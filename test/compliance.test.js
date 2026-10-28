// Git compliance: everything we validate or produce, decided by git itself over enumerated input spaces.
//   idents  → `git fsck --strict` on a commit carrying the ident
//   refs    → `git check-ref-format`
//   paths   → tree built from the path, then `git fsck --strict` (protectNTFS/HFS defaults)
//   trees   → our encodeTree hash == `git write-tree` over all name pairs × modes
//   commits → parseCommit on every commit shape git can write (merges, gpgsig, mergetag, encoding, extra headers)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot } from './server.js';
import { validateIdent, validateRef, validatePath } from '../src/validate.js';
import { encodeCommit, parseCommit, hashObject, encodeTree, parseTree, treeSort } from '../src/objects.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { Rng } from './fuzz/prng.js';

let root, cleanup, repo, emptyTree, blob;
before(() => { ({ root, cleanup } = tmpRoot()); repo = join(root, 'r'); mkdirSync(repo); git(repo, ['init', '-q']); emptyTree = git(repo, ['hash-object', '-t', 'tree', '--stdin', '-w'], { input: '' }).trim(); blob = git(repo, ['hash-object', '-w', '--stdin'], { input: 'x' }).trim(); });
after(() => cleanup());

// fsck verdict for one object: filter fsck's output to this oid (fsck scans the whole store)
function fsckOf(oid) {
  let out = '';
  try { git(repo, ['fsck', '--strict', '--no-dangling']); } catch (e) { out = (e.stderr || '').toString() + (e.stdout || '').toString(); }
  const line = out.split('\n').find(l => l.includes(oid) && /^(error|warning)/.test(l));
  return line ? line.replace(/^(error|warning) in \w+ [0-9a-f]+: /, '').split(':')[0] : 'ok';
}
const writeLiterally = (type, data) => { try { return gitBuf(repo, ['hash-object', '-t', type, '-w', '--stdin', '--literally'], data).toString().trim(); } catch { return null; } };

const strings = (alphabet, maxLen) => { const out = ['']; let layer = ['']; for (let n = 1; n <= maxLen; n++) { layer = layer.flatMap(s => alphabet.map(c => s + c)); out.push(...layer); } return out; };

test('ident validation == git fsck --strict (exhaustive over an alphabet, name and email independently)', () => {
  const alpha = ['a', ' ', '<', '>', '\n', '\0', '.', '\t', '\r', '"', "'", '@', ','];
  let n = 0, disagree = [];
  const check = (name, email) => {
    n++;
    let ours; try { validateIdent({ name, email, time: 1700000000, tz: '+0000' }); ours = 'ok'; } catch { ours = 'reject'; }
    const data = Buffer.from(`tree ${emptyTree}\nauthor ${name} <${email}> 1700000000 +0000\ncommitter ${name} <${email}> 1700000000 +0000\n\nm\n`, 'utf8');
    const oid = writeLiterally('commit', data);
    const theirs = oid ? fsckOf(oid) : 'unwritable';
    // a NUL splits the header for git ("unterminated header"); for us it is a plain reject. Both reject.
    if ((ours === 'ok') !== (theirs === 'ok')) disagree.push({ name, email, ours, theirs });
  };
  for (const s of strings(alpha, 3)) { check(s, 'a@x'); check('A', s); }
  for (const [name, email] of [["O'Brien", 'o@x'], ['Dr. Who, Jr.', 'w@x'], [' lead', 'l@x'], ['trail ', 't@x'], ['日本語 名', 'n@x'], ['', ''], ['x', 'a b @ c']]) check(name, email);
  assert.deepEqual(disagree, [], `${disagree.length}/${n} disagreements`);
  console.log(`  idents: ${n} cases, 0 disagreements`);
});

test('ref validation == git check-ref-format (exhaustive over an alphabet)', () => {
  const alpha = ['a', '/', '.', '~', '^', ':', '?', '*', '[', '\\', ' ', '@', '{', '}', '-', '\x7f', '\x01', 'l', 'o', 'c', 'k'];
  let n = 0; const disagree = [];
  const tails = [...strings(alpha, 2), '.lock', 'a.lock', 'a.lock/b', 'lock', '@{', 'a@{b', 'a..b', 'a/.b', '.a', 'a/', 'a//b', 'a.', 'a...', 'x.lock.y'];
  for (const t of tails) for (const ref of [`refs/heads/${t}`, `refs/${t}`, t]) {
    if (ref.includes('\n') || ref.includes('\0')) continue; // cannot be passed as an argv string; we reject both regardless
    n++;
    let ours; try { validateRef(ref); ours = 'ok'; } catch { ours = 'reject'; }
    let theirs; try { execFileSync('git', ['check-ref-format', ref], { stdio: 'pipe' }); theirs = 'ok'; } catch { theirs = 'reject'; }
    // we additionally require a full refs/ name (bare "main" is rejected by us, accepted by check-ref-format)
    if (!ref.startsWith('refs/')) { if (ours !== 'reject') disagree.push({ ref, ours, theirs: 'n/a (we require refs/)' }); continue; }
    if (ours !== theirs) disagree.push({ ref, ours, theirs });
  }
  assert.deepEqual(disagree, [], `${disagree.length}/${n} disagreements`);
  console.log(`  refs: ${n} cases, 0 disagreements`);
});

test('path validation == git tree acceptance + fsck --strict (components over an alphabet, .git variants, NTFS/HFS)', () => {
  const alpha = ['a', '.', 'g', 'i', 't', '~', '1', ' ', 'G', 'I', 'T', '\\'];
  const comps = [...new Set([...strings(alpha, 2).filter(s => s.length), ...strings(['.', 'g', 'i', 't', 'G'], 4).filter(s => s.length), '.git', '.GIT', '.Git', 'git~1', 'GIT~1', '.gi\u200ct', '.g\u200ci\u200dt', '.git ', '.git.', '.git..', '.git . ', 'gi7eba~1', '.GIT~1', 'x', '..', '.', 'nul\0x', 'a\nb', '.gitmodules', '.git\u200e', '\ufeff.git', '.giT'])]; // 'a/b' is two components for us, one (invalid) name for a tree
  let n = 0; const disagree = [];
  for (const c of comps) {
    n++;
    const path = `d/${c}`;
    let ours; try { validatePath(path, DEFAULT_LIMITS); ours = 'ok'; } catch { ours = 'reject'; }
    // git side: build the tree object directly (bypassing index normalization) and fsck it
    const data = Buffer.concat([Buffer.from(`100644 ${c}\0`, 'utf8'), Buffer.from(blob, 'hex')]);
    const oid = c.includes('\0') || c.includes('/') ? null : writeLiterally('tree', data);
    const theirs = oid ? fsckOf(oid) : 'reject';
    if ((ours === 'ok') !== (theirs === 'ok')) disagree.push({ c: JSON.stringify(c), ours, theirs });
  }
  assert.deepEqual(disagree, [], `${disagree.length}/${n} disagreements`);
  console.log(`  paths: ${n} components, 0 disagreements`);
});

test('tree encoding == git write-tree over all name pairs × {file, dir} (sort order with dir-as-slash)', () => {
  const names = ['a', 'a-', 'a.', 'a0', 'a_', 'ab', 'A', 'a~', 'b', 'a b', '-a', '.a', '한', 'aa', 'a.b', 'a-b'];
  let n = 0;
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) for (const [mi, mj] of [['100644', '100644'], ['40000', '100644'], ['100644', '40000'], ['40000', '40000'], ['120000', '100755']]) {
    const sub = join(root, `t${n++}`); mkdirSync(sub); git(sub, ['init', '-q']);
    const entries = [[names[i], mi], [names[j], mj]].map(([name, mode]) => ({ mode, name, oid: mode === '40000' ? emptyTreeIn(sub) : blobIn(sub, name) }));
    // git: mktree with entries (any order) → oid
    const mk = git(sub, ['mktree'], { input: entries.map(e => `${e.mode.padStart(6, '0')} ${e.mode === '40000' ? 'tree' : 'blob'} ${e.oid}\t${e.name}`).join('\n') + '\n' }).trim();
    assert.equal(hashObject('tree', encodeTree(entries)), mk, `${names[i]}(${mi}) vs ${names[j]}(${mj})`);
    assert.equal(hashObject('tree', encodeTree([entries[1], entries[0]])), mk, 'order-independent');
  }
  console.log(`  trees: ${n} pairs, all equal to git mktree`);
});
const emptyTreeIn = sub => git(sub, ['hash-object', '-t', 'tree', '--stdin', '-w'], { input: '' }).trim();
const blobIn = (sub, s) => git(sub, ['hash-object', '-w', '--stdin'], { input: s }).trim();

test('parseCommit recovers tree/parents/author/committer/message from every commit shape git writes', () => {
  const sub = join(root, 'c'); mkdirSync(sub); git(sub, ['init', '-q', '-b', 'main']);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@x', GIT_AUTHOR_DATE: '1700000000 +0100', GIT_COMMITTER_DATE: '1700000001 -0230' };
  writeFileSync(join(sub, 'f'), '1'); git(sub, ['add', 'f']); git(sub, ['commit', '-q', '-m', 'root'], { env });
  git(sub, ['checkout', '-q', '-b', 'b1']); writeFileSync(join(sub, 'g'), '2'); git(sub, ['add', 'g']); git(sub, ['commit', '-q', '-m', 'b1'], { env });
  git(sub, ['checkout', '-q', '-b', 'b2', 'main']); writeFileSync(join(sub, 'h'), '3'); git(sub, ['add', 'h']); git(sub, ['commit', '-q', '-m', 'b2\n\nbody line\n\nmore'], { env });
  git(sub, ['checkout', '-q', 'main']); git(sub, ['merge', '-q', '--no-ff', '-m', 'octo', 'b1', 'b2'], { env });
  const tree = git(sub, ['rev-parse', 'HEAD^{tree}']).trim(), p = git(sub, ['rev-parse', 'HEAD']).trim();
  // hand-made shapes git accepts: gpgsig (multi-line continuation), mergetag, encoding, unknown header, empty message, no trailing newline
  const shapes = [
    `tree ${tree}\nparent ${p}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n =abcd\n -----END PGP SIGNATURE-----\n\nsigned\n`,
    `tree ${tree}\nparent ${p}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 +0000\nmergetag object ${p}\n type commit\n tag v9\n tagger T <t@x> 3 +0000\n \n v9\n\nmerge tag\n`,
    `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 +0000\nencoding ISO-8859-1\n\nlatin\n`,
    `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 +0000\nx-custom header value\n\n`,
    `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 +0000\n\nno trailing newline`,
    `tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 +0000\n`,
  ];
  const all = [...git(sub, ['rev-list', '--all']).trim().split('\n'), ...shapes.map(s => gitBuf(sub, ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], Buffer.from(s)).toString().trim())];
  for (const oid of all) {
    const data = new Uint8Array(gitBuf(sub, ['cat-file', 'commit', oid]));
    const c = parseCommit(data);
    const [t, ...parents] = git(sub, ['rev-list', '--parents', '-n1', oid]).trim().split(' ').slice(1).length ? [git(sub, ['rev-parse', `${oid}^{tree}`]).trim(), ...git(sub, ['rev-list', '--parents', '-n1', oid]).trim().split(' ').slice(1)] : [git(sub, ['rev-parse', `${oid}^{tree}`]).trim()];
    assert.equal(c.tree, t, oid); assert.deepEqual(c.parents, parents, oid);
    assert.equal(c.author, git(sub, ['log', '-1', '--format=%an <%ae> %at %ai', oid]).trim().replace(/ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, ' '), oid);
    assert.equal((c.message ?? '').replace(/\n+$/, ''), git(sub, ['log', '-1', '--format=%B', oid]).replace(/\n+$/, ''), oid); // %B appends newlines of its own
    // re-encoding a commit we did not write must be byte-identical when it has only standard headers
    // parse ∘ encode is the identity for every shape, including multi-line continuation headers (gpgsig, mergetag)
    assert.deepEqual([...encodeCommit(c)], [...data], `roundtrip ${oid}`);
  }
  console.log(`  commits: ${all.length} shapes parsed consistently with git log`);
});
