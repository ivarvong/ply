// Real git as the oracle: `git http-backend` behind a tiny Node HTTP→CGI shim.
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
export const gitBuf = (cwd, args, input) => execFileSync('git', args, { cwd, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

// ---- git fsck as the oracle: the one definition every suite uses (self-tested in test/fsck-oracle.test.js) ----
// git 2.50 writes fsck's verdict in these shapes, on two streams; an object problem never starts with "error:":
//   stderr  `error in <type> <oid>: <msgId>: <text>`    exit 1 (--strict turns WARN ids into errors)
//           `warning in <type> <oid>: <msgId>: <text>`  exit 0 (INFO ids stay warnings even under --strict:
//                                                        badFilemode, missingTaggerEntry, gitmodulesParse)
//           `error: <text>`, `fatal: <text>`            (a damaged object file, a bad argument)
//   stdout  `broken link from <type> <oid>` + an indented `to <type> <oid>` line, `missing <type> <oid>`  exit 2
//           `dangling <type> <oid>`                     exit 0 (silenced by --no-dangling)
// `notice:` lines (unborn HEAD, no refs) are the only output that says nothing about an object. A continuation line
// (leading whitespace) is folded into the line before it. --connectivity-only skips every format check (a
// duplicate-entry tree passes it with exit 0), so it is refused here.
export function fsck(cwd, args = []) {
  if (args.includes('--connectivity-only')) throw new Error('fsck --connectivity-only checks no object format; it is not an oracle');
  const r = spawnSync('git', ['fsck', '--strict', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  const lines = [];
  for (const l of `${r.stdout}\n${r.stderr}`.split('\n')) {
    if (!l.trim() || l.startsWith('notice:')) continue;
    if (/^\s/.test(l) && lines.length) lines[lines.length - 1] += ` ${l.trim()}`; else lines.push(l.trim());
  }
  return { status: r.status, lines };
}
// Every problem in the store: [] iff fsck --strict exits 0 and prints nothing but notices. Assert it with
// `assert.deepEqual(fsckProblems(bare), [])`. `dangling: true` keeps dangling objects as problems.
export function fsckProblems(cwd, { dangling = false, args = [] } = {}) {
  const { status, lines } = fsck(cwd, [...(dangling ? [] : ['--no-dangling']), ...args]);
  return status === 0 && !lines.length ? [] : [...lines, ...(status !== 0 ? [`(git fsck exit ${status})`] : [])];
}
// The problems git reports about one object, in a store that may hold other (bad) objects on purpose. The oid must be
// full: an abbreviation can match another object's line. Exit bits beyond 1 (object) and 2 (connectivity) are a
// store or git failure no line can be pinned to, so they throw.
export function fsckProblemsOf(cwd, oid) {
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error(`fsckProblemsOf needs a full oid, got ${JSON.stringify(oid)}`);
  const { status, lines } = fsck(cwd, ['--no-dangling']);
  if (status === null || (status & ~3) !== 0) throw new Error(`git fsck failed (exit ${status}): ${lines.join(' | ')}`);
  return lines.filter(l => l.includes(oid));
}

export function startGitServer(root, extraEnv = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const env = {
      ...process.env, ...extraEnv,
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: u.pathname, REQUEST_METHOD: req.method, QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'fuzz', REMOTE_ADDR: '127.0.0.1',
      SERVER_PROTOCOL: 'HTTP/1.1', GATEWAY_INTERFACE: 'CGI/1.1',
      HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0), headerDone = false;
    const stderr = [];
    child.stderr.on('data', d => stderr.push(d));
    child.stdout.on('data', d => {
      if (headerDone) return void res.write(d);
      head = Buffer.concat([head, d]);
      const i = head.indexOf('\r\n\r\n') >= 0 ? head.indexOf('\r\n\r\n') : head.indexOf('\n\n');
      if (i < 0) return;
      const sepLen = head.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
      const headers = {}; let status = 200;
      for (const line of head.subarray(0, i).toString().split(/\r?\n/)) {
        const c = line.indexOf(':'); if (c < 0) continue;
        const k = line.slice(0, c).trim(), v = line.slice(c + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10); else headers[k] = v;
      }
      res.writeHead(status, headers);
      headerDone = true;
      res.write(head.subarray(i + sepLen));
    });
    child.on('close', code => {
      if (!headerDone) { res.writeHead(500); res.end(Buffer.concat(stderr).toString()); return; }
      res.end();
    });
  });
  // Outlive the client's idle sockets: with Node's 5 s default the server can close a kept-alive socket just as undici
  // reuses it (slow oracle steps idle that long), surfacing as a spurious 'fetch failed'.
  server.keepAliveTimeout = 120_000; server.headersTimeout = 121_000;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }), server });
  }));
}

// Basic auth in front of `upstreamUrl`: a request without an Authorization header gets 401 + `WWW-Authenticate: Basic`
// (what makes git send its credential); `accept(authorization)` decides the rest (false → 401, its body echoing the
// header and its decoded form, as a careless server would). Every request's Authorization (or null) lands in `seen`.
export function startAuthGate(upstreamUrl, accept = () => true) {
  const up = new URL(upstreamUrl);
  const seen = [];
  const server = http.createServer((req, res) => {
    const a = req.headers.authorization ?? null;
    seen.push({ method: req.method, path: req.url.split('?')[0], authorization: a });
    if (a === null || !accept(a)) {
      const decoded = a?.startsWith('Basic ') ? Buffer.from(a.slice(6), 'base64').toString() : '';
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="gate"', 'content-type': 'text/plain' });
      res.end(a === null ? 'authentication required' : `bad credentials ${a} (${decoded})`);
      return;
    }
    const p = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(p);
  });
  server.keepAliveTimeout = 120_000; server.headersTimeout = 121_000;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, seen,
    close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }),
  })));
}

// git itself, asynchronously (the gate runs in this process): no config, no credential helper, no prompt.
// `extraEnv` reaches git and what it runs (a credential helper's values, GIT_SSH_COMMAND).
export function gitAsync(cwd, args, extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extraEnv };
  return new Promise(resolve => {
    const c = spawn('git', ['-c', 'credential.helper=', '-c', 'user.name=g', '-c', 'user.email=g@x', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; });
    c.on('close', status => resolve({ status, stdout, stderr }));
  });
}

// A bare repo configured for v2 partial fetch of arbitrary objects + push.
export function makeBareRepo(root, name) {
  const dir = join(root, `${name}.git`);
  git(root, ['init', '--bare', '-q', '-b', 'main', dir]);
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true'], ['http.receivepack', 'true'], ['receive.fsckObjects', 'true'], ['transfer.fsckObjects', 'true'], ['protocol.version', '2']]) git(dir, ['config', k, v]);
  return dir;
}

export function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ply-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Materialize a tree spec {path: Uint8Array|string|{mode, data}} in a work repo and push to bare. Returns head oid.
export function commitFiles(work, bare, files, msg = 'seed', { exec = [] } = {}) {
  const fs = require_fs();
  for (const [p, v] of Object.entries(files)) {
    const full = join(work, p);
    fs.mkdirSync(join(full, '..'), { recursive: true });
    const data = v && typeof v === 'object' && 'data' in v ? v.data : v;
    fs.writeFileSync(full, data);
    if ((v && v.mode === '100755') || exec.includes(p)) fs.chmodSync(full, 0o755);
  }
  git(work, ['add', '-A']);
  git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '--allow-empty', '-m', msg]);
  git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
  return git(work, ['rev-parse', 'HEAD']).trim();
}
import { createRequire } from 'node:module';
const require_fs = () => createRequire(import.meta.url)('node:fs');
