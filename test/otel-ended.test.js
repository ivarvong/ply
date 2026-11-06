// EndedSpan and Tracer's onEnd (issue #210): a span as it ended, as plain values, with no OTLP built unless asked.
// The contract: every field of the EndedSpan equals what flattenLine reads back from the OTLP line end() exports for the
// same span (judged here over random attribute records of every value kind, scrubbed and not, with events, links and
// error status), otlp() is that very span, and a tracer builds only the forms someone consumes.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Tracer, arrayExporter, flattenLine, KIND } from '../src/otel.js';

const scrub = s => s.replaceAll('SECRET', '[redacted]');
const plain = ended => { const flat = { ...ended }; delete flat.startTimeUnixNano; delete flat.endTimeUnixNano; delete flat.otlp; return flat; };

// A deterministic generator of attribute values: every branch of anyValue, the edges of each (-0, NaN, a bigint past
// 2^53, an empty and an over-4096-byte Uint8Array, nested arrays holding null and the missing value, objects).
function rng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; }; }
function value(r, depth = 0) {
  const pick = Math.floor(r() * 17);
  switch (pick) {
    case 0: return null;
    case 1: return undefined;
    case 2: return '';
    case 3: return `v${Math.floor(r() * 100)} SECRET tail`;
    case 4: return r() < 0.5;
    case 5: return Math.floor(r() * 2 ** 40) - 2 ** 39;
    case 6: return -0;
    case 7: return r() * 1e6 - 5e5;
    case 8: return [Number.NaN, Infinity, -Infinity, 1e21, 2 ** 53 + 2][Math.floor(r() * 5)];
    case 9: return BigInt(Math.floor(r() * 2 ** 50)) * 123_456_789n - 99n;
    case 10: return Uint8Array.from({ length: Math.floor(r() * 8) }, () => Math.floor(r() * 256));
    case 11: return new Uint8Array(4100).fill(7);
    case 12: return depth > 2 ? 'leaf' : Array.from({ length: Math.floor(r() * 4) }, () => value(r, depth + 1));
    case 13: return { toString: () => 'object SECRET' };
    case 14: return new Date(0);
    case 15: return 0;
    default: return `plain-${pick}`;
  }
}
function attrs(r) {
  const out = {};
  const n = Math.floor(r() * 12);
  for (let i = 0; i < n; i++) out[`k.${i}.${Math.floor(r() * 3)}`] = value(r);
  if (r() < 0.1) Object.defineProperty(out, '__proto__', { value: value(r), enumerable: true, writable: true, configurable: true });
  return out;
}

test('an EndedSpan is exactly what flattenLine reads back from the exported OTLP line, and otlp() is that span', () => {
  const r = rng(20261106);
  let compared = 0, scrubbed = 0, errors = 0, withEvents = 0, followers = 0;
  for (let round = 0; round < 400; round++) {
    const ended = [];
    const exporter = arrayExporter();
    const t = new Tracer({ exporter, onEnd: s => ended.push(s), maxEvents: 3 });
    const useScrub = r() < 0.5;
    const root = t.start('git.op', { attrs: attrs(r), ...(useScrub ? { scrub } : {}) });
    const child = t.start('git.op.child', { parent: root, kind: KIND.CLIENT, attrs: attrs(r) });
    child.set(attrs(r));
    for (let e = Math.floor(r() * 5); e > 0; e--) child.event(`ev${e}`, attrs(r));
    if (r() < 0.3) { child.error(Object.assign(new Error('boom SECRET'), { code: 'http' })); errors++; }
    child.end();
    const follower = t.start('git.op.stream', { follows: root, attrs: attrs(r) });
    root.end();
    follower.end();
    followers++;
    assert.equal(ended.length, 3);
    assert.equal(exporter.lines.length, 3);
    for (let i = 0; i < 3; i++) {
      const line = exporter.lines[i];
      const [flat] = flattenLine(line);
      assert.deepStrictEqual(plain(ended[i]), flat, `round ${round} span ${i}`);
      const otlp = line.resourceSpans[0].scopeSpans[0].spans[0];
      assert.equal(ended[i].otlp(), otlp, 'otlp() is the span the exporter got');
      assert.equal(ended[i].startTimeUnixNano, otlp.startTimeUnixNano);
      assert.equal(ended[i].endTimeUnixNano, otlp.endTimeUnixNano);
      if (useScrub) scrubbed++;
      if (flat.events.length) withEvents++;
      compared++;
    }
    if (useScrub) for (const s of ended) assert.ok(!JSON.stringify(plain(s)).includes('SECRET'), 'no credential in a scrubbed EndedSpan');
  }
  assert.ok(compared === 1200 && scrubbed > 300 && errors > 50 && withEvents > 100 && followers === 400, `vacuous: ${compared} ${scrubbed} ${errors} ${withEvents}`);
});

test('onEnd alone: no exporter call and no OTLP until otlp() is asked; then built once, as an exporter would have got it', () => {
  const ended = [];
  const t = new Tracer({ onEnd: s => ended.push(s) });
  const s = t.start('git.x', { attrs: { 'git.x.n': 3n, 'git.x.s': 'SECRET' }, scrub });
  s.event('e', { a: 1 });
  s.end();
  assert.equal(t.count, 1, 'every ended span is counted');
  assert.equal(ended.length, 1);
  const [e] = ended;
  assert.deepStrictEqual(e.attrs, { 'git.x.n': 3, 'git.x.s': '[redacted]', 'ply.isolate.invocation': e.attrs['ply.isolate.invocation'], 'ply.isolate.cold': e.attrs['ply.isolate.cold'] });
  // late writes after end change the live span, not what ended
  s.set({ 'git.x.late': 1 });
  s.event('late');
  s.error(new Error('late'));
  assert.equal(s.attrs['git.x.late'], 1, 'a late set still lands on the span');
  const otlp = e.otlp();
  assert.equal(e.otlp(), otlp, 'built once');
  const [flat] = flattenLine({ resourceSpans: [{ resource: t.resource, scopeSpans: [{ scope: t.scope, spans: [otlp] }] }] });
  assert.deepStrictEqual(plain(e), flat);
  assert.ok(!otlp.attributes.some(kv => kv.key === 'git.x.late'));
  assert.equal(otlp.events.length, 1);
  assert.equal(otlp.status.code, 1);
  assert.deepStrictEqual(otlp.attributes.find(kv => kv.key === 'git.x.n').value, { intValue: '3' });
});

test('a tracer with neither onEnd nor an exporter builds nothing and still counts; the default exporter is unchanged', () => {
  const t = new Tracer();
  assert.equal(t.onEnd, null);
  t.start('a').end();
  t.start('b').end();
  assert.equal(t.count, 2);
  t.exporter({ resourceSpans: [] });
});

test('onEnd runs before the exporter, and a subclass that overrides export gets every span (old consumers)', () => {
  const order = [];
  const t = new Tracer({ exporter: () => order.push('export'), onEnd: () => order.push('onEnd') });
  t.start('a').end();
  assert.deepStrictEqual(order, ['onEnd', 'export']);
  const seen = [];
  class Mirror extends Tracer { export(span) { seen.push(span.name); super.export(span); } }
  new Mirror().start('m1').end();
  const viaSink = [];
  new Mirror({ onEnd: s => viaSink.push(s.name) }).start('m2').end();
  assert.deepStrictEqual(seen, ['m1', 'm2']);
  assert.deepStrictEqual(viaSink, ['m2']);
  const exported = [];
  const late = new Tracer();
  late.exporter = line => exported.push(line);
  late.start('assigned').end();
  assert.equal(exported.length, 1, 'an exporter assigned after construction is used');
});

test('ids: 32 and 16 lowercase hex digits, distinct across pool refills', () => {
  const t = new Tracer();
  const ids = new Set();
  for (let i = 0; i < 2000; i++) {
    const s = t.start('r');
    assert.match(s.traceId, /^[0-9a-f]{32}$/);
    assert.match(s.spanId, /^[0-9a-f]{16}$/);
    const c = t.start('c', { parent: s });
    assert.equal(c.traceId, s.traceId);
    ids.add(s.traceId); ids.add(s.spanId); ids.add(c.spanId);
  }
  assert.equal(ids.size, 6000);
});
