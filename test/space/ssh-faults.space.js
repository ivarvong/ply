// The ssh-faults space, as code: what ply's SSH client does when the server breaks the protocol at one handshake phase.
// Two axes, each a tagged union: the phase (which server message carries the fault) and the defect (what is wrong with
// it; a defect with variants carries them as payload). The product is generic; INAPPLICABLE names the pairs that do not
// exist on the wire (with the reason), and `expected` is a total function from a cell to an outcome:
//
//   ply:  { tag: 'ok' }                      lsRefs answers (the fault was tolerated)
//         { tag: 'refused', code, message }  a typed error with that code, its message matching, within the time bound
//   git:  'ok' | 'refused'                   `git ls-remote` through OpenSSH against the same faulty server
//
// The oracle is OpenSSH (via git). ply and git must agree on the class (ok/refused) unless the cell names a DIVERGENCE
// with its reason. The scripted server is test/sshfake.js; RFC sections are RFC 4253 (transport), 4252 (auth), 4254
// (connection). The enumerator is test/space/ssh-faults.test.js.

export const PHASE = { name: 'phase', doc: 'the server message the fault is in, in handshake order', variants: [
  { tag: 'banner', why: 'the identification string (RFC 4253 §4.2); sent before any packet' },
  { tag: 'kexinit', why: 'the server KEXINIT (§7.1): algorithm lists' },
  { tag: 'ecdh', why: 'SSH_MSG_KEX_ECDH_REPLY (RFC 5656 §4, curve25519 RFC 8731): host key, ephemeral key, signature over H' },
  { tag: 'newkeys', why: 'the server NEWKEYS (§7.3): the last plaintext packet' },
  { tag: 'service', why: 'SERVICE_ACCEPT (§10): the first encrypted packet' },
  { tag: 'userauth', why: 'USERAUTH_SUCCESS (RFC 4252 §5.1)' },
  { tag: 'channelOpen', why: 'CHANNEL_OPEN_CONFIRMATION (RFC 4254 §5.1)' },
  { tag: 'exec', why: 'the exec request\'s CHANNEL_SUCCESS (RFC 4254 §5.4, §6.5)' },
  { tag: 'data', why: 'CHANNEL_DATA carrying the git v2 advertisement (RFC 4254 §5.2; gitprotocol-v2)' },
] };

export const DEFECT = { name: 'defect', doc: 'what is wrong with that message', variants: [
  { tag: 'truncated', cut: 'tcp', why: 'the connection ends inside the message (half the packet, or half the version line)' },
  { tag: 'truncated', cut: 'reset', why: 'a TCP reset (RST) after half the message' },
  { tag: 'truncated', cut: 'channel', why: 'the channel closes while the client still has bytes to write (window 0, then CHANNEL_CLOSE; RFC 4254 §5.2-5.3)' },
  { tag: 'truncated', cut: 'eof', why: 'the channel ends cleanly (exit-status 0, EOF, CLOSE) after half the advertisement' },
  { tag: 'malformed', why: 'the message ends inside one of its fields (a name-list, a string, a uint32 cut short: RFC 4251 §5); test/sshfake.js MALFORMED_CUT' },
  { tag: 'oversize', what: 'packet', why: 'a packet length field of 16 MiB (§6.1: implementations need only handle 35000; ply allows 256 KiB + 64); for the banner, a version line that never ends' },
  { tag: 'oversize', what: 'stream', why: 'an advertisement that never reaches its flush (limits.maxPackBytes bounds it)' },
  { tag: 'badPad', why: 'padding_length 3 (§6: at least 4 bytes; OpenSSH: "Corrupted padlen")' },
  { tag: 'badMac', why: 'the AES-GCM tag of the message fails (RFC 5647 §7.3); only once keys are in use' },
  { tag: 'unknown', why: `a message of unassigned type 200 before the real one (§11.4: MUST answer UNIMPLEMENTED and otherwise ignore it)` },
  ...['kex', 'hostKey', 'cipher'].map(which => ({ tag: 'wrongAlg', which, why: `the server's ${which} list names nothing the client implements (§7.1: no common algorithm, disconnect)` })),
  { tag: 'wrongAlg', which: 'phase', why: 'the phase\'s own refusal or mismatch: a v1 version line, an ssh-rsa host key blob, SERVICE_ACCEPT naming ssh-connection, USERAUTH_FAILURE (password only), CHANNEL_OPEN_FAILURE, CHANNEL_FAILURE for exec, a "version 3" advertisement' },
  ...['unpinned', 'sigType', 'sigBytes', 'ephLength', 'ephLowOrder'].map(what => ({ tag: 'badKey', what, why: {
    unpinned: 'a valid exchange signed by a host key that is not the pinned one', sigType: 'the signature blob says ssh-rsa', sigBytes: 'an Ed25519 signature over other bytes than H',
    ephLength: 'a 31-byte server ephemeral key (RFC 8731 §3: 32)', ephLowOrder: 'the all-zero (low-order) ephemeral key: the shared secret is zero (RFC 8731 §3: MUST abort)' }[what] })),
  { tag: 'duplicate', when: 'immediate', why: 'the message twice in a row' },
  { tag: 'duplicate', when: 'afterSession', why: 'a second KEXINIT once the session is up: a server-initiated rekey (§9)' },
  { tag: 'outOfOrder', why: 'the next phase\'s message first, then this one (for the banner: a KEXINIT packet before the version line; for data: exit, EOF and CLOSE, then the data)' },
  ...[2, 11].map(code => ({ tag: 'disconnect', code, why: `SSH_MSG_DISCONNECT ${code === 2 ? 'PROTOCOL_ERROR' : 'BY_APPLICATION'} instead of the message (§11.1)` })),
] };

export const AXES = [PHASE, DEFECT];

const PLAIN = new Set(['banner', 'kexinit', 'ecdh', 'newkeys']); // before NEWKEYS: no MAC exists
const PHASE_WRONG = new Set(['banner', 'ecdh', 'service', 'userauth', 'channelOpen', 'exec', 'data']);
// Pairs that do not exist on the wire; every other pair is a cell.
export const INAPPLICABLE = [
  { why: 'a channel cut needs a channel: only the data phase has one with bytes still to write or read', test: c => c.defect.tag === 'truncated' && ['channel', 'eof'].includes(c.defect.cut) && c.phase.tag !== 'data' },
  { why: 'a message with no fields cannot end inside one: the version line, NEWKEYS and USERAUTH_SUCCESS', test: c => c.defect.tag === 'malformed' && ['banner', 'newkeys', 'userauth'].includes(c.phase.tag) },
  { why: 'an unending stream needs a stream: only the advertisement is one', test: c => c.defect.tag === 'oversize' && c.defect.what === 'stream' && c.phase.tag !== 'data' },
  { why: 'the version line is a text line: it has no padding, MAC or message type, and cannot be a DISCONNECT', test: c => c.phase.tag === 'banner' && ['badPad', 'badMac', 'unknown', 'disconnect'].includes(c.defect.tag) },
  { why: 'no MAC before NEWKEYS takes effect (§7.3): the plaintext packets carry none', test: c => c.defect.tag === 'badMac' && PLAIN.has(c.phase.tag) },
  { why: 'algorithm lists exist only in KEXINIT', test: c => c.defect.tag === 'wrongAlg' && c.defect.which !== 'phase' && c.phase.tag !== 'kexinit' },
  { why: 'KEXINIT\'s refusal is the list axis (kex, hostKey, cipher); NEWKEYS carries nothing to refuse', test: c => c.defect.tag === 'wrongAlg' && c.defect.which === 'phase' && !PHASE_WRONG.has(c.phase.tag) },
  { why: 'host key, signature and ephemeral key are fields of KEX_ECDH_REPLY only', test: c => c.defect.tag === 'badKey' && c.phase.tag !== 'ecdh' },
  { why: 'a rekey is a second KEXINIT: only the kexinit phase has one', test: c => c.defect.tag === 'duplicate' && c.defect.when === 'afterSession' && c.phase.tag !== 'kexinit' },
];

export function* cells() {
  for (const phase of PHASE.variants) for (const defect of DEFECT.variants) {
    const c = { phase, defect };
    if (!INAPPLICABLE.some(r => r.test(c))) yield c;
  }
}
export const census = () => { let cells = 0; const inapplicable = INAPPLICABLE.map(() => 0); for (const phase of PHASE.variants) for (const defect of DEFECT.variants) { const i = INAPPLICABLE.findIndex(r => r.test({ phase, defect })); if (i < 0) cells++; else inapplicable[i]++; } return { raw: PHASE.variants.length * DEFECT.variants.length, cells, inapplicable }; };
const payload = v => Object.entries(v).filter(([k]) => k !== 'tag' && k !== 'why').map(([, x]) => x).join(',');
export const cellId = c => `${c.phase.tag}/${c.defect.tag}${payload(c.defect) ? `(${payload(c.defect)})` : ''}`;
// the fault test/sshfake.js injects for a cell
export const fault = c => ({ phase: c.phase.tag === 'channelOpen' ? 'channel-open' : c.phase.tag, defect: c.defect });

// ---- expected outcome ----
const ok = { tag: 'ok' };
const refused = (code, message) => ({ tag: 'refused', code, message });
// type byte of each phase's message, and what ply is waiting for when it arrives a second time
const TYPE = { kexinit: 20, ecdh: 31, newkeys: 21, service: 6, userauth: 52, channelOpen: 91, exec: 99, data: 94 };
const expecting = { kexinit: 'KEXINIT', ecdh: 'KEX_ECDH_REPLY', newkeys: 'NEWKEYS', service: 'SERVICE_ACCEPT' };
// ply's view of a message it did not expect, by the phase it is waiting in
const unexpected = (waiting, type) => (expecting[waiting] ? refused('ssh', new RegExp(`expected ${expecting[waiting]}, got ${type}$`))
  : waiting === 'userauth' ? refused('ssh', new RegExp(`unexpected message ${type} during userauth`))
  : refused('ssh', new RegExp(`unexpected message ${type}`)));
const PHASES = PHASE.variants.map(v => v.tag);

// Cells where ply and OpenSSH/git do not agree on ok/refused, each with the reason it is right for ply.
export const DIVERGENCE = {
  'kexinit/duplicate(afterSession)': 'ply does not implement rekeying (RFC 4253 §9 lets either side start one; OpenSSH honours it). ply sessions are one git operation, under the 1 GiB / 1 h rekey limits of OpenSSH servers; it refuses typed (`unsupported`) rather than continue on keys it was asked to retire',
};

export function expected(c) {
  const p = c.phase.tag, d = c.defect;
  const git = id => (DIVERGENCE[id] ? (ply => ({ ply, git: ply.tag === 'ok' ? 'refused' : 'ok' })) : (ply => ({ ply, git: ply.tag === 'ok' ? 'ok' : 'refused' })));
  const out = git(cellId(c));
  switch (d.tag) {
    case 'truncated':
      if (d.cut === 'channel') return out(refused('network', /channel closed while writing/));
      if (d.cut === 'reset') return out(refused('network', /ECONNRESET/));
      if (d.cut === 'eof') return out(refused('protocol', /git-upload-pack ended before the response was complete$/));
      return out(refused('network', /connection closed by peer/));
    case 'oversize':
      if (d.what === 'stream') return out(refused('limit_exceeded', /advertisement bytes/));
      if (p === 'banner') return out(refused('ssh', /no version line/));
      return out(refused('ssh', /packet too large \(16777216\)/));
    // ply reads every field of these messages, as OpenSSH does ("incomplete message", observed)
    case 'malformed': return out(refused('ssh', /short message/));
    case 'badPad': return out(refused('ssh', /bad padding/));
    case 'badMac': return out(refused('ssh', /packet authentication failed \(bad tag\)/));
    // OpenSSH refuses an unknown type during the key exchange (strict KEX) and userauth, and answers it UNIMPLEMENTED in
    // the connection phase (observed); ply does the same
    case 'unknown': return out(['channelOpen', 'exec', 'data'].includes(p) ? ok : unexpected(p, 200));
    case 'wrongAlg':
      if (d.which !== 'phase') return out(refused('unsupported', new RegExp(`no common ${{ kex: 'kex', hostKey: 'host key', cipher: 'cipher' }[d.which]} algorithm`)));
      return out({
        banner: refused('unsupported', /server version SSH-1\.5-plyfake/),
        ecdh: refused('unsupported', /host key type ssh-rsa/),
        service: ok, // the service name in SERVICE_ACCEPT is not checked, by OpenSSH (observed) or ply
        userauth: refused('auth', /publickey authentication refused \(server accepts: password,keyboard-interactive\)/),
        channelOpen: refused('ssh', /channel open failed \(3\): unknown channel type/),
        exec: refused('remote_error', /server refused to exec "git-upload-pack '\/r\.git'"/),
        data: refused('unsupported', /did not speak protocol v2 \(first line "version 3"\)/),
      }[p]);
    case 'badKey': return out({
      unpinned: refused('host_key_mismatch', /does not match the pinned/),
      sigType: refused('ssh', /bad host signature type/),
      sigBytes: refused('host_key_mismatch', /signature over the exchange hash does not verify/),
      ephLength: refused('ssh', /bad server ephemeral key/),
      ephLowOrder: refused('ssh', /all-zero shared secret/),
    }[d.what]);
    case 'duplicate':
      if (d.when === 'afterSession') return out(refused('unsupported', /server requested rekeying/));
      if (p === 'banner') return out(refused('ssh', /packet too large/)); // the second version line read as a packet length ("SSH-")
      if (p === 'channelOpen') return out(refused('ssh', /unexpected message 91 for channel 0, which is not opening/)); // OpenSSH: "open confirmation for non-opening channel"
      if (p === 'userauth') return out(ok); // a stray USERAUTH_SUCCESS in the connection phase: UNIMPLEMENTED, ignored (OpenSSH, observed)
      if (p === 'exec') return out(ok); // a reply with no request pending is dropped (OpenSSH, observed)
      if (p === 'data') return out(refused('protocol', /ls-refs: malformed line "version 2"/)); // the second advertisement read as the ls-refs answer
      return out(unexpected(PHASES[PHASES.indexOf(p) + 1], TYPE[p]));
    case 'outOfOrder':
      if (p === 'banner') return out(refused('ssh', /no version line/)); // binary before the version line
      if (p === 'exec') return out(ok); // data before the exec reply: allowed once the channel is open (RFC 4254 §5.2)
      if (p === 'data') return out(refused('remote_error', /git-upload-pack ended before its advertisement \(exit 0\)/));
      if (p === 'channelOpen') return out(ok); // an exec reply before the request answers nothing: dropped (OpenSSH, observed)
      return out(unexpected(p, TYPE[PHASES[PHASES.indexOf(p) + 1]] ?? 31));
    case 'disconnect': return out(refused(d.code === 2 ? 'protocol' : 'ssh', new RegExp(`server disconnected \\(${d.code}\\): fault at ${p === 'channelOpen' ? 'channel-open' : p}`)));
  }
  throw new Error(`ssh-faults: no expected outcome for ${cellId(c)}`);
}
