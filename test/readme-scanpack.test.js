// README contracts a consumer codes against (#301 items 2 and 6):
//   - the scanPack loop in the README, run as written: it sees every object of a pack git made, with git's sizes;
//   - the wire-span attribute sentence of the telemetry contract, checked on a GET, a POST and a failed exchange.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { scanPack, readCommit, Tracer } from '../src/index.js';
import { arrayExporter, flattenLine } from '../src/otel.js';
import { startGitServer, makeBareRepo, tmpRoot, commitFiles, git, gitBuf } from './server.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

function scanLoop() {
  const at = README.indexOf('<!-- scanpack-loop:');
  assert.ok(at >= 0, 'README has the scanpack-loop block');
  const m = /```js\n([\s\S]*?)```/.exec(README.slice(at));
  assert.ok(m);
  const body = m[1].replace(/^import \{ scanPack \} from 'ply';\n/m, '') + '\nreturn sizes;';
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  return new AsyncFunction('scanPack', 'pack', body);
}

test('README scanPack loop sees every object of a git-made pack, at the size git reports', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const bare = makeBareRepo(root, 'p'); const work = join(root, 'w'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'a.txt': 'alpha\n', 'dir/b.txt': 'b'.repeat(70000), 'c.bin': '\u0000\u0001\u0002' }, 'seed');
    // no deltas (window 0): each object's inflated bytes are the object itself, so git's object size is the expected count
    const pack = new Uint8Array(gitBuf(bare, ['pack-objects', '--all', '--stdout', '--window=0', '-q'], ''));
    const expected = git(bare, ['cat-file', '--batch-all-objects', '--batch-check=%(objectsize)']).trim().split('\n').map(Number).sort((a, b) => a - b);
    const sizes = await scanLoop()(scanPack, (async function* () { yield pack; })());
    assert.deepEqual([...sizes].sort((a, b) => a - b), expected);
  } finally { cleanup(); }
});

test('README wire-span attributes: GET has no request bytes, POST has them, a failed exchange has no response bytes', async () => {
  const { root, cleanup } = tmpRoot(); const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'r'); const work = join(root, 'w'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'a.txt': 'a\n' }, 'seed');
    const ex = arrayExporter();
    const good = await readCommit(`${srv.url}/r.git`, { ref: 'main' }, { tracer: new Tracer({ exporter: ex }) });
    assert.ok(good.ok);
    const bad = await readCommit(`${srv.url}/missing.git`, { ref: 'main' }, { tracer: new Tracer({ exporter: ex }) });
    assert.equal(bad.ok, false);
    const wire = ex.lines.flatMap(flattenLine).filter(s => /^git\.(upload-pack|receive-pack)/.test(s.name));
    assert.ok(wire.length > 0);
    let failed = 0;
    for (const s of wire) {
      for (const k of ['git.transport', 'server.address']) assert.ok(k in s.attrs, `${s.name} lacks ${k}`);
      if (s.attrs['http.request.method'] === 'POST') assert.equal(typeof s.attrs['git.request.bytes'], 'number', `${s.name}: POST carries git.request.bytes`);
      else assert.ok(!('git.request.bytes' in s.attrs), `${s.name}: a GET sends no body`);
      const status = s.attrs['http.response.status_code'];
      if (typeof status === 'number' && status >= 400) { failed++; assert.ok(!('git.response.bytes' in s.attrs), `${s.name}: HTTP ${status} read no body`); }
      else assert.equal(typeof s.attrs['git.response.bytes'], 'number', `${s.name}: a completed exchange carries git.response.bytes`);
    }
    assert.ok(failed > 0, 'the missing repository produced a failed exchange span');
  } finally { await srv.close(); cleanup(); }
});
