// Shared helpers for the worker-mem harness: paths, the cf CLI (always without CLOUDFLARE_API_TOKEN), redaction.
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, writeSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const DATA = join(HERE, '.data');
export const REPORTS = join(HERE, 'reports');
export const WORKER = 'ply-memlab';
export const NAMESPACE = 'ply-loadgen';
export const TOKEN_FILE = join(homedir(), '.config', 'ply', 'memlab-token');

const ART = /art_v\d+_[^\s"'\\]+/g;
const secrets = new Set();
export const remember = s => { if (s) secrets.add(s); return s; };
export function redact(text) {
  let out = String(text).replace(ART, '[redacted]');
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out;
}

const cfEnv = () => {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  return env;
};

// Runs cf; returns { code, stdout, stderr } with secrets redacted from stderr only (stdout may carry minted tokens).
export function cfRaw(args, opts = {}) {
  const r = spawnSync('cf', args, { encoding: opts.encoding ?? 'utf8', env: cfEnv(), cwd: opts.cwd ?? HERE, maxBuffer: 256 * 1024 * 1024, input: opts.input });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: redact(r.stderr ?? '') };
}

export function cfJson(args, opts = {}) {
  const r = cfRaw(args, opts);
  if (r.code !== 0) throw new Error(`cf ${args.slice(0, 4).join(' ')} failed: ${r.stderr.slice(0, 600)}`);
  const at = r.stdout.search(/[[{]/);
  return at < 0 ? null : JSON.parse(r.stdout.slice(at));
}

// Writes a secret to a 0600 file without ever echoing it.
export function writeSecret(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w', 0o600);
  writeSync(fd, value);
  closeSync(fd);
}

// The bearer for the ply-memlab Worker, generated once.
export function memlabToken() {
  if (!existsSync(TOKEN_FILE)) writeSecret(TOKEN_FILE, randomBytes(32).toString('hex'));
  return remember(readFileSync(TOKEN_FILE, 'utf8').trim());
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');

export function quantiles(xs) {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const at = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, min: v[0], p50: at(0.5), p90: at(0.9), max: v[v.length - 1] };
}
