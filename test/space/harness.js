// Runs one rendered cell through the real push path: `push()` over a fake transport that frames the response bytes
// exactly as http.js does (pktStep over the body, pktFinish at the end), no network. Returns the outcome as a tagged union.
// PUSH_SPACE_SRC=<dir>: run the space against another copy of src/ (e.g. `git archive main src`) to see where it disagrees
const SRC = process.env.PUSH_SPACE_SRC ?? '../../src';
const { push } = await import(`${SRC}/push.js`);
// atomic and push options reach push() only as capabilities checked against an advertisement that has them (the cells
// are about the response, not the advertisement: test/space/advertisement.test.js is). An older src/ without
// checkPushCaps took them raw.
const { checkPushCaps } = await import(`${SRC}/receivecaps.js`);
import { pktInit, pktStep, pktFinish } from '../../src/pktline.js';
import { withLimits } from '../../src/limits.js';
import { thrown as fail } from '../../src/errors.js';

const spanStub = { set() {}, event() {} };
const tracer = { span: async (_name, _opts, fn) => fn(spanStub) };

export function fakeTransport(response, limits) {
  const t = {
    limits: withLimits(limits), tracer, parent: null, sent: 0,
    async *frames(service, body) {
      t.sent++;
      if (service !== 'git-receive-pack' || !(body instanceof Uint8Array)) throw new Error('harness: bad request');
      if (response.drop) throw fail('network', `connection reset ${response.drop}`);
      const r = pktStep(pktInit(), response.bytes);
      yield* r.frames;
      if (response.end === 'throw') throw fail('network', 'connection reset after the response');
      pktFinish(r.state);
    },
  };
  return t;
}

// rendered: { commands, opts, limits, response } (space.js render). Outcome:
// landed | rejected | partial | ambiguous | preSend (a typed error with nothing sent) | other (anything else: a bug)
export async function runPush(rendered, response = rendered.response) {
  const t = fakeTransport(response ?? { drop: 'never' }, rendered.limits);
  try {
    const { atomic = false, pushOptions = [], ...opts } = rendered.opts ?? {};
    const checked = checkPushCaps && (atomic || pushOptions.length > 0) ? checkPushCaps(new Set(['atomic', 'push-options']), { atomic, pushOptions }).value : undefined;
    await push(t, { commands: rendered.commands, objects: [], ...(checkPushCaps ? { ...opts, ...(checked ? { checked } : {}) } : rendered.opts) });
    return { tag: 'landed', refs: rendered.commands.map(c => c.ref) };
  } catch (e) {
    if (t.sent === 0 && (e.code === 'bad_request' || e.code === 'limit_exceeded')) return { tag: 'preSend', code: e.code, what: e.what };
    if (t.sent === 0) return { tag: 'other', code: e.code, message: `nothing sent: ${e.message}` };
    if (e.code === 'ambiguous') return { tag: 'ambiguous' };
    if (e.code === 'cas_conflict' || e.code === 'push_rejected' || e.code === 'not_fast_forward') return { tag: 'rejected', code: e.code };
    if (e.code === 'push_partial') return { tag: 'partial', landed: e.landed, rejected: e.rejected.map(r => r.ref) };
    return { tag: 'other', code: e.code, message: e.message };
  }
}

export const sameOutcome = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const label = o => (o.tag === 'rejected' || o.tag === 'preSend' || o.tag === 'other' ? `${o.tag}(${o.code})` : o.tag);
