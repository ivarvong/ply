// A ratchet baseline may move the unsafe way only in a commit that says so. Each baseline's own script compares the
// tree with the baseline, so a change that edits both passes it; this compares the baseline with the base commit's.
//   node scripts/ratchet-guard.mjs [<base>]   base: the argument, else $RATCHET_BASE, else origin/main
// A loosened baseline fails unless a commit in <merge-base>..HEAD carries, on a line of its own,
//   Ratchet-Change: <file>: <reason>
// Loosened means: throw-baseline's count rose; an absence-baseline count rose or its boundary changed; a category of
// test/space/ratchet.json gained a hole id or was removed; test/durations.json lost the entry of a test file that
// still exists (it would be planned as the heaviest file). A baseline the base does not have is new, not loosened.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const rose = (base, head) => Object.keys(base).filter(k => typeof base[k] === 'number')
  .flatMap(k => (typeof head[k] !== 'number' ? [`${k} removed`] : head[k] > base[k] ? [`${k} rose ${base[k]} -> ${head[k]}`] : []));

export const BASELINES = {
  'scripts/throw-baseline.json': rose,
  'scripts/absence-baseline.json': (base, head) => [...(head.boundary === base.boundary ? [] : [`boundary ${base.boundary} -> ${head.boundary}`]), ...rose(base, head)],
  'test/space/ratchet.json': (base, head) => Object.entries(base.categories ?? {}).flatMap(([c, { ids }]) => {
    const now = head.categories?.[c];
    if (!now) return [`category ${c} removed`];
    const had = new Set(ids);
    return now.ids.filter(id => !had.has(id)).map(id => `${c} gained hole ${id}`);
  }),
  'test/durations.json': (base, head, exists) => Object.keys(base).filter(f => !(f in head) && exists(f)).map(f => `${f} lost its weight`),
};

// The ways `file` moved the unsafe way between two versions of its text; [] when it did not.
export function loosened(file, baseText, headText, exists = existsSync) {
  if (baseText === null) return [];
  if (headText === null) return ['baseline deleted'];
  return BASELINES[file](JSON.parse(baseText), JSON.parse(headText), exists);
}

function main() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ref = process.argv[2] ?? (process.env.RATCHET_BASE || 'origin/main');
  let base;
  try { base = git('merge-base', ref, 'HEAD').trim(); } catch {
    console.error(`ratchet-guard: cannot resolve base '${ref}' (fetch it; CI needs fetch-depth: 0)`);
    process.exit(1);
  }
  const marked = new Set([...git('log', '--format=%B', `${base}..HEAD`).matchAll(/^Ratchet-Change: (\S+): \S.*$/gmu)].map(m => m[1]));
  let failed = false;
  for (const file of Object.keys(BASELINES)) {
    let baseText = null;
    try { baseText = git('show', `${base}:${file}`); } catch { /* not in the base: a new baseline */ }
    const why = loosened(file, baseText, existsSync(file) ? readFileSync(file, 'utf8') : null);
    if (why.length === 0) continue;
    if (marked.has(file)) { console.log(`ratchet-guard: ${file} loosened (${why.length}), declared by Ratchet-Change`); continue; }
    failed = true;
    console.error(`ratchet-guard: ${file} moved the unsafe way against ${base.slice(0, 7)}:\n${why.slice(0, 20).map(w => `  ${w}`).join('\n')}${why.length > 20 ? `\n  ... ${why.length - 20} more` : ''}\n  a commit must carry the line 'Ratchet-Change: ${file}: <reason>'`);
  }
  if (failed) process.exit(1);
  console.log(`ratchet-guard: no undeclared loosening against ${base.slice(0, 7)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
