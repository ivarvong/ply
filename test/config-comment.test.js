// readConfig drops a `#` or `;` comment from each line of a stored .git/config in time linear in the line.
//
// The oracle for WHAT is dropped is the pattern main (ec337c5) applied, `/[#;].*$/u`, run here by the regex engine on
// short lines where its cost does not matter: the comment starts at the first `#` or `;` that has no LF, CR, U+2028 or
// U+2029 after it (`.` stops at those, and `$` without the m flag is only the end of the line). The oracle for the COST
// is a ratio of two times measured the same way, never a time.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { configCommentStart } from '../src/transport.js';
import { readConfig } from '../src/repo-node.js';

test('configCommentStart cuts exactly where main\'s pattern cut, for every line of up to 5 characters over an 8-letter alphabet', () => {
  const alphabet = ['a', ' ', '#', ';', '\n', '\r', '\u2028', '\u2029'];
  let checked = 0;
  const walk = (line, left) => {
    assert.equal(line.slice(0, configCommentStart(line)), line.replace(/[#;].*$/u, ''), JSON.stringify(line));
    checked += 1;
    if (left > 0) for (const c of alphabet) walk(line + c, left - 1);
  };
  walk('', 5);
  assert.equal(checked, (8 ** 6 - 1) / 7); // 1 + 8 + ... + 8^5 lines: the walk reached every one
  // An astral character and a lone surrogate are one `.` each under the u flag: neither ends a comment.
  for (const line of ['k = v # \u{1F600} x', 'k = v ; \uD83D x', '# \uDE00\r; y', 'k = "a#b"']) assert.equal(line.slice(0, configCommentStart(line)), line.replace(/[#;].*$/u, ''), JSON.stringify(line));
});

test('readConfig: values main read are unchanged, with LF and with CRLF line ends', () => {
  // Hand-derived from the rule above. With CRLF the CR ends the line after the comment, so main kept the comment in the
  // value (git itself drops it); this change keeps main's reading and only bounds its cost.
  const lf = readConfig('[core]\n\tbare = false ; comment\n# [x]\n[Extensions]\n\tObjectFormat = sha256 # why\n');
  assert.deepEqual([...lf], [['core.bare', 'false'], ['extensions.objectformat', 'sha256']]);
  const crlf = readConfig('[core]\r\n\tbare = false ; comment\r\n# [x]\r\n[Extensions]\r\n\tObjectFormat = sha256\r\n');
  assert.deepEqual([...crlf], [['core.bare', 'false ; comment'], ['extensions.objectformat', 'sha256']]);
});

test('readConfig: a CRLF line of 64x the comment characters costs under 300x the time (linear is 64x, quadratic 4096x)', () => {
  // One call on a line of 64n `#` against 64 calls on a line of n: linear work is equal, quadratic work is 64 times
  // more. Best of 5 each, so load only ever narrows the ratio's noise, never widens it.
  const N = 500;
  const small = `[core]\n${'#'.repeat(N)}\r\n`;
  const big = `[core]\n${'#'.repeat(64 * N)}\r\n`;
  const best = (fn) => { let b = Infinity; for (let i = 0; i < 5; i++) { const t0 = performance.now(); fn(); b = Math.min(b, performance.now() - t0); } return b; };
  const smallMs = best(() => { for (let i = 0; i < 64; i++) readConfig(small); }) / 64;
  const bigMs = best(() => readConfig(big));
  assert.ok(bigMs < 300 * smallMs, `64x the comment characters cost ${(bigMs / smallMs).toFixed(0)}x the time (${bigMs.toFixed(3)} ms against ${smallMs.toFixed(5)} ms)`);
});
