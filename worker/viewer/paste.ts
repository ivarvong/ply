// Turn a pasted locator into an https remote the allowlist can accept or reject.
// This does not widen the host check: validatePublicRepoUrl still runs on the result.
export type PastedRepo = { remote: string; ref?: string; path?: string };

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

function webPath(remote: string): PastedRepo {
  let u: URL;
  try { u = new URL(remote); }
  catch { return { remote }; }
  if (u.username || u.password || u.search || u.hash) return { remote };
  const parts = u.pathname.split('/').filter(part => part.length > 0).map(part => {
    try { return decodeURIComponent(part); }
    catch { return part; }
  });
  if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    const owner = parts[0] ?? '';
    const repo = parts[1] ?? '';
    const ref = parts[3] ?? '';
    const path = parts.slice(4).join('/');
    u.pathname = `/${owner}/${repo}`;
    return { remote: u.toString(), ref: ref || undefined, path: path || undefined };
  }
  return { remote: u.toString() };
}

/** https URL, github.com/owner/repo, owner/repo (github), or git@host:path with the ssh user dropped. */
export function interpretRemote(raw: string): PastedRepo {
  const text = raw.trim();
  if (!text) return { remote: text };
  const scp = /^git@([A-Za-z0-9.-]+):([^\\]+)$/.exec(text);
  if (scp?.[1] && scp[2] && !text.includes('://')) return webPath(`https://${scp[1]}/${scp[2].replace(/^\/+/, '')}`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return webPath(text);
  if (OWNER_REPO.test(text)) return { remote: `https://github.com/${text}` };
  if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/|$)/.test(text)) return webPath(`https://${text}`);
  return { remote: text };
}
