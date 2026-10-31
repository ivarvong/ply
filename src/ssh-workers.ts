// Cloudflare Workers byte stream for the SSH client: `connect()` from cloudflare:sockets (outbound TCP).
/* oxlint-disable typescript/promise-function-async -- armed() and write() hand on the race and the writer's promise, not a wrapper around them */
import { thrown as fail } from './errors.js';
import { connect } from 'cloudflare:sockets';
import type { SshStream } from './ssh.js';
export async function workersStream(host: string, port: number, { timeoutMs = 30_000 }: { readonly timeoutMs?: number } = {}): Promise<SshStream> {
  const sock = connect({ hostname: host, port }, { allowHalfOpen: false });
  const reader = sock.readable.getReader(); const writer = sock.writable.getWriter();
  await sock.opened;
  let timer: ReturnType<typeof setTimeout> | undefined; // undefined, not null: clearTimeout's type (both clear nothing)
  const armed = <T>(p: Promise<T>): Promise<T> => { if (!timeoutMs) return p; return Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => { rej(fail('timeout', 'socket timeout')); }, timeoutMs); })]).finally(() => { clearTimeout(timer); }); };
  return {
    async read() { const { value, done } = await armed(reader.read()); return done ? null : value; },
    write(bytes) { return armed(writer.write(bytes)); },
    // oxlint-disable-next-line typescript/no-floating-promises -- best effort, as before: nothing waits on the socket closing
    close() { try { writer.close().catch(() => { /* already closed */ }); } catch { /* ignore */ } try { sock.close(); } catch { /* ignore */ } },
  };
}
