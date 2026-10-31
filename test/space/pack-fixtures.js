// Real git-produced packs for the pack-cut space. Every pack is written by `git pack-objects` (git's own writer), never
// by ply: a cell that cuts or corrupts one starts from bytes an honest server sends. Built once per process in a temp
// repository; the objects are fixed text, so the packs are the same bytes on every run of the same git.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'ply', GIT_AUTHOR_EMAIL: 'ply@example.com', GIT_COMMITTER_NAME: 'ply', GIT_COMMITTER_EMAIL: 'ply@example.com', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() };

export function git(dir, args, input) {
  return execFileSync('git', args, { cwd: dir, env: ENV, input, maxBuffer: 1 << 28 });
}
const line = (dir, args, input) => git(dir, args, input).toString().trim();

// A blob that slides one block of pseudo-random lines per version (v_i = B_i..B_i+3): each version is closest to its
// neighbour, so pack-objects deltas the four versions into an OFS chain.
const lcg = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648);
const block = (seed, n) => { const r = lcg(seed); return Array.from({ length: n }, () => `${r().toString(36)} ${r().toString(36)}\n`).join(''); };
const text = i => Array.from({ length: 4 }, (_, k) => block(i + k + 1, 40)).join('');

export function buildPacks() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-pack-cut-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'pack.compression', '9']);
    const v = [];
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, 'f.txt'), text(i));
      writeFileSync(join(dir, 'g.txt'), `small ${i}\n`);
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', `v${i}`]);
      v.push(line(dir, ['rev-parse', 'HEAD']));
    }
    git(dir, ['tag', '-a', '-m', 'annotated', 't1', v[0]]);
    const oid = rev => line(dir, ['rev-parse', rev]);
    const objs = {
      commit: v[0], tree: oid(`${v[0]}^{tree}`), blob: oid(`${v[0]}:g.txt`), tag: oid('t1'),
      big1: oid(`${v[0]}:f.txt`), big2: oid(`${v[1]}:f.txt`), big3: oid(`${v[2]}:f.txt`), big4: oid(`${v[3]}:f.txt`),
    };
    const pack = (oids, args = []) => new Uint8Array(git(dir, ['pack-objects', '--stdout', '-q', ...args], `${oids.join('\n')}\n`));
    const packs = {
      // non-delta, one object of each type (commit, tree, blob, tag): what a full pack of distinct small objects is
      full: { bytes: pack([objs.commit, objs.tree, objs.blob, objs.big1, objs.tag], ['--no-reuse-delta', '--window=0']), want: objs.commit, kind: 'non-delta, every type' },
      // OFS_DELTA: one base and one delta (pack-objects --delta-base-offset, as upload-pack asks with ofs-delta)
      ofs: { bytes: pack([objs.big1, objs.big2], ['--delta-base-offset', '--no-reuse-delta']), want: objs.big2, kind: 'OFS_DELTA' },
      // REF_DELTA: the same objects without ofs-delta
      ref: { bytes: pack([objs.big1, objs.big2], ['--no-reuse-delta']), want: objs.big2, kind: 'REF_DELTA' },
      // an OFS chain three deep
      chain: { bytes: pack([objs.big1, objs.big2, objs.big3, objs.big4], ['--delta-base-offset', '--no-reuse-delta', '--depth=50']), want: objs.big4, kind: 'OFS chain' },
      // a thin pack: REF_DELTA against a base the pack does not carry (fetch with thin-pack)
      thin: { bytes: new Uint8Array(git(dir, ['pack-objects', '--stdout', '-q', '--thin', '--revs', '--no-reuse-delta'], `${v[1]}\n^${v[0]}\n`)), want: v[1], kind: 'thin REF_DELTA', external: true },
    };
    // single-object packs: what a tree:0 / one-want fetch returns (the streamed spStep path)
    const single = {};
    for (const t of ['commit', 'tree', 'blob', 'tag']) single[t] = { bytes: pack([objs[t]]), want: objs[t], type: t };
    // the thin pack's external bases, as {type, data} by oid
    const bases = new Map();
    for (const o of [objs.big1, objs.blob, oid(`${v[0]}^{tree}`), v[0]]) bases.set(o, { type: line(dir, ['cat-file', '-t', o]), data: new Uint8Array(git(dir, ['cat-file', line(dir, ['cat-file', '-t', o]), o])) });
    const version = line(dir, ['version']);
    return { packs, single, objs, bases, version };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// git index-pack --strict on the bytes, as the oracle: { ok, msg }. In a scratch repository that holds the thin
// pack's bases, so --fix-thin can complete a thin pack the way a receiving git would.
export function indexPackOracle() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-pack-oracle-'));
  git(dir, ['init', '-q', '--bare']);
  let n = 0;
  return {
    dir,
    run(bytes, { thin = false } = {}) {
      const f = join(dir, `c${n++ % 4}.pack`);
      if (!thin) writeFileSync(f, bytes);
      try {
        // --fix-thin needs --stdin (it appends the bases to a pack it writes into the repository)
        if (thin) execFileSync('git', ['index-pack', '--stdin', '--strict', '--fix-thin'], { cwd: dir, env: ENV, input: bytes, stdio: ['pipe', 'pipe', 'pipe'] });
        else execFileSync('git', ['index-pack', '--strict', '-o', `${f}.idx`, f], { cwd: dir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, msg: '' };
      } catch (e) { return { ok: false, msg: String(e.stderr ?? '').trim().split('\n').pop() }; }
    },
    seed(bytes) { git(dir, ['index-pack', '--stdin', '--strict'], bytes); },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}
