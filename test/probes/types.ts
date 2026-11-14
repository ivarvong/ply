// Differential probes: one scenario, run by ply and by stock git against git http-backend (the reference, configured to
// the server-under-test's known policy) and against the server under test, judged by stock git and compared on meaning
// (refs, HEAD, reachable objects, trees, ancestry, fsck, outcome class, error class), never on wire bytes.
//
// A scenario is a pure plan: a seed repository made of deterministic objects (fixed identities and dates, so every
// target holds the same object ids), steps (pushes, concurrent pushes) with an optional fault (hold the receive-pack
// request while another writer moves refs, or let the server answer and cut the answer), and the outcome git
// http-backend is expected to give. test/probes/runner.mjs executes plans; test/probes/evaluate.ts compares results.
import type { Area, BehaviourId, NonEmpty } from '../behaviours/types.js';

export type { NonEmpty };

// A scenario is keyed by the behaviour it probes: `<behaviour id>#<variant>`. probes.test.js checks the behaviour is in
// the matrix, so a probe cannot cite a behaviour that does not exist.
export type ScenarioId = `${BehaviourId<Area>}#${string}`;

// ---- seed: objects made locally by git plumbing (hash-object, mktree via an index, commit-tree, mktag) ----
// Content is text or deterministic incompressible bytes (a SHA-256 counter stream from `seed`), so a size probe needs
// no fixture file and every target receives identical blobs.
export type Content = { readonly tag: 'text'; readonly text: string } | { readonly tag: 'noise'; readonly seed: string; readonly bytes: number };
export type FileSpec = { readonly path: string; readonly content: Content };
// A commit's tree is its first parent's tree with `files` written over it (a root commit starts empty).
export type CommitSpec = { readonly tag: 'commit'; readonly name: string; readonly parents: readonly string[]; readonly files: readonly FileSpec[]; readonly message: string };
export type TagSpec = { readonly tag: 'annotated-tag'; readonly name: string; readonly target: string; readonly tagName: string; readonly message: string };
export type ObjectSpec = CommitSpec | TagSpec;
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
export type Fault =
  | { readonly tag: 'none' }
  | { readonly tag: 'race'; readonly moves: NonEmpty<Move> }
  | { readonly tag: 'cut-response' };

// How stock git renders a push, or why it cannot: some scenarios have no native-git form (git checks a lease client
// side, so a plain stale old id never reaches the server from git).
export type GitForm = { readonly tag: 'same' } | { readonly tag: 'none'; readonly why: string };

export type Push = { readonly updates: NonEmpty<Update>; readonly atomic: boolean };
export type Step =
  | { readonly tag: 'push'; readonly push: Push; readonly fault: Fault; readonly git: GitForm }
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

// The error class: ply's PlyError code, or stock git's refusal mapped onto the same names (evaluate.ts gitErrorClass),
// so wording differences between servers are normalized before comparison. null when the step landed.
export type ErrorClass = string | null;

export type StepExpect = { readonly outcome: Outcome; readonly error: ErrorClass };
// A concurrent step is expected as a multiset of outcomes (sorted).
export type Expectation =
  | { readonly tag: 'one'; readonly ply: StepExpect; readonly git: StepExpect | null }
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
  // per step, in order (a tuple the length of steps is checked at run time by probes.test.js)
  readonly expect: NonEmpty<Expectation>;
  readonly final: readonly FinalRef[];
  readonly compare: Compare;
  // the reference repository's receive-pack settings beyond the Artifacts policy (none by default)
  readonly referenceConfig: readonly (readonly [string, string])[];
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

// ---- observations (what a run records; the runner fills them, evaluate.ts compares them) ----
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
export const PAIRS = ['art-ply~ref-ply', 'art-git~ref-git', 'ref-ply~ref-git', 'art-ply~art-git', 'ref-ply~expect', 'ref-git~expect', 'ref-ply~claims', 'ref-git~claims', 'art-ply~claims', 'art-git~claims'] as const;
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
