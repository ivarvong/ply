// Round trips and wall time of the read operations against real remotes, old tree against new (issue #218).
//   node test/bench-rt.mjs [--runs 7] [--tree <dir> ...] [--bearer-file <json with .plaintext>] --remote '<url> <file d1> <file d2> <file d3> <dir d1>' ...
// A tree is any ply checkout (an older commit's `git archive` of src/ and test/ts-resolve.mjs too): its src/ is imported
// through its own module graph (module state such as the quirks memo is per tree). Each tree gets one quirks record per
// remote, shared by every run after one warm-up pass, which is how a long-lived caller (ply-web: one record per origin
// per isolate) runs: the steady state, not first contact. Runs are interleaved tree by tree and op by op, so a change in
// the network hits every tree alike.
//   requests   every HTTP request the op made (GET info/refs, POST git-upload-pack)
//   serial     the requests on the critical path: a request that starts after every earlier one has ended starts a new
//              step; one that starts while another is in flight joins the current step
//   ms         wall time of the op, a readFile's stream drained
// `--bearer-file` sends `Authorization: Bearer <plaintext>` to an Artifacts host (*.artifacts.cloudflare.net) only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (e) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.\.?\//.test(specifier) || !specifier.endsWith('.js')) throw e;
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const opts = k => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const runs = Number(opt('runs', '7'));
const trees = opts('tree').length ? opts('tree') : ['.'];
const bearerFile = opt('bearer-file', null);
const bearer = bearerFile === null ? null : JSON.parse(readFileSync(bearerFile, 'utf8')).plaintext;
const remotes = opts('remote').map(s => { const [url, f1, f2, f3, d1] = s.split(' '); return { url, f1, f2, f3, d1 }; });
if (remotes.length === 0) { console.error('give at least one --remote'); process.exit(2); }

const load = async dir => {
  const src = pathToFileURL(resolve(dir, 'src')).href;
  const [read, log] = await Promise.all([import(`${src}/read.ts`), import(`${src}/log.ts`)]);
  return { dir, ...read, readLog: log.readLog };
};
const loaded = await Promise.all(trees.map(load));

// A fetch that records each request's start and end (the end is when its body has been read to the end or cancelled).
function counting() {
  const events = [];
  const fetchImpl = async (input, init) => {
    const ev = { start: performance.now(), end: Number.POSITIVE_INFINITY };
    events.push(ev);
    const res = await fetch(input, init);
    if (!res.body) { ev.end = performance.now(); return res; }
    const reader = res.body.getReader();
    const body = new ReadableStream({
      async pull(c) { const r = await reader.read(); if (r.done) { ev.end = performance.now(); c.close(); } else c.enqueue(r.value); },
      cancel(reason) { ev.end = performance.now(); return reader.cancel(reason); },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  const serial = () => {
    let steps = 0, until = -1;
    for (const e of [...events].sort((a, b) => a.start - b.start)) {
      if (e.start >= until) steps++;
      until = Math.max(until, e.end);
    }
    return steps;
  };
  return { fetchImpl, events, serial };
}
const drain = async stream => { let n = 0; for await (const c of stream) n += c.length; return n; };
const ops = r => [
  ['readCommit', (ply, o) => ply.readCommit(r.url, { ref: null }, o)],
  ['readLog 10', (ply, o) => ply.readLog(r.url, { ref: null, limit: 10 }, o)],
  ['listTree /', (ply, o) => ply.listTree(r.url, { ref: null, path: '' }, o)],
  [`listTree ${r.d1}`, (ply, o) => ply.listTree(r.url, { ref: null, path: r.d1 }, o)],
  [`readFile ${r.f1}`, (ply, o) => ply.readFile(r.url, { ref: null, path: r.f1 }, o)],
  [`readFile ${r.f2}`, (ply, o) => ply.readFile(r.url, { ref: null, path: r.f2 }, o)],
  [`readFile ${r.f3}`, (ply, o) => ply.readFile(r.url, { ref: null, path: r.f3 }, o)],
];
const auth = url => (bearer !== null && new URL(url).host.endsWith('.artifacts.cloudflare.net') ? { auth: { bearer } } : {});

async function once(ply, quirks, r, fn) {
  const c = counting();
  const t0 = performance.now();
  const got = await fn(ply, { quirks, fetchImpl: c.fetchImpl, ...auth(r.url) });
  if (!got.ok) throw new Error(`${got.error.code}: ${got.error.message}`);
  if (got.value.stream) await drain(got.value.stream);
  return { ms: performance.now() - t0, requests: c.events.length, serial: c.serial() };
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = a => `${Math.round(q(a, 0.5))} [${Math.round(q(a, 0))}–${Math.round(q(a, 1))}]`;
const counts = a => { const lo = Math.min(...a), hi = Math.max(...a); return lo === hi ? `${lo}` : `${lo}–${hi}`; };

for (const r of remotes) {
  const quirks = loaded.map(() => ({}));
  const table = new Map();
  for (const [name, fn] of ops(r)) {
    loaded.forEach(ply => table.set(`${name}\0${ply.dir}`, { ms: [], requests: [], serial: [] }));
    // warm-up: the quirks record learns what this server takes (first contact is not what is measured)
    for (const [i, ply] of loaded.entries()) await once(ply, quirks[i], r, fn);
  }
  for (let run = 0; run < runs; run++) {
    for (const [name, fn] of ops(r)) {
      for (const [i, ply] of loaded.entries()) {
        const m = await once(ply, quirks[i], r, fn);
        const row = table.get(`${name}\0${ply.dir}`);
        row.ms.push(m.ms); row.requests.push(m.requests); row.serial.push(m.serial);
      }
    }
  }
  console.log(`\n${new URL(r.url).host}${new URL(r.url).pathname}  (${runs} runs, steady state; median [min–max] ms)`);
  console.log(`  ${'op'.padEnd(44)} ${loaded.map(p => `${p.dir.slice(-14).padStart(14)}: req serial ms`.padEnd(46)).join(' ')}`);
  for (const [name] of ops(r)) {
    const cells = loaded.map(ply => { const row = table.get(`${name}\0${ply.dir}`); return `${counts(row.requests).padStart(20)} ${counts(row.serial).padStart(4)} ${fmt(row.ms).padEnd(20)}`; });
    console.log(`  ${name.padEnd(44)} ${cells.join(' ')}`);
  }
}
