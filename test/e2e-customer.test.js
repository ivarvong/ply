// A new customer's first day, as README.md "Quick start: a repo end to end" writes it: every `// quick-start:` block is
// read from the README and executed as written (imports from 'ply' bound to the package entry, src/index.ts), in order,
// against `git http-backend`, and after every step real git says the repository is what git would have made (rev-parse,
// ls-tree, show, merge-tree, rev-list, cat-file, clone + diff -r, fsck --strict). test/types/readme.typetest.ts is the
// same blocks as TypeScript (generated from the README; this file fails when it drifts: UPDATE_README_TYPETEST=1).
//
// Two server configurations:
//   default  makeBareRepo: uploadpack.allowFilter, allowAnySHA1InWant, protocol.version 2 (the fixture every suite uses)
//   stock    makeBareRepo { stock: true }: upload-pack at git's defaults (no filter, no any-SHA-1 wants), as a
//            `git init --bare` behind `git http-backend` with `http.receivepack true` serves it
// The stock server runs the whole lifecycle on one repository, and again step by step, each step from a copy of the
// default run's repository just before it (with the default run's variables), so each step is judged on its own too.
import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as ply from '../src/index.js';
import * as plyCheckoutNode from '../src/checkout-node.js';
import { git, tmpRoot, makeBareRepo, startGitServer, fsckProblems, commitFiles, initRepo } from './server.js';

const ZERO = '0'.repeat(40);
const README_PATH = new URL('../README.md', import.meta.url);
const TYPETEST_PATH = new URL('./types/readme.typetest.ts', import.meta.url);
const MODULES = { ply, 'ply/checkout-node': plyCheckoutNode };
const TS_SPECIFIER = { ply: '../../src/index.js', 'ply/checkout-node': '../../src/checkout-node.js' };

// ---- the README's quick-start blocks ----
const BLOCK = /```js\n\/\/ quick-start: ([\w-]+)\n([\s\S]*?)```/g;
const IMPORT = /^import \{([^}]+)\} from '([^']+)';\n/gm;
function readmeBlocks(text) {
  return [...text.matchAll(BLOCK)].map(([, step, code]) => {
    const imports = [...code.matchAll(IMPORT)].map(([, names, from]) => ({ names: names.split(',').map(s => s.trim()).filter(Boolean), from }));
    const body = code.replace(IMPORT, '');
    const declared = [...body.matchAll(/^(?:const|let) (\w+)/gm)].map(m => m[1]);
    return { step, code, imports, body, declared };
  });
}
const BLOCKS = readmeBlocks(readFileSync(README_PATH, 'utf8'));
const STEPS = BLOCKS.map(b => b.step).filter(s => s !== 'setup');

// The TypeScript twin: every block in order, its imports pointed at src/. Top-level await, never run (tsc only).
function typetestOf(blocks) {
  const head = '// GENERATED from README.md "Quick start" by test/e2e-customer.test.js (UPDATE_README_TYPETEST=1 rewrites it).\n'
    + '// The README blocks as a TypeScript consumer writes them, plain strings for refs and paths: `npm run typecheck` compiles\n'
    + '// it, under tsconfig.isolated.json too.\n';
  return head + blocks.map(b => `\n// ---- ${b.step} ----\n${b.code.replace(IMPORT, (_, names, from) => `import {${names}} from '${TS_SPECIFIER[from] ?? from}';\n`)}`).join('');
}

// A silent console that keeps what the blocks print.
const quietConsole = () => { const lines = []; const keep = (...a) => { lines.push(a); }; return { lines, log: keep, warn: keep, error: keep, info: keep }; };
const AsyncFunction = (async () => {}).constructor;
// Run one block with `scope` as its free variables (earlier blocks' declarations and imports, the setup values);
// returns the scope plus what the block declared at top level.
async function runBlock(block, scope) {
  const bound = { ...scope };
  for (const { names, from } of block.imports) for (const n of names) bound[n] = MODULES[from][n];
  const names = Object.keys(bound);
  const fn = new AsyncFunction(...names, `${block.body}\nreturn { ${block.declared.join(', ')} };`);
  return { ...bound, ...(await fn(...names.map(n => bound[n]))) };
}

// ---- git as the oracle ----
const rev = (bare, r) => git(bare, ['rev-parse', '--verify', '-q', r]).trim();
const has = (bare, r) => spawnSync('git', ['rev-parse', '--verify', '-q', r], { cwd: bare }).status === 0;
const show = (bare, spec) => git(bare, ['show', spec]);
const files = bare => git(bare, ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n');
const parentsOf = (bare, r) => git(bare, ['rev-list', '--parents', '-n', '1', r]).trim().split(' ').slice(1);
const subject = (bare, r) => git(bare, ['log', '-1', '--format=%s', r]).trim();
const clean = bare => assert.deepEqual(fsckProblems(bare), [], 'git fsck --strict');
// The tree git itself writes for `files` applied to `parent` (a clone, the edits, add -A, write-tree).
function gitTree(bare, parent, apply) {
  const work = `${bare}-work-${Math.random().toString(36).slice(2)}`;
  git(join(bare, '..'), ['clone', '-q', '--no-checkout', bare, work]);
  git(work, ['-c', 'advice.detachedHead=false', 'checkout', '-q', parent]);
  apply(work);
  git(work, ['add', '-A']);
  return git(work, ['write-tree']).trim();
}

// What each step must leave behind, given the scope after it ran.
const CHECKS = {
  'first-commit': (bare, s) => {
    assert.equal(rev(bare, 'refs/heads/main'), s.first.value.newCommit);
    assert.deepEqual(parentsOf(bare, 'main'), [], 'a root commit');
    assert.equal(git(bare, ['ls-tree', 'main', 'bin/build']).split(' ')[0], '100755');
    assert.equal(show(bare, 'main:src/config.ts'), 'export const VERSION = "1.2.3";\n');
    assert.equal(s.first.value.newTree, gitTree(bare, 'main', () => {}), 'tree git writes for the same files');
    clean(bare);
  },
  read: (bare, s) => {
    assert.equal(s.head.value.oid, rev(bare, 'main'));
    assert.equal(s.head.value.tree, rev(bare, 'main^{tree}'));
    assert.equal(s.head.value.message, git(bare, ['cat-file', 'commit', 'main']).split('\n\n').slice(1).join('\n\n'));
    const lsTree = git(bare, ['ls-tree', 'main:src']).trim().split('\n').map(l => { const [meta, name] = l.split('\t'); const [mode, type, oid] = meta.split(' '); return { mode, type, oid, name }; });
    assert.deepEqual(s.listing.value.entries.map(e => ({ mode: e.mode, type: e.type, oid: e.oid, name: e.name })), lsTree);
    assert.equal(s.config, show(bare, 'main:src/config.ts'));
  },
  edit: (bare, s) => {
    assert.equal(rev(bare, 'main'), s.bump.value.newCommit);
    assert.equal(s.bump.value.noop, false);
    assert.deepEqual(parentsOf(bare, 'main'), [s.first.value.newCommit]);
    assert.equal(show(bare, 'main:src/config.ts'), 'export const VERSION = "1.2.4";\n');
    assert.equal(git(bare, ['diff', '--name-only', 'main^', 'main']).trim(), 'src/config.ts');
    assert.equal(subject(bare, 'main'), 'Bump version to 1.2.4');
    clean(bare);
  },
  'commit-changes': (bare, s) => {
    assert.equal(s.change.value.outcome, 'commit');
    assert.equal(rev(bare, 'main'), s.change.value.oid);
    assert.deepEqual(parentsOf(bare, 'main'), [s.bump.value.newCommit]);
    const expected = gitTree(bare, s.bump.value.newCommit, w => {
      mkdirSync(join(w, 'docs'), { recursive: true });
      writeFileSync(join(w, 'docs/index.md'), '# Intro\n');
      writeFileSync(join(w, 'README.md'), '# site\n\nHello.\n');
      writeFileSync(join(w, 'src/config.ts'), 'export const VERSION = "1.3.0";\n');
      git(w, ['rm', '-q', 'bin/build']);
    });
    assert.equal(rev(bare, 'main^{tree}'), expected, 'the tree git writes for the same changes');
    assert.deepEqual(files(bare), ['README.md', 'docs/index.md', 'src/config.ts']);
    clean(bare);
  },
  'branch-merge': (bare, s) => {
    assert.equal(s.feature.value.oid, s.change.value.oid, 'feature created at main');
    assert.equal(rev(bare, 'refs/heads/feature'), s.work.value.oid);
    assert.deepEqual(parentsOf(bare, 'feature'), [s.change.value.oid]);
    assert.equal(s.merged.value.outcome, 'merge');
    assert.equal(rev(bare, 'main'), s.merged.value.oid);
    assert.deepEqual(parentsOf(bare, 'main'), [s.hotfix.value.newCommit, s.work.value.oid]);
    const mergeTree = git(bare, ['merge-tree', '--write-tree', s.hotfix.value.newCommit, s.work.value.oid]).trim().split('\n')[0];
    assert.equal(rev(bare, 'main^{tree}'), mergeTree, 'git merge-tree --write-tree');
    assert.equal(show(bare, 'main:README.md'), '# site\n\nHello, world.\n');
    assert.equal(show(bare, 'main:src/feature.ts'), 'export const feature = true;\n');
    clean(bare);
  },
  tag: (bare, s) => {
    assert.equal(git(bare, ['cat-file', '-t', 'refs/tags/v1.3.0']).trim(), 'commit');
    assert.equal(rev(bare, 'refs/tags/v1.3.0'), rev(bare, 'main'));
    assert.equal(s.release.value.annotated, false);
    assert.equal(git(bare, ['cat-file', '-t', 'refs/tags/v1.3.0-notes']).trim(), 'tag');
    assert.equal(rev(bare, 'refs/tags/v1.3.0-notes'), s.notes.value.oid);
    assert.equal(rev(bare, 'refs/tags/v1.3.0-notes^{commit}'), rev(bare, 'main'));
    const tag = git(bare, ['cat-file', 'tag', 'refs/tags/v1.3.0-notes']);
    assert.match(tag, /^object [0-9a-f]{40}\ntype commit\ntag v1\.3\.0-notes\ntagger Release Bot <bot@example\.com> \d+ \+0000\n\nRelease 1\.3\.0\n$/);
    clean(bare);
  },
  'rebase-pick-revert': (bare, s) => {
    assert.equal(s.rebased.value.outcome, 'rebase');
    assert.equal(rev(bare, 'refs/heads/topic'), s.rebased.value.oid);
    assert.deepEqual(parentsOf(bare, 'topic'), [s.onMain.value.oid], 'topic replayed onto main');
    assert.equal(git(bare, ['diff', '--name-only', 'topic^', 'topic']).trim(), 'src/topic.ts');
    assert.equal(git(bare, ['log', '-1', '--format=%an|%s', 'topic']).trim(), 'Release Bot|Add topic');
    assert.equal(s.picked.value.outcome, 'ok');
    assert.deepEqual(parentsOf(bare, s.picked.value.oid), [s.onMain.value.oid]);
    assert.equal(rev(bare, `${s.picked.value.oid}^{tree}`), rev(bare, 'topic^{tree}'), 'the pick applies the same change');
    assert.equal(s.reverted.value.outcome, 'ok');
    assert.equal(rev(bare, 'main'), s.reverted.value.oid);
    assert.deepEqual(parentsOf(bare, 'main'), [s.picked.value.oid]);
    assert.equal(rev(bare, 'main^{tree}'), rev(bare, `${s.onMain.value.oid}^{tree}`), 'the revert undoes the pick');
    assert.equal(subject(bare, 'main'), 'Revert "Add topic"');
    clean(bare);
  },
  history: (bare, s) => {
    const want = git(bare, ['rev-list', '--first-parent', '-n', '10', 'main']).trim().split('\n');
    assert.deepEqual(s.log.value.commits.map(c => c.oid), want);
    assert.equal(s.log.value.commits[0].message, git(bare, ['cat-file', 'commit', 'main']).split('\n\n').slice(1).join('\n\n'));
  },
  checkout: (bare, s) => {
    assert.equal(s.tree.value.commit, rev(bare, 'v1.3.0^{commit}'));
    assert.deepEqual(s.tree.value.entries.map(e => e.path), git(bare, ['ls-tree', '-r', '--name-only', 'v1.3.0']).trim().split('\n'));
    const clone = `${bare}-clone-${Math.random().toString(36).slice(2)}`;
    git(join(bare, '..'), ['clone', '-q', '-b', 'main', bare, clone]);
    const diff = spawnSync('diff', ['-r', '--no-dereference', '-x', '.git', clone, s.outDir], { encoding: 'utf8' });
    assert.equal(diff.status, 0, `checkoutDir equals git clone: ${diff.stdout}${diff.stderr}`);
    assert.equal(s.written.value.written.files, files(bare).length);
  },
  refs: (bare, s) => {
    // listRefs ran before the two deletes: git's refs now, plus the two it deleted, in git's (byte) order
    const now = git(bare, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/tags/']).trim().split('\n');
    const want = [...now, `refs/heads/feature ${s.gone.value.oid}`, `refs/tags/v1.3.0-notes ${s.untagged.value.oid}`].sort((a, b) => (a < b ? -1 : 1));
    assert.deepEqual(s.refs.value.refs.map(r => `${r.name} ${r.oid}`), want, 'listRefs is for-each-ref, before the deletes');
    assert.equal(s.refs.value.head, git(bare, ['symbolic-ref', 'HEAD']).trim());
    const notes = s.refs.value.refs.find(r => r.name === 'refs/tags/v1.3.0-notes');
    assert.equal(notes.peeled, s.notes.value.commit, 'an annotated tag is peeled to its commit');
    assert.equal(has(bare, 'refs/tags/v1.3.0-notes'), false);
    assert.equal(s.untagged.value.ref, 'refs/tags/v1.3.0-notes');
    assert.equal(has(bare, 'refs/tags/v1.3.0'), true);
    assert.equal(has(bare, 'refs/heads/feature'), false);
    assert.equal(s.gone.value.oid, s.work.value.oid);
    assert.equal(has(bare, 'refs/heads/topic'), true);
    clean(bare);
  },
  errors: (bare, s) => {
    assert.equal(s.stale.ok, false);
    assert.equal(s.stale.error.code, 'match_count');
    assert.equal(s.stale.error.matches, 0);
    assert.deepEqual(s.console.lines.at(-1), ['matches', 0]);
    assert.equal(rev(bare, 'main'), s.reverted.value.oid, 'nothing pushed');
  },
};

let root, cleanup, srv;
let n = 0;
const author = { name: 'Release Bot', email: 'bot@example.com' };
// The setup block's names, bound to this server instead of the README's placeholders.
const setupScope = name => ({ url: `${srv.url}/${name}.git`, opts: {}, author, outDir: join(root, `${name}-out`), console: quietConsole() });

// A repository as the default fixture has it, or with upload-pack at git's defaults.
const defaultRepo = name => makeBareRepo(root, name);
const stockRepo = name => makeBareRepo(root, name, { stock: true });
// A copy of `bare` reconfigured as makeBareRepo's stock: the upload-pack keys unset again.
function stockCopy(bare, name) {
  const dir = join(root, `${name}.git`);
  cpSync(bare, dir, { recursive: true });
  for (const k of ['uploadpack.allowFilter', 'uploadpack.allowAnySHA1InWant', 'protocol.version']) spawnSync('git', ['config', '--unset', k], { cwd: dir });
  const left = spawnSync('git', ['config', '--get-regexp', '^(uploadpack|protocol)\\.'], { cwd: dir, encoding: 'utf8' });
  assert.equal(left.stdout, '', 'stock: no upload-pack or protocol keys');
  return dir;
}

before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
});
after(async () => { await srv?.close(); cleanup?.(); });

describe('README quick start', () => {
  test('the blocks: setup names what the test binds, every import is a real export', () => {
    assert.deepEqual(BLOCKS.map(b => b.step), ['setup', 'first-commit', 'read', 'edit', 'commit-changes', 'branch-merge', 'tag', 'rebase-pick-revert', 'history', 'checkout', 'refs', 'errors']);
    assert.deepEqual(BLOCKS[0].declared, ['url', 'opts', 'author', 'outDir']);
    for (const b of BLOCKS) for (const { names, from } of b.imports) for (const name of names) assert.equal(typeof MODULES[from]?.[name], 'function', `${b.step}: ${name} from '${from}'`);
    for (const step of STEPS) assert.equal(typeof CHECKS[step], 'function', `a git check for ${step}`);
  });
  test('opts.tracer is optional: no tracer works (spans dropped); a value that is not a Tracer is bad_request', async () => {
    defaultRepo('no-tracer');
    const url = `${srv.url}/no-tracer.git`;
    const first = await ply.pushTree(url, { ref: 'refs/heads/main', create: true, files: { 'a.txt': 'a\n' }, author, message: 'first' });
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    const read = await ply.readCommit(url, { ref: 'main' });
    assert.equal(read.ok && 'oid' in read.value ? read.value.oid : null, first.value.newCommit);
    const listed = await ply.listRefs(url);
    assert.deepEqual(listed.ok ? listed.value : listed.error.message, { head: 'refs/heads/main', refs: [{ name: 'refs/heads/main', oid: first.value.newCommit, peeled: null }] });
    for (const r of [await ply.deleteTag(url, { name: '' }), await ply.listRefs(url, { prefixes: [''] }), await ply.listRefs(url, { prefixes: 'refs/' })]) {
      assert.equal(r.ok ? 'ok' : r.error.code, 'bad_request');
    }
    for (const tracer of [{}, 7, 'x']) {
      const r = await ply.readCommit(url, { ref: 'main' }, { tracer });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'bad_request');
      assert.match(r.error.message, /opts\.tracer must be a Tracer/);
    }
  });
  test('#186: the low-level calls work on a transport made without a tracer; parseTag and TYPE_ID are exported', async () => {
    defaultRepo('low-level');
    const url = `${srv.url}/low-level.git`;
    const first = await ply.pushTree(url, { ref: 'refs/heads/main', files: { 'a.txt': 'a\n' }, author, message: 'first' });
    assert.equal(first.ok, true);
    const t = ply.createTransport(url, {});
    assert.equal(t.ok, true);
    const listed = await ply.lsRefs(t.value, ['refs/heads/']);
    assert.equal(listed.ok ? listed.value.refs.get('refs/heads/main').oid : listed.error.message, first.value.newCommit);
    const pushed = await ply.push(t.value, { ref: 'refs/heads/copy', oldOid: ply.ZERO_OID, newOid: first.value.newCommit, objects: [] });
    assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.error.message);
    assert.equal(rev(join(root, 'low-level.git'), 'refs/heads/copy'), first.value.newCommit);
    assert.equal(typeof ply.parseTag, 'function');
    assert.deepEqual([ply.TYPE_ID.commit, ply.TYPE_ID.tree, ply.TYPE_ID.blob, ply.TYPE_ID.tag], [1, 2, 3, 4]);
    const tag = ply.encodeTag({ object: first.value.newCommit, type: 'commit', tag: 'v1', tagger: ply.ident(ply.validateIdent({ ...author, time: 1, tz: '+0000' }).value).value, message: 'm\n' });
    const parsed = ply.parseTag(tag.value);
    assert.equal(parsed.ok ? parsed.value.object : parsed.error.message, first.value.newCommit);
  });
  test('test/types/readme.typetest.ts is the README blocks (UPDATE_README_TYPETEST=1 regenerates it)', () => {
    const want = typetestOf(BLOCKS);
    if (process.env.UPDATE_README_TYPETEST) writeFileSync(TYPETEST_PATH, want);
    assert.equal(existsSync(TYPETEST_PATH) ? readFileSync(TYPETEST_PATH, 'utf8') : '', want);
  });
});

// The default run: one repository through every step. Before each step its state (repository and variables) is kept
// for the stock run.
const before_ = new Map();
describe('lifecycle, default server (allowFilter on)', () => {
  let bare, scope;
  test.each(STEPS)('%s', async step => {
    if (step === STEPS[0]) { bare = defaultRepo('main-default'); scope = setupScope('main-default'); }
    const snap = join(root, `snap-${step}`);
    cpSync(bare, snap, { recursive: true });
    before_.set(step, { snap, scope });
    scope = await runBlock(BLOCKS.find(b => b.step === step), scope);
    CHECKS[step](bare, scope);
  });
});

// Each step on a stock server, from the default run's state just before it.
describe('lifecycle, stock server (upload-pack defaults), step by step', () => {
  for (const step of STEPS) {
    test(step, async () => {
      const from = before_.get(step);
      assert.ok(from, `the default run reached ${step}`);
      const name = `stock-${step}-${n++}`;
      const bare = stockCopy(from.snap, name);
      const scope = { ...from.scope, ...setupScope(name), console: quietConsole() };
      const after_ = await runBlock(BLOCKS.find(b => b.step === step), scope);
      CHECKS[step](bare, after_);
    });
  }
});

// The whole lifecycle on one stock repository.
describe('lifecycle, stock server (upload-pack defaults), continuous', () => {
  let bare, scope;
  test.each(STEPS)('%s', async step => {
    if (step === STEPS[0]) { bare = stockRepo('main-stock'); scope = setupScope('main-stock'); }
    scope = await runBlock(BLOCKS.find(b => b.step === step), scope);
    CHECKS[step](bare, scope);
  });
});

// createBranch / deleteBranch / createTag beyond the happy path, on both servers: git says what the ref is after each.
const opts = () => ({ tracer: new ply.Tracer() });
const errOf = r => { assert.equal(r.ok, false, 'an Err'); return r.error; };
for (const kind of ['default', 'stock']) {
  describe(`ref operations, ${kind} server`, () => {
    let bare, url, c1, c2;
    before(() => {
      const name = `refs-${kind}`;
      bare = kind === 'default' ? defaultRepo(name) : stockRepo(name);
      url = `${srv.url}/${name}.git`;
      const work = join(root, `${name}-seed`);
      initRepo(work);
      c1 = commitFiles(work, bare, { 'a.txt': 'one\n' }, 'one');
      c2 = commitFiles(work, bare, { 'a.txt': 'two\n' }, 'two');
      git(bare, ['tag', '-a', '-m', 'annotated', 'v-ann', c1]);
    });

    test('createBranch from a branch name, a short name, a peeled annotated tag', async () => {
      for (const [ref, from, want] of [['refs/heads/b-full', 'refs/heads/main', () => c2], ['refs/heads/b-short', 'main', () => c2], ['refs/heads/b-tag', 'v-ann', () => c1]]) {
        const r = await ply.createBranch(url, { ref, from }, { ...opts(), verify: true });
        assert.ok(r.ok, `${ref}: ${r.ok || r.error.message}`);
        assert.equal(r.value.oid, want());
        assert.equal(rev(bare, ref), want());
        assert.equal(r.value.pushBytes > 0, true, 'an empty pack, still framed');
      }
      clean(bare);
    });
    test('createBranch from a 40-hex commit id that is not a tip', async () => {
      const r = await ply.createBranch(url, { ref: 'refs/heads/b-oid', from: c1 }, opts());
      assert.ok(r.ok, r.ok || r.error.message);
      assert.equal(rev(bare, 'refs/heads/b-oid'), c1);
    });
    test('createBranch refuses: an existing branch (cas_conflict, actual its tip), a missing from, a bad ref, the zero id', async () => {
      const exists = errOf(await ply.createBranch(url, { ref: 'refs/heads/main', from: c1 }, opts()));
      assert.equal(exists.code, 'cas_conflict');
      assert.equal(exists.expected, ZERO);
      assert.equal(exists.actual, c2);
      assert.equal(rev(bare, 'main'), c2, 'untouched');
      const missing = errOf(await ply.createBranch(url, { ref: 'refs/heads/x', from: 'refs/heads/nope' }, opts()));
      assert.equal(missing.code, 'not_found');
      assert.equal(missing.miss.kind, 'ref');
      assert.equal(errOf(await ply.createBranch(url, { ref: 'heads/x', from: 'main' }, opts())).code, 'bad_request');
      assert.equal(errOf(await ply.createBranch(url, { ref: 'refs/heads/x', from: '' }, opts())).code, 'bad_request');
      assert.equal(errOf(await ply.createBranch(url, { ref: 'refs/heads/x', from: ZERO }, opts())).code, 'bad_request');
      assert.equal(has(bare, 'refs/heads/x'), false);
    });
    test('createBranch and createTag lose a race to a ref made between ls-refs and receive-pack: cas_conflict naming the winner', async () => {
      const racing = ref => async (input, init) => {
        if (String(input).endsWith('/git-receive-pack')) git(bare, ['update-ref', ref, c1]);
        return fetch(input, init);
      };
      const branch = errOf(await ply.createBranch(url, { ref: 'refs/heads/race', from: 'main' }, { ...opts(), fetchImpl: racing('refs/heads/race') }));
      assert.equal(branch.code, 'cas_conflict', branch.message);
      assert.equal(branch.expected, ZERO);
      assert.equal(branch.actual, c1);
      const tag = errOf(await ply.createTag(url, { name: 'race', target: 'main' }, { ...opts(), fetchImpl: racing('refs/tags/race') }));
      assert.equal(tag.code, 'cas_conflict', tag.message);
      assert.equal(tag.actual, c1);
      assert.equal(rev(bare, 'refs/heads/race'), c1);
      clean(bare);
    });
    test('deleteBranch: stale expected (cas_conflict, nothing sent), absent (not_found), HEAD\'s branch (the server\'s push_rejected), then a delete', async () => {
      git(bare, ['update-ref', 'refs/heads/gone', c2]);
      const stale = errOf(await ply.deleteBranch(url, { ref: 'refs/heads/gone', expected: c1 }, opts()));
      assert.equal(stale.code, 'cas_conflict');
      assert.equal(stale.expected, c1);
      assert.equal(stale.actual, c2);
      assert.equal(rev(bare, 'refs/heads/gone'), c2);
      assert.equal(errOf(await ply.deleteBranch(url, { ref: 'refs/heads/gone', expected: 'abc' }, opts())).code, 'bad_request');
      const head = errOf(await ply.deleteBranch(url, { ref: 'refs/heads/main' }, opts()));
      assert.equal(head.code, 'push_rejected');
      assert.match(head.message, /current branch/);
      assert.equal(rev(bare, 'main'), c2);
      const r = await ply.deleteBranch(url, { ref: 'refs/heads/gone', expected: c2 }, opts());
      assert.ok(r.ok, r.ok || r.error.message);
      assert.equal(r.value.oid, c2);
      assert.equal(has(bare, 'refs/heads/gone'), false);
      const absent = errOf(await ply.deleteBranch(url, { ref: 'refs/heads/gone' }, opts()));
      assert.equal(absent.code, 'not_found');
      assert.equal(absent.miss.kind, 'ref');
      clean(bare);
    });
    test('#116: deleteBranch loses a race between ls-refs and receive-pack: cas_conflict naming the winner\'s tip, or null when it was deleted', async () => {
      const racing = (...args) => async (input, init) => {
        if (String(input).endsWith('/git-receive-pack')) git(bare, args);
        return fetch(input, init);
      };
      git(bare, ['update-ref', 'refs/heads/del-race', c2]);
      const moved = errOf(await ply.deleteBranch(url, { ref: 'refs/heads/del-race' }, { ...opts(), fetchImpl: racing('update-ref', 'refs/heads/del-race', c1) }));
      assert.equal(moved.code, 'cas_conflict', moved.message);
      assert.equal(moved.expected, c2, 'the tip ls-refs reported');
      assert.equal(moved.actual, c1, 'the tip the winner left, read back');
      assert.equal(rev(bare, 'refs/heads/del-race'), c1, 'untouched');
      const gone = errOf(await ply.deleteBranch(url, { ref: 'refs/heads/del-race' }, { ...opts(), fetchImpl: racing('update-ref', '-d', 'refs/heads/del-race') }));
      assert.equal(gone.code, 'cas_conflict', gone.message);
      assert.equal(gone.expected, c1);
      assert.equal(gone.actual, null, 'deleted by the winner: absent');
      assert.equal(has(bare, 'refs/heads/del-race'), false);
      clean(bare);
    });
    test('createTag: lightweight and annotated (as git tag -a writes it), refusals', async () => {
      const light = await ply.createTag(url, { name: 'refs/tags/l1', target: 'main' }, { ...opts(), verify: true });
      assert.ok(light.ok, light.ok || light.error.message);
      assert.equal(git(bare, ['cat-file', '-t', 'refs/tags/l1']).trim(), 'commit');
      assert.equal(rev(bare, 'refs/tags/l1'), c2);
      const tagger = { name: 'T', email: 't@x', time: 1700000000, tz: '+0100' };
      const ann = await ply.createTag(url, { name: 'a1', target: 'refs/heads/main', message: 'Release one', tagger }, { ...opts(), verify: true });
      assert.ok(ann.ok, ann.ok || ann.error.message);
      assert.equal(ann.value.annotated, true);
      assert.equal(ann.value.commit, c2);
      assert.equal(rev(bare, 'refs/tags/a1'), ann.value.oid);
      // git tag -a in a clone with the same tagger and time writes the same object
      const work = join(root, `tag-${kind}`);
      git(root, ['clone', '-q', bare, work]);
      git(work, ['tag', '-a', '-m', 'Release one', 'a1-git', c2], { env: { ...process.env, GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_COMMITTER_DATE: '1700000000 +0100' } });
      assert.equal(git(work, ['cat-file', 'tag', 'a1-git']).replace('tag a1-git', 'tag a1'), git(bare, ['cat-file', 'tag', 'refs/tags/a1']));
      const exists = errOf(await ply.createTag(url, { name: 'a1', target: c1 }, opts()));
      assert.equal(exists.code, 'cas_conflict');
      assert.equal(exists.actual, ann.value.oid);
      assert.equal(errOf(await ply.createTag(url, { name: 'n1', target: 'main', message: 'no tagger' }, opts())).code, 'bad_request');
      assert.equal(errOf(await ply.createTag(url, { name: '', target: 'main' }, opts())).code, 'bad_request');
      assert.equal(errOf(await ply.createTag(url, { name: 'n2', target: '' }, opts())).code, 'bad_request');
      assert.equal(errOf(await ply.createTag(url, { name: 'bad..name', target: 'main' }, opts())).code, 'bad_request');
      assert.equal(errOf(await ply.createTag(url, { name: 'n3', target: 'refs/heads/nope' }, opts())).code, 'not_found');
      assert.equal(has(bare, 'refs/tags/n1') || has(bare, 'refs/tags/n3'), false);
      clean(bare);
    });
  });
}
