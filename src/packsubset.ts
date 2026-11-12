// Pack subset (#235): a new, valid pack of chosen entries of an existing one, read through a range reader, each entry's
// compressed bytes copied unchanged (nothing inflated or deflated). How a push too large for a host's cap is cut into
// several, or part of a received pack relayed, in memory bounded by a chunk whatever the pack's size.
//
// The selection is a list of the source's entry indices (from scanPackIndex, #236) in the order they are to be written,
// which may differ from the source's. It is copied at the call (4 bytes an entry): the array is the caller's to reuse. Each entry gets a rewritten header: the same type and size, an OFS_DELTA's
// distance recomputed for its new position, a REF_DELTA's base id unchanged (Cloudflare Artifacts packs are REF only, so
// they pass through as they are). An OFS base must be written earlier in the new pack; one that is not (left out, or
// later in the order) is refused by default, or written as a REF_DELTA to the base's id with `outsideBase: 'ref'` when
// that id is known: the scan index knows a whole object's (oids on); `resolved` (resolvePackRange over the same pack)
// knows every entry's, so with it a chain is cut anywhere, below a delta base too. A REF base outside the selection
// stays a REF: such a pack is thin, and the receiver supplies the base (receive-pack's index-pack --fix-thin) or
// refuses.
//
// One decision, shared: `entryWrite` and `baseId` say how an entry is written given where its base is, and the planner
// (packplan.ts) plans with the same two functions, so a batch it plans is one this module builds from the same
// `resolved`.
//
// Base first. With `resolved`, a selected base is written before the first selected entry resting on it (through any
// chain), whatever the selection's order; entries with no such tie keep the caller's order. Stock git refuses a thin
// pack in which a REF_DELTA precedes its base when that base is itself a delta the receiver already holds (it appends
// the base from its store, then meets it in the pack: "appears twice in the pack", measured against git 2.50
// index-pack --strict --fix-thin). Without `resolved` a REF_DELTA's delta base cannot be told from a base outside the
// pack, so the order is the caller's to get right (the planner's batches are base first).
//
// `extras` are small objects ply encodes itself (a commit, a generated tree), deflated before anything is streamed and
// written after the selected entries. Their base may be none or a REF; an OFS base inside extras is refused, as is any
// extra a pack cannot hold (a type that is not commit, tree, blob or tag; a REF base that is not a 40-hex id).
//
// `length` is exact before the first byte, so the stream feeds pushPack (#234) with a known length. Consecutive source
// entries are read with one range read; the SHA-1 trailer is computed while streaming. Held: per selected entry 8 bytes
// (its new offset) + 4 (its OFS base's position) + 4 (its index, the copy) + 1 (its kind), per source entry 4 + 1
// (position, selected mark), per entry rewritten as a REF_DELTA its base's 20-byte id, the extras' deflated bytes, and
// the chunk in flight; with `resolved`, also 4 bytes per selected entry for the base-first order (the copy is reordered
// into a second Uint32Array) and 1 per source entry while ordering. A source that serves fewer or more bytes than a range asks for
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
import { withDefaults, fromNullish } from './absent.js';
import type { Input } from './absent.js';
import type { RangeSource, Halt } from './rangesource.js';
import { HALTED, haltOn, drop, cancelRange, cancelLate } from './rangesource.js';
import type { ScannedPack } from './packscanindex.js';
import type { ResolvedIndex } from './packrangeresolve.js';
import type { PackInput } from './pack.js';
import { encodeObjHeader, encodeOfsDistance, entryHead, inputBase, packHeader, zlibDeflate } from './pack.js';
import { streamingSha1, fromHex } from './sha1.js';
import { concat } from './bytes.js';
import { OBJ_COMMIT, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA, PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from './format.js';

// In-range indexed reads of columns this module sized or the index sized; noUncheckedIndexedAccess cannot see that.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */

export type OutsideBase = 'refuse' | 'ref';
export type PackSubsetOpts = {
  readonly extras: readonly PackInput[];
  readonly outsideBase: OutsideBase;
  // every entry's id (resolvePackRange over this pack), or null: only a whole object's id is known (the scan index)
  readonly resolved: ResolvedIndex | null;
};
export type PackSubset = { readonly stream: ReadableStream<Uint8Array>; readonly length: number; readonly count: number };
// A fresh record per call: withDefaults fills it in place.
const defaultOpts = (): PackSubsetOpts => ({ extras: [], outsideBase: 'refuse', resolved: null });

// A pack's object count is a 32-bit field.
const MAX_COUNT = 0xff_ff_ff_ff;
// How an entry is written: as stored (a whole object, or a REF_DELTA with its base id), as an OFS_DELTA to its base's
// new position, as a REF_DELTA in place of the stored OFS_DELTA, or not at all.
export const WRITE_WHOLE = 0;
export const WRITE_OFS = 1;
export const WRITE_REF = 2;
export const WRITE_REF_FROM_OFS = 3;
export const WRITE_REFUSED = 4;
export type EntryWrite = typeof WRITE_WHOLE | typeof WRITE_OFS | typeof WRITE_REF | typeof WRITE_REF_FROM_OFS | typeof WRITE_REFUSED;
const KIND_WHOLE = WRITE_WHOLE;
const KIND_OFS = WRITE_OFS;
const KIND_REF = WRITE_REF;
const KIND_REF_FROM_OFS = WRITE_REF_FROM_OFS;
const NOT_WRITTEN = -1;

// The one rule for writing an entry whose stored type is `stored`: `baseWritten` says its OFS base is earlier in the
// same new pack, `baseIdKnown` that `baseId` names that base. The planner and the builder both decide with this.
export function entryWrite(stored: number, baseWritten: boolean, baseIdKnown: boolean, outsideBase: OutsideBase): EntryWrite {
  if (stored === OBJ_REF_DELTA) return WRITE_REF;
  if (stored !== OBJ_OFS_DELTA) return WRITE_WHOLE;
  if (baseWritten) return WRITE_OFS;
  return outsideBase === 'ref' && baseIdKnown ? WRITE_REF_FROM_OFS : WRITE_REFUSED;
}
// Bytes an OFS_DELTA header spends on a distance (the planner counts written headers with it).
export const ofsDistanceBytes = (distance: number): number => encodeOfsDistance(distance).length;

type Plan = {
  readonly pack: ScannedPack;
  // the plan's own copy of the caller's selection, taken at the call, in write order: the offsets below are planned
  // from these values, so the stream must write from the same ones whatever the caller does with its array afterwards
  readonly selection: Uint32Array;
  readonly resolved: ResolvedIndex | null;
  readonly kind: Uint8Array;
  readonly basePos: Int32Array;
  readonly newOffset: Float64Array;
  // by position, the base id of each entry rewritten as a REF_DELTA: the answer plan() checked, asked for once
  readonly baseIds: Map<number, Uint8Array>;
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
// An object id as a REF_DELTA header carries it: 40 lowercase hex, what parseOid (oid.ts) accepts. Spelled here because
// this file is at its import budget.
const OID_TEXT = /^[0-9a-f]{40}$/u;
// What a caller's `resolved.oid()` threw: carried to the refusal as its cause, never swallowed and never let out.
export type Threw = { readonly threw: unknown };
// A caller's `resolved.oid()` that returned nothing at all (no Option): refused in those words, with no cause.
export type Nothing = { readonly nothing: true };
const NOTHING: Nothing = { nothing: true };
// The id `resolved` gives entry `b`, checked here, where it is used. A resolved index is the caller's object (made by
// hand, or read back from storage): an `oid` that is missing or answers anything but 40 lowercase hex names no base
// (null), and one that throws is reported with what it threw. Either way the entry is refused (by the planner and the
// builder alike) and nothing but an object id is ever written into a REF_DELTA header. Asked only for a base outside
// the batch, so the check costs nothing elsewhere.
function resolvedId(resolved: ResolvedIndex, b: number): string | Threw | Nothing | null {
  try {
    const answer = fromNullish(resolved.oid(b));
    if (answer.tag === 'none') return NOTHING;
    const id = answer.value;
    if (id.tag !== 'some') return null;
    const value: unknown = id.value;
    return typeof value === 'string' && OID_TEXT.test(value) ? value : null;
  } catch (threw) {
    return { threw };
  }
}
// The id of entry `b` as a REF_DELTA would name it: from `resolved` when given (any entry), else the scan index's (a
// whole object, oids on); null when neither knows it, and what `resolved.oid()` threw when it did.
export function baseId(pack: ScannedPack, resolved: ResolvedIndex | null, b: number): string | Threw | Nothing | null {
  return resolved === null ? wholeOid(pack, b) : resolvedId(resolved, b);
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
    case KIND_REF_FROM_OFS: return concat([encodeObjHeader(OBJ_REF_DELTA, size), p.baseIds.get(k) as Uint8Array]);
    default: return encodeObjHeader(c.storedType[i] as number, size);
  }
}

// The copy with every selected base moved before the first entry that rests on it; otherwise the caller's order.
// `queued` marks each entry once, so a base column that loops (a damaged index) still ends: at most one step an entry,
// and at most `copy.length` entries written. A chain is written into `out` as it is walked, then turned round in place.
function baseFirst(copy: Uint32Array, selected: Uint8Array, resolved: ResolvedIndex): Uint32Array {
  const base = resolved.columns.base;
  const queued = new Uint8Array(selected.length);
  const out = new Uint32Array(copy.length);
  let w = 0;
  for (let k = 0; k < copy.length; k++) {
    const from = w;
    let u = copy[k] as number;
    while (u >= 0 && u < selected.length && selected[u] === 1 && queued[u] !== 1) {
      queued[u] = 1;
      out[w++] = u;
      u = base[u] as number;
    }
    out.subarray(from, w).reverse();
  }
  return out;
}

// Extra j as a pack can hold it: bytes, and either a whole object of one of the four types (commit 1 .. tag 4; 0, 5 and
// the delta types are not whole objects) or a REF_DELTA to a 40-hex id, whose own type is the delta's and is not read.
// The values are a JavaScript caller's, so they are checked as unknown: buildPack's encoder checks none of this
// (pack.ts), and an extra it would write wrong is a pack of the declared length that no git can parse.
function checkExtra(j: number, given: PackInput): Result<null, PlyError> {
  // not an object at all (null, a missing value, a number): refused before a property of it is read
  const o: unknown = given;
  if (typeof o !== 'object' || o === null) return refuse('pack subset extras', `extra ${j} is not an object`);
  const data: unknown = given.data;
  if (!(data instanceof Uint8Array)) return refuse('pack subset extras', `extra ${j} has data that is not a Uint8Array`);
  const base = inputBase(given);
  const tag: unknown = base.tag;
  if (tag === 'ofs') return refuse('pack subset extras', `extra ${j} has an OFS base; give a REF base or none`);
  if (tag === 'ref') {
    const oid: unknown = base.tag === 'ref' ? base.oid : null;
    return typeof oid === 'string' && OID_TEXT.test(oid) ? ok(null) : refuse('pack subset extras', `extra ${j} has a REF base that is not a 40-hex object id`);
  }
  if (tag !== 'none') return refuse('pack subset extras', `extra ${j} has a base that is neither none nor a REF`);
  const type: unknown = given.type;
  if (typeof type !== 'number' || !Number.isInteger(type) || type < OBJ_COMMIT || type > OBJ_TAG) return refuse('pack subset extras', `extra ${j} has type ${String(type)}; a whole object is a commit (1), tree (2), blob (3) or tag (4)`);
  return ok(null);
}

// The entries to write, checked and copied (a caller's later change to its array changes nothing), in write order (base
// first with `resolved`), with the marks the layout fills in. Every extra is checked first, before any is deflated.
type Order = { readonly order: Uint32Array; readonly pos: Int32Array; readonly selected: Uint8Array };
function ordered(pack: ScannedPack, selection: readonly number[], opts: PackSubsetOpts): Result<Order, PlyError> {
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
  return ok({ order: opts.resolved === null ? copy : baseFirst(copy, selected, opts.resolved), pos, selected });
}

// Each entry's kind, header and offset in the new pack, in write order; then the extras.
async function plan(pack: ScannedPack, selection: readonly number[], opts: PackSubsetOpts): Promise<Result<Plan, PlyError>> {
  const checked = ordered(pack, selection, opts);
  if (!checked.ok) return checked;
  const { order, pos, selected } = checked.value;
  const c = pack.columns;
  const n = order.length;
  const p: Plan = { pack, selection: order, resolved: opts.resolved, kind: new Uint8Array(n), basePos: new Int32Array(n).fill(NOT_WRITTEN), newOffset: new Float64Array(n), baseIds: new Map(), extras: [], body: 0 };
  let offset = PACK_HEADER_BYTES;
  for (let k = 0; k < n; k++) {
    const i = order[k] as number;
    const stored = c.storedType[i] as number;
    if (stored === OBJ_OFS_DELTA) {
      const b = c.baseIndex[i] as number;
      const at = pos[b] as number;
      // the id is asked for only when it would be written (the base is not earlier in this pack), and once: the
      // answer checked here is the one the header carries, so a `resolved` that answers otherwise later changes nothing
      const id = at === NOT_WRITTEN ? baseId(pack, opts.resolved, b) : null;
      if (id !== null && typeof id !== 'string') {
        return 'threw' in id
          ? fail('bad_request', `pack subset: the resolved index's oid() threw for entry ${b}, the base of entry ${i}`, { what: 'pack subset base', cause: id.threw })
          : refuse('pack subset base', `the resolved index's oid() returned nothing for entry ${b}, the base of entry ${i}`);
      }
      const write = entryWrite(stored, at !== NOT_WRITTEN, id !== null, opts.outsideBase);
      if (write === WRITE_OFS) {
        p.kind[k] = KIND_OFS;
        p.basePos[k] = at;
      } else if (write === WRITE_REF_FROM_OFS && id !== null) {
        p.kind[k] = KIND_REF_FROM_OFS;
        p.baseIds.set(k, fromHex(id));
      } else {
        const where = selected[b] === 1 ? 'is written after it' : 'is not selected';
        const hint = opts.outsideBase === 'ref' ? ' and its id is unknown (a delta and no `resolved`, a `resolved` with no valid id for it, or oids off)' : '; outsideBase: \'ref\' writes it as a REF_DELTA when the base id is known';
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
// `bare`: the reader is the platform's own (platformReader), so a chunk read is awaited as it is, with no promise and no
// hop added per chunk: the halt's abort listener cancels the reader, which settles a read in flight (done), and the
// check after the await sees the halt. Any other reader may never answer its cancel, so its reads go through halt.race.
function cutter(reader: ReadableStreamDefaultReader<Uint8Array>, start: number, length: number, halt: Halt, bare: boolean): Cut {
  let chunk: Uint8Array = new Uint8Array(0);
  let at = 0;
  let got = 0;
  const long = (): PlyError => plyError('pack_corrupt', `pack subset: the range at ${start} served more than its ${length} bytes`);
  // the next chunk of the range, or why there is none
  async function refill(): Promise<PlyError | null> {
    const r = bare ? await reader.read() : await halt.race(reader.read(), drop);
    if (r === HALTED || halt.halted()) return cancelled();
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
    const r = bare ? await reader.read() : await halt.race(reader.read(), drop);
    if (r === HALTED || halt.halted()) return cancelled();
    return r.done ? null : long();
  }
  return { take, skip, end };
}

// The platform's reader on a range whose getReader is the platform's own. null for any other range, which is then read
// through its own reader: a class that defines its own getReader (a subclass that serves its bytes through it, with no
// underlying source at all) and an object that is not a platform ReadableStream (the brand check throws).
// oxlint-disable-next-line typescript/unbound-method -- only ever called with the range as its `this`, just below
const getPlatformReader: (this: ReadableStream<Uint8Array>) => ReadableStreamDefaultReader<Uint8Array> = ReadableStream.prototype.getReader;
function platformReader(range: ReadableStream<Uint8Array>): ReadableStreamDefaultReader<Uint8Array> | null {
  // oxlint-disable-next-line typescript/unbound-method -- compared, never called
  if (range.getReader !== getPlatformReader) return null;
  try { return getPlatformReader.call(range); } catch { return null; }
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
    const own = platformReader(opened.value);
    const reader = own === null ? opened.value.getReader() : own;
    halt.reading(reader);
    let outcome: PlyError | null | 'open' = 'open';
    try {
      outcome = yield* run(p, cutter(reader, start, length, halt, own !== null), r.from, r.to);
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
export async function packSubset(source: RangeSource, pack: ScannedPack, selection: readonly number[], input: Input<PackSubsetOpts> = {}): Promise<Result<PackSubset, PlyError>> {
  const opts = withDefaults(input, defaultOpts());
  if (opts.resolved !== null && opts.resolved.count !== pack.count) return refuse('pack subset resolved', `the resolved index has ${opts.resolved.count} entries, the pack ${pack.count}`);
  if (pack.bytes > source.size) return refuse('pack subset source', `the source holds ${source.size} bytes; the indexed pack is ${pack.bytes}`);
  // a JavaScript caller's value, checked as unknown: null, a number or an array-like is refused before it is counted
  const extras: unknown = opts.extras;
  if (!Array.isArray(extras)) return refuse('pack subset extras', 'extras is not an array');
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
