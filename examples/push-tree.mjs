// Push a directory as one commit to a git smart-HTTP remote, with no git binary: ply's pushDir.
// usage: node examples/push-tree.mjs <dir> <remote-url> [--ref main] [--message "..."]
// env:   PLY_TOKEN (Basic, user PLY_USER or x-access-token) or PLY_BEARER; GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL
//
// The tree is exactly <dir> (`.git` skipped; `.gitignore` is not read — pass pushDir a `filter` for that). A new ref is
// created with the zero old-oid; an existing one is updated with its current head as the CAS. The push is thin: blobs
// and trees the previous commit already has are left out, so a repeat with one file changed sends that blob, the trees
// on its path and the commit, and a repeat with nothing changed is a noop (no push at all).
import { parseArgs } from 'node:util';
import { pushDir } from 'ply/tree-node';
import { Tracer } from 'ply';

const { positionals: [dir, url], values } = parseArgs({ allowPositionals: true, options: { ref: { type: 'string', default: 'main' }, message: { type: 'string' } } });
if (!dir || !url) { console.error('usage: node examples/push-tree.mjs <dir> <remote-url> [--ref main] [--message "..."]'); process.exit(2); }

const env = process.env;
const auth = env.PLY_TOKEN ? { token: env.PLY_TOKEN, ...(env.PLY_USER && { user: env.PLY_USER }) } : env.PLY_BEARER ? { bearer: env.PLY_BEARER } : undefined;
const ref = values.ref.startsWith('refs/') ? values.ref : `refs/heads/${values.ref}`;
const author = { name: env.GIT_AUTHOR_NAME ?? 'ply', email: env.GIT_AUTHOR_EMAIL ?? 'ply@localhost' };

const r = await pushDir(url, { dir, ref, author, message: values.message ?? `push ${dir}` }, { auth, tracer: new Tracer() });
const { files, trees, sent, sentBlobs, sentTrees } = r.objects;
console.log(r.noop
  ? `noop: ${ref} already has this tree (${r.newTree}); nothing sent`
  : `${ref}: ${r.oldCommit ?? '(new)'} -> ${r.newCommit}`);
console.log(`  ${files} files, ${trees} trees; sent ${sent} objects (${sentBlobs} blobs, ${sentTrees} trees, 1 commit), ${r.pushBytes} pack bytes`);
