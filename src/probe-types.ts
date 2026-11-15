// Differential probes (t229u): one scenario, run by ply and by stock git against git http-backend (the reference,
// configured to the server-under-test's known policy) and against the server under test, judged by stock git and
// compared on meaning (refs, HEAD, reachable objects, trees, ancestry, fsck, outcome class, error class), never on wire
// bytes. Exported as `ply/probes` so a probe runner outside this repository (ply-web's workbench) runs the same plans
// and classifies its answers with the same types.
//
// A scenario is a pure plan: a seed repository made of deterministic objects (fixed identities and dates, so every
// target holds the same object ids), steps (pushes, fetches, concurrent pushes) with an optional fault, and the outcome
// git http-backend is expected to give. test/probes/runner.mjs executes plans in this repository; probe-evaluate.ts
// compares results.

export type NonEmpty<T> = readonly [T, ...T[]];

// The areas of server behaviour, in the order COVERAGE.md lists them (test/behaviours/types.ts titles them).
export const AREAS = ['refs', 'caps', 'fetch', 'pack', 'push', 'concurrency', 'tags', 'ancestry', 'errors', 'interrupted', 'http'] as const;
export type Area = (typeof AREAS)[number];
// A behaviour id is `<area>.<slug>`: the area is part of the id, so an id filed under the wrong area does not type.
export type BehaviourId<A extends Area> = `${A}.${string}`;

// A scenario is keyed by the behaviour it probes: `<behaviour id>#<variant>`. probes.test.js checks the behaviour is in
// the matrix, so a probe cannot cite a behaviour that does not exist.
export type ScenarioId = `${BehaviourId<Area>}#${string}`;

// ---- seed: objects made locally by git plumbing (hash-object, mktree via an index, commit-tree, mktag) ----
// Content is text or deterministic incompressible bytes (a SHA-256 counter stream from `seed`), so a size probe needs
// no fixture file and every target receives identical blobs.
// `repeat` is `bytes` copies of one byte: a blob that deflates about a thousandfold, for a decompression-ratio probe.
export type Content =
  | { readonly tag: 'text'; readonly text: string }
  | { readonly tag: 'noise'; readonly seed: string; readonly bytes: number }
  | { readonly tag: 'repeat'; readonly byte: number; readonly bytes: number };
export type FileSpec = { readonly path: string; readonly content: Content };
// A commit's tree is its first parent's tree with `files` written over it (a root commit starts empty).
export type CommitSpec = { readonly tag: 'commit'; readonly name: string; readonly parents: readonly string[]; readonly files: readonly FileSpec[]; readonly message: string };
export type TagSpec = { readonly tag: 'annotated-tag'; readonly name: string; readonly target: string; readonly tagName: string; readonly message: string };
// A tree written byte for byte (`git hash-object --literally -t tree`): its entries in the order given, each a mode and
// a name as written and the blob it names, so a tree git itself never writes (unsorted, a name twice, a `/` in a name,
// `.git`, a zero-padded mode) can be seeded and pushed by either client.
export type RawTreeEntry = { readonly mode: string; readonly name: string; readonly blob: ObjRef };
export type RawTreeSpec = { readonly tag: 'raw-tree'; readonly name: string; readonly entries: NonEmpty<RawTreeEntry> };
// A commit written byte for byte: `tree` names a raw tree or a commit (whose tree it takes), `author` is the author
// line after `author ` verbatim (a missing email, a date that is not a number), the committer is the probe identity.
export type RawCommitSpec = { readonly tag: 'raw-commit'; readonly name: string; readonly tree: string; readonly parents: readonly string[]; readonly author: string; readonly message: string };
// An object id that no target and no client holds (the SHA-1 of `seed`), named so a command can point a ref at it.
export type PhantomSpec = { readonly tag: 'phantom'; readonly name: string; readonly seed: string };
// A tag object written byte for byte (`git hash-object --literally -t tag`): `object` names any seed object (a phantom
// for a tag of an object nobody holds, another tag for a tag of a tag), `type` is the type line as written, which need
// not be the named object's type; the tagger is the probe identity.
export type RawTagSpec = { readonly tag: 'raw-tag'; readonly name: string; readonly object: string; readonly type: string; readonly tagName: string; readonly message: string };
export type ObjectSpec = CommitSpec | TagSpec | RawTreeSpec | RawCommitSpec | PhantomSpec | RawTagSpec;
// What the target holds before the first step: refs pointing at named objects. Objects no ref names stay local, for a
// step to push.
export type RefAt = { readonly ref: string; readonly at: string };
export type Seed = { readonly objects: readonly ObjectSpec[]; readonly refs: readonly RefAt[] };

// ---- steps ----
// An object id in a plan: the zero id (create / delete) or a named seed object.
export type OidExpr = { readonly tag: 'zero' } | { readonly tag: 'obj'; readonly name: string };
// One ref update as ply sends it (old id, new id, ref). Stock git sends the same command from
// `--force-with-lease=<ref>:<old> +<new>:<ref>` (`:<ref>` for a delete; a create is a plain `<new>:<ref>`, because git
// does not hold a create to an empty or zero lease): git checks the lease against its own advertisement and sends that
// advertised id as the old id, so on the wire both clients send the plan's old id unless a fault moves the ref after
// git has read it, which is what a race fault is for.
export type Update = { readonly ref: string; readonly old: OidExpr; readonly new: OidExpr };
// Another writer's move, applied through a separate channel while the step's receive-pack request is held.
export type Move = { readonly ref: string; readonly to: OidExpr };

// none          the request is forwarded untouched
// race          the step's first receive-pack POST is held; the moves are pushed (forced) by another writer; then the
//               held request is forwarded: the server sees an old id that was current when the client read it
// cut-response  the step's first receive-pack POST is forwarded and the server's whole answer read, then the client's
//               connection is destroyed before a byte of it: the server applied (or refused) a push the client never
//               hears about
// cut-request    the step's request is forwarded only up to `fraction` of its body, then the upstream request is
//                aborted and the client's connection destroyed: the server reads a body that stops halfway
// stall-request  the body is forwarded up to `fraction`, then nothing for `ms`, then the rest: the server's idle limit
// stall-response the server's whole answer is held `ms` before the client gets a byte: the client's own timer
// drop-response  the client gets the status, headers and `fraction` of the body, then the connection is destroyed
// For a push step the fault is on the first receive-pack POST of `main`; for a fetch step, the first upload-pack POST
// of `main` that carries command=fetch.
export type Fault =
  | { readonly tag: 'none' }
  | { readonly tag: 'race'; readonly moves: NonEmpty<Move> }
  | { readonly tag: 'cut-response' }
  | { readonly tag: 'cut-request'; readonly fraction: number }
  | { readonly tag: 'stall-request'; readonly fraction: number; readonly ms: number }
  | { readonly tag: 'stall-response'; readonly ms: number }
  | { readonly tag: 'drop-response'; readonly fraction: number };
// The client's own timers for a step: ply's firstByteTimeoutMs and idleTimeoutMs limits; stock git's
// http.lowSpeedLimit=1 with http.lowSpeedTime the same span rounded up to a second. null: each client's defaults.
export type Timeouts = { readonly ms: number } | null;

// How stock git renders a push, or why it cannot: some scenarios have no native-git form (git checks a lease client
// side, so a plain stale old id never reaches the server from git).
export type GitForm = { readonly tag: 'same' } | { readonly tag: 'none'; readonly why: string };

// An object of the seed, by name: a commit, or the blob at a path of a commit's tree.
export type ObjRef = { readonly tag: 'commit'; readonly name: string } | { readonly tag: 'blob'; readonly of: string; readonly path: string };
// How a pack is damaged after it is built (the trailer is recomputed except for bad-trailer and truncated):
//   bad-trailer  the trailing SHA-1 is wrong      bad-zlib  an object's zlib stream fails its Adler-32 check
//   truncated    the pack ends halfway through    none      intact
export const DAMAGE = ['none', 'bad-trailer', 'bad-zlib', 'truncated'] as const;
export type Damage = (typeof DAMAGE)[number];
// objects  ply's own push: ply builds the pack from the objects (the pushed objects not reachable from the seed's refs,
//          minus `omit`)
// hand     the same objects as a pack the harness writes and ply sends as is (pushPack): the first blob sent as a
//          REF_DELTA against `deltaBase` when it is set (a valid literal-only delta, or one whose copy reads past the end
//          of its base), then damaged. Stock git cannot send such a pack, so a step carrying one has no native-git form.
// defect   the same objects as a pack the harness writes with one structural defect (PackDefect), trailer recomputed:
//          a pack git's own index-pack must refuse whole, or, for `duplicate`, a pack with every entry twice
// listed   exactly the named seed objects, as ply's own push builds a pack of them: for an object no reachability walk
//          can start from (a tag of an object nobody holds, a tag whose type line disagrees with its object)
export type PackForm =
  | { readonly tag: 'objects' }
  | { readonly tag: 'listed'; readonly objects: NonEmpty<string> }
  | { readonly tag: 'hand'; readonly deltaBase: ObjRef | null; readonly delta: 'literal' | 'copy-past-end'; readonly damage: Damage }
  | { readonly tag: 'defect'; readonly defect: PackDefect };
// One defect of a pack's structure (the trailer is recomputed over the damaged bytes, so only the defect is wrong):
//   signature            the first four bytes are `PACX`
//   version              the header's version is `version` (git reads 2 and 3)
//   count                the header's object count is the real count plus `by` (more objects named than sent, or fewer)
//   size-header          the first object's header states its size plus `by`, so its zlib stream inflates to a
//                        different length than stated
//   bad-type             the first object's header carries type `type` (0 and 5 are not object types)
//   ofs-delta-before-start the first blob as an OFS_DELTA whose base offset reaches before the pack's first byte
//   delta-size-mismatch  the first blob as a REF_DELTA against `base` (which the server holds) whose header states a
//                        result one byte longer than its instructions write
//   duplicate            every object twice (count doubled)
//   no-objects           a well-formed pack with no object at all, for a command whose new id the pack does not carry
export type PackDefect =
  | { readonly tag: 'signature' }
  | { readonly tag: 'version'; readonly version: number }
  | { readonly tag: 'count'; readonly by: number }
  | { readonly tag: 'size-header'; readonly by: number }
  | { readonly tag: 'bad-type'; readonly type: number }
  | { readonly tag: 'ofs-delta-before-start' }
  | { readonly tag: 'delta-size-mismatch'; readonly base: ObjRef }
  | { readonly tag: 'duplicate' }
  | { readonly tag: 'no-objects' };
export type Push = { readonly updates: NonEmpty<Update>; readonly atomic: boolean; readonly omit: readonly ObjRef[]; readonly pack: PackForm };
// Where the pushing client's repository came from:
//   full     the client holds every seed object (ply: the plan's objects; git: the seed store)
//   shallow  git pushes from `git fetch --depth <depth>` of `tip` out of the seed store (ply, which has no shallow
//            state, sends the objects the plan names, minus `omit`)
//   partial  each client first fetches the target's main with filter blob:none (ply: fetchPack, checked to carry no
//            blob; git: clone --filter=blob:none), then the new objects are added locally and pushed
export type From = { readonly tag: 'full' } | { readonly tag: 'shallow'; readonly tip: string; readonly depth: number } | { readonly tag: 'partial' };
export type Step =
  // `ply`: whether ply has a form of this push (ply keeps no shallow state, so it cannot send git's shallow lines)
  | { readonly tag: 'push'; readonly push: Push; readonly fault: Fault; readonly git: GitForm; readonly ply: GitForm; readonly from: From; readonly timeouts: Timeouts }
  // fetch `want` (a seed object `ref` points at): ply fetchPack of it, stock git `git fetch <url> <ref>` into an empty
  // repository; landed means the wanted object arrived
  | { readonly tag: 'fetch'; readonly ref: string; readonly want: string; readonly fault: Fault; readonly git: GitForm; readonly timeouts: Timeouts }
  // every push starts at once (Promise.all for ply; concurrent processes for git); each on its own connection
  | { readonly tag: 'concurrent'; readonly pushes: NonEmpty<Push>; readonly git: GitForm }
  // once step `of` (a concurrent step) is over, every push of it that did not land is sent again, one at a time, with
  // the same commands; a push that landed the first time is carried as landed. A retry that lands shows the first
  // attempt was not applied (a create or a compare-and-swap would be refused if it had been).
  | { readonly tag: 'retry-unlanded'; readonly of: number; readonly git: GitForm };

// ---- outcomes, classified the same way for both clients ----
// landed     every command applied
// partial    some applied, some refused (non-atomic)
// conflict   refused because a ref was not what the command said (compare-and-swap, lock, atomic sibling)
// rejected   refused for another reason (policy, size, a pack the server will not take)
// ambiguous  the client cannot tell what the server did (no answer, an empty or cut answer)
export const OUTCOMES = ['landed', 'partial', 'conflict', 'rejected', 'ambiguous'] as const;
export type Outcome = (typeof OUTCOMES)[number];

// The error class: ply's PlyError code, or stock git's refusal mapped onto the same names (test/probes/git-outcome.ts),
// so wording differences between servers are normalized before comparison. null when the step landed.
export type ErrorClass = string | null;

export type StepExpect = { readonly outcome: Outcome; readonly error: ErrorClass };
// A concurrent step is expected as a multiset of outcomes (sorted). `either`: one step whose answer git words
// differently across versions, so the class a client reads from it differs too (git 2.47 reports a directory/file
// refusal as `failed to update ref`, a cas reason, and git >= 2.51 as `refname conflict`, a refusal); any listed
// answer meets it, and `why` names the versions.
export type Expectation =
  | { readonly tag: 'one'; readonly ply: StepExpect; readonly git: StepExpect | null }
  | { readonly tag: 'either'; readonly ply: NonEmpty<StepExpect>; readonly git: NonEmpty<StepExpect> | null; readonly why: string }
  | { readonly tag: 'many'; readonly ply: readonly Outcome[]; readonly git: readonly Outcome[] | null };

// The final value of a ref, as git http-backend is expected to hold it.
export type FinalRef =
  | { readonly tag: 'at'; readonly ref: string; readonly at: string }
  | { readonly tag: 'absent'; readonly ref: string }
  // a race with no fixed winner: the ref holds one of these objects (ABSENT: or the winner deleted it)
  | { readonly tag: 'one-of'; readonly ref: string; readonly names: NonEmpty<string> };
export const ABSENT = '(absent)';

// exact        every target's end state must be identical (refs, objects, trees, ancestry, merge bases, fsck)
// winner-of    a concurrent step has no fixed winner: refs and fsck are compared with the winner replaced by its name;
//              objects, trees and ancestry follow the winner, so they are not compared (the reason is the scenario's)
export type Compare = { readonly tag: 'exact' } | { readonly tag: 'winner-of'; readonly why: string };

export type Scenario = {
  readonly id: ScenarioId;
  readonly description: string;
  readonly seed: Seed;
  // the first ref the target is created with is its default branch; `main` everywhere
  readonly steps: NonEmpty<Step>;
  // per step, in order (a tuple the length of steps; test/probes/probes.test.js checks it)
  readonly expect: NonEmpty<Expectation>;
  readonly final: readonly FinalRef[];
  readonly compare: Compare;
  // the reference repository's receive-pack settings beyond the Artifacts policy (none by default)
  readonly referenceConfig: ReadonlyArray<readonly [string, string]>;
};

// ---- targets ----
// The four runs of a scenario. Each is a fresh repository.
//   ref-ply  ply against the reference          (CI)
//   ref-git  stock git against the reference    (CI: the baseline that makes art-git readable)
//   art-ply  ply against the server under test  (opt-in, private)
//   art-git  stock git against the server under test (opt-in, private)
export const TARGETS = ['ref-ply', 'ref-git', 'art-ply', 'art-git'] as const;
export type Target = (typeof TARGETS)[number];
export type Client = 'ply' | 'git';
export const clientOf = (t: Target): Client => (t.endsWith('-ply') ? 'ply' : 'git');

// ---- observations (what a run records; the runner fills them, probe-evaluate.ts compares them) ----
export type StepObservation = { readonly outcomes: NonEmpty<{ readonly outcome: Outcome; readonly error: ErrorClass; readonly detail: string }> };
export type EndState = {
  readonly head: string | null; // HEAD's symref target, or null when the server names none
  readonly refs: Readonly<Record<string, string>>; // refname -> oid (peeled tags not included)
  readonly objects: readonly string[]; // every object reachable from a ref, sorted
  readonly trees: Readonly<Record<string, string>>; // refname -> the tree of what it peels to
  readonly ancestry: readonly string[]; // `git rev-list --parents --all`, sorted
  readonly mergeBases: Readonly<Record<string, string>>; // "a..b" for each pair of branch tips -> merge-base --all
  readonly fsck: readonly string[]; // fsck --strict problems of a mirror clone; [] is clean
};
export type Observation = { readonly steps: readonly StepObservation[]; readonly end: EndState };

// The fields compared, and which two runs a difference is between.
export const FIELDS = ['outcome', 'error', 'head', 'refs', 'objects', 'trees', 'ancestry', 'merge-bases', 'fsck', 'expectation', 'claims'] as const;
export type Field = (typeof FIELDS)[number];
// same-client pairs compare outcomes and end states; the cross-client pair on the reference compares end states only
// (ply and git may phrase one refusal differently, but must leave the same repository); `expect` is a run against the
// scenario's stated reference outcome. `~claims` is a run against itself: every push of the last step a client called
// landed must show in the refs the judge read (a client that says landed when nothing landed is the worst answer).
// `art-ply~expect` is ply's run against the server alone, read against the stated expectation (probe-evaluate.ts
// soloDiffs): the one corner a runner without stock git or the reference (a Worker) can record.
export const PAIRS = ['art-ply~ref-ply', 'art-git~ref-git', 'ref-ply~ref-git', 'art-ply~art-git', 'ref-ply~expect', 'ref-git~expect', 'art-ply~expect', 'ref-ply~claims', 'ref-git~claims', 'art-ply~claims', 'art-git~claims'] as const;
export type Pair = (typeof PAIRS)[number];

export type Difference = { readonly scenario: ScenarioId; readonly pair: Pair; readonly field: Field; readonly left: string; readonly right: string };

// An expected difference: exactly which values on which pair, and why. Anything unlisted is a finding; an entry no
// difference used fails the run (a stale entry hides nothing and must go).
export type Allow = { readonly scenario: ScenarioId; readonly pair: Pair; readonly field: Field; readonly left: string; readonly right: string; readonly reason: string };

// client-bug             ply is wrong against git http-backend (ref-ply misses the expectation git meets)
// server-bug             ply is right against the reference, differs against the server, and stock git reproduces it
// unresolved             the triangle does not close (no native-git form, or native git does not reproduce it, or the
//                        expectation itself is wrong)
// (expected incompatibilities are the allow-list's entries, reported as such, not as findings)
export type FindingClass = 'client-bug' | 'server-bug' | 'unresolved';
export type Finding = Difference & { readonly class: FindingClass; readonly why: string };
