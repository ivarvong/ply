// The advertisement space, as code: what ply does with what a server says about itself, and with what ply asks of it.
// Four decisions, each a product of axes that are tagged unions (a list of variants with the payload needed to render
// them and a `why` citing git's source), each with an exhaustive expected outcome per cell:
//
//   caps     discover(): the v2 capability advertisement (GET info/refs?service=git-upload-pack)
//   refs     lsRefs(): the ls-refs response, record by record
//   push     push() through GitHttp/pushWithOptions: what the push asks for × what receive-pack advertises
//   request  fetchPack(): the request arguments ply sends that no other space covers × the server's filter support
//
// Expected outcome, the one rule: ply proceeds when git proceeds, and gives a typed refusal (`unsupported`, `protocol`,
// `remote_error`, `not_git`, `network`) when git refuses or when a feature ply needs is absent. Every cell's expected
// value carries both sides: `git` (what git does with the same bytes: `ok` | `refuse`) and `ply` (an outcome tag, with
// the parsed value for `ok`); `consistent()` checks the rule over every cell. git sources are v2.50.0: connect.c
// (discover_version, process_capabilities_v2, server_supports_v2, server_feature_v2, server_supports_feature,
// send_capabilities, get_remote_refs, process_ref_v2), pkt-line.c (packet_read_with_status), remote-curl.c,
// serve.c (capabilities[]), upload-pack.c (upload_pack_advertise, process_args), send-pack.c (send_pack),
// builtin/receive-pack.c (show_ref, read_head_info), fetch-pack.c (send_fetch_request).
import { te, concat } from '../../src/bytes.js';

const pktBytes = payload => { const p = typeof payload === 'string' ? te.encode(payload) : payload; return concat([te.encode((p.length + 4).toString(16).padStart(4, '0')), p]); };
const FLUSH = te.encode('0000'), DELIM = te.encode('0001');
export const AGENT = 'git/2.50.0';
// the five `fetch=` features upload_pack_advertise can write, in its order
export const FETCH_FEATURES = ['shallow', 'wait-for-done', 'filter', 'ref-in-want', 'sideband-all'];
const subsets = list => list.reduce((acc, x) => acc.concat(acc.map(s => [...s, x])), [[]]).map(s => list.filter(x => s.includes(x)));
// payload sizes around git's reader limit (pkt-line.c: payload >= LARGE_PACKET_MAX dies "bad line length")
export const PAYLOAD_MAX = 65519;

export const product = axes => axes.reduce((cells, a) => cells.flatMap(c => a.variants.map(v => ({ ...c, [a.name]: v }))), [{}]);
export const cellId = (axes, c) => axes.map(a => `${a.name}=${c[a.name].tag}${c[a.name].set ? `[${c[a.name].set.join(',')}]` : ''}`).join(' ');

// ================================================================== caps ==================================================
export const CAPS_AXES = [
  { name: 'agent', doc: 'the agent capability', variants: [
    { tag: 'present', why: 'serve.c agent_advertise: always written by git' },
    { tag: 'absent', why: 'a server that does not say (send_capabilities skips agent= when !server_supports_v2("agent"))' },
    { tag: 'empty', why: '`agent=` with an empty value: recorded, never decided on' },
  ] },
  { name: 'objectFormat', doc: 'object-format, read by send_capabilities with server_feature_v2 (needs `=`)', variants: [
    { tag: 'sha1', value: 'sha1', why: 'serve.c object_format_advertise: the repository hash' },
    { tag: 'absent', why: 'no line: send_capabilities falls back to sha1' },
    { tag: 'sha256', value: 'sha256', why: 'a sha256 repository (git init --object-format=sha256): git proceeds, ply is sha1-only' },
    { tag: 'unknown', value: 'sha3', why: 'hash_algo_by_name fails: "unknown object format \'%s\' specified by server"' },
    { tag: 'bare', why: '`object-format` with no `=`: server_feature_v2 needs `=`, so it is absent (sha1)' },
    { tag: 'empty', value: '', why: '`object-format=`: "unknown object format \'\'"' },
  ] },
  { name: 'fetch', doc: 'the fetch command and its features', variants: [
    { tag: 'absent', why: 'no fetch command: fetch-pack ensure_server_supports_v2("fetch") dies' },
    ...subsets(FETCH_FEATURES).map(set => ({ tag: 'features', set, why: 'upload_pack_advertise: shallow and wait-for-done always; filter, ref-in-want, sideband-all by config' })),
  ] },
  { name: 'lsRefs', doc: 'the ls-refs command', variants: [
    { tag: 'unborn', why: 'ls_refs_advertise with lsrefs.unborn=advertise (the default)' },
    { tag: 'plain', why: 'lsrefs.unborn=ignore' },
    { tag: 'absent', why: 'get_remote_refs: ensure_server_supports_v2("ls-refs") dies' },
  ] },
  { name: 'serverOption', doc: 'server-option', variants: [
    { tag: 'present', why: 'serve.c: always advertised' },
    { tag: 'absent', why: 'ply never sends server options; recorded only' },
  ] },
  { name: 'sessionId', doc: 'session-id', variants: [
    { tag: 'absent', why: 'transfer.advertiseSID=false (the default)' },
    { tag: 'present', value: 'sid-1', why: 'transfer.advertiseSID=true; recorded only' },
  ] },
  { name: 'malformed', doc: 'one malformation of the advertisement', variants: [
    { tag: 'none', why: 'as serve.c writes it' },
    { tag: 'noLF', why: 'no line ends in LF: packet_read chomps an LF only when present (PACKET_READ_CHOMP_NEWLINE)' },
    { tag: 'unknownCap', why: 'a capability nobody defines: every lookup skips it' },
    { tag: 'duplicate', why: 'each capability again with another value, after the first: connect.c takes the first match' },
    { tag: 'longMax', why: `a capability line of ${PAYLOAD_MAX} payload bytes: the longest git's reader accepts` },
    { tag: 'longOver', why: `a capability line of ${PAYLOAD_MAX + 1} payload bytes: "protocol error: bad line length"` },
    { tag: 'noFlush', why: 'the body ends after the last capability: "expected flush after capabilities"' },
    { tag: 'delim', why: 'a delim-pkt where the flush belongs: "expected flush after capabilities"' },
    { tag: 'trailing', why: 'a data pkt after the flush: remote-curl hands it on as the ls-refs response, "invalid ls-refs response"' },
  ] },
];
// The protocol the server answers with, a tagged union whose only variant with a payload is v2 (it carries CAPS_AXES).
export const PROTOCOLS = [
  { tag: 'v2', why: 'version 2 then capabilities (serve.c protocol_v2_advertise_capabilities)' },
  { tag: 'v0', why: 'a server that ignores Git-Protocol: "# service=" preamble, then v0 ref lines with capabilities after NUL; git proceeds (discover_version), ply needs v2' },
  { tag: 'v1', why: '"# service=" preamble, "version 1", then v0 lines: protocol v1, which git reads as v0 (observed: ls-remote proceeds); ply needs v2' },
  { tag: 'err', why: 'an ERR pkt first: "remote error: %s"' },
  { tag: 'v2service', why: 'git\'s default v2 advertisement after a "# service=git-upload-pack" pkt and its flush (the smart-HTTP v0 preamble some servers keep): remote-curl skips it' },
  { tag: 'serviceNoFlush', why: 'the preamble with no flush after it: remote-curl refuses (observed)' },
  { tag: 'html', why: 'HTTP 200 with text/html (a login page): remote-curl "not valid: is this a git repository?"; http.js not_git' },
  { tag: 'reset', why: 'the connection fails before any response: git "the remote end hung up"; http.js network' },
];
export const CANONICAL_CAPS = { agent: 'present', objectFormat: 'sha1', fetch: 'shallow,wait-for-done,filter', lsRefs: 'unborn', serverOption: 'present', sessionId: 'absent', malformed: 'none' };
const fetchKey = v => (v.tag === 'absent' ? 'absent' : v.set.join(','));
export const capsDeviations = c => c.protocol.tag !== 'v2' ? 1 : CAPS_AXES.filter(a => (a.name === 'fetch' ? fetchKey(c.fetch) : c[a.name].tag) !== CANONICAL_CAPS[a.name]).length;
export function capsCells() {
  const v2 = product(CAPS_AXES).map(c => ({ protocol: PROTOCOLS[0], ...c }));
  return [...v2, ...PROTOCOLS.slice(1).map(p => ({ protocol: p }))];
}
// the canonical capability axes (git's default advertisement), for the protocol variants that wrap it
const canonicalAxes = () => Object.fromEntries(CAPS_AXES.map(a => [a.name, a.name === 'fetch' ? a.variants.find(v => v.set?.join(',') === CANONICAL_CAPS.fetch) : a.variants.find(v => v.tag === CANONICAL_CAPS[a.name])]));
const WRAPS_V2 = ['v2service', 'serviceNoFlush'];
export const capsCellId = c => (c.protocol.tag === 'v2' ? `v2 ${cellId(CAPS_AXES, c)}` : c.protocol.tag);

// The capability lines (no LF), in serve.c's order, before malformation.
function capLines(c) {
  const L = [];
  if (c.agent.tag === 'present') L.push(`agent=${AGENT}`); else if (c.agent.tag === 'empty') L.push('agent=');
  if (c.lsRefs.tag === 'unborn') L.push('ls-refs=unborn'); else if (c.lsRefs.tag === 'plain') L.push('ls-refs');
  if (c.fetch.tag === 'features') L.push(`fetch=${c.fetch.set.join(' ')}`);
  if (c.serverOption.tag === 'present') L.push('server-option');
  if (c.objectFormat.tag === 'bare') L.push('object-format'); else if ('value' in c.objectFormat) L.push(`object-format=${c.objectFormat.value}`);
  if (c.sessionId.tag === 'present') L.push(`session-id=${c.sessionId.value}`);
  return L;
}
// `duplicate`: each capability again, after all the others, with a value that differs from the first
const DUP = c => [
  'agent=dup/1',
  'ls-refs' + (c.lsRefs.tag === 'unborn' ? '' : '=unborn'),
  `fetch=${c.fetch.tag === 'absent' ? FETCH_FEATURES.join(' ') : FETCH_FEATURES.filter(f => !c.fetch.set.includes(f)).join(' ')}`,
  'server-option',
  `object-format=${c.objectFormat.tag === 'sha1' ? 'sha256' : 'sha1'}`,
  'session-id=dup',
];

// The effective capabilities: what git (and so ply) reads from the cell, per axis, under `duplicate` first-wins.
export function effectiveCaps(c) {
  const dup = c.malformed.tag === 'duplicate';
  const format = c.objectFormat.tag === 'absent' || c.objectFormat.tag === 'bare' ? 'sha1' : c.objectFormat.value; // a DUP after an absent/bare first is sha1 too
  return {
    agent: c.agent.tag === 'present' ? AGENT : c.agent.tag === 'empty' ? '' : dup ? 'dup/1' : '',
    objectFormat: format,
    fetch: c.fetch.tag === 'features' ? c.fetch.set : dup ? FETCH_FEATURES : null,
    lsRefs: c.lsRefs.tag !== 'absent' || dup,
    lsRefsUnborn: c.lsRefs.tag === 'unborn' || (c.lsRefs.tag === 'absent' && dup),
    serverOption: c.serverOption.tag === 'present' || dup,
    sessionId: c.sessionId.tag === 'present' ? c.sessionId.value : dup ? 'dup' : '',
  };
}

// fx: the fixture refs { head, main, tag, peeled } (oids; the ls-refs response every caps cell is served with)
export function renderCaps(c, fx) {
  if (c.protocol.tag === 'html') return { status: 200, contentType: 'text/html; charset=utf-8', body: te.encode('<html><body>Sign in</body></html>\n') };
  if (c.protocol.tag === 'reset') return { reset: true };
  const ct = 'application/x-git-upload-pack-advertisement';
  if (c.protocol.tag === 'err') return { status: 200, contentType: ct, body: concat([pktBytes('ERR access denied\n'), FLUSH]) };
  if (WRAPS_V2.includes(c.protocol.tag)) {
    const inner = renderCaps({ ...canonicalAxes(), protocol: PROTOCOLS[0] }, fx);
    return { ...inner, body: concat([pktBytes('# service=git-upload-pack\n'), ...(c.protocol.tag === 'v2service' ? [FLUSH] : []), inner.body]) };
  }
  if (c.protocol.tag === 'v0' || c.protocol.tag === 'v1') {
    const v0 = [pktBytes(`${fx.main} HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/main object-format=sha1 agent=${AGENT}\n`), pktBytes(`${fx.main} refs/heads/main\n`), FLUSH];
    return { status: 200, contentType: ct, body: concat([pktBytes('# service=git-upload-pack\n'), FLUSH, ...(c.protocol.tag === 'v1' ? [pktBytes('version 1\n')] : []), ...v0]) };
  }
  const m = c.malformed.tag;
  let lines = ['version 2', ...capLines(c)];
  if (m === 'unknownCap') lines.push('frobnicate=1');
  if (m === 'duplicate') lines.push(...DUP(c));
  const eol = m === 'noLF' ? '' : '\n';
  const parts = lines.map(l => pktBytes(l + eol));
  if (m === 'longMax' || m === 'longOver') parts.push(pktBytes(`x-pad=${'a'.repeat((m === 'longMax' ? PAYLOAD_MAX : PAYLOAD_MAX + 1) - 'x-pad='.length - 1)}\n`));
  if (m !== 'noFlush') parts.push(m === 'delim' ? DELIM : FLUSH);
  if (m === 'trailing') parts.push(pktBytes('trailing\n'));
  return { status: 200, contentType: ct, body: concat(parts) };
}

// git's verdict on the cell. ls-remote: the advertisement, then ls-refs (served with refs in the cell's hash). fetch:
// ls-remote plus a fetch of refs/heads/main (fetch-pack needs the `fetch` command; a sha256 cell is not fetched).
export function gitCaps(c) {
  const p = c.protocol.tag;
  if (p === 'v0' || p === 'v1' || p === 'v2service') return { lsRemote: 'ok', fetch: 'ok' };
  if (p !== 'v2') return { lsRemote: 'refuse', fetch: 'refuse' };
  const e = effectiveCaps(c);
  const lsRemote = ['longOver', 'noFlush', 'delim', 'trailing'].includes(c.malformed.tag) || !e.lsRefs || !['sha1', 'sha256'].includes(e.objectFormat) ? 'refuse' : 'ok';
  return { lsRemote, fetch: lsRemote === 'refuse' || e.fetch === null ? 'refuse' : 'ok' };
}

// ply's discover() on the cell. Order: the pkt framing, the protocol, the advertisement's framing, ls-refs and fetch
// present, the object format; ok carries the fields the test compares.
export function expectedCaps(c) {
  const git = gitCaps(c);
  const p = c.protocol.tag;
  const out = ply => ({ git, ply });
  if (p === 'html') return out({ tag: 'not_git' });
  if (p === 'reset') return out({ tag: 'network' });
  if (p === 'err') return out({ tag: 'remote_error' });
  if (p === 'serviceNoFlush') return out({ tag: 'protocol', why: 'advertisement framing' });
  if (p === 'v2service') return expectedCaps({ ...canonicalAxes(), protocol: PROTOCOLS[0] });
  if (p !== 'v2') return out({ tag: 'unsupported', why: 'protocol' });
  const m = c.malformed.tag;
  if (m === 'longOver') return out({ tag: 'protocol', why: 'pkt length' });
  if (m === 'noFlush' || m === 'delim' || m === 'trailing') return out({ tag: 'protocol', why: 'advertisement framing' });
  const e = effectiveCaps(c);
  if (!e.lsRefs) return out({ tag: 'unsupported', why: 'ls-refs' });
  if (e.fetch === null) return out({ tag: 'unsupported', why: 'fetch' });
  if (e.objectFormat !== 'sha1') return out({ tag: 'unsupported', why: 'object-format' });
  return out({ tag: 'ok', info: { agent: e.agent, objectFormat: 'sha1', fetch: e.fetch, filter: e.fetch.includes('filter'), shallow: e.fetch.includes('shallow'), waitForDone: e.fetch.includes('wait-for-done'), refInWant: e.fetch.includes('ref-in-want'), sidebandAll: e.fetch.includes('sideband-all'), lsRefs: true, lsRefsUnborn: e.lsRefsUnborn, serverOption: e.serverOption, sessionId: e.sessionId } });
}
// where ply refuses although git proceeds: only for a need git does not have in that operation (named, never silent)
export const PLY_NEEDS = { protocol: 'ply speaks v2 only (every request asserts it)', fetch: 'every ply read fetches', 'object-format': 'ply is sha1-only' };

// ================================================================== refs ==================================================
export const REFS_AXES = [
  { name: 'record', doc: 'one record of the listing, added to or changed in HEAD (symref), main, a tag (peeled)', variants: [
    { tag: 'plain', why: 'the listing as ls_refs writes it: HEAD symref-target, a branch, an annotated tag with peeled' },
    { tag: 'unknownAttr', why: 'an attribute ply and git do not know (`frob:1`): process_ref_v2 skips it (#16)' },
    { tag: 'unbornHead', why: '"unborn HEAD symref-target:…" in place of HEAD (ls-refs unborn): process_ref_v2 records no ref' },
    { tag: 'unbornOther', why: '"unborn <name>" for another name: process_ref_v2 skips it' },
    { tag: 'unbornOnly', why: '"unborn" alone: fewer than two fields, "invalid ls-refs response"' },
    { tag: 'emptySymref', why: '`symref-target:` with an empty target: kept as given; no HEAD target for ply' },
    { tag: 'emptyPeeled', why: '`peeled:` empty: parse_oid_hex fails, "invalid ls-refs response"' },
    { tag: 'badPeeled', why: '`peeled:zz`: "invalid ls-refs response"' },
    { tag: 'upperOid', why: 'the branch oid in upper case: parse_oid_hex_algop reads either case (hexval)' },
    { tag: 'upperPeeled', why: 'the peeled oid in upper case: as upperOid' },
    { tag: 'emptyName', why: '"<oid> " (an empty second field): process_ref_v2 makes a ref named ""' },
    { tag: 'doubleSpace', why: '"<oid>  <name>": the split on every space gives an empty name and an attribute token' },
    { tag: 'oidOnly', why: '"<oid>": one field, "invalid ls-refs response"' },
    { tag: 'badOid', why: '"<40 non-hex> <name>": parse_oid_hex_algop fails, "invalid ls-refs response"' },
    { tag: 'sha256', why: 'a 64-hex oid under a sha1 advertisement: "invalid ls-refs response"; ply is sha1-only' },
    { tag: 'duplicate', why: 'the branch again with another oid: git keeps both, find_ref_by_name (fetch, ls-remote --refs lookups) takes the first' },
    { tag: 'capsName', why: '"<oid> capabilities^{}": a v0 placeholder name, an ordinary ref name in v2' },
    { tag: 'err', why: 'an ERR pkt first: "remote error: %s"' },
  ] },
  { name: 'eol', doc: 'line ends', variants: [
    { tag: 'lf', why: 'as ls_refs writes it' },
    { tag: 'none', why: 'no LF on any record: the reader chomps an LF only when present' },
  ] },
  { name: 'framing', doc: 'the end of the listing', variants: [
    { tag: 'flush', why: 'output = *ref flush-pkt' },
    { tag: 'noFlush', why: '"expected flush after ref listing"' },
    { tag: 'delim', why: 'a delim-pkt for the flush: "expected flush after ref listing"' },
    { tag: 'trailing', why: 'a data pkt after the flush: "expected response end packet after ref listing" (stateless)' },
    { tag: 'longMax', why: `the branch record padded with an unknown attribute to ${PAYLOAD_MAX} payload bytes: accepted` },
    { tag: 'longOver', why: `padded to ${PAYLOAD_MAX + 1}: "protocol error: bad line length"` },
  ] },
];
export const refsCells = () => product(REFS_AXES);
export const refsCellId = c => cellId(REFS_AXES, c);
export const REFS_CANONICAL = { record: 'plain', eol: 'lf', framing: 'flush' };

// fx: { head: branch name 'refs/heads/main', main, tag, peeled, other } oids. Returns the response body.
export function renderRefs(c, fx) {
  const r = c.record.tag;
  const head = r === 'unbornHead' ? 'unborn HEAD symref-target:refs/heads/main' : `${fx.main} HEAD symref-target:${r === 'emptySymref' ? '' : 'refs/heads/main'}`;
  let main = `${r === 'upperOid' ? fx.main.toUpperCase() : fx.main} refs/heads/main${r === 'unknownAttr' ? ' frob:1' : ''}`;
  const tag = `${fx.tag} refs/tags/v1 peeled:${r === 'emptyPeeled' ? '' : r === 'badPeeled' ? 'zz' : r === 'upperPeeled' ? fx.peeled.toUpperCase() : fx.peeled}`;
  const extra = { unbornOther: ['unborn refs/heads/x'], unbornOnly: ['unborn'], emptyName: [`${fx.main} `], doubleSpace: [`${fx.main}  refs/heads/x`], oidOnly: [fx.main], badOid: [`${'z'.repeat(40)} refs/heads/bad`], sha256: [`${'a'.repeat(64)} refs/heads/wide`], duplicate: [`${fx.other} refs/heads/main`], capsName: [`${fx.main} capabilities^{}`] }[r] ?? [];
  const f = c.framing.tag;
  if (f === 'longMax' || f === 'longOver') main += ` x-pad:${'a'.repeat((f === 'longMax' ? PAYLOAD_MAX : PAYLOAD_MAX + 1) - main.length - ' x-pad:'.length - 1)}`;
  const lines = [...(r === 'err' ? ['ERR nope'] : []), head, main, tag, ...extra];
  const eol = c.eol.tag === 'lf' ? '\n' : '';
  // the padded line keeps its LF so that its payload is the stated size under either eol
  const parts = lines.map(l => pktBytes(l === main && (f === 'longMax' || f === 'longOver') ? `${l}\n` : l + eol));
  if (f !== 'noFlush') parts.push(f === 'delim' ? DELIM : FLUSH);
  if (f === 'trailing') parts.push(pktBytes('trailing\n'));
  return concat(parts);
}

export function gitRefs(c) {
  const bad = ['unbornOnly', 'emptyPeeled', 'badPeeled', 'oidOnly', 'badOid', 'sha256', 'err'].includes(c.record.tag) || ['noFlush', 'delim', 'trailing', 'longOver'].includes(c.framing.tag);
  return bad ? 'refuse' : 'ok';
}
// ply's lsRefs(): the pkt framing first (a chunk is decoded before its frames are read), then the records in order, then
// the listing's end. ok: the refs in listing order as [name, oid, peeled?, symref-target?] and head.
export function expectedRefs(c, fx) {
  const git = gitRefs(c);
  const r = c.record.tag, f = c.framing.tag;
  const out = ply => ({ git, ply });
  if (f === 'longOver') return out({ tag: 'protocol', why: 'pkt length' });
  if (r === 'err') return out({ tag: 'remote_error' });
  if (['emptyPeeled', 'badPeeled', 'oidOnly', 'badOid', 'unbornOnly'].includes(r)) return out({ tag: 'protocol', why: 'record' });
  if (r === 'sha256') return out({ tag: 'unsupported', why: 'object-format' });
  if (f !== 'flush' && f !== 'longMax') return out({ tag: 'protocol', why: 'listing framing' });
  const refs = [];
  if (r !== 'unbornHead') refs.push(['HEAD', fx.main, null, r === 'emptySymref' ? '' : 'refs/heads/main']);
  refs.push(['refs/heads/main', fx.main, null, null]);
  refs.push(['refs/tags/v1', fx.tag, fx.peeled, null]);
  if (r === 'emptyName' || r === 'doubleSpace') refs.push(['', fx.main, null, null]);
  if (r === 'capsName') refs.push(['capabilities^{}', fx.main, null, null]);
  return out({ tag: 'ok', refs, head: r === 'unbornHead' || r === 'emptySymref' ? null : 'refs/heads/main' });
}

// ================================================================== push ==================================================
export const PUSH_AXES = [
  { name: 'request', doc: 'what the push asks for', variants: [
    { tag: 'none', why: 'a plain push: ply reads no advertisement (one round trip)' },
    { tag: 'atomic', why: 'atomic: send_pack dies "the receiving end does not support --atomic push" unless advertised; receive-pack ignores an unadvertised atomic' },
    { tag: 'options', why: 'push options: "the receiving end does not support push options"; receive-pack reads unadvertised option lines as the pack' },
    { tag: 'both', why: 'atomic and push options' },
  ] },
  { name: 'atomic', doc: 'receive.advertiseAtomic', variants: [{ tag: 'on', why: 'the default: show_ref writes " atomic"' }, { tag: 'off', why: 'receive.advertiseAtomic=false' }] },
  { name: 'options', doc: 'receive.advertisePushOptions', variants: [{ tag: 'off', why: 'the default' }, { tag: 'on', why: 'receive.advertisePushOptions=true: " push-options"' }] },
  { name: 'format', doc: 'the server repository\'s hash', variants: [{ tag: 'sha1', why: 'object-format=sha1' }, { tag: 'sha256', why: 'object-format=sha256: "the receiving end does not support this repository\'s hash algorithm"' }] },
];
export const pushCells = () => product(PUSH_AXES);
export const pushCellId = c => cellId(PUSH_AXES, c);
const wantsAtomic = c => c.request.tag === 'atomic' || c.request.tag === 'both';
const wantsOptions = c => c.request.tag === 'options' || c.request.tag === 'both';
// git: send_pack checks the hash, then atomic, then push options, all before the pack. ply: the same three in the same
// order, when it reads the advertisement (atomic or options asked); a plain push to a sha256 repository reaches
// receive-pack, which dies reading the commands ("unsupported object format"): no report, so `ambiguous`.
export function expectedPush(c) {
  const why = c.format.tag === 'sha256' ? 'hash' : wantsAtomic(c) && c.atomic.tag === 'off' ? 'atomic' : wantsOptions(c) && c.options.tag === 'off' ? 'options' : null;
  const git = why ? { tag: 'refuse', why } : { tag: 'ok' };
  if (c.request.tag === 'none') return { git, ply: why ? { tag: 'ambiguous', why: 'no advertisement read; receive-pack dies on the commands' } : { tag: 'landed' } };
  return { git, ply: why ? { tag: 'unsupported', why } : { tag: 'landed' } };
}
export const GIT_PUSH_REFUSAL = {
  hash: 'the receiving end does not support this repository\'s hash algorithm',
  atomic: 'the receiving end does not support --atomic push',
  options: 'the receiving end does not support push options',
};

// ================================================================= request ================================================
export const REQUEST_AXES = [
  { name: 'flag', doc: 'one fetch argument ply can send (fetch.js fetchBody)', variants: [
    { tag: 'noProgress', why: 'ply\'s default: `no-progress`; upload-pack passes no --progress to pack-objects' },
    { tag: 'progress', why: 'noProgress:false: no `no-progress` line; pack-objects gets --progress (band 2)' },
    { tag: 'includeTag', why: '`include-tag`: pack-objects --include-tag (process_args sets use_include_tag)' },
    { tag: 'deepenRelative', why: '`deepen-relative` with `deepen 1` from a shallow boundary: depth counted from the client\'s shallows' },
    { tag: 'filter', why: '`filter blob:none`: process_args accepts it only when allow_filter' },
  ] },
  { name: 'server', doc: 'uploadpack.allowFilter', variants: [
    { tag: 'filterOn', why: 'uploadpack.allowFilter=true: `fetch=… filter`' },
    { tag: 'filterOff', why: 'the default: a `filter` line is an unexpected line and upload-pack dies (no flush)' },
  ] },
];
export const requestCells = () => product(REQUEST_AXES);
export const requestCellId = c => cellId(REQUEST_AXES, c);
// git fetch with the same option: proceeds everywhere (with filter off it warns "filtering not recognized by server,
// ignoring" and fetches everything). ply needs the filter it asked for (fetchObject's bounded memory rests on it): a
// server that cannot filter is refused (`protocol`: the stream ends without its flush; ply cannot tell more).
export function expectedRequest(c) {
  if (c.flag.tag === 'filter' && c.server.tag === 'filterOff') return { git: 'ok', gitSendsFlag: false, ply: { tag: 'protocol', why: 'filter not allowed' } };
  return { git: 'ok', gitSendsFlag: true, ply: { tag: 'ok', why: 'same request lines and the same pack-objects invocation as git' } };
}

// ============================================================== the rule ==================================================
// Over every cell: ply never proceeds where git refuses, and refuses where git proceeds only for a named need.
const TYPED = ['unsupported', 'protocol', 'remote_error', 'not_git', 'network'];
export function consistent(kind, e) {
  const gitOk = kind === 'caps' ? e.git.lsRemote === 'ok' : kind === 'push' ? e.git.tag === 'ok' : e.git === 'ok';
  const plyOk = e.ply.tag === 'ok' || e.ply.tag === 'landed';
  if (plyOk && !gitOk) return 'ply proceeds where git refuses';
  if (!plyOk && !TYPED.includes(e.ply.tag) && !(kind === 'push' && e.ply.tag === 'ambiguous')) return `untyped refusal ${e.ply.tag}`;
  if (!plyOk && gitOk) {
    if (kind === 'caps' && !(e.ply.why in PLY_NEEDS)) return `ply refuses where git proceeds, for no named need (${e.ply.why})`;
    if (kind === 'refs' || kind === 'push') return 'ply refuses where git proceeds';
    if (kind === 'request' && e.ply.why !== 'filter not allowed') return 'ply refuses where git proceeds';
  }
  return null;
}

// the cells judged by real git (test/space/advertisement.test.js runs exactly these); the rest are derived
export const observedCounts = () => ({ caps: capsCells().filter(c => capsDeviations(c) <= 1).length, refs: refsCells().length, push: pushCells().length, request: requestCells().length });

// ============================================================== SPACE.md ==================================================
export const MD_START = '<!-- advertisement: generated by scripts/space-md.mjs; do not edit by hand -->';
export const MD_END = '<!-- advertisement: end generated -->';
export function mdBlock(observed) {
  const fmt = n => n.toLocaleString('en-US');
  const L = [MD_START, ''];
  const axes = (title, list) => {
    L.push(`**${title}**`, '');
    for (const a of list) L.push(`- \`${a.name}\` (${a.variants.length}) — ${a.doc}: ${a.variants.map(v => `\`${v.tag}${v.set ? `[${v.set.join(' ')}]` : ''}\``).filter((x, i, s) => a.name !== 'fetch' || i < 2 || i === s.length - 1).join(', ')}${a.name === 'fetch' ? ' (… every subset of the five features: 32 + absent)' : ''}`);
    L.push('');
  };
  L.push('### Axes (tagged unions)', '');
  L.push(`**caps protocol** (${PROTOCOLS.length}) — ${PROTOCOLS.map(p => `\`${p.tag}\``).join(', ')}; only \`v2\` carries the capability axes`, '');
  axes('caps (v2)', CAPS_AXES);
  axes('refs', REFS_AXES);
  axes('push', PUSH_AXES);
  axes('request', REQUEST_AXES);
  const counts = { caps: capsCells().length, refs: refsCells().length, push: pushCells().length, request: requestCells().length };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const obs = Object.values(observed).reduce((a, b) => a + b, 0);
  L.push('### Cells', '');
  L.push('| decision | cells | observed from git | derived |', '|---|---:|---:|---:|');
  for (const k of Object.keys(counts)) L.push(`| ${k} | ${fmt(counts[k])} | ${fmt(observed[k])} | ${fmt(counts[k] - observed[k])} |`);
  L.push(`| **all** | **${fmt(total)}** | **${fmt(obs)}** | **${fmt(total - obs)}** |`, '', MD_END);
  return L.join('\n');
}
