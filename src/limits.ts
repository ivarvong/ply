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
import { fromNullish, isMissing, withDefaults } from './absent.js';

/* oxlint-disable no-magic-numbers -- these are the cap definitions; parsers import the names */

const KIB = 1024;
const MIB = KIB * KIB;

/**
 * Each side of a line merge. git's MAX_XDIFF_SIZE (xdiff/xdiff.h) is ~1 GiB; a Worker isolate is not.
 * 8 MiB is large enough for a source file and small enough to reject a blob the merger cannot hold twice.
 */
export const LIMIT_MERGE_BLOB: number = 8 * MIB;
/**
 * The line merge's work budget: primitive diff steps for one merged file, counted across everything that merge runs
 * (both histogram diffs, the classic-diff fallbacks, group compaction, conflict refinement). git's histogram diff
 * rescans the rest of the region on every split (xhistogram.c find_lcs), so a file whose splits peel a line or two at
 * a time costs O(n²) however short its hash chains are; the byte cap does not bound that. The budget does, whatever
 * the content: a merge that would pass it is refused as `too large to merge`, never guessed.
 * A step is ~6-7 ns of CPU on the histogram path and ~12-15 ns on the classic fallback (measured: linemerge.ts,
 * classicDiff), so the CPU bound is the fallback's rate times the budget.
 * Sized at 7cfa0b7, on a 16-core machine running about 25 other test processes (process.cpuUsage medians; the cases
 * are pinned in test/linemerge.test.js, which asserts the counts, not the times):
 * - Default 2^32: what git itself merges cleanly in about 5 s is merged, on both shapes measured. git merge-file
 *   (2.50) takes 3.4 s on 40,000 lines of swapped pairs (0.75 n² = 1.2e9 steps here) and 7.9 s on 60,000 (2.7e9),
 *   about 2.9 ns a step, so its 5 s is ~1.7e9 steps there; 2^30 refused the first of those. A bulk edit costs git
 *   less per step (about 1.7 ns), so its 5 s is more steps: 130,000 lines with every 10th changed is 4.1 s in git and
 *   2,451,130,516 steps here, 143,000 lines 5.0 s and 2,965,798,566, so ~3e9; 2^31, sized from the swaps alone,
 *   refused the first of those (measured at 1b9f578). It is also 11.9 times the 361,702,266 steps of the 70,000-line
 *   / 3,500-hunk bulk edit (1.75 s here, 0.76 s in git). A refusal at this budget costs ~25 s of CPU (131,074 lines
 *   of swapped pairs: 24,920 ms, one run, 5.8 ns a step).
 * - Worker 2^26: the worst inputs found under WORKER_LIMITS.maxMergeBlobBytes are refused in 1.04 s (250,000 swapped
 *   lines, histogram), 1.40 s (1,048,576 random a/b/c lines, classic fallback) and 1.74 s (60 copies each of 8,733
 *   lines, shuffled); at 2^27 the first two took 1.45 s and 1.48 s and the third ran to its end in 2.27 s. The budget
 *   does not cover splitting the three sides into records (0.43 s for 3 x 250,000 lines, 0.89 s for 3 x 1,048,576),
 *   so a budget of 0 still costs 0.55 s and 1.06 s on those inputs: the rest of the second is maxMergeBlobBytes'.
 */
export const LIMIT_MERGE_WORK: number = 2 ** 32;
export const LIMIT_MERGE_WORK_WORKER: number = 2 ** 26;
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
 * and is the ceiling for resolvePack's work: each entry is visited at most three times in any pack order (a delta is
 * filed under its base and resolved when the base lands), a REF_DELTA base is one Map lookup, never a scan or a pass.
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
 * The bytes kept of one report-status reason: the reason of "ng <ref> <reason>", or the status of "unpack <status>".
 * git's own are under 50 bytes and the longest host reason observed is 86 (Cloudflare Artifacts), so 4 KiB is room for
 * a host that explains itself. A longer reason is cut here and its ref keeps its status (push.ts cutReportLine): the cap
 * bounds what is held (one reason a command), never the outcome. Never below git's own longest (push.ts reportReasonCap).
 */
export const LIMIT_REPORT_REASON_BYTES = 4096;
/** The same for a 128 MiB isolate: 10 000 refused refs hold 10 MiB of reasons (and as much again decoded), not 40 MiB. */
export const LIMIT_REPORT_REASON_BYTES_WORKER = 1024;
/**
 * Band-2 bytes (progress, hook output) decoded from one receive-pack answer. A frame past it is dropped unread and the
 * report is still read (the answer as a whole is held to maxPackBytes). Only a 4 KiB tail is ever kept, so this bounds
 * the decoding, not the memory: git's progress is a few KiB and a talkative hook some hundreds; 8 MiB is past both.
 */
export const LIMIT_REPORT_PROGRESS_BYTES = 8_388_608;
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
/**
 * resolvePackRange's work bound. Resolving a pack honestly costs its floor: every member inflated once and every delta
 * applied once, which is the sum of sizes the pack itself declares (each capped by maxObjectSize / maxDeltaResult), and
 * has nothing to do with its compressed size: 80 one-line edits of a 4 MB file are a pack of about 1 MB and a floor of
 * over 256 MiB. LIMIT_RESOLVE_FACTOR is the work allowed per floor byte: the room for bases made again after a cache
 * miss. Measured by the test's own RangeSource (test/pack-range-resolve.test.js): that history resolves at about 1x the
 * sum of its object sizes on the default cache.
 * The hard ceiling, whatever the pack declares (a pack of maximum-size delta bombs declares a floor as large as it
 * likes), is the Limits key maxResolveWork, exactly as parsed. parseLimits refuses it below the record's own
 * maxInflatedTotal (bad_request, #271): such a ceiling would refuse what the retain bound admits.
 * Left out of a caller's record it is LIMIT_RESOLVE_TOTALS x that record's
 * maxInflatedTotal, so it follows the preset: 2 GiB on DEFAULT_LIMITS, 512 MiB on WORKER_LIMITS. Measured on a 40 KB
 * bomb (test/pack-range-resolve-bound.test.js): refused after 512 MiB in about 2 s of CPU and after 2 GiB in about 8 s
 * (about 4 ns per work byte, most of it hashing each result). An honest pack whose objects sum past the ceiling is
 * refused too (limit_exceeded, `resolve work bytes`): raise maxResolveWork for it.
 */
export const LIMIT_RESOLVE_FACTOR = 4;
export const LIMIT_RESOLVE_TOTALS = 8;
export const LIMIT_RESOLVE_WORK: number = LIMIT_INFLATED_TOTAL * LIMIT_RESOLVE_TOTALS;
/**
 * What memoryCache() (packcache.ts) retains unless told otherwise: the body bytes and header text of all its entries.
 * One object's worth: a process that keeps a cache beside its work holds at most one more LIMIT_OBJECT.
 */
export const LIMIT_MEMORY_CACHE_BYTES: number = LIMIT_OBJECT;
/** Entries memoryCache() keeps unless told otherwise, however small: its eviction pass walks them on a put. */
export const LIMIT_MEMORY_CACHE_ENTRIES = 1024;
/* oxlint-enable no-magic-numbers */

export type Limits = {
  readonly maxMergeBlobBytes: number;
  readonly maxMergeWork: number;
  readonly maxObjectSize: number;
  readonly maxHarvestBytes: number;
  readonly maxPackBytes: number;
  readonly maxPushBytes: number;
  readonly maxDeltaResult: number;
  readonly maxDeltaChain: number;
  readonly maxInflatedTotal: number;
  readonly maxResolveWork: number;
  readonly maxPackObjects: number;
  readonly maxRefs: number;
  readonly maxRebaseCommits: number;
  readonly maxSectionLines: number;
  readonly maxTreeEntries: number;
  readonly maxPathDepth: number;
  readonly maxPathComponent: number;
  readonly maxMergeDepth: number;
  readonly maxReportLines: number;
  readonly maxReportReasonBytes: number;
  readonly maxReportProgressBytes: number;
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
// What a caller passes: any subset of the keys (a missing key is the default; maxResolveWork missing is derived from
// the record's own maxInflatedTotal), or none. null is a value on every key, and refused.
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
  maxMergeWork: LIMIT_MERGE_WORK,
  maxObjectSize: LIMIT_OBJECT,
  maxHarvestBytes: LIMIT_HARVEST,
  maxPackBytes: LIMIT_PACK_WIRE,
  maxPushBytes: LIMIT_PUSH_BYTES,
  maxDeltaResult: LIMIT_DELTA_RESULT,
  maxDeltaChain: LIMIT_DELTA_CHAIN,
  maxInflatedTotal: LIMIT_INFLATED_TOTAL,
  maxResolveWork: LIMIT_RESOLVE_WORK,
  maxPackObjects: LIMIT_PACK_OBJECTS,
  maxRefs: LIMIT_REFS,
  maxRebaseCommits: LIMIT_REBASE_COMMITS,
  maxSectionLines: LIMIT_SECTION_LINES,
  maxTreeEntries: LIMIT_TREE_ENTRIES,
  maxPathDepth: LIMIT_PATH_DEPTH,
  maxPathComponent: LIMIT_PATH_COMPONENT,
  maxMergeDepth: LIMIT_MERGE_DEPTH,
  maxReportLines: LIMIT_REPORT_LINES,
  maxReportReasonBytes: LIMIT_REPORT_REASON_BYTES,
  maxReportProgressBytes: LIMIT_REPORT_PROGRESS_BYTES,
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
 * object, maxMergeBlobBytes 2 MiB (the line merger holds each side more than twice), maxMergeWork 2^26 steps per merged
 * file (LIMIT_MERGE_WORK_WORKER: CPU, not memory), maxTreeEntries 32 768
 * (a listed entry keeps ~150 B of heap, so the 200 000 default is ~30 MiB of the isolate's 128: #140), and
 * maxReportReasonBytes 1 KiB (a push of maxRefs refused refs holds one reason each). Every other cap
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
  maxResolveWork: 64 * MIB * LIMIT_RESOLVE_TOTALS,
  maxDeltaResult: 16 * MIB,
  maxHarvestBytes: 8 * MIB,
  maxMergeBlobBytes: 2 * MIB,
  maxMergeWork: LIMIT_MERGE_WORK_WORKER,
  maxTreeEntries: 32_768,
  maxReportReasonBytes: LIMIT_REPORT_REASON_BYTES_WORKER,
});
/* oxlint-enable no-magic-numbers */

// A caller's overrides on top of the defaults, as a plain record: it is checked where it enters (parseLimits).
// maxResolveWork left out follows the record's own maxInflatedTotal (resolveWorkOf), as in parseLimits.
const resolveWorkOf = (maxInflatedTotal: number): number => Math.min(Number.MAX_SAFE_INTEGER, maxInflatedTotal * LIMIT_RESOLVE_TOTALS);
export const withLimits = (o: Partial<Limits> = {}): Limits => {
  // null from an untyped caller is no overrides, as the missing value is: the frozen defaults, not a throw
  const given = getOrElse<Partial<Limits>>(fromNullish(o), {});
  const filled = { ...DEFAULT_LIMITS, ...given };
  return Object.freeze(isMissing(given.maxResolveWork) ? { ...filled, maxResolveWork: resolveWorkOf(filled.maxInflatedTotal) } : filled);
};

// A record with maxResolveWork taken out, so it is derived from the record's own maxInflatedTotal where it is parsed:
// for a spread preset whose maxInflatedTotal is changed (`withDerivedWork({ ...WORKER_LIMITS, maxInflatedTotal: x })`
// is bounded at 8 x x). Every other key is kept as given.
export const withDerivedWork = <T extends LimitsInput>(limits: T): Omit<T, 'maxResolveWork'> => {
  const { maxResolveWork: _derived, ...rest } = limits;
  return rest;
};

// Absent, NaN, Infinity, or negative: the check would not bound anything. Fail before any allocation.
export const checkLimit = (value: unknown, what: string): Result<number, ErrorOf<'bad_request'>> =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? ok(value)
    : err(plyError('bad_request', `limits.${what} must be a finite non-negative number`, { what, got: value }));

// The largest delay a platform timer holds: a signed 32-bit count of ms (24.8 days). The exchange's three timeouts.
export const MAX_TIMER_MS = 2_147_483_647;
const TIMER_KEYS: ReadonlySet<string> = new Set(['requestTimeoutMs', 'firstByteTimeoutMs', 'idleTimeoutMs']);

// The caller's limits record (any subset), or none (null), parsed once where it enters. A key it gives must pass
// checkLimit (the refusal names the key, `got` is what was passed; keys are checked in DEFAULT_LIMITS order); a key it
// leaves out, or passes as the missing value, is DEFAULT_LIMITS's (maxResolveWork: 8 x the record's maxInflatedTotal; given, it must be at least the record's maxInflatedTotal). Keys this version does not read are ignored. A
// record parseLimits already returned is returned as it is; none (null) is DEFAULT_LIMITS.
// @decoder parseLimits prefix=limits
export function parseLimits(input: LimitsInput | null): Result<CheckedLimits, ErrorOf<'bad_request'>> {
  if (input === null) return ok(DEFAULT_LIMITS);
  if (isChecked(input)) return ok(input);
  // A spread of DEFAULT_LIMITS: its keys (the brand is not enumerable), in order, each filled from the input where given.
  const given = withDefaults<Limits>(input, { ...DEFAULT_LIMITS });
  // the resolve work ceiling a caller leaves out follows the maxInflatedTotal of its own record, not the default's
  const filled: Limits = isMissing(input.maxResolveWork) ? { ...given, maxResolveWork: resolveWorkOf(given.maxInflatedTotal) } : given;
  for (const [key, value] of Object.entries(filled)) {
    const checked = checkLimit(value, key);
    if (!checked.ok) return checked;
    // a timer holds at most MAX_TIMER_MS: above it the platform's timer fires at once (Node: 1 ms, with a warning)
    if (TIMER_KEYS.has(key) && checked.value > MAX_TIMER_MS) return err(plyError('bad_request', `limits.${key} must be at most ${MAX_TIMER_MS} ms (0 turns the timer off)`, { what: key, got: value }));
  }
  // #271: the resolver's ceiling is this number as given, so one below the retain bound is refused, never raised
  if (filled.maxResolveWork < filled.maxInflatedTotal) return err(plyError('bad_request', `limits.maxResolveWork must be at least limits.maxInflatedTotal (${filled.maxInflatedTotal})`, { what: 'maxResolveWork', got: filled.maxResolveWork }));
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
