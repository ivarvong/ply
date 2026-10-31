// The push-outcome space, as code. Each axis is a tagged union (a list of variants, each with the minimal payload needed
// to render it and a `why` citing git's source). The space is the plain list of axes; `product` takes it generically, so
// a new variant or axis adds every cell it creates. `render` is one function per axis, composed; `expected` is a total
// function from a cell to a tagged-union outcome, written as one exhaustive table per axis (MEANING) plus a combiner.
// SPACE.md's "Push outcome" section is generated from this file (scripts/space-md.mjs) and checked by the test.
//
// git sources cited are git v2.50.0: builtin/receive-pack.c (report, report_v2, execute_commands, execute_commands_atomic,
// unpack, copy_to_sideband, cmd_receive_pack), send-pack.c (receive_unpack_status, receive_status, send_pack),
// sideband.c (demultiplex_sideband), pkt-line.c (recv_sideband, packet_writer_error, packet_read_with_status).
import { pkt, FLUSH } from '../../src/pktline.js';
import { concat, te } from '../../src/bytes.js';

export const ZERO = '0'.repeat(40);
export const OLD = '1'.repeat(40);
export const NEW = '2'.repeat(40);
export const REFS = ['refs/heads/r0', 'refs/heads/r1', 'refs/heads/r2'];
export const FOREIGN_REF = 'refs/heads/zz';
// The enumerator runs with a small report-line cap so the `flood` delivery can exceed it cheaply.
export const MAX_REPORT_LINES = 16;
// git's unpack() return values (builtin/receive-pack.c unpack, parse_pack_header): the only non-"ok" unpack statuses
// receive-pack can write. Exported for the doc; src/push.js keeps its own copy (the test checks they agree).
export const GIT_UNPACK_ERRORS = [
  'eof before pack header was fully read',
  'protocol error (pack signature mismatch detected)',
  'protocol error (pack version unsupported)',
  'unknown error in parse_pack_header',
  'unable to create temporary object directory',
  'unpack-objects abnormal exit',
  'index-pack fork failed',
  'index-pack abnormal exit',
];

// ---- per-ref status: one union, used by two axes (every ref's status, and the odd ref of a mixed report) ----
const STATUS = [
  { tag: 'ok', why: 'report(): "ok <ref>" when cmd->error_string is NULL' },
  { tag: 'ngCas', reason: 'failed to update ref', why: 'execute_commands_non_atomic(): ref_transaction_commit failed (stale old oid; observed from git 2.50)' },
  { tag: 'ngHook', reason: 'hook declined', why: 'update(): the update hook refused (observed)' },
  { tag: 'ngAtomic', reason: 'atomic push failure', why: 'execute_commands_atomic(): the innocent members of a failed atomic push (observed)' },
  { tag: 'ngUnpacker', reason: 'unpacker error', why: 'execute_commands(): every command, and only when unpack failed' },
  { tag: 'missing', why: 'no status line for a commanded ref: report() writes one per command, so never git' },
  { tag: 'duplicate', why: 'the ref\'s "ok" line twice: report() writes one per command; report_v2 repeats "ok" only with option lines (proc-receive)' },
  { tag: 'unexpected', why: `the ref's line names ${FOREIGN_REF}, a ref not commanded (send-pack.c receive_status: "unknown ref")` },
  { tag: 'unreadable', why: 'the status word is not text (0xff 0xfe): send-pack.c receive_status "invalid ref status"' },
  { tag: 'nearMiss', why: '"ng <ref>" with no reason: report() always writes a reason; send-pack.c would read it as "failed"' },
];

const variants = (list, extra = {}) => list.map(v => ({ ...v, ...extra }));

// ---- the axes ----
const EVENT = { name: 'event', doc: 'what else happens around the exchange', variants: [
    { tag: 'clean', why: 'nothing else' },
    { tag: 'progress', why: 'band 2 before the report (unpack/hook stderr via copy_to_sideband) and after it (post-receive)' },
    { tag: 'keepalive', why: 'an empty band-1 packet "0005\\1" before and after the report: copy_to_sideband sends it while hooks run (use_keepalive is KEEPALIVE_ALWAYS from execute_commands on, so post-receive too)' },
    { tag: 'band3Before', why: 'band 3 before the report: demultiplex_sideband reports "remote error"; receive-pack itself never writes band 3' },
    { tag: 'band3After', why: 'band 3 after the report, before the outer flush' },
    { tag: 'errPkt', why: 'an "ERR " pkt before the report: packet_read dies (PACKET_READ_DIE_ON_ERR_PACKET in send_pack)' },
    { tag: 'dropBeforePack', why: 'the connection fails after the commands, before the pack: the server unpacks nothing ("eof before pack header")' },
    { tag: 'dropMidPack', why: 'the connection fails inside the pack: index-pack/unpack-objects fails, nothing is updated' },
    { tag: 'dropAfterPack', why: 'the connection fails after the pack, before any response byte: the server may have updated the refs' },
    ...[
      ['ref', 'validateRef refuses the ref name'],
      ['oid', 'an old/new oid that is not 40-hex'],
      ['maxRefs', 'more commands than limits.maxRefs'],
      ['packBytes', 'the built pack exceeds limits.maxPackBytes'],
      ['pushOption', 'a push option containing LF'],
    ].map(([what, why]) => ({ tag: 'refused', what, why: `ply refuses before sending: ${why}` })),
  ] };
const FRAMING = { name: 'framing', doc: 'how the report is carried', variants: [
    { tag: 'plain', why: 'no side-band: report() write_or_die(1, …); hook output goes to stderr, not the wire' },
    { tag: 'sideband', why: 'side-band-64k: report pkts + flush inside one band-1 packet (send_sideband), then an outer flush (cmd_receive_pack)' },
  ] };
const DELIVERY = { name: 'delivery', doc: 'what reaches the client of the framed response', variants: [
    { tag: 'complete', why: 'every byte, then end of stream' },
    { tag: 'band1Split', why: 'one band-1 packet per inner pkt: send_sideband() chunks at LARGE_PACKET_MAX; the client reassembles band 1 as a stream' },
    { tag: 'noFinalFlush', why: 'the stream ends before the final flush: git dies (packet_read: "the remote end hung up") / demultiplex_sideband "unexpected disconnect"' },
    { tag: 'noReportFlush', why: 'the report\'s own flush is missing inside band 1, the outer flush present' },
    { tag: 'cutAfterUnpack', why: 'the stream ends cleanly after the unpack line (a cut at a pkt boundary)' },
    { tag: 'cutMidPkt', why: 'the stream ends inside the last data pkt' },
    { tag: 'trailingPkt', why: 'a second copy of the report after the final flush' },
    { tag: 'throwAfter', why: 'every byte, then the transport fails (connection reset after the flush)' },
    { tag: 'flood', why: `${MAX_REPORT_LINES} extra report lines: exceeds the client's report-line cap` },
    { tag: 'trailingFlush', why: 'a second flush after the final flush' },
    { tag: 'band1Trailing', extra: 'partial', why: 'band 1 carries two more bytes after the report\'s flush (a pkt cut inside band 1)' },
    { tag: 'band1Trailing', extra: 'flush', why: 'band 1 carries a second report flush' },
    { tag: 'wrongBand', band: 5, why: 'the report on band 5: one bit from band 1 (demultiplex_sideband: "bad band")' },
  ] };
export const AXES = [
  EVENT, FRAMING, DELIVERY,
  { name: 'refs', doc: 'number of commanded refs', variants: [
    { tag: 'one', n: 1, why: 'single-ref push (the edit pipeline)' },
    { tag: 'two', n: 2, why: 'smallest multi-ref push: first and last ref differ' },
    { tag: 'three', n: 3, why: 'a ref with neighbours on both sides (an interior position)' },
  ] },
  { name: 'commands', doc: 'what the commands ask for; decides whether a pack is sent', variants: [
    { tag: 'withPack', why: 'some new oid is non-zero: cmd_receive_pack runs unpack_with_sideband()' },
    { tag: 'deleteOnly', why: 'every new oid is zero: delete_only() skips unpack, so the status is always "unpack ok"' },
  ] },
  { name: 'atomic', doc: 'the atomic capability', variants: [
    { tag: 'off', why: 'execute_commands_non_atomic(): one transaction per ref' },
    { tag: 'on', why: 'execute_commands_atomic(): one transaction; a failure inside it marks every other command "atomic push failure"' },
  ] },
  { name: 'format', doc: 'report-status v1 or v2, and option lines', variants: [
    { tag: 'v1', why: 'report(): unpack line, one ok/ng line per command, flush' },
    { tag: 'v2', why: 'report_v2() without proc-receive: byte-identical to report()' },
    { tag: 'v2Options', why: 'report_v2(): "option forced-update" after each ok, written only for proc-receive reports' },
    { tag: 'v1Options', why: 'option lines when report-status-v2 was not negotiated: report() never writes them' },
  ] },
  { name: 'unpack', doc: 'the unpack line', variants: [
    { tag: 'ok', why: 'report(): "unpack ok" when unpack_status is NULL' },
    { tag: 'gitError', status: 'unpack-objects abnormal exit', why: 'unpack(): one of git\'s fixed failure strings (observed with a corrupted pack)' },
    { tag: 'absent', why: 'no unpack line: send-pack.c receive_unpack_status fails' },
    { tag: 'unreadable', why: 'status bytes 0xff 0xfe: not text' },
    { tag: 'nearMiss', status: 'ok*', why: 'one flip from "ok" (issue #33): neither "ok" nor a git failure string' },
    { tag: 'duplicated', why: 'two "unpack ok" lines: receive_unpack_status reads one; the second is an invalid ref status' },
  ] },
  { name: 'status', doc: 'every commanded ref\'s status (a mixed report overrides one ref, see spread)', variants: variants(STATUS) },
  { name: 'spread', doc: 'statuses across refs: uniform, or one ref (at index `at`) differs', variants: [
    { tag: 'uniform', why: 'every ref has `status`' },
    ...[0, 1, 2].flatMap(at => STATUS.map(odd => ({ tag: 'mixed', at, odd, why: `ref ${at} has status ${odd.tag}` }))),
  ] },
];

export const axis = name => AXES.find(a => a.name === name);
export const TAGS = Object.fromEntries(AXES.map(a => [a.name, [...new Set(a.variants.map(v => v.tag))]]));
export const STATUS_TAGS = STATUS.map(s => s.tag);

// ---- constraints: impossible cells, and axes made irrelevant by another axis ----
const SIDEBAND_ONLY_EVENTS = new Set(['progress', 'keepalive', 'band3Before', 'band3After']);
const NO_RESPONSE = new Set(['dropBeforePack', 'dropMidPack', 'dropAfterPack', 'refused']);
// Each rule reads `axes` and says why the cell cannot exist. A cell matching any rule is not a cell of the space.
export const IMPOSSIBLE = [
  { why: 'plain framing has no band 1, 2 or 3 (use_sideband=0: hook output goes to stderr)', axes: ['event', 'framing', 'delivery'], test: c => c.framing.tag === 'plain' && (SIDEBAND_ONLY_EVENTS.has(c.event.tag) || ['band1Split', 'noReportFlush', 'band1Trailing', 'wrongBand'].includes(c.delivery.tag)) },
  { why: 'a delete-only push sends no pack, so it cannot be cut inside or after one, nor refused for its size', axes: ['event', 'commands'], test: c => c.commands.tag === 'deleteOnly' && (['dropMidPack', 'dropAfterPack'].includes(c.event.tag) || (c.event.tag === 'refused' && c.event.what === 'packBytes')) },
  { why: 'one ref cannot be mixed', axes: ['refs', 'spread'], test: c => c.spread.tag === 'mixed' && c.refs.n === 1 },
  { why: 'the odd ref index is beyond the commanded refs', axes: ['refs', 'spread'], test: c => c.spread.tag === 'mixed' && c.spread.at >= c.refs.n },
  { why: 'a mixed report whose odd status equals the common status is the uniform cell', axes: ['status', 'spread'], test: c => c.spread.tag === 'mixed' && c.spread.odd.tag === c.status.tag },
];
// When `when(cell)` holds (it reads only `on`), `axes` cannot affect anything (nothing is read): only their first
// variant is kept. `on` must precede `axes` in AXES.
export const COLLAPSE = [
  { why: 'no response is read (refused before sending, or the connection failed first): the response axes are irrelevant', on: ['event'], when: c => NO_RESPONSE.has(c.event.tag), axes: ['framing', 'delivery', 'format', 'unpack', 'status', 'spread'] },
];

// ---- the product (generic, pruned) ----
// Walks AXES in order; a rule is checked as soon as every axis it reads is assigned, so an impossible subtree is
// skipped whole and its size counted arithmetically. `visit(cell)` sees every cell; the return is the census.
export const rawSize = (axes = AXES) => axes.reduce((n, a) => n * a.variants.length, 1);
export function walk(visit = () => {}, axes = AXES) {
  const pos = Object.fromEntries(axes.map((a, i) => [a.name, i]));
  const ready = rules => rules.map(r => Math.max(...(r.axes ?? r.on).map(n => pos[n])));
  const impReady = ready(IMPOSSIBLE), colReady = ready(COLLAPSE.map(r => ({ axes: r.on })));
  const by = { cells: 0 };
  const rest = i => axes.slice(i).reduce((n, a) => n * a.variants.length, 1);
  const cell = {}, collapsed = new Set();
  const go = i => {
    if (i === axes.length) { by.cells++; visit({ ...cell }); return; }
    const a = axes[i];
    const vs = collapsed.has(a.name) ? a.variants.slice(0, 1) : a.variants;
    if (vs.length < a.variants.length) { const k = 'collapsed:0'; by[k] = (by[k] ?? 0) + (a.variants.length - vs.length) * rest(i + 1); }
    for (const v of vs) {
      cell[a.name] = v;
      const bad = IMPOSSIBLE.findIndex((r, j) => impReady[j] === i && r.test(cell));
      if (bad >= 0) { const k = `impossible:${bad}`; by[k] = (by[k] ?? 0) + rest(i + 1); continue; }
      const added = [];
      COLLAPSE.forEach((r, j) => { if (colReady[j] === i && r.when(cell)) for (const n of r.axes) if (!collapsed.has(n)) { collapsed.add(n); added.push(n); } });
      go(i + 1);
      for (const n of added) collapsed.delete(n);
    }
    delete cell[a.name];
  };
  go(0);
  return { raw: rawSize(axes), ...by };
}
// Deviations from git's canonical single-ref success on the axes that shape the response. PUSH_SPACE=quick (the mutation
// gate) explores the sub-product of cells with at most QUICK_DEVIATIONS of them; the full run explores every cell.
const CANONICAL_AXES = ['event', 'delivery', 'format', 'unpack', 'status', 'spread'];
export const QUICK_DEVIATIONS = 2;
export const deviations = c => CANONICAL_AXES.filter(n => c[n] !== axis(n).variants[0]).length;
export function* cells() { const all = []; walk(c => all.push(c)); yield* all; }
export const census = () => walk();
export const cellId = c => AXES.map(a => {
  const v = c[a.name];
  const p = Object.entries(v).filter(([k]) => k !== 'tag' && k !== 'why' && k !== 'n').map(([k, x]) => `${k}=${typeof x === 'object' ? x.tag : x}`);
  return p.length ? `${v.tag}(${p.join(',')})` : v.tag;
}).join('/');

// ---- per-ref statuses of a cell ----
export const statuses = c => Array.from({ length: c.refs.n }, (_, i) => (c.spread.tag === 'mixed' && c.spread.at === i ? c.spread.odd : c.status));

// ---- rendering: one function per axis, composed ----
const line = (...parts) => concat(parts.map(p => (typeof p === 'string' ? te.encode(p) : p)));
const band = (b, body) => pkt(concat([Uint8Array.of(b), body]));
const OPTION_LINE = line('option forced-update\n');

export const RENDER = {
  refs: v => ({ refs: REFS.slice(0, v.n) }),
  commands: v => ({ newOid: v.tag === 'deleteOnly' ? ZERO : NEW }),
  atomic: v => ({ atomic: v.tag === 'on' }),
  format: v => ({ reportV2: v.tag === 'v2' || v.tag === 'v2Options', options: v.tag === 'v2Options' || v.tag === 'v1Options' }),
  unpack: v => ({
    ok: () => [line('unpack ok\n')],
    gitError: () => [line(`unpack ${v.status}\n`)],
    absent: () => [],
    unreadable: () => [line('unpack ', Uint8Array.of(0xff, 0xfe), '\n')],
    nearMiss: () => [line(`unpack ${v.status}\n`)],
    duplicated: () => [line('unpack ok\n'), line('unpack ok\n')],
  })[v.tag](),
  // one ref's status lines
  status: (v, ref, options) => ({
    ok: () => [line(`ok ${ref}\n`), ...(options ? [OPTION_LINE] : [])],
    ngCas: () => [line(`ng ${ref} ${v.reason}\n`)],
    ngHook: () => [line(`ng ${ref} ${v.reason}\n`)],
    ngAtomic: () => [line(`ng ${ref} ${v.reason}\n`)],
    ngUnpacker: () => [line(`ng ${ref} ${v.reason}\n`)],
    missing: () => [],
    duplicate: () => [line(`ok ${ref}\n`), line(`ok ${ref}\n`)],
    unexpected: () => [line(`ok ${FOREIGN_REF}\n`)],
    unreadable: () => [line(Uint8Array.of(0xff, 0xfe), ` ${ref}\n`)],
    nearMiss: () => [line(`ng ${ref}\n`)],
  })[v.tag](),
  spread: (c, refs, options) => statuses(c).flatMap((s, i) => RENDER.status(s, refs[i], options)),
  // framing: report lines (+ the event's frames) → outer frames. A frame is { data } or { flush: true }.
  framing: (v, { lines, pre, post, reportFlush, split, reportBand = 1, after = new Uint8Array(0) }) => v.tag === 'plain'
    ? [...pre, ...lines.map(data => ({ data: pkt(data) })), { flush: true, final: true }]
    : [...pre, ...(split
      ? [...lines.map(data => ({ data: band(reportBand, pkt(data)) })), ...(reportFlush ? [{ data: band(reportBand, FLUSH) }] : [])]
      : [{ data: band(reportBand, concat([...lines.map(d => pkt(d)), ...(reportFlush ? [FLUSH] : []), after])) }]), ...post, { flush: true, final: true }],
  event: v => ({
    clean: () => ({ pre: [], post: [] }),
    progress: () => ({ pre: [{ data: band(2, line('Resolving deltas: 100% (1/1), done.\n')) }], post: [{ data: band(2, line('post-receive: deployed\n')) }] }),
    keepalive: () => ({ pre: [{ data: band(1, new Uint8Array(0)) }], post: [{ data: band(1, new Uint8Array(0)) }] }),
    band3Before: () => ({ pre: [{ data: band(3, line('internal server error\n')) }], post: [] }),
    band3After: () => ({ pre: [], post: [{ data: band(3, line('internal server error\n')) }] }),
    errPkt: () => ({ pre: [{ data: pkt('ERR access denied\n') }], post: [] }),
    dropBeforePack: () => ({ drop: 'before the pack' }),
    dropMidPack: () => ({ drop: 'inside the pack' }),
    dropAfterPack: () => ({ drop: 'after the pack' }),
    refused: () => ({ refused: v.what }),
  })[v.tag](),
  // delivery: (frames, report lines) → { bytes, end: 'eof' | 'throw' }
  delivery: v => v.tag,
};

const serialize = frames => concat(frames.map(f => (f.flush ? FLUSH : f.data)));

// The request ply makes for a cell, and the server's behaviour (null for a pre-send refusal).
export function render(c) {
  const { refs } = RENDER.refs(c.refs);
  const { newOid } = RENDER.commands(c.commands);
  const { atomic } = RENDER.atomic(c.atomic);
  const { reportV2, options } = RENDER.format(c.format);
  const ev = RENDER.event(c.event);
  let commands = refs.map(ref => ({ ref, oldOid: OLD, newOid }));
  const opts = { sideband: c.framing.tag === 'sideband', reportV2, atomic, pushOptions: [] };
  const limits = { maxRefs: 8, maxReportLines: MAX_REPORT_LINES, maxPackBytes: 1 << 20 };
  if (ev.refused) {
    if (ev.refused === 'ref') commands = [{ ...commands[0], ref: 'refs/heads/bad name' }, ...commands.slice(1)];
    if (ev.refused === 'oid') commands = [{ ...commands[0], oldOid: 'xyz' }, ...commands.slice(1)];
    if (ev.refused === 'maxRefs') limits.maxRefs = refs.length - 1;
    if (ev.refused === 'packBytes') limits.maxPackBytes = 16;
    if (ev.refused === 'pushOption') opts.pushOptions = ['a\nb'];
    return { commands, opts, limits, response: null };
  }
  if (ev.drop) return { commands, opts, limits, response: { drop: ev.drop } };
  let lines = [...RENDER.unpack(c.unpack), ...RENDER.spread(c, refs, options)];
  const d = RENDER.delivery(c.delivery);
  if (d === 'cutAfterUnpack') lines = lines.slice(0, 1);
  if (d === 'flood') lines = [...lines.slice(0, 1), ...Array.from({ length: MAX_REPORT_LINES }, () => line('unpack flood\n')), ...lines.slice(1)];
  const after = d === 'band1Trailing' ? (c.delivery.extra === 'flush' ? FLUSH : te.encode('00')) : undefined;
  const framed = RENDER.framing(c.framing, { lines, pre: ev.pre, post: d === 'cutAfterUnpack' ? [] : ev.post, reportFlush: !['noReportFlush', 'cutAfterUnpack'].includes(d), split: d === 'band1Split', reportBand: d === 'wrongBand' ? c.delivery.band : 1, after });
  let frames = framed;
  if (d === 'noFinalFlush' || d === 'cutAfterUnpack' || d === 'cutMidPkt') frames = frames.filter(f => !f.final);
  if (d === 'trailingPkt') frames = [...frames, ...RENDER.framing(c.framing, { lines, pre: [], post: [], reportFlush: true, split: false })];
  if (d === 'trailingFlush') frames = [...frames, { flush: true }];
  let bytes = serialize(frames);
  if (d === 'cutMidPkt') {
    // inside the last data pkt; a report with no data pkt at all ends inside its flush ("00")
    const last = frames.filter(f => f.data).at(-1);
    bytes = last ? bytes.subarray(0, bytes.length - Math.ceil(last.data.length / 2)) : concat([bytes, te.encode('00')]);
  }
  return { commands, opts, limits, response: { bytes, end: d === 'throwAfter' ? 'throw' : 'eof' } };
}

// ---- the expected outcome: exhaustive per-axis meaning, then one combiner ----
// Outcomes: { tag: 'landed', refs } | { tag: 'rejected', code } | { tag: 'partial', landed, rejected }
//         | { tag: 'ambiguous' } | { tag: 'preSend', code, what }
const CAS = new Set(['ngCas', 'ngAtomic']);
export const MEANING = {
  refs: { one: () => ({}), two: () => ({}), three: () => ({}) },
  commands: { withPack: () => ({ pack: true }), deleteOnly: () => ({ pack: false }) },
  atomic: { off: () => ({ atomic: false }), on: () => ({ atomic: true }) },
  // option lines follow each ok: neither shape is a plain update. v2 + options is proc-receive (the server updated some
  // other ref or oid on our behalf): ply does not model it, so a report carrying them is never a definite answer.
  format: { v1: () => ({ options: false }), v2: () => ({ options: false }), v2Options: () => ({ options: true }), v1Options: () => ({ options: true }) },
  unpack: {
    ok: () => 'ok', gitError: () => 'failed',
    absent: () => 'bad', unreadable: () => 'bad', nearMiss: () => 'bad', duplicated: () => 'bad',
  },
  status: {
    ok: () => 'ok', ngCas: () => 'ng', ngHook: () => 'ng', ngAtomic: () => 'ng', ngUnpacker: () => 'unpacker',
    missing: () => 'bad', duplicate: () => 'bad', unexpected: () => 'bad', unreadable: () => 'bad', nearMiss: () => 'bad',
  },
  spread: { uniform: () => null, mixed: v => v.at },
  framing: { plain: () => 'exact', sideband: () => 'exact' },
  delivery: {
    complete: () => 'exact', band1Split: () => 'exact',
    noFinalFlush: () => 'broken', noReportFlush: () => 'broken', cutAfterUnpack: () => 'broken', cutMidPkt: () => 'broken',
    trailingPkt: () => 'broken', throwAfter: () => 'broken', flood: () => 'broken',
    trailingFlush: () => 'broken', band1Trailing: () => 'broken', wrongBand: () => 'broken',
  },
  event: {
    clean: () => 'exact', progress: () => 'exact', keepalive: () => 'exact',
    band3Before: () => 'broken', band3After: () => 'broken', errPkt: () => 'broken',
    dropBeforePack: () => 'none', dropMidPack: () => 'none', dropAfterPack: () => 'none',
    refused: v => ({ ref: ['bad_request', 'ref'], oid: ['bad_request', undefined], maxRefs: ['limit_exceeded', 'push commands'], packBytes: ['limit_exceeded', 'push pack bytes'], pushOption: ['bad_request', 'push option'] })[v.what],
  },
};
const mean = (name, v) => {
  const f = MEANING[name][v.tag];
  if (!f) throw new Error(`MEANING.${name} has no case for tag ${v.tag}`);
  return f(v);
};

const AMBIGUOUS = Object.freeze({ tag: 'ambiguous' });
export function expected(c) {
  const ev = mean('event', c.event);
  if (Array.isArray(ev)) return { tag: 'preSend', code: ev[0], what: ev[1] };
  if (ev === 'none' || ev === 'broken') return AMBIGUOUS;
  if (mean('framing', c.framing) !== 'exact' || mean('delivery', c.delivery) !== 'exact') return AMBIGUOUS;
  mean('refs', c.refs); mean('spread', c.spread);
  const { pack } = mean('commands', c.commands);
  const { atomic } = mean('atomic', c.atomic);
  const { options } = mean('format', c.format);
  const unpack = mean('unpack', c.unpack);
  const per = statuses(c).map(s => ({ kind: mean('status', s), s }));
  if (unpack === 'bad' || per.some(p => p.kind === 'bad')) return AMBIGUOUS;
  if (options && per.some(p => p.kind === 'ok')) return AMBIGUOUS;
  const refs = REFS.slice(0, c.refs.n);
  if (unpack === 'failed') return pack && per.every(p => p.kind === 'unpacker') ? { tag: 'rejected', code: 'push_rejected' } : AMBIGUOUS;
  if (per.some(p => p.kind === 'unpacker')) return AMBIGUOUS;
  const ok = refs.filter((_, i) => per[i].kind === 'ok'), ng = refs.filter((_, i) => per[i].kind === 'ng');
  if (!ng.length) return { tag: 'landed', refs: ok };
  if (!ok.length) {
    const tags = per.map(p => p.s.tag);
    return { tag: 'rejected', code: tags.every(t => CAS.has(t)) && tags.some(t => t === 'ngCas') ? 'cas_conflict' : 'push_rejected' };
  }
  return atomic ? AMBIGUOUS : { tag: 'partial', landed: ok, rejected: ng };
}
export const isDefinite = o => o.tag === 'landed' || o.tag === 'rejected' || o.tag === 'partial';
