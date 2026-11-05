// Pack parsing and delta resolution (buffered, general-purpose): parsePack walks a whole pack verifying the trailer,
// applyDelta is git's patch_delta, resolvePack resolves OFS/REF chains to a fixpoint with external bases as a last
// resort, describePack reports that layout the way `git verify-pack -v` prints it (a thin base is data, not an error),
// makeDelta is a general delta generator. The edit pipeline needs none of this (fetch.js/fetchObject +
// pack.js/spliceDelta); it is here for the general client and re-exported from pack.js for callers.
import type { ErrorOf } from './errors.js';
import { fail, plyError } from './errors.js';
import type { Err, Result } from './result.js';
import { ok, err, assertNever, flatMapOption, getOrElse } from './result.js';
import { at, atOr, fromNullable, fromNullish, mapGet, readKey, type Input } from './absent.js';
import type { Oid } from './oid.js';
import { parseOid } from './oid.js';
import { TYPE, TYPE_NAME, hashObject, nameOfTypeId } from './objects.js';
import type { LimitKey, Limits } from './limits.js';
import { DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD, limitError, checkLimit, readLimit } from './limits.js';
// pack.js re-exports this module's parsers: a cycle of a re-export and one function, which ES modules resolve
// oxlint-disable-next-line import/no-cycle -- see above
import { spliceDelta } from './pack.js';
import type { DeltaOp, SplicedDelta } from './pack.js';
import { shortRead } from './bytes.js';
import type { ObjType, ObjectTypeName, PackKind } from './format.js';
import type { InflateStats, ObjBase, ObjHeader, ObjSize, OfsDelta, PackCaps, PackError, PackPiece, PackScan } from './packstream.js';
import { NO_BASE, packScanOpen, parsePackFeed, parsePackClose, parsePackPull, readObjHeader, readOfsDelta, readUint32BE, readVarint } from './packstream.js';
import {
  PACK_VERSION, DELTA_SIZE_MIN, DELTA_COPY, DELTA_COPY_MAX, DELTA_OFF4_FACTOR, DELTA_OFF_SHIFT,
  DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3, DELTA_BYTE2_SHIFT,
} from './format.js';

export type { PackKind, PackError, ObjBase, ObjHeader, ObjSize, OfsDelta, PackCaps };
// The header readers live with the scan (packstream.ts); re-exported here, where callers have always found them.
export { readObjHeader, readOfsDelta, readUint32BE };
type Corrupt = ErrorOf<'pack_corrupt'>;
const corrupt = (msg: string): Err<Corrupt> => fail('pack_corrupt', msg);
const short = (buf: Uint8Array, p: number): Err<Corrupt> => err(shortRead('pack_corrupt', p, 1, buf.length));

// A stored object's type (commit, tree, blob, tag): what a full object and a resolved delta are.
export type ResolvedObjType = typeof TYPE.COMMIT | typeof TYPE.TREE | typeof TYPE.BLOB | typeof TYPE.TAG;
function storedType(n: number): ResolvedObjType | null {
  switch (n) {
    case TYPE.COMMIT:
    case TYPE.TREE:
    case TYPE.BLOB:
    case TYPE.TAG:
      return n;
    default:
      return null;
  }
}
const storedName = (type: ResolvedObjType): ObjectTypeName => TYPE_NAME[type];

// ---- parse ----
// Caps are required. A missing field used to become Infinity (a nullish fallback), which disabled the check; checkLimit rejects that.
// Each key's cap is the caller's override at the same index when it gave one, else limits[key]; the first cap that
// bounds nothing is the error. One cap per key, in order, so the result has keys.length entries.
type Caps = readonly [number, number, number];
function capsOf(limits: Limits, keys: readonly [LimitKey, LimitKey, LimitKey], given: readonly unknown[] = []): Result<Caps, ErrorOf<'bad_request'>> {
  const out: number[] = [];
  for (const [i, k] of keys.entries()) {
    const g = at(given, i);
    const r = g.tag === 'some' ? checkLimit(g.value, k) : readLimit(limits, k);
    if (!r.ok) return r;
    out.push(r.value);
  }
  // three keys, three caps (the loop above)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return ok(out as unknown as Caps);
}
// verify: check the trailer's SHA-1 (anything but false verifies); limits: the caps (DEFAULT_LIMITS); maxObjects and
// maxInflatedTotal: a cap that overrides the one in limits.
export type PackParseConfig = {
  readonly verify: boolean;
  readonly limits: Limits;
  readonly maxObjects: number;
  readonly maxInflatedTotal: number;
};
export type PackParseOptions = Input<PackParseConfig>;
// parsePack's options for `limits`: the two pack caps read out of it, checked (the first that bounds nothing is the error).
export type PackParseOpts = { readonly limits: Limits; readonly maxObjects: number; readonly maxInflatedTotal: number };
export function packParseOpts(limits: Limits = DEFAULT_LIMITS): Result<PackParseOpts, ErrorOf<'bad_request'>> {
  const maxObjects = readLimit(limits, 'maxPackObjects');
  if (!maxObjects.ok) return maxObjects;
  const maxInflatedTotal = readLimit(limits, 'maxInflatedTotal');
  if (!maxInflatedTotal.ok) return maxInflatedTotal;
  return ok({ limits, maxObjects: maxObjects.value, maxInflatedTotal: maxInflatedTotal.value });
}
// The caps parsePack's options give: each override checked as limits' own key would be (capsOf).
export function packCaps(opts: PackParseOptions): Result<PackCaps, ErrorOf<'bad_request'>> {
  const limits = getOrElse(fromNullish(opts.limits), DEFAULT_LIMITS);
  const caps = capsOf(limits, ['maxPackObjects', 'maxInflatedTotal', 'maxObjectSize'], [opts.maxObjects, opts.maxInflatedTotal]);
  if (!caps.ok) return caps;
  const [maxObjects, maxInflatedTotal, maxObjectSize] = caps.value;
  return ok({ maxObjects, maxInflatedTotal, maxObjectSize });
}

// One object as parsePack read it: its type is one of the six, its declared size within maxObjectSize, its base parsed
// (a tagged ObjBase, a REF base an Oid), its data the inflated bytes (a delta's are its instructions).
export type ParsedObject = {
  readonly offset: number;
  readonly headerBytes: number;
  readonly type: ObjType;
  readonly size: number;
  readonly compressed: number;
  readonly data: Uint8Array;
  readonly base: ObjBase;
  readonly inflate: InflateStats;
};
export type PackStats = {
  readonly version: number;
  readonly count: number;
  full: number;
  ofsDelta: number;
  refDelta: number;
  readonly byType: Record<string, number>;
  compressed: number;
  inflated: number;
  readonly inflate: { blocks: number; stored: number; fixed: number; dynamic: number };
};
export type ParsedPack = { readonly objects: ParsedObject[]; readonly stats: PackStats; readonly trailer: string; readonly bytes: number };

// What a collector over the scan keeps of one object: the object (its inflated bytes), or nothing (a dropped object
// is still counted in the stats; a fetch that does not need it never holds it).
export type ObjectSink = (header: ScannedHeader) => boolean;
export type ScannedHeader = { readonly offset: number; readonly headerBytes: number; readonly type: ObjType; readonly size: ObjSize; readonly base: ObjBase };
const keepAll: ObjectSink = () => true;
// The object being collected: its header and the buffer its chunks land in (a declared size, so one buffer), or none
// when the sink dropped it.
type Collecting = { readonly header: ScannedHeader; readonly out: Uint8Array | null; at: number };
const freshStats = (version: number, count: number): PackStats => ({ version, count, full: 0, ofsDelta: 0, refDelta: 0, byType: {}, compressed: 0, inflated: 0, inflate: { blocks: 0, stored: 0, fixed: 0, dynamic: 0 } });
const kindOf = (type: ObjType): PackKind => nameOfTypeId(type);
function countBase(stats: PackStats, base: ObjBase): void {
  switch (base.tag) {
    case 'none': stats.full++; return;
    case 'ofs': stats.ofsDelta++; return;
    case 'ref': stats.refDelta++; return;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  assertNever(base);
}

// A pack read through the scan (packstream.ts) piece by piece, the objects collected as their chunks arrive: the
// collector is the only thing that holds an object, and only the ones `keep` asks for. Feed it with packCollectFeed and
// finish it with packCollectEnd; parsePack is the two over a buffer in hand.
export type PackCollector = {
  readonly scan: PackScan;
  readonly keep: ObjectSink;
  objects: ParsedObject[];
  stats: PackStats;
  trailer: string;
  bytes: number;
  cur: Collecting | null;
};
export function packCollectOpen(caps: PackCaps, verify: boolean, keep: ObjectSink = keepAll): Result<PackCollector, PackError> {
  const scan = packScanOpen(caps, verify);
  if (!scan.ok) return scan;
  // Stryker disable next-line StringLiteral: a placeholder, the trailer piece sets it before the end returns the pack
  return ok({ scan: scan.value, keep, objects: [], stats: freshStats(0, 0), trailer: '', bytes: 0, cur: null });
}
const UNIT: Result<null, never> = ok(null);
// One piece of the scan into the collector.
// oxlint-disable-next-line complexity -- one case per scan event
function collectPiece(c: PackCollector, p: PackPiece): void {
  switch (p.kind) {
    // collectDrain stops at `need` and `end`: neither reaches here, and neither carries anything to collect
    // Stryker disable next-line all: see above
    case 'need': case 'end': return;
    case 'header': c.stats = freshStats(p.version, p.count); return;
    case 'object': {
      const header: ScannedHeader = { offset: p.offset, headerBytes: p.headerBytes, type: p.type, size: p.size, base: p.base };
      countBase(c.stats, p.base);
      c.cur = { header, out: c.keep(header) ? new Uint8Array(p.size) : null, at: 0 };
      return;
    }
    case 'chunk': {
      const cur = c.cur;
      // a chunk always follows its object (cur is set), and a declared bound: the scan never yields past the object's
      // size, which is out's length
      // Stryker disable next-line ConditionalExpression: cur is never null here (above); a dropped object's out is
      if (cur !== null && cur.out !== null) cur.out.set(p.bytes, cur.at);
      // Stryker disable next-line ConditionalExpression: cur is never null here (above)
      if (cur !== null) cur.at += p.bytes.length;
      return;
    }
    case 'object-end': {
      const cur = c.cur;
      c.cur = null;
      // an object-end always follows its object
      // Stryker disable next-line ConditionalExpression,BlockStatement: see above
      if (cur === null) return;
      const { header } = cur;
      const kind = kindOf(header.type);
      c.stats.compressed += p.compressed; c.stats.inflated += header.size;
      c.stats.inflate.blocks += p.stats.blocks; c.stats.inflate.stored += p.stats.stored; c.stats.inflate.fixed += p.stats.fixed; c.stats.inflate.dynamic += p.stats.dynamic;
      c.stats.byType[kind] = getOrElse(readKey(c.stats.byType, kind), 0) + 1;
      if (cur.out !== null) c.objects.push({ ...header, compressed: p.compressed, data: cur.out, inflate: p.stats });
      return;
    }
    case 'trailer': c.trailer = p.trailer; return;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  assertNever(p);
}
// Pull until the scan wants more input or the pack has ended, or it is refused.
function collectDrain(c: PackCollector): Result<null, PackError> {
  for (;;) {
    const r = parsePackPull(c.scan);
    if (!r.ok) return r;
    if (r.value.kind === 'need' || r.value.kind === 'end') return UNIT;
    collectPiece(c, r.value);
  }
}
// Append pack bytes and collect what they complete. The bytes may be dropped by the caller once this returns.
export function packCollectFeed(c: PackCollector, bytes: Uint8Array): Result<null, PackError> {
  parsePackFeed(c.scan, bytes);
  c.bytes += bytes.length;
  return collectDrain(c);
}
// The input is over: the pack, or where it was refused.
export function packCollectEnd(c: PackCollector): Result<ParsedPack, PackError> {
  parsePackClose(c.scan);
  // a closed scan never asks for more: it ends or refuses
  const r = collectDrain(c);
  if (!r.ok) return r;
  return ok({ objects: c.objects, stats: c.stats, trailer: c.trailer, bytes: c.bytes });
}

// A pack in hand, parsed: every object kept. The scan's refusals, in its order, are this one's.
// @decoder parsePack prefix=pack
export function parsePack(buf: Uint8Array, opts: PackParseOptions = {}): Result<ParsedPack, PackError> {
  const caps = packCaps(opts);
  if (!caps.ok) return caps;
  const c = packCollectOpen(caps.value, opts.verify !== false);
  // the caps passed packCaps, so the scan's inflate record opens (packScanOpen)
  // Stryker disable next-line ConditionalExpression,BlockStatement: see above
  if (!c.ok) return c;
  // a refusal sticks on the scan: the end returns the feed's again
  packCollectFeed(c.value, buf);
  return packCollectEnd(c.value);
}

// ---- delta ----
export type DeltaOps = { copy: number; insert: number; copyBytes: number; insertBytes: number };
// A delta parsed once (parseDelta, #156): the source and result sizes from its header, its opcode counts, and its
// instructions checked: no reserved opcode, nothing cut, every copy inside the source, every insert inside the delta,
// exactly dstSize bytes out. The instructions stay in the delta's own bytes (`code`, from `start`): a record per op
// would cost tens of bytes of heap where its encoding costs one to eight, and a hostile delta's op count is bounded only
// by its length, so the parsed form would be an amplifier. Walking a parsed delta (deltaOps, applyProgram) cannot fail.
declare const deltaBrand: unique symbol;
export type DeltaProgram = {
  readonly srcSize: number;
  readonly dstSize: number;
  readonly ops: DeltaOps;
  readonly code: Uint8Array;
  readonly start: number;
  readonly [deltaBrand]: typeof deltaBrand;
};
// maxResult: the cap on the result's size (limits.maxDeltaResult when left out).
export type DeltaOptions = Input<{ readonly maxResult: number }>;
// The copy fields an opcode names, read from `p`: offset, length, and where the next opcode starts. Past the end a field
// reads 0 and `next` passes code.length, which the parser refuses as a short read (there is no allocation per byte).
type CopyOp = { readonly off: number; readonly len: number; readonly next: number };
function copyFields(code: Uint8Array, op: number, from: number): CopyOp {
  let p = from;
  const byte = (): number => atOr(code, p++, 0);
  // off and len are 0 until their first byte, so that byte is assigned, not or-ed in
  let off = 0;
  let len = 0;
  if (op & DELTA_COPY_OFF1) off = byte();
  if (op & DELTA_COPY_OFF2) off |= byte() << DELTA_OFF_SHIFT;
  if (op & DELTA_COPY_OFF3) off |= byte() << DELTA_BYTE2_SHIFT;
  if (op & DELTA_COPY_OFF4) off += byte() * DELTA_OFF4_FACTOR;
  if (op & DELTA_COPY_LEN1) len = byte();
  if (op & DELTA_COPY_LEN2) len |= byte() << DELTA_OFF_SHIFT;
  if (op & DELTA_COPY_LEN3) len |= byte() << DELTA_BYTE2_SHIFT;
  return { off, len: len === 0 ? DELTA_COPY_MAX : len, next: p };
}
// The last check, and the one that makes a parsed delta: the instructions produced exactly the result size.
type Unchecked = { readonly srcSize: number; readonly dstSize: number; readonly ops: DeltaOps; readonly code: Uint8Array; readonly start: number };
const producesExactly = (v: Unchecked, produced: number): v is DeltaProgram => produced === v.dstSize;
// The delta's header and every instruction, checked once: git's patch_delta, in its order (the result size against the
// cap, then the source size against the base when one is given, then the instructions).
// @decoder parseDelta prefix=delta
// oxlint-disable-next-line eslint/complexity -- one decoder: git's patch_delta, an opcode loop
export function parseDelta(delta: Uint8Array, opts: DeltaOptions = {}, baseSize: number | null = null): Result<DeltaProgram, PackError> {
  let maxResult = DEFAULT_LIMITS.maxDeltaResult;
  const given = fromNullable(opts.maxResult);
  if (given.tag === 'some') {
    const m = checkLimit(given.value, 'maxDeltaResult');
    if (!m.ok) return m;
    maxResult = m.value;
  }
  if (delta.length < DELTA_SIZE_MIN) return corrupt('delta: shorter than DELTA_SIZE_MIN');
  // readVarint's reads are bounded, so a header that runs past the buffer is a short read before p can pass the end.
  const bs = readVarint(delta, 0, 'delta');
  if (!bs.ok) return bs;
  const rs = readVarint(delta, bs.value[1], 'delta');
  if (!rs.ok) return rs;
  const srcSize = bs.value[0];
  const dstSize = rs.value[0];
  const start = rs.value[1];
  if (dstSize > maxResult) return err(limitError('delta result size', dstSize, maxResult));
  if (baseSize !== null && srcSize !== baseSize) return corrupt(`delta: base size ${srcSize} != ${baseSize}`);
  let p = start;
  let o = 0;
  const ops: DeltaOps = { copy: 0, insert: 0, copyBytes: 0, insertBytes: 0 };
  while (p < delta.length) {
    const c = delta[p++] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- p < delta.length (the loop)
    if (c & DELTA_COPY) {
      const f = copyFields(delta, c, p);
      p = f.next;
      if (p > delta.length) return short(delta, delta.length);
      if (f.off + f.len > srcSize || o + f.len > dstSize) return corrupt('delta: copy out of range');
      o += f.len;
      ops.copy++; ops.copyBytes += f.len;
    } else if (c) {
      if (p + c > delta.length || o + c > dstSize) return corrupt('delta: insert out of range');
      o += c; p += c;
      ops.insert++; ops.insertBytes += c;
    } else return corrupt('delta: reserved opcode 0');
  }
  const program: Unchecked = { srcSize, dstSize, ops, code: delta, start };
  if (!producesExactly(program, o)) return corrupt(`delta: produced ${o} != ${dstSize}`);
  return ok(program);
}
// A parsed delta's instructions, in order. Nothing here can fail: parseDelta checked every one.
export function* deltaOps(program: DeltaProgram): Generator<DeltaOp, void, unknown> {
  const code = program.code;
  let p = program.start;
  while (p < code.length) {
    const c = code[p++] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- p < code.length (the loop)
    if (c & DELTA_COPY) {
      const f = copyFields(code, c, p);
      p = f.next;
      yield { tag: 'copy', off: f.off, len: f.len };
    } else {
      yield { tag: 'insert', bytes: code.subarray(p, p + c) };
      p += c;
    }
  }
}
// A parsed delta over its base: the result, written into one buffer of dstSize bytes. The base must be srcSize bytes.
export function applyProgram(base: Uint8Array, program: DeltaProgram): Result<Uint8Array<ArrayBuffer>, Corrupt> {
  if (base.length !== program.srcSize) return corrupt(`delta: base size ${program.srcSize} != ${base.length}`);
  const out = new Uint8Array(program.dstSize);
  let o = 0;
  for (const op of deltaOps(program)) {
    switch (op.tag) {
      // in range: parseDelta checked off + len against srcSize, which is base.length (above)
      case 'copy': out.set(base.subarray(op.off, op.off + op.len), o); o += op.len; continue;
      case 'insert': out.set(op.bytes, o); o += op.bytes.length; continue;
    }
    // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
    assertNever(op);
  }
  return ok(out);
}
export type Patched = { out: Uint8Array; ops: DeltaOps };
// git's patch_delta: the delta parsed against the base's size, then applied.
// @decoder applyDelta prefix=delta
export function applyDelta(base: Uint8Array, delta: Uint8Array, opts: DeltaOptions = {}): Result<Patched, PackError> {
  const program = parseDelta(delta, opts, base.length);
  if (!program.ok) return program;
  const out = applyProgram(base, program.value);
  return out.ok ? ok({ out: out.value, ops: program.value.ops }) : out;
}

// Common-prefix/suffix delta between two buffers: one copy of the prefix, the middle inserted, one copy of the suffix
// (spliceDelta builds those instructions and encodes them).
export function makeDelta(base: Uint8Array, target: Uint8Array): SplicedDelta {
  let p = 0;
  const max = Math.min(base.length, target.length);
  while (p < max && base[p] === target[p]) p++;
  let s = 0;
  while (s < max - p && base[base.length - 1 - s] === target[target.length - 1 - s]) s++;
  // p + s <= min(base.length, target.length) by the loops above: a view, it cannot be short
  return spliceDelta({ baseLen: base.length, off: p, oldLen: base.length - p - s, insert: target.subarray(p, target.length - s) });
}

// ---- resolve ----
// A base from outside the pack (a thin pack's), as the caller's `external` returns it: plain values, parsed where the
// resolver reads them (externalBase).
export type ExternalBase = { readonly type: number; readonly data: Uint8Array };
// The caller's lookup of a thin base by id. Anything falsy (null, or a JavaScript function's bare `return`) is "not
// here"; `void` is how a function type admits that bare return.
// oxlint-disable-next-line typescript/no-invalid-void-type -- a JavaScript caller's lookup may return nothing (see above)
export type ExternalLookup = (oid: Oid) => ExternalBase | null | void;
// A full object as resolvePack returns it; a delta's result also carries its delta's opcode counts.
export type ResolvedFull = {
  readonly type: ResolvedObjType;
  readonly data: Uint8Array;
  readonly chain: number;
  readonly oid: Oid;
  readonly offset: number;
  readonly size: number;
  readonly compressed: number;
  readonly base: ObjBase;
};
export type ResolvedDelta = ResolvedFull & { readonly deltaOps: DeltaOps };
export type ResolvedObject = ResolvedFull | ResolvedDelta;
// A base as a hand-built object may give it: the tagged form with plain values (an id as a string), parsed at the edge.
export type BaseInput = { readonly tag: 'none' } | { readonly tag: 'ofs'; readonly offset: number } | { readonly tag: 'ref'; readonly oid: string };
// One object as resolvePack takes it: parsePack's (a ParsedObject is one), or built by hand with plain values. A left-out
// base is none; a left-out size or compressed count is the data's length and 0.
export type PackObjectInput = { readonly offset: number; readonly type: number; readonly data: Uint8Array } & Input<{ readonly base: BaseInput; readonly size: number; readonly compressed: number }>;
// What resolvePack reads of a parsed pack: parsePack's result, or a hand-built one (stats optional).
export type PackToResolve = { readonly objects: readonly PackObjectInput[] } & Input<{ readonly stats: Input<{ readonly inflated: number }> }>;
export type ResolvedPack = { readonly objects: Map<string, ResolvedObject>; readonly stats: { maxChain: number; externalBases: number; baseLookups: number } };
type Base = { readonly type: ResolvedObjType; readonly data: Uint8Array; readonly chain: number };
// One object of the resolver's input, parsed (packEntry): a full object's type is a stored type, a delta's base tagged.
type Entry =
  | { readonly tag: 'full'; readonly offset: number; readonly type: ResolvedObjType; readonly data: Uint8Array; readonly size: number; readonly compressed: number; readonly base: ObjBase }
  | { readonly tag: 'delta'; readonly offset: number; readonly data: Uint8Array; readonly size: number; readonly compressed: number; readonly base: ObjBase & { readonly tag: 'ofs' | 'ref' } };

type BadRequest = ErrorOf<'bad_request'>;
const badObject = (offset: unknown, why: string): Err<BadRequest> => fail('bad_request', `resolvePack: object at ${String(offset)} ${why}`, { what: 'object' });
// A hand-built base, parsed: the tag one of the three, an OFS offset a non-negative safe integer, a REF id an Oid.
function parseBase(offset: number, given: Input<{ readonly base: BaseInput }>): Result<ObjBase, BadRequest> {
  const b = fromNullish(given.base);
  if (b.tag === 'none') return ok(NO_BASE);
  const base = b.value;
  // a JavaScript caller's tag outside the three
  if (base.tag !== 'none' && base.tag !== 'ofs' && base.tag !== 'ref') return badObject(offset, `has base tag ${JSON.stringify(Reflect.get(base, 'tag'))}`);
  switch (base.tag) {
    case 'none': return ok(NO_BASE);
    case 'ofs':
      if (!Number.isSafeInteger(base.offset) || base.offset < 0) return badObject(offset, `has ofs base ${String(base.offset)}`);
      return ok({ tag: 'ofs', offset: base.offset });
    case 'ref': {
      const oid = parseOid(base.oid);
      if (!oid.ok) return badObject(offset, `has ref base ${JSON.stringify(base.oid)}, not an object id`);
      return ok({ tag: 'ref', oid: oid.value });
    }
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(base);
}
// The resolver's edge (#156): each object's plain values parsed once into an Entry. A full object's type is commit,
// tree, blob or tag; a delta's type is not read (its result is its base's type).
function packEntry(o: PackObjectInput): Result<Entry, BadRequest> {
  const base = parseBase(o.offset, o);
  if (!base.ok) return base;
  // read once: the entry holds it from here
  const data: unknown = o.data;
  if (!(data instanceof Uint8Array)) return badObject(o.offset, 'has no data');
  const size = getOrElse(fromNullish(o.size), data.length);
  const compressed = getOrElse(fromNullish(o.compressed), 0);
  const b = base.value;
  if (b.tag !== 'none') return ok({ tag: 'delta', offset: o.offset, data, size, compressed, base: b });
  const type = storedType(o.type);
  if (type === null) return badObject(o.offset, `has type ${String(o.type)} and no base`);
  return ok({ tag: 'full', offset: o.offset, type, data, size, compressed, base: b });
}

// One object's resolution: done, waiting on a REF_DELTA base that has not been resolved yet (in this phase), or refused.
// `waiting` is the typed form of what used to be a pack_corrupt "ref delta base … not found" caught back by a regex on
// its message (#76).
type Step =
  | { readonly tag: 'resolved'; readonly r: ResolvedObject }
  | { readonly tag: 'waiting'; readonly oid: Oid }
  | { readonly tag: 'failed'; readonly error: PackError };
const failed = (error: PackError): Step => ({ tag: 'failed', error });
// The fixpoint's phase: REF_DELTA bases from the pack only, until a pass makes no progress; then the caller's
// `external` lookup too (a thin pack's bases); then, if a pass still makes no progress, the first waiting object's
// missing base is the error.
type Phase = 'in_pack' | 'external';

// A REF_DELTA whose base is not in the pack, kept instead of refused. `oid` is that missing base (the root the fixpoint
// was waiting on), in pack order of the objects that could not be resolved.
export type UnresolvedBase = { readonly offset: number; readonly oid: Oid };
export type CollectedPack = ResolvedPack & { readonly unresolved: readonly UnresolvedBase[] };

// A thin REF base must be exactly the object git stored under that oid: the four stored types only
// (commit, tree, blob, tag), and the SHA-1 of "type SP size NUL" + bytes must equal the named oid.
// Anything else is pack_corrupt before applyDelta.
function externalBase(oid: Oid, ext: ExternalBase): Result<Base, Corrupt> {
  const type = storedType(ext.type);
  // a delta type, 0, 5, or any other non-object id
  if (type === null) return corrupt(`pack: ref delta base ${oid} has type ${ext.type}`);
  const hashed = hashObject(storedName(type), ext.data);
  if (hashed !== oid) return corrupt(`pack: ref delta base ${oid} hashes to ${hashed}`);
  return ok({ type, data: ext.data, chain: 0 });
}

// The fixpoint. `collectMissing` is describePack's path: a thin base is data, not an error. Without it a thin base the
// lookup does not have is refused (`pack: ref delta base … not found`), which callers and the pack-cut space depend on.
// oxlint-disable-next-line complexity -- the fixpoint's phases, one function so the memo and the budget are shared
function fixpoint(parsed: PackToResolve, external: ExternalLookup, limits: Limits, collectMissing: boolean): Result<CollectedPack, PackError> {
  const caps = capsOf(limits, ['maxDeltaChain', 'maxDeltaResult', 'maxInflatedTotal']);
  if (!caps.ok) return caps;
  const [maxChain, maxDelta, inflatedCap] = caps.value;
  const entries: Entry[] = [];
  for (const o of parsed.objects) {
    const e = packEntry(o);
    if (!e.ok) return e;
    entries.push(e.value);
  }
  const byOffset = new Map(entries.map(o => [o.offset, o]));
  // REF_DELTA lookup is this map, not a scan of the objects (that is O(n) per delta, O(passes·n²) on a pack of tiny
  // ref-deltas). Resolved deltas join the same map.
  const byOid = new Map<Oid, Entry>();
  const resolved = new Map<string, ResolvedObject>();
  const memo = new Map<number, ResolvedObject>();
  const stats = { maxChain: 0, externalBases: 0, baseLookups: 0 };
  // Bytes already held (inflated instructions and bases) plus each delta result, which is a new buffer, and
  // LIMIT_OBJECT_OVERHEAD per object, as parsePack charged it. That one charge covers the object's resolved form too
  // (measured: resolving adds 0.65 KiB per object, delta or not), so a delta result adds its bytes only.
  const given = flatMapOption(fromNullish(parsed.stats), s => fromNullish(s.inflated));
  let held = (given.tag === 'some' ? given.value : entries.reduce((n, o) => n + o.data.length, 0)) + entries.length * LIMIT_OBJECT_OVERHEAD;
  let phase: Phase = 'in_pack';
  // The base of a delta: the object at its offset (OFS_DELTA), or the object named by its id (REF_DELTA).
  type BaseOrStep = { readonly tag: 'base'; readonly base: Base } | Step;
  function findBase(base: ObjBase & { readonly tag: 'ofs' | 'ref' }, depth: number, resolveFn: (o: Entry, d: number) => Step): BaseOrStep {
    switch (base.tag) {
      case 'ofs': {
        const b = mapGet(byOffset, base.offset);
        if (b.tag === 'none') return failed(plyError('pack_corrupt', `pack: ofs delta base not at object boundary ${base.offset}`));
        const s = resolveFn(b.value, depth + 1);
        if (s.tag !== 'resolved') return s;
        return { tag: 'base', base: s.r };
      }
      case 'ref': {
        stats.baseLookups++;
        const inPack = mapGet(byOid, base.oid);
        if (inPack.tag === 'some') {
          // byOid holds resolved objects only, so this is the memo's answer, whatever the depth
          // Stryker disable next-line ArithmeticOperator: see above
          const s = resolveFn(inPack.value, depth + 1);
          // Stryker disable next-line ConditionalExpression,BlockStatement: an object in byOid has resolved (above)
          if (s.tag !== 'resolved') return s;
          return { tag: 'base', base: s.r };
        }
        if (phase !== 'external') return { tag: 'waiting', oid: base.oid };
        const ext = external(base.oid);
        if (!ext) return { tag: 'waiting', oid: base.oid };
        const checked = externalBase(base.oid, ext);
        if (!checked.ok) return failed(checked.error);
        stats.externalBases++;
        return { tag: 'base', base: checked.value };
      }
    }
    // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
    return assertNever(base);
  }
  // A delta's resolved form: its base's bytes patched by its instructions.
  function patch(obj: Entry & { readonly tag: 'delta' }, base: Base): Result<ResolvedObject, PackError> {
    // Chain length, not recursion depth: a base resolved earlier comes back from memo, so depth alone let a chain
    // emitted base-first grow without bound (#14). An external base is chain 0.
    const chain = base.chain + 1;
    if (chain > maxChain) return err(limitError('delta chain depth', chain, maxChain));
    // The result buffer does not exist until the delta's header passes maxResult. Room is what the aggregate cap has left.
    const room = inflatedCap - held;
    if (room < 0) return err(limitError('pack inflated bytes', held, inflatedCap));
    const patched = applyDelta(base.data, obj.data, { maxResult: Math.min(maxDelta, room) });
    if (!patched.ok) return patched;
    held += patched.value.out.length;
    const out = patched.value.out;
    return ok({ type: base.type, data: out, chain, deltaOps: patched.value.ops, oid: hashObject(storedName(base.type), out), offset: obj.offset, size: obj.size, compressed: obj.compressed, base: obj.base });
  }
  function resolveObj(obj: Entry, depth = 0): Step {
    const hit = mapGet(memo, obj.offset);
    if (hit.tag === 'some') return { tag: 'resolved', r: hit.value };
    if (depth > maxChain) return failed(limitError('delta chain depth', depth, maxChain));
    let r: ResolvedObject;
    if (obj.tag === 'full') {
      r = { type: obj.type, data: obj.data, chain: 0, oid: hashObject(storedName(obj.type), obj.data), offset: obj.offset, size: obj.size, compressed: obj.compressed, base: obj.base };
    } else {
      const b = findBase(obj.base, depth, resolveObj);
      if (b.tag !== 'base') return b;
      const built = patch(obj, b.base);
      if (!built.ok) return failed(built.error);
      r = built.value;
    }
    if (r.chain > stats.maxChain) stats.maxChain = r.chain;
    memo.set(obj.offset, r);
    resolved.set(r.oid, r);
    byOid.set(r.oid, obj);
    return { tag: 'resolved', r };
  }
  // Full objects first: each is hashed once (resolveObj) and registered, so a REF_DELTA finds it by id.
  for (const o of entries) {
    if (o.tag === 'delta') continue;
    const s = resolveObj(o);
    // a full object resolves: it has no base to wait on or refuse
    // Stryker disable next-line ConditionalExpression,BlockStatement: see above
    if (s.tag === 'failed') return err(s.error);
  }
  // Until nothing is pending: a pass either resolves something, or moves to the external phase once, or ends in an
  // error. A REF chain emitted child-first resolves one link per pass, so the pass count is bounded by the chain check
  // above (≤ 2 · maxDeltaChain + 2), not by a pass ceiling that used to return the tail unresolved without an error (#14).
  // Stryker disable next-line MethodExpression,ConditionalExpression: a full object left in is resolved already, and comes back from the memo
  let pending: Entry[] = entries.filter(o => o.tag === 'delta');
  while (pending.length > 0) {
    const next: Entry[] = [];
    let missingOid = '';
    let haveMissing = false;
    const waited: UnresolvedBase[] = [];
    for (const o of pending) {
      const s = resolveObj(o);
      switch (s.tag) {
        case 'failed': return err(s.error);
        case 'waiting':
          next.push(o);
          waited.push({ offset: o.offset, oid: s.oid });
          if (!haveMissing) { missingOid = s.oid; haveMissing = true; }
          continue;
        case 'resolved': continue;
      }
      // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(s);
    }
    if (next.length === pending.length) {
      // no progress even with external bases: the first waiting object's base is missing from the pack and the caller
      if (phase === 'external') {
        if (collectMissing) return ok({ objects: resolved, stats, unresolved: waited });
        return corrupt(`pack: ref delta base ${missingOid} not found`);
      }
      phase = 'external'; // every in-pack base is known now; the rest are thin bases
    }
    pending = next;
  }
  return ok({ objects: resolved, stats, unresolved: [] });
}

// Stryker disable next-line ArrowFunction: null and a bare return both mean the base is not in the pack
const noBase = (): null => null;

// objects from parsePack (or built by hand, parsed here: an invalid one is bad_request); external(oid) -> {type, data}
// for thin bases. A thin base the lookup does not have is refused.
export function resolvePack(parsed: PackToResolve, external: ExternalLookup = noBase, limits: Limits = DEFAULT_LIMITS): Result<ResolvedPack, PackError> {
  const r = fixpoint(parsed, external, limits, false);
  return r.ok ? ok({ objects: r.value.objects, stats: r.value.stats }) : r;
}
// resolvePack, keeping what a thin base it does not have leaves unresolved instead of refusing it: those objects'
// offsets and the bases they wait on (a wide fetch that dropped blobs reads them as blobs; describePack as missingBases).
export function resolvePackCollect(parsed: PackToResolve, external: ExternalLookup, limits: Limits): Result<CollectedPack, PackError> {
  return fixpoint(parsed, external, limits, true);
}

// ---- layout (git verify-pack -v) ----
// What verify-pack prints for one object, plus the wire type it does not print. `size` is the pack header's inflated
// size (the delta or the object), not the resolved object. `type` is the resolved object type, which a missing thin
// base hides. No span: this is a pure read of bytes already in hand; the span belongs to the fetch that received them.
// A base: none (a full object); an OFS_DELTA's offset, and the base object's id once that object resolved; a REF_DELTA's
// id, whether or not the object is in the pack.
export type PackBase =
  | { readonly tag: 'none' }
  | { readonly tag: 'ofs'; readonly offset: number; readonly oid: Oid | null }
  | { readonly tag: 'ref'; readonly oid: Oid };
export type PackLayoutObject = {
  readonly offset: number;
  readonly headerBytes: number;
  readonly compressed: number;
  readonly size: number;
  readonly wireType: ObjType;
  readonly type: ResolvedObjType | null;
  readonly oid: Oid | null;
  readonly base: PackBase;
  readonly depth: number;
};
export type PackLayout = {
  readonly version: typeof PACK_VERSION;
  readonly count: number;
  readonly trailer: string;
  readonly objects: readonly PackLayoutObject[];
  // First-seen unique REF bases that are not in the pack, in pack order. These are the objects
  // `git index-pack --fix-thin` appends.
  readonly missingBases: readonly Oid[];
};

function baseOf(obj: ParsedObject, memo: ReadonlyMap<number, ResolvedObject>): PackBase {
  switch (obj.base.tag) {
    case 'none': return obj.base;
    case 'ofs': {
      const base = mapGet(memo, obj.base.offset);
      return { tag: 'ofs', offset: obj.base.offset, oid: base.tag === 'some' ? base.value.oid : null };
    }
    case 'ref': return obj.base;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(obj.base);
}
// Depth of an object the fixpoint could not hash. That only happens when a REF base is outside the pack, and a
// resolved base would have resolved this object too, so the walk never lands on a memoised object. An external base
// is chain 0: a REF_DELTA on it is 1, and an OFS_DELTA on that object is one deeper. Same numbers verify-pack prints
// once index-pack has appended the base.
function chainDepth(obj: ParsedObject, byOffset: ReadonlyMap<number, ParsedObject>): number {
  if (obj.base.tag !== 'ofs') return 1;
  const base = mapGet(byOffset, obj.base.offset);
  // Stryker disable next-line ConditionalExpression: an ofs offset that is not an object is pack_corrupt before layout
  if (base.tag === 'none') return 0;
  return chainDepth(base.value, byOffset) + 1;
}
function packLayout(parsed: ParsedPack, resolved: CollectedPack): PackLayout {
  const memo = new Map<number, ResolvedObject>();
  for (const r of resolved.objects.values()) memo.set(r.offset, r);
  const byOffset = new Map(parsed.objects.map(o => [o.offset, o]));
  const objects: PackLayoutObject[] = [];
  for (const obj of parsed.objects) {
    const found = mapGet(memo, obj.offset);
    const r = found.tag === 'some' ? found.value : null;
    objects.push({
      offset: obj.offset,
      headerBytes: obj.headerBytes,
      compressed: obj.compressed,
      size: obj.size,
      wireType: obj.type,
      type: r ? r.type : null,
      oid: r ? r.oid : null,
      base: baseOf(obj, memo),
      depth: r ? r.chain : chainDepth(obj, byOffset),
    });
  }
  const missingBases: Oid[] = [];
  const seenOid = new Set<Oid>();
  for (const u of resolved.unresolved) {
    if (seenOid.has(u.oid)) continue;
    seenOid.add(u.oid);
    missingBases.push(u.oid);
  }
  return { version: PACK_VERSION, count: parsed.stats.count, trailer: parsed.trailer, objects, missingBases };
}

// The pack's layout as `git verify-pack -v` prints it. A thin REF base is `missingBases`, not an error and not a
// message to match. Limits are the same ones parse and resolve already enforce.
export function describePack(buf: Uint8Array, limits: Limits = DEFAULT_LIMITS): Result<PackLayout, PackError> {
  const parsed = parsePack(buf, { limits });
  if (!parsed.ok) return parsed;
  const resolved = fixpoint(parsed.value, noBase, limits, true);
  if (!resolved.ok) return resolved;
  return ok(packLayout(parsed.value, resolved.value));
}
