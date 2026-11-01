// Bounds on everything an untrusted server (or a careless caller) can size. Every allocation driven by
// wire data checks one of these before the buffer exists. A missing or non-finite field is a hard error:
// `undefined > n` is false in JS, so a forgotten default must not silently disable the check.
import type { ErrorOf } from './errors.js';
import { plyError } from './errors.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

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
 * report-status-v2 option lines. The ref cap is the same order.
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
/** Per HTTP exchange, including a stalled body. The timer that enforces this owns the AbortSignal. */
export const LIMIT_REQUEST_TIMEOUT_MS = 60_000;

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
};
export type LimitKey = keyof Limits;

export const DEFAULT_LIMITS: Limits = Object.freeze({
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
});

// A caller's overrides on top of the defaults. Values are checked where they are used (checkLimit), not here: a
// caller may pass a field this version does not read.
export const withLimits = (o: Partial<Limits> = {}): Limits => Object.freeze({ ...DEFAULT_LIMITS, ...o });

// Absent, NaN, Infinity, or negative: the check would not bound anything. Fail before any allocation.
export const checkLimit = (value: unknown, what: string): Result<number, ErrorOf<'bad_request'>> =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? ok(value)
    : err(plyError('bad_request', `limits.${what} must be a finite non-negative number`, { what, got: value }));
export const readLimit = (limits: Partial<Limits> | null | undefined, key: LimitKey): Result<number, ErrorOf<'bad_request'>> =>
  checkLimit(limits?.[key], key);

// The value for `what` exceeding its bound: `got` against `max`.
export const limitExceeded = (what: string, got: number, max: number): ErrorOf<'limit_exceeded'> =>
  plyError('limit_exceeded', `${what} ${got} exceeds limit ${max}`, { what, got, max });

// Migration boundary: the throwing forms unconverted modules call. finiteLimit repeats checkLimit's test rather than
// calling it, so a bundle of unconverted callers carries no Result plumbing (bundle budgets); it goes away, with the
// repetition, when the last caller converts.
export const finiteLimit = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw plyError('bad_request', `limits.${what} must be a finite non-negative number`, { what, got: value });
  }
  return value;
};
export const requireLimit = (limits: Partial<Limits> | null | undefined, key: LimitKey): number => finiteLimit(limits?.[key], key);
export { limitExceeded as limitError };
