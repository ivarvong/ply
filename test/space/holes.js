// The hole computation shared by the gates (test/space/registry.test.js, test/space/failsites.test.js), the ratchet
// writer and SPACES.md (scripts/spaces.mjs). A hole is one id in one category:
//
//   decisions  a decision point of the inventory (scripts/decision-points.mjs) that no registry rule names     gate a
//   git        a git-manifest entry (test/space/git-manifest.json) neither covered nor excluded                 gate b
//   failsites  a fail site (fail / failHere / wrapper call) no recorded stack passed through, unless excluded   gate c
//   claims     a fail site the registry assigns to a merged space whose runners did not reach it                gate c
//   linux      a runner of a merged CI space with no record from a Linux run. Judged only on records from Linux (CI);
//              a macOS pass does not count: the filesystem there hides cells (a non-UTF-8 ref name cannot be a file)
//   stale      a registry rule that matches nothing (the decision it named is gone or renamed)
//
// Ratchet (test/space/ratchet.json): per category, the ids that are holes today. A category stored with 0 holes is in
// ENFORCE mode: any hole fails. Otherwise REPORT mode: the holes are printed and the gate passes, unless a hole is not
// in the stored list (a new hole: the count can only go down, and a fixed hole cannot be traded for a new one). A fixed
// hole is reported until the ratchet is rewritten (`node scripts/spaces.mjs --ratchet`), which never adds an id.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, decisionPoints } from '../../scripts/decision-points.mjs';
import { SPACES, DECISIONS, GIT, SAMPLED } from './registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '../..');
export const RATCHET = join(HERE, 'ratchet.json');
export const CATEGORIES = ['decisions', 'git', 'failsites', 'claims', 'linux', 'stale'];
export const manifest = () => JSON.parse(readFileSync(join(HERE, 'git-manifest.json'), 'utf8'));
export const ratchet = () => JSON.parse(readFileSync(RATCHET, 'utf8'));
export const spaceByName = new Map(SPACES.map(s => [s.name, s]));
export const isSite = p => p.kind === 'fail' || p.kind === 'failHere' || p.kind === 'wrapper';

const glob = pattern => new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
// Resolve every id against a rule list: an exact rule wins over a glob; among globs, the first in source order.
export function resolve(ids, rules) {
  const exact = new Map(), globs = [];
  rules.forEach((r, i) => (r.match.includes('*') ? globs.push({ r, i, re: glob(r.match) }) : exact.set(r.match, { r, i })));
  const used = new Set(), by = new Map();
  for (const id of ids) {
    // a decode is never swept in by a function glob: its mode is a decision of its own, named explicitly
    const e = exact.get(id) ?? globs.find(g => g.re.test(id) && (!id.includes(':decode:') || g.r.match.includes(':decode:')));
    if (e) { by.set(id, e.r); used.add(e.i); }
  }
  return { by, unused: rules.filter((_, i) => !used.has(i)) };
}

// Structural problems in the registry itself (always fatal: a rule naming a space or axis that does not exist is a typo,
// not a hole).
export function registryProblems() {
  const bad = [];
  const names = new Set();
  for (const s of SPACES) {
    if (names.has(s.name)) bad.push(`space ${s.name} registered twice`);
    names.add(s.name);
    if (!['main', 'pending'].includes(s.status)) bad.push(`space ${s.name}: status must be main or pending`);
    if (s.status === 'pending' && !/^#\d+$/.test(s.pending ?? '')) bad.push(`space ${s.name}: a pending space names its PR (pending: '#NN')`);
    if (!['enumerated', 'curated', 'random'].includes(s.kind)) bad.push(`space ${s.name}: kind must be enumerated, curated or random`);
    if (!['ci', 'ci-step', 'nightly', 'local', 'manual'].includes(s.run)) bad.push(`space ${s.name}: run must be ci, ci-step, nightly, local or manual`);
    if (s.osDependent !== undefined && (typeof s.osDependent !== 'string' || s.osDependent.length < 12)) bad.push(`space ${s.name}: osDependent says why`);
    if (!s.oracle) bad.push(`space ${s.name}: no oracle`);
    if (!s.axes?.length) bad.push(`space ${s.name}: no axes`);
    if (s.status === 'main') for (const r of s.runners ?? []) if (!existsSync(join(ROOT, r))) bad.push(`space ${s.name}: runner ${r} does not exist`);
  }
  for (const [list, rules] of [['DECISIONS', DECISIONS], ['GIT', GIT]]) for (const r of rules) {
    if (typeof r.match !== 'string' || !r.match) { bad.push(`${list}: a rule without match`); continue; }
    if ('excluded' in r) { if (typeof r.excluded !== 'string' || r.excluded.length < 12) bad.push(`${list} ${r.match}: an exclusion needs a reason`); continue; }
    const s = spaceByName.get(r.space);
    if (!s) { bad.push(`${list} ${r.match}: unknown space ${r.space}`); continue; }
    if (!s.axes.some(a => a.tag === r.axisTag)) bad.push(`${list} ${r.match}: space ${r.space} has no axis ${r.axisTag} (axes: ${s.axes.map(a => a.tag).join(', ')})`);
  }
  return bad;
}

// Fail-site records written by test/space/failsite-hook.mjs: frame -> Set(runner).
export function readRecords(dir) {
  const frames = new Map();
  const runners = new Set();
  const platforms = new Map(); // runner -> Set(platform)
  if (!dir || !existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    runners.add(rec.runner);
    if (!platforms.has(rec.runner)) platforms.set(rec.runner, new Set());
    platforms.get(rec.runner).add(rec.platform ?? 'unknown');
    for (const k of Object.keys(rec.frames)) { if (!frames.has(k)) frames.set(k, new Set()); frames.get(k).add(rec.runner); }
  }
  return { frames, runners, platforms };
}
export const frameOf = p => `${p.file}:${p.callLine}:${p.col}`;

// Everything the gates and SPACES.md need, computed once.
export function compute({ records = null } = {}) {
  const inv = inventory();
  const points = decisionPoints(inv);
  const man = manifest();
  const dec = resolve(points.map(p => p.id), DECISIONS);
  const git = resolve(man.entries.map(e => e.id), GIT);
  const holes = { decisions: [], git: [], failsites: null, claims: null, linux: null, stale: [] };
  for (const p of points) if (!dec.by.has(p.id)) holes.decisions.push(p.id);
  for (const e of man.entries) if (!git.by.has(e.id)) holes.git.push(e.id);
  for (const r of dec.unused) holes.stale.push(`DECISIONS ${r.match}`);
  for (const r of git.unused) holes.stale.push(`GIT ${r.match}`);
  const sites = points.filter(isSite);
  let reachedBy = null;
  if (records) {
    reachedBy = new Map(sites.map(p => [p.id, records.frames.get(frameOf(p)) ?? new Set()]));
    const sampled = new Set(SAMPLED.map(s => s.id));
    // a site the registry excludes (with its reason) is not a hole for gate c either
    const excluded = p => { const r = dec.by.get(p.id); return !!r && 'excluded' in r; };
    holes.failsites = sites.filter(p => !reachedBy.get(p.id).size && !sampled.has(p.id) && !excluded(p)).map(p => p.id);
    holes.claims = [];
    for (const p of sites) {
      const r = dec.by.get(p.id);
      const s = r && !('excluded' in r) ? spaceByName.get(r.space) : null;
      if (!s || s.status !== 'main' || !s.runners?.length || sampled.has(p.id)) continue;
      // a claim is checked only when its space's runners were part of this run
      if (!s.runners.some(x => records.runners.has(x))) continue;
      if (!s.runners.some(x => reachedBy.get(p.id).has(x))) holes.claims.push(`${p.id} -> ${s.name}`);
    }
  }
  // the Linux gate: only a run that has Linux records can judge it (null otherwise: not judged, not passed)
  if (records && [...(records.platforms?.values() ?? [])].some(p => p.has('linux'))) {
    holes.linux = [];
    for (const s of SPACES) if (s.status === 'main' && s.run === 'ci') for (const r of s.runners ?? []) if (!records.platforms.get(r)?.has('linux')) holes.linux.push(`${s.name}: ${r}`);
  }
  return { inv, points, sites, man, dec, git, holes, reachedBy };
}

// Gate verdict for one category against the ratchet: { mode, problems, fixed }.
export function judge(category, ids, stored = ratchet().categories[category]) {
  const known = new Set(stored?.ids ?? []);
  const mode = (stored?.count ?? 0) === 0 ? 'ENFORCE' : 'REPORT';
  const fresh = ids.filter(id => !known.has(id));
  const fixed = [...known].filter(id => !ids.includes(id));
  return { mode, problems: mode === 'ENFORCE' ? ids : fresh, fixed, count: ids.length, stored: stored?.count ?? 0 };
}

// ---- severity: what a hole costs if git and ply disagree there ----
// 1: a strict or replacement decode of bytes git passes through raw (unless the registry says display-only);
//    a check on untrusted input (anything a server, a repository or the wire decides: objects, packs, pkt-lines,
//    reports, advertisements, ssh packets), on either side (a git check with no space, or a ply parser site no cell reached)
// 2: a decision that claims an outcome: landed, rejected, conflict, ambiguous, not fast-forward
// 3: the rest (caller input validation, limits, local I/O)
const UNTRUSTED_CODES = new Set(['pack_corrupt', 'protocol', 'not_git', 'remote_error', 'ssh', 'host_key_mismatch']);
const OUTCOME_CODES = new Set(['cas_conflict', 'push_rejected', 'ambiguous', 'merge_conflict', 'not_fast_forward', 'not_linear', 'unrelated_histories', 'match_count']);
const UNTRUSTED_GIT_KINDS = new Set(['fsck-msg', 'tree-mode', 'reject', 'ng', 'err-pkt', 'capability', 'refname-rule']);
const CLIENT_SIDE_PARSERS = new Set(['pkt-line.c', 'sideband.c', 'connect.c', 'send-pack.c']);
export function severityOfPoint(p) {
  if (p.kind === 'decode') return p.mode === 'lossless' ? 3 : 1;
  if (UNTRUSTED_CODES.has(p.code)) return 1;
  if (OUTCOME_CODES.has(p.code)) return 2;
  if (p.kind === 'export' && /^(parse|decode)/.test(p.fn)) return 1;
  if (p.kind === 'export' && /^(decide|classify)/.test(p.fn)) return 2;
  return 3;
}
export function severityOfGit(e) {
  if (UNTRUSTED_GIT_KINDS.has(e.kind)) return e.kind === 'fsck-msg' && e.severity === 'IGNORE' ? 3 : 1;
  if ((e.kind === 'die' || e.kind === 'error') && CLIENT_SIDE_PARSERS.has(e.file)) return 1;
  return 3;
}
