// Real-git oracles for the codec layer: our bytes vs git's bytes, our parse vs git's pack writer.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { Rng } from './fuzz/prng.js';
import { genBlob } from './fuzz/gen.js';
import { parseTree, encodeTree, hashObject, TYPE_NAME } from '../src/objects.js';
import { parsePack, resolvePack, buildPack, makeDelta } from '../src/pack.js';
import { GitHttp } from '../src/client.js';
import { Tracer, arrayExporter } from '../src/otel.js';
import { toHex } from '../src/sha1.js';

const SEED = parseInt(process.env.SEED ?? '7', 10);
let root, cleanup, srv, bare, work;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  bare = makeBareRepo(root, 'o');
  work = join(root, 'work'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  srv = await startGitServer(root);
});
after(async () => { await srv.close(); cleanup(); });

const EDGE = ['a', 'a-b', 'a.b', 'a0', 'a_b', 'ab', 'A', 'a~', 'z', 'é', 'a b', 'a--', '-a', '.h', 'ä', '한', '🚀', 'b'];

test('tree encoding: our tree oid == git write-tree for sort-edge names, modes, symlinks', () => {
  const rng = new Rng(SEED);
  for (let round = 0; round < 8; round++) {
    const files = {};
    const dirs = new Set();
    for (const n of EDGE) {
      const r = rng.float();
      if (r < 0.35) files[n] = { mode: '100644', data: genBlob(rng, 'tiny') };
      else if (r < 0.5) files[n] = { mode: '100755', data: genBlob(rng, 'tiny') };
      else if (r < 0.7) { files[`${n}/inner${rng.int(0, 3)}`] = { mode: '100644', data: genBlob(rng, 'tiny') }; dirs.add(n); }
    }
    // staged with plumbing, not the filesystem: 'A' and 'a' coexist in git but not on a case-insensitive disk (macOS)
    const sub = join(root, `tree${round}`); mkdirSync(sub); git(sub, ['init', '-q']);
    const stage = (mode, path, data) => git(sub, ['update-index', '--add', '--cacheinfo', `${mode},${gitBuf(sub, ['hash-object', '-w', '--stdin'], data).toString().trim()},${path}`]);
    for (const [p, v] of Object.entries(files)) stage(v.mode, p, v.data);
    if (rng.bool(0.5) && !files.lnk) stage('120000', 'lnk', 'a');
    const treeOid = git(sub, ['write-tree']).trim();
    const raw = gitBuf(sub, ['cat-file', 'tree', treeOid]);
    const entries = parseTree(new Uint8Array(raw));
    assert.equal(hashObject('tree', encodeTree(entries)), treeOid, `round ${round}`);
    // shuffle then re-encode must still match (sort is ours, not git's order)
    const shuffled = [...entries].sort(() => rng.float() - 0.5);
    assert.equal(hashObject('tree', encodeTree(shuffled)), treeOid);
    // git ls-tree agreement on modes
    const ls = git(sub, ['ls-tree', treeOid]).trim().split('\n').map(l => l.split(/\s+/)[0]);
    assert.deepEqual(entries.map(e => e.mode.padStart(6, '0')), ls);
  }
});

test('blob/commit oids == git hash-object', () => {
  const rng = new Rng(SEED + 1);
  for (const cls of ['empty', 'tiny', 'text', 'random', 'boundary', 'binaryish']) {
    const d = genBlob(rng, cls);
    assert.equal(hashObject('blob', d), gitBuf(work, ['hash-object', '--stdin'], d).toString().trim(), cls);
  }
});

test('git pack-objects (ofs-delta, varied window/depth/compression) parses and resolves to git cat-file truth', async () => {
  const rng = new Rng(SEED + 2);
  // repo with history so deltas exist
  const sub = join(root, 'packrepo'); mkdirSync(sub); git(sub, ['init', '-q', '-b', 'main']);
  let text = genBlob(rng, 'text');
  for (let i = 0; i < 6; i++) {
    const files = {};
    for (let f = 0; f < 5; f++) { const o = rng.int(0, text.length); text = new Uint8Array([...text.subarray(0, o), ...rng.bytes(rng.int(1, 40)), ...text.subarray(o)]); files[`d${f % 2}/f${f}.txt`] = text; }
    files[`bin${i}`] = genBlob(rng, rng.pick(['random', 'repetitive', 'boundary', 'empty']));
    for (const [p, v] of Object.entries(files)) { mkdirSync(join(sub, p, '..'), { recursive: true }); writeFileSync(join(sub, p), v); }
    git(sub, ['add', '-A']); git(sub, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', `c${i}`]);
  }
  const truth = new Map(git(sub, ['cat-file', '--batch-check', '--batch-all-objects']).trim().split('\n').map(l => { const [oid, type, size] = l.split(' '); return [oid, { type, size: +size }]; }));
  for (const [window, depth, comp] of [[10, 50, 0], [1, 1, 1], [250, 50, 9], [0, 0, 6], [5, 2, -1]]) {
    const pack = new Uint8Array(gitBuf(sub, ['-c', `pack.compression=${comp}`, 'pack-objects', '--delta-base-offset', `--window=${window}`, `--depth=${depth}`, '--all', '--stdout', '--revs'], 'HEAD\n'));
    const parsed = parsePack(pack);
    assert.equal(parsed.stats.count, truth.size, `all objects (w${window} d${depth} c${comp})`);
    const r = resolvePack(parsed);
    for (const [oid, t] of truth) {
      const o = r.objects.get(oid);
      assert.ok(o, `missing ${oid}`);
      assert.equal(TYPE_NAME[o.type], t.type); assert.equal(o.data.length, t.size);
      assert.ok(Buffer.from(o.data).equals(gitBuf(sub, ['cat-file', t.type, oid])), `content ${oid}`);
    }
    // chain depth vs verify-pack
    const pdir = join(root, `vp-${window}-${depth}-${comp}`); mkdirSync(pdir);
    writeFileSync(join(pdir, 'p.pack'), pack);
    git(sub, ['index-pack', join(pdir, 'p.pack')]);
    const vp = git(sub, ['verify-pack', '-v', join(pdir, 'p.pack')]).split('\n').filter(l => /^[0-9a-f]{40} (commit|tree|blob)/.test(l));
    for (const l of vp) {
      const [oid, , , , offset, chain] = l.trim().split(/\s+/);
      const o = r.objects.get(oid);
      assert.equal(o.offset, +offset, `offset ${oid}`);
      assert.equal(o.chain, chain ? +chain : 0, `chain ${oid}`);
    }
    if (depth > 0 && window > 0) assert.ok(parsed.stats.ofsDelta > 0, 'git produced ofs deltas');
    if (comp === 0) assert.ok(parsed.stats.inflate.stored > 0, 'level 0 → stored blocks seen');
  }
});

test('thin pack from our buildPack is accepted by git index-pack --fix-thin and yields the expected oid', async () => {
  const rng = new Rng(SEED + 3);
  const base = genBlob(rng, 'text');
  const baseOid = gitBuf(work, ['hash-object', '-w', '--stdin'], base).toString().trim();
  const target = new Uint8Array([...base.subarray(0, 100), ...rng.bytes(300), ...base.subarray(200)]);
  const { pack } = await buildPack([{ type: 3, data: makeDelta(base, target).delta, baseOid }]);
  const out = gitBuf(work, ['index-pack', '--stdin', '--fix-thin', '-v'], pack).toString();
  const targetOid = hashObject('blob', target);
  assert.ok(Buffer.from(gitBuf(work, ['cat-file', 'blob', targetOid])).equals(Buffer.from(target)), out);
});

test('v2 fetch filter=blob:none deepen=1 returns exactly git rev-list --objects --filter=blob:none set; tree:0 returns one', async () => {
  const head = commitFiles(work, bare, { 'a/b/c.txt': 'c', 'a/d.txt': 'd', 'e/f/g/h.txt': 'h', 'top.txt': 'top' }, 'one');
  const head2 = commitFiles(work, bare, { 'top.txt': 'top2' }, 'two');
  const tracer = new Tracer({ exporter: arrayExporter() });
  const c = new GitHttp(`${srv.url}/o.git`, { tracer });
  const { refs } = await c.lsRefs(['refs/heads/main']);
  assert.equal(refs.get('refs/heads/main').oid, head2);
  const r = await c.fetchPack({ wants: [head2], filter: 'blob:none', deepen: 1 });
  const expected = git(bare, ['rev-list', '--objects', '--no-object-names', '--filter=blob:none', '--max-count=1', head2]).trim().split('\n').sort();
  assert.deepEqual([...r.objects.keys()].sort(), expected);
  assert.ok(r.parsed.stats.byType.blob === undefined);
  const r0 = await c.fetchPack({ wants: [head2], filter: 'tree:0', deepen: 1 });
  assert.equal(r0.parsed.stats.count, 1);
  // deepen 1 on a 2-commit history reports shallow
  const span = tracer.exporter.lines.flatMap(l => l.resourceSpans[0].scopeSpans[0].spans).find(s => s.name === 'git.upload-pack fetch');
  assert.ok(span.attributes.find(a => a.key === 'git.fetch.shallow').value.arrayValue.values.length === 1);
  // tree:N is NOT a subset of blob:none: it includes blobs at depth < N (oracle-verified; top.txt comes back).
  const r3 = await c.fetchPack({ wants: [head2], filter: 'tree:2', deepen: 1 });
  assert.ok([...r3.objects.values()].some(o => TYPE_NAME[o.type] === 'blob'), 'tree:2 includes depth-1 blobs');
  // combine:blob:none+tree:N is the real "trees to depth N, no blobs" filter, a strict subset of blob:none.
  const r4 = await c.fetchPack({ wants: [head2], filter: 'combine:blob:none+tree:2', deepen: 1 });
  assert.ok([...r4.objects.values()].every(o => TYPE_NAME[o.type] !== 'blob'));
  assert.ok(r4.parsed.stats.count < r.parsed.stats.count);
  for (const oid of r4.objects.keys()) assert.ok(r.objects.has(oid));
  // want an arbitrary blob by oid
  const blobOid = git(bare, ['rev-parse', `${head}:a/b/c.txt`]).trim();
  const rb = await c.fetchPack({ wants: [blobOid] });
  assert.equal(new TextDecoder().decode(rb.objects.get(blobOid).data), 'c');
});
