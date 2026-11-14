// The Option constructors a public signature takes (encodeSavedIndex's `resolved`, loadTransferPack's `saved`) are
// importable from the package root (#301 item 3). `none` is one shared plain object: README says never assign to it; nothing here freezes or checks that.
// Expected values come from the README contract: `some(value)` is `{ tag: 'some', value }`, `none` is `{ tag: 'none' }`.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ply from '../src/index.js';
import { tmpRoot, git } from './server.js';

const { some, none, isSome, isNone, matchOption, encodeSavedIndex, decodeSavedIndex, scanPackIndex } = ply;

test('Option constructors and helpers are root exports and behave as README says', () => {
  for (const name of ['some', 'none', 'isSome', 'isNone', 'matchOption']) assert.ok(name in ply, `root exports ${name}`);
  const bytes = new Uint8Array([1, 2, 3]);
  const s = some(bytes);
  assert.deepEqual(s, { tag: 'some', value: bytes });
  assert.deepEqual(none, { tag: 'none' });
  assert.equal(isSome(s), true);
  assert.equal(isNone(s), false);
  assert.equal(isSome(none), false);
  assert.equal(isNone(none), true);
  const h = { some: v => `some:${v.length}`, none: () => 'none' };
  assert.deepEqual(matchOption(s, h), { ok: true, value: 'some:3' });
  assert.deepEqual(matchOption(none, h), { ok: true, value: 'none' });
});

// #296 at the root: an argument that is not an Option is no Option. Expected from README "Saved pack index": isSome and
// isNone answer false, matchOption answers bad_request naming the argument, and a branch that throws is bad_request
// naming 'matchOption handler' with the thrown value as cause. None of them throws.
test('the root Option helpers answer a wrong shape as a value, never a throw (#296)', () => {
  const h = { some: () => 1, none: () => 2 };
  for (const bad of [null, undefined, 5, 'some', [], {}, { tag: 'other' }]) {
    assert.equal(isSome(bad), false, String(bad));
    assert.equal(isNone(bad), false, String(bad));
    const r = matchOption(bad, h);
    assert.deepEqual([r.ok, r.error.code, r.error.what], [false, 'bad_request', 'option'], String(bad));
  }
  assert.equal(isSome({ tag: 'some', value: 0 }), true);
  assert.equal(isNone({ tag: 'none' }), true);
  for (const bad of [null, undefined, 5, [], {}, { some: () => 1 }, { none: () => 2 }, { some: 1, none: () => 2 }, { some: () => 1, none: 'x' }]) {
    for (const o of [some(1), none]) {
      const r = matchOption(o, bad);
      assert.deepEqual([r.ok, r.error.code, r.error.what], [false, 'bad_request', 'handlers'], JSON.stringify(bad));
    }
  }
  const boom = new Error('boom');
  for (const o of [some(1), none]) {
    const r = matchOption(o, { some: () => { throw boom; }, none: () => { throw boom; } });
    assert.deepEqual([r.ok, r.error.code, r.error.what, r.error.cause], [false, 'bad_request', 'matchOption handler', boom]);
  }
});

test('encodeSavedIndex takes the root none, and decodeSavedIndex gives none back for an unresolved index', async () => {
  const { root, cleanup } = tmpRoot();
  const repo = join(root, 'r');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=A', '-c', 'user.email=a@x', 'commit', '-qm', 'one']);
  const pack = new Uint8Array(execFileSync('git', ['-C', repo, 'pack-objects', '--stdout', '--revs'], { input: 'HEAD\n' }));
  const scanned = await scanPackIndex(new ReadableStream({ start(c) { c.enqueue(pack); c.close(); } }));
  assert.ok(scanned.ok);
  const enc = encodeSavedIndex(scanned.value, none);
  assert.ok(enc.ok);
  const trailer = Buffer.from(pack.subarray(pack.length - 20)).toString('hex');
  const dec = decodeSavedIndex(enc.value, { trailer, bytes: pack.length });
  assert.ok(dec.ok);
  assert.equal(isNone(dec.value.resolved), true);
  assert.equal(dec.value.pack.count, 3); // git's pack: one commit, one tree, one blob
  cleanup();
});
