// The ssh-faults space (test/space/ssh-faults.space.js): every cell runs twice against the same scripted faulty server
// (test/sshfake.js): ply's lsRefs over createSshTransport, and `git ls-remote` through OpenSSH, the oracle. ply's outcome
// must be the cell's (a typed code and message, or ok) within the time bound; git's class (ok / refused) must be the
// cell's, which is ply's unless the space names a divergence. A fault-free run first proves the server speaks SSH to
// both. Then the host-key pin, the caller's input to the same handshake: ssh-keygen is its oracle.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startFakeSshd } from '../sshfake.js';
import * as space from './ssh-faults.space.js';
import { createSshTransport } from '../../src/sshgit.js';
import { nodeStream } from '../../src/ssh-node.js';
import { SshClient, hostKeyFromLine } from '../../src/ssh.js';
import { lsRefs } from '../../src/lsrefs.js';
import { Tracer } from '../../src/otel.js';
import { withLimits } from '../../src/limits.js';
import { concat } from '../../src/bytes.js';

const TIMEOUT_MS = 4000;   // ply's requestTimeoutMs: a cell that hangs ends as `timeout`, which no cell expects
const BOUND_MS = 2000;     // every cell's outcome, ok or refused, well inside it
const GIT_KILL_MS = 10000; // git/OpenSSH have no bound of their own here
const WORKERS = 4;
const LIMITS = withLimits({ requestTimeoutMs: TIMEOUT_MS, maxPackBytes: 16384 });

// a child process and everything it spawned (git runs ssh), killed together
const run = (cmd, args, env) => new Promise(res => {
  const p = spawn(cmd, args, { env, detached: true }); let stdout = '', stderr = '';
  p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; });
  const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } };
  const k = setTimeout(kill, GIT_KILL_MS);
  p.on('exit', (status, signal) => { clearTimeout(k); kill(); setTimeout(() => res({ status, signal, stdout, stderr }), 20); });
});

let dir, kp, pub, servers = [];
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ssh-faults-'));
  kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  servers = await Promise.all(Array.from({ length: WORKERS }, () => startFakeSshd()));
  writeFileSync(join(dir, 'known_hosts'), servers.map(s => `[127.0.0.1]:${s.port} ${s.hostKeyLine}\n`).join(''));
});
after(async () => { await Promise.all(servers.map(s => s.close())); rmSync(dir, { recursive: true, force: true }); });

const urlOf = s => `ssh://git@127.0.0.1:${s.port}/r.git`;
async function plyRun(s) {
  const t = createSshTransport(urlOf(s), { privateKey: kp.privateKey, publicKeyRaw: pub, hostKey: s.hostKeyLine, connect: nodeStream, tracer: new Tracer(), limits: LIMITS });
  const t0 = Date.now();
  try { const { refs } = await lsRefs(t, ['refs/heads/main']); return { tag: 'ok', refs: [...refs.keys()], ms: Date.now() - t0 }; }
  catch (e) { return { tag: 'refused', code: e.code, message: e.message, ms: Date.now() - t0 }; }
  finally { await t.close().catch(() => {}); }
}
async function gitRun(s) {
  const ssh = `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${join(dir, 'known_hosts')} -o IdentitiesOnly=yes -o IdentityFile=/dev/null`;
  const r = await run('git', ['ls-remote', urlOf(s)], { ...process.env, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: '0' });
  const why = r.stderr.split('\n').filter(l => l && !l.startsWith('**')).slice(0, 2).join(' / ');
  return { tag: r.signal ? 'hung' : r.status === 0 ? 'ok' : 'refused', stdout: r.stdout, why };
}

test('the scripted server speaks SSH: with no fault, ply and git ls-remote through OpenSSH both read its one ref', async () => {
  const s = servers[0]; s.setFault(null);
  const [p, g] = [await plyRun(s), await gitRun(s)];
  assert.deepEqual([p.tag, p.refs], ['ok', ['refs/heads/main']], JSON.stringify(p));
  assert.equal(g.tag, 'ok', g.why); assert.match(g.stdout, /^a{40}\trefs\/heads\/main\n$/);
});

test('ssh-faults: every cell, ply against its expected outcome and OpenSSH/git against its class', async () => {
  const c = space.census();
  const cells = [...space.cells()];
  assert.equal(cells.length, c.cells);
  const t0 = Date.now(); const rows = []; let next = 0;
  await Promise.all(servers.map(async s => {
    while (next < cells.length) {
      const cell = cells[next++];
      s.setFault(space.fault(cell));
      const ply = await plyRun(s);
      const git = await gitRun(s);
      rows.push({ id: space.cellId(cell), want: space.expected(cell), ply, git });
    }
  }));
  const bad = [];
  const outcomes = {};
  for (const { id, want, ply, git } of rows) {
    const k = ply.tag === 'ok' ? 'ok' : ply.code; outcomes[k] = (outcomes[k] ?? 0) + 1;
    if (want.ply.tag === 'ok' ? ply.tag !== 'ok' : ply.tag !== 'refused' || ply.code !== want.ply.code || !want.ply.message.test(ply.message)) bad.push(`${id}: ply ${ply.tag === 'ok' ? 'ok' : `${ply.code}: ${ply.message}`}; want ${want.ply.tag === 'ok' ? 'ok' : `${want.ply.code} ${want.ply.message}`}`);
    if (ply.ms > BOUND_MS) bad.push(`${id}: ply took ${ply.ms} ms (bound ${BOUND_MS})`);
    if (git.tag !== want.git) bad.push(`${id}: git ${git.tag} (${git.why}); want ${want.git}`);
  }
  const div = rows.filter(r => space.DIVERGENCE[r.id]).map(r => r.id);
  console.log(`  ssh-faults: ${rows.length} cells of ${c.raw} phase × defect pairs (${c.inapplicable.reduce((a, b) => a + b, 0)} inapplicable), ${((Date.now() - t0) / 1000).toFixed(1)} s on ${WORKERS} servers; ply outcomes ${JSON.stringify(outcomes)}; slowest ply cell ${Math.max(...rows.map(r => r.ply.ms))} ms; divergences from git: ${div.join(', ') || 'none'}`);
  assert.deepEqual(bad, []);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length, 'cell ids are unique');
  for (const id of Object.keys(space.DIVERGENCE)) assert.ok(rows.some(r => r.id === id), `divergence ${id} names no cell`);
});

// ---- the pin: the caller's half of host authentication ----
const blobLine = parts => `ssh-ed25519 ${Buffer.from(concat(parts)).toString('base64')}`;
const sstr = b => { const x = typeof b === 'string' ? new TextEncoder().encode(b) : b; const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, x.length); return concat([n, x]); };
const PIN = [
  { tag: 'valid', line: () => servers[0].hostKeyLine, want: null },
  { tag: 'absent', line: () => undefined, want: /hostKey is required/ },
  { tag: 'notALine', line: () => 'not a host key', want: /hostKey must be an "ssh-ed25519 AAAA…" line/ },
  { tag: 'rsaBlob', line: () => blobLine([sstr('ssh-rsa'), sstr(new Uint8Array(32))]), want: /hostKey blob is not ssh-ed25519/ },
  { tag: 'shortKey', line: () => blobLine([sstr('ssh-ed25519'), sstr(new Uint8Array(31))]), want: /hostKey: bad key length/ },
];
test('pin: SshClient and createSshTransport refuse a malformed hostKey before any I/O (bad_request), as ssh-keygen refuses the line', async () => {
  let dialed = 0;
  const stream = { read: async () => { dialed++; return null; }, write: async () => { dialed++; }, close() {} };
  for (const v of PIN) {
    const line = v.line();
    const entries = {
      SshClient: () => new SshClient(stream, { user: 'u', hostKey: line, tracer: new Tracer() }),
      createSshTransport: () => createSshTransport(urlOf(servers[0]), { privateKey: kp.privateKey, publicKeyRaw: pub, hostKey: line, connect: () => { dialed++; return stream; }, tracer: new Tracer() }),
    };
    for (const [name, f] of Object.entries(entries)) {
      if (!v.want) assert.doesNotThrow(f, `${v.tag} via ${name}`);
      else assert.throws(f, e => e.code === 'bad_request' && v.want.test(e.message), `${v.tag} via ${name}`);
    }
    if (line !== undefined) { // the oracle: ssh-keygen -l reads a known_hosts-style line, or refuses it
      const f = join(dir, `pin-${v.tag}.pub`); writeFileSync(f, `${line}\n`);
      const r = await run('ssh-keygen', ['-l', '-f', f], process.env);
      assert.equal(r.status === 0, !v.want, `ssh-keygen -l on ${v.tag}: exit ${r.status} ${r.stderr}`);
      if (!v.want) assert.deepEqual(hostKeyFromLine(line), servers[0].hostKeyLine && hostKeyFromLine(servers[0].hostKeyLine));
    }
  }
  assert.equal(dialed, 0, 'no stream was touched');
});
