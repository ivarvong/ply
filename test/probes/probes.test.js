// Differential probes, reference target only (CI): every scenario run by ply and by stock git against git http-backend
// configured to Artifacts' known policy, judged by stock git (ls-remote, a mirror clone, fsck --strict, rev-list,
// merge-base), compared by src/probe-evaluate.ts. The Artifacts runs are opt-in and private (scripts/probes.mjs
// --artifacts); this file never reaches the network beyond 127.0.0.1.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS } from '../../src/probe-scenarios.ts';
import { ALLOW } from '../../src/probe-allow.ts';
import { compareScenario, evaluablePairs, judge, plyOutcome, classify, runsFor, soloDiffs } from '../../src/probe-evaluate.ts';
import { gitOutcome } from './git-outcome.ts';
import { startReference, runScenario, newTracer, reportOf } from './runner.mjs';
import { BEHAVIOURS } from '../behaviours/matrix.ts';
import { ABSENT } from '../../src/probe-types.ts';

test('every scenario probes a matrix behaviour, ids are unique, plans are closed', () => {
  const ids = SCENARIOS.map(s => s.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate scenario ids');
  const behaviours = new Set(BEHAVIOURS.map(b => b.id));
  for (const s of SCENARIOS) {
    const [behaviour, variant] = s.id.split('#');
    assert.ok(behaviours.has(behaviour), `${s.id}: no matrix behaviour ${behaviour}`);
    assert.match(variant ?? '', /^[a-z0-9]+(-[a-z0-9]+)*$/, `${s.id}: variant must be kebab-case`);
    assert.equal(s.expect.length, s.steps.length, `${s.id}: one expectation per step`);
    const defined = new Set(s.seed.objects.map(o => o.name));
    const refs = [
      ...s.seed.refs.map(r => r.at),
      ...s.seed.objects.flatMap(o => {
        switch (o.tag) {
          case 'commit': return o.parents;
          case 'annotated-tag': return [o.target];
          case 'raw-commit': return [...o.parents, o.tree];
          case 'raw-tree': return o.entries.map(e => e.blob.tag === 'blob' ? e.blob.of : e.blob.name);
          case 'phantom': return [];
          case 'raw-tag': return [o.object];
        }
        throw new Error(`unknown seed object ${o.tag}`);
      }),
      ...s.steps.flatMap(st => (st.tag === 'push' ? [st.push] : st.tag === 'concurrent' ? st.pushes : []).flatMap(p => p.updates.flatMap(u => [u.old, u.new]))).filter(e => e.tag === 'obj').map(e => e.name),
      ...s.steps.flatMap(st => (st.tag === 'push' && st.fault.tag === 'race' ? st.fault.moves.map(m => m.to) : [])).filter(e => e.tag === 'obj').map(e => e.name),
      ...s.steps.flatMap(st => (st.tag === 'fetch' ? [st.want] : [])),
      ...s.steps.flatMap(st => (st.tag === 'push' && st.push.pack.tag === 'listed' ? st.push.pack.objects : [])),
      ...s.final.flatMap(f => (f.tag === 'at' ? [f.at] : f.tag === 'one-of' ? f.names.filter(n => n !== ABSENT) : [])),
    ];
    for (const n of refs) assert.ok(defined.has(n), `${s.id}: ${n} is not a seed object`);
    s.seed.objects.forEach((o, i) => { if (o.tag === 'commit' || o.tag === 'raw-commit') for (const p of o.parents) assert.ok(s.seed.objects.slice(0, i).some(x => x.name === p), `${s.id}: ${o.name}'s parent ${p} must come first`); });
    s.expect.forEach((e, i) => assert.equal(e.tag === 'many', s.steps[i].tag === 'concurrent' || s.steps[i].tag === 'retry-unlanded', `${s.id}: step ${i}: a concurrent or retry step takes a multiset expectation`));
    s.steps.forEach((st, i) => { if (st.tag === 'retry-unlanded') assert.ok(st.of < i && s.steps[st.of].tag === 'concurrent', `${s.id}: step ${i} retries an earlier concurrent step`); });
  }
  // and the other way: a matrix behaviour that cites this file has a scenario here
  const probed = new Set(SCENARIOS.map(s => s.id.split('#')[0]));
  const cites = b => [...b.tests, ...(b.status.tag === 'verified' ? b.status.evidence : []).filter(e => e.ref.tag === 'test').map(e => e.ref)].some(r => r.path === 'test/probes/probes.test.js');
  for (const b of BEHAVIOURS) if (cites(b)) assert.ok(probed.has(b.id), `${b.id} cites test/probes/probes.test.js but has no scenario`);
  for (const a of ALLOW) {
    assert.ok(ids.includes(a.scenario), `allow entry for unknown scenario ${a.scenario}`);
    assert.ok(a.reason.trim().length > 20, `allow entry ${a.scenario} ${a.pair} ${a.field}: say why`);
  }
});

test('stock git porcelain is classified like ply: landed, partial, conflict, rejected, ambiguous', () => {
  const line = (flag, ref, summary) => `${flag}\t${ref}:${ref}\t${summary}`;
  const R = 'refs/heads/main', S = 'refs/heads/side';
  assert.deepEqual(gitOutcome(0, `To x\n${line(' ', R, 'a..b')}\nDone\n`, '').outcome, 'landed');
  assert.deepEqual(gitOutcome(0, `To x\n${line('=', R, '[up to date]')}\nDone\n`, '').outcome, 'landed');
  assert.deepEqual(gitOutcome(1, `To x\n${line(' ', R, 'a..b')}\n${line('!', S, '[remote rejected] (failed to update ref)')}\nDone\n`, ''), { outcome: 'partial', error: 'push_partial', detail: 'failed to update ref' });
  assert.equal(gitOutcome(1, `${line('!', R, '[remote rejected] (stale ref)')}\n`, '').error, 'cas_conflict', 'Artifacts wording');
  assert.equal(gitOutcome(1, `${line('!', R, '[remote rejected] (incorrect old value provided)')}\n`, '').error, 'cas_conflict');
  assert.deepEqual(gitOutcome(1, `${line('!', R, '[rejected] (stale info)')}\n`, ''), { outcome: 'conflict', error: 'cas_conflict', detail: 'stale info' }, 'git saw the other writer first');
  assert.equal(gitOutcome(1, `${line('!', R, '[rejected] (fetch first)')}\n`, '').error, 'cas_conflict');
  assert.equal(gitOutcome(1, `${line('!', R, '[rejected] (non-fast-forward)')}\n`, '', new Set([R])).error, 'cas_conflict', 'a create of a ref that exists');
  assert.deepEqual(gitOutcome(1, `${line('!', R, '[remote rejected] (atomic push failure)')}\n${line('!', S, '[remote rejected] (failed to update ref)')}\n`, '').error, 'cas_conflict');
  assert.equal(gitOutcome(1, `${line('!', R, '[remote rejected] (unpacker error)')}\n`, 'remote: fatal: pack exceeds maximum allowed size\n').error, 'limit_exceeded');
  assert.equal(gitOutcome(1, `${line('!', R, '[remote rejected] (unpacker error)')}\n`, '').outcome, 'rejected');
  assert.equal(gitOutcome(1, `${line('!', R, '[rejected] (non-fast-forward)')}\n`, '').error, 'not_fast_forward');
  assert.deepEqual(gitOutcome(128, '', 'error: RPC failed; curl 52 Empty reply from server\nfatal: the remote end hung up unexpectedly\n').outcome, 'ambiguous');
  assert.equal(plyOutcome({ ok: false, code: 'ambiguous', message: 'x' }).outcome, 'ambiguous');
  assert.equal(plyOutcome({ ok: false, code: 'push_partial', message: 'x' }).outcome, 'partial');
  assert.equal(plyOutcome({ ok: false, code: 'limit_exceeded', message: 'x' }).outcome, 'rejected');
});

// Synthetic observations: the evaluator's own rules, with no server.
const S0 = SCENARIOS.find(s => s.id === 'push.fast-forward-update#plain');
const end = refs => ({ head: 'refs/heads/main', refs, objects: [], trees: {}, ancestry: [], mergeBases: {}, fsck: [] });
const obs = (outcome, error, refs) => ({ steps: [{ outcomes: [{ outcome, error, detail: '' }] }], end: end(refs) });
const names = { a: 'base', b: 'ff' };
test('triangulation: a server difference ply alone shows is unresolved; stock git reproducing it makes it a server bug; ply wrong on the reference is a client bug', () => {
  const good = obs('landed', null, { 'refs/heads/main': 'b' });
  const bad = obs('rejected', 'push_rejected', { 'refs/heads/main': 'a' });
  const plyOnly = compareScenario(S0, { 'ref-ply': good, 'ref-git': good, 'art-ply': bad, 'art-git': good }, names);
  const outcomeDiff = plyOnly.find(d => d.pair === 'art-ply~ref-ply' && d.field === 'outcome');
  assert.equal(classify(S0, outcomeDiff, plyOnly).class, 'unresolved');
  const both = compareScenario(S0, { 'ref-ply': good, 'ref-git': good, 'art-ply': bad, 'art-git': bad }, names);
  assert.equal(classify(S0, both.find(d => d.pair === 'art-ply~ref-ply' && d.field === 'outcome'), both).class, 'server-bug');
  const client = compareScenario(S0, { 'ref-ply': bad, 'ref-git': good }, names);
  assert.equal(classify(S0, client.find(d => d.pair === 'ref-ply~expect'), client).class, 'client-bug');
});

test('allow-list: a listed difference is expected, an unlisted one is a finding, an unused entry is reported', () => {
  const good = obs('landed', null, { 'refs/heads/main': 'b' });
  const odd = obs('landed', null, { 'refs/heads/main': 'b' });
  const diffs = compareScenario(S0, { 'ref-ply': good, 'ref-git': good, 'art-ply': { ...odd, end: { ...odd.end, head: null } }, 'art-git': good }, names);
  const d = diffs.find(x => x.field === 'head' && x.pair === 'art-ply~ref-ply');
  const entry = { scenario: S0.id, pair: d.pair, field: d.field, left: d.left, right: d.right, reason: 'synthetic: the server names no HEAD symref in this made-up case' };
  const stale = { ...entry, field: 'refs', reason: 'synthetic: an entry no difference uses must be reported' };
  const evaluated = [{ scenario: S0.id, pairs: evaluablePairs({ 'ref-ply': good, 'ref-git': good, 'art-ply': good, 'art-git': good }) }];
  const v = judge(SCENARIOS, diffs, [entry, stale], evaluated);
  assert.equal(v.expected.filter(e => e.difference === d).length, 1);
  assert.ok(!v.findings.some(f => f.field === 'head' && f.pair === 'art-ply~ref-ply'));
  assert.ok(v.findings.some(f => f.pair === 'art-ply~art-git' && f.field === 'head'), 'the cross-client pair is still a finding');
  assert.deepEqual(v.unused, [stale]);
  // reference-only runs do not evaluate Artifacts pairs, so an Artifacts entry is not "unused" there
  assert.deepEqual(judge(SCENARIOS, [], [entry], [{ scenario: S0.id, pairs: ['ref-ply~ref-git', 'ref-ply~expect', 'ref-git~expect'] }]).unused, []);
});

test('claims: a client that says landed when the refs do not show it is a finding', () => {
  const said = obs('landed', null, { 'refs/heads/main': 'a' }); // landed, but main is still base
  const good = obs('landed', null, { 'refs/heads/main': 'b' });
  const d = compareScenario(S0, { 'ref-ply': good, 'ref-git': good, 'art-ply': good, 'art-git': said }, names);
  const c = d.find(x => x.pair === 'art-git~claims');
  assert.equal(c.left, 'push 0 landed: refs/heads/main=base');
  assert.equal(classify(S0, c, d).class, 'server-bug');
  assert.deepEqual(compareScenario(S0, { 'ref-ply': good }, names).filter(x => x.field === 'claims'), []);
});

test('solo (one corner, the workbench): ply against the server read against the stated expectation', () => {
  const good = obs('landed', null, { 'refs/heads/main': 'b' });
  assert.deepEqual(soloDiffs(S0, good, names), [], 'a run that meets the expectation has no difference');
  const bad = obs('rejected', 'push_rejected', { 'refs/heads/main': 'a' });
  const d = soloDiffs(S0, bad, names);
  assert.deepEqual(d.map(x => `${x.pair} ${x.field} ${x.left} | ${x.right}`), [
    'art-ply~expect outcome s0=rejected | s0=landed',
    'art-ply~expect error s0=push_rejected | s0=null',
    'art-ply~expect expectation refs/heads/main=base | refs/heads/main=ff',
  ]);
  // a solo difference reads as the art-ply~ref-ply difference a full run records, so it is classified (unresolved:
  // stock git did not run) and the same allow entries cover it
  const full = compareScenario(S0, { 'ref-ply': good, 'art-ply': bad }, names).filter(x => x.pair === 'art-ply~ref-ply' && (x.field === 'outcome' || x.field === 'error'));
  assert.deepEqual(full.map(x => [x.field, x.left, x.right]), d.slice(0, 2).map(x => [x.field, x.left, x.right]));
  assert.equal(classify(S0, d[0], d).class, 'unresolved');
  const entry = { scenario: S0.id, pair: 'art-ply~ref-ply', field: 'error', left: 's0=push_rejected', right: 's0=null', reason: 'synthetic: an entry written for a full run' };
  const v = judge(SCENARIOS, d, [entry], [{ scenario: S0.id, pairs: ['art-ply~expect', 'art-ply~claims'] }]);
  assert.equal(v.expected.length, 1);
  assert.equal(v.findings.length, 2);
  const lied = soloDiffs(S0, obs('landed', null, { 'refs/heads/main': 'a' }), names);
  assert.ok(lied.some(x => x.pair === 'art-ply~claims' && x.left === 'push 0 landed: refs/heads/main=base'));
  // the stated expectation of the size probe meets the allow entry ply already keeps for it
  const size = SCENARIOS.find(s => s.id === 'push.size-limits#pack-over-cap');
  const sd = soloDiffs(size, { steps: [{ outcomes: [{ outcome: 'rejected', error: 'limit_exceeded', detail: '' }] }], end: end({ 'refs/heads/main': 'a' }) }, names);
  assert.equal(judge(SCENARIOS, sd, ALLOW, [{ scenario: size.id, pairs: ['art-ply~expect'] }]).findings.length, 0);
});

let ref;
before(async () => { ref = await startReference(); });
after(async () => { await ref.close(); });

const diffs = [], evaluated = [];
for (const s of SCENARIOS) {
  test(`probe ${s.id}: ply and stock git against the reference meet the expectation and leave the same repository`, async () => {
    const runs = {}; let names = {};
    for (const t of ['ref-ply', 'ref-git'].filter(x => runsFor(s, x === 'ref-git' ? 'git' : 'ply'))) {
      const root = mkdtempSync(join(tmpdir(), 'ply-probe-'));
      try {
        const repo = await ref.repo(s);
        const r = await runScenario(s, { name: t, client: t.slice(4), proxy: ref.proxy, repoPath: repo.repoPath }, { tracer: newTracer().tracer, root });
        runs[t] = r.observation; names = r.byOid;
        // every planned fault fired
        for (const st of r.observation.steps) for (const o of st.outcomes) assert.doesNotMatch(o.detail, /never fired/, `${s.id} ${t}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    const d = compareScenario(s, runs, names);
    diffs.push(...d); evaluated.push({ scenario: s.id, pairs: evaluablePairs(runs) });
    const v = judge(SCENARIOS, d, ALLOW, [{ scenario: s.id, pairs: evaluablePairs(runs) }]);
    assert.deepEqual(v.findings, [], `${s.id}: findings against the reference`);
  });
}

test('the proxy reads the per-command push report, inside side-band 1 or bare', () => {
  const pkt = (s) => { const b = Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
  const status = Buffer.concat([pkt('unpack ok\n'), pkt('ok refs/heads/a\n'), pkt('ng refs/heads/a/b failed to update ref\n'), Buffer.from('0000')]);
  const want = ['unpack ok', 'ok refs/heads/a', 'ng refs/heads/a/b failed to update ref'];
  assert.deepEqual(reportOf(status), want);
  assert.deepEqual(reportOf(Buffer.concat([pkt('\x02progress\n'), pkt(`\x01${status.toString('latin1')}`), Buffer.from('0000')])), want);
  assert.deepEqual(reportOf(Buffer.alloc(0)), []);
  assert.deepEqual(reportOf(Buffer.from('0010ERR refused\n')), []);
});

test('no allow entry is unused on the reference pairs', () => {
  assert.deepEqual(judge(SCENARIOS, diffs, ALLOW, evaluated).unused, []);
});
