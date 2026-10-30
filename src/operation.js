// What every operation (edit, merge, rebase, pick) has in common, written once: a root span named `git.<op>` with the
// operation's attributes, a transport (built for the url, or the caller's — re-parented under the root for its spans),
// the outcome attribute on success or failure, and the one rule about confirmation: after a push is acknowledged, any
// failure to read the ref back as expected is `ambiguous`.
//
//   operation('merge', url, opts, async ({ t, root, outcome }) => { …; return outcome('merge', result, attrs); })
//
// The body returns via `outcome(name, result, attrs)`, which stamps `git.<op>.outcome` and ends the span. Thrown errors
// stamp the error's code as the outcome and are rethrown with `e.span = root` so a caller can link a retry to it.
import { createTransport, redactUrl } from './http.js';
import { withParent } from './transport.js';
import { lsRefs } from './lsrefs.js';
import { fail } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';

export async function operation(op, url, { auth, tracer, parent = null, fetchImpl, limits = DEFAULT_LIMITS, signal = null, quirks, transport = null, attrs = {}, link = null, onFinish = null }, body) {
  const name = `git.${op}`;
  const root = tracer.start(name, { parent, attrs: { [`${name}.url`]: transport?.url ?? redactUrl(url), ...attrs } });
  if (link) root.link(link.span, { 'ply.link': link.kind });
  const t = transport ? withParent(transport, root) : createTransport(url, { auth, tracer, parent: root, fetchImpl, limits, signal, quirks });
  // The root and every span under it redact the credential; root.error(e) below scrubs the error the caller gets.
  if (t.scrub) root.scrub = t.scrub;
  const finish = extra => { if (onFinish) root.set(onFinish()); root.set(extra); return root; };
  const outcome = (kind, result, extra = {}) => { finish({ ...extra, [`${name}.outcome`]: kind }).end(); return result; };
  try {
    return await body({ t, root, outcome, limits });
  } catch (e) {
    finish({ [`${name}.outcome`]: e?.code ?? 'error' }).error(e, e?.code).end();
    if (e && typeof e === 'object') e.span = root;
    throw e;
  }
}

// After an acknowledged push: read `ref` back and require `expected`. A transport error here, or any other value, is
// 'ambiguous' — the push may have landed. Records `<prefix>.verify.ref` on `root`.
export async function verifyRef(t, root, prefix, ref, expected) {
  let seen;
  try { seen = (await lsRefs(t, [ref])).refs.get(ref)?.oid; }
  catch (e) { throw fail('ambiguous', `push reported ok but the verification read-back failed: ${e.message}`, { cause: e, original: e.code, expected }); }
  root.set({ [`${prefix}.verify.ref`]: seen ?? '' });
  if (seen !== expected) throw fail('ambiguous', `push reported ok but ${ref} is ${seen ?? 'absent'}, not ${expected}`, { seen: seen ?? null, expected });
  return seen;
}
