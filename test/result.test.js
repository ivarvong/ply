// The errors-as-values layer: Result helpers, the PlyError constructor, and limits' value API next to its throwing
// wrappers. Exact values and boundaries, so a mutant of any comparison or field fails here (stryker: vitest.stryker).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ok, err, map, mapErr, andThen, match, matchKind, matchOption, assertNever, errorKind, errorKindAttr, some, none, isSome, isNone, resultToOption, optionToResult, transposeResultOption, transposeOptionResult } from '../src/result.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { fail, plyError, isPlyCode, retryPolicy, isRetryable, CODES, RETRY } from '../src/errors.js';
import { checkLimit, parseLimits, limitsOf, lowered, limitExceeded, limitError, DEFAULT_LIMITS, WORKER_LIMITS } from '../src/limits.js';
import { unwrap } from './unwrap.js';

test('Result: ok/err shapes, map/mapErr/andThen short-circuit, match dispatches on code, assertNever throws', () => {
  assert.deepEqual(ok(1), { ok: true, value: 1 });
  assert.deepEqual(err('e'), { ok: false, error: 'e' });
  assert.deepEqual(map(ok(2), n => n * 3), { ok: true, value: 6 });
  const e = err('x');
  assert.equal(map(e, () => assert.fail('mapped an Err')), e);
  assert.deepEqual(mapErr(err('a'), s => `${s}!`), { ok: false, error: 'a!' });
  const o = ok(1);
  assert.equal(mapErr(o, () => assert.fail('mapped an Ok error')), o);
  assert.deepEqual(andThen(ok(2), n => ok(n + 1)), { ok: true, value: 3 });
  assert.deepEqual(andThen(ok(2), () => err('late')), { ok: false, error: 'late' });
  assert.equal(andThen(e, () => assert.fail('continued past an Err')), e);
  assert.equal(match({ code: 'a', n: 4 }, { a: u => u.n + 1, b: () => 0 }), 5);
  assert.equal(match({ code: 'b' }, { a: () => 1, b: () => 2 }), 2);
  assert.equal(matchKind({ kind: 'a', n: 4 }, { a: u => u.n + 1, b: () => 0 }), 5);
  assert.equal(matchKind({ kind: 'b' }, { a: () => 1, b: () => 2 }), 2);
  assert.throws(() => assertNever('z'), { message: 'unreachable: z' });
});

test('errorKind is the span attribute: miss, then kind, then reason, then code', () => {
  assert.equal(errorKind({ code: 'not_found', miss: { kind: 'path' }, kind: 'other', reason: 'short_read' }), 'path');
  assert.equal(errorKind({ code: 'bad_request', kind: 'not_string', reason: 'short_read' }), 'not_string');
  assert.equal(errorKind({ code: 'remote_error', reason: 'not_our_ref' }), 'not_our_ref');
  assert.equal(errorKind({ code: 'timeout' }), 'timeout');
  assert.equal(errorKind({ miss: { kind: 1 }, code: 'not_found' }), 'not_found');
  assert.equal(errorKind({ code: 7 }), 'Error');
  assert.equal(errorKind(null), 'Error');
  assert.equal(errorKind('x'), 'Error');
  const e = { code: 'not_found', miss: { kind: 'head_absent' } };
  assert.deepEqual(errorKindAttr(e), { 'error.kind': 'head_absent' });
  const ex = arrayExporter();
  const span = new Tracer({ exporter: ex }).start('git.result.kind');
  span.set(errorKindAttr(e)).error(e, e.code).end();
  const flat = flattenLine(ex.lines[0])[0];
  assert.equal(flat.attrs['error.kind'], 'head_absent');
  assert.equal(flat.attrs['error.type'], 'not_found');
  assert.equal(flat.name, 'git.result.kind');
});

test('Option is some or none, and it composes with Result', () => {
  assert.deepEqual(some(1), { tag: 'some', value: 1 });
  assert.deepEqual(none, { tag: 'none' });
  assert.equal(isSome(some(1)), true);
  assert.equal(isNone(none), true);
  assert.equal(isSome(none), false);
  assert.equal(matchOption(some(2), { some: n => n + 1, none: () => 0 }), 3);
  assert.equal(matchOption(none, { some: () => 1, none: () => 2 }), 2);
  assert.deepEqual(resultToOption(ok(3)), some(3));
  assert.equal(resultToOption(err('e')), none);
  assert.deepEqual(optionToResult(some(4), 'missing'), ok(4));
  assert.deepEqual(optionToResult(none, 'missing'), err('missing'));
  assert.deepEqual(transposeResultOption(ok(some(5))), some(ok(5)));
  assert.equal(transposeResultOption(ok(none)), none);
  assert.deepEqual(transposeResultOption(err('e')), some(err('e')));
  assert.deepEqual(transposeOptionResult(some(ok(6))), ok(some(6)));
  assert.deepEqual(transposeOptionResult(some(err('e'))), err('e'));
  assert.deepEqual(transposeOptionResult(none), ok(none));
});

// Span.error writes error.kind itself. A caller who stamped a stale kind is overwritten, so the attribute is the value.
test('Span.error records error.kind beside error.type', () => {
  const cells = [
    [{ code: 'not_found', miss: { kind: 'head_absent' }, kind: 'other', reason: 'short_read' }, 'not_found', 'head_absent'],
    [{ code: 'bad_request', kind: 'not_string', reason: 'short_read' }, 'bad_request', 'not_string'],
    [{ code: 'remote_error', reason: 'not_our_ref' }, 'remote_error', 'not_our_ref'],
    [{ code: 'timeout' }, 'timeout', 'timeout'],
    [{ miss: { kind: 1 }, code: 'not_found' }, 'not_found', 'not_found'],
    ['plain', undefined, 'Error'],
    [null, 'bad_request', 'Error'],
  ];
  for (const [value, type, kind] of cells) {
    const ex = arrayExporter();
    const span = new Tracer({ exporter: ex }).start('git.otel.kind');
    span.set({ 'error.kind': 'stale' }).error(value, type).end();
    const flat = flattenLine(ex.lines[0])[0];
    assert.equal(flat.attrs['error.kind'], kind, kind);
    assert.equal(flat.attrs['error.type'], type ?? 'Error');
    assert.equal(flat.name, 'git.otel.kind');
  }
});

test('PlyError: one constructor, an Error carrying its fields; fail wraps it in an Err', () => {
  const e = plyError('http', 'HTTP 502', { status: 502 });
  assert.ok(e instanceof Error);
  assert.equal(e.code, 'http');
  assert.equal(e.message, 'HTTP 502');
  assert.equal(e.status, 502);
  const r = fail('timeout', 't');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'timeout');
  assert.equal(r.error.message, 't');
  assert.throws(() => plyError('nope', 'x'), { message: 'internal: unknown error code nope' });
  assert.deepEqual(CODES, Object.keys(RETRY));
  assert.ok(Object.isFrozen(CODES) && Object.isFrozen(RETRY));
  assert.equal(isPlyCode('network'), true);
  assert.equal(isPlyCode('nope'), false);
  assert.equal(isPlyCode(7), false);
  assert.equal(retryPolicy({ code: 'cas_conflict' }), 'fresh');
  assert.equal(retryPolicy({ code: 'nope' }), 'no');
  assert.equal(retryPolicy(null), 'no');
  assert.equal(isRetryable({ code: 'network' }), true);
  assert.equal(isRetryable({ code: 'ambiguous' }), false);
});

test('limits: checkLimit/parseLimits accept exactly the finite non-negative numbers; the error is an Error with its fields', () => {
  const bad = (what, got) => ({ ok: false, error: { code: 'bad_request', message: `limits.${what} must be a finite non-negative number`, what, got } });
  const shape = r => (r.ok ? r : { ok: false, error: { code: r.error.code, message: r.error.message, what: r.error.what, got: r.error.got } });
  for (const v of [0, 1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(checkLimit(v, 'k'), { ok: true, value: v });
    assert.equal(unwrap(checkLimit(v, 'k')), v);
  }
  for (const v of [-1, -0.5, Number.NaN, Infinity, -Infinity, '5', undefined, null]) {
    assert.deepEqual(shape(checkLimit(v, 'k')), bad('k', v));
    assert.throws(() => unwrap(checkLimit(v, 'k')), x => x instanceof Error && x.code === 'bad_request' && x.what === 'k' && Object.is(x.got, v));
  }
  // parseLimits (#156): a key given is checked as checkLimit checks it; a key left out (or the missing value) is the
  // default; null is a value, refused, on every key (#271); keys it does not read are
  // ignored; the record is total, frozen and checked.
  assert.equal(unwrap(parseLimits(DEFAULT_LIMITS)), DEFAULT_LIMITS, 'a checked record is returned as it is');
  assert.deepEqual({ ...unwrap(parseLimits({})) }, { ...DEFAULT_LIMITS });
  assert.deepEqual({ ...unwrap(parseLimits(null)) }, { ...DEFAULT_LIMITS });
  assert.deepEqual({ ...unwrap(parseLimits({ maxRefs: undefined })) }, { ...DEFAULT_LIMITS });
  assert.deepEqual({ ...unwrap(parseLimits({ maxRefs: 3, other: -1 })) }, { ...DEFAULT_LIMITS, maxRefs: 3 });
  assert.equal(Object.isFrozen(unwrap(parseLimits({ maxRefs: 3 }))), true);
  assert.deepEqual(shape(parseLimits({ maxRefs: null })), bad('maxRefs', null));
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    for (const v of [-1, Number.NaN, Infinity, '5', null]) {
      assert.deepEqual(shape(parseLimits({ [key]: v })), bad(key, v), key);
    }
    // 0 on every key at once: a record with maxInflatedTotal 0 may set any key to 0 (maxResolveWork >= maxInflatedTotal)
    assert.equal(unwrap(parseLimits({ maxInflatedTotal: 0, [key]: 0 }))[key], 0, key);
  }
  // left out, maxResolveWork is derived: by hand, 8 x maxInflatedTotal (256 MiB by default, 1 MiB given) = 2,147,483,648 and 8,388,608
  assert.equal(unwrap(parseLimits({})).maxResolveWork, 2_147_483_648);
  assert.equal(unwrap(parseLimits({ maxInflatedTotal: 1_048_576 })).maxResolveWork, 8_388_608);
  // the refusal names maxResolveWork and quotes the bound it fell under (the README Limits contract)
  const below = (got, total) => ({ ok: false, error: { code: 'bad_request', message: `limits.maxResolveWork must be at least limits.maxInflatedTotal (${total})`, what: 'maxResolveWork', got } });
  // #271: maxResolveWork below the record's own maxInflatedTotal bounds nothing the resolver would keep; refused, not raised
  for (const x of [1_048_576, 268_435_456]) {
    assert.deepEqual(shape(parseLimits({ maxInflatedTotal: x, maxResolveWork: x - 1 })), below(x - 1, x));
    assert.equal(unwrap(parseLimits({ maxInflatedTotal: x, maxResolveWork: x })).maxResolveWork, x);
  }
  // against the default maxInflatedTotal (256 MiB) when the record leaves it out, and against a spread preset's
  assert.deepEqual(shape(parseLimits({ maxResolveWork: 1 })), below(1, 268_435_456));
  assert.deepEqual(shape(parseLimits({ ...WORKER_LIMITS, maxInflatedTotal: 1_073_741_824 })), below(536_870_912, 1_073_741_824));
  // the first bad key in DEFAULT_LIMITS order is the refusal, whatever order the caller wrote
  const keys = Object.keys(DEFAULT_LIMITS);
  assert.equal(parseLimits({ [keys.at(-1)]: -1, [keys[0]]: -1 }).error.what, keys[0]);
  // the brand is the parser's: a spread (or a hand-built total record) is a plain record again, parsed afresh
  const checked = unwrap(parseLimits({ maxRefs: 3 }));
  assert.equal(unwrap(parseLimits(checked)), checked);
  const spread = { ...checked, maxRefs: -1 };
  assert.deepEqual(shape(parseLimits(spread)), bad('maxRefs', -1));
  assert.notEqual(unwrap(parseLimits({ ...checked })), checked);
  assert.deepEqual(Object.keys(checked), keys, 'the brand is not an enumerable key');
  // lowered: one bound, never raised, never below zero, still checked
  const low = lowered(checked, 'maxRefs', 2);
  assert.deepEqual([low.maxRefs, lowered(checked, 'maxRefs', 9).maxRefs, lowered(checked, 'maxRefs', -5).maxRefs, low.maxObjectSize], [2, 3, 0, DEFAULT_LIMITS.maxObjectSize]);
  assert.equal(unwrap(parseLimits(low)), low);
  // limitsOf: an entry's options; left out or null is the defaults
  assert.equal(unwrap(limitsOf({})), DEFAULT_LIMITS);
  assert.deepEqual({ ...unwrap(limitsOf({ limits: null })) }, { ...DEFAULT_LIMITS });
  assert.equal(unwrap(limitsOf({ limits: WORKER_LIMITS })), WORKER_LIMITS);
  assert.deepEqual(shape(limitsOf({ limits: { maxRefs: -2 } })), bad('maxRefs', -2));
  const x = limitExceeded('refs', 11, 10);
  assert.deepEqual({ code: x.code, message: x.message, what: x.what, got: x.got, max: x.max }, { code: 'limit_exceeded', message: 'refs 11 exceeds limit 10', what: 'refs', got: 11, max: 10 });
  assert.equal(limitError, limitExceeded);
});
