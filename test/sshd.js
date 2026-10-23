// A real sshd for the oracle: ephemeral port, Ed25519 host key, our WebCrypto Ed25519 key in authorized_keys,
// GIT_PROTOCOL accepted via AcceptEnv, publickey only. Runs as the current user (root in the sandbox) — fine for tests.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { sshPublicKey } from '../src/sign.js';

export const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

export async function startSshd(root, { publicKeyRaw, acceptEnv = true, user = process.env.USER || 'root' } = {}) {
  const dir = join(root, 'sshd'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host_ed25519')]);
  const hostKeyLine = readFileSync(join(dir, 'host_ed25519.pub'), 'utf8').trim();
  const authorized = join(dir, 'authorized_keys');
  writeFileSync(authorized, `${sshPublicKey(publicKeyRaw).line} ply-test\n`); chmodSync(authorized, 0o600);
  const port = await freePort();
  const pid = join(dir, 'sshd.pid');
  writeFileSync(join(dir, 'sshd_config'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host_ed25519')}`, `AuthorizedKeysFile ${authorized}`, `PidFile ${pid}`,
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'PermitRootLogin yes', 'UsePAM no', 'StrictModes no',
    'LogLevel VERBOSE', acceptEnv ? 'AcceptEnv GIT_PROTOCOL' : '# no AcceptEnv', 'Subsystem sftp internal-sftp', 'ClientAliveInterval 0',
  ].join('\n') + '\n');
  const proc = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stderr.on('data', d => { log += d; }); proc.stdout.on('data', d => { log += d; });
  // wait for the port
  for (let i = 0; i < 100; i++) { try { await new Promise((res, rej) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(); }); s.once('error', rej); }); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
  return { port, host: '127.0.0.1', user, hostKeyLine, dir, log: () => log, close: () => new Promise(r => { proc.once('exit', r); proc.kill('SIGTERM'); }) };
}
