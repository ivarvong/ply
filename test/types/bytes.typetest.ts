// Compile-time checks for the byte-array rule (docs/STACK.md, #100 item 2): every input accepts any `Uint8Array`
// (ArrayBufferLike); a function that allocates returns `Uint8Array<ArrayBuffer>`. A consumer moves bytes between ply
// functions with no casts. `tsc --noEmit` must pass; every @ts-expect-error must still be an error.
import { fetchPack } from '../../src/fetchpack.js';
import { push, type PackObject } from '../../src/push.js';
import { parseRefname } from '../../src/refname.js';
import { spliceDelta, zlibDeflate, buildPack } from '../../src/pack.js';
import { concat, bufferSource } from '../../src/bytes.js';
import { signCommit, withGpgsig, type Signer } from '../../src/sign.js';
import { encodeCommit } from '../../src/objects.js';
import { frames, type Transport } from '../../src/transport.js';
import type { PushTransport } from '../../src/push.js';
import type { Span } from '../../src/otel.js';

declare const t: Transport & PushTransport;
declare const span: Span;
declare const signer: Signer;
// Bytes of unknown backing (a consumer's own buffer, a SharedArrayBuffer view, a Node Buffer slice).
declare const anyBytes: Uint8Array;
declare const shared: Uint8Array<SharedArrayBuffer>;

// fetchPack → push: fetched objects go straight into a push.
const consumerFetchThenPush = async (): Promise<void> => {
  const r = await fetchPack(t, { wants: ['0'.repeat(40)] });
  const objects: PackObject[] = [...(r.objects?.values() ?? [])].map(o => ({ type: o.type, data: o.data }));
  const ref = ((): import('../../src/refname.js').Refname => { const p = parseRefname('refs/heads/x'); if (!p.ok) throw p.error; return p.value; })();
  await push(t, { ref, oldOid: '0'.repeat(40), newOid: '1'.repeat(40), objects });
};
void consumerFetchThenPush;

// spliceDelta → zlibDeflate → buildPack: each output is the next input.
const consumerDeltaThenDeflate = async (): Promise<void> => {
  const { delta } = spliceDelta({ baseLen: 10, off: 2, oldLen: 3, insert: anyBytes });
  const z: Uint8Array<ArrayBuffer> = await zlibDeflate(delta);
  await zlibDeflate(anyBytes);
  await zlibDeflate(shared);
  await buildPack([{ type: 3, data: z }, { type: 3, data: anyBytes }, { type: 3, data: shared }, { type: 7, data: delta, baseOid: '2'.repeat(40) }]);
};
void consumerDeltaThenDeflate;

// Inputs anywhere: signing, the transport's request body, a pushed object.
const consumerInputs = async (): Promise<void> => {
  await signCommit(anyBytes, signer);
  await signCommit(shared, signer);
  void withGpgsig(anyBytes, 'sig');
  for await (const f of frames(t, 'git-upload-pack', anyBytes, span)) void f;
  const ref = ((): import('../../src/refname.js').Refname => { const p = parseRefname('refs/heads/x'); if (!p.ok) throw p.error; return p.value; })();
  await push(t, { ref, oldOid: '0'.repeat(40), newOid: '1'.repeat(40), objects: [{ type: 3, data: shared }] });
};
void consumerInputs;

// Allocating functions return ArrayBuffer-backed bytes, so a consumer can hand them to a BufferSource Web API as is.
const allocated: Array<Uint8Array<ArrayBuffer>> = [
  concat([anyBytes, shared]),
  spliceDelta({ baseLen: 1, off: 0, oldLen: 0, insert: anyBytes }).delta,
  encodeCommit({ tree: '0'.repeat(40), author: 'a <a@b> 0 +0000' }),
  withGpgsig(anyBytes, 'sig'),
  bufferSource(shared),
];
void new Blob(allocated);
// The rule's other half: an input of unknown backing is not ArrayBuffer-backed until bufferSource makes it so.
// @ts-expect-error a SharedArrayBuffer view is not a BufferSource
void new Blob([shared]);
