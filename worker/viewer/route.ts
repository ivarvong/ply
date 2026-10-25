import { fail } from '../../src/errors.js';
import { validatePath } from '../../src/validate.js';
import { VIEWER_CAPS, VIEWER_GIT_LIMITS } from './limits.ts';
import type { FilterName } from './model.ts';
import { allowlistFromEnv, validatePublicRepoUrl, viewerPathFor, type AllowedHost, type RepoLocation } from './url.ts';

export type ViewerRoute =
  | { kind: 'css' }
  | { kind: 'home' }
  | { kind: 'redirect'; location: string }
  | {
      kind: 'repo';
      loc: RepoLocation;
      ref: string | null;
      path: string;
      raw: boolean;
      pack: { want: string; filter: FilterName; offset: number | null } | null;
    };

export type RouteOpts = {
  allowedHosts: readonly AllowedHost[];
};

const SECRET_QUERY = /^(access_token|token|password|auth|authorization|git-token|git-authorization)$/i;
const OID = /^[0-9a-f]{40}$/;

function bad(message: string): never {
  throw fail('bad_request', message);
}

export function routeOptsFromEnv(env: { VIEWER_EXTRA_HOSTS?: string }): RouteOpts {
  return { allowedHosts: allowlistFromEnv(env.VIEWER_EXTRA_HOSTS) };
}

function parseRef(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  if (raw.length > 1024) bad('ref is too long');
  if (raw === 'HEAD') return 'HEAD';
  if (OID.test(raw)) return raw;
  if (raw.startsWith('refs/')) {
    if (/[\u0000-\u001f\u007f ~^:?*\[\\]|\.\.|@\{|\/\/|\s/.test(raw)) bad('ref is not a valid name');
    return raw;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes('..') || raw.startsWith('/') || raw.endsWith('/') || raw.endsWith('.lock')) bad('ref is not a valid name');
  return raw;
}

function parsePath(raw: string | null): string {
  if (raw === null || raw === '') return '';
  const stripped = raw.replace(/^\/+|\/+$/g, '');
  if (!stripped) return '';
  if (stripped.length > 1024) bad('path is too long');
  validatePath(stripped, VIEWER_GIT_LIMITS);
  return stripped;
}

function parseFilter(raw: string | null, wantPresent: boolean): FilterName {
  if (raw === null || raw === '') return 'tree:0';
  if (raw === 'tree:0' || raw === 'blob:none') return raw;
  if (!wantPresent) bad('filter is only valid on a pack map');
  bad('filter must be tree:0 or blob:none');
}

function locate(host: string, repoPath: string, opts: RouteOpts): RepoLocation {
  if (!host || host.length > 253 || /[\u0000-\u001f\u007f\s/@\\]/.test(host)) bad(`remote host is not allowed. Supported hosts: ${opts.allowedHosts.join(', ')}.`);
  return validatePublicRepoUrl(`https://${host}/${repoPath}`, { allowedHosts: opts.allowedHosts, maxLength: VIEWER_CAPS.maxUrlLength });
}

export function parseViewerRoute(url: URL, opts: RouteOpts): ViewerRoute {
  if (url.pathname.length > VIEWER_CAPS.maxUrlLength || url.href.length > VIEWER_CAPS.maxUrlLength * 2) bad('URL is too long');
  for (const key of url.searchParams.keys()) if (SECRET_QUERY.test(key)) bad('query must not carry credentials');
  if (url.pathname === '/view.css') return { kind: 'css' };
  if (url.pathname === '/view' || url.pathname === '/view/') {
    const remote = url.searchParams.get('remote');
    if (!remote) return { kind: 'home' };
    const loc = validatePublicRepoUrl(remote, { allowedHosts: opts.allowedHosts, maxLength: VIEWER_CAPS.maxUrlLength });
    const ref = parseRef(url.searchParams.get('ref'));
    return { kind: 'redirect', location: viewerPathFor(loc, { ref: ref ?? undefined }) };
  }
  if (!url.pathname.startsWith('/view/')) bad('not a viewer route');
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname.slice('/view/'.length)); } catch { bad('remote path is not allowed'); }
  if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('..')) bad('remote path is not allowed');
  const parts = decoded.split('/').filter(part => part.length > 0);
  if (parts.length < 2) bad('remote path is not allowed');
  const host = parts[0] ?? '';
  const repoPath = parts.slice(1).join('/');
  const loc = locate(host, repoPath, opts);
  const wantRaw = url.searchParams.get('want');
  const filter = parseFilter(url.searchParams.get('filter'), wantRaw !== null);
  let pack: { want: string; filter: FilterName; offset: number | null } | null = null;
  if (wantRaw !== null) {
    if (!OID.test(wantRaw)) bad('want must be a 40-hex object id');
    const offsetRaw = url.searchParams.get('offset');
    let offset: number | null = null;
    if (offsetRaw !== null && offsetRaw !== '') {
      if (!/^\d+$/.test(offsetRaw)) bad('offset must be a byte offset');
      offset = Number(offsetRaw);
      if (offset > VIEWER_CAPS.maxPackBytes) bad('offset is past the pack cap');
    }
    pack = { want: wantRaw, filter, offset };
  } else if (url.searchParams.get('filter') || url.searchParams.get('offset')) bad('filter and offset need a want');
  const raw = url.searchParams.get('raw') === '1';
  if (raw && pack) bad('raw is a file view');
  return { kind: 'repo', loc, ref: parseRef(url.searchParams.get('ref')), path: parsePath(url.searchParams.get('path')), raw, pack };
}
