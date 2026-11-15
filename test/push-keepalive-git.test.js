// Band-1 keepalives from real git (http.sideband-keepalive): git http-backend's receive-pack, with receive.keepAlive=1
// and a pre-receive hook that sleeps 3 s without output, writes empty band-1 packets (`0005\x01`) while the hook runs,
// then the report. ply's push reads past them to the report: landed, the ref moved, fsck --strict clean. The response
// bytes are captured as the server wrote them, so the test also shows git sent keepalives at all (not only that ply
// tolerates injected ones, test/push-report-bound.test.js).
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems, initRepo } from './server.js';
import { createTransport } from '../src/http.js';
import { ZERO_OID } from '../src/push.js';
import { pushPack } from '../src/receivecaps.js';
import { unwrap } from './unwrap.js';

const REF = 'refs/heads/main';
const HOOK_S = 3;
let root, cleanup, srv, source;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const work = join(root, 'source');
  mkdirSync(work);
  initRepo(work);
  writeFileSync(join(work, 'a.txt'), 'keepalive\n');
  git(work, ['add', '.']);
  git(work, ['-c', 'user.name=a', '-c', 'user.email=a@x', 'commit', '-q', '-m', 'one']);
  const oid = git(work, ['rev-parse', 'HEAD']).trim();
  source = { oid, pack: new Uint8Array(gitBuf(work, ['pack-objects', '--revs', '--stdout', '-q'], `${oid}\n`)) };
});
after(async () => { await srv.close(); cleanup(); });

// The bytes of every receive-pack answer, read whole here and handed to ply unchanged.
const capture = () => {
  const answers = [];
  const fetchImpl = async (url, init) => {
    const r = await fetch(url, init);
    if (!String(url).endsWith('/git-receive-pack')) return r;
    const bytes = new Uint8Array(await r.arrayBuffer());
    answers.push(bytes);
    return new Response(bytes, { status: r.status, headers: r.headers });
  };
  return { answers, fetchImpl };
};
// pkt-lines of a side-band-64k answer, framed from the protocol: four hex digits that count themselves, then the band.
const bands = bytes => {
  const out = [];
  for (let o = 0; o + 4 <= bytes.length;) {
    const n = parseInt(new TextDecoder().decode(bytes.subarray(o, o + 4)), 16);
    if (!(n >= 4)) { o += 4; continue; }
    out.push({ band: bytes[o + 4], length: n - 5 });
    o += n;
  }
  return out;
};

test('real git keepalives while a pre-receive hook runs: band-1 empty packets, then the report; ply lands', async () => {
  const bare = makeBareRepo(root, 'k');
  git(bare, ['config', 'receive.keepAlive', '1']);
  const hook = join(bare, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\nsleep ${HOOK_S}\n`);
  chmodSync(hook, 0o755);
  const { answers, fetchImpl } = capture();
  const t0 = performance.now();
  const r = await pushPack(unwrap(createTransport(`${srv.url}/k.git`, { fetchImpl })), { ref: REF, oldOid: ZERO_OID, newOid: source.oid, pack: new ReadableStream({ start(c) { c.enqueue(source.pack); c.close(); } }), length: source.pack.length });
  const ms = performance.now() - t0;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(ms >= HOOK_S * 1000, `the hook ran (${Math.round(ms)} ms)`);
  assert.equal(answers.length, 1);
  const keepalives = bands(answers[0]).filter(p => p.band === 1 && p.length === 0).length;
  assert.ok(keepalives >= 1, `git sent band-1 keepalives (${keepalives})`);
  assert.equal(git(bare, ['rev-parse', REF]).trim(), source.oid);
  assert.deepEqual(fsckProblems(bare), []);
}, 30_000);
