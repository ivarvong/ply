// The HTTP-level probes (test/probes/wire-plans.ts) against the reference: git http-backend with Artifacts' known
// policy behind Node's HTTP server (test/server.js), asked directly (no proxy, so framing reaches it as written). Every
// plan the reference can answer must meet its stated answer with every sender, the main branch unmoved and the
// repository fsck-clean; each plan names a matrix behaviour; senders that cannot send a plan say why.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { startGitServer } from '../server.js';
import { BEHAVIOURS } from '../behaviours/matrix.ts';
import { WIRE, WIRE_ALLOW, cornersOf, onReference } from './wire-plans.ts';
import { REFERENCE_POLICY, gitEnv, newTracer, run } from './runner.mjs';
import { WIRE_REFERENCE_CONFIG, referenceAuth, runWirePlan, seedOf, tempRoot, v2Caps, wireSeed } from './wire.mjs';

let root, srv, ws, n = 0;
before(async () => {
  root = tempRoot();
  mkdirSync(join(root, 'repos'));
  srv = await startGitServer(join(root, 'repos'));
  ws = await wireSeed(root);
});
after(async () => { await srv.close(); rmSync(root, { recursive: true, force: true }); });

async function referenceRepo(plan) {
  const name = `w${n++}`;
  const dir = join(root, 'repos', `${name}.git`);
  const env = gitEnv(root);
  await run('git', ['init', '-q', '--bare', '-b', 'main', dir], { env });
  for (const [k, v] of [...REFERENCE_POLICY, ...WIRE_REFERENCE_CONFIG]) await run('git', ['config', k, v], { cwd: dir, env });
  const url = `${srv.url}/${name}.git`;
  const p = await run('git', ['push', '-q', url, ...(await seedOf(plan, ws)).specs], { cwd: ws.dir, env: ws.env });
  assert.equal(p.status, 0, p.stderr);
  return url;
}

test('every allow entry names a plan, a sender it runs with, and a reason', () => {
  for (const a of WIRE_ALLOW) {
    const p = WIRE.find(x => x.id === a.plan);
    assert.ok(p !== undefined && cornersOf(p).includes(a.corner), `${a.plan} ${a.corner}`);
    assert.ok(a.reason.length > 40);
  }
});

test('every wire plan names a matrix behaviour, ids are unique, a sender that cannot send says why', () => {
  const ids = WIRE.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const known = new Set(BEHAVIOURS.map(b => b.id));
  for (const p of WIRE) {
    assert.ok(known.has(p.id.split('#')[0]), `${p.id} names no behaviour`);
    if (p.git.tag === 'none') assert.ok(p.git.why.length > 10, p.id);
    if (p.ply.tag === 'none') assert.ok(p.ply.why.length > 10, p.id);
  }
});

for (const plan of WIRE.filter(onReference)) {
  test(`reference: ${plan.id} meets its answer with every sender`, async () => {
    const url = await referenceRepo(plan);
    const { tracer } = newTracer();
    const caps = (await v2Caps(url, referenceAuth(url))).caps;
    const r = await runWirePlan(plan, cornersOf(plan), { name: 'ref', url, judgeUrl: url, auth: referenceAuth(url) }, ws, { root, tracer, caps });
    for (const x of r.results) {
      const allow = WIRE_ALLOW.find(a => a.plan === plan.id && a.target === 'ref' && a.corner === x.corner);
      if (allow === undefined) assert.ok(x.meets, `${x.corner}: ${x.cls} (${x.detail}) end ${JSON.stringify(r.end)}`);
      else assert.ok(!x.meets && x.cls === allow.cls, `allow entry unused: ${plan.id} ref ${x.corner} gave ${x.cls}, meets ${x.meets}`);
    }
  }, 60_000);
}
