// Thin REF bases (#143). Every cell is a base git stored, a type the caller claims, and exact or flipped
// bytes. An honest base matches `git index-pack --stdin --strict --fix-thin` and `git cat-file`. Any other
// buffer is one `git hash-object` would not store under that oid, and resolvePack refuses it before applyDelta.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPack, parsePack, resolvePack, makeDelta } from '../../src/pack.js';
import { hashObject } from '../../src/objects.js';
import { cells } from './thin-base.space.js';

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000',
};

const git = (dir, args, input) => execFileSync('git', args, { cwd: dir, env: ENV, input, maxBuffer: 1 << 26 });
const line = (dir, args, input) => git(dir, args, input).toString().trim();

function gitHash(dir, typeName, bytes, literally) {
  const args = ['hash-object', ...(literally ? ['--literally'] : []), '-t', typeName, '--stdin'];
  try {
    return { ok: true, oid: line(dir, args, bytes) };
  } catch (e) {
    return { ok: false, status: e.status, err: String(e.stderr ?? '') };
  }
}

function flip(bytes) {
  const out = Uint8Array.from(bytes);
  const i = out.length - 1;
  out[i] = (out[i] ?? 0) ^ 1;
  return out;
}

function tagBytes(object, name, message) {
  return Buffer.from(`object ${object}\ntype commit\ntag ${name}\ntagger a <a@x> 1700000000 +0000\n\n${message}\n`);
}

test('thin REF base: every claim × byte form against git hash-object and index-pack --fix-thin', async () => {
  const all = cells();
  assert.equal(all.length, 4 * 8 * 2);
  const dir = mkdtempSync(join(tmpdir(), 'ply-thin-base-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    const blobBase = Buffer.from(`blob-base\n${'x'.repeat(64)}\n`);
    const blobNext = Buffer.from(`blob-base\n${'y'.repeat(64)}\n`);
    const blob0 = line(dir, ['hash-object', '-w', '-t', 'blob', '--stdin'], blobBase);
    const blob1 = line(dir, ['hash-object', '-w', '-t', 'blob', '--stdin'], blobNext);
    const tree0 = line(dir, ['mktree'], `100644 blob ${blob0}\tf.txt\n`);
    const tree1 = line(dir, ['mktree'], `100644 blob ${blob1}\tf.txt\n`);
    const commit0 = line(dir, ['commit-tree', tree0, '-m', 'base']);
    const commit1 = line(dir, ['commit-tree', tree1, '-p', commit0, '-m', 'next']);
    const tag0 = line(dir, ['mktag'], tagBytes(commit0, 'v0', 'annotated base'));
    const tag1 = line(dir, ['mktag'], tagBytes(commit1, 'v1', 'annotated next'));
    const made = {
      blob: { oid: blob0, base: new Uint8Array(blobBase), target: new Uint8Array(blobNext), targetOid: blob1 },
      tree: { oid: tree0, base: new Uint8Array(git(dir, ['cat-file', 'tree', tree0])), target: new Uint8Array(git(dir, ['cat-file', 'tree', tree1])), targetOid: tree1 },
      commit: { oid: commit0, base: new Uint8Array(git(dir, ['cat-file', 'commit', commit0])), target: new Uint8Array(git(dir, ['cat-file', 'commit', commit1])), targetOid: commit1 },
      tag: { oid: tag0, base: new Uint8Array(git(dir, ['cat-file', 'tag', tag0])), target: new Uint8Array(git(dir, ['cat-file', 'tag', tag1])), targetOid: tag1 },
    };
    const cType = tag => ({ blob: 3, tree: 2, commit: 1, tag: 4 })[tag];
    const packs = {};
    for (const [tag, obj] of Object.entries(made)) {
      assert.equal(hashObject(tag, obj.base), obj.oid, `${tag} base hashes as git stored it`);
      const { pack } = await buildPack([{ type: cType(tag), data: makeDelta(obj.base, obj.target).delta, baseOid: obj.oid }]);
      packs[tag] = parsePack(pack);
      const indexed = git(dir, ['index-pack', '--stdin', '--strict', '--fix-thin'], pack);
      assert.match(indexed.toString(), /^pack\t[0-9a-f]{40}\n$/);
      assert.equal(line(dir, ['cat-file', '-t', obj.targetOid]), tag);
      assert.deepEqual(new Uint8Array(git(dir, ['cat-file', tag, obj.targetOid])), obj.target);
    }
    for (const c of all) {
      const obj = made[c.base.tag];
      const data = c.bytes.tag === 'exact' ? obj.base : flip(obj.base);
      const parsed = packs[c.base.tag];
      let threw = null;
      let resolved = null;
      try { resolved = resolvePack(parsed, oid => (oid === obj.oid ? { type: c.claim.type, data } : undefined)); }
      catch (e) { threw = e; }
      if (c.honest) {
        assert.equal(threw, null, `${c.id}: ${threw?.message}`);
        const got = resolved.objects.get(obj.targetOid);
        assert.ok(got, `${c.id}: result oid`);
        assert.equal(got.type, c.base.type, `${c.id}: resolved type`);
        assert.deepEqual(got.data, obj.target, `${c.id}: cat-file bytes`);
        const gitOid = gitHash(dir, c.base.name, data, true);
        assert.equal(gitOid.ok && gitOid.oid, obj.oid, `${c.id}: git hash-object --literally`);
        continue;
      }
      assert.equal(threw?.code, 'pack_corrupt', `${c.id}: ${threw?.code} ${threw?.message}`);
      assert.equal(threw.message.startsWith('delta:'), false, `${c.id}: refused before applyDelta (${threw.message})`);
      if (c.claim.stored) {
        const gitOid = gitHash(dir, c.claim.name, data, true);
        assert.equal(gitOid.ok, true, `${c.id}: ${gitOid.err}`);
        assert.notEqual(gitOid.oid, obj.oid, `${c.id}: git would store this under the base oid`);
        assert.equal(threw.message, `pack: ref delta base ${obj.oid} hashes to ${gitOid.oid}`, c.id);
      } else {
        const refused = gitHash(dir, c.claim.name, data, false);
        assert.equal(refused.ok, false, `${c.id}: git hash-object -t ${c.claim.name} should refuse`);
        assert.match(refused.err, /invalid object type/, c.id);
        assert.equal(threw.message, `pack: ref delta base ${obj.oid} has type ${c.claim.type}`, c.id);
      }
    }
    // without the real base, git does not apply the thin pack
    const empty = mkdtempSync(join(tmpdir(), 'ply-thin-empty-'));
    try {
      git(empty, ['init', '-q', '--bare']);
      const pack = (await buildPack([{ type: 3, data: makeDelta(made.blob.base, made.blob.target).delta, baseOid: made.blob.oid }])).pack;
      assert.throws(() => git(empty, ['index-pack', '--stdin', '--strict', '--fix-thin'], pack));
    } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

