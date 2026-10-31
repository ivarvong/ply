// Issue #43: git never interprets the bytes of a name, a message, an ident or a ref. Every cell of
//   byte content × object field × operation
// is run against git as the oracle (`ls-tree -z`, `cat-file`, `for-each-ref`, `merge-tree`, `check-attr` through
// merge-tree's attr.tree) over git http-backend. A cell passes when ply returns the same bytes or names git does, or
// when both refuse (git cannot store or read the value, and ply's refusal is typed). A ply refusal where git succeeds is
// allowed only with a reason listed in ALLOWED_REFUSALS. Strings carry bytes as bytes.js decodeBytes maps them:
// well-formed UTF-8 as itself (a BOM anywhere stays), every other byte as U+DC00 + byte; encodeBytes is the inverse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { readFile, listTree, readCommit } from '../src/read.js';
import { checkoutTree } from '../src/checkout.js';
import { writeFiles } from '../src/checkout-node.js';
import { editFile } from '../src/edit.js';
import { mergeBranch } from '../src/merge.js';
import { decodeBytes, encodeBytes } from '../src/bytes.js';
import { isPlyCode } from '../src/errors.js';
import { Tracer } from '../src/otel.js';

const O = (extra = {}) => ({ tracer: new Tracer(), ...extra });

// ---- the space ----
const BOM = [0xef, 0xbb, 0xbf];
// Each content puts its bytes into a base string: at the front for the leading BOM, after the first byte otherwise.
export const CONTENT = {
  leadingBom: s => B(BOM, s),
  midBom: s => B(s.slice(0, 1), BOM, s.slice(1)),
  invalidUtf8: s => B(s.slice(0, 1), [0xff, 0x80], s.slice(1)),
  overlong: s => B(s.slice(0, 1), [0xc0, 0xaf, 0xe0, 0x80, 0xae], s.slice(1)), // overlong '/' and '.'
  nul: s => B(s.slice(0, 1), [0x00], s.slice(1)),
  cr: s => B(s.slice(0, 1), [0x0d], s.slice(1)),
  multibyte: s => B(s.slice(0, 1), 'é€🚀', s.slice(1)),
  latin1: s => B(s.slice(0, 1), [0xe9, 0xe8], s.slice(1)),
};
export const FIELDS = ['treeName', 'commitMessage', 'authorName', 'refName', 'attributesPattern', 'tagName'];
export const OPS = ['readFile', 'listTree', 'readCommit', 'checkoutTree', 'editFile', 'merge'];

// A ply refusal where git succeeds, with the reason it is right.
const ALLOWED_REFUSALS = {
  // APFS stores names as UTF-8 and answers EILSEQ to anything else; `git clone` fails on that file the same way.
  // `git merge <annotated tag>` writes a mergetag header, which ply does not; it says so instead of merging without it.
  merge: e => e.code === 'unsupported' && /is an annotated tag/.test(e.message),
  checkoutTree: e => e.code === 'unsupported' && /filesystem refuses the name bytes/.test(e.message) && process.platform === 'darwin',
};

function B(...parts) { return Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p)))); }

// ---- git, bytes in and out ----
const run = (cwd, args, { input, env } = {}) => spawnSync('git', args, { cwd, input, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 1 << 26 });
const gitOk = (cwd, args, opts) => { const r = run(cwd, args, opts); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout; };
const hash = (bare, type, data) => gitOk(bare, ['hash-object', '-w', '--literally', '-t', type, '--stdin'], { input: data }).toString().trim();
const sortKey = e => (e.mode === '40000' ? B(e.name, '/') : e.name);
const rawTree = entries => B(...[...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b))).flatMap(e => [B(`${e.mode} `), e.name, [0], Buffer.from(e.oid, 'hex')]));
const IDENT_TAIL = ' <a@x> 1700000000 +0000';
const rawCommit = ({ tree, parents = [], author = B('A U Thor'), message = B('m\n') }) => B(`tree ${tree}\n`, ...parents.map(p => `parent ${p}\n`), 'author ', author, IDENT_TAIL, '\ncommitter C', IDENT_TAIL, '\n\n', message);
// ls-tree -z: [{ mode, type, oid, name: Buffer }]; throws when git cannot read the tree
const lsTree = (bare, rev) => { const out = gitOk(bare, ['ls-tree', '-z', rev]); const rows = []; let p = 0; while (p < out.length) { const nul = out.indexOf(0, p); const line = out.subarray(p, nul); const tab = line.indexOf(9); const [mode, type, oid] = line.subarray(0, tab).toString().split(' '); rows.push({ mode, type, oid, name: Buffer.from(line.subarray(tab + 1)) }); p = nul + 1; } return rows; };
const catCommit = (bare, rev) => { const raw = gitOk(bare, ['cat-file', 'commit', rev]); const blank = raw.indexOf('\n\n'); const head = raw.subarray(0, blank).toString('latin1').split('\n'); const field = k => head.filter(l => l.startsWith(k + ' ')).map(l => Buffer.from(l.slice(k.length + 1), 'latin1')); const author = field('author')[0]; const lt = author.indexOf(' <'); return { tree: field('tree')[0].toString(), parents: field('parent').map(String), authorName: author.subarray(0, lt), message: raw.subarray(blank + 2) }; };
// Ref names never go through argv (it is UTF-8 to node): git lists them as bytes, and is asked by oid. for-each-ref
// skips a name check-ref-format refuses ("ignoring ref with broken name"), so absence is git's refusal.
const gitRefs = bare => { const out = gitOk(bare, ['for-each-ref', '--format=%(objectname) %(*objectname) %(refname)%00']); const m = new Map(); let p = 0; while (p < out.length) { const nul = out.indexOf(0, p); const line = out.subarray(p, nul); const [oid, peeled] = line.subarray(0, 82).toString().split(' '); m.set(Buffer.from(line.subarray(line.indexOf(32, 41) + 1)).toString('latin1'), { oid, commit: peeled || oid }); p = nul + 2; } return m; };
const refAt = (bare, name) => { const r = gitRefs(bare).get(Buffer.from(encodeBytes(name)).toString('latin1')); if (!r) throw new Error(`git: no ref ${JSON.stringify(name)} (for-each-ref lists no such name)`); return r.commit; };
const refList = bare => [...gitRefs(bare)].map(([n, r]) => `${r.oid} ${n}`).join('\n');
const bytesOf = s => Buffer.from(encodeBytes(s));
const drain = async stream => { const parts = []; for await (const c of stream) parts.push(Buffer.from(c)); return Buffer.concat(parts); };

// ---- one fixture per (content, field) ----
// main: C0 (f.txt, g.txt[, .gitattributes]) → C1 (f.txt line 1). side: C0 → S1 (f.txt line 3, plus the field's bytes).
// The field's bytes: treeName, a file of that name on side; commitMessage / authorName, S1's; refName, a branch at S1
// (the read target); attributesPattern, a .gitattributes line `<pattern> merge=union` on both sides and a file the
// pattern names that both sides change, so the merge is clean only when the pattern matches; tagName, an annotated tag
// object at S1 whose `tag` header and ref carry the bytes (the read target).
const F_BASE = 'line1\nline2\nline3\n';
function fixture(root, id, content, field) {
  const bare = makeBareRepo(root, id);
  const blob = data => hash(bare, 'blob', B(data));
  const hostile = s => CONTENT[content](s);
  const f0 = blob(F_BASE), f1 = blob('LINE1\nline2\nline3\n'), fs1 = blob('line1\nline2\nLINE3\n'), g = blob('g\n');
  const base = [{ mode: '100644', name: B('f.txt'), oid: f0 }, { mode: '100644', name: B('g.txt'), oid: g }];
  const fx = { bare, field, content, target: 'refs/heads/side', from: 'refs/heads/side', extraRefs: [] };
  let attrFile = null;
  if (field === 'attributesPattern') {
    const pattern = hostile('p.txt');
    const named = Buffer.from(pattern.filter(b => b !== 0));
    attrFile = { pattern, named, ga: blob(B(pattern, ' merge=union\n')), u0: blob('u0\n'), uo: blob('uo\n'), ut: blob('ut\n') };
    base.push({ mode: '100644', name: B('.gitattributes'), oid: attrFile.ga }, { mode: '100644', name: named, oid: attrFile.u0 });
  }
  const t0 = hash(bare, 'tree', rawTree(base));
  const c0 = hash(bare, 'commit', rawCommit({ tree: t0 }));
  const swap = (entries, name, oid) => entries.map(e => (e.name.equals(B(name)) ? { ...e, oid } : e));
  let mainEntries = swap(base, 'f.txt', f1), sideEntries = swap(base, 'f.txt', fs1);
  if (attrFile) { mainEntries = swap(mainEntries, attrFile.named, attrFile.uo); sideEntries = swap(sideEntries, attrFile.named, attrFile.ut); }
  if (field === 'treeName') sideEntries = [...sideEntries, { mode: '100644', name: hostile('n.txt'), oid: blob('hostile name\n') }];
  const c1 = hash(bare, 'commit', rawCommit({ tree: hash(bare, 'tree', rawTree(mainEntries)), parents: [c0], message: B('main\n') }));
  const s1 = hash(bare, 'commit', rawCommit({ tree: hash(bare, 'tree', rawTree(sideEntries)), parents: [c0], author: field === 'authorName' ? hostile('A U Thor') : B('A U Thor'), message: field === 'commitMessage' ? B(hostile('side commit'), '\n') : B('side\n') }));
  const refs = [[B('refs/heads/main'), c1], [B('refs/heads/side'), s1]];
  const peeled = new Map();
  // a NUL ends the name in packed-refs: that ref cannot exist, and git refuses every operation on it
  if (field === 'refName') { const name = B('refs/heads/', hostile('hr')); if (!name.includes(0)) refs.push([name, s1]); fx.target = fx.from = decodeBytes(name); }
  if (field === 'tagName') {
    const tagName = hostile('tg');
    const tag = hash(bare, 'tag', B(`object ${s1}\ntype commit\ntag `, tagName, '\ntagger T', IDENT_TAIL, '\n\ntag\n'));
    const name = B('refs/tags/', tagName.filter(b => b !== 0));
    refs.push([name, tag]); peeled.set(name.toString('latin1'), s1); fx.target = fx.from = decodeBytes(name);
  }
  // packed-refs, not update-ref: a loose ref is a file, and the filesystem may refuse its name (APFS: EILSEQ)
  refs.sort((a, b) => Buffer.compare(a[0], b[0]));
  writeFileSync(join(bare, 'packed-refs'), B('# pack-refs with: peeled fully-peeled sorted \n', ...refs.flatMap(([n, o]) => [`${o} `, n, '\n', ...(peeled.has(n.toString('latin1')) ? [`^${peeled.get(n.toString('latin1'))}\n`] : [])])));
  fx.refsBefore = refList(bare);
  return fx;
}

// ---- the oracle and ply, per operation ----
// The target ref must be one git lists (check-ref-format); otherwise git refuses every operation on it.
// Each returns { git, ply } normalized to comparable values, or throws (git's refusal, ply's refusal).
const WHO = { name: 'P Ly', email: 'p@x' };
const fieldIn = (fx, s) => decodeBytes(CONTENT[fx.content](s));
const OPERATIONS = {
  async readFile(fx, url) {
    const rows = lsTree(fx.bare, revOf(fx)).filter(r => r.type === 'blob');
    const git = rows.map(r => ({ name: r.name.toString('hex'), data: gitOk(fx.bare, ['cat-file', 'blob', r.oid]).toString('hex') }));
    return { git, ply: async () => { const out = []; for (const r of rows) { const f = await readFile(url, { ref: fx.target, path: decodeBytes(r.name) }, O()); out.push({ name: r.name.toString('hex'), data: (await drain(f.stream)).toString('hex') }); } return out; } };
  },
  async listTree(fx, url) {
    const git = lsTree(fx.bare, revOf(fx)).map(r => ({ name: r.name.toString('hex'), mode: r.mode, oid: r.oid }));
    return { git, ply: async () => (await listTree(url, { ref: fx.target }, O())).entries.map(e => ({ name: bytesOf(e.name).toString('hex'), mode: e.mode, oid: e.oid })) };
  },
  async readCommit(fx, url) {
    const c = catCommit(fx.bare, revOf(fx));
    const git = { tree: c.tree, parents: c.parents, author: c.authorName.toString('hex'), message: c.message.toString('hex') };
    return { git, ply: async () => { const r = await readCommit(url, { ref: fx.target }, O()); return { tree: r.tree, parents: r.parents, author: bytesOf(r.author.name).toString('hex'), message: bytesOf(r.message).toString('hex') }; } };
  },
  async checkoutTree(fx, url) {
    const rows = lsTree(fx.bare, revOf(fx)).filter(r => r.type === 'blob');
    const git = rows.map(r => ({ path: r.name.toString('hex'), data: gitOk(fx.bare, ['cat-file', 'blob', r.oid]).toString('hex') })).sort(byPath);
    return { git, ply: async () => {
      const co = await checkoutTree(url, { ref: fx.target }, O());
      const files = []; for await (const f of co.files) files.push({ path: bytesOf(f.path).toString('hex'), data: (await drain(f.stream)).toString('hex') });
      // and onto a filesystem: the names on disk are git's bytes
      const dir = mkdtempSync(join(fx.bare, '..', 'co-'));
      try {
        await writeFiles(dir, (await checkoutTree(url, { ref: fx.target }, O())).files);
        const disk = readdirSync(dir, { encoding: 'buffer' }).map(n => n.toString('hex')).sort();
        assert.deepEqual(disk, files.map(f => f.path).sort(), 'names on disk');
      } finally { rmSync(dir, { recursive: true, force: true }); }
      return files.sort(byPath);
    } };
  },
  async editFile(fx, url) {
    // the edit is on the target branch (for a tag, on side); the caller's message / author carry the field's bytes
    const ref = fx.field === 'tagName' ? 'refs/heads/side' : fx.target;
    const message = fx.field === 'commitMessage' ? fieldIn(fx, 'edit message') : 'edit';
    const author = fx.field === 'authorName' ? { ...WHO, name: fieldIn(fx, 'P Ly') } : WHO;
    const old = refAt(fx.bare, ref);
    gitCanUpdate(fx.bare, ref, old);
    const oldRows = lsTree(fx.bare, old);
    const fOld = oldRows.find(r => r.name.equals(B('f.txt'))).oid;
    const newBlob = gitOk(fx.bare, ['hash-object', '--stdin'], { input: B(gitOk(fx.bare, ['cat-file', 'blob', fOld]).toString().replace('line2', 'EDITED')) }).toString().trim();
    const git = { tree: oldRows.map(r => ({ name: r.name.toString('hex'), mode: r.mode, oid: r.name.equals(B('f.txt')) ? newBlob : r.oid })), parents: [old], author: bytesOf(author.name).toString('hex'), message: B(encodeBytes(message), '\n').toString('hex') };
    gitCan(message, author.name);
    return { git, ply: async () => {
      const r = await editFile(url, { ref, path: 'f.txt', find: 'line2', replace: 'EDITED', author, message }, O());
      assert.equal(r.outcome ?? 'ok', 'ok');
      const now = refAt(fx.bare, ref);
      // no other ref appeared or moved (a ref name read as U+FFFD would push a new ref)
      const others = list => list.split('\n').filter(l => !l.endsWith(` ${Buffer.from(encodeBytes(ref)).toString('latin1')}`)).join('\n');
      assert.equal(others(refList(fx.bare)), others(fx.refsBefore), 'refs other than the edited one');
      const c = catCommit(fx.bare, now);
      return { tree: lsTree(fx.bare, now).map(x => ({ name: x.name.toString('hex'), mode: x.mode, oid: x.oid })), parents: c.parents, author: c.authorName.toString('hex'), message: c.message.toString('hex') };
    } };
  },
  async merge(fx, url) {
    const message = fx.field === 'commitMessage' ? fieldIn(fx, 'merge message') : 'merge';
    const author = fx.field === 'authorName' ? { ...WHO, name: fieldIn(fx, 'P Ly') } : WHO;
    gitCan(message, author.name);
    const r = run(fx.bare, ['-c', 'attr.tree=refs/heads/main', 'merge-tree', '--write-tree', 'refs/heads/main', refAt(fx.bare, fx.from)]);
    if (r.status !== 0 && r.status !== 1) throw new Error(`git merge-tree: ${r.stderr}`);
    const git = r.status === 0 ? { clean: true, tree: r.stdout.toString().split('\n')[0], message: B(encodeBytes(message), '\n').toString('hex'), author: bytesOf(author.name).toString('hex') } : { clean: false };
    return { git, ply: async () => {
      let m; try { m = await mergeBranch(url, { ref: 'refs/heads/main', from: fx.from, author, message }, O({ attributes: 'ours' })); } catch (e) { if (e.code === 'merge_conflict') return { clean: false }; throw e; }
      const c = catCommit(fx.bare, 'refs/heads/main');
      assert.equal(m.outcome, 'merge');
      return { clean: true, tree: c.tree, message: c.message.toString('hex'), author: c.authorName.toString('hex') };
    } };
  },
};
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
// the rev git reads: the target (a tag peels to its commit)
const revOf = fx => refAt(fx.bare, fx.target);
// Whether git can move the ref at all, asked of a copy of the server. A name argv can carry: a real `git push` of a child
// commit (receive-pack's own checks: a broken ref elsewhere fails its connectivity check, "missing necessary objects").
// Any other name: `update-ref --stdin`, which reads it as bytes (the loose ref file it writes may be refused by the
// filesystem, APFS: EILSEQ, as a push would be).
function gitCanUpdate(bare, ref, old) {
  const a = mkdtempSync(join(bare, '..', 'cp-')), b = mkdtempSync(join(bare, '..', 'cp-'));
  try {
    cpSync(bare, a, { recursive: true }); cpSync(bare, b, { recursive: true });
    const argvSafe = ref.isWellFormed() && /^[\x21-\x7e]+$/.test(ref);
    const child = gitOk(a, ['commit-tree', `${old}^{tree}`, '-p', old, '-m', 'probe'], { env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } }).toString().trim();
    const r = argvSafe ? run(a, ['push', '-q', b, `${child}:${ref}`]) : run(b, ['update-ref', '--stdin'], { input: B('update ', encodeBytes(ref), ` ${old} ${old}\n`) });
    if (r.status !== 0) throw new Error(`git ${argvSafe ? 'push' : 'update-ref'}: ${(r.stderr.toString().trim().split('\n').find(l => l.includes('rejected')) ?? r.stderr.toString().trim())}`);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
}
// What git refuses to write from a caller: a NUL in a message (commit-tree: "a NUL byte in commit log message not
// allowed") or in an ident (an environment variable cannot hold one); a ref name check-ref-format refuses.
function gitCan(message, name) {
  if (encodeBytes(message).includes(0)) throw new Error('git commit-tree: a NUL byte in commit log message not allowed');
  if (encodeBytes(name).includes(0)) throw new Error('git: an ident cannot hold NUL');
}

// ---- run the product ----
let root, cleanup, srv;
const results = [];
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const verdict = async (fx, op) => {
  const url = `${srv.url}/${fx.bare.split('/').pop()}`;
  // The target ref must be a name git accepts (check-ref-format); otherwise git refuses every operation on it.
  let oracle, gitErr = null;
  try { oracle = await OPERATIONS[op](fx, url); } catch (e) { gitErr = e; }
  let got, plyErr = null;
  try { got = gitErr ? await plyAnyway(fx, op, url) : await oracle.ply(); } catch (e) { plyErr = e; }
  if (plyErr && (!isPlyCode(plyErr.code) || plyErr.code === 'network')) return { v: 'untyped', why: String(plyErr?.stack ?? plyErr) };
  if (gitErr && plyErr) return { v: 'refused-as-git', why: `${plyErr.code}: ${plyErr.message}`, git: String(gitErr.message).split('\n')[0] };
  if (gitErr) return { v: 'git-refuses-ply-accepts', why: String(gitErr.message).split('\n')[0] };
  if (plyErr) return ALLOWED_REFUSALS[op]?.(plyErr) ? { v: 'refused', why: `${plyErr.code}: ${plyErr.message}` } : { v: 'refused-unexplained', why: `${plyErr.code}: ${plyErr.message}` };
  try { assert.deepEqual(got, oracle.git); return { v: 'same' }; } catch (e) { return { v: 'differs', why: e.message.slice(0, 600) }; }
};
// git refused: ply must refuse too. Run ply's operation with the same inputs and no oracle to compare against.
async function plyAnyway(fx, op, url) {
  const message = fx.field === 'commitMessage' ? fieldIn(fx, 'msg') : 'msg';
  const author = fx.field === 'authorName' ? { ...WHO, name: fieldIn(fx, 'P Ly') } : WHO;
  if (op === 'readFile') return (await readFile(url, { ref: fx.target, path: 'f.txt' }, O())).size;
  if (op === 'listTree') return (await listTree(url, { ref: fx.target }, O())).entries.length;
  if (op === 'readCommit') return (await readCommit(url, { ref: fx.target }, O())).oid;
  if (op === 'checkoutTree') { const co = await checkoutTree(url, { ref: fx.target }, O()); for await (const f of co.files) await drain(f.stream); return co.entries.length; }
  if (op === 'editFile') return (await editFile(url, { ref: fx.field === 'tagName' ? 'refs/heads/side' : fx.target, path: 'f.txt', find: 'line2', replace: 'X', author, message }, O())).outcome;
  return (await mergeBranch(url, { ref: 'refs/heads/main', from: fx.from, author, message }, O({ attributes: 'ours' }))).outcome;
}

test(`git bytes: ${Object.keys(CONTENT).length} contents × ${FIELDS.length} fields × ${OPS.length} operations, every cell against git`, async () => {
  let n = 0;
  // CELL=content/field/op runs one cell and prints its whole verdict
  const only = process.env.CELL?.split('/');
  for (const content of Object.keys(CONTENT)) for (const field of FIELDS) for (const op of OPS) {
    if (only && (only[0] !== content || only[1] !== field || only[2] !== op)) continue;
    // a fresh fixture per cell: edits and merges move refs
    const fx = fixture(root, `r${n++}`, content, field);
    results.push({ content, field, op, ...(await verdict(fx, op)) });
    if (only) console.log(results.at(-1));
  }
  const bad = results.filter(r => !['same', 'refused-as-git', 'refused'].includes(r.v));
  const table = {};
  for (const r of results) { const k = `${r.field}`; table[k] ??= {}; table[k][r.op] = (table[k][r.op] ?? '') + (r.v === 'same' ? '=' : r.v === 'refused-as-git' ? 'g' : r.v === 'refused' ? 'r' : 'X'); }
  console.log(`# ${results.length} cells (contents in order ${Object.keys(CONTENT).join(' ')}; '=' same as git, 'g' both refuse, 'r' allowed refusal, 'X' fails)`);
  for (const [field, ops] of Object.entries(table)) console.log(`# ${field.padEnd(18)} ${OPS.map(op => `${op}:${ops[op]}`).join(' ')}`);
  const counts = {}; for (const r of results) counts[r.v] = (counts[r.v] ?? 0) + 1;
  console.log(`# verdicts ${JSON.stringify(counts)}`);
  for (const r of results.filter(x => x.v !== 'same')) console.log(`# ${r.v.padEnd(24)} ${r.content}/${r.field}/${r.op}: ${String(r.why ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 300)}${r.git ? ` [git: ${r.git.slice(0, 120)}]` : ''}`);
  if (!only) assert.equal(results.length, Object.keys(CONTENT).length * FIELDS.length * OPS.length);
  assert.deepEqual(bad.map(r => `${r.content}/${r.field}/${r.op}: ${r.v}`), []);
});

// Every decoder is bytes.js's: a `new TextDecoder()` elsewhere would bring back the default that drops a leading BOM,
// and a `new TextEncoder()` writes a lone surrogate as U+FFFD. bytes.js holds the three constructions this audit chose.
test('src/ constructs TextDecoder and TextEncoder only in bytes.js', () => {
  const dir = new URL('../src/', import.meta.url);
  const found = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const text = readFileSync(new URL(f, dir), 'utf8');
    for (const m of text.matchAll(/new Text(De|En)coder\(([^)]*)\)/g)) found.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(found, ["bytes.js: new TextEncoder()", "bytes.js: new TextDecoder('utf-8', { ignoreBOM: true })", "bytes.js: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })"]);
});
