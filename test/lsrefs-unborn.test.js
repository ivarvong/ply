// lsRefs({ unborn: true }) against real git (issue #103). Three oracles, all git's own:
//   1. the argument: `git ls-remote` (protocol v2, GIT_TRACE_PACKET) sends `unborn` to a server exactly when that
//      server's advertisement lists `ls-refs=unborn` (connect.c: server_supports_feature). ply must send it under the
//      same condition, and never when not asked.
//   2. the answer: the ls-refs response git's server (http-backend → upload-pack, ls-refs.c) gave ply's exact request,
//      read with connect.c process_ref_v2's unborn rule (an `unborn HEAD` line, its first symref-target, the last wins).
//   3. the meaning: `git clone` of an empty repository creates the unborn HEAD's branch when git learned one, and
//      init.defaultBranch otherwise (clone.c). ply's `unborn.target ?? default` must equal the clone's HEAD.
// Cells: repository state × lsrefs.unborn server config × ref prefixes × asked or not.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { git, gitAsync, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { createTransport as rawTransport } from '../src/http.js';
import { Tracer } from '../src/otel.js';
import { lsRefs, discover, GitHttp } from '../src/client.js';
import { lsRefs as lsRefsWire, parseLsRefLine, parseUnbornLine } from '../src/lsrefs.js';
import { pkts } from '../src/pktline.js';
import { defaultCapabilities } from '../src/capabilities.js';

const td = new TextDecoder();
const createTransport = (u, opts = {}) => {
  const given = 'capabilities' in opts ? opts.capabilities : null;
  const base = given === null ? defaultCapabilities() : { ...defaultCapabilities(), ...given };
  const tracer = given !== null && given.tracer ? given.tracer : new Tracer();
  return rawTransport(u, { ...opts, capabilities: { ...base, tracer } });
};
const DEFAULT_BRANCH = 'zz-default';
let root, cleanup, srv, oid;
const repos = {};

// Repository states. Each is served three times, once per lsrefs.unborn value (git's default is `advertise`).
const STATES = {
  empty: bare => bare, // git init --bare -b main: HEAD -> refs/heads/main, no refs
  'empty-trunk': bare => { git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']); return bare; },
  born: (bare, work) => { commitFiles(work, bare, { a: 'a\n' }); return bare; },
  'head-missing': (bare, work) => { commitFiles(work, bare, { a: 'a\n' }); git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/missing']); return bare; },
  detached: (bare, work) => { const c = commitFiles(work, bare, { a: 'a\n' }); git(bare, ['update-ref', '--no-deref', 'HEAD', c]); return bare; },
};
const CONFIGS = ['advertise', 'allow', 'ignore'];
const PREFIXES = [[], ['HEAD'], ['refs/heads/']];

before(async () => {
  ({ root, cleanup } = tmpRoot());
  for (const [state, make] of Object.entries(STATES)) {
    for (const cfg of CONFIGS) {
      const name = `${state}-${cfg}`;
      const work = join(root, `w-${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
      const bare = make(makeBareRepo(root, name), work);
      git(bare, ['config', 'lsrefs.unborn', cfg]);
      repos[name] = { state, cfg, bare, headOid: state === 'detached' ? git(bare, ['rev-parse', 'HEAD']).trim() : null };
    }
  }
  oid = git(repos['born-advertise'].bare, ['rev-parse', 'refs/heads/main']).trim();
  srv = await startGitServer(root);
});
after(async () => { await srv.close(); cleanup(); });

const url = name => `${srv.url}/${name}.git`;

// A transport that records every ls-refs request body and the response git's server gave it.
function recorded(name) {
  const seen = [];
  const fetchImpl = async (u, init) => {
    const res = await fetch(u, init);
    if (init?.method !== 'POST') return res;
    const body = new Uint8Array(await res.arrayBuffer());
    seen.push({ request: td.decode(init.body), response: body });
    return new Response(body, { status: res.status, headers: res.headers });
  };
  return { t: createTransport(url(name), { capabilities: { ...defaultCapabilities(), fetch: fetchImpl } }), seen };
}

// pkt-lines of a response body, as text (data packets only; the flush ends the listing)
function pktLines(buf) {
  const out = [];
  for (let i = 0; i < buf.length;) {
    const n = parseInt(td.decode(buf.subarray(i, i + 4)), 16);
    if (n < 4) { i += 4; continue; }
    out.push(td.decode(buf.subarray(i + 4, i + n)).replace(/\n$/, ''));
    i += n;
  }
  return out;
}
// connect.c process_ref_v2, the unborn branch, written out independently of src/lsrefs.ts
function gitUnborn(lines) {
  let target = null;
  for (const l of lines) {
    const f = l.split(' ');
    if (f[0] !== 'unborn' || f[1] !== 'HEAD') continue;
    const a = f.slice(2).find(x => x.startsWith('symref-target:'));
    if (a !== undefined) target = a.slice('symref-target:'.length);
  }
  return target === null || target === '' ? null : { name: 'HEAD', target };
}

// Oracle 1: does git's own client send `unborn` to this server?
const gitSendsUnborn = {};
async function gitSends(name) {
  if (!(name in gitSendsUnborn)) {
    const r = await gitAsync(root, ['-c', 'protocol.version=2', 'ls-remote', url(name)], { GIT_TRACE_PACKET: '1' });
    assert.equal(r.status, 0, r.stderr);
    gitSendsUnborn[name] = / (?:ls-remote|git)> unborn$/m.test(r.stderr); // the client side of the trace (git 2.50 names it ls-remote, older git "git")
  }
  return gitSendsUnborn[name];
}

test('lsRefs unborn: the argument, the answer and the ref listing agree with git, across every cell', async () => {
  let cells = 0;
  for (const [name, { state, cfg, headOid }] of Object.entries(repos)) {
    const sends = await gitSends(name);
    assert.equal(sends, cfg === 'advertise', `${name}: git sends unborn only to an advertising server`);
    // async: the server runs in this process, so a synchronous git would deadlock against it
    const lsRemote = (await gitAsync(root, ['-c', 'protocol.version=2', 'ls-remote', '--symref', url(name)])).stdout;
    for (const prefixes of PREFIXES) {
      for (const ask of [true, false]) {
        const cell = `${name} prefixes=${JSON.stringify(prefixes)} unborn=${ask}`;
        const { t, seen } = recorded(name);
        const r = await lsRefs(t, prefixes, ask ? { unborn: true } : {});
        const lsReq = seen.filter(s => s.request.includes('command=ls-refs'));
        assert.equal(lsReq.length, 1, cell);
        const sent = pktLines(new TextEncoder().encode(lsReq[0].request)).includes('unborn');
        assert.equal(sent, ask && sends, `${cell}: ply sends unborn exactly when asked and git would`);
        // the answer: git's server response to ply's request, read as git reads it
        const lines = pktLines(lsReq[0].response);
        assert.deepEqual(r.unborn, gitUnborn(lines), `${cell}: unborn`);
        // and the expected value, spelled out
        const headListed = prefixes.length === 0 || prefixes.includes('HEAD');
        const expectTarget = { empty: 'refs/heads/main', 'empty-trunk': 'refs/heads/trunk', 'head-missing': 'refs/heads/missing' }[state];
        assert.deepEqual(r.unborn, ask && sends && headListed && expectTarget ? { name: 'HEAD', target: expectTarget } : null, `${cell}: expected unborn`);
        // refs and head are what they were without the argument: git's ls-remote for the unfiltered listing
        if (prefixes.length === 0) {
          const want = lsRemote.split('\n').filter(l => /^[0-9a-f]{40}\t/.test(l)).map(l => l.split('\t').reverse().join(' ')).sort();
          assert.deepEqual([...r.refs.values()].map(x => `${x.name} ${x.oid}`).sort(), want, `${cell}: refs`);
          const sym = /^ref: (\S+)\tHEAD$/m.exec(lsRemote);
          assert.equal(r.head, state === 'born' ? sym?.[1] : null, `${cell}: head`);
        }
        if (state === 'detached' && headListed) assert.equal(r.refs.get('HEAD')?.oid, headOid, `${cell}: detached HEAD is a ref`);
        if (state === 'detached' || state === 'born') assert.equal(r.unborn, null, cell);
        cells++;
      }
    }
  }
  assert.equal(cells, Object.keys(STATES).length * CONFIGS.length * PREFIXES.length * 2);
  console.log(`  lsRefs unborn: ${cells} cells`);
});

test('lsRefs unborn: an empty repository clones to the branch ply reports (git clone is the oracle)', async () => {
  let cells = 0;
  for (const [name, { state }] of Object.entries(repos)) {
    if (!state.startsWith('empty')) continue;
    const dest = join(root, `clone-${name}`);
    const c = await gitAsync(root, ['-c', 'protocol.version=2', '-c', `init.defaultBranch=${DEFAULT_BRANCH}`, 'clone', '-q', url(name), dest]);
    assert.equal(c.status, 0, c.stderr);
    const cloneHead = git(dest, ['symbolic-ref', 'HEAD']).trim();
    const r = await lsRefs(createTransport(url(name)), ['HEAD'], { unborn: true });
    assert.equal(r.unborn?.target ?? `refs/heads/${DEFAULT_BRANCH}`, cloneHead, name);
    assert.equal(r.head, null, name);
    assert.equal(r.refs.size, 0, name);
    cells++;
  }
  assert.equal(cells, 2 * CONFIGS.length);
});

test('lsRefs unborn: a discover() result in hand answers the capability, with no advertisement request', async () => {
  for (const cfg of CONFIGS) {
    const name = `empty-${cfg}`;
    const info = await discover(createTransport(url(name)));
    assert.equal(info.lsRefsUnborn, cfg === 'advertise');
    const { t, seen } = recorded(name);
    const gets = [];
    const t2 = createTransport(url(name), { capabilities: { ...defaultCapabilities(), fetch: async (u, init) => {
      const method = init != null && typeof init.method === 'string' ? init.method : 'GET';
      if (method === 'GET') gets.push(u);
      return fetch(u, init);
    } } });
    const r = await lsRefs(t2, [], { unborn: true, info });
    assert.deepEqual(gets, [], `${cfg}: no advertisement fetched`);
    assert.deepEqual(r.unborn, cfg === 'advertise' ? { name: 'HEAD', target: 'refs/heads/main' } : null);
    // the GitHttp method takes the same options
    const viaClient = await new GitHttp(url(name), { capabilities: { ...defaultCapabilities(), tracer: new Tracer() } }).lsRefs([], { unborn: true });
    assert.deepEqual(viaClient.unborn, r.unborn);
    // asking costs exactly one advertisement GET without info
    await lsRefs(t, [], { unborn: true });
    assert.equal(seen.length, 1);
  }
});

test('lsRefs: not asked, an unborn line a server sends anyway is skipped; the wire exchange without a reader never sends it', async () => {
  const name = 'empty-advertise';
  const { t, seen } = recorded(name);
  const r = await lsRefsWire(t, []);
  assert.equal(r.unborn, null);
  assert.ok(!seen[0].request.includes('unborn'));
  // a hand-built response with unborn lines and no request for them: git's process_ref_v2 records them only into a
  // target its caller supplied; ply with no reader skips them
  const body = pkts(['unborn HEAD symref-target:refs/heads/x\n', `${oid} refs/heads/main\n`]);
  const fake = createTransport('http://fake.invalid/r.git', { capabilities: { ...defaultCapabilities(), fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } }) } });
  const r2 = await lsRefsWire(fake, []);
  assert.equal(r2.unborn, null);
  assert.equal(r2.refs.size, 1);
  const r3 = await lsRefsWire(fake, [], { unborn: parseUnbornLine });
  assert.deepEqual(r3.unborn, { name: 'HEAD', target: 'refs/heads/x' });
});

test('parseUnbornLine: connect.c process_ref_v2 unborn rule, line by line', () => {
  const cases = [
    // [line, prev, expected]
    ['unborn HEAD symref-target:refs/heads/main', null, { name: 'HEAD', target: 'refs/heads/main' }],
    ['unborn HEAD peeled:x symref-target:refs/heads/a symref-target:refs/heads/b', null, { name: 'HEAD', target: 'refs/heads/a' }],
    ['unborn HEAD', { name: 'HEAD', target: 'refs/heads/p' }, { name: 'HEAD', target: 'refs/heads/p' }], // no target: prev stands
    ['unborn HEAD symref-target:refs/heads/n', { name: 'HEAD', target: 'refs/heads/p' }, { name: 'HEAD', target: 'refs/heads/n' }], // last wins
    ['unborn HEAD symref-target:', { name: 'HEAD', target: 'refs/heads/p' }, null], // git records "" and clone ignores it
    ['unborn refs/heads/x symref-target:refs/heads/y', null, null], // only HEAD
    ['unborn  HEAD symref-target:refs/heads/y', null, null], // a doubled space is an empty name field
    ['unborn head symref-target:refs/heads/y', null, null],
    ['unborn HEAD symref-target:refs/heads/a b', null, { name: 'HEAD', target: 'refs/heads/a' }], // split on every space
  ];
  for (const [line, prev, want] of cases) {
    assert.equal(parseLsRefLine(line), null, line);
    assert.deepEqual(parseUnbornLine(line, prev), want, line);
  }
  // `unborn` alone has one field: git says invalid ls-refs response; ply's line parser refuses it the same way
  assert.throws(() => parseLsRefLine('unborn'), e => e.code === 'protocol');
});
