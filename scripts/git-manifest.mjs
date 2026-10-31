// git-source manifest: the checks and messages git itself has, extracted mechanically from git's source at a pinned tag.
// Every entry is something git decides; test/space/registry.js must say which ply space covers it or why it does not
// apply (test/space/gates.test.js, gate b). The output is committed as test/space/git-manifest.json.
//
//   node scripts/git-manifest.mjs                 summary from a cached shallow clone (cloned on first use)
//   node scripts/git-manifest.mjs --write         rewrite test/space/git-manifest.json
//   node scripts/git-manifest.mjs --src <dir>     use an existing checkout of git at GIT_TAG instead of cloning
//
// Kinds (each entry: id, kind, file, line, fn, text):
//   fsck-msg      fsck.h FOREACH_FSCK_MSG_ID: the msg id and its default severity, plus the fsck.c functions reporting it
//   die / error   every die(), die_errno(), error(), error_errno() in the protocol files below, with its format string
//   reject        a reason receive-pack writes on an "ng" line: `ret = "..."`, `->error_string = "..."`, the unpack
//                 status strings unpack() returns, and every `return "..."` of receive-pack
//   ng / err-pkt  a string literal starting "ng " or "ERR " (what a client reads as a refusal)
//   capability    a capability a server advertises (receive-pack show_ref, upload-pack write_v0_ref and
//                 upload_pack_advertise, ls-refs ls_refs_advertise, serve.c capabilities[])
//   request-arg   an argument upload-pack's v2 fetch and ls-refs accept (process_args, ls_refs)
//   refname-rule  refs.c check_refname_component / check_or_sanitize_refname conditions (the comment bullets and the
//                 `/* Refname ... */` branch comments, each the condition git returns -1 for)
//   tree-mode     fsck_tree: every `case S_IF...` mode it accepts, and every FSCK_MSG it reports
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GIT_TAG = 'v2.50.0';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = join(ROOT, 'test/space/git-manifest.json');
export const MESSAGE_FILES = ['builtin/receive-pack.c', 'upload-pack.c', 'connect.c', 'pkt-line.c', 'sideband.c', 'send-pack.c', 'transport.c', 'http.c'];

function gitSource(argv) {
  const i = argv.indexOf('--src');
  if (i >= 0) return argv[i + 1];
  const dir = join(tmpdir(), `ply-git-src-${GIT_TAG}`);
  if (!existsSync(join(dir, 'fsck.h'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', GIT_TAG, 'https://github.com/git/git.git', dir], { stdio: 'inherit' });
  }
  return dir;
}

// ---- a small C reader: comments blanked (newlines kept), string literals decoded, functions located ----
function blankComments(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '"' || c === "'") { const j = endOfLiteral(s, i); out += s.slice(i, j); i = j; continue; }
    if (c === '/' && d === '*') { const j = s.indexOf('*/', i + 2); const k = j < 0 ? s.length : j + 2; out += s.slice(i, k).replace(/[^\n]/g, ' '); i = k; continue; }
    if (c === '/' && d === '/') { const j = s.indexOf('\n', i); const k = j < 0 ? s.length : j; out += ' '.repeat(k - i); i = k; continue; }
    out += c; i++;
  }
  return out;
}
function endOfLiteral(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
  return j + 1;
}
const unescape = body => body.replace(/\\(n|t|r|"|'|\\|0|x[0-9a-fA-F]{2}|[0-7]{1,3})/g, (_, e) => ({ n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', 0: '\0' }[e] ?? (e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : String.fromCharCode(parseInt(e, 8)))));
// Adjacent string literals from position i (after whitespace, through `_(`, `N_(`, `Q_(`): the decoded text, or null.
function stringAt(s, i) {
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  ws();
  const m = /^(?:N_|Q_|_)\s*\(/.exec(s.slice(i, i + 8));
  if (m) { i += m[0].length; ws(); }
  if (s[i] !== '"') return null;
  let text = '';
  while (s[i] === '"') { const j = endOfLiteral(s, i); text += unescape(s.slice(i + 1, j - 1)); i = j; ws(); }
  return text;
}
const lineAt = (s, i) => { let n = 1; for (let k = 0; k < i; k++) if (s.charCodeAt(k) === 10) n++; return n; };
// Function bodies: a `{` at column 0 opens one; its name is the last `name(` at the start of a column-0 line before it.
function functions(s) {
  const fns = [];
  const re = /^\{/gm;
  let m;
  while ((m = re.exec(s))) {
    const head = s.slice(Math.max(0, m.index - 600), m.index);
    const names = [...head.matchAll(/^[A-Za-z_][\w \t*]*?\b(\w+)\s*\(/gm)];
    const name = names.length ? names[names.length - 1][1] : '?';
    let depth = 0, j = m.index;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '"' || c === "'") { j = endOfLiteral(s, j) - 1; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    fns.push({ name, start: m.index, end: j });
  }
  return fns;
}
const fnAt = (fns, i) => fns.find(f => f.start <= i && i <= f.end)?.name ?? '(top)';
function literalsIn(s, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    if (s[i] === "'") { i = endOfLiteral(s, i) - 1; continue; }
    if (s[i] !== '"') continue;
    const j = endOfLiteral(s, i);
    out.push({ text: unescape(s.slice(i + 1, j - 1)), at: i });
    i = j - 1;
  }
  return out;
}

function load(dir, file) {
  const raw = readFileSync(join(dir, file), 'utf8');
  const s = blankComments(raw);
  return { file, raw, s, fns: functions(s) };
}

export function extract(dir) {
  const entries = [];
  const add = e => entries.push(e);

  // ---- fsck message ids ----
  const fsckH = readFileSync(join(dir, 'fsck.h'), 'utf8');
  const fsckC = load(dir, 'fsck.c');
  const block = fsckH.slice(fsckH.indexOf('#define FOREACH_FSCK_MSG_ID'));
  const hLine = fsckH.slice(0, fsckH.indexOf('#define FOREACH_FSCK_MSG_ID')).split('\n').length;
  for (const m of block.matchAll(/FUNC\((\w+), (\w+)\)/g)) {
    const [, id, severity] = m;
    const camel = id.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    const reportedIn = [...new Set([...fsckC.s.matchAll(new RegExp(`FSCK_MSG_${id}\\b`, 'g'))].map(x => fnAt(fsckC.fns, x.index)))];
    add({ id: `fsck:${camel}`, kind: 'fsck-msg', file: 'fsck.h', line: hLine + block.slice(0, m.index).split('\n').length - 1, fn: 'FOREACH_FSCK_MSG_ID', text: `${id} ${severity}`, severity, reportedIn });
  }

  // ---- messages, reject reasons, refusal strings ----
  for (const file of MESSAGE_FILES) {
    const f = load(dir, file);
    const short = file.replace('builtin/', '');
    for (const m of f.s.matchAll(/(?<![\w.>])(die_errno|die|error_errno|error)\s*\(/g)) {
      const text = stringAt(f.s, m.index + m[0].length) ?? '<expr>';
      add({ kind: m[1].startsWith('die') ? 'die' : 'error', file, line: lineAt(f.s, m.index), fn: fnAt(f.fns, m.index), text, base: `${short}:${m[1].startsWith('die') ? 'die' : 'error'}:${fnAt(f.fns, m.index)}:${text}` });
    }
    if (file === 'builtin/receive-pack.c') {
      for (const m of f.s.matchAll(/(?:\bret|error_string|reported_error)\s*=\s*(?=(?:N_|_)?\s*\(?\s*")/g)) {
        const text = stringAt(f.s, m.index + m[0].length);
        if (text !== null) add({ kind: 'reject', file, line: lineAt(f.s, m.index), fn: fnAt(f.fns, m.index), text, base: `${short}:reject:${text}` });
      }
      for (const m of f.s.matchAll(/\breturn\s+(?=(?:N_|_)?\s*\(?\s*")/g)) {
        const text = stringAt(f.s, m.index + m[0].length);
        if (text !== null) add({ kind: 'reject', file, line: lineAt(f.s, m.index), fn: fnAt(f.fns, m.index), text, base: `${short}:reject:${text}` });
      }
    }
    for (const lit of literalsIn(f.s, 0, f.s.length)) {
      if (lit.text.startsWith('ng ')) add({ kind: 'ng', file, line: lineAt(f.s, lit.at), fn: fnAt(f.fns, lit.at), text: lit.text, base: `${short}:ng:${fnAt(f.fns, lit.at)}:${lit.text}` });
      if (lit.text.startsWith('ERR ')) add({ kind: 'err-pkt', file, line: lineAt(f.s, lit.at), fn: fnAt(f.fns, lit.at), text: lit.text, base: `${short}:err-pkt:${fnAt(f.fns, lit.at)}:${lit.text}` });
    }
  }

  // ---- capabilities and request arguments ----
  const capFns = [['builtin/receive-pack.c', 'show_ref', 'receive-pack v0'], ['upload-pack.c', 'write_v0_ref', 'upload-pack v0'], ['upload-pack.c', 'upload_pack_advertise', 'v2 fetch'], ['ls-refs.c', 'ls_refs_advertise', 'v2 ls-refs']];
  for (const [file, fn, where] of capFns) {
    const f = load(dir, file);
    const body = f.fns.find(x => x.name === fn);
    if (!body) throw new Error(`git-manifest: ${file} has no ${fn}()`);
    for (const lit of literalsIn(f.s, body.start, body.end)) {
      for (const tok of lit.text.split(/\s+/)) {
        const name = tok.replace(/=.*$/, '');
        if (!/^[a-z][a-z0-9_-]+$/.test(name)) continue;
        add({ kind: 'capability', file, line: lineAt(f.s, lit.at), fn, text: name, where, base: `capability:${where}:${name}` });
      }
    }
  }
  const serve = load(dir, 'serve.c');
  for (const m of serve.s.matchAll(/\.name\s*=\s*"([^"]+)"/g)) add({ kind: 'capability', file: 'serve.c', line: lineAt(serve.s, m.index), fn: 'capabilities[]', text: m[1], where: 'v2 serve', base: `capability:v2 serve:${m[1]}` });
  const argFns = [['upload-pack.c', ['process_args', 'parse_want', 'parse_want_ref', 'parse_have', 'process_shallow', 'process_deepen', 'process_deepen_since', 'process_deepen_not'], 'v2 fetch'], ['ls-refs.c', ['ls_refs'], 'v2 ls-refs']];
  for (const [file, names, where] of argFns) {
    const f = load(dir, file);
    const seen = new Set();
    for (const fn of names) {
      const body = f.fns.find(x => x.name === fn);
      if (!body) throw new Error(`git-manifest: ${file} has no ${fn}()`);
      for (const m of f.s.slice(body.start, body.end).matchAll(/(?:skip_prefix|strcmp|starts_with|parse_feature_value)\s*\(\s*(?:\w+\s*,\s*"([^"]+)"|"([^"]+)"\s*,)/g)) {
        const name = (m[1] ?? m[2]).trim();
        if (seen.has(name) || !/^[a-z][a-z0-9-]*$/.test(name)) continue;
        seen.add(name);
        add({ kind: 'request-arg', file, line: lineAt(f.s, body.start + m.index), fn, text: name, where, base: `request-arg:${where}:${name}` });
      }
    }
  }

  // ---- ref-name rules ----
  const refs = load(dir, 'refs.c');
  const comp = refs.raw.indexOf('static int check_refname_component(');
  const doc = refs.raw.lastIndexOf('/*', comp);
  const docText = refs.raw.slice(doc, comp);
  const docLine = lineAt(refs.raw, doc);
  docText.split('\n').forEach((l, k) => {
    const m = /^\s*\*\s+- (it .+?)(?:, or|\.)?$/.exec(l);
    if (m) add({ kind: 'refname-rule', file: 'refs.c', line: docLine + k, fn: 'check_refname_component', text: m[1], base: `refname:${m[1]}` });
  });
  const rf = functions(blankComments(refs.raw));
  for (const fn of ['check_refname_component', 'check_or_sanitize_refname']) {
    const body = rf.find(x => x.name === fn);
    for (const m of refs.raw.slice(body.start, body.end).matchAll(/\/\*\s*((?:Refname|Component)[^*]*?)\s*\*\//g)) add({ kind: 'refname-rule', file: 'refs.c', line: lineAt(refs.raw, body.start + m.index), fn, text: m[1].replace(/\s+/g, ' '), base: `refname:${m[1].replace(/\s+/g, ' ')}` });
    for (const m of refs.raw.slice(body.start, body.end).matchAll(/if \(!\(\*?flags & (REFNAME_\w+)\)[^\n]*/g)) add({ kind: 'refname-rule', file: 'refs.c', line: lineAt(refs.raw, body.start + m.index), fn, text: `unless ${m[1]}: ${m[0].trim()}`, base: `refname:unless ${m[1]}` });
  }

  // ---- fsck_tree ----
  const tree = fsckC.fns.find(x => x.name === 'fsck_tree');
  if (!tree) throw new Error('git-manifest: fsck.c has no fsck_tree()');
  const tb = fsckC.s.slice(tree.start, tree.end);
  for (const m of tb.matchAll(/case (S_IF\w+(?:\s*\|\s*0\d+)?):/g)) add({ kind: 'tree-mode', file: 'fsck.c', line: lineAt(fsckC.s, tree.start + m.index), fn: 'fsck_tree', text: `mode ${m[1].replace(/\s+/g, '')}`, base: `tree-mode:case ${m[1].replace(/\s+/g, '')}` });
  for (const m of tb.matchAll(/FSCK_MSG_(\w+)/g)) add({ kind: 'tree-mode', file: 'fsck.c', line: lineAt(fsckC.s, tree.start + m.index), fn: 'fsck_tree', text: `reports ${m[1]}`, base: `tree-mode:reports ${m[1]}` });

  // stable ids: kind-specific base, numbered when git repeats it
  const seen = new Map();
  for (const e of entries) {
    if (e.id) continue;
    const base = e.base.replace(/\s+/g, ' ').slice(0, 140);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    e.id = n === 1 ? base : `${base}#${n}`;
    delete e.base;
  }
  return entries;
}

export function build(dir) {
  const version = execFileSync('git', ['-C', dir, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' }).trim();
  if (version !== GIT_TAG) throw new Error(`git-manifest: ${dir} is at ${version}, not ${GIT_TAG}`);
  const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const entries = extract(dir);
  const counts = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return { git: { tag: GIT_TAG, commit, source: 'https://github.com/git/git' }, generator: 'scripts/git-manifest.mjs', counts, entries };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = build(gitSource(process.argv));
  if (process.argv.includes('--write')) writeFileSync(MANIFEST, `${JSON.stringify(m, null, 1)}\n`);
  console.log(`git ${m.git.tag} (${m.git.commit.slice(0, 12)}): ${m.entries.length} entries`, m.counts);
}
