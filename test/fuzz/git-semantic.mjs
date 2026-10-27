// Header-level mutations of commits, tags, and trees. ply may reject an object git accepts — duplicate
// single-valued headers and orders commit-tree would not write are illegal here on purpose, and fsck is
// looser. If ply parses the object, every field git exposes has to match.
//
//   node test/fuzz/git-semantic.mjs [--n 20] [--seed 1] [--case <seed>]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concat, te } from '../../src/bytes.js';
import { fromHex } from '../../src/sha1.js';
import { hashObject, parseCommit, parseTag, parseTree, encodeCommit, encodeTag, ident } from '../../src/objects.js';
import { Rng } from './prng.js';
import { OID_BYTES } from '../../src/format.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '20', 10);
const SEED = parseInt(args.seed ?? '1', 10);
const ONLY = args.case && args.case !== true ? String(args.case) : null;
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
  GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@b.c',
};
const AUTHOR = ident({ name: 'A', email: 'a@b.c', time: '1700000000' });
const COMMITTER = ident({ name: 'C', email: 'c@b.c', time: '1700000001' });

function git(dir, argv, input) {
  const r = spawnSync('git', ['-C', dir, ...argv], { input, encoding: 'utf8', env });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}

const dir = mkdtempSync(join(tmpdir(), 'ply-sem-'));
const init = git(dir, ['init', '-q', '-b', 'main']);
if (init.code !== 0) { console.error(init.err); process.exit(1); }
const empty = git(dir, ['hash-object', '-t', 'tree', '-w', '--stdin'], '').out.trim();
const blob = git(dir, ['hash-object', '-w', '--stdin'], 'hello\n').out.trim();
const treeBytes = concat([te.encode(`100644 a\0`), fromHex(blob), te.encode(`40000 d\0`), fromHex(empty)]);
const treeOid = git(dir, ['hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], Buffer.from(treeBytes)).out.trim();
const commitText = `tree ${empty}\nauthor ${AUTHOR}\ncommitter ${COMMITTER}\n\nmsg\n`;
const commitOid = git(dir, ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], commitText).out.trim();
const TREES = [empty, treeOid];
const COMMITS = [commitOid];
const OBJECTS = [
  { oid: commitOid, type: 'commit' },
  { oid: treeOid, type: 'tree' },
  { oid: empty, type: 'tree' },
  { oid: blob, type: 'blob' },
];

function literally(type, data) {
  const input = typeof data === 'string' ? data : Buffer.from(data);
  const r = git(dir, ['hash-object', '-t', type, '-w', '--stdin', '--literally'], input);
  if (r.code !== 0) throw new Error(`hash-object ${type}: ${r.err}`);
  const oid = r.out.trim().split('\n').pop();
  const ours = hashObject(type, typeof data === 'string' ? te.encode(data) : data);
  if (ours !== oid) throw new Error(`hash diverged ${type}: ply ${ours} git ${oid}`);
  return oid;
}

function parseOrThrow(type, data) {
  const bytes = typeof data === 'string' ? te.encode(data) : data;
  if (type === 'commit') return parseCommit(bytes);
  if (type === 'tag') return parseTag(bytes);
  return parseTree(bytes);
}

function norm(s) { return (s ?? '').replace(/\n+$/, ''); }

function agreeCommit(oid, parsed) {
  const r = git(dir, ['log', '-1', '--no-walk', '--date=raw', '--format=%T%x00%P%x00%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%e%x00%B', oid]);
  if (r.code !== 0) return `git rejected the commit (${r.err.trim().split('\n')[0]})`;
  const [tree, parents, an, ae, ad, cn, ce, cd, encoding, message] = r.out.split('\0');
  const identLine = (name, email, date) => (name === '' && email === '' && date === '' ? null : `${name} <${email}> ${date}`);
  if (parsed.tree !== tree) return `tree ply ${parsed.tree} git ${tree}`;
  if ((parsed.parents ?? []).join(' ') !== parents) return `parents ply ${parsed.parents} git ${parents}`;
  if ((parsed.author ?? null) !== identLine(an, ae, ad)) return `author ply ${parsed.author} git ${identLine(an, ae, ad)}`;
  if ((parsed.committer ?? null) !== identLine(cn, ce, cd)) return `committer ply ${parsed.committer} git ${identLine(cn, ce, cd)}`;
  if ((parsed.encoding ?? '') !== encoding) return `encoding ply ${parsed.encoding} git ${encoding}`;
  if (norm(parsed.message) !== norm(message)) return `message ply ${JSON.stringify(parsed.message)} git ${JSON.stringify(message)}`;
  return null;
}

function agreeTag(oid, parsed) {
  const ref = `refs/tags/sem-${oid.slice(0, 12)}`;
  const up = git(dir, ['update-ref', ref, oid]);
  if (up.code !== 0) return `git rejected the tag (${up.err.trim().split('\n')[0]})`;
  const sep = '\x1f';
  const r = git(dir, ['for-each-ref', `--format=%(tag)${sep}%(*objectname)${sep}%(tagger)${sep}%(contents)`, ref]);
  if (r.code !== 0) return `git rejected the tag (${r.err.trim().split('\n')[0]})`;
  const [tag, object, tagger, contents] = r.out.split('\x1f');
  const same = (ply, gitField) => (ply ?? '') === gitField;
  if (!same(parsed.tag, tag)) return `tag ply ${parsed.tag} git ${tag}`;
  if (!same(parsed.object, object)) return `object ply ${parsed.object} git ${object}`;
  if (!same(parsed.tagger, tagger)) return `tagger ply ${JSON.stringify(parsed.tagger)} git ${JSON.stringify(tagger)}`;
  if (norm(parsed.message) !== norm(contents)) return `message ply ${JSON.stringify(parsed.message)} git ${JSON.stringify(contents)}`;
  return null;
}

// ls-tree prints the mode git will use, not the raw bytes. A regular-file mode keeps only the executable bit
// (100664 is shown as 100644). That normalization is deliberate in parseTree; compare the canonical mode.
function canonicalMode(mode) {
  const text = String(mode).replace(/^0+/, '') || '0';
  const n = parseInt(text, 8);
  const type = n & 0o170000;
  if (type === 0o100000) return (n & 0o111) ? '100755' : '100644';
  if (type === 0o120000) return '120000';
  if (type === 0o40000) return '40000';
  if (type === 0o160000) return '160000';
  return text;
}

function agreeTree(oid, entries) {
  const r = git(dir, ['ls-tree', oid]);
  if (r.code !== 0) return `git rejected the tree (${r.err.trim().split('\n')[0]})`;
  const lines = r.out.split('\n').filter(Boolean);
  if (lines.length !== entries.length) return `entries ply ${entries.length} git ${lines.length}`;
  for (let i = 0; i < lines.length; i++) {
    const [mode, , idName] = lines[i].split(' ');
    const tab = idName.indexOf('\t');
    const id = idName.slice(0, tab);
    const name = idName.slice(tab + 1);
    if (canonicalMode(mode) !== canonicalMode(entries[i].mode) || id !== entries[i].oid || name !== entries[i].name) {
      return `entry ${i} ply ${entries[i].mode} ${entries[i].oid} ${entries[i].name} git ${mode} ${id} ${name}`;
    }
  }
  return null;
}

function commitLines(rng) {
  const lines = [
    `tree ${rng.pick(TREES)}`,
    `parent ${rng.pick(COMMITS)}`,
    `author ${AUTHOR}`,
    `committer ${COMMITTER}`,
    'encoding UTF-8',
  ];
  const kind = rng.int(0, 6);
  if (kind === 1) lines.splice(rng.int(0, lines.length), 0, lines[rng.int(0, lines.length - 1)]);
  else if (kind === 2) {
    const i = rng.int(0, lines.length - 1), j = rng.int(0, lines.length - 1);
    [lines[i], lines[j]] = [lines[j], lines[i]];
  } else if (kind === 3) lines.splice(rng.int(0, lines.length - 1), 1);
  else if (kind === 4) {
    const extra = rng.pick([
      `tree ${rng.pick(TREES)}`, `parent ${rng.pick(COMMITS)}`, `author ${COMMITTER}`, `committer ${AUTHOR}`,
      'encoding ISO-8859-1', 'gpgsig -----BEGIN', ' signature', `mergetag object ${commitOid}`, 'x-custom v',
    ]);
    lines.splice(rng.int(0, lines.length), 0, extra);
  } else if (kind === 5) lines.splice(2, 0, `parent ${rng.pick(COMMITS)}`);
  else if (kind === 6) lines.push('gpgsig -----BEGIN', ' signature');
  return lines.join('\n') + '\n\n' + rng.pick(['msg\n', '', 'a\n\nb\n']);
}

function tagText(rng) {
  const target = rng.pick(OBJECTS);
  const lines = [`object ${target.oid}`, `type ${target.type}`, 'tag v1', `tagger ${AUTHOR}`];
  const kind = rng.int(0, 5);
  if (kind === 1) lines.splice(rng.int(0, lines.length), 0, lines[rng.int(0, lines.length - 1)]);
  else if (kind === 2) {
    const i = rng.int(0, lines.length - 1), j = rng.int(0, lines.length - 1);
    [lines[i], lines[j]] = [lines[j], lines[i]];
  } else if (kind === 3) lines.splice(rng.int(0, lines.length - 1), 1);
  else if (kind === 4) {
    const again = rng.pick(OBJECTS);
    lines.splice(rng.int(0, lines.length), 0, rng.pick(['gpgsig abc', 'foo bar', `object ${again.oid}`, `type ${again.type}`, 'tag v2']));
  } else if (kind === 5) lines[2] = 'tag ';
  return lines.join('\n') + '\n\nrel\n';
}

function treeData(rng) {
  const entries = [
    { mode: '100644', name: 'a', oid: blob },
    { mode: '40000', name: 'd', oid: empty },
  ];
  const kind = rng.int(0, 4);
  if (kind === 1) entries.push({ mode: '100644', name: 'a', oid: blob });
  else if (kind === 2) entries.reverse();
  else if (kind === 3) entries[0].mode = rng.pick(['100664', '100755', '120000', '0']);
  else if (kind === 4) entries.push({ mode: '100644', name: 'b', oid: blob });
  return concat(entries.map(e => concat([te.encode(`${e.mode} ${e.name}\0`), fromHex(e.oid)])));
}

const cases = [];
cases.push({ name: 'dup-tree', type: 'commit', data: `tree ${empty}\nauthor ${AUTHOR}\ncommitter ${COMMITTER}\ntree ${blob}\n\nmsg\n` });
cases.push({ name: 'legal-commit', type: 'commit', data: encodeCommit({ tree: empty, parents: [commitOid], author: AUTHOR, committer: COMMITTER, encoding: 'UTF-8', message: 'msg\n' }) });
cases.push({ name: 'legal-tag', type: 'tag', data: encodeTag({ object: commitOid, type: 'commit', tag: 'v1', tagger: AUTHOR, message: 'rel\n' }) });
cases.push({ name: 'legal-tree', type: 'tree', data: treeBytes });
for (let i = 0; i < N; i++) {
  const seed = (SEED * 1000003 + i) >>> 0;
  const rng = new Rng(seed);
  const kind = rng.int(0, 2);
  if (kind === 0) cases.push({ name: `commit#${seed}`, seed, type: 'commit', data: commitLines(rng) });
  else if (kind === 1) cases.push({ name: `tag#${seed}`, seed, type: 'tag', data: tagText(rng) });
  else cases.push({ name: `tree#${seed}`, seed, type: 'tree', data: treeData(rng) });
}

let selected = cases;
if (ONLY !== null) {
  const asSeed = Number(ONLY);
  selected = Number.isInteger(asSeed) && String(asSeed) === ONLY ? cases.filter(c => c.seed === asSeed) : cases.filter(c => c.name === ONLY);
  if (!selected.length) { console.error(`no case ${ONLY}`); process.exit(2); }
}

const fails = [];
try {
  for (const c of selected) {
    const data = typeof c.data === 'string' ? c.data : c.data;
    let parsed, rejected;
    try { parsed = parseOrThrow(c.type, data); rejected = false; }
    catch (e) {
      rejected = true;
      if (e.code !== 'pack_corrupt') { fails.push(c.name); console.log(`FAIL ${c.name}: untyped ${e.code}: ${e.message}`); continue; }
    }
    if (rejected) { console.log(`reject    ${c.name}`); continue; }
    const oid = literally(c.type, data);
    const diff = c.type === 'commit' ? agreeCommit(oid, parsed) : c.type === 'tag' ? agreeTag(oid, parsed) : agreeTree(oid, parsed);
    if (diff) { fails.push(c.name); console.log(`FAIL ${c.name}: ${diff}`); }
    else console.log(`agree     ${c.name}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${selected.length} cases, ${fails.length} failures`);
process.exit(fails.length ? 1 : 0);
