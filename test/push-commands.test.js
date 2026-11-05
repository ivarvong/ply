// Push commands are parsed once at the push edge (#156): planPush turns the caller's plain-string commands into a
// ParsedCommands (Refname refs, Oid oids, at least one) and nothing after it sees a raw string. Every outcome of the
// old checks holds, cell by cell, including the empty list: 'protocol', nothing sent, no span, and every other refusal
// first. PUSH_COMMANDS_SRC=<dir> runs the same cells against another copy of src/ (the parity run in the report).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { withLimits } from '../src/limits.js';
import { checkPushCaps } from '../src/receivecaps.js';
import { unwrap } from './unwrap.js';

const SRC = process.env.PUSH_COMMANDS_SRC ?? '../src';
const { push, planPush } = await import(`${SRC}/push.js`);

const A = 'a'.repeat(40), B = 'b'.repeat(40), Z = '0'.repeat(40);
// a transport double: counts requests and spans, answers nothing (no cell here reaches a request)
const counting = (limits = {}) => {
  const t = { limits: withLimits(limits), parent: null, sentN: 0, spans: 0, tracer: { span: async (_n, _o, fn) => { t.spans++; return fn({ set() {}, event() {}, error() {} }); } }, async *frames() { t.sentN++; } };
  return t;
};
const outcome = async (opts, limits = {}) => {
  const t = counting(limits);
  const r = await push(t, opts);
  return { code: r.ok ? 'ok' : r.error.code, what: r.ok ? null : r.error.what ?? null, sent: t.sentN, spans: t.spans };
};

test('the empty list: protocol, nothing sent, no span; every other refusal first', async () => {
  assert.deepEqual(await outcome({ commands: [] }), { code: 'protocol', what: null, sent: 0, spans: 0 });
  assert.deepEqual(await outcome({ commands: [], atomic: true }), { code: 'bad_request', what: null, sent: 0, spans: 0 });
  assert.deepEqual(await outcome({ commands: [], objects: [{ type: 3, data: new Uint8Array(1), baseIndex: 0 }] }), { code: 'bad_request', what: 'baseIndex', sent: 0, spans: 0 });
  assert.deepEqual(await outcome({ commands: [] }, { maxPackBytes: NaN }), { code: 'bad_request', what: 'maxPackBytes', sent: 0, spans: 0 });
  assert.deepEqual(await outcome({ commands: [] }, { maxReportLines: -1 }), { code: 'bad_request', what: 'maxReportLines', sent: 0, spans: 0 });
  assert.deepEqual(await outcome({ commands: [] }, { maxRefs: 'x' }), { code: 'bad_request', what: 'maxRefs', sent: 0, spans: 0 });
  const checked = unwrap(checkPushCaps(new Set(['push-options']), { pushOptions: ['a\nb'] }));
  assert.deepEqual(await outcome({ commands: [], checked }), { code: 'bad_request', what: 'push option', sent: 0, spans: 0 });
});

test('each command: the ref first (receive-pack\'s rules, deleting or not), then both oids; the first bad command wins', async () => {
  const cells = [
    [{ ref: 'refs/heads/main', oldOid: Z, newOid: A }, 'ok'],
    [{ ref: 'refs/heads/main', oldOid: A, newOid: Z }, 'ok'],
    [{ ref: 'refs/foo', oldOid: A, newOid: Z }, 'ok'], // one level: deletable
    [{ ref: 'refs/foo', oldOid: Z, newOid: A }, 'bad_request:ref'],
    [{ ref: 'refs/@', oldOid: A, newOid: Z }, 'bad_request:ref'],
    [{ ref: 'main', oldOid: Z, newOid: A }, 'bad_request:ref'],
    [{ ref: 'refs/heads/main', oldOid: A.toUpperCase(), newOid: B }, 'bad_request:null'],
    [{ ref: 'refs/heads/main', oldOid: A, newOid: B.slice(1) }, 'bad_request:null'],
    [{ ref: 'refs/heads/a b', oldOid: 'x', newOid: B }, 'bad_request:ref'], // the ref is read first
  ];
  for (const [c, want] of cells) {
    const o = await outcome({ commands: [c], objects: [] });
    const got = o.code === 'bad_request' ? `${o.code}:${o.what}` : o.code === 'ambiguous' ? 'ok' : o.code;
    assert.equal(got, want, JSON.stringify(c));
  }
  const two = await outcome({ commands: [{ ref: 'refs/heads/ok', oldOid: Z, newOid: A }, { ref: 'refs/heads/main', oldOid: 'x', newOid: B }] });
  assert.deepEqual([two.code, two.sent], ['bad_request', 0]);
});

test('the single-ref form: a missing field is refused like a bad one, before anything is sent', async () => {
  assert.deepEqual(await outcome({ oldOid: Z, newOid: A }), { code: 'bad_request', what: 'ref', sent: 0, spans: 0 });
  assert.deepEqual(await outcome({ ref: 'refs/heads/main', newOid: A }), { code: 'bad_request', what: null, sent: 0, spans: 0 });
  assert.deepEqual(await outcome({ ref: 'refs/heads/main', oldOid: Z }), { code: 'bad_request', what: null, sent: 0, spans: 0 });
});

test('the plan carries the parsed commands: the same text, at least one', () => {
  const plan = unwrap(planPush({ commands: [{ ref: 'refs/heads/x', oldOid: Z, newOid: A }, { ref: 'refs/heads/y', oldOid: A, newOid: Z }] }, withLimits()));
  assert.deepEqual(plan.commands.map(c => [c.ref, c.oldOid, c.newOid]), [['refs/heads/x', Z, A], ['refs/heads/y', A, Z]]);
  assert.equal(plan.needPack, true);
  assert.ok(plan.caps.includes('delete-refs'));
  const single = unwrap(planPush({ ref: 'refs/heads/x', oldOid: Z, newOid: A }, withLimits()));
  assert.deepEqual(single.commands.map(c => c.ref), ['refs/heads/x']);
});

// The one difference from the old check, for untyped callers only: the 40-hex pattern read its argument as a string
// (RegExp.test), so an array or a String object holding 40 hex passed and was written as its text. parseOid takes only a
// string. A typed caller cannot pass either (Command's oids are strings). Not run against another src (it differs there).
test('an oid that is not a string is bad_request (the old pattern read [hex] and new String(hex) as their text)', { skip: Boolean(process.env.PUSH_COMMANDS_SRC) }, async () => {
  for (const v of [[A], new String(A), 1, null]) {
    const o = await outcome({ commands: [{ ref: 'refs/heads/main', oldOid: v, newOid: B }] });
    assert.deepEqual([o.code, o.sent], ['bad_request', 0], String(v));
  }
});

test('maxRefs bounds the commands: exactly maxRefs pass planning, one more is limit_exceeded with nothing sent', async () => {
  const cmds = n => Array.from({ length: n }, (_, i) => ({ ref: `refs/heads/b${i}`, oldOid: A, newOid: Z }));
  assert.equal(unwrap(planPush({ commands: cmds(2) }, withLimits({ maxRefs: 2 }))).commands.length, 2);
  const over = await outcome({ commands: cmds(3) }, { maxRefs: 2 });
  assert.deepEqual(over, { code: 'limit_exceeded', what: 'push commands', sent: 0, spans: 0 });
});
