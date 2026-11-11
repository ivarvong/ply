// Telemetry never changes an operation's outcome (SAFETY I36, README "Telemetry"): a tracer whose onEnd or exporter
// throws, or whose async exporter rejects, is caught at the boundary where ply calls it. Judged against git
// http-backend: the Result is ok, and real git (rev-parse / show on the bare repository) says the push landed with the
// bytes this test wrote. The failures are counted on the tracer and handed to onTelemetryError.
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { commitChanges, readFile, Tracer } from '../src/index.js';
import { tmpRoot, makeBareRepo, git, commitFiles, startGitServer } from './server.js';

let server; let bare; let url; let cleanup;
const author = { name: 'T', email: 't@example.com' };
const head = () => git(bare, ['rev-parse', 'refs/heads/main']).trim();
beforeAll(async () => {
  const tmp = tmpRoot(); cleanup = tmp.cleanup;
  bare = makeBareRepo(tmp.root, 'r');
  const work = join(tmp.root, 'work'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { 'a.txt': 'hello\n' });
  server = await startGitServer(tmp.root);
  url = `${server.url}/r.git`;
});
afterAll(async () => { await server.close(); cleanup(); });

const boom = hook => new Error(`${hook} down`);
// each row: the tracer options whose telemetry code fails on every span, and the hook the failure is reported under
const failing = [
  ['onEnd throws', { onEnd: () => { throw boom('onEnd'); } }, 'onEnd'],
  ['exporter throws (sync)', { exporter: () => { throw boom('exporter'); } }, 'exporter'],
  ['exporter rejects (async)', { exporter: async () => { await null; throw boom('exporter'); } }, 'exporter'],
  ['exporter throws a non-Error', { exporter: () => { throw null; } }, 'exporter'],
];

for (const [label, options, hook] of failing) {
  test(`a push lands and is reported ok when the tracer's ${label}`, async () => {
    const reported = [];
    const tracer = new Tracer({ ...options, onTelemetryError: (error, at) => { reported.push([error, at]); throw new Error('the reporter throws too'); } });
    const before = head();
    const path = `f-${failing.findIndex(f => f[0] === label)}.txt`;
    const content = `written under: ${label}\n`;
    const r = await commitChanges(url, { ref: 'refs/heads/main', changes: [{ kind: 'write', path, content }], author, message: label }, { tracer });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error.code}: ${r.error.message}`);
    // real git: the ref moved, to the commit ply reported, and the file holds the bytes written above
    const after = head();
    assert.notEqual(after, before);
    assert.equal(r.value.oid, after);
    assert.equal(git(bare, ['show', `refs/heads/main:${path}`]), content);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main~1']).trim(), before);
    // an async exporter's rejection settles a microtask later
    await new Promise(resolve => { setImmediate(resolve); });
    assert.ok(tracer.telemetryErrors > 0);
    assert.equal(reported.length, tracer.telemetryErrors);
    assert.ok(reported.every(([, at]) => at.hook === hook && typeof at.span === 'string' && at.span.startsWith('git.')));
    assert.ok(reported.some(([, at]) => at.span === 'git.receive-pack') && reported.some(([, at]) => at.span === 'git.commit'));
  });
}

test('a read returns its Result when onEnd and the exporter both throw', async () => {
  const tracer = new Tracer({ onEnd: () => { throw boom('onEnd'); }, exporter: () => { throw boom('exporter'); } });
  const r = await readFile(url, { ref: 'main', path: 'a.txt' }, { tracer });
  assert.equal(r.ok, true);
  assert.equal(await new Response(r.value.stream).text(), 'hello\n');
});

test('a Tracer subclass whose export() throws or rejects does not fail the push either', async () => {
  class Mirror extends Tracer { export() { throw boom('export'); } }
  class AsyncMirror extends Tracer { async export() { await null; throw boom('export'); } }
  for (const tracer of [new Mirror(), new AsyncMirror()]) {
    const before = head();
    const r = await commitChanges(url, { ref: 'refs/heads/main', changes: [{ kind: 'write', path: `m-${tracer.constructor.name}.txt`, content: 'm\n' }], author, message: 'mirror' }, { tracer });
    assert.equal(r.ok, true);
    assert.notEqual(head(), before);
    await new Promise(resolve => { setImmediate(resolve); });
    assert.ok(tracer.telemetryErrors > 0);
  }
});
