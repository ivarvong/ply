// Semantic-lie fuzz: the server answers with WELL-FORMED protocol bytes that are wrong. No corruption the parsers
// can see — only the client's content checks (oid verification, size contracts, CAS) stand between a lie and a bad push.
// Every lie is built from real objects taken from a second repo or an older commit of the same repo.
//   node test/fuzz/liar.mjs [--n 200] [--seed 1] [--case <seed>] [--op edit|mergebase|mixed]
// Two families. `edit`: editFile on a fixed two-commit repo (LIES). `mergebase` (issue #18): mergeBase / mergeBranch on a
// random DAG (dag.js) behind a server that answers the commit-only `tree:0` + `deepen` walks with a cut history
// (MERGE_LIES): ancestors omitted without a `shallow` line, omitted beside honest shallow lines, a consistent shallower
// cut, the want itself missing, an unrequested commit, a tree in a tree:0 pack. Oracle: `git merge-base --all` and
// `git merge-tree --write-tree`. A lied-to run must end in a typed error or exactly git's bases; an honest run must
// equal git's bases (set equality, criss-cross included); a merge that lands must be the one git produces (I21).
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from '../server.js';
import { startProxy } from '../proxy.js';
import { Rng } from './prng.js';
import { genDag, readModel } from './dag.js';
import { MERGE_LIES, mergeLie, fetchResponse, pktLine, FLUSH } from './mergelies.js';
import { editFile } from '../../src/edit.js';
import { mergeBase, mergeBranch } from '../../src/merge.js';
import { createTransport } from '../../src/http.js';
import { Tracer, arrayExporter, flattenLine } from '../../src/otel.js';
import { withLimits } from '../../src/limits.ts';
import { TYPE } from '../../src/objects.js';
import { concat, te } from '../../src/bytes.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '200', 10), SEED = parseInt(args.seed ?? String(Date.now() % 1e9), 10), ONLY = args.case ? parseInt(args.case, 10) : null;
const OP = args.op ?? 'mixed';
if (!['edit', 'mergebase', 'mixed'].includes(OP)) throw new Error(`--op must be edit, mergebase or mixed, not ${OP}`);
const CODES = new Set(['pack_corrupt', 'protocol', 'network', 'timeout', 'aborted', 'not_git', 'auth', 'not_found', 'rate_limited', 'upstream_5xx', 'http', 'limit_exceeded', 'remote_error', 'match_count', 'cas_conflict', 'push_rejected', 'bad_request', 'unsupported', 'ambiguous', 'merge_conflict', 'unrelated_histories', 'not_fast_forward']);

const obj = (bare, oid) => { const t = git(bare, ['cat-file', '-t', oid]).trim(); return { type: TYPE[t.toUpperCase()], data: new Uint8Array(gitBuf(bare, ['cat-file', t, oid])) }; };

const FILE = 'a/b/target.txt', ORIG = 'before MARK after\n', EXPECTED = 'before XX after\n';

// Lies. Each takes the real repo state + a decoy repo and returns a fault function for the proxy.
const LIES = {
  // ls-refs points at an older commit (server lagging / replica split-brain). Legit: edit lands on that base; CAS protects.
  'ls-refs:old-commit': (R, D) => ctx => ctx.stage === 'ls-refs' ? { type: 'bytes', bytes: concat([pktLine(`${R.older} refs/heads/main\n`), FLUSH]), name: 'ls-refs old' } : { type: 'pass' },
  // ls-refs points at a commit from an unrelated repo (that the server does not have).
  'ls-refs:foreign-commit': (R, D) => ctx => ctx.stage === 'ls-refs' ? { type: 'bytes', bytes: concat([pktLine(`${D.head} refs/heads/main\n`), FLUSH]), name: 'ls-refs foreign' } : { type: 'pass' },
  // ls-refs says one thing, then the push's CAS must notice the server never had that commit as main.
  'ls-refs:fabricated-oid': (R, D) => ctx => ctx.stage === 'ls-refs' ? { type: 'bytes', bytes: concat([pktLine(`${'a'.repeat(40)} refs/heads/main\n`), FLUSH]), name: 'ls-refs fake' } : { type: 'pass' },
  // commit fetch returns a different (older) commit object than the one wanted.
  'commit:wrong-object': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === 0 ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.older)], { shallow: [R.older] }), name: 'wrong commit' } : { type: 'pass' },
  // commit fetch returns the decoy repo's commit: wrong oid, wrong tree.
  'commit:foreign-object': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === 0 ? { type: 'bytes', bytes: fetchResponse([obj(D.bare, D.head)], { shallow: [D.head] }), name: 'foreign commit' } : { type: 'pass' },
  // tree fetch at some level returns a tree with the same name present but pointing at a different blob (decoy content).
  'tree:swapped-entry': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.leafLevel ? { type: 'bytes', bytes: fetchResponse([obj(D.bare, D.leafTree)]), name: 'swapped tree' } : { type: 'pass' },
  // tree fetch returns the right tree bytes but for the wrong level (root instead of leaf).
  'tree:wrong-level': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.leafLevel ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.rootTree)]), name: 'wrong level' } : { type: 'pass' },
  // blob fetch returns a different blob of the SAME size (so header size matches; only content differs).
  'blob:same-size-other-content': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([{ type: TYPE.BLOB, data: te.encode(ORIG.replace('MARK', 'MARX')) }]), name: 'blob same size' } : { type: 'pass' },
  // blob fetch returns a same-size blob whose content still contains the needle elsewhere: the client scans, finds exactly one
  // match, computes a delta against the CLAIMED base oid and pushes. The server holds the real base: the delta's base-size
  // check or the resulting object hash must fail. Outcome must be a rejection, never a committed wrong file.
  'blob:same-size-needle-kept': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([{ type: TYPE.BLOB, data: te.encode('MARK before after\n') }]), name: 'blob needle kept' } : { type: 'pass' },
  // blob fetch returns a DIFFERENT-size blob with the needle: size contract vs header is what must catch it.
  'blob:other-size-needle-kept': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([{ type: TYPE.BLOB, data: te.encode('x MARK y\n') }]), name: 'blob other size' } : { type: 'pass' },
  // blob fetch returns the OLD version of the file (server serving stale object store).
  'blob:stale-version': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.olderBlob)]), name: 'stale blob' } : { type: 'pass' },
  // blob fetch returns a tree object instead.
  'blob:tree-instead': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.rootTree)]), name: 'tree for blob' } : { type: 'pass' },
  // blob fetch returns two objects (the blob plus junk) in a well-formed pack.
  'blob:extra-object': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.blob), obj(R.bare, R.rootTree)]), name: 'extra object' } : { type: 'pass' },
  // every fetch answers with an empty (0-object) well-formed pack.
  'fetch:empty-pack': (R, D) => ctx => ctx.stage === 'fetch' ? { type: 'bytes', bytes: fetchResponse([]), name: 'empty pack' } : { type: 'pass' },
  // receive-pack says ok but did nothing (lying report).
  'push:fake-ok': (R, D) => ctx => ctx.stage === 'receive-pack' ? { type: 'bytes', bytes: concat([pktLine('unpack ok\n'), pktLine('ok refs/heads/main\n'), FLUSH]), name: 'fake ok', noForward: true } : { type: 'pass' },
  // receive-pack reports ok for a different ref than we pushed.
  'push:ok-other-ref': (R, D) => ctx => ctx.stage === 'receive-pack' ? { type: 'bytes', bytes: concat([pktLine('unpack ok\n'), pktLine('ok refs/heads/other\n'), FLUSH]), name: 'ok other ref' } : { type: 'pass' },
  // receive-pack reports ok AND ng for the same ref.
  'push:ok-and-ng': (R, D) => ctx => ctx.stage === 'receive-pack' ? { type: 'bytes', bytes: concat([pktLine('unpack ok\n'), pktLine('ok refs/heads/main\n'), pktLine('ng refs/heads/main later\n'), FLUSH]), name: 'ok+ng' } : { type: 'pass' },
  // receive-pack: unpack ok but no ref lines at all.
  'push:no-ref-lines': (R, D) => ctx => ctx.stage === 'receive-pack' ? { type: 'bytes', bytes: concat([pktLine('unpack ok\n'), FLUSH]), name: 'no ref lines' } : { type: 'pass' },
  // two lies: ls-refs old commit AND blob stale (consistent with each other: a fully lagging replica).
  'replica:consistent-lag': (R, D) => ctx => ctx.stage === 'ls-refs' ? { type: 'bytes', bytes: concat([pktLine(`${R.older} refs/heads/main\n`), FLUSH]), name: 'lag' } : { type: 'pass' },
};

// one random DAG per case, pushed to a bare repo; every commit's bytes read once, up front (the fault never spawns git)
function dagRepo(rng, i, decoy) {
  const name = `g${i}`; const bare = makeBareRepo(root, name); const work = join(root, `gw${i}`); mkdirSync(work);
  const dag = genDag(rng, work, { commits: rng.int(8, 26), branches: rng.int(2, 4) });
  git(work, ['push', '-q', '--all', bare]);
  const model = readModel(bare);
  const commitData = new Map(); for (const c of model.commits.keys()) commitData.set(c, obj(bare, c).data);
  const trees = new Map();
  return { name, bare, work, model, dag, commitData, decoy, lied: 0, omitted: 0, treeOf: c => { const t = model.commits.get(c).tree; if (!trees.has(t)) trees.set(t, obj(bare, t).data); return trees.get(t); } };
}
const sortedBases = s => s.trim().split('\n').filter(Boolean).sort();
const gitMergeTree = (bare, ours, theirs) => { const r = spawnSync('git', ['-C', bare, '-c', 'attr.tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'merge-tree', '--write-tree', '--name-only', ours, theirs], { encoding: 'utf8' }); return { clean: r.status === 0, tree: r.stdout.split('\n')[0].trim() }; };

async function mergeBaseCase(rng, i, seed, decoy) {
  const kinds = Object.keys(MERGE_LIES);
  const kind = kinds[rng.int(0, kinds.length - 1)];
  const M = dagRepo(rng, i, decoy);
  const commits = [...M.model.commits.keys()]; // what the bare repo holds (genDag's unreferenced commits are not pushed)
  // two distinct commits, branch heads more often than not; refs for the end-to-end merge
  const pickC = () => rng.weighted([[rng.pick(M.dag.branchHeads), 3], [rng.pick(commits), 2], [M.dag.tip, 1]]);
  let a = pickC(), b = pickC(); for (let k = 0; a === b && k < 20; k++) b = pickC();
  if (a === b) b = commits.find(c => c !== a);
  git(M.bare, ['update-ref', 'refs/heads/ours', a]); git(M.bare, ['update-ref', 'refs/heads/theirs', b]);
  const gitBases = sortedBases(git(M.bare, ['merge-base', '--all', a, b]));
  const op = rng.bool(0.6) ? 'mergeBase' : 'mergeBranch';
  const maxDepth = rng.pick([undefined, undefined, 16, 32]);
  const proxy = await startProxy(srv.url, mergeLie(M, kind, seed));
  const exporter = arrayExporter();
  let result = null, error = null;
  const url = `${proxy.url}/${M.name}.git`;
  try {
    if (op === 'mergeBase') result = await mergeBase(createTransport(url, { tracer: new Tracer({ exporter }), limits: withLimits({ requestTimeoutMs: 3000 }) }), a, b, maxDepth ? { maxDepth } : {});
    else result = await mergeBranch(url, { ref: 'refs/heads/ours', from: 'refs/heads/theirs', author: { name: 'l', email: 'l@x' } }, { tracer: new Tracer({ exporter }), limits: withLimits({ requestTimeoutMs: 3000, ...(maxDepth ? { maxMergeDepth: maxDepth } : {}) }) });
  } catch (e) { error = e; }
  await proxy.close();
  const problems = [];
  const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
  const nowOurs = git(M.bare, ['rev-parse', 'refs/heads/ours']).trim();
  if (error && !CODES.has(error.code)) problems.push(`untyped ${error.code}: ${error.message}`);
  if (error && nowOurs !== a) problems.push(`ref moved on error to ${nowOurs.slice(0, 8)}`);
  const basesOf = () => (op === 'mergeBase' ? result.bases.slice().sort() : null);
  if (!error && op === 'mergeBase' && !same(basesOf(), gitBases)) problems.push(`bases ${basesOf().map(x => x.slice(0, 8))} != git merge-base --all ${gitBases.map(x => x.slice(0, 8))}${M.lied ? ' (lied to)' : ' (HONEST server)'}`);
  if (!error && op === 'mergeBranch') {
    // I21: whatever landed is what git produces from git's base; a many-bases history is refused, not merged
    if (gitBases.length !== 1 && result.outcome !== 'up_to_date') problems.push(`merged with ${gitBases.length} git bases (outcome ${result.outcome})`);
    if (result.base !== undefined && !gitBases.includes(result.base)) problems.push(`merge used base ${String(result.base).slice(0, 8)}, git's: ${gitBases.map(x => x.slice(0, 8))}`);
    if (result.outcome === 'merge') { const g = gitMergeTree(M.bare, a, b); if (!g.clean || g.tree !== result.tree) problems.push(`pushed merge tree ${result.tree.slice(0, 8)}; git merge-tree ${g.clean ? g.tree.slice(0, 8) : 'conflicts'}`); if (nowOurs !== result.oid) problems.push('ref is not the merge commit'); }
    if (result.outcome === 'fast_forward' && (nowOurs !== b || gitBases[0] !== a)) problems.push('fast-forward where git has no ancestor relation');
    if (result.outcome === 'up_to_date' && !(gitBases.length === 1 && gitBases[0] === b) && a !== b) problems.push('up_to_date but theirs is not the base');
    const fsck = fsckProblems(M.bare); if (fsck.length) problems.push(`fsck: ${fsck[0]}`);
  }
  if (error && op === 'mergeBranch' && error.code === 'merge_conflict' && error.bases && !same(error.bases.slice().sort(), gitBases)) problems.push(`criss-cross refusal with bases ${error.bases.length}, git has ${gitBases.length}${M.lied ? ' (lied to)' : ' (HONEST server)'}`);
  if (error && error.code === 'unrelated_histories' && gitBases.length) problems.push(`unrelated_histories but git has a base${M.lied ? ' (lied to)' : ' (HONEST server)'}`);
  // lies the pack itself contradicts must be pack_corrupt (a missing want, a commit that is not an ancestor of it), with
  // nothing landed; omissions may also surface as the depth cap (a consistent shallower cut) or a correct base.
  if (M.lied && ['mb:omit-want', 'mb:extra-foreign'].includes(kind) && error?.code !== 'pack_corrupt') problems.push(`${kind} fired ${M.lied}× but outcome is ${error ? error.code : 'success'}`);
  if (M.lied && error && !['pack_corrupt', 'limit_exceeded', 'protocol', 'merge_conflict', 'not_fast_forward', 'unrelated_histories'].includes(error.code)) problems.push(`lied to, unexpected code ${error.code}`);
  const code = error ? error.code : (op === 'mergeBase' ? `ok(${result.bases.length})` : `ok:${result.outcome}`);
  return { lie: `${kind}${M.lied ? `×${M.lied}` : ''} ${op}${maxDepth ? ` d${maxDepth}` : ''}`, code, error, problems, cleanup: () => rmSync(M.work, { recursive: true, force: true }) };
}

const { root, cleanup } = tmpRoot();
const srv = await startGitServer(root);
const outcomes = {}, fails = [];
try {
  const names = Object.keys(LIES);
  const seeds = ONLY !== null ? [ONLY] : Array.from({ length: N }, (_, i) => (SEED * 7919 + i * 104729) >>> 0);
  // the unrelated commit for mb:extra-foreign, made once
  const dbare0 = makeBareRepo(root, 'decoy0'); const dwork0 = join(root, 'decoy0w'); mkdirSync(dwork0); git(dwork0, ['init', '-q', '-b', 'main']);
  const decoy = obj(dbare0, commitFiles(dwork0, dbare0, { 'decoy.txt': 'decoy\n' }, 'decoy'));
  for (let i = 0; i < seeds.length; i++) {
    const rng = new Rng(seeds[i]);
    const mb = rng.bool(1 / 3); // drawn in every mode so --op mergebase --case <seed> replays a mixed run's case
    if (OP === 'mergebase' || (OP === 'mixed' && mb)) {
      const r = await mergeBaseCase(rng, i, seeds[i], decoy);
      outcomes[`${r.lie.split(/[×\s]/)[0]} → ${r.code}`] = (outcomes[`${r.lie.split(/[×\s]/)[0]} → ${r.code}`] ?? 0) + 1;
      process.stdout.write(`${r.problems.length ? 'FAIL' : 'ok  '} #${String(i).padStart(3)} seed=${seeds[i]} ${r.lie.padEnd(38)} → ${r.code.padEnd(13)} ${r.error ? r.error.message.slice(0, 70) : ''}\n`);
      if (r.problems.length) { fails.push(seeds[i]); console.log('     ' + r.problems.join('\n     ') + `\n     repro: node test/fuzz/liar.mjs --op mergebase --case ${seeds[i]}`); }
      r.cleanup();
      continue;
    }
    const lie = names[rng.int(0, names.length - 1)];
    const name = `l${i}`;
    // real repo: two commits so there is an "older" version of everything
    const bare = makeBareRepo(root, name); const work = join(root, `w${i}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    const older = commitFiles(work, bare, { [FILE]: 'old MARK old\n', 'z.txt': 'z' }, 'older');
    const head = commitFiles(work, bare, { [FILE]: ORIG }, 'head');
    const R = { bare, head, older, rootTree: git(bare, ['rev-parse', 'main^{tree}']).trim(), blob: git(bare, ['rev-parse', 'main:' + FILE]).trim(), olderBlob: git(bare, [`rev-parse`, `${older}:${FILE}`]).trim(), leafLevel: 1 + 2, blobFetch: 1 + 3 };
    // decoy repo: same path, different content
    const dbare = makeBareRepo(root, 'd' + name); const dwork = join(root, `dw${i}`); mkdirSync(dwork); git(dwork, ['init', '-q', '-b', 'main']);
    const dhead = commitFiles(dwork, dbare, { [FILE]: 'decoy MARK decoy\n' }, 'decoy');
    const D = { bare: dbare, head: dhead, leafTree: git(dbare, ['rev-parse', 'main:a/b']).trim() };
    const proxy = await startProxy(srv.url, LIES[lie](R, D));
    const exporter = arrayExporter();
    let result = null, error = null;
    const verify = rng.bool(0.5);
    try { result = await editFile(`${proxy.url}/${name}.git`, { path: FILE, find: 'MARK', replace: 'XX', author: { name: 'l', email: 'l@x' }, message: 'l' }, { tracer: new Tracer({ exporter }), limits: withLimits({ requestTimeoutMs: 3000 }), verify }); }
    catch (e) { error = e; }
    await proxy.close();
    const problems = [];
    const nowHead = git(bare, ['rev-parse', 'main']).trim();
    const content = gitBuf(bare, ['cat-file', 'blob', `main:${FILE}`]).toString();
    const fsck = fsckProblems(bare);
    if (fsck.length) problems.push(`fsck: ${fsck[0]}`);
    if (error) {
      if (!CODES.has(error.code)) problems.push(`untyped ${error.code}: ${error.message}`);
      if (error.code === 'ambiguous') { if (nowHead !== head && content !== EXPECTED) problems.push(`ambiguous but ref moved to wrong content ${JSON.stringify(content)}`); }
      else if (nowHead !== head) problems.push(`ref moved on error to ${nowHead.slice(0, 8)} (content ${JSON.stringify(content)})`);
    } else {
      // a success must be a TRUE success: ref == our commit, content == expected splice of the REAL head blob
      if (nowHead !== result.newCommit) { if (!(lie === 'push:fake-ok' && !verify)) problems.push(`claimed success but ref is ${nowHead.slice(0, 8)} not ${result.newCommit.slice(0, 8)}`); }
      else if (content !== EXPECTED) problems.push(`claimed success with WRONG CONTENT ${JSON.stringify(content)}`);
      else { const parent = (() => { try { return git(bare, ['rev-parse', `${result.newCommit}^`]).trim(); } catch { return null; } })(); if (parent !== head && lie !== 'ls-refs:old-commit' && lie !== 'replica:consistent-lag') problems.push('new commit parent is not the real head'); }
    }
    // a lying 'ok' must be caught whenever verify is on (the proxy's fake report never reaches the real server)
    if (lie === 'push:fake-ok') { if (verify && !error) problems.push('verify=on but forged ok was believed'); if (verify && error && error.code !== 'ambiguous') problems.push(`verify=on: expected ambiguous, got ${error.code}`); }
    const code = error ? error.code : 'ok';
    outcomes[`${lie} → ${code}`] = (outcomes[`${lie} → ${code}`] ?? 0) + 1;
    process.stdout.write(`${problems.length ? 'FAIL' : 'ok  '} #${String(i).padStart(3)} seed=${seeds[i]} ${(lie + (verify ? ' +verify' : '')).padEnd(38)} → ${code.padEnd(13)} ${error ? error.message.slice(0, 70) : ''}\n`);
    if (problems.length) { fails.push(seeds[i]); console.log('     ' + problems.join('\n     ') + `\n     repro: node test/fuzz/liar.mjs --case ${seeds[i]}`); }
    rmSync(work, { recursive: true, force: true }); rmSync(dwork, { recursive: true, force: true });
  }
} finally { await srv.close(); cleanup(); }
console.log(`\n${N} cases, ${fails.length} failures\n` + Object.entries(outcomes).sort().map(([k, v]) => `${String(v).padStart(4)} ${k}`).join('\n'));
process.exit(fails.length ? 1 : 0);
