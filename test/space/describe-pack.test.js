// describePack against packs git wrote. verify-pack -v is the row oracle; index-pack --fix-thin is the thin-base oracle.
// A limit probe uses git's own columns for the boundary (header size, chain depth, cat-file size of each delta).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describePack } from '../../src/pack.js';
import { TYPE, TYPE_ID } from '../../src/objects.js';
import { toHex } from '../../src/sha1.js';
import { DEFAULT_LIMITS, withLimits } from '../../src/limits.js';
import { PACK_TRAILER_BYTES, PACK_VERSION } from '../../src/format.js';
import { CONTENTS, COMPRESSION, OFS, DEPTH, THIN, PACK_CELLS, LIMIT_PROBES, CELL_COUNT, REPRESENTATIVE } from './describe-pack.space.js';

const ENV = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8',
};
const ROW = /^([0-9a-f]{40})\s+(commit|tree|blob|tag)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+)\s+([0-9a-f]{40}))?$/;
const NON = /^non delta: (\d+) objects?$/;
const CHAIN = /^chain length = (\d+): (\d+) objects?$/;

const git = (cwd, args, input) => execFileSync('git', args, { cwd, env: ENV, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const gitText = (cwd, args, input) => git(cwd, args, input).toString('utf8');
const commit = (repo, message) => {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=g', '-c', 'user.email=g@x', 'commit', '-q', '-m', message]);
};
const file = (repo, name, n, mark) => {
  const b = Buffer.alloc(n, 0x41);
  if (mark !== undefined) b.set(Buffer.from(mark), 0);
  writeFileSync(join(repo, name), b);
};

function makeRepo(root, content) {
  const repo = join(root, content);
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  if (content === 'blob' || content === 'commit') {
    file(repo, 'a.txt', 32, 'a');
    commit(repo, 'c');
  } else if (content === 'tag') {
    file(repo, 'a.txt', 2000, 'a');
    commit(repo, 'base');
    file(repo, 'a.txt', 2000, 'b');
    commit(repo, 'tip');
    git(repo, ['-c', 'user.name=g', '-c', 'user.email=g@x', 'tag', '-a', 'v1', '-m', 'annotated']);
  } else if (content === 'history') {
    for (let i = 0; i < 6; i++) {
      file(repo, 'a.txt', 2000, `h${i}`);
      commit(repo, `c${i}`);
    }
  } else if (content === 'fan') {
    for (let i = 0; i < 4; i++) file(repo, `f${i}.txt`, 1500, `f${i}`);
    commit(repo, 'base');
    for (let i = 0; i < 4; i++) file(repo, `f${i}.txt`, 1500, `g${i}`);
    commit(repo, 'tip');
  } else throw new Error(content);
  return repo;
}

function packInput(repo, content, thin) {
  if (content === 'blob') return { args: [], input: `${gitText(repo, ['rev-parse', 'HEAD:a.txt']).trim()}\n` };
  const revs = ['--revs'];
  if (content === 'tag') return { args: revs, input: thin ? 'refs/tags/v1\n^HEAD~1\n' : 'refs/tags/v1\n' };
  if (thin && content !== 'commit') return { args: revs, input: 'HEAD\n^HEAD~1\n' };
  return { args: revs, input: 'HEAD\n' };
}

function parseVerify(text) {
  const rows = [];
  let non = null;
  const chains = new Map();
  for (const line of text.split('\n')) {
    const t = line.trim();
    const row = ROW.exec(t);
    if (row) {
      rows.push({
        oid: row[1], type: row[2], size: Number(row[3]), packed: Number(row[4]), offset: Number(row[5]),
        depth: row[6] ? Number(row[6]) : 0, base: row[7] ?? null,
      });
      continue;
    }
    const nd = NON.exec(t);
    if (nd) non = Number(nd[1]);
    const ch = CHAIN.exec(t);
    if (ch) chains.set(Number(ch[1]), Number(ch[2]));
  }
  assert.notEqual(non, null, text);
  let gotNon = 0;
  const gotChains = new Map();
  for (const r of rows) {
    if (r.depth === 0) gotNon++;
    else gotChains.set(r.depth, (gotChains.get(r.depth) ?? 0) + 1);
  }
  assert.equal(non, gotNon, text);
  assert.equal(gotChains.size, chains.size, text);
  for (const [d, n] of gotChains) assert.equal(chains.get(d), n, `chain ${d}`);
  return rows;
}

function eqRow(o, row, label) {
  assert.equal(o.size, row.size, `${label} size`);
  assert.equal(o.headerBytes + o.compressed, row.packed, `${label} size-in-pack`);
  assert.equal(o.offset, row.offset, `${label} offset`);
  assert.equal(o.depth, row.depth, `${label} depth`);
  if (row.depth === 0) assert.equal(o.wireType, TYPE_ID[row.type], `${label} wire`);
  else assert.ok(o.wireType === TYPE.OFS_DELTA || o.wireType === TYPE.REF_DELTA, `${label} delta wire ${o.wireType}`);
  if (o.oid === null) {
    assert.equal(o.type, null, label);
    assert.ok(o.depth >= 1, label);
  } else {
    assert.equal(o.oid, row.oid, `${label} oid`);
    assert.equal(TYPE_ID[row.type], o.type, `${label} type`);
  }
  if (row.base === null) assert.equal(o.base, null, `${label} base`);
  else if (o.base && 'offset' in o.base) {
    if (o.base.oid !== null) assert.equal(o.base.oid, row.base, `${label} ofs base`);
    else assert.equal(o.oid, null, label);
  } else assert.equal(o.base?.oid, row.base, `${label} ref base`);
}

const hashOf = text => {
  const m = text.match(/[0-9a-f]{40}/g);
  assert.ok(m, text);
  return m[m.length - 1];
};

function verifySelf(scratch, bytes, layout) {
  const packPath = join(scratch, 'p.pack');
  const idxPath = join(scratch, 'p.idx');
  rmSync(packPath, { force: true });
  rmSync(idxPath, { force: true });
  writeFileSync(packPath, bytes);
  const sum = hashOf(gitText(scratch, ['index-pack', packPath]));
  assert.equal(layout.trailer, sum);
  const rows = parseVerify(gitText(scratch, ['verify-pack', '-v', packPath]));
  assert.equal(layout.count, rows.length);
  assert.equal(layout.objects.length, rows.length);
  assert.deepEqual(layout.missingBases, []);
  const byOff = new Map(rows.map(r => [r.offset, r]));
  for (const o of layout.objects) eqRow(o, byOff.get(o.offset), `off ${o.offset}`);
  return rows;
}

function verifyThin(repo, bytes, layout) {
  let bare;
  try { bare = gitText(repo, ['index-pack', '--stdin'], bytes); } catch (e) { bare = `${e.stderr ?? e.message}`; }
  assert.match(bare, /unresolved delta/);
  const fixedHash = hashOf(gitText(repo, ['index-pack', '--stdin', '--fix-thin'], bytes));
  const fixedPath = join(repo, '.git', 'objects', 'pack', `pack-${fixedHash}.pack`);
  const rows = parseVerify(gitText(repo, ['verify-pack', '-v', fixedPath]));
  const cut = bytes.length - PACK_TRAILER_BYTES;
  const appended = rows.filter(r => r.offset >= cut);
  const kept = rows.filter(r => r.offset < cut);
  // git 2.43 appends those bases in the same order describePack reports: first-seen in pack order.
  assert.deepEqual(layout.missingBases, appended.map(r => r.oid));
  assert.equal(layout.objects.length, kept.length);
  const byOff = new Map(kept.map(r => [r.offset, r]));
  for (const o of layout.objects) eqRow(o, byOff.get(o.offset), `thin off ${o.offset}`);
  assert.equal(layout.trailer, toHex(bytes.subarray(bytes.length - PACK_TRAILER_BYTES)));
  return kept;
}

test('describePack matches git verify-pack over the pack product and at every limit boundary', { timeout: 180_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ply-describe-'));
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  git(scratch, ['init', '-q']);
  const repos = new Map(CONTENTS.map(c => [c, makeRepo(root, c)]));
  let packs = 0;
  let thinHits = 0;
  let multiBase = 0;
  let rep = null;
  const built = [];
  for (const content of CONTENTS) for (const compression of COMPRESSION) for (const ofs of OFS) for (const depth of DEPTH) for (const thin of THIN) {
    const repo = repos.get(content);
    const { args, input } = packInput(repo, content, thin);
    const window = depth === 0 ? 0 : depth;
    const cmd = ['-c', `pack.compression=${compression}`, '-c', 'pack.threads=1', 'pack-objects', '--stdout', `--depth=${depth}`, `--window=${window}`, ...args];
    if (ofs) cmd.push('--delta-base-offset');
    if (thin) cmd.push('--thin');
    built.push({ content, compression, ofs, depth, thin, repo, bytes: new Uint8Array(git(repo, cmd, input)) });
  }
  try {
    for (const cell of built) {
      const { content, compression, ofs, depth, thin, repo, bytes } = cell;
      const described = describePack(bytes);
      const label = `${content} c${compression} ofs${ofs} d${depth} thin${thin}`;
      assert.equal(described.ok, true, label);
      if (!described.ok) continue;
      const layout = described.value;
      assert.equal(layout.version, PACK_VERSION, label);
      assert.equal(layout.count, layout.objects.length, label);
      let rows;
      if (layout.missingBases.length === 0) rows = verifySelf(scratch, bytes, layout);
      else {
        assert.equal(thin, true, `${label} produced a thin base without --thin`);
        rows = verifyThin(repo, bytes, layout);
        thinHits++;
        if (layout.missingBases.length >= 2) multiBase++;
      }
      packs++;
      if (content === REPRESENTATIVE.content && compression === REPRESENTATIVE.compression && ofs === REPRESENTATIVE.ofs && depth === REPRESENTATIVE.depth && thin === REPRESENTATIVE.thin) {
        rep = { repo, bytes, rows };
      }
    }
    assert.equal(packs, PACK_CELLS);
    assert.ok(thinHits > 0, 'no cell was a thin pack');
    assert.ok(multiBase > 0, 'no thin pack had two missing bases');
    assert.ok(rep, 'representative pack was not built');
    const maxHeader = Math.max(...rep.rows.map(r => r.size));
    const maxDepth = Math.max(...rep.rows.map(r => r.depth));
    const deltaSizes = rep.rows.filter(r => r.depth > 0).map(r => Number(gitText(rep.repo, ['cat-file', '-s', r.oid]).trim()));
    assert.ok(maxDepth >= 1 && deltaSizes.length > 0, 'representative pack has no delta');
    const headerSum = rep.rows.reduce((n, r) => n + r.size, 0);
    const maxDelta = Math.max(...deltaSizes);
    const bounds = [
      ['maxPackObjects', rep.rows.length, 'pack objects'],
      ['maxObjectSize', maxHeader, 'pack object size'],
      ['maxInflatedTotal', headerSum + deltaSizes.reduce((n, s) => n + s, 0), 'delta result size'],
      ['maxDeltaChain', maxDepth, 'delta chain depth'],
      ['maxDeltaResult', maxDelta, 'delta result size'],
    ];
    let probes = 0;
    for (const [name, boundary, what] of bounds) {
      assert.equal(describePack(rep.bytes, withLimits({ [name]: boundary })).ok, true, `${name}=${boundary}`);
      const under = describePack(rep.bytes, withLimits({ [name]: boundary - 1 }));
      assert.equal(under.ok, false, `${name}=${boundary - 1}`);
      if (!under.ok) {
        assert.equal(under.error.code, 'limit_exceeded');
        assert.equal(under.error.what, what, `${name} refused as ${under.error.what}`);
      }
      probes += 2;
    }
    const nan = describePack(rep.bytes, withLimits({ maxPackObjects: Number.NaN }));
    assert.equal(nan.ok, false);
    if (!nan.ok) {
      assert.equal(nan.error.code, 'bad_request');
      assert.equal(nan.error.what, 'maxPackObjects');
    }
    const missing = { ...DEFAULT_LIMITS };
    delete missing.maxDeltaChain;
    const gone = describePack(rep.bytes, missing);
    assert.equal(gone.ok, false);
    if (!gone.ok) {
      assert.equal(gone.error.code, 'bad_request');
      assert.equal(gone.error.what, 'maxDeltaChain');
    }
    probes += 2;
    assert.equal(probes, LIMIT_PROBES);
    assert.equal(packs + probes, CELL_COUNT);
    console.log(`describe-pack: ${packs} packs, ${thinHits} thin (${multiBase} with two or more bases), ${probes} limit probes`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
