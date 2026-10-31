// The fsck tree-entry enumerator (test/space/fsck-tree.space.js). Every cell of trigger × mode × name × position is a
// tree built byte for byte, judged by `git fsck --strict` (both streams, the exit code, every `error in` / `warning in`
// line and its msgId, never --connectivity-only) and by ply's parseTree, through which every read path goes. Holds:
//   1. the model (git's fsck_tree ported in the space file) to git, cell by cell: the same error and warning msgIds;
//   2. ply to the expected outcome: it refuses exactly the trees git errors on, naming one of git's msgIds, and accepts
//      the rest with the canonical modes `git ls-tree` prints;
//   3. the checkout: every entry ply accepts is a path `git read-tree` accepts with core.protectHFS and core.protectNTFS
//      both on (so verify_path refuses nothing parseTree lets through, on Linux or macOS), and checkoutPathRefusal agrees;
//      on Windows, checkoutPathRefusal against the rules of compat/mingw.c;
//   4. .gitattributes contents at git's line and size caps: ply reads them as `git check-attr --source` does.
// FSCK_TREE_SRC=<dir> runs ply's side against another copy of src/ (`git archive <rev> src | tar -x -C <dir>`), to count
// what that revision got wrong. FSCK_TREE_LIST=1 prints every disagreeing cell. FSCK_TREE_LARGE=1 adds the three
// 100 MiB .gitattributes cells (about 300 MB of blobs).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as space from './fsck-tree.space.js';
import { checkoutPathRefusal } from '../../src/validate.js';
import { attributesFor, bytesToStr } from '../../src/attributes.js';
import { encodeBytes, decodeBytes } from '../../src/bytes.js';

const SRC = process.env.FSCK_TREE_SRC ?? new URL('../../src', import.meta.url).pathname;
// an absolute specifier: the .js -> .ts resolve hook maps relative ones only (objects is TypeScript since T2; an older src copy is .js)
const { parseTree } = await import(existsSync(`${SRC}/objects.ts`) ? `${SRC}/objects.ts` : `${SRC}/objects.js`);
const LIST = !!process.env.FSCK_TREE_LIST;

const sha1 = (type, data) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
const EMPTY_BLOB = sha1('blob', Buffer.alloc(0));
const NULL = '0'.repeat(40);

function run(cmd, args, { cwd, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', status => resolve({ status, stdout: Buffer.concat(out).toString('latin1'), stderr: Buffer.concat(err).toString('latin1') }));
    p.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); }); // a git that exits without reading stdin
    p.stdin.end(input ?? '');
  });
}

// ---- the cells and the objects each one needs ----
// objects: [{ type, data, oid, owner: cell index | null (a fixture) }]
function build() {
  const cells = space.product().map((c, i) => ({ c, i, id: space.cellId(c) }));
  const objects = new Map([[EMPTY_BLOB, { type: 'blob', data: Buffer.alloc(0), oid: EMPTY_BLOB, owners: null }]]);
  const own = (type, data, i) => {
    const oid = sha1(type, data);
    const o = objects.get(oid);
    if (o) { if (o.owners) o.owners.add(i); else return oid; } else objects.set(oid, { type, data, oid, owners: new Set([i]) });
    return oid;
  };
  for (const x of cells) {
    x.entries = space.entriesOf(x.c);
    x.extra = new Set();
    const oidOf = e => {
      if (e.oid === 'null') return NULL;
      if (e.oid === 'blob') return EMPTY_BLOB;
      if (e.oid === 'gitlink') { const g = space.gitlinkOid(x.id, e.role); x.extra.add(g); return g; }
      const t = own('tree', space.subtreeBytes(x.id, e.role, EMPTY_BLOB), x.i); x.extra.add(t); return t;
    };
    x.bytes = space.treeBytes(x.entries, oidOf);
    x.oid = own('tree', x.bytes, x.i);
    x.want = space.expected(x.c);
  }
  return { cells, objects: [...objects.values()] };
}

// ---- the oracle: git fsck --strict over a store, every line pinned to the cell that owns an oid in it ----
const UNPINNED = /^error: (empty filename in tree entry|malformed mode in tree entry)$/;
const CONNECTIVITY = /^(broken link from|missing (blob|tree|commit) |error in tree [0-9a-f]{40}: broken links$)/;
const msgIdOf = l => /^(?:error|warning) in \w+ [0-9a-f]{40}: (\w+): /.exec(l)?.[1] ?? null;

async function writeLoose(dir, objs) {
  mkdirSync(join(dir, 'in'), { recursive: true });
  for (const type of ['blob', 'tree']) {
    const mine = objs.filter(o => o.type === type);
    if (!mine.length) continue;
    const paths = mine.map((o, k) => { const p = join(dir, 'in', `${type}-${k}`); writeFileSync(p, o.data); return p; });
    const r = await run('git', ['hash-object', '-t', type, '--literally', '-w', '--stdin-paths'], { cwd: dir, input: paths.join('\n') + '\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), mine.map(o => o.oid), `git hash-object --literally and this test hash every ${type} alike`);
  }
  rmSync(join(dir, 'in'), { recursive: true, force: true });
}

// The full space goes in one pack per shard, framed with node:zlib and indexed by `git index-pack` without --strict
// (which judges nothing; git hashes each object from its bytes, and show-index must list exactly our oids), as #62 does:
// a loose object per cell costs about half a millisecond on APFS. A fixed sample is also written loose with `git
// hash-object --literally` and must get the same lines.
async function writePack(dir, objs) {
  const parts = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2].writeUInt32BE(objs.length);
  for (const o of objs) {
    let size = o.data.length;
    const head = [({ tree: 2, blob: 3 }[o.type] << 4) | (size & 0x0f)];
    size >>= 4;
    while (size) { head[head.length - 1] |= 0x80; head.push(size & 0x7f); size >>= 7; }
    parts.push(Buffer.from(head), deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  const r = await run('git', ['index-pack', '--stdin'], { cwd: dir, input: Buffer.concat([body, createHash('sha1').update(body).digest()]) });
  assert.equal(r.status, 0, r.stderr);
  const idx = join(dir, 'objects', 'pack', `pack-${r.stdout.trim().split(/\s+/).pop()}.idx`);
  const listed = await run('git', ['show-index'], { cwd: dir, input: readFileSync(idx) });
  assert.deepEqual(listed.stdout.trim().split('\n').map(l => l.split(' ')[1]).sort(), objs.map(o => o.oid).sort(), 'git hashes every object as this test does');
}

// → Map(cell index → lines), and the unpinned lines (git's own `error:` from decode_tree_entry, before a badTree)
async function judge(cells, objects, { loose }) {
  const shards = loose ? 1 : Math.max(1, Math.min(8, availableParallelism()));
  const root = mkdtempSync(join(tmpdir(), 'ply-fsck-tree-'));
  const lines = new Map(cells.map(x => [x.i, []]));
  const unpinned = [];
  const exits = [];
  try {
    await Promise.all(Array.from({ length: shards }, async (_, s) => {
      const dir = join(root, `s${s}`);
      assert.equal((await run('git', ['init', '-q', '--bare', dir])).status, 0);
      const mineCells = cells.filter((_, k) => k % shards === s);
      const want = new Set(mineCells.map(x => x.i));
      const mine = objects.filter(o => !o.owners || [...o.owners].some(i => want.has(i)));
      if (loose) await writeLoose(dir, mine); else await writePack(dir, mine);
      const r = await run('git', ['fsck', '--strict', '--no-dangling'], { cwd: dir });
      const got = [];
      for (const l of `${r.stdout}\n${r.stderr}`.split('\n')) {
        if (!l.trim() || l.startsWith('notice:')) continue;
        if (/^\s/.test(l) && got.length) got[got.length - 1] += ` ${l.trim()}`; else got.push(l.trim());
      }
      // exit bits: 1 an object error, 2 connectivity, 4 (packed only) an object in a pack that does not parse
      assert.ok(r.status !== null && (r.status & ~(loose ? 3 : 7)) === 0, `git fsck exit ${r.status}: ${got.slice(0, 5).join(' | ')}`);
      exits.push({ status: r.status, errors: got.some(l => !l.startsWith('warning in ') && !UNPINNED.test(l) && !/^(broken link from|missing )/.test(l)) });
      const byOid = new Map();
      for (const x of mineCells) for (const oid of [x.oid, ...x.extra]) { if (!byOid.has(oid)) byOid.set(oid, []); byOid.get(oid).push(x.i); }
      for (const l of got) {
        if (UNPINNED.test(l)) { unpinned.push(l); continue; }
        const owners = [...l.matchAll(/[0-9a-f]{40}/g)].map(m => byOid.get(m[0])).find(Boolean);
        if (!owners) throw new Error(`fsck line pinned to no cell: ${l}`);
        for (const i of owners) lines.get(i).push(l);
      }
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { lines, unpinned, exits };
}

const classify = ls => ({
  errors: [...new Set(ls.filter(l => l.startsWith('error in ') && msgIdOf(l)).map(msgIdOf))].sort(),
  warnings: [...new Set(ls.filter(l => l.startsWith('warning in ')).map(msgIdOf))].sort(),
  connectivity: ls.filter(l => CONNECTIVITY.test(l)).length,
  other: ls.filter(l => !msgIdOf(l) && !CONNECTIVITY.test(l)),
});

function plyOutcome(bytes) {
  try { return { ply: 'accept', entries: parseTree(new Uint8Array(bytes)) }; } catch (e) {
    if (e?.code !== 'pack_corrupt') return { ply: 'other', message: `${e?.code}: ${e?.message}` };
    return { ply: 'refuse', message: e.message, msgIds: space.msgIdsOfPly(e.message) };
  }
}

// a name's bytes as ply's string for them (bytes.js decodeBytes, as parseTree returns it)
const bytesName = b => decodeBytes(new Uint8Array(b));

const LOOSE_EVERY = process.env.FSCK_TREE_LOOSE ? 1 : 40;
let built, verdicts;

test('fsck tree space: every axis variant cites git, the product is exhaustive, every cell has an expected outcome', () => {
  for (const a of space.AXES) for (const v of a.variants) assert.ok(v.why && v.why.length > 2, `${a.name}.${v.tag} cites why`);
  built = build();
  const raw = space.AXES.reduce((n, a) => n * a.variants.length, 1);
  const collapsed = raw - built.cells.length;
  assert.equal(collapsed, space.AXES.filter(a => a.name !== 'trigger' && a.name !== 'position').reduce((n, a) => n * a.variants.length, 1) * (space.AXES.find(a => a.name === 'position').variants.length - 1), 'only the one-entry trees collapse');
  for (const x of built.cells) assert.ok(x.want.ply === 'accept' || x.want.ply === 'refuse', x.id);
  console.log(`  fsck-tree: ${raw} raw cells, ${built.cells.length} after collapsing one-entry trees, ${built.objects.length} objects`);
});

test('fsck tree space: git fsck --strict agrees with the model on every cell (packed), and a loose sample agrees with the packed run', { timeout: 600_000 }, async () => {
  const { cells, objects } = built;
  const packed = await judge(cells, objects, { loose: false });
  const sample = cells.filter((_, k) => k % LOOSE_EVERY === 0);
  const loose = await judge(sample, objects, { loose: true });
  for (const x of sample) {
    const a = classify(loose.lines.get(x.i)), b = classify(packed.lines.get(x.i));
    assert.deepEqual([a.errors, a.warnings], [b.errors, b.warnings], `loose and packed fsck agree on ${x.id}`);
  }
  // the loose store's exit code says what its lines say: bit 1 iff some error line
  for (const ex of loose.exits) assert.equal(!!(ex.status & 1), ex.errors, `loose fsck exit ${ex.status} matches its lines`);
  const wrong = [];
  for (const x of cells) {
    const g = classify(packed.lines.get(x.i));
    x.git = g;
    if (g.other.length) wrong.push(`${x.id}: unclassified fsck lines ${JSON.stringify(g.other)}`);
    const hasNull = x.entries.some(e => e.oid === 'null'), badTree = g.errors.includes('badTree');
    if (g.connectivity && !hasNull && !badTree) wrong.push(`${x.id}: connectivity lines without a null oid or a bad tree`);
    if (JSON.stringify([g.errors, g.warnings]) !== JSON.stringify([x.want.errors, x.want.warnings])) wrong.push(`${x.id}: model errors ${x.want.errors} warnings ${x.want.warnings}; git errors ${g.errors} warnings ${g.warnings}`);
  }
  if (packed.unpinned.length) assert.ok(cells.some(x => x.git.errors.includes('badTree')), 'git\'s own error: lines come only with a badTree');
  verdicts = packed;
  if (wrong.length) console.log(wrong.slice(0, LIST ? wrong.length : 20).join('\n'));
  assert.deepEqual(wrong.length, 0, `${wrong.length} cells where the model and git disagree`);
  const tally = {};
  for (const x of cells) { const k = x.git.errors.length ? 'error' : x.git.warnings.length ? 'warning-only' : 'clean'; tally[k] = (tally[k] ?? 0) + 1; }
  console.log(`  fsck-tree git: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', ')}; loose sample ${sample.length}`);
});

test('fsck tree space: ply refuses exactly what git errors on (naming one of its msgIds) and reads the rest with git\'s canonical modes', () => {
  assert.ok(verdicts, 'the fsck run');
  const wrong = {}, samples = {};
  let n = 0;
  for (const x of built.cells) {
    const got = plyOutcome(x.bytes);
    let why = null;
    if (got.ply !== x.want.ply) why = `${x.want.ply} -> ${got.ply}${got.message ? ` (${got.message.replace(/".*"/, '"…"')})` : ''}`;
    else if (got.ply === 'refuse' && !(got.msgIds ?? []).some(m => x.git.errors.includes(m))) why = `refused as ${got.message.replace(/".*"/, '"…"')}, git said ${x.git.errors}`;
    else if (got.ply === 'accept') {
      const modes = got.entries.map(e => e.mode), names = got.entries.map(e => Buffer.from(encodeBytes(e.name)).toString('hex'));
      const wantModes = x.entries.map(e => space.canon(space.parseMode(e.mode))), wantNames = x.entries.map(e => e.name.toString('hex'));
      if (JSON.stringify(modes) !== JSON.stringify(wantModes)) why = `modes ${modes} != canon_mode ${wantModes}`;
      else if (JSON.stringify(names) !== JSON.stringify(wantNames)) why = 'names do not round-trip to their bytes';
    }
    if (why) {
      n++;
      const k = `${why} | git: ${[...x.git.errors, ...x.git.warnings.map(w => `${w}(warning)`)].join('+') || 'clean'}`;
      wrong[k] = (wrong[k] ?? 0) + 1;
      (samples[k] ??= []).push(x.id);
    }
  }
  for (const [k, c] of Object.entries(wrong).sort((a, b) => b[1] - a[1])) console.log(`  fsck-tree wrong: ${c} × ${k}${LIST ? `\n    ${samples[k].join('\n    ')}` : ` (e.g. ${samples[k][0]})`}`);
  const accepted = built.cells.filter(x => x.want.ply === 'accept').length;
  console.log(`  fsck-tree ply (${SRC}): ${built.cells.length} cells, ${accepted} accept, ${built.cells.length - accepted} refuse expected; ${n} wrong`);
  assert.equal(n, 0, `${n} cells where ply disagrees with the expected outcome`);
});

test('fsck tree space: the modes git ls-tree prints are canon_mode of the mode bytes (the model\'s canon is git\'s)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-fsck-tree-ls-'));
  try {
    assert.equal((await run('git', ['init', '-q', '--bare', dir])).status, 0);
    const objs = [{ type: 'blob', data: Buffer.alloc(0), oid: EMPTY_BLOB }];
    const sub = Buffer.concat([Buffer.from('100644 f\0'), Buffer.from(EMPTY_BLOB, 'hex')]);
    objs.push({ type: 'tree', data: sub, oid: sha1('tree', sub) });
    const trees = [];
    for (const v of space.AXES.find(a => a.name === 'mode').variants) {
      const c = space.canon(space.parseMode(v.raw));
      const target = c === '40000' ? sha1('tree', sub) : c === '160000' ? 'c0ffee'.padEnd(40, '0') : EMPTY_BLOB;
      const data = Buffer.concat([Buffer.from(`${v.raw} a\0`), Buffer.from(target, 'hex')]);
      objs.push({ type: 'tree', data, oid: sha1('tree', data) });
      trees.push({ v, c, oid: sha1('tree', data) });
    }
    await writeLoose(dir, objs);
    for (const t of trees) {
      const r = await run('git', ['ls-tree', t.oid], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(Number.parseInt(r.stdout.split(' ')[0], 8), Number.parseInt(t.c, 8), `${t.v.raw}: git ls-tree ${r.stdout.trim()}, model ${t.c}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fsck tree space: every entry ply accepts is a path git read-tree checks out with protectHFS and protectNTFS on; checkoutPathRefusal agrees', { timeout: 300_000 }, async () => {
  assert.ok(built, 'the cells');
  // the distinct (name, mode) entries of cells ply accepts, each alone in a tree; plus names git must refuse (the oracle can fail)
  const pairs = new Map();
  for (const x of built.cells) if (x.want.ply === 'accept') for (const e of x.entries) pairs.set(`${e.mode} ${e.name.toString('hex')}`, { mode: e.mode, name: e.name, refuse: false });
  for (const [mode, name] of [['100644', '.git'], ['100644', 'GIT~1'], ['100644', '.git. .'], ['120000', '.gitmodules'], ['120000', '.GITMODULES'], ['100644', '.g‌it']]) pairs.set(`${mode} ${Buffer.from(name).toString('hex')}`, { mode, name: Buffer.from(name), refuse: true });
  const dir = mkdtempSync(join(tmpdir(), 'ply-fsck-tree-co-'));
  try {
    assert.equal((await run('git', ['init', '-q', '--bare', dir])).status, 0);
    const sub = Buffer.concat([Buffer.from('100644 f\0'), Buffer.from(EMPTY_BLOB, 'hex')]);
    const objs = [{ type: 'blob', data: Buffer.alloc(0), oid: EMPTY_BLOB }, { type: 'tree', data: sub, oid: sha1('tree', sub) }];
    const list = [...pairs.values()];
    for (const p of list) {
      const c = space.canon(space.parseMode(p.mode));
      const target = c === '40000' ? sha1('tree', sub) : c === '160000' ? 'c0ffee'.padEnd(40, '0') : EMPTY_BLOB;
      p.data = Buffer.concat([Buffer.from(`${p.mode} `), p.name, Buffer.from([0]), Buffer.from(target, 'hex')]);
      p.oid = sha1('tree', p.data); p.canon = c;
      objs.push({ type: 'tree', data: p.data, oid: p.oid });
    }
    await writeLoose(dir, [...new Map(objs.map(o => [o.oid, o])).values()]);
    const wrong = [];
    await Promise.all(Array.from({ length: 8 }, async (_, s) => {
      for (const p of list.filter((_, k) => k % 8 === s)) {
        const r = await run('git', ['-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true', 'read-tree', p.oid], { cwd: dir, env: { GIT_INDEX_FILE: join(dir, `index-${s}`) } });
        const gitRefuses = r.status !== 0;
        if (gitRefuses && !/invalid path/.test(r.stderr)) wrong.push(`${p.mode} ${JSON.stringify(p.name.toString('latin1'))}: read-tree failed for another reason: ${r.stderr.trim()}`);
        if (gitRefuses !== p.refuse) wrong.push(`${p.mode} ${JSON.stringify(p.name.toString('latin1'))}: git read-tree ${gitRefuses ? 'refuses' : 'accepts'}`);
        const name = bytesName(p.name);
        for (const platform of ['linux', 'darwin']) {
          const why = checkoutPathRefusal(`d/${name}`, p.canon, platform);
          if (!!why !== p.refuse) wrong.push(`${p.mode} ${JSON.stringify(p.name.toString('latin1'))} on ${platform}: checkoutPathRefusal ${why}`);
        }
      }
    }));
    assert.deepEqual(wrong, []);
    console.log(`  fsck-tree checkout: ${list.length} accepted (name, mode) entries, git read-tree with protectHFS+protectNTFS refuses none of them`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('fsck tree space: on Windows, checkoutPathRefusal refuses what git for Windows refuses (compat/mingw.c, derived)', () => {
  const wrong = [];
  for (const [name, refused] of space.WIN32) {
    const why = checkoutPathRefusal(`d/${name}`, '100644', 'win32');
    if (!!why !== refused) wrong.push(`${JSON.stringify(name)}: ${why ?? 'allowed'}, mingw.c ${refused ? 'refuses' : 'allows'}`);
    if (!/[\\:]/.test(name) && !/^(con|aux|prn|nul|com|lpt)/i.test(name) && !/[ .]$/.test(name) && !/[<>"|?*\x01]/.test(name)) assert.equal(checkoutPathRefusal(`d/${name}`, '100644', 'linux'), null, name);
  }
  assert.deepEqual(wrong, []);
});

// ---- .gitattributes contents at git's caps (fsck_blob gitattributesLineLength / gitattributesLarge; attr.c) ----
// fsck errors in the blob at a line of 2048 bytes or more, or a blob over 100 MiB; attr.c ignores such a line, and a blob
// of 100 MiB or more, with a warning. ply's decision: a blob's content is not an object check (parseTree never sees it,
// and git checks such a repository out); where ply reads .gitattributes (merge), it reads them as attr.c does.
const CONTENT = [
  ...[2047, 2048, 2049].flatMap(len => ['100644', '120000'].map(mode => ({ id: `line${len}/${mode}`, len, mode }))),
  ...(process.env.FSCK_TREE_LARGE ? [100 * 1024 * 1024 - 1, 100 * 1024 * 1024, 100 * 1024 * 1024 + 1].map(size => ({ id: `size${size}`, size, mode: '100644' })) : []),
];
const contentOf = c => {
  const head = '*.txt merge=union\n';
  if (c.len) return Buffer.from(`${head}*.c foo=${'v'.repeat(c.len - '*.c foo='.length)}\n`);
  const first = `${head}*.c foo=bar\n`;
  const pad = c.size - first.length;
  const line = `#${'p'.repeat(98)}\n`;
  return Buffer.concat([Buffer.from(first), Buffer.from(line.repeat(Math.floor(pad / line.length))), Buffer.from('#'.repeat(pad % line.length))]);
};

test('fsck tree space: .gitattributes at git\'s line and size caps reads as git check-attr --source reads it; fsck\'s verdict is the model\'s', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-fsck-tree-attr-'));
  try {
    assert.equal((await run('git', ['init', '-q', '--bare', dir])).status, 0);
    const wrong = [];
    for (const c of CONTENT) {
      const data = contentOf(c);
      if (c.len) assert.equal(data.toString().split('\n')[1].length, c.len);
      if (c.size) assert.equal(data.length, c.size);
      const blob = sha1('blob', data);
      const tdata = Buffer.concat([Buffer.from(`${c.mode} .gitattributes\0`), Buffer.from(blob, 'hex'), Buffer.from('100644 x.c\0'), Buffer.from(EMPTY_BLOB, 'hex')]);
      const tree = sha1('tree', tdata);
      await writeLoose(dir, [{ type: 'blob', data, oid: blob }, { type: 'blob', data: Buffer.alloc(0), oid: EMPTY_BLOB }, { type: 'tree', data: tdata, oid: tree }]);
      const ga = await run('git', ['check-attr', `--source=${tree}`, '-a', 'x.c', 'x.txt'], { cwd: dir });
      assert.equal(ga.status, 0, ga.stderr);
      const gitAttrs = ga.stdout.trim().split('\n').filter(Boolean).map(l => l.replace(/^x\.(c|txt): /, '$1 ')).sort();
      const files = new Map([['', bytesToStr(data)]]);
      const ours = ['c', 'txt'].flatMap(ext => [...attributesFor(`x.${ext}`, files)].filter(([, v]) => v !== null).map(([k, v]) => `${ext} ${k}: ${v === true ? 'set' : v === false ? 'unset' : v}`)).sort();
      if (JSON.stringify(ours) !== JSON.stringify(gitAttrs)) wrong.push(`${c.id}: ply ${JSON.stringify(ours).slice(0, 200)}, git ${JSON.stringify(gitAttrs).slice(0, 200)}`);
      // fsck: a blob over a cap is an error in the blob; a symlink is a warning in the tree and its content is not read
      const f = await run('git', ['fsck', '--strict', '--no-dangling'], { cwd: dir });
      const ids = [...`${f.stdout}\n${f.stderr}`.matchAll(/(?:error|warning) in \w+ ([0-9a-f]{40}): (\w+):/g)].filter(m => m[1] === blob || m[1] === tree).map(m => m[2]).sort();
      const model = c.mode === '120000' ? ['gitattributesSymlink'] : (c.len >= 2048 || c.size > 100 * 1024 * 1024) ? [c.len ? 'gitattributesLineLength' : 'gitattributesLarge'] : [];
      if (JSON.stringify(ids) !== JSON.stringify(model)) wrong.push(`${c.id}: fsck ${ids}, model ${model}`);
      assert.ok(plyOutcome(tdata).ply === 'accept', `${c.id}: the tree itself is one ply accepts`);
      await run('git', ['prune', '--expire=now'], { cwd: dir });
      rmSync(join(dir, 'objects'), { recursive: true, force: true }); mkdirSync(join(dir, 'objects', 'pack'), { recursive: true }); mkdirSync(join(dir, 'objects', 'info'), { recursive: true });
    }
    assert.deepEqual(wrong, []);
    console.log(`  fsck-tree .gitattributes: ${CONTENT.length} cells agree with check-attr and fsck${process.env.FSCK_TREE_LARGE ? '' : ' (FSCK_TREE_LARGE=1 adds the 100 MiB cells)'}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fsck tree space: SPACE.md\'s generated block is current', async () => {
  const doc = await import('../../scripts/space-md.mjs');
  assert.equal(doc.currentFsckTree(), doc.fsckTreeBlock(), 'SPACE.md is stale: run node scripts/space-md.mjs --write');
});
