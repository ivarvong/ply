// The default depth of a single-object fetch (fetchObject / objectAt). The rule set, from the owner:
//   R1  one object costs one object's worth of pack: a want that is or may be a commit asks for depth 1 when the server
//       takes shallow requests
//   R2  a caller's explicit deepen is sent as given and always wins (0: no `deepen` line)
//   R3  without the capability ply behaves as on main, for every refusal shape: a default-depth request (the caller gave
//       no deepen, 1 was sent, `shallow` not yet known for the quirks record) refused with an empty response, an ERR
//       line or HTTP 400 reads the advertisement once; `shallow` not listed: asked again without deepen, once;
//       listed: the first error stands. Never when the caller gave deepen, never more than one re-ask
//   R4  no extra round trip on a success path
// Every expected value below is stated from those rules, from git's (what a pack holds: upload-pack with and without a
// depth and a filter) and from two things main already did and README states: an empty response on the tree:0 path reads
// the advertisement for `filter` (the no-filter fallback), and a single-object fetch refuses a pack of more than one
// object for a want not typed COMMIT (`pack_corrupt`). None of it is read back from objectAt.
//
// The server: git http-backend behind a proxy. `advertised` is whether its fetch= line lists `shallow`; `refusal` is what
// it does with a request that carries `deepen` (a request without one is always git's answer).
export const AXES = [
  { name: 'asked', doc: "the caller's deepen", variants: [
    { tag: 'none', why: 'left out: the default depth applies (R1)' },
    { tag: '0', why: 'explicit 0: no `deepen` line, the whole history (R2)' },
    { tag: '2', why: 'explicit n: `deepen 2`, sent as given (R2)' }] },
  { name: 'expectType', doc: 'the type the caller names; the want is an object of that type', variants: [
    { tag: 'none', why: 'untyped: may be a commit (the want is the tip commit)' },
    { tag: 'COMMIT', why: 'a commit' },
    { tag: 'TAG', why: 'may peel to a commit (the want is an annotated tag of the tip)' },
    { tag: 'TREE', why: 'no history is reachable from a tree: no default depth' },
    { tag: 'BLOB', why: 'nor from a blob' }] },
  { name: 'knowledge', doc: 'what the quirks record was taught about `shallow` before the call (by discover())', variants: [
    { tag: 'unlearned', why: 'no advertisement read for this record' },
    { tag: 'listed', why: 'an advertisement that listed `shallow`' },
    { tag: 'unlisted', why: 'an advertisement that did not' }] },
  { name: 'advertised', doc: "whether the server's fetch= line lists `shallow` during the call (differs from a learned knowledge when the server changed: stored state is untrusted)", variants: [
    { tag: 'yes', why: 'git, GitHub, GitLab, Codeberg, Artifacts' },
    { tag: 'no', why: 'a server without shallow fetches' }] },
  { name: 'refusal', doc: 'what the server does with a request that carries `deepen`', variants: [
    { tag: 'none', why: 'takes it: git' },
    { tag: 'empty', why: 'HTTP 200 with an empty body: git upload-pack dying on an argument it does not take' },
    { tag: 'err', why: 'an ERR pkt-line (remote_error)' },
    { tag: '400', why: 'HTTP 400: how Artifacts refuses an argument it does not take' },
    { tag: 'ignored', why: 'drops the line and answers as if it were not there' }] },
  { name: 'path', doc: "objectAt's request path", variants: [
    { tag: 'tree:0', why: 'the single fetch, filter tree:0 (quirks.treeFilter tree:0)' },
    { tag: 'blob:none', why: 'the wide fetch on a record that learned blob:none (Artifacts)' },
    { tag: 'unfiltered', why: 'the wide fetch on a record that learned no filter (the server lists no `filter`)' },
    { tag: "filter ''", why: "the single fetch with the caller's filter ''" }] },
];

export function cells() {
  const out = [];
  const go = (i, cell) => {
    if (i === AXES.length) { out.push({ id: AXES.map(a => cell[a.name]).join('/'), ...cell }); return; }
    for (const v of AXES[i].variants) go(i + 1, { ...cell, [AXES[i].name]: v.tag });
  };
  go(0, {});
  return out;
}

const REFUSED = { empty: 'protocol', err: 'remote_error', 400: 'http' };
const post = depth => `POST ${depth === null ? '-' : depth}`;

// How many objects git packs for the want when the request it answers carries `depth` (null: no deepen line). The
// history is `commits` commits in a line, each with its own root tree of one entry (f.txt) and its own blob, and one
// annotated tag on the tip. Hand-derived from upload-pack: without a depth a commit want brings every commit reachable
// from it, with depth d the commit and d - 1 generations (a tag: the commits counted from the one it peels to,
// shallow.c get_shallow_commits deref_tag); filter tree:0 keeps commits and tags (and a tree that is itself the want),
// blob:none adds each commit's trees, no filter adds the blobs.
export function packObjects(c, depth, commits) {
  if (c.expectType === 'BLOB') return 1;
  const full = c.path === 'unfiltered' || c.path === "filter ''";
  if (c.expectType === 'TREE') return full ? 2 : 1;
  const perCommit = c.path === 'tree:0' ? 1 : (full ? 3 : 2);
  const n = depth === null ? commits : Math.min(depth, commits);
  return n * perCommit + (c.expectType === 'TAG' ? 1 : 0);
}

// What the call must do: the requests in order (`POST <deepen or ->`, `GET` for the advertisement), then ok or the
// error code. `depth` is the depth git answered the last request with (null: none, or the server ignored it);
// `objects` what that pack holds.
export function expected(c, commits) {
  const mayBeCommit = c.expectType !== 'TREE' && c.expectType !== 'BLOB';
  // R2, then R1: not for a record taught that the server lists no `shallow` (R3: as on main)
  const first = c.asked !== 'none' ? (c.asked === '0' ? null : Number(c.asked)) : (mayBeCommit && c.knowledge !== 'unlisted' ? 1 : null);
  const answered = (requests, sent) => {
    const depth = c.refusal === 'ignored' ? null : sent;
    const objects = packObjects(c, depth, commits);
    // main: the single fetch takes a pack of more than one object only for a want typed COMMIT (README, fetchObject)
    const single = c.path === 'tree:0' || c.path === "filter ''";
    return { requests, outcome: single && c.expectType !== 'COMMIT' && objects !== 1 ? 'pack_corrupt' : 'ok', depth, objects };
  };
  // a request without `deepen` is git's, and so is one whose `deepen` the server takes or ignores: one request (R4)
  if (first === null || !(c.refusal in REFUSED)) return answered([post(first)], first);
  const code = REFUSED[c.refusal];
  // The advertisement is read in this call: main's filter fallback (an empty response on the tree:0 path), or R3 (a
  // default depth, nothing learned for the record).
  const read = (c.path === 'tree:0' && c.refusal === 'empty') || (c.asked === 'none' && c.knowledge === 'unlearned');
  if (!read) return { requests: [post(first)], outcome: code };
  // it lists no `shallow` and the depth was ply's own: asked again without it, once (R3). The caller's stands (R2).
  if (c.asked === 'none' && c.advertised === 'no') return answered([post(first), 'GET', post(null)], null);
  return { requests: [post(first), 'GET'], outcome: code };
}

export const START = '<!-- default-depth: generated by test/space/default-depth.test.js (DEFAULT_DEPTH_WRITE=1); do not edit by hand -->';
export const END = '<!-- default-depth: end generated -->';
// The generated part of SPACE.md's "Default depth" section: the axes, the product and the census of expected outcomes.
export function block(commits) {
  const L = [START, '', '### Axes', ''];
  for (const a of AXES) {
    L.push(`**${a.name}** — ${a.doc} (${a.variants.length})`, '');
    for (const v of a.variants) L.push(`- \`${v.tag}\` — ${v.why}`);
    L.push('');
  }
  const all = cells();
  const census = new Map();
  for (const c of all) {
    const e = expected(c, commits);
    const k = `${e.requests.join(', ')} → ${e.outcome}`;
    census.set(k, (census.get(k) ?? 0) + 1);
  }
  L.push('### Product', '', `${AXES.map(a => a.variants.length).join(' × ')} = **${all.length.toLocaleString('en-US')} cells** (${AXES.map(a => a.name).join(' × ')}), none removed.`, '');
  L.push('| requests, in order → outcome | cells |', '|---|---:|');
  for (const [k, n] of [...census].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))) L.push(`| \`${k}\` | ${n.toLocaleString('en-US')} |`);
  L.push('', END);
  return L.join('\n');
}
