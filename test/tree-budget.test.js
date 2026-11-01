// Issue #140. listTree of a tree at maxTreeEntries used to die in a 128 MiB heap, and the refusal one
// entry past the cap ran only after the array of entries already existed (~350 MB RSS). The count of
// framed entries happens first; the hex id is a getter. Git is the oracle for a tree at the cap (git
// stores it). One entry past the cap is ply's typed limit, which git does not have.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTree, encodeTree } from '../src/objects.js';
import { toHex } from '../src/sha1.js';
import { LIMIT_TREE_ENTRIES } from '../src/limits.js';
import { OID_BYTES, TREE_ENTRY_MIN } from '../src/format.js';
import { te } from '../src/bytes.js';
import { git, gitBuf, tmpRoot } from './server.js';

const MODE = '100644 ';
const NAME = 8;
const STRIDE = MODE.length + NAME + 1 + OID_BYTES;
const CAP = LIMIT_TREE_ENTRIES;
// Measured on this tree (zero-padded names, listTree-shaped map): about 242 MB at the cap and 125 MB
// on the refusal. The old refusal was ~270–350 MB and the cap OOM'd a 128 MiB heap. Headroom for CI.
const RSS_BOUND_MB = 320;

const entryAt = (buf, i) => {
  const o = i * STRIDE;
  buf.write(MODE, o, 'ascii');
  buf.write(String(i).padStart(NAME, '0'), o + MODE.length, 'ascii');
  buf[o + MODE.length + NAME] = 0;
  const id = o + MODE.length + NAME + 1;
  buf[id] = 1;
  buf[id + OID_BYTES - 1] = i & 0xff;
  buf[id + OID_BYTES - 2] = (i >>> 8) & 0xff;
  buf[id + OID_BYTES - 3] = (i >>> 16) & 0xff;
};

const build = n => {
  const buf = Buffer.alloc(n * STRIDE);
  for (let i = 0; i < n; i++) entryAt(buf, i);
  return buf;
};

const runChild = (file, count) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    '--max-old-space-size=128', '--import', './test/ts-resolve.mjs',
    'test/tree-budget-child.mjs', file, String(STRIDE), String(count),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  let err = '';
  child.stdout.on('data', d => out.push(d));
  child.stderr.on('data', d => { err += d; });
  child.on('close', status => {
    const text = Buffer.concat(out).toString();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* the heap killer prints no JSON */ }
    resolve({ status, parsed, err, text });
  });
  child.on('error', reject);
});

const throws = (fn, code, message) => {
  assert.throws(fn, e => e.code === code && e.message === message);
};

test('a framed entry past the cap is limit_exceeded, and a bad prefix is still pack_corrupt', () => {
  const oid = Uint8Array.of(1, ...new Uint8Array(OID_BYTES - 1));
  const raw = (text, id = oid) => {
    const body = te.encode(text);
    const out = new Uint8Array(body.length + id.length);
    out.set(body);
    out.set(id, body.length);
    return out;
  };
  const data = (...parts) => {
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n);
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return out;
  };
  throws(() => parseTree(data(raw('100644 a\0'), raw('100644 b\0')), { maxTreeEntries: 1 }), 'limit_exceeded', 'tree entries 2 exceeds limit 1');
  // Bytes after the cap are not parsed: a broken mode there does not become pack_corrupt.
  throws(() => parseTree(data(raw('100644 a\0'), te.encode('nope')), { maxTreeEntries: 1 }), 'limit_exceeded', 'tree entries 2 exceeds limit 1');
  throws(() => parseTree(raw('100644 .\0'), { maxTreeEntries: 1 }), 'pack_corrupt', 'tree: bad name');
  // The duplicate sits inside the cap, so it is reported even though another entry follows.
  throws(
    () => parseTree(data(raw('100644 a\0'), raw('100644 a\0', Uint8Array.of(2, ...new Uint8Array(OID_BYTES - 1))), raw('100644 b\0')), { maxTreeEntries: 2 }),
    'pack_corrupt',
    'tree: duplicate entry "a"',
  );
  const parsed = parseTree(raw('100644 a\0'));
  assert.equal(parsed.length, 1);
  assert.equal(Object.hasOwn(parsed[0], 'oid'), false);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['entryOffset', 'mode', 'name', 'oidOffset']);
  assert.equal(parsed[0].oid, toHex(oid));
  assert.ok(encodeTree(parsed).length >= TREE_ENTRY_MIN);
});

test('199999 and 200000 list under a 128 MiB heap; 200001 is a typed refusal and git agrees at the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-tree-'));
  const file = join(dir, 'tree');
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(file, build(CAP + 1));
    const at = await runChild(file, CAP);
    const under = await runChild(file, CAP - 1);
    const over = await runChild(file, CAP + 1);
    for (const r of [at, under]) {
      assert.equal(r.status, 0, r.err);
      assert.equal(r.parsed?.status, 'ok', r.text || r.err);
      assert.ok(r.parsed.rss < RSS_BOUND_MB, `rss ${r.parsed.rss}`);
    }
    assert.equal(under.parsed.n, CAP - 1);
    assert.equal(at.parsed.n, CAP);
    assert.equal(at.parsed.first.name, '00000000');
    assert.equal(at.parsed.last.name, String(CAP - 1).padStart(NAME, '0'));
    assert.equal(over.status, 0, over.err);
    assert.equal(over.parsed?.status, 'err', over.text || over.err);
    assert.equal(over.parsed.code, 'limit_exceeded');
    assert.equal(over.parsed.what, 'tree entries');
    assert.equal(over.parsed.got, CAP + 1);
    assert.equal(over.parsed.max, CAP);
    assert.ok(over.parsed.rss < RSS_BOUND_MB, `refusal rss ${over.parsed.rss}`);

    git(root, ['init', '--bare', 'r.git']);
    const bare = join(root, 'r.git');
    const slice = readFileSync(file).subarray(0, CAP * STRIDE);
    const oid = gitBuf(bare, ['hash-object', '-w', '-t', 'tree', '--stdin'], slice).toString().trim();
    assert.equal(git(bare, ['cat-file', '-t', oid]).trim(), 'tree');
    const listed = gitBuf(bare, ['ls-tree', oid]).toString().trim().split('\n');
    assert.equal(listed.length, CAP);
    const hash = createHash('sha256');
    for (const line of listed) {
      const tab = line.indexOf('\t');
      const name = line.slice(tab + 1);
      const id = line.slice(line.indexOf(' ', line.indexOf(' ') + 1) + 1, tab);
      hash.update(name);
      hash.update('\0');
      hash.update(id);
      hash.update('\0');
    }
    assert.equal(hash.digest('hex'), at.parsed.digest);
    assert.equal(listed[0].endsWith(`\t${at.parsed.first.name}`), true);
    assert.equal(listed[0].includes(at.parsed.first.oid), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});
