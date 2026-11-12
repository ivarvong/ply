// ply#274: the fetch filter-refusal predicate and readConfig's key/value line, both rewritten to run in linear time.
//
// The oracle for WHAT each one classifies is the pattern main (8e3939d) applied, run here by the regex engine on short
// inputs where its cost does not matter, plus the real refusal texts (Cloudflare Artifacts, observed 2026-10-23; git's
// upload-pack, upload-pack.c "filter '%s' not supported") and `git config --file … --list` for the config forms ply reads.
// The oracle for the COST is a ratio of two times measured the same way (the issue's generator), never a time.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isFilterRefusal, isFilterRejection } from '../src/fetch.js';
import { readConfig } from '../src/repo-node.js';

const OLD_FILTER = /only blob:none is supported|unsupported (git )?fetch filter|filter .* not (supported|allowed)/i;
const OLD_KV = /^([A-Za-z][\w-]*)\s*(=\s*(.*))?$/u;

test('the refusal texts servers really send are refusals at 400 and nothing else', () => {
  const real = [
    'Unsupported Git fetch filter; only blob:none is supported.',
    'HTTP 400 git-upload-pack: Unsupported Git fetch filter; only blob:none is supported.',
    "filter 'tree' not supported",
    "filter 'sparse:oid' not supported",
    "git upload-pack: filter 'blob:limit' not supported",
    'filter blob:limit=1 not allowed',
    'filter tree:0 not supported',
    'unsupported fetch filter',
    'unsupported git fetch filter',
  ];
  for (const t of real) {
    assert.equal(isFilterRefusal(400, t), true, t);
    assert.equal(isFilterRefusal(500, t), false, t);
    assert.equal(isFilterRejection({ code: 'remote_error', message: t }), true, t);
  }
  for (const t of ['filter not allowed', 'filter\nnot supported', 'filter x\r not supported', 'not supported filter ', 'fetch filter=blob:none', '']) {
    assert.equal(isFilterRefusal(400, t), false, JSON.stringify(t));
  }
});

test('isFilterRefusal classifies every message of up to 4 tokens exactly as main\'s regex did', () => {
  const tokens = ['filter ', 'FiLtEr ', ' not supported', ' NOT Allowed', ' not', ' ', 'x', '\n', '\r', ' ', ' ',
    'unsupported git fetch filter', 'only blob:none is supported', 'İ', 'K', 'filte'];
  let checked = 0;
  const walk = (text, left) => {
    assert.equal(isFilterRefusal(400, text), OLD_FILTER.test(text), JSON.stringify(text));
    checked += 1;
    if (left > 0) for (const t of tokens) walk(text + t, left - 1);
  };
  walk('', 4);
  assert.ok(checked > 69000);
});

// readConfig as main had it, the config-line regex the only change.
const oldReadConfig = text => {
  const out = new Map();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const head = /^\[([^\]\s"]+)(\s+"([^"]*)")?\]$/u.exec(line);
    if (head !== null) { section = head[3] !== undefined ? `${head[1].toLowerCase()}.${head[3]}` : head[1].toLowerCase(); continue; }
    const kv = OLD_KV.exec(line);
    if (kv !== null && section !== '') out.set(`${section}.${kv[1].toLowerCase()}`, (kv[3] ?? 'true').trim());
  }
  return out;
};

test('readConfig reads every key/value line of up to 6 characters exactly as main\'s regex did', () => {
  const alphabet = ['a', '=', ' ', '\t', '\r', ' ', ' ', 'x', '-'];
  let checked = 0;
  const walk = (line, left) => {
    if (!line.includes('#') && !line.includes(';')) {
      assert.deepEqual([...readConfig(`[s]\n${line}`)], [...oldReadConfig(`[s]\n${line}`)], JSON.stringify(line));
      checked += 1;
    }
    if (left > 0) for (const c of alphabet) walk(line + c, left - 1);
  };
  walk('', 6);
  assert.ok(checked > 500000);
});

test('readConfig agrees with git config --list on the forms ply reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-274-'));
  try {
    const file = join(dir, 'config');
    const git = (...a) => spawnSync('git', ['config', '--file', file, ...a], { encoding: 'utf8' });
    git('core.bare', 'false');
    git('extensions.objectFormat', 'sha1');
    git('extensions.refStorage', 'files');
    git('remote.origin.url', 'https://example.com/a b.git');
    git('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git('branch.main.remote', 'origin');
    const text = `${readFileSync(file, 'utf8')}\tbare2 =   spaced value  \n\tflag\n`;
    const listed = spawnSync('git', ['config', '-f', '-', '--list'], { input: text, encoding: 'utf8' }).stdout.trim().split('\n')
      .map(l => { const i = l.indexOf('='); return i < 0 ? [l, 'true'] : [l.slice(0, i), l.slice(i + 1)]; });
    const ours = readConfig(text);
    for (const [k, v] of listed) {
      const dot = k.lastIndexOf('.');
      assert.equal(ours.get(`${k.slice(0, dot)}.${k.slice(dot + 1).toLowerCase()}`), v, k);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ratio = (f, gen, n) => {
  const time = m => { const s = gen(m); let best = Infinity; for (let i = 0; i < 7; i++) { const t0 = performance.now(); f(s); best = Math.min(best, performance.now() - t0); } return best; };
  return time(4 * n) / time(n);
};

test('both stay linear on the issue\'s generators (4x the input costs well under 16x the time)', () => {
  for (const [name, f, gen] of [
    ['filter', s => isFilterRefusal(400, s), n => 'filter '.repeat(n)],
    ['config', s => readConfig(`[s]\n${s}`), n => `a=${' '.repeat(n)}x\ry`],
  ]) {
    let best = Infinity;
    for (let a = 0; a < 3 && best >= 9; a++) best = Math.min(best, ratio(f, gen, 20000));
    assert.ok(best < 9, `${name}: ${best.toFixed(1)}x`);
  }
});
