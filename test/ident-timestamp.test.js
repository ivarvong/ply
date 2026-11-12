// The timestamp of an author, committer or tagger line is the remote's text, bounded only by maxObjectSize. Deciding
// whether it overflows git's range must not cost more than a benign object of the same size: the run of digits is
// judged by its length before any of it is converted (objects/ident-timestamp-bigint-cpu).
// The verdicts on the boundary values are git's: `git fsck --strict` over a repository holding the hand-built object.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommit, parseTag, fsckIdent } from '../src/objects.js';

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree
const latin1 = s => new Uint8Array(Buffer.from(s, 'latin1'));
// Hand-built from the object formats, not ply's encoders.
const commitText = (time, message = 'm\n') => `tree ${TREE}\nauthor A <a@b> ${time} +0000\ncommitter A <a@b> 1700000000 +0000\n\n${message}`;
const tagText = (time, message = 'm\n') => `object ${TREE}\ntype tree\ntag v1\ntagger A <a@b> ${time} +0000\n\n${message}`;

// The work counter: every digit handed to BigInt while fn runs. Converting a decimal string to a BigInt is the only
// superlinear step an ident parse can take, so this is the cost the remote controls. (If the parser ever stops using
// BigInt, the benign assertion below fails and this counter is replaced; it does not silently pass.)
function digitsConverted(fn) {
  const real = globalThis.BigInt;
  let digits = 0;
  globalThis.BigInt = new Proxy(real, {
    apply(target, self, args) {
      if (typeof args[0] === 'string') digits += args[0].length;
      return Reflect.apply(target, self, args);
    },
  });
  try { return { value: fn(), digits }; } finally { globalThis.BigInt = real; }
}

// 2^63 - 1 is 19 digits, so no verdict needs more than 19 digits of any one timestamp.
const MOST_DIGITS_ONE_IDENT_NEEDS = 19;

test('a huge timestamp costs no more conversion work than a benign object of the same size, and is still badDateOverflow', () => {
  for (const [parse, text, idents] of [[parseCommit, commitText, 2], [parseTag, tagText, 1]]) {
    for (const n of [100_000, 200_000, 400_000]) {
      const hostileBytes = latin1(text('9'.repeat(n)));
      // the same size, the bulk in the message; its idents carry ordinary 10-digit times
      const benignBytes = latin1(text('1700000000', `${'9'.repeat(n - 10)}m\n`));
      assert.equal(benignBytes.length, hostileBytes.length, 'same-size objects');
      const benign = digitsConverted(() => parse(benignBytes));
      assert.equal(benign.value.ok, true, 'benign object parses');
      // the counter is live: each ident of the benign object has a 10-digit time
      assert.equal(benign.digits, 10 * idents, `${parse.name} benign n=${n}: digits converted`);
      const hostile = digitsConverted(() => parse(hostileBytes));
      assert.equal(hostile.value.ok, false);
      assert.equal(hostile.value.error.code, 'pack_corrupt');
      assert.equal(hostile.value.error.msgId, 'badDateOverflow');
      assert.ok(hostile.digits <= MOST_DIGITS_ONE_IDENT_NEEDS * idents,
        `${parse.name} n=${n}: ${hostile.digits} digits converted for the hostile object, ${benign.digits} for the same-size benign one (ratio ${(hostile.digits / benign.digits).toFixed(1)}; bound ${MOST_DIGITS_ONE_IDENT_NEEDS * idents})`);
    }
  }
});

// The second work counter: every character the ident parser classifies as a digit. The digit run was still walked to
// its end one classification a digit after BigInt stopped seeing it: linear, but about 200 times the CPU of a same-size
// benign object (the reviewer's exp6-cputime.mjs on 91f0e71: 64 ms against 0.3 ms at 4M digits).
// The expected bound is git's rule, not ply's code: with no leading zero a 20th digit is already past 2^63 - 1, and
// fsck_ident reports the overflow before it reads what follows the digits, so 20 digits of one timestamp decide it.
// The count goes through the classifier fsckIdent takes as a parameter (a RegExp; parseCommit and parseTag pass the
// module's own), so nothing global is patched (#276) and the gate c recorder's own regex calls are never counted.
class CountingDigit extends RegExp {
  constructor() { super('^[0-9]$', 'u'); this.tests = 0; }
  test(s) { this.tests++; return super.test(s); }
}
function charsClassified(text, at, kind, role) {
  const digit = new CountingDigit();
  return { value: fsckIdent(text, at, kind, role, digit), tests: digit.tests };
}
const AT = { commit: `tree ${TREE}\nauthor `.length, tag: `object ${TREE}\ntype tree\ntag v1\ntagger `.length };

test('a huge timestamp is not walked to its end: the characters classified do not grow with the digit run', () => {
  for (const [kind, role, text] of [['commit', 'author', commitText], ['tag', 'tagger', tagText]]) {
    const counts = [];
    for (const n of [100_000, 200_000, 400_000]) {
      const benign = charsClassified(text('1700000000', `${'9'.repeat(n - 10)}m\n`), AT[kind], kind, role);
      assert.equal(benign.value.ok, true, 'benign ident parses');
      // the counter is live, by hand: 1 for the first digit, 11 for the 10-digit run (its 10 digits and the space that
      // ends it), 4 for the time zone digits
      assert.equal(benign.tests, 1 + 11 + 4, `${kind} benign n=${n}: characters classified`);
      const hostile = charsClassified(text('9'.repeat(n)), AT[kind], kind, role);
      assert.equal(hostile.value.ok, false);
      assert.equal(hostile.value.error.msgId, 'badDateOverflow');
      // by hand from git's rule: 1 for the first digit, then the run is read to its 20th digit and no further
      assert.equal(hostile.tests, 1 + 20, `${kind} n=${n}: characters classified for the hostile ident`);
      counts.push(hostile.tests);
    }
    assert.deepEqual(counts, [counts[0], counts[0], counts[0]], `${kind}: the same work at 100k, 200k and 400k digits`);
  }
});

// parseCommit and parseTag still refuse the hostile object (the whole-object verdict, independent of the counter)
test('parseCommit and parseTag refuse a huge timestamp as badDateOverflow', () => {
  for (const [parse, text] of [[parseCommit, commitText], [parseTag, tagText]]) {
    const r = parse(latin1(text('9'.repeat(100_000))));
    assert.equal(r.ok, false);
    assert.equal(r.error.msgId, 'badDateOverflow');
  }
});

function git(dir, args, input) {
  const r = spawnSync('git', ['-C', dir, ...args], { input, maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}
// git's verdict on one object: fsck --strict over a fresh repository holding it and the empty tree it points at.
function fsck(type, text) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-ident-time-'));
  try {
    assert.equal(git(dir, ['init', '-q', '-b', 'main']).code, 0);
    assert.equal(git(dir, ['hash-object', '-t', 'tree', '-w', '--stdin'], '').out.trim(), TREE);
    const w = git(dir, ['hash-object', '-t', type, '-w', '--stdin', '--literally'], Buffer.from(text, 'latin1'));
    assert.equal(w.code, 0, w.err);
    const r = git(dir, ['fsck', '--strict']);
    return { accepted: r.code === 0, overflow: /badDateOverflow/u.test(r.err + r.out), text: (r.err + r.out).trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Around 2^63 - 1 (9223372036854775807) and the 19 / 20-digit edge the length rule decides on. Git says which overflow.
const BOUNDARY = [
  '0', '1700000000',
  '999999999999999999', // 18 digits
  '1000000000000000000', // the least 19-digit value
  '9223372036854775806', '9223372036854775807', '9223372036854775808', // 2^63 - 2, 2^63 - 1, 2^63
  '9999999999999999999', // the greatest 19-digit value
  '10000000000000000000', // the least 20-digit value
  '18446744073709551615', '18446744073709551616', // 2^64 - 1, 2^64
  '99999999999999999999', // the greatest 20-digit value
  '100000000000000000000', // 21 digits
  '9'.repeat(40),
];

test('the 19 / 20-digit boundary timestamps get git fsck\'s verdict from parseCommit and parseTag', () => {
  const disagreements = [];
  const verdicts = { accepted: 0, overflow: 0 };
  for (const [type, parse, text] of [['commit', parseCommit, commitText], ['tag', parseTag, tagText]]) {
    for (const time of BOUNDARY) {
      const theirs = fsck(type, text(time));
      // every refusal in these cells must be the overflow one: anything else means the cell is not testing the date
      assert.equal(theirs.accepted || theirs.overflow, true, `${type} ${time}: git refused for another reason: ${theirs.text}`);
      verdicts[theirs.accepted ? 'accepted' : 'overflow']++;
      const ours = parse(latin1(text(time)));
      const oursVerdict = ours.ok ? 'accepted' : `${ours.error.code} ${ours.error.msgId}`;
      const gitVerdict = theirs.accepted ? 'accepted' : 'pack_corrupt badDateOverflow';
      if (oursVerdict !== gitVerdict) disagreements.push(`${type} ${time} (${time.length} digits): git ${gitVerdict}, ply ${oursVerdict}`);
    }
  }
  assert.deepEqual(disagreements, []);
  // the oracle saw both sides of the boundary
  assert.ok(verdicts.accepted >= 8 && verdicts.overflow >= 8, JSON.stringify(verdicts));
});
