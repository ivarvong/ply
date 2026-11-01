// Cells observed from git: a real `git receive-pack` (git http-backend behind test/server.js) answers ply's real HTTP
// push. For each scenario the response bytes are captured and must equal the cell's rendering (band-2 text stripped,
// runs of keepalives collapsed), ply's outcome must be the table's, and the server's ref state must agree with it:
// landed → every ref moved; rejected → none; partial → exactly the landed ones; ambiguous → recorded (the truth ply did
// not claim). Faults are injected in the request (a corrupted pack, a cut body), never in git's answer.
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { git, tmpRoot, makeBareRepo, startGitServer } from '../server.js';
import { GitHttp } from '../../src/client.js';
import { Tracer, arrayExporter } from '../../src/otel.js';
import { encodeTree, encodeCommit, hashObject, TYPE } from '../../src/objects.js';
import { pktInit, pktStep, FLUSH } from '../../src/pktline.js';
import { concat, te, indexOfBytes } from '../../src/bytes.js';
import { ZERO_OID } from '../../src/push.js';
import * as space from './push-outcome.space.js';
import { defaultCapabilities } from '../../src/capabilities.js';

const ev = (name, tag, extra = {}) => {
  const vs = space.axis(name).variants.filter(v => v.tag === tag && Object.entries(extra).every(([k, x]) => (typeof x === 'string' && typeof v[k] === 'object' ? v[k].tag === x : v[k] === x)));
  if (vs.length !== 1) throw new Error(`no single variant ${name}.${tag} ${JSON.stringify(extra)}`);
  return vs[0];
};
// cellOf({ refs: 'two', spread: ['mixed', { at: 1, odd: 'ngHook' }], ... }); unspecified axes take their first variant
export const cellOf = spec => Object.fromEntries(space.AXES.map(a => {
  const s = spec[a.name] ?? a.variants[0].tag;
  return [a.name, Array.isArray(s) ? ev(a.name, s[0], s[1]) : ev(a.name, s)];
}));

const commit = (msg, parents) => {
  const blob = te.encode(`${msg}\n`);
  const tree = encodeTree([{ mode: '100644', name: 'f', oid: hashObject('blob', blob) }]);
  const c = encodeCommit({ tree: hashObject('tree', tree), parents, author: 'a <a@x> 1700000000 +0000', message: `${msg}\n` });
  return { oid: hashObject('commit', c), objects: [{ type: TYPE.COMMIT, data: c }, { type: TYPE.TREE, data: tree }, { type: TYPE.BLOB, data: blob }] };
};
const C0 = commit('c0', []), C1 = commit('c1', [C0.oid]);
const hook = (bare, name, body) => { const p = join(bare, 'hooks', name); mkdirSync(join(bare, 'hooks'), { recursive: true }); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
const SETUP = {
  none: () => {},
  updateRejectsR1: b => hook(b, 'update', 'echo "update $1" >&2\n[ "$1" = refs/heads/r1 ] && exit 1\nexit 0'),
  preReceiveRejects: b => hook(b, 'pre-receive', 'echo "policy: no" >&2\nexit 1'),
  hideR1: b => git(b, ['config', 'receive.hideRefs', 'refs/heads/r1']),
  noisy: b => { hook(b, 'pre-receive', 'echo "pre-receive says hi" >&2'); hook(b, 'post-receive', 'echo "post-receive says bye" >&2'); },
  slowHooks: b => { git(b, ['config', 'receive.keepAlive', '1']); hook(b, 'pre-receive', 'sleep 2'); hook(b, 'post-receive', 'sleep 2'); },
};
// request faults, applied by the fetchImpl wrapper to the receive-pack POST
const FAULT = {
  none: null,
  corruptPack: body => { const b = body.slice(); b[b.length - 5] ^= 1; return { body: b }; },
  dropBeforePack: body => ({ body: body.subarray(0, packStart(body)), drop: true }),
  dropMidPack: body => ({ body: body.subarray(0, packStart(body) + 20), drop: true }),
  dropAfterPack: body => ({ body, drop: true }),
};
const packStart = body => indexOfBytes(body, te.encode('PACK'));
// the compare-and-swap reasons of rejectionCode (src/push.js isCas)
const CAS = /^(failed to update ref|failed to lock|atomic push failure|bad ref|stale ref|incorrect old value provided)$|fetch first|non-fast-forward|already exists/;

// [name, cell spec, { setup, fault, stale }]. `stale`: refs commanded with an old oid they are not at.
const N = { one: 1, two: 2, three: 3 };
export const SCENARIOS = [
  ...['one', 'two', 'three'].flatMap(refs => ['plain', 'sideband'].flatMap(framing => ['v1', 'v2'].flatMap(format => ['off', 'on'].map(atomic =>
    [`all ok ${refs}/${framing}/${format}/atomic ${atomic}`, { refs, framing, format, atomic }, {}]))) ),
  ...['two', 'three'].flatMap(refs => ['plain', 'sideband'].flatMap(framing => ['v1', 'v2'].flatMap(format => [
    [`update hook refuses r1 ${refs}/${framing}/${format}`, { refs, framing, format, event: framing === 'sideband' ? 'progress' : 'clean', spread: ['mixed', { at: 1, odd: 'ngHook' }] }, { setup: 'updateRejectsR1' }],
    [`update hook refuses r1, atomic ${refs}/${framing}/${format}`, { refs, framing, format, atomic: 'on', event: framing === 'sideband' ? 'progress' : 'clean', status: 'ngAtomic', spread: ['mixed', { at: 1, odd: 'ngHook' }] }, { setup: 'updateRejectsR1' }],
  ]))),
  ...['plain', 'sideband'].flatMap(framing => [
    [`pre-receive refuses ${framing}`, { refs: 'two', framing, event: framing === 'sideband' ? 'progress' : 'clean', status: 'ngHook' }, { setup: 'preReceiveRejects', reasons: { ngHook: 'pre-receive hook declined' } }],
    [`stale old oid ${framing}`, { framing, event: framing === 'sideband' ? 'progress' : 'clean', status: 'ngCas' }, { stale: [0] }],
    [`stale old oid, two refs ${framing}`, { refs: 'two', framing, event: framing === 'sideband' ? 'progress' : 'clean', spread: ['mixed', { at: 0, odd: 'ngCas' }] }, { stale: [0] }],
    [`corrupted pack ${framing}`, { framing, event: framing === 'sideband' ? 'progress' : 'clean', unpack: 'gitError', status: 'ngUnpacker' }, { fault: 'corruptPack' }],
    [`corrupted pack, two refs, atomic ${framing}`, { refs: 'two', atomic: 'on', framing, event: framing === 'sideband' ? 'progress' : 'clean', unpack: 'gitError', status: 'ngUnpacker' }, { fault: 'corruptPack' }],
    [`delete ${framing}`, { commands: 'deleteOnly', framing }, {}],
    [`delete two, one stale ${framing}`, { refs: 'two', commands: 'deleteOnly', framing, event: framing === 'sideband' ? 'progress' : 'clean', spread: ['mixed', { at: 1, odd: 'ngCas' }] }, { stale: [1] }],
    // update(): a delete whose old oid names an object the server lacks is applied regardless ("allowing deletion of
    // corrupt ref"): git's report says ok, and the ref is gone. The report is truthful, the CAS is not.
    [`delete with an unknown old oid ${framing}`, { commands: 'deleteOnly', framing, event: framing === 'sideband' ? 'progress' : 'clean' }, { stale: [0], unknownOld: true }],
    [`hidden ref, non-atomic ${framing}`, { refs: 'two', framing, spread: ['mixed', { at: 1, odd: 'ngHook' }] }, { setup: 'hideR1', reasons: { ngHook: 'deny updating a hidden ref' } }],
    [`hidden ref, atomic ${framing}`, { refs: 'two', atomic: 'on', framing, spread: ['mixed', { at: 1, odd: 'ngHook' }] }, { setup: 'hideR1', reasons: { ngHook: 'deny updating a hidden ref' } }],
  ]),
  ['noisy hooks, band 2 before and after the report', { refs: 'two', framing: 'sideband', event: 'progress' }, { setup: 'noisy' }],
  ['slow hooks: keepalives before and after the report', { framing: 'sideband', event: 'keepalive' }, { setup: 'slowHooks' }],
  ...['dropBeforePack', 'dropMidPack', 'dropAfterPack'].map(fault => [`connection fails: ${fault}`, { event: fault, framing: 'plain' }, { fault }]),
];

// band 2 removed; runs of empty band-1 packets (keepalives) collapsed to one
function normalize(bytes, sideband) {
  if (!sideband) return bytes;
  const r = pktStep(pktInit(), bytes);
  const out = []; let prevKeepalive = false;
  for (const f of r.frames) {
    if (f.kind === 'flush') { out.push(FLUSH); prevKeepalive = false; continue; }
    if (f.payload[0] === 2) continue;
    const ka = f.payload.length === 1 && f.payload[0] === 1;
    if (ka && prevKeepalive) continue;
    prevKeepalive = ka;
    const len = (f.payload.length + 4).toString(16).padStart(4, '0');
    out.push(te.encode(len), f.payload);
  }
  if (r.state.carry) out.push(r.state.carry);
  return concat(out);
}

// what besides the report git sent on the side-band: band-2 frames, and empty band-1 keepalives before / after the report
function extras(bytes) {
  const r = pktStep(pktInit(), bytes);
  const x = { band2: 0, kaBefore: 0, kaAfter: 0 }; let reported = false;
  for (const f of r.frames) {
    if (f.kind !== 'data') continue;
    if (f.payload[0] === 2) x.band2++;
    else if (f.payload[0] === 1 && f.payload.length === 1) x[reported ? 'kaAfter' : 'kaBefore']++;
    else if (f.payload[0] === 1) reported = true;
  }
  return x;
}
// the cell's event must be what git did: clean → nothing besides the report; progress → band 2; keepalive → keepalives
// on both sides of the report (the claim that post-receive keepalives follow the report is checked here)
const eventMatches = (event, x) => ({ clean: x.band2 === 0 && x.kaBefore + x.kaAfter === 0, progress: x.band2 > 0, keepalive: x.kaBefore > 0 && x.kaAfter > 0 })[event] ?? true;

const outcomeOf = (e, commands) => {
  if (!e) return { tag: 'landed', refs: commands.map(c => c.ref) };
  if (e.code === 'ambiguous') return { tag: 'ambiguous' };
  if (e.code === 'cas_conflict' || e.code === 'push_rejected') return { tag: 'rejected', code: e.code };
  if (e.code === 'push_partial') return { tag: 'partial', landed: e.landed, rejected: e.rejected.map(r => r.ref) };
  return { tag: 'other', code: e.code, message: e.message };
};

export async function observeAll() {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  const results = [];
  try {
    let id = 0;
    for (const [name, spec, { setup = 'none', fault = 'none', stale = [], reasons = {}, unknownOld = false }] of SCENARIOS) {
      const cell = cellOf(spec);
      const n = N[cell.refs.tag];
      const bare = makeBareRepo(root, `s${id}`);
      const seed = new GitHttp(`${srv.url}/s${id}.git`, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: arrayExporter() }) } });
      id++;
      // r0..r2 at C0; C1 exists on the server (refs/keep/c1) so a stale old oid names a known object, unless unknownOld
      await seed.push({ commands: [...space.REFS.map(ref => ({ ref, oldOid: ZERO_OID, newOid: C0.oid })), ...(unknownOld ? [] : [{ ref: 'refs/keep/c1', oldOid: ZERO_OID, newOid: C1.oid }])], objects: unknownOld ? C0.objects : [...C0.objects, ...C1.objects], sideband: false });
      SETUP[setup](bare);
      const del = cell.commands.tag === 'deleteOnly';
      const commands = space.REFS.slice(0, n).map((ref, i) => ({ ref, oldOid: stale.includes(i) ? C1.oid : C0.oid, newOid: del ? ZERO_OID : C1.oid }));
      let captured = null;
      const fetchImpl = async (url, init) => {
        if (init?.method !== 'POST' || !url.endsWith('/git-receive-pack')) return fetch(url, init);
        const f = FAULT[fault]?.(init.body) ?? { body: init.body };
        const res = await fetch(url, { ...init, body: f.body });
        const bytes = new Uint8Array(await res.arrayBuffer());
        captured = bytes;
        if (f.drop) throw new TypeError('fetch failed (injected: connection reset)');
        return new Response(bytes, { status: res.status, headers: res.headers });
      };
      const client = new GitHttp(`${srv.url}/s${id - 1}.git`, { capabilities: { ...defaultCapabilities(), fetch: fetchImpl, tracer: new Tracer({ exporter: arrayExporter() }) } });
      const before = git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']);
      let err = null;
      try { await client.push({ commands, objects: del ? [] : C1.objects, sideband: cell.framing.tag === 'sideband', reportV2: cell.format.tag === 'v2', atomic: cell.atomic.tag === 'on' }); } catch (e) { err = e; }
      const after = git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']);
      const at = (text, ref) => text.split('\n').find(l => l.startsWith(`${ref} `)) ?? null;
      const moved = commands.map(c => c.ref).filter(ref => at(before, ref) !== at(after, ref));
      // the cell as git's text writes it: git's own ng reasons substituted into the variants' payloads, each checked to be
      // of the variant's class (git versions word a stale ref differently: "failed to update ref", "incorrect old value provided")
      const said = new Map([...Buffer.from(captured ?? []).toString('latin1').matchAll(/ng (refs\/\S+) ([^\n]*)\n/g)].map(m => [m[1], m[2]]));
      const st = space.statuses(cell);
      const reasonOf = tag => { const i = st.findIndex(v => v.tag === tag); return i < 0 ? undefined : said.get(space.REFS[i]); };
      const classOk = (tag, r) => r === undefined || ({ ngCas: CAS.test(r), ngHook: !CAS.test(r), ngAtomic: r === 'atomic push failure', ngUnpacker: r === 'unpacker error' })[tag] !== false;
      const withReason = v => { const r = reasonOf(v.tag) ?? reasons[v.tag]; if (!classOk(v.tag, r)) throw new Error(`${name}: git's reason ${JSON.stringify(r)} is not of class ${v.tag}`); return r === undefined || !('reason' in v) ? v : { ...v, reason: r }; };
      const withReasons = { ...cell, status: withReason(cell.status), spread: cell.spread.tag === 'mixed' ? { ...cell.spread, odd: withReason(cell.spread.odd) } : cell.spread };
      const rendered = space.render(withReasons).response;
      const sideband = cell.framing.tag === 'sideband';
      const bytesMatch = rendered?.bytes ? Buffer.compare(Buffer.from(normalize(captured ?? new Uint8Array(0), sideband)), Buffer.from(normalize(rendered.bytes, sideband))) === 0 : null;
      const sent = captured && sideband ? extras(captured) : { band2: 0, kaBefore: 0, kaAfter: 0 };
      results.push({ name, cell, cellId: space.cellId(cell), expected: space.expected(cell), got: outcomeOf(err, commands), moved, captured, bytesMatch, eventMatch: captured ? eventMatches(cell.event.tag, sent) : true, sent, rendered: rendered?.bytes ?? null, error: err?.message ?? null });
      rmSync(bare, { recursive: true, force: true });
    }
  } finally { await srv.close(); cleanup(); }
  return results;
}
