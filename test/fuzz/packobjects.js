// Run `git pack-objects` exactly as upload-pack does for a v2 fetch, and return the
// object set it produced. This is the exact-set oracle; the model gives the bound.
import { execFileSync } from 'node:child_process';
import { gitBuf } from '../server.js';
import { parsePack, resolvePack } from '../../src/pack.js';
import { effectiveHaves } from './dag.js';

// Git 2.56 moved the argv out of upload-pack.c create_pack_file into
// odb/source-files.c odb_source_files_generate_pack. --thin follows --stdout, and
// progress-none (ply sends no-progress by default) is spelled --quiet. Through 2.55
// --thin precedes --stdout and a quiet client adds no flag.
export const PACK_ARGV_QUIET = Object.freeze([2, 56, 0]);

const atLeast = (version, floor) => version[0] > floor[0] || (version[0] === floor[0] && (version[1] > floor[1] || (version[1] === floor[1] && version[2] >= floor[2])));

export function installedGitVersion() {
  const s = execFileSync('git', ['--version'], { encoding: 'utf8' });
  const m = /git version (\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) throw new Error(`unrecognized git version: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const INSTALLED_GIT = installedGitVersion();

export function packObjectsOracle(bare, model, req, { shallowSet, unshallowed = [], inDepth = new Map(), external }) {
  const { haves = [], filter, thinPack, ofsDelta = true } = req;
  // send_unshallow(): an unshallowed client commit's parents become wants, the commit itself an extra edge.
  // It sets object->parsed = 0 and re-parses, which appends the parents to the already-parsed list: each parent twice.
  const wants = [...req.wants, ...unshallowed.flatMap(u => { const ps = model.commits.get(u).parents; return [...ps, ...ps]; })];
  const peel = o => (model.tags.has(o) ? model.tags.get(o) : o);
  const known = effectiveHaves(model, haves);
  const shallows = [...shallowSet];
  const extraEdges = new Set(unshallowed);
  const { args, stdin } = reconstructInvocation({ wants, known, shallows, extraEdges, thinPack, ofsDelta, filter });
  const pack = new Uint8Array(gitBuf(bare, ['pack-objects', ...args, '-q'], stdin));
  if (pack.length === 0) return { objects: new Map(), count: 0 };
  const parsed = parsePack(pack);
  const r = resolvePack(parsed, external);
  return { objects: r.objects, count: parsed.stats.count, parsed };
}

// Argv in the order the installed git's upload-pack passes to pack-objects.
export function packObjectsArgs({ thinPack, shallows, ofsDelta, includeTag, filter, version = INSTALLED_GIT }) {
  const quiet = atLeast(version, PACK_ARGV_QUIET);
  const args = ['--revs'];
  if (thinPack && !quiet) args.push('--thin');
  args.push('--stdout');
  if (thinPack && quiet) args.push('--thin');
  if (shallows.length) args.push('--shallow');
  if (ofsDelta) args.push('--delta-base-offset');
  if (includeTag) args.push('--include-tag');
  if (quiet) args.push('--quiet');
  if (filter) args.push(`--filter=${filter}`);
  return args;
}

export function reconstructInvocation({ wants, known, shallows, extraEdges, thinPack, ofsDelta, includeTag, filter, version }) {
  const args = packObjectsArgs({ thinPack, shallows, ofsDelta, includeTag, filter, version });
  // grafts are written in oid order (for_each_commit_graft walks a sorted list)
  const stdin = [...[...shallows].sort().map(s => `--shallow ${s}`), ...wants, '--not', ...known, ...extraEdges, ''].join('\n') + '\n';
  return { args, stdin };
}
export function reconstructFor(model, req, { shallowSet, unshallowed = [] }) {
  const wants = [...req.wants, ...unshallowed.flatMap(u => { const ps = model.commits.get(u).parents; return [...ps, ...ps]; })];
  return reconstructInvocation({ wants, known: effectiveHaves(model, req.haves ?? []), shallows: [...shallowSet], extraEdges: unshallowed, thinPack: req.thinPack, ofsDelta: req.ofsDelta !== false, filter: req.filter });
}
