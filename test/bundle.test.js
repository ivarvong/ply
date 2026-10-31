// Tree-shaking is a property we have to earn, so it is asserted: bundle the edit entry and check what it carries.
// Every symbol in ABSENT is general-client machinery that must not ride along. Those structural checks fail.
// Byte sizes are REPORT-ONLY (ivar, 2026-10-31: "Until this thing fucking works do not microoptimize on bundle size"):
// each entry's minified and gzip bytes are printed against the last budget, and a size never fails a test. The dated
// notes below are that history.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, format: 'esm', minify: true, write: false, logLevel: 'silent', metafile: true }));
// Report-only: prints `entry min|gz bytes (budget N, ±d)` and never fails.
const size = (entry, kind, got, budget) => console.log(`bundle ${entry.padEnd(8)} ${kind.padEnd(3)} ${String(got).padStart(7)} B (budget ${budget}, ${got - budget >= 0 ? '+' : ''}${got - budget})`);
const retained = out => Object.entries(Object.values(out.metafile.outputs)[0].inputs).map(([k, v]) => [k.replace(/^src\//, '').replace(/\.ts$/, '.js'), v.bytesInOutput]).sort((a, b) => b[1] - a[1]);

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
  // 2026-10-27: 56,087 B. The shared header checker, the encoding field it round-trips, and the one-unpack guard.
  // 2026-10-27: 59,643 B / 22,823 B gz. Aggregate caps and the branded ident validator live on the edit path
  // (parsePack, inflate, encodeCommit, validateIdent) so a missing limit cannot fall open.
  // 2026-10-27: 60,436 B / 23,089 B gz. http.js streams advertisements into maxPackBytes, keeps a 4 KiB
  // error-page prefix, and rejects CR/LF in caller header fields. That module is on every entry.
  // 2026-10-30: 60,525 B / 23,128 B gz. push.js refuses a pack over maxPackBytes before sending it (issue #11).
  // 2026-10-30: 60,668 B / 23,229 B gz. the size-varint cap in readObjHeader/applyDelta and the counted scan (issue #13).
  // 2026-10-30: 60,701 B / 23,239 B gz. resolvePack counts delta chain length per link and runs its fixpoint to completion (issue #14).
  // 2026-10-30: 62,215 B / 23,900 B gz. the credential scrub (12-character fragments, the user rule) and the redirect refusal in http.js, the span scrub in otel.js (issue #15).
  // 2026-10-30: 62,420 B / 23,943 B gz. ls-refs keeps only symref-target and a checked peeled, report options and merge maps have no prototype, scrubError walks them (issue #16).
  // 2026-10-30: 62,836 B / 24,093 B gz. URL userinfo sent as git sends it (percent-decoded bytes, `user:` for a user alone), the token-as-user scrub rule, a typed bad URL (issue #32).
  // 2026-10-30: 63,168 B / 24,230 B gz. v2Step caps band 1 and band 2 at maxPackBytes for every consumer, zlibBound in spStep and inflate, push caps band 2, the declared-size check before begin() in streamBlobEdit (issue #36).
  // 2026-10-30: 63,709 B / 24,444 B gz. Explicit credentials as UTF-8 bytes and refused when they send nothing, the scrub module shared with SSH (issue #40).
  // 2026-10-30: 63,197 B / 24,217 B gz. checkWide: the blob:none fallback drops an extra over a limit instead of failing (issue #46).
  // 2026-10-30: 64,070 B / 24,571 B gz. merge of #48 and #47 (credential handling, issue #40, with checkWide, issue #46).
  // 2026-10-30: 64,399 B / 24,708 B gz. merge of #49 and #48 (body and zlib bounds, issue #36, with credential handling, issue #40).
  // 2026-10-30: 63,148 B / 24,220 B gz. parseTree refuses one name twice anywhere in a tree, orders on raw bytes with fsck's S_ISDIR, and refuses decode-twins (issue #34).
  // 2026-10-30: 65,439 B / 25,067 B gz. The push outcome as an allowlist: the response stream as a step machine (streamStep), the report classified against git's exact grammar (classifyReport), an exhaustive decideOutcome, push_partial (SPACE.md, SAFETY.md I36).
  // 2026-10-30: 64,903 B / 24,908 B gz. names, messages, idents and ref names as bytes (decodeBytes/encodeBytes, surrogate-escaped), BOM kept, sideband text decoded across frames (issue #43).
  // 2026-10-30: 68,764 B / 26,407 B gz. merge of #49, #50, #51, #52, #53, #55 and #54 on main (train/1): #36 caps, #34 parseTree, the push outcome space, #41/#42 merge base, #43 bytes, #35 span contract.
  // 2026-10-31: 71,208 B / 27,424 B gz. parseTree is fsck_tree: utf8.c/path.c's .git and .gitmodules spellings, nullSha1, largePathname, dotfiles that are not blobs, canon_mode (hole #4, space/fsck-tree).
  // 2026-10-31: 73,215 B / 28,144 B gz. release/1: train/1, #19, #57, #58, #62, #64, #65, #66, #67, #70.
  // 2026-10-31: 73,369 B / 28,212 B gz. validatePushRef: receive-pack's funny refname refused before sending (#73).
  size('edit', 'min', min, 73_370);
  // 2026-10-31: 73,090 B / 28,222 B gz. strict TS (T2: objects, format, validate, scrub): min down, gz up a few dozen bytes from strict-lint forms (/u regexes, Number.parseInt, explicit length checks, noUncheckedIndexedAccess guards) and identifier remangling.
  size('edit', 'gz', gz, 28_223);
});

test('merge entry: the line merge rides with merge/rebase only, under its own budget', async () => {
  const out = await bundle('src/merge.ts');
  const js = out.outputFiles[0].text, files = retained(out).map(([k]) => k);
  assert.ok(files.includes('linemerge.js'));
  assert.ok(!/node:|\bclass\s+\w+\s*(extends\s+[\w.]+\s*)?\{/.test(js), 'no node builtins or classes');
  const min = js.length, gz = gzipSync(js, { level: 9 }).length;
  console.log(`  merge bundle: ${min} B min, ${gz} B gz; modules: ${retained(out).map(([k, b]) => `${k}=${b}`).join(' ')}`);
  // 2026-10-20: 63.9 KB — line merge (xdiff port incl. Myers) ≈ 10.4 KB, .gitattributes ≈ 5.5 KB; the edit bundle carries neither
  // 2026-10-23: 67.4 KB with the blob:none fallback (fetchPackTree0, fetchWide)
  // 2026-10-25: 72.5 KB. The same parser checks the edit and read bundles grew by.
  // 2026-10-27: 77,245 B. Merge validates idents before I/O and the ancestors walk is an index, not q.shift.
  // 2026-10-27: 78,147 B. The same http.js advertisement and header checks, plus parsers taking transport limits.
  // 2026-10-30: 78,403 B. The same pre-send push refusal, and encodeTree refusing a duplicate name (issue #11).
  // 2026-10-30: 78,515 B. The same size-varint cap (issue #13).
  // 2026-10-30: 78,548 B. The same delta chain bound (issue #14).
  // 2026-10-30: 80,062 B. The same credential scrub and redirect refusal (issue #15).
  // 2026-10-30: 80,435 B. The same, plus the [:class:] table as a Map (issue #16).
  // 2026-10-30: 80,904 B. The walk's packs held to the deepen contract and checked with assertFetched before harvest (issue #18).
  // 2026-10-30: 81,313 B. The same URL userinfo handling (issue #32).
  // 2026-10-30: 81,582 B. The same pack-byte cap in v2Step, zlib-length bound and push band-2 cap (issue #36).
  // 2026-10-30: 82,181 B. The same credential handling (issue #40).
  // 2026-10-30: 81,669 B. The same checkWide, also on the merge-base walk's blob:none packs (issue #46).
  // 2026-10-30: 82,537 B. merge of #48 and #47 (credential handling, issue #40, with checkWide, issue #46).
  // 2026-10-30: 82,807 B. merge of #49 and #48 (body and zlib bounds, issue #36, with credential handling, issue #40).
  // 2026-10-30: 81,637 B. The same parseTree duplicate and order rules (issue #34).
  // 2026-10-30: 83,907 B. The same push outcome allowlist (SAFETY.md I36).
  // 2026-10-30: 81,773 B. A settled cut one best base reaches and another does not keeps the merge-base walk going (#42);
  // rebase fetches a base named only at the window's cut (#41).
  // 2026-10-30: 83,592 B. The same, plus .gitattributes paths matched on their bytes and an annotated tag refused by name (issue #43).
  // 2026-10-30: 87,511 B. merge of #49, #50, #51, #52, #53, #55 and #54 on main (train/1): #36 caps, #34 parseTree, the push outcome space, #41/#42 merge base, #43 bytes, #35 span contract.
  // 2026-10-31: 89,918 B. parseTree is fsck_tree: utf8.c/path.c's .git and .gitmodules spellings, nullSha1, largePathname, dotfiles that are not blobs, canon_mode (hole #4, space/fsck-tree).
  // 2026-10-31: 91,966 B. release/1: train/1, #19, #57, #58, #62, #64, #65, #66, #67, #70.
  // 2026-10-31: 92,121 B. validatePushRef: receive-pack's funny refname refused before sending (#73).
  size('merge', 'min', min, 92_122);
});

test('log entry: readLog carries no push, merge, pack building or rebase code', async () => {
  const out = await bundle('src/log.js');
  const js = out.outputFiles[0].text, files = retained(out).map(([k]) => k);
  for (const f of ['push.js', 'pack.js', 'merge.js', 'linemerge.js', 'rebase.js', 'attributes.js', 'edit.js', 'sign.js', 'negotiate.js', 'receivecaps.js', 'client.js', 'discover.js', 'tree.js', 'checkout.js']) assert.ok(!files.includes(f), `${f} is in the log bundle`);
  const ABSENT = { 'receive-pack': /git-receive-pack|report-status/, 'pack building': /buildPack|zlibDeflate|CompressionStream/, 'classes': /\bclass\s+\w+\s*(extends\s+[\w.]+\s*)?\{/, 'node builtins': /node:/ };
  for (const [what, re] of Object.entries(ABSENT)) assert.ok(!re.test(js), `${what} leaked into the log bundle (${re})`);
  const min = js.length, gz = gzipSync(js, { level: 9 }).length;
  console.log(`  log bundle: ${min} B min, ${gz} B gz; modules: ${retained(out).map(([k, b]) => `${k}=${b}`).join(' ')}`);
  // 2026-10-30: 43,164 B / 17,227 B gz, first measured (issue #56): ls-refs, the commit-only window (fetchPackTree0
  // with the blob:none fallback, so the delta resolver), the deepen-contract check and readCommit's commit view.
  // 2026-10-31: 49,521 B / 19,807 B gz. release/1: train/1, #19, #57, #58, #62, #64, #65, #66, #67, #70.
  size('log', 'min', min, 49_522);
  size('log', 'gz', gz, 19_808);
});

test('full entry is the superset and still carries no node builtins', async () => {
  const out = await build({ entryPoints: ['src/index.js'], bundle: true, format: 'esm', minify: true, write: false, logLevel: 'silent', metafile: true });
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
  // 2026-10-27: 44,745 B / 17,299 B gz. Tree and commit parsers take the transport caps, and ls-refs requires the flush.
  // 2026-10-27: 45,553 B / 17,616 B gz. The read path uses the same capped HTTP advertisement and error-page reader.
  // 2026-10-30: 45,568 B / 17,625 B gz. openBlob is exported for checkout.js (issue #12): its name is no longer mangled.
  // 2026-10-30: 45,680 B / 17,679 B gz. The same size-varint cap, which bounds openBlob's header phase (issue #13).
  // 2026-10-30: 45,713 B / 17,690 B gz. The same delta chain bound (issue #14).
  // 2026-10-30: 47,227 B / 18,349 B gz. The same credential scrub and redirect refusal (issue #15).
  // 2026-10-30: 47,398 B / 18,400 B gz. The same ls-refs attribute whitelist and scrub walk (issue #16).
  // 2026-10-30: 47,393 B / 18,399 B gz. openBlob's pump failure records itself and ends both spans (failHere); with #16 merged it minifies under the budget above.
  // 2026-10-30: 47,831 B / 18,565 B gz. The same URL userinfo handling (issue #32).
  // 2026-10-30: 48,307 B / 18,778 B gz. The same pack-byte cap and zlib-length bound, which is what caps openBlob's body; openBlob's stream wraps DecompressionStream's refusals as pack_corrupt (issue #36).
  // 2026-10-30: 48,703 B / 18,909 B gz. The same credential handling (issue #40).
  // 2026-10-30: 48,192 B / 18,710 B gz. The same checkWide (issue #46).
  // 2026-10-30: 49,064 B / 19,053 B gz. merge of #48 and #47 (credential handling, issue #40, with checkWide, issue #46).
  // 2026-10-30: 49,538 B / 19,272 B gz. merge of #49 and #48 (body and zlib bounds, issue #36, with credential handling, issue #40).
  // 2026-10-30: 48,142 B / 18,699 B gz. The same parseTree duplicate and order rules (issue #34).
  // 2026-10-30: 47,849 B / 18,572 B gz. errors.js gains push_partial (SAFETY.md I36); no push code rides along.
  // 2026-10-30: 49,816 B / 19,369 B gz. The same bytes-as-strings mapping (issue #43).
  // 2026-10-30: 49,381 B / 19,155 B gz. git.read.blob follows the root and records a consumer's cancel (issue #35).
  // 2026-10-30: 51,502 B / 20,042 B gz. merge of #49, #50, #51, #52, #53, #55 and #54 on main (train/1): #36 caps, #34 parseTree, the push outcome space, #41/#42 merge base, #43 bytes, #35 span contract.
  // 2026-10-31: 53,946 B / 21,069 B gz. parseTree is fsck_tree: utf8.c/path.c's .git and .gitmodules spellings, nullSha1, largePathname, dotfiles that are not blobs, canon_mode (hole #4, space/fsck-tree).
  // 2026-10-31: 55,816 B / 21,786 B gz. release/1: train/1, #19, #57, #58, #62, #64, #65, #66, #67, #70.
  size('read', 'min', min, 55_817);
  // 2026-10-31: 55,506 B / 21,791 B gz. T2 strict TS (see the edit budget).
  size('read', 'gz', gz, 21_792);
});

test('tree entry: pushTree is Workers-safe; the directory walk (node:fs) lives only in tree-node.js', async () => {
  const out = await bundle('src/tree.js');
  const js = out.outputFiles[0].text, files = retained(out).map(([k]) => k);
  for (const f of ['tree-node.js', 'merge.js', 'linemerge.js', 'rebase.js', 'attributes.js', 'read.js', 'fetchpack.js', 'negotiate.js', 'receivecaps.js', 'client.js', 'discover.js']) assert.ok(!files.includes(f), `${f} is in the tree bundle`);
  assert.ok(!/node:|\bclass\s+\w+\s*(extends\s+[\w.]+\s*)?\{/.test(js), 'no node builtins or classes');
  const min = js.length, gz = gzipSync(js, { level: 9 }).length;
  console.log(`  tree bundle: ${min} B min, ${gz} B gz; modules: ${retained(out).map(([k, b]) => `${k}=${b}`).join(' ')}`);
  // 2026-10-30: 57,232 B / 22,070 B gz, first measured (issue #11): the edit path's fetch and push plus encodeTree,
  // makeDelta and the tree diff; no streamed blob scanner, no merge.
  // 2026-10-30: 57,344 B / 22,128 B gz. The same size-varint cap (issue #13).
  // 2026-10-30: 57,377 B / 22,136 B gz. The same delta chain bound (issue #14).
  // 2026-10-30: 58,891 B / 22,787 B gz. The same credential scrub and redirect refusal (issue #15).
  // 2026-10-30: 59,096 B / 22,842 B gz. The same (issue #16).
  // 2026-10-30: 59,520 B / 23,000 B gz. The same URL userinfo handling (issue #32).
  // 2026-10-30: 59,849 B / 23,158 B gz. The same pack-byte cap, zlib-length bound and push band-2 cap (issue #36).
  // 2026-10-30: 60,391 B / 23,353 B gz. The same credential handling (issue #40).
  // 2026-10-30: 59,881 B / 23,141 B gz. The same checkWide (issue #46).
  // 2026-10-30: 60,752 B / 23,494 B gz. merge of #48 and #47 (credential handling, issue #40, with checkWide, issue #46).
  // 2026-10-30: 61,079 B / 23,631 B gz. merge of #49 and #48 (body and zlib bounds, issue #36, with credential handling, issue #40).
  // 2026-10-30: 59,847 B / 23,153 B gz. The same parseTree duplicate and order rules (issue #34).
  // 2026-10-30: 62,111 B / 23,985 B gz. The same push outcome allowlist (SAFETY.md I36).
  // 2026-10-30: 61,621 B / 23,854 B gz. The same (issue #43).
  // 2026-10-30: 65,489 B / 25,330 B gz. merge of #49, #50, #51, #52, #53, #55 and #54 on main (train/1): #36 caps, #34 parseTree, the push outcome space, #41/#42 merge base, #43 bytes, #35 span contract.
  // 2026-10-31: 67,878 B / 26,343 B gz. parseTree is fsck_tree: utf8.c/path.c's .git and .gitmodules spellings, nullSha1, largePathname, dotfiles that are not blobs, canon_mode (hole #4, space/fsck-tree).
  // 2026-10-31: 69,891 B / 27,043 B gz. release/1: train/1, #19, #57, #58, #62, #64, #65, #66, #67, #70.
  // 2026-10-31: 70,045 B / 27,104 B gz. validatePushRef: receive-pack's funny refname refused before sending (#73).
  size('tree', 'min', min, 70_046);
  // 2026-10-31: 69,763 B / 27,134 B gz. T2 strict TS (see the edit budget).
  size('tree', 'gz', gz, 27_135);
  const full = await build({ entryPoints: ['src/index.js'], bundle: true, format: 'esm', write: false, logLevel: 'silent', metafile: true });
  assert.ok(!retained(full).map(([k]) => k).includes('tree-node.js'), 'the full entry does not carry the Node walk');
  const node = await build({ entryPoints: ['src/tree-node.js'], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  assert.match(node.outputFiles[0].text, /node:fs\/promises/);
  // src/ imports node: builtins in exactly the two Node adapters
  const { readdirSync, readFileSync } = await import('node:fs');
  const withNode = readdirSync('src').filter(f => /\.[jt]s$/.test(f) && /from 'node:/.test(readFileSync(`src/${f}`, 'utf8'))).sort();
  assert.deepEqual(withNode, ['checkout-node.js', 'tree-node.js']);
});

test('checkout entry: checkoutTree is Workers-safe and carries no push or merge code; the directory writer is checkout-node.js', async () => {
  const out = await bundle('src/checkout.js');
  const js = out.outputFiles[0].text, files = retained(out).map(([k]) => k);
  for (const f of ['checkout-node.js', 'tree-node.js', 'tree.js', 'push.js', 'pack.js', 'edit.js', 'merge.js', 'linemerge.js', 'rebase.js', 'attributes.js', 'sign.js', 'negotiate.js', 'receivecaps.js', 'client.js', 'discover.js']) assert.ok(!files.includes(f), `${f} is in the checkout bundle`);
  const ABSENT = { 'receive-pack': /git-receive-pack|report-status/, 'pack building': /buildPack|zlibDeflate|CompressionStream/, 'classes': /\bclass\s+\w+\s*(extends\s+[\w.]+\s*)?\{/, 'node builtins': /node:/ };
  for (const [what, re] of Object.entries(ABSENT)) assert.ok(!re.test(js), `${what} leaked into the checkout bundle (${re})`);
  const min = js.length, gz = gzipSync(js, { level: 9 }).length;
  console.log(`  checkout bundle: ${min} B min, ${gz} B gz; modules: ${retained(out).map(([k, b]) => `${k}=${b}`).join(' ')}`);
  // 2026-10-30: 42,396 B / 16,829 B gz, first measured (issue #12): the read path's ls-refs and blob stream, plus the
  // buffered fetchPack and delta resolver for the tree pack and the blob batches. Smaller than the read entry because
  // it does not carry readFile's tree:0 walk or readCommit's views.
  // 2026-10-30: 42,508 B / 16,894 B gz. The same size-varint cap (issue #13).
  // 2026-10-30: 42,541 B / 16,901 B gz. The same delta chain bound (issue #14).
  // 2026-10-30: 44,055 B / 17,546 B gz. The same credential scrub and redirect refusal (issue #15).
  // 2026-10-30: 44,226 B / 17,576 B gz. The same ls-refs attribute whitelist and scrub walk (issue #16).
  // 2026-10-30: 44,221 B / 17,573 B gz. The same openBlob pump-failure span fix, with #16 merged.
  // 2026-10-30: 44,658 B / 17,768 B gz. The same URL userinfo handling (issue #32).
  // 2026-10-30: 45,292 B / 18,032 B gz. The same pack-byte cap, zlib-length bound and openBlob stream wrap (issue #36).
  // 2026-10-30: 45,530 B / 18,115 B gz. The same credential handling (issue #40).
  // 2026-10-30: 44,697 B / 17,804 B gz. fetchPackOnce takes a `check` for fetchPackTree0 (issue #46); checkWide itself is shaken out.
  // 2026-10-30: 45,569 B / 18,149 B gz. merge of #48 and #47 (credential handling, issue #40, with checkWide, issue #46).
  // 2026-10-30: 46,201 B / 18,389 B gz. merge of #49 and #48 (body and zlib bounds, issue #36, with credential handling, issue #40).
  // 2026-10-30: 44,984 B / 17,893 B gz. The same parseTree duplicate and order rules (issue #34).
  // 2026-10-30: 44,676 B / 17,775 B gz. errors.js gains push_partial (SAFETY.md I36); no push code rides along.
  // 2026-10-30: 46,321 B / 18,459 B gz. The same (issue #43).
  // 2026-10-30: 45,887 B / 18,246 B gz. The same blob-stream cancel and follows spans (issue #35).
  // 2026-10-30: 48,181 B / 19,164 B gz. merge of #49, #50, #51, #52, #53, #55 and #54 on main (train/1): #36 caps, #34 parseTree, the push outcome space, #41/#42 merge base, #43 bytes, #35 span contract.
  // 2026-10-31: 50,542 B / 20,121 B gz. parseTree is fsck_tree: utf8.c/path.c's .git and .gitmodules spellings, nullSha1, largePathname, dotfiles that are not blobs, canon_mode (hole #4, space/fsck-tree).
  // 2026-10-31: 52,917 B / 20,911 B gz. release/1: train/1, #19, #57, #58, #62, #64, #65, #66, #67, #70.
  size('checkout', 'min', min, 52_918);
  // 2026-10-31: 52,604 B / 20,928 B gz. T2 strict TS (see the edit budget).
  size('checkout', 'gz', gz, 20_929);
  const full = await build({ entryPoints: ['src/index.js'], bundle: true, format: 'esm', write: false, logLevel: 'silent', metafile: true });
  assert.ok(!retained(full).map(([k]) => k).includes('checkout-node.js'), 'the full entry does not carry the Node writer');
  const node = await build({ entryPoints: ['src/checkout-node.js'], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  assert.match(node.outputFiles[0].text, /node:fs\/promises/);
});
