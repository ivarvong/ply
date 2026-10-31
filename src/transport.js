// The transport contract. A transport is a plain record; the protocol layer (lsrefs, fetch, push, discover, receivecaps)
// calls exactly two things on it and never looks inside:
//
//   t.frames(service, body, span, hints)  → AsyncIterable of pkt-line frames of one command's response
//   t.advertise(service, span)            → Uint8Array: the service's capability advertisement (pkt-lines)
//
// plus the data every caller may read: t.kind ('http' | 'ssh'), t.url (credential-free, for spans and messages),
// t.tracer, t.parent (the span wire spans hang under), t.limits, t.signal, and t.scrub: null, or a function that
// redacts the transport's credential from any text (server echoes), applied by every span under it (otel.js). SSH has
// none: publickey auth never sends the server a secret it could echo.
//
// `hints` are transport-neutral requests a transport may honor or ignore: { bypassCache: true } asks an HTTP transport
// with a pack cache in front of it (packcache.js) to go to the origin. Transports record, on the span they are given:
//   git.transport            'http' | 'ssh'
//   git.request.bytes        body bytes sent
//   git.response.bytes       bytes received for this command
//   git.response.first_byte_ms, git.response.duration_ms
//   git.response.cache       'HIT' | 'MISS' | 'BUST' | ''   (HTTP with packcache; '' otherwise)
//   server.address, url.full
// and may add transport-specific detail under http.* / ssh.*. Implementations: http.js, sshgit.js.
import { fail, isPlyCode } from './errors.js';
import { KIND } from './otel.js';

// We are not git and do not claim to be: servers that branch on the agent string get the truth.
export const UA = 'ply/0.1.0';
export const proto = msg => fail('protocol', msg);

export const frames = (t, service, body, span, hints = {}) => t.frames(service, body, span, hints);
export const advertise = (t, service, span) => t.advertise(service, span);

// The same transport, with wire spans parented under `parent` (an operation's root). State is shared with the original:
// the view only shadows `parent`. (A transport's methods must therefore read `parent` from the record they are called on.)
export const withParent = (t, parent) => Object.create(t, { parent: { value: parent, enumerable: true } });

// Span options for a wire round trip under this transport's parent.
// It carries the transport's `scrub` (credential redaction, http.js), so even an unparented wire span exports none.
export const clientSpan = (t, attrs = {}) => ({ parent: t.parent, kind: KIND.CLIENT, attrs, scrub: t.scrub ?? null });

// Give an untyped failure a default code (typed errors keep theirs).
export async function coded(code, fn) { try { return await fn(); } catch (e) { if (!isPlyCode(e?.code)) { try { e.code = code; } catch { e = fail(code, String(e?.message ?? e), { cause: e }); } } throw e; } }

export function wrapNet(e, signal) {
  if (isPlyCode(e?.code)) return e;
  if (signal?.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError') return fail(e?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted', `request aborted: ${e?.message ?? e}`, { cause: e });
  return fail('network', `network: ${e?.message ?? e}`, { cause: e });
}
