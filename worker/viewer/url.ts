// Public-repo URL validation. A ValidatedPublicRepoUrl is the only string the viewer will fetch,
// and it is produced only by validatePublicRepoUrl. Credentialed URLs are rejected, not stripped
// into an Authorization header (createTransport would otherwise promote userinfo into auth).
//
// Host policy is an exact allowlist. There is no suffix match, no wildcard, and no IP-literal
// folding: a hostname is accepted only when it is one of the allowed hosts, character for character.
import { fail } from '../../src/errors.js';

declare const validatedPublicRepoUrl: unique symbol;
export type ValidatedPublicRepoUrl = string & { readonly [validatedPublicRepoUrl]: 'ValidatedPublicRepoUrl' };

declare const allowedHost: unique symbol;

/** Built-in public forges. Exact hostnames, lowercase, no leading wildcard and no trailing dot. */
export const ALLOWED_HOSTS = Object.freeze([
  'github.com',
  'gitlab.com',
  'codeberg.org',
  'bitbucket.org',
  'git.sr.ht',
] as const);

export type BuiltinAllowedHost = (typeof ALLOWED_HOSTS)[number];

/**
 * A hostname the viewer may fetch. The built-in forges are the union above. An operator extra
 * (VIEWER_EXTRA_HOSTS) is branded only after it passes the exact-hostname grammar.
 */
export type AllowedHost = BuiltinAllowedHost | (string & { readonly [allowedHost]: 'AllowedHost' });

export type ValidateOpts = {
  allowedHosts?: readonly AllowedHost[];
  maxLength?: number;
};

export type RepoLocation = {
  url: ValidatedPublicRepoUrl;
  origin: string;
  host: AllowedHost;
  hostname: AllowedHost;
  repoPath: string;
  allowedHosts: readonly AllowedHost[];
};

const EXTRA_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function brand(url: string): ValidatedPublicRepoUrl {
  return url as ValidatedPublicRepoUrl;
}

function brandExtra(host: string): AllowedHost {
  return host as string & { readonly [allowedHost]: 'AllowedHost' };
}

/**
 * Defaults, plus exact hostnames from VIEWER_EXTRA_HOSTS. Unset or blank keeps the defaults.
 * Tokens with a scheme, port, userinfo, wildcard, or trailing dot are skipped — they are not
 * turned into suffix rules. Artifacts stays off until the operator names that exact host.
 */
export function allowlistFromEnv(raw: string | undefined): readonly AllowedHost[] {
  if (raw === undefined || raw.trim() === '') return ALLOWED_HOSTS;
  const extras: AllowedHost[] = [];
  const seen = new Set<string>(ALLOWED_HOSTS);
  for (const part of raw.split(',')) {
    const item = part.trim().toLowerCase();
    if (!item || seen.has(item)) continue;
    if (/[*@:/\\%\s]/.test(item) || item.startsWith('.') || item.endsWith('.')) continue;
    if (!EXTRA_HOST.test(item)) continue;
    seen.add(item);
    extras.push(brandExtra(item));
  }
  if (extras.length === 0) return ALLOWED_HOSTS;
  return Object.freeze([...ALLOWED_HOSTS, ...extras]);
}

/** Case-insensitive exact match. A trailing dot is not stripped, and a suffix never matches. */
export function hostAllowed(hostname: string, allowed: readonly AllowedHost[]): boolean {
  const host = hostname.toLowerCase();
  for (const item of allowed) if (item === host) return true;
  return false;
}

function supported(allowed: readonly AllowedHost[]): string {
  return `Supported hosts: ${allowed.join(', ')}.`;
}

function reject(allowed: readonly AllowedHost[], message: string): never {
  throw fail('bad_request', `${message} ${supported(allowed)}`);
}

/** True when the raw authority's host ends in `.`, even if a URL parser would drop that dot. */
function authorityEndsWithDot(raw: string): boolean {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw.trim());
  if (!match?.[1]) return false;
  let authority = match[1];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  if (authority.startsWith('[')) return false;
  const colon = authority.lastIndexOf(':');
  if (colon >= 0 && /^\d+$/.test(authority.slice(colon + 1))) authority = authority.slice(0, colon);
  return authority.endsWith('.');
}

function checkPath(pathname: string, allowed: readonly AllowedHost[]): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (!trimmed.startsWith('/')) reject(allowed, 'remote path is not allowed.');
  const parts = trimmed.slice(1).split('/');
  if (parts.length < 1 || parts.length > 16) reject(allowed, 'remote path is not allowed.');
  if (trimmed.length > 512) reject(allowed, 'remote path is too long.');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') reject(allowed, 'remote path is not allowed.');
    if (part.includes('@') || part.includes('\\') || part.includes(' ') || /[\u0000-\u001f\u007f]/.test(part)) reject(allowed, 'remote path is not allowed.');
    if (part.includes('%')) reject(allowed, 'remote path is not allowed.');
  }
  return parts.join('/');
}

/**
 * Validate a user-supplied git remote. https, no userinfo, default port, and a hostname that
 * exactly matches the allowlist. Anything else is rejected before a fetch, with the supported hosts.
 */
export function validatePublicRepoUrl(raw: string, opts: ValidateOpts = {}): RepoLocation {
  const allowed = opts.allowedHosts ?? ALLOWED_HOSTS;
  const maxLength = opts.maxLength ?? 2048;
  if (typeof raw !== 'string' || !raw.trim()) reject(allowed, 'remote is required.');
  if (raw.length > maxLength) reject(allowed, 'remote is too long.');
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) reject(allowed, 'remote is not a URL.');
  let u: URL;
  try { u = new URL(raw); }
  catch { reject(allowed, 'remote is not a URL.'); }
  if (u.username || u.password) reject(allowed, 'remote must not carry credentials.');
  if (u.search || u.hash) reject(allowed, 'remote must not have a query or fragment.');
  const repoPath = checkPath(u.pathname, allowed);
  if (u.protocol !== 'https:') reject(allowed, 'remote must be https.');
  if (u.port !== '') reject(allowed, 'remote must use port 443.');
  const hostname = u.hostname.toLowerCase();
  const matched = allowed.find(item => item === hostname);
  if (authorityEndsWithDot(raw) || hostname.endsWith('.') || !matched) reject(allowed, 'remote host is not an allowlisted host.');
  const origin = `https://${matched}`;
  const canonical = `${origin}/${repoPath}`;
  return { url: brand(canonical), origin, host: matched, hostname: matched, repoPath, allowedHosts: allowed };
}

function repoVariants(repoPath: string): string[] {
  const bare = repoPath.replace(/\.git$/, '');
  return [...new Set([repoPath, bare, `${bare}.git`])];
}

/** A fetch the transport is about to make must be this repo's smart-HTTP endpoint on an allowlisted host. */
export function assertUpstreamUrl(raw: string, repo: ValidatedPublicRepoUrl, allowed: readonly AllowedHost[]): ValidatedPublicRepoUrl {
  let u: URL;
  try { u = new URL(raw); }
  catch { reject(allowed, 'upstream URL rejected.'); }
  if (u.username || u.password || u.hash) reject(allowed, 'upstream URL rejected.');
  if (u.protocol !== 'https:' || u.port !== '') reject(allowed, 'upstream URL rejected.');
  if (authorityEndsWithDot(raw) || !hostAllowed(u.hostname, allowed)) reject(allowed, 'redirect host is not an allowlisted host.');
  const base = new URL(repo);
  if (u.host !== base.host) reject(allowed, 'cross-host upstream rejected.');
  const path = u.pathname.replace(/\/+$/, '');
  const variants = repoVariants(new URL(repo).pathname.replace(/^\//, '').replace(/\/+$/, ''));
  const matched = variants.find(v => path === `/${v}/info/refs` || path === `/${v}/git-upload-pack`);
  if (!matched) reject(allowed, 'upstream path is not a git smart-HTTP endpoint.');
  if (path.endsWith('/info/refs')) {
    const keys = [...u.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'service' || u.searchParams.get('service') !== 'git-upload-pack') reject(allowed, 'unexpected info/refs query.');
  } else if (u.search) reject(allowed, 'unexpected upload-pack query.');
  return brand(u.toString());
}

export function viewerHref(host: string, repoPath: string, query: Record<string, string | undefined> = {}): string {
  const path = `/view/${encodeURIComponent(host)}/${repoPath.split('/').map(part => encodeURIComponent(part)).join('/')}`;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) qs.set(key, value);
  const tail = qs.toString();
  return tail ? `${path}?${tail}` : path;
}

export function viewerPathFor(loc: RepoLocation, query: Record<string, string | undefined> = {}): string {
  return viewerHref(loc.host, loc.repoPath, query);
}
