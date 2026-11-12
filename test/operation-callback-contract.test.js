// The operation() callback contract (#306, README "operation(): your body's outcomes"), pinned case by case. Breaking
// since #277: a callback's own throw is never returned as itself unless it is a PlyError thrown before the push
// request was handed to the transport. The expected values are the README contract, hand-derived:
//   1. a non-ply throw before the hand-over        -> Err bad_request, what 'callback', cause === the thrown value
//   2. a PlyError throw before the hand-over        -> Err that very PlyError (same object, same code)
//   3. a throw after the hand-over                  -> Err ambiguous, what 'callback', cause === the thrown value
//                                                      (a thrown PlyError's code goes to `original`), except that a
//                                                      thrown `ambiguous` PlyError is returned as itself (no what, no cause)
//   4. a returned value (Ok, or the caller's own discriminated union inside it) passes through unchanged
// No server: fetchImpl refuses every request, so nothing can reach a network; the hand-over is the frames() call.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { operation, plyError } from '../src/index.js';

const url = 'https://example.invalid/r.git';
const opts = { fetchImpl: async () => { await null; throw new Error('no network in this test'); } };
const empty = new Uint8Array(0);

test('1. a non-ply value thrown before the hand-over is bad_request what callback, with the value as cause', async () => {
  for (const thrown of [new Error('conflict'), { kind: 'ref_exists' }, 'a string', null]) {
    const r = await operation('probe', url, opts, async () => { await null; throw thrown; });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'bad_request');
    assert.equal(r.error.what, 'callback');
    assert.equal(r.error.cause, thrown);
    assert.notEqual(r.error, thrown);
  }
  // an upload-pack request only reads: still before the hand-over
  const thrown = new Error('after a read');
  const r = await operation('probe', url, opts, async ({ t, root }) => { await null; t.frames('git-upload-pack', empty, root, {}); throw thrown; });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_request');
  assert.equal(r.error.what, 'callback');
  assert.equal(r.error.cause, thrown);
});

test('2. a PlyError thrown before the hand-over is returned as itself', async () => {
  const thrown = plyError('cas_conflict', 'mine: someone else moved the ref');
  const r = await operation('probe', url, opts, async () => { await null; throw thrown; });
  assert.equal(r.ok, false);
  assert.equal(r.error, thrown);
  assert.equal(r.error.code, 'cas_conflict');
});

test('3. any throw after the push request was handed to the transport is ambiguous what callback, with the value as cause', async () => {
  // README row 1 'after': a non-PlyError with a string `code` (a node network error) also puts that code in `original`
  for (const thrown of [new Error('boom'), { kind: 'stale_expected' }, Object.assign(new Error('reset'), { code: 'ECONNRESET' }), plyError('cas_conflict', 'mine: a definite rejection, seen after the hand-over')]) {
    const r = await operation('probe', url, opts, async ({ t, root }) => { await null; t.frames('git-receive-pack', empty, root, {}); throw thrown; });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ambiguous');
    assert.equal(r.error.what, 'callback');
    assert.equal(r.error.cause, thrown);
    assert.notEqual(r.error, thrown);
    if (thrown instanceof Error && 'code' in thrown) assert.equal(r.error.original, thrown.message === 'reset' ? 'ECONNRESET' : 'cas_conflict');
    else assert.equal('original' in r.error, false);
  }
});

test('3b. an ambiguous PlyError thrown after the hand-over is returned as itself, not re-wrapped', async () => {
  const thrown = plyError('ambiguous', 'mine: I already know the push outcome is unknown');
  const r = await operation('probe', url, opts, async ({ t, root }) => { await null; t.frames('git-receive-pack', empty, root, {}); throw thrown; });
  assert.equal(r.ok, false);
  assert.equal(r.error, thrown);
  assert.equal(r.error.code, 'ambiguous');
  assert.equal(r.error.what, undefined);
  assert.equal(r.error.cause, undefined);
});

test('4. a returned value passes through: expected outcomes as a discriminated union, before or after the hand-over', async () => {
  const conflict = { tag: 'conflict', reason: 'ref_exists' };
  const before = await operation('probe', url, opts, async ({ outcome }) => { await null; return outcome('conflict', conflict); });
  assert.equal(before.ok, true);
  assert.equal(before.value, conflict);
  const after = await operation('probe', url, opts, async ({ t, root, outcome }) => { await null; t.frames('git-receive-pack', empty, root, {}); return outcome('conflict', conflict); });
  assert.equal(after.ok, true);
  assert.equal(after.value, conflict);
  // a returned Err is the caller's Err, also as itself, after the hand-over too
  const mine = plyError('cas_conflict', 'mine: definite');
  const returned = await operation('probe', url, opts, async ({ t, root }) => { await null; t.frames('git-receive-pack', empty, root, {}); return { ok: false, error: mine }; });
  assert.equal(returned.ok, false);
  assert.equal(returned.error, mine);
});
