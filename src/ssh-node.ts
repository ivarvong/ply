/// <reference types="node" />
// node byte stream for the SSH client (not for the Workers bundle: node:net). The Workers counterpart is ssh-workers.ts.
/* oxlint-disable no-await-in-loop, typescript/promise-function-async -- read() waits for the next chunk until one is there; the stream and write() are the promises their executors settle */
import { thrown as fail } from './errors.js';
import net from 'node:net';
import type { Bytes, SshStream } from './ssh.js';
export function nodeStream(host: string, port: number, { timeoutMs = 30_000 }: { readonly timeoutMs?: number } = {}): Promise<SshStream> {
  return new Promise((resolve, reject) => {
    // half-open: a peer that sends DISCONNECT and closes its side must not fail our next write before we read its reason
    const sock = net.connect({ host, port, allowHalfOpen: true });
    const chunks: Bytes[] = [], waiters: Array<() => void> = []; let ended = false, err: Error | null = null;
    const wake = () => { for (const f of waiters.splice(0)) f(); };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a socket Buffer is a view of node's pool, an ArrayBuffer, never shared memory
    sock.on('data', (d: Buffer) => { chunks.push(new Uint8Array(d.buffer as ArrayBuffer, d.byteOffset, d.length)); wake(); });
    const end = () => { ended = true; wake(); };
    sock.on('end', end); sock.on('close', end);
    sock.on('error', e => { err = e; end(); reject(e); });
    sock.setTimeout(timeoutMs, () => { err = fail('timeout', 'socket timeout'); sock.destroy(); });
    sock.once('connect', () => { resolve({
      async read() { for (;;) { const c = chunks.shift(); if (c) return c; if (err) throw err; if (ended) return null; await new Promise<void>(r => { waiters.push(r); }); } },
      write(bytes) { return new Promise<void>((res, rej) => { sock.write(bytes, e => { if (e) rej(e); else res(); }); }); },
      close() { sock.end(); sock.destroy(); },
    }); });
  });
}
