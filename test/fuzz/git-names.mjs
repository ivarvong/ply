// git's own verdict on tree-entry names, for test/fuzz/dotnames.mjs. ply is not asked anything here.
// Each name becomes a one-entry tree `120000 <name>\0<oid of the empty blob>`, written as a loose object (node:crypto
// SHA-1, node:zlib deflate) into a fresh bare repository, and one `git fsck --strict --no-dangling` judges them all.
// A symlink entry makes fsck_tree (git fsck.c) name every check a name can trip, each from git's own is_hfs_* / is_ntfs_*:
//   hasDotgit             name is .git, or is_hfs_dotgit / is_ntfs_dotgit says so (any backslash-separated component too)
//   gitmodulesSymlink     is_hfs_dotgitmodules || is_ntfs_dotgitmodules (any backslash-separated component too)
//   gitignoreSymlink      is_hfs_dotgitignore || is_ntfs_dotgitignore
//   gitattributesSymlink  is_hfs_dotgitattributes || is_ntfs_dotgitattributes
//   mailmapSymlink        is_hfs_dotmailmap || is_ntfs_dotmailmap
// The verdict is those five as a 0/1 string, the order of dotnames-corpus.js's verdicts(). A name git cannot hold as
// one tree entry (empty, or with a NUL: the name ends at the first NUL) is not judged: its verdict is null.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const MSG_IDS = ['hasDotgit', 'gitmodulesSymlink', 'gitignoreSymlink', 'gitattributesSymlink', 'mailmapSymlink'];
const ENV = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };

function writeLoose(dir, type, body) {
  const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
  const oid = createHash('sha1').update(raw).digest('hex');
  const d = join(dir, 'objects', oid.slice(0, 2));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, oid.slice(2)), deflateSync(raw, { level: 1 }));
  return oid;
}

// names: Uint8Array[] → (string | null)[], one verdict per name in order
export function gitNameVerdicts(names) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-git-names-'));
  try {
    const init = spawnSync('git', ['init', '-q', '--bare', dir], { env: ENV, encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    const blob = Buffer.from(writeLoose(dir, 'blob', Buffer.alloc(0)), 'hex');
    const oids = names.map(b => (b.length === 0 || b.includes(0) ? null : writeLoose(dir, 'tree', Buffer.concat([Buffer.from('120000 '), Buffer.from(b), Buffer.of(0), blob]))));
    const r = spawnSync('git', ['fsck', '--strict', '--no-dangling'], { cwd: dir, env: ENV, encoding: 'latin1', maxBuffer: 1 << 30 });
    if (r.status === null || r.error) throw new Error(`git fsck did not finish: ${r.error ?? r.signal}`);
    const found = new Map();
    for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
      const m = /^(?:error|warning) in tree ([0-9a-f]{40}): (\w+):/.exec(line);
      if (!m) continue;
      let s = found.get(m[1]);
      if (!s) found.set(m[1], s = new Set());
      s.add(m[2]);
    }
    // every tree written is one git sees: `git count-objects` counts the loose objects fsck walked
    const count = spawnSync('git', ['count-objects'], { cwd: dir, env: ENV, encoding: 'utf8' });
    const loose = Number(/^(\d+) objects/.exec(count.stdout)?.[1]);
    const want = new Set(oids.filter(o => o !== null)).size + 1;
    if (loose !== want) throw new Error(`git counts ${loose} loose objects, ${want} written`);
    return oids.map(o => (o === null ? null : MSG_IDS.map(id => +(found.get(o)?.has(id) ?? false)).join('')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
