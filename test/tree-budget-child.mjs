// One tree, one heap. The parent (test/tree-budget.test.js) builds the bytes; this process parses them
// under whatever --max-old-space-size it was given and prints a single JSON line.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseTree } from '../src/objects.js';

const file = process.argv[2];
const stride = Number(process.argv[3]);
const count = Number(process.argv[4]);
const data = new Uint8Array(readFileSync(file)).subarray(0, stride * count);
const rss = () => Math.round(process.resourceUsage().maxRSS / 1024);
try {
  const entries = parseTree(data);
  const hash = createHash('sha256');
  const mapped = entries.map(e => {
    hash.update(e.name);
    hash.update('\0');
    hash.update(e.oid);
    hash.update('\0');
    return { name: e.name, mode: e.mode, oid: e.oid };
  });
  const first = mapped[0];
  const last = mapped.at(-1);
  process.stdout.write(`${JSON.stringify({
    status: 'ok', n: mapped.length, rss: rss(),
    first, last, digest: hash.digest('hex'),
  })}\n`);
} catch (e) {
  process.stdout.write(`${JSON.stringify({
    status: 'err', code: e.code, message: e.message, got: e.got, max: e.max, what: e.what, rss: rss(),
  })}\n`);
}
