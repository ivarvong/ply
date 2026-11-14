// `ply/probes`: the differential probe plans, their types and the pure evaluator, for a probe runner outside this
// repository (ply-web's workbench runs a plan from a Worker and classifies ply's answers with these types).
export * from './probe-types.js';
export { SCENARIOS } from './probe-scenarios.js';
export { ALLOW } from './probe-allow.js';
export { plyOutcome, renderSteps, expectationDiffs, claimDiffs, pushesOf, skippedFor, evaluablePairs, compareScenario, soloDiffs, allowFor, runsFor, classify, judge } from './probe-evaluate.js';
export type { Classified, Names, Runs, Verdict } from './probe-evaluate.js';
