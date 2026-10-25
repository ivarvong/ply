// One public page: discover, then either a pack map or a ref → commit → tree walk → optional blob.
// Quirks stay on this request. Sharing them with the /v1 isolate map would hide the tree:0 → blob:none
// retry the trace is here to show, and would change /v1 timing.
import { concat } from '../../src/bytes.js';
import { fail } from '../../src/errors.js';
import { limitError } from '../../src/limits.js';
import { TYPE, hashObject, parseTree } from '../../src/objects.js';
import type { Budget } from './budget.ts';
import { clampText, safeFilename } from './escape.ts';
import type { FetchLike } from './fetchguard.ts';
import { VIEWER_CAPS, VIEWER_GIT_LIMITS, VIEWER_UA } from './limits.ts';
import { mapParsed } from './packmap.ts';
import type { CommitInfo, FilterName, Loaded, RepoHeader, ServerInfo, TreeEntry } from './model.ts';
import { candidates, createGitTransport, cursorFinish, cursorInit, cursorStep, discoverRepo, filterRejected, inflateObject, listRefs, readObject, readPack, streamPack, treeEntryType, treeMode, viewCommit, type GitTransport, type ViewerTracer } from './ply.ts';
import type { ViewerRoute } from './route.ts';
import type { RepoLocation, ValidatedPublicRepoUrl } from './url.ts';
import { viewerHref } from './url.ts';

type Quirks = { treeFilter?: 'blob:none' };

type NoCredential = { auth?: never };

export type SessionDeps = {
  tracer: ViewerTracer;
  fetchImpl: FetchLike;
  signal: AbortSignal;
  budget: Budget;
};

type RefRec = { oid: string; peeled?: string };

function openTransport(url: ValidatedPublicRepoUrl, opts: NoCredential & {
  tracer: ViewerTracer;
  fetchImpl: FetchLike;
  signal: AbortSignal;
  quirks: Quirks;
}): GitTransport {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw fail('bad_request', 'remote must not carry credentials');
  return createGitTransport(url, { ...opts, userAgent: VIEWER_UA, limits: VIEWER_GIT_LIMITS });
}

function serverOf(info: { version: number; agent: string; objectFormat: string; caps: Map<string, string>; fetch: string[]; filter: boolean }): ServerInfo {
  return {
    agent: info.agent,
    protocol: info.version,
    objectFormat: info.objectFormat,
    caps: [...info.caps.keys()],
    fetchFeatures: info.fetch,
    filterAdvertised: info.filter,
  };
}

function toCommit(oid: string, data: Uint8Array): CommitInfo {
  const view = viewCommit(data);
  const author = view.author ?? { name: '', email: '', time: '', tz: '' };
  return {
    oid,
    tree: view.tree ?? '',
    parents: view.parents ?? [],
    authorName: author.name ?? '',
    authorEmail: author.email ?? '',
    authorTime: author.time ?? '',
    authorTz: author.tz ?? '',
    message: view.message ?? '',
    signed: !!view.signed,
  };
}

function headerFor(loc: RepoLocation, ref: string, commit: string, server: ServerInfo): RepoHeader {
  return { host: loc.host, repoPath: loc.repoPath, ref, commit, treeHref: viewerHref(loc.host, loc.repoPath, { ref }), server };
}

function refPrefixes(ref: string | null): string[] {
  const prefixes = new Set<string>(['HEAD', 'refs/heads/']);
  for (const cand of candidates(ref)) {
    if (cand === 'HEAD') continue;
    if (cand.startsWith('refs/tags/')) prefixes.add('refs/tags/');
    else prefixes.add(cand);
  }
  return [...prefixes];
}

function resolveRef(refs: Map<string, RefRec>, head: string | null, ref: string | null): { name: string; commit: string } {
  const cands = candidates(ref);
  if (!cands.length) return { name: ref ?? '', commit: ref ?? '' };
  for (const cand of cands) {
    const rec = refs.get(cand);
    if (!rec) continue;
    return { name: cand === 'HEAD' ? (head ?? 'HEAD') : cand, commit: rec.peeled ?? rec.oid };
  }
  throw fail('not_found', cands[0] === 'HEAD' ? 'remote HEAD is unborn or absent; pass ref explicitly' : `ref ${ref} not found`);
}

async function loadTreeBytes(transport: GitTransport, oid: string, cache: Map<string, Uint8Array>): Promise<Uint8Array> {
  const hit = cache.get(oid);
  if (hit) return hit;
  const obj = await readObject(transport, { oid, filter: 'tree:0', expectType: TYPE.TREE });
  cache.set(oid, obj.data);
  return obj.data;
}

function listed(entries: { name: string; mode: string; oid: string }[]): { shown: TreeEntry[]; truncated: number } {
  if (entries.length > VIEWER_GIT_LIMITS.maxTreeEntries) throw limitError('tree entries', entries.length, VIEWER_GIT_LIMITS.maxTreeEntries);
  const mapped: TreeEntry[] = entries.map(entry => ({ name: entry.name, mode: treeMode(entry.mode), oid: entry.oid, type: treeEntryType(entry.mode) }));
  mapped.sort((a, b) => (a.type === 'tree' ? 0 : 1) - (b.type === 'tree' ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { shown: mapped.slice(0, VIEWER_CAPS.maxTreeShown), truncated: Math.max(0, mapped.length - VIEWER_CAPS.maxTreeShown) };
}

async function readBlob(transport: GitTransport, tracer: ViewerTracer, oid: string): Promise<{ size: number; bytes: Uint8Array | null; tooBig: boolean }> {
  const span = tracer.start('git.viewer.blob', { attrs: { 'git.read.blob.oid': oid } });
  const fetchSpan = tracer.start('git.upload-pack fetch', { parent: span, kind: 3 });
  const it = streamPack(transport, { wants: [oid], ofsDelta: true, thinPack: false }, fetchSpan)[Symbol.asyncIterator]();
  let sp = cursorInit();
  const early: Uint8Array[] = [];
  try {
    while (sp.phase !== 'body') {
      const step = await it.next();
      if (step.done) throw fail('pack_corrupt', 'pack ended before the object header');
      const r = cursorStep(sp, step.value);
      sp = r.state;
      early.push(...r.zlib);
    }
    if (sp.type !== TYPE.BLOB) throw fail('pack_corrupt', `expected blob, got type ${sp.type}`);
    if (sp.size > VIEWER_CAPS.maxFileDisplayBytes) {
      span.set({ 'git.viewer.blob.too_big': true, 'git.viewer.blob.size': sp.size });
      await it.return?.().catch(() => {});
      fetchSpan.set({ 'git.viewer.blob.too_big': true, 'git.viewer.blob.size': sp.size });
      fetchSpan.end();
      span.end();
      return { size: sp.size, bytes: null, tooBig: true };
    }
    const zlibParts = early;
    let zlibLen = early.reduce((n, c) => n + c.byteLength, 0);
    for (;;) {
      const step = await it.next();
      if (step.done) break;
      const r = cursorStep(sp, step.value);
      sp = r.state;
      for (const z of r.zlib) { zlibParts.push(z); zlibLen += z.byteLength; }
      if (zlibLen > VIEWER_CAPS.maxFileDisplayBytes + 64 * 1024) throw limitError('compressed object bytes', zlibLen, VIEWER_CAPS.maxFileDisplayBytes);
    }
    sp = cursorFinish(sp);
    const { out } = inflateObject(concat(zlibParts), 0, { expectedSize: sp.size, maxOutput: VIEWER_CAPS.maxFileDisplayBytes });
    const got = hashObject('blob', out);
    if (got !== oid) throw fail('pack_corrupt', `blob content hashes to ${got}, not ${oid}`);
    fetchSpan.end();
    span.set({ 'git.viewer.blob.size': sp.size });
    span.end();
    return { size: sp.size, bytes: out, tooBig: false };
  } catch (err) {
    await it.return?.().catch(() => {});
    fetchSpan.error(err).end();
    span.error(err).end();
    throw err;
  }
}

function asText(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

async function loadParents(transport: GitTransport, budget: Budget, first: CommitInfo, quirks: Quirks): Promise<{ log: CommitInfo[]; logStopped: boolean }> {
  const log = [first];
  let parent = first.parents[0];
  while (parent && log.length < VIEWER_CAPS.maxLogCommits) {
    if (quirks.treeFilter === 'blob:none' || !budget.canSpend()) return { log, logStopped: true };
    try {
      const obj = await readObject(transport, { oid: parent, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT });
      const commit = toCommit(parent, obj.data);
      log.push(commit);
      parent = commit.parents[0];
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'limit_exceeded' || code === 'timeout' || code === 'aborted') throw err;
      return { log, logStopped: true };
    }
  }
  return { log, logStopped: false };
}

async function loadTree(transport: GitTransport, route: Extract<ViewerRoute, { kind: 'repo' }>, server: ServerInfo, quirks: Quirks, budget: Budget, tracer: ViewerTracer): Promise<Loaded> {
  const listedRefs = await listRefs(transport, refPrefixes(route.ref));
  const resolved = resolveRef(listedRefs.refs, listedRefs.head, route.ref);
  const commitObj = await readObject(transport, { oid: resolved.commit, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT });
  const commit = toCommit(resolved.commit, commitObj.data);
  const header = headerFor(route.loc, resolved.name, resolved.commit, server);
  const cache = new Map<string, Uint8Array>();
  const comps = route.path ? route.path.split('/') : [];
  let treeOid = commit.tree;
  let file: { mode: string; oid: string } | null = null;
  for (let depth = 0; depth < comps.length; depth++) {
    const name = comps[depth] ?? '';
    const data = await loadTreeBytes(transport, treeOid, cache);
    const entries = parseTree(data);
    if (entries.length > VIEWER_GIT_LIMITS.maxTreeEntries) throw limitError('tree entries', entries.length, VIEWER_GIT_LIMITS.maxTreeEntries);
    const entry = entries.find((item: { name: string }) => item.name === name);
    if (!entry) throw fail('not_found', `path component ${name} not found`);
    const last = depth === comps.length - 1;
    if (!last) {
      if (entry.mode !== '40000') throw fail('not_found', `${name} is not a directory`);
      treeOid = entry.oid;
      continue;
    }
    if (entry.mode === '40000') treeOid = entry.oid;
    else file = { mode: entry.mode, oid: entry.oid };
  }
  if (file) {
    const mode = treeMode(file.mode);
    if (file.mode === '160000') {
      if (route.raw) throw fail('not_found', 'submodule has no blob in this repository');
      return { kind: 'file', header, path: route.path, mode, blob: file.oid, size: 0, note: 'submodule', text: null };
    }
    const blob = await readBlob(transport, tracer, file.oid);
    if (blob.tooBig || !blob.bytes) {
      if (route.raw) throw limitError('file bytes', blob.size, VIEWER_CAPS.maxFileDisplayBytes);
      return { kind: 'file', header, path: route.path, mode, blob: file.oid, size: blob.size, note: 'too-big', text: null };
    }
    if (route.raw) return { kind: 'raw', filename: safeFilename(route.path), bytes: blob.bytes, size: blob.size };
    const text = asText(blob.bytes);
    return { kind: 'file', header, path: route.path, mode, blob: file.oid, size: blob.size, note: text === null ? 'binary' : 'text', text };
  }
  if (route.raw) throw fail('bad_request', 'raw is a file view');
  const data = await loadTreeBytes(transport, treeOid, cache);
  const parsed = parseTree(data);
  const entries = listed(parsed);
  let readme: { name: string; text: string } | { name: string; tooBig: true } | null = null;
  if (!route.path && budget.canSpend()) {
    const hit = parsed.find((entry: { name: string; mode: string; oid: string }) => (entry.name === 'README.md' || entry.name === 'README') && entry.mode !== '40000' && entry.mode !== '160000');
    if (hit) {
      try {
        const blob = await readBlob(transport, tracer, hit.oid);
        if (blob.tooBig || !blob.bytes) readme = { name: hit.name, tooBig: true };
        else {
          const text = asText(blob.bytes);
          readme = text === null ? { name: hit.name, tooBig: true } : { name: hit.name, text: clampText(text, 20_000) };
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'limit_exceeded' || code === 'timeout' || code === 'aborted') throw err;
        readme = null;
      }
    }
  }
  const heads = [];
  for (const [name, rec] of listedRefs.refs) {
    if (!name.startsWith('refs/heads/')) continue;
    heads.push({ name, oid: rec.oid, head: name === listedRefs.head });
  }
  heads.sort((a, b) => Number(b.head) - Number(a.head) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const branches = heads.slice(0, VIEWER_CAPS.maxBranchesShown);
  const { log, logStopped } = await loadParents(transport, budget, commit, quirks);
  return {
    kind: 'tree', header, path: route.path, commit, log, logStopped, branches,
    branchesTruncated: heads.length - branches.length,
    entries: entries.shown,
    entriesTruncated: entries.truncated,
    readme,
  };
}

async function loadPack(transport: GitTransport, route: Extract<ViewerRoute, { kind: 'repo' }>, server: ServerInfo, quirks: Quirks): Promise<Loaded> {
  const pack = route.pack;
  if (!pack) throw fail('internal', 'pack view without a want');
  const want = pack.want;
  const requested: FilterName = pack.filter;
  const common = { wants: [want], deepen: 1, ofsDelta: true as const, thinPack: false as const };
  let honoured: FilterName = requested;
  let result;
  if (requested === 'tree:0') {
    try {
      result = await readPack(transport, { ...common, filter: 'tree:0' }, { resolve: false });
    } catch (err) {
      if (!filterRejected(err)) throw err;
      quirks.treeFilter = 'blob:none';
      honoured = 'blob:none';
      result = await readPack(transport, { ...common, filter: 'blob:none' }, {
        resolve: false,
        attrs: { 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': 'tree:0', 'git.fetch.filter.learned': true },
      });
    }
  } else {
    result = await readPack(transport, { ...common, filter: 'blob:none' }, { resolve: false });
  }
  if (!result?.parsed) throw fail('pack_corrupt', 'server sent no pack');
  return {
    kind: 'pack',
    header: headerFor(route.loc, route.ref ?? 'HEAD', want, server),
    want,
    filterRequested: requested,
    filterHonoured: honoured,
    map: mapParsed(result.parsed, VIEWER_GIT_LIMITS),
    offset: pack.offset,
    askedOfsDelta: true,
    askedThinPack: false,
  };
}

export async function loadRepo(route: Extract<ViewerRoute, { kind: 'repo' }>, deps: SessionDeps): Promise<Loaded> {
  const quirks: Quirks = {};
  const transport = openTransport(route.loc.url, { tracer: deps.tracer, fetchImpl: deps.fetchImpl, signal: deps.signal, quirks });
  const info = await discoverRepo(transport);
  const server = serverOf(info);
  if (route.pack) return loadPack(transport, route, server, quirks);
  return loadTree(transport, route, server, quirks, deps.budget, deps.tracer);
}
