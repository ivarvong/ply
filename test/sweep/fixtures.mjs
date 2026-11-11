// Bare repos and packs for the cells that are about to run. A repo whose stamp matches is left in place, so a
// second sweep does not rebuild a 16 MiB blob. The oracle file is git's own measurements: the pack a blob
// fetches as, the longest delta chain verify-pack reports, and each pack's object count and inflated sum.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_MAINTENANCE } from '../server.js';

const STAMP = 'sweep-3';
const WHEN = 1700000000;

/** @param {string[]} args @param {{ input?: Buffer | string }} [opts] */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', fail);
    // git closes stdin when it rejects the stream; the close handler reports why.
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') fail(error); });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error(`git ${args.slice(0, 8).join(' ')} exited ${code}: ${Buffer.concat(err).toString().slice(0, 800)}`));
      else resolve(Buffer.concat(out));
    });
    child.stdin.end(opts.input ?? '');
  });
}

/** @param {number} n */
function urandom(n) {
  const buf = Buffer.alloc(n);
  if (n === 0) return buf;
  const fd = openSync('/dev/urandom', 'r');
  try {
    let off = 0;
    while (off < n) {
      const got = readSync(fd, buf, off, n - off, null);
      if (got <= 0) throw new Error('urandom returned no bytes');
      off += got;
    }
  } finally {
    closeSync(fd);
  }
  return buf;
}

/** @param {string} dir */
function stamped(dir) {
  const path = join(dir, 'sweep-stamp');
  return existsSync(path) && readFileSync(path, 'utf8') === STAMP;
}

/** @param {string} dir */
async function bare(dir) {
  rmSync(dir, { recursive: true, force: true });
  await git(['init', '-q', '--bare', '-b', 'main', dir]);
  const cfg = [
    ['uploadpack.allowFilter', 'true'],
    ['uploadpack.allowAnySHA1InWant', 'true'],
    ['http.receivepack', 'true'],
    ['protocol.version', '2'],
    ...NO_MAINTENANCE,
    ['core.bigFileThreshold', '2g'],
  ];
  for (const [key, value] of cfg) await git(['-C', dir, 'config', key, value]);
  writeFileSync(join(dir, 'sweep-stamp'), STAMP);
}

/** @param {string} ref @param {number} when @param {string} message @param {Buffer[]} ops */
function commit(ref, when, message, ops) {
  const head = Buffer.from(`commit ${ref}\ncommitter sweep <sweep@example.com> ${when} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`);
  return Buffer.concat([head, ...ops]);
}

/** @param {string} path @param {Buffer} data */
function inline(path, data) {
  return Buffer.concat([Buffer.from(`M 100644 inline ${path}\ndata ${data.length}\n`), data, Buffer.from('\n')]);
}

/** @param {string} dir @param {Buffer} stream */
async function fastImport(dir, stream) {
  await git(['-C', dir, 'fast-import', '--quiet', '--done'], { input: Buffer.concat([stream, Buffer.from('done\n')]) });
}

/** @param {string} repoGit @param {string} path */
async function blobPackBytes(repoGit, path) {
  const oid = (await git(['-C', repoGit, 'rev-parse', `main:${path}`])).toString().trim();
  const packed = await git(['-C', repoGit, 'pack-objects', '--stdout'], { input: `${oid}\n` });
  return packed.length;
}

/** @param {string} text */
function chainLength(text) {
  let max = 0;
  for (const line of text.split('\n')) {
    const m = /^chain length = (\d+)/.exec(line);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** @param {string} text */
function inflatedSum(text) {
  // verify-pack pads the type column, so a single space after the type only matches `commit`. Split instead.
  let inflated = 0;
  let objects = 0;
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const size = parts[2];
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0] ?? '') && size !== undefined && /^\d+$/.test(size)) { inflated += Number(size); objects++; }
  }
  return { inflated, objects };
}

/** The largest object verify-pack lists as a delta (a line with a depth and a base), sized by cat-file. @param {string} repoGit @param {string} text */
async function deltaResultMax(repoGit, text) {
  const oids = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 7 && /^[0-9a-f]{40}$/.test(parts[0] ?? '') && /^[0-9a-f]{40}$/.test(parts[6] ?? '')) oids.push(parts[0]);
  }
  if (oids.length === 0) return 0;
  const sizes = (await git(['-C', repoGit, 'cat-file', '--batch-check=%(objectsize)'], { input: `${oids.join('\n')}\n` })).toString().trim().split('\n');
  return Math.max(...sizes.map(Number));
}

/**
 * @param {string} repoGit
 * @param {string} packPath
 * @param {number} depth
 * @param {'ofs' | 'ref'} kind
 * @param {number} window
 */
async function writePack(repoGit, packPath, depth, kind, window) {
  const list = await git(['-C', repoGit, 'rev-list', '--objects', '--all']);
  const args = ['-C', repoGit, 'pack-objects', '-q', '--stdout', '--no-reuse-delta', `--depth=${depth}`, `--window=${window}`];
  if (kind === 'ofs') args.push('--delta-base-offset');
  const packed = await git(args, { input: list });
  writeFileSync(packPath, packed);
  const idx = packPath.replace(/\.pack$/, '.idx');
  await git(['index-pack', '-o', idx, packPath]);
  const verified = (await git(['verify-pack', '-v', idx])).toString();
  return { chain: chainLength(verified), sum: inflatedSum(verified), deltaMax: await deltaResultMax(repoGit, verified) };
}

/** @param {string} root @param {string} name @param {Record<string, number>} wires */
async function buildRepo(root, name, wires) {
  const dir = join(root, `${name}.git`);
  if (!stamped(dir)) {
    await bare(dir);
    const caps = /^cap-([a-z]+)--(.+)$/.exec(name);
    const body = repoStream(caps ? caps[2] : name);
    if (body.length > 0) await fastImport(dir, body);
    // a server without one capability ply can use; the content is the named fixture's
    if (caps) for (const [key, value] of CAP_MODES[caps[1]] ?? []) await git(['-C', dir, 'config', key, value]);
  }
  // Measured even when the repo was reused: the oracle file is the only copy of the pack size.
  if (name.startsWith('blob-') && wires[name] === undefined) wires[name] = await blobPackBytes(dir, 'big.bin');
}

/** @type {Record<string, [string, string][]>} */
const CAP_MODES = {
  nofilter: [['uploadpack.allowFilter', 'false']],
  nosha: [['uploadpack.allowAnySHA1InWant', 'false'], ['uploadpack.allowReachableSHA1InWant', 'false'], ['uploadpack.allowTipSHA1InWant', 'false']],
  reachable: [['uploadpack.allowAnySHA1InWant', 'false'], ['uploadpack.allowReachableSHA1InWant', 'true']],
  nopush: [['http.receivepack', 'false']],
};

/** @param {number} lines @param {number} version */
function thinText(lines, version) {
  const out = [];
  for (let i = 0; i < lines; i++) out.push(i % 97 === version ? `line ${i} edited in v${version}` : `line ${String(i).padStart(5, '0')} ${'t'.repeat(56)}`);
  return Buffer.from(`${out.join('\n')}\n`);
}

/** @param {string} name */
function repoStream(name) {
  if (name === 'empty') return Buffer.alloc(0);
  if (name === 'thin-remote' || name === 'thin-local') {
    // the same first commit in both (same bytes, same time: same oid); the local one has a second that edits the file
    const parts = [commit('refs/heads/main', WHEN, 'v1', [inline('t.txt', thinText(1024, 1))])];
    if (name === 'thin-local') parts.push(commit('refs/heads/main', WHEN + 1, 'v2', [inline('t.txt', thinText(1024, 2))]));
    return Buffer.concat(parts);
  }
  if (name.startsWith('octo-')) {
    // one commit with N parents, each its own root commit (a distinct empty-tree commit), reachable only through it
    const n = Number(name.slice('octo-'.length));
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(Buffer.from(`reset refs/heads/tmp\n`), Buffer.concat([Buffer.from(`commit refs/heads/tmp\nmark :${i + 1}\ncommitter sweep <sweep@example.com> ${WHEN} +0000\ndata ${String(i).length + 1}\nr${i}\n`)]));
    const merges = Array.from({ length: n - 1 }, (_, i) => `merge :${i + 2}\n`).join('');
    parts.push(Buffer.from(`commit refs/heads/main\ncommitter sweep <sweep@example.com> ${WHEN + 1} +0000\ndata 4\nocto\nfrom :1\n${merges}`), inline('f.txt', Buffer.from('o\n')));
    parts.push(Buffer.from('reset refs/heads/tmp\nfrom 0000000000000000000000000000000000000000\n\n'));
    return Buffer.concat(parts);
  }
  if (name.startsWith('branches-')) {
    // main plus N - 1 more branches at the same commit: a push of all of them is N commands and N + 1 report lines
    const n = Number(name.slice('branches-'.length));
    const parts = [commit('refs/heads/main', WHEN, 'branches', [inline('f.txt', Buffer.from('b\n'))])];
    for (let i = 0; i < n - 1; i++) parts.push(Buffer.from(`reset refs/heads/b${String(i).padStart(6, '0')}\nfrom refs/heads/main\n\n`));
    return Buffer.concat(parts);
  }
  if (name.startsWith('blob-')) {
    const size = Number(name.slice('blob-'.length));
    return commit('refs/heads/main', WHEN, 'blob', [inline('big.bin', urandom(size)), inline('small.txt', Buffer.from('hello\n'))]);
  }
  if (name.startsWith('tree-')) {
    const entries = Number(name.slice('tree-'.length));
    if (entries === 0) return commit('refs/heads/main', WHEN, 'empty', []);
    const blob = Buffer.concat([Buffer.from('blob\nmark :1\ndata 1\nx\n')]);
    const ops = [];
    for (let i = 0; i < entries; i++) ops.push(Buffer.from(`M 100644 :1 e${String(i).padStart(7, '0')}\n`));
    return Buffer.concat([blob, commit('refs/heads/main', WHEN, 'tree', ops)]);
  }
  if (name.startsWith('depth-')) {
    const depth = Number(name.slice('depth-'.length));
    const path = depth === 1 ? 'f.txt' : `${Array.from({ length: depth - 1 }, () => 'd').join('/')}/f.txt`;
    return commit('refs/heads/main', WHEN, 'depth', [inline(path, Buffer.from('deep\n'))]);
  }
  if (name.startsWith('comp-')) {
    const length = Number(name.slice('comp-'.length));
    return commit('refs/heads/main', WHEN, 'comp', [inline('a'.repeat(length), Buffer.from('c'))]);
  }
  if (name.startsWith('log-')) {
    const n = Number(name.slice('log-'.length));
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(commit('refs/heads/main', WHEN + i, `c${i}`, [inline('f.txt', Buffer.from(`${i}\n`))]));
    return Buffer.concat(parts);
  }
  if (name.startsWith('refs-')) {
    const n = Number(name.slice('refs-'.length));
    const parts = [commit('refs/heads/main', WHEN, 'refs', [inline('f.txt', Buffer.from('r\n'))])];
    for (let i = 0; i < n - 1; i++) parts.push(Buffer.from(`reset refs/tags/t${String(i).padStart(6, '0')}\nfrom refs/heads/main\n\n`));
    return Buffer.concat(parts);
  }
  if (name.startsWith('mb-')) {
    const k = Number(name.slice('mb-'.length));
    const parts = [commit('refs/heads/main', WHEN, 'base', [inline('a.txt', Buffer.from('a\n')), inline('b.txt', Buffer.from('b\n'))])];
    parts.push(Buffer.from('reset refs/heads/feat\nfrom refs/heads/main\n\n'));
    for (let i = 0; i < k; i++) parts.push(commit('refs/heads/main', WHEN + 10 + i, `m${i}`, [inline('a.txt', Buffer.from(`a${i}\n`))]));
    for (let i = 0; i < k; i++) parts.push(commit('refs/heads/feat', WHEN + 10 + i, `f${i}`, [inline('b.txt', Buffer.from(`b${i}\n`))]));
    return Buffer.concat(parts);
  }
  if (name.startsWith('mblob-')) {
    const size = Number(name.slice('mblob-'.length));
    const trio = mergeTrio(size);
    const parts = [commit('refs/heads/main', WHEN, 'base', [inline('big.txt', trio.base)])];
    parts.push(Buffer.from('reset refs/heads/feat\nfrom refs/heads/main\n\n'));
    parts.push(commit('refs/heads/main', WHEN + 1, 'ours', [inline('big.txt', trio.ours)]));
    parts.push(commit('refs/heads/feat', WHEN + 2, 'theirs', [inline('big.txt', trio.theirs)]));
    return Buffer.concat(parts);
  }
  if (name.startsWith('edit-')) {
    const size = Number(name.slice('edit-'.length));
    return commit('refs/heads/main', WHEN, 'edit', [inline('e.txt', editBody(size))]);
  }
  if (name === 'push-empty') return commit('refs/heads/main', WHEN, 'empty', []);
  if (name === 'inflate') {
    const ops = [];
    for (let i = 0; i < 6; i++) ops.push(inline(`b${i}.bin`, Buffer.alloc(1000, 0x30 + i)));
    return commit('refs/heads/main', WHEN, 'inflate', ops);
  }
  if (name.startsWith('tiny-')) {
    // n distinct 7-byte blobs, 1000 to a directory
    const n = Number(name.slice('tiny-'.length));
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(Buffer.from(`blob\nmark :${i + 1}\ndata 7\n${String(i).padStart(7, '0')}\n`));
    const ops = [];
    for (let i = 0; i < n; i++) ops.push(Buffer.from(`M 100644 :${i + 1} d${Math.floor(i / 1000)}/f${i}\n`));
    parts.push(commit('refs/heads/main', WHEN, 'tiny', ops));
    return Buffer.concat(parts);
  }
  if (name === 'chain-src') return chainStream(80, 80);
  if (name === 'chain-long') return chainStream(300, 1000);
  throw new Error(`no fixture builder for ${name}`);
}

/** @param {number} versions @param {number} lines */
function chainStream(versions, lines) {
  const body = Array.from({ length: lines }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(48)}`);
  const parts = [];
  for (let v = 0; v < versions; v++) {
    body[v % lines] = `line ${String(v % lines).padStart(4, '0')} changed ${String(v).padStart(4, '0')} ${'y'.repeat(40)}`;
    parts.push(commit('refs/heads/main', WHEN + v, `v${v}`, [inline('f.txt', Buffer.from(`${body.join('\n')}\n`))]));
  }
  return Buffer.concat(parts);
}

/** @param {number} size */
function editBody(size) {
  const needle = Buffer.from('NEEDLE\n');
  if (size < needle.length) throw new Error(`edit fixture ${size} is shorter than the needle`);
  const left = Math.floor((size - needle.length) / 2);
  const right = size - needle.length - left;
  return Buffer.concat([Buffer.alloc(left, 0x71), needle, Buffer.alloc(right, 0x72)]);
}

/** @param {number} size */
function mergeTrio(size) {
  // Three lines: a changed first line, one unchanged line, a changed last line. Adjacent edits conflict
  // ("both sides changed the same lines"), and a middle of millions of short lines makes the diff itself
  // the cost. One unchanged line keeps the merge to three records whatever the file size is.
  const head = 5;
  const tail = 5;
  if (size < head + tail + 2) throw new Error(`merge fixture ${size} needs two lines and a separator`);
  const middleLen = size - head - tail;
  const mid = Buffer.alloc(middleLen, 0x7a);
  mid[middleLen - 1] = 0x0a;
  const file = (h, t) => Buffer.concat([Buffer.from(h), mid, Buffer.from(t)]);
  return { base: file('AAAA\n', 'AAAA\n'), ours: file('OOOO\n', 'AAAA\n'), theirs: file('AAAA\n', 'TTTT\n') };
}

/**
 * @param {string} root
 * @param {{ repo?: string, pack?: string, local?: string, store?: string }[]} cells
 */
export async function ensureFixtures(root, cells) {
  mkdirSync(root, { recursive: true });
  const oraclePath = join(root, 'oracle.json');
  /** @type {{ wires: Record<string, number>, chains: Record<string, number>, sums: Record<string, { inflated: number, objects: number }>, deltaMax: Record<string, number> }} */
  const oracle = { wires: {}, chains: {}, sums: {}, deltaMax: {}, ...(existsSync(oraclePath) ? JSON.parse(readFileSync(oraclePath, 'utf8')) : {}) };
  oracle.deltaMax ??= {};
  const repos = [...new Set(cells.flatMap(c => [c.repo, c.local, c.store]).filter(Boolean))];
  for (const name of repos) await buildRepo(root, name, oracle.wires);
  const packs = [...new Set(cells.map(c => c.pack).filter(Boolean))];
  if (packs.length > 0) {
    mkdirSync(join(root, 'packs'), { recursive: true });
    if (packs.some(id => !id.startsWith('long-') && !id.startsWith('tiny-') && id !== 'inflate')) await buildRepo(root, 'chain-src', oracle.wires);
    for (const id of packs.filter(p => p.startsWith('tiny-'))) await buildRepo(root, id, oracle.wires);
    if (packs.some(id => id.startsWith('long-'))) await buildRepo(root, 'chain-long', oracle.wires);
    if (packs.includes('inflate')) await buildRepo(root, 'inflate', oracle.wires);
    for (const id of packs) {
      const packPath = join(root, 'packs', `${id}.pack`);
      if (existsSync(packPath) && oracle.chains[id] !== undefined && oracle.sums[id] !== undefined && oracle.deltaMax[id] !== undefined) continue;
      // writePack runs git index-pack on the pack: git accepts every pack a cell parses
      const built = await buildOnePack(root, id, packPath);
      oracle.chains[id] = built.chain;
      oracle.sums[id] = built.sum;
      oracle.deltaMax[id] = built.deltaMax;
    }
  }
  writeFileSync(oraclePath, `${JSON.stringify(oracle)}\n`);
  return oracle;
}

/** @param {string} root @param {string} id @param {string} packPath */
async function buildOnePack(root, id, packPath) {
  if (id === 'inflate' || id.startsWith('tiny-')) return writePack(join(root, `${id}.git`), packPath, 0, 'ofs', 0);
  const long = id.startsWith('long-');
  const rest = long ? id.slice('long-'.length) : id;
  const m = /^d(\d+)-(ofs|ref)$/.exec(rest);
  if (!m) throw new Error(`bad pack id ${id}`);
  const repo = join(root, long ? 'chain-long.git' : 'chain-src.git');
  const window = long ? 300 : 80;
  return writePack(repo, packPath, Number(m[1]), m[2] === 'ofs' ? 'ofs' : 'ref', window);
}
