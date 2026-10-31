// Fuzz the pack we PRODUCE. For random (repo, path, edit) shapes, build the thin push pack exactly as editFile does
// and let git judge it: index-pack --fix-thin --strict must accept it, and the resulting objects must be byte-identical
// to those from a full-object (non-delta) pack of the same edit and to git's own objects after applying the edit with
// git itself. Targets delta-op boundaries (64 KiB copies, 127-byte inserts), deep paths, odd names, tree sizes.
//   node test/fuzz/packgen.mjs [--n 200] [--seed 1]
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { git, gitBuf, tmpRoot, fsckProblems } from '../server.js';
import { Rng } from './prng.js';
import { parseTree, treeReplaceOid, hashObject, encodeCommit, TYPE } from '../../src/objects.js';
import { spliceDelta, buildPack, makeDelta } from '../../src/pack.js';
import { fromHex } from '../../src/sha1.js';
import { concat, te } from '../../src/bytes.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '200', 10), SEED = parseInt(args.seed ?? String(Date.now() % 1e9), 10);
const { root, cleanup } = tmpRoot();
const fails = [], cov = new Map();
const bump = k => cov.set(k, (cov.get(k) ?? 0) + 1);
try {
  for (let i = 0; i < N; i++) {
    const seed = (SEED * 7919 + i * 104729) >>> 0, rng = new Rng(seed);
    const work = join(root, `w${i}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
    // shape
    const depth = rng.weighted([[1, 3], [2, 3], [3, 2], [6, 1], [12, 1]]);
    const nameOf = () => rng.pick(['a', 'b-c', 'd.e', 'f g', '-h', '.i', 'ü', '日本', 'x'.repeat(rng.int(1, 60)), 'z' + rng.int(0, 99)]);
    const comps = Array.from({ length: depth }, nameOf); const path = comps.join('/');
    const blobLen = rng.weighted([[0, 1], [1, 1], [rng.int(2, 200), 4], [rng.int(60000, 70000), 2], [rng.int(130000, 140000), 2], [rng.int(300, 5000), 3]]);
    const base = rng.bool(0.5) ? Buffer.alloc(blobLen, rng.int(0, 255)) : Buffer.from(Array.from({ length: blobLen }, () => rng.int(0, 255)));
    const off = rng.pick([0, blobLen, blobLen >> 1, Math.min(blobLen, 65535), Math.min(blobLen, 65536), Math.min(blobLen, 65537), Math.min(blobLen, 131072), rng.int(0, blobLen)]);
    const oldLen = Math.min(blobLen - off, rng.pick([0, 1, 7, 127, 128, 255, 256, rng.int(0, 300)]));
    const insert = Buffer.from(Array.from({ length: rng.pick([0, 1, 126, 127, 128, 254, 255, 256, rng.int(0, 2000)]) }, () => rng.int(0, 255)));
    const target = Buffer.concat([base.subarray(0, off), insert, base.subarray(off + oldLen)]);
    if (target.equals(base)) { rmSync(work, { recursive: true, force: true }); continue; } // noop edits never reach the pack builder
    // siblings so trees are non-trivial
    const files = { [path]: base };
    for (let k = rng.int(0, 30); k > 0; k--) { const d = rng.int(0, depth - 1); files[[...comps.slice(0, d), 's' + rng.int(0, 9999)].join('/')] = Buffer.from('s'); }
    for (const [p, v] of Object.entries(files)) { mkdirSync(join(work, p, '..'), { recursive: true }); writeFileSync(join(work, p), v); }
    git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'base'], { env });
    const oldCommit = git(work, ['rev-parse', 'HEAD']).trim();
    // git's own version of the edit (the reference objects)
    writeFileSync(join(work, path), target); git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'edit'], { env });
    const refCommit = git(work, ['rev-parse', 'HEAD']).trim(), refTree = git(work, ['rev-parse', 'HEAD^{tree}']).trim(), refBlob = git(work, ['rev-parse', `HEAD:${path}`]).trim();
    git(work, ['reset', '-q', '--hard', oldCommit]);
    // our objects: walk trees from the old commit (what editFile holds), splice, build thin pack
    const levels = []; let treeOid = git(work, ['rev-parse', `${oldCommit}^{tree}`]).trim();
    for (const name of comps) { const data = new Uint8Array(gitBuf(work, ['cat-file', 'tree', treeOid])); const entry = parseTree(data).find(e => e.name === name); levels.push({ treeOid, data, entry }); treeOid = entry.oid; }
    const oldBlob = treeOid;
    const newBlob = hashObject('blob', new Uint8Array(target));
    const blobDelta = spliceDelta({ baseLen: base.length, off, oldLen, insert: new Uint8Array(insert) }).delta;
    const treeObjs = []; let child = newBlob;
    for (let l = levels.length - 1; l >= 0; l--) { const { treeOid: oldT, data, entry } = levels[l]; const nd = treeReplaceOid(data, entry, child); const nid = hashObject('tree', nd); treeObjs.unshift({ data: spliceDelta({ baseLen: data.length, off: entry.oidOffset, oldLen: 20, insert: fromHex(child) }).delta, full: nd, baseOid: oldT, newOid: nid }); child = nid; }
    const commitData = encodeCommit({ tree: child, parents: [oldCommit], author: 'p <p@x> 1700000000 +0000', committer: 'p <p@x> 1700000000 +0000', message: 'edit\n' });
    const newCommit = hashObject('commit', commitData);
    const problems = [];
    if (newBlob !== refBlob) problems.push(`blob oid ${newBlob.slice(0, 8)} != git ${refBlob.slice(0, 8)}`);
    if (child !== refTree) problems.push(`tree oid ${child.slice(0, 8)} != git ${refTree.slice(0, 8)}`);
    if (newCommit !== refCommit) problems.push(`commit oid != git (${newCommit.slice(0, 8)} vs ${refCommit.slice(0, 8)})`);
    const thinObjs = [{ type: TYPE.COMMIT, data: commitData }, ...treeObjs.map(t => ({ type: TYPE.TREE, data: t.data, baseOid: t.baseOid })), blobDelta.length >= 4 ? { type: TYPE.BLOB, data: blobDelta, baseOid: oldBlob } : { type: TYPE.BLOB, data: new Uint8Array(target) }];
    const fullObjs = [{ type: TYPE.COMMIT, data: commitData }, ...treeObjs.map(t => ({ type: TYPE.TREE, data: t.full })), { type: TYPE.BLOB, data: new Uint8Array(target) }];
    const { pack: thin } = await buildPack(thinObjs), { pack: full } = await buildPack(fullObjs);
    // git judges: both packs must index strictly in a repo that has only the OLD objects
    const judge = join(root, `j${i}`); execFileSync('git', ['clone', '-q', '--bare', work, judge]); git(judge, ['update-ref', 'refs/heads/main', oldCommit]); git(judge, ['reflog', 'expire', '--expire=now', '--all']); git(judge, ['gc', '-q', '--prune=now']);
    for (const [label, pack] of [['thin', thin], ['full', full]]) {
      try { execFileSync('git', ['-C', judge, 'index-pack', '--fix-thin', '--strict', '--stdin', '--keep'], { input: pack, stdio: 'pipe' }); } // no -o: lands in objects/pack so git can see the objects
      catch (e) { problems.push(`${label} pack rejected: ${(e.stderr || '').toString().trim().split('\n').pop().slice(0, 100)}`); }
    }
    if (!problems.length) {
      if (!Buffer.from(gitBuf(judge, ['cat-file', 'blob', newBlob])).equals(target)) problems.push('blob content via git != target');
      const fsck = fsckProblems(judge, { args: [newCommit] }); if (fsck.length) problems.push(`fsck ${fsck[0]}`);
      // and a real push of the thin pack lands the ref
      const out = execFileSync('git', ['-C', judge, 'receive-pack', '.'], { input: concat([pktFor(`${oldCommit} ${newCommit} refs/heads/main\0report-status\n`), te.encode('0000'), thin]), stdio: 'pipe' }).toString();
      if (!/unpack ok/.test(out) || !/ok refs\/heads\/main/.test(out)) problems.push(`receive-pack: ${out.replace(/\n/g, '|').slice(0, 100)}`);
      if (git(judge, ['rev-parse', 'main']).trim() !== newCommit) problems.push('ref not advanced');
    }
    for (const b of [`depth.${depth}`, `blob.${blobLen === 0 ? 0 : 2 ** Math.floor(Math.log2(blobLen))}`, `off.${off === 0 ? 'start' : off === blobLen ? 'end' : off % 65536 === 0 ? '64k-aligned' : off % 65536 === 65535 ? '64k-1' : 'mid'}`, `oldLen.${oldLen}`, `insert.${insert.length}`, `copyops.${Math.ceil(off / 65536) + Math.ceil((blobLen - off - oldLen) / 65536)}`, `thin.${thin.length < full.length ? 'smaller' : 'not-smaller'}`]) bump(b);
    process.stdout.write(`${problems.length ? 'FAIL' : 'ok  '} #${String(i).padStart(3)} seed=${seed} depth=${depth} blob=${blobLen} off=${off} old=${oldLen} ins=${insert.length} thin=${thin.length}B full=${full.length}B\n`);
    if (problems.length) { fails.push(seed); console.log('     ' + problems.join('\n     ')); }
    rmSync(work, { recursive: true, force: true }); rmSync(judge, { recursive: true, force: true });
  }
} finally { cleanup(); }
function pktFor(s) { const b = te.encode(s); return concat([te.encode((b.length + 4).toString(16).padStart(4, '0')), b]); }
console.log(`\n${N} cases, ${fails.length} failures\n` + [...cov.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${String(v).padStart(4)} ${k}`).join('\n'));
process.exit(fails.length ? 1 : 0);
