// The ssh-service space (test/space/ssh-service.space.js): a real OpenSSH sshd whose forced command produces each
// service outcome, and git over OpenSSH (ls-remote, push) as the oracle on the same server and key setup. ply's code and
// message must be the cell's within the time bound; git's class must be the cell's (ply's unless a divergence is named),
// and for every refusal git's stderr and ply's message carry the same server line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { git, tmpRoot, makeBareRepo, commitFiles } from '../server.js';
import { startSshd } from '../sshd.js';
import * as space from './ssh-service.space.js';
import { createSshTransport } from '../../src/sshgit.js';
import { nodeStream } from '../../src/ssh-node.js';
import { lsRefs } from '../../src/lsrefs.js';
import { receiveCaps } from '../../src/receivecaps.js';
import { sshPublicKey } from '../../src/sign.js';
import { Tracer } from '../../src/otel.js';
import { withLimits } from '../../src/limits.ts';

const TIMEOUT_MS = 8000, BOUND_MS = 5000, GIT_KILL_MS = 15000;
const run = (cmd, args, env) => new Promise(res => {
  const p = spawn(cmd, args, { env, detached: true }); let stdout = '', stderr = '';
  p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; });
  const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } };
  const k = setTimeout(kill, GIT_KILL_MS);
  p.on('exit', (status, signal) => { clearTimeout(k); kill(); setTimeout(() => res({ status, signal, stdout, stderr }), 20); });
});

// The forced command: one outcome per repository name, the real service for the rest.
const FORCED = `#!/bin/sh
cmd="$SSH_ORIGINAL_COMMAND"
case "$cmd" in
  *"/absent.git'") exec env PATH=/nonexistent /bin/sh -c "$cmd" ;;
  *"/hostNotFound.git'") echo "ERROR: Repository not found." >&2; exit 1 ;;
  *"/hostDenied.git'") echo "ERROR: Permission to o/r.git denied to u." >&2; exit 1 ;;
  *"/silent.git'") exit 1 ;;
  *"/emptyAdvertisement.git'") printf 0000; exit 0 ;;
  *"/warning.git'") echo "warning: this host is in maintenance" >&2; exec /bin/sh -c "$cmd" ;;
  *) exec /bin/sh -c "$cmd" ;;
esac
`;

let root, cleanup, sshd, kp, pub, gitEnv, work, repos;
const root0 = () => process.getuid?.() === 0;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  sshd = await startSshd(root, { publicKeyRaw: pub });
  const kdir = join(root, 'gitkey'); mkdirSync(kdir, { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(kdir, 'id')]);
  const forced = join(root, 'forced.sh'); writeFileSync(forced, FORCED); chmodSync(forced, 0o755);
  const opt = `command="${forced}",no-pty,no-port-forwarding`;
  writeFileSync(join(sshd.dir, 'authorized_keys'), `${opt} ${sshPublicKey(pub).line} ply\n${opt} ${readFileSync(join(kdir, 'id.pub'), 'utf8').trim()}\n`);
  writeFileSync(join(kdir, 'known_hosts'), `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`);
  gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `ssh -F /dev/null -i ${join(kdir, 'id')} -o BatchMode=yes -o UserKnownHostsFile=${join(kdir, 'known_hosts')} -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes` };
  // the repositories, one per outcome name
  const r = join(root, 'r'); mkdirSync(r);
  work = join(root, 'work'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  for (const name of ['exists', 'warning', 'unreadable']) commitFiles(work, makeBareRepo(r, name), { 'f.txt': `${name}\n` }, name);
  mkdirSync(join(r, 'notRepo.git'));
  chmodSync(join(r, 'unreadable.git'), 0o000);
  repos = r;
});
after(async () => { chmodSync(join(repos, 'unreadable.git'), 0o755); await sshd.close(); cleanup(); });

const pathOf = c => join(repos, `${c.outcome.tag}.git`);
const urlOf = c => `ssh://${sshd.user}@127.0.0.1:${sshd.port}${pathOf(c)}`;
async function plyRun(c) {
  const t = createSshTransport(urlOf(c), { privateKey: kp.privateKey, publicKeyRaw: pub, hostKey: sshd.hostKeyLine, connect: nodeStream, tracer: new Tracer(), limits: withLimits({ requestTimeoutMs: TIMEOUT_MS }) });
  const t0 = Date.now();
  try {
    if (c.service.tag === 'uploadPack') await lsRefs(t, ['refs/heads/main']); else await receiveCaps(t);
    return { tag: 'ok', ms: Date.now() - t0 };
  } catch (e) { return { tag: 'refused', code: e.code, message: e.message, ms: Date.now() - t0 }; }
  finally { await t.close().catch(() => {}); }
}
let pushes = 0;
async function gitRun(c) {
  const r = c.service.tag === 'uploadPack' ? await run('git', ['ls-remote', urlOf(c)], gitEnv)
    : await run('git', ['-C', work, 'push', urlOf(c), `HEAD:refs/heads/from-git-${pushes++}`], gitEnv);
  return { tag: r.signal ? 'hung' : r.status === 0 ? 'ok' : 'refused', stderr: r.stderr };
}

test('ssh-service: every cell, ply against its expected outcome and git over OpenSSH against its class and server line', async () => {
  const t0 = Date.now(); const bad = []; const rows = [];
  for (const c of space.cells()) {
    const id = space.cellId(c); const want = space.expected(c, { root: root0() });
    const ply = await plyRun(c); const g = await gitRun(c);
    rows.push({ id, code: ply.tag === 'ok' ? 'ok' : ply.code, git: g.tag, fatal: g.stderr.split('\n').filter(l => l.startsWith('fatal: ')).map(l => l.replace(pathOf(c), '<path>')) });
    if (want.ply.tag === 'ok' ? ply.tag !== 'ok' : ply.tag !== 'refused' || ply.code !== want.ply.code || !want.ply.message.test(ply.message)) bad.push(`${id}: ply ${ply.tag === 'ok' ? 'ok' : `${ply.code}: ${ply.message}`}; want ${want.ply.tag === 'ok' ? 'ok' : `${want.ply.code} ${want.ply.message}`}`);
    if (ply.ms > BOUND_MS) bad.push(`${id}: ply took ${ply.ms} ms`);
    if (g.tag !== want.git) bad.push(`${id}: git ${g.tag}; want ${want.git}: ${g.stderr.trim().slice(0, 300)}`);
    const line = want.ply.tag === 'refused' ? space.serverLine(c, pathOf(c)) : null;
    if (line && !(root0() && c.outcome.tag === 'unreadable')) {
      if (!g.stderr.includes(line)) bad.push(`${id}: git's stderr lacks the server line ${JSON.stringify(line)}: ${g.stderr.trim().slice(0, 300)}`);
      if (!ply.message?.includes(line)) bad.push(`${id}: ply's message lacks the server line ${JSON.stringify(line)}: ${ply.message}`);
    }
  }
  console.log(`  ssh-service: ${rows.length} cells in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${rows.map(r => `${r.id}=${r.code}/git:${r.git}`).join(' ')}`);
  console.log(`  git's own lines on refusal: ${JSON.stringify([...new Set(rows.flatMap(r => r.fatal))])}`);
  assert.deepEqual(bad, []);
});
