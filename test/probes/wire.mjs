// Runs test/probes/wire-plans.ts against a target with each sender (raw socket, curl, stock git, ply) and records what
// came back and what stock git, the judge, sees afterwards. Impure on purpose; what an answer means is in classOf and
// meets below, the same for every target and sender.
//
// A wire target: { name, url (the repository's smart-HTTP URL, reached directly: no proxy between the sender and the
// server, since a proxy would reframe the request), judgeUrl (where stock git reads the end state), auth }, where auth
// supplies a credential to each sender without handing it to a child process's argv or environment:
//   headers(kind, h)   adds the Authorization header for `kind` to a header object (raw socket, ply's fetch)
//   curlFile(kind)     a 0600 file of headers for curl's `-H @file`, or null; removed by the caller
//   gitFile(kind)      a 0600 git config file (http.extraHeader) for `-c include.path=`, or null; removed by the caller
//   url(kind)          the URL to ask (`missing-repo`: a sibling path where no repository is)
// For the reference all of these add nothing.
import net from 'node:net';
import tls from 'node:tls';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { TYPE_ID } from '../../src/objects.js';
import { buildSeed, gitEnv, observeEnd, run } from './runner.mjs';
import { GitHttp } from '../../src/client.js';

const ZERO = '0'.repeat(40);
const CHUNK = 8 * 1024;
const EXPECT_WAIT_MS = 1500;
const ANSWER_TIMEOUT_MS = 30_000;
const NOISE_BYTES = 64 * 1024;
// The reference refuses every filter but blob:none in git's own words (upload-pack), as Artifacts does.
export const WIRE_REFERENCE_CONFIG = [['uploadpackfilter.allow', 'false'], ['uploadpackfilter.blob:none.allow', 'true']];

export const WIRE_SEED = {
  objects: [
    { tag: 'commit', name: 'base', parents: [], files: [{ path: 'a.txt', content: { tag: 'text', text: 'wire probe base\n' } }], message: 'base' },
    { tag: 'commit', name: 'next', parents: ['base'], files: [{ path: 'b.bin', content: { tag: 'noise', seed: 'wire-next', bytes: NOISE_BYTES } }], message: 'next' },
  ],
  refs: [{ ref: 'refs/heads/main', at: 'base' }],
};

const must = async (p, what) => { const r = await p; if (r.status !== 0) throw new Error(`${what}: exit ${r.status}: ${r.stderr.trim().slice(0, 300)}`); return r; };

// The seed store, its ids, base's a.txt and its size, and next's objects as a pack (what a create of next sends).
export async function wireSeed(root) {
  const seed = await buildSeed(root, WIRE_SEED);
  const { dir, env } = seed;
  const base = seed.names.base, next = seed.names.next;
  const blob = (await must(run('git', ['rev-parse', `${base}:a.txt`], { cwd: dir, env }), 'rev-parse a.txt')).stdout.trim();
  const blobSize = Number((await must(run('git', ['cat-file', '-s', blob], { cwd: dir, env }), 'cat-file -s')).stdout.trim());
  const pack = await new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const p = spawn('git', ['pack-objects', '--revs', '--stdout', '-q'], { cwd: dir, env });
      const out = [];
      p.stdout.on('data', d => out.push(d));
      p.on('error', reject);
      p.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`pack-objects exit ${code}`))));
      p.stdin.end(`${next}\n^${base}\n`);
    }, reject);
  });
  const list = (await must(run('git', ['rev-list', '--objects', '--no-object-names', next, '--not', base], { cwd: dir, env }), 'rev-list next')).stdout.trim().split('\n').filter(Boolean);
  const batch = (await must(run('git', ['cat-file', '--batch'], { cwd: dir, env, input: `${list.join('\n')}\n` }), 'cat-file next')).out;
  const objects = [];
  for (let o = 0; o < batch.length;) {
    const nl = batch.indexOf(10, o);
    const [oid, type, size] = batch.subarray(o, nl).toString('latin1').split(' ');
    const n = Number(size);
    objects.push({ oid, type: TYPE_ID[type], data: new Uint8Array(batch.subarray(nl + 1, nl + 1 + n)) });
    o = nl + 1 + n + 1;
  }
  return { seed, dir, env, base, next, blob, blobSize, pack, objects, many: null };
}

// The many-refs seed (wire-plans.ts WireSeedForm): branches alternately at base and next, tags at base, as refs in the
// seed store so one glob push writes them all. Returns name -> id for every ref the target should then list.
export async function manyRefs(ws, form) {
  if (ws.many !== null && ws.many.form === `${form.heads}/${form.tags}`) return ws.many.refs;
  const refs = { 'refs/heads/main': ws.base };
  for (let i = 0; i < form.heads; i++) refs[`refs/heads/many/b${String(i).padStart(4, '0')}`] = i % 2 === 0 ? ws.base : ws.next;
  for (let i = 0; i < form.tags; i++) refs[`refs/tags/many/t${String(i).padStart(4, '0')}`] = ws.base;
  const input = Object.entries(refs).filter(([r]) => r !== 'refs/heads/main').map(([r, oid]) => `create ${r} ${oid}\n`).join('');
  await must(run('git', ['update-ref', '--stdin'], { cwd: ws.dir, env: ws.env, input }), 'many refs');
  ws.many = { form: `${form.heads}/${form.tags}`, refs };
  return refs;
}
// The refspecs that seed a target for a plan, pushed from the seed store, and the refs it then holds.
export async function seedOf(plan, ws) {
  switch (plan.seed.tag) {
    case 'base': return { specs: [`${ws.base}:refs/heads/main`], refs: { 'refs/heads/main': ws.base } };
    case 'many-refs': return { specs: [`${ws.base}:refs/heads/main`, 'refs/heads/many/*:refs/heads/many/*', 'refs/tags/many/*:refs/tags/many/*'], refs: await manyRefs(ws, plan.seed) };
  }
  throw new Error(`unknown wire seed ${plan.seed.tag}`);
}

// ---- request bodies ----
const pkt = s => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
const FLUSH = Buffer.from('0000'), DELIM = Buffer.from('0001');
export const wireRef = corner => `refs/heads/wire-${corner}`;
export const refFor = (template, corner) => template.split('<c>').join(corner);
const idOf = (ws, x) => (x === 'zero' ? ZERO : x === 'base' ? ws.base : ws.next);
// A pack of no objects (a create or update to an object the server already holds still sends a pack).
const EMPTY_PACK = (() => { const h = Buffer.from('PACK\0\0\0\x02\0\0\0\0', 'latin1'); return Buffer.concat([h, createHash('sha1').update(h).digest()]); })();
export function bodyOf(body, ws, corner) {
  switch (body.tag) {
    case 'ls-refs': return Buffer.concat([pkt('command=ls-refs\n'), pkt('agent=ply-wire-probe\n'), DELIM, pkt('ref-prefix refs/heads/\n'), FLUSH]);
    case 'ls-refs-no-flush': return Buffer.concat([pkt('command=ls-refs\n'), pkt('agent=ply-wire-probe\n'), DELIM, pkt('ref-prefix refs/heads/\n')]);
    case 'object-info': return Buffer.concat([pkt('command=object-info\n'), DELIM, pkt('size\n'), pkt(`oid ${ws.blob}\n`), FLUSH]);
    case 'fetch-filter': return Buffer.concat([pkt('command=fetch\n'), pkt('agent=ply-wire-probe\n'), DELIM, pkt(`want ${ws.base}\n`), pkt(`filter ${body.filter}=${ws.blob}\n`), pkt('no-progress\n'), pkt('done\n'), FLUSH]);
    case 'unknown-command': return Buffer.concat([pkt('command=frobnicate\n'), FLUSH]);
    case 'push-create': return Buffer.concat([pkt(`${ZERO} ${ws.next} ${wireRef(corner)}\0report-status agent=ply-wire-probe\n`), FLUSH, ws.pack]);
    case 'bytes': return Buffer.from(body.latin1, 'latin1');
    case 'push-ref': {
      const cmd = pkt(Buffer.concat([Buffer.from(`${idOf(ws, body.old)} ${idOf(ws, body.new)} `, 'latin1'), Buffer.from(refFor(body.ref, corner), 'utf8'), Buffer.from(`\0${body.caps} agent=ply-wire-probe\n`, 'latin1')]));
      return Buffer.concat([cmd, FLUSH, ...(body.new === 'zero' ? [] : [body.new === 'next' ? ws.pack : EMPTY_PACK])]);
    }
    case 'v2': return Buffer.concat([pkt(`command=${body.command}\n`), ...body.capLines.map(l => pkt(`${l}\n`)), DELIM, ...body.argLines.map(l => pkt(`${l.split('<base>').join(ws.base)}\n`)), FLUSH]);
    case 'ls-refs-all': return Buffer.concat([pkt('command=ls-refs\n'), pkt('agent=ply-wire-probe\n'), DELIM, pkt('peel\n'), pkt('symrefs\n'), FLUSH]);
  }
  throw new Error(`unknown wire body ${body.tag}`);
}
export function encodeBody(buf, encoding) {
  switch (encoding.tag) {
    case 'identity': return buf;
    case 'gzip': return gzipSync(buf);
    case 'gzip-corrupt': {
      const z = Buffer.from(gzipSync(buf));
      const mid = 10 + Math.floor((z.length - 18) / 2); // inside the deflate stream (10-byte header, 8-byte trailer)
      for (let i = 0; i < 8; i++) z[mid + i] ^= 0xff;
      return z;
    }
  }
  throw new Error(`unknown encoding ${encoding.tag}`);
}
const contentType = (req, kind) => (req.contentType.tag === 'other' ? req.contentType.value : `application/x-${req.service}-${kind}`);

// The request as method, path suffix, headers and body (before framing).
export function requestOf(plan, ws, corner) {
  const r = plan.request;
  switch (r.tag) {
    case 'advertise': return { method: 'GET', suffix: `/info/refs?service=${r.service}`, headers: r.protocol === 'v2' ? { 'git-protocol': 'version=2' } : {}, body: null, framing: { tag: 'length' } };
    case 'credential': return { method: 'GET', suffix: '/info/refs?service=git-upload-pack', headers: { 'git-protocol': 'version=2' }, body: null, framing: { tag: 'length' } };
    case 'get': return { method: 'GET', suffix: r.path, headers: {}, body: null, framing: { tag: 'length' } };
    case 'rpc': {
      const headers = { 'content-type': contentType(r, 'request'), accept: `application/x-${r.service}-result` };
      if (r.protocol === 'v2') headers['git-protocol'] = 'version=2';
      if (r.encoding.tag !== 'identity') headers['content-encoding'] = 'gzip';
      return { method: 'POST', suffix: `/${r.service}`, headers, body: encodeBody(bodyOf(r.body, ws, corner), r.encoding), framing: r.framing };
    }
  }
  throw new Error(`unknown request ${r.tag}`);
}
const credentialOf = plan => (plan.request.tag === 'credential' ? plan.request.credential : 'write');

// ---- a raw HTTP/1.1 exchange on a socket ----
function parseResponses(buf) {
  let at = 0, interim100 = false;
  for (;;) {
    const end = buf.indexOf('\r\n\r\n', at);
    if (end < 0) return { status: 0, headers: {}, body: Buffer.alloc(0), interim100, partial: true };
    const lines = buf.subarray(at, end).toString('latin1').split('\r\n');
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1] ?? 0);
    const headers = {};
    for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    at = end + 4;
    if (status >= 100 && status < 200) { if (status === 100) interim100 = true; continue; }
    let body = buf.subarray(at);
    if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
      const parts = [];
      for (let o = 0; o < body.length;) {
        const le = body.indexOf('\r\n', o);
        if (le < 0) break;
        const n = parseInt(body.subarray(o, le).toString('latin1'), 16);
        if (!(n > 0)) break;
        parts.push(body.subarray(le + 2, le + 2 + n));
        o = le + 2 + n + 2;
      }
      body = Buffer.concat(parts);
    } else if (headers['content-length'] !== undefined) body = body.subarray(0, Number(headers['content-length']));
    return { status, headers, body, interim100, partial: false };
  }
}
export function rawExchange(url, req, extraHeaders) {
  const u = new URL(url + req.suffix);
  const secure = u.protocol === 'https:';
  const port = Number(u.port || (secure ? 443 : 80));
  const head = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, 'User-Agent: ply-wire-probe/1', 'Connection: close'];
  for (const [k, v] of Object.entries({ ...req.headers, ...extraHeaders })) head.push(`${k}: ${v}`);
  const body = req.body;
  const f = req.framing;
  if (body !== null) {
    if (f.tag === 'chunked') head.push('Transfer-Encoding: chunked');
    else head.push(`Content-Length: ${body.length + (f.tag === 'length-off' ? f.by : 0)}`);
    if (f.tag === 'expect-continue') head.push('Expect: 100-continue');
  }
  const t0 = performance.now();
  return new Promise(resolve => {
    const chunks = [];
    let done = false, sawContinue = false, onContinue = null;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      const r = parseResponses(Buffer.concat(chunks));
      resolve({ ...r, error, ms: +(performance.now() - t0).toFixed(1) });
    };
    const timer = setTimeout(() => finish('timeout'), ANSWER_TIMEOUT_MS);
    const sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
    sock.on('data', d => { chunks.push(d); if (!sawContinue && Buffer.concat(chunks).toString('latin1').startsWith('HTTP/1.1 100')) { sawContinue = true; onContinue?.(); } });
    sock.on('end', () => finish(null));
    sock.on('close', () => finish(null));
    sock.on('error', e => finish(String(e.code ?? e.message)));
    sock.once(secure ? 'secureConnect' : 'connect', async () => {
      sock.write(`${head.join('\r\n')}\r\n\r\n`);
      if (body === null) return;
      if (f.tag === 'expect-continue') await new Promise(r => { onContinue = r; if (sawContinue) r(); setTimeout(r, EXPECT_WAIT_MS); });
      if (f.tag === 'chunked') {
        for (let o = 0; o < body.length; o += CHUNK) { const c = body.subarray(o, o + CHUNK); sock.write(`${c.length.toString(16)}\r\n`); sock.write(c); sock.write('\r\n'); }
        sock.write('0\r\n\r\n');
      } else if (f.tag === 'length-off' && f.by < 0) sock.write(body);
      else sock.write(body);
      if (f.tag === 'length-off' && f.by > 0) sock.end(); // half-close: the promised bytes never come
    });
  });
}

// ---- curl ----
export async function curlExchange(url, req, authFile, root) {
  const dir = mkdtempSync(join(root, 'curl-'));
  const args = ['-sS', '--http1.1', '--max-time', String(ANSWER_TIMEOUT_MS / 1000), '-o', join(dir, 'body'), '-D', join(dir, 'head'), '-w', '%{http_code}', '-A', 'ply-wire-probe/1', '-X', req.method];
  for (const [k, v] of Object.entries(req.headers)) args.push('-H', `${k}: ${v}`);
  if (req.body !== null) {
    writeFileSync(join(dir, 'req'), req.body);
    args.push('--data-binary', `@${join(dir, 'req')}`);
    if (req.framing.tag === 'chunked') args.push('-H', 'Transfer-Encoding: chunked');
    if (req.framing.tag === 'expect-continue') args.push('-H', 'Expect: 100-continue', '--expect100-timeout', String(EXPECT_WAIT_MS / 1000));
    else args.push('-H', 'Expect:');
  }
  if (authFile !== null) args.push('-H', `@${authFile}`);
  args.push(url + req.suffix);
  const t0 = performance.now();
  const r = await run('curl', args, { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, timeoutMs: ANSWER_TIMEOUT_MS + 5000 });
  const ms = +(performance.now() - t0).toFixed(1);
  const read = f => { try { return readFileSync(join(dir, f)); } catch { return Buffer.alloc(0); } };
  const head = read('head').toString('latin1');
  const blocks = head.split(/\r\n\r\n/).filter(b => b.startsWith('HTTP/'));
  const last = blocks[blocks.length - 1] ?? '';
  const headers = {};
  for (const l of last.split('\r\n').slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  const out = { status: Number(r.stdout.trim()) || 0, headers, body: read('body'), interim100: blocks.some(b => b.startsWith('HTTP/1.1 100')), error: r.status === 0 ? null : `curl exit ${r.status}: ${r.stderr.trim().slice(0, 160)}`, ms };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

// ---- what an answer is ----
function pktLinesOf(buf, limit = 400) {
  const out = [];
  for (let o = 0; o + 4 <= buf.length && out.length < limit;) {
    const h = buf.subarray(o, o + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(h)) return { lines: out, clean: false };
    const n = parseInt(h, 16);
    if (n < 4) { out.push(n === 0 ? '<flush>' : n === 1 ? '<delim>' : '<end>'); o += 4; continue; }
    if (o + n > buf.length) return { lines: out, clean: false };
    out.push(buf.subarray(o + 4, o + n).toString('latin1'));
    o += n;
  }
  return { lines: out, clean: true };
}
const firstLine = buf => buf.toString('latin1').split('\n')[0].replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
// An answer as one class: v0-adv:<main id> | v2-adv | ls-refs:<main id> | object-info:<size> | err:<text> | report:<lines>
// | pack | empty | status:<n> | text:<first line>. ERR may come on band 3 of a side-band answer or bare.
export function classOf(status, body, ws) {
  if (status >= 400) return `status:${status}`;
  if (status === 0) return 'no-answer';
  if (body.length === 0) return 'empty';
  const { lines } = pktLinesOf(body);
  const err = lines.find(l => l.startsWith('ERR ') || l.startsWith('\x03'));
  if (err !== undefined) return `err:${(err.startsWith('\u0003') ? err.slice(1) : err).replace(/^ERR /, '').trim().slice(0, 120)}`;
  if (lines[0]?.startsWith('# service=')) {
    const main = lines.find(l => / refs\/heads\/main/.test(l));
    return lines.includes('version 2\n') ? 'v2-adv' : `v0-adv:${main ? main.slice(0, 40) : 'no-main'}`;
  }
  if (lines[0] === 'version 2\n') return 'v2-adv';
  const lsMain = lines.find(l => /^[0-9a-f]{40} refs\/heads\/main/.test(l));
  if (lsMain) return `ls-refs:${lsMain.slice(0, 40)}`;
  const size = lines.find(l => l.startsWith(`${ws.blob} `));
  if (lines[0] === 'size\n' || size !== undefined) return `object-info:${size ? size.trim().split(' ')[1] : '?'}`;
  if (lines.some(l => l.startsWith('unpack '))) return `report:${lines.filter(l => !l.startsWith('<')).map(l => l.trim()).join(';').slice(0, 160)}`;
  if (lines.includes('packfile\n')) return 'pack';
  return `text:${firstLine(body)}`;
}
const refusedClass = c => /^(status:4|status:5|err:|empty$|no-answer$)/.test(c) || (c.startsWith('report:') && !c.startsWith('report:unpack ok;ok ')) || c === 'refused' || c === 'client-refused';

// A listing as one class: `refs:<count>:<digest>` over the sorted `<id> <name>` pairs (HEAD and peeled lines left out),
// from a v0 advertisement, a v2 ls-refs answer, git ls-remote's or ply's list.
export const listingOf = pairs => {
  const lines = pairs.filter(([, n]) => n !== 'HEAD' && !n.endsWith('^{}')).map(([o, n]) => `${o} ${n}`).sort();
  return `refs:${lines.length}:${createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12)}`;
};
const listingOfBody = (status, body) => {
  if (status >= 400) return `status:${status}`;
  if (status === 0) return 'no-answer';
  const { lines } = pktLinesOf(body, Infinity);
  return listingOf(lines.map(l => /^([0-9a-f]{40}) ([^\0\s]+)/.exec(l)).filter(m => m !== null).map(m => [m[1], m[2]]));
};
// A dumb-HTTP file as one class: dumb-refs:<main id> | dumb-head:<target> | dumb-packs:<n> | status:<n> | text:<first line>.
const dumbOf = (path, status, body) => {
  if (status >= 400) return `status:${status}`;
  if (status === 0) return 'no-answer';
  const t = body.toString('latin1');
  const lines = t.split('\n').filter(Boolean);
  switch (path) {
    case '/info/refs': { const m = lines.map(l => /^([0-9a-f]{40})\trefs\/heads\/main$/.exec(l)).find(x => x !== null); return m ? `dumb-refs:${m[1]}` : `text:${firstLine(body)}`; }
    case '/HEAD': return /^ref: (\S+)\n?$/.test(t) ? `dumb-head:${/^ref: (\S+)/.exec(t)[1]}` : `text:${firstLine(body)}`;
    case '/objects/info/packs': return lines.every(l => /^P pack-[0-9a-f]{40}\.pack$/.test(l)) ? `dumb-packs:${lines.length}` : `text:${firstLine(body)}`;
  }
  return `text:${firstLine(body)}`;
};
// The class of a raw or curl answer for this plan.
const answerClass = (plan, x, ws) => (plan.expect.tag === 'listing' ? listingOfBody(x.status, x.body) : plan.request.tag === 'get' ? dumbOf(plan.request.path, x.status, x.body) : fold(classOf(x.status, x.body, ws)));

// The v2 advertisement's capabilities on the target (object-info's expectation depends on it).
export async function v2Caps(url, auth) {
  const h = {};
  auth.headers('write', h);
  const r = await rawExchange(url, { method: 'GET', suffix: '/info/refs?service=git-upload-pack', headers: { 'git-protocol': 'version=2' }, body: null, framing: { tag: 'length' } }, h);
  return { caps: pktLinesOf(r.body).lines.filter(l => !l.startsWith('<') && !l.startsWith('#')).map(l => l.trim()), ray: r.headers['cf-ray'] ?? null };
}

// Whether one sender's result meets the plan's stated answer. `end` is the judge's view after the plan.
export function meets(plan, res, end, ws, caps, seeded = { 'refs/heads/main': ws.base }) {
  const ref = end.refs[wireRef(res.corner)] ?? null;
  const clean = end.fsck.length === 0 && end.refs['refs/heads/main'] === ws.base;
  const a = plan.expect;
  const asSeeded = () => JSON.stringify(Object.entries(end.refs).sort()) === JSON.stringify(Object.entries(seeded).sort()) && end.fsck.length === 0;
  const landedRef = r => res.cls === 'landed' && end.refs[refFor(r, res.corner)] === ws.next && clean;
  const refusedRef = r => refusedClass(res.cls) && !(refFor(r, res.corner) in end.refs) && clean;
  switch (a.tag) {
    case 'ref-landed': return landedRef(a.ref);
    case 'ref-refused': return refusedClass(res.cls) && asSeeded();
    case 'ref-either': return landedRef(a.ref) || refusedRef(a.ref);
    case 'dumb': return res.cls.startsWith('status:4') || res.cls === (a.path === '/info/refs' ? `dumb-refs:${ws.base}` : a.path === '/HEAD' ? 'dumb-head:refs/heads/main' : res.cls.startsWith('dumb-packs:') ? res.cls : 'dumb-packs');
    case 'listing': return res.cls === listingOf(Object.entries(seeded).map(([n, o]) => [o, n])) && asSeeded();
    case 'v0-advertisement': return res.cls === `v0-adv:${ws.base}`;
    case 'ls-refs-main': return res.cls === `ls-refs:${ws.base}` && clean;
    case 'landed': return res.cls === 'landed' && ref === ws.next && end.fsck.length === 0;
    case 'refused': return refusedClass(res.cls) && ref === null && clean;
    case 'object-info': return caps.some(c => c === 'object-info' || c.startsWith('object-info=')) ? res.cls === `object-info:${ws.blobSize}` : refusedClass(res.cls);
    case 'status': return a.statuses.some(st => res.cls === `status:${st}` || res.cls === `class:${st === 404 ? 'not_found' : 'auth'}`);
  }
  return false;
}
// A landed push's report class is folded to `landed` so senders compare; a plain refusal keeps its words.
const fold = c => (c.startsWith('report:unpack ok;ok ') && !c.includes(';ng ') ? 'landed' : c);

// ---- stock git and ply ----
async function gitCorner(plan, target, ws, root) {
  const kind = credentialOf(plan);
  const cfg = target.auth.gitFile(kind);
  const env = { ...gitEnv(root), GIT_TERMINAL_PROMPT: '0', GIT_TRACE_CURL: join(root, `trace-${Date.now()}`), GIT_TRACE_CURL_NO_DATA: '1' };
  const pre = cfg === null ? [] : ['-c', `include.path=${cfg}`];
  const url = target.auth.url(kind);
  const t0 = performance.now();
  let r, cls;
  try {
    switch (plan.git.tag) {
      case 'ls-remote-v0': {
        r = await run('git', [...pre, '-c', 'protocol.version=0', 'ls-remote', url], { cwd: root, env });
        const main = r.stdout.split('\n').find(l => l.endsWith('\trefs/heads/main'));
        cls = r.status === 0 ? `v0-adv:${main ? main.slice(0, 40) : 'no-main'}` : `git-exit:${r.status}`;
        break;
      }
      case 'push-chunked': {
        r = await run('git', [...pre, '-c', 'http.postBuffer=4096', 'push', '--porcelain', url, `${ws.next}:${wireRef('git')}`], { cwd: ws.dir, env });
        cls = r.status === 0 ? 'landed' : `refused`;
        break;
      }
      case 'fetch-filter': {
        const dir = join(root, `filter-${Date.now()}.git`);
        r = await run('git', [...pre, 'clone', '-q', '--bare', `--filter=sparse:oid=${ws.blob}`, url, dir], { cwd: root, env });
        cls = r.status === 0 ? 'landed' : 'refused';
        rmSync(dir, { recursive: true, force: true });
        break;
      }
      case 'ls-remote': {
        r = await run('git', [...pre, 'ls-remote', url], { cwd: root, env });
        const s = r.stderr;
        cls = r.status === 0 ? 'listed' : /returned error: (\d{3})/.test(s) ? `status:${/returned error: (\d{3})/.exec(s)[1]}` : /could not read Username|Authentication failed|terminal prompts disabled/.test(s) ? 'status:401' : /not found/i.test(s) ? 'status:404' : `git-exit:${r.status}`;
        break;
      }
      case 'push-ref': {
        const ref = refFor(plan.expect.ref, 'git');
        r = await run('git', [...pre, 'push', '--porcelain', url, `${ws.next}:${ref}`], { cwd: ws.dir, env });
        let tr = '';
        try { tr = readFileSync(env.GIT_TRACE_CURL, 'latin1'); } catch { tr = ''; }
        const posted = /=> Send header: POST \S*git-receive-pack/.test(tr);
        cls = r.status === 0 ? 'landed' : posted ? 'refused' : 'client-refused';
        break;
      }
      case 'ls-remote-dumb': {
        r = await run('git', [...pre, 'ls-remote', url], { cwd: root, env: { ...env, GIT_SMART_HTTP: '0' } });
        const main = r.stdout.split('\n').find(l => l.endsWith('\trefs/heads/main'));
        const s = r.stderr;
        cls = r.status === 0 ? (main ? `dumb-refs:${main.slice(0, 40)}` : 'dumb-refs:no-main') : /returned error: (\d{3})/.test(s) ? `status:${/returned error: (\d{3})/.exec(s)[1]}` : /not found/i.test(s) ? 'status:404' : `git-exit:${r.status}`;
        break;
      }
      case 'ls-remote-all': {
        r = await run('git', [...pre, '-c', `protocol.version=${plan.git.protocol === 'v0' ? 0 : 2}`, 'ls-remote', url], { cwd: root, env });
        cls = r.status === 0 ? listingOf(r.stdout.split('\n').filter(Boolean).map(l => l.split('\t'))) : `git-exit:${r.status}`;
        break;
      }
      default: throw new Error(`no git form ${plan.git.tag}`);
    }
    let trace = '';
    try { trace = readFileSync(env.GIT_TRACE_CURL, 'latin1'); } catch { trace = ''; }
    rmSync(env.GIT_TRACE_CURL, { force: true });
    const rays = [...trace.matchAll(/<= Recv header: cf-ray: (\S+)/gi)].map(m => m[1]);
    const chunked = /=> Send header: Transfer-Encoding: chunked/i.test(trace);
    return { corner: 'git', cls, status: null, interim100: null, ms: +(performance.now() - t0).toFixed(1), rays, detail: `${r.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}${plan.git.tag === 'push-chunked' ? ` [chunked=${chunked}]` : ''}`, error: null };
  } finally {
    if (cfg !== null) rmSync(dirname(cfg), { recursive: true, force: true });
  }
}
async function plyCorner(plan, target, ws, tracer) {
  const kind = credentialOf(plan);
  const rays = [];
  let posts = 0;
  const fetchImpl = async (u, init = {}) => {
    if (String(init.method ?? 'GET').toUpperCase() === 'POST' && String(u).endsWith('git-receive-pack')) posts++;
    const headers = new Headers(init.headers);
    const h = {};
    target.auth.headers(kind, h);
    for (const [k, v] of Object.entries(h)) headers.set(k, v);
    const res = await fetch(u, { ...init, headers });
    const ray = res.headers.get('cf-ray');
    if (ray !== null) rays.push(ray);
    return res;
  };
  const t0 = performance.now();
  const client = GitHttp.create(target.auth.url(kind), { tracer, fetchImpl, quirks: {} });
  if (!client.ok) return { corner: 'ply', cls: `ply:${client.error.code}`, status: null, interim100: null, ms: 0, rays, detail: String(client.error.message).slice(0, 200), error: null };
  let r;
  switch (plan.ply.tag) {
    case 'ls-refs': r = await client.value.lsRefs(); break;
    case 'fetch-filter': r = await client.value.fetchPack({ wants: [ws.base], filter: `sparse:oid=${ws.blob}` }); break;
    case 'push-ref': r = await client.value.push({ commands: [{ ref: refFor(plan.expect.ref, 'ply'), oldOid: ZERO, newOid: ws.next }], objects: ws.objects }); break;
    case 'ls-refs-all': {
      r = await client.value.lsRefs();
      const ms = +(performance.now() - t0).toFixed(1);
      if (r.ok) return { corner: 'ply', cls: listingOf([...r.value.refs.values()].map(x => [x.oid, x.name])), status: null, interim100: null, ms, rays, detail: `${r.value.refs.size} refs`, error: null };
      return { corner: 'ply', cls: `ply:${r.error.code}`, status: null, interim100: null, ms, rays, detail: String(r.error.message).slice(0, 160), error: null };
    }
    default: throw new Error(`no ply form ${plan.ply.tag}`);
  }
  const ms = +(performance.now() - t0).toFixed(1);
  if (plan.ply.tag === 'push-ref') return { corner: 'ply', cls: r.ok ? 'landed' : posts === 0 ? 'client-refused' : 'refused', status: null, interim100: null, ms, rays, detail: r.ok ? 'ok' : `${r.error.code}: ${String(r.error.message).slice(0, 160)}`, error: null };
  if (r.ok) return { corner: 'ply', cls: plan.ply.tag === 'ls-refs' ? 'listed' : 'landed', status: null, interim100: null, ms, rays, detail: 'ok', error: null };
  const st = /"status":(\d{3})/.exec(JSON.stringify(r.error))?.[1] ?? null;
  const code = r.error.code;
  const cls = plan.ply.tag === 'ls-refs' ? (code === 'auth' || code === 'not_found' ? `class:${code}` : `ply:${code}`) : 'refused';
  return { corner: 'ply', cls, status: st === null ? null : Number(st), interim100: null, ms, rays, detail: `${code}: ${String(r.error.message).slice(0, 160)}`, error: null };
}

// One plan on one target: every corner in order, then the judge. `caps`: the target's v2 capabilities.
export async function runWirePlan(plan, corners, target, ws, { root, tracer, caps }) {
  const results = [];
  for (const corner of corners) {
    const req = requestOf(plan, ws, corner);
    const kind = credentialOf(plan);
    const url = target.auth.url(kind);
    if (corner === 'raw' || corner === 'curl') {
      let x;
      if (corner === 'raw') { const h = {}; target.auth.headers(kind, h); x = await rawExchange(url, req, h); } else {
        const f = target.auth.curlFile(kind);
        try { x = await curlExchange(url, req, f, root); } finally { if (f !== null) rmSync(dirname(f), { recursive: true, force: true }); }
      }
      const ray = x.headers['cf-ray'] ?? null;
      results.push({ corner, cls: answerClass(plan, x, ws), status: x.status, interim100: x.interim100, ms: x.ms, rays: ray === null ? [] : [ray], detail: x.error ?? firstLine(x.body), error: x.error });
    } else if (corner === 'git') results.push(await gitCorner(plan, target, ws, root));
    else results.push(await plyCorner(plan, target, ws, tracer));
  }
  const end = await judgeEnd(target.judgeUrl, root, ws.env);
  const seeded = (await seedOf(plan, ws)).refs;
  const many = Object.keys(end.refs).length > 50;
  return { results: results.map(r => ({ ...r, meets: meets(plan, r, end, ws, caps, seeded) })), end: { refs: many ? { count: Object.keys(end.refs).length, main: end.refs['refs/heads/main'] ?? null } : end.refs, fsck: end.fsck, head: end.head } };
}
// The judge's view; a repository stock git cannot mirror (a ref name git refuses to write, say) is itself a problem.
async function judgeEnd(url, root, env) {
  try { return await observeEnd(url, root, env); } catch (e) {
    const ls = await run('git', ['ls-remote', url], { cwd: root, env });
    const refs = Object.fromEntries(ls.stdout.split('\n').filter(Boolean).map(l => l.split('\t')).filter(([, n]) => n !== 'HEAD' && !n.endsWith('^{}')).map(([o, n]) => [n, o]));
    return { head: null, refs, fsck: [`judge failed: ${String(e?.message ?? e).slice(0, 200)}`] };
  }
}

// Differences that matter, between two targets for the same sender, and between senders on one target.
export function wireDiffs(planId, byTarget) {
  const out = [];
  const [ref, art] = [byTarget.ref, byTarget.art];
  if (ref && art) for (const a of art.results) {
    const r = ref.results.find(x => x.corner === a.corner);
    if (r && r.meets !== a.meets) out.push({ plan: planId, pair: `art-${a.corner}~ref-${a.corner}`, field: 'meets', left: `${a.meets} (${a.cls})`, right: `${r.meets} (${r.cls})` });
    else if (r && r.cls !== a.cls) out.push({ plan: planId, pair: `art-${a.corner}~ref-${a.corner}`, field: 'class', left: a.cls, right: r.cls, minor: true });
  }
  for (const [name, t] of Object.entries(byTarget)) {
    if (!t) continue;
    const ms = new Set(t.results.map(x => x.meets));
    if (ms.size > 1) out.push({ plan: planId, pair: `${name}:senders`, field: 'meets', left: t.results.map(x => `${x.corner}=${x.meets}`).join(' '), right: '' });
  }
  return out;
}

export function referenceAuth(url) {
  return { headers: () => {}, curlFile: () => null, gitFile: () => null, url: () => url, hasRevoked: () => false };
}
export const tempRoot = () => mkdtempSync(join(tmpdir(), 'ply-wire-'));
