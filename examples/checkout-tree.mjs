// Check a ref out of a git smart-HTTP remote into a directory, with no git binary: ply's checkoutDir.
// usage: node examples/checkout-tree.mjs <remote-url> <dir> [--ref main]
// env:   PLY_TOKEN (Basic, user PLY_USER or x-access-token) or PLY_BEARER
//
// <dir> must be absent or empty. Laid out as `git clone` lays it out: 100755 executable, 120000 a symlink (never
// followed), a submodule an empty directory. Every blob is hash-checked as it streams; trees come in one blob:none
// fetch and the blobs in one more, so the round trips do not grow with the file count.
import { parseArgs } from 'node:util';
import { checkoutDir } from 'ply/checkout-node';
import { Tracer, defaultCapabilities } from 'ply';

const { positionals: [url, dir], values } = parseArgs({ allowPositionals: true, options: { ref: { type: 'string' } } });
if (!url || !dir) { console.error('usage: node examples/checkout-tree.mjs <remote-url> <dir> [--ref main]'); process.exit(2); }

const env = process.env;
const auth = env.PLY_TOKEN ? { token: env.PLY_TOKEN, ...(env.PLY_USER && { user: env.PLY_USER }) } : env.PLY_BEARER ? { bearer: env.PLY_BEARER } : undefined;

const refArg = values.ref;
const ref = typeof refArg === 'string' ? refArg : null;
const r = await checkoutDir(url, { dir, ref }, { auth, capabilities: { ...defaultCapabilities(), tracer: new Tracer() } });
const w = r.written;
console.log(`${r.ref} @ ${r.commit} -> ${dir}`);
console.log(`  wrote ${w.files} files (${w.bytes} bytes), ${w.symlinks} symlinks, ${w.gitlinks} submodule dirs`);
