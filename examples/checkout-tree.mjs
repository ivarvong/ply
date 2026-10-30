// Check out a ref into a directory using only ply's read API (no git binary, no clone, no object store).
// usage: node examples/checkout-tree.mjs <remote-url> <out-dir> [ref|HEAD] [token]
// Every blob is streamed and hash-checked by ply as it passes; files land with git's mode (100755 → executable).
import { mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { listTree, readFile, readCommit, Tracer, arrayExporter, flattenLine } from '../src/index.js';

const [url, out, ref = 'HEAD', token] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node examples/checkout-tree.mjs <url> <out-dir> [ref] [token]'); process.exit(2); }

const tracer = new Tracer({ exporter: arrayExporter() });
const auth = token ? { user: 'x', token } : undefined;
const quirks = {};
const cache = new Map();                       // tree bytes by oid, shared across every call
const opts = { cache, tracer, auth, quirks };

// resolve once, then address everything by commit oid so no later call pays an ls-refs
const { oid: commit, message } = await readCommit(url, { ref }, opts);
let files = 0, bytes = 0;
async function checkout(path) {
  const { entries } = await listTree(url, { ref: commit, path }, opts);
  mkdirSync(join(out, path), { recursive: true });
  for (const e of entries) {
    const p = path ? `${path}/${e.name}` : e.name;
    if (e.type === 'tree') { await checkout(p); continue; }
    if (e.type === 'commit') { console.error(`skip submodule ${p} @ ${e.oid}`); continue; }
    const f = await readFile(url, { ref: commit, path: p }, opts);
    const data = new Uint8Array(await new Response(f.stream).arrayBuffer());   // the stream errors (never ends) if the bytes are not the blob's
    if (f.mode === '120000') { symlinkSync(new TextDecoder().decode(data), join(out, p)); continue; }
    writeFileSync(join(out, p), data);
    if (f.mode === '100755') chmodSync(join(out, p), 0o755);
    files++; bytes += data.length;
  }
}
await checkout('');
const wire = tracer.exporter.lines.flatMap(flattenLine).filter(s => s.attrs['git.request.bytes'] != null);
console.log(JSON.stringify({ commit, message: message?.split('\n')[0], files, bytes, roundTrips: wire.length, bytesIn: wire.reduce((a, s) => a + (s.attrs['git.response.bytes'] ?? 0), 0) }, null, 2));
