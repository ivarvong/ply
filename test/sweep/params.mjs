// One row per Limits key. `later` is a key the harness knows about and does not sweep yet (the second pass, #144):
// a key with no row at all would be an untested parameter, which the boundary test rejects.
import { DEFAULT_LIMITS } from '../../src/limits.js';

/** @typedef {{ key: keyof typeof DEFAULT_LIMITS, limit: number, probe: string | null, later: boolean }} Param */

/** @type {Param[]} */
export const PARAMS = [
  { key: 'maxMergeBlobBytes', limit: DEFAULT_LIMITS.maxMergeBlobBytes, probe: 'mergeBranch of a file of that exact size', later: false },
  { key: 'maxObjectSize', limit: DEFAULT_LIMITS.maxObjectSize, probe: 'pushTree of one file', later: false },
  { key: 'maxHarvestBytes', limit: DEFAULT_LIMITS.maxHarvestBytes, probe: null, later: true },
  { key: 'maxPackBytes', limit: DEFAULT_LIMITS.maxPackBytes, probe: 'readFile of an incompressible blob', later: false },
  { key: 'maxDeltaResult', limit: DEFAULT_LIMITS.maxDeltaResult, probe: null, later: true },
  { key: 'maxDeltaChain', limit: DEFAULT_LIMITS.maxDeltaChain, probe: 'resolvePack of a pack-objects chain', later: false },
  { key: 'maxInflatedTotal', limit: DEFAULT_LIMITS.maxInflatedTotal, probe: 'parsePack with the cap set around the inflated sum', later: false },
  { key: 'maxPackObjects', limit: DEFAULT_LIMITS.maxPackObjects, probe: null, later: true },
  { key: 'maxRefs', limit: DEFAULT_LIMITS.maxRefs, probe: 'lsRefs of N refs plus HEAD', later: false },
  { key: 'maxRebaseCommits', limit: DEFAULT_LIMITS.maxRebaseCommits, probe: null, later: true },
  { key: 'maxSectionLines', limit: DEFAULT_LIMITS.maxSectionLines, probe: null, later: true },
  { key: 'maxTreeEntries', limit: DEFAULT_LIMITS.maxTreeEntries, probe: 'listTree', later: false },
  { key: 'maxPathDepth', limit: DEFAULT_LIMITS.maxPathDepth, probe: 'readFile of a path with that many components', later: false },
  { key: 'maxPathComponent', limit: DEFAULT_LIMITS.maxPathComponent, probe: 'readFile of a component of that length', later: false },
  { key: 'maxMergeDepth', limit: DEFAULT_LIMITS.maxMergeDepth, probe: 'readLog limit and merge-base distance', later: false },
  { key: 'maxReportLines', limit: DEFAULT_LIMITS.maxReportLines, probe: null, later: true },
  { key: 'maxCommitParents', limit: DEFAULT_LIMITS.maxCommitParents, probe: null, later: true },
  { key: 'maxLsRefsBytes', limit: DEFAULT_LIMITS.maxLsRefsBytes, probe: 'lsRefs with the byte cap overridden', later: false },
  { key: 'requestTimeoutMs', limit: DEFAULT_LIMITS.requestTimeoutMs, probe: null, later: true },
];

export const PARAM_BY_KEY = new Map(PARAMS.map(p => [p.key, p]));
