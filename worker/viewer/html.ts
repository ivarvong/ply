import { VIEWER_CAPS } from './limits.ts';
import { clampText, escapeHtml } from './escape.ts';
import { renderMarkdown } from './markdown.ts';
import type { CommitInfo, Loaded, TraceBar, TraceModel, TreeEntry } from './model.ts';
import type { PackMap, PackObjectView } from './packmap.ts';
import { VIEWER_JS } from './script.ts';
import { ALLOWED_HOSTS, viewerHref } from './url.ts';

const ICON_DIR = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1.4 2.4h5.1l1.3 1.6h6.8v9.2H1.4z"/></svg>';
const ICON_FILE = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 1.4h6.2L13 5.2v9.4H3zM8.8 2.1V5.4H12"/></svg>';

const EXAMPLES = [
  ['octocat/Hello-World', '/view/github.com/octocat/Hello-World'],
  ['sindresorhus/is', '/view/github.com/sindresorhus/is'],
  ['tj/commander.js', '/view/github.com/tj/commander.js'],
] as const;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/view.css"></head><body><header class="top"><a href="/view">ply</a><span>public repo viewer</span></header><main>${body}</main><script>${VIEWER_JS}</script></body></html>`;
}

function href(host: string, repoPath: string, query: Record<string, string | undefined>): string {
  return escapeHtml(viewerHref(host, repoPath, query));
}

function short(oid: string): string {
  return oid.slice(0, 7);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

function commitBlock(commit: CommitInfo): string {
  const subject = commit.message.split('\n')[0] ?? '';
  return `<p><strong>${escapeHtml(subject || '(no message)')}</strong></p><p class="muted">${escapeHtml(commit.authorName)} · ${escapeHtml(commit.authorTime)} ${escapeHtml(commit.authorTz)}${commit.signed ? ' · signed' : ''}</p><pre class="msg">${escapeHtml(clampText(commit.message, 4000))}</pre>`;
}

function portions(lengths: number[]): number[] {
  const total = lengths.reduce((sum, n) => sum + n, 0) || 1;
  const raw = lengths.map(n => (n / total) * 100);
  const floors = raw.map(n => Math.floor(n));
  let left = 100 - floors.reduce((sum, n) => sum + n, 0);
  const order = raw.map((n, i) => [n - (floors[i] ?? 0), i] as const).sort((a, b) => b[0] - a[0]);
  const out = floors.slice();
  for (let i = 0; i < left; i++) {
    const slot = order[i % order.length]?.[1] ?? 0;
    out[slot] = (out[slot] ?? 0) + 1;
  }
  return out;
}

function barClass(bar: TraceBar): string {
  if (bar.status === 'error' || (bar.httpStatus !== null && bar.httpStatus >= 400)) return 'c-err';
  if (bar.lines.some(line => line.startsWith('git.fetch.filter.fallback='))) return 'c-fallback';
  if (bar.cache === 'HIT') return 'c-hit';
  if (bar.name.includes('discover')) return 'c-discover';
  if (bar.name.includes('ls-refs')) return 'c-refs';
  return 'c-fetch';
}

function traceLabel(name: string): string {
  return name.replace(/^git\./, '');
}

export function renderTrace(trace: TraceModel, host: string, repoPath: string, ref: string | null): string {
  if (!trace.bars.length) return `<section class="card trace"><h2>Trace</h2><p class="muted">No upstream git calls.</p></section>`;
  const span = Math.max(trace.totalMs, 1);
  const fallbacks = trace.bars.filter(bar => bar.lines.some(line => line.startsWith('git.fetch.filter.fallback='))).length;
  const retry = fallbacks === 0 ? '' : fallbacks === 1 ? ' · 1 retry' : ` · ${fallbacks} retries`;
  const pill = `${trace.bars.length} upstream calls · ${formatDuration(trace.totalMs)}${retry}`;
  const rows = trace.bars.map(bar => {
    const left = Math.max(0, Math.min(100, Math.round((bar.startMs / span) * 100)));
    let width = Math.max(bar.durMs > 0 ? 1 : 0, Math.round((bar.durMs / span) * 100));
    if (left + width > 100) width = Math.max(1, 100 - left);
    const failed = bar.status === 'error' || (bar.httpStatus !== null && bar.httpStatus >= 400);
    const bits = [formatDuration(bar.durMs), bar.httpStatus === null ? '' : `HTTP ${bar.httpStatus}`, bar.bytes === null ? '' : formatBytes(bar.bytes), bar.cache && bar.cache !== 'n/a' ? bar.cache : ''].filter(Boolean);
    const tip = `${traceLabel(bar.name)} · ${bits.join(' · ')}`;
    const pack = bar.packWant && bar.packFilter ? ` <a href="${href(host, repoPath, { ref: ref ?? undefined, want: bar.packWant, filter: bar.packFilter })}">pack map</a>` : '';
    return `<details class="span${failed ? ' err' : ''}"><summary><span class="name">${escapeHtml(traceLabel(bar.name))}</span><span class="track" title="${escapeHtml(tip)}"><span class="bar ${barClass(bar)} o${left} w${width}"></span></span><span class="meta">${escapeHtml(bits.join(' · '))}${pack}</span></summary><pre class="detail">${escapeHtml(bar.lines.join('\n'))}</pre></details>`;
  }).join('');
  const note = fallbacks ? `<p class="banner">filter tree:0 was rejected. ply retried with blob:none. The calls are serial, which is why the waterfall is a staircase.</p>` : '';
  return `<details class="card trace" open><summary><span class="pill">${escapeHtml(pill)}</span></summary><p class="muted">cf-ray ${escapeHtml(trace.cfRay || 'n/a')} · request ${escapeHtml(trace.requestId || 'n/a')}</p>${note}${rows}</details>`;
}

function serverBox(loaded: Exclude<Loaded, { kind: 'raw' }>): string {
  const server = loaded.header.server;
  return `<p class="muted">protocol v${server.protocol} · agent ${escapeHtml(server.agent || 'unknown')} · ${escapeHtml(server.objectFormat)} · filter ${server.filterAdvertised ? 'advertised' : 'not advertised'}</p>`;
}

function branchSwitcher(loaded: Extract<Loaded, { kind: 'tree' | 'file' }>): string {
  const { header } = loaded;
  const action = href(header.host, header.repoPath, {});
  const path = loaded.path ? `<input type="hidden" name="path" value="${escapeHtml(loaded.path)}">` : '';
  const branches = 'branches' in loaded ? loaded.branches : [];
  const known = branches.some(branch => branch.name === header.ref || branch.name.replace(/^refs\/heads\//, '') === header.ref);
  const extra = known ? '' : `<option value="${escapeHtml(header.ref)}" selected>${escapeHtml(header.ref)}</option>`;
  const options = branches.map(branch => {
    const label = branch.name.replace(/^refs\/heads\//, '');
    const selected = branch.name === header.ref || label === header.ref ? ' selected' : '';
    return `<option value="${escapeHtml(branch.name)}"${selected}>${escapeHtml(label)}${branch.head ? ' (default)' : ''}</option>`;
  }).join('');
  const branchForm = branches.length || extra
    ? `<form action="${action}" method="get"><label>Branch <select name="ref" aria-label="Branch">${extra}${options}</select></label>${path}<button type="submit">Switch</button></form>`
    : '';
  return `<div class="switchers">${branchForm}<form action="${action}" method="get"><label>Tag or commit <input type="text" name="ref" placeholder="v1.0.0" aria-label="Tag or commit"></label>${path}<button type="submit" class="ghost">Open</button></form></div>`;
}

function logList(loaded: Extract<Loaded, { kind: 'tree' }>): string {
  const items = loaded.log.map(commit => `<li><a href="${href(loaded.header.host, loaded.header.repoPath, { ref: commit.oid })}">${escapeHtml(short(commit.oid))}</a> ${escapeHtml((commit.message.split('\n')[0] ?? '').slice(0, 120))}</li>`).join('');
  const stopped = loaded.logStopped ? `<p class="muted">Log stopped: the subrequest budget was spent, or the server only honours blob:none.</p>` : '';
  return `<section class="card"><h2>Recent commits</h2>${stopped}<ul class="log">${items}</ul></section>`;
}

function entryRows(host: string, repoPath: string, ref: string, path: string, entries: TreeEntry[]): string {
  return entries.map(entry => {
    const child = path ? `${path}/${entry.name}` : entry.name;
    const icon = entry.type === 'tree' ? ICON_DIR : ICON_FILE;
    const label = entry.type === 'tree' ? `${entry.name}/` : entry.name;
    return `<tr><td class="name">${icon}<a href="${href(host, repoPath, { ref, path: child })}">${escapeHtml(label)}</a></td><td class="oid">${escapeHtml(short(entry.oid))}</td></tr>`;
  }).join('');
}

function crumbs(host: string, repoPath: string, ref: string, path: string): string {
  const repoParts = repoPath.replace(/\.git$/, '').split('/');
  const bits = [`<a href="${href(host, repoPath, { ref })}">${escapeHtml(host)}</a>`];
  let repoAcc = '';
  for (const part of repoParts) {
    repoAcc = repoAcc ? `${repoAcc}/${part}` : part;
    bits.push(`<a href="${href(host, repoPath, { ref })}">${escapeHtml(part)}</a>`);
  }
  let acc = '';
  for (const part of path ? path.split('/') : []) {
    acc = acc ? `${acc}/${part}` : part;
    bits.push(`<a href="${href(host, repoPath, { ref, path: acc })}">${escapeHtml(part)}</a>`);
  }
  return `<p class="crumbs">${bits.join('<span class="sep">/</span>')}</p>`;
}

function readmeBlock(loaded: Extract<Loaded, { kind: 'tree' }>): string {
  const readme = loaded.readme;
  if (!readme) return '';
  if ('tooBig' in readme) return `<section class="card readme"><h2>${escapeHtml(readme.name)}</h2><p class="banner">This README is binary or larger than ${formatBytes(VIEWER_CAPS.maxFileDisplayBytes)}, so it is not rendered. Open the file to see the size.</p></section>`;
  return `<section class="card readme"><h2>${escapeHtml(readme.name)}</h2><div class="md">${renderMarkdown(readme.text)}</div></section>`;
}

function renderTree(loaded: Extract<Loaded, { kind: 'tree' }>, trace: TraceModel): string {
  const { header } = loaded;
  const more = loaded.entriesTruncated ? `<p class="muted">Showing ${loaded.entries.length} of ${loaded.entries.length + loaded.entriesTruncated} entries.</p>` : '';
  const empty = loaded.entries.length ? '' : '<p class="muted">This directory is empty.</p>';
  return shell(`${header.repoPath} at ${header.ref}`, `
    ${crumbs(header.host, header.repoPath, header.ref, loaded.path)}
    <div class="repo-head"><h1>${escapeHtml(header.repoPath.replace(/\.git$/, ''))}</h1>${branchSwitcher(loaded)}</div>
    ${serverBox(loaded)}
    <p class="muted">commit <a href="${href(header.host, header.repoPath, { ref: header.commit })}">${escapeHtml(short(header.commit))}</a> · <a href="${href(header.host, header.repoPath, { ref: header.ref, want: header.commit, filter: 'tree:0' })}">tree:0 pack</a> · <a href="${href(header.host, header.repoPath, { ref: header.ref, want: header.commit, filter: 'blob:none' })}">blob:none pack</a></p>
    <div class="card">${commitBlock(loaded.commit)}</div>
    <section class="card"><h2>Files</h2>${more}${empty}<table class="files"><thead><tr><th>Name</th><th>Object</th></tr></thead><tbody>${entryRows(header.host, header.repoPath, header.ref, loaded.path, loaded.entries)}</tbody></table></section>
    ${readmeBlock(loaded)}
    ${logList(loaded)}
    ${renderTrace(trace, header.host, header.repoPath, header.ref)}
    ${footer(trace)}
  `);
}

function renderFile(loaded: Extract<Loaded, { kind: 'file' }>, trace: TraceModel): string {
  const { header } = loaded;
  const rawHref = href(header.host, header.repoPath, { ref: header.ref, path: loaded.path, raw: '1' });
  let body: string;
  if (loaded.note === 'submodule') body = `<p class="banner">This is a submodule (gitlink) ${escapeHtml(loaded.blob)}. The blob is not in this repository.</p>`;
  else if (loaded.note === 'too-big') body = `<p class="banner">This file is ${formatBytes(loaded.size)}, over the ${formatBytes(VIEWER_CAPS.maxFileDisplayBytes)} display cap. It was not buffered. Open a smaller file, or fetch it with git.</p>`;
  else if (loaded.note === 'binary') body = `<p class="banner">Binary file, ${formatBytes(loaded.size)}. Not shown as text. <a href="${rawHref}">Download raw bytes</a> (not HTML).</p>`;
  else {
    const lines = (loaded.text ?? '').split('\n');
    if (loaded.text?.endsWith('\n')) lines.pop();
    const shown = lines.slice(0, VIEWER_CAPS.maxLineRows);
    const rows = shown.map((line, i) => {
      const n = i + 1;
      return `<div class="line" id="L${n}"><a class="ln" href="#L${n}">${n}</a><span class="src">${escapeHtml(line)}</span></div>`;
    }).join('');
    const cut = lines.length > shown.length ? `<p class="muted">Showing ${shown.length} of ${lines.length} lines.</p>` : '';
    body = `${cut}<div class="code" role="table" aria-label="File contents">${rows}</div>`;
  }
  return shell(loaded.path, `
    ${crumbs(header.host, header.repoPath, header.ref, loaded.path)}
    <div class="repo-head"><h1>${escapeHtml(loaded.path.split('/').pop() || loaded.path)}</h1>${branchSwitcher(loaded)}</div>
    ${serverBox(loaded)}
    <div class="filebar">
      <p class="muted">mode ${escapeHtml(loaded.mode)} · ${formatBytes(loaded.size)} · blob ${escapeHtml(short(loaded.blob))} · commit ${escapeHtml(short(header.commit))}</p>
      <p><a href="${rawHref}">Raw</a> · <button type="button" class="ghost" data-copy="">Copy permalink</button></p>
    </div>
    <section class="card">${body}<p class="muted">Line numbers link to <span class="oid">#L10</span>. Copy permalink includes the line you last opened.</p></section>
    ${renderTrace(trace, header.host, header.repoPath, header.ref)}
    ${footer(trace)}
  `);
}

function objectDetail(obj: PackObjectView): string {
  const preview = obj.preview;
  let extra = '';
  if (preview?.kind === 'commit') extra = `<p>${escapeHtml(preview.summary)}</p><p class="muted">tree ${escapeHtml(short(preview.tree))} · parents ${escapeHtml(preview.parents.map(short).join(' ') || 'none')}</p>`;
  else if (preview?.kind === 'tree') extra = `<p class="muted">${escapeHtml(preview.names.join(', ') || '(empty tree)')}</p>`;
  else if (preview?.kind === 'blob') extra = preview.text !== null ? `<pre class="msg">${escapeHtml(preview.text)}</pre>` : `<p>Binary or large blob, ${formatBytes(obj.inflated)} inflated.</p>`;
  else if (preview?.kind === 'tag') extra = `<pre class="msg">${escapeHtml(preview.text)}</pre>`;
  else if (preview?.kind === 'unresolved') extra = `<p>The delta base is not in this pack.</p>`;
  return `<section class="card" id="detail-${obj.offset}"><h2>Object at ${obj.offset}</h2><p>wire ${escapeHtml(obj.wireType.replace('_', ' '))} · resolved ${escapeHtml(obj.resolvedType ?? 'unresolved')} · oid ${escapeHtml(obj.oid ?? 'n/a')}</p><p class="muted">header ${formatBytes(obj.headerBytes)} · compressed ${formatBytes(obj.compressed)} · inflated ${formatBytes(obj.inflated)} · chain ${obj.chain}${obj.baseOffset !== null ? ` · base @${obj.baseOffset}` : ''}${obj.baseOid ? ` · base ${escapeHtml(short(obj.baseOid))}` : ''}</p>${extra}</section>`;
}

function renderPack(loaded: Extract<Loaded, { kind: 'pack' }>, trace: TraceModel): string {
  const map: PackMap = loaded.map;
  const selected = loaded.offset === null ? null : map.objects.find(obj => obj.offset === loaded.offset) ?? null;
  const lengths = [map.headerLength, ...map.objects.map(obj => obj.length), map.trailerLength];
  const widths = portions(lengths);
  const segments: { cls: string; width: number; offset: number | null; label: string; tip: string }[] = [
    { cls: 't-header', width: widths[0] ?? 0, offset: null, label: 'header', tip: `pack header · ${formatBytes(map.headerLength)}` },
    ...map.objects.map((obj, i) => ({
      cls: `t-${obj.wireType}`,
      width: widths[i + 1] ?? 0,
      offset: obj.offset,
      label: obj.wireType,
      tip: `${obj.wireType.replaceAll('_', ' ')} @${obj.offset} · ${formatBytes(obj.compressed)} compressed · ${formatBytes(obj.inflated)} inflated${obj.baseOffset !== null ? ` · base @${obj.baseOffset}` : ''}`,
    })),
    { cls: 't-trailer', width: widths[widths.length - 1] ?? 0, offset: null, label: 'trailer', tip: `checksum trailer · ${formatBytes(map.trailerLength)}` },
  ];
  const bar = segments.map(segment => {
    const width = segment.width ?? 0;
    if (!width) return '';
    if (segment.offset === null) return `<span class="${segment.cls} w${width}" title="${escapeHtml(segment.tip)}"></span>`;
    const on = selected && segment.offset === selected.offset ? ' on' : '';
    return `<a class="${segment.cls}${on} w${width}" href="#o${segment.offset}" title="${escapeHtml(segment.tip)}" aria-label="${escapeHtml(segment.tip)}"></a>`;
  }).join('');
  const legend = ['header', 'commit', 'tree', 'blob', 'tag', 'ofs_delta', 'ref_delta', 'trailer'].map(name => `<span><i class="sw t-${name}"></i>${escapeHtml(name.replace('_', ' '))}</span>`).join('');
  const rows = map.objects.map(obj => {
    const base = obj.baseOffset !== null ? ` data-base="${obj.baseOffset}"` : '';
    const on = selected && obj.offset === selected.offset ? ' class="on"' : '';
    return `<tr id="o${obj.offset}"${base}${on}><td><a href="#o${obj.offset}">${obj.offset}</a></td><td>${escapeHtml(obj.wireType.replaceAll('_', ' '))}</td><td>${escapeHtml(obj.resolvedType ?? '')}</td><td>${formatBytes(obj.compressed)}</td><td>${formatBytes(obj.inflated)}</td><td>${obj.chain}</td><td class="oid">${escapeHtml(obj.oid ? short(obj.oid) : obj.baseOid ? `base ${short(obj.baseOid)}` : obj.baseOffset !== null ? `@${obj.baseOffset}` : '')}</td></tr>`;
  }).join('');
  const links = map.links.map(link => `<li><a href="#o${link.deltaOffset}">delta @${link.deltaOffset}</a> → ${link.baseOffset !== null ? `<a href="#o${link.baseOffset}">base @${link.baseOffset}</a>` : `base ${escapeHtml(short(link.baseOid ?? ''))}`} · depth ${link.depth}</li>`).join('');
  const choice = map.ofsDelta === 0 && map.refDelta === 0
    ? 'The server sent full objects only — no ofs-delta and no ref-delta.'
    : `The server used ${map.ofsDelta} ofs-delta and ${map.refDelta} ref-delta object${map.refDelta === 1 ? '' : 's'}.`;
  return shell(`pack ${short(loaded.want)}`, `
    <h1>Pack map</h1>
    ${crumbs(loaded.header.host, loaded.header.repoPath, loaded.header.ref, '')}
    ${serverBox(loaded)}
    <p class="stats"><span><strong>${map.count}</strong> objects</span><span><strong>${formatBytes(map.bytes)}</strong></span><span>version ${map.version}</span><span>max chain ${map.maxChain}</span><span>${map.thin ? 'thin pack' : 'not thin'}</span></p>
    <p>want ${escapeHtml(short(loaded.want))} · asked ${escapeHtml(loaded.filterRequested)} · honoured ${escapeHtml(loaded.filterHonoured)} · client asked for ofs-delta and did not ask for a thin pack</p>
    <p>${escapeHtml(choice)} Click a segment to jump to its row. A delta highlights its base.</p>
    <div class="legend">${legend}</div>
    <div class="packbar" role="img" aria-label="Pack layout by object type">${bar}</div>
    ${selected ? objectDetail(selected) : '<p class="muted">Select a region to inspect that object.</p>'}
    <section class="card"><h2>Objects</h2><table class="files"><thead><tr><th>offset</th><th>wire</th><th>resolved</th><th>compressed</th><th>inflated</th><th>chain</th><th>oid</th></tr></thead><tbody>${rows}</tbody></table></section>
    <section class="card"><h2>Delta chains</h2><ul class="log">${links || '<li class="muted">no deltas</li>'}</ul></section>
    ${renderTrace(trace, loaded.header.host, loaded.header.repoPath, loaded.header.ref)}
    ${footer(trace)}
  `);
}

function footer(trace: TraceModel): string {
  return `<footer>Caps: ${formatBytes(VIEWER_CAPS.maxUpstreamBytes)} upstream/page · ${formatBytes(VIEWER_CAPS.maxPackBytes)} pack · ${VIEWER_CAPS.maxPackObjects} objects · ${formatBytes(VIEWER_CAPS.maxFileDisplayBytes)} file · chain ${VIEWER_CAPS.maxDeltaChain} · ${VIEWER_CAPS.maxSubrequests} subrequests · ${VIEWER_CAPS.requestTimeoutMs / 1000}s/call · ${VIEWER_CAPS.pageTimeoutMs / 1000}s/page · ${VIEWER_CAPS.ratePerMinute}/min page · ${VIEWER_CAPS.packRatePerMinute}/min pack. cf-ray ${escapeHtml(trace.cfRay || 'n/a')}.</footer>`;
}

function errorTitle(code: string, status: number): string {
  if (code === 'rate_limited' || status === 429) return 'Too many requests';
  if (code === 'not_found' || status === 404) return 'Not found';
  if (code === 'limit_exceeded' || status === 413) return 'Too big for this viewer';
  if (code === 'timeout' || status === 504) return 'The git host timed out';
  if (code === 'unavailable' || status === 503) return 'Viewer unavailable';
  if (code === 'bad_request' || status === 400) return 'That URL is not supported';
  return 'Something went wrong';
}

function errorHint(code: string, status: number, message: string): string {
  if (code === 'rate_limited' || status === 429) return 'Wait for the retry window, then open the repository again. The limit is per client.';
  if (code === 'unavailable' || status === 503) return 'The rate limiter is not available, so the viewer stops rather than fetching without a limit.';
  if (code === 'limit_exceeded' || status === 413) return 'Open a smaller path or a single file. Huge repositories and packs are refused on purpose.';
  if (code === 'timeout' || status === 504) return 'The git host did not answer in time. Try the same URL again.';
  if (code === 'not_found' || status === 404) return 'Check the owner, repository, branch, and path. Private repositories are not visible here.';
  if (/credentials/.test(message)) return 'Remove the username and password from the URL and paste it again. Credentials are never forwarded.';
  if (/allowlisted|Supported hosts/.test(message)) return 'Use one of the supported hosts. owner/repo by itself means github.com.';
  return 'Go back to the viewer and paste a public repository URL.';
}

export function renderHome(error: string | null): string {
  const alert = error ? `<p class="banner error">${escapeHtml(error)}</p>` : '';
  const chips = EXAMPLES.map(([label, hrefValue]) => `<a class="chip" href="${hrefValue}">${escapeHtml(label)}</a>`).join('');
  const hosts = ALLOWED_HOSTS.map(host => `<li>${escapeHtml(host)}</li>`).join('');
  return shell('ply viewer', `
    <h1>Read a public git repository</h1>
    <p class="hero">Paste a URL, <span class="oid">github.com/owner/repo</span>, or just <span class="oid">owner/repo</span>. Credentials are rejected, not forwarded.</p>
    ${alert}
    <form class="home" action="/view" method="get">
      <input class="big" type="text" name="remote" required placeholder="octocat/Hello-World" aria-label="Git URL" autofocus>
      <button type="submit">Open</button>
    </form>
    <nav class="chips" aria-label="Example repositories">${chips}</nav>
    <section class="card"><h2>Supported hosts</h2><ul class="hosts">${hosts}</ul><p class="muted">https, no username or password, port 443. A trailing dot or a lookalike host is rejected.</p></section>
    <section class="card"><h2>Limits</h2><p class="muted">Fail closed. ${formatBytes(VIEWER_CAPS.maxUpstreamBytes)} and ${VIEWER_CAPS.maxSubrequests} upstream calls per page, packs up to ${formatBytes(VIEWER_CAPS.maxPackBytes)} / ${VIEWER_CAPS.maxPackObjects} objects, files up to ${formatBytes(VIEWER_CAPS.maxFileDisplayBytes)}, delta chains to depth ${VIEWER_CAPS.maxDeltaChain}, ${VIEWER_CAPS.requestTimeoutMs / 1000}s per call, ${VIEWER_CAPS.pageTimeoutMs / 1000}s per page, ${VIEWER_CAPS.ratePerMinute} page views and ${VIEWER_CAPS.packRatePerMinute} pack maps per client per minute.</p></section>
  `);
}

export function renderError(status: number, code: string, message: string, trace: TraceModel, host = '', repoPath = '', ref: string | null = null): string {
  return shell(errorTitle(code, status), `
    <h1>${escapeHtml(errorTitle(code, status))}</h1>
    <p class="banner error">${escapeHtml(message)}</p>
    <p class="next">${escapeHtml(errorHint(code, status, message))} <a href="/view">Back to the viewer</a>.</p>
    <p class="muted">HTTP ${status}</p>
    ${renderTrace(trace, host, repoPath, ref)}
    ${footer(trace)}
  `);
}

export function renderLoaded(loaded: Exclude<Loaded, { kind: 'raw' }>, trace: TraceModel): string {
  if (loaded.kind === 'tree') return renderTree(loaded, trace);
  if (loaded.kind === 'file') return renderFile(loaded, trace);
  return renderPack(loaded, trace);
}
