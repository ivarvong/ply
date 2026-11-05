// A request body as bytes, for a fetch double that reads what was sent. push streams a pack over INFLATE_CHUNK
// (src/packwrite.ts): the body is then a ReadableStream (`duplex: 'half'`), read here once, and the request is forwarded
// with the bytes it held.
export async function readBody(init) {
  const body = init?.body;
  if (body === undefined || body === null) return { bytes: null, init, streamed: false };
  if (typeof body?.getReader !== 'function') return { bytes: Buffer.from(body), init, streamed: false };
  const bytes = Buffer.from(await new Response(body).arrayBuffer());
  const { duplex: _duplex, ...rest } = init;
  return { bytes, init: { ...rest, body: bytes }, streamed: true };
}
