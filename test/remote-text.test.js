// Remote-written text in errors (SAFETY.md "Remote text"): a server chooses the bytes of an ERR line, a band-3 message,
// an HTTP error body, a refused protocol line. None of them may reach an error message with a character that drives a
// terminal or forges a control sequence in a log. Expected values here are derived by hand from the input (each escape
// is the code point in hex, four digits in the BMP), and the "nothing unprintable" property is stated with a Unicode-category
// regex written in this file.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { remoteQuoted, remoteText } from '../src/errors.js';
import { v2Init, v2Step, v2End } from '../src/fetch.js';

const te = new TextEncoder();
// what a terminal or log acts on: controls (C0, DEL, C1) except tab and newline, format characters, separators, lone surrogates
const DRIVES = /(?![\t\n])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

test('remoteText: ESC sequences, CR, NUL, C1, DEL and bidi overrides are written as \\uXXXX', () => {
  // ESC = 0x1b, BEL = 0x07, CR = 0x0d, NUL = 0x00, CSI = 0x9b, DEL = 0x7f, RLO = 0x202e
  assert.equal(remoteText('\x1b]0;owned\x07\x1b[2J ok\r\x1b[K'), '\\u001b]0;owned\\u0007\\u001b[2J ok\\u000d\\u001b[K');
  assert.equal(remoteText('a\0b'), 'a\\u0000b');
  assert.equal(remoteText('x\u009b31m\x7f‮'), 'x\\u009b31m\\u007f\\u202e');
  // printable text, tab and newline are unchanged
  assert.equal(remoteText('denied to ivar\n\tsee https://example.com/é — 日本'), 'denied to ivar\n\tsee https://example.com/é — 日本');
  // quoted: JSON's escapes for quote, backslash and newline, then DEL, C1, a bidi override and U+2028
  assert.equal(remoteQuoted('a"b\\c\n\x7f\u009b‮ ', 60), '"a\\"b\\\\c\\n\\u007f\\u009b\\u202e\\u2028"');
});

test('remoteText: a 10 MB line is cut to the bound before any work, and a cut surrogate pair is escaped', () => {
  const big = '\x1b'.repeat(10 * 1024 * 1024);
  assert.equal(remoteText(big, 60), '\\u001b'.repeat(60));
  assert.equal(remoteQuoted(big, 60), `"${'\\u001b'.repeat(60)}"`);
  assert.equal(remoteText('a'.repeat(3000)).length, 1024); // the default bound
  // 59 units then U+1F600 (d83d de00): the cut at 60 leaves the lone high surrogate d83d
  assert.equal(remoteText('a'.repeat(59) + '\u{1f600}', 60), `${'a'.repeat(59)}\\ud83d`);
  assert.equal(remoteText('a'.repeat(58) + '\u{1f600}', 60), `${'a'.repeat(58)}\u{1f600}`);
});

test('remoteText: invalid UTF-8 decodes to U+FFFD and nothing unprintable is left', () => {
  const decoded = new TextDecoder().decode(Uint8Array.from([0x41, 0xff, 0xfe, 0xc3, 0x28, 0x1b, 0x42]));
  assert.equal(remoteText(decoded), 'A���(\\u001bB');
  for (let cp = 0; cp < 0x3000; cp++) {
    assert.equal(DRIVES.test(remoteText(`x${String.fromCodePoint(cp)}y`)), false, `U+${cp.toString(16)}`);
    assert.equal(DRIVES.test(remoteQuoted(`x${String.fromCodePoint(cp)}y`)), false, `quoted U+${cp.toString(16)}`);
  }
  // lone surrogates, and U+E0001 (a tag character, above the BMP)
  assert.equal(remoteText('\ud800 \udfff \u{e0001}'), '\\ud800 \\udfff \\u{e0001}');
  assert.equal(DRIVES.test(remoteQuoted('\ud800\x1b\u{e0001}‏')), false);
});

// the v2 fetch answer, one frame at a time (the frames are written here, not by ply)
const step = (lines, done) => {
  let st = v2Init();
  for (const l of [...lines, null]) { const r = v2Step(st, l === null ? { kind: 'flush' } : { kind: 'data', payload: te.encode(l) }); if (!r.ok) return r; st = r.value.state; }
  return v2End(st, done);
};

test('fetch: a refused acknowledgment line is quoted cut to 60 units and escaped; the ready message is exact', () => {
  const junk = step(['acknowledgments\n', 'x\x1b[2J\u009b31m\x7f‮\n'], false);
  assert.deepEqual([junk.ok, junk.error.code, junk.error.message], [false, 'protocol', 'v2: unexpected acknowledgment line "x\\u001b[2J\\u009b31m\\u007f\\u202e"']);
  // boundary: 60 units are shown whole, the 61st is cut
  const at60 = step(['acknowledgments\n', `${'k'.repeat(60)}\n`], false);
  assert.equal(at60.error.message, `v2: unexpected acknowledgment line "${'k'.repeat(60)}"`);
  const at61 = step(['acknowledgments\n', `${'k'.repeat(60)}Z\n`], false);
  assert.equal(at61.error.message, `v2: unexpected acknowledgment line "${'k'.repeat(60)}"`);
  const ready = step(['acknowledgments\n', 'ready\n'], false);
  assert.deepEqual([ready.ok, ready.error.code, ready.error.message], [false, 'protocol', 'v2: the server said ready and sent no packfile section']);
});

test('fetch: an ERR line reaches remote_error escaped', () => {
  const r = step(['ERR \x1b]0;owned-title\x07\x1b[2J\x1b[1;1H\x1b[32mEverything up-to-date\x1b[0m\r\x1b[K\n'], true);
  assert.deepEqual([r.ok, r.error.code], [false, 'remote_error']);
  assert.equal(r.error.message, 'remote: \\u001b]0;owned-title\\u0007\\u001b[2J\\u001b[1;1H\\u001b[32mEverything up-to-date\\u001b[0m\\u000d\\u001b[K');
  assert.equal(DRIVES.test(r.error.message), false);
});

// The inventory: every place in src/ that puts remote-written text into an error message or a span attribute, by file
// and number of remoteText( / remoteQuoted( calls. A new site is added here in the same change; a site that quotes
// remote text in one of the old shapes is caught by the patterns below.
const SITES = { 'caps.ts': 2, 'fetch.ts': 3, 'http.ts': 2, 'lsrefs.ts': 4, 'negotiate.ts': 1, 'push.ts': 3, 'receivecaps.ts': 1 };
test('inventory: remote text reaches an error only through remoteText / remoteQuoted', () => {
  const dir = new URL('../src/', import.meta.url);
  const found = {};
  const raw = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.ts')).sort()) {
    if (name === 'errors.ts') continue; // the helpers themselves
    const lines = readFileSync(new URL(name, dir), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.startsWith('import ')) return;
      const calls = line.split(/remote(?:Text|Quoted)\(/u).length - 1;
      if (calls > 0) found[name] = (found[name] ?? 0) + calls;
      // the old shapes: `remote: ${…}` and a JSON-quoted remote line, without the helper
      if (/`remote: \$\{(?!remoteText\()/u.test(line) || /JSON\.stringify\((?:(?:line|first|head|a)\.slice|first\)|ct\))/u.test(line)) raw.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(raw, []);
  assert.deepEqual(found, SITES);
});
