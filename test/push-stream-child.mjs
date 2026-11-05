// One streamed push of an L-byte random blob (test/push-stream.test.js), under --expose-gc. The peak is sampled after
// a full GC every 50 ms, so it is live memory, not garbage the collector has not reached yet. Prints one JSON line.
//   node --expose-gc --import ./test/ts-resolve.mjs test/push-stream-child.mjs <url> <L>
import { randomFillSync } from 'node:crypto';
import { createTransport } from '../src/http.js';
import { push, ZERO_OID } from '../src/push.js';
import { hashObject, encodeTree, encodeCommit, TYPE } from '../src/objects.js';
import { withLimits } from '../src/limits.js';
import { unwrap } from './unwrap.js';

const [url, size] = process.argv.slice(2);
const L = Number(size);
const blob = new Uint8Array(L);
for (let i = 0; i < L; i += 65536) randomFillSync(blob, i, Math.min(65536, L - i));
const tree = unwrap(encodeTree([{ mode: '100644', name: 'big.bin', oid: hashObject('blob', blob) }]));
const commit = unwrap(encodeCommit({ tree: hashObject('tree', tree), author: 'a <a@x> 1700000000 +0000', message: 'm\n' }));
const oid = hashObject('commit', commit);
const t = unwrap(createTransport(url, { limits: withLimits({ maxPackBytes: 4 * L }) }));
globalThis.gc(); globalThis.gc();
const base = process.memoryUsage();
let peak = base.arrayBuffers, rss = base.rss;
const timer = setInterval(() => { globalThis.gc(); const m = process.memoryUsage(); peak = Math.max(peak, m.arrayBuffers); rss = Math.max(rss, m.rss); }, 50);
const r = await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: oid, objects: [{ type: TYPE.BLOB, data: blob }, { type: TYPE.TREE, data: tree }, { type: TYPE.COMMIT, data: commit }] });
clearInterval(timer);
process.stdout.write(`${JSON.stringify({ ok: r.ok, error: r.ok ? null : r.error.message, commit: oid, packBytes: r.ok ? r.value.packBytes : null, liveDelta: peak - base.arrayBuffers, rssDelta: rss - base.rss })}\n`);
