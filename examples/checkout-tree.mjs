// Check a ref out of a git smart-HTTP remote into a directory, with no git binary: ply's checkoutDir.
// usage: node examples/checkout-tree.mjs <remote-url> <dir> [--ref main]
// env:   PLY_TOKEN (Basic, user PLY_USER or x-access-token) or PLY_BEARER
//
// <dir> must be absent or empty. Laid out as `git clone` lays it out: 100755 executable, 120000 a symlink (never
// followed), a submodule an empty directory. Every blob is hash-checked as it streams; trees come in one blob:none
// fetch and the blobs in one more, so the round trips do not grow with the file count.
import { parseArgs } from 'node:util';
import { CHECKOUT_BATCH, checkoutDir } from 'ply/checkout-node';
import { DEFAULT_LIMITS, Tracer } from 'ply';

const { positionals: [url, dir], values } = parseArgs({ allowPositionals: true, options: { ref: { type: 'string' } } });
if (!url || !dir) { console.error('usage: node examples/checkout-tree.mjs <remote-url> <dir> [--ref main]'); process.exit(2); }

const env = process.env;
const token = env.PLY_TOKEN;
const bearer = env.PLY_BEARER;
const user = env.PLY_USER;
const auth = typeof token === 'string' && token !== ''
  ? (typeof user === 'string' && user !== '' ? { token, user } : { token })
  : (typeof bearer === 'string' && bearer !== '' ? { bearer } : null);

const ref = typeof values.ref === 'string' ? values.ref : null;
const checked = await checkoutDir(url, { dir, ref, path: '' }, {
  auth,
  tracer: new Tracer(),
  parent: null,
  fetchImpl: null,
  limits: DEFAULT_LIMITS,
  signal: null,
  quirks: null,
  transport: null,
  batch: CHECKOUT_BATCH,
  platform: process.platform,
});
if (!checked.ok) { console.error(checked.error.message); process.exit(1); }
const r = checked.value;
const w = r.written;
console.log(`${r.ref} @ ${r.commit} -> ${dir}`);
console.log(`  wrote ${w.files} files (${w.bytes} bytes), ${w.symlinks} symlinks, ${w.gitlinks} submodule dirs`);
