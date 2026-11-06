// #209: the ls-refs listing reader without a state copy per ref, and the line parser reading by index. The reader must
// answer exactly as it did before: the c91c9cf implementation is kept here as the model (parseLsRefLine split the line,
// lsRefsStep returned a copy of the state per frame), and both are run over generated lines and frame sequences. The
// cases after it pin each branch of the new code for the mutation gate, and lsRefs stops reading at the first ref past
// maxRefs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseLsRefLine, parseUnbornLine, lsInit, lsRefsStep, lsRefsEnd, lsRefs } from '../src/lsrefs.js';
import { decodeBytes, te } from '../src/bytes.js';
import { DEFAULT_LIMITS, withLimits } from '../src/limits.js';
import { none, some } from '../src/result.js';

// ---- the model: src/lsrefs.ts at c91c9cf, with parseOid's rule spelled out (40 lowercase hex after lowercasing) ----
const R_OK = (value) => ({ ok: true, value });
const R_ERR = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
const malformed = (line) => R_ERR('protocol', `ls-refs: malformed line ${JSON.stringify(line.slice(0, 60))}`);
const sha1Model = (text) => { const l = text.toLowerCase(); return /^[0-9a-f]{40}$/.test(l) ? l : null; };
function parseModel(line) {
  if (line.startsWith('ERR ')) return R_ERR('remote_error', `remote: ${line.slice(4)}`);
  const sp = line.indexOf(' ');
  if (sp < 0) return malformed(line);
  const oid = line.slice(0, sp);
  if (oid === 'unborn') return R_OK(null);
  const rest = line.slice(sp + 1);
  const cut = rest.indexOf(' ');
  const name = cut < 0 ? rest : rest.slice(0, cut);
  const attrs = cut < 0 ? [] : rest.slice(cut + 1).split(' ');
  if (/^[0-9a-fA-F]{64}$/.test(oid)) return R_ERR('unsupported', 'unsupported object-format: only sha1 repositories are supported');
  const parsed = sha1Model(oid);
  if (parsed === null) return malformed(line);
  const rec = { oid: parsed, name, peeled: null, 'symref-target': null };
  for (const a of attrs) {
    const colon = a.indexOf(':');
    if (colon < 0) continue;
    const key = a.slice(0, colon), value = a.slice(colon + 1);
    if (key === 'peeled') {
      const peeled = sha1Model(value);
      if (peeled === null) return malformed(line);
      rec[key] = peeled;
    } else if (key === 'symref-target') rec[key] = value;
  }
  return R_OK(rec);
}
const limitModel = (what, got, max) => R_ERR('limit_exceeded', `${what} ${got} exceeds limit ${max}`, { what, got, max });
function stepModel(st, f, caps) {
  if (st.tag === 'ended') return R_ERR('protocol', `ls-refs: ${f.kind} after the terminating flush-pkt`);
  if (f.kind === 'flush') return R_OK({ ...st, tag: 'ended' });
  if (f.kind !== 'data') return R_ERR('protocol', `ls-refs: unexpected ${f.kind} in ref listing`);
  const bytes = st.bytes + f.payload.length;
  if (bytes > caps.maxBytes) return limitModel('ls-refs bytes', bytes, caps.maxBytes);
  const line = decodeBytes(f.payload).replace(/\n$/, '');
  const parsed = parseModel(line);
  if (!parsed.ok) return parsed;
  const rec = parsed.value;
  if (rec === null) {
    const unborn = caps.unborn.tag === 'some' && caps.unborn.value ? caps.unborn.value(line, st.unborn) : st.unborn;
    return R_OK({ ...st, bytes, unborn });
  }
  if (st.refs.has(rec.name)) return R_OK({ ...st, bytes });
  let { counted } = st;
  if (rec.name !== 'HEAD') {
    if (counted >= caps.maxRefs) return limitModel('ls-refs lines', counted + 1, caps.maxRefs);
    counted += 1;
  }
  st.refs.set(rec.name, rec);
  const head = rec.name === 'HEAD' && rec['symref-target'] ? rec['symref-target'] : st.head;
  return R_OK({ ...st, bytes, counted, head });
}

// A Result as plain data: an Ok's value as given, an Err as the error's code, message and limit fields.
const errShape = (e) => ({ code: e.code, message: e.message, ...('what' in e ? { what: e.what } : {}), ...('got' in e ? { got: e.got, max: e.max } : {}) });
const shape = (r) => (r.ok ? R_OK(r.value) : { ok: false, error: errShape(r.error) });
const listing = (st) => ({ tag: st.tag, refs: [...st.refs.entries()], counted: st.counted, bytes: st.bytes, head: st.head, unborn: st.unborn });

function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}
const A = 'ab'.repeat(20), B = '0123456789'.repeat(4);
// Fields chosen at the edges of each rule: oids of either case, 64-hex, 39/41 chars, a non-ASCII letter that
// lowercases to two code units (U+0130) or to ASCII (U+212A KELVIN SIGN), every key spelling near the two kept ones.
const FIELDS = [
  A, B, A.toUpperCase(), `${A.slice(0, 20)}${A.slice(20).toUpperCase()}`, 'ab'.repeat(32), 'AB'.repeat(32), A.slice(1), `${A}0`,
  `İ${A.slice(2)}`, `K${A.slice(1)}`, 'unborn', 'ERR', 'HEAD', 'refs/heads/main', 'refs/tags/v1', '',
  `peeled:${B}`, `peeled:${A.toUpperCase()}`, 'peeled:', 'peeled:junk', `peeled:${B}:`, 'peeled', `peeled_:${B}`, `Peeled:${B}`, `xpeeled:${B}`,
  'symref-target:refs/heads/main', 'symref-target:', 'symref-target', 'symref-target::a:b', 'symref-targetx:y', ':', ':peeled',
  'a:b', '__proto__:x', 'capabilities^{}', 'été',
];
const SEPARATORS = [' ', ' ', ' ', '  ', ''];
function genLine(r) {
  const n = r() % 6;
  let line = r() % 7 === 0 ? 'ERR ' : '';
  for (let i = 0; i < n; i++) {
    // the first field is mostly an oid, so most lines reach the name and attribute rules
    const f = i === 0 && r() % 3 > 0 ? FIELDS[r() % 4] : FIELDS[r() % FIELDS.length];
    line += (i > 0 ? SEPARATORS[r() % SEPARATORS.length] : '') + f;
  }
  if (r() % 9 === 0) line += ' ';
  return line;
}

test('parseLsRefLine answers as the c91c9cf parser on 20,000 generated lines', () => {
  const r = prng(209);
  const seen = new Set();
  for (let i = 0; i < 20_000; i++) {
    const line = genLine(r);
    const got = shape(parseLsRefLine(line)), want = parseModel(line);
    assert.deepEqual(got, want, JSON.stringify(line));
    seen.add(want.ok ? (want.value === null ? 'unborn' : `ok:${want.value.peeled !== null}:${want.value['symref-target'] !== null}`) : want.error.code);
  }
  // every outcome the parser has was reached
  for (const k of ['unborn', 'ok:false:false', 'ok:true:false', 'ok:false:true', 'ok:true:true', 'remote_error', 'protocol', 'unsupported']) assert.ok(seen.has(k), k);
});

test('lsRefsStep answers as the c91c9cf step on 3,000 generated frame sequences', () => {
  const r = prng(20_261_106);
  const readers = [none, some(null), some(parseUnbornLine)];
  const lines = [
    `${A} HEAD symref-target:refs/heads/main`, `${A} HEAD`, `${B} HEAD symref-target:`, `${A} HEAD symref-target:refs/heads/other`,
    `${A} refs/heads/main`, `${B} refs/heads/main`, `${A} refs/heads/HEAD`, `${B} refs/tags/v1 peeled:${A}`,
    'unborn HEAD symref-target:refs/heads/main', 'unborn HEAD symref-target:', 'unborn refs/heads/x symref-target:y', 'unborn HEAD',
    `${A} refs/heads/é`, 'ERR denied', `${A}`, `${'ab'.repeat(32)} HEAD`,
  ];
  const frame = () => {
    const k = r() % 40;
    if (k === 0) return { kind: 'flush' };
    if (k === 1) return { kind: 'delim' };
    if (k === 2) return { kind: 'end' };
    const text = k < 10 ? `${A} refs/pull/${r() % 12}/head` : lines[r() % lines.length];
    const bytes = te.encode(r() % 4 === 0 ? text : `${text}\n`);
    // a stray byte that is no UTF-8: decodeBytes keeps it as an escape, before the LF and at the end
    return { kind: 'data', payload: r() % 13 === 0 ? Uint8Array.from([...bytes.slice(0, -1), 0xff, ...bytes.slice(-1)]) : bytes };
  };
  let refused = 0, ended = 0;
  for (let s = 0; s < 3000; s++) {
    const frames = Array.from({ length: 1 + (r() % 14) }, frame);
    if (r() % 2 === 0) frames.push({ kind: 'flush' });
    const maxBytes = r() % 3 === 0 ? 40 + (r() % 400) : 1 << 20;
    const caps = { maxBytes, maxRefs: r() % 6, unborn: readers[r() % readers.length] };
    let st = lsInit(), model = lsInit();
    let stopped = false;
    for (const f of frames) {
      const got = lsRefsStep(st, f, caps), want = stepModel(model, f, caps);
      assert.equal(got.ok, want.ok, JSON.stringify(frames.map(x => x.kind)));
      if (!want.ok) { assert.deepEqual(errShape(got.error), want.error); stopped = true; refused++; break; }
      // the step returns the listing it was given, updated
      assert.equal(got.value, st);
      st = got.value; model = want.value;
      assert.deepEqual(listing(st), listing(model));
    }
    if (stopped) continue;
    const got = lsRefsEnd(st), want = lsRefsEnd(model);
    assert.deepEqual(shape(got), shape(want));
    if (want.ok) ended++;
  }
  assert.ok(refused > 500 && ended > 200, `${refused} refused, ${ended} ended`);
});

// ---- the branches, one by one ----
const caps = (o = {}) => ({ maxBytes: 1 << 20, maxRefs: 10, unborn: none, ...o });
const data = (s) => ({ kind: 'data', payload: te.encode(s) });
const len = (s) => te.encode(s).length;
function run(lines, c = caps()) {
  const st = lsInit();
  for (const l of lines) {
    const r = lsRefsStep(st, typeof l === 'string' ? data(l) : l, c);
    if (!r.ok) return { st, error: r.error };
  }
  return { st, error: null };
}

test('parseLsRefLine: each field rule, read by index', () => {
  const v = (line) => { const r = parseLsRefLine(line); assert.ok(r.ok, line); return r.value; };
  assert.deepEqual(v(`${A} refs/heads/a`), { oid: A, name: 'refs/heads/a', peeled: null, 'symref-target': null });
  // the name ends at the first space; the attribute values run to the next space or the end
  assert.deepEqual(v(`${A} r peeled:${B} symref-target:t`), { oid: A, name: 'r', peeled: B, 'symref-target': 't' });
  assert.deepEqual(v(`${A} r symref-target:t peeled:${B}`), { oid: A, name: 'r', peeled: B, 'symref-target': 't' });
  assert.deepEqual(v(`${A} r symref-target:t:u x`), { oid: A, name: 'r', peeled: null, 'symref-target': 't:u' });
  assert.deepEqual(v(`${A} r symref-target:`), { oid: A, name: 'r', peeled: null, 'symref-target': '' });
  assert.deepEqual(v(`${A} r symref-target:a symref-target:b`)['symref-target'], 'b', 'the last one wins');
  assert.deepEqual(v(`${A} r peeled:${A} peeled:${B}`).peeled, B, 'the last one wins');
  assert.deepEqual(v(`${A} r peeled:${A.toUpperCase()}`).peeled, A, 'a peeled oid of either case, kept lowercase');
  assert.deepEqual(v(`${A.toUpperCase()} r`).oid, A);
  assert.deepEqual(v(`${A} r  symref-target:t `), { oid: A, name: 'r', peeled: null, 'symref-target': 't' }, 'empty fields skipped');
  assert.deepEqual(v(`${A} r x:symref-target:t`)['symref-target'], null, 'the key is the text before the first colon');
  assert.deepEqual(v(`${A} r ysymref-target:t zpeeled:${B}`), { oid: A, name: 'r', peeled: null, 'symref-target': null });
  assert.deepEqual(v(`${A}  r`).name, '', 'a doubled space: the name is the empty field');
  assert.deepEqual(v(`${A} `).name, '');
  assert.deepEqual(v(`${A} peeled:${B}`), { oid: A, name: `peeled:${B}`, peeled: null, 'symref-target': null }, 'the second field is the name, whatever it says');
  // a malformed peeled oid anywhere in the line, and a sha256 oid against everything else that is not 40 hex
  for (const line of [`${A} r peeled:${A}0`, `${A} r peeled:`, `${A} r symref-target:t peeled:x y`]) {
    assert.deepEqual(shape(parseLsRefLine(line)), malformed(line), line);
  }
  assert.equal(parseLsRefLine(`${'AB'.repeat(32)} r`).error.code, 'unsupported');
  assert.deepEqual(shape(parseLsRefLine(`${'ab'.repeat(31)} r`)), malformed(`${'ab'.repeat(31)} r`));
  assert.deepEqual(shape(parseLsRefLine(`İ${A.slice(2)} r`)), malformed(`İ${A.slice(2)} r`), 'lowercases to 40 code units, not 40 hex digits');
});

test('lsRefsStep: one listing, updated in place; a refusal changes nothing', () => {
  const st = lsInit();
  const c = caps({ maxRefs: 2 });
  const first = lsRefsStep(st, data(`${A} HEAD symref-target:refs/heads/main\n`), c);
  assert.equal(first.value, st);
  const headBytes = len(`${A} HEAD symref-target:refs/heads/main\n`);
  assert.deepEqual(listing(st), { tag: 'open', refs: [['HEAD', { oid: A, name: 'HEAD', peeled: null, 'symref-target': 'refs/heads/main' }]], counted: 0, bytes: headBytes, head: 'refs/heads/main', unborn: null });
  assert.equal(lsRefsStep(st, data(`${A} refs/heads/a\n`), c).value, st);
  assert.equal(lsRefsStep(st, data(`${A} refs/heads/HEAD\n`), c).value, st);
  assert.deepEqual([st.counted, st.bytes, st.refs.size], [2, headBytes + len(`${A} refs/heads/a\n`) + len(`${A} refs/heads/HEAD\n`), 3]);
  const before = listing(st);
  const refused = lsRefsStep(st, data(`${A} refs/heads/b\n`), c);
  assert.deepEqual(errShape(refused.error), { code: 'limit_exceeded', message: 'ls-refs lines 3 exceeds limit 2', what: 'ls-refs lines', got: 3, max: 2 });
  assert.deepEqual(listing(st), before);
  const ended = lsRefsStep(st, { kind: 'flush' }, c);
  assert.equal(ended.value, st);
  assert.equal(st.tag, 'ended');
  assert.deepEqual(lsRefsEnd(st).value, { refs: st.refs, head: 'refs/heads/main', unborn: null });
  assert.equal(lsRefsStep(st, data(`${A} refs/heads/b\n`), c).error.message, 'ls-refs: data after the terminating flush-pkt');
});

test('lsRefsStep: maxRefs counts names other than HEAD, at the boundary', () => {
  const refs = (n) => Array.from({ length: n }, (_, i) => `${A} refs/heads/b${i}\n`);
  assert.equal(run([...refs(3), `${A} HEAD\n`], caps({ maxRefs: 3 })).error, null, 'exactly maxRefs, and HEAD beside them');
  assert.equal(run([`${A} HEAD\n`, ...refs(3)], caps({ maxRefs: 3 })).st.counted, 3);
  const over = run([...refs(4), `${A} HEAD\n`], caps({ maxRefs: 3 }));
  assert.deepEqual([over.error.what, over.error.got, over.error.max, over.st.counted, over.st.refs.size], ['ls-refs lines', 4, 3, 3, 3]);
  assert.equal(run([`${A} HEAD\n`], caps({ maxRefs: 0 })).error, null, 'HEAD alone, under maxRefs 0');
  assert.equal(run([`${A} refs/heads/HEAD\n`], caps({ maxRefs: 0 })).error.got, 1, 'refs/heads/HEAD is a branch');
  // a name listed twice is read once and counted once; its bytes still count
  const dup = run([...refs(2), `${B} refs/heads/b0\n`], caps({ maxRefs: 2 }));
  assert.deepEqual([dup.error, dup.st.counted, dup.st.refs.get('refs/heads/b0').oid, dup.st.bytes], [null, 2, A, 3 * len(`${A} refs/heads/b0\n`)]);
});

test('lsRefsStep: maxBytes counts every data frame, the duplicate and the unborn lines too, at the boundary', () => {
  const lines = [`${A} refs/heads/a\n`, `${B} refs/heads/a\n`, 'unborn HEAD symref-target:refs/heads/main\n', `${A} HEAD\n`];
  const total = lines.reduce((n, l) => n + te.encode(l).length, 0);
  for (const unborn of [none, some(parseUnbornLine)]) {
    assert.equal(run(lines, caps({ maxBytes: total, unborn })).error, null);
    assert.equal(run(lines, caps({ maxBytes: total, unborn })).st.bytes, total);
    const over = run(lines, caps({ maxBytes: total - 1, unborn })).error;
    assert.deepEqual([over.what, over.got, over.max], ['ls-refs bytes', total, total - 1]);
  }
});

test('lsRefsStep: HEAD names the symref target only when it has one; the first HEAD is the one kept', () => {
  assert.equal(run([`${A} HEAD symref-target:refs/heads/main`]).st.head, 'refs/heads/main');
  assert.equal(run([`${A} HEAD`]).st.head, null);
  assert.equal(run([`${A} HEAD symref-target:`]).st.head, null);
  assert.equal(run([`${A} HEAD symref-target:refs/heads/a`, `${A} HEAD symref-target:refs/heads/b`]).st.head, 'refs/heads/a');
  assert.equal(run([`${A} refs/heads/x symref-target:refs/heads/a`]).st.head, null, 'only HEAD names it');
});

test('lsRefsStep: an unborn line goes to the reader the caller passed, and to no other', () => {
  const line = 'unborn HEAD symref-target:refs/heads/main\n';
  assert.deepEqual(run([line], caps({ unborn: some(parseUnbornLine) })).st.unborn, { name: 'HEAD', target: 'refs/heads/main' });
  assert.equal(run([line], caps({ unborn: some(null) })).st.unborn, null);
  assert.equal(run([line], caps({ unborn: none })).st.unborn, null);
  const seen = [];
  const reader = (l, prev) => { seen.push([l, prev]); return { name: 'HEAD', target: `t${seen.length}` }; };
  assert.deepEqual(run([line, `${line.trim()} x`], caps({ unborn: some(reader) })).st.unborn, { name: 'HEAD', target: 't2' });
  assert.deepEqual(seen, [[line.trim(), null], [`${line.trim()} x`, { name: 'HEAD', target: 't1' }]], 'the line without its LF, and the previous answer');
  assert.equal(run([line], caps({ unborn: some(reader) })).st.refs.size, 0);
});

test('lsRefsStep: only the one trailing LF comes off', () => {
  assert.equal(run([`${A} refs/heads/a`]).st.refs.has('refs/heads/a'), true, 'no LF: the line as it is');
  assert.equal(run([`${A} refs/heads/a\n`]).st.refs.has('refs/heads/a'), true);
  assert.equal(run([`${A} refs/heads/a\n\n`]).st.refs.has('refs/heads/a\n'), true, 'the second LF is the name\'s');
  assert.equal(run([`${A} r symref-target:t\r\n`]).st.refs.get('r')['symref-target'], 't\r');
  assert.equal(run([`${A} refs/heads/a \n`]).st.refs.has('refs/heads/a '), true);
});

// lsRefs reads the listing as the frames arrive and stops at the first ref past maxRefs: the frames after it are never
// pulled from the transport (the 413 a large listing gets is decided at ref maxRefs + 1, not after the whole answer).
test('lsRefs stops reading at the first ref past maxRefs, and at the frame past maxLsRefsBytes', async () => {
  const spanStub = { set() {}, event() {}, error() {} };
  const pulled = { n: 0, closed: false };
  const transport = (limits, n) => ({
    limits, tracer: { span: async (_name, _opts, fn) => fn(spanStub) }, parent: null,
    async *frames() {
      try {
        yield data(`${A} HEAD symref-target:refs/heads/b0\n`); pulled.n++;
        for (let i = 0; i < n; i++) { yield data(`${A} refs/heads/b${i}\n`); pulled.n++; }
        yield { kind: 'flush' };
      } finally { pulled.closed = true; }
    },
  });
  const headLen = len(`${A} HEAD symref-target:refs/heads/b0\n`), refLen = len(`${A} refs/heads/b0\n`);
  const refused = await lsRefs(transport(withLimits({ maxRefs: 5 }), 1000));
  assert.deepEqual(errShape(refused.error), { code: 'limit_exceeded', message: 'ls-refs lines 6 exceeds limit 5', what: 'ls-refs lines', got: 6, max: 5 });
  assert.deepEqual(pulled, { n: 6, closed: true }, 'HEAD and five refs read, the sixth refused as it arrived, the stream closed');
  pulled.n = 0; pulled.closed = false;
  const listed = await lsRefs(transport(withLimits({ maxRefs: 5 }), 5));
  assert.deepEqual([listed.ok, listed.value.refs.size, listed.value.head], [true, 6, 'refs/heads/b0']);
  pulled.n = 0; pulled.closed = false;
  const bytes = await lsRefs(transport(withLimits({ maxLsRefsBytes: headLen + 2 * refLen }), 1000));
  assert.deepEqual([bytes.error.what, bytes.error.got, pulled.n, pulled.closed], ['ls-refs bytes', headLen + 3 * refLen, 3, true]);
  assert.equal(DEFAULT_LIMITS.maxRefs, 10_000);
});
