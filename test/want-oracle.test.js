// Fetch wants are object ids, parsed once (#156): fetchRequest refuses a want that is not one, before any request.
// git's verdict on the same want line, from git upload-pack itself (protocol v2, stateless, as smart HTTP runs it):
// upload-pack.c parse_want reads `want <arg>` with get_oid_hex and dies "expected to get oid, not 'want …'" otherwise.
// get_oid_hex reads either case and only the first 40 characters, so two classes git answers and ply does not take as
// given: an upper-case id (ply lowercases it: the same object, and git answers ply's line with the same pack) and text
// after the id (ply refuses it; git would ignore it). Every other non-oid want git refuses, and ply refuses it too.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { git, tmpRoot, makeBareRepo, commitFiles } from './server.js';
import { fetchBody, fetchRequest } from '../src/fetch.js';
import { fetchPack } from '../src/fetchpack.js';
import { createTransport } from '../src/http.js';
import { Tracer } from '../src/otel.js';
import { unwrap } from './unwrap.js';

let tmp, bare, head;
before(() => {
  tmp = tmpRoot();
  bare = makeBareRepo(tmp.root, 'w', { stock: true });
  const work = join(tmp.root, 'work');
  git(tmp.root, ['init', '-q', '-b', 'main', work]);
  head = commitFiles(work, bare, { a: 'a\n' });
});
after(() => tmp.cleanup());

const te = new TextEncoder();
// a pkt-line by hand (not ply's writer): the request git reads is the one written here
const line = s => { const b = te.encode(s); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
const request = want => Buffer.concat([line('command=fetch\n'), Buffer.from('0001'), line(`want ${want}\n`), line('no-progress\n'), line('done\n'), Buffer.from('0000')]);
// git upload-pack's answer: 'pack' (a packfile section came back) or 'refuse' (it died expecting an oid), and the bytes
const uploadPack = body => {
  const r = spawnSync('git', ['upload-pack', '--stateless-rpc', bare], { input: body, env: { ...process.env, GIT_PROTOCOL: 'version=2' } });
  const out = r.stdout.toString('latin1');
  if (out.includes('packfile\n')) return { verdict: 'pack', out };
  assert.match(r.stderr.toString(), /expected to get oid, not 'want /, `git's refusal: ${r.stderr}`);
  return { verdict: 'refuse', out };
};
const plyVerdict = want => {
  const r = fetchRequest({ wants: [want] });
  if (r.ok) return { verdict: 'ok', want: r.value.wants[0] };
  assert.equal(r.error.code, 'bad_request');
  assert.equal(r.error.what, 'want');
  return { verdict: 'refuse', message: r.error.message };
};

test('want: git upload-pack and fetchRequest agree on every class, but the two git reads past', () => {
  const cells = [
    // [name, want, git, ply]
    ['the id', head, 'pack', 'ok'],
    ['the id in upper case', head.toUpperCase(), 'pack', 'ok'],
    ['an abbreviation', head.slice(0, 7), 'refuse', 'refuse'],
    ['one digit short', head.slice(0, 39), 'refuse', 'refuse'],
    ['a ref name', 'refs/heads/main', 'refuse', 'refuse'],
    ['HEAD', 'HEAD', 'refuse', 'refuse'],
    ['empty', '', 'refuse', 'refuse'],
    ['a non-hex digit', `${head.slice(0, 39)}g`, 'refuse', 'refuse'],
    // git's get_oid_hex reads 40 characters and stops: what follows is ignored. ply does not send it.
    ['a 41st character', `${head}x`, 'pack', 'refuse'],
    ['a second word', `${head} more`, 'pack', 'refuse'],
  ];
  const wrong = [];
  for (const [name, want, gitWant, plyWant] of cells) {
    const g = uploadPack(request(want)).verdict, p = plyVerdict(want);
    if (g !== gitWant || p.verdict !== plyWant) wrong.push(`${name}: git ${g}, ply ${p.verdict}`);
    if (p.verdict === 'refuse' && p.message !== 'invalid want: must be an object id (40 hex digits)') wrong.push(`${name}: ${p.message}`);
  }
  assert.deepEqual(wrong, []);
});

test('want: an upper-case id is sent lowercase, and git answers the upper-case line with the pack it sends for the id', () => {
  const upper = head.toUpperCase();
  assert.equal(unwrap(fetchRequest({ wants: [upper] })).wants[0], head);
  // ply's body for the upper-case id is its body for the id, byte for byte
  assert.deepEqual(Buffer.from(unwrap(fetchBody({ wants: [upper] }))), Buffer.from(unwrap(fetchBody({ wants: [head] }))));
  // and git reads the two lines as one object: the same answer to either
  assert.equal(uploadPack(request(upper)).out, uploadPack(request(head)).out);
});

test('want: a NUL, CR or LF is the wire refusal it always was; a non-oid want is refused before any request', async () => {
  for (const w of [`${head}\n`, 'a\rb', 'a\0']) {
    const r = fetchRequest({ wants: [w] });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'bad_request');
    assert.equal(r.error.what, 'want');
    assert.equal(r.error.message, 'invalid want: must be a string without NUL, CR, or LF');
  }
  // the first bad want is the refusal, in order; haves after it are not read
  const second = fetchRequest({ wants: [head, 'refs/heads/main'], haves: ['x\n'] });
  assert.equal(second.error.what, 'want');
  let requests = 0;
  const t = unwrap(createTransport('http://127.0.0.1:9/r.git', { tracer: new Tracer(), fetchImpl: async () => { requests++; throw new Error('no request expected'); } }));
  const r = await fetchPack(t, { wants: ['refs/heads/main'] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_request');
  assert.equal(r.error.what, 'want');
  assert.equal(requests, 0);
});
