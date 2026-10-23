// git over SSH: the same pkt-line/v2/pack bytes as smart HTTP, on one channel per service instead of one POST per
// command. `createSshTransport` returns a transport record that lsRefs/packStream/push/discover/receiveCaps use
// unchanged (transport.js dispatches to t.frames / t.advertise). One SSH connection serves every command of an edit.
//
//   git-upload-pack  (v2 via `env GIT_PROTOCOL=version=2`): the server speaks first — "version 2" + capabilities + flush —
//                    then each command's response ends at a top-level flush; the channel stays open for the next command.
//   git-receive-pack (v0): the server speaks first — ref advertisement with capabilities + flush — then one push.
// URL forms: ssh://[user@]host[:port]/path and the scp-like user@host:path (GitHub: git@github.com:owner/repo.git).
import { fail } from './errors.js';
import { SshClient, hostKeyFromLine } from './ssh.js';
import { pktInit, pktStep, FLUSH } from './pktline.js';
import { td, concat } from './bytes.js';
import { DEFAULT_LIMITS } from './limits.js';


export function parseSshUrl(url) {
  let m = String(url).match(/^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.*)$/);
  if (m) return { user: m[1] ?? 'git', host: m[2], port: m[3] ? +m[3] : 22, path: '/' + m[4] };
  m = String(url).includes('://') ? null : String(url).match(/^(?:([^@/]+)@)?([^/:]+):(?!\d+(?:\/|$))(.+)$/); // scp-like: no scheme, host:path
  if (m) return { user: m[1] ?? 'git', host: m[2], port: 22, path: m[3] };
  throw fail('bad_request', `not an ssh git url: ${url}`);
}
export const sshRedact = ({ user, host, port, path }) => `ssh://${user}@${host}${port === 22 ? '' : `:${port}`}${path.startsWith('/') ? '' : '/'}${path}`;

// `connect(host, port) → stream` is the platform's TCP (ssh-node.js / ssh-workers.js); the key is a WebCrypto Ed25519 pair.
export function createSshTransport(url, { privateKey, publicKeyRaw, hostKey, connect, tracer, parent = null, limits = DEFAULT_LIMITS, signal = null, user: userOverride } = {}) {
  const u = parseSshUrl(url); if (userOverride) u.user = userOverride;
  if (!hostKey) throw fail('bad_request', 'hostKey is required: an SSH client in a Worker cannot trust-on-first-use (ssh-keyscan -t ed25519 <host>)');
  const pinned = hostKey instanceof Uint8Array ? hostKey : hostKeyFromLine(hostKey);
  const st = { client: null, channels: new Map(), connecting: null };
  const t = {
    kind: 'ssh', url: sshRedact(u), ssh: u, tracer, parent, limits, signal, quirks: {}, objects: new Map(),
    async connectOnce(span) {
      if (st.client) return st.client;
      if (!st.connecting) st.connecting = (async () => {
        const stream = await connect(u.host, u.port, { timeoutMs: limits.requestTimeoutMs });
        const c = new SshClient(stream, { user: u.user, privateKey, publicKeyRaw, hostKey: pinned, tracer, parent: span ?? t.parent, timeoutMs: limits.requestTimeoutMs });
        await c.connect(); await c.authenticate();
        st.client = c; return c;
      })();
      return st.connecting;
    },
    // One channel per service, opened on first use; the server's opening advertisement is read and kept.
    async channelFor(service, span) {
      if (st.channels.has(service)) return st.channels.get(service);
      const c = await t.connectOnce(span);
      const quoted = `'${u.path.replace(/'/g, `'\\''`)}'`;
      const chSpan = tracer.start('ssh.exec', { parent: span ?? t.parent, attrs: { 'ssh.command': `${service} ${quoted}`, 'git.service': service } });
      const ch = await c.exec(`${service} ${quoted}`, { env: service === 'git-upload-pack' ? { GIT_PROTOCOL: 'version=2' } : {} });
      const entry = { ch, pkt: pktInit(), carry: [], adv: null, caps: null, span: chSpan, bytesIn: 0, bytesOut: 0, lock: Promise.resolve() };
      // read the advertisement: frames up to and including the first flush
      const advFrames = []; const raw = [];
      for await (const f of t.readUntilFlush(entry, raw)) advFrames.push(f);
      entry.adv = concat(raw);
      const first = advFrames.find(f => f.kind === 'data'); const firstLine = first ? td.decode(first.payload).replace(/\n$/, '') : '';
      if (service === 'git-upload-pack') {
        if (firstLine !== 'version 2') { await t.close(); throw fail('unsupported', `ssh: server did not speak protocol v2 (first line ${JSON.stringify(firstLine.slice(0, 60))}); it must accept the GIT_PROTOCOL environment variable (AcceptEnv GIT_PROTOCOL)${ch.stderr() ? `; stderr: ${ch.stderr().trim().slice(0, 200)}` : ''}`); }
        entry.caps = advFrames.filter(f => f.kind === 'data').map(f => td.decode(f.payload).replace(/\n$/, '')).slice(1);
      } else {
        const nul = first ? first.payload.indexOf(0) : -1;
        entry.caps = nul >= 0 ? td.decode(first.payload.subarray(nul + 1)).trim().split(' ') : [];
        if (!first) { const err = ch.stderr().trim(); await t.close(); throw fail(/denied|not found|does not appear|no such|fatal/i.test(err) ? 'not_found' : 'remote_error', `ssh: ${service} sent no advertisement${err ? `: ${err.slice(0, 200)}` : ''}`); }
      }
      chSpan.set({ 'git.advertisement.bytes': entry.adv.length, 'git.advertisement.caps': entry.caps.slice(0, 32) });
      st.channels.set(service, entry);
      return entry;
    },
    // Frames from the channel up to and including the next top-level flush (the decoder state carries across commands).
    async *readUntilFlush(entry, rawOut = null) {
      // frames already decoded but not yet yielded (a chunk can carry the end of one response and the start of the next)
      while (entry.carry.length) { const f = entry.carry.shift(); yield f; if (f.kind === 'flush') return; }
      for await (const chunk of entry.ch.stdout()) {
        entry.bytesIn += chunk.length; if (rawOut) rawOut.push(chunk);
        const r = pktStep(entry.pkt, chunk); entry.pkt = r.state;
        let i = 0;
        for (; i < r.frames.length; i++) { yield r.frames[i]; if (r.frames[i].kind === 'flush') { entry.carry.push(...r.frames.slice(i + 1)); return; } }
      }
      const err = entry.ch.stderr().trim();
      throw fail(err ? 'remote_error' : 'protocol', `ssh: ${entry.span.attrs['git.service']} ended before the response was complete${err ? `: ${err.slice(0, 300)}` : ''}`, { exit: await entry.ch.exit() });
    },
    // A channel is one git process reading commands in order: concurrent callers (editFile overlaps ls-refs with a
    // speculative fetch) are serialized here, each taking the channel from body write to the closing flush.
    async *frames(service, body, span) {
      const entry = await t.channelFor(service, span);
      span.set({ 'git.transport': 'ssh', 'server.address': `${u.host}:${u.port}`, 'url.full': t.url, 'git.request.bytes': body.length, 'git.response.cache': '', 'git.service': service });
      let release; const mine = new Promise(r => { release = r; }); const prev = entry.lock; entry.lock = mine;
      const tq = Date.now(); await prev; span.set({ 'ssh.channel.queued_ms': Date.now() - tq });
      try {
        const t0 = Date.now();
        await entry.ch.write(body); entry.bytesOut += body.length;
        let bytes = 0, first = null;
        for await (const f of t.readUntilFlush(entry)) { if (first === null) first = Date.now() - t0; bytes += 4 + (f.payload?.length ?? 0); yield f; }
        span.set({ 'git.response.bytes': bytes, 'git.response.first_byte_ms': first ?? -1, 'git.response.duration_ms': Date.now() - t0, 'ssh.channel.stderr.tail': entry.ch.stderr().slice(-256) });
      } finally { release(); }
      if (service === 'git-receive-pack') {
        await t.closeChannel(service); // one push per receive-pack process
        // git caches loose refs for the life of a process: a long-lived upload-pack would keep answering with the refs
        // as they were before the push (found by `verify` over ssh). Drop it; the next command starts a fresh one.
        await t.closeChannel('git-upload-pack');
      }
    },
    async advertise(service, span) { const entry = await t.channelFor(service, span); span.set({ 'git.transport': 'ssh', 'server.address': `${u.host}:${u.port}`, 'git.response.bytes': entry.adv.length }); return entry.adv; },
    async closeChannel(service) {
      const entry = st.channels.get(service); if (!entry) return; st.channels.delete(service);
      try { if (service === 'git-upload-pack') { await entry.ch.write(FLUSH); } await entry.ch.eof(); const code = await entry.ch.exit(); entry.span.set({ 'ssh.exit': code ?? -1, 'ssh.bytes.in': entry.bytesIn, 'ssh.bytes.out': entry.bytesOut }); await entry.ch.close(); }
      catch (e) { entry.span.error(e); }
      entry.span.end();
    },
    async close() { for (const s of [...st.channels.keys()]) await t.closeChannel(s); if (st.client) { st.lastStats = st.client.stats; await st.client.disconnect(); st.client = null; st.connecting = null; } },
    stats: () => st.client?.stats ?? st.lastStats ?? null,
  };
  return t;
}
