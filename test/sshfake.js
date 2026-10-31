// A scripted SSH-2 server for the ssh-faults space (test/space/ssh-faults.*): enough of RFC 4253/4252/4254 to serve one
// `git-upload-pack` (protocol v2: advertisement + ls-refs) to ply and to OpenSSH, with one fault injected at a chosen
// handshake phase. Written from the RFCs, not from src/ssh.js (it imports nothing from ply's ssh code), so OpenSSH talking
// to it cleanly is what vouches for it: every fault-free run is `git ls-remote` through OpenSSH succeeding.
//
//   kex curve25519-sha256 · host key ssh-ed25519 · aes128/256-gcm@openssh.com · auth: any request succeeds
//
// A fault is { phase, defect } (the space's tagged unions). The server sends each phase's message through emit(phase,
// payload), which applies the defect when the phase matches. Rekeying is implemented (a client may answer a rekey
// request), so a client that refuses one refuses by its own choice.
import net from 'node:net';
import { te, td, concat } from '../src/bytes.js';

export const MSG = { DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, KEXINIT: 20, NEWKEYS: 21, ECDH_INIT: 30, ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, GLOBAL_REQUEST: 80, REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93, CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98, CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100 };
export const UNKNOWN_TYPE = 200; // unassigned (RFC 4250 §4.1.2: 192-255 are local extensions; nobody here knows 200)
export const OID = 'a'.repeat(40);
// how many bytes `malformed` drops from the end of each phase's message: enough to end it inside a field it has
// (kexinit: first_kex_packet_follows and reserved; ecdh: the signature; service: the service name; channel-open: window
// and maximum packet; exec: the recipient channel; data: the data string)
export const MALFORMED_CUT = { kexinit: 5, ecdh: 10, service: 4, 'channel-open': 8, exec: 2, data: 10 };

// ---- codec (RFC 4251 §5) ----
const u32 = n => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const str = b => { const x = typeof b === 'string' ? te.encode(b) : b; return concat([u32(x.length), x]); };
const mpint = b => { let i = 0; while (i < b.length && b[i] === 0) i++; const t = b.subarray(i); return str(t.length && t[0] & 0x80 ? concat([Uint8Array.of(0), t]) : t); };
const names = l => str(l.join(','));
const msg = (type, ...parts) => concat([Uint8Array.of(type), ...parts]);
class R {
  constructor(b) { this.b = b; this.p = 0; }
  byte() { if (this.p >= this.b.length) throw new Error('fake: short'); return this.b[this.p++]; }
  u32() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getUint32(0); this.p += 4; return v; }
  str() { const n = this.u32(); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  text() { return td.decode(this.str()); }
  list() { const t = this.text(); return t ? t.split(',') : []; }
}
const pktLine = s => { const b = te.encode(s); return concat([te.encode((b.length + 4).toString(16).padStart(4, '0')), b]); };
const FLUSH = te.encode('0000');
const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

// kex-strict-s-v00@openssh.com: what an OpenSSH >= 9.6 server advertises (the Terrapin countermeasure, CVE-2023-48795).
// With it, OpenSSH (the oracle) treats any unexpected message during the initial key exchange as fatal, as ply does.
export const SERVER_ALGS = { kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'kex-strict-s-v00@openssh.com'], hostKey: ['ssh-ed25519'], cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'], mac: ['hmac-sha2-256'], comp: ['none'] };
export const ADVERTISEMENT = ['version 2\n', 'agent=git/plyfake\n', 'ls-refs\n', 'fetch=shallow\n', 'object-format=sha1\n'];

export async function hostKeyPair() {
  const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
  const blob = concat([str('ssh-ed25519'), str(raw)]);
  return { ...k, raw, blob, line: `ssh-ed25519 ${Buffer.from(blob).toString('base64')}` };
}

// One connection. Reads are a buffer plus waiters; a closed socket fails every pending read (the script ends).
class Conn {
  constructor(sock, server) {
    this.sock = sock; this.srv = server; this.fault = server.fault; this.buf = new Uint8Array(0); this.waiters = []; this.closed = false;
    this.enc = null; this.dec = null; this.seqIn = 0; this.sessionId = null; this.log = [];
    sock.on('data', d => { this.buf = concat([this.buf, new Uint8Array(d.buffer, d.byteOffset, d.length)]); this.wake(); });
    const end = () => { this.closed = true; this.wake(); };
    sock.on('end', end); sock.on('close', end); sock.on('error', end);
  }
  wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  async need(n) { while (this.buf.length < n) { if (this.closed) throw new Error('fake: client closed'); await new Promise(r => this.waiters.push(r)); } }
  take(n) { const out = this.buf.slice(0, n); this.buf = this.buf.subarray(n); return out; }
  write(b) { if (!this.sock.destroyed) this.sock.write(b); }
  end() { this.sock.end(); }
  cut(how) { if (how === 'reset') setTimeout(() => this.sock.resetAndDestroy(), 20); else this.end(); } // a FIN, or an RST once the bytes are out
  async line() { for (;;) { const i = this.buf.indexOf(0x0a); if (i >= 0) return td.decode(this.take(i + 1)).replace(/\r?\n$/, ''); await this.need(this.buf.length + 1); } }

  // ---- packets ----
  // wire bytes for one payload; `mod` bends it: padLen (a padding-length byte that is not the real one), tag (flip the
  // last tag byte), length (a length field that is not the real one).
  async packet(payload, mod = {}) {
    const block = this.enc ? 16 : 8, lenCounts = !this.enc;
    let pad = block - (((lenCounts ? 4 : 0) + 1 + payload.length) % block); if (pad < 4) pad += block;
    const body = concat([u32(1 + payload.length + pad), Uint8Array.of(mod.padLen ?? pad), payload, new Uint8Array(pad)]);
    if (mod.length !== undefined) body.set(u32(mod.length), 0);
    if (!this.enc) return body;
    const iv = this.enc.nonce.slice(); this.enc.bump();
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: body.subarray(0, 4), tagLength: 128 }, this.enc.key, body.subarray(4)));
    if (mod.tag) sealed[sealed.length - 1] ^= 1;
    return concat([body.subarray(0, 4), sealed]);
  }
  async send(payload, mod) { this.write(await this.packet(payload, mod)); }
  async readPacket() {
    await this.need(4); const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0);
    if (len > 300000) throw new Error(`fake: client packet length ${len}`);
    let plain;
    if (!this.dec) { await this.need(4 + len); plain = this.take(4 + len).subarray(4); }
    else {
      await this.need(4 + len + 16); const lf = this.take(4); const sealed = this.take(len + 16);
      const iv = this.dec.nonce.slice(); this.dec.bump();
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: lf, tagLength: 128 }, this.dec.key, sealed));
    }
    this.seqIn++;
    return plain.subarray(1, plain.length - plain[0]);
  }
  // next message that is not transport noise; a client KEXINIT once the session is up is answered with a rekey
  async next() {
    for (;;) {
      const p = await this.readPacket(); const t = p[0];
      this.log.push(t);
      if (t === MSG.IGNORE || t === MSG.DEBUG || t === MSG.UNIMPLEMENTED) continue;
      if (t === MSG.DISCONNECT) throw new Error('fake: client disconnected');
      if (t === MSG.GLOBAL_REQUEST) { const r = new R(p); r.byte(); r.text(); if (r.byte()) await this.send(msg(MSG.REQUEST_FAILURE)); continue; }
      if (t === MSG.KEXINIT && this.sessionId) { await this.kex(p, false); continue; }
      return p;
    }
  }
  async expect(type) { const p = await this.next(); if (p[0] !== type) throw new Error(`fake: expected ${type}, got ${p[0]}`); return p; }

  // ---- the fault ----
  hit(phase) { return this.fault && this.fault.phase === phase ? this.fault.defect : null; }
  variant(phase, tag) { const d = this.hit(phase); return d && d.tag === tag ? d : null; }
  // Send `payload` as `phase`'s message, bent by the defect when the phase matches. `alt` gives what the phase-specific
  // defects mean here: { wrong: payload, before: payload sent first (out of order) }. Returns false when the defect ends
  // the server's side (the script stops; the client decides what that was).
  async emit(phase, payload, alt = {}) {
    const d = this.hit(phase);
    if (!d) { await this.send(payload); return true; }
    switch (d.tag) {
      case 'truncated': {
        if (d.cut === 'channel') { await this.send(payload); return true; } // handled by the data script
        const wire = await this.packet(payload); this.write(wire.subarray(0, Math.max(1, wire.length >> 1))); this.cut(d.cut); return false;
      }
      case 'oversize':
        if (d.what === 'stream') { await this.send(payload); return true; } // handled by the data script
        this.write(concat([u32(0x01000000), new Uint8Array(32)])); return false;
      case 'malformed': await this.send(payload.subarray(0, payload.length - MALFORMED_CUT[phase])); return false;
      case 'badPad': await this.send(payload, { padLen: 3 }); return false;
      case 'badMac': await this.send(payload, { tag: true }); return false;
      case 'unknown': await this.send(msg(UNKNOWN_TYPE, str('fault'))); await this.send(payload); return true;
      case 'wrongAlg': await this.send(alt.wrong); return !alt.terminal;
      case 'duplicate': await this.send(payload); if (d.when !== 'afterSession') await this.send(payload); return true;
      case 'outOfOrder': await this.send(alt.before); await this.send(payload); return true;
      case 'disconnect': await this.send(msg(MSG.DISCONNECT, u32(d.code), str(`fault at ${phase}`), str(''))); this.end(); return false;
      default: await this.send(payload); return true; // a defect handled where the phase builds its payload (badKey)
    }
  }

  // ---- the script ----
  async run() {
    // banner
    const vS = 'SSH-2.0-plyfake_1.0';
    const b = this.hit('banner');
    if (!b) this.write(te.encode(`${vS}\r\n`));
    else if (b.tag === 'truncated') { this.write(te.encode(vS.slice(0, 9))); this.cut(b.cut); return; }
    else if (b.tag === 'oversize') { this.write(te.encode('x'.repeat(70000))); return; } // no line end: a version line that never ends
    else if (b.tag === 'wrongAlg') { this.write(te.encode('SSH-1.5-plyfake\r\n')); return; }
    else if (b.tag === 'duplicate') this.write(te.encode(`${vS}\r\nSSH-2.0-second\r\n`));
    else if (b.tag === 'outOfOrder') { this.write(await this.packet(this.kexInitPayload())); this.write(te.encode(`${vS}\r\n`)); }
    const vC = await this.line();
    this.vS = vS; this.vC = vC;
    // kexinit (both ways), ecdh, newkeys
    const cIni = await this.readPacket(); if (cIni[0] !== MSG.KEXINIT) throw new Error('fake: client KEXINIT');
    if (!(await this.kex(cIni, true))) return;
    // service
    await this.expect(MSG.SERVICE_REQUEST);
    if (!(await this.emit('service', msg(MSG.SERVICE_ACCEPT, str('ssh-userauth')), { wrong: msg(MSG.SERVICE_ACCEPT, str('ssh-connection')), before: msg(MSG.USERAUTH_SUCCESS) }))) return;
    // userauth: whatever the client asks succeeds (none, publickey query, publickey with a signature)
    await this.expect(MSG.USERAUTH_REQUEST);
    if (!(await this.emit('userauth', msg(MSG.USERAUTH_SUCCESS), { wrong: msg(MSG.USERAUTH_FAILURE, names(['password', 'keyboard-interactive']), Uint8Array.of(0)), terminal: true, before: msg(MSG.CHANNEL_OPEN_CONFIRMATION, u32(0), u32(0), u32(1 << 21), u32(32768)) }))) return;
    // channel open
    const open = new R(await this.expect(MSG.CHANNEL_OPEN)); open.byte(); open.text(); const peer = open.u32(); this.peerWindow = open.u32(); open.u32();
    this.peer = peer;
    const window0 = this.variant('data', 'truncated')?.cut === 'channel';
    const confirm = msg(MSG.CHANNEL_OPEN_CONFIRMATION, u32(peer), u32(7), u32(window0 ? 0 : 1 << 21), u32(32768));
    if (!(await this.emit('channel-open', confirm, { wrong: msg(MSG.CHANNEL_OPEN_FAILURE, u32(peer), u32(3), str('unknown channel type'), str('')), terminal: true, before: msg(MSG.CHANNEL_SUCCESS, u32(peer)) }))) return;
    // env (no reply wanted) then exec
    let exec = null;
    while (!exec) {
      const r = new R(await this.expect(MSG.CHANNEL_REQUEST)); r.byte(); r.u32(); const name = r.text(); const want = r.byte();
      if (name === 'exec') exec = r.text();
      else if (want) await this.send(msg(MSG.CHANNEL_FAILURE, u32(peer)));
    }
    this.exec = exec;
    const data = s => msg(MSG.CHANNEL_DATA, u32(peer), str(typeof s === 'string' ? te.encode(s) : s));
    const adv = concat([...ADVERTISEMENT.map(pktLine), FLUSH]);
    if (!(await this.emit('exec', msg(MSG.CHANNEL_SUCCESS, u32(peer)), { wrong: msg(MSG.CHANNEL_FAILURE, u32(peer)), terminal: true, before: data(adv) }))) return;
    const advSent = this.variant('exec', 'outOfOrder');
    if (this.variant('kexinit', 'duplicate')?.when === 'afterSession') { // a server-initiated rekey, in the connection phase
      this.rekeySent = true; await this.send(this.kexInitPayload());
      await this.kex(await this.expectRaw(MSG.KEXINIT), false);
    }
    // data: the advertisement, then one ls-refs answer per command, until the client's flush or EOF
    const closeAll = async () => { await this.send(msg(MSG.CHANNEL_REQUEST, u32(peer), str('exit-status'), Uint8Array.of(0), u32(0))); await this.send(msg(MSG.CHANNEL_EOF, u32(peer))); await this.send(msg(MSG.CHANNEL_CLOSE, u32(peer))); };
    const d = this.hit('data');
    if (d?.tag === 'oversize' && d.what === 'stream') { // an advertisement that never ends: pkt-lines, no flush
      // a well-formed v2 capability list that does not end: git would read it to the end, ply stops at its limit
      await this.send(data(pktLine('version 2\n')));
      for (let i = 0; i < this.srv.streamPkts && !this.closed; i++) await this.send(data(pktLine(`x-cap-${i}=${'y'.repeat(990)}\n`)));
      this.end(); return; // git has no bound of its own: it would read forever, so the stream ends here

    }
    if (d?.tag === 'outOfOrder') { await closeAll(); await this.send(data(adv)); return; }
    if (d?.tag === 'truncated' && d.cut === 'eof') { await this.send(data(adv.subarray(0, adv.length >> 1))); await closeAll(); return; }
    if (!advSent && !(await this.emit('data', data(adv), { wrong: data(concat([pktLine('version 3\n'), FLUSH])), terminal: true }))) return;
    if (d?.tag === 'truncated' && d.cut === 'channel') { await this.send(msg(MSG.CHANNEL_CLOSE, u32(peer))); await this.send(msg(MSG.CHANNEL_WINDOW_ADJUST, u32(peer), u32(1 << 21))); return; }
    let pending = new Uint8Array(0), command = null;
    for (;;) {
      const m = await this.next(); const r = new R(m); const t = r.byte();
      if (t === MSG.CHANNEL_DATA) {
        r.u32(); pending = concat([pending, r.str()]);
        for (;;) {
          if (pending.length < 4) break;
          const n = parseInt(td.decode(pending.subarray(0, 4)), 16);
          if (n === 0) {
            pending = pending.subarray(4);
            if (command === 'ls-refs') { await this.send(data(concat([pktLine(`${OID} refs/heads/main\n`), FLUSH]))); command = null; continue; }
            await closeAll(); return;
          }
          if (n === 1) { pending = pending.subarray(4); continue; }
          if (pending.length < n) break;
          const line = td.decode(pending.subarray(4, n)); pending = pending.subarray(n);
          if (line.startsWith('command=')) command = line.slice(8).trim();
        }
      } else if (t === MSG.CHANNEL_EOF) { await closeAll(); return; }
      else if (t === MSG.CHANNEL_CLOSE) return;
    }
  }

  kexInitPayload() {
    const w = this.variant('kexinit', 'wrongAlg');
    const a = { ...SERVER_ALGS };
    if (w) a[w.which] = [`${w.which.toLowerCase()}-none@ply.test`];
    return msg(MSG.KEXINIT, new Uint8Array(16).fill(7), names(a.kex), names(a.hostKey), names(a.cipher), names(a.cipher), names(a.mac), names(a.mac), names(a.comp), names(a.comp), names([]), names([]), Uint8Array.of(0), u32(0));
  }

  // One key exchange (the first, or a rekey the client asked for). `cIni` is the client's KEXINIT payload.
  async kex(cIni, first) {
    const iS = this.kexInitPayload();
    if (first) {
      const sent = await this.emit('kexinit', iS, { wrong: iS, before: msg(MSG.ECDH_REPLY) });
      if (!sent) return false;
      if (this.variant('kexinit', 'wrongAlg')) return false;
    } else if (this.rekeySent) this.rekeySent = false; // ours went first (server-initiated)
    else await this.send(iS);
    const cr = new R(cIni); cr.byte(); cr.p += 16; const ckex = cr.list(); cr.list(); const encCS = cr.list(), encSC = cr.list();
    const pick = (ours, theirs) => theirs.find(x => ours.includes(x));
    const enc = { cs: pick(SERVER_ALGS.cipher, encCS), sc: pick(SERVER_ALGS.cipher, encSC) };
    if (!pick(SERVER_ALGS.kex, ckex) || !enc.cs || !enc.sc) throw new Error('fake: no common algorithm');
    const init = new R(await this.expectRaw(MSG.ECDH_INIT)); init.byte(); const qC = init.str();
    const eph = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    let qS = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    const K = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: await crypto.subtle.importKey('raw', qC, { name: 'X25519' }, false, []) }, eph.privateKey, 256));
    const bad = first ? this.variant('ecdh', 'badKey') : null;
    const key = bad?.what === 'unpinned' ? this.srv.otherKey : this.srv.hostKey;
    let kS = key.blob;
    if (first && this.variant('ecdh', 'wrongAlg')) kS = concat([str('ssh-rsa'), str(new Uint8Array(32).fill(1))]);
    if (bad?.what === 'ephLength') qS = qS.subarray(0, 31);
    if (bad?.what === 'ephLowOrder') qS = new Uint8Array(32);
    const H = await sha256(concat([str(this.vC), str(this.vS), str(cIni), str(iS), str(kS), str(qC), str(qS), mpint(K)]));
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, bad?.what === 'sigBytes' ? concat([H, Uint8Array.of(1)]) : H));
    const sigBlob = concat([str(bad?.what === 'sigType' ? 'ssh-rsa' : 'ssh-ed25519'), str(sig)]);
    const reply = msg(MSG.ECDH_REPLY, str(kS), str(qS), str(sigBlob));
    if (first) { if (!(await this.emit('ecdh', reply, { wrong: reply, before: msg(MSG.NEWKEYS) }))) return false; }
    else await this.send(reply);
    if (!this.sessionId) this.sessionId = H;
    const derive = async (X, len) => { let out = await sha256(concat([mpint(K), H, te.encode(X), this.sessionId])); while (out.length < len) out = concat([out, await sha256(concat([mpint(K), H, out]))]); return out.subarray(0, len); };
    const klen = a => (a.startsWith('aes256') ? 32 : 16);
    const [ivCS, ivSC, kCS, kSC] = await Promise.all([derive('A', 12), derive('B', 12), derive('C', klen(enc.cs)), derive('D', klen(enc.sc))]);
    const gcm = async (k, iv, use) => { const nonce = iv.slice(); return { key: await crypto.subtle.importKey('raw', k, { name: 'AES-GCM' }, false, [use]), nonce, bump: () => { for (let i = 11; i >= 4; i--) { nonce[i] = (nonce[i] + 1) & 255; if (nonce[i]) break; } } }; };
    const newEnc = await gcm(kSC, ivSC, 'encrypt'), newDec = await gcm(kCS, ivCS, 'decrypt');
    if (first) {
      const nk = msg(MSG.NEWKEYS);
      const d = this.hit('newkeys');
      if (d?.tag === 'duplicate') { await this.send(nk); this.enc = newEnc; await this.send(nk); }
      else { if (!(await this.emit('newkeys', nk, { before: msg(MSG.SERVICE_ACCEPT, str('ssh-userauth')) }))) return false; this.enc = newEnc; }
    } else { await this.send(msg(MSG.NEWKEYS)); this.enc = newEnc; }
    await this.expectRaw(MSG.NEWKEYS);
    this.dec = newDec;
    return true;
  }
  // during the first kex the client's messages are read raw (no rekey handling: there is no session yet)
  async expectRaw(type) { for (;;) { const p = await this.readPacket(); if (p[0] === MSG.IGNORE || p[0] === MSG.DEBUG || p[0] === MSG.UNIMPLEMENTED) continue; if (p[0] !== type) throw new Error(`fake: expected ${type}, got ${p[0]}`); return p; } }
}

// startFakeSshd() → { port, hostKeyLine, setFault(f), connections: [{ log, exec, error }], close() }
export async function startFakeSshd({ streamPkts = 64 } = {}) {
  const hostKey = await hostKeyPair(), otherKey = await hostKeyPair();
  const srv = { hostKey, otherKey, fault: null, streamPkts, conns: [] };
  const socks = new Set();
  const server = net.createServer(sock => {
    socks.add(sock); sock.on('close', () => socks.delete(sock));
    const c = new Conn(sock, srv); const rec = { fault: srv.fault, log: c.log, exec: null, error: null }; srv.conns.push(rec);
    c.run().then(() => { rec.exec = c.exec; }, e => { rec.exec = c.exec; rec.error = e.message; sock.destroy(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, hostKeyLine: hostKey.line, conns: srv.conns,
    setFault(f) { srv.fault = f; },
    close() { for (const s of socks) s.destroy(); return new Promise(r => server.close(r)); },
  };
}
