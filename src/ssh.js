// SSH-2 client, zero dependencies, over any byte stream { read(): Promise<Uint8Array|null>, write(bytes), close() }.
// Enough of RFC 4253/4252/4254 to run one command on a git host and nothing more:
//   kex curve25519-sha256 · host key ssh-ed25519 (pinned, never trust-on-first-use) · aes128/256-gcm@openssh.com
//   userauth publickey with Ed25519 · session channel: env + exec, window flow control, stderr, exit-status
// Every primitive is WebCrypto (X25519, Ed25519, AES-GCM, SHA-256), so this runs on Workers and node ≥ 20 unchanged.
// Pure parts: the wire codec (ssh strings/mpints/name-lists), KEXINIT, the exchange hash, key derivation layout, packet
// padding. Effects: the stream and crypto.subtle. Spans: one per phase, attributes carry the negotiated algorithms.
import { thrown as fail } from './errors.js';
import { te, td, concat, decodeChunk } from './bytes.js';
import { KIND } from './otel.js';

const MSG = { DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7, KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53, USERAUTH_PK_OK: 60,
  GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82, CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93, CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98, CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100 };
export const SSH_MSG = MSG;
const sshErr = (msg, extra) => fail('ssh', msg, extra);

// ---- wire codec (pure) ----
export const u32 = n => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const str = b => { const bytes = typeof b === 'string' ? te.encode(b) : b; return concat([u32(bytes.length), bytes]); };
export const mpint = bytes => { let i = 0; while (i < bytes.length && bytes[i] === 0) i++; const t = bytes.subarray(i); return str(t.length && (t[0] & 0x80) ? concat([Uint8Array.from([0]), t]) : t); };
export const nameList = names => str(names.join(','));
export const bool = b => Uint8Array.from([b ? 1 : 0]);
export class Reader {
  constructor(buf) { this.buf = buf; this.p = 0; }
  byte() { if (this.p >= this.buf.length) throw sshErr('ssh: short message'); return this.buf[this.p++]; }
  u32() { if (this.p + 4 > this.buf.length) throw sshErr('ssh: short message'); const v = ((this.buf[this.p] << 24) | (this.buf[this.p + 1] << 16) | (this.buf[this.p + 2] << 8) | this.buf[this.p + 3]) >>> 0; this.p += 4; return v; }
  bool() { return this.byte() !== 0; }
  bytes(n) { if (this.p + n > this.buf.length) throw sshErr('ssh: short message'); const b = this.buf.subarray(this.p, this.p + n); this.p += n; return b; }
  string() { return this.bytes(this.u32()); }
  text() { return td.decode(this.string()); }
  names() { const t = this.text(); return t ? t.split(',') : []; }
}

export const ALGS = Object.freeze({ kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org'], hostKey: ['ssh-ed25519'], cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'], mac: ['hmac-sha2-256'], comp: ['none'] });

// KEXINIT payload (pure given the cookie)
export function kexInit(cookie) {
  return concat([Uint8Array.from([MSG.KEXINIT]), cookie, nameList(ALGS.kex), nameList(ALGS.hostKey), nameList(ALGS.cipher), nameList(ALGS.cipher), nameList(ALGS.mac), nameList(ALGS.mac), nameList(ALGS.comp), nameList(ALGS.comp), nameList([]), nameList([]), bool(false), u32(0)]);
}
// @decoder parseKexInit prefix=kex
export function parseKexInit(payload) {
  const r = new Reader(payload); if (r.byte() !== MSG.KEXINIT) throw sshErr('ssh: expected KEXINIT');
  r.bytes(16);
  const out = { kex: r.names(), hostKey: r.names(), encCS: r.names(), encSC: r.names(), macCS: r.names(), macSC: r.names(), compCS: r.names(), compSC: r.names(), langCS: r.names(), langSC: r.names(), firstFollows: r.bool() };
  return out;
}
// First of ours the server also lists (RFC 4253 §7.1: client's preference order)
export const pick = (ours, theirs, what) => { const a = ours.find(x => theirs.includes(x)); if (!a) throw fail('unsupported', `ssh: no common ${what} algorithm (server offers ${theirs.join(',')})`); return a; };

// Packet padding (pure): block 8 before NEWKEYS (whole packet incl. length), 16 with GCM (everything but the length).
export function padded(payload, block, lengthCounts) {
  const fixed = (lengthCounts ? 4 : 0) + 1 + payload.length;
  let padLen = block - (fixed % block); if (padLen < 4) padLen += block;
  const pad = new Uint8Array(padLen); crypto.getRandomValues(pad);
  return concat([u32(1 + payload.length + padLen), Uint8Array.from([padLen]), payload, pad]);
}

// A packet's payload (pure): `body` is [padding_length][payload][padding], `len` bytes. RFC 4253 §6: at least 4 bytes of
// padding, a payload of at least the message type; OpenSSH refuses anything else ("incomplete message").
export const unpad = (body, len) => {
  const padLen = body[0];
  if (!(padLen >= 4 && padLen <= len - 2)) throw sshErr(`ssh: bad padding (${padLen} in a ${len}-byte packet)`);
  return body.subarray(1, len - padLen);
};

// Exchange hash H (pure)
export const exchangeHashInput = ({ vC, vS, iC, iS, kS, qC, qS, K }) => concat([str(vC), str(vS), str(iC), str(iS), str(kS), str(qC), str(qS), mpint(K)]);

// Key derivation: K1 = H(K || H || X || session_id), Kn = H(K || H || K1 || … || Kn-1), concatenated to `len` (RFC 4253 §7.2)
async function deriveKey(K, H, X, sessionId, len) {
  const sha = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  let out = await sha(concat([mpint(K), H, Uint8Array.from([X.charCodeAt(0)]), sessionId]));
  while (out.length < len) out = concat([out, await sha(concat([mpint(K), H, out]))]);
  return out.subarray(0, len);
}

// AES-GCM direction state: 12-byte nonce = 4 fixed + 8-byte invocation counter, incremented per packet (RFC 5647 §7.1)
function gcmState(key, iv) {
  const nonce = iv.slice();
  const bump = () => { for (let i = 11; i >= 4; i--) { nonce[i] = (nonce[i] + 1) & 255; if (nonce[i]) break; } };
  return { key, nonce, bump };
}

const encodePub = raw => concat([str('ssh-ed25519'), str(raw)]);
// known_hosts / ssh-keyscan form: "[host] ssh-ed25519 <base64 of the wire blob>"; we keep the raw 32-byte key
export const hostKeyLine = raw => `ssh-ed25519 ${btoa(String.fromCharCode(...encodePub(raw)))}`;
export const hostKeyFromLine = line => {
  const m = String(line).trim().match(/^(?:\S+\s+)?ssh-ed25519\s+([A-Za-z0-9+/=]+)/);
  if (!m) throw fail('bad_request', 'hostKey must be an "ssh-ed25519 AAAA…" line (optionally prefixed by a host)');
  const r = new Reader(Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)));
  if (r.text() !== 'ssh-ed25519') throw fail('bad_request', 'hostKey blob is not ssh-ed25519');
  const raw = r.string(); if (raw.length !== 32) throw fail('bad_request', 'hostKey: bad key length'); return raw;
};

export class SshClient {
  constructor(stream, { user, privateKey, publicKeyRaw, hostKey, tracer, parent = null, clientVersion = 'SSH-2.0-ply_0.1.0', windowSize = 2 * 1024 * 1024, maxPacket = 32768 } = {}) {
    if (!hostKey) throw fail('bad_request', 'hostKey is required: an SSH client in a Worker cannot trust-on-first-use');
    this.s = stream; this.user = user; this.privateKey = privateKey; this.publicKeyRaw = publicKeyRaw;
    this.hostKeyPinned = hostKey instanceof Uint8Array ? hostKey : hostKeyFromLine(hostKey);
    this.tracer = tracer; this.parent = parent; this.vC = clientVersion; this.windowSize = windowSize; this.maxPacket = maxPacket;
    this.rbuf = new Uint8Array(0); this.enc = null; this.dec = null; this.seqIn = 0; this.seqOut = 0;
    this.sessionId = null; this.channels = new Map(); this.nextChannel = 0; this.closed = false; this.stats = { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };
    this.pending = []; // messages for channels not yet consumed
  }

  // ---- stream helpers ----
  async fill(n) {
    while (this.rbuf.length < n) {
      const chunk = await this.s.read();
      if (chunk === null) throw fail('network', 'ssh: connection closed by peer');
      this.stats.bytesIn += chunk.length;
      this.rbuf = this.rbuf.length ? concat([this.rbuf, chunk]) : chunk;
    }
  }
  take(n) { const out = this.rbuf.subarray(0, n); this.rbuf = this.rbuf.subarray(n); return out; }
  async send(bytes) { this.stats.bytesOut += bytes.length; await this.s.write(bytes); }

  // ---- packet layer ----
  // One packet at a time each way, whoever calls: two channels, a WINDOW_ADJUST beside a command, a reply to a server
  // request. A packet's nonce is claimed (copied and bumped) before the first await, and the next packet is not sealed
  // until this one is on the wire, so packets leave in nonce order and no nonce is used twice (concurrent callers once
  // sealed two CHANNEL_OPENs under one nonce: GCM's confidentiality and integrity are gone for both). Reads likewise:
  // the stream buffer and the decrypt nonce belong to one reader at a time. A packet that fails either way (bad tag, short
  // read, failed send) leaves the stream out of step, so the connection is dead: every later packet fails with that error
  // at once (a reader that went on would take ciphertext for a length and wait for bytes the server never sends).
  writePacket(payload) { const p = (this.wq ?? Promise.resolve()).then(() => this.live(() => this.sealPacket(payload))); this.wq = p.catch(() => {}); return p; }
  readPacket() { const p = (this.rq ?? Promise.resolve()).then(() => this.live(() => this.openPacket())); this.rq = p.catch(() => {}); return p; }
  async live(f) { if (this.dead) throw this.dead; try { return await f(); } catch (e) { this.dead ??= e; throw e; } }
  async sealPacket(payload) {
    let pkt;
    if (!this.enc) pkt = padded(payload, 8, true);
    else {
      const body = padded(payload, 16, false); // [len(4)][padlen][payload][pad]; len is AAD, the rest is sealed
      const lengthField = body.subarray(0, 4), plain = body.subarray(4);
      const iv = this.enc.nonce.slice(); this.enc.bump();
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: lengthField, tagLength: 128 }, this.enc.key, plain));
      pkt = concat([lengthField, sealed]);
    }
    this.seqOut++; this.stats.packetsOut++;
    await this.send(pkt);
  }
  async openPacket() {
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
  async readMessage() {
    for (;;) {
      const p = await this.readPacket();
      const type = p[0];
      if (type === MSG.IGNORE || type === MSG.DEBUG || type === MSG.EXT_INFO) continue;
      if (type === MSG.UNIMPLEMENTED) continue;
      if (type === MSG.DISCONNECT) { const r = new Reader(p); r.byte(); const code = r.u32(); const desc = r.text(); throw fail(code === 2 /* PROTOCOL_ERROR */ ? 'protocol' : 'ssh', `ssh: server disconnected (${code}): ${desc}`, { disconnect: code }); }
      if (type === MSG.GLOBAL_REQUEST) { const r = new Reader(p); r.byte(); r.text(); if (r.bool()) await this.writePacket(Uint8Array.from([MSG.REQUEST_FAILURE])); continue; }
      if (type === MSG.KEXINIT && this.sessionId) throw fail('unsupported', 'ssh: server requested rekeying; ply sessions are short enough not to');
      return p;
    }
  }

  // ---- connection setup ----
  async connect() {
    return this.tracer.span('ssh.connect', { parent: this.parent, kind: KIND.CLIENT, attrs: { 'ssh.user': this.user, 'ssh.client.version': this.vC } }, async span => {
      // version exchange: the server may send banner lines before its version line
      await this.send(te.encode(this.vC + '\r\n'));
      // Lines before it are text (§4.2), bounded as OpenSSH bounds them: 1024 lines, 64 KiB, no NUL (a server that sends
      // packets first, or junk forever, is refused at once rather than read until the request times out).
      let vS = null, seen = 0, lines = 0;
      while (vS === null) {
        let nl = this.rbuf.indexOf(0x0a);
        while (nl < 0 && seen + this.rbuf.length <= 65536) { await this.fill(this.rbuf.length + 1); nl = this.rbuf.indexOf(0x0a); }
        const raw = nl < 0 ? null : this.take(nl + 1);
        seen += raw?.length ?? 0; lines++;
        if (!raw || raw.includes(0) || lines > 1024 || seen > 65536) throw sshErr('ssh: no version line');
        const line = td.decode(raw).replace(/\r?\n$/, '');
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
      if (iS[0] !== MSG.KEXINIT) throw sshErr(`ssh: expected KEXINIT, got ${iS[0]}`);
      const theirs = parseKexInit(iS);
      const chosen = { kex: pick(ALGS.kex, theirs.kex, 'kex'), hostKey: pick(ALGS.hostKey, theirs.hostKey, 'host key'), encCS: pick(ALGS.cipher, theirs.encCS, 'cipher'), encSC: pick(ALGS.cipher, theirs.encSC, 'cipher') };
      span.set({ 'ssh.kex': chosen.kex, 'ssh.hostkey.alg': chosen.hostKey, 'ssh.cipher.c2s': chosen.encCS, 'ssh.cipher.s2c': chosen.encSC, 'ssh.server.kex': theirs.kex.slice(0, 8), 'ssh.server.ciphers': theirs.encSC.slice(0, 8) });
      if (theirs.firstFollows) await this.readMessage(); // a guessed packet we did not ask for: ignore it (our guess was not made)
      // ECDH (X25519)
      const eph = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      const qC = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
      await this.writePacket(concat([Uint8Array.from([MSG.KEX_ECDH_INIT]), str(qC)]));
      const reply = await this.readMessage();
      if (reply[0] !== MSG.KEX_ECDH_REPLY) throw sshErr(`ssh: expected KEX_ECDH_REPLY, got ${reply[0]}`);
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
      const keyLen = a => (a.startsWith('aes256') ? 32 : 16);
      const [ivCS, ivSC, keyCS, keySC] = await Promise.all([deriveKey(K, H, 'A', H, 12), deriveKey(K, H, 'B', H, 12), deriveKey(K, H, 'C', H, keyLen(chosen.encCS)), deriveKey(K, H, 'D', H, keyLen(chosen.encSC))]);
      const nk = await this.readMessage(); if (nk[0] !== MSG.NEWKEYS) throw sshErr(`ssh: expected NEWKEYS, got ${nk[0]}`);
      this.enc = gcmState(await crypto.subtle.importKey('raw', keyCS, { name: 'AES-GCM' }, false, ['encrypt']), ivCS);
      this.dec = gcmState(await crypto.subtle.importKey('raw', keySC, { name: 'AES-GCM' }, false, ['decrypt']), ivSC);
      span.set({ 'ssh.packets.in': this.stats.packetsIn, 'ssh.packets.out': this.stats.packetsOut });
    });
  }

  async authenticate() {
    return this.tracer.span('ssh.userauth', { parent: this.parent, kind: KIND.CLIENT, attrs: { 'ssh.auth.method': 'publickey', 'ssh.auth.key': 'ssh-ed25519' } }, async span => {
      await this.writePacket(concat([Uint8Array.from([MSG.SERVICE_REQUEST]), str('ssh-userauth')]));
      const acc = await this.readMessage(); if (acc[0] !== MSG.SERVICE_ACCEPT) throw sshErr(`ssh: expected SERVICE_ACCEPT, got ${acc[0]}`);
      { const r = new Reader(acc); r.byte(); r.text(); } // the service name: read, as OpenSSH reads it (a message cut short is refused), not compared
      const pubBlob = encodePub(this.publicKeyRaw);
      const head = concat([str(this.user), str('ssh-connection'), str('publickey'), bool(true), str('ssh-ed25519'), str(pubBlob)]);
      const toSign = concat([str(this.sessionId), Uint8Array.from([MSG.USERAUTH_REQUEST]), head]);
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', this.privateKey, toSign));
      await this.writePacket(concat([Uint8Array.from([MSG.USERAUTH_REQUEST]), head, str(concat([str('ssh-ed25519'), str(sig)]))]));
      for (;;) {
        const m = await this.readMessage();
        if (m[0] === MSG.USERAUTH_SUCCESS) { span.set({ 'ssh.auth.ok': true }); return; }
        if (m[0] === MSG.USERAUTH_BANNER) { const r = new Reader(m); r.byte(); span.set({ 'ssh.auth.banner': r.text().slice(0, 512) }); continue; }
        if (m[0] === MSG.USERAUTH_FAILURE) { const r = new Reader(m); r.byte(); const methods = r.names(); throw fail('auth', `ssh: publickey authentication refused (server accepts: ${methods.join(',') || 'nothing'})`, { methods }); }
        throw sshErr(`ssh: unexpected message ${m[0]} during userauth`);
      }
    });
  }

  // Run a command on a session channel. Returns { stdout: AsyncIterable<Uint8Array>, write(bytes), eof(), stderr(): string, exit(): Promise<number|null> }.
  async exec(command, { env = {} } = {}) {
    const id = this.nextChannel++;
    const ch = { id, remote: null, opening: true, pendingReplies: 0, winLocal: this.windowSize, winRemote: 0, maxRemote: 0, queue: [], queued: 0, replies: [], waiters: [], eof: false, closed: false, stderr: '', stderrCarry: new Uint8Array(0), exit: null, exitWaiters: [], winWaiters: [] };
    this.channels.set(id, ch);
    await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_OPEN]), str('session'), u32(id), u32(this.windowSize), u32(this.maxPacket)]));
    const conf = await this.readChannelMsg(ch, [MSG.CHANNEL_OPEN_CONFIRMATION, MSG.CHANNEL_OPEN_FAILURE]);
    if (conf[0] === MSG.CHANNEL_OPEN_FAILURE) { const r = new Reader(conf); r.byte(); r.u32(); const code = r.u32(); throw sshErr(`ssh: channel open failed (${code}): ${r.text()}`); }
    { const r = new Reader(conf); r.byte(); r.u32(); ch.remote = r.u32(); ch.winRemote = r.u32(); ch.maxRemote = r.u32(); }
    for (const [k, v] of Object.entries(env)) await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_REQUEST]), u32(ch.remote), str('env'), bool(false), str(k), str(v)]));
    ch.pendingReplies++; // counted before the request is queued: its reply cannot arrive before it
    await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_REQUEST]), u32(ch.remote), str('exec'), bool(true), str(command)]));
    const res = await this.readChannelMsg(ch, [MSG.CHANNEL_SUCCESS, MSG.CHANNEL_FAILURE]);
    if (res[0] === MSG.CHANNEL_FAILURE) throw fail('remote_error', `ssh: server refused to exec ${JSON.stringify(command)}`);
    const self = this;
    return {
      channel: ch,
      async write(bytes) {
        let off = 0;
        while (off < bytes.length) {
          while (ch.winRemote === 0 && !ch.closed) await self.pumpOnce(ch);
          if (ch.closed) throw fail('network', 'ssh: channel closed while writing');
          const n = Math.min(bytes.length - off, ch.winRemote, ch.maxRemote || 32768, 32768);
          ch.winRemote -= n; // claimed before the await: a concurrent writer sees what is left
          await self.writePacket(concat([Uint8Array.from([MSG.CHANNEL_DATA]), u32(ch.remote), str(bytes.subarray(off, off + n))]));
          off += n;
        }
      },
      async eof() { if (!ch.sentEof) { ch.sentEof = true; await self.writePacket(concat([Uint8Array.from([MSG.CHANNEL_EOF]), u32(ch.remote)])); } },
      async *stdout() { for (;;) { if (ch.queue.length) { const d = ch.queue.shift(); ch.queued -= d.length; await self.consumed(ch); yield d; continue; } if (ch.eof || ch.closed) return; await self.pumpOnce(ch); } },
      stderr: () => ch.stderr,
      async exit() { while (ch.exit === null && !ch.closed) await self.pumpOnce(ch); return ch.exit; },
      async close() { if (!ch.closed && !ch.sentClose) { ch.sentClose = true; try { await self.writePacket(concat([Uint8Array.from([MSG.CHANNEL_CLOSE]), u32(ch.remote)])); } catch { /* closing */ } } },
    };
  }

  // Wait for one of `types` for this channel: open and request replies are kept per channel by dispatch, whoever read them.
  async readChannelMsg(ch, types) {
    for (;;) { const i = ch.replies.findIndex(m => types.includes(m[0])); if (i >= 0) return ch.replies.splice(i, 1)[0]; await this.pumpOnce(); }
  }
  // Read and dispatch one message. Concurrent waiters share the read in flight, then re-check their own condition: what
  // arrived went to its channel, whichever waiter read it (a second reader would block on a message nobody sends).
  pumpOnce(ch) {
    if (ch?.closed) return Promise.resolve();
    this.pumping ??= this.readMessage().then(m => this.dispatch(m, this.seqLast)).finally(() => { this.pumping = null; });
    return this.pumping;
  }
  // The connection phase, as OpenSSH runs it (channels.c, dispatch.c). A message that is not for a channel (an unknown
  // type, a stray USERAUTH_SUCCESS) is answered UNIMPLEMENTED and otherwise ignored (RFC 4253 §11.4). A request reply
  // with no request pending is dropped (a reply that precedes its request answers nothing); an open confirmation or
  // failure for a channel that is not opening is fatal ("open confirmation for non-opening channel").
  async dispatch(m, seq) {
    const type = m[0];
    const r = new Reader(m); r.byte();
    if (!CHANNEL_MSGS.includes(type)) { await this.writePacket(concat([Uint8Array.from([MSG.UNIMPLEMENTED]), u32(seq)])); return; }
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
    else if (type === MSG.CHANNEL_CLOSE) { ch.closed = true; ch.eof = true; if (!ch.sentClose) { ch.sentClose = true; try { await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_CLOSE]), u32(ch.remote)])); } catch { /* peer gone */ } } }
    else if (type === MSG.CHANNEL_REQUEST) { const name = r.text(); const wantReply = r.bool(); if (name === 'exit-status') ch.exit = r.u32(); else if (name === 'exit-signal') { ch.exit = -1; ch.exitSignal = r.text(); } if (wantReply) await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_FAILURE]), u32(ch.remote)])); }
  }
  // Flow control bounds what we hold: data takes window as it arrives and gets it back only once stdout() hands it on (stderr
  // is consumed on arrival, as an 8 KiB tail), so queued + winLocal ≤ windowSize. Data past the window is a server that
  // ignores flow control (RFC 4254 §5.2): refused before it is copied, whatever message we were waiting for.
  arrived(ch, n) { if (n > ch.winLocal) throw sshErr(`ssh: server sent ${n} bytes with ${ch.winLocal} left in the channel window`, { window: this.windowSize, queued: ch.queued }); ch.winLocal -= n; }
  async consumed(ch) { const add = this.windowSize - ch.winLocal - ch.queued; if (ch.winLocal < this.windowSize / 2 && add > 0) { ch.winLocal += add; await this.writePacket(concat([Uint8Array.from([MSG.CHANNEL_WINDOW_ADJUST]), u32(ch.remote), u32(add)])); } }

  async disconnect(reason = 'done') {
    if (this.closed) return; this.closed = true;
    try { await this.writePacket(concat([Uint8Array.from([MSG.DISCONNECT]), u32(11 /* BY_APPLICATION */), str(reason), str('')])); } catch { /* already gone */ }
    try { await this.s.close(); } catch { /* ignore */ }
  }
}

const CHANNEL_MSGS = [MSG.CHANNEL_OPEN_CONFIRMATION, MSG.CHANNEL_OPEN_FAILURE, MSG.CHANNEL_WINDOW_ADJUST, MSG.CHANNEL_DATA, MSG.CHANNEL_EXTENDED_DATA, MSG.CHANNEL_EOF, MSG.CHANNEL_CLOSE, MSG.CHANNEL_REQUEST, MSG.CHANNEL_SUCCESS, MSG.CHANNEL_FAILURE];
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export async function fingerprint(raw) { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', encodePub(raw))); return 'SHA256:' + btoa(String.fromCharCode(...d)).replace(/=+$/, ''); }
