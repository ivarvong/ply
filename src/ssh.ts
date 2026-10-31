// SSH-2 client, zero dependencies, over any byte stream { read(): Promise<Uint8Array|null>, write(bytes), close() }.
// Enough of RFC 4253/4252/4254 to run one command on a git host and nothing more:
//   kex curve25519-sha256 · host key ssh-ed25519 (pinned, never trust-on-first-use) · aes128/256-gcm@openssh.com
//   userauth publickey with Ed25519 · session channel: env + exec, window flow control, stderr, exit-status
// Every primitive is WebCrypto (X25519, Ed25519, AES-GCM, SHA-256), so this runs on Workers and node ≥ 20 unchanged.
// Pure parts: the wire codec (ssh strings/mpints/name-lists), KEXINIT, the exchange hash, key derivation layout, packet
// padding. Effects: the stream and crypto.subtle. Spans: one per phase, attributes carry the negotiated algorithms.
/* oxlint-disable no-await-in-loop, max-classes-per-file, typescript/promise-function-async -- a byte stream is read and written in order, each step after the one before; Reader is the codec SshClient reads with; a function that returns a promise it did not make (the packet queues, the shared read) is not wrapped in another */
import type { Extra } from './errors.js';
import { thrown as fail } from './errors.js';
import { te, td, concat, decodeChunk } from './bytes.js';
import { KIND } from './otel.js';

// Bytes this module hands to WebCrypto: BufferSource excludes views of shared memory, and no byte here is shared.
export type Bytes = Uint8Array<ArrayBuffer>;
// The platform byte stream (ssh-node.ts, ssh-workers.ts, or sshgit's bounded wrapper around one).
export type SshStream = {
  read(): Promise<Bytes | null>;
  write(bytes: Uint8Array): Promise<unknown>;
  close(): unknown;
};
// The parts of otel's Tracer and Span this module and sshgit use.
export type SpanLike = {
  readonly attrs: Readonly<Record<string, unknown>>;
  set(attrs: Readonly<Record<string, unknown>>): SpanLike;
  error(e: unknown): SpanLike;
  end(): void;
};
export type SpanOptions = {
  readonly parent?: unknown;
  readonly follows?: unknown;
  readonly kind?: number;
  readonly scrub?: ((s: string) => string) | null;
  readonly attrs?: Readonly<Record<string, unknown>>;
};
export type TracerLike = {
  span<T>(name: string, opts: SpanOptions, fn: (span: SpanLike) => Promise<T>): Promise<T>;
  start(name: string, opts: SpanOptions): SpanLike;
};

const MSG = { DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7, KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53, USERAUTH_PK_OK: 60,
  GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82, CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93, CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98, CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100 } as const;
export const SSH_MSG: typeof MSG = MSG;
const sshErr = (msg: string, extra?: Extra) => fail('ssh', msg, extra);
// A handshake step that read some other message (a message always has its type byte: unpad keeps at least one).
const expected = (what: string, m: Uint8Array) => sshErr(`ssh: expected ${what}, got ${String(m[0])}`);

// ---- wire codec (pure) ----
export const u32 = (n: number): Bytes => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const str = (b: string | Uint8Array): Bytes => { const bytes = typeof b === 'string' ? te.encode(b) : b; return concat([u32(bytes.length), bytes]); };
// A leading byte with the high bit set gets a zero in front (an empty `t` has no leading byte: `undefined & 0x80` is 0).
export const mpint = (bytes: Uint8Array): Bytes => { let i = 0; while (i < bytes.length && bytes[i] === 0) i++; const t = bytes.subarray(i); return str((t[0] ?? 0) & 0x80 ? concat([Uint8Array.from([0]), t]) : t); };
export const nameList = (names: readonly string[]): Bytes => str(names.join(','));
export const bool = (b: boolean): Bytes => Uint8Array.from([b ? 1 : 0]);
export class Reader {
  public declare buf: Bytes;
  public declare p: number;
  public constructor(buf: Bytes) { this.buf = buf; this.p = 0; }
  public byte(): number { const b = this.buf[this.p]; if (b === undefined) throw sshErr('ssh: short message'); this.p++; return b; }
  // Checked whole before any byte is taken, so a short read consumes nothing.
  public u32(): number { if (this.p + 4 > this.buf.length) throw sshErr('ssh: short message'); return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0; }
  public bool(): boolean { return this.byte() !== 0; }
  public bytes(n: number): Bytes { if (this.p + n > this.buf.length) throw sshErr('ssh: short message'); const b = this.buf.subarray(this.p, this.p + n); this.p += n; return b; }
  public string(): Bytes { return this.bytes(this.u32()); }
  public text(): string { return td.decode(this.string()); }
  public names(): string[] { const t = this.text(); return t ? t.split(',') : []; }
}

export type Algorithms = {
  readonly kex: readonly string[];
  readonly hostKey: readonly string[];
  readonly cipher: readonly string[];
  readonly mac: readonly string[];
  readonly comp: readonly string[];
};
export const ALGS: Algorithms = Object.freeze({ kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org'], hostKey: ['ssh-ed25519'], cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'], mac: ['hmac-sha2-256'], comp: ['none'] });

// KEXINIT payload (pure given the cookie)
export function kexInit(cookie: Uint8Array): Bytes {
  return concat([Uint8Array.from([MSG.KEXINIT]), cookie, nameList(ALGS.kex), nameList(ALGS.hostKey), nameList(ALGS.cipher), nameList(ALGS.cipher), nameList(ALGS.mac), nameList(ALGS.mac), nameList(ALGS.comp), nameList(ALGS.comp), nameList([]), nameList([]), bool(false), u32(0)]);
}
export type KexInit = {
  readonly kex: string[];
  readonly hostKey: string[];
  readonly encCS: string[];
  readonly encSC: string[];
  readonly macCS: string[];
  readonly macSC: string[];
  readonly compCS: string[];
  readonly compSC: string[];
  readonly langCS: string[];
  readonly langSC: string[];
  readonly firstFollows: boolean;
};
// @decoder parseKexInit prefix=kex
export function parseKexInit(payload: Bytes): KexInit {
  const r = new Reader(payload); if (r.byte() !== MSG.KEXINIT) throw sshErr('ssh: expected KEXINIT');
  r.bytes(16);
  const out = { kex: r.names(), hostKey: r.names(), encCS: r.names(), encSC: r.names(), macCS: r.names(), macSC: r.names(), compCS: r.names(), compSC: r.names(), langCS: r.names(), langSC: r.names(), firstFollows: r.bool() };
  return out;
}
// First of ours the server also lists (RFC 4253 §7.1: client's preference order). Ours has no empty name.
export const pick = (ours: readonly string[], theirs: readonly string[], what: string): string => { const a = ours.find(x => theirs.includes(x)); if (a === undefined) throw fail('unsupported', `ssh: no common ${what} algorithm (server offers ${theirs.join(',')})`); return a; };

// Packet padding (pure): block 8 before NEWKEYS (whole packet incl. length), 16 with GCM (everything but the length).
export function padded(payload: Uint8Array, block: number, lengthCounts: boolean): Bytes {
  const fixed = (lengthCounts ? 4 : 0) + 1 + payload.length;
  let padLen = block - (fixed % block); if (padLen < 4) padLen += block;
  const pad = new Uint8Array(padLen); crypto.getRandomValues(pad);
  return concat([u32(1 + payload.length + padLen), Uint8Array.from([padLen]), payload, pad]);
}

// A packet's payload (pure): `body` is [padding_length][payload][padding], `len` bytes. RFC 4253 §6: at least 4 bytes of
// padding, a payload of at least the message type; OpenSSH refuses anything else ("incomplete message").
export const unpad = (body: Bytes, len: number): Bytes => {
  const padLen = body[0];
  if (padLen === undefined || padLen < 4 || padLen > len - 2) throw sshErr(`ssh: bad padding (${String(padLen)} in a ${len}-byte packet)`);
  return body.subarray(1, len - padLen);
};

// Exchange hash H (pure)
export type ExchangeHashFields = {
  readonly vC: string;
  readonly vS: string;
  readonly iC: Uint8Array;
  readonly iS: Uint8Array;
  readonly kS: Uint8Array;
  readonly qC: Uint8Array;
  readonly qS: Uint8Array;
  readonly K: Uint8Array;
};
export const exchangeHashInput = ({ vC, vS, iC, iS, kS, qC, qS, K }: ExchangeHashFields): Bytes => concat([str(vC), str(vS), str(iC), str(iS), str(kS), str(qC), str(qS), mpint(K)]);

const sha = async (b: Bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
// Key derivation: K1 = H(K || H || X || session_id), Kn = H(K || H || K1 || … || Kn-1), concatenated to `len` (RFC 4253 §7.2).
// X is one ASCII letter, so its UTF-8 encoding is its one byte.
async function deriveKey(K: Uint8Array, H: Uint8Array, X: string, sessionId: Uint8Array, len: number) {
  let out = await sha(concat([mpint(K), H, te.encode(X), sessionId]));
  while (out.length < len) out = concat([out, await sha(concat([mpint(K), H, out]))]);
  return out.subarray(0, len);
}

// AES-GCM direction state: 12-byte nonce = 4 fixed + 8-byte invocation counter, incremented per packet (RFC 5647 §7.1)
type Gcm = { readonly key: CryptoKey; readonly nonce: Bytes; readonly bump: () => void };
function gcmState(key: CryptoKey, iv: Bytes): Gcm {
  const nonce = iv.slice();
  const bump = () => { for (let i = 11; i >= 4; i--) { const v = ((nonce[i] ?? 0) + 1) & 255; nonce[i] = v; if (v) break; } };
  return { key, nonce, bump };
}

// Bytes as a binary string (each byte one UTF-16 code unit, as btoa takes them), and back.
const binary = (b: Uint8Array) => String.fromCodePoint(...b);
const encodePub = (raw: Uint8Array) => concat([str('ssh-ed25519'), str(raw)]);
// known_hosts / ssh-keyscan form: "[host] ssh-ed25519 <base64 of the wire blob>"; we keep the raw 32-byte key
export const hostKeyLine = (raw: Uint8Array): string => `ssh-ed25519 ${btoa(binary(encodePub(raw)))}`;
export const hostKeyFromLine = (line: unknown): Bytes => {
  const b64 = String(line).trim().match(/^(?:\S+\s+)?ssh-ed25519\s+([A-Za-z0-9+/=]+)/u)?.[1];
  if (b64 === undefined) throw fail('bad_request', 'hostKey must be an "ssh-ed25519 AAAA…" line (optionally prefixed by a host)');
  const r = new Reader(Uint8Array.from(atob(b64), c => c.codePointAt(0) ?? 0));
  if (r.text() !== 'ssh-ed25519') throw fail('bad_request', 'hostKey blob is not ssh-ed25519');
  const raw = r.string(); if (raw.length !== 32) throw fail('bad_request', 'hostKey: bad key length'); return raw;
};
export async function fingerprint(raw: Uint8Array): Promise<string> { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', encodePub(raw))); return `SHA256:${btoa(binary(d)).replace(/[=]+$/u, '')}`; }

const CHANNEL_MSGS: ReadonlySet<number | undefined> = new Set([MSG.CHANNEL_OPEN_CONFIRMATION, MSG.CHANNEL_OPEN_FAILURE, MSG.CHANNEL_WINDOW_ADJUST, MSG.CHANNEL_DATA, MSG.CHANNEL_EXTENDED_DATA, MSG.CHANNEL_EOF, MSG.CHANNEL_CLOSE, MSG.CHANNEL_REQUEST, MSG.CHANNEL_SUCCESS, MSG.CHANNEL_FAILURE]);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const keyLen = (a: string) => (a.startsWith('aes256') ? 32 : 16);

// One session channel. `remote` is null until the server confirms the open. `exit` is the exit status, -1 for an
// exit-signal (A5: a union, not a sentinel), null while neither has arrived.
export type Channel = {
  readonly id: number;
  remote: number | null;
  opening: boolean;
  pendingReplies: number;
  winLocal: number;
  winRemote: number;
  maxRemote: number;
  readonly queue: Bytes[];
  queued: number;
  readonly replies: Bytes[];
  readonly waiters: unknown[];
  eof: boolean;
  closed: boolean;
  stderr: string;
  stderrCarry: Uint8Array;
  exit: number | null;
  exitSignal?: string;
  sentEof?: boolean;
  sentClose?: boolean;
  readonly exitWaiters: unknown[];
  readonly winWaiters: unknown[];
};
export type Exec = {
  readonly channel: Channel;
  write(bytes: Uint8Array): Promise<void>;
  eof(): Promise<void>;
  stdout(): AsyncGenerator<Bytes, void>;
  stderr(): string;
  exit(): Promise<number | null>;
  close(): Promise<void>;
};
export type SshStats = { packetsIn: number; packetsOut: number; bytesIn: number; bytesOut: number };
export type SshClientOptions = {
  readonly user: string;
  readonly privateKey: CryptoKey;
  readonly publicKeyRaw: Uint8Array;
  readonly hostKey: string | Uint8Array;
  readonly tracer: TracerLike;
  readonly parent?: unknown;
  readonly clientVersion?: string;
  readonly windowSize?: number;
  readonly maxPacket?: number;
};

export class SshClient {
  public declare s: SshStream;
  public declare user: string;
  public declare privateKey: CryptoKey;
  public declare publicKeyRaw: Uint8Array;
  public declare hostKeyPinned: Uint8Array;
  public declare tracer: TracerLike;
  public declare parent: unknown;
  public declare vC: string;
  public declare vS?: string;
  public declare windowSize: number;
  public declare maxPacket: number;
  public declare rbuf: Bytes;
  public declare enc: Gcm | null;
  public declare dec: Gcm | null;
  public declare seqIn: number;
  public declare seqOut: number;
  public declare seqLast: number; // set by every packet read, before anything dispatches it
  public declare sessionId: Bytes | null;
  public declare channels: Map<number, Channel>;
  public declare nextChannel: number;
  public declare closed: boolean;
  public declare stats: SshStats;
  public declare pending: unknown[];
  public declare wq?: Promise<unknown>;
  public declare rq?: Promise<unknown>;
  public declare dead?: unknown;
  public declare pumping?: Promise<void> | null;

  // An untyped caller that passes no options still reaches the hostKey check (`= {}`), as before.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  public constructor(stream: SshStream, { user, privateKey, publicKeyRaw, hostKey, tracer, parent = null, clientVersion = 'SSH-2.0-ply_0.1.0', windowSize = 2 * 1024 * 1024, maxPacket = 32_768 }: SshClientOptions = {} as SshClientOptions) {
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- untyped callers: any falsy hostKey is missing
    if (!hostKey) throw fail('bad_request', 'hostKey is required: an SSH client in a Worker cannot trust-on-first-use');
    this.s = stream; this.user = user; this.privateKey = privateKey; this.publicKeyRaw = publicKeyRaw;
    this.hostKeyPinned = hostKey instanceof Uint8Array ? hostKey : hostKeyFromLine(hostKey);
    this.tracer = tracer; this.parent = parent; this.vC = clientVersion; this.windowSize = windowSize; this.maxPacket = maxPacket;
    this.rbuf = new Uint8Array(0); this.enc = null; this.dec = null; this.seqIn = 0; this.seqOut = 0;
    this.sessionId = null; this.channels = new Map(); this.nextChannel = 0; this.closed = false; this.stats = { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };
    this.pending = []; // messages for channels not yet consumed
  }

  // ---- stream helpers ----
  public async fill(n: number): Promise<void> {
    while (this.rbuf.length < n) {
      const chunk = await this.s.read();
      if (chunk === null) throw fail('network', 'ssh: connection closed by peer');
      this.stats.bytesIn += chunk.length;
      this.rbuf = this.rbuf.length > 0 ? concat([this.rbuf, chunk]) : chunk;
    }
  }
  public take(n: number): Bytes { const out = this.rbuf.subarray(0, n); this.rbuf = this.rbuf.subarray(n); return out; }
  public async send(bytes: Uint8Array): Promise<void> { this.stats.bytesOut += bytes.length; await this.s.write(bytes); }

  // ---- packet layer ----
  // One packet at a time each way, whoever calls: two channels, a WINDOW_ADJUST beside a command, a reply to a server
  // request. A packet's nonce is claimed (copied and bumped) before the first await, and the next packet is not sealed
  // until this one is on the wire, so packets leave in nonce order and no nonce is used twice (concurrent callers once
  // sealed two CHANNEL_OPENs under one nonce: GCM's confidentiality and integrity are gone for both). Reads likewise:
  // the stream buffer and the decrypt nonce belong to one reader at a time. A packet that fails either way (bad tag, short
  // read, failed send) leaves the stream out of step, so the connection is dead: every later packet fails with that error
  // at once (a reader that went on would take ciphertext for a length and wait for bytes the server never sends).
  public writePacket(payload: Uint8Array): Promise<void> { const p = (this.wq ?? Promise.resolve()).then(() => this.live(() => this.sealPacket(payload))); this.wq = p.catch(() => { /* the next packet waits for this one either way */ }); return p; }
  public readPacket(): Promise<Bytes> { const p = (this.rq ?? Promise.resolve()).then(() => this.live(() => this.openPacket())); this.rq = p.catch(() => { /* the next packet waits for this one either way */ }); return p; }
  public async live<T>(f: () => Promise<T>): Promise<T> {
    // dead holds the connection's first failure as it was caught (any thrown value; a falsy one never marked it dead)
    // oxlint-disable-next-line typescript/strict-boolean-expressions, typescript/only-throw-error -- see above
    if (this.dead) throw this.dead;
    try { return await f(); } catch (e) { this.dead ??= e; throw e; }
  }
  public async sealPacket(payload: Uint8Array): Promise<void> {
    let pkt;
    if (this.enc) {
      const body = padded(payload, 16, false); // [len(4)][padlen][payload][pad]; len is AAD, the rest is sealed
      const lengthField = body.subarray(0, 4), plain = body.subarray(4);
      const iv = this.enc.nonce.slice(); this.enc.bump();
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: lengthField, tagLength: 128 }, this.enc.key, plain));
      pkt = concat([lengthField, sealed]);
    }
    else pkt = padded(payload, 8, true);
    this.seqOut++; this.stats.packetsOut++;
    await this.send(pkt);
  }
  public async openPacket(): Promise<Bytes> {
    if (!this.dec) {
      await this.fill(4); const len = new Reader(this.rbuf).u32();
      if (len > 256 * 1024 + 64) throw sshErr(`ssh: packet too large (${len})`);
      await this.fill(4 + len); const raw = this.take(4 + len);
      this.seqLast = this.seqIn++; this.stats.packetsIn++;
      return unpad(raw.subarray(4), len);
    }
    await this.fill(4); const lengthField = this.take(4).slice(); const len = new Reader(lengthField).u32();
    if (len > 256 * 1024 + 64) throw sshErr(`ssh: packet too large (${len})`);
    await this.fill(len + 16); const sealed = this.take(len + 16);
    const iv = this.dec.nonce.slice(); this.dec.bump();
    let plain;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: lengthField, tagLength: 128 }, this.dec.key, sealed)); }
    catch { throw sshErr('ssh: packet authentication failed (bad tag)'); }
    this.seqLast = this.seqIn++; this.stats.packetsIn++;
    return unpad(plain, len);
  }
  // Transport-level messages that may arrive at any time are handled here; anything else is returned.
  public async readMessage(): Promise<Bytes> {
    for (;;) {
      const p = await this.readPacket();
      const type = p[0];
      if (type === MSG.IGNORE || type === MSG.DEBUG || type === MSG.EXT_INFO) continue;
      if (type === MSG.UNIMPLEMENTED) continue;
      // For A5: only reason 2 is `protocol`; every other reason (13 ILLEGAL_USER_NAME, 14 NO_MORE_AUTH_METHODS) is `ssh`, retry 'yes'
      if (type === MSG.DISCONNECT) { const r = new Reader(p); r.byte(); const code = r.u32(); const desc = r.text(); throw fail(code === 2 /* PROTOCOL_ERROR */ ? 'protocol' : 'ssh', `ssh: server disconnected (${code}): ${desc}`, { disconnect: code }); }
      if (type === MSG.GLOBAL_REQUEST) { const r = new Reader(p); r.byte(); r.text(); if (r.bool()) await this.writePacket(Uint8Array.from([MSG.REQUEST_FAILURE])); continue; }
      if (type === MSG.KEXINIT && this.sessionId) throw fail('unsupported', 'ssh: server requested rekeying; ply sessions are short enough not to');
      return p;
    }
  }

  // ---- connection setup ----
  // async: a synchronous failure (no tracer) rejects, as it always has
  // oxlint-disable-next-line require-await -- see above
  public async connect(): Promise<void> {
    // oxlint-disable-next-line complexity -- the handshake is one sequence (RFC 4253 §4-§7), each step refusing what it reads
    return this.tracer.span('ssh.connect', { parent: this.parent, kind: KIND.CLIENT, attrs: { 'ssh.user': this.user, 'ssh.client.version': this.vC } }, async span => {
      // version exchange: the server may send banner lines before its version line
      await this.send(te.encode(`${this.vC}\r\n`));
      // Lines before it are text (§4.2), bounded as OpenSSH bounds them: 1024 lines, 64 KiB, no NUL (a server that sends
      // packets first, or junk forever, is refused at once rather than read until the request times out).
      let lines = 0, seen = 0, vS: string | null = null;
      while (vS === null) {
        let nl = this.rbuf.indexOf(0x0a);
        while (nl < 0 && seen + this.rbuf.length <= 65_536) { await this.fill(this.rbuf.length + 1); nl = this.rbuf.indexOf(0x0a); }
        const raw = nl < 0 ? null : this.take(nl + 1);
        seen += raw?.length ?? 0; lines++;
        if (!raw || raw.includes(0) || lines > 1024 || seen > 65_536) throw sshErr('ssh: no version line');
        const line = td.decode(raw).replace(/\r?\n$/u, '');
        if (line.startsWith('SSH-')) vS = line;
      }
      if (!vS.startsWith('SSH-2.0-') && !vS.startsWith('SSH-1.99-')) throw fail('unsupported', `ssh: server version ${vS}`);
      span.set({ 'ssh.server.version': vS });
      this.vS = vS;
      // KEXINIT both ways
      const cookie = new Uint8Array(16); crypto.getRandomValues(cookie);
      const iC = kexInit(cookie);
      await this.writePacket(iC);
      const iS = await this.readMessage();
      if (iS[0] !== MSG.KEXINIT) throw expected('KEXINIT', iS);
      const theirs = parseKexInit(iS);
      const chosen = { kex: pick(ALGS.kex, theirs.kex, 'kex'), hostKey: pick(ALGS.hostKey, theirs.hostKey, 'host key'), encCS: pick(ALGS.cipher, theirs.encCS, 'cipher'), encSC: pick(ALGS.cipher, theirs.encSC, 'cipher') };
      span.set({ 'ssh.kex': chosen.kex, 'ssh.hostkey.alg': chosen.hostKey, 'ssh.cipher.c2s': chosen.encCS, 'ssh.cipher.s2c': chosen.encSC, 'ssh.server.kex': theirs.kex.slice(0, 8), 'ssh.server.ciphers': theirs.encSC.slice(0, 8) });
      if (theirs.firstFollows) await this.readMessage(); // a guessed packet we did not ask for: ignore it (our guess was not made)
      // ECDH (X25519)
      const eph = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      const qC = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
      await this.writePacket(concat([Uint8Array.from([MSG.KEX_ECDH_INIT]), str(qC)]));
      const reply = await this.readMessage();
      if (reply[0] !== MSG.KEX_ECDH_REPLY) throw expected('KEX_ECDH_REPLY', reply);
      const r = new Reader(reply); r.byte();
      const kS = r.string(), qS = r.string(), sigBlob = r.string();
      // host key: must be ssh-ed25519 and must be the pinned one — checked before anything is derived from it
      const kr = new Reader(kS); const kType = kr.text(); const kRaw = kr.string();
      if (kType !== 'ssh-ed25519') throw fail('unsupported', `ssh: host key type ${kType}`);
      if (kRaw.length !== 32 || !equal(kRaw, this.hostKeyPinned)) throw fail('host_key_mismatch', `ssh: host key ${hostKeyLine(kRaw)} does not match the pinned ${hostKeyLine(this.hostKeyPinned)}`, { presented: hostKeyLine(kRaw) });
      span.set({ 'ssh.hostkey.fingerprint': await fingerprint(kRaw) });
      if (qS.length !== 32) throw sshErr('ssh: bad server ephemeral key');
      // A low-order server key makes the shared secret zero (RFC 8731 §3: abort). WebCrypto on node and workerd refuses to
      // derive it (an untyped OperationError); a runtime that derives it returns zeros. Both are this one refusal.
      const serverPub = await crypto.subtle.importKey('raw', qS, { name: 'X25519' }, false, []);
      const K = await crypto.subtle.deriveBits({ name: 'X25519', public: serverPub }, eph.privateKey, 256).then(b => new Uint8Array(b), () => null);
      if (!K || K.every(b => b === 0)) throw sshErr('ssh: all-zero shared secret');
      const H = new Uint8Array(await crypto.subtle.digest('SHA-256', exchangeHashInput({ vC: this.vC, vS, iC, iS, kS, qC, qS, K })));
      const sr = new Reader(sigBlob); if (sr.text() !== 'ssh-ed25519') throw sshErr('ssh: bad host signature type'); const sig = sr.string();
      const hostPub = await crypto.subtle.importKey('raw', kRaw, { name: 'Ed25519' }, false, ['verify']);
      if (!(await crypto.subtle.verify('Ed25519', hostPub, sig, H))) throw fail('host_key_mismatch', 'ssh: host key signature over the exchange hash does not verify');
      this.sessionId = H;
      // NEWKEYS: ours, then derive, then theirs (RFC 4253 §7.3)
      await this.writePacket(Uint8Array.from([MSG.NEWKEYS]));
      const [ivCS, ivSC, keyCS, keySC] = await Promise.all([deriveKey(K, H, 'A', H, 12), deriveKey(K, H, 'B', H, 12), deriveKey(K, H, 'C', H, keyLen(chosen.encCS)), deriveKey(K, H, 'D', H, keyLen(chosen.encSC))]);
      const nk = await this.readMessage(); if (nk[0] !== MSG.NEWKEYS) throw expected('NEWKEYS', nk);
      this.enc = gcmState(await crypto.subtle.importKey('raw', keyCS, { name: 'AES-GCM' }, false, ['encrypt']), ivCS);
      this.dec = gcmState(await crypto.subtle.importKey('raw', keySC, { name: 'AES-GCM' }, false, ['decrypt']), ivSC);
      span.set({ 'ssh.packets.in': this.stats.packetsIn, 'ssh.packets.out': this.stats.packetsOut });
    });
  }

  // oxlint-disable-next-line require-await -- async as connect() is
  public async authenticate(): Promise<void> {
    return this.tracer.span('ssh.userauth', { parent: this.parent, kind: KIND.CLIENT, attrs: { 'ssh.auth.method': 'publickey', 'ssh.auth.key': 'ssh-ed25519' } }, async span => {
      await this.writePacket(concat([Uint8Array.from([MSG.SERVICE_REQUEST]), str('ssh-userauth')]));
      const acc = await this.readMessage(); if (acc[0] !== MSG.SERVICE_ACCEPT) throw expected('SERVICE_ACCEPT', acc);
      { const r = new Reader(acc); r.byte(); r.text(); } // the service name: read, as OpenSSH reads it (a message cut short is refused), not compared
      const pubBlob = encodePub(this.publicKeyRaw);
      const head = concat([str(this.user), str('ssh-connection'), str('publickey'), bool(true), str('ssh-ed25519'), str(pubBlob)]);
      // authenticate() runs after connect(), which set the session id (A5: the phase as a union, not sessionId's truthiness)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
      const toSign = concat([str(this.sessionId as Uint8Array), Uint8Array.from([MSG.USERAUTH_REQUEST]), head]);
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', this.privateKey, toSign));
      await this.writePacket(concat([Uint8Array.from([MSG.USERAUTH_REQUEST]), head, str(concat([str('ssh-ed25519'), str(sig)]))]));
      for (;;) {
        const m = await this.readMessage();
        if (m[0] === MSG.USERAUTH_SUCCESS) { span.set({ 'ssh.auth.ok': true }); return; }
        if (m[0] === MSG.USERAUTH_BANNER) { const r = new Reader(m); r.byte(); span.set({ 'ssh.auth.banner': r.text().slice(0, 512) }); continue; }
        if (m[0] === MSG.USERAUTH_FAILURE) { const r = new Reader(m); r.byte(); const methods = r.names(); throw fail('auth', `ssh: publickey authentication refused (server accepts: ${methods.join(',') || 'nothing'})`, { methods }); }
        throw sshErr(`ssh: unexpected message ${String(m[0])} during userauth`);
      }
    });
  }

  // Run a command on a session channel. Returns { stdout: AsyncIterable<Uint8Array>, write(bytes), eof(), stderr(): string, exit(): Promise<number|null> }.
  public async exec(command: string, { env = {} }: { readonly env?: Readonly<Record<string, string>> } = {}): Promise<Exec> {
    const id = this.nextChannel++;
    const ch: Channel = { id, remote: null, opening: true, pendingReplies: 0, winLocal: this.windowSize, winRemote: 0, maxRemote: 0, queue: [], queued: 0, replies: [], waiters: [], eof: false, closed: false, stderr: '', stderrCarry: new Uint8Array(0), exit: null, exitWaiters: [], winWaiters: [] };
    this.channels.set(id, ch);
    await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_OPEN]), str('session'), u32(id), u32(this.windowSize), u32(this.maxPacket)]));
    const conf = await this.readChannelMsg(ch, [MSG.CHANNEL_OPEN_CONFIRMATION, MSG.CHANNEL_OPEN_FAILURE]);
    if (conf[0] === MSG.CHANNEL_OPEN_FAILURE) { const r = new Reader(conf); r.byte(); r.u32(); const code = r.u32(); throw sshErr(`ssh: channel open failed (${code}): ${r.text()}`); }
    const r = new Reader(conf); r.byte(); r.u32(); const remote = r.u32(); ch.remote = remote; ch.winRemote = r.u32(); ch.maxRemote = r.u32();
    for (const [k, v] of Object.entries(env)) await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_REQUEST]), u32(remote), str('env'), bool(false), str(k), str(v)]));
    ch.pendingReplies++; // counted before the request is queued: its reply cannot arrive before it
    await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_REQUEST]), u32(remote), str('exec'), bool(true), str(command)]));
    const res = await this.readChannelMsg(ch, [MSG.CHANNEL_SUCCESS, MSG.CHANNEL_FAILURE]);
    if (res[0] === MSG.CHANNEL_FAILURE) throw fail('remote_error', `ssh: server refused to exec ${JSON.stringify(command)}`);
    // oxlint-disable-next-line typescript/no-this-alias, unicorn/no-this-assignment -- the handle's methods (one a generator, which has no arrow form) act on this client
    const self = this;
    return {
      channel: ch,
      async write(bytes) {
        let off = 0;
        while (off < bytes.length) {
          while (ch.winRemote === 0 && !ch.closed) await self.pumpOnce(ch);
          if (ch.closed) throw fail('network', 'ssh: channel closed while writing');
          const n = Math.min(bytes.length - off, ch.winRemote, ch.maxRemote || 32_768, 32_768);
          ch.winRemote -= n; // claimed before the await: a concurrent writer sees what is left
          await self.writePacket(concat([Uint8Array.from([MSG.CHANNEL_DATA]), u32(remote), str(bytes.subarray(off, off + n))]));
          off += n;
        }
      },
      async eof() { if (ch.sentEof !== true) { ch.sentEof = true; await self.writePacket(concat([Uint8Array.from([MSG.CHANNEL_EOF]), u32(remote)])); } },
      async *stdout() { for (;;) { const d = ch.queue.shift(); if (d) { ch.queued -= d.length; await self.consumed(ch); yield d; continue; } if (ch.eof || ch.closed) return; await self.pumpOnce(ch); } },
      stderr: () => ch.stderr,
      async exit() { while (ch.exit === null && !ch.closed) await self.pumpOnce(ch); return ch.exit; },
      async close() { if (!ch.closed && ch.sentClose !== true) { ch.sentClose = true; try { await self.writePacket(concat([Uint8Array.from([MSG.CHANNEL_CLOSE]), u32(remote)])); } catch { /* closing */ } } },
    };
  }

  // Wait for one of `types` for this channel: open and request replies are kept per channel by dispatch, whoever read them.
  public async readChannelMsg(ch: Channel, types: ReadonlyArray<number | undefined>): Promise<Bytes> {
    for (;;) { const i = ch.replies.findIndex(m => types.includes(m[0])); const m = ch.replies[i]; if (m) { ch.replies.splice(i, 1); return m; } await this.pumpOnce(); }
  }
  // Read and dispatch one message. Concurrent waiters share the read in flight, then re-check their own condition: what
  // arrived went to its channel, whichever waiter read it (a second reader would block on a message nobody sends).
  public pumpOnce(ch?: Channel): Promise<void> {
    if (ch?.closed === true) return Promise.resolve();
    this.pumping ??= this.readMessage().then(m => this.dispatch(m, this.seqLast)).finally(() => { this.pumping = null; });
    return this.pumping;
  }
  // The connection phase, as OpenSSH runs it (channels.c, dispatch.c). A message that is not for a channel (an unknown
  // type, a stray USERAUTH_SUCCESS) is answered UNIMPLEMENTED and otherwise ignored (RFC 4253 §11.4). A request reply
  // with no request pending is dropped (a reply that precedes its request answers nothing); an open confirmation or
  // failure for a channel that is not opening is fatal ("open confirmation for non-opening channel").
  // A message for a channel the server has not confirmed yet is answered on remote channel 0 (`u32(null)` was 0).
  // oxlint-disable-next-line complexity -- one branch per channel message, as channels.c dispatches them
  public async dispatch(m: Bytes, seq: number): Promise<void> {
    const type = m[0];
    const r = new Reader(m); r.byte();
    if (!CHANNEL_MSGS.has(type)) { await this.writePacket(concat([Uint8Array.from([MSG.UNIMPLEMENTED]), u32(seq)])); return; }
    const ch = this.channels.get(r.u32()); if (!ch) return;
    if (type === MSG.CHANNEL_OPEN_CONFIRMATION || type === MSG.CHANNEL_OPEN_FAILURE) {
      if (!ch.opening) throw sshErr(`ssh: unexpected message ${type} for channel ${ch.id}, which is not opening`);
      ch.opening = false; ch.replies.push(m);
    }
    else if (type === MSG.CHANNEL_SUCCESS || type === MSG.CHANNEL_FAILURE) { if (ch.pendingReplies > 0) { ch.pendingReplies--; ch.replies.push(m); } }
    else if (type === MSG.CHANNEL_DATA) { const d = r.string(); this.arrived(ch, d.length); ch.queue.push(d.slice()); ch.queued += d.length; }
    else if (type === MSG.CHANNEL_EXTENDED_DATA) { r.u32(); const d = r.string(); this.arrived(ch, d.length); const t = decodeChunk(ch.stderrCarry, d); ch.stderrCarry = t.carry; ch.stderr = (ch.stderr + t.text).slice(-8192); await this.consumed(ch); }
    else if (type === MSG.CHANNEL_WINDOW_ADJUST) ch.winRemote += r.u32();
    else if (type === MSG.CHANNEL_EOF) ch.eof = true;
    else if (type === MSG.CHANNEL_CLOSE) { ch.closed = true; ch.eof = true; if (ch.sentClose !== true) { ch.sentClose = true; try { await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_CLOSE]), u32(ch.remote ?? 0)])); } catch { /* peer gone */ } } }
    else if (type === MSG.CHANNEL_REQUEST) { const name = r.text(); const wantReply = r.bool(); if (name === 'exit-status') ch.exit = r.u32(); else if (name === 'exit-signal') { ch.exit = -1; ch.exitSignal = r.text(); } if (wantReply) await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_FAILURE]), u32(ch.remote ?? 0)])); }
  }
  // Flow control bounds what we hold: data takes window as it arrives and gets it back only once stdout() hands it on (stderr
  // is consumed on arrival, as an 8 KiB tail), so queued + winLocal ≤ windowSize. Data past the window is a server that
  // ignores flow control (RFC 4254 §5.2): refused before it is copied, whatever message we were waiting for.
  public arrived(ch: Channel, n: number): void { if (n > ch.winLocal) throw sshErr(`ssh: server sent ${n} bytes with ${ch.winLocal} left in the channel window`, { window: this.windowSize, queued: ch.queued }); ch.winLocal -= n; }
  public async consumed(ch: Channel): Promise<void> { const add = this.windowSize - ch.winLocal - ch.queued; if (ch.winLocal < this.windowSize / 2 && add > 0) { ch.winLocal += add; await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_WINDOW_ADJUST]), u32(ch.remote ?? 0), u32(add)])); } }

  public async disconnect(reason = 'done'): Promise<void> {
    if (this.closed) return; this.closed = true;
    try { await this.writePacket(concat([Uint8Array.from([MSG.DISCONNECT]), u32(11 /* BY_APPLICATION */), str(reason), str('')])); } catch { /* already gone */ }
    try { await this.s.close(); } catch { /* ignore */ }
  }
}

