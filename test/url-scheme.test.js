// The base URL's scheme (security/base-url-scheme-not-checked). ply speaks git smart HTTP and nothing else (SAFETY.md:
// the SSH transport was removed), so a remote that is not http: or https: can never work: it is a definite bad_request
// before any I/O, never a retry-shaped `network` and never a URL handed to a fetch implementation (Deno and Bun read
// file: through fetch; every runtime serves data:). Redirect targets and allowUrl results were already held to http(s);
// this holds the base to the same rule. The expectations are that rule, not ply's output.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTransport } from '../src/http.js';
import { listRefs } from '../src/index.js';

const REFUSED = [
  'file:///etc/passwd', 'data:text/plain,hi', 'blob:nodedata:abc', 'ftp://127.0.0.1/repo.git', 'ssh://git@127.0.0.1/repo.git',
  'git://127.0.0.1/repo.git', 'git+ssh://127.0.0.1/repo.git', 'ext::sh -c "touch /tmp/pwned"', 'javascript:alert(1)',
  'ws://127.0.0.1/repo.git', 'wss://127.0.0.1/repo.git', 'httpx://127.0.0.1/repo.git', 'about:blank',
];

test('a base URL that is not http: or https: is bad_request before any fetch', async () => {
  for (const url of REFUSED) {
    const seen = [];
    const fetchImpl = async (u) => { seen.push(String(typeof u === 'string' ? u : u.url)); return new Response('nope', { status: 404 }); };
    const t = createTransport(url, { fetchImpl });
    assert.deepEqual([t.ok, t.error?.code, t.error?.what], [false, 'bad_request', 'url'], url);
    const r = await listRefs(url, {}, { fetchImpl });
    assert.deepEqual([r.ok, r.error?.code, r.error?.what, seen], [false, 'bad_request', 'url', []], url);
  }
});

test('the refusal never repeats the URL (its userinfo is a credential)', () => {
  const t = createTransport('ssh://git:s3cret-token@127.0.0.1/repo.git', {});
  assert.equal(t.ok, false);
  assert.equal(JSON.stringify(t.error).includes('s3cret-token'), false);
  assert.equal(t.error.message.includes('127.0.0.1'), false);
});

test('http: and https: are accepted in any letter case (the URL parser lowercases the scheme)', () => {
  for (const url of ['http://127.0.0.1/repo.git', 'https://127.0.0.1/repo.git', 'HTTP://127.0.0.1/repo.git', 'HtTpS://127.0.0.1/repo.git']) {
    assert.equal(createTransport(url, {}).ok, true, url);
  }
});
