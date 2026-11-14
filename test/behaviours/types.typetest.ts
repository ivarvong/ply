// Compile-time checks for the coverage matrix (test/behaviours/types.ts): the illegal states do not type.
// `tsc --noEmit` must pass; every @ts-expect-error must still be an error.
import type { Behaviour, Evidence, Status } from './types.js';

const ok: Status = { tag: 'verified', evidence: [{ kind: 'ply_vs_reference_git', ref: { tag: 'test', path: 'test/parity.test.js', anchor: 'x' } }] };

// @ts-expect-error a verified status with no evidence
const noEvidence: Status = { tag: 'verified', evidence: [] };
// @ts-expect-error a verified status with the evidence left out
const missing: Status = { tag: 'verified' };
// @ts-expect-error an Artifacts check the run did not record
const unknownCheck: Evidence = { kind: 'ply_vs_artifacts', ref: { tag: 'run', run: 'validate-7b0c310f', check: 'not a check' } };
// @ts-expect-error a run that cannot back this kind (the compat run is stock git only, not ply)
const wrongKind: Evidence = { kind: 'ply_vs_artifacts', ref: { tag: 'run', run: 'loadgen-compat-20261024', check: 'clone_full/small/v2' } };
// @ts-expect-error reference-git evidence must name a test, not a run
const refRun: Evidence = { kind: 'ply_vs_reference_git', ref: { tag: 'run', run: 'validate-7b0c310f', check: 'discover' } };
// @ts-expect-error an unsupported behaviour may carry only evidence that does not involve ply
const plyObserved: Status = { tag: 'unsupported', why: 'x', observed: [{ kind: 'ply_vs_artifacts', ref: { tag: 'run', run: 'validate-7b0c310f', check: 'discover' } }] };

const common = { description: 'd', tests: [], notes: [] } as const;
// @ts-expect-error an unsupported behaviour names no ply operation
const unsupportedWithOp: Behaviour = { ...common, id: 'refs.x', area: 'refs', ops: [{ module: 'src/lsrefs.ts', symbol: 'lsRefs' }], status: { tag: 'unsupported', why: 'x', observed: [] } };
// @ts-expect-error an implemented behaviour names at least one ply operation
const implementedNoOp: Behaviour = { ...common, id: 'refs.x', area: 'refs', ops: [], status: { tag: 'implemented' } };
// @ts-expect-error the id's prefix is its area
const wrongArea: Behaviour = { ...common, id: 'fetch.x', area: 'refs', ops: [], status: { tag: 'unsupported', why: 'x', observed: [] } };

export const used = [ok, noEvidence, missing, unknownCheck, wrongKind, refRun, plyObserved, unsupportedWithOp, implementedNoOp, wrongArea];
