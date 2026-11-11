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

// The rule applies to the URL that will be requested, so allowUrl runs before it, exactly as on main. Every expected
// value below is main's verdict (ec337c5, recorded by running these calls against that checkout) for an input the
// scheme rule does not concern: a mapping the caller wrote, a refusal the caller wrote, and the userinfo refusal that
// has always come first. Only a URL that would be fetched as something other than http(s) gets the new refusal.
import { parseHttpOptions } from '../src/http.js';
const mapToHttps = (u) => ({ ok: true, value: new URL(`https://real.example${u.pathname}`) });
const mine = { code: 'bad_request', message: 'host not allowed', what: 'allowUrl-deny' };
const deny = () => ({ ok: false, error: mine });

test('an alias scheme that allowUrl maps to https is accepted: the URL requested is the https one', () => {
  const asked = [];
  const allowUrl = (u) => { asked.push(u.href); return mapToHttps(u); };
  const settings = parseHttpOptions('repo://alias/team/r.git', { allowUrl });
  assert.equal(settings.ok, true);
  assert.equal(settings.value.url.href, 'https://real.example/team/r.git');
  assert.deepEqual(asked, ['repo://alias/team/r.git']);
  assert.equal(createTransport('repo://alias/team/r.git', { allowUrl: mapToHttps }).ok, true);
});

test('a denying allowUrl on a base that is not http(s) answers with the caller\'s own error', () => {
  for (const url of ['file:///etc/passwd', 'ssh://git@h.example/r.git', 'repo://alias/team/r.git']) {
    const t = createTransport(url, { allowUrl: deny });
    assert.equal(t.ok, false, url);
    assert.equal(t.error, mine, url);
  }
});

test('a NUL, CR or LF in the userinfo of a URL that is not http(s) is the userinfo refusal, with or without allowUrl', () => {
  for (const url of ['ssh://u%00@h.example/r.git', 'repo://u%0d@alias/r.git', 'git://u:p%0a@h.example/r.git']) {
    for (const options of [{}, { allowUrl: deny }, { allowUrl: mapToHttps }]) {
      const t = createTransport(url, options);
      assert.deepEqual([t.ok, t.error?.code, t.error?.what], [false, 'bad_request', 'url userinfo'], url);
    }
  }
});

test('an allowUrl that answers with a URL that is not http(s) is refused as on main (what: allowUrl), never fetched', () => {
  const t = createTransport('ssh://h.example/r.git', { allowUrl: (u) => ({ ok: true, value: u }) });
  assert.deepEqual([t.ok, t.error?.code, t.error?.what], [false, 'bad_request', 'allowUrl']);
});
