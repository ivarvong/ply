// #246: a host's own unpack failure. Cloudflare Artifacts answers a pack it cannot unpack with "unpack <reason>" and then
// "ng <ref> <reason>" for every commanded ref, the same reason echoed (observed 2026-11-10 on prod: "invalid pack entry
// type 0", "invalid zlib member", "pack stream incomplete at finish", "invalid pack signature"; plain and side-band;
// one and two refs, atomic or not). That shape is a definite rejection (push_rejected, nothing moved), not ambiguous.
// Every other non-git unpack status stays ambiguous (SPACE.md judgment 3): no ref lines, a ref line that does not echo
// the status, or an "ok" beside it. A delete-only push answered with any unpack failure stays ambiguous (no pack sent).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyReport, decideOutcome, parseReceivePackTooLarge, push, ZERO_OID } from '../src/push.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { pkt, FLUSH } from '../src/pktline.js';
import { concat, te } from '../src/bytes.js';
import { unwrap } from './unwrap.js';

const A = 'refs/heads/a', B = 'refs/heads/b';
const T0 = 'invalid pack entry type 0';
const lines = (...ls) => ls.map(l => (typeof l === 'string' ? te.encode(l) : l));
const cls = (ls, refs = [A]) => classifyReport(lines(...ls), refs.map(ref => ({ ref })));
const ngs = (reason, ...refs) => refs.map(ref => ({ ref, ok: false, reason }));

test('the echoed shape is unpackFailed and decides push_rejected; delete-only stays ambiguous', () => {
  for (const reason of [T0, 'invalid zlib member', 'pack stream incomplete at finish', 'invalid pack signature']) {
    const one = cls([`unpack ${reason}\n`, `ng ${A} ${reason}\n`]);
    assert.deepEqual(one, { tag: 'unpackFailed', status: reason, refs: ngs(reason, A) });
    assert.deepEqual(decideOutcome(one), { tag: 'rejected', code: 'push_rejected', refs: [{ ref: A, reason, cls: 'rejected' }] });
    assert.deepEqual(decideOutcome(one, { atomic: true }).tag, 'rejected');
    assert.deepEqual(decideOutcome(one, { pack: false }), { tag: 'ambiguous', why: 'unpack failed but no pack was sent' });
  }
  // two refs, in either order
  assert.deepEqual(cls([`unpack ${T0}\n`, `ng ${B} ${T0}\n`, `ng ${A} ${T0}\n`], [A, B]), { tag: 'unpackFailed', status: T0, refs: ngs(T0, B, A) });
  // git's own status with the echoed reasons is also an unpack failure
  const git = 'index-pack abnormal exit';
  assert.equal(cls([`unpack ${git}\n`, `ng ${A} ${git}\n`]).tag, 'unpackFailed');
});

test('a host status without the full echo is ambiguous', () => {
  const why = (ls, refs) => { const s = cls(ls, refs); assert.equal(s.tag, 'malformed', JSON.stringify(s)); return s.why; };
  // no ref lines at all, one ref missing, one ref not echoing, an "ok" beside it, git's "unpacker error" beside it
  assert.equal(why([`unpack ${T0}\n`]), 'no git unpack line first');
  assert.equal(why([`unpack ${T0}\n`, `ng ${A} ${T0}\n`], [A, B]), 'no git unpack line first');
  assert.equal(why([`unpack ${T0}\n`, `ng ${A} ${T0}\n`, `ng ${B} stale ref\n`], [A, B]), 'no git unpack line first');
  assert.equal(why([`unpack ${T0}\n`, `ng ${A} ${T0}\n`, `ok ${B}\n`], [A, B]), 'no git unpack line first');
  assert.equal(why([`unpack ${T0}\n`, `ng ${A} unpacker error\n`]), 'no git unpack line first');
  assert.equal(why([`unpack ${T0}\n`, `ok ${A}\n`]), 'no git unpack line first');
  // a reason one byte off the status, and a status one byte off "ok" with ok lines (issue #33)
  assert.equal(why([`unpack ${T0}\n`, `ng ${A} invalid pack entry type 1\n`]), 'no git unpack line first');
  assert.equal(why(['unpack ok*\n', `ok ${A}\n`]), 'no git unpack line first');
  // an unreadable or empty status is never a host's failure
  assert.equal(why([concat([te.encode('unpack '), Uint8Array.of(0xff), te.encode('\n')]), `ng ${A} \udcff\n`]), 'no git unpack line first');
  assert.equal(why(['unpack \n', `ng ${A} x\n`]), 'no git unpack line first');
  // the ref lines are still checked as lines
  assert.equal(why([`unpack ${T0}\n`, `ng refs/heads/zz ${T0}\n`]), 'status for a ref not commanded');
  assert.equal(why([`unpack ${T0}\n`, `ng ${A} ${T0}\n`, `ng ${A} ${T0}\n`]), `two statuses for ${A}`);
  // after "unpack ok" the same reason is an ordinary refusal
  assert.deepEqual(decideOutcome(cls(['unpack ok\n', `ng ${A} ${T0}\n`])), { tag: 'rejected', code: 'push_rejected', refs: [{ ref: A, reason: T0, cls: 'rejected' }] });
});

// through push(): the bytes Artifacts sent on 2026-11-10, side-band and plain. A single-ref update is not read back.
const tracerStub = { span: async (_n, _o, fn) => fn({ set() { return this; }, error() { return this; }, end() {} }) };
const transportOf = (...frames) => {
  const services = [];
  return {
    services,
    t: {
      limits: DEFAULT_LIMITS, tracer: tracerStub, parent: null,
      async *frames(service) { services.push(service); for (const f of frames) yield f === null ? { kind: 'flush' } : { kind: 'data', payload: f }; },
    },
  };
};
const oid = n => n.toString(16).padStart(2, '0').repeat(20);
const update = sideband => ({ commands: [{ ref: A, oldOid: oid(1), newOid: oid(3) }], sideband });
// the band-1 payload Artifacts sent (its outer pkt "005c\x01…" and final flush are the transport's framing)
const inner = concat([unwrap(pkt(`unpack ${T0}\n`)), unwrap(pkt(`ng ${A} ${T0}\n`)), FLUSH]);

test('push(): Artifacts\' side-band and plain reports are push_rejected with the host\'s reason, no read-back', async () => {
  const cases = [
    { sideband: true, frames: [concat([Uint8Array.of(1), inner]), null] },
    { sideband: false, frames: [te.encode(`unpack ${T0}\n`), te.encode(`ng ${A} ${T0}\n`), null] },
  ];
  for (const c of cases) {
    const { t, services } = transportOf(...c.frames);
    const r = await push(t, update(c.sideband));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'push_rejected', r.error.message);
    assert.equal(r.error.message, `push rejected: ${T0}`);
    assert.equal(r.error.report.tag, 'unpackFailed');
    assert.equal(r.error.report.status, T0);
    assert.deepEqual(services, ['git-receive-pack'], 'a definite answer reads nothing back');
  }
});

test('push(): the same failure for a delete-only push is ambiguous', async () => {
  const { t } = transportOf(concat([Uint8Array.of(1), inner]), null);
  const r = await push(t, { commands: [{ ref: A, oldOid: oid(1), newOid: ZERO_OID }], sideband: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ambiguous', r.error.message);
});

// #266: Artifacts refuses a shallow or disconnected push with a shorter ng reason than the unpack status.
const MISSING_UNPACK = 'reachable object is missing';
const MISSING_NG = 'missing object';
const TOO_LARGE = 'artifacts_git_receive_pack_request_too_large: push is 286.3 MiB, limit is 64.0 MiB';

test('Artifacts missing-object alias is unpackFailed and decides push_rejected; a one-byte-off reason stays ambiguous', () => {
  const one = cls([`unpack ${MISSING_UNPACK}\n`, `ng ${A} ${MISSING_NG}\n`]);
  assert.deepEqual(one, { tag: 'unpackFailed', status: MISSING_UNPACK, refs: ngs(MISSING_NG, A) });
  assert.deepEqual(decideOutcome(one), { tag: 'rejected', code: 'push_rejected', refs: [{ ref: A, reason: MISSING_NG, cls: 'rejected' }] });
  assert.deepEqual(decideOutcome(one, { atomic: true }).tag, 'rejected');
  assert.deepEqual(decideOutcome(one, { pack: false }), { tag: 'ambiguous', why: 'unpack failed but no pack was sent' });
  // two refs, both the alias
  assert.deepEqual(cls([`unpack ${MISSING_UNPACK}\n`, `ng ${B} ${MISSING_NG}\n`, `ng ${A} ${MISSING_NG}\n`], [A, B]).tag, 'unpackFailed');
  // a reason that is not the documented alias stays malformed (SPACE.md judgment 3)
  assert.equal(cls([`unpack ${MISSING_UNPACK}\n`, `ng ${A} object is missing\n`]).tag, 'malformed');
  assert.equal(cls([`unpack ${MISSING_UNPACK}\n`, `ng ${A} ${MISSING_UNPACK}\n`]).tag, 'unpackFailed');
});

test('push(): Artifacts missing-object reports are push_rejected, side-band and plain, no read-back', async () => {
  const payload = concat([unwrap(pkt(`unpack ${MISSING_UNPACK}\n`)), unwrap(pkt(`ng ${A} ${MISSING_NG}\n`)), FLUSH]);
  const cases = [
    { sideband: true, frames: [concat([Uint8Array.of(1), payload]), null] },
    { sideband: false, frames: [te.encode(`unpack ${MISSING_UNPACK}\n`), te.encode(`ng ${A} ${MISSING_NG}\n`), null] },
  ];
  for (const c of cases) {
    const { t, services } = transportOf(...c.frames);
    const r = await push(t, update(c.sideband));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'push_rejected', r.error.message);
    assert.equal(r.error.message, `push rejected: ${MISSING_NG}`);
    assert.equal(r.error.report.tag, 'unpackFailed');
    assert.equal(r.error.report.status, MISSING_UNPACK);
    assert.deepEqual(services, ['git-receive-pack'], 'a definite answer reads nothing back');
  }
});

test('Artifacts 64 MiB cap is limit_exceeded with got/max in bytes, not push_rejected or ambiguous', () => {
  const one = cls([`unpack ${TOO_LARGE}\n`, `ng ${A} ${TOO_LARGE}\n`]);
  assert.equal(one.tag, 'unpackFailed');
  const decided = decideOutcome(one);
  assert.deepEqual(decided, { tag: 'rejected', code: 'limit_exceeded', refs: [{ ref: A, reason: TOO_LARGE, cls: 'rejected' }] });
  assert.equal(decideOutcome(one, { pack: false }).tag, 'ambiguous');
});

test('push(): Artifacts too-large report is limit_exceeded with the cap, side-band and plain, no read-back', async () => {
  const payload = concat([unwrap(pkt(`unpack ${TOO_LARGE}\n`)), unwrap(pkt(`ng ${A} ${TOO_LARGE}\n`)), FLUSH]);
  const cases = [
    { sideband: true, frames: [concat([Uint8Array.of(1), payload]), null] },
    { sideband: false, frames: [te.encode(`unpack ${TOO_LARGE}\n`), te.encode(`ng ${A} ${TOO_LARGE}\n`), null] },
  ];
  const wantGot = Math.round(286.3 * 1024 * 1024);
  const wantMax = 64 * 1024 * 1024;
  for (const c of cases) {
    const { t, services } = transportOf(...c.frames);
    const r = await push(t, update(c.sideband));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'limit_exceeded', r.error.message);
    assert.equal(r.error.what, 'receive-pack request');
    assert.equal(r.error.got, wantGot);
    assert.equal(r.error.max, wantMax);
    assert.match(r.error.message, /64\.0 MiB/);
    assert.equal(r.error.report.tag, 'unpackFailed');
    assert.deepEqual(services, ['git-receive-pack'], 'a definite answer reads nothing back');
  }
});

test('an empty receive-pack report stays ambiguous (concurrent same-repo 200 with no unpack/ref lines)', async () => {
  // no frames at all: the body was empty (HTTP 200, no pkt-lines)
  const empty = transportOf();
  const none = await push(empty.t, update(true));
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'ambiguous', none.error.message);
  // a flush before any report line (side-band or plain)
  const flushed = transportOf(null);
  const early = await push(flushed.t, update(true));
  assert.equal(early.ok, false);
  assert.equal(early.error.code, 'ambiguous', early.error.message);
  const plain = transportOf(null);
  const plainEmpty = await push(plain.t, update(false));
  assert.equal(plainEmpty.ok, false);
  assert.equal(plainEmpty.error.code, 'ambiguous');
  // classifyReport of zero lines is still malformed, not a rejection
  assert.deepEqual(decideOutcome(cls([])), { tag: 'ambiguous', why: 'no git unpack line first' });
});

// Review ec337c5 (push/too-large-regex-cubic-redos, hostile/too-large-regex-quadratic): the #266 pattern was
// `[0-9]+[.]?[0-9]*` twice, so a digit run that never reaches " MiB" was split every possible way: quadratic for one
// run (65,000 digits: 2.3 s), cubic for two (2,492 bytes: 12.9 s), on a reason any host writes in one pkt-line.
// Host text is classified in time linear in its length. Proved by ratio, not by a clock threshold: 64 times the input
// may cost at most 300 times the best run (linear is 64; quadratic 4,096; cubic 262,144).
const HEAD = 'artifacts_git_receive_pack_request_too_large: push is ';
const adversarial = [
  ['one digit run, no " MiB"', n => HEAD + '1'.repeat(n)],
  ['two digit runs, a wrong last byte', n => `${HEAD}${'1'.repeat(Math.floor(n / 3))} MiB, limit is ${'1'.repeat(n - Math.floor(n / 3))}X`],
  ['digits and dots', n => `${HEAD}${'1.'.repeat(n / 2)} MiB, limit is 1 MiB`],
];
// ns per call, the best of `rounds` batches (the minimum is the run least disturbed by the machine)
const best = (fn, batch, rounds) => {
  let b = Infinity;
  for (let i = 0; i < rounds; i++) {
    const t0 = process.hrtime.bigint();
    for (let j = 0; j < batch; j++) fn();
    b = Math.min(b, Number(process.hrtime.bigint() - t0) / batch);
  }
  return b;
};
// a call that already takes over a millisecond is timed alone (the pre-fix pattern takes seconds); the verdict is the ratio
const cost = fn => { const probe = best(fn, 1, 1); return probe > 1e6 ? Math.min(probe, best(fn, 1, 2)) : best(fn, 20, 9); };
const SMALL = 1000, BIG = 64000, MAX_RATIO = 300;

test('a host-written reason is classified in linear time: 64,000 adversarial digits cost under 300 times 1,000', { timeout: 120_000 }, () => {
  for (const [name, make] of adversarial) {
    const small = make(SMALL), big = make(BIG);
    assert.equal(parseReceivePackTooLarge(big), null, name);
    const direct = cost(() => parseReceivePackTooLarge(big)) / cost(() => parseReceivePackTooLarge(small));
    assert.ok(direct < MAX_RATIO, `${name}: parseReceivePackTooLarge ${BIG} digits cost ${direct.toFixed(0)}x ${SMALL} digits`);
    // the whole path a report line takes: reportStep's printable check, ngClass, rejectionCode, as ng and as an echoed unpack
    const decide = reason => () => {
      assert.equal(decideOutcome(cls([`unpack ok\n`, `ng ${A} ${reason}\n`])).code, 'push_rejected');
      assert.equal(decideOutcome(cls([`unpack ${reason}\n`, `ng ${A} ${reason}\n`])).code, 'push_rejected');
    };
    const whole = cost(decide(big)) / cost(decide(small));
    assert.ok(whole < MAX_RATIO, `${name}: classifyReport + decideOutcome ${BIG} digits cost ${whole.toFixed(0)}x ${SMALL} digits`);
  }
});

test('parseReceivePackTooLarge: the observed Artifacts text parses to the same bytes; near misses and insane figures do not', () => {
  // By hand, 1 MiB = 1,048,576 bytes: 286.3 MiB = 286 * 1,048,576 + 0.3 * 1,048,576 = 299,892,736 + 314,572.8
  // = 300,207,308.8, rounded 300,207,309; 64.0 MiB = 67,108,864.
  assert.deepEqual(parseReceivePackTooLarge(TOO_LARGE), { got: 300207309, max: 67108864 });
  // whole MiB figures (no fraction): 65 * 1,048,576 = 68,157,440
  assert.deepEqual(parseReceivePackTooLarge(`${HEAD}65 MiB, limit is 64 MiB`), { got: 68157440, max: 67108864 });
  // 0.5 MiB = 524,288; 1.25 MiB = 1,310,720
  assert.deepEqual(parseReceivePackTooLarge(`${HEAD}1.25 MiB, limit is 0.5 MiB`), { got: 1310720, max: 524288 });
  const no = [
    '', HEAD, `${HEAD} MiB, limit is  MiB`, `${HEAD}286.3 MiB, limit is 64.0 MiB `, ` ${TOO_LARGE}`, `${TOO_LARGE}\n`, TOO_LARGE.replace('MiB,', 'GiB,'),
    `${HEAD}286.3 MiB, limit is 64.0`, `${HEAD}.3 MiB, limit is 64.0 MiB`, `${HEAD}286. MiB, limit is 64.0 MiB`, `${HEAD}2.8.6 MiB, limit is 64.0 MiB`,
    `${HEAD}-1 MiB, limit is 64.0 MiB`, `${HEAD}1e3 MiB, limit is 64.0 MiB`, `${HEAD}Infinity MiB, limit is 64.0 MiB`, `${HEAD}0x10 MiB, limit is 64.0 MiB`,
    // a limit of nothing is not a size cap
    `${HEAD}286.3 MiB, limit is 0 MiB`, `${HEAD}286.3 MiB, limit is 0.0 MiB`,
    // more digits than any byte count ply can hold exactly: 10^10 MiB is over 2^53 bytes
    `${HEAD}10000000000 MiB, limit is 64.0 MiB`, `${HEAD}286.3 MiB, limit is ${'9'.repeat(400)} MiB`,
    // 300 leading zeros: more than the 9 integer digits a figure may have
    `${HEAD}${'0'.repeat(300)}286.3 MiB, limit is 64.0 MiB`,
    // the second figure's unit is checked too: the last four characters are ' MiB' and nothing else
    `${HEAD}286.3 MiB, limit is 64.0 GiB`, `${HEAD}286.3 MiB, limit is 64.0 KiB`, `${HEAD}286.3 MiB, limit is 64.0 mib`, `${HEAD}286.3 MiB, limit is 64.0XXXX`,
    `${HEAD}286.3 MiB, limit is 64.0MiB `, `${HEAD}286.3 MiB, limit is 64.0 MiB, limit is 64.0 GiB`,
    // the first 54 characters are the head and nothing else: the same length with one word, one letter or the code changed
    TOO_LARGE.replace('push is', 'pull is'), TOO_LARGE.replace('artifacts_git', 'Artifacts_git'), TOO_LARGE.replace('too_large:', 'too_small:'),
    `${'x'.repeat(HEAD.length)}286.3 MiB, limit is 64.0 MiB`, `${HEAD.slice(1)} 286.3 MiB, limit is 64.0 MiB`,
    // the head and the tail alone, sharing their space or not; no middle; the middle twice
    `${HEAD}MiB`, `${HEAD} MiB`, `${HEAD}5 MiB`, `${HEAD}286.3 MiB`, `${HEAD}286.3 MiB, limit is 64.0 MiB, limit is 64.0 MiB`,
    // 10 integer digits, 7 decimals (9 and 6 are the most a figure has, below)
    `${HEAD}1000000000 MiB, limit is 64.0 MiB`, `${HEAD}286.3 MiB, limit is 1000000000 MiB`, `${HEAD}1.0000001 MiB, limit is 64.0 MiB`, `${HEAD}286.3 MiB, limit is 64.0000000 MiB`,
    // 10 integer digits with decimals, on either side: the 9-digit bound holds for a figure with a '.' as for one without.
    // It is the bound that keeps the byte count exact: 9999999999.5 MiB is 10,485,759,999,475,712 bytes, over 2^53
    // (9,007,199,254,740,992), and 1234567890.5 has the same 10 digits.
    `${HEAD}1234567890.5 MiB, limit is 64.0 MiB`, `${HEAD}286.3 MiB, limit is 1234567890.5 MiB`, `${HEAD}9999999999.5 MiB, limit is 64.0 MiB`, `${HEAD}286.3 MiB, limit is 9999999999.5 MiB`,
    // a figure is digits only, on both sides
    `${HEAD}286.3 MiB, limit is .5 MiB`, `${HEAD}286.3 MiB, limit is 64. MiB`, `${HEAD}286.3 MiB, limit is -64 MiB`, `${HEAD}286.3 MiB, limit is 6 4 MiB`, `${HEAD}286.3 MiB, limit is 64.0a MiB`, `${HEAD}a286.3 MiB, limit is 64.0 MiB`,
    `${HEAD}0 MiB, limit is 64.0 MiB`, `${HEAD}0.0000004 MiB, limit is 64.0 MiB`,
  ];
  // the near misses are near: each of the two-figure ones differs from a parsing reason in the part named above
  assert.equal(TOO_LARGE.replace('push is', 'pull is').length, TOO_LARGE.length);
  assert.equal(HEAD.length, 54);
  for (const reason of no) assert.equal(parseReceivePackTooLarge(reason), null, JSON.stringify(reason.slice(0, 120)));
  // every figure that parses is a safe, positive byte count
  const top = parseReceivePackTooLarge(`${HEAD}999999999.999999 MiB, limit is 999999999.999999 MiB`);
  assert.ok(top !== null && Number.isSafeInteger(top.got) && top.got === top.max && top.got > 0, JSON.stringify(top));
  // By hand: 999,999,999.999999 MiB = 10^9 * 2^20 - 2^20 / 10^6 = 1,048,576,000,000,000 - 1.048576, rounded
  // 1,048,575,999,999,999; the smallest figure, 0.000001 MiB = 1.048576 bytes, rounds to 1; 9 leading digits with
  // zeros: 000000001 MiB = 1,048,576.
  assert.deepEqual(top, { got: 1048575999999999, max: 1048575999999999 });
  assert.deepEqual(parseReceivePackTooLarge(`${HEAD}000000001 MiB, limit is 0.000001 MiB`), { got: 1048576, max: 1 });
});
