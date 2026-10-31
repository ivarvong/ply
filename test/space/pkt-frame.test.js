// The pkt-frame space (SPACES.md holes #6 and #14): pkt-line length framing, bounded-exhaustive, judged by git.
//
//   length    every class of the 4-byte prefix: 0000 flush, 0001 delim, 0002 response-end, 0003 invalid, 0004 empty,
//             0005, 0006, 000a, 0100, fff0 (LARGE_PACKET_MAX, git's writer bound), fff1, fff2, fff3 (git's reader
//             bound: len-4 < LARGE_PACKET_MAX), fff4 (the first refused), ffff; upper-, lower- and mixed-case hex; a
//             non-hex byte (each neighbour of a hex range: '/', ':', '@', 'G', '`', 'g', and ' ', NUL, 0xff, '-', '+')
//             in each of the 4 positions
//   relation  exact | short (one payload byte missing, then EOF) | long (one extra byte, then the rest) | cut1..cut3 (EOF
//             after 1..3 bytes of the prefix) | last (the frame, then EOF: the stream's terminator is missing)
//   position  adv-v2 (discover: the v2 capability advertisement) | adv-v0 (receiveCaps: the receive-pack ref
//             advertisement) | ls-refs (a v2 command response section) | band1 | band2 | band3 (a sideband packet in the
//             fetch packfile section) | push-report (report-status, no side-band) | push-sideband (side-band-64k)
//   writer    (hole #14) field {push option, ls-refs prefix, want, deepen-not, filter, ref} × payload length {65515,
//             65516, 65517}: git's format_packet dies "impossibly long line" past LARGE_PACKET_MAX before writing a byte
//
// Spec: git v2.50.0 pkt-line.c packet_read_with_status (ported below as gitRead), checked against real git on every
// framing cell: `git upload-pack --stateless-rpc` (protocol v2) reads the cell's bytes with GIT_TRACE_PACKET on, and the
// frames it traces and the error it dies with must be the model's. ply's pktStep/pktFinish must then equal the model on
// every framing cell (one chunk and byte by byte), and every position cell runs ply's real consumer over a real http
// transport (test/space/wire.js) with the expected outcome below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pkt, pktInit, pktStep, pktFinish } from '../../src/pktline.js';
import { discover } from '../../src/discover.js';
import { receiveCaps } from '../../src/receivecaps.js';
import { lsRefs, lsRefsBody } from '../../src/lsrefs.js';
import { fetchObject, fetchBody } from '../../src/fetch.js';
import { push } from '../../src/push.js';
import { pushWithOptions } from '../../src/receivecaps.js';
import { transport, outcome, outcomeSync, cat, enc, band, FLUSH, DELIM } from './wire.js';
import { git } from './pack-fixtures.js';

const LARGE_PACKET_MAX = 65520; // pkt-line.h
const OID = 'a'.repeat(40);

// ---- the spec: git's packet_read_with_status over a whole buffer (size = LARGE_PACKET_MAX, the packet_buffer) ----
const hexval = c => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);
export function gitRead(buf) {
  const frames = [];
  let p = 0;
  for (;;) {
    if (p === buf.length) return { frames, end: 'eof' };
    if (buf.length - p < 4) return { frames, end: 'hangup' }; // get_packet_data: "the remote end hung up unexpectedly"
    const v = [0, 1, 2, 3].map(i => hexval(buf[p + i]));
    if (v.some(x => x < 0)) return { frames, end: 'badchar' }; // "protocol error: bad line length character: %.4s"
    const len = (v[0] << 12) | (v[1] << 8) | (v[2] << 4) | v[3];
    if (len < 3) { frames.push({ kind: ['flush', 'delim', 'end'][len] }); p += 4; continue; }
    if (len === 3) return { frames, end: 'badlen' }; // "protocol error: bad line length %d"
    if (len - 4 >= LARGE_PACKET_MAX) return { frames, end: 'badlen' };
    if (buf.length - p - 4 < len - 4) return { frames, end: 'hangup' };
    frames.push({ kind: 'data', payload: buf.subarray(p + 4, p + len) });
    p += len;
  }
}

// ---- the axes ----
const NONHEX = ['/', ':', '@', 'G', '`', 'g', ' ', '\0', '\xff', '-', '+'];
const LENGTHS = [
  ...[['0000', 'flush'], ['0001', 'delim'], ['0002', 'end']].map(([hex, kind]) => ({ tag: `ctl-${kind}`, hex, control: kind })),
  { tag: 'len3', hex: '0003', bad: true },
  ...[4, 5, 6, 10, 256, 65520, 65521, 65522, 65523].map(n => ({ tag: `len${n}`, hex: n.toString(16).padStart(4, '0'), n })),
  ...[65524, 65535].map(n => ({ tag: `len${n}`, hex: n.toString(16).padStart(4, '0'), n, bad: true })),
  ...[['00AF', 175], ['00aF', 175], ['00Af', 175], ['FFF3', 65523]].map(([hex, n]) => ({ tag: `case-${hex}`, hex, n })),
  { tag: 'case-FFF4', hex: 'FFF4', n: 65524, bad: true },
  ...NONHEX.flatMap(ch => [0, 1, 2, 3].map(i => ({ tag: `nonhex-${ch.charCodeAt(0).toString(16)}@${i}`, hex: '000a'.slice(0, i) + ch + '000a'.slice(i + 1), n: 10, bad: true }))),
];
const RELATIONS = ['exact', 'short', 'long', 'cut1', 'cut2', 'cut3', 'last'];
const hexBytes = s => Uint8Array.from([...s].map(c => c.charCodeAt(0)));

// The cell's bytes: the prefix and the payload a position chooses (`payload(n)` returns exactly n - 4 bytes).
function cellBytes(L, rel, payload) {
  const prefix = hexBytes(L.hex);
  const whole = L.control || L.tag === 'len3' ? prefix : cat([prefix, payload(L.n)]);
  if (rel === 'exact' || rel === 'last') return whole;
  if (rel === 'short') return whole.subarray(0, whole.length - 1);
  if (rel === 'long') return cat([whole, Uint8Array.of(0x61)]);
  return prefix.subarray(0, Number(rel.slice(3)));
}
// the relation ends the stream (nothing after the cell) or leaves the rest of the response after it
const endsStream = rel => rel !== 'exact' && rel !== 'long';
const cells = () => LENGTHS.flatMap(L => RELATIONS.filter(r => !(L.control || L.tag === 'len3') || r !== 'short').map(rel => ({ L, rel })));

// ---- framing cells: the model against real git, then ply against the model ----
const gitDir = mkdtempSync(join(tmpdir(), 'ply-pkt-frame-'));
git(gitDir, ['init', '-q', '--bare']);
process.on('exit', () => rmSync(gitDir, { recursive: true, force: true }));
const agentPayload = n => enc(n - 4 >= 6 ? `agent=${'a'.repeat(n - 10)}` : 'a'.repeat(n - 4));
const traceText = b => { let s = ''; for (const c of b) { if (c === 10) continue; s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : `\\${c.toString(8)}`; } return s; };

function runGit(bytes) {
  const r = spawnSync('git', ['upload-pack', '--stateless-rpc', gitDir], { input: bytes, env: { ...process.env, GIT_PROTOCOL: 'version=2', GIT_TRACE_PACKET: '1' }, maxBuffer: 1 << 24 });
  const err = r.stderr.toString('latin1');
  const read = [];
  for (const l of err.split('\n')) { const m = /packet: +upload-pack< (.*)$/.exec(l); if (m) read.push(m[1]); }
  const fatal = (/fatal: (.*)/.exec(err) ?? [])[1] ?? null;
  const end = fatal === null ? null : /bad line length character/.test(fatal) ? 'badchar' : /bad line length/.test(fatal) ? 'badlen' : /hung up unexpectedly/.test(fatal) ? 'hangup' : 'semantic';
  return { read, fatal, end };
}
const traced = f => (f.kind === 'data' ? traceText(f.payload) : { flush: '0000', delim: '0001', end: '0002' }[f.kind]);

function plyRead(bytes, bytewise) {
  const frames = [];
  const o = outcomeSync(() => {
    let st = pktInit();
    if (bytewise) for (let i = 0; i < bytes.length; i++) { const r = pktStep(st, bytes.subarray(i, i + 1)); st = r.state; frames.push(...r.frames); }
    else { const r = pktStep(st, bytes); st = r.state; frames.push(...r.frames); }
    pktFinish(st);
  });
  return { frames, o };
}
const plyEnd = o => (o.tag === 'ok' ? 'eof' : o.tag !== 'typed' || o.code !== 'protocol' ? `other:${o.code}` : /trailing/.test(o.message) ? 'hangup' : /bad pkt-line length at/.test(o.message) ? 'badchar' : /invalid pkt-line length|^bad pkt-line length \d+$/.test(o.message) ? 'badlen' : `protocol:${o.message}`);
const sameFrames = (a, b) => a.length === b.length && a.every((f, i) => f.kind === b[i].kind && (f.kind !== 'data' || Buffer.compare(Buffer.from(f.payload), Buffer.from(b[i].payload)) === 0));

const census = { framing: 0, gitObserved: 0, positions: 0, outcomes: {}, writer: 0 };

test('framing: the model is git (upload-pack reads every cell with GIT_TRACE_PACKET), and ply is the model', () => {
  const lead = pkt('command=ls-refs\n');
  const wrong = [];
  for (const { L, rel } of cells()) {
    const cell = cellBytes(L, rel, agentPayload);
    const stream = cat([lead, cell, endsStream(rel) ? new Uint8Array(0) : FLUSH]);
    const m = gitRead(stream);
    const g = runGit(stream);
    census.framing++;
    const id = `${L.tag}/${rel}`;
    // git: what it traced is a prefix of the model's frames; where it died of framing, the model ends there the same way
    const want = m.frames.map(traced);
    if (g.read.some((r, i) => r !== want[i])) wrong.push(`${id}: git read ${JSON.stringify(g.read.map(s => s.slice(0, 20)))}, model ${JSON.stringify(want.map(s => s.slice(0, 20)))}`);
    else if (g.end === 'hangup' && m.end === 'eof' && g.read.length === m.frames.length) {
      // the stream ended on a frame boundary before the request's flush: git's request reader is not gentle on EOF
      // there ("hung up"); the packet reader itself read every frame, which is the model's eof
      census.gitObserved++;
    } else if (['badchar', 'badlen', 'hangup'].includes(g.end)) {
      census.gitObserved++;
      if (g.end !== m.end || g.read.length !== m.frames.length) wrong.push(`${id}: git died ${g.end} after ${g.read.length} frames (${g.fatal}), model ${m.end} after ${m.frames.length}`);
    } else if (g.end === null && g.read.length === m.frames.length) {
      census.gitObserved++;
      // a clean exit: git read every frame; the model must end cleanly or at a partial prefix git reads gently (EOF)
      if (m.end !== 'eof' && m.end !== 'hangup') wrong.push(`${id}: git exited cleanly, model ${m.end}`);
    }
    // ply against the model, in one chunk and byte by byte (frames are compared byte by byte: a chunk that throws hands
    // its consumer the error, not the frames before it in the same chunk)
    for (const bytewise of [false, true]) {
      const p = plyRead(stream, bytewise);
      if ((bytewise && !sameFrames(p.frames, m.frames)) || plyEnd(p.o) !== m.end) wrong.push(`${id}${bytewise ? ' bytewise' : ''}: ply ${p.frames.length} frames, ${plyEnd(p.o)}; model ${m.frames.length}, ${m.end}`);
    }
  }
  if (process.env.PKT_DUMP) console.error(wrong.join("\n")); assert.deepEqual(wrong.slice(0, 30), [], `${wrong.length} framing cell(s) disagree`);
});

// ---- position cells ----
const BIG = (() => { // a single-object pack larger than one frame, so a band-1 cell of any legal length carries real pack bytes
  const dir = mkdtempSync(join(tmpdir(), 'ply-pkt-big-'));
  try {
    git(dir, ['init', '-q']);
    let x = 7; const data = Buffer.alloc(150_000); for (let i = 0; i < data.length; i++) { x = (x * 1103515245 + 12345) % 2147483648; data[i] = x >> 16; }
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: data }).toString().trim();
    return { oid, pack: new Uint8Array(git(dir, ['pack-objects', '--stdout', '-q'], `${oid}\n`)) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
})();
const filler = n => enc('a'.repeat(Math.max(0, n)));
const ZERO = '0'.repeat(40);

// Each position: payload(n) (n-4 bytes, semantically neutral where git allows it), neutral(n): whether a legal data frame
// of length n is neutral there, render(L) -> { kind: advertise | post, before, after } (the
// response is before + cell + after; after ends with the terminator), run(t) the consumer, refuse: a refusal's code there.
// a flush in the packfile section ends the response: frames after it are refused; as the last frame, the pack is cut
const BAND_FLUSH = { exact: 'protocol', last: 'pack_corrupt' };
const POS = {
  'adv-v2': {
    // a flush ends the advertisement: on its own an empty one, which names neither ls-refs nor fetch (unsupported: git
    // "server doesn't support"); anything after it is refused (judgment: git's
    // remote-curl hands the whole buffer to the client, which would read the rest as the next response)
    payload: n => filler(n - 4), neutral: () => true, refuse: 'protocol', flush: { exact: 'protocol', last: 'unsupported' },
    render: () => ({ kind: 'advertise', before: pkt('version 2\n'), after: cat([pkt('agent=git/2.50.0\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow filter\n'), pkt('object-format=sha1\n'), FLUSH]) }),
    run: t => discover(t),
  },
  'adv-v0': {
    // a ref line: "<oid> refs/heads/<name>\n" (connect.c get_remote_heads process_ref); shorter than one is malformed
    payload: n => (n - 4 >= 54 ? enc(`${OID} refs/heads/${'a'.repeat(n - 4 - 53)}\n`) : filler(n - 4)), neutral: n => n - 4 >= 54, refuse: 'protocol',
    // get_remote_heads reads to the first flush and no further: what follows a flush is never read
    flush: { exact: 'ok', last: 'ok' },
    render: () => ({ kind: 'advertise', before: cat([pkt('# service=git-receive-pack\n'), FLUSH, pkt(`${OID} refs/heads/main\0report-status delete-refs push-options\n`)]), after: cat([pkt(`${OID} refs/tags/v1\n`), FLUSH]) }),
    run: t => receiveCaps(t),
  },
  'ls-refs': {
    // a ref line with an attribute git and ply both skip (process_ref_v2 reads only symref-target: and peeled:)
    payload: n => (n - 4 >= 64 ? enc(`${OID} refs/heads/pad x-pad:${'a'.repeat(n - 4 - 63)}\n`) : filler(n - 4)), neutral: n => n - 4 >= 64, refuse: 'protocol',
    // the flush ends the listing: on its own a valid one; a line after it is refused ("after the terminating flush-pkt")
    flush: { exact: 'protocol', last: 'ok' },
    render: () => ({ kind: 'post', before: pkt(`${OID} HEAD symref-target:refs/heads/main\n`), after: cat([pkt(`${OID} refs/heads/main\n`), FLUSH]) }),
    run: t => lsRefs(t),
  },
  band1: {
    payload: n => (n < 5 ? new Uint8Array(0) : cat([Uint8Array.of(1), BIG.pack.subarray(1000, 1000 + n - 5)])), neutral: n => n >= 5, refuse: 'protocol', flush: BAND_FLUSH,
    render: L => {
      const used = !L.control && L.tag !== 'len3' && L.n >= 5 ? L.n - 5 : 0; // a data cell carries pack bytes 1000..1000+used
      return { kind: 'post', before: cat([pkt('packfile\n'), band(1, BIG.pack.subarray(0, 1000))]), after: cat([...chunks(BIG.pack.subarray(1000 + used), 60000).map(c => band(1, c)), FLUSH]) };
    },
    run: t => fetchObject(t, { oid: BIG.oid }),
  },
  band2: {
    payload: n => (n < 5 ? new Uint8Array(0) : cat([Uint8Array.of(2), filler(n - 5)])), neutral: n => n >= 5, refuse: 'protocol', flush: BAND_FLUSH,
    render: () => ({ kind: 'post', before: cat([pkt('packfile\n'), band(1, BIG.pack.subarray(0, 1000))]), after: cat([...chunks(BIG.pack.subarray(1000), 60000).map(c => band(1, c)), FLUSH]) }),
    run: t => fetchObject(t, { oid: BIG.oid }),
  },
  band3: {
    payload: n => (n < 5 ? new Uint8Array(0) : cat([Uint8Array.of(3), filler(n - 5)])), neutral: () => false, refuse: 'protocol', remote: true, flush: BAND_FLUSH,
    render: () => ({ kind: 'post', before: cat([pkt('packfile\n'), band(1, BIG.pack.subarray(0, 1000))]), after: cat([...chunks(BIG.pack.subarray(1000), 60000).map(c => band(1, c)), FLUSH]) }),
    run: t => fetchObject(t, { oid: BIG.oid }),
  },
  'push-report': {
    payload: n => filler(n - 4), neutral: () => false, refuse: 'ambiguous', push: true,
    render: () => ({ kind: 'post', before: pkt('unpack ok\n'), after: cat([pkt('ok refs/heads/r0\n'), FLUSH]) }),
    run: t => push(t, { commands: [{ ref: 'refs/heads/r0', oldOid: OID, newOid: ZERO }], sideband: false }),
  },
  'push-sideband': {
    payload: n => (n < 5 ? new Uint8Array(0) : cat([Uint8Array.of(2), filler(n - 5)])), neutral: n => n >= 5, refuse: 'ambiguous', push: true,
    render: () => ({ kind: 'post', before: band(1, pkt('unpack ok\n')), after: cat([band(1, cat([pkt('ok refs/heads/r0\n'), FLUSH])), FLUSH]) }),
    run: t => push(t, { commands: [{ ref: 'refs/heads/r0', oldOid: OID, newOid: ZERO }], sideband: true }),
  },
};
function chunks(b, n) { const out = []; for (let i = 0; i < b.length; i += n) out.push(b.subarray(i, i + n)); return out; }

// The expected outcome of a position cell, from the model and the position's semantics:
//   framing the model refuses (bad length character, bad length, EOF inside a frame)  -> refuse (the position's code)
//   the stream ends without its terminator (relation last; a cut) -> refuse
//   long: one stray byte shifts every later frame; whatever the model frames, they are not the response -> refuse
//   exact, a data frame: neutral payload -> ok; band 3 -> remote_error; a frame the position cannot hold -> refuse
//   exact, flush/delim/response-end where a data line belongs -> refuse (git: "expected flush after capabilities",
//   get_remote_heads "invalid packet", "expected flush after ref listing"; a delim or response-end ends git's sideband
//   demultiplexer, so the pack is cut; push: the report is incomplete)
function expected(name, L, rel, response) {
  const P = POS[name];
  const m = gitRead(response);
  const refuse = { tag: 'typed', code: P.refuse };
  const legalData = !L.control && !L.bad;
  // band 3 is acted on as it is read: git's demultiplexer dies "remote error" before it reads past the frame
  if (P.remote && legalData && ['exact', 'long', 'last'].includes(rel) && L.n >= 5) return { tag: 'typed', code: 'remote_error' };
  if (m.end !== 'eof') return refuse;
  if (L.control === 'flush' && P.flush?.[rel]) return P.flush[rel] === 'ok' ? { tag: 'ok' } : { tag: 'typed', code: P.flush[rel] };
  if (rel !== 'exact' || L.control) return refuse;
  return P.neutral(L.n) ? { tag: 'ok' } : refuse;
}

test('positions: every length × relation × position cell through ply\'s real consumer has its expected outcome', async () => {
  const wrong = [];
  for (const [name, P] of Object.entries(POS)) {
    for (const { L, rel } of cells()) {
      const cell = cellBytes(L, rel, P.payload);
      const r = P.render(L, rel);
      // a cutting relation ends the stream at the cell: nothing after it is sent
      const sent = cat([r.before, cell, endsStream(rel) ? new Uint8Array(0) : r.after]);
      const t = transport((kind, service) => {
        if (kind === 'advertise') return r.kind === 'advertise' ? { bytes: sent } : undefined;
        if (service === 'git-upload-pack' || service === 'git-receive-pack') return r.kind === 'post' ? { bytes: sent } : undefined;
      });
      const want = expected(name, L, rel, sent);
      const got = await outcome(() => P.run(t));
      census.positions++;
      const k = `${name}:${got.tag === 'typed' ? got.code : got.tag}`; census.outcomes[k] = (census.outcomes[k] ?? 0) + 1;
      if (got.tag !== want.tag || (want.tag === 'typed' && got.code !== want.code)) wrong.push(`${name} ${L.tag}/${rel}: want ${want.tag}${want.code ? `(${want.code})` : ''}, got ${got.tag}${got.code ? `(${got.code})` : ''} ${(got.message ?? '').slice(0, 90)}`);
    }
  }
  if (process.env.PKT_DUMP) console.error(wrong.join("\n")); assert.deepEqual(wrong.slice(0, 40), [], `${wrong.length} position cell(s) wrong`);
});

// The smart-http "# service=" header (remote-curl check_smart_http): optional, its metadata lines run to a flush. Every
// header form × both advertisements: absent and present-with-flush are the same advertisement; a header whose flush is
// a delim, or missing (the response cut inside it), is refused.
test('service header: absent | flush | metadata then flush | delim | cut, on both advertisements', async () => {
  const wrong = [];
  const bodies = {
    'adv-v2': { run: t => discover(t), rest: cat([pkt('version 2\n'), pkt('agent=git/2.50.0\n'), pkt('ls-refs\n'), pkt('fetch=shallow filter\n'), FLUSH]) },
    'adv-v0': { run: t => receiveCaps(t), rest: cat([pkt(`${OID} refs/heads/main\0report-status\n`), FLUSH]) },
    // a receive-pack GET answered in v2 (Cloudflare Artifacts, asked with Git-Protocol: version=2): no v0 capabilities
    'adv-v0 as v2': { run: t => receiveCaps(t), rest: cat([pkt('version 2\n'), pkt('agent=x\n'), FLUSH]) },
  };
  const svc = { 'adv-v2': 'git-upload-pack', 'adv-v0': 'git-receive-pack', 'adv-v0 as v2': 'git-receive-pack' };
  for (const [name, b] of Object.entries(bodies)) {
    const head = pkt(`# service=${svc[name]}\n`);
    for (const [form, bytes, ok] of [
      ['absent', b.rest, true], ['flush', cat([head, FLUSH, b.rest]), true], ['metadata', cat([head, pkt('x-meta\n'), FLUSH, b.rest]), true],
      ['delim', cat([head, DELIM, b.rest]), false], ['cut', head, false],
      ['rest cut before its flush', cat([head, FLUSH, b.rest.subarray(0, b.rest.length - 4)]), false],
    ]) {
      const got = await outcome(() => b.run(transport(kind => (kind === 'advertise' ? { bytes } : undefined))));
      census.positions++;
      if (ok ? got.tag !== 'ok' : !(got.tag === 'typed' && got.code === 'protocol')) wrong.push(`${name} ${form}: ${JSON.stringify(got).slice(0, 140)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// ---- hole #14: the writer bound ----
// git format_packet: `if (n > LARGE_PACKET_MAX) die("protocol error: impossibly long line")` with n the framed length, so
// the largest payload is LARGE_PACKET_MAX - 4 = 65516. ply must refuse a longer field with a typed bad_request before any
// request is made (I1: every error typed; I5: refuse caller input before I/O), and send a 65516-byte payload intact.
test('writer: a field that frames past LARGE_PACKET_MAX is bad_request before any request; 65516 bytes frame intact', async () => {
  const wrong = [];
  const fields = {
    // field -> (payload length) -> [the call, the payload prefix the field adds]
    'push option': n => ({ call: t => pushWithOptions(t, { commands: [{ ref: 'refs/heads/r0', oldOid: OID, newOid: ZERO }], pushOptions: ['o'.repeat(n - 1)], sideband: false }), service: 'git-receive-pack', adv: true }),
    'ls-refs prefix': n => ({ call: t => lsRefs(t, ['p'.repeat(n - 'ref-prefix \n'.length)]), service: 'git-upload-pack' }),
    want: n => ({ call: () => fetchBody({ wants: ['w'.repeat(n - 'want \n'.length)] }), pure: true }),
    'deepen-not': n => ({ call: () => fetchBody({ wants: [OID], deepenNot: ['d'.repeat(n - 'deepen-not \n'.length)] }), pure: true }),
    filter: n => ({ call: () => fetchBody({ wants: [OID], filter: 'f'.repeat(n - 'filter \n'.length) }), pure: true }),
    'ls-refs body': n => ({ call: () => lsRefsBody(['p'.repeat(n - 'ref-prefix \n'.length)]), pure: true }),
  };
  for (const [field, mk] of Object.entries(fields)) for (const n of [LARGE_PACKET_MAX - 5, LARGE_PACKET_MAX - 4, LARGE_PACKET_MAX - 3]) {
    census.writer++;
    const c = mk(n);
    let requests = 0;
    const t = transport((kind, service) => { requests++; if (kind === 'advertise') return { bytes: cat([pkt('# service=git-receive-pack\n'), FLUSH, pkt(`${OID} refs/heads/r0\0report-status delete-refs push-options\n`), FLUSH]) }; return { bytes: service === 'git-upload-pack' ? FLUSH : cat([pkt('unpack ok\n'), pkt('ok refs/heads/r0\n'), FLUSH]) }; });
    const got = await outcome(() => c.call(t));
    const over = n > LARGE_PACKET_MAX - 4;
    if (over) {
      if (got.tag !== 'typed' || got.code !== 'bad_request') wrong.push(`${field} payload ${n}: want bad_request, got ${JSON.stringify(got).slice(0, 160)}`);
      else if (!c.pure && requests > (c.adv ? 1 : 0)) wrong.push(`${field} payload ${n}: ${requests} request(s) before the refusal`);
    } else if (got.tag !== 'ok') wrong.push(`${field} payload ${n}: want accepted, got ${JSON.stringify(got).slice(0, 160)}`);
    else if (c.pure) {
      const m = gitRead(got.value);
      if (m.end !== 'eof' || !m.frames.some(f => f.kind === 'data' && f.payload.length === n)) wrong.push(`${field} payload ${n}: the body does not frame back to a ${n}-byte line`);
    }
  }
  // pkt() itself, the one writer: every length to the bound frames back exactly; one past it is bad_request
  for (const n of [0, 1, LARGE_PACKET_MAX - 4]) { const f = gitRead(pkt(new Uint8Array(n))); if (f.end !== 'eof' || f.frames[0].payload.length !== n) wrong.push(`pkt(${n})`); }
  const over = outcomeSync(() => pkt(new Uint8Array(LARGE_PACKET_MAX - 3)));
  if (over.tag !== 'typed' || over.code !== 'bad_request') wrong.push(`pkt(${LARGE_PACKET_MAX - 3}): ${JSON.stringify(over)}`);
  assert.deepEqual(wrong, []);
});

test('census', t => {
  t.diagnostic(`${LENGTHS.length} length classes × ${RELATIONS.length} relations: ${census.framing} framing cells (${census.gitObserved} with git's verdict observed to the end), ${census.positions} position cells over ${Object.keys(POS).length} positions, ${census.writer} writer cells`);
  for (const [k, v] of Object.entries(census.outcomes).sort()) t.diagnostic(`  ${k}: ${v}`);
});
