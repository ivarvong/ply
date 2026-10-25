import { VIEWER_CAPS } from './limits.ts';
import { clampText, escapeHtml } from './escape.ts';
import type { CommitInfo, Loaded, TraceBar, TraceModel, TreeEntry } from './model.ts';
import type { PackMap, PackObjectView } from './packmap.ts';
import { ALLOWED_HOSTS, viewerHref } from './url.ts';

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/view.css"></head><body><header class="top"><a href="/view">ply</a><span>public repo viewer</span></header><main>${body}</main></body></html>`;
}

function href(host: string, repoPath: string, query: Record<string, string | undefined>): string {
  return escapeHtml(viewerHref(host, repoPath, query));
}

function short(oid: string): string {
  return oid.slice(0, 10);
}

function commitBlock(commit: CommitInfo): string {
  const subject = commit.message.split('\n')[0] ?? '';
  return `<p><strong>${escapeHtml(subject || '(no message)')}</strong></p><p class="muted">${escapeHtml(commit.authorName)} &lt;${escapeHtml(commit.authorEmail)}&gt; ${escapeHtml(commit.authorTime)} ${escapeHtml(commit.authorTz)}${commit.signed ? ' · signed' : ''}</p><pre class="msg">${escapeHtml(clampText(commit.message, 4000))}</pre>`;
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

export function renderTrace(trace: TraceModel, host: string, repoPath: string, ref: string | null): string {
  if (!trace.bars.length) return `<section class="card trace"><h2>Trace</h2><p class="muted">No upstream git calls.</p></section>`;
  const span = Math.max(trace.totalMs, 1);
  const rows = trace.bars.map(bar => {
    const left = Math.max(0, Math.min(100, Math.round((bar.startMs / span) * 100)));
    let width = Math.max(bar.durMs > 0 ? 1 : 0, Math.round((bar.durMs / span) * 100));
    if (left + width > 100) width = Math.max(1, 100 - left);
    const bits = [`${Math.round(bar.durMs)} ms`, bar.httpStatus === null ? '' : `HTTP ${bar.httpStatus}`, bar.bytes === null ? '' : `${bar.bytes} B`, bar.cache].filter(Boolean);
    const pack = bar.packWant && bar.packFilter ? ` · <a href="${href(host, repoPath, { ref: ref ?? undefined, want: bar.packWant, filter: bar.packFilter })}">pack map</a>` : '';
    return `<div class="row"><div>${escapeHtml(bar.name)}</div><div class="track"><div class="bar ${barClass(bar)} o${left} w${width}"></div></div><div class="meta">${escapeHtml(bits.join(' · '))}${pack}</div></div><p class="detail">${escapeHtml(bar.lines.join('\n'))}</p>`;
  }).join('');
  const fallback = trace.bars.some(bar => bar.lines.some(line => line.startsWith('git.fetch.filter.fallback=')));
  const note = fallback ? `<p class="banner">filter tree:0 was rejected. ply retried with blob:none, and the calls are serial — the same shape as a slow Workers trace.</p>` : '';
  return `<section class="card trace"><h2>Trace</h2><p class="muted">${Math.round(trace.totalMs)} ms of git round trips. cf-ray ${escapeHtml(trace.cfRay || 'n/a')} · request ${escapeHtml(trace.requestId || 'n/a')}</p>${note}${rows}</section>`;
}

function serverBox(loaded: Exclude<Loaded, { kind: 'raw' }>): string {
  const server = loaded.header.server;
  return `<p class="muted">protocol v${server.protocol} · agent ${escapeHtml(server.agent || 'unknown')} · object-format ${escapeHtml(server.objectFormat)} · filter ${server.filterAdvertised ? 'advertised' : 'not advertised'} · caps ${escapeHtml(server.caps.join(' ') || 'none')}</p>`;
}

function branchList(loaded: Extract<Loaded, { kind: 'tree' }>): string {
  const items = loaded.branches.map(branch => `<li>${branch.head ? '<strong>HEAD</strong> ' : ''}<a href="${href(loaded.header.host, loaded.header.repoPath, { ref: branch.name })}">${escapeHtml(branch.name)}</a> <span class="oid">${escapeHtml(short(branch.oid))}</span></li>`).join('');
  const more = loaded.branchesTruncated ? `<p class="muted">showing ${loaded.branches.length} of ${loaded.branches.length + loaded.branchesTruncated} branches</p>` : '';
  return `<section class="card"><h2>Branches</h2>${more}<ul class="refs">${items || '<li class="muted">no branches</li>'}</ul></section>`;
}

function logList(loaded: Extract<Loaded, { kind: 'tree' }>): string {
  const items = loaded.log.map(commit => `<li><a href="${href(loaded.header.host, loaded.header.repoPath, { ref: commit.oid })}">${escapeHtml(short(commit.oid))}</a> ${escapeHtml((commit.message.split('\n')[0] ?? '').slice(0, 120))}</li>`).join('');
  const stopped = loaded.logStopped ? `<p class="muted">log stopped (subrequest budget, or the server only honours blob:none)</p>` : '';
  return `<section class="card"><h2>Recent commits</h2>${stopped}<ul class="log">${items}</ul></section>`;
}

function entryRows(host: string, repoPath: string, ref: string, path: string, entries: TreeEntry[]): string {
  return entries.map(entry => {
    const child = path ? `${path}/${entry.name}` : entry.name;
    const label = entry.type === 'tree' ? `${entry.name}/` : entry.name;
    return `<tr><td>${escapeHtml(entry.mode)}</td><td><a href="${href(host, repoPath, { ref, path: child })}">${escapeHtml(label)}</a></td><td class="oid">${escapeHtml(entry.type)} ${escapeHtml(short(entry.oid))}</td></tr>`;
  }).join('');
}

function crumbs(host: string, repoPath: string, ref: string, path: string): string {
  const bits = [`<a href="${href(host, repoPath, { ref })}">${escapeHtml(repoPath)}</a>`];
  const parts = path ? path.split('/') : [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    bits.push(`<a href="${href(host, repoPath, { ref, path: acc })}">${escapeHtml(part)}</a>`);
  }
  return `<p class="crumbs">${bits.join(' / ')}</p>`;
}

function renderTree(loaded: Extract<Loaded, { kind: 'tree' }>, trace: TraceModel): string {
  const { header } = loaded;
  const more = loaded.entriesTruncated ? `<p class="muted">showing ${loaded.entries.length} of ${loaded.entries.length + loaded.entriesTruncated} entries</p>` : '';
  return shell(`${header.repoPath} at ${header.ref}`, `
    <h1>${escapeHtml(header.repoPath)}</h1>
    ${crumbs(header.host, header.repoPath, header.ref, loaded.path)}
    ${serverBox(loaded)}
    <p class="muted">ref ${escapeHtml(header.ref)} · commit ${escapeHtml(header.commit)} · <a href="${href(header.host, header.repoPath, { ref: header.ref, want: header.commit, filter: 'tree:0' })}">tree:0 pack</a> · <a href="${href(header.host, header.repoPath, { ref: header.ref, want: header.commit, filter: 'blob:none' })}">blob:none pack</a></p>
    <div class="card">${commitBlock(loaded.commit)}</div>
    ${logList(loaded)}
    ${branchList(loaded)}
    <section class="card"><h2>Tree ${escapeHtml(loaded.path || '/')}</h2>${more}<table class="files"><thead><tr><th>mode</th><th>name</th><th>object</th></tr></thead><tbody>${entryRows(header.host, header.repoPath, header.ref, loaded.path, loaded.entries)}</tbody></table></section>
    ${renderTrace(trace, header.host, header.repoPath, header.ref)}
    ${footer(trace)}
  `);
}

function renderFile(loaded: Extract<Loaded, { kind: 'file' }>, trace: TraceModel): string {
  const { header } = loaded;
  let body: string;
  if (loaded.note === 'submodule') body = `<p>Submodule (gitlink) ${escapeHtml(loaded.blob)}. This repository does not contain the blob.</p>`;
  else if (loaded.note === 'too-big') body = `<p>File is ${loaded.size} bytes, over the ${VIEWER_CAPS.maxFileDisplayBytes} byte display cap. It was not buffered.</p>`;
  else if (loaded.note === 'binary') body = `<p>Binary file, ${loaded.size} bytes. Not shown as text. <a href="${href(header.host, header.repoPath, { ref: header.ref, path: loaded.path, raw: '1' })}">raw bytes</a> (not HTML).</p>`;
  else {
    const lines = (loaded.text ?? '').split('\n');
    if (loaded.text?.endsWith('\n')) lines.pop();
    const shown = lines.slice(0, VIEWER_CAPS.maxLineRows);
    const rows = shown.map((line, i) => `<div><span class="ln">${i + 1}</span><span class="src">${escapeHtml(line)}</span></div>`).join('');
    const cut = lines.length > shown.length ? `<p class="muted">showing ${shown.length} of ${lines.length} lines</p>` : '';
    body = `${cut}<div class="code">${rows}</div><p><a href="${href(header.host, header.repoPath, { ref: header.ref, path: loaded.path, raw: '1' })}">raw</a></p>`;
  }
  return shell(loaded.path, `
    <h1>${escapeHtml(loaded.path)}</h1>
    ${crumbs(header.host, header.repoPath, header.ref, loaded.path)}
    ${serverBox(loaded)}
    <p class="muted">mode ${escapeHtml(loaded.mode)} · blob ${escapeHtml(loaded.blob)} · ${loaded.size} bytes · commit ${escapeHtml(short(header.commit))}</p>
    <section class="card">${body}</section>
    ${renderTrace(trace, header.host, header.repoPath, header.ref)}
    ${footer(trace)}
  `);
}

function objectDetail(obj: PackObjectView): string {
  const preview = obj.preview;
  let extra = '';
  if (preview?.kind === 'commit') extra = `<p>${escapeHtml(preview.summary)}</p><p class="muted">tree ${escapeHtml(preview.tree)} · parents ${escapeHtml(preview.parents.join(' ') || 'none')}</p>`;
  else if (preview?.kind === 'tree') extra = `<p class="muted">${escapeHtml(preview.names.join(', ') || '(empty tree)')}</p>`;
  else if (preview?.kind === 'blob') extra = preview.text !== null ? `<pre class="msg">${escapeHtml(preview.text)}</pre>` : `<p>Binary or large blob, ${obj.inflated} bytes inflated.</p>`;
  else if (preview?.kind === 'tag') extra = `<pre class="msg">${escapeHtml(preview.text)}</pre>`;
  else if (preview?.kind === 'unresolved') extra = `<p>Delta base is not in this pack.</p>`;
  return `<section class="card"><h2>Object at ${obj.offset}</h2><p>wire ${escapeHtml(obj.wireType)} · resolved ${escapeHtml(obj.resolvedType ?? 'unresolved')} · oid ${escapeHtml(obj.oid ?? 'n/a')}</p><p class="muted">header ${obj.headerBytes} B · compressed ${obj.compressed} B · inflated ${obj.inflated} B · chain ${obj.chain}${obj.baseOffset !== null ? ` · base @${obj.baseOffset}` : ''}${obj.baseOid ? ` · base ${escapeHtml(obj.baseOid)}` : ''}</p>${extra}</section>`;
}

function renderPack(loaded: Extract<Loaded, { kind: 'pack' }>, trace: TraceModel): string {
  const map: PackMap = loaded.map;
  const selected = loaded.offset === null ? null : map.objects.find(obj => obj.offset === loaded.offset) ?? null;
  const lengths = [map.headerLength, ...map.objects.map(obj => obj.length), map.trailerLength];
  const widths = portions(lengths);
  const segments: { cls: string; width: number; offset: number | null; label: string }[] = [
    { cls: 't-header', width: widths[0] ?? 0, offset: null, label: 'header' },
    ...map.objects.map((obj, i) => ({ cls: `t-${obj.wireType}`, width: widths[i + 1] ?? 0, offset: obj.offset, label: obj.wireType })),
    { cls: 't-trailer', width: widths[widths.length - 1] ?? 0, offset: null, label: 'trailer' },
  ];
  const bar = segments.map(segment => {
    const width = segment.width ?? 0;
    if (!width) return '';
    if (segment.offset === null) return `<span class="${segment.cls} w${width}"></span>`;
    const on = selected && segment.offset === selected.offset ? ' on' : '';
    return `<a class="${segment.cls}${on} w${width}" href="${href(loaded.header.host, loaded.header.repoPath, { ref: loaded.header.ref, want: loaded.want, filter: loaded.filterRequested, offset: String(segment.offset) })}" title="${escapeHtml(segment.label)} @${segment.offset}"></a>`;
  }).join('');
  const legend = ['header', 'commit', 'tree', 'blob', 'tag', 'ofs_delta', 'ref_delta', 'trailer'].map(name => `<span><i class="sw t-${name}"></i>${name.replace('_', ' ')}</span>`).join('');
  const rows = map.objects.map(obj => `<tr><td><a href="${href(loaded.header.host, loaded.header.repoPath, { ref: loaded.header.ref, want: loaded.want, filter: loaded.filterRequested, offset: String(obj.offset) })}">${obj.offset}</a></td><td>${escapeHtml(obj.wireType)}</td><td>${escapeHtml(obj.resolvedType ?? '')}</td><td>${obj.compressed}</td><td>${obj.inflated}</td><td>${obj.chain}</td><td class="oid">${escapeHtml(obj.oid ? short(obj.oid) : obj.baseOid ? `base ${short(obj.baseOid)}` : obj.baseOffset !== null ? `@${obj.baseOffset}` : '')}</td></tr>`).join('');
  const links = map.links.map(link => `<li>delta @${link.deltaOffset} → ${link.baseOffset !== null ? `base @${link.baseOffset}` : `base ${escapeHtml(link.baseOid ?? '')}`} · depth ${link.depth}</li>`).join('');
  const choice = map.ofsDelta === 0 && map.refDelta === 0
    ? 'The server sent full objects only — no ofs-delta and no ref-delta.'
    : `The server used ${map.ofsDelta} ofs-delta and ${map.refDelta} ref-delta object${map.refDelta === 1 ? '' : 's'}.`;
  return shell(`pack ${short(loaded.want)}`, `
    <h1>Pack map</h1>
    <p class="crumbs"><a href="${href(loaded.header.host, loaded.header.repoPath, { ref: loaded.header.ref })}">${escapeHtml(loaded.header.repoPath)}</a></p>
    ${serverBox(loaded)}
    <p>want ${escapeHtml(loaded.want)} · asked ${escapeHtml(loaded.filterRequested)} · honoured ${escapeHtml(loaded.filterHonoured)} · client asked for ofs-delta and did not ask for a thin pack</p>
    <p>${map.count} objects · ${map.bytes} bytes · version ${map.version} · max chain ${map.maxChain} · trailer ${escapeHtml(map.trailer)}${map.thin ? ' · thin pack' : ''}${map.unresolved ? ' · unresolved ref-delta' : ''}</p>
    <p>${escapeHtml(choice)}</p>
    <div class="legend">${legend}</div>
    <div class="packbar">${bar}</div>
    ${selected ? objectDetail(selected) : '<p class="muted">Select a region to inspect that object.</p>'}
    <section class="card"><h2>Objects</h2><table class="files"><thead><tr><th>offset</th><th>wire</th><th>resolved</th><th>compressed</th><th>inflated</th><th>chain</th><th>oid</th></tr></thead><tbody>${rows}</tbody></table></section>
    <section class="card"><h2>Delta chains</h2><ul class="log">${links || '<li class="muted">no deltas</li>'}</ul></section>
    ${renderTrace(trace, loaded.header.host, loaded.header.repoPath, loaded.header.ref)}
    ${footer(trace)}
  `);
}

function footer(trace: TraceModel): string {
  return `<footer>caps: ${VIEWER_CAPS.maxUpstreamBytes} B upstream/page · ${VIEWER_CAPS.maxPackBytes} B pack · ${VIEWER_CAPS.maxPackObjects} objects · ${VIEWER_CAPS.maxFileDisplayBytes} B file · chain ${VIEWER_CAPS.maxDeltaChain} · ${VIEWER_CAPS.maxSubrequests} subrequests · ${VIEWER_CAPS.requestTimeoutMs} ms/call · ${VIEWER_CAPS.pageTimeoutMs} ms/page · ${VIEWER_CAPS.ratePerMinute}/min page · ${VIEWER_CAPS.packRatePerMinute}/min pack. cf-ray ${escapeHtml(trace.cfRay || 'n/a')}.</footer>`;
}

export function renderHome(error: string | null): string {
  const alert = error ? `<p class="banner error">${escapeHtml(error)}</p>` : '';
  return shell('ply viewer', `
    <h1>Read a public git repository</h1>
    <p>Paste an https smart-HTTP URL. Credentials are rejected, not forwarded. Supported hosts: ${escapeHtml(ALLOWED_HOSTS.join(', '))}.</p>
    ${alert}
    <form class="home" action="/view" method="get">
      <input type="url" name="remote" required placeholder="https://github.com/octocat/Hello-World.git" aria-label="Git URL">
      <input type="text" name="ref" placeholder="ref (optional)" aria-label="ref">
      <button type="submit">Open</button>
    </form>
    <p><a href="/view/github.com/octocat/Hello-World">github.com/octocat/Hello-World</a></p>
    <section class="card"><h2>Limits</h2><p class="muted">Fail closed. ${VIEWER_CAPS.maxUpstreamBytes} bytes and ${VIEWER_CAPS.maxSubrequests} upstream calls per page, packs mapped up to ${VIEWER_CAPS.maxPackBytes} bytes / ${VIEWER_CAPS.maxPackObjects} objects, files shown up to ${VIEWER_CAPS.maxFileDisplayBytes} bytes, delta chains to depth ${VIEWER_CAPS.maxDeltaChain}, ${VIEWER_CAPS.requestTimeoutMs} ms per call, ${VIEWER_CAPS.pageTimeoutMs} ms per page, ${VIEWER_CAPS.ratePerMinute} page views and ${VIEWER_CAPS.packRatePerMinute} pack maps per client per minute.</p></section>
  `);
}

export function renderError(status: number, code: string, message: string, trace: TraceModel, host = '', repoPath = '', ref: string | null = null): string {
  return shell(code, `<h1>${escapeHtml(code)}</h1><p class="banner error">${escapeHtml(message)}</p><p class="muted">HTTP ${status}</p>${renderTrace(trace, host, repoPath, ref)}${footer(trace)}`);
}

export function renderLoaded(loaded: Exclude<Loaded, { kind: 'raw' }>, trace: TraceModel): string {
  if (loaded.kind === 'tree') return renderTree(loaded, trace);
  if (loaded.kind === 'file') return renderFile(loaded, trace);
  return renderPack(loaded, trace);
}
