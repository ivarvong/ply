// Production smoke for the ply Worker. Every step is recorded (request, status, latency, evidence, request id) to a JSON
// file; nothing secret is printed or written (tokens are read from files and only ever sent as headers).
//
//   node worker/smoke.mjs <base-url> read  [--out file.json]
//   node worker/smoke.mjs <base-url> write --repo <create.json> --work <seeded clone dir> [--out file.json]
//
// PLY token: ~/.config/ply/worker-token. Artifacts read token: $PLY_SMOKE_READ_JSON (default: the session scratchpad's
// repo-create.json), field `token`. Expected README bytes: `git show a0f7f4c:README.md` in this repo.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, phase] = process.argv.slice(2);
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
if (!base || !['read', 'write', 'gate'].includes(phase)) { console.error('usage: smoke.mjs <base> read|write|gate [...]'); process.exit(2); }
const PLY = readFileSync(join(homedir(), '.config/ply/worker-token'), 'utf8').trim();
const ROOT = new URL('..', import.meta.url).pathname;
const steps = [];
const short = s => (s.length > 160 ? s.slice(0, 160) + '…' : s);
const secrets = [PLY];
const clean = s => secrets.reduce((t, x) => (x ? t.split(x).join('[redacted]') : t), String(s));

async function call(name, method, path, { body, headers = {}, ply = true, expect, check } = {}) {
  const t0 = performance.now();
  const res = await fetch(base + path, { method, headers: { ...(ply ? { authorization: `Bearer ${PLY}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Math.round(performance.now() - t0);
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* bytes */ }
  let pass = [].concat(expect).includes(res.status), evidence = `HTTP ${res.status}`;
  if (pass && check) { try { const r = await check({ res, buf, json }); if (r && typeof r === 'object') evidence += `; ${r.info}`; else if (r !== true && r !== undefined) { pass = false; if (typeof r === 'string') evidence += `; ${r}`; } } catch (e) { pass = false; evidence += `; check threw: ${e.message}`; } }
  if (!pass && json) evidence += `; body ${short(JSON.stringify(json))}`;
  if (json?.code && json.code !== 'unauthorized') evidence += `; code=${json.code}`;
  const step = { name, method, path: path.replace(/remote=[^&]+/, m => short(decodeURIComponent(m))), status: res.status, expect, pass, ms, requestId: res.headers.get('x-ply-request-id'), serverTiming: res.headers.get('server-timing'), plyTrace: res.headers.get('x-ply-trace'), evidence: clean(evidence) };
  steps.push(step);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${String(ms).padStart(5)} ms  ${res.status}  ${name}  ${clean(evidence).slice(0, 200)}`);
  return { res, buf, json, step };
}
const q = o => '?' + new URLSearchParams(o).toString();
// git's own view of a commit, in /v1/commit's shape (idents from `git log --date=raw`, message from `git cat-file`)
const gitCommitView = (dir, oid) => {
  const [o, tree, parents, an, ae, ad, cn, ce, cd] = execFileSync('git', ['-C', dir, 'log', '-1', '--date=raw', '--format=%H%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd', oid]).toString().replace(/\n$/, '').split('\x1f');
  const raw = execFileSync('git', ['-C', dir, 'cat-file', 'commit', oid]).toString(); const cut = raw.indexOf('\n\n');
  const id = (name, email, d) => { const [epoch, tz] = d.split(' '); return { name, email, time: new Date(Number(epoch) * 1000).toISOString().replace('.000Z', 'Z'), epoch: Number(epoch), tz }; };
  return { oid: o, tree, parents: parents ? parents.split(' ') : [], author: id(an, ae, ad), committer: id(cn, ce, cd), message: raw.slice(cut + 2), signed: /^gpgsig(-sha256)? /m.test(raw.slice(0, cut)) };
};
const sameCommit = (json, want) => { const { ref, trace, ...got } = json; const bad = Object.keys(want).filter(k => JSON.stringify(got[k]) !== JSON.stringify(want[k])); return bad.length ? `fields differ from git: ${bad.join(',')}` : { info: `${want.oid} parents=${want.parents.length} signed=${want.signed} == git (${Object.keys(want).length} fields)` }; };
const leakCheck = (text, toks) => toks.filter(Boolean).every(t => !text.includes(t) && !text.includes(Buffer.from(`x-access-token:${t}`).toString('base64')));

if (phase === 'gate' || phase === 'read') {
  await call('GET / usage (public)', 'GET', '/', { ply: false, expect: 200, check: ({ buf }) => /Bearer <PLY_TOKEN>/.test(buf.toString()) || 'usage text missing' });
  await call('missing PLY bearer → 401', 'GET', '/v1/refs' + q({ remote: 'https://github.com/git/git.git' }), { ply: false, expect: 401 });
  await call('wrong PLY bearer → 401', 'GET', '/v1/refs' + q({ remote: 'https://github.com/git/git.git' }), { ply: false, headers: { authorization: 'Bearer nope' }, expect: 401 });
  for (const r of ['http://github.com/git/git.git', 'https://127.0.0.1/x.git', 'https://169.254.169.254/x.git', 'https://localhost/x.git', 'https://u:p@github.com/git/git.git', 'https://github.com:8443/git/git.git'])
    await call(`allowlist refuses ${r}`, 'GET', '/v1/refs' + q({ remote: r, trace: '1' }), { expect: 400, check: ({ json }) => (json.code === 'bad_request' && json.trace.length === 0) || 'not refused before I/O' });
}

if (phase === 'read') {
  const rj = JSON.parse(readFileSync(process.env.PLY_SMOKE_READ_JSON ?? (() => { throw new Error('set PLY_SMOKE_READ_JSON to the repo-create JSON (remote + token)'); })(), 'utf8'));
  secrets.push(rj.token);
  const art = rj.remote;
  const want = execFileSync('git', ['-C', ROOT, 'show', 'a0f7f4c:README.md']);
  const artH = form => (form === 'bearer' ? { 'git-authorization': `Bearer ${rj.token}` } : form === 'basic' ? { 'git-authorization': `Basic ${Buffer.from(`x-access-token:${rj.token}`).toString('base64')}` } : { 'git-token': rj.token });
  await call('Artifacts default/ply refs', 'GET', '/v1/refs' + q({ remote: art }), { headers: artH('token'), expect: 200, check: ({ json, buf }) => (json.head === 'refs/heads/main' && /^[0-9a-f]{40}$/.test(json.refs['refs/heads/main']) && leakCheck(buf.toString(), [rj.token])) || `head=${json.head}` });
  for (const form of ['bearer', 'basic', 'token']) {
    await call(`Artifacts default/ply read README.md (${form}) == git show a0f7f4c:README.md`, 'GET', '/v1/read' + q({ remote: art, path: 'README.md', trace: '1' }), { headers: artH(form), expect: 200, check: ({ res, buf }) =>
      (buf.equals(want) && res.headers.get('content-length') === String(want.length) && res.headers.get('x-ply-blob') === execFileSync('git', ['-C', ROOT, 'rev-parse', 'a0f7f4c:README.md']).toString().trim()) || `bytes ${buf.length} vs ${want.length}, equal=${buf.equals(want)}, commit ${res.headers.get('x-ply-commit')}` });
  }
  await call('Artifacts default/ply tree /', 'GET', '/v1/tree' + q({ remote: art, trace: '1' }), { headers: artH('token'), expect: 200, check: ({ json, buf }) => {
    const ls = execFileSync('git', ['-C', ROOT, 'ls-tree', 'a0f7f4c']).toString().trim().split('\n').map(l => l.split('\t')[1]);
    const names = json.entries.map(e => e.name);
    const wide = json.trace.filter(s => s.attrs['git.fetch.filter.fallback']).map(s => s.attrs['git.fetch.wide.extra_bytes']);
    return (JSON.stringify(names) === JSON.stringify(ls) && leakCheck(buf.toString(), [rj.token])) || `names ${names.join(',')} vs ${ls.join(',')}; wide extra_bytes ${wide}`;
  } });
  await call('Artifacts default/ply commit (HEAD) == git log/cat-file in this repo', 'GET', '/v1/commit' + q({ remote: art, trace: '1' }), { headers: artH('token'), expect: 200, check: ({ json, buf }) => {
    if (!leakCheck(buf.toString(), [rj.token])) return 'token in response';
    try { return sameCommit(json, gitCommitView(ROOT, json.oid)); } catch { return `commit ${json.oid} not in the local repo to compare`; }
  } });
  await call('Artifacts default/ply commit ref=no-such-branch → 404', 'GET', '/v1/commit' + q({ remote: art, ref: 'no-such-branch' }), { headers: artH('token'), expect: 404, check: ({ json }) => json.code === 'not_found' || json.code });
  await call('Artifacts default/ply read src/ (dir) → 404', 'GET', '/v1/read' + q({ remote: art, path: 'src' }), { headers: artH('token'), expect: 404 });
  await call('Artifacts default/ply wrong credential → 401/403', 'GET', '/v1/refs' + q({ remote: art }), { headers: { 'git-token': 'art_v1_' + 'x'.repeat(40) }, expect: [401, 403], check: ({ json }) => ({ info: `upstreamStatus=${json.upstreamStatus}` }) });
  await call('Artifacts default/ply no credential → 401', 'GET', '/v1/refs' + q({ remote: art }), { expect: 401 });
  await call('Artifacts discover', 'GET', '/v1/discover' + q({ remote: art }), { headers: artH('token'), expect: 200, check: ({ json }) => ({ info: `agent=${json.agent} fetch=${json.fetch.join(' ')}` }) });
  // GitHub, public, no credential
  const gh = 'https://github.com/git/git.git';
  const refs = await call('GitHub git/git refs prefix=refs/heads/', 'GET', '/v1/refs' + q({ remote: gh, prefix: 'refs/heads/' }), { expect: 200, check: ({ json }) => (/^[0-9a-f]{40}$/.test(json.refs['refs/heads/master'] ?? '') && json.head === 'refs/heads/master') || `head=${json.head}` });
  await call('GitHub git/git tree /', 'GET', '/v1/tree' + q({ remote: gh, trace: '1' }), { expect: 200, check: ({ json }) => (json.entries.some(e => e.name === 'README.md' && e.type === 'blob') && json.entries.some(e => e.name === 'Documentation' && e.mode === '040000')) || 'entries missing' });
  const rd = await call('GitHub git/git read README.md', 'GET', '/v1/read' + q({ remote: gh, path: 'README.md', trace: '1' }), { expect: 200 });
  const commit = rd.res.headers.get('x-ply-commit');
  const raw = Buffer.from(await (await fetch(`https://raw.githubusercontent.com/git/git/${commit}/README.md`)).arrayBuffer());
  steps.push({ name: 'GitHub README.md == raw.githubusercontent.com at x-ply-commit', pass: raw.equals(rd.buf), evidence: `commit ${commit}; ${rd.buf.length} B vs raw ${raw.length} B; master=${refs.json?.refs?.['refs/heads/master']}` });
  console.log(`${raw.equals(rd.buf) ? 'PASS' : 'FAIL'}  GitHub README byte-equal to raw at ${commit}`);
  // a public GitHub repo's HEAD commit vs stock git (a blob:none, no-checkout clone of the same remote)
  const py = 'https://github.com/elixir-ai-tools/pyex.git';
  const pc = await call('GitHub pyex commit (HEAD)', 'GET', '/v1/commit' + q({ remote: py }), { expect: 200 });
  if (pc.json?.oid) {
    const dir = mkdtempSync(join(tmpdir(), 'ply-smoke-pyex-'));
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', py, dir]);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
    const r = head === pc.json.oid ? sameCommit(pc.json, gitCommitView(dir, head)) : `HEAD moved? worker ${pc.json.oid} vs clone ${head}`;
    const pass = typeof r === 'object';
    steps.push({ name: 'GitHub pyex commit == git clone HEAD, field by field', pass, evidence: pass ? r.info : r });
    console.log(`${pass ? 'PASS' : 'FAIL'}  GitHub pyex commit vs git: ${pass ? r.info : r}`);
  }
  await call('GitHub git/git discover', 'GET', '/v1/discover' + q({ remote: gh }), { expect: 200, check: ({ json }) => ({ info: `agent=${json.agent}` }) });
  await call('GitHub nonexistent repo → 401/404', 'GET', '/v1/refs' + q({ remote: 'https://github.com/ivarvong/this-repo-does-not-exist-ply.git' }), { expect: [401, 403, 404], check: ({ json }) => ({ info: `code=${json.code} upstream=${json.upstreamStatus}` }) });
  // no author: with writes off → 501; with writes on → 400 before anything is pushed (this must never edit default/ply)
  await call('write gate (POST /v1/edit without author: 501 off, 400 on)', 'POST', '/v1/edit', { body: { remote: art, path: 'README.md', find: 'x', replace: 'y', message: 'm' }, headers: artH('token'), expect: arg('write-status') ? Number(arg('write-status')) : [400, 501], check: ({ json }) => ({ info: `code=${json.code}` }) });
}

if (phase === 'write') {
  const repo = JSON.parse(readFileSync(arg('repo'), 'utf8')); secrets.push(repo.token);
  const remote = repo.remote, H = { 'git-token': repo.token }, A = { name: 'ply smoke', email: 'smoke@ply.invalid' };
  const work = arg('work');
  const W = (name, method, path, body, expect, check) => call(name, method, path, { body: { remote, ...body }, headers: H, expect, check });
  const gitEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repo.token}` }; // token never in argv
  const lsRemote = () => Object.fromEntries(execFileSync('git', ['-C', work, 'ls-remote', remote], { env: gitEnv }).toString().trim().split('\n').map(l => l.split('\t').reverse()));
  const head0 = (await call('refs', 'GET', '/v1/refs' + q({ remote }), { headers: H, expect: 200 })).json.refs['refs/heads/main'];
  const e1 = await W('edit main:notes/a.txt MARK→EDITED', 'POST', '/v1/edit?trace=1', { path: 'notes/a.txt', find: 'MARK', replace: 'EDITED', author: A, message: 'smoke: edit' }, 200, ({ json }) => ({ info: `newCommit=${json.newCommit} pushBytes=${json.pushBytes} wide=${json.trace.filter(s => s.attrs['git.fetch.filter.fallback']).length}` }));
  const c1 = e1.json.newCommit;
  await W('edit with stale head → 409 cas_conflict', 'POST', '/v1/edit', { path: 'notes/a.txt', find: 'EDITED', replace: 'NOPE', author: A, message: 'smoke: stale', head: head0 }, 409, ({ json }) => (json.code === 'cas_conflict' && json.retry === 'fresh') || json.code);
  await W('edit with current head → 200', 'POST', '/v1/edit', { path: 'notes/a.txt', find: 'EDITED', replace: 'EDITED2', author: A, message: 'smoke: edit 2', head: c1 }, 200, ({ json }) => ({ info: `hint=${json.hint}` }));
  await W('edit zero matches → 422 match_count', 'POST', '/v1/edit', { path: 'notes/a.txt', find: 'NOT-THERE', replace: 'x', author: A, message: 'm' }, 422);
  await W('edit creating branch feat-edit from main', 'POST', '/v1/edit', { ref: 'feat-edit', base: 'main', path: 'merge/x.txt', find: 'x2', replace: 'x2 feat', author: A, message: 'smoke: feat' }, 200);
  await W('branch create tmp from main', 'POST', '/v1/branch', { ref: 'tmp', from: 'main' }, 201, ({ json }) => ({ info: `oid=${json.oid} pushBytes=${json.pushBytes}` }));
  await W('branch create tmp again → 409', 'POST', '/v1/branch', { ref: 'tmp', from: 'main' }, 409, ({ json }) => json.code === 'cas_conflict' || json.code);
  await W('branch delete tmp stale oid → 409', 'DELETE', '/v1/branch', { ref: 'tmp', oid: head0 }, 409);
  await W('branch delete tmp (CAS = current)', 'DELETE', '/v1/branch', { ref: 'tmp' }, 200, ({ json }) => ({ info: `deleted=${json.deleted}` }));
  await W('edit main merge/y.txt (diverge)', 'POST', '/v1/edit', { path: 'merge/y.txt', find: 'y1', replace: 'y1 main', author: A, message: 'smoke: main y' }, 200);
  const mg = await W('merge feat-edit → main (merge commit)', 'POST', '/v1/merge?trace=1', { from: 'feat-edit', author: A, message: 'smoke: merge' }, 200, ({ json }) => ({ info: `outcome=${json.outcome} oid=${json.oid} tree=${json.tree}` }));
  await W('edit creating feat-rebase from main~ (via base=refs/tags/smoke-base)', 'POST', '/v1/edit', { ref: 'feat-rebase', base: 'refs/tags/smoke-base', path: 'rebase/r.txt', find: 'r1', replace: 'r1 rebased', author: A, message: 'smoke: to rebase' }, 200);
  await W('rebase feat-rebase onto main', 'POST', '/v1/rebase?trace=1', { ref: 'feat-rebase', onto: 'main', committer: A }, 200, ({ json }) => ({ info: `outcome=${json.outcome} commits=${json.commits} oid=${json.oid}` }));
  const rb = lsRemote()['refs/heads/feat-rebase'];
  const cp = await W('cherry-pick feat-rebase tip onto main', 'POST', '/v1/cherry-pick', { commit: rb, committer: A }, 200, ({ json }) => ({ info: `oid=${json.oid} tree=${json.tree}` }));
  await W('revert the cherry-pick', 'POST', '/v1/revert', { commit: cp.json?.oid, committer: A }, 200, ({ json }) => ({ info: `oid=${json.oid} tree=${json.tree}` }));
  await W('merge conflict → 409', 'POST', '/v1/merge', { ref: 'conflict-a', from: 'conflict-b', author: A }, 409, ({ json }) => ({ info: `conflicts=${JSON.stringify(json.conflicts)}` }));
  await call('wrong git credential → 401/403', 'GET', '/v1/refs' + q({ remote }), { headers: { 'git-token': 'art_v1_' + 'y'.repeat(40) }, expect: [401, 403], check: ({ json }) => ({ info: `upstream=${json.upstreamStatus}` }) });
  await call('missing PLY bearer on a write → 401', 'POST', '/v1/edit', { ply: false, body: { remote }, expect: 401 });
  writeFileSync(join(arg('outdir') ?? tmpdir(), 'smoke-write-refs.json'), JSON.stringify({ head0, c1, merge: mg.json, refs: lsRemote() }, null, 2));
}

const out = arg('out');
if (out) writeFileSync(out, JSON.stringify({ base, phase, at: new Date().toISOString(), steps }, null, 2));
const failed = steps.filter(s => !s.pass);
console.log(`\n${steps.length - failed.length}/${steps.length} passed`);
process.exit(failed.length ? 1 : 0);
