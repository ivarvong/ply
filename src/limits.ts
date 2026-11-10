// Bounds on everything an untrusted server (or a careless caller) can size. Every allocation driven by
// wire data checks one of these before the buffer exists. A caller's record is parsed once, where it enters
// (parseLimits: a transport, an operation, a public codec): a key it gives must be a finite non-negative number, a key
// it leaves out is the default. Past that line the record is a total CheckedLimits and every read is a property read:
// a missing value compared with `>` is false in JS, so no unchecked record may reach a check.
import type { ErrorOf } from './errors.js';
import { plyError } from './errors.js';
import type { Result } from './result.js';
import { err, getOrElse, ok } from './result.js';
import type { Input } from './absent.js';
import { fromNullish, withDefaults } from './absent.js';

/* oxlint-disable no-magic-numbers -- these are the cap definitions; parsers import the names */

const KIB = 1024;
const MIB = KIB * KIB;

/**
 * Each side of a line merge. git's MAX_XDIFF_SIZE (xdiff/xdiff.h) is ~1 GiB; a Worker isolate is not.
 * 8 MiB is large enough for a source file and small enough to reject a blob the merger cannot hold twice.
 */
export const LIMIT_MERGE_BLOB: number = 8 * MIB;
/**
 * Inflated size of any single non-streamed object (trees, commits, tags, metadata blobs).
 * gitformat-pack does not cap this; 64 MiB is one object a Worker-sized heap can still inflate and hash.
 */
export const LIMIT_OBJECT: number = 64 * MIB;
/** Commits and trees kept from an over-wide blob:none pack. Half an object, so a harvest cannot hide a second full one. */
export const LIMIT_HARVEST: number = LIMIT_OBJECT / 2;
/**
 * Band-1 (pack) bytes one fetch may deliver, buffered or streamed, and band-2 bytes beside them; also one advertisement,
 * one receive-pack report. Two objects, on the wire. A streamed blob holds none of it, but its ingress has to end
 * somewhere a caller controls: 128 MiB is above GitHub's 100 MiB file cap, so any blob GitHub stores streams under it.
 */
export const LIMIT_PACK_WIRE: number = LIMIT_OBJECT * 2;
/**
 * Blob bytes one pushTree may hold before it builds the tree. The same ceiling as the pack on the wire, so one
 * maximum object still fits and three 48 MiB blobs (144 MiB, which peaked near 440 MB RSS) do not.
 */
export const LIMIT_PUSH_BYTES: number = LIMIT_PACK_WIRE;
/** Result size a delta header may claim (gitformat-pack "Deltified representation"). Same ceiling as one object. */
export const LIMIT_DELTA_RESULT: number = LIMIT_OBJECT;
/**
 * Delta chain depth. pack-objects' default window depth is 50; 64 is past that and still a fixed walk.
 * resolvePack counts deltas from the full (or external) base, so no resolved object is more than 64 deltas deep in
 * either pack order (test/delta-bound.test.js).
 */
export const LIMIT_DELTA_CHAIN = 64;
/**
 * How many maximum-sized objects a buffered pack may inflate at once, including delta results resolvePack
 * allocates on top of the inflated instructions. Four covers a merge-base triple (base, ours, theirs) plus
 * the commit that names them. Issue #9's 6 × 64 MiB pack is 384 MiB and must fail before that resident set exists.
 * Each object also pays LIMIT_OBJECT_OVERHEAD (below), so the four are three maximum objects and a small one.
 */
export const LIMIT_INFLATED_OBJECTS = 4;
export const LIMIT_INFLATED_TOTAL: number = LIMIT_OBJECT * LIMIT_INFLATED_OBJECTS;
/**
 * Objects in one buffered pack. gitformat-pack stores the count as a uint32, which is not a memory or CPU bound.
 * 100_000 is above a blob:none listing of a large repository's trees (the kernel is on the order of 10^4 trees)
 * and is the ceiling for a REF_DELTA fixpoint: one Map lookup per object per pass, not a scan of the pack.
 */
export const LIMIT_PACK_OBJECTS = 100_000;
/** ls-refs lines, and the rebase chain walked from them. */
export const LIMIT_REFS = 10_000;
export const LIMIT_REBASE_COMMITS: number = LIMIT_REFS;
/** shallow, ack, and any other v2 section lines per fetch. */
export const LIMIT_SECTION_LINES = 1000;
/**
 * Entries parsed from one tree. A max-sized tree of minimum entries (git's "too-short tree object" floor)
 * is millions of names; this stops before that array exists.
 */
export const LIMIT_TREE_ENTRIES = 200_000;
/** PATH_MAX for one component, and a depth no real worktree uses. */
export const LIMIT_PATH_DEPTH = 128;
export const LIMIT_PATH_COMPONENT = 4096;
/**
 * Merge-base doubling search. The walk starts at 8 and doubles; 1024 is eight steps, and the pack byte cap
 * fires on a wide blob:none window before a deeper search would.
 */
export const LIMIT_MERGE_DEPTH = 1024;
/**
 * report-status pkt-lines buffered from receive-pack: one unpack line, one status per ref, plus
 * report-status-v2 option lines. The ref cap is the same order. push reads at least as many lines as git sends for
 * the commands pushed (1 + N, or 1 + 5N with report-status-v2; push.ts reportLineCap), so a push of N <= maxRefs
 * commands never trips this cap; a larger value admits a proc-receive hook that reports one command as several refs.
 */
export const LIMIT_REPORT_LINES: number = LIMIT_REFS;
/**
 * Parents on one commit. An octopus is a handful; a commit that lists more parents than the ref cap is not
 * a history bestBases will walk.
 */
export const LIMIT_COMMIT_PARENTS: number = LIMIT_REFS;
/**
 * Decoded ls-refs payload bytes. maxRefs lines at the pkt-line maximum (gitprotocol-common: 65520) is
 * hundreds of MiB; the buffered-response cap we already accept for one pack is the ceiling.
 */
export const LIMIT_LS_REFS_BYTES: number = LIMIT_PACK_WIRE;
/**
 * The whole HTTP exchange, opt-in: 0 (the default) is no total cap, so a long healthy stream is never cut for its
 * duration alone (#255). A positive value bounds the exchange end to end, body included, as before #255. Stalls are
 * bounded by the two timers below whatever this is (src/deadline.ts).
 */
export const LIMIT_REQUEST_TIMEOUT_MS = 0;
/** From the request (or the end of a streamed upload) to the response headers. 0 turns it off. */
export const LIMIT_FIRST_BYTE_TIMEOUT_MS = 60_000;
/** The longest gap with no progress: no upload chunk pulled, no response body chunk read. 0 turns it off. */
export const LIMIT_IDLE_TIMEOUT_MS = 60_000;
/**
 * What one held object costs beyond its bytes, charged against the byte budget that holds it: each parsed pack object
 * against maxInflatedTotal (parsePack, and resolvePack's room), each local object against it (pushRepo), each file or
 * change against maxPushBytes (fileEntries, commitChanges), each walked file against maxInflatedTotal (filesFromDir).
 * Without it 100 000 three-byte blobs (1.4 MB of pack) pass every byte cap and exhaust a 128 MiB heap (#142).
 * Measured on node 22 (`--expose-gc`, heapUsed after two gc() calls, the result held; scratch scripts in #142):
 * parsePack + resolvePack of N tiny blobs retains 1.05 KiB per object (0.40 parse, 0.65 resolve), fetchPack with a
 * tracer 1.15 KiB, and at --max-old-space-size=128 fetchPack survives 90 000 and dies at 99 000 (≥ 1.3 KiB live per
 * object at the peak); RSS grows 2.0 to 2.3 KiB per object. pushTree of 8-byte files: RSS grows 2.4 KiB per file, and at
 * 128 MiB it survives 75 000 and dies at 100 000 (≥ 1.3 KiB per file). 3 KiB is above every one of those numbers, so
 * a byte budget sized for a heap stays inside it however the bytes are split; on DEFAULT_LIMITS that is about 87 000
 * tiny objects in one pack and 43 000 tiny files in one push. Not a Limits key: it is a property of this code, not a policy.
 */
export const LIMIT_OBJECT_OVERHEAD: number = 3 * KIB;

/**
 * Inflated bytes a work-budgeted pack scan may produce per pack byte consumed, past the maxInflatedTotal it may always
 * spend. Not a memory figure (such a scan keeps no object): it bounds the CPU a pack can buy. DEFLATE reaches about
 * 1032:1; real packs measure far below this (deltas inflate only their instructions).
 */
export const LIMIT_WORK_RATIO = 32;
/* oxlint-enable no-magic-numbers */

export type Limits = {
  readonly maxMergeBlobBytes: number;
  readonly maxObjectSize: number;
  readonly maxHarvestBytes: number;
  readonly maxPackBytes: number;
  readonly maxPushBytes: number;
  readonly maxDeltaResult: number;
  readonly maxDeltaChain: number;
  readonly maxInflatedTotal: number;
  readonly maxPackObjects: number;
  readonly maxRefs: number;
  readonly maxRebaseCommits: number;
  readonly maxSectionLines: number;
  readonly maxTreeEntries: number;
  readonly maxPathDepth: number;
  readonly maxPathComponent: number;
  readonly maxMergeDepth: number;
  readonly maxReportLines: number;
  readonly maxCommitParents: number;
  readonly maxLsRefsBytes: number;
  readonly requestTimeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly idleTimeoutMs: number;
};
export type LimitKey = keyof Limits;

// A limits record parsed once (#156): every key present, each a finite non-negative number. The brand is a module
// symbol, written only here (parseLimits, and the presets below); it is not enumerable, so a spread of a checked record
// is a plain record again and is parsed afresh. Internal code takes CheckedLimits and reads its keys directly.
const CHECKED_LIMITS: unique symbol = Symbol('checkedLimits');
export type CheckedLimits = Limits & { readonly [CHECKED_LIMITS]: true };
// What a caller passes: any subset of the keys (a missing key is the default), or none.
export type LimitsInput = Input<Limits>;

// The brand on a record whose every value is a finite non-negative number (each caller's check, or arithmetic on checked
// values). Frozen: the record is shared by every read past the edge.
function grant(values: Limits): CheckedLimits {
  // Stryker disable next-line BooleanLiteral: the brand is its presence (isChecked reads Object.hasOwn); its value is never read
  const checked: CheckedLimits = { ...values, [CHECKED_LIMITS]: true };
  Object.defineProperty(checked, CHECKED_LIMITS, { enumerable: false });
  return Object.freeze(checked);
}
const isChecked = (value: LimitsInput): value is CheckedLimits => Object.hasOwn(value, CHECKED_LIMITS);

export const DEFAULT_LIMITS: CheckedLimits = grant({
  maxMergeBlobBytes: LIMIT_MERGE_BLOB,
  maxObjectSize: LIMIT_OBJECT,
  maxHarvestBytes: LIMIT_HARVEST,
  maxPackBytes: LIMIT_PACK_WIRE,
  maxPushBytes: LIMIT_PUSH_BYTES,
  maxDeltaResult: LIMIT_DELTA_RESULT,
  maxDeltaChain: LIMIT_DELTA_CHAIN,
  maxInflatedTotal: LIMIT_INFLATED_TOTAL,
  maxPackObjects: LIMIT_PACK_OBJECTS,
  maxRefs: LIMIT_REFS,
  maxRebaseCommits: LIMIT_REBASE_COMMITS,
  maxSectionLines: LIMIT_SECTION_LINES,
  maxTreeEntries: LIMIT_TREE_ENTRIES,
  maxPathDepth: LIMIT_PATH_DEPTH,
  maxPathComponent: LIMIT_PATH_COMPONENT,
  maxMergeDepth: LIMIT_MERGE_DEPTH,
  maxReportLines: LIMIT_REPORT_LINES,
  maxCommitParents: LIMIT_COMMIT_PARENTS,
  maxLsRefsBytes: LIMIT_LS_REFS_BYTES,
  requestTimeoutMs: LIMIT_REQUEST_TIMEOUT_MS,
  firstByteTimeoutMs: LIMIT_FIRST_BYTE_TIMEOUT_MS,
  idleTimeoutMs: LIMIT_IDLE_TIMEOUT_MS,
});

/**
 * Limits for a 128 MiB isolate (a Cloudflare Worker), where DEFAULT_LIMITS are sized for a git client's heap. One object
 * peaks near twice its size (the inflate output and the buffer the caller holds), so the object and delta caps are
 * 16 MiB and the inflated total, which also pays LIMIT_OBJECT_OVERHEAD per object, is 64 MiB: half the isolate, about
 * 21 000 tiny objects. The wire caps (pack, push, ls-refs) are two objects, as in the defaults. maxHarvestBytes is half an
 * object, maxMergeBlobBytes 2 MiB (the line merger holds each side more than twice), and maxTreeEntries 32 768
 * (a listed entry keeps ~150 B of heap, so the 200 000 default is ~30 MiB of the isolate's 128: #140). Every other cap
 * is the default. The limit sweep runs these at --max-old-space-size=128 (test/sweep/matrix.mjs, `worker.*` cells):
 * each refuses or succeeds, none runs out of memory.
 */
/* oxlint-disable no-magic-numbers -- the preset's cap definitions, as above */
export const WORKER_LIMITS: CheckedLimits = grant({
  ...DEFAULT_LIMITS,
  maxObjectSize: 16 * MIB,
  maxPackBytes: 32 * MIB,
  maxPushBytes: 32 * MIB,
  maxLsRefsBytes: 32 * MIB,
  maxInflatedTotal: 64 * MIB,
  maxDeltaResult: 16 * MIB,
  maxHarvestBytes: 8 * MIB,
  maxMergeBlobBytes: 2 * MIB,
  maxTreeEntries: 32_768,
});
/* oxlint-enable no-magic-numbers */

// A caller's overrides on top of the defaults, as a plain record: it is checked where it enters (parseLimits).
export const withLimits = (o: Partial<Limits> = {}): Limits => Object.freeze({ ...DEFAULT_LIMITS, ...o });

// Absent, NaN, Infinity, or negative: the check would not bound anything. Fail before any allocation.
export const checkLimit = (value: unknown, what: string): Result<number, ErrorOf<'bad_request'>> =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? ok(value)
    : err(plyError('bad_request', `limits.${what} must be a finite non-negative number`, { what, got: value }));

// The caller's limits record (any subset), or none (null), parsed once where it enters. A key it gives must pass
// checkLimit (the refusal names the key, `got` is what was passed; keys are checked in DEFAULT_LIMITS order); a key it
// leaves out, or passes as the missing value, is DEFAULT_LIMITS's. Keys this version does not read are ignored. A
// record parseLimits already returned is returned as it is; none (null) is DEFAULT_LIMITS.
// @decoder parseLimits prefix=limits
export function parseLimits(input: LimitsInput | null): Result<CheckedLimits, ErrorOf<'bad_request'>> {
  if (input === null) return ok(DEFAULT_LIMITS);
  if (isChecked(input)) return ok(input);
  // A spread of DEFAULT_LIMITS: its keys (the brand is not enumerable), in order, each filled from the input where given.
  const filled = withDefaults<Limits>(input, { ...DEFAULT_LIMITS });
  for (const [key, value] of Object.entries(filled)) {
    const checked = checkLimit(value, key);
    if (!checked.ok) return checked;
  }
  return ok(grant(filled));
}

// The limits an entry's options name (`limits`: any subset; left out or null is the defaults), parsed once at the entry.
export const limitsOf = (options: Input<{ readonly limits: LimitsInput | null }>): Result<CheckedLimits, ErrorOf<'bad_request'>> =>
  parseLimits(getOrElse<LimitsInput | null>(fromNullish(options.limits), null));

// A checked record with one bound lowered to `value` (never raised): an operation's room for one step (what is left of
// a budget, a tighter per-call cap). `value` is arithmetic on checked bounds; below zero is zero.
export const lowered = (limits: CheckedLimits, key: LimitKey, value: number): CheckedLimits =>
  grant({ ...limits, [key]: Math.max(0, Math.min(limits[key], value)) });

// The value for `what` exceeding its bound: `got` against `max`.
export const limitExceeded = (what: string, got: number, max: number): ErrorOf<'limit_exceeded'> =>
  plyError('limit_exceeded', `${what} ${got} exceeds limit ${max}`, { what, got, max });

export { limitExceeded as limitError };
