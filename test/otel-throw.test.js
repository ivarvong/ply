// Telemetry never changes an operation's outcome (SAFETY I36, README "Telemetry"): a tracer whose onEnd or exporter
// throws, or whose async exporter rejects, is caught at the boundary where ply calls it. Judged against git
// http-backend: the Result is ok, and real git (rev-parse / show on the bare repository) says the push landed with the
// bytes this test wrote. The failures are counted on the tracer and handed to onTelemetryError.
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { commitChanges, editFile, pushTree, readFile, Tracer } from '../src/index.js';
import { operation } from '../src/operation.js';
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

// opts.tracer is duck-typed (owner decision; operation()'s entry check requires start() and nothing else). Two tracers
// that are not this copy's Tracer class: a start/span wrapper around a real one, and a Tracer without guard() (what a
// Tracer built by an older pinned copy of ply looks like to this copy). On main ec337c5 both return ok; the expected
// values below are git's: the ref moved, to a commit whose file holds the bytes written here.
const ducks = [
  ['a { start, span } wrapper', () => { const real = new Tracer({ exporter: () => { /* healthy */ } }); return { start: (name, o) => real.start(name, o), span: (name, o, f) => real.span(name, o, f) }; }],
  ['a Tracer without guard()', () => Object.defineProperty(new Tracer({ exporter: () => { /* healthy */ } }), 'guard', { value: null })],
];
for (const [label, make] of ducks) {
  test(`editFile and pushTree land and return ok when opts.tracer is ${label}`, async () => {
    for (const [api, run, path, content] of [
      ['editFile', tracer => editFile(url, { ref: 'refs/heads/main', path: 'a.txt', find: 'hello', replace: 'hello again', author, message: 'edit' }, { tracer }), 'a.txt', 'hello again\n'],
      ['pushTree', tracer => pushTree(url, { ref: 'refs/heads/main', files: { 'a.txt': 'hello\n', 't.txt': `${label}\n` }, author, message: 'tree' }, { tracer }), 't.txt', `${label}\n`],
    ]) {
      const before = head();
      let r;
      try { r = await run(make()); } catch (e) { assert.fail(`${api} rejected after the push (git: ref moved = ${head() !== before}): ${String(e)}`); }
      assert.equal(r.ok, true, r.ok ? '' : `${api}: ${r.error.code}: ${r.error.message}`);
      assert.notEqual(head(), before, `${api}: git says the ref moved`);
      assert.equal(git(bare, ['rev-parse', 'refs/heads/main~1']).trim(), before);
      assert.equal(git(bare, ['show', `refs/heads/main:${path}`]), content);
    }
  });
}

test('a throwing onFinish under a minimal duck-typed tracer: the landed push is ok, and the failure is reported as onFinish', async () => {
  const real = new Tracer();
  const reported = [];
  // the least operation() accepts: start(). onTelemetryError is read if present, never required.
  const minimal = { start: (name, o) => real.start(name, o) };
  const reporting = { start: (name, o) => real.start(name, o), onTelemetryError: (error, at) => { reported.push([error, at]); } };
  const thrown = new Error('onFinish down');
  for (const [n, tracer] of [minimal, reporting].entries()) {
    const before = head();
    const content = `landed under a throwing onFinish ${n}\n`;
    let r;
    // the body lands a real push, then leaves through outcome(), which runs onFinish
    try {
      r = await operation('probe', url, { tracer, onFinish: () => { throw thrown; } }, async ({ outcome }) => {
        const pushed = await commitChanges(url, { ref: 'refs/heads/main', changes: [{ kind: 'write', path: `of-${n}.txt`, content }], author, message: 'onFinish' }, {});
        return pushed.ok ? outcome('landed', pushed.value) : pushed;
      });
    } catch (e) { assert.fail(`operation() rejected after the push landed: ${String(e)}`); }
    assert.equal(r.ok, true, r.ok ? '' : `${r.error.code}: ${r.error.message}`);
    assert.equal(head(), r.value.oid, 'git: the ref is at the commit reported');
    assert.notEqual(head(), before);
    assert.equal(git(bare, ['show', `refs/heads/main:of-${n}.txt`]), content);
  }
  assert.deepEqual(reported, [[thrown, { hook: 'onFinish', span: 'git.probe' }]]);
});

// An exception from ply's own span-building is not the caller's exporter failing (owner decision): it is reported as
// 'internal'. The input: an attribute whose value has no string form (Object.create(null): String() of it is a
// TypeError by the language), which the OTLP encoding stringifies. The exporter here is healthy and must not be blamed.
test("a failure building the span is reported as 'internal', never as the exporter or onEnd, and end() does not throw", () => {
  for (const withOnEnd of [false, true]) {
    const reported = []; const lines = []; const ended = [];
    const tracer = new Tracer({ exporter: line => { lines.push(line); }, ...(withOnEnd ? { onEnd: s => { ended.push(s.name); } } : {}), onTelemetryError: (error, at) => { reported.push([error instanceof TypeError, at]); } });
    tracer.start('bad', { attrs: { unprintable: Object.create(null) } }).end();
    tracer.start('good', { attrs: { fine: 1 } }).end();
    assert.deepEqual(reported, [[true, { hook: 'internal', span: 'bad' }]]);
    assert.equal(tracer.telemetryErrors, 1);
    // the healthy span after it is exported as usual; the unbuildable one never reaches the exporter
    assert.deepEqual(lines.map(l => l.resourceSpans[0].scopeSpans[0].spans[0].name), ['good']);
    if (withOnEnd) assert.deepEqual(ended, ['good']);
  }
});
