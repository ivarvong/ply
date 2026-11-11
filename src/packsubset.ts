// Pack subset (#235): a new, valid pack of chosen entries of an existing one, read through a range reader, each entry's
// compressed bytes copied unchanged (nothing inflated or deflated). How a push too large for a host's cap is cut into
// several, or part of a received pack relayed, in memory bounded by a chunk whatever the pack's size.
//
// The selection is a list of the source's entry indices (from scanPackIndex, #236) in the order they are to be written,
// which may differ from the source's. It is copied at the call (4 bytes an entry): the array is the caller's to reuse. Each entry gets a rewritten header: the same type and size, an OFS_DELTA's
// distance recomputed for its new position, a REF_DELTA's base id unchanged (Cloudflare Artifacts packs are REF only, so
// they pass through as they are). An OFS base must be written earlier in the new pack; one that is not (left out, or
// later in the order) is refused by default, or written as a REF_DELTA to the base's id with `outsideBase: 'ref'` when
// the index knows that id (a whole object, oids on). A REF base outside the selection stays a REF: such a pack is thin,
// and the receiver supplies the base (receive-pack's index-pack --fix-thin) or refuses.
//
// `extras` are small objects ply encodes itself (a commit, a generated tree), deflated before anything is streamed and
// written after the selected entries. Their base may be none or a REF; an OFS base inside extras is refused, as is any
// extra a pack cannot hold (a type that is not commit, tree, blob or tag; a REF base that is not a 40-hex id).
//
// `length` is exact before the first byte, so the stream feeds pushPack (#234) with a known length. Consecutive source
// entries are read with one range read; the SHA-1 trailer is computed while streaming. Held: per selected entry 8 bytes
// (its new offset) + 4 (its OFS base's position) + 4 (its index, the copy) + 1 (its kind), per source entry 4 + 1 (position, selected mark), the
// extras' deflated bytes, and the chunk in flight. A source that serves fewer or more bytes than a range asks for
// errors the stream (pack_corrupt) before the trailer, so the receiver never gets a whole pack from a short read.
//
// The source is the caller's storage and may never answer. Cancelling the stream settles at once all the same: no await
// on the source (opening a range, reading it, cancelling it) is made without `Halt.race` (rangesource.ts), the range in flight is
// cancelled and the source's abort signal fired without waiting for either, and whatever a read answers later is
// dropped (a range that opens late is cancelled).
import type { PlyError } from './errors.js';
import { fail, plyError } from './errors.js';
import type { Result } from './result.js';
import { ok } from './result.js';
import { withDefaults } from './absent.js';
import type { RangeSource, Halt } from './rangesource.js';
import { HALTED, haltOn, drop, cancelRange, cancelLate } from './rangesource.js';
import type { ScannedPack } from './packscanindex.js';
import type { PackInput } from './pack.js';
import { encodeObjHeader, encodeOfsDistance, entryHead, inputBase, packHeader, zlibDeflate } from './pack.js';
import { streamingSha1, fromHex } from './sha1.js';
import { concat } from './bytes.js';
import { OBJ_COMMIT, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA, PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from './format.js';
import { parseOid } from './oid.js';

// In-range indexed reads of columns this module sized or the index sized; noUncheckedIndexedAccess cannot see that.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */

export type OutsideBase = 'refuse' | 'ref';
export type PackSubsetOpts = { readonly extras: readonly PackInput[]; readonly outsideBase: OutsideBase };
export type PackSubset = { readonly stream: ReadableStream<Uint8Array>; readonly length: number; readonly count: number };
// A fresh record per call: withDefaults fills it in place.
const defaultOpts = (): PackSubsetOpts => ({ extras: [], outsideBase: 'refuse' });

// A pack's object count is a 32-bit field.
const MAX_COUNT = 0xff_ff_ff_ff;
const KIND_WHOLE = 0;
const KIND_OFS = 1;
const KIND_REF = 2;
const KIND_REF_FROM_OFS = 3;
const NOT_WRITTEN = -1;

type Plan = {
  readonly pack: ScannedPack;
  // the plan's own copy of the caller's selection, taken at the call: the offsets below are planned from these values,
  // so the stream must write from the same ones whatever the caller does with its array afterwards
  readonly selection: Uint32Array;
  readonly kind: Uint8Array;
  readonly basePos: Int32Array;
  readonly newOffset: Float64Array;
  readonly extras: ReadonlyArray<{ readonly head: Uint8Array; readonly z: Uint8Array }>;
  readonly body: number;
};

const cancelled = (): PlyError => plyError('aborted', 'pack subset: the stream was cancelled');

const refuse = (what: string, message: string): Result<never, PlyError> => fail('bad_request', `pack subset: ${message}`, { what });

// The id of whole object `i`, if the index computed it.
function wholeOid(pack: ScannedPack, i: number): string | null {
  const e = pack.entry(i);
  return e.tag === 'some' ? e.value.oid : null;
}
// The REF base id entry `i` names.
function refOid(pack: ScannedPack, i: number): string | null {
  const e = pack.entry(i);
  return e.tag === 'some' && e.value.base.tag === 'ref' ? e.value.base.oid : null;
}

// Entry k's header in the new pack.
function headerOf(p: Plan, k: number): Uint8Array {
  const i = p.selection[k] as number;
  const c = p.pack.columns;
  const size = c.size[i] as number;
  switch (p.kind[k] as number) {
    case KIND_OFS: return concat([encodeObjHeader(OBJ_OFS_DELTA, size), encodeOfsDistance((p.newOffset[k] as number) - (p.newOffset[p.basePos[k] as number] as number))]);
    case KIND_REF: return concat([encodeObjHeader(OBJ_REF_DELTA, size), fromHex(refOid(p.pack, i) as string)]);
    case KIND_REF_FROM_OFS: return concat([encodeObjHeader(OBJ_REF_DELTA, size), fromHex(wholeOid(p.pack, c.baseIndex[i] as number) as string)]);
    default: return encodeObjHeader(c.storedType[i] as number, size);
  }
}

// Extra j as a pack can hold it: bytes, and either a whole object of one of the four types (commit 1 .. tag 4; 0, 5 and
// the delta types are not whole objects) or a REF_DELTA to a 40-hex id, whose own type is the delta's and is not read.
// The values are a JavaScript caller's, so they are checked as unknown: buildPack's encoder checks none of this
// (pack.ts), and an extra it would write wrong is a pack of the declared length that no git can parse.
function checkExtra(j: number, o: PackInput): Result<null, PlyError> {
  const data: unknown = o.data;
  if (!(data instanceof Uint8Array)) return refuse('pack subset extras', `extra ${j} has data that is not a Uint8Array`);
  const base = inputBase(o);
  const tag: unknown = base.tag;
  if (tag === 'ofs') return refuse('pack subset extras', `extra ${j} has an OFS base; give a REF base or none`);
  if (tag === 'ref') {
    const oid: unknown = base.tag === 'ref' ? base.oid : null;
    return parseOid(oid).ok ? ok(null) : refuse('pack subset extras', `extra ${j} has a REF base that is not a 40-hex object id`);
  }
  if (tag !== 'none') return refuse('pack subset extras', `extra ${j} has a base that is neither none nor a REF`);
  const type: unknown = o.type;
  if (typeof type !== 'number' || !Number.isInteger(type) || type < OBJ_COMMIT || type > OBJ_TAG) return refuse('pack subset extras', `extra ${j} has type ${String(type)}; a whole object is a commit (1), tree (2), blob (3) or tag (4)`);
  return ok(null);
}

async function plan(pack: ScannedPack, selection: readonly number[], opts: PackSubsetOpts): Promise<Result<Plan, PlyError>> {
  const c = pack.columns;
  const n = selection.length;
  const total = n + opts.extras.length;
  if (total > MAX_COUNT) return refuse('pack subset count', `${total} objects is more than a pack can count`);
  // every extra is checked before any is deflated, and before the selection is walked
  for (const [j, o] of opts.extras.entries()) {
    const checked = checkExtra(j, o);
    if (!checked.ok) return checked;
  }
  // where each source entry is written (position in the new pack), NOT_WRITTEN until it is
  const pos = new Int32Array(pack.count).fill(NOT_WRITTEN);
  const selected = new Uint8Array(pack.count);
  // distinct entries of the pack are at most its count, so the copy is sized by the pack, never by the caller's array
  if (n > pack.count) return refuse('pack subset selection', `${n} entries selected from a pack of ${pack.count}: one is selected twice or is not in the pack`);
  const copy = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    const i = selection[k] as number;
    if (!Number.isInteger(i) || i < 0 || i >= pack.count) return refuse('pack subset selection', `entry ${String(i)} is not in the pack (0..${pack.count - 1})`);
    if (selected[i] === 1) return refuse('pack subset selection', `entry ${i} is selected twice`);
    selected[i] = 1;
    copy[k] = i;
  }
  const p: Plan = { pack, selection: copy, kind: new Uint8Array(n), basePos: new Int32Array(n).fill(NOT_WRITTEN), newOffset: new Float64Array(n), extras: [], body: 0 };
  let offset = PACK_HEADER_BYTES;
  for (let k = 0; k < n; k++) {
    const i = copy[k] as number;
    const stored = c.storedType[i] as number;
    if (stored === OBJ_OFS_DELTA) {
      const b = c.baseIndex[i] as number;
      const at = pos[b] as number;
      if (at !== NOT_WRITTEN) {
        p.kind[k] = KIND_OFS;
        p.basePos[k] = at;
      } else if (opts.outsideBase === 'ref' && wholeOid(pack, b) !== null) {
        p.kind[k] = KIND_REF_FROM_OFS;
      } else {
        const where = selected[b] === 1 ? 'is written after it' : 'is not selected';
        const hint = opts.outsideBase === 'ref' ? ' and its id is unknown (a delta, or oids off)' : '; outsideBase: \'ref\' writes it as a REF_DELTA when the base id is known';
        return refuse('pack subset base', `entry ${i} is an OFS_DELTA whose base, entry ${b}, ${where}${hint}`);
      }
    } else if (stored === OBJ_REF_DELTA) {
      if (refOid(pack, i) === null) return refuse('pack subset base', `entry ${i} is a REF_DELTA with no base id in the index`);
      p.kind[k] = KIND_REF;
    } else {
      p.kind[k] = KIND_WHOLE;
    }
    p.newOffset[k] = offset;
    pos[i] = k;
    offset += headerOf(p, k).length + (c.compressed[i] as number);
  }
  const extras: Array<{ head: Uint8Array; z: Uint8Array }> = [];
  for (const o of opts.extras) {
    // the extras are small and few; in order, as the pack is
    // oxlint-disable-next-line no-await-in-loop -- see above
    const z = await zlibDeflate(o.data);
    const head = entryHead(o, offset, []).head;
    extras.push({ head, z });
    offset += head.length + z.length;
  }
  return ok({ ...p, extras, body: offset });
}

// Exactly `length` bytes from a range reader, cut into the views the caller asks for (never a copy). `take(n)` yields
// n bytes and returns null, or returns the refusal; `skip(n)` drops n; `end()` checks the range is used up. A refusal is
// a value, never a throw (docs/STACK.md rule 1): the stream below errors itself with it.
type Cut = {
  readonly take: (want: number) => AsyncGenerator<Uint8Array, PlyError | null, unknown>;
  readonly skip: (want: number) => Promise<PlyError | null>;
  readonly end: () => Promise<PlyError | null>;
};
function cutter(reader: ReadableStreamDefaultReader<Uint8Array>, start: number, length: number, halt: Halt): Cut {
  let chunk: Uint8Array = new Uint8Array(0);
  let at = 0;
  let got = 0;
  const long = (): PlyError => plyError('pack_corrupt', `pack subset: the range at ${start} served more than its ${length} bytes`);
  // the next chunk of the range, or why there is none
  async function refill(): Promise<PlyError | null> {
    const r = await halt.race(reader.read(), drop);
    if (r === HALTED) return cancelled();
    if (r.done) return plyError('pack_corrupt', `pack subset: the range at ${start} ended after ${got} of ${length} bytes`);
    if (got + r.value.length > length) return long();
    chunk = r.value;
    at = 0;
    got += chunk.length;
    return null;
  }
  async function* take(want: number): AsyncGenerator<Uint8Array, PlyError | null, unknown> {
    let left = want;
    while (left > 0) {
      if (at >= chunk.length) {
        // oxlint-disable-next-line no-await-in-loop -- one stream, read in order
        const refused = await refill();
        if (refused !== null) return refused;
        continue;
      }
      const n = Math.min(left, chunk.length - at);
      yield chunk.subarray(at, at + n);
      at += n;
      left -= n;
    }
    return null;
  }
  async function skip(want: number): Promise<PlyError | null> {
    let left = want;
    while (left > 0) {
      if (at >= chunk.length) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        const refused = await refill();
        if (refused !== null) return refused;
        continue;
      }
      const n = Math.min(left, chunk.length - at);
      at += n;
      left -= n;
    }
    return null;
  }
  async function end(): Promise<PlyError | null> {
    if (at < chunk.length) return long();
    const r = await halt.race(reader.read(), drop);
    if (r === HALTED) return cancelled();
    return r.done ? null : long();
  }
  return { take, skip, end };
}

// Runs of entries consecutive in the source, written consecutively: one range read each.
function* runs(p: Plan): Generator<{ readonly from: number; readonly to: number }> {
  const sel = p.selection;
  let from = 0;
  for (let k = 1; k <= sel.length; k++) {
    if (k === sel.length || (sel[k] as number) !== (sel[k - 1] as number) + 1) {
      yield { from, to: k };
      from = k;
    }
  }
}

// One run's bytes: each entry's new header, then its compressed bytes from the range; null at the end, or the refusal.
async function* run(p: Plan, cut: Cut, from: number, to: number): AsyncGenerator<Uint8Array, PlyError | null, unknown> {
  const c = p.pack.columns;
  for (let k = from; k < to; k++) {
    const i = p.selection[k] as number;
    // oxlint-disable-next-line no-await-in-loop -- one stream, read in order
    const skipped = await cut.skip(c.headerBytes[i] as number);
    if (skipped !== null) return skipped;
    yield headerOf(p, k);
    const took = yield* cut.take(c.compressed[i] as number);
    if (took !== null) return took;
  }
  return cut.end();
}

// The new pack's bytes before its trailer; null when all were written, or the refusal that stopped them.
async function* pieces(source: RangeSource, p: Plan, halt: Halt): AsyncGenerator<Uint8Array, PlyError | null, unknown> {
  const c = p.pack.columns;
  yield packHeader(p.selection.length + p.extras.length);
  for (const r of runs(p)) {
    if (r.to === r.from) continue;
    const first = p.selection[r.from] as number;
    const last = p.selection[r.to - 1] as number;
    const start = c.offset[first] as number;
    const length = (c.offset[last] as number) + (c.headerBytes[last] as number) + (c.compressed[last] as number) - start;
    // oxlint-disable-next-line no-await-in-loop -- one run after another, in pack order
    const opened = await halt.race(source.read(start, length, halt.signal), cancelLate);
    if (opened === HALTED) return cancelled();
    if (!opened.ok) return opened.error;
    const reader = opened.value.getReader();
    halt.reading(reader);
    let outcome: PlyError | null | 'open' = 'open';
    try {
      outcome = yield* run(p, cutter(reader, start, length, halt), r.from, r.to);
    } finally {
      halt.reading(null);
      // a range not read to its end (a refusal, the consumer cancelling) is cancelled, not left open; the source is
      // asked, not waited for
      if (outcome !== null) cancelRange(reader, null);
      reader.releaseLock();
    }
    if (outcome !== null) return outcome;
  }
  for (const x of p.extras) { yield x.head; yield x.z; }
  return null;
}

// The selected entries of `pack`, read from `source`, as a new pack (see the top of this file). Refusals of the
// selection, its bases or the extras are a Result before any byte is read; a range that fails or serves the wrong
// length errors the stream before its trailer.
export async function packSubset(source: RangeSource, pack: ScannedPack, selection: readonly number[], input: Partial<PackSubsetOpts> = {}): Promise<Result<PackSubset, PlyError>> {
  const opts = withDefaults(input, defaultOpts());
  if (pack.bytes > source.size) return refuse('pack subset source', `the source holds ${source.size} bytes; the indexed pack is ${pack.bytes}`);
  const planned = await plan(pack, selection, opts);
  if (!planned.ok) return planned;
  const p = planned.value;
  const length = p.body + PACK_TRAILER_BYTES;
  // the stream's own signal: aborted by its consumer's cancel, given to every source.read
  const abort = new AbortController();
  const halt = haltOn(abort.signal);
  const it = pieces(source, p, halt);
  const sha = streamingSha1();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctl): Promise<void> {
      let r: IteratorResult<Uint8Array, PlyError | null>;
      // a range reader whose stream errors (its own failure) rejects here
      try { r = await it.next(); } catch (e) { if (!halt.halted()) ctl.error(e); return; }
      // cancelled while this read was in flight: nothing more is enqueued, whatever the read came to
      if (halt.halted()) return;
      if (r.done === true) {
        if (r.value !== null) { ctl.error(r.value); return; }
        if (sent !== p.body) { ctl.error(plyError('internal', `pack subset: wrote ${sent} bytes, planned ${p.body}`)); return; }
        ctl.enqueue(fromHex(await sha.hex()));
        ctl.close();
        return;
      }
      sent += r.value.length;
      await sha.update(r.value);
      if (halt.halted()) return;
      ctl.enqueue(r.value);
    },
    // Settles at once, whatever the source does: the read in flight is released (Halt), and the generator unwinds
    // behind it, or from the yield it is parked at, without being waited for.
    cancel(reason: unknown): void {
      abort.abort(reason);
      it.return(null).catch(drop);
    },
  }, { highWaterMark: 0 });
  return ok({ stream, length, count: p.selection.length + p.extras.length });
}
