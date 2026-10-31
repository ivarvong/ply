// git over SSH: the same pkt-line/v2/pack bytes as smart HTTP, on one channel per service instead of one POST per
// command. `createSshTransport` returns a transport record that lsRefs/packStream/push/discover/receiveCaps use
// unchanged (transport.js dispatches to t.frames / t.advertise). One SSH connection serves every command of an edit.
//
//   git-upload-pack  (v2 via `env GIT_PROTOCOL=version=2`): the server speaks first — "version 2" + capabilities + flush —
//                    then each command's response ends at a top-level flush; the channel stays open for the next command.
//   git-receive-pack (v0): the server speaks first — ref advertisement with capabilities + flush — then one push.
// URL forms: ssh://[user@]host[:port]/path and the scp-like user@host:path (GitHub: git@github.com:owner/repo.git).
import { thrown as fail } from './errors.ts';
import { SshClient, hostKeyFromLine } from './ssh.js';
import { pktInit, pktStep, FLUSH } from './pktline.js';
import { td, te, concat, decodeStrict } from './bytes.js';
import { scrubber, secretUser, REDACTED } from './scrub.js';
import { DEFAULT_LIMITS, requireLimit, limitError } from './limits.ts';
import { validateWire } from './validate.js';
import { wrapNet } from './transport.js';


// An ssh:// URL is percent-decoded as git decodes it (git 2.50, measured through GIT_SSH_COMMAND): `%XX` is that byte
// in the user, host and path (`t%C3%ABst` → `tëst`, `p%20q` → `p q`), except `%00`, which git keeps as written, and
// an invalid escape (`%ZZ`), kept too. The scp-like form is not decoded (git: `iv%40ar@host:p` logs in as `iv%40ar`).
// SSH strings are UTF-8 (RFC 4252), so bytes that are not are refused.
const SSH_URL = 'invalid ssh url: expected ssh://[user@]host[:port]/path or [user@]host:path';
const sshDecode = s => {
  if (!s.includes('%')) return s;
  const parts = s.split(/(%[0-9a-f]{2})/i);
  const bytes = [];
  for (const p of parts) {
    if (/^%[0-9a-f]{2}$/i.test(p) && p !== '%00') bytes.push(parseInt(p.slice(1), 16));
    else for (const b of te.encode(p)) bytes.push(b);
  }
  try { return decodeStrict(Uint8Array.from(bytes)); } catch { throw fail('bad_request', 'invalid ssh url: a percent-escape is not UTF-8', { what: 'ssh url' }); }
};
// A `:` in the userinfo is a password. ply authenticates by public key only, and git hands `user:pass@host` to ssh,
// which logs in as `user:pass`: the password goes to the server as the login name (measured, every form: `ivar:@`,
// `ivar:pass@`, `:pass@`; the scp-like `ivar:pass@host:p` git reads as host `ivar`). Refused, and never quoted: no
// error from here echoes the URL.
const noPassword = user => { if (user?.includes(':')) throw fail('bad_request', 'invalid ssh url: a password in the userinfo is not supported (ply authenticates by public key); remove it', { what: 'ssh url' }); return user; };

// @decoder parseSshUrl prefix=ssh-url
export function parseSshUrl(url) {
  let m = String(url).match(/^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.*)$/);
  if (m) return { user: m[1] === undefined ? 'git' : sshDecode(noPassword(m[1])), host: sshDecode(m[2]), port: m[3] ? +m[3] : 22, path: '/' + sshDecode(m[4]) };
  m = String(url).includes('://') ? null : String(url).match(/^(?:([^@/]+)@)?([^/:]+):(?!\d+(?:\/|$))(.+)$/); // scp-like: no scheme, host:path
  if (m) return { user: noPassword(m[1]) ?? 'git', host: m[2], port: 22, path: m[3] };
  throw fail('bad_request', SSH_URL, { what: 'ssh url' });
}
// The login name is not a credential under publickey auth, but one that is secret-shaped (a token pasted into an ssh URL,
// `ssh://ghp_…@host`) is treated as one, by the rule HTTP applies to a user with no password (scrub.js): it is sent to
// the server as the login, and replaced by '[redacted]' in `t.url`, spans and errors.
export const sshRedact = ({ user, host, port, path }) => `ssh://${secretUser(user, false) ? REDACTED : user}@${host}${port === 22 ? '' : `:${port}`}${path.startsWith('/') ? '' : '/'}${path}`;

// A service that ends before writing a byte refused the command: git prints the server's stderr and "Could not read from
// remote repository" for every such refusal; ply types it from that text as HTTP types a status. A missing repository
// is `not_found` (git's own "does not appear to be a git repository", a host's "Repository not found"), a denied one
// `auth` (HTTP 403: "Permission to o/r.git denied", "access denied"), anything else the server said `remote_error`
// (a shell's "git-upload-pack: command not found" is the host lacking git, not the repository missing).
export const refusalCode = stderr => /does not appear to be a git repository|repository not found|not a git repository/i.test(stderr) ? 'not_found'
  : /permission denied|access denied|denied to |forbidden/i.test(stderr) ? 'auth' : 'remote_error';

// `connect(host, port) → stream` is the platform's TCP (ssh-node.js / ssh-workers.js); the key is a WebCrypto Ed25519 pair.
export function createSshTransport(url, { privateKey, publicKeyRaw, hostKey, connect, tracer, parent = null, limits = DEFAULT_LIMITS, signal = null, user: userOverride } = {}) {
  const u = parseSshUrl(url); if (userOverride) u.user = userOverride;
  validateWire(u.user, 'ssh user'); validateWire(u.host, 'ssh host'); validateWire(u.path, 'ssh path');
  const timeoutMs = requireLimit(limits, 'requestTimeoutMs');
  if (!hostKey) throw fail('bad_request', 'hostKey is required: an SSH client in a Worker cannot trust-on-first-use (ssh-keyscan -t ed25519 <host>)');
  const pinned = hostKey instanceof Uint8Array ? hostKey : hostKeyFromLine(hostKey);
  // SAFETY I1 for SSH. Every wait on the server is bounded by `requestTimeoutMs` and by the caller's `signal`, and ends in
  // the error HTTP gives for the same event (wrapNet: `timeout` / `aborted`). The stream's own timers are idle timers: a
  // server trickling a byte at a time never trips them. Bounds: connection + handshake + channel setup (+ advertisement);
  // one command from its body write to its closing flush (time queued behind the channel's previous command is not
  // counted: that command holds its own bound); close. Every channel shares one byte stream, so a bound that fires tears
  // the connection down: `conn.dead` rejects and every read and write races it, so a pending read ends at once whatever
  // the platform stream does on close(). The next command opens a new connection. The timer is the strong owner of the
  // teardown (not AbortSignal.timeout, for the reason http.js gives).
  const fresh = () => { const conn = { reason: null, raw: null }; conn.dead = new Promise((_, rej) => { conn.kill = rej; }); conn.dead.catch(() => {}); return conn; };
  const st = { client: null, channels: new Map(), opening: new Map(), connecting: null, conn: fresh() };
  const teardown = (conn, e) => {
    if (conn.reason) return;
    conn.reason = e; conn.kill(e);
    try { conn.raw?.close(); } catch { /* already closed */ }
    if (st.conn !== conn) return;
    for (const entry of st.channels.values()) { entry.span.error(e).set({ 'ssh.exec.outcome': e?.code ?? 'error' }); entry.span.end(); }
    if (st.client) st.lastStats = st.client.stats;
    st.channels = new Map(); st.opening = new Map(); st.client = null; st.connecting = null; st.conn = fresh();
  };
  const bound = () => {
    if (signal?.aborted) throw wrapNet(signal.reason, signal);
    const conn = st.conn;
    const timer = setTimeout(() => teardown(conn, wrapNet(new DOMException(`request exceeded ${timeoutMs} ms`, 'TimeoutError'))), timeoutMs);
    timer?.unref?.();
    const onAbort = () => teardown(conn, wrapNet(signal.reason, signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    return () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  };
  const t = {
    kind: 'ssh', url: sshRedact(u), ssh: u, tracer, parent, limits, signal, quirks: {}, objects: new Map(), scrub: secretUser(u.user, false) ? scrubber([u.user]) : null,
    async connectOnce(span) {
      if (st.client) return st.client;
      const conn = st.conn;
      if (st.connecting) return st.connecting;
      // A handshake that fails (refused, bad banner, host key, auth) is not kept: the next command dials again.
      const p = st.connecting = (async () => {
        const opening = Promise.resolve(connect(u.host, u.port, { timeoutMs }));
        opening.then(raw => { if (conn.reason) try { raw.close(); } catch { /* closing */ } }, () => {});
        const raw = conn.raw = await Promise.race([opening, conn.dead]);
        if (conn.reason) { try { raw.close(); } catch { /* closing */ } throw conn.reason; }
        // a platform stream's own failure (a reset, a write after the peer went) is `network`, as HTTP types it
        const net = e => { throw wrapNet(e); };
        const stream = { read: () => Promise.race([raw.read(), conn.dead]).catch(net), write: bytes => Promise.race([raw.write(bytes), conn.dead]).catch(net), close: () => raw.close() };
        const c = new SshClient(stream, { user: u.user, privateKey, publicKeyRaw, hostKey: pinned, tracer, parent: span ?? t.parent });
        try { await c.connect(); await c.authenticate(); } catch (e) { try { raw.close(); } catch { /* closing */ } throw e; } // a failed handshake holds no socket
        st.client = c; return c;
      })();
      p.catch(() => { if (st.connecting === p) st.connecting = null; });
      return p;
    },
    // One channel per service, opened on first use; the server's opening advertisement is read and kept. Concurrent first
    // callers (editFile overlaps ls-refs with a speculative fetch) share one opening: a second channel would escape the
    // first one's command lock.
    channelFor(service, span) {
      if (st.channels.has(service)) return Promise.resolve(st.channels.get(service));
      if (!st.opening.has(service)) {
        const p = t.openChannel(service, span).finally(() => { if (st.opening.get(service) === p) st.opening.delete(service); });
        st.opening.set(service, p);
      }
      return st.opening.get(service);
    },
    // A channel that fails to open closes the transport, as a failed handshake does: a failed command holds no socket.
    async openChannel(service, span) {
      const c = await t.connectOnce(span);
      const quoted = `'${u.path.replace(/'/g, `'\\''`)}'`;
      // the channel (one git process) lives until closeChannel, across commands and operations: it follows the span that
      // opened it rather than being its child (README "Span lifetimes")
      const chSpan = tracer.start('ssh.exec', { follows: span ?? t.parent, scrub: t.scrub, attrs: { 'ssh.command': `${service} ${quoted}`, 'git.service': service } });
      try {
        const ch = await c.exec(`${service} ${quoted}`, { env: service === 'git-upload-pack' ? { GIT_PROTOCOL: 'version=2' } : {} });
        const entry = { ch, pkt: pktInit(), carry: [], carryAt: 0, adv: null, caps: null, span: chSpan, bytesIn: 0, bytesOut: 0, lock: Promise.resolve() };
        // read the advertisement: frames up to and including the first flush
        const advFrames = []; const raw = [];
        for await (const f of t.readUntilFlush(entry, raw)) advFrames.push(f);
        entry.adv = concat(raw);
        const first = advFrames.find(f => f.kind === 'data'); const firstLine = first ? td.decode(first.payload).replace(/\n$/, '') : '';
        if (service === 'git-upload-pack') {
          if (firstLine !== 'version 2') throw fail('unsupported', `ssh: server did not speak protocol v2 (first line ${JSON.stringify(firstLine.slice(0, 60))}); it must accept the GIT_PROTOCOL environment variable (AcceptEnv GIT_PROTOCOL)${ch.stderr() ? `; stderr: ${ch.stderr().trim().slice(0, 200)}` : ''}`);
          entry.caps = advFrames.filter(f => f.kind === 'data').map(f => td.decode(f.payload).replace(/\n$/, '')).slice(1);
        } else {
          const nul = first ? first.payload.indexOf(0) : -1;
          entry.caps = nul >= 0 ? td.decode(first.payload.subarray(nul + 1)).trim().split(' ') : [];
          if (!first) throw fail('protocol', `ssh: ${service} sent an empty advertisement (no ref line, no capabilities)`);
        }
        chSpan.set({ 'git.advertisement.bytes': entry.adv.length, 'git.advertisement.caps': entry.caps.slice(0, 32) });
        st.channels.set(service, entry);
        return entry;
      } catch (e) { chSpan.error(e).set({ 'ssh.exec.outcome': e?.code ?? 'error' }); chSpan.end(); await t.close(); throw e; }
    },
    // Frames from the channel up to and including the next top-level flush (the decoder state carries across commands).
    async *readUntilFlush(entry, rawOut = null) {
      // frames already decoded but not yet yielded (a chunk can carry the end of one response and the start of the next).
      // An index, not shift(): the remainder can be every pkt-line of the next pack, and shift is O(n) per frame.
      const maxAdv = rawOut ? requireLimit(t.limits, 'maxPackBytes') : 0;
      let advBytes = 0;
      while (entry.carryAt < entry.carry.length) {
        const f = entry.carry[entry.carryAt++];
        if (entry.carryAt === entry.carry.length) { entry.carry = []; entry.carryAt = 0; }
        yield f;
        if (f.kind === 'flush') return;
      }
      for await (const chunk of entry.ch.stdout()) {
        entry.bytesIn += chunk.length;
        if (rawOut) {
          advBytes += chunk.length;
          if (advBytes > maxAdv) throw limitError('advertisement bytes', advBytes, maxAdv);
          rawOut.push(chunk);
        }
        const r = pktStep(entry.pkt, chunk); entry.pkt = r.state;
        let i = 0;
        for (; i < r.frames.length; i++) { yield r.frames[i]; if (r.frames[i].kind === 'flush') { entry.carry.push(...r.frames.slice(i + 1)); return; } }
      }
      // the exit status first: stderr can still be arriving when stdout ends
      const exit = await entry.ch.exit(), err = entry.ch.stderr().trim(), service = entry.span.attrs['git.service'];
      if (rawOut && !advBytes) throw fail(refusalCode(err), `ssh: ${service} ended before its advertisement (exit ${exit ?? 'unknown'})${err ? `: ${err.slice(0, 300)}` : ''}`, { exit });
      throw fail(err ? 'remote_error' : 'protocol', `ssh: ${service} ended before the response was complete${err ? `: ${err.slice(0, 300)}` : ''}`, { exit });
    },
    // A channel is one git process reading commands in order: concurrent callers (editFile overlaps ls-refs with a
    // speculative fetch) are serialized here, each taking the channel from body write to the closing flush.
    async *frames(service, body, span) {
      let done = bound(), entry;
      try { entry = await t.channelFor(service, span); } finally { done(); }
      span.set({ 'git.transport': 'ssh', 'server.address': `${u.host}:${u.port}`, 'url.full': t.url, 'git.request.bytes': body.length, 'git.response.cache': '', 'git.service': service });
      let release; const mine = new Promise(r => { release = r; }); const prev = entry.lock; entry.lock = mine;
      // A command queued behind one whose bound fired holds a channel of the torn-down connection: its first write
      // rejects at once with that bound's error (the stream races `conn.dead`).
      const tq = Date.now(); await prev; span.set({ 'ssh.channel.queued_ms': Date.now() - tq });
      try { done = bound(); } catch (e) { release(); throw e; }
      try {
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
      } finally { done(); }
    },
    async advertise(service, span) {
      const done = bound();
      try { const entry = await t.channelFor(service, span); span.set({ 'git.transport': 'ssh', 'server.address': `${u.host}:${u.port}`, 'git.response.bytes': entry.adv.length }); return entry.adv; }
      finally { done(); }
    },
    async closeChannel(service) {
      const entry = st.channels.get(service); if (!entry) return; st.channels.delete(service);
      try { if (service === 'git-upload-pack') { await entry.ch.write(FLUSH); } await entry.ch.eof(); const code = await entry.ch.exit(); entry.span.set({ 'ssh.exit': code ?? -1, 'ssh.bytes.in': entry.bytesIn, 'ssh.bytes.out': entry.bytesOut, 'ssh.exec.outcome': 'ok' }); await entry.ch.close(); }
      catch (e) { entry.span.error(e).set({ 'ssh.exec.outcome': e?.code ?? 'error' }); }
      entry.span.end();
    },
    // Bounded like a command; with the signal already aborted the connection is dropped without the goodbye.
    async close() {
      let done;
      try { done = bound(); } catch (e) { teardown(st.conn, e); return; }
      try { for (const s of [...st.channels.keys()]) await t.closeChannel(s); if (st.client) { st.lastStats = st.client.stats; await st.client.disconnect(); st.client = null; st.connecting = null; st.conn = fresh(); } }
      finally { done(); }
    },
    stats: () => st.client?.stats ?? st.lastStats ?? null,
  };
  return t;
}
