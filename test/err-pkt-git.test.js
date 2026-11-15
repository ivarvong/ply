// A real ERR pkt-line (errors.err-pkt-line): git http-backend's upload-pack answers a fetch of an id it does not hold
// with `ERR upload-pack: not our ref <id>`. ply reports it as remote_error, reason not_our_ref; the bytes are
// captured as the server wrote them, so the test also shows the server sent ERR (not only that ply reads injected ones).
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, tmpRoot, makeBareRepo, startGitServer, initRepo } from './server.js';
import { createTransport } from '../src/http.js';
import { fetchPack } from '../src/fetchpack.js';
import { unwrap } from './unwrap.js';

let root, cleanup, srv;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const work = join(root, 'source');
  mkdirSync(work);
  initRepo(work);
  writeFileSync(join(work, 'a.txt'), 'err\n');
  git(work, ['add', '.']);
  git(work, ['-c', 'user.name=a', '-c', 'user.email=a@x', 'commit', '-q', '-m', 'one']);
  const bare = makeBareRepo(root, 'e');
  git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
});
after(async () => { await srv.close(); cleanup(); });

test('real git ERR on a fetch of an id no one holds: the bytes carry ERR, ply says remote_error not_our_ref', async () => {
  const phantom = createHash('sha1').update('err-pkt-git phantom').digest('hex');
  const answers = [];
  const fetchImpl = async (url, init) => {
    const r = await fetch(url, init);
    if (!String(url).endsWith('/git-upload-pack')) return r;
    const bytes = new Uint8Array(await r.arrayBuffer());
    answers.push(new TextDecoder().decode(bytes));
    return new Response(bytes, { status: r.status, headers: r.headers });
  };
  const r = await fetchPack(unwrap(createTransport(`${srv.url}/e.git`, { fetchImpl })), { wants: [phantom] });
  assert.ok(answers.some(a => a.includes(`ERR upload-pack: not our ref ${phantom}`)), JSON.stringify(answers));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'remote_error', JSON.stringify(r.error));
  assert.equal(r.error.reason, 'not_our_ref');
}, 30_000);
