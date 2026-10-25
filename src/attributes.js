// .gitattributes, as git reads them (attr.c, dir.c, wildmatch.c, quote.c): parse, match and fill, byte for byte. Pure.
//
// Strings here are byte strings (one char per byte, as String.fromCharCode(byte)): paths and attribute files are bytes,
// git's ctype is ASCII-only, and every comparison is bytewise. Use `bytesToStr` / `utf8ToStr` at the edges.
//
// What is modelled: one attribute stack per path — the built-in `[attr]binary -diff -merge -text` at the bottom, the
// root .gitattributes (the only file allowed to define macros), then one .gitattributes per directory down to the
// path's own; patterns with gitignore semantics (no '/' → basename at any depth below the file's directory; trailing
// '/' → directories only, so never a file; leading '/' anchors; wildmatch with WM_PATHNAME); states set / -unset /
// !unspecified / =value; git's fill order (most specific file first, lines bottom-up, a line's states right to left,
// first assignment wins, a macro set to true expands where it is assigned). Not modelled: $GIT_DIR/info/attributes,
// core.attributesFile and system attributes — they live on the server, not in the tree.
//
// Verified against `git check-attr --source` (test/fuzz/attributes.mjs).

export const UNSET = null;          // '!attr'  — explicitly unspecified
const UNKNOWN = undefined;          // never mentioned
const BLANK = ' \t\r\n';
const MAX_LINE = 2048, MAX_FILE = 100 * 1024 * 1024;
const BUILTIN = '[attr]binary -diff -merge -text';

export const bytesToStr = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; };
export const utf8ToStr = s => bytesToStr(new TextEncoder().encode(s));

// ---- git's sane_ctype (ASCII only) ----
const isAlpha = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = c => c >= 48 && c <= 57;
const isUpper = c => c >= 65 && c <= 90, isLower = c => c >= 97 && c <= 122;
const isSpace = c => c === 9 || c === 10 || c === 13 || c === 32;
const isPrint = c => c >= 0x20 && c <= 0x7e;
const isGraph = c => c >= 0x21 && c <= 0x7e;
const isCntrl = c => c < 32 || c === 127;
const isPunct = c => isGraph(c) && !isAlpha(c) && !isDigit(c);
const isXdigit = c => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isBlank = c => c === 32 || c === 9;
const isGlobSpecial = c => c === 42 || c === 63 || c === 91 || c === 92; // * ? [ \

// ---- wildmatch.c (no WM_CASEFOLD: a bare server repo has core.ignorecase off) ----
const MATCH = 0, NOMATCH = 1, ABORT_ALL = -1, ABORT_TO_STARSTAR = -2;
function dowild(P, pi, T, ti, pathname) {
  const p = i => (i < P.length ? P.charCodeAt(i) : 0), t = i => (i < T.length ? T.charCodeAt(i) : 0);
  for (; p(pi) !== 0; ti++, pi++) {
    let pch = p(pi); let tch = t(ti);
    if (tch === 0 && pch !== 42) return ABORT_ALL;
    switch (pch) {
      case 92: pch = p(++pi); // '\\' literal next — FALLTHROUGH
      // eslint-disable-next-line no-fallthrough
      default: if (tch !== pch) return NOMATCH; continue;
      case 63: if (pathname && tch === 47) return NOMATCH; continue; // '?'
      case 42: { // '*'
        let matchSlash;
        if (p(++pi) === 42) {
          const prev = pi;
          while (p(++pi) === 42) { /* skip */ }
          if (!pathname) matchSlash = true;
          else if ((prev < 2 || p(prev - 2) === 47) && (p(pi) === 0 || p(pi) === 47 || (p(pi) === 92 && p(pi + 1) === 47))) {
            if (p(pi) === 47 && dowild(P, pi + 1, T, ti, pathname) === MATCH) return MATCH;
            matchSlash = true;
          } else matchSlash = false;
        } else matchSlash = !pathname;
        if (p(pi) === 0) {
          if (!matchSlash && T.indexOf('/', ti) >= 0) return ABORT_TO_STARSTAR;
          return MATCH;
        } else if (!matchSlash && p(pi) === 47) {
          const slash = T.indexOf('/', ti);
          if (slash < 0) return ABORT_ALL;
          ti = slash; break; // the slash is consumed by the loop
        }
        for (;;) {
          if (tch === 0) break;
          if (!isGlobSpecial(p(pi))) {
            const want = p(pi);
            while ((tch = t(ti)) !== 0 && (matchSlash || tch !== 47)) { if (tch === want) break; ti++; }
            if (tch !== want) return matchSlash ? ABORT_ALL : ABORT_TO_STARSTAR;
          }
          const m = dowild(P, pi, T, ti, pathname);
          if (m !== NOMATCH) { if (!matchSlash || m !== ABORT_TO_STARSTAR) return m; }
          else if (!matchSlash && tch === 47) return ABORT_TO_STARSTAR;
          tch = t(++ti);
        }
        return ABORT_ALL;
      }
      case 91: { // '['
        pch = p(++pi);
        if (pch === 94) pch = 33; // '^' → '!'
        const negated = pch === 33;
        if (negated) pch = p(++pi);
        let prev = 0, matched = false;
        do {
          if (!pch) return ABORT_ALL;
          if (pch === 92) { pch = p(++pi); if (!pch) return ABORT_ALL; if (tch === pch) matched = true; }
          else if (pch === 45 && prev && p(pi + 1) && p(pi + 1) !== 93) { // range
            pch = p(++pi);
            if (pch === 92) { pch = p(++pi); if (!pch) return ABORT_ALL; }
            if (tch <= pch && tch >= prev) matched = true;
            pch = 0;
          } else if (pch === 91 && p(pi + 1) === 58) { // [:class:]
            const s = pi += 2;
            for (; (pch = p(pi)) && pch !== 93; pi++) { /* shared iterator */ }
            if (!pch) return ABORT_ALL;
            const len = pi - s - 1;
            if (len < 0 || p(pi - 1) !== 58) { pi = s - 2; pch = 91; if (tch === pch) matched = true; }
            else {
              const cls = P.slice(s, s + len);
              const test = { alnum: c => isAlpha(c) || isDigit(c), alpha: isAlpha, blank: isBlank, cntrl: isCntrl, digit: isDigit, graph: isGraph, lower: isLower, print: isPrint, punct: isPunct, space: isSpace, upper: isUpper, xdigit: isXdigit }[cls];
              if (!test) return ABORT_ALL; // malformed [:class:]
              if (test(tch)) matched = true;
              pch = 0;
            }
          } else if (tch === pch) matched = true;
          prev = pch; pch = p(++pi);
        } while (pch !== 93);
        if (matched === negated || (pathname && tch === 47)) return NOMATCH;
        continue;
      }
    }
  }
  return ti < T.length ? NOMATCH : MATCH;
}
export const wildmatch = (pattern, text, { pathname = false } = {}) => dowild(pattern, 0, text, 0, pathname) === MATCH;

// ---- dir.c: parse_path_pattern, match_basename, match_pathname ----
const simpleLength = s => { let i = 0; while (i < s.length && !isGlobSpecial(s.charCodeAt(i))) i++; return i; };
function parsePattern(raw) {
  let p = raw, negative = false;
  if (p[0] === '!') { negative = true; p = p.slice(1); }
  let len = p.length, mustBeDir = false;
  if (len && p[len - 1] === '/') { len--; mustBeDir = true; }
  const nodir = p.slice(0, len).indexOf('/') < 0;
  const prefix = Math.min(simpleLength(p), len);
  const endsWith = p[0] === '*' && simpleLength(p.slice(1)) === p.length - 1;
  return { pattern: p.slice(0, len), negative, mustBeDir, nodir, prefix, endsWith };
}
function matchBasename(base, pat) {
  if (pat.prefix === pat.pattern.length) return base === pat.pattern;
  if (pat.endsWith) return pat.pattern.length - 1 <= base.length && base.endsWith(pat.pattern.slice(1));
  return wildmatch(pat.pattern, base);
}
function matchPathname(path, origin, pat) {
  let pattern = pat.pattern, prefix = pat.prefix;
  if (pattern[0] === '/') { pattern = pattern.slice(1); prefix--; }
  const baselen = origin.length;
  if (path.length < baselen + 1 || (baselen && path[baselen] !== '/') || path.slice(0, baselen) !== origin) return false;
  let name = baselen ? path.slice(baselen + 1) : path;
  if (prefix > 0) {
    if (prefix > name.length) return false;
    if (pattern.slice(0, prefix) !== name.slice(0, prefix)) return false;
    if (pattern.length === prefix && name.length === prefix) return true;
    prefix--; pattern = pattern.slice(prefix); name = name.slice(prefix);
  }
  return wildmatch(pattern, name, { pathname: true });
}
// path_matches for a file (attributes are only ever asked of files here)
function pathMatches(path, origin, pat) {
  if (pat.mustBeDir) return false;
  if (pat.nodir) return matchBasename(path.slice(path.lastIndexOf('/') + 1), pat);
  return matchPathname(path, origin, pat);
}

// ---- quote.c: unquote_c_style ----
function unquote(s) { // s starts with '"'; → { value, rest } or null
  let i = 1, out = '';
  for (;;) {
    let j = i; while (j < s.length && s[j] !== '"' && s[j] !== '\\') j++;
    out += s.slice(i, j); i = j;
    if (i >= s.length) return null;
    if (s[i++] === '"') return { value: out, rest: s.slice(i) };
    const ch = s[i++];
    const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 }[ch];
    if (simple !== undefined) { out += String.fromCharCode(simple); continue; }
    if (ch >= '0' && ch <= '3') {
      const d1 = s[i++], d2 = s[i++];
      if (!(d1 >= '0' && d1 <= '7') || !(d2 >= '0' && d2 <= '7')) return null;
      out += String.fromCharCode(((ch.charCodeAt(0) - 48) << 6) | ((d1.charCodeAt(0) - 48) << 3) | (d2.charCodeAt(0) - 48)); continue;
    }
    return null;
  }
}

// ---- attr.c: parse_attr_line ----
const validName = n => n.length > 0 && n[0] !== '-' && /^[-A-Za-z0-9_.]+$/.test(n);
// git ≥ 2.44 reserves builtin_* (builtin_objectmode): a line naming one is invalid as a whole; older git accepts it
const reservedIn = reserveBuiltin => n => reserveBuiltin && n.startsWith('builtin_');
const span = (s, i, set, inSet) => { while (i < s.length && set.includes(s[i]) === inSet) i++; return i; };
function parseStates(s, reserved) { // → [[name, value]] or null (any invalid state voids the line)
  const out = []; let i = 0;
  while (i < s.length) {
    const ep = span(s, i, BLANK, false);
    let eq = s.indexOf('=', i); if (eq < 0 || ep < eq) eq = -1;
    let name = s.slice(i, eq >= 0 ? eq : ep), value;
    if (name[0] === '-' || name[0] === '!') { value = name[0] === '-' ? false : UNSET; name = name.slice(1); }
    else value = eq >= 0 ? s.slice(eq + 1, ep) : true;
    if (!validName(name) || reserved(name)) return null;
    out.push([name, value]);
    i = span(s, ep, BLANK, true);
  }
  return out;
}
// @decoder parseLine prefix=attr-line
export function parseLine(line, { macrosOk, reserveBuiltin = true }) {
  const reserved = reservedIn(reserveBuiltin);
  let cp = span(line, 0, BLANK, true);
  if (cp >= line.length || line[cp] === '#') return null;
  if (line.length >= MAX_LINE) return null;
  let name, states;
  const q = line[cp] === '"' ? unquote(line.slice(cp)) : null;
  if (q) { name = q.value; states = q.rest; }
  else { const e = span(line, cp, BLANK, false); name = line.slice(cp, e); states = line.slice(e); }
  let macro = null;
  if (name.length > 6 && name.startsWith('[attr]')) {
    if (!macrosOk) return null;
    const rest = name.slice(6); const k = span(rest, 0, BLANK, true); const mname = rest.slice(k, span(rest, k, BLANK, false));
    if (!validName(mname) || reserved(mname)) return null;
    macro = mname;
  }
  const parsed = parseStates(states.slice(span(states, 0, BLANK, true)), reserved);
  if (!parsed) return null;
  if (macro) return { macro, states: parsed };
  const pat = parsePattern(name);
  if (pat.negative) return null; // negative patterns are ignored in attributes
  return { pat, states: parsed };
}
// @decoder parseFile prefix=attr-file
export function parseFile(text, { macrosOk = false, reserveBuiltin = true } = {}) {
  if (text.length >= MAX_FILE) return [];
  const nul = text.indexOf('\0'); if (nul >= 0) text = text.slice(0, nul); // C string
  const lines = []; let sp = 0;
  while (sp < text.length) { let ep = text.indexOf('\n', sp); const more = ep >= 0; if (!more) ep = text.length; const l = parseLine(text.slice(sp, ep), { macrosOk, reserveBuiltin }); if (l) lines.push(l); sp = ep + (more ? 1 : 0); }
  return lines;
}
const BUILTIN_FILE = parseFile(BUILTIN, { macrosOk: true });

// Attributes of `path` (byte string, no trailing slash) given the .gitattributes texts by directory:
// files: Map(dir byte string → file text byte string), '' for the root. Returns Map(name → true | false | null | string).
export function attributesFor(path, files, { reserveBuiltin = true } = {}) {
  const frames = [{ origin: null, lines: BUILTIN_FILE }];
  const dirs = ['']; const last = path.lastIndexOf('/');
  for (let i = path.indexOf('/'); i >= 0 && i <= last; i = path.indexOf('/', i + 1)) dirs.push(path.slice(0, i));
  for (const d of dirs) if (files.has(d)) frames.push({ origin: d, lines: parseFile(files.get(d), { macrosOk: d === '', reserveBuiltin }) });
  // determine_macros: the most specific definition wins (frames top-down, lines bottom-up)
  const macros = new Map();
  for (let f = frames.length - 1; f >= 0; f--) for (let i = frames[f].lines.length - 1; i >= 0; i--) { const l = frames[f].lines[i]; if (l.macro && !macros.has(l.macro)) macros.set(l.macro, l.states); }
  const out = new Map();
  const fillOne = states => {
    const todo = [...states];
    while (todo.length) {
      const [name, value] = todo.pop();
      if (out.has(name)) continue;
      out.set(name, value);
      if (value === true && macros.has(name)) todo.push(...macros.get(name));
    }
  };
  for (let f = frames.length - 1; f >= 1; f--) {
    const { origin, lines } = frames[f];
    for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].macro && pathMatches(path, origin, lines[i].pat)) fillOne(lines[i].states);
  }
  return out;
}
export const attributeOf = (attrs, name) => (attrs.has(name) ? attrs.get(name) : UNKNOWN);
