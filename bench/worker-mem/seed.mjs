// Seeds (or deletes) the throwaway Artifacts repo the harness reads: ~1 GiB of history pushed as one commit per push,
// each push under the 64 MiB request cap, with stock git. The worker then fetches the whole history as one pack.
//
//   node bench/worker-mem/seed.mjs            create + push, write .data/seed.json
//   node bench/worker-mem/seed.mjs --delete   delete the repo named in .data/seed.json
//
// Content is deterministic (AES-CTR keystream), mostly incompressible so pack bytes ≈ data bytes, plus one commit of
// near-duplicate text files so the pack also carries real deltas. One 30 MiB blob (under the 32 MiB object cap) is the
// read cell's target.
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { NO_MAINTENANCE } from '../../test/server.js';
import { DATA, NAMESPACE, cfJson, cfRaw, remember, writeSecret, stamp, redact, sleep } from './lib.mjs';

const MIB = 1024 * 1024;
const SEED_FILE = join(DATA, 'seed.json');
const COMMITS = Number(process.env.MEMLAB_COMMITS ?? 18);
const FILES_PER_COMMIT = 7;
const FILE_MIB = 8;
const BIG_BLOB_MIB = 30;
const TEXT_FILES = 1500;

const keystream = (label, n) => {
  const key = createHash('sha256').update(`ply-memlab:${label}`).digest().subarray(0, 16);
  return createCipheriv('aes-128-ctr', key, Buffer.alloc(16)).update(Buffer.alloc(n));
};

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...opts.env }, maxBuffer: 64 * MIB });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args[0]} failed: ${redact(r.stderr).slice(0, 800)}`);
  return r;
}

function write(src, rel, data) {
  const p = join(src, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

function ids(x, out = new Set()) {
  if (Array.isArray(x)) for (const v of x) ids(v, out);
  else if (x && typeof x === 'object') {
    if (typeof x.id === 'string' && ('state' in x || 'expires_at' in x || 'scope' in x)) out.add(x.id);
    for (const v of Object.values(x)) ids(v, out);
  }
  return out;
}

export function revokeAll(name) {
  const listed = cfJson(['artifacts', 'namespaces', 'repos', 'tokens', 'list', '--namespace', NAMESPACE, '--name', name, '--state', 'active']);
  const all = [...ids(listed)];
  for (const id of all) cfJson(['artifacts', 'namespaces', 'tokens', 'revoke', id, '--namespace', NAMESPACE, '--force']);
  return all.length;
}

export function mint(name, scope, ttl) {
  const m = cfJson(['artifacts', 'namespaces', 'tokens', 'create', NAMESPACE, '--repo', name, '--scope', scope, '--ttl', String(ttl)]);
  return { token: remember(m.plaintext), id: m.id };
}

// 401/403 from the advertisement with this token means it no longer works.
export async function refused(remote, token) {
  const res = await fetch(`${remote}/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`, 'git-protocol': 'version=2' },
  });
  await res.arrayBuffer();
  return res.status === 401 || res.status === 403;
}

async function seed() {
  const name = `ply-memlab-seed-${stamp().toLowerCase()}`;
  const created = cfJson(['artifacts', 'namespaces', 'repos', 'create', NAMESPACE, '--name', name, '--default-branch', 'main', '--description', 'ply bench/worker-mem seed (kept for reruns; delete with seed.mjs --delete)']);
  const remote = created.remote ?? created.result?.remote;
  if (!/^https:\/\/[a-z0-9]+\.artifacts\.cloudflare\.net\/git\//.test(remote ?? '')) throw new Error('repo create returned no Artifacts remote');
  writeFileSync(SEED_FILE, JSON.stringify({ name, remote, state: 'created' }, null, 1));
  console.log(`created ${NAMESPACE}/${name}; revoked ${revokeAll(name)} auto token(s)`);
  const write_ = mint(name, 'write', 7200);
  const auth = join(DATA, 'auth.gitconfig');
  writeSecret(auth, `[http]\n\textraHeader = Authorization: Basic ${Buffer.from(`x:${write_.token}`).toString('base64')}\n`);
  const src = join(DATA, 'src');
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  git(src, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'ply memlab'], ['user.email', 'memlab@example.invalid'], ...NO_MAINTENANCE, ['core.compression', '6']]) git(src, ['config', k, v]);
  const date = { GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
  const pushes = [];
  const push = async (sha, label) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const t0 = Date.now();
      const r = git(src, ['-c', `include.path=${auth}`, 'push', '--porcelain', remote, `${sha}:refs/heads/main`], { allowFail: true });
      if (r.status === 0) { pushes.push({ label, sha, ms: Date.now() - t0, attempt }); console.log(`pushed ${label} ${sha.slice(0, 12)} in ${Date.now() - t0} ms`); return; }
      console.log(`push ${label} attempt ${attempt} failed: ${redact(r.stderr).slice(0, 300)}`);
      await sleep(5000 * attempt);
    }
    throw new Error(`push ${label} failed 4 times`);
  };
  try {
    // commit 0: the read cell's 30 MiB blob and near-duplicate text (real deltas)
    write(src, 'big/blob30.bin', keystream('big', BIG_BLOB_MIB * MIB));
    const base = keystream('text-base', 24 * 1024).toString('hex');
    for (let f = 0; f < TEXT_FILES; f++) {
      const noise = keystream(`text-${f}`, 64).toString('hex');
      const at = (f * 977) % (base.length - 200);
      write(src, `text/d${String(f % 30).padStart(2, '0')}/f${f}.txt`, `${base.slice(0, at)}${noise}${base.slice(at + noise.length)}\n`);
    }
    git(src, ['add', '-A']);
    git(src, ['commit', '-q', '-m', 'memlab seed 0: big blob + text'], { env: date });
    const blob = git(src, ['rev-parse', 'HEAD:big/blob30.bin']).stdout.trim();
    await push(git(src, ['rev-parse', 'HEAD']).stdout.trim(), 'c0');
    for (let c = 1; c <= COMMITS; c++) {
      for (let f = 0; f < FILES_PER_COMMIT; f++) write(src, `bin/c${String(c).padStart(2, '0')}/f${f}.bin`, keystream(`bin-${c}-${f}`, FILE_MIB * MIB));
      git(src, ['add', '-A']);
      git(src, ['commit', '-q', '-m', `memlab seed ${c}`], { env: date });
      await push(git(src, ['rev-parse', 'HEAD']).stdout.trim(), `c${c}`);
    }
    const head = git(src, ['rev-parse', 'HEAD']).stdout.trim();
    const objects = git(src, ['rev-list', '--objects', '--all']).stdout.trim().split('\n').length;
    const packed = spawnSync('git', ['pack-objects', '--stdout', '--revs', '--delta-base-offset'], { cwd: src, input: `${head}\n`, maxBuffer: 4096 * MIB });
    const meta = { name, remote, state: 'seeded', head, blob, blobBytes: BIG_BLOB_MIB * MIB, commits: COMMITS + 1, objects, localPackBytes: packed.stdout.length, pushes, seededAt: new Date().toISOString() };
    writeFileSync(SEED_FILE, JSON.stringify(meta, null, 1));
    console.log(`seeded head ${head} objects ${objects} local pack ${packed.stdout.length} bytes`);
  } finally {
    rmSync(auth, { force: true });
    revokeAll(name);
    console.log(`write token revoked; refused afterwards: ${await refused(remote, write_.token)}`);
    rmSync(src, { recursive: true, force: true });
  }
}

function remove() {
  if (!existsSync(SEED_FILE)) throw new Error('no .data/seed.json');
  const { name } = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
  revokeAll(name);
  const r = cfRaw(['artifacts', 'namespaces', 'repos', 'delete', name, '--namespace', NAMESPACE, '--force']);
  if (r.code !== 0) throw new Error(`delete failed: ${r.stderr.slice(0, 300)}`);
  rmSync(SEED_FILE);
  console.log(`deleted ${NAMESPACE}/${name}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(DATA, { recursive: true });
  if (process.argv.includes('--delete')) remove();
  else await seed();
}
