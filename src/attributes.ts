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

/* oxlint-disable unicorn/prefer-code-point -- byte strings (above): charCodeAt/fromCharCode are the byte <-> char map; codePointAt would pair surrogates */
import type { Option } from './result.js';
import type { Input } from './absent.js';
import { encodeBytes } from './bytes.js';
import { none, some, getOrElse } from './result.js';
import { fromNullable, mapGet, withDefaults } from './absent.js';

// The last element of a stack, taken off it; None when the stack is empty.
export const popLast = <T>(xs: T[]): Option<T> => fromNullable(xs.pop());

// A state as a line assigns it: true (set), false (-unset), null (!unspecified), or a =value (A6: an AttrValue union).
export type AttrValue = boolean | null | string;
export type AttrState = readonly [name: string, value: AttrValue];
export type Pattern = {
  readonly pattern: string;
  readonly negative: boolean;
  readonly mustBeDir: boolean;
  readonly nodir: boolean;
  readonly prefix: number;
  readonly endsWith: boolean;
};
// A line that defines a macro, or a pattern line: `'pat' in line` tells them apart. A skipped line is null.
export type AttrLine =
  | { readonly macro: string; readonly states: readonly AttrState[] }
  | { readonly pat: Pattern; readonly states: readonly AttrState[] };
export type ParseConfig = { readonly macrosOk: boolean; readonly reserveBuiltin: boolean };
export type ParseOptions = Input<ParseConfig>;
const parseDefaults = (): ParseConfig => ({ macrosOk: false, reserveBuiltin: true });

export const UNSET = null;    // '!attr'  — explicitly unspecified
const BLANK = ' \t\r\n';
const MAX_LINE = 2048;
const MAX_FILE = 100 * 1024 * 1024;
const BUILTIN = '[attr]binary -diff -merge -text';

export const bytesToStr = (bytes: Uint8Array): string => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };
// encodeBytes: a path whose tree name held escaped bytes (#43) is matched on those bytes, as check-attr matches them
export const utf8ToStr = (s: string): string => bytesToStr(encodeBytes(s, 'path'));

// ---- git's sane_ctype (ASCII only) ----
type Ctype = (c: number) => boolean;
const isAlpha: Ctype = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit: Ctype = c => c >= 48 && c <= 57;
const isUpper: Ctype = c => c >= 65 && c <= 90;
const isLower: Ctype = c => c >= 97 && c <= 122;
const isSpace: Ctype = c => c === 9 || c === 10 || c === 13 || c === 32;
const isPrint: Ctype = c => c >= 0x20 && c <= 0x7e;
const isGraph: Ctype = c => c >= 0x21 && c <= 0x7e;
const isCntrl: Ctype = c => c < 32 || c === 127;
const isPunct: Ctype = c => isGraph(c) && !isAlpha(c) && !isDigit(c);
const isXdigit: Ctype = c => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isBlank: Ctype = c => c === 32 || c === 9;
const isGlobSpecial: Ctype = c => c === 42 || c === 63 || c === 91 || c === 92; // * ? [ \

// a Map: the class name comes from .gitattributes, and `[[:constructor:]]` is not a class (wildmatch: ABORT_ALL)
const CLASSES = new Map<string, Ctype>([['alnum', c => isAlpha(c) || isDigit(c)], ['alpha', isAlpha], ['blank', isBlank], ['cntrl', isCntrl], ['digit', isDigit], ['graph', isGraph], ['lower', isLower], ['print', isPrint], ['punct', isPunct], ['space', isSpace], ['upper', isUpper], ['xdigit', isXdigit]]);

// ---- wildmatch.c (no WM_CASEFOLD: a bare server repo has core.ignorecase off) ----
const MATCH = 0;
const NOMATCH = 1;
const ABORT_ALL = -1;
const ABORT_TO_STARSTAR = -2;
// A line-for-line port of wildmatch.c's dowild: C's pattern and text pointers advance in place, in one function.
/* oxlint-disable eslint/no-param-reassign, eslint/max-depth, eslint/complexity, eslint/no-unmodified-loop-condition -- a line-for-line port of dowild (above) */
function dowild(P: string, pi: number, T: string, ti: number, pathname: boolean): number {
  const p = (i: number): number => (i < P.length ? P.charCodeAt(i) : 0);
  const t = (i: number): number => (i < T.length ? T.charCodeAt(i) : 0);
  for (; p(pi) !== 0; ti++, pi++) {
    let pch = p(pi); let tch = t(ti);
    if (tch === 0 && pch !== 42) return ABORT_ALL;
    switch (pch) {
      default: if (pch === 92) pch = p(++pi); if (tch !== pch) return NOMATCH; continue; // '\\': the next is literal
      case 63: if (pathname && tch === 47) return NOMATCH; continue; // '?'
      case 42: { // '*'
        let matchSlash: boolean;
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
          if (!matchSlash && T.includes('/', ti)) return ABORT_TO_STARSTAR;
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
        let prev = 0;
        let matched = false;
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
              const test = CLASSES.get(cls);
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
/* oxlint-enable eslint/no-param-reassign, eslint/max-depth, eslint/complexity, eslint/no-unmodified-loop-condition */
export const wildmatch = (pattern: string, text: string, pathname = false): boolean => dowild(pattern, 0, text, 0, pathname) === MATCH;

// ---- dir.c: parse_path_pattern, match_basename, match_pathname ----
const simpleLength = (s: string): number => { let i = 0; while (i < s.length && !isGlobSpecial(s.charCodeAt(i))) i++; return i; };
function parsePattern(raw: string): Pattern {
  let p = raw;
  let negative = false;
  // Stryker disable next-line MethodExpression: parseLine drops a negative pattern before this sliced text is read
  if (p[0] === '!') { negative = true; p = p.slice(1); }
  let len = p.length, mustBeDir = false;
  if (len && p[len - 1] === '/') { len--; mustBeDir = true; }
  const nodir = !p.slice(0, len).includes('/');
  const prefix = Math.min(simpleLength(p), len);
  const endsWith = p[0] === '*' && simpleLength(p.slice(1)) === p.length - 1;
  return { pattern: p.slice(0, len), negative, mustBeDir, nodir, prefix, endsWith };
}
function matchBasename(base: string, pat: Pattern): boolean {
  if (pat.prefix === pat.pattern.length) return base === pat.pattern;
  if (pat.endsWith) return pat.pattern.length - 1 <= base.length && base.endsWith(pat.pattern.slice(1));
  return wildmatch(pat.pattern, base);
}
function matchPathname(path: string, origin: string, pat: Pattern): boolean {
  let { pattern, prefix } = pat;
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
  return wildmatch(pattern, name, true);
}
// path_matches for a file (attributes are only ever asked of files here)
function pathMatches(path: string, origin: string, pat: Pattern): boolean {
  if (pat.mustBeDir) return false;
  if (pat.nodir) return matchBasename(path.slice(path.lastIndexOf('/') + 1), pat);
  return matchPathname(path, origin, pat);
}

// ---- quote.c: unquote_c_style ----
// quote.c's escapes, by the character after the backslash (a Map: a miss is None)
const ESCAPES = new Map<string, number>([['a', 7], ['b', 8], ['f', 12], ['n', 10], ['r', 13], ['t', 9], ['v', 11], ['\\', 92], ['"', 34]]);
// None: an unterminated string or a bad escape (the name is then read unquoted, as git does)
function unquote(s: string): Option<{ readonly value: string; readonly rest: string }> { // s starts with '"'
  let i = 1, out = '';
  for (;;) {
    let j = i; while (j < s.length && s[j] !== '"' && s[j] !== '\\') j++;
    out += s.slice(i, j); i = j;
    if (i >= s.length) return none;
    if (s[i++] === '"') return some({ value: out, rest: s.slice(i) });
    const ch = s.charAt(i++); // past the end: '', no escape and no digit → none below
    const simple = mapGet(ESCAPES, ch);
    if (simple.tag === 'some') { out += String.fromCharCode(simple.value); continue; }
    if (ch >= '0' && ch <= '3') {
      const d1 = s.charAt(i++);
      const d2 = s.charAt(i++);
      if (!(d1 >= '0' && d1 <= '7') || !(d2 >= '0' && d2 <= '7')) return none;
      out += String.fromCharCode(((ch.charCodeAt(0) - 48) << 6) | ((d1.charCodeAt(0) - 48) << 3) | (d2.charCodeAt(0) - 48)); continue;
    }
    return none;
  }
}

// ---- attr.c: parse_attr_line ----
const validName = (n: string): boolean => n.length > 0 && n[0] !== '-' && /^[-A-Za-z0-9_.]+$/u.test(n);
// git ≥ 2.44 reserves builtin_* (builtin_objectmode): a line naming one is invalid as a whole; older git accepts it
const reservedIn = (reserveBuiltin: boolean) => (n: string): boolean => reserveBuiltin && n.startsWith('builtin_');
// oxlint-disable-next-line eslint/no-param-reassign -- the scan index is the result
const span = (s: string, i: number, set: string, inSet: boolean): number => { while (i < s.length && set.includes(s.charAt(i)) === inSet) i++; return i; };
function parseStates(s: string, reserved: (n: string) => boolean): AttrState[] | null { // any invalid state voids the line
  const out: AttrState[] = []; let i = 0;
  while (i < s.length) {
    const ep = span(s, i, BLANK, false);
    let eq = s.indexOf('=', i);
    // Stryker disable next-line EqualityOperator,ConditionalExpression: indexOf is -1 or past the token start, and a token that starts with '=' is rejected either way
    if (eq < 0) eq = -1;
    // The else-if form is one statement, so a disable comment between the branches does not apply.
    // Stryker disable next-line EqualityOperator: '=' is not blank, so it cannot sit on the exclusive end of the token
    if (ep < eq) eq = -1;
    // Stryker disable next-line EqualityOperator: an '=' at index 0 makes the name empty or invalid, so both comparisons reject the line
    let name = s.slice(i, eq >= 0 ? eq : ep);
    let value: AttrValue;
    if (name[0] === '-' || name[0] === '!') { value = name[0] === '-' ? false : UNSET; name = name.slice(1); }
    else {
      // Stryker disable next-line EqualityOperator: an '=' at index 0 fails validName before this value is read, so both comparisons reject the line
      value = eq >= 0 ? s.slice(eq + 1, ep) : true;
    }
    if (!validName(name) || reserved(name)) return null;
    out.push([name, value]);
    i = span(s, ep, BLANK, true);
  }
  return out;
}
function parseLineWith(line: string, { macrosOk, reserveBuiltin }: ParseConfig): AttrLine | null {
  const reserved = reservedIn(reserveBuiltin);
  const cp = span(line, 0, BLANK, true);
  if (cp >= line.length || line[cp] === '#') return null;
  if (line.length >= MAX_LINE) return null;
  let name: string;
  let states: string;
  const q = line[cp] === '"' ? unquote(line.slice(cp)) : none;
  if (q.tag === 'some') { name = q.value.value; states = q.value.rest; }
  else { const e = span(line, cp, BLANK, false); name = line.slice(cp, e); states = line.slice(e); }
  let macro = ''; // validName: a macro's name is never ''
  if (name.length > 6 && name.startsWith('[attr]')) {
    if (!macrosOk) return null;
    const rest = name.slice(6); const k = span(rest, 0, BLANK, true);
    // Stryker disable next-line MethodExpression: the macro name token contains no blank, so this slice is the whole remainder
    const mname = rest.slice(k, span(rest, k, BLANK, false));
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
// @decoder parseLine prefix=attr-line
export function parseLine(line: string, options: ParseOptions): AttrLine | null {
  return parseLineWith(line, withDefaults(options, parseDefaults()));
}
// @decoder parseFile prefix=attr-file
// maxFile defaults to git's 100MiB attribute-file cap. Tests pass a smaller cap so the boundary is reachable
// without allocating that buffer on every run.
export type ParseFileConfig = ParseConfig & { readonly maxFile: number };
export function parseFile(file: string, options: Input<ParseFileConfig> = {}): AttrLine[] {
  const { macrosOk, reserveBuiltin, maxFile } = withDefaults(options, { ...parseDefaults(), maxFile: MAX_FILE });
  if (file.length >= maxFile) return [];
  const nul = file.indexOf('\0'); const text = nul >= 0 ? file.slice(0, nul) : file; // C string
  const lines: AttrLine[] = []; let sp = 0;
  while (sp < text.length) { let ep = text.indexOf('\n', sp); const more = ep >= 0; if (!more) ep = text.length; const l = parseLineWith(text.slice(sp, ep), { macrosOk, reserveBuiltin }); if (l) lines.push(l); sp = ep + (more ? 1 : 0); }
  return lines;
}
const BUILTIN_FILE = parseFile(BUILTIN, { macrosOk: true });

// Attributes of `path` (byte string, no trailing slash) given the .gitattributes texts by directory:
// files: Map(dir byte string → file text byte string), '' for the root. Returns Map(name → true | false | null | string).
// The built-in frame's origin is never read (it holds only the macro); '' keeps the frames one type.
export type AttributesConfig = { readonly reserveBuiltin: boolean };
export function attributesFor(path: string, files: ReadonlyMap<string, string>, options: Input<AttributesConfig> = {}): Map<string, AttrValue> {
  const { reserveBuiltin } = withDefaults(options, { reserveBuiltin: true });
  const frames: Array<{ readonly origin: string; readonly lines: readonly AttrLine[] }> = [{ origin: '', lines: BUILTIN_FILE }];
  const dirs = ['']; const last = path.lastIndexOf('/');
  for (let i = path.indexOf('/'); i >= 0 && i <= last; i = path.indexOf('/', i + 1)) dirs.push(path.slice(0, i));
  for (const d of dirs) { const text = mapGet(files, d); if (text.tag === 'some') frames.push({ origin: d, lines: parseFile(text.value, { macrosOk: d === '', reserveBuiltin }) }); }
  // determine_macros: the most specific definition wins (frames top-down, lines bottom-up)
  const macros = new Map<string, readonly AttrState[]>();
  for (const { lines } of frames.toReversed()) for (const l of lines.toReversed()) if ('macro' in l && !macros.has(l.macro)) macros.set(l.macro, l.states);
  const out = new Map<string, AttrValue>();
  const fillOne = (states: readonly AttrState[]): void => {
    const todo = [...states];
    for (let s = popLast(todo); s.tag === 'some'; s = popLast(todo)) {
      const [name, value] = s.value;
      if (out.has(name)) continue;
      out.set(name, value);
      if (value === true) todo.push(...getOrElse(mapGet(macros, name), []));
    }
  };
  // the built-in frame holds only a macro, which fills nothing
  for (const { origin, lines } of frames.toReversed()) for (const l of lines.toReversed()) if ('pat' in l && pathMatches(path, origin, l.pat)) fillOne(l.states);
  return out;
}
// None: never mentioned. Some(null): explicitly unspecified ('!attr').
export const attributeOf = (attrs: ReadonlyMap<string, AttrValue>, name: string): Option<AttrValue> => mapGet(attrs, name);
