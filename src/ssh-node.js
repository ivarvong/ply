// node byte stream for the SSH client (not for the Workers bundle: node:net). The Workers counterpart is ssh-workers.js.
import { fail } from './errors.js';
import net from 'node:net';
export function nodeStream(host, port, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const chunks = []; let waiters = []; let ended = false, err = null;
    const wake = () => { const w = waiters; waiters = []; for (const f of w) f(); };
    sock.on('data', d => { chunks.push(new Uint8Array(d.buffer, d.byteOffset, d.length)); wake(); });
    sock.on('end', () => { ended = true; wake(); }); sock.on('close', () => { ended = true; wake(); });
    sock.on('error', e => { err = e; ended = true; wake(); reject(e); });
    sock.setTimeout(timeoutMs, () => { err = fail('timeout', 'socket timeout'); sock.destroy(); });
    sock.once('connect', () => resolve({
      async read() { for (;;) { if (chunks.length) return chunks.shift(); if (err) throw err; if (ended) return null; await new Promise(r => waiters.push(r)); } },
      write(bytes) { return new Promise((res, rej) => sock.write(bytes, e => (e ? rej(e) : res()))); },
      close() { sock.end(); sock.destroy(); },
    }));
  });
}
// ci/fast probe: whole-file mutation of every src file (reverted in the next commit)
