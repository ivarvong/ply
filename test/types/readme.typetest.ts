// GENERATED from README.md "Quick start" by test/e2e-customer.test.js (UPDATE_README_TYPETEST=1 rewrites it).
// The README blocks as a TypeScript consumer writes them, plain strings for refs and paths: `npm run typecheck` compiles
// it. tsconfig.isolated.json excludes it (it imports the JS entry, src/index.js).

// ---- setup ----
const url = 'https://git.example.com/acme/site.git';  // an existing repository, empty or not
const opts = { auth: { token: process.env['GIT_TOKEN'] } };  // add tracer: new Tracer({ exporter }) to export spans
const author = { name: 'Release Bot', email: 'bot@example.com' };  // time defaults to now, tz to +0000
const outDir = './site-checkout';  // checkoutDir writes here; it must be absent or empty

// ---- first-commit ----
import { pushTree } from '../../src/index.js';

const first = await pushTree(url, {
  ref: 'refs/heads/main',
  files: {
    'README.md': '# site\n',
    'src/config.ts': 'export const VERSION = "1.2.3";\n',
    'bin/build': { data: '#!/bin/sh\necho build\n', mode: '100755' },
  },
  author, message: 'Initial commit',
}, opts);
if (!first.ok) throw first.error;
console.log(first.value.newCommit);  // the commit id main now points at

// ---- read ----
import { readCommit, listTree, readFile } from '../../src/index.js';

const head = await readCommit(url, { ref: 'main' }, opts);
if (!head.ok) throw head.error;
if ('empty' in head.value) throw new Error('main has no commits yet');
console.log(head.value.oid, head.value.tree, head.value.parents, head.value.message);

const listing = await listTree(url, { ref: 'main', path: 'src' }, opts);
if (!listing.ok) throw listing.error;
for (const e of listing.value.entries) console.log(e.mode, e.type, e.oid, e.name);  // as git ls-tree prints them

const file = await readFile(url, { ref: 'main', path: 'src/config.ts' }, opts);
if (!file.ok) throw file.error;
const config = await new Response(file.value.stream).text();  // read the stream to the end (or cancel it)
console.log(file.value.size, config);

// ---- edit ----
import { editFile } from '../../src/index.js';

const bump = await editFile(url, {
  ref: 'refs/heads/main', path: 'src/config.ts',
  find: 'VERSION = "1.2.3"', replace: 'VERSION = "1.2.4"',
  author, message: 'Bump version to 1.2.4',
}, opts);
if (!bump.ok) throw bump.error;  // match_count when find is not there exactly once
console.log(bump.value.newCommit, bump.value.noop);  // noop: find === replace, nothing pushed

// ---- commit-changes ----
import { commitChanges } from '../../src/index.js';

const change = await commitChanges(url, {
  ref: 'refs/heads/main',
  changes: [
    { kind: 'create', path: 'docs/intro.md', content: '# Intro\n' },  // refuses a path that exists
    { kind: 'write', path: 'README.md', content: '# site\n\nHello.\n' },  // creates or overwrites
    { kind: 'edit', path: 'src/config.ts', find: '1.2.4', replace: '1.3.0' },  // exactly one match
    { kind: 'delete', path: 'bin/build' },  // a file or a whole directory
    { kind: 'rename', from: 'docs/intro.md', to: 'docs/index.md' },
  ],
  author, message: 'Docs; version 1.3.0',
}, opts);
if (!change.ok) throw change.error;
console.log(change.value.outcome, change.value.oid);  // 'commit', or 'noop' when the tree did not change

// ---- branch-merge ----
import { createBranch, mergeBranch } from '../../src/index.js';

const feature = await createBranch(url, { ref: 'refs/heads/feature', from: 'main' }, opts);
if (!feature.ok) throw feature.error;  // cas_conflict when the branch already exists

const work = await commitChanges(url, {
  ref: 'refs/heads/feature',
  changes: [{ kind: 'create', path: 'src/feature.ts', content: 'export const feature = true;\n' }],
  author, message: 'Add feature flag',
}, opts);
if (!work.ok) throw work.error;

const hotfix = await editFile(url, {  // main moves on meanwhile
  ref: 'refs/heads/main', path: 'README.md', find: 'Hello.', replace: 'Hello, world.', author, message: 'Fix greeting',
}, opts);
if (!hotfix.ok) throw hotfix.error;

const merged = await mergeBranch(url, { ref: 'refs/heads/main', from: 'refs/heads/feature', author }, opts);
if (!merged.ok) throw merged.error;
console.log(merged.value.outcome, merged.value.oid);  // 'merge': a commit with parents [main, feature]

// ---- tag ----
import { createTag } from '../../src/index.js';

const release = await createTag(url, { name: 'v1.3.0', target: 'refs/heads/main' }, opts);
if (!release.ok) throw release.error;
const notes = await createTag(url, { name: 'v1.3.0-notes', target: release.value.commit, message: 'Release 1.3.0', tagger: author }, opts);
if (!notes.ok) throw notes.error;
console.log(notes.value.oid, notes.value.commit);  // the tag object, and the commit it names

// ---- rebase-pick-revert ----
import { rebaseBranch, cherryPick, revertCommit } from '../../src/index.js';

const topic = await createBranch(url, { ref: 'refs/heads/topic', from: 'refs/heads/main' }, opts);
if (!topic.ok) throw topic.error;
const onTopic = await commitChanges(url, { ref: 'refs/heads/topic', changes: [{ kind: 'create', path: 'src/topic.ts', content: 'export const topic = 1;\n' }], author, message: 'Add topic' }, opts);
if (!onTopic.ok) throw onTopic.error;
const onMain = await commitChanges(url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'CHANGELOG.md', content: '1.3.0\n' }], author, message: 'Changelog' }, opts);
if (!onMain.ok) throw onMain.error;

const rebased = await rebaseBranch(url, { ref: 'refs/heads/topic', onto: 'refs/heads/main', committer: author }, opts);
if (!rebased.ok) throw rebased.error;  // topic's commits replayed onto main's tip

const picked = await cherryPick(url, { ref: 'refs/heads/main', commit: rebased.value.oid, committer: author }, opts);
if (!picked.ok) throw picked.error;  // outcome 'ok', or 'empty' when main already has the change (nothing written)

const reverted = await revertCommit(url, { ref: 'refs/heads/main', commit: picked.value.oid, committer: author }, opts);
if (!reverted.ok) throw reverted.error;  // a 'Revert "Add topic"' commit on main

// ---- history ----
import { readLog } from '../../src/index.js';

const log = await readLog(url, { ref: 'refs/heads/main', limit: 10 }, opts);
if (!log.ok) throw log.error;
for (const c of log.value.commits) console.log(c.oid.slice(0, 7), c.parents.length, c.message.split('\n')[0]);

// ---- checkout ----
import { checkoutTree } from '../../src/index.js';
import { checkoutDir } from '../../src/checkout-node.js';

const tree = await checkoutTree(url, { ref: 'v1.3.0' }, opts);
if (!tree.ok) throw tree.error;
for await (const f of tree.value.files) {
  if (f.stream) console.log(f.path, f.mode, (await new Response(f.stream).arrayBuffer()).byteLength);  // read each stream
}

const written = await checkoutDir(url, { dir: outDir, ref: 'main' }, opts);
if (!written.ok) throw written.error;
console.log(written.value.written.files);  // files written under outDir

// ---- refs ----
import { listRefs, deleteBranch, deleteTag } from '../../src/index.js';

const refs = await listRefs(url, {}, opts);  // branches and tags; { prefixes: ['refs/heads/'] } for branches only
if (!refs.ok) throw refs.error;
console.log(refs.value.head, refs.value.refs.map(r => r.name));  // 'refs/heads/main', [ 'refs/heads/feature', … ]

const gone = await deleteBranch(url, { ref: 'refs/heads/feature', expected: work.value.oid }, opts);
if (!gone.ok) throw gone.error;  // cas_conflict when feature moved off that commit; not_found when it is gone
const untagged = await deleteTag(url, { name: 'v1.3.0-notes' }, opts);
if (!untagged.ok) throw untagged.error;

// ---- errors ----
import { assertNever } from '../../src/index.js';

const stale = await editFile(url, {
  ref: 'refs/heads/main', path: 'src/config.ts', find: 'VERSION = "9.9.9"', replace: 'VERSION = "10.0.0"', author, message: 'Bump',
}, opts);
if (!stale.ok) {
  const e = stale.error;
  switch (e.code) {
    case 'cas_conflict':  // the ref moved between read and push (editFile already redid it once): read again, redo
      console.warn('moved', e.expected, e.actual); break;
    case 'match_count':  // find matched e.matches times, not once: the file is not what you expected
      console.warn('matches', e.matches); break;
    case 'not_found':  // e.miss.kind: 'ref' | 'path' | 'repository' | 'head_unborn' | 'commit' | …
      console.warn('missing', e.miss.kind); break;
    case 'auth':  // 401/403: the credential is missing, wrong, or lacks write access
      console.warn('auth'); break;
    case 'limit_exceeded':  // a limits.* bound (e.what, e.got, e.max): raise it with withLimits, or do less per call
      console.warn('limit', e.what, e.got, e.max); break;
    case 'ambiguous':  // the push was sent and may have landed: read the ref back before doing anything else
      console.warn('unknown outcome'); break;
    case 'network': case 'timeout': case 'rate_limited': case 'upstream_5xx': case 'protocol': case 'pack_corrupt':
      console.warn('transient: retry with backoff', e.code); break;  // isRetryable(e) is true for exactly these
    case 'merge_conflict': case 'not_fast_forward': case 'not_linear': case 'unrelated_histories':
      console.warn('history needs a human', e.code); break;
    case 'push_rejected': case 'push_partial': case 'remote_error':  // a hook, branch protection, or the server said no
      console.warn('refused', e.message); break;
    case 'bad_request': case 'unsupported': case 'lfs_pointer': case 'http': case 'not_git': case 'aborted': case 'internal':
      console.warn('fix the call or the setup', e.code, e.message); break;
    default:
      assertNever(e);
  }
}
