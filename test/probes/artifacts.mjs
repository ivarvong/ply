// The server-under-test target for Cloudflare Artifacts: a fresh repository per scenario run, in the load-test
// namespace only, created and deleted with the `cf` CLI. Opt-in (scripts/probes.mjs --artifacts); CI never loads this.
//
// Credentials: the CLI's own login is used for the control plane; each repository's write token is minted from the CLI's
// stdout and held in this process's memory only (handed to the recording proxy, which adds the Authorization header).
// It is never printed, written, put in argv or in a child's environment; every string this module returns goes through
// scrub(). Every token minted, including the one `repos create` mints by itself, is revoked and proven dead (403)
// before the repository is deleted, and the deletion is checked by listing.
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { startRecordingProxy } from './runner.mjs';

export const NAMESPACE = 'ply-loadgen'; // the only namespace hostile or load traffic may touch
const secrets = new Set();
const keep = s => { if (typeof s === 'string' && s.length >= 8) { secrets.add(s); secrets.add(encodeURIComponent(s)); secrets.add(Buffer.from(`x:${s}`).toString('base64')); } return s; };
export const scrub = text => { let t = String(text); for (const s of secrets) t = t.split(s).join('[redacted]'); return t; };

function sh(cmd, args, { cwd, env }) {
  return new Promise(resolve => {
    const t0 = performance.now();
    execFile(cmd, args, { cwd, env, maxBuffer: 16 << 20, timeout: 120_000 }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), ms: +(performance.now() - t0).toFixed(0) }));
  });
}
const json = text => { const a = text.indexOf('{'), b = text.indexOf('['); const i = a < 0 ? b : b < 0 ? a : Math.min(a, b); try { return i < 0 ? null : JSON.parse(text.slice(i)); } catch { return null; } };
const ids = node => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object') { if (typeof n.id === 'string' && n.id) out.push(n.id); Object.values(n).forEach(visit); } }; visit(node); return out; };
const findStrings = (node, keys, out = []) => {
  if (Array.isArray(node)) { for (const x of node) findStrings(x, keys, out); return out; }
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (keys.includes(k) && typeof v === 'string') out.push(v); findStrings(v, keys, out); }
  return out;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// cli: { bin, cwd, env } for the `cf` CLI. log: (record) => void for the control-plane audit (scrubbed by the caller).
export function artifactsTarget({ cli, runId, log }) {
  if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('runId must be lowercase alphanumerics and dashes');
  const cf = async (label, args) => { const r = await sh(cli.bin, args, cli); log({ kind: 'cf', label, args: args.filter(a => !secrets.has(a)), code: r.code, ms: r.ms, stderr: r.code ? scrub(r.stderr.trim().slice(0, 300)) : '' }); return r; };
  let n = 0;
  const tokens = []; // { id, label, repo, revoked, probe, ray }
  const repos = []; // { name, created, deleted, listedAfter }

  // A revoked token must be refused: GET the upload-pack advertisement with it until 403 (propagation), at most ~12 s.
  async function proveDead(remote, plain) {
    let status = 0, ray = null;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${plain}` }, redirect: 'manual' });
      status = res.status; ray = res.headers.get('cf-ray'); await res.body?.cancel();
      log({ kind: 'http', label: 'revoked-token probe', status, cfRay: ray });
      if (status === 403) break;
      await sleep(2000);
    }
    return { status, ray };
  }
  async function revoke(t, remote, plain) {
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) { ok = (await cf('token revoke', ['artifacts', 'namespaces', 'tokens', 'revoke', t.id, '--namespace', NAMESPACE, '--force'])).code === 0; if (!ok) await sleep(2000); }
    t.revoked = ok;
    if (plain !== null) { const p = await proveDead(remote, plain); t.probe = p.status; t.ray = p.ray; }
  }

  return {
    tokens, repos,
    // Create the repository, revoke whatever it minted by itself, mint a write token, and start a proxy that adds it.
    async open(label) {
      const name = `ply-probe-${runId}-${String(n++).padStart(2, '0')}`;
      const rec = { name, label, created: false, deleted: false, listedAfter: null };
      repos.push(rec);
      const c = await cf('repo create', ['artifacts', 'namespaces', 'repos', 'create', NAMESPACE, '--name', name, '--default-branch', 'main', '--description', `ply differential probe ${label} (deleted after)`]);
      const j = c.code === 0 ? json(c.stdout) : null;
      const autos = findStrings(j, ['token', 'plaintext']).map(keep);
      const remote = findStrings(j, ['remote']).find(u => /^https:\/\/[a-z0-9]+\.artifacts\.cloudflare\.net\/git\//.test(u)) ?? null;
      if (remote === null) throw new Error(`repo create gave no remote (exit ${c.code}): ${scrub(c.stderr.trim().slice(0, 300))}`);
      rec.created = true;
      const listed = await cf('repo tokens list', ['artifacts', 'namespaces', 'repos', 'tokens', 'list', '--namespace', NAMESPACE, '--name', name, '--state', 'active']);
      for (const id of listed.code === 0 ? ids(json(listed.stdout)) : []) {
        const t = { id, label: 'auto (repos create)', repo: name, revoked: false, probe: null, ray: null };
        tokens.push(t);
        await revoke(t, remote, autos[0] ?? null);
      }
      const m = await cf('token create (write)', ['artifacts', 'namespaces', 'tokens', 'create', NAMESPACE, '--repo', name, '--scope', 'write', '--ttl', '1800']);
      const mj = m.code === 0 ? json(m.stdout) : null;
      const plain = typeof mj?.plaintext === 'string' ? keep(mj.plaintext) : null;
      if (plain === null || typeof mj?.id !== 'string') throw new Error(`token create failed (exit ${m.code})`);
      const token = { id: mj.id, label: 'write', repo: name, revoked: false, probe: null, ray: null };
      tokens.push(token);
      const u = new URL(remote);
      const proxy = await startRecordingProxy({ upstream: u.origin, authorization: `Bearer ${plain}` });
      return {
        name, proxy, repoPath: u.pathname.replace(/\/$/, ''),
        async close() {
          await proxy.close();
          await revoke(token, remote, plain);
          const left = await cf('repo tokens list', ['artifacts', 'namespaces', 'repos', 'tokens', 'list', '--namespace', NAMESPACE, '--name', name, '--state', 'active']);
          for (const id of left.code === 0 ? ids(json(left.stdout)) : []) {
            const t = { id, label: 'leftover', repo: name, revoked: false, probe: null, ray: null };
            tokens.push(t);
            await revoke(t, remote, null);
          }
          for (let i = 0; i < 3 && !rec.deleted; i++) rec.deleted = (await cf('repo delete', ['artifacts', 'namespaces', 'repos', 'delete', name, '--namespace', NAMESPACE, '--force'])).code === 0;
          const after = await cf('repo list (gone?)', ['artifacts', 'namespaces', 'repos', 'list', '--namespace', NAMESPACE, '--search', name]);
          rec.listedAfter = after.code === 0 ? JSON.stringify(json(after.stdout) ?? []).includes(`"${name}"`) : null;
        },
      };
    },
  };
}
