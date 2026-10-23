// Run `git pack-objects` exactly as upload-pack (git 2.43 create_pack_file) does for a v2 fetch, and return the
// object set it produced. This is the exact-set oracle; the model gives the bound.
import { gitBuf } from '../server.js';
import { parsePack, resolvePack } from '../../src/pack.js';
import { effectiveHaves } from './dag.js';

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

// upload-pack create_pack_file() (git 2.43): argv and stdin, in its order.
export function reconstructInvocation({ wants, known, shallows, extraEdges, thinPack, ofsDelta, includeTag, filter }) {
  const args = ['--revs'];
  if (thinPack) args.push('--thin');
  args.push('--stdout');
  if (shallows.length) args.push('--shallow');
  if (ofsDelta) args.push('--delta-base-offset');
  if (includeTag) args.push('--include-tag');
  if (filter) args.push(`--filter=${filter}`);
  // grafts are written in oid order (for_each_commit_graft walks a sorted list)
  const stdin = [...[...shallows].sort().map(s => `--shallow ${s}`), ...wants, '--not', ...known, ...extraEdges, ''].join('\n') + '\n';
  return { args, stdin };
}
export function reconstructFor(model, req, { shallowSet, unshallowed = [] }) {
  const wants = [...req.wants, ...unshallowed.flatMap(u => { const ps = model.commits.get(u).parents; return [...ps, ...ps]; })];
  return reconstructInvocation({ wants, known: effectiveHaves(model, req.haves ?? []), shallows: [...shallowSet], extraEdges: unshallowed, thinPack: req.thinPack, ofsDelta: req.ofsDelta !== false, filter: req.filter });
}
