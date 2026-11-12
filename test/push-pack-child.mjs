// One pushPack of N fresh chunks of C bytes, drained by a fake server (test/push-pack.test.js), under --expose-gc. The
// peak is sampled after a full GC every 50 ms, so it is live memory, not garbage not yet reached. Prints one JSON line.
//   node --expose-gc --import ./test/ts-resolve.mjs test/push-pack-child.mjs <chunk bytes> <chunks>
import { randomFillSync } from 'node:crypto';
import { createTransport } from '../src/http.js';
import { pushPackChecked, ZERO_OID } from '../src/push.js';
import { withLimits } from '../src/limits.js';
import { pkt, FLUSH } from '../src/pktline.js';
import { concat } from '../src/bytes.js';
import { unwrap } from './unwrap.js';

const [c, count] = process.argv.slice(2).map(Number);
const REF = 'refs/heads/main';
const answer = concat([unwrap(pkt('unpack ok\n')), unwrap(pkt(`ok ${REF}\n`)), FLUSH]);
let bytesSeen = 0;
const fetchImpl = async (url, init) => {
  if (!String(url).endsWith('/git-receive-pack')) return new Response('', { status: 200 });
  const reader = init.body.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    bytesSeen += r.value.length;
    // a real server takes time; the bytes are dropped here
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return new Response(answer, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
};
let made = 0;
const pack = new ReadableStream({
  pull(ctl) {
    if (made === count) { ctl.close(); return; }
    made++;
    const b = new Uint8Array(c);
    randomFillSync(b, 0, 64);
    ctl.enqueue(b);
  },
}, { highWaterMark: 0 });
const t = unwrap(createTransport('https://example.invalid/r.git', { fetchImpl, limits: withLimits({ maxPackBytes: c * count }) }));
globalThis.gc(); globalThis.gc();
const base = process.memoryUsage();
let peak = base.arrayBuffers, samples = 0;
const timer = setInterval(() => { globalThis.gc(); samples++; peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 50);
const { result: r } = await pushPackChecked(t, { ref: REF, oldOid: ZERO_OID, newOid: 'a'.repeat(40), pack, length: c * count, sideband: false });
clearInterval(timer);
process.stdout.write(`${JSON.stringify({ ok: r.ok, error: r.ok ? null : r.error.message, packBytes: r.ok ? r.value.packBytes : null, bytesSeen, samples, liveDelta: peak - base.arrayBuffers })}\n`);
