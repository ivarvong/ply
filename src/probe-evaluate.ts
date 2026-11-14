// The differential evaluator (pure): classify each client's answer the same way, compare the runs of a scenario field
// by field, apply the allow-list, and classify what is left by triangulation (t229u): a difference between ply against
// the server and ply against the reference is a server bug only when ply meets the reference expectation and stock git
// against the server reproduces it. Exported as `ply/probes` beside the plans (probe-scenarios.ts); stock git's own
// answers are parsed in test/probes/git-outcome.ts, which only the in-repository runner needs.
import { at, readKey } from './absent.js';
import { assertNever, none } from './result.js';
import type { Option } from './result.js';
import { ABSENT, TARGETS, clientOf } from './probe-types.js';
import type { Allow, Client, Difference, EndState, ErrorClass, Expectation, Field, FinalRef, Finding, OidExpr, FindingClass, Observation, Outcome, Pair, Push, Scenario, Step, StepExpect, StepObservation, Target } from './probe-types.js';

// ---- one answer, one class ----
export type Classified = { readonly outcome: Outcome; readonly error: ErrorClass; readonly detail: string };

const DETAIL_MAX = 300;
// ply: the Result of an operation. `code` is the PlyError code when it failed.
export function plyOutcome(r: { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }): Classified {
  if (r.ok) return { outcome: 'landed', error: null, detail: 'ok' };
  const detail = r.message.slice(0, DETAIL_MAX);
  switch (r.code) {
    case 'push_partial': return { outcome: 'partial', error: r.code, detail };
    case 'ambiguous': return { outcome: 'ambiguous', error: r.code, detail };
    case 'cas_conflict': return { outcome: 'conflict', error: r.code, detail };
    default: return { outcome: 'rejected', error: r.code, detail };
  }
}

// ---- rendering: each compared field as one deterministic string ----
const sortedJson = (o: Readonly<Record<string, string>>): string => JSON.stringify(Object.fromEntries(Object.entries(o).toSorted(([a], [b]) => a.localeCompare(b))));
const renderStep = (s: StepObservation, f: 'outcome' | 'error'): string => {
  const vals = s.outcomes.map(x => (f === 'outcome' ? x.outcome : String(x.error)));
  return s.outcomes.length === 1 ? vals.join('') : vals.toSorted().join(',');
};
export const renderSteps = (obs: Observation, f: 'outcome' | 'error'): string => obs.steps.map((s, i) => `s${i}=${renderStep(s, f)}`).join(';');

// Object ids shown by seed name where the seed made them (the same on every target), so a difference reads as
// "main: diverged vs ff" and a race winner can be named.
export type Names = Readonly<Record<string, string>>; // oid -> name
const lookup = (table: Readonly<Record<string, string>>, key: string): Option<string> => readKey(table, key);
const named = (names: Names, oid: string): string => {
  const n = lookup(names, oid);
  return n.tag === 'some' ? n.value : oid;
};
const byNameOf = (names: Names): Readonly<Record<string, string>> => Object.fromEntries(Object.entries(names).map(([oid, n]) => [n, oid]));
const refOf = (end: EndState, ref: string): Option<string> => lookup(end.refs, ref);

type EndField = Exclude<Field, 'outcome' | 'error' | 'expectation' | 'claims'>;
function renderEnd(s: Scenario, names: Names, end: EndState, field: EndField): string | null {
  const winners = new Set(s.final.flatMap(f => (f.tag === 'one-of' ? f.names : [])));
  const refName = (oid: string): string => (s.compare.tag === 'winner-of' && winners.has(named(names, oid)) ? '<winner>' : named(names, oid));
  if (s.compare.tag === 'winner-of' && (field === 'objects' || field === 'trees' || field === 'ancestry' || field === 'merge-bases')) return null;
  switch (field) {
    case 'head': return String(end.head);
    case 'refs': {
      const shown: Record<string, string> = Object.fromEntries(Object.entries(end.refs).map(([r, oid]) => [r, refName(oid)]));
      // a winner that deleted the ref is still the winner
      if (s.compare.tag === 'winner-of') for (const f of s.final) if (f.tag === 'one-of' && f.names.includes(ABSENT) && !Object.hasOwn(shown, f.ref)) shown[f.ref] = '<winner>';
      return sortedJson(shown);
    }
    case 'objects': return `${end.objects.length}:${end.objects.join(',')}`;
    case 'trees': return sortedJson(end.trees);
    case 'ancestry': return end.ancestry.join('|');
    case 'merge-bases': return sortedJson(end.mergeBases);
    case 'fsck': return end.fsck.length === 0 ? 'clean' : end.fsck.join('|');
  }
  return assertNever(field);
}
const END_FIELDS = ['head', 'refs', 'objects', 'trees', 'ancestry', 'merge-bases', 'fsck'] as const;

// ---- expectation: a run against what the scenario says git http-backend does ----
const oneOf = (x: StepExpect): string => `${x.outcome}/${String(x.error)}`;
const expectedOf = (e: Expectation, c: Client): string | null => {
  if (e.tag === 'one') {
    const x = c === 'ply' ? e.ply : e.git;
    return x === null ? null : oneOf(x);
  }
  const xs = c === 'ply' ? e.ply : e.git;
  return xs === null ? null : xs.toSorted().join(',');
};
const observedOf = (e: Expectation, s: StepObservation): string => (e.tag === 'one' ? oneOf(s.outcomes[0]) : s.outcomes.map(x => x.outcome).toSorted().join(','));

// The stated end refs against the refs a judge read.
const absentName = (f: FinalRef): string => (f.tag === 'one-of' ? ABSENT : 'absent');
function finalHolds(f: FinalRef, got: Option<string>, gotName: string, byName: Readonly<Record<string, string>>): boolean {
  switch (f.tag) {
    case 'absent': return got.tag === 'none';
    case 'at': {
      const want = lookup(byName, f.at);
      return got.tag === 'some' && want.tag === 'some' && got.value === want.value;
    }
    case 'one-of': return f.names.includes(gotName);
  }
  return assertNever(f);
}
function finalShown(f: FinalRef): string {
  switch (f.tag) {
    case 'absent': return 'absent';
    case 'at': return f.at;
    case 'one-of': return f.names.join('|');
  }
  return assertNever(f);
}
function finalDiffs(s: Scenario, pair: Pair, obs: Observation, names: Names): Difference[] {
  const byName = byNameOf(names);
  const out: Difference[] = [];
  for (const f of s.final) {
    const got = refOf(obs.end, f.ref);
    const gotName = got.tag === 'some' ? named(names, got.value) : absentName(f);
    if (!finalHolds(f, got, gotName, byName)) out.push({ scenario: s.id, pair, field: 'expectation', left: `${f.ref}=${gotName}`, right: `${f.ref}=${finalShown(f)}` });
  }
  return out;
}

export function expectationDiffs(s: Scenario, target: 'ref-ply' | 'ref-git', obs: Observation, names: Names): Difference[] {
  const c: Client = target === 'ref-ply' ? 'ply' : 'git';
  const pair: Pair = target === 'ref-ply' ? 'ref-ply~expect' : 'ref-git~expect';
  const out: Difference[] = [];
  for (const [i, e] of s.expect.entries()) {
    const want = expectedOf(e, c);
    const step = at(obs.steps, i);
    if (want === null || step.tag === 'none') continue;
    const got = observedOf(e, step.value);
    if (got !== want) out.push({ scenario: s.id, pair, field: 'expectation', left: `s${i}=${got}`, right: `s${i}=${want}` });
  }
  out.push(...finalDiffs(s, pair, obs, names));
  if (obs.end.fsck.length > 0) out.push({ scenario: s.id, pair, field: 'fsck', left: obs.end.fsck.join('|'), right: 'clean' });
  return out;
}

// ---- claims: a landed answer must be true ----
const CLAIMS_PAIR: Readonly<Record<Target, Pair>> = { 'ref-ply': 'ref-ply~claims', 'ref-git': 'ref-git~claims', 'art-ply': 'art-ply~claims', 'art-git': 'art-git~claims' };
// The pushes a step sends, in the order its outcomes are recorded.
export function pushesOf(s: Scenario, st: Step): readonly Push[] {
  switch (st.tag) {
    case 'push': return [st.push];
    case 'concurrent': return st.pushes;
    case 'fetch': return [];
    case 'retry-unlanded': {
      const of = at(s.steps, st.of);
      return of.tag === 'none' || of.value.tag === 'retry-unlanded' ? [] : pushesOf(s, of.value);
    }
  }
  return assertNever(st);
}
// A push's new id as the seed made it (none for a delete), and how a claim's two sides are shown.
const wantOf = (e: OidExpr, byName: Readonly<Record<string, string>>): Option<string> => (e.tag === 'zero' ? none : lookup(byName, e.name));
const oidName = (e: OidExpr): string => (e.tag === 'zero' ? 'absent' : e.name);
const sameOid = (want: Option<string>, got: Option<string>): boolean => (got.tag === 'none' ? want.tag === 'none' : want.tag === 'some' && want.value === got.value);
const shownOid = (names: Names, got: Option<string>): string => (got.tag === 'none' ? 'absent' : named(names, got.value));
// A step one client has no form of is recorded as skipped and judged by nobody.
export const skippedFor = (st: Step, c: Client): boolean => (c === 'git' ? st.git.tag === 'none' : st.tag === 'push' && st.ply.tag === 'none');
export function claimDiffs(s: Scenario, target: Target, obs: Observation, names: Names): Difference[] {
  const last = s.steps.length - 1;
  const seen = at(obs.steps, last);
  const step = at(s.steps, last);
  if (step.tag === 'none' || seen.tag === 'none' || skippedFor(step.value, clientOf(target))) return [];
  const pushes = pushesOf(s, step.value);
  const byName = byNameOf(names);
  const out: Difference[] = [];
  for (const [i, o] of seen.value.outcomes.entries()) {
    const p = at(pushes, i);
    if (o.outcome !== 'landed' || p.tag === 'none') continue;
    for (const u of p.value.updates) {
      const got = refOf(obs.end, u.ref);
      if (!sameOid(wantOf(u.new, byName), got)) out.push({ scenario: s.id, pair: CLAIMS_PAIR[target], field: 'claims', left: `push ${i} landed: ${u.ref}=${shownOid(names, got)}`, right: `${u.ref}=${oidName(u.new)}` });
    }
  }
  return out;
}

// ---- the differential: every evaluable pair, field by field ----
type SidePair = Exclude<Pair, `${string}~expect` | `${string}~claims`>;
const PAIR_SIDES: Readonly<Record<SidePair, readonly [Target, Target, 'all' | 'end']>> = {
  'art-ply~ref-ply': ['art-ply', 'ref-ply', 'all'],
  'art-git~ref-git': ['art-git', 'ref-git', 'all'],
  'ref-ply~ref-git': ['ref-ply', 'ref-git', 'end'],
  'art-ply~art-git': ['art-ply', 'art-git', 'end'],
};
const SIDE_PAIRS: readonly SidePair[] = ['art-ply~ref-ply', 'art-git~ref-git', 'ref-ply~ref-git', 'art-ply~art-git'];
export type Runs = Partial<Readonly<Record<Target, Observation>>>;
const runOf = (runs: Runs, t: Target): Option<Observation> => readKey(runs, t);

export function evaluablePairs(runs: Runs): Pair[] {
  const pairs: Pair[] = [];
  for (const p of SIDE_PAIRS) {
    const [l, r] = PAIR_SIDES[p];
    if (runOf(runs, l).tag === 'some' && runOf(runs, r).tag === 'some') pairs.push(p);
  }
  if (runOf(runs, 'ref-ply').tag === 'some') pairs.push('ref-ply~expect');
  if (runOf(runs, 'ref-git').tag === 'some') pairs.push('ref-git~expect');
  for (const t of TARGETS) if (runOf(runs, t).tag === 'some') pairs.push(CLAIMS_PAIR[t]);
  return pairs;
}

export function compareScenario(s: Scenario, runs: Runs, names: Names): Difference[] {
  const out: Difference[] = [];
  for (const p of SIDE_PAIRS) {
    const [l, r, scope] = PAIR_SIDES[p];
    const a = runOf(runs, l);
    const b = runOf(runs, r);
    if (a.tag === 'none' || b.tag === 'none') continue;
    if (scope === 'all') for (const f of ['outcome', 'error'] as const) {
      const la = renderSteps(a.value, f), rb = renderSteps(b.value, f);
      if (la !== rb) out.push({ scenario: s.id, pair: p, field: f, left: la, right: rb });
    }
    for (const f of END_FIELDS) {
      const la = renderEnd(s, names, a.value.end, f), rb = renderEnd(s, names, b.value.end, f);
      if (la !== null && rb !== null && la !== rb) out.push({ scenario: s.id, pair: p, field: f, left: la, right: rb });
    }
  }
  const rg = runOf(runs, 'ref-git');
  const rp = runOf(runs, 'ref-ply');
  if (rp.tag === 'some') out.push(...expectationDiffs(s, 'ref-ply', rp.value, names));
  if (rg.tag === 'some') out.push(...expectationDiffs(s, 'ref-git', rg.value, names));
  for (const t of TARGETS) {
    const r = runOf(runs, t);
    if (r.tag === 'some') out.push(...claimDiffs(s, t, r.value, names));
  }
  return out;
}

// ---- one corner: ply alone against the server (ply-web's workbench) ----
// ply's run against the server, compared with the scenario's stated ply expectation instead of a ref-ply run: ref-ply
// meets that expectation at every commit (test/probes/probes.test.js), so for a scenario whose steps each state one
// outcome a solo difference reads exactly as the art-ply~ref-ply difference a full run records, and the allow-list's
// art-ply~ref-ply entries apply to it unchanged. A concurrent step's errors are not stated, so not compared. A judge in
// a Worker has no fsck, so fsck is not compared; the end refs and every landed claim are.
// A concurrent step states only its outcomes (sorted), so its errors are not compared here.
const expectRender = (e: Expectation, f: 'outcome' | 'error'): string => {
  if (e.tag === 'many') return e.ply.toSorted().join(',');
  return f === 'outcome' ? e.ply.outcome : String(e.ply.error);
};
export function soloDiffs(s: Scenario, obs: Observation, names: Names): Difference[] {
  const out: Difference[] = [];
  for (const f of ['outcome', 'error'] as const) {
    // a concurrent step's errors are not stated, only its outcomes
    const steps = s.expect.map((e, i) => ({ e, i, seen: at(obs.steps, i) })).filter(x => f === 'outcome' || x.e.tag === 'one');
    const left = steps.map(x => `s${x.i}=${x.seen.tag === 'some' ? renderStep(x.seen.value, f) : '(not run)'}`).join(';');
    const right = steps.map(x => `s${x.i}=${expectRender(x.e, f)}`).join(';');
    if (left !== right) out.push({ scenario: s.id, pair: 'art-ply~expect', field: f, left, right });
  }
  out.push(...finalDiffs(s, 'art-ply~expect', obs, names), ...claimDiffs(s, 'art-ply', obs, names));
  return out;
}

// ---- allow-list, then triangulation ----
// An art-ply~ref-ply entry covers the same difference on art-ply~expect (ref-ply meets the expectation; see soloDiffs).
const matches = (a: Allow, d: Difference): boolean => a.scenario === d.scenario && (a.pair === d.pair || (a.pair === 'art-ply~ref-ply' && d.pair === 'art-ply~expect')) && a.field === d.field && a.left === d.left && a.right === d.right;
export const allowFor = (allow: readonly Allow[], d: Difference): Option<Allow> => at(allow.filter(a => matches(a, d)), 0);

export type Verdict = {
  readonly expected: ReadonlyArray<{ readonly difference: Difference; readonly reason: string }>;
  readonly findings: readonly Finding[];
  // entries whose scenario and pair were evaluated in this run, and that matched nothing: the run fails on any
  readonly unused: readonly Allow[];
};

const has = (ds: readonly Difference[], s: string, p: Pair, f: Field | null): boolean => ds.some(d => d.scenario === s && d.pair === p && (f === null || d.field === f));
const noGitForm = (s: Scenario): boolean => s.steps.some(st => st.git.tag === 'none');
// a scenario one client cannot run at all: its targets are not run, so no pair with them is evaluated
export const runsFor = (s: Scenario, c: Client): boolean => !s.steps.every(st => skippedFor(st, c));

type Why = { readonly class: FindingClass; readonly why: string };
const why = (c: FindingClass, text: string): Why => ({ class: c, why: text });

// The server pairs: ply or stock git against the server, read against its reference run or the expectation.
function classifyServer(s: Scenario, d: Difference & { readonly pair: 'art-ply~ref-ply' | 'art-ply~expect' | 'art-git~ref-git' | 'art-ply~art-git' }, all: readonly Difference[]): Why {
  const plyRefWrong = has(all, s.id, 'ref-ply~expect', null);
  switch (d.pair) {
    case 'art-ply~ref-ply':
      if (plyRefWrong) return why('unresolved', 'ply misses the reference expectation, so a difference on the server cannot be attributed');
      if (noGitForm(s)) return why('unresolved', 'ply is right on the reference; this scenario has no native-git form to reproduce it with');
      if (has(all, s.id, 'art-git~ref-git', d.field)) return why('server-bug', 'ply is right on the reference and stock git reproduces the difference on the server');
      return why('unresolved', 'ply is right on the reference but stock git does not reproduce it on the server: a behaviour only ply\'s bytes reach, or ply\'s handling of this server\'s answer');
    case 'art-ply~expect':
      return why('unresolved', 'ply alone against the server: ply meets this expectation against git http-backend at this commit, so the server answered differently or ply read its answer differently; stock git and the reference did not run, so export the scenario and run it with test/probes to close the triangle');
    case 'art-git~ref-git':
      return has(all, s.id, 'ref-git~expect', null) ? why('unresolved', 'stock git misses the reference expectation') : why('server-bug', 'the same stock git client answers differently against the server than against git http-backend');
    case 'art-ply~art-git':
      if (has(all, s.id, 'art-ply~ref-ply', d.field) || has(all, s.id, 'art-git~ref-git', d.field)) return why('unresolved', 'follows from a same-client difference listed separately');
      return why('unresolved', 'ply and stock git leave different repositories on the server while each matches its reference run');
  }
  return assertNever(d.pair);
}

export function classify(s: Scenario, d: Difference, all: readonly Difference[]): Why {
  const gitRefWrong = has(all, s.id, 'ref-git~expect', null);
  switch (d.pair) {
    case 'ref-ply~expect':
      return gitRefWrong ? why('unresolved', 'stock git misses the expectation on the reference too: the expectation or the harness is wrong') : why('client-bug', 'ply misses the reference expectation that stock git meets');
    case 'ref-git~expect':
      return why('unresolved', 'stock git against git http-backend misses the stated expectation: fix the scenario or the reference policy');
    case 'ref-ply~ref-git':
      return has(all, s.id, 'ref-ply~expect', null) ? why('client-bug', 'ply leaves a different repository than stock git on the reference and misses its expectation') : why('unresolved', 'ply and stock git leave different repositories on the reference; the expectation does not decide which is right');
    case 'art-ply~ref-ply':
    case 'art-ply~expect':
    case 'art-git~ref-git':
    case 'art-ply~art-git':
      return classifyServer(s, { ...d, pair: d.pair }, all);
    case 'ref-ply~claims':
      return why('client-bug', 'ply said landed against git http-backend and the refs do not show it');
    case 'ref-git~claims':
      return why('unresolved', 'stock git said landed against git http-backend and the refs do not show it: the harness is wrong');
    case 'art-ply~claims':
      return has(all, s.id, 'art-git~claims', null) ? why('server-bug', 'the server told both clients a push landed that the refs do not show') : why('unresolved', 'ply said landed and the refs do not show it; stock git was not told the same');
    case 'art-git~claims':
      return why('server-bug', 'the server told stock git a push landed that the refs do not show');
  }
  return assertNever(d.pair);
}

export function judge(scenarios: readonly Scenario[], diffs: readonly Difference[], allow: readonly Allow[], evaluated: ReadonlyArray<{ readonly scenario: string; readonly pairs: readonly Pair[] }>): Verdict {
  const used = new Set<Allow>();
  const expected: Array<{ difference: Difference; reason: string }> = [];
  const findings: Finding[] = [];
  for (const d of diffs) {
    const a = allowFor(allow, d);
    if (a.tag === 'some') { used.add(a.value); expected.push({ difference: d, reason: a.value.reason }); continue; }
    const s = at(scenarios.filter(x => x.id === d.scenario), 0);
    if (s.tag === 'none') continue;
    findings.push({ ...d, ...classify(s.value, d, diffs) });
  }
  const ran = (a: Allow): boolean => evaluated.some(e => e.scenario === a.scenario && e.pairs.includes(a.pair));
  return { expected, findings, unused: allow.filter(a => ran(a) && !used.has(a)) };
}
