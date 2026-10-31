// git over SSH: the same pkt-line/v2/pack bytes as smart HTTP, on one channel per service instead of one POST per
// command. `createSshTransport` returns a transport record that lsRefs/packStream/push/discover/receiveCaps use
// unchanged (transport.js dispatches to t.frames / t.advertise). One SSH connection serves every command of an edit.
//
//   git-upload-pack  (v2 via `env GIT_PROTOCOL=version=2`): the server speaks first — "version 2" + capabilities + flush —
//                    then each command's response ends at a top-level flush; the channel stays open for the next command.
//   git-receive-pack (v0): the server speaks first — ref advertisement with capabilities + flush — then one push.
// URL forms: ssh://[user@]host[:port]/path and the scp-like user@host:path (GitHub: git@github.com:owner/repo.git).
/* oxlint-disable no-await-in-loop, typescript/promise-function-async -- one channel carries one command at a time: each read and write follows the one before; a function that hands on a promise it did not make (the shared opening, a race) is not wrapped in another */
import { thrown as fail } from './errors.js';
import type { Exec, SpanLike, SshStats, SshStream, TracerLike } from './ssh.js';
import { SshClient, hostKeyFromLine } from './ssh.js';
import { pktInit, pktStep, FLUSH } from './pktline.js';
import { td, te, concat, decodeStrict } from './bytes.js';
import { scrubber, secretUser, REDACTED } from './scrub.js';
import type { Limits } from './limits.js';
import { DEFAULT_LIMITS, requireLimit, limitError } from './limits.js';
import { validateWire } from './validate.js';
import { wrapNet } from './transport.js';


// An ssh:// URL is percent-decoded as git decodes it (git 2.50, measured through GIT_SSH_COMMAND): `%XX` is that byte
// in the user, host and path (`t%C3%ABst` → `tëst`, `p%20q` → `p q`), except `%00`, which git keeps as written, and
// an invalid escape (`%ZZ`), kept too. The scp-like form is not decoded (git: `iv%40ar@host:p` logs in as `iv%40ar`).
// SSH strings are UTF-8 (RFC 4252), so bytes that are not are refused.
const SSH_URL = 'invalid ssh url: expected ssh://[user@]host[:port]/path or [user@]host:path';
const URL_WHAT = { what: 'ssh url' }; // copied into each error (thrown spreads it), never shared
const sshDecode = (s: string): string => {
  if (!s.includes('%')) return s;
  const parts = s.split(/(%[0-9a-f]{2})/iu);
  const bytes: number[] = [];
  for (const p of parts) {
    if (/^%[0-9a-f]{2}$/iu.test(p) && p !== '%00') bytes.push(Number.parseInt(p.slice(1), 16));
    else for (const b of te.encode(p)) bytes.push(b);
  }
  try { return decodeStrict(Uint8Array.from(bytes)); } catch { throw fail('bad_request', 'invalid ssh url: a percent-escape is not UTF-8', URL_WHAT); }
};
// A `:` in the userinfo is a password. ply authenticates by public key only, and git hands `user:pass@host` to ssh,
// which logs in as `user:pass`: the password goes to the server as the login name (measured, every form: `ivar:@`,
// `ivar:pass@`, `:pass@`; the scp-like `ivar:pass@host:p` git reads as host `ivar`). Refused, and never quoted: no
// error from here echoes the URL.
const noPassword = <U extends string | undefined>(user: U): U => { if (user?.includes(':') === true) throw fail('bad_request', 'invalid ssh url: a password in the userinfo is not supported (ply authenticates by public key); remove it', URL_WHAT); return user; };

export type SshUrl = { user: string; host: string; port: number; path: string };
// @decoder parseSshUrl prefix=ssh-url
export function parseSshUrl(url: unknown): SshUrl {
  // Every group but the user and the port always takes part in a match, so no `?? ''` below ever applies.
  let m = String(url).match(/^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.*)$/u);
  if (m) return { user: m[1] === undefined ? 'git' : sshDecode(noPassword(m[1])), host: sshDecode(m[2] ?? ''), port: m[3] === undefined ? 22 : +m[3], path: `/${sshDecode(m[4] ?? '')}` };
  m = String(url).includes('://') ? null : String(url).match(/^(?:([^@/]+)@)?([^/:]+):(?!\d+(?:\/|$))(.+)$/u); // scp-like: no scheme, host:path
  if (m) return { user: noPassword(m[1]) ?? 'git', host: m[2] ?? '', port: 22, path: m[3] ?? '' };
  throw fail('bad_request', SSH_URL, URL_WHAT);
}
// The login name is not a credential under publickey auth, but one that is secret-shaped (a token pasted into an ssh URL,
// `ssh://ghp_…@host`) is treated as one, by the rule HTTP applies to a user with no password (scrub.js): it is sent to
// the server as the login, and replaced by '[redacted]' in `t.url`, spans and errors.
export const sshRedact = ({ user, host, port, path }: SshUrl): string => `ssh://${secretUser(user, false) ? REDACTED : user}@${host}${port === 22 ? '' : `:${port}`}${path.startsWith('/') ? '' : '/'}${path}`;

// A service that ends before writing a byte refused the command: git prints the server's stderr and "Could not read from
// remote repository" for every such refusal; ply types it from that text as HTTP types a status. A missing repository
// is `not_found` (git's own "does not appear to be a git repository", a host's "Repository not found"), a denied one
// `auth` (HTTP 403: "Permission to o/r.git denied", "access denied"), anything else the server said `remote_error`
// (a shell's "git-upload-pack: command not found" is the host lacking git, not the repository missing).
// A5: a typed refusal instead of reading the server's text.
export const refusalCode = (stderr: string): 'not_found' | 'auth' | 'remote_error' => {
  if (/does not appear to be a git repository|repository not found|not a git repository/iu.test(stderr)) return 'not_found';
  return /permission denied|access denied|denied to |forbidden/iu.test(stderr) ? 'auth' : 'remote_error';
};

// A pkt-line frame and the decoder state, as pktline's pktStep types them.
type PktStep = ReturnType<typeof pktStep>;
export type Frame = PktStep['frames'][number];
type ChannelEntry = {
  readonly ch: Exec;
  pkt: PktStep['state'];
  carry: Frame[];
  carryAt: number;
  adv: Uint8Array | null;
  caps: string[] | null;
  readonly span: SpanLike;
  bytesIn: number;
  bytesOut: number;
  lock: Promise<void>;
};
// One connection's teardown: `dead` rejects with `reason` when a bound fires (see below).
type Conn = { reason: object | null; raw: SshStream | null; dead: Promise<never>; kill: (e: unknown) => void };
export type SshConnect = (host: string, port: number, opts: { readonly timeoutMs: number }) => SshStream | Promise<SshStream>;
export type SshTransportOptions = {
  readonly privateKey: CryptoKey;
  readonly publicKeyRaw: Uint8Array;
  readonly hostKey: string | Uint8Array;
  readonly connect: SshConnect;
  readonly tracer: TracerLike;
  readonly parent?: unknown;
  readonly limits?: Partial<Limits>;
  readonly signal?: AbortSignal | null;
  readonly user?: string;
};
export type SshTransport = {
  readonly kind: 'ssh';
  readonly url: string;
  readonly ssh: SshUrl;
  readonly tracer: TracerLike;
  readonly parent: unknown;
  readonly limits: Partial<Limits>;
  readonly signal: AbortSignal | null;
  readonly quirks: Record<string, unknown>;
  readonly objects: Map<string, unknown>;
  readonly scrub: ((s: string) => string) | null;
  connectOnce(span?: SpanLike | null): Promise<SshClient>;
  channelFor(service: string, span?: SpanLike | null): Promise<ChannelEntry>;
  openChannel(service: string, span?: SpanLike | null): Promise<ChannelEntry>;
  readUntilFlush(entry: ChannelEntry, rawOut?: Uint8Array[] | null): AsyncGenerator<Frame, void>;
  frames(service: string, body: Uint8Array, span: SpanLike): AsyncGenerator<Frame, void>;
  advertise(service: string, span: SpanLike): Promise<Uint8Array | null>;
  closeChannel(service: string): Promise<void>;
  close(): Promise<void>;
  stats(): SshStats | null;
};

// a platform stream's own failure (a reset, a write after the peer went) is `network`, as HTTP types it
const net = (e: unknown): never => { throw wrapNet(e); };
// A thrown value read loosely (as errors.ts reads one): its code, else 'error'.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
const outcome = (e: unknown) => (e as { readonly code?: unknown } | null | undefined)?.code ?? 'error';

// `connect(host, port) → stream` is the platform's TCP (ssh-node.ts / ssh-workers.ts); the key is a WebCrypto Ed25519 pair.
// An untyped caller that passes no options still reaches the checks below (`= {}`), as before.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
export function createSshTransport(url: unknown, { privateKey, publicKeyRaw, hostKey, connect, tracer, parent = null, limits = DEFAULT_LIMITS, signal = null, user: userOverride }: SshTransportOptions = {} as SshTransportOptions): SshTransport {
  const u = parseSshUrl(url);
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- untyped callers: any falsy override keeps the URL's user
  if (userOverride) u.user = userOverride;
  validateWire(u.user, 'ssh user'); validateWire(u.host, 'ssh host'); validateWire(u.path, 'ssh path');
  const timeoutMs = requireLimit(limits, 'requestTimeoutMs');
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- untyped callers: any falsy hostKey is missing
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
  const fresh = (): Conn => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dead and kill are set on the next line, before conn escapes (a Promise executor runs at once)
    const conn = { reason: null, raw: null } as Conn;
    conn.dead = new Promise((_, rej) => { conn.kill = rej; }); conn.dead.catch(() => { /* observed by every race */ }); return conn;
  };
  const st: { client: SshClient | null; channels: Map<string, ChannelEntry>; opening: Map<string, Promise<ChannelEntry>>; connecting: Promise<SshClient> | null; conn: Conn; lastStats?: SshStats } = { client: null, channels: new Map(), opening: new Map(), connecting: null, conn: fresh() };
  const teardown = (conn: Conn, e: object) => {
    if (conn.reason) return;
    conn.reason = e; conn.kill(e);
    try { conn.raw?.close(); } catch { /* already closed */ }
    if (st.conn !== conn) return;
    for (const entry of st.channels.values()) { entry.span.error(e).set({ 'ssh.exec.outcome': outcome(e) }); entry.span.end(); }
    if (st.client) st.lastStats = st.client.stats;
    st.channels = new Map(); st.opening = new Map(); st.client = null; st.connecting = null; st.conn = fresh();
  };
  const bound = () => {
    if (signal?.aborted === true) throw wrapNet(signal.reason, signal);
    const conn = st.conn;
    const timer = setTimeout(() => { teardown(conn, wrapNet(new DOMException(`request exceeded ${timeoutMs} ms`, 'TimeoutError'))); }, timeoutMs);
    // node's timer would hold the process open for the bound; a Workers timer is a number and has no unref
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    (timer as unknown as { readonly unref?: () => unknown } | undefined)?.unref?.();
    const onAbort = () => { teardown(conn, wrapNet(signal?.reason, signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    return () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  };
  const t: SshTransport = {
    kind: 'ssh', url: sshRedact(u), ssh: u, tracer, parent, limits, signal, quirks: {}, objects: new Map(), scrub: secretUser(u.user, false) ? scrubber([u.user]) : null,
    // async: the early returns resolve, as they always have
    // oxlint-disable-next-line require-await -- see above
    async connectOnce(span) {
      if (st.client) return st.client;
      const conn = st.conn;
      if (st.connecting) return st.connecting;
      // A handshake that fails (refused, bad banner, host key, auth) is not kept: the next command dials again.
      const p = st.connecting = (async () => {
        const opening = Promise.resolve(connect(u.host, u.port, { timeoutMs }));
        // a socket that arrives after the bound fired is closed; a failed dial is reported by the race below
        // oxlint-disable-next-line promise/catch-or-return, promise/always-return -- see above
        opening.then(raw => { if (conn.reason) try { raw.close(); } catch { /* closing */ } }, () => { /* the race below reports it */ });
        const raw = conn.raw = await Promise.race([opening, conn.dead]);
        // oxlint-disable-next-line typescript/only-throw-error -- the bound's error (wrapNet's), rethrown
        if (conn.reason) { try { raw.close(); } catch { /* closing */ } throw conn.reason; }
        const stream: SshStream = { read: () => Promise.race([raw.read(), conn.dead]).catch(net), write: bytes => Promise.race([raw.write(bytes), conn.dead]).catch(net), close: () => raw.close() };
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
      const open = st.channels.get(service); if (open) return Promise.resolve(open);
      const pending = st.opening.get(service); if (pending) return pending;
      const p = t.openChannel(service, span).finally(() => { if (st.opening.get(service) === p) st.opening.delete(service); });
      st.opening.set(service, p);
      return p;
    },
    // A channel that fails to open closes the transport, as a failed handshake does: a failed command holds no socket.
    async openChannel(service, span) {
      const c = await t.connectOnce(span);
      const quoted = `'${u.path.replaceAll("'", `'\\''`)}'`;
      // the channel (one git process) lives until closeChannel, across commands and operations: it follows the span that
      // opened it rather than being its child (README "Span lifetimes")
      const chSpan = tracer.start('ssh.exec', { follows: span ?? t.parent, scrub: t.scrub, attrs: { 'ssh.command': `${service} ${quoted}`, 'git.service': service } });
      try {
        const ch = await c.exec(`${service} ${quoted}`, { env: service === 'git-upload-pack' ? { GIT_PROTOCOL: 'version=2' } : {} });
        const entry: ChannelEntry = { ch, pkt: pktInit(), carry: [], carryAt: 0, adv: null, caps: null, span: chSpan, bytesIn: 0, bytesOut: 0, lock: Promise.resolve() };
        // read the advertisement: frames up to and including the first flush
        const advFrames: Frame[] = []; const raw: Uint8Array[] = [];
        for await (const f of t.readUntilFlush(entry, raw)) advFrames.push(f);
        const adv = concat(raw); entry.adv = adv;
        let caps: string[];
        const first = advFrames.find(f => f.kind === 'data'); const firstLine = first ? td.decode(first.payload).replace(/\n$/u, '') : '';
        if (service === 'git-upload-pack') {
          if (firstLine !== 'version 2') throw fail('unsupported', `ssh: server did not speak protocol v2 (first line ${JSON.stringify(firstLine.slice(0, 60))}); it must accept the GIT_PROTOCOL environment variable (AcceptEnv GIT_PROTOCOL)${ch.stderr() ? `; stderr: ${ch.stderr().trim().slice(0, 200)}` : ''}`);
          caps = advFrames.filter(f => f.kind === 'data').map(f => td.decode(f.payload).replace(/\n$/u, '')).slice(1);
        } else {
          const nul = first ? first.payload.indexOf(0) : -1;
          caps = nul >= 0 ? td.decode(first?.payload.subarray(nul + 1)).trim().split(' ') : [];
          if (!first) throw fail('protocol', `ssh: ${service} sent an empty advertisement (no ref line, no capabilities)`);
        }
        entry.caps = caps;
        chSpan.set({ 'git.advertisement.bytes': adv.length, 'git.advertisement.caps': caps.slice(0, 32) });
        st.channels.set(service, entry);
        return entry;
      } catch (e) { chSpan.error(e).set({ 'ssh.exec.outcome': outcome(e) }); chSpan.end(); await t.close(); throw e; }
    },
    // Frames from the channel up to and including the next top-level flush (the decoder state carries across commands).
    async *readUntilFlush(entry, rawOut = null) {
      // frames already decoded but not yet yielded (a chunk can carry the end of one response and the start of the next).
      // An index, not shift(): the remainder can be every pkt-line of the next pack, and shift is O(n) per frame.
      const maxAdv = rawOut ? requireLimit(t.limits, 'maxPackBytes') : 0;
      let advBytes = 0;
      // A frame is an object, so the loop runs while carryAt is inside carry.
      for (let f = entry.carry[entry.carryAt]; f; f = entry.carry[entry.carryAt]) {
        entry.carryAt++;
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
        for (const f of r.frames) { i++; yield f; if (f.kind === 'flush') { entry.carry.push(...r.frames.slice(i)); return; } }
      }
      // the exit status first: stderr can still be arriving when stdout ends
      const exit = await entry.ch.exit();
      const err = entry.ch.stderr().trim();
      const service = String(entry.span.attrs['git.service']);
      const tail = err ? `: ${err.slice(0, 300)}` : '';
      if (rawOut && !advBytes) throw fail(refusalCode(err), `ssh: ${service} ended before its advertisement (exit ${exit ?? 'unknown'})${tail}`, { exit });
      throw fail(err ? 'remote_error' : 'protocol', `ssh: ${service} ended before the response was complete${tail}`, { exit });
    },
    // A channel is one git process reading commands in order: concurrent callers (editFile overlaps ls-refs with a
    // speculative fetch) are serialized here, each taking the channel from body write to the closing flush.
    async *frames(service, body, span) {
      let done = bound(), entry: ChannelEntry;
      try { entry = await t.channelFor(service, span); } finally { done(); }
      span.set({ 'git.transport': 'ssh', 'server.address': `${u.host}:${u.port}`, 'url.full': t.url, 'git.request.bytes': body.length, 'git.response.cache': '', 'git.service': service });
      let release: (() => void) | undefined;
      const mine = new Promise<void>(r => { release = r; }); const prev = entry.lock; entry.lock = mine;
      // A command queued behind one whose bound fired holds a channel of the torn-down connection: its first write
      // rejects at once with that bound's error (the stream races `conn.dead`).
      const tq = Date.now(); await prev; span.set({ 'ssh.channel.queued_ms': Date.now() - tq });
      try { done = bound(); } catch (e) { release?.(); throw e; }
      try {
        try {
          const t0 = Date.now();
          await entry.ch.write(body); entry.bytesOut += body.length;
          let bytes = 0, first: number | null = null;
          for await (const f of t.readUntilFlush(entry)) { first ??= Date.now() - t0; bytes += 4 + (f.payload?.length ?? 0); yield f; }
          span.set({ 'git.response.bytes': bytes, 'git.response.first_byte_ms': first ?? -1, 'git.response.duration_ms': Date.now() - t0, 'ssh.channel.stderr.tail': entry.ch.stderr().slice(-256) });
        } finally { release?.(); }
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
      try { const entry = await t.channelFor(service, span); span.set({ 'git.transport': 'ssh', 'server.address': `${u.host}:${u.port}`, 'git.response.bytes': entry.adv?.length }); return entry.adv; }
      finally { done(); }
    },
    async closeChannel(service) {
      const entry = st.channels.get(service); if (!entry) return; st.channels.delete(service);
      try { if (service === 'git-upload-pack') { await entry.ch.write(FLUSH); } await entry.ch.eof(); const code = await entry.ch.exit(); entry.span.set({ 'ssh.exit': code ?? -1, 'ssh.bytes.in': entry.bytesIn, 'ssh.bytes.out': entry.bytesOut, 'ssh.exec.outcome': 'ok' }); await entry.ch.close(); }
      catch (e) { entry.span.error(e).set({ 'ssh.exec.outcome': outcome(e) }); }
      entry.span.end();
    },
    // Bounded like a command; with the signal already aborted the connection is dropped without the goodbye.
    async close() {
      let done;
      // bound() throws wrapNet's error: an object
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
      try { done = bound(); } catch (e) { teardown(st.conn, e as object); return; }
      // a snapshot: closeChannel deletes from the map, and a teardown replaces it, mid-loop
      // oxlint-disable-next-line unicorn/no-useless-spread -- see above
      try { for (const s of [...st.channels.keys()]) await t.closeChannel(s); if (st.client) { st.lastStats = st.client.stats; await st.client.disconnect(); st.client = null; st.connecting = null; st.conn = fresh(); } }
      finally { done(); }
    },
    stats: () => st.client?.stats ?? st.lastStats ?? null,
  };
  return t;
}
