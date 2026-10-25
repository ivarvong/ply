// Tree-shaking is a property we have to earn, so it is asserted: bundle the edit entry and check what it carries.
// Every symbol in ABSENT is general-client machinery that must not ride along; the byte budget catches a slow creep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, format: 'esm', minify: true, write: false, logLevel: 'silent', metafile: true }));
const retained = out => Object.entries(Object.values(out.metafile.outputs)[0].inputs).map(([k, v]) => [k.replace(/^src\//, ''), v.bytesInOutput]).sort((a, b) => b[1] - a[1]);

test('edit entry carries only what the edit path uses', async () => {
  const out = await bundle('src/edit.js');
  const js = out.outputFiles[0].text;
  const ABSENT = {
    // the delta resolver (parsePack/resolvePack/applyDelta) rides along since 2026-10-23: the blob:none fallback for servers
    // that refuse tree:0 (Cloudflare Artifacts) gets multi-object, possibly deltified packs. The generator does not.
    'delta generator': /copyOps|makeDelta/,
    'negotiation': /negotiate|promisor/,
    'receive-pack advertisement': /git\.receive\.caps|receiveCaps/,
    'discover canary': /git\.server\.agent/,
    'buffered fetchPack': /git\.pack\.chain\.max|fetchPackOnce/,
    'classes': /\bclass\s+\w+\s*(extends\s+[\w.]+\s*)?\{/,
    'node builtins': /node:/,
    'tree encoding': /treeSort|encodeTree/,
  };
  for (const [what, re] of Object.entries(ABSENT)) assert.ok(!re.test(js), `${what} leaked into the edit bundle (${re})`);
  const files = retained(out).map(([k]) => k);
  for (const f of ['fetchpack.js', 'negotiate.js', 'receivecaps.js', 'discover.js', 'client.js', 'packcache.js', 'merge.js', 'linemerge.js', 'rebase.js', 'attributes.js']) assert.ok(!files.includes(f), `${f} is in the edit bundle`);
  const min = js.length, gz = gzipSync(js, { level: 9 }).length;
  console.log(`  edit bundle: ${min} B min, ${gz} B gz; modules: ${retained(out).map(([k, b]) => `${k}=${b}`).join(' ')}`);
  // 2026-10-23: 49.9 KB / 18.9 KB gz (was 42.6 / 16.5): +4.2 KB packresolve.js, +2.6 KB fetch.js for the blob:none fallback
  // 2026-10-25: 55.1 KB / 20.8 KB gz. take(), format facts, and fsck checks in parseTree/assertFetched.
  assert.ok(min < 56_000, `edit bundle ${min} B exceeds budget`);
  assert.ok(gz < 21_500, `edit bundle ${gz} B gz exceeds budget`);
});

test('ssh entry: the SSH client rides only with ply/ssh; the edit bundle has none of it', async () => {
  const edit = await bundle('src/edit.js');
  assert.ok(!/SSH-2\.0|curve25519|KEXINIT/.test(edit.outputFiles[0].text), 'no SSH in the edit bundle');
  const ssh = await build({ entryPoints: ['src/sshgit.js'], bundle: true, format: 'esm', minify: true, write: false, logLevel: 'silent', metafile: true, external: ['cloudflare:sockets', 'node:net'] });
  const js = ssh.outputFiles[0].text;
  assert.ok(/curve25519-sha256/.test(js) && /aes128-gcm@openssh\.com/.test(js));
  assert.ok(!/node:net/.test(js), 'the ssh transport does not pick a socket implementation');
  console.log(`  ssh transport bundle: ${js.length} B min, ${gzipSync(js, { level: 9 }).length} B gz; modules: ${retained(ssh).map(([k, b]) => `${k}=${b}`).join(' ')}`);
  assert.ok(js.length < 30_000, `ssh bundle ${js.length} B exceeds budget`);
});

test('merge entry: the line merge rides with merge/rebase only, under its own budget', async () => {
  const out = await bundle('src/merge.js');
  const js = out.outputFiles[0].text, files = retained(out).map(([k]) => k);
  assert.ok(files.includes('linemerge.js'));
  assert.ok(!/node:|\bclass\s+\w+\s*(extends\s+[\w.]+\s*)?\{/.test(js), 'no node builtins or classes');
  const min = js.length, gz = gzipSync(js, { level: 9 }).length;
  console.log(`  merge bundle: ${min} B min, ${gz} B gz; modules: ${retained(out).map(([k, b]) => `${k}=${b}`).join(' ')}`);
  // 2026-10-20: 63.9 KB — line merge (xdiff port incl. Myers) ≈ 10.4 KB, .gitattributes ≈ 5.5 KB; the edit bundle carries neither
  // 2026-10-23: 67.4 KB with the blob:none fallback (fetchPackTree0, fetchWide)
  // 2026-10-25: 72.5 KB. The same parser checks the edit and read bundles grew by.
  assert.ok(min < 74_000, `merge bundle ${min} B exceeds budget`);
});

test('full entry is the superset and still carries no node builtins', async () => {
  const out = await build({ entryPoints: ['src/index.js'], bundle: true, format: 'esm', minify: true, write: false, logLevel: 'silent', metafile: true, external: ['cloudflare:sockets'] });
  const js = out.outputFiles[0].text;
  assert.ok(!/node:/.test(js));
  for (const f of ['packresolve.js', 'fetchpack.js', 'negotiate.js', 'receivecaps.js', 'discover.js', 'client.js', 'packcache.js', 'edit.js']) assert.ok(retained(out).map(([k]) => k).includes(f), `${f} missing from full bundle`);
  console.log(`  full bundle: ${js.length} B min, ${gzipSync(js, { level: 9 }).length} B gz`);
});

test('read entry: readFile/listTree carry no push, merge, pack building or rebase code', async () => {
  const out = await bundle('src/read.js');
  const js = out.outputFiles[0].text, files = retained(out).map(([k]) => k);
  for (const f of ['push.js', 'pack.js', 'merge.js', 'linemerge.js', 'rebase.js', 'attributes.js', 'edit.js', 'sign.js', 'fetchpack.js', 'negotiate.js', 'receivecaps.js', 'client.js', 'discover.js']) assert.ok(!files.includes(f), `${f} is in the read bundle`);
  const ABSENT = { 'receive-pack': /git-receive-pack|report-status/, 'pack building': /buildPack|zlibDeflate|CompressionStream/, 'line merge': /histogram|xdl_/, 'classes': /\bclass\s+\w+\s*(extends\s+[\w.]+\s*)?\{/, 'node builtins': /node:/ };
  for (const [what, re] of Object.entries(ABSENT)) assert.ok(!re.test(js), `${what} leaked into the read bundle (${re})`);
  const min = js.length, gz = gzipSync(js, { level: 9 }).length;
  console.log(`  read bundle: ${min} B min, ${gz} B gz; modules: ${retained(out).map(([k, b]) => `${k}=${b}`).join(' ')}`);
  // 2026-10-23: 36.3 KB / 13.9 KB gz, of which packresolve.js 4.2 KB is the blob:none fallback's delta resolver
  // 2026-10-25: 42.0 KB / 16.0 KB gz. take(), format facts, and fsck checks in parseTree/assertFetched.
  assert.ok(min < 43_000, `read bundle ${min} B exceeds budget`);
  assert.ok(gz < 16_500, `read bundle ${gz} B gz exceeds budget`);
});
