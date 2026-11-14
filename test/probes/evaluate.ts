// The differential evaluator (pure): classify each client's answer the same way, compare the four runs of a scenario
// field by field, apply the allow-list, and classify what is left by triangulation (t229u): a difference between ply
// against the server and ply against the reference is a server bug only when ply meets the reference expectation and
// stock git against the server reproduces it.
import { ABSENT, TARGETS, clientOf } from './types.js';
import type { Allow, Client, Difference, Push, EndState, ErrorClass, Expectation, Field, Finding, FindingClass, Observation, Outcome, Pair, Scenario, Step, StepObservation, Target } from './types.js';

// ---- one answer, one class ----
export type Classified = { readonly outcome: Outcome; readonly error: ErrorClass; readonly detail: string };

// ply: the Result of a push. `code` is the PlyError code when it failed.
export function plyOutcome(r: { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }): Classified {
  if (r.ok) return { outcome: 'landed', error: null, detail: 'ok' };
  const detail = r.message.slice(0, 300);
  switch (r.code) {
    case 'push_partial': return { outcome: 'partial', error: r.code, detail };
    case 'ambiguous': return { outcome: 'ambiguous', error: r.code, detail };
    case 'cas_conflict': return { outcome: 'conflict', error: r.code, detail };
    default: return { outcome: 'rejected', error: r.code, detail };
  }
}

// A refusal reason stock git printed for one ref, as the error class ply would give it. Wording differs between servers
// ("failed to update ref", "stale ref", "incorrect old value provided"); the class is what is compared.
// A refusal git makes itself because its advertisement already shows another writer's value ("stale info" for a lease,
// "fetch first" for a create or update without force) is the same conflict the server's compare-and-swap reports when
// git read the advertisement a moment earlier: which one a racing client sees is timing, so both are cas_conflict.
export function gitReasonClass(reason: string, stderr: string): string {
  if (/stale info|fetch first/.test(reason)) return 'cas_conflict';
  if (/atomic push failure|atomic transaction failed/.test(reason)) return 'atomic_sibling';
  if (/non-fast-forward/.test(reason)) return 'not_fast_forward';
  if (/failed to update ref|failed to lock|cannot lock|incorrect old value|stale ref|already exists|does not exist|bad ref|reference/.test(reason)) return 'cas_conflict';
  if (/exceeds maximum|too large|limit is|maximum allowed/i.test(`${reason}\n${stderr}`)) return 'limit_exceeded';
  return 'push_rejected';
}

const OK_FLAGS = new Set([' ', '+', '-', '*', '=']);
// `git push --porcelain`: a `<flag>\t<src>:<dst>\t<summary>` line per ref (git-push(1) OUTPUT). No ref line and a
// non-zero exit is a push whose answer git never read: ambiguous.
// `creates`: the refs the plan creates (zero old id). git refuses a create of a ref its advertisement already shows as
// "non-fast-forward" (or "fetch first"): for a create that is the conflict, not a history rule.
export function gitOutcome(status: number | null, stdout: string, stderr: string, creates: ReadonlySet<string> = new Set()): Classified {
  const refs = stdout.split('\n').filter(l => /^[ +\-*=!]\t[^\t]*:[^\t]*\t/.test(l)).map(l => {
    const [flag = '!', spec = '', summary = ''] = l.split('\t');
    const reason = /\(([^)]*)\)\s*$/.exec(summary)?.[1] ?? summary;
    return { ok: OK_FLAGS.has(flag), reason: creates.has(spec.slice(spec.indexOf(':') + 1)) && reason === 'non-fast-forward' ? 'fetch first' : reason };
  });
  const tail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  if (refs.length === 0) return status === 0 ? { outcome: 'landed', error: null, detail: 'no ref lines' } : { outcome: 'ambiguous', error: 'ambiguous', detail: tail };
  const bad = refs.filter(r => !r.ok);
  if (bad.length === 0 && status === 0) return { outcome: 'landed', error: null, detail: 'ok' };
  if (bad.length === 0) return { outcome: 'ambiguous', error: 'ambiguous', detail: tail };
  if (bad.length < refs.length) return { outcome: 'partial', error: 'push_partial', detail: bad.map(b => b.reason).join('; ') };
  const classes = bad.map(b => gitReasonClass(b.reason, stderr));
  const error = classes.find(c => c !== 'atomic_sibling') ?? 'cas_conflict';
  const outcome: Outcome = error === 'cas_conflict' ? 'conflict' : 'rejected';
  return { outcome, error, detail: bad.map(b => b.reason).join('; ') };
}

// ---- rendering: each compared field as one deterministic string ----
const sortedJson = (o: Readonly<Record<string, string>>): string => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
const renderStep = (s: StepObservation, f: 'outcome' | 'error'): string => {
  const vals = s.outcomes.map(x => (f === 'outcome' ? x.outcome : String(x.error)));
  return s.outcomes.length === 1 ? (vals[0] ?? '') : [...vals].sort().join(',');
};
export const renderSteps = (obs: Observation, f: 'outcome' | 'error'): string => obs.steps.map((s, i) => `s${i}=${renderStep(s, f)}`).join(';');

// Object ids shown by seed name where the seed made them (the same on every target), so a difference reads as
// "main: diverged vs ff" and a race winner can be named.
export type Names = Readonly<Record<string, string>>; // oid -> name
const named = (names: Names, oid: string): string => names[oid] ?? oid;

function renderEnd(s: Scenario, names: Names, end: EndState, field: Exclude<Field, 'outcome' | 'error' | 'expectation' | 'claims'>): string | null {
  const winners = new Set(s.final.flatMap(f => (f.tag === 'one-of' ? f.names : [])));
  const refName = (oid: string): string => (s.compare.tag === 'winner-of' && winners.has(named(names, oid)) ? '<winner>' : named(names, oid));
  if (s.compare.tag === 'winner-of' && (field === 'objects' || field === 'trees' || field === 'ancestry' || field === 'merge-bases')) return null;
  switch (field) {
    case 'head': return String(end.head);
    case 'refs': {
      const shown: Record<string, string> = Object.fromEntries(Object.entries(end.refs).map(([r, oid]) => [r, refName(oid)]));
      // a winner that deleted the ref is still the winner
      if (s.compare.tag === 'winner-of') for (const f of s.final) if (f.tag === 'one-of' && f.names.includes(ABSENT) && shown[f.ref] === undefined) shown[f.ref] = '<winner>';
      return sortedJson(shown);
    }
    case 'objects': return `${end.objects.length}:${end.objects.join(',')}`;
    case 'trees': return sortedJson(end.trees);
    case 'ancestry': return end.ancestry.join('|');
    case 'merge-bases': return sortedJson(end.mergeBases);
    case 'fsck': return end.fsck.length === 0 ? 'clean' : end.fsck.join('|');
  }
}
const END_FIELDS = ['head', 'refs', 'objects', 'trees', 'ancestry', 'merge-bases', 'fsck'] as const;

// ---- expectation: a reference run against what the scenario says git http-backend does ----
const expectedOf = (e: Expectation, c: Client): string | null => {
  if (e.tag === 'one') { const x = c === 'ply' ? e.ply : e.git; return x === null ? null : `${x.outcome}/${String(x.error)}`; }
  const xs = c === 'ply' ? e.ply : e.git;
  return xs === null ? null : [...xs].sort().join(',');
};
const observedOf = (e: Expectation, s: StepObservation): string => (e.tag === 'one' ? `${s.outcomes[0].outcome}/${String(s.outcomes[0].error)}` : s.outcomes.map(x => x.outcome).sort().join(','));

export function expectationDiffs(s: Scenario, target: 'ref-ply' | 'ref-git', obs: Observation, names: Names): Difference[] {
  const c: Client = target === 'ref-ply' ? 'ply' : 'git';
  const pair: Pair = target === 'ref-ply' ? 'ref-ply~expect' : 'ref-git~expect';
  const out: Difference[] = [];
  s.expect.forEach((e, i) => {
    const want = expectedOf(e, c);
    const step = obs.steps[i];
    if (want === null || step === undefined) return;
    const got = observedOf(e, step);
    if (got !== want) out.push({ scenario: s.id, pair, field: 'expectation', left: `s${i}=${got}`, right: `s${i}=${want}` });
  });
  const byName = Object.fromEntries(Object.entries(names).map(([oid, n]) => [n, oid]));
  for (const f of s.final) {
    const got = obs.end.refs[f.ref];
    const gotName = got === undefined ? (f.tag === 'one-of' ? ABSENT : 'absent') : named(names, got);
    const ok = f.tag === 'absent' ? got === undefined : f.tag === 'at' ? got !== undefined && got === byName[f.at] : f.names.includes(gotName);
    if (!ok) out.push({ scenario: s.id, pair, field: 'expectation', left: `${f.ref}=${gotName}`, right: `${f.ref}=${f.tag === 'at' ? f.at : f.tag === 'absent' ? 'absent' : f.names.join('|')}` });
  }
  if (obs.end.fsck.length > 0) out.push({ scenario: s.id, pair, field: 'fsck', left: obs.end.fsck.join('|'), right: 'clean' });
  return out;
}

// ---- claims: a landed answer must be true ----
const CLAIMS_PAIR: { readonly [T in Target]: Pair } = { 'ref-ply': 'ref-ply~claims', 'ref-git': 'ref-git~claims', 'art-ply': 'art-ply~claims', 'art-git': 'art-git~claims' };
export function claimDiffs(s: Scenario, target: Target, obs: Observation, names: Names): Difference[] {
  const last = s.steps.length - 1;
  const step = s.steps[last], seen = obs.steps[last];
  if (step === undefined || seen === undefined || (clientOf(target) === 'git' && step.git.tag === 'none')) return [];
  const pushesOf = (st: Step): readonly Push[] => (st.tag === 'push' ? [st.push] : st.tag === 'concurrent' ? st.pushes : (() => { const of = s.steps[st.of]; return of === undefined || of.tag === 'retry-unlanded' ? [] : pushesOf(of); })());
  const pushes = pushesOf(step);
  const byName = Object.fromEntries(Object.entries(names).map(([oid, n]) => [n, oid]));
  const out: Difference[] = [];
  seen.outcomes.forEach((o, i) => {
    const p = pushes[i];
    if (o.outcome !== 'landed' || p === undefined) return;
    for (const u of p.updates) {
      const want = u.new.tag === 'zero' ? undefined : byName[u.new.name];
      const got = obs.end.refs[u.ref];
      if (got !== want) out.push({ scenario: s.id, pair: CLAIMS_PAIR[target], field: 'claims', left: `push ${i} landed: ${u.ref}=${got === undefined ? 'absent' : named(names, got)}`, right: `${u.ref}=${u.new.tag === 'zero' ? 'absent' : u.new.name}` });
    }
  });
  return out;
}

// ---- the differential: every evaluable pair, field by field ----
const PAIR_SIDES: { readonly [P in Exclude<Pair, `${string}~expect` | `${string}~claims`>]: readonly [Target, Target, 'all' | 'end'] } = {
  'art-ply~ref-ply': ['art-ply', 'ref-ply', 'all'],
  'art-git~ref-git': ['art-git', 'ref-git', 'all'],
  'ref-ply~ref-git': ['ref-ply', 'ref-git', 'end'],
  'art-ply~art-git': ['art-ply', 'art-git', 'end'],
};
export type Runs = Partial<Readonly<Record<Target, Observation>>>;

export function evaluablePairs(runs: Runs): Pair[] {
  const pairs: Pair[] = [];
  for (const [p, [l, r]] of Object.entries(PAIR_SIDES)) if (runs[l] !== undefined && runs[r] !== undefined) pairs.push(p as Pair);
  if (runs['ref-ply'] !== undefined) pairs.push('ref-ply~expect');
  if (runs['ref-git'] !== undefined) pairs.push('ref-git~expect');
  for (const t of TARGETS) if (runs[t] !== undefined) pairs.push(CLAIMS_PAIR[t]);
  return pairs;
}

export function compareScenario(s: Scenario, runs: Runs, names: Names): Difference[] {
  const out: Difference[] = [];
  for (const [p, [l, r, scope]] of Object.entries(PAIR_SIDES) as [Pair, readonly [Target, Target, 'all' | 'end']][]) {
    const a = runs[l], b = runs[r];
    if (a === undefined || b === undefined) continue;
    if (scope === 'all') for (const f of ['outcome', 'error'] as const) {
      const la = renderSteps(a, f), rb = renderSteps(b, f);
      if (la !== rb) out.push({ scenario: s.id, pair: p, field: f, left: la, right: rb });
    }
    for (const f of END_FIELDS) {
      const la = renderEnd(s, names, a.end, f), rb = renderEnd(s, names, b.end, f);
      if (la !== null && rb !== null && la !== rb) out.push({ scenario: s.id, pair: p, field: f, left: la, right: rb });
    }
  }
  const rp = runs['ref-ply'], rg = runs['ref-git'];
  if (rp !== undefined) out.push(...expectationDiffs(s, 'ref-ply', rp, names));
  if (rg !== undefined) out.push(...expectationDiffs(s, 'ref-git', rg, names));
  for (const t of TARGETS) { const r = runs[t]; if (r !== undefined) out.push(...claimDiffs(s, t, r, names)); }
  return out;
}

// ---- allow-list, then triangulation ----
const matches = (a: Allow, d: Difference): boolean => a.scenario === d.scenario && a.pair === d.pair && a.field === d.field && a.left === d.left && a.right === d.right;

export type Verdict = {
  readonly expected: readonly { readonly difference: Difference; readonly reason: string }[];
  readonly findings: readonly Finding[];
  // entries whose scenario and pair were evaluated in this run, and that matched nothing: the run fails on any
  readonly unused: readonly Allow[];
};

const has = (ds: readonly Difference[], s: string, p: Pair, f: Field | null): boolean => ds.some(d => d.scenario === s && d.pair === p && (f === null || d.field === f));
const noGitForm = (s: Scenario): boolean => s.steps.some(st => st.git.tag === 'none');

export function classify(s: Scenario, d: Difference, all: readonly Difference[]): { readonly class: FindingClass; readonly why: string } {
  const plyRefWrong = has(all, s.id, 'ref-ply~expect', null);
  const gitRefWrong = has(all, s.id, 'ref-git~expect', null);
  const gitRepro = (f: Field): boolean => has(all, s.id, 'art-git~ref-git', f);
  switch (d.pair) {
    case 'ref-ply~expect':
      return gitRefWrong ? { class: 'unresolved', why: 'stock git misses the expectation on the reference too: the expectation or the harness is wrong' } : { class: 'client-bug', why: 'ply misses the reference expectation that stock git meets' };
    case 'ref-git~expect':
      return { class: 'unresolved', why: 'stock git against git http-backend misses the stated expectation: fix the scenario or the reference policy' };
    case 'ref-ply~ref-git':
      return plyRefWrong ? { class: 'client-bug', why: 'ply leaves a different repository than stock git on the reference and misses its expectation' } : { class: 'unresolved', why: 'ply and stock git leave different repositories on the reference; the expectation does not decide which is right' };
    case 'art-ply~ref-ply':
      if (plyRefWrong) return { class: 'unresolved', why: 'ply misses the reference expectation, so a difference on the server cannot be attributed' };
      if (noGitForm(s)) return { class: 'unresolved', why: 'ply is right on the reference; this scenario has no native-git form to reproduce it with' };
      if (gitRepro(d.field)) return { class: 'server-bug', why: 'ply is right on the reference and stock git reproduces the difference on the server' };
      return { class: 'unresolved', why: 'ply is right on the reference but stock git does not reproduce it on the server: a behaviour only ply\'s bytes reach, or ply\'s handling of this server\'s answer' };
    case 'art-git~ref-git':
      return gitRefWrong ? { class: 'unresolved', why: 'stock git misses the reference expectation' } : { class: 'server-bug', why: 'the same stock git client answers differently against the server than against git http-backend' };
    case 'ref-ply~claims':
      return { class: 'client-bug', why: 'ply said landed against git http-backend and the refs do not show it' };
    case 'ref-git~claims':
      return { class: 'unresolved', why: 'stock git said landed against git http-backend and the refs do not show it: the harness is wrong' };
    case 'art-ply~claims':
      return has(all, s.id, 'art-git~claims', null) ? { class: 'server-bug', why: 'the server told both clients a push landed that the refs do not show' } : { class: 'unresolved', why: 'ply said landed and the refs do not show it; stock git was not told the same' };
    case 'art-git~claims':
      return { class: 'server-bug', why: 'the server told stock git a push landed that the refs do not show' };
    case 'art-ply~art-git':
      if (has(all, s.id, 'art-ply~ref-ply', d.field) || has(all, s.id, 'art-git~ref-git', d.field)) return { class: 'unresolved', why: 'follows from a same-client difference listed separately' };
      return { class: 'unresolved', why: 'ply and stock git leave different repositories on the server while each matches its reference run' };
  }
}

export function judge(scenarios: readonly Scenario[], diffs: readonly Difference[], allow: readonly Allow[], evaluated: readonly { readonly scenario: string; readonly pairs: readonly Pair[] }[]): Verdict {
  const used = new Set<Allow>();
  const expected: { difference: Difference; reason: string }[] = [];
  const findings: Finding[] = [];
  for (const d of diffs) {
    const a = allow.find(x => matches(x, d));
    if (a !== undefined) { used.add(a); expected.push({ difference: d, reason: a.reason }); continue; }
    const s = scenarios.find(x => x.id === d.scenario);
    if (s === undefined) continue;
    findings.push({ ...d, ...classify(s, d, diffs) });
  }
  const ran = (a: Allow): boolean => evaluated.some(e => e.scenario === a.scenario && e.pairs.includes(a.pair));
  return { expected, findings, unused: allow.filter(a => ran(a) && !used.has(a)) };
}
