// One row per Limits key, each with the probe that sweeps it. `later` marks a key the harness knows about and does
// not sweep yet; since the second pass (#144) there is none. A key with no row at all would be an untested parameter,
// which the boundary test rejects, as it rejects a swept key with no cell.
import { DEFAULT_LIMITS } from '../../src/limits.js';

/** @typedef {{ key: keyof typeof DEFAULT_LIMITS, limit: number, probe: string | null, later: boolean }} Param */

/** @type {Param[]} */
export const PARAMS = [
  { key: 'maxMergeBlobBytes', limit: DEFAULT_LIMITS.maxMergeBlobBytes, probe: 'mergeBranch of a file of that exact size', later: false },
  { key: 'maxObjectSize', limit: DEFAULT_LIMITS.maxObjectSize, probe: 'pushTree of one file', later: false },
  { key: 'maxHarvestBytes', limit: DEFAULT_LIMITS.maxHarvestBytes, probe: 'readLog on a server without filters, the cap around the commit and tree bytes git reports', later: false },
  { key: 'maxPackBytes', limit: DEFAULT_LIMITS.maxPackBytes, probe: 'readFile of an incompressible blob', later: false },
  { key: 'maxDeltaResult', limit: DEFAULT_LIMITS.maxDeltaResult, probe: 'parsePack with the cap around the largest delta git stored', later: false },
  { key: 'maxDeltaChain', limit: DEFAULT_LIMITS.maxDeltaChain, probe: 'resolvePack of a pack-objects chain', later: false },
  { key: 'maxInflatedTotal', limit: DEFAULT_LIMITS.maxInflatedTotal, probe: 'parsePack with the cap set around the inflated sum', later: false },
  { key: 'maxPackObjects', limit: DEFAULT_LIMITS.maxPackObjects, probe: 'parsePack around the verify-pack count; pushTree file count', later: false },
  { key: 'maxRefs', limit: DEFAULT_LIMITS.maxRefs, probe: 'lsRefs of N refs plus HEAD', later: false },
  { key: 'maxRebaseCommits', limit: DEFAULT_LIMITS.maxRebaseCommits, probe: 'rebaseBranch of a K-commit branch', later: false },
  { key: 'maxSectionLines', limit: DEFAULT_LIMITS.maxSectionLines, probe: 'fetchPack haves (acknowledgments) and deepen wants (shallow-info), counted by git', later: false },
  { key: 'maxTreeEntries', limit: DEFAULT_LIMITS.maxTreeEntries, probe: 'listTree', later: false },
  { key: 'maxPathDepth', limit: DEFAULT_LIMITS.maxPathDepth, probe: 'readFile of a path with that many components', later: false },
  { key: 'maxPushBytes', limit: DEFAULT_LIMITS.maxPushBytes, probe: 'pushTree of files whose bytes sum past the cap', later: false },
  { key: 'maxPathComponent', limit: DEFAULT_LIMITS.maxPathComponent, probe: 'readFile of a component of that length', later: false },
  { key: 'maxMergeDepth', limit: DEFAULT_LIMITS.maxMergeDepth, probe: 'readLog limit and merge-base distance', later: false },
  { key: 'maxReportLines', limit: DEFAULT_LIMITS.maxReportLines, probe: 'pushRepo of N branches (N + 1 report lines)', later: false },
  { key: 'maxReportReasonBytes', limit: DEFAULT_LIMITS.maxReportReasonBytes, probe: 'pushRepo under a limit of 0: the report is still read (a cap on what is kept, not on the outcome)', later: false },
  { key: 'maxReportProgressBytes', limit: DEFAULT_LIMITS.maxReportProgressBytes, probe: 'pushRepo under a limit of 0: band 2 is dropped, the report is still read', later: false },
  { key: 'maxCommitParents', limit: DEFAULT_LIMITS.maxCommitParents, probe: 'readLog of an octopus commit', later: false },
  { key: 'maxLsRefsBytes', limit: DEFAULT_LIMITS.maxLsRefsBytes, probe: 'lsRefs with the byte cap overridden', later: false },
  { key: 'requestTimeoutMs', limit: DEFAULT_LIMITS.requestTimeoutMs, probe: 'lsRefs and readFile through a delaying or stalling shim, with the opt-in total set', later: false },
  { key: 'firstByteTimeoutMs', limit: DEFAULT_LIMITS.firstByteTimeoutMs, probe: 'lsRefs through a delaying shim (a slow server)', later: false },
  { key: 'idleTimeoutMs', limit: DEFAULT_LIMITS.idleTimeoutMs, probe: 'lsRefs and readFile through a stalling shim (a stalled body)', later: false },
];

export const PARAM_BY_KEY = new Map(PARAMS.map(p => [p.key, p]));
