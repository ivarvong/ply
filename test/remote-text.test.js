// Remote-written text in errors (SAFETY.md "Remote text"): a server chooses the bytes of an ERR line, a band-3 message,
// an HTTP error body, a refused protocol line. None of them may reach an error message with a character that drives a
// terminal or forges a control sequence in a log. Expected values here are derived by hand from the input (each escape
// is the code point in hex, four digits in the BMP), and the "nothing unprintable" property is stated with a Unicode-category
// regex written in this file.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { remoteQuoted, remoteText } from '../src/errors.js';
import { v2Init, v2Step, v2End } from '../src/fetch.js';
import { parseCapabilitiesV2 } from '../src/caps.js';
import { parseLsRefLine } from '../src/lsrefs.js';
import { outcomeResult } from '../src/push.js';
import { listRefs, readFile } from '../src/index.js';

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

// v2End names the sections of an answer that has no packfile section. A section header is a line the server chooses:
// each name is shown cut to 60 units and escaped, and at most 8 names are shown. Expected values are written out by hand.
test('fetch: the section names in "no packfile section" are escaped, cut to 60 units each, and at most 8 are shown', () => {
  // ESC ] 0 ; owned BEL, ESC [ 2 J, C1 CSI (U+009B), RLO (U+202E)
  const hostile = step(['\x1b]0;owned\x07\x1b[2J\u009b31m‮\n'], true);
  assert.deepEqual([hostile.ok, hostile.error.code], [false, 'protocol']);
  assert.equal(hostile.error.message, 'v2: no packfile section (sections: \\u001b]0;owned\\u0007\\u001b[2J\\u009b31m\\u202e)');
  assert.equal(DRIVES.test(hostile.error.message), false);
  // names git writes are shown as they were, and no section at all is still "none"
  assert.equal(step(['acknowledgments\n', 'NAK\n'], true).error.message, 'v2: no packfile section (sections: acknowledgments)');
  assert.equal(step(['shallow-info\n'], false).error.message, 'v2: no packfile section (sections: shallow-info)');
  assert.equal(step([], true).error.message, 'v2: no packfile section (sections: none)');
  // one header of 65000 units: 60 are shown. 61 units: the 61st is cut.
  assert.equal(step([`${'a'.repeat(65000)}\n`], true).error.message, `v2: no packfile section (sections: ${'a'.repeat(60)})`);
  assert.equal(step([`${'k'.repeat(60)}Z\n`], true).error.message, `v2: no packfile section (sections: ${'k'.repeat(60)})`);
  // 12 sections (a delim frame between them starts the next header): the first 8 are shown. 8 names: all 8.
  const many = n => { let st = v2Init(); for (let i = 0; i < n; i++) { st = v2Step(st, data(`s${i}\n`)).value.state; st = v2Step(st, { kind: 'delim' }).value.state; } return v2End(v2Step(st, { kind: 'flush' }).value.state, true); };
  assert.equal(many(12).error.message, 'v2: no packfile section (sections: s0,s1,s2,s3,s4,s5,s6,s7)');
  assert.equal(many(8).error.message, 'v2: no packfile section (sections: s0,s1,s2,s3,s4,s5,s6,s7)');
  // the whole message is bounded whatever the server sends: 8 names of 60 escaped units (6 characters each) and 7 commas
  const worst = (() => { let st = v2Init(); for (let i = 0; i < 12; i++) { st = v2Step(st, data(`${'\x1b'.repeat(65000)}\n`)).value.state; st = v2Step(st, { kind: 'delim' }).value.state; } return v2End(v2Step(st, { kind: 'flush' }).value.state, true); })();
  assert.equal(worst.error.message.length, 'v2: no packfile section (sections: )'.length + 8 * 60 * 6 + 7);
});

// A credential the server echoes is scrubbed before the text is cut (SAFETY.md I43): a cut that falls inside the
// credential must leave none of it. The token is 40 capital letters; the padding is dots and every other character of
// the expected message is lower case, a digit, a bracket, a colon or a space, so "no character of the token is in the
// message" is checked without ply's scrubber. The expected message is derived by hand: the token is replaced by the
// scrubber's marker "[redacted]", then 1024 units of the text are kept.
const TOKEN = 'ZQXLWJVKMNPTYHBGFSUCZQXLWJVKMNPTYHBGFSUC';
const CUTS = [1024 - 39, 1024 - 20, 1024 - 11, 1024 - 5, 1024 - 1]; // padding lengths that put the cut inside the token
const echoed = pad => `${'.'.repeat(pad)}${TOKEN} denied`;
const kept = pad => `${'.'.repeat(pad)}[redacted] denied`.slice(0, 1024);
const leaked = message => [...new Set(TOKEN)].filter(c => message.includes(c));
const handScrub = s => s.replaceAll(TOKEN, '[redacted]');
const data = s => ({ kind: 'data', payload: te.encode(s) });

test('a credential across the 1024-unit cut: the step functions scrub first (caps, ls-refs, fetch ERR, fetch band 3, push band 3)', () => {
  for (const pad of CUTS) {
    const sites = {
      caps: parseCapabilitiesV2([data(`ERR ${echoed(pad)}`)], handScrub),
      lsRefs: parseLsRefLine(`ERR ${echoed(pad)}`, handScrub),
      fetchErr: v2Step(v2Init(), data(`ERR ${echoed(pad)}\n`), handScrub),
      fetchBand3: v2Step(v2Step(v2Init(), data('packfile\n')).value.state, data(`\x03${echoed(pad)}\n`), handScrub),
    };
    for (const [site, r] of Object.entries(sites)) {
      assert.deepEqual([site, r.ok, r.error.code, r.error.message], [site, false, 'remote_error', `remote: ${kept(pad)}`]);
      assert.deepEqual(leaked(r.error.message), [], `${site} pad=${pad}`);
    }
    const pushed = outcomeResult({ tag: 'ambiguous', why: 'band 3' }, { report: null, hookOutput: '', remote: echoed(pad), commands: [] }, handScrub);
    assert.deepEqual([pushed.ok, pushed.error.code, pushed.error.message], [false, 'ambiguous', `push outcome unknown: remote: ${kept(pad)}: band 3`]);
    assert.deepEqual(leaked(pushed.error.message.replace(/: band 3$/u, '')), [], `push pad=${pad}`);
  }
});

// The same through the exchanges, with ply's own scrubber (auth.token): a server written here answers ls-refs or fetch
// with the token inside an ERR line or a band-3 message.
test('a credential across the 1024-unit cut: listRefs (ERR) and readFile (fetch ERR, fetch band 3) carry none of it', async () => {
  const pkt = s => { const b = Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
  const FLUSH = Buffer.from('0000');
  const advert = Buffer.concat([pkt('version 2\n'), pkt('agent=git/2.50.0\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done filter\n'), pkt('object-format=sha1\n'), FLUSH]);
  let answer = () => FLUSH;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' }); res.end(advert); return; }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(answer(Buffer.concat(chunks).toString('latin1')));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/repo.git`;
  const listing = Buffer.concat([pkt(`${'1'.repeat(40)} refs/heads/main\n`), FLUSH]);
  const lsRefs = body => body.includes('command=ls-refs');
  try {
    for (const pad of CUTS) {
      const cases = {
        lsRefsErr: [() => pkt(`ERR ${echoed(pad)}\n`), () => listRefs(url, {}, { auth: { token: TOKEN } })],
        fetchErr: [body => (lsRefs(body) ? listing : pkt(`ERR ${echoed(pad)}\n`)), () => readFile(url, { ref: 'main', path: 'a' }, { auth: { token: TOKEN } })],
        fetchBand3: [body => (lsRefs(body) ? listing : Buffer.concat([pkt('packfile\n'), pkt(`\x03${echoed(pad)}\n`)])), () => readFile(url, { ref: 'main', path: 'a' }, { auth: { token: TOKEN } })],
      };
      for (const [name, [serve, call]] of Object.entries(cases)) {
        answer = serve;
        const r = await call();
        assert.deepEqual([name, pad, r.ok, r.error.code, r.error.message], [name, pad, false, 'remote_error', `remote: ${kept(pad)}`]);
        assert.deepEqual(leaked(r.error.message), [], `${name} pad=${pad}`);
      }
    }
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

// The inventory: every place in src/ that puts remote-written text into an error message or a span attribute, by file
// and number of remoteText( / remoteQuoted( calls. A new site is added here in the same change; a site that quotes
// remote text in one of the old shapes is caught by the patterns below.
const SITES = { 'caps.ts': 2, 'fetch.ts': 4, 'http.ts': 2, 'lsrefs.ts': 4, 'negotiate.ts': 1, 'push.ts': 3, 'receivecaps.ts': 1 };
// a message that interpolates the section names a server sent (v2End) with no helper on the line
const RAW_SECTIONS = line => /\$\{[^`]*\bsections\b/u.test(line) && !/remote(?:Text|Quoted)\(/u.test(line);
test('inventory: the raw-shape patterns see a section list interpolated without the helper', () => {
  // v2End's line as it was written before it was routed, and as it is written now
  assert.equal(RAW_SECTIONS("  if (done || !acks) return proto(`v2: no packfile section (sections: ${st.sections.join(',') || 'none'})`);"), true);
  assert.equal(RAW_SECTIONS("  if (done || !acks) return proto(`v2: no packfile section (sections: ${st.sections.slice(0, SECTIONS_SHOWN).map(s => remoteText(s, SECTION_SHOWN)).join(',') || 'none'})`);"), false);
});
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
      if (/`remote: \$\{(?!remoteText\()/u.test(line) || /JSON\.stringify\((?:(?:line|first|head|a)\.slice|first\)|ct\))/u.test(line) || RAW_SECTIONS(line)) raw.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(raw, []);
  assert.deepEqual(found, SITES);
});
