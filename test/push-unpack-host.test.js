// #246: a host's own unpack failure. Cloudflare Artifacts answers a pack it cannot unpack with "unpack <reason>" and then
// "ng <ref> <reason>" for every commanded ref, the same reason echoed (observed 2026-11-10 on prod: "invalid pack entry
// type 0", "invalid zlib member", "pack stream incomplete at finish", "invalid pack signature"; plain and side-band;
// one and two refs, atomic or not). That shape is a definite rejection (push_rejected, nothing moved), not ambiguous.
// Every other non-git unpack status stays ambiguous (SPACE.md judgment 3): no ref lines, a ref line that does not echo
// the status, or an "ok" beside it. A delete-only push answered with any unpack failure stays ambiguous (no pack sent).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyReport, decideOutcome, push, ZERO_OID } from '../src/push.js';
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
