// Push a local repository, with its history, to a git smart-HTTP remote with no git binary: ply's pushRepo.
// usage: node examples/push-repo.mjs <repo-dir> <remote-url> [refspec ...] [--all] [--tags] [--force] [--dry-run] [--thin]
// env:   PLY_TOKEN (Basic, user PLY_USER or x-access-token) or PLY_BEARER
//
// Refspecs are git's: `main`, `src:dst`, `+src:dst` (forced), `:dst` (delete). With none, the current branch goes to
// the same name. ply reads `.git` itself (loose objects, packs, packed refs), asks the remote for its refs, and sends
// one pack with what the remote lacks, delta-compressed. A non-fast-forward is refused before anything is sent, unless
// forced; when every ref is already there, nothing is sent at all.
import { parseArgs } from 'node:util';
import { pushRepo } from 'ply/repo-node';

const { positionals: [dir, url, ...refspecs], values } = parseArgs({
  allowPositionals: true,
  options: { all: { type: 'boolean' }, tags: { type: 'boolean' }, force: { type: 'boolean', short: 'f' }, 'dry-run': { type: 'boolean', short: 'n' }, thin: { type: 'boolean' } },
});
if (!dir || !url) { console.error('usage: node examples/push-repo.mjs <repo-dir> <remote-url> [refspec ...] [--all] [--tags] [--force] [--dry-run] [--thin]'); process.exit(2); }

const env = process.env;
const auth = env.PLY_TOKEN ? { token: env.PLY_TOKEN, ...(env.PLY_USER && { user: env.PLY_USER }) } : env.PLY_BEARER ? { bearer: env.PLY_BEARER } : undefined;
const spec = { refspecs: refspecs.length ? refspecs : null, all: !!values.all, tags: !!values.tags, force: !!values.force, dryRun: !!values['dry-run'], thin: !!values.thin };

const result = await pushRepo(dir, url, spec, { auth });
// pushRepo returns a Result: an Err is a PlyError, whose code says what to do next (README "Errors")
if (!result.ok) { console.error(`${result.error.code}: ${result.error.message}`); process.exit(1); }
const r = result.value;
const short = oid => oid.slice(0, 7);
if (r.upToDate) console.log('Everything up-to-date');
for (const u of r.updates) {
  const what = { create: '[new]', update: `${short(u.oldOid)}..${short(u.newOid)}`, force: `+ ${short(u.oldOid)}...${short(u.newOid)} (forced)`, delete: '[deleted]' }[u.kind];
  console.log(`  ${what} ${u.ref}`);
}
if (!r.upToDate) console.log(`${r.dryRun ? 'dry run, would send' : 'sent'} ${r.objects} objects (${r.deltas + r.thinDeltas} deltas), ${r.packBytes} pack bytes`);
