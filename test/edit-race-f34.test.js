// F34: same-file edit races must never surface as ambiguous (HTTP 502 via ply-web). One ok, rest cas_conflict.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { editFile } from '../src/edit.js';
import { Tracer } from '../src/otel.js';
import { unwrapAsync } from './unwrap.js';

test('same-file edit race ×1000 attempts: only ok and cas_conflict', async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'f34');
    const work = join(root, 'w'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'README.md': 'ply-edit-1\n' }, 'seed');
    const url = `${srv.url}/f34.git`;
    const TRIALS = 200;
    const RACERS = 5;
    const bad = [];
    for (let trial = 0; trial < TRIALS; trial++) {
      const tip = git(bare, ['rev-parse', 'main']).trim();
      // find still matches once after prior winners (they keep the ply-edit-1\n prefix)
      const results = await Promise.all(Array.from({ length: RACERS }, (_, i) =>
        unwrapAsync(editFile(url, {
          path: 'README.md', find: 'ply-edit-1\n', replace: `ply-edit-1\nrace-${trial}-${i}\n`,
          author: { name: 'r', email: 'r@x' }, message: `t${trial}-${i}`,
        }, { head: tip, strictHead: true, tracer: new Tracer() })).then(
          () => ({ ok: true, code: null }),
          e => ({ ok: false, code: e.code }),
        )));
      const nOk = results.filter(x => x.ok).length;
      const nCas = results.filter(x => !x.ok && x.code === 'cas_conflict').length;
      const other = results.filter(x => !x.ok && x.code !== 'cas_conflict');
      if (nOk !== 1 || nCas !== RACERS - 1 || other.length) {
        bad.push({ trial, nOk, nCas, other: other.map(o => o.code), codes: results.map(r => r.ok ? 'ok' : r.code) });
        break;
      }
    }
    assert.deepEqual(bad, [], JSON.stringify(bad.slice(0, 3)));
  } finally {
    await srv.close();
    cleanup();
  }
}, 180_000);
