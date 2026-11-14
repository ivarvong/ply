// The differential probe scenarios, keyed by matrix behaviour (`<behaviour>#<variant>`), in priority order: the hard
// state transitions first (stale old ids, lost answers, contention, atomicity, refs moved under a push, size caps,
// non-fast-forward), then the plain transitions the hard ones are read against. Each is a pure plan; the runner
// (test/probes/runner.mjs) seeds a fresh repository per target, runs the steps, and stock git judges the result.
import { ABSENT } from './types.js';
import type { CommitSpec, Damage, Expectation, Fault, Timeouts, FileSpec, FinalRef, Move, NonEmpty, ObjRef, ObjectSpec, OidExpr, Outcome, Push, RefAt, Scenario, StepExpect, TagSpec, Update } from './types.js';

const text = (path: string, s: string): FileSpec => ({ path, content: { tag: 'text', text: s } });
const noise = (path: string, seed: string, bytes: number): FileSpec => ({ path, content: { tag: 'noise', seed, bytes } });
const commit = (name: string, parents: readonly string[], files: readonly FileSpec[]): CommitSpec => ({ tag: 'commit', name, parents, files, message: name });
const tag = (name: string, target: string, tagName: string): TagSpec => ({ tag: 'annotated-tag', name, target, tagName, message: `tag ${tagName}` });
const ZERO: OidExpr = { tag: 'zero' };
const o = (name: string): OidExpr => ({ tag: 'obj', name });
const at = (ref: string, name: string): RefAt => ({ ref, at: name });
const upd = (ref: string, old: OidExpr, next: OidExpr): Update => ({ ref, old, new: next });
const move = (ref: string, to: OidExpr): Move => ({ ref, to });
const one = (outcome: Outcome, error: string | null): StepExpect => ({ outcome, error });
const both = (e: StepExpect): Expectation => ({ tag: 'one', ply: e, git: e });
const LANDED: Expectation = both(one('landed', null));
const finalAt = (ref: string, name: string): FinalRef => ({ tag: 'at', ref, at: name });
const absent = (ref: string): FinalRef => ({ tag: 'absent', ref });
const pushOf = (updates: NonEmpty<Update>, atomic = false): Push => ({ updates, atomic, omit: [], pack: { tag: 'objects' } });
const MAIN = 'refs/heads/main';
const SIDE = 'refs/heads/side';

// base -- ff         (f.txt changed)
//      \- diverged   (g.txt added)
const CORE: readonly ObjectSpec[] = [
  commit('base', [], [text('f.txt', 'base\n'), text('dir/n.txt', 'nested\n')]),
  commit('ff', ['base'], [text('f.txt', 'ff\n')]),
  commit('diverged', ['base'], [text('g.txt', 'diverged\n')]),
];
const EXACT = { tag: 'exact' } as const;
const PLAIN = { referenceConfig: [], compare: EXACT } as const;
const SAME = { tag: 'same' } as const;
const NO_FAULT = { tag: 'none' } as const;
const FULL = { tag: 'full' } as const;
const step = (push: Push, fault: Fault = NO_FAULT) => ({ tag: 'push', push, fault, git: SAME, ply: SAME, from: FULL, timeouts: null }) as const;
const nonEmpty = <T>(xs: readonly T[]): NonEmpty<T> => {
  const [first, ...rest] = xs;
  if (first === undefined) throw new Error('nonEmpty: empty list');
  return [first, ...rest];
};

const CONTENDERS = 8;
const contenders = Array.from({ length: CONTENDERS }, (_, i) => commit(`c${i}`, ['base'], [text(`c${i}.txt`, `contender ${i}\n`)]));
const contenderNames = nonEmpty(contenders.map(c => c.name));

// 66 MiB of incompressible content in three 22 MiB blobs: over a 64 MiB pack cap, each blob under a 32 MiB object cap.
const MIB = 1024 * 1024;
const BIG = commit('big', ['base'], [noise('big/a.bin', 'a', 22 * MIB), noise('big/b.bin', 'b', 22 * MIB), noise('big/c.bin', 'c', 22 * MIB)]);
const MANY = 50;

// ---- days 5-6 batch B objects ----
// x: a child of ff; a depth-2 shallow fetch of x holds x and ff, with base below the boundary
const X = commit('x', ['ff'], [text('f.txt', 'x\n')]);
// ghost and thin: siblings of ff; ghost is never on the target and holds the blob a thin pack names as its delta base
const LINES = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join('');
const GHOST = commit('ghost', ['base'], [text('t.txt', LINES)]);
const THIN = commit('thin', ['base'], [text('t.txt', `${LINES}one more\n`)]);
// y changes f.txt on ff; z adds copy.txt holding the same blob as dir/n.txt, which a blob:none clone never fetched
const Y = commit('y', ['ff'], [text('f.txt', 'y\n')]);
const Z = commit('z', ['ff'], [text('copy.txt', 'nested\n')]);
const blob = (of: string, path: string): ObjRef => ({ tag: 'blob', of, path });
const hand = (push: Push, deltaBase: ObjRef | null, delta: 'literal' | 'copy-past-end', damage: Damage): Push => ({ ...push, pack: { tag: 'hand', deltaBase, delta, damage } });
const NO_GIT_PACK = { tag: 'none', why: 'stock git writes its own packs; this pack is written by the harness and sent by ply (pushPack)' } as const;
const handStep = (push: Push) => ({ tag: 'push', push, fault: NO_FAULT, git: NO_GIT_PACK, ply: SAME, from: FULL, timeouts: null }) as const;
// ---- days 5-6 batch C objects and steps ----
// mid: 2 MiB of incompressible content on base, so a cut or a stall lands inside the pack
const MID = commit('mid', ['base'], [noise('mid.bin', 'mid', 2 * MIB)]);
const fetchStep = (want: string, fault: Fault, timeouts: Timeouts = null) => ({ tag: 'fetch', ref: MAIN, want, fault, git: SAME, timeouts }) as const;
const STALL_MS = 20_000;
const REFUSED_PACK = { tag: 'one', ply: one('rejected', 'push_rejected'), git: null } as const;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'concurrency.stale-old-oid#race',
    description: 'Both clients read main at base; another writer moves main to diverged while the receive-pack request is held; the push base->ff must be refused and main stay at diverged.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff'))]), { tag: 'race', moves: [move(MAIN, o('diverged'))] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'concurrency.stale-old-oid#direct',
    description: 'ply sends a push whose old id (base) is already stale (main is at diverged): the server refuses it, main unchanged.',
    seed: { objects: CORE, refs: [at(MAIN, 'diverged')] },
    steps: [{ tag: 'push', push: pushOf([upd(MAIN, o('base'), o('ff'))]), fault: NO_FAULT, from: FULL, timeouts: null, ply: SAME, git: { tag: 'none', why: 'stock git checks --force-with-lease against its own advertisement and refuses client side ("stale info"); the race variant is its server-side form' } }],
    expect: [{ tag: 'one', ply: one('conflict', 'cas_conflict'), git: null }],
    final: [finalAt(MAIN, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'interrupted.push-response-lost#cut',
    // stock git (libcurl) re-sends a request whose reused connection closed with no answer, so git's push is sent twice:
    // the replay meets the server's compare-and-swap (main is already ff) and is refused, and git's own retry finds
    // main up to date. ply sends once and says ambiguous. Both must leave main at ff with nothing applied twice.
    description: 'The server applies base->ff but its answer is cut: ply must report ambiguous, refs show the push landed, a naive retry is refused; stock git\'s transparent re-send must be refused by compare-and-swap.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff'))]), { tag: 'cut-response' }), step(pushOf([upd(MAIN, o('base'), o('ff'))]))],
    expect: [{ tag: 'one', ply: one('ambiguous', 'ambiguous'), git: one('conflict', 'cas_conflict') }, { tag: 'one', ply: one('conflict', 'cas_conflict'), git: one('landed', null) }],
    final: [finalAt(MAIN, 'ff')],
    ...PLAIN,
  },
  {
    id: 'concurrency.empty-report-under-contention#distinct-refs',
    description: `${CONTENDERS} pushes at once to one repository, each creating its own branch: every one lands, or is reported ambiguous (never landed when it did not).`,
    seed: { objects: [...CORE, ...contenders], refs: [at(MAIN, 'base')] },
    steps: [{ tag: 'concurrent', pushes: nonEmpty(contenders.map(c => pushOf([upd(`refs/heads/p-${c.name}`, ZERO, o(c.name))]))), git: SAME }],
    expect: [{ tag: 'many', ply: contenders.map(() => 'landed' as const), git: contenders.map(() => 'landed' as const) }],
    final: contenders.map(c => finalAt(`refs/heads/p-${c.name}`, c.name)),
    ...PLAIN,
  },
  {
    id: 'concurrency.empty-report-under-contention#same-ref',
    description: `${CONTENDERS} pushes at once moving main from base to ${CONTENDERS} different commits: exactly one lands, the rest are refused as conflicts.`,
    seed: { objects: [...CORE, ...contenders], refs: [at(MAIN, 'base')] },
    steps: [{ tag: 'concurrent', pushes: nonEmpty(contenders.map(c => pushOf([upd(MAIN, o('base'), o(c.name))]))), git: SAME }],
    expect: [{ tag: 'many', ply: ['landed', ...contenders.slice(1).map(() => 'conflict' as const)], git: ['landed', ...contenders.slice(1).map(() => 'conflict' as const)] }],
    final: [{ tag: 'one-of', ref: MAIN, names: contenderNames }],
    referenceConfig: [],
    compare: { tag: 'winner-of', why: 'the winner of a same-ref race is not fixed; objects, trees and ancestry follow it' },
  },
  {
    id: 'push.atomic#all-land',
    description: 'An atomic push moving main and side base->ff: both land.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff')), upd(SIDE, o('base'), o('ff'))], true))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'ff'), finalAt(SIDE, 'ff')],
    ...PLAIN,
  },
  {
    id: 'push.atomic#one-stale',
    description: 'An atomic push of main and side base->ff while another writer moves side to diverged: neither lands.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff')), upd(SIDE, o('base'), o('ff'))], true), { tag: 'race', moves: [move(SIDE, o('diverged'))] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), finalAt(SIDE, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'push.non-atomic-partial#one-stale',
    description: 'A non-atomic push of main and side base->ff while another writer moves side to diverged: main lands, side is refused, the client says which.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff')), upd(SIDE, o('base'), o('ff'))]), { tag: 'race', moves: [move(SIDE, o('diverged'))] })],
    expect: [both(one('partial', 'push_partial'))],
    final: [finalAt(MAIN, 'ff'), finalAt(SIDE, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'concurrency.ref-created-between-read-and-push#race',
    description: 'A create of refs/heads/new (zero old id) while another writer creates it first: refused, the winner kept.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/heads/new', ZERO, o('ff'))]), { tag: 'race', moves: [move('refs/heads/new', o('diverged'))] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), finalAt('refs/heads/new', 'diverged')],
    ...PLAIN,
  },
  {
    id: 'concurrency.ref-deleted-between-read-and-push#race',
    description: 'An update side base->ff while another writer deletes side: refused, side stays deleted.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(SIDE, o('base'), o('ff'))]), { tag: 'race', moves: [move(SIDE, ZERO)] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), absent(SIDE)],
    ...PLAIN,
  },
  {
    id: 'push.size-limits#pack-over-cap',
    description: 'A 66 MiB pack (three 22 MiB incompressible blobs) against a 64 MiB receive cap: refused, main unchanged.',
    seed: { objects: [...CORE, BIG], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('big'))]))],
    // ply classifies limit_exceeded from Artifacts' wording only; git http-backend's refusal is "unpacker error" with the
    // reason on band 2, which stock git's stderr shows ("pack exceeds maximum allowed size")
    expect: [{ tag: 'one', ply: one('rejected', 'push_rejected'), git: one('rejected', 'limit_exceeded') }],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  {
    id: 'push.non-fast-forward#with-old-id',
    description: 'A non-fast-forward update ff->diverged naming the current old id (a forced update with a lease): accepted.',
    seed: { objects: CORE, refs: [at(MAIN, 'ff')] },
    steps: [step(pushOf([upd(MAIN, o('ff'), o('diverged'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'push.fast-forward-update#plain',
    description: 'A fast-forward update base->ff with the current old id lands.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'ff')],
    ...PLAIN,
  },
  {
    id: 'push.create-ref#plain',
    description: 'A create (zero old id) of refs/heads/new at ff lands.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/heads/new', ZERO, o('ff'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/heads/new', 'ff')],
    ...PLAIN,
  },
  {
    id: 'push.create-ref#already-exists',
    // pins the git form of a create: with a lease or force git would overwrite the ref (git 2.47 ignores an empty or zero
    // lease on a create); as a plain push it refuses client side, and ply's zero old id is refused by the server
    description: 'A create (zero old id) of refs/heads/new at ff when new already exists at diverged: refused, new unchanged.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at('refs/heads/new', 'diverged')] },
    steps: [step(pushOf([upd('refs/heads/new', ZERO, o('ff'))]))],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), finalAt('refs/heads/new', 'diverged')],
    ...PLAIN,
  },
  {
    id: 'push.delete-ref#plain',
    description: 'A delete (zero new id) of side lands.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(SIDE, o('base'), ZERO)]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), absent(SIDE)],
    ...PLAIN,
  },
  {
    id: 'push.first-commit-empty-repo#root',
    description: 'The first push to an empty repository creates main from a root commit; HEAD names main.',
    seed: { objects: CORE, refs: [] },
    steps: [step(pushOf([upd(MAIN, ZERO, o('base'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  {
    id: 'tags.lightweight-create#plain',
    description: 'A lightweight tag refs/tags/v1 created at ff (sending ff\'s objects).',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/tags/v1', ZERO, o('ff'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/tags/v1', 'ff')],
    ...PLAIN,
  },
  {
    id: 'tags.annotated-create#plain',
    description: 'An annotated tag object for base pushed as refs/tags/v1.',
    seed: { objects: [...CORE, tag('t1', 'base', 'v1')], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/tags/v1', ZERO, o('t1'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/tags/v1', 't1')],
    ...PLAIN,
  },
  {
    id: 'tags.delete#plain',
    description: 'A delete of refs/tags/v0.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at('refs/tags/v0', 'base')] },
    steps: [step(pushOf([upd('refs/tags/v0', o('base'), ZERO)]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), absent('refs/tags/v0')],
    ...PLAIN,
  },
  {
    id: 'ancestry.merge-commit-push#two-parents',
    description: 'A two-parent merge of ff and diverged pushed onto main (base->merge): ancestry and merge bases as git computes them.',
    seed: { objects: [...CORE, commit('merge', ['ff', 'diverged'], [text('g.txt', 'diverged\n')])], refs: [at(MAIN, 'base'), at(SIDE, 'diverged')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('merge'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'merge'), finalAt(SIDE, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'push.many-ref-updates#fifty-creates',
    description: `One push creating ${MANY} branches at ff.`,
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf(nonEmpty(Array.from({ length: MANY }, (_, i) => upd(`refs/heads/many/${String(i).padStart(2, '0')}`, ZERO, o('ff'))))))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), ...Array.from({ length: MANY }, (_, i) => finalAt(`refs/heads/many/${String(i).padStart(2, '0')}`, 'ff'))],
    ...PLAIN,
  },
  // ---- days 5-6: more race shapes, retry after a refusal under contention ----
  {
    id: 'concurrency.stale-old-oid#delete-vs-update',
    description: 'Both clients read side at base and delete it; another writer moves side to diverged while the request is held: the delete must be refused and side stay at diverged.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(SIDE, o('base'), ZERO)]), { tag: 'race', moves: [move(SIDE, o('diverged'))] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), finalAt(SIDE, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'concurrency.concurrent-writers#create-vs-create',
    description: 'Two pushes at once create refs/heads/new, one at ff and one at diverged: exactly one lands, the other is refused as a conflict.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [{ tag: 'concurrent', pushes: [pushOf([upd('refs/heads/new', ZERO, o('ff'))]), pushOf([upd('refs/heads/new', ZERO, o('diverged'))])], git: SAME }],
    expect: [{ tag: 'many', ply: ['landed', 'conflict'], git: ['landed', 'conflict'] }],
    final: [finalAt(MAIN, 'base'), { tag: 'one-of', ref: 'refs/heads/new', names: ['ff', 'diverged'] }],
    referenceConfig: [],
    compare: { tag: 'winner-of', why: 'the winner of a create race is not fixed; objects, trees and ancestry follow it' },
  },
  {
    id: 'concurrency.concurrent-writers#delete-vs-update',
    description: 'Two pushes at once on side (at base): one deletes it, one moves it to ff: exactly one lands, the other is refused as a conflict.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [{ tag: 'concurrent', pushes: [pushOf([upd(SIDE, o('base'), ZERO)]), pushOf([upd(SIDE, o('base'), o('ff'))])], git: SAME }],
    expect: [{ tag: 'many', ply: ['landed', 'conflict'], git: ['landed', 'conflict'] }],
    final: [finalAt(MAIN, 'base'), { tag: 'one-of', ref: SIDE, names: ['ff', ABSENT] }],
    referenceConfig: [],
    compare: { tag: 'winner-of', why: 'the winner of a delete/update race is not fixed; objects, trees and ancestry follow it' },
  },
  {
    id: 'concurrency.empty-report-under-contention#retry-after-busy',
    description: `${CONTENDERS} pushes at once, each creating its own branch; then every push that did not land is sent again, one at a time: each retry lands (a create of a ref the first attempt had made would be refused), so nothing reported unknown was applied.`,
    seed: { objects: [...CORE, ...contenders], refs: [at(MAIN, 'base')] },
    steps: [
      { tag: 'concurrent', pushes: nonEmpty(contenders.map(c => pushOf([upd(`refs/heads/p-${c.name}`, ZERO, o(c.name))]))), git: SAME },
      { tag: 'retry-unlanded', of: 0, git: SAME },
    ],
    expect: [
      { tag: 'many', ply: contenders.map(() => 'landed' as const), git: contenders.map(() => 'landed' as const) },
      { tag: 'many', ply: contenders.map(() => 'landed' as const), git: contenders.map(() => 'landed' as const) },
    ],
    final: contenders.map(c => finalAt(`refs/heads/p-${c.name}`, c.name)),
    ...PLAIN,
  },
  // ---- days 5-6 batch B: packs ply sends as written, shallow and partial clients ----
  {
    id: 'pack.push-thin-against-server-base#literal-delta',
    description: 'ply pushes thin (t.txt of thin as a REF_DELTA against base:f.txt, which the server holds): the server completes it and the push lands.',
    seed: { objects: [...CORE, GHOST, THIN], refs: [at(MAIN, 'base')] },
    steps: [{ ...handStep(hand(pushOf([upd(MAIN, o('base'), o('thin'))]), blob('base', 'f.txt'), 'literal', 'none')), git: SAME }],
    expect: [LANDED],
    final: [finalAt(MAIN, 'thin')],
    ...PLAIN,
  },
  {
    id: 'pack.push-thin-missing-base#ghost-base',
    description: 'ply pushes a pack whose only blob is a REF_DELTA against ghost:t.txt, which the server never had: refused, main unchanged.',
    seed: { objects: [...CORE, GHOST, THIN], refs: [at(MAIN, 'base')] },
    steps: [handStep(hand(pushOf([upd(MAIN, o('base'), o('thin'))]), blob('ghost', 't.txt'), 'literal', 'none'))],
    expect: [REFUSED_PACK],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  {
    id: 'pack.push-malformed-object-refused#missing-blob',
    description: 'ply pushes base->ff in a pack missing ff\'s new f.txt blob (the tree names it): refused, main unchanged.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [handStep({ ...hand(pushOf([upd(MAIN, o('base'), o('ff'))]), null, 'literal', 'none'), omit: [blob('ff', 'f.txt')] })],
    expect: [REFUSED_PACK],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  {
    id: 'pack.push-malformed-object-refused#delta-copy-past-end',
    description: 'ply pushes base->ff with ff\'s blob as a REF_DELTA against base:f.txt whose copy reads past the end of the base: refused, main unchanged.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [handStep(hand(pushOf([upd(MAIN, o('base'), o('ff'))]), blob('base', 'f.txt'), 'copy-past-end', 'none'))],
    expect: [REFUSED_PACK],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  ...(['bad-trailer', 'bad-zlib', 'truncated'] as const).map((damage): Scenario => ({
    id: `pack.push-corrupt-pack-refused#${damage}`,
    description: `ply pushes base->ff in a pack with ${damage === 'bad-trailer' ? 'a wrong trailing SHA-1' : damage === 'bad-zlib' ? 'an object whose zlib stream fails its Adler-32 check (trailer recomputed)' : 'only its first half'}: refused, main unchanged.`,
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [handStep(hand(pushOf([upd(MAIN, o('base'), o('ff'))]), null, 'literal', damage))],
    expect: [REFUSED_PACK],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  })),
  {
    id: 'push.from-shallow-clone#boundary-held',
    description: 'main at ff; stock git pushes x (a child of ff) from a depth-2 shallow fetch of x (boundary ff, which the server holds): lands.',
    seed: { objects: [...CORE, X], refs: [at(MAIN, 'ff')] },
    steps: [{ ...step(pushOf([upd(MAIN, o('ff'), o('x'))])), from: { tag: 'shallow', tip: 'x', depth: 2 } }],
    expect: [LANDED],
    final: [finalAt(MAIN, 'x')],
    ...PLAIN,
  },
  {
    id: 'push.from-shallow-clone#history-missing',
    description: 'An empty repository; ply pushes x with ff but without base (the history below a depth-2 shallow boundary): refused as a missing object, no ref created.',
    seed: { objects: [...CORE, X], refs: [] },
    steps: [{ ...step({ ...pushOf([upd(MAIN, ZERO, o('x'))]), omit: [{ tag: 'commit', name: 'base' }] }), git: { tag: 'none', why: 'stock git sends its shallow boundary with such a push; that form is the shallow-update variant' } }],
    expect: [{ tag: 'one', ply: one('rejected', 'push_rejected'), git: null }],
    final: [absent(MAIN)],
    ...PLAIN,
  },
  {
    id: 'push.from-shallow-clone#shallow-update',
    // git http-backend refuses this by default ("shallow update not allowed"); the reference runs with
    // receive.shallowUpdate=true, the receiver this scenario compares against
    description: 'An empty repository; stock git pushes x from a depth-2 shallow fetch (x and ff, base below the boundary), sending its shallow line; with receive.shallowUpdate=true the push lands and the repository records ff as a shallow boundary.',
    seed: { objects: [...CORE, X], refs: [] },
    steps: [{ ...step(pushOf([upd(MAIN, ZERO, o('x'))])), from: { tag: 'shallow', tip: 'x', depth: 2 }, ply: { tag: 'none', why: 'ply keeps no shallow state and sends no shallow line; its form is the history-missing variant' } }],
    expect: [{ tag: 'one', ply: one('landed', null), git: one('landed', null) }],
    final: [finalAt(MAIN, 'x')],
    referenceConfig: [['receive.shallowUpdate', 'true']],
    compare: EXACT,
  },
  {
    id: 'push.from-partial-clone#blob-none',
    description: 'main at ff; each client first fetches main with filter blob:none, then pushes y (f.txt changed): lands.',
    seed: { objects: [...CORE, Y], refs: [at(MAIN, 'ff')] },
    steps: [{ ...step(pushOf([upd(MAIN, o('ff'), o('y'))])), from: { tag: 'partial' } }],
    expect: [LANDED],
    final: [finalAt(MAIN, 'y')],
    ...PLAIN,
  },
  {
    id: 'push.from-partial-clone#reuse-absent-blob',
    description: 'main at ff; from a blob:none clone, push z, whose new tree names dir/n.txt\'s blob (never fetched) at copy.txt: lands, and the blob is not sent.',
    seed: { objects: [...CORE, Z], refs: [at(MAIN, 'ff')] },
    steps: [{ ...step(pushOf([upd(MAIN, o('ff'), o('z'))])), from: { tag: 'partial' } }],
    expect: [LANDED],
    final: [finalAt(MAIN, 'z')],
    ...PLAIN,
  },
  // ---- days 5-6 batch C: a request body cut, stalls on both sides, a fetch answer dropped midway ----
  {
    id: 'interrupted.push-body-cut#half',
    // the 2 MiB body is over git's http.postBuffer, so git streams it (after a 4-byte probe request) and cannot re-send
    // it: both clients say ambiguous, and each one's retry must land: the server applied nothing of the cut body
    description: 'A push base->mid (2 MiB) whose request body stops halfway and is aborted: nothing lands; each client says ambiguous and its retry lands; fsck clean.',
    seed: { objects: [...CORE, MID], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('mid'))]), { tag: 'cut-request', fraction: 0.5 }), step(pushOf([upd(MAIN, o('base'), o('mid'))]))],
    expect: [both(one('ambiguous', 'ambiguous')), LANDED],
    final: [finalAt(MAIN, 'mid')],
    ...PLAIN,
  },
  {
    id: 'interrupted.stall-timeouts#push-request-stall',
    description: `A push base->mid whose request body stops halfway for ${STALL_MS / 1000} s, then finishes: the server waits for it and the push lands.`,
    seed: { objects: [...CORE, MID], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('mid'))]), { tag: 'stall-request', fraction: 0.5, ms: STALL_MS })],
    expect: [LANDED],
    final: [finalAt(MAIN, 'mid')],
    ...PLAIN,
  },
  {
    id: 'interrupted.stall-timeouts#push-request-stall-10s',
    description: 'A push base->mid whose request body stops halfway for 10 s, then finishes: the server waits for it and the push lands.',
    seed: { objects: [...CORE, MID], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('mid'))]), { tag: 'stall-request', fraction: 0.5, ms: 10_000 })],
    expect: [LANDED],
    final: [finalAt(MAIN, 'mid')],
    ...PLAIN,
  },
  {
    id: 'interrupted.stall-timeouts#push-response-stall',
    description: 'The server applies base->ff and its answer is held 4 s against a 1 s client timer: ply says ambiguous (typed), stock git gives up with no report; main is at ff.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [{ ...step(pushOf([upd(MAIN, o('base'), o('ff'))]), { tag: 'stall-response', ms: 4000 }), timeouts: { ms: 1000 } }],
    expect: [{ tag: 'one', ply: one('ambiguous', 'ambiguous'), git: one('ambiguous', 'ambiguous') }],
    final: [finalAt(MAIN, 'ff')],
    ...PLAIN,
  },
  {
    id: 'interrupted.stall-timeouts#fetch-request-stall',
    description: `A fetch of main (mid) whose request body stops halfway for ${STALL_MS / 1000} s, then finishes: the server waits and the pack arrives.`,
    seed: { objects: [...CORE, MID], refs: [at(MAIN, 'mid')] },
    steps: [fetchStep('mid', { tag: 'stall-request', fraction: 0.5, ms: STALL_MS })],
    expect: [LANDED],
    final: [finalAt(MAIN, 'mid')],
    ...PLAIN,
  },
  {
    id: 'interrupted.stall-timeouts#fetch-response-stall',
    description: 'A fetch of main whose answer is held 4 s against a 1 s client timer: each client fails with a timeout, nothing is half-written.',
    seed: { objects: [...CORE, MID], refs: [at(MAIN, 'mid')] },
    steps: [fetchStep('mid', { tag: 'stall-response', ms: 4000 }, { ms: 1000 })],
    expect: [{ tag: 'one', ply: one('rejected', 'timeout'), git: one('rejected', 'timeout') }],
    final: [finalAt(MAIN, 'mid')],
    ...PLAIN,
  },
  {
    id: 'interrupted.fetch-dropped-mid-response#half',
    description: 'A fetch of main (mid, 2 MiB) whose answer stops halfway (connection closed): each client fails, never a partial result.',
    seed: { objects: [...CORE, MID], refs: [at(MAIN, 'mid')] },
    steps: [fetchStep('mid', { tag: 'drop-response', fraction: 0.5 })],
    expect: [{ tag: 'one', ply: one('rejected', 'network'), git: one('rejected', 'fetch_failed') }],
    final: [finalAt(MAIN, 'mid')],
    ...PLAIN,
  },
];
