// The differential probe scenarios, keyed by matrix behaviour (`<behaviour>#<variant>`), in priority order: the hard
// state transitions first (stale old ids, lost answers, contention, atomicity, refs moved under a push, size caps,
// non-fast-forward), then the plain transitions the hard ones are read against. Each is a pure plan; the runner
// (test/probes/runner.mjs here, ply-web's workbench in a Worker) seeds a fresh repository per target, runs the steps,
// and a judge reads the result back.
import { ABSENT } from './probe-types.js';
import type { CommitSpec, Damage, Expectation, Fault, Timeouts, FileSpec, FinalRef, GitForm, Move, NonEmpty, ObjRef, ObjectSpec, OidExpr, Outcome, PackDefect, Push, RawCommitSpec, RawTagSpec, RawTreeEntry, RawTreeSpec, RefAt, Scenario, Step, StepExpect, TagSpec, Update } from './probe-types.js';

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
const mapNonEmpty = <T, U>(xs: NonEmpty<T>, f: (x: T) => U): NonEmpty<U> => [f(xs[0]), ...xs.slice(1).map(x => f(x))];

const CONTENDER_INDEXES: NonEmpty<number> = [0, 1, 2, 3, 4, 5, 6, 7];
const CONTENDERS = CONTENDER_INDEXES.length;
const contenders: NonEmpty<CommitSpec> = mapNonEmpty(CONTENDER_INDEXES, i => commit(`c${i}`, ['base'], [text(`c${i}.txt`, `contender ${i}\n`)]));
const contenderNames = mapNonEmpty(contenders, c => c.name);

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

type Corruption = Exclude<Damage, 'none'>;
const DAMAGE_TEXT: Readonly<Record<Corruption, string>> = {
  'bad-trailer': 'a wrong trailing SHA-1',
  'bad-zlib': 'an object whose zlib stream fails its Adler-32 check (trailer recomputed)',
  truncated: 'only its first half',
};
const corrupt = (damage: Corruption): Scenario => ({
  id: `pack.push-corrupt-pack-refused#${damage}`,
  description: `ply pushes base->ff in a pack with ${DAMAGE_TEXT[damage]}: refused, main unchanged.`,
  seed: { objects: CORE, refs: [at(MAIN, 'base')] },
  steps: [handStep(hand(pushOf([upd(MAIN, o('base'), o('ff'))]), null, 'literal', damage))],
  expect: [REFUSED_PACK],
  final: [finalAt(MAIN, 'base')],
  ...PLAIN,
});

// ---- 2026-11-15: malformed packs and objects. Each is refused with an unpack or ng status, and the state after the
// refusal is the invariant: main unmoved, the repository still served (a fetch of main lands), and fsck --strict of a
// mirror clone clean. A defect in the pack's structure is written by the harness and sent by ply (pushPack); a
// malformed object is seeded byte for byte (git hash-object --literally) and pushed by both clients, whose own pack
// writers carry it unchecked.
const REFUSED: StepExpect = one('rejected', 'push_rejected');
// After the refused push: a fetch of main (still base) lands for the clients that ran the push.
const fetchAfter = (git: GitForm): Step => ({ tag: 'fetch', ref: MAIN, want: 'base', fault: NO_FAULT, git, timeouts: null });
const defectPush = (defect: PackDefect, updates: NonEmpty<Update> = [upd(MAIN, o('base'), o('ff'))]): Push => ({ ...pushOf(updates), pack: { tag: 'defect', defect } });
const DEFECT_TEXT: Readonly<Record<PackDefect['tag'], string>> = {
  signature: 'whose signature is PACX',
  version: 'whose header says version 4',
  count: 'whose header object count is off',
  'size-header': 'whose first blob\'s header states one byte more than its zlib stream inflates to',
  'bad-type': 'whose first blob\'s header carries object type 5 (reserved)',
  'ofs-delta-before-start': 'whose first blob is an OFS_DELTA reaching before the pack\'s first byte',
  'delta-size-mismatch': 'whose first blob is a REF_DELTA against base:f.txt stating a result one byte longer than it writes',
  duplicate: 'holding every object twice',
  'no-objects': 'with no objects',
};
// A pack-structure defect: ply only (stock git writes its own packs).
const defectScenario = (behaviour: 'pack.push-bad-header-refused' | 'pack.push-bad-entry-refused', variant: string, defect: PackDefect, extra = ''): Scenario => ({
  id: `${behaviour}#${variant}`,
  description: `ply pushes base->ff in a pack ${DEFECT_TEXT[defect.tag]}${extra}: refused, main unchanged, main still fetchable, fsck clean.`,
  seed: { objects: CORE, refs: [at(MAIN, 'base')] },
  steps: [handStep(defectPush(defect)), fetchAfter(NO_GIT_PACK)],
  expect: [{ tag: 'one', ply: REFUSED, git: null }, { tag: 'one', ply: one('landed', null), git: null }],
  final: [finalAt(MAIN, 'base')],
  ...PLAIN,
});
// Malformed objects, written byte for byte: trees over base's and ff's f.txt blobs, commits on base's tree.
const BASE_F = blob('base', 'f.txt');
const FF_F = blob('ff', 'f.txt');
const entry = (mode: string, name: string, b: ObjRef): RawTreeEntry => ({ mode, name, blob: b });
const rawTree = (name: string, entries: NonEmpty<RawTreeEntry>): RawTreeSpec => ({ tag: 'raw-tree', name, entries });
const rawCommit = (name: string, tree: string, author: string): RawCommitSpec => ({ tag: 'raw-commit', name, tree, parents: ['base'], author, message: name });
const PROBE_ID = 'ply probe <probe@ply.invalid>';
// One malformed object pushed as main base->bad by both clients: refused (receive.fsckObjects), main unchanged.
const fsckScenario = (behaviour: 'pack.push-fsck-tree-refused' | 'pack.push-fsck-commit-refused', variant: string, what: string, objects: readonly ObjectSpec[], fsckId: string): Scenario => ({
  id: `${behaviour}#${variant}`,
  description: `Both clients push main base->bad, where bad ${what} (git fsck: ${fsckId}): refused, main unchanged, main still fetchable, fsck clean.`,
  seed: { objects: [...CORE, ...objects], refs: [at(MAIN, 'base')] },
  steps: [step(pushOf([upd(MAIN, o('base'), o('bad'))])), fetchAfter(SAME)],
  expect: [both(REFUSED), LANDED],
  final: [finalAt(MAIN, 'base')],
  ...PLAIN,
});
const treeCase = (variant: string, what: string, fsckId: string, entries: NonEmpty<RawTreeEntry>): Scenario =>
  fsckScenario('pack.push-fsck-tree-refused', variant, `is a commit on base whose tree ${what}`, [rawTree('t', entries), rawCommit('bad', 't', `${PROBE_ID} 1700000000 +0000`)], fsckId);
const commitCase = (variant: string, what: string, fsckId: string, author: string): Scenario =>
  fsckScenario('pack.push-fsck-commit-refused', variant, `is a commit on base's tree whose author line ${what}`, [rawCommit('bad', 'base', author)], fsckId);
// 16 MiB of one byte: deflates to about 16 KiB (about 1000:1), under a 32 MiB object cap and the 64 MiB pack cap.
const RATIO = commit('ratio', ['base'], [{ path: 'zeros.bin', content: { tag: 'repeat', byte: 0, bytes: 16 * MIB } }]);

const MALFORMED: readonly Scenario[] = [
  {
    id: 'fetch.want-unreachable-or-unknown#phantom',
    description: 'ply fetches an id no one holds (want phantom): the server refuses it (ERR not our ref) and ply reports a typed remote error; main unchanged, fsck clean.',
    seed: { objects: [...CORE, { tag: 'phantom', name: 'phantom', seed: 'want-unknown' }], refs: [at(MAIN, 'base')] },
    steps: [{ tag: 'fetch', ref: MAIN, want: 'phantom', fault: NO_FAULT, git: { tag: 'none', why: 'the runner\'s git fetch names a ref; stock git\'s form, git fetch <url> <unknown id>, is loadgen-phase3 fake_sha' }, timeouts: null }],
    expect: [{ tag: 'one', ply: one('rejected', 'remote_error'), git: null }],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  defectScenario('pack.push-bad-header-refused', 'bad-signature', { tag: 'signature' }),
  defectScenario('pack.push-bad-header-refused', 'bad-version', { tag: 'version', version: 4 }),
  defectScenario('pack.push-bad-header-refused', 'count-more', { tag: 'count', by: 1 }, ' (one more than sent)'),
  defectScenario('pack.push-bad-header-refused', 'count-fewer', { tag: 'count', by: -1 }, ' (one fewer than sent)'),
  defectScenario('pack.push-bad-entry-refused', 'size-header-mismatch', { tag: 'size-header', by: 1 }),
  defectScenario('pack.push-bad-entry-refused', 'bad-type', { tag: 'bad-type', type: 5 }),
  defectScenario('pack.push-bad-entry-refused', 'ofs-delta-before-start', { tag: 'ofs-delta-before-start' }),
  defectScenario('pack.push-bad-entry-refused', 'delta-size-mismatch', { tag: 'delta-size-mismatch', base: BASE_F }),
  {
    id: 'pack.push-duplicate-entries#every-object-twice',
    // git http-backend with receive.fsckObjects (index-pack --strict) refuses a pack naming an object twice: unpacker error
    description: 'ply pushes base->ff in a pack holding every object twice (count doubled): refused, main unchanged, main still fetchable, fsck clean.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [handStep(defectPush({ tag: 'duplicate' })), fetchAfter(NO_GIT_PACK)],
    expect: [{ tag: 'one', ply: REFUSED, git: null }, { tag: 'one', ply: one('landed', null), git: null }],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  {
    id: 'push.ref-to-missing-object-refused#not-in-pack-or-repo',
    description: 'ply pushes main base->phantom (an id no one holds) with a well-formed pack of no objects: refused (missing necessary objects), main unchanged, still fetchable, fsck clean.',
    seed: { objects: [...CORE, { tag: 'phantom', name: 'phantom', seed: 'not-in-pack-or-repo' }], refs: [at(MAIN, 'base')] },
    steps: [{ ...handStep(defectPush({ tag: 'no-objects' }, [upd(MAIN, o('base'), o('phantom'))])), git: { tag: 'none', why: 'stock git refuses client side to push an object it does not have' } }, fetchAfter({ tag: 'none', why: 'stock git has no form of the push' })],
    expect: [{ tag: 'one', ply: REFUSED, git: null }, { tag: 'one', ply: one('landed', null), git: null }],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  treeCase('unsorted', 'lists g.txt before f.txt', 'treeNotSorted', [entry('100644', 'g.txt', FF_F), entry('100644', 'f.txt', BASE_F)]),
  treeCase('duplicate-name', 'names f.txt twice', 'duplicateEntries', [entry('100644', 'f.txt', BASE_F), entry('100644', 'f.txt', FF_F)]),
  treeCase('slash-in-name', 'has an entry named dir/x.txt', 'fullPathname', [entry('100644', 'dir/x.txt', BASE_F)]),
  treeCase('dot-git', 'has an entry named .git', 'hasDotgit', [entry('100644', '.git', BASE_F)]),
  treeCase('zero-padded-mode', 'has a file mode written 0100644', 'zeroPaddedFilemode', [entry('0100644', 'f.txt', BASE_F)]),
  commitCase('bad-date', 'has the date notadate', 'badDate', `${PROBE_ID} notadate +0000`),
  commitCase('missing-email', 'has no <email>', 'missingEmail', 'ply probe 1700000000 +0000'),
  commitCase('bad-timezone', 'has the time zone +00x0', 'badTimezone', `${PROBE_ID} 1700000000 +00x0`),
  commitCase('date-overflow', 'has a 20-digit date', 'badDateOverflow', `${PROBE_ID} 99999999999999999999 +0000`),
  {
    id: 'pack.push-decompression-ratio#zeros-16mib',
    description: 'Both clients push main base->ratio, whose blob is 16 MiB of zero bytes (about 16 KiB deflated, about 1000:1): lands, fsck clean.',
    seed: { objects: [...CORE, RATIO], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ratio'))])), { tag: 'fetch', ref: MAIN, want: 'ratio', fault: NO_FAULT, git: SAME, timeouts: null }],
    expect: [LANDED, LANDED],
    final: [finalAt(MAIN, 'ratio')],
    ...PLAIN,
  },
];

// ---- ref and object semantics (phase 4): what git refuses about ref shapes and tag objects ----
// A tag of a tag (t2 -> t1 -> base), a tag of an object nobody holds, a tag whose type line says tree for a commit.
const rawTag = (name: string, object: string, type: string, tagName: string): RawTagSpec => ({ tag: 'raw-tag', name, object, type, tagName, message: `tag ${tagName}` });
const NO_GIT_TAG_WALK: GitForm = { tag: 'none', why: 'stock git walks a pushed tag to its object while packing (pack-objects), so it cannot send a tag of a missing or mistyped object' };
const listedPush = (updates: NonEmpty<Update>, objects: NonEmpty<string>): Push => ({ ...pushOf(updates), pack: { tag: 'listed', objects } });
const REF_SEMANTICS: readonly Scenario[] = [
  {
    id: 'refs.directory-file-conflict#file-then-dir',
    description: 'refs/heads/a exists; a create of refs/heads/a/b is refused (a ref cannot be both a name and a directory) and a is untouched.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at('refs/heads/a', 'base')] },
    steps: [step(pushOf([upd('refs/heads/a/b', ZERO, o('ff'))]))],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), finalAt('refs/heads/a', 'base'), absent('refs/heads/a/b')],
    ...PLAIN,
  },
  {
    id: 'refs.directory-file-conflict#dir-then-file',
    description: 'refs/heads/a/b exists; a create of refs/heads/a is refused and a/b is untouched.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at('refs/heads/a/b', 'base')] },
    steps: [step(pushOf([upd('refs/heads/a', ZERO, o('ff'))]))],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), finalAt('refs/heads/a/b', 'base'), absent('refs/heads/a')],
    ...PLAIN,
  },
  {
    id: 'refs.directory-file-conflict#both-in-one-push',
    description: 'One non-atomic push creating refs/heads/a and refs/heads/a/b: never both. receive-pack applies each command alone, so a lands and a/b is refused (partial).',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/heads/a', ZERO, o('ff')), upd('refs/heads/a/b', ZERO, o('diverged'))]))],
    expect: [both(one('partial', 'push_partial'))],
    final: [finalAt(MAIN, 'base'), finalAt('refs/heads/a', 'ff'), absent('refs/heads/a/b')],
    ...PLAIN,
  },
  {
    id: 'refs.symref-head#delete-default-branch',
    description: 'A delete of the default branch main (what HEAD names) while side exists: refused (receive.denyDeleteCurrent, git\'s default); main and HEAD unchanged.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'ff')] },
    steps: [step(pushOf([upd(MAIN, o('base'), ZERO)]))],
    expect: [both(REFUSED)],
    final: [finalAt(MAIN, 'base'), finalAt(SIDE, 'ff')],
    ...PLAIN,
  },
  {
    id: 'tags.peel-chain#tag-of-tag',
    description: 'refs/tags/v2 created at a tag (t2) of a tag (t1) of base: lands, both tag objects reachable, peels to base.',
    seed: { objects: [...CORE, tag('t1', 'base', 'v1'), rawTag('t2', 't1', 'tag', 'v2')], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/tags/v2', ZERO, o('t2'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/tags/v2', 't2')],
    ...PLAIN,
  },
  {
    id: 'push.ref-to-missing-object-refused#tag-of-missing-object',
    description: 'refs/tags/m created at a tag object (sent) whose object nobody holds: refused (missing necessary objects); no ref, fsck clean.',
    seed: { objects: [...CORE, { tag: 'phantom', name: 'phantom', seed: 'tag-of-missing' }, rawTag('tm', 'phantom', 'commit', 'm')], refs: [at(MAIN, 'base')] },
    steps: [{ ...step(listedPush([upd('refs/tags/m', ZERO, o('tm'))], ['tm'])), git: NO_GIT_TAG_WALK }],
    expect: [{ tag: 'one', ply: one('rejected', 'push_rejected'), git: null }],
    final: [finalAt(MAIN, 'base'), absent('refs/tags/m')],
    ...PLAIN,
  },
  {
    id: 'pack.push-malformed-object-refused#tag-type-mismatch',
    description: 'refs/tags/w created at a tag object (sent) whose type line says tree while its object, base, is a commit the server holds: refused; no ref, fsck clean.',
    seed: { objects: [...CORE, rawTag('tw', 'base', 'tree', 'w')], refs: [at(MAIN, 'base')] },
    steps: [{ ...step(listedPush([upd('refs/tags/w', ZERO, o('tw'))], ['tw'])), git: NO_GIT_TAG_WALK }],
    expect: [{ tag: 'one', ply: one('rejected', 'push_rejected'), git: null }],
    final: [finalAt(MAIN, 'base'), absent('refs/tags/w')],
    ...PLAIN,
  },
  {
    id: 'tags.move-existing-tag#non-fast-forward',
    description: 'refs/tags/v1 (lightweight, at ff) moved to diverged naming the current old id (git: a lease, which forces): accepted as any ref update.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at('refs/tags/v1', 'ff')] },
    steps: [step(pushOf([upd('refs/tags/v1', o('ff'), o('diverged'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/tags/v1', 'diverged')],
    ...PLAIN,
  },
  {
    id: 'tags.move-existing-tag#annotated-to-other-tag',
    description: 'refs/tags/v1 at annotated t1 (base) moved to annotated t3 (ff) with the current old id: accepted; t1 no longer reachable.',
    seed: { objects: [...CORE, tag('t1', 'base', 'v1'), tag('t3', 'ff', 'v1')], refs: [at(MAIN, 'base'), at('refs/tags/v1', 't1')] },
    steps: [step(pushOf([upd('refs/tags/v1', o('t1'), o('t3'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/tags/v1', 't3')],
    ...PLAIN,
  },
  {
    id: 'tags.delete#annotated',
    description: 'A delete of refs/tags/v1, an annotated tag, naming the tag object as the old id.',
    seed: { objects: [...CORE, tag('t1', 'base', 'v1')], refs: [at(MAIN, 'base'), at('refs/tags/v1', 't1')] },
    steps: [step(pushOf([upd('refs/tags/v1', o('t1'), ZERO)]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), absent('refs/tags/v1')],
    ...PLAIN,
  },
];

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
    steps: [{ tag: 'concurrent', pushes: mapNonEmpty(contenders, c => pushOf([upd(`refs/heads/p-${c.name}`, ZERO, o(c.name))])), git: SAME }],
    expect: [{ tag: 'many', ply: contenders.map(() => 'landed' as const), git: contenders.map(() => 'landed' as const) }],
    final: contenders.map(c => finalAt(`refs/heads/p-${c.name}`, c.name)),
    ...PLAIN,
  },
  {
    id: 'concurrency.empty-report-under-contention#same-ref',
    description: `${CONTENDERS} pushes at once moving main from base to ${CONTENDERS} different commits: exactly one lands, the rest are refused as conflicts.`,
    seed: { objects: [...CORE, ...contenders], refs: [at(MAIN, 'base')] },
    steps: [{ tag: 'concurrent', pushes: mapNonEmpty(contenders, c => pushOf([upd(MAIN, o('base'), o(c.name))])), git: SAME }],
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
    steps: [step(pushOf(mapNonEmpty([0, ...Array.from({ length: MANY - 1 }, (_, i) => i + 1)], i => upd(`refs/heads/many/${String(i).padStart(2, '0')}`, ZERO, o('ff')))))],
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
      { tag: 'concurrent', pushes: mapNonEmpty(contenders, c => pushOf([upd(`refs/heads/p-${c.name}`, ZERO, o(c.name))])), git: SAME },
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
  corrupt('bad-trailer'),
  corrupt('bad-zlib'),
  corrupt('truncated'),
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
    // stock git's timer here is http.lowSpeedTime, which a silent connection trips on some git/libcurl builds (2.47.3 with
    // curl 8.14) and not on others (CI's 2.56.1 waits and lands), so only ply's answer is stated; both still run
    description: 'The server applies base->ff and its answer is held 4 s against a 1 s client timer: ply says ambiguous (typed); main is at ff.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [{ ...step(pushOf([upd(MAIN, o('base'), o('ff'))]), { tag: 'stall-response', ms: 4000 }), timeouts: { ms: 1000 } }],
    expect: [{ tag: 'one', ply: one('ambiguous', 'ambiguous'), git: null }],
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
    // as push-response-stall: stock git's lowSpeedTime on a silent connection depends on the build, so only ply's is stated
    description: 'A fetch of main whose answer is held 4 s against a 1 s client timer: ply fails with a typed timeout, nothing is half-written.',
    seed: { objects: [...CORE, MID], refs: [at(MAIN, 'mid')] },
    steps: [fetchStep('mid', { tag: 'stall-response', ms: 4000 }, { ms: 1000 })],
    expect: [{ tag: 'one', ply: one('rejected', 'timeout'), git: null }],
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
  ...MALFORMED,
  ...REF_SEMANTICS,
];
