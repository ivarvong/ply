// Cloudflare Workers byte stream for the SSH client: `connect()` from cloudflare:sockets (outbound TCP).
import { thrown as fail } from './errors.ts';
import { connect } from 'cloudflare:sockets';
export async function workersStream(host, port, { timeoutMs = 30000 } = {}) {
  const sock = connect({ hostname: host, port }, { allowHalfOpen: false });
  const reader = sock.readable.getReader(); const writer = sock.writable.getWriter();
  await sock.opened;
  let timer = null;
  const armed = p => { if (!timeoutMs) return p; return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(fail('timeout', 'socket timeout')), timeoutMs); })]).finally(() => clearTimeout(timer)); };
  return {
    async read() { const { value, done } = await armed(reader.read()); return done ? null : value; },
    write(bytes) { return armed(writer.write(bytes)); },
    close() { try { writer.close().catch(() => {}); } catch { /* ignore */ } try { sock.close(); } catch { /* ignore */ } },
  };
}
