// Public viewer: URL/SSRF rules, caps, escaping, a real pack fixture, the credential-stripping fetch,
// a local git http-backend, the SQLite rate-limit object under workerd, and (when reachable) GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { concat } from '../src/bytes.js';
import { Sha1 } from '../src/sha1.js';
import { TYPE } from '../src/objects.js';
import { encodeObjHeader, spliceDelta, zlibDeflate } from '../src/pack.js';
import { parsePack } from '../src/packresolve.js';
import { git, makeBareRepo, startGitServer, tmpRoot, commitFiles } from './server.js';
import { startProxy } from './proxy.js';
import { createBudget } from '../worker/viewer/budget.ts';
import { escapeHtml } from '../worker/viewer/escape.ts';
import { credentialFreeHeaders, createViewerFetch } from '../worker/viewer/fetchguard.ts';
import { handleViewer } from '../worker/viewer/handle.ts';
import { renderLoaded } from '../worker/viewer/html.ts';
import { VIEWER_CAPS, VIEWER_GIT_LIMITS, VIEWER_UA, rateLimitFor } from '../worker/viewer/limits.ts';
import type { Loaded, RateNamespace, TraceModel } from '../worker/viewer/model.ts';
import { mapPack } from '../worker/viewer/packmap.ts';
import { ALLOWED_HOSTS, allowlistFromEnv, assertUpstreamUrl, validatePublicRepoUrl, type AllowedHost, type RepoLocation } from '../worker/viewer/url.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/viewer/small.pack', import.meta.url));
const FIXTURE_SHA = 'a86b269e52e69445e10d4c1dd7c5a89b323c0988f1d73b1f0b0c7c1d112f846a';

function loc(raw: string, allowed: readonly AllowedHost[] = ALLOWED_HOSTS): RepoLocation {
  return validatePublicRepoUrl(raw, { allowedHosts: allowed });
}

test('public repo URLs: exact allowlist, case, trailing dot, lookalikes, credentials', () => {
  const supported = 'Supported hosts: github.com, gitlab.com, codeberg.org, bitbucket.org, git.sr.ht.';
  assert.equal(loc('https://github.com/octocat/Hello-World.git').repoPath, 'octocat/Hello-World.git');
  assert.equal(loc('https://GitHub.com/octocat/Hello-World').host, 'github.com');
  assert.equal(loc('https://GitHub.com/octocat/Hello-World').url, 'https://github.com/octocat/Hello-World');
  assert.equal(loc('https://gitlab.com/a/b').host, 'gitlab.com');
  assert.equal(loc('https://codeberg.org/a/b').host, 'codeberg.org');
  assert.equal(loc('https://bitbucket.org/a/b').host, 'bitbucket.org');
  assert.equal(loc('https://git.sr.ht/~user/repo').host, 'git.sr.ht');
  assert.equal(loc('https://git.sr.ht/~user/repo').repoPath, '~user/repo');
  const bad = [
    'http://github.com/a/b', 'https://github.com:8443/a/b', 'https://user:pw@github.com/a/b', 'https://github.com/a/b?x=1',
    'https://github.com/a/b#f', 'https://github.com./octocat/Hello-World', 'https://github.com.evil.com/a/b',
    'https://evilgithub.com/a/b', 'https://githüb.com/a/b', 'https://xn--githb-nva.com/a/b',
    'https://127.0.0.1/a/b', 'https://10.0.0.1/a/b', 'https://192.168.1.1/a/b',
    'https://169.254.169.254/a/b', 'https://0.0.0.0/a/b', 'https://[::1]/a/b', 'https://[::ffff:7f00:1]/a/b',
    'https://2130706433/a/b', 'https://0x7f000001/a/b', 'https://0177.0.0.1/a/b', 'https://127.1/a/b',
    'https://localhost/a/b', 'https://foo.localhost/a/b', 'https://git.internal/a/b', 'https://evil.github.com/a/b',
    'https://notgithub.com/a/b', 'https://127.0.0.1.nip.io/a/b', 'https://acct.artifacts.cloudflare.net/git/repo.git',
    'https://ply.ivar.workers.dev/a/b', 'https://other.workers.dev/a/b', 'ftp://github.com/a/b', 'not a url', '',
  ];
  for (const raw of bad) {
    assert.throws(() => loc(raw), (err: { message?: string }) => {
      const message = String(err?.message ?? err);
      return message.includes(supported) && !message.includes('super-secret-token') && !message.includes('pw@');
    }, raw);
  }
  assert.throws(() => loc('https://user:super-secret-token@github.com/octocat/Hello-World'), (err: { message?: string }) => {
    const message = String(err?.message ?? '');
    return /credentials/.test(message) && message.includes(supported) && !message.includes('super-secret-token');
  });
  const extra = allowlistFromEnv('acct.artifacts.cloudflare.net, *.artifacts.cloudflare.net, https://evil.example, github.com:443, , not a host');
  assert.equal(extra.some(host => host === 'github.com'), true);
  assert.equal(extra.some(host => host === 'acct.artifacts.cloudflare.net'), true);
  assert.equal(extra.some(host => host.includes('*') || host.includes('/') || host.includes(':')), false);
  assert.equal(allowlistFromEnv(undefined).length, ALLOWED_HOSTS.length);
  assert.equal(allowlistFromEnv('').length, ALLOWED_HOSTS.length);
  assert.equal(allowlistFromEnv('*.artifacts.cloudflare.net').length, ALLOWED_HOSTS.length);
  const art = loc('https://acct.artifacts.cloudflare.net/git/ns/repo.git', extra);
  assert.equal(art.host, 'acct.artifacts.cloudflare.net');
  assert.throws(() => loc('https://other.artifacts.cloudflare.net/a/b.git', extra), (err: { message?: string }) => /not an allowlisted host/.test(String(err?.message)) && String(err?.message).includes('acct.artifacts.cloudflare.net'));
  assert.throws(() => loc('https://acct.artifacts.cloudflare.net/a/b.git'), /not an allowlisted host/);
  const repo = loc('https://github.com/octocat/Hello-World');
  assert.equal(assertUpstreamUrl('https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack');
  assert.throws(() => assertUpstreamUrl('https://evil.example/octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /not an allowlisted host/);
  assert.throws(() => assertUpstreamUrl('https://github.com.evil.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /not an allowlisted host/);
  assert.throws(() => assertUpstreamUrl('https://gitlab.com/octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /cross-host/);
  assert.throws(() => assertUpstreamUrl('http://github.com/octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /upstream URL rejected/);
  assert.throws(() => assertUpstreamUrl('https://github.com:8443/octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /upstream URL rejected/);
  assert.throws(() => assertUpstreamUrl('https://github.com./octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /not an allowlisted host/);
  assert.throws(() => assertUpstreamUrl('https://github.com/other/Hello/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /smart-HTTP/);
  assert.throws(() => assertUpstreamUrl('https://github.com/octocat/Hello-World/git-upload-pack?x=1', repo.url, repo.allowedHosts), /query/);
});

test('rate and byte caps clamp and fail closed', () => {
  assert.equal(rateLimitFor('page', undefined), 60);
  assert.equal(rateLimitFor('pack', ''), 20);
  assert.equal(rateLimitFor('page', '99999'), VIEWER_CAPS.rateCeiling);
  assert.equal(rateLimitFor('page', '0'), 1);
  assert.equal(rateLimitFor('page', 'nope'), 60);
  assert.equal(rateLimitFor('pack', '3'), 3);
  const budget = createBudget(100, 2);
  budget.countSubrequest();
  budget.countSubrequest();
  assert.equal(budget.canSpend(), false);
  assert.throws(() => budget.countSubrequest(), (err: { code?: string }) => err.code === 'limit_exceeded');
  const bytes = createBudget(4, 16);
  bytes.addBytes(4);
  assert.throws(() => bytes.addBytes(1), (err: { code?: string }) => err.code === 'limit_exceeded');
});

test('escapeHtml and the page renderer keep repository text out of HTML', () => {
  assert.equal(escapeHtml(`<script>alert(1)</script>"'`), '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;');
  const trace: TraceModel = { bars: [], totalMs: 0, cfRay: 'ray', requestId: 'id' };
  const loaded: Loaded = {
    kind: 'tree',
    header: {
      host: 'github.com', repoPath: 'o/r', ref: 'refs/heads/main', commit: 'a'.repeat(40),
      treeHref: '/view/github.com/o/r',
      server: { agent: 'gitty/1.0', protocol: 2, objectFormat: 'sha1', caps: ['agent'], fetchFeatures: ['filter'], filterAdvertised: true },
    },
    path: '',
    commit: { oid: 'a'.repeat(40), tree: 'b'.repeat(40), parents: [], authorName: '<b>', authorEmail: 'a@b', authorTime: 't', authorTz: '+0000', message: '<script>alert(1)</script>', signed: false },
    log: [], logStopped: false,
    branches: [{ name: 'refs/heads/main', oid: 'a'.repeat(40), head: true }], branchesTruncated: 0,
    entries: [{ name: '<script>.txt', mode: '100644', oid: 'c'.repeat(40), type: 'blob' }], entriesTruncated: 0,
  };
  const html = renderLoaded(loaded, trace);
  assert.equal(/<script/i.test(html), false);
  assert.equal(html.includes('style='), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;\.txt/);
  assert.match(html, /gitty\/1\.0/);
});

function encodeOfs(distance: number): Uint8Array {
  const out = [distance & 0x7f];
  let n = Math.floor(distance / 128);
  while (n > 0) {
    n -= 1;
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return Uint8Array.from(out);
}

async function ofsChain(deltaCount: number): Promise<Uint8Array> {
  const payload = new TextEncoder().encode('x');
  const baseZ = await zlibDeflate(payload);
  const delta = spliceDelta({ baseLen: payload.length, off: 0, oldLen: 0, insert: new Uint8Array() }).delta;
  const deltaZ = await zlibDeflate(delta);
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, deltaCount + 1);
  const parts: Uint8Array[] = [header];
  const baseHeader = encodeObjHeader(TYPE.BLOB, payload.length);
  parts.push(baseHeader, baseZ);
  let offset = 12;
  let prev = offset;
  offset += baseHeader.length + baseZ.length;
  const dHeader = encodeObjHeader(TYPE.OFS_DELTA, delta.length);
  for (let i = 0; i < deltaCount; i++) {
    const ofs = encodeOfs(offset - prev);
    parts.push(dHeader, ofs, deltaZ);
    prev = offset;
    offset += dHeader.length + ofs.length + deltaZ.length;
  }
  const body = concat(parts);
  return concat([body, new Sha1().update(body).digest()]);
}

test('pack fixture matches git verify-pack; bombs and long chains fail closed', async () => {
  const pack = new Uint8Array(readFileSync(FIXTURE));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pack));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  assert.equal(hex, FIXTURE_SHA);
  const map = mapPack(pack);
  assert.equal(map.count, 9);
  assert.equal(map.bytes, 930);
  assert.equal(map.ofsDelta, 0);
  assert.equal(map.refDelta, 1);
  assert.equal(map.thin, false);
  assert.equal(map.maxChain, 1);
  assert.equal(map.trailer, 'a470ee9652a659aa2aea5ad58df2a80594c8cfff');
  assert.equal(map.objects[0]?.oid, '4ce20682b4778f9086b59216533e2ccff8dbb191');
  assert.equal(map.objects[1]?.wireType, 'ref_delta');
  assert.equal(map.objects[1]?.resolvedType, 'commit');
  assert.equal(map.objects[1]?.baseOffset, null);
  assert.equal(map.objects[1]?.baseOid, '4ce20682b4778f9086b59216533e2ccff8dbb191');
  assert.equal(map.objects[1]?.chain, 1);
  assert.equal(map.objects[1]?.oid, 'f2db53ea00f5d51ab58e1392c78bb99760defebd');
  let cursor = 12;
  for (const obj of map.objects) {
    assert.equal(obj.offset, cursor);
    cursor += obj.length;
  }
  assert.equal(cursor + 20, pack.length);
  const dir = mkdtempSync(join(tmpdir(), 'ply-pack-'));
  try {
    copyFileSync(FIXTURE, join(dir, 'small.pack'));
    git(dir, ['index-pack', 'small.pack']);
    const verified = git(dir, ['verify-pack', '-v', 'small.pack']);
    assert.match(verified, /non delta: 8 objects/);
    assert.match(verified, /chain length = 1: 1 object/);
    assert.match(verified, /small\.pack: ok/);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const bomb = new Uint8Array(64);
  bomb.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(bomb.buffer).setUint32(4, 2);
  new DataView(bomb.buffer).setUint32(8, 1);
  bomb.set(encodeObjHeader(TYPE.BLOB, 50_000_000), 12);
  assert.throws(() => parsePack(bomb, { limits: VIEWER_GIT_LIMITS, maxObjects: VIEWER_CAPS.maxPackObjects, maxInflatedTotal: VIEWER_CAPS.maxInflatedTotal }), (err: { code?: string; message?: string }) => err.code === 'limit_exceeded' && /pack object size/.test(err.message ?? ''));

  const tooMany = new Uint8Array(32);
  tooMany.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(tooMany.buffer).setUint32(4, 2);
  new DataView(tooMany.buffer).setUint32(8, 401);
  assert.throws(() => parsePack(tooMany, { maxObjects: 400 }), (err: { code?: string }) => err.code === 'limit_exceeded');

  const short = mapPack(await ofsChain(1));
  assert.equal(short.ofsDelta, 1);
  assert.equal(short.maxChain, 1);
  assert.equal(short.objects[1]?.resolvedType, 'blob');
  await assert.rejects(async () => mapPack(await ofsChain(33)), (err: { code?: string; message?: string }) => err.code === 'limit_exceeded' && /delta chain depth/.test(err.message ?? ''));
});

test('viewer fetch drops credentials, forces the user agent, and refuses a cross-host redirect', async () => {
  const headers = credentialFreeHeaders({ Authorization: 'Bearer no', Cookie: 'a=b', 'Git-Token': 't', 'Git-Protocol': 'version=2', 'User-Agent': 'python-requests/2' });
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('git-token'), null);
  assert.equal(headers.get('user-agent'), VIEWER_UA);
  assert.equal(headers.get('git-protocol'), 'version=2');
  const repo = loc('https://github.com/octocat/Hello-World');
  const seen: { url: string; authorization: string | null; cookie: string | null; ua: string | null }[] = [];
  const budget = createBudget();
  const fetchImpl = createViewerFetch(async (input, init) => {
    const h = new Headers(init?.headers);
    seen.push({ url: String(input), authorization: h.get('authorization'), cookie: h.get('cookie'), ua: h.get('user-agent') });
    const url = String(input);
    if (url.endsWith('/info/refs?service=git-upload-pack') && !url.includes('.git/')) {
      return new Response(null, { status: 301, headers: { location: 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack' } });
    }
    if (url.includes('evil.example')) return new Response('no');
    return new Response('ok', { status: 200 });
  }, repo.url, repo.allowedHosts, budget, AbortSignal.timeout(1000));
  const ok = await fetchImpl('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack', { headers: { Authorization: 'Bearer leaked', Cookie: 'session=1' } });
  assert.equal(await ok.text(), 'ok');
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.url, 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack');
  for (const hop of seen) {
    assert.equal(hop.authorization, null);
    assert.equal(hop.cookie, null);
    assert.equal(hop.ua, VIEWER_UA);
  }
  await assert.rejects(fetchImpl('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack&x=1'), (err: { code?: string }) => err.code === 'bad_request');
  const cross = createViewerFetch(async (input) => {
    if (String(input).includes('evil.example')) throw new Error('forwarded cross-host');
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/octocat/Hello-World/info/refs?service=git-upload-pack' } });
  }, repo.url, repo.allowedHosts, createBudget(), AbortSignal.timeout(1000));
  await assert.rejects(cross('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack'), (err: { code?: string; message?: string }) => err.code === 'bad_request' && /not an allowlisted host/.test(err.message ?? ''));
  const otherForge = createViewerFetch(async (input) => {
    if (!String(input).includes('github.com/')) throw new Error(`followed redirect to ${String(input)}`);
    return new Response(null, { status: 302, headers: { location: 'https://gitlab.com/octocat/Hello-World/info/refs?service=git-upload-pack' } });
  }, repo.url, repo.allowedHosts, createBudget(), AbortSignal.timeout(1000));
  await assert.rejects(otherForge('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack'), (err: { code?: string; message?: string }) => err.code === 'bad_request' && /cross-host/.test(err.message ?? ''));
  const lookalike = createViewerFetch(async (input) => {
    if (String(input).includes('evil.com')) throw new Error('followed lookalike redirect');
    return new Response(null, { status: 302, headers: { location: 'https://github.com.evil.com/octocat/Hello-World/info/refs?service=git-upload-pack' } });
  }, repo.url, repo.allowedHosts, createBudget(), AbortSignal.timeout(1000));
  await assert.rejects(lookalike('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack'), (err: { code?: string; message?: string }) => err.code === 'bad_request' && /not an allowlisted host/.test(err.message ?? ''));
});

function fakeRate(): RateNamespace {
  const buckets = new Map<string, number[]>();
  return {
    idFromName: name => name,
    get: id => ({
      admit(bucket, now, lim, windowMs) {
        const key = `${String(id)}:${bucket}`;
        const list = (buckets.get(key) ?? []).filter(ts => ts > now - windowMs);
        if (list.length >= lim) return { ok: false, remaining: 0, retryAfterMs: 1000 };
        list.push(now);
        buckets.set(key, list);
        return { ok: true, remaining: lim - list.length, retryAfterMs: 0 };
      },
    }),
  };
}

function viewerEnv(extra: Record<string, string> = {}) {
  return { VIEWER_RATE: fakeRate(), PACK_CACHE: 'off', ...extra };
}

/** Dial a local git http-backend while the viewer only ever validates an allowlisted https URL. */
function rewriteAllowlisted(localBase: string, publicHost = 'github.com'): typeof fetch {
  const local = new URL(localBase);
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw);
    if (u.hostname !== publicHost) throw new Error(`refusing to dial ${u.hostname}`);
    u.protocol = local.protocol;
    u.hostname = local.hostname;
    u.port = local.port;
    const res = await fetch(u, init);
    const location = res.headers.get('location');
    if (!location) return res;
    const next = new URL(location, u);
    if (next.hostname === local.hostname && next.port === local.port) {
      next.protocol = 'https:';
      next.hostname = publicHost;
      next.port = '';
      const headers = new Headers(res.headers);
      headers.set('location', next.href);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  };
}

test('viewer reads a local public repo, escapes hostile names, and never forwards credentials', async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const name = 'demo';
    const bare = makeBareRepo(root, name);
    const work = join(root, 'work');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    const head = commitFiles(work, bare, { 'README.md': 'hello viewer\n', 'pic.bin': Uint8Array.from([0, 1, 2, 255]), '<script>.txt': 'nope\n' }, 'seed <script>alert(1)</script>');
    git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '--allow-empty', '-q', '-m', 'second']);
    git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
    const seen: { authorization: string | null; cookie: string | null; gitToken: string | null; ua: string | null }[] = [];
    const dial = rewriteAllowlisted(srv.url);
    const fetchImpl: typeof fetch = async (input, init) => {
      const h = new Headers(init?.headers);
      seen.push({ authorization: h.get('authorization'), cookie: h.get('cookie'), gitToken: h.get('git-token'), ua: h.get('user-agent') });
      return dial(input, init);
    };
    const env = viewerEnv();
    const repoPath = `/view/github.com/${name}.git`;
    const page = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}`, {
      headers: { authorization: 'Bearer viewer-should-ignore', cookie: 'session=secret', 'git-token': 'git-secret', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'ray-test' },
    }), env, {}, { fetchImpl });
    assert.equal(page.status, 200, await page.clone().text());
    const html = await page.text();
    assert.match(html, /README\.md/);
    assert.equal(html.includes('hello viewer'), false);
    assert.equal(html.includes('127.0.0.1'), false);
    assert.match(html, /refs\/heads\/main/);
    assert.match(html, /git\.upload-pack/);
    assert.match(html, /ray-test/);
    assert.equal(/<script/i.test(html), false);
    assert.match(html, /&lt;script&gt;/);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'none'/);
    assert.match(page.headers.get('content-security-policy') ?? '', /style-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(html.includes('viewer-should-ignore'), false);
    assert.equal(html.includes('git-secret'), false);
    assert.ok(seen.length > 0);
    for (const hop of seen) {
      assert.equal(hop.authorization, null);
      assert.equal(hop.cookie, null);
      assert.equal(hop.gitToken, null);
      assert.equal(hop.ua, VIEWER_UA);
    }
    const file = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?ref=main&path=README.md`), env, {}, { fetchImpl });
    assert.equal(file.status, 200);
    const fileHtml = await file.text();
    assert.match(fileHtml, /class="ln">1</);
    assert.match(fileHtml, /hello viewer/);
    const raw = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?path=README.md&raw=1`), env, {}, { fetchImpl });
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(await raw.text(), 'hello viewer\n');
    const bin = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?path=pic.bin&raw=1`), env, {}, { fetchImpl });
    assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(new Uint8Array(await bin.arrayBuffer()), new Uint8Array([0, 1, 2, 255]));
    const pack = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?want=${head}&filter=tree:0`), env, {}, { fetchImpl });
    assert.equal(pack.status, 200);
    const packHtml = await pack.text();
    assert.match(packHtml, /Pack map/);
    assert.match(packHtml, /ofs-delta/);
    assert.equal(packHtml.includes('style='), false);
    const css = await handleViewer(new Request('https://ply.ivar.workers.dev/view.css'), env, {});
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    const home = await handleViewer(new Request('https://ply.ivar.workers.dev/view'), env, {});
    const homeHtml = await home.text();
    assert.match(homeHtml, /octocat\/Hello-World/);
    assert.match(homeHtml, /bitbucket\.org/);
    assert.match(homeHtml, /git\.sr\.ht/);
    assert.equal(homeHtml.includes('artifacts.cloudflare.net'), false);
    const redir = await handleViewer(new Request(`https://ply.ivar.workers.dev/view?remote=${encodeURIComponent(`https://github.com/${name}.git`)}`), env, {});
    assert.equal(redir.status, 302);
    assert.equal(redir.headers.get('location'), `/view/github.com/${name}.git`);
    const localRemote = await handleViewer(new Request(`https://ply.ivar.workers.dev/view?remote=${encodeURIComponent(`${srv.url}/${name}.git`)}`), env, {});
    assert.equal(localRemote.status, 400);
    const localHtml = await localRemote.text();
    assert.match(localHtml, /Supported hosts/);
    assert.equal(localHtml.includes('127.0.0.1'), false);
    const extra = await handleViewer(new Request(`https://ply.ivar.workers.dev/view?remote=${encodeURIComponent('https://acct.artifacts.cloudflare.net/git/ns/repo.git')}`), viewerEnv({ VIEWER_EXTRA_HOSTS: 'acct.artifacts.cloudflare.net' }), {});
    assert.equal(extra.status, 302);
    assert.equal(extra.headers.get('location'), '/view/acct.artifacts.cloudflare.net/git/ns/repo.git');
    const wildcard = await handleViewer(new Request(`https://ply.ivar.workers.dev/view?remote=${encodeURIComponent('https://acct.artifacts.cloudflare.net/git/ns/repo.git')}`), viewerEnv({ VIEWER_EXTRA_HOSTS: '*.artifacts.cloudflare.net' }), {});
    assert.equal(wildcard.status, 400);
    const secret = await handleViewer(new Request('https://ply.ivar.workers.dev/view?remote=https://github.com/a/b&token=super-secret-token'), env, {});
    assert.equal(secret.status, 400);
    assert.equal((await secret.text()).includes('super-secret-token'), false);
    const ssrf = await handleViewer(new Request('https://ply.ivar.workers.dev/view/169.254.169.254/latest'), env, {}, { fetchImpl: async () => { throw new Error('ssrf fetched'); } });
    assert.equal(ssrf.status, 400);
    assert.match(await ssrf.text(), /Supported hosts: github.com, gitlab.com, codeberg.org, bitbucket.org, git.sr.ht/);
    const hostile = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?path=${encodeURIComponent('<script>alert(1)</script>')}`), env, {}, { fetchImpl });
    assert.equal(hostile.status, 404);
    const hostileHtml = await hostile.text();
    assert.equal(/<script/i.test(hostileHtml), false);
    assert.match(hostileHtml, /&lt;script&gt;/);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('a tree:0 rejection is visible, then the blob:none retry, and a denied rate limit does no fetch', async () => {
  const { root, cleanup } = tmpRoot();
  const upstream = await startGitServer(root);
  const filterOf = (body: Uint8Array) => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;
  const proxy = await startProxy(upstream.url, (ctx: { stage: string; reqBody: Uint8Array }) => (
    ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none'
      ? { type: 'status', status: 400, contentType: 'text/plain', body: 'Unsupported Git fetch filter; only blob:none is supported.' }
      : { type: 'pass' }
  ));
  try {
    const bare = makeBareRepo(root, 'art');
    const work = join(root, 'art-work');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'README.md': 'artifacts-shaped\n' }, 'one');
    let fetches = 0;
    const dial = rewriteAllowlisted(proxy.url);
    const fetchImpl: typeof fetch = async (input, init) => { fetches++; return dial(input, init); };
    const env = viewerEnv();
    const res = await handleViewer(new Request('https://ply.ivar.workers.dev/view/github.com/art.git', { headers: { 'cf-connecting-ip': '203.0.113.10' } }), env, {}, { fetchImpl });
    assert.equal(res.status, 200, await res.clone().text());
    const html = await res.text();
    assert.match(html, /filter tree:0 was rejected/);
    assert.match(html, /HTTP 400/);
    assert.match(html, /blob:none/);
    const limited = fakeRate();
    let called = 0;
    const denyEnv = { VIEWER_RATE: limited, PACK_CACHE: 'off', VIEWER_RATE_PER_MIN: '1' };
    const first = await handleViewer(new Request('https://ply.ivar.workers.dev/view', { headers: { 'cf-connecting-ip': '203.0.113.11' } }), denyEnv, {}, { fetchImpl: async () => { called++; throw new Error('no'); }, now: 1_000 });
    assert.equal(first.status, 200);
    const second = await handleViewer(new Request('https://ply.ivar.workers.dev/view/github.com/art.git', { headers: { 'cf-connecting-ip': '203.0.113.11' } }), denyEnv, {}, { fetchImpl: async () => { called++; throw new Error('fetched while limited'); }, now: 1_500 });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '1');
    assert.equal(called, 0);
    assert.ok(fetches > 0);
    const missing = await handleViewer(new Request('https://ply.ivar.workers.dev/view'), {}, {});
    assert.equal(missing.status, 503);
  } finally {
    await proxy.close();
    await upstream.close();
    cleanup();
  }
});

const WORKERD = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url))].filter((p): p is string => !!p && existsSync(p));

test('workerd: sqlite rate limit, and /v1 still requires the bearer', { skip: WORKERD.length === 0 && 'workerd not installed' }, async () => {
  const { root, cleanup } = tmpRoot();
  const out = join(root, 'wk');
  mkdirSync(out);
  await build({ entryPoints: [fileURLToPath(new URL('../worker/index.js', import.meta.url))], bundle: true, format: 'esm', outfile: join(out, 'worker.mjs'), logLevel: 'silent', external: ['cloudflare:workers'] });
  const port = 19100 + (process.pid % 40);
  const ply = 'test-ply-token-' + 'x'.repeat(20);
  writeFileSync(join(out, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = (
    modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ],
    compatibilityDate = "2026-10-18",
    durableObjectNamespaces = [ (className = "ViewerRateLimit", uniqueKey = "viewer-rate-test", enableSql = true) ],
    durableObjectStorage = (inMemory = void),
    bindings = [
      (name = "PLY_TOKEN", text = "${ply}"),
      (name = "WRITES", text = "off"),
      (name = "PACK_CACHE", text = "off"),
      (name = "VIEWER_RATE_PER_MIN", text = "2"),
      (name = "VIEWER_RATE", durableObjectNamespace = "ViewerRateLimit")
    ]
  )), (name = "internet", network = (allow = ["private", "public", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ]
);
`);
  let logs = '';
  const proc = spawn(WORKERD[0] as string, ['serve', join(out, 'config.capnp'), '--verbose'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { logs += d; });
  proc.stderr.on('data', d => { logs += d; });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.equal(up, true, logs.slice(-1500));
    const hit = (ip: string) => fetch(`http://127.0.0.1:${port}/view`, { headers: { 'cf-connecting-ip': ip } });
    assert.equal((await hit('198.51.100.8')).status, 200);
    assert.equal((await hit('198.51.100.8')).status, 200);
    const limited = await hit('198.51.100.8');
    const limitedBody = await limited.text();
    assert.equal(limited.status, 429, `${limitedBody}\n${logs.slice(-2000)}`);
    assert.equal((await hit('198.51.100.9')).status, 200);
    const blocked = await fetch(`http://127.0.0.1:${port}/view/127.0.0.1/latest/meta-data`);
    assert.equal(blocked.status, 400);
    const blockedHtml = await blocked.text();
    assert.match(blockedHtml, /Supported hosts: github.com, gitlab.com, codeberg.org, bitbucket.org, git.sr.ht/);
    const gated = await fetch(`http://127.0.0.1:${port}/v1/refs?remote=${encodeURIComponent('https://github.com/octocat/Hello-World.git')}`);
    assert.equal(gated.status, 401);
    const leaked = await fetch(`http://127.0.0.1:${port}/view/user:super-secret-token@github.com/octocat/Hello-World`);
    assert.equal(leaked.status, 400);
    assert.equal((await leaked.text()).includes('super-secret-token'), false);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(logs.includes('super-secret-token'), false);
  } finally {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    cleanup();
  }
});

test('a public GitHub repository renders when the network can reach it', { timeout: 40_000 }, async (t) => {
  const probe = await fetch('https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', {
    headers: { 'git-protocol': 'version=2', 'user-agent': VIEWER_UA },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!probe?.ok) {
    await probe?.body?.cancel().catch(() => {});
    return t.skip('GitHub is unreachable from this environment');
  }
  await probe.arrayBuffer();
  const env = { VIEWER_RATE: fakeRate(), PACK_CACHE: 'off' };
  const res = await handleViewer(new Request('https://ply.ivar.workers.dev/view/github.com/octocat/Hello-World', { headers: { 'cf-connecting-ip': '203.0.113.50', 'cf-ray': 'github-ray' } }), env, {});
  assert.equal(res.status, 200, await res.clone().text());
  const html = await res.text();
  assert.match(html, /Hello-World/);
  assert.match(html, /git\.upload-pack/);
  assert.match(html, /github-ray/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'none'/);
  const want = /[0-9a-f]{40}/.exec(html)?.[0];
  assert.ok(want);
  const pack = await handleViewer(new Request(`https://ply.ivar.workers.dev/view/github.com/octocat/Hello-World?want=${want}&filter=blob:none`), env, {});
  assert.equal(pack.status, 200, await pack.clone().text());
  const packHtml = await pack.text();
  assert.match(packHtml, /Pack map/);
  assert.match(packHtml, /agent /);
});
