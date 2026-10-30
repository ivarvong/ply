// Push a directory as one commit to a git smart-HTTP remote using only ply's primitives (no git binary).
// usage: node examples/push-tree.mjs <dir> <remote-url> [refs/heads/main] [token]
//   - new ref: created with the zero old-oid (the CAS "must not exist")
//   - existing ref: parent = current head, old oid = that head (CAS); objects the server already has (same oid in the
//     previous commit's tree) are left out of the pack, so a one-file change ships one blob + the trees on its path + the commit
//   - .gitignore files (root and nested) are honoured: comments, negation, anchoring, dir-only, *, ?, **; .git is always ignored
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import {
  createTransport, lsRefs, push, ZERO_OID, listTree, readCommit,
  hashObject, encodeTree, encodeCommit, ident, validateIdent, validatePath, TYPE, TYPE_NAME,
  Tracer, arrayExporter, flattenLine, DEFAULT_LIMITS,
} from '../src/index.js';

const [dir, url, ref = 'refs/heads/main', token] = process.argv.slice(2);
if (!dir || !url) { console.error('usage: node examples/push-tree.mjs <dir> <url> [ref] [token]'); process.exit(2); }

// ---- .gitignore (the common subset; last matching pattern wins, as in git) ----
const globToRe = g => {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { const slash = g[i + 2] === '/'; re += slash ? '(?:.*/)?' : '.*'; i += slash ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
};
// returns [{ re, neg, dirOnly }] relative to the directory the .gitignore lives in
function parseIgnore(text) {
  const rules = [];
  for (let line of text.split('\n')) {
    line = line.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let neg = false, dirOnly = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const re = new RegExp(anchored ? `^${globToRe(line)}$` : `(?:^|/)${globToRe(line)}$`);
    rules.push({ re, neg, dirOnly });
  }
  return rules;
}
// ignored(relPath, isDir, stack of [{ base, rules }] from root down)
const ignored = (rel, isDir, stack) => {
  let result = false;
  for (const { base, rules } of stack) {
    const sub = base ? (rel.startsWith(base + '/') ? rel.slice(base.length + 1) : null) : rel;
    if (sub === null) continue;
    for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(sub)) result = !r.neg;
  }
  return result;
};

// ---- directory → objects ----
const objects = new Map();   // oid → { type, data } (dedup: identical blobs appear once)
const put = (type, data) => { const oid = hashObject(TYPE_NAME[type], data); objects.set(oid, { type, data }); return oid; };
function treeOf(abs, root, stack) {
  const rel = posix.normalize(relative(root, abs).split('\\').join('/'));
  const gi = join(abs, '.gitignore');
  if (existsSync(gi)) stack = [...stack, { base: rel === '.' ? '' : rel, rules: parseIgnore(readFileSync(gi, 'utf8')) }];
  const entries = [];
  for (const name of readdirSync(abs)) {
    if (name === '.git') continue;
    const full = join(abs, name);
    const st = statSync(full);
    const r = rel === '.' ? name : `${rel}/${name}`;
    if (ignored(r, st.isDirectory(), stack)) continue;
    validatePath(r, DEFAULT_LIMITS);
    if (st.isDirectory()) { const oid = treeOf(full, root, stack); if (oid) entries.push({ mode: '40000', name, oid }); }
    else if (st.isFile()) entries.push({ mode: st.mode & 0o111 ? '100755' : '100644', name, oid: put(TYPE.BLOB, new Uint8Array(readFileSync(full))) });
    // symlinks and other kinds are skipped: a deploy artifact has no business carrying them
  }
  if (!entries.length) return null;   // git has no empty trees
  return put(TYPE.TREE, encodeTree(entries));
}

const tracer = new Tracer({ exporter: arrayExporter() });
const auth = token ? { user: 'x', token } : undefined;
const quirks = {};                                   // shared: a host's learned quirks (Artifacts' blob:none) are paid for once
const t = createTransport(url, { tracer, auth, quirks });

// 1. where is the ref now? (one v2 ls-refs; the old oid is the compare-and-swap value for the push)
const { refs } = await lsRefs(t, [ref]);
const head = refs.get(ref)?.oid ?? null;

// 2. objects
const tree = treeOf(dir, dir, []);
if (!tree) { console.error('nothing to push: every file is ignored'); process.exit(1); }
const who = validateIdent({ name: 'ply-deploy', email: 'deploy@example.invalid', time: Math.floor(Date.now() / 1000), tz: '+0000' });
// unchanged tree → no commit (git would make an empty commit; a deploy has nothing to deploy)
if (head && (await readCommit(url, { ref: head }, { tracer, auth, quirks })).tree === tree) { console.log(JSON.stringify({ ref, head, tree, noop: true })); process.exit(0); }
const commit = put(TYPE.COMMIT, encodeCommit({ tree, parents: head ? [head] : [], author: ident(who), message: `deploy ${new Date().toISOString()}\n` }));

// 3. leave out what the server already has: every tree and blob reachable from the previous commit's tree
const have = new Set();
if (head) {
  const cache = new Map();
  const walk = async path => {
    const { tree: oid, entries } = await listTree(url, { ref: head, path }, { cache, tracer, auth, quirks });
    have.add(oid);
    for (const e of entries) {
      if (e.type === 'tree') { if (!have.has(e.oid)) await walk(path ? `${path}/${e.name}` : e.name); }
      else have.add(e.oid);
    }
  };
  await walk('');
}
const send = [...objects].filter(([oid]) => !have.has(oid)).map(([, o]) => o);

// 4. one v0 receive-pack
const res = await push(t, { ref, oldOid: head ?? ZERO_OID, newOid: commit, objects: send });
const wire = tracer.exporter.lines.flatMap(flattenLine).filter(s => s.name.startsWith('git.') && s.attrs['git.request.bytes'] != null);
console.log(JSON.stringify({
  ref, oldOid: head ?? ZERO_OID, newCommit: commit, tree,
  objects: { total: objects.size, serverHad: objects.size - send.length, sent: send.length },
  packBytes: res.packBytes, unpack: res.report.unpack, refs: res.report.refs,
  roundTrips: wire.length, bytes: { out: wire.reduce((a, s) => a + s.attrs['git.request.bytes'], 0), in: wire.reduce((a, s) => a + (s.attrs['git.response.bytes'] ?? 0), 0) },
}, null, 2));
