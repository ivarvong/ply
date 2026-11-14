// The Git behaviour coverage matrix: every server behaviour ply can exercise (or cannot yet), the ply operations and
// tests that exercise it, and who has independently checked the server's answer. ply is a conformance and behaviour
// testing instrument for Cloudflare Artifacts as well as a client; the unit of progress is an independently validated
// server behaviour or failure mode, not a git command.
//
// Rules (test/behaviours/matrix.test.js enforces each):
//   - every op is an export of its src/ module and every test anchor is text in the cited file (grep, not memory);
//   - ply_vs_reference_git evidence cites a file that runs real git;
//   - run evidence cites a run in runs.ts and a check that run recorded (the types refuse anything else);
//   - COVERAGE.md is `npm run coverage-matrix -- --md` of this file.
// Status rule: `verified` needs at least one independent check of any kind. Evidence against git http-backend shows
// ply's probe is right against the reference; only Artifacts evidence says anything about Artifacts. COVERAGE.md
// reports both counts so a behaviour verified against git alone shows as an Artifacts gap.
import type { Area, Behaviour, BehaviourIn, Evidence, NonEmpty, OtherEvidence, PlyOp, Status, TestRef } from './types.js';
import type { CheckOf } from './runs.js';

const op = (module: PlyOp['module'], symbol: string): PlyOp => ({ module, symbol });
const t = (path: TestRef['path'], anchor: string): TestRef => ({ tag: 'test', path, anchor });

// Evidence, one constructor per source. The check argument is typed by the run: a check the run did not record does
// not compile.
const git = (path: TestRef['path'], anchor: string): Evidence => ({ kind: 'ply_vs_reference_git', ref: t(path, anchor) });
const validatePly = (check: CheckOf<'validate-7b0c310f'>): Evidence => ({ kind: 'ply_vs_artifacts', ref: { tag: 'run', run: 'validate-7b0c310f', check } });
const validateGit = (check: CheckOf<'validate-7b0c310f'>): Evidence => ({ kind: 'native_git_vs_artifacts', ref: { tag: 'run', run: 'validate-7b0c310f', check } });
const plyWorker = (check: CheckOf<'loadgen-phase6-plyw-20261025'>): Evidence => ({ kind: 'ply_vs_artifacts', ref: { tag: 'run', run: 'loadgen-phase6-plyw-20261025', check } });
const compat = (check: CheckOf<'loadgen-compat-20261024'>): OtherEvidence => ({ kind: 'native_git_vs_artifacts', ref: { tag: 'run', run: 'loadgen-compat-20261024', check } });
const phase2Git = (check: CheckOf<'loadgen-phase2-20261025'>): OtherEvidence => ({ kind: 'native_git_vs_artifacts', ref: { tag: 'run', run: 'loadgen-phase2-20261025', check } });
const phase2Wire = (check: CheckOf<'loadgen-phase2-20261025'>): OtherEvidence => ({ kind: 'wire_probe_vs_artifacts', ref: { tag: 'run', run: 'loadgen-phase2-20261025', check } });
const phase3Git = (check: CheckOf<'loadgen-phase3-20261025'>): OtherEvidence => ({ kind: 'native_git_vs_artifacts', ref: { tag: 'run', run: 'loadgen-phase3-20261025', check } });
const hostile = (check: CheckOf<'loadgen-phase4-hostile-20261025'>): OtherEvidence => ({ kind: 'wire_probe_vs_artifacts', ref: { tag: 'run', run: 'loadgen-phase4-hostile-20261025', check } });
const hostileWrite = (check: CheckOf<'loadgen-phase4-hostile-write-20261025'>): OtherEvidence => ({ kind: 'wire_probe_vs_artifacts', ref: { tag: 'run', run: 'loadgen-phase4-hostile-write-20261025', check } });
const deltaGit = (check: CheckOf<'loadgen-phase5-delta-20261025'>): OtherEvidence => ({ kind: 'native_git_vs_artifacts', ref: { tag: 'run', run: 'loadgen-phase5-delta-20261025', check } });
const deltaWire = (check: CheckOf<'loadgen-phase5-delta-20261025'>): OtherEvidence => ({ kind: 'wire_probe_vs_artifacts', ref: { tag: 'run', run: 'loadgen-phase5-delta-20261025', check } });

const verified = (...evidence: NonEmpty<Evidence>): Extract<Status, { readonly tag: 'verified' }> => ({ tag: 'verified', evidence });
const IMPLEMENTED: Extract<Status, { readonly tag: 'implemented' }> = { tag: 'implemented' };
const unsupported = (why: string, ...observed: readonly OtherEvidence[]): Extract<Status, { readonly tag: 'unsupported' }> => ({ tag: 'unsupported', why, observed });
// Each entry is checked against its own area's type (the id's prefix must be the area).
const b = <A extends Area>(x: BehaviourIn<A>): BehaviourIn<A> => x;

// ply's operations, named once.
const LS_REFS = op('src/lsrefs.ts', 'lsRefs');
const LIST_REFS = op('src/refops.ts', 'listRefs');
const DISCOVER = op('src/discover.ts', 'discover');
const PARSE_CAPS = op('src/caps.ts', 'parseCapabilitiesV2');
const REQUIRED_V2 = op('src/closed.ts', 'checkRequiredV2');
const OBJECT_FORMAT = op('src/closed.ts', 'decideObjectFormat');
const RECEIVE_CAPS = op('src/receivecaps.ts', 'receiveCaps');
const CHECK_PUSH_CAPS = op('src/receivecaps.ts', 'checkPushCaps');
const FETCH_PACK = op('src/fetchpack.ts', 'fetchPack');
const FETCH_FILTERED = op('src/fetchpack.ts', 'fetchPackFiltered');
const FETCH_OBJECT = op('src/fetch.ts', 'fetchObject');
const FETCH_REQUEST = op('src/fetch.ts', 'fetchRequest');
const NEGOTIATE = op('src/negotiate.ts', 'negotiate');
const SIDEBAND = op('src/fetch.ts', 'parseSideband');
const LEARN_FILTER = op('src/transport.ts', 'learnFilter');
const PARSE_PACK = op('src/packresolve.ts', 'parsePack');
const RESOLVE_PACK = op('src/packresolve.ts', 'resolvePack');
const RESOLVE_RANGE = op('src/packrangeresolve.ts', 'resolvePackRange');
const SCAN_PACK = op('src/pullstream.ts', 'scanPack');
const PUSH = op('src/push.ts', 'push');
const PUSH_PACK = op('src/receivecaps.ts', 'pushPack');
const CLASSIFY_REPORT = op('src/push.ts', 'classifyReport');
const EDIT_FILE = op('src/edit.ts', 'editFile');
const COMMIT_CHANGES = op('src/changes.ts', 'commitChanges');
const PUSH_TREE = op('src/tree.ts', 'pushTree');
const CREATE_BRANCH = op('src/refops.ts', 'createBranch');
const DELETE_BRANCH = op('src/refops.ts', 'deleteBranch');
const CREATE_TAG = op('src/refops.ts', 'createTag');
const DELETE_TAG = op('src/refops.ts', 'deleteTag');
const READ_FILE = op('src/read.ts', 'readFile');
const LIST_TREE = op('src/read.ts', 'listTree');
const READ_COMMIT = op('src/read.ts', 'readCommit');
const READ_LOG = op('src/log.ts', 'readLog');
const MERGE_BASE = op('src/merge.ts', 'mergeBase');
const MERGE_BRANCH = op('src/merge.ts', 'mergeBranch');
const REBASE_BRANCH = op('src/rebase.ts', 'rebaseBranch');
const CHERRY_PICK = op('src/rebase.ts', 'cherryPick');
const REVERT_COMMIT = op('src/rebase.ts', 'revertCommit');
const RUN_TRANSFER = op('src/transfer.ts', 'runTransfer');
const CREATE_TRANSPORT = op('src/http.ts', 'createTransport');
const REDIRECT_POLICY = op('src/http.ts', 'redirectPolicy');
const EXCHANGE_CLOCK = op('src/deadline.ts', 'exchangeClock');

const PARITY_LSREFS = 'ls-refs == git ls-remote (prefixes, symrefs, peeled tags, many refs)';
const MATRIX = 'exhaustive fetch matrix: wants × haves × deepen × filter × server';
const CLONE_SHAPES = 'clone --depth N / --filter / --shallow-since / --shallow-exclude: same invocation, same shallow set, same objects';
const ADV_PUSH = 'push: request × advertised atomic × advertised push-options × object-format, judged by git push';
const ADV_REAL = 'real git http-backend configurations advertise exactly what the renderer writes for their cell';

const REFS: readonly BehaviourIn<'refs'>[] = [
  b({
    id: 'refs.ls-refs-listing', area: 'refs',
    description: 'v2 ls-refs lists every ref with its object id.',
    ops: [LS_REFS, LIST_REFS],
    tests: [t('test/parity.test.js', PARITY_LSREFS), t('test/e2e-customer.test.js', 'listRefs is for-each-ref, before the deletes')],
    status: verified(git('test/parity.test.js', PARITY_LSREFS), validatePly('refs list (peeled tags)'), plyWorker('refs/small'), compat('ls_remote/small/v2'), validateGit('git judge: fsck --strict, refs, history')),
    notes: [],
  }),
  b({
    id: 'refs.ref-prefix', area: 'refs',
    description: 'ls-refs `ref-prefix` arguments restrict the listing to refs under the given prefixes.',
    ops: [LS_REFS, LIST_REFS],
    tests: [t('test/parity.test.js', "['refs/heads/main', 'refs/tags/v1'], ['HEAD']")],
    status: verified(git('test/parity.test.js', "['refs/heads/main', 'refs/tags/v1'], ['HEAD']"), plyWorker('refs/prefix'), plyWorker('refs/prefix_tags'), compat('ls_remote_ref_prefix/small/v2')),
    notes: [],
  }),
  b({
    id: 'refs.symref-head', area: 'refs',
    description: 'ls-refs `symrefs` reports the target of HEAD, and the target is the default branch.',
    ops: [LS_REFS],
    tests: [t('test/parity.test.js', PARITY_LSREFS)],
    status: verified(git('test/parity.test.js', PARITY_LSREFS), plyWorker('refs/n4_head'), plyWorker('refs/n4')),
    notes: ['The Artifacts checks read a repository stock git pushed; no probe checks HEAD after a multi-branch push from ply itself.'],
  }),
  b({
    id: 'refs.peeled-tags', area: 'refs',
    description: 'ls-refs `peel` attaches the peeled id to annotated tags, and only to them.',
    ops: [LS_REFS, LIST_REFS],
    tests: [t('test/parity.test.js', PARITY_LSREFS)],
    status: verified(git('test/parity.test.js', PARITY_LSREFS), validatePly('refs list (peeled tags)'), compat('ls_remote_tags/small/v2')),
    notes: [],
  }),
  b({
    id: 'refs.unborn-empty-repo', area: 'refs',
    description: 'An empty repository lists no refs, and ls-refs `unborn` names the branch HEAD will be born on.',
    ops: [LS_REFS],
    tests: [t('test/lsrefs-unborn.test.js', 'lsRefs unborn: the argument, the answer and the ref listing agree with git, across every cell'), t('test/lsrefs-unborn.test.js', 'lsRefs unborn: an empty repository clones to the branch ply reports (git clone is the oracle)')],
    status: verified(git('test/lsrefs-unborn.test.js', 'lsRefs unborn: the argument, the answer and the ref listing agree with git, across every cell'), validatePly('refs (empty)'), plyWorker('refs/empty')),
    notes: [],
  }),
  b({
    id: 'refs.advertisement-shapes', area: 'refs',
    description: 'Unusual but legal listings (duplicate names, ordering, raw bytes in names) are read as git reads them.',
    ops: [LS_REFS],
    tests: [t('test/space/advertisement.test.js', 'refs: every cell, judged by git ls-remote; a duplicate ref resolves to its first listing in git fetch'), t('test/git-bytes.test.js', 'byte content × object field × operation')],
    status: verified(git('test/space/advertisement.test.js', 'refs: every cell, judged by git ls-remote; a duplicate ref resolves to its first listing in git fetch')),
    notes: ['No Artifacts evidence: ply has never asked Artifacts to list a ref with non-UTF-8 or unusual bytes.'],
  }),
  b({
    id: 'refs.v0-upload-pack-advertisement', area: 'refs',
    description: 'The v0/v1 upload-pack advertisement (refs and capabilities on the info/refs GET, no Git-Protocol header).',
    ops: [],
    tests: [],
    status: unsupported('ply asks for protocol v2 on upload-pack and refuses a server that answers otherwise (src/caps.ts).', compat('ls_remote/small/v0'), compat('clone_full/small/v0'), compat('depth_1/small/v0')),
    notes: ['Only stock git has probed v0/v1 on Artifacts.'],
  }),
  b({
    id: 'refs.receive-pack-advertisement', area: 'refs',
    description: 'The receive-pack advertisement (v0 form: capabilities on the first ref, `capabilities^{}` for an empty repository).',
    ops: [RECEIVE_CAPS, PUSH],
    tests: [t('test/space/advertisement.test.js', ADV_PUSH), t('test/push.test.js', 'push matrix: configs × hooks × commands × caps, parity with git push')],
    status: verified(git('test/space/advertisement.test.js', ADV_PUSH), validatePly('write: root commit (edit changes)'), phase2Wire('receive_caps/artifacts')),
    notes: [],
  }),
];

const CAPS: readonly BehaviourIn<'caps'>[] = [
  b({
    id: 'caps.v2-capability-advertisement', area: 'caps',
    description: 'The v2 capability advertisement: version 2, agent, ls-refs and fetch features, object-format, server-option, session-id.',
    ops: [DISCOVER, PARSE_CAPS],
    tests: [t('test/space/advertisement.test.js', 'caps: every cell through discover() (derived from the table)'), t('test/space/advertisement.test.js', ADV_REAL)],
    status: verified(git('test/space/advertisement.test.js', ADV_REAL), validatePly('discover'), plyWorker('discover/v2_caps'), phase2Wire('capability_table/v2'), deltaWire('caps/v2_fetch_features')),
    notes: [],
  }),
  b({
    id: 'caps.required-capabilities', area: 'caps',
    description: 'A server missing a capability ply needs (ls-refs, fetch) is refused as unsupported before any operation.',
    ops: [REQUIRED_V2, DISCOVER],
    tests: [t('test/space/advertisement.test.js', 'caps: every cell through discover() (derived from the table)')],
    status: verified(git('test/space/advertisement.test.js', ADV_REAL)),
    notes: ['Artifacts advertises every required capability, so the refusal has never been reached against it.'],
  }),
  b({
    id: 'caps.object-format', area: 'caps',
    description: 'object-format=sha1 is accepted; any other object format is refused as unsupported.',
    ops: [OBJECT_FORMAT, DISCOVER],
    tests: [t('test/space/advertisement.test.js', ADV_PUSH)],
    status: verified(git('test/space/advertisement.test.js', ADV_PUSH)),
    notes: ['ply has not probed a sha256 repository on any server.'],
  }),
  b({
    id: 'caps.fetch-argument-gating', area: 'caps',
    description: 'ply sends a fetch argument (filter, shallow, include-tag, thin-pack, ofs-delta) only when the advertisement allows it, as git fetch does.',
    ops: [FETCH_PACK, FETCH_REQUEST],
    tests: [t('test/space/advertisement.test.js', 'request: fetch arguments ply sends, judged by git fetch')],
    status: verified(git('test/space/advertisement.test.js', 'request: fetch arguments ply sends, judged by git fetch')),
    notes: [],
  }),
  b({
    id: 'caps.filter-not-advertised', area: 'caps',
    description: 'A server whose fetch= line lists no `filter` (stock http-backend) gets no filter argument after one probe.',
    ops: [FETCH_PACK, READ_FILE, LIST_TREE],
    tests: [t('test/no-filter.test.js', 'reads: readFile, listTree, readCommit, readLog, checkoutTree answer the same on both; one probe, then no filter')],
    status: verified(git('test/no-filter.test.js', 'reads: readFile, listTree, readCommit, readLog, checkoutTree answer the same on both; one probe, then no filter')),
    notes: [],
  }),
  b({
    id: 'caps.receive-pack-capabilities', area: 'caps',
    description: 'receive-pack capabilities (report-status, report-status-v2, side-band-64k, atomic, push-options, delete-refs, ofs-delta, object-format) are read and checked before the POST.',
    ops: [RECEIVE_CAPS, CHECK_PUSH_CAPS],
    tests: [t('test/space/advertisement.test.js', ADV_PUSH), t('test/push-pack.test.js', 'atomic the server does not advertise: unsupported, no POST, the pack unread')],
    status: verified(git('test/space/advertisement.test.js', ADV_PUSH), phase2Wire('receive_caps/artifacts'), deltaWire('caps/receive_pack_ofs_delta')),
    notes: [],
  }),
  b({
    id: 'caps.server-option', area: 'caps',
    description: 'v2 `server-option` arguments on ls-refs and fetch.',
    ops: [],
    tests: [],
    status: unsupported('discover() reads the capability; no ply operation sends a server-option.', phase2Wire('capability_table/v2')),
    notes: [],
  }),
  b({
    id: 'caps.wait-for-done-packfile-uris-sideband-all', area: 'caps',
    description: 'v2 fetch features wait-for-done, packfile-uris and sideband-all.',
    ops: [],
    tests: [],
    status: unsupported('src/closed.ts names them only to classify an advertisement; ply never requests them.', deltaWire('caps/v2_fetch_features')),
    notes: [],
  }),
  b({
    id: 'caps.object-info', area: 'caps',
    description: 'The v2 `object-info` command (object sizes without a pack).',
    ops: [],
    tests: [],
    status: unsupported('No ply operation sends command=object-info.', phase2Wire('object_info/artifacts')),
    notes: [],
  }),
];

const FETCH: readonly BehaviourIn<'fetch'>[] = [
  b({
    id: 'fetch.want-tip-full-pack', area: 'fetch',
    description: 'want of a tip with done and no filter: the pack holds exactly what pack-objects sends.',
    ops: [FETCH_PACK],
    tests: [t('test/protocol.test.js', MATRIX)],
    status: verified(git('test/protocol.test.js', MATRIX), compat('clone_full/small/v2'), compat('clone_full/big/v2'), validateGit('git judge: fsck --strict, refs, history')),
    notes: ['On Artifacts only stock git has fetched full packs; ply always fetches there with a filter or a depth.'],
  }),
  b({
    id: 'fetch.want-non-tip-object', area: 'fetch',
    description: 'want of an object that is not an advertised tip (an older commit, a tree, a blob, a tag) by id.',
    ops: [FETCH_PACK, FETCH_OBJECT, READ_FILE],
    tests: [t('test/protocol.test.js', MATRIX), t('test/read.test.js', 'readFile bytes == git show <ref>:<path> for every blob path and every ref form')],
    status: verified(git('test/protocol.test.js', MATRIX), git('test/read.test.js', 'readFile bytes == git show <ref>:<path> for every blob path and every ref form'), validatePly('read/blob README.md'), validatePly('tree (root, src)'), phase3Git('reachable_nontip/v2/artifacts'), phase2Git('fetch_reachable_sha')),
    notes: ['The reference fixtures set uploadpack.allowAnySHA1InWant; a differential run must give the reference server the want policy Artifacts has.'],
  }),
  b({
    id: 'fetch.want-unreachable-or-unknown', area: 'fetch',
    description: 'want of an unreachable or nonexistent id: the server refuses (ERR not our ref), and ply reports a typed remote_error.',
    ops: [FETCH_PACK],
    tests: [t('test/mutant-kill-tree.test.js', 'ERR upload-pack: not our ref x')],
    status: verified(phase3Git('unreachable_local/v2/artifacts'), phase3Git('fake_sha/v2/artifacts'), hostile('proto/want_short_oid'), hostile('proto/want_nonhex_oid')),
    notes: ['ply\'s side is tested only with a fake upload-pack; no test sends ply an unknown want against real git or Artifacts.'],
  }),
  b({
    id: 'fetch.want-have-line-syntax', area: 'fetch',
    description: 'want/have/shallow lines: upload-pack\'s verdict on each class of id, and ply refusing non-ids before the wire.',
    ops: [FETCH_REQUEST, NEGOTIATE],
    tests: [t('test/want-oracle.test.js', 'want: git upload-pack and fetchRequest agree on every class')],
    status: verified(git('test/want-oracle.test.js', 'want: git upload-pack and fetchRequest agree on every class'), hostile('proto/have_bad_oid'), hostile('proto/shallow_bad_oid')),
    notes: [],
  }),
  b({
    id: 'fetch.have-negotiation', area: 'fetch',
    description: 'Multi-round have/ACK negotiation, then done: the server stops at common commits and sends only what is missing.',
    ops: [NEGOTIATE, FETCH_PACK],
    tests: [t('test/protocol.test.js', MATRIX), t('test/want-oracle.test.js', 'negotiate: an acknowledgment that is not an object id')],
    status: verified(git('test/protocol.test.js', MATRIX), compat('incremental_fetch/scratch/v2')),
    notes: ['On Artifacts only stock git has negotiated; no ply probe has sent haves there.'],
  }),
  b({
    id: 'fetch.acknowledgments-ready-packfile', area: 'fetch',
    description: 'v2 response sections in order (acknowledgments, ready, shallow-info, packfile); a server that breaks the order is a protocol error, as it is for git.',
    ops: [FETCH_PACK],
    tests: [t('test/fetch-lying-server.test.js', 'a fetch sent with done and answered with acknowledgments only is a protocol error, as it is for git'), t('test/fetch-lying-server.test.js', 'a fetch sent with done and answered with acknowledgments before its packfile is a protocol error, as it is for git')],
    status: verified(git('test/fetch-lying-server.test.js', 'a fetch sent with done and answered with acknowledgments only is a protocol error, as it is for git')),
    notes: [],
  }),
  b({
    id: 'fetch.filter-blob-none', area: 'fetch',
    description: 'filter blob:none: commits and trees, and blobs only when wanted by id.',
    ops: [FETCH_PACK, FETCH_FILTERED, READ_FILE],
    tests: [t('test/protocol.test.js', MATRIX), t('test/log.test.js', 'readLog on blob:none: the trees are harvested')],
    status: verified(git('test/protocol.test.js', MATRIX), validatePly('read/blob README.md'), validatePly('tree (root, src)'), plyWorker('read/small'), compat('filter_blob_none+lazy_checkout/deep/v2')),
    notes: [],
  }),
  b({
    id: 'fetch.filter-tree-depth', area: 'fetch',
    description: 'filter tree:<depth> (tree:0 commit only, tree:1, tree:2).',
    ops: [FETCH_PACK, READ_COMMIT],
    tests: [t('test/protocol.test.js', MATRIX), t('test/read.test.js', 'readCommit fetches the commit object only: one tree:0 deepen-1 fetch, no tree fetches')],
    status: verified(git('test/protocol.test.js', MATRIX), compat('filter_tree_0/deep/v2')),
    notes: [],
  }),
  b({
    id: 'fetch.filter-blob-limit', area: 'fetch',
    description: 'filter blob:limit=<n>.',
    ops: [FETCH_PACK],
    tests: [t('test/protocol.test.js', MATRIX)],
    status: verified(git('test/protocol.test.js', MATRIX), compat('filter_blob_limit_2m/big/v2')),
    notes: [],
  }),
  b({
    id: 'fetch.filter-combine', area: 'fetch',
    description: 'filter combine:blob:none+tree:<k> (a commit and the first levels of its path in one request).',
    ops: [FETCH_PACK, READ_FILE],
    tests: [t('test/protocol.test.js', MATRIX), t('test/path-trees.test.js', 'a server that takes it: first contact is tree:0')],
    status: verified(git('test/protocol.test.js', MATRIX), git('test/path-trees.test.js', 'a server that takes it: first contact is tree:0')),
    notes: ['No Artifacts evidence of any kind for combine filters.'],
  }),
  b({
    id: 'fetch.filter-sparse-oid', area: 'fetch',
    description: 'filter sparse:oid=<blob>.',
    ops: [],
    tests: [],
    status: unsupported('No ply operation builds a sparse:oid filter, and no test sends one.', compat('filter_sparse_oid/wide/v2')),
    notes: [],
  }),
  b({
    id: 'fetch.filter-refusal-fallback', area: 'fetch',
    description: 'A server that advertises filter but refuses a filter spec with HTTP 400: ply records the refusal for that remote and falls back to blob:none.',
    ops: [LEARN_FILTER, FETCH_PACK, READ_FILE],
    tests: [t('test/artifacts-compat.test.js', 'Unsupported Git fetch filter; only blob:none is supported.'), t('test/path-trees.test.js', 'an Artifacts-like server (only blob:none): never asked for the deep fetch')],
    status: verified(git('test/artifacts-compat.test.js', 'Unsupported Git fetch filter; only blob:none is supported.'), validatePly('read/blob README.md'), plyWorker('read/small')),
    notes: ['The reference tests emulate the 400 with a proxy in front of git; git judges the results, not the refusal.'],
  }),
  b({
    id: 'fetch.deepen-depth', area: 'fetch',
    description: 'deepen <n>: a shallow pack cut n commits below each want, with shallow-info naming the boundary.',
    ops: [FETCH_PACK, FETCH_OBJECT],
    tests: [t('test/protocol.test.js', MATRIX), t('test/parity.test.js', CLONE_SHAPES), t('test/fetchobject-deepen.test.js', 'fetchObject costs one object')],
    status: verified(git('test/parity.test.js', CLONE_SHAPES), compat('depth_1/small/v2'), compat('depth_n/small/v2')),
    notes: [],
  }),
  b({
    id: 'fetch.deepen-since', area: 'fetch',
    description: 'deepen-since <time>.',
    ops: [FETCH_PACK],
    tests: [t('test/parity.test.js', CLONE_SHAPES)],
    status: verified(git('test/parity.test.js', CLONE_SHAPES), compat('shallow_since/deep/v2')),
    notes: [],
  }),
  b({
    id: 'fetch.deepen-not', area: 'fetch',
    description: 'deepen-not <ref>.',
    ops: [FETCH_PACK],
    tests: [t('test/parity.test.js', CLONE_SHAPES)],
    status: verified(git('test/parity.test.js', CLONE_SHAPES), compat('shallow_exclude/deep/v2')),
    notes: [],
  }),
  b({
    id: 'fetch.deepen-relative-unshallow', area: 'fetch',
    description: 'Fetch after a shallow clone: deepen-relative, a deeper depth, and unshallow, from the client\'s shallow list.',
    ops: [FETCH_PACK],
    tests: [t('test/parity.test.js', 'fetch after a shallow clone: --deepen (relative), --depth=N, --unshallow, --shallow-since, --shallow-exclude')],
    status: verified(git('test/parity.test.js', 'fetch after a shallow clone: --deepen (relative), --depth=N, --unshallow, --shallow-since, --shallow-exclude'), phase2Git('deepen_relative_v2'), compat('unshallow/deep/v2'), phase2Git('depth_beyond_history')),
    notes: [],
  }),
  b({
    id: 'fetch.include-tag', area: 'fetch',
    description: 'include-tag: annotated tags that point into the pack are sent with it.',
    ops: [FETCH_PACK],
    tests: [t('test/parity.test.js', 'includeTag: true')],
    status: verified(git('test/parity.test.js', 'includeTag: true'), compat('depth_1/wide/v2'), compat('clone_full/small/v2')),
    notes: ['ply\'s own operations never ask for include-tag; only a fetchPack caller that sets it does.'],
  }),
  b({
    id: 'fetch.thin-pack', area: 'fetch',
    description: 'thin-pack with haves: deltas against objects the client has, resolved against external bases.',
    ops: [FETCH_PACK, RESOLVE_PACK],
    tests: [t('test/protocol.test.js', MATRIX), t('test/edges.test.js', 'thin-pack fetch with have resolves against external base')],
    status: verified(git('test/edges.test.js', 'thin-pack fetch with have resolves against external base'), deltaGit('storage/thin_fetch')),
    notes: [],
  }),
  b({
    id: 'fetch.ofs-delta-requested', area: 'fetch',
    description: 'ofs-delta: OFS_DELTA entries only when asked for.',
    ops: [FETCH_PACK, PARSE_PACK],
    tests: [t('test/protocol.test.js', MATRIX)],
    status: verified(git('test/protocol.test.js', MATRIX), deltaWire('caps/upload_v0_ofs_thin')),
    notes: [],
  }),
  b({
    id: 'fetch.sideband-bands', area: 'fetch',
    description: 'Side-band in the packfile section: band 1 data, band 2 progress, band 3 fatal error.',
    ops: [SIDEBAND, FETCH_PACK],
    tests: [t('test/adversarial.test.js', "{ name: 'fetch band 3 (commit)'"), t('test/remote-text.test.js', 'listRefs (ERR) and readFile (fetch ERR, fetch band 3) carry none of it')],
    status: verified(git('test/adversarial.test.js', 'every protocol-aware mutator × every stage: typed error or git-verified success, never silent corruption')),
    notes: ['Band 3 is only ever injected by a proxy; no server has been made to send ply a fatal band-3 line.'],
  }),
];

const PUSH_MATRIX = 'push matrix: configs × hooks × commands × caps, parity with git push';

const PACK: readonly BehaviourIn<'pack'>[] = [
  b({
    id: 'pack.ofs-delta-resolve', area: 'pack',
    description: 'A served pack with OFS_DELTA chains resolves to the objects git verify-pack lists.',
    ops: [PARSE_PACK, RESOLVE_RANGE, SCAN_PACK],
    tests: [t('test/pack-range-resolve.test.js', "this repository's pack with OFS deltas matches git verify-pack")],
    status: verified(git('test/pack-range-resolve.test.js', "this repository's pack with OFS deltas matches git verify-pack")),
    notes: ['Artifacts sends REF_DELTA only, so no fetch from it reaches OFS resolution.'],
  }),
  b({
    id: 'pack.ref-delta-resolve', area: 'pack',
    description: 'A served pack of REF_DELTA entries only (what Artifacts sends) resolves in any order.',
    ops: [PARSE_PACK, RESOLVE_RANGE, SCAN_PACK],
    tests: [t('test/pack-range-resolve.test.js', "this repository's pack, REF_DELTA only (what Artifacts sends)"), t('test/edges.test.js', 'REF_DELTA packs (server without ofs-delta) resolve identically')],
    status: verified(git('test/pack-range-resolve.test.js', "this repository's pack, REF_DELTA only (what Artifacts sends)"), validatePly('read/blob README.md'), validatePly('viewer: /r/ply blob (README.md)')),
    notes: [],
  }),
  b({
    id: 'pack.thin-ref-base', area: 'pack',
    description: 'A thin REF base supplied from outside the pack is checked against its claimed id before a delta applies.',
    ops: [RESOLVE_PACK],
    tests: [t('test/space/thin-base.test.js', 'thin REF base: every claim × byte form against git hash-object and index-pack --fix-thin')],
    status: verified(git('test/space/thin-base.test.js', 'thin REF base: every claim × byte form against git hash-object and index-pack --fix-thin')),
    notes: [],
  }),
  b({
    id: 'pack.truncated-served-pack', area: 'pack',
    description: 'A served pack cut at any byte is refused, typed, on every read path, where git index-pack refuses it.',
    ops: [PARSE_PACK, SCAN_PACK, RESOLVE_RANGE],
    tests: [t('test/space/pack-cut.test.js', 'cut: every byte offset of every pack is refused, typed, on every path')],
    status: verified(git('test/space/pack-cut.test.js', 'git index-pack --strict refuses every cut')),
    notes: [],
  }),
  b({
    id: 'pack.corrupt-served-pack', area: 'pack',
    description: 'A served pack with a corrupt header field, zlib member, delta or checksum is refused exactly where git index-pack --strict refuses it.',
    ops: [PARSE_PACK, SCAN_PACK, FETCH_PACK],
    tests: [t('test/space/pack-cut.test.js', 'corrupt: every header-field class is refused exactly where git index-pack --strict refuses it, typed'), t('test/adversarial.test.js', 'every protocol-aware mutator × every stage: typed error or git-verified success, never silent corruption')],
    status: verified(git('test/space/pack-cut.test.js', 'corrupt: every header-field class is refused exactly where git index-pack --strict refuses it, typed')),
    notes: [],
  }),
  b({
    id: 'pack.served-pack-limits', area: 'pack',
    description: 'Hostile sizes in a served pack (object size, delta result, chain depth, inflated total) are refused before allocation.',
    ops: [PARSE_PACK, RESOLVE_RANGE],
    tests: [t('test/adversarial.test.js', 'I4 limits: hostile sizes are rejected before allocation; memory does not grow'), t('test/delta-bound.test.js', 'A delta that asks for a huge result must die before the output buffer exists'), t('test/space/pack-cut.test.js', 'caps: maxObjectSize, maxInflatedTotal, maxDeltaChain at, and one under, what each real pack needs')],
    status: verified(git('test/space/pack-cut.test.js', 'caps: maxObjectSize, maxInflatedTotal, maxDeltaChain at, and one under, what each real pack needs')),
    notes: [],
  }),
  b({
    id: 'pack.push-ofs-delta-accepted', area: 'pack',
    description: 'receive-pack accepts a pushed pack with OFS_DELTA entries when it advertises ofs-delta.',
    ops: [PUSH, PUSH_PACK],
    tests: [t('test/push-once.test.js', 'push: an ofs delta whose base is a repeated object still names its base'), t('test/push-pack.test.js', 'a stock git pack of known length: chunked stream, ref moves, fsck --strict clean, span counts the body')],
    status: verified(git('test/push-pack.test.js', 'a stock git pack of known length: chunked stream, ref moves, fsck --strict clean, span counts the body'), deltaWire('push/ofs')),
    notes: [],
  }),
  b({
    id: 'pack.push-thin-against-server-base', area: 'pack',
    description: 'receive-pack completes a thin pushed pack whose REF bases it holds (every ply edit pushes blob and tree deltas this way).',
    ops: [EDIT_FILE, PUSH],
    tests: [t('test/edges.test.js', 'push = commit + 100 tree deltas + blob delta')],
    status: verified(git('test/edges.test.js', 'push = commit + 100 tree deltas + blob delta'), validatePly('write: edit README find/replace (c1)'), deltaWire('push/thin_ok')),
    notes: [],
  }),
  b({
    id: 'pack.push-thin-missing-base', area: 'pack',
    description: 'receive-pack refuses a thin pushed pack whose base it does not hold, and moves no ref.',
    ops: [PUSH_PACK],
    tests: [],
    status: verified(deltaWire('push/thin_missing')),
    notes: ['pushPack can send such a pack but no test does; only a hand-built probe has checked Artifacts.'],
  }),
  b({
    id: 'pack.push-corrupt-pack-refused', area: 'pack',
    description: 'receive-pack refuses a corrupt pushed pack (unpack error, ng for every ref) and moves no ref.',
    ops: [PUSH_PACK, CLASSIFY_REPORT],
    tests: [t('test/push-pack.test.js', 'a corrupt pack against stock git'), t('test/custom-exchange.test.js', 'a corrupt pack: the report is unpackFailed'), t('test/push-unpack-host.test.js', 'the echoed shape is unpackFailed and decides push_rejected; delete-only stays ambiguous')],
    status: verified(git('test/push-pack.test.js', 'a corrupt pack against stock git'), hostileWrite('pack/corrupt_zlib'), hostileWrite('pack/bad_checksum'), hostileWrite('pack/truncated'), hostileWrite('pack/bad_magic'), hostileWrite('pack/wrong_object_count')),
    notes: ['ply\'s reading of Artifacts\' own unpack-failure report is tested only on bytes copied from prod into a fake (push-unpack-host.test.js).'],
  }),
  b({
    id: 'pack.push-duplicate-object', area: 'pack',
    description: 'A pushed pack never names one object twice (a strict receiver refuses it).',
    ops: [PUSH],
    tests: [t('test/push-once.test.js', 'push: a list that names objects twice is one object each on the wire')],
    status: verified(git('test/push-once.test.js', 'push: a list that names objects twice is one object each on the wire')),
    notes: [],
  }),
  b({
    id: 'pack.push-malformed-object-refused', area: 'pack',
    description: 'receive-pack refuses a well-framed pack that holds a malformed object or a delta with no base.',
    ops: [PUSH_PACK],
    tests: [],
    status: verified(hostileWrite('pack/invalid_commit_payload'), hostileWrite('pack/delta_missing_base')),
    notes: ['ply\'s encoders never write a malformed object (the encode-*-fsck tests); pushPack could carry one but no test does.'],
  }),
];

const PUSHES: readonly BehaviourIn<'push'>[] = [
  b({
    id: 'push.create-ref', area: 'push',
    description: 'A command with the zero old id creates a ref.',
    ops: [PUSH, CREATE_BRANCH],
    tests: [t('test/push.test.js', "'create': t =>"), t('test/e2e-customer.test.js', 'createBranch from a branch name, a short name, a peeled annotated tag')],
    status: verified(git('test/push.test.js', "'create': t =>"), validatePly('branch create (feat from c0)'), plyWorker('branch/create'), phase2Git('new_branch')),
    notes: [],
  }),
  b({
    id: 'push.first-commit-empty-repo', area: 'push',
    description: 'The first push to an empty repository creates the default branch from a root commit.',
    ops: [COMMIT_CHANGES, PUSH],
    tests: [t('test/changes.test.js', 'commitChanges: start × place × op against git cat-file and fsck --strict')],
    status: verified(git('test/changes.test.js', 'commitChanges: start × place × op against git cat-file and fsck --strict'), validatePly('write: root commit (edit changes)')),
    notes: [],
  }),
  b({
    id: 'push.fast-forward-update', area: 'push',
    description: 'A fast-forward update with the current old id lands.',
    ops: [PUSH, EDIT_FILE],
    tests: [t('test/push.test.js', PUSH_MATRIX)],
    status: verified(git('test/push.test.js', PUSH_MATRIX), validatePly('write: edit README find/replace (c1)'), plyWorker('edit/ok')),
    notes: [],
  }),
  b({
    id: 'push.non-fast-forward', area: 'push',
    description: 'A non-fast-forward update: refused under receive.denyNonFastForwards, accepted as a forced update otherwise.',
    ops: [PUSH],
    tests: [t('test/push.test.js', "'nonff-update': t =>"), t('test/push.test.js', "'deny-nonff': { 'receive.denyNonFastForwards': 'true' }")],
    status: verified(git('test/push.test.js', "'nonff-update': t =>"), phase2Git('non_ff_reject'), compat('force_push/scratch/v2')),
    notes: ['No ply probe has pushed a non-fast-forward to Artifacts.'],
  }),
  b({
    id: 'push.delete-ref', area: 'push',
    description: 'A command with the zero new id deletes a ref (delete-refs); refused under receive.denyDeletes.',
    ops: [PUSH, DELETE_BRANCH],
    tests: [t('test/push.test.js', "'delete': t =>"), t('test/push.test.js', "'deny-deletes': { 'receive.denyDeletes': 'true' }")],
    status: verified(git('test/push.test.js', "'delete': t =>"), validatePly('branch delete (CAS ok)'), plyWorker('branch/delete'), compat('tag_push_delete/scratch/v2')),
    notes: [],
  }),
  b({
    id: 'push.atomic', area: 'push',
    description: 'atomic: several ref updates land together or not at all.',
    ops: [PUSH, PUSH_PACK, RUN_TRANSFER],
    tests: [t('test/push.test.js', "'multi-atomic': t =>"), t('test/push-pack.test.js', 'atomic: checked against the advertisement, then sent; two refs land together')],
    status: verified(git('test/push-pack.test.js', 'atomic: checked against the advertisement, then sent; two refs land together'), compat('atomic_push_multi_ref/scratch/v2')),
    notes: ['No ply probe has sent an atomic push to Artifacts, and none has made one of its commands fail there.'],
  }),
  b({
    id: 'push.non-atomic-partial', area: 'push',
    description: 'A non-atomic multi-ref push the server applies in part is push_partial, naming what landed.',
    ops: [PUSH],
    tests: [t('test/push.test.js', "assert.equal(err.code, 'push_partial'")],
    status: verified(git('test/push.test.js', "assert.equal(err.code, 'push_partial'")),
    notes: ['No Artifacts evidence of any kind for a partly applied push.'],
  }),
  b({
    id: 'push.report-status', area: 'push',
    description: 'report-status: an unpack line (ok or a reason) and an ok or ng line per command, classified as landed, rejected, conflict or ambiguous.',
    ops: [PUSH, CLASSIFY_REPORT],
    tests: [t('test/space/push-ng.test.js', 'push ng: cells observed from git'), t('test/space/push-outcome.test.js', 'The push-outcome enumerator'), t('test/push.test.js', PUSH_MATRIX)],
    status: verified(git('test/push.test.js', PUSH_MATRIX), validatePly('write: root commit (edit changes)')),
    notes: ['push-ng and push-outcome judge the class table over a fake transport; their git-observed cells are recorded bytes.'],
  }),
  b({
    id: 'push.report-status-v2', area: 'push',
    description: 'report-status-v2: option lines after ok.',
    ops: [PUSH],
    tests: [t('test/push.test.js', 'reportV2: true')],
    status: verified(git('test/push.test.js', 'reportV2: true')),
    notes: ['No Artifacts evidence: no recorded run says whether Artifacts advertises report-status-v2.'],
  }),
  b({
    id: 'push.sideband-hook-output', area: 'push',
    description: 'side-band-64k on receive-pack: the report on band 1, hook output on band 2.',
    ops: [PUSH],
    tests: [t('test/push.test.js', 'hook stderr visible on band 2 when side-band is requested')],
    status: verified(git('test/push.test.js', 'hook stderr visible on band 2 when side-band is requested')),
    notes: [],
  }),
  b({
    id: 'push.push-options', area: 'push',
    description: 'push-options: sent only when advertised; they reach the hook.',
    ops: [PUSH, PUSH_PACK],
    tests: [t('test/push.test.js', 'options reached the hook'), t('test/push-pack.test.js', 'push options: refused when not advertised, sent when they are')],
    status: verified(git('test/push.test.js', 'options reached the hook'), phase2Git('push_options')),
    notes: [],
  }),
  b({
    id: 'push.hook-rejection', area: 'push',
    description: 'A pre-receive or update hook that declines: ng with the hook\'s reason, ref unchanged.',
    ops: [PUSH],
    tests: [t('test/push.test.js', "'pre-receive-reject': ['pre-receive'")],
    status: verified(git('test/push.test.js', "'pre-receive-reject': ['pre-receive'")),
    notes: ['Artifacts runs no user hooks; this is reference-only by nature.'],
  }),
  b({
    id: 'push.ref-name-rules', area: 'push',
    description: 'receive-pack\'s ref-name rules ("funny refname"): ply refuses before the wire exactly what receive-pack refuses.',
    ops: [PUSH],
    tests: [t('test/space/refname.test.js', 'ref names: ply agrees with git check-ref-format and receive-pack on every cell')],
    status: verified(git('test/space/refname.test.js', 'ref names: ply agrees with git check-ref-format and receive-pack on every cell'), phase2Git('invalid_ref_names'), hostileWrite('ref/dotdot'), hostileWrite('ref/control_char'), hostileWrite('ref/long_name')),
    notes: [],
  }),
  b({
    id: 'push.size-limits', area: 'push',
    description: 'A push over the server\'s object or pack size cap is refused with a report ply classifies as limit_exceeded.',
    ops: [PUSH, PUSH_PACK],
    tests: [t('test/push-unpack-host.test.js', 'Artifacts 64 MiB cap is limit_exceeded with got/max in bytes, not push_rejected or ambiguous')],
    status: verified(phase2Git('blob_push_ceiling'), compat('large_blob_push_24m/scratch/v2'), hostileWrite('pack/zlib_bomb_40m')),
    notes: ['ply\'s classification is tested only on report bytes copied into a fake. Neither git (receive.maxInputSize) nor Artifacts has refused a ply push for size in a recorded run.'],
  }),
  b({
    id: 'push.many-ref-updates', area: 'push',
    description: 'One push carrying many ref updates.',
    ops: [PUSH],
    tests: [],
    status: verified(phase2Git('many_refs_5000'), hostileWrite('ref/fifty_updates')),
    notes: ['ply can send any number of commands; no test sends more than a few.'],
  }),
  b({
    id: 'push.signed-push', area: 'push',
    description: 'push-cert (signed pushes).',
    ops: [],
    tests: [],
    status: unsupported('ply signs commits (src/sign.ts) but never sends a push certificate.', phase2Git('signed_push')),
    notes: [],
  }),
];

const CONCURRENCY: readonly BehaviourIn<'concurrency'>[] = [
  b({
    id: 'concurrency.stale-old-oid', area: 'concurrency',
    description: 'A push whose old id is no longer the ref\'s value is refused (compare-and-swap) and the ref is unchanged.',
    ops: [PUSH, PUSH_PACK, EDIT_FILE],
    tests: [t('test/push.test.js', "'stale-old': t =>"), t('test/push-pack.test.js', 'a stale old oid is cas_conflict, as push reports it'), t('test/custom-exchange.test.js', 'receive-pack refuses a command (stale old id)')],
    status: verified(git('test/push.test.js', "'stale-old': t =>"), git('test/push-pack.test.js', 'a stale old oid is cas_conflict, as push reports it'), phase2Git('force_with_lease_stale')),
    notes: ['The validate CAS checks (stale head, stale delete) are refused by ply-web from ls-refs, before any push: Artifacts refusing a stale ply push has no recorded run. artifacts-compat.test.js emulates its reason with a proxy.'],
  }),
  b({
    id: 'concurrency.concurrent-writers', area: 'concurrency',
    description: 'Concurrent writers on one ref: one wins each round, the rest are refused as stale and retry; nothing is lost.',
    ops: [EDIT_FILE, PUSH],
    tests: [t('test/concurrency.test.js', 'concurrent CAS writers converge; conflicts are observed and retried, never lost'), t('test/edit-race-f34.test.js', 'same-file edit race ×1000 attempts: only ok and cas_conflict')],
    status: verified(git('test/concurrency.test.js', 'concurrent CAS writers converge; conflicts are observed and retried, never lost'), git('test/edit-race-f34.test.js', 'same-file edit race ×1000 attempts: only ok and cas_conflict'), plyWorker('edit/race_same_file'), plyWorker('edit/race_diff_files'), phase2Git('fetch_push_race')),
    notes: [],
  }),
  b({
    id: 'concurrency.ref-created-between-read-and-push', area: 'concurrency',
    description: 'Another writer creates the target ref between ply\'s ls-refs and its receive-pack: the create is refused, naming the winner.',
    ops: [CREATE_BRANCH, CREATE_TAG, COMMIT_CHANGES],
    tests: [t('test/e2e-customer.test.js', 'createBranch and createTag lose a race to a ref made between ls-refs and receive-pack: cas_conflict naming the winner'), t('test/changes-create-race.test.js', 'commitChanges creating a ref from a base')],
    status: verified(git('test/e2e-customer.test.js', 'createBranch and createTag lose a race to a ref made between ls-refs and receive-pack: cas_conflict naming the winner')),
    notes: ['No Artifacts evidence: validate\'s duplicate-branch check is refused by ply-web from ls-refs, before receive-pack.'],
  }),
  b({
    id: 'concurrency.ref-deleted-between-read-and-push', area: 'concurrency',
    description: 'Another writer deletes the target ref between ply\'s read and its push.',
    ops: [COMMIT_CHANGES],
    tests: [t('test/changes-delete-race.test.js', 'head pinned to the base: a target deleted mid-call is cas_conflict and stays deleted')],
    status: verified(git('test/changes-delete-race.test.js', 'head pinned to the base: a target deleted mid-call is cas_conflict and stays deleted')),
    notes: ['No Artifacts evidence.'],
  }),
  b({
    id: 'concurrency.read-after-write', area: 'concurrency',
    description: 'A landed push is visible at once to ls-refs and to fetch (no stale advertisement after a push).',
    ops: [LS_REFS, READ_FILE, READ_COMMIT],
    tests: [t('test/transfer.test.js', 'ls-refs that lags a push: settled by reading again, not by sending again')],
    status: verified(validatePly('freshness: refs-after-write'), validatePly('freshness: read-after-write README'), validatePly('freshness: commit-after-write'), phase2Git('visibility_latency')),
    notes: ['transfer.test.js emulates a lagging ls-refs with a proxy; the reference server never lags, so there is no reference evidence.'],
  }),
  b({
    id: 'concurrency.empty-report-under-contention', area: 'concurrency',
    description: 'A receive-pack 200 with no unpack or ref lines (seen on Artifacts under same-repo concurrency) is ambiguous, never landed.',
    ops: [PUSH, CLASSIFY_REPORT],
    tests: [t('test/push-unpack-host.test.js', 'an empty receive-pack report stays ambiguous (concurrent same-repo 200 with no unpack/ref lines)')],
    status: IMPLEMENTED,
    notes: ['Tested on recorded bytes only; no recorded run reproduces the empty report.'],
  }),
  b({
    id: 'concurrency.two-transfer-runners', area: 'concurrency',
    description: 'Two resumable transfers of one plan at once both finish with the planned head; each refused step is settled by reading refs.',
    ops: [RUN_TRANSFER],
    tests: [t('test/transfer-outcomes.test.js', 'two runners on one plan at once, 20 times: both end done; the destination is the planned head')],
    status: verified(git('test/transfer-outcomes.test.js', 'two runners on one plan at once, 20 times: both end done; the destination is the planned head')),
    notes: ['No Artifacts evidence.'],
  }),
];

const TAG_TEST = 'createTag: lightweight and annotated (as git tag -a writes it), refusals';

const TAGS: readonly BehaviourIn<'tags'>[] = [
  b({
    id: 'tags.lightweight-create', area: 'tags',
    description: 'A lightweight tag is a ref create under refs/tags pointing at a commit.',
    ops: [CREATE_TAG],
    tests: [t('test/e2e-customer.test.js', TAG_TEST)],
    status: verified(git('test/e2e-customer.test.js', TAG_TEST), validatePly('tag lightweight')),
    notes: [],
  }),
  b({
    id: 'tags.annotated-create', area: 'tags',
    description: 'An annotated tag pushes a tag object with its ref, byte-equal to git tag -a.',
    ops: [CREATE_TAG],
    tests: [t('test/e2e-customer.test.js', TAG_TEST)],
    status: verified(git('test/e2e-customer.test.js', TAG_TEST), validatePly('tag annotated'), validateGit('git judge: fsck --strict, refs, history')),
    notes: [],
  }),
  b({
    id: 'tags.delete', area: 'tags',
    description: 'A tag delete with the expected old id; a stale expected id is refused.',
    ops: [DELETE_TAG],
    tests: [t('test/e2e-customer.test.js', 'deleteTag')],
    status: verified(git('test/e2e-customer.test.js', 'deleteTag'), validatePly('tag delete (CAS) + stale delete -> 409'), compat('tag_push_delete/scratch/v2')),
    notes: ['The stale half of the validate check is refused by ply-web from ls-refs, not by Artifacts.'],
  }),
  b({
    id: 'tags.peel-chain', area: 'tags',
    description: 'A ref given as an annotated tag (or a tag of a tag) is peeled to its commit for reads and branch creation.',
    ops: [READ_FILE, CREATE_BRANCH],
    tests: [t('test/e2e-customer.test.js', 'createBranch from a branch name, a short name, a peeled annotated tag'), t('test/read.test.js', 'readFile bytes == git show <ref>:<path> for every blob path and every ref form')],
    status: verified(git('test/read.test.js', 'readFile bytes == git show <ref>:<path> for every blob path and every ref form'), validatePly('read: tag name resolves (ref=v1)')),
    notes: [],
  }),
  b({
    id: 'tags.many-tags', area: 'tags',
    description: 'A repository with many tags: listing, include-tag and fetch stay correct.',
    ops: [LS_REFS],
    tests: [],
    status: verified(phase2Git('shape/manytags')),
    notes: ['No ply test or probe lists a many-tag repository.'],
  }),
];

const MERGE_SPACE = 'merge-base outcome space: position × multiplicity × settled × server × op, every cell equal to git';

const ANCESTRY: readonly BehaviourIn<'ancestry'>[] = [
  b({
    id: 'ancestry.merge-base-search', area: 'ancestry',
    description: 'Merge bases found by shallow windows over the server (deepen), equal to git merge-base --all within the cap.',
    ops: [MERGE_BASE],
    tests: [t('test/mergebase-space.test.js', MERGE_SPACE), t('test/space/merge-depth.test.js', 'merge-base cap: every relation × length × cap against git merge-base --all')],
    status: verified(git('test/mergebase-space.test.js', MERGE_SPACE), git('test/space/merge-depth.test.js', 'merge-base cap: every relation × length × cap against git merge-base --all'), validatePly('merge feat into main (true merge)')),
    notes: [],
  }),
  b({
    id: 'ancestry.merge-commit-push', area: 'ancestry',
    description: 'A two-parent merge commit pushed as a fast-forward of the target; history visible to git as a merge.',
    ops: [MERGE_BRANCH],
    tests: [t('test/merge.test.js', 'outcomes: up-to-date, fast-forward, ff-only refusal, no-ff merge commit, clean merge, conflict')],
    status: verified(git('test/merge.test.js', 'outcomes: up-to-date, fast-forward, ff-only refusal, no-ff merge commit, clean merge, conflict'), validatePly('merge feat into main (true merge)'), plyWorker('merge/true'), plyWorker('merge/verify'), phase2Git('shape/merges')),
    notes: [],
  }),
  b({
    id: 'ancestry.fast-forward-and-up-to-date', area: 'ancestry',
    description: 'Merging an ancestor is up to date (no push); merging a descendant fast-forwards the ref.',
    ops: [MERGE_BRANCH],
    tests: [t('test/merge.test.js', 'outcomes: up-to-date, fast-forward, ff-only refusal, no-ff merge commit, clean merge, conflict')],
    status: verified(git('test/merge.test.js', 'outcomes: up-to-date, fast-forward, ff-only refusal, no-ff merge commit, clean merge, conflict'), validatePly('merge again -> up_to_date'), validatePly('merge fast-forward (ff branch)'), plyWorker('merge/ff')),
    notes: [],
  }),
  b({
    id: 'ancestry.rebase-chain', area: 'ancestry',
    description: 'A chain of commits replayed onto a moved base, pushed with the old tip as the expected id.',
    ops: [REBASE_BRANCH],
    tests: [t('test/rebase.test.js', 'rebase: three commits onto a moved main')],
    status: verified(git('test/rebase.test.js', 'rebase: three commits onto a moved main'), validatePly('rebase topic onto main')),
    notes: [],
  }),
  b({
    id: 'ancestry.cherry-pick-revert', area: 'ancestry',
    description: 'Cherry-pick and revert: one new commit whose tree equals git\'s; empty results stop or keep as git does.',
    ops: [CHERRY_PICK, REVERT_COMMIT],
    tests: [t('test/rebase.test.js', 'cherry-pick and revert: trees equal git'), t('test/pick-empty.test.js', 'cherry-pick --keep-redundant-commits and --allow-empty: commit bytes match git, stop writes nothing')],
    status: verified(git('test/rebase.test.js', 'cherry-pick and revert: trees equal git'), validatePly('cherry-pick f2 onto main'), validatePly('cherry-pick again -> empty noop'), validatePly('revert cherry-pick on main')),
    notes: [],
  }),
  b({
    id: 'ancestry.log-walk', area: 'ancestry',
    description: 'First-parent history read in shallow windows equals git log --first-parent.',
    ops: [READ_LOG],
    tests: [t('test/log.test.js', 'readLog: server × shape × limit × behaviour, every cell against git')],
    status: verified(git('test/log.test.js', 'readLog: server × shape × limit × behaviour, every cell against git'), plyWorker('commit/deep')),
    notes: ['validate\'s log checks go through the viewer, which judges Artifacts history with git log, not readLog.'],
  }),
  b({
    id: 'ancestry.cut-graph', area: 'ancestry',
    description: 'A server that withholds ancestors without saying shallow: ply fails closed, nothing pushed.',
    ops: [MERGE_BASE, MERGE_BRANCH],
    tests: [t('test/adversarial.test.js', '#18 merge base over a cut graph: a server that withholds ancestors without a shallow line fails closed (pack_corrupt), nothing pushed')],
    status: IMPLEMENTED,
    notes: ['A proxy cuts the graph; no git or Artifacts server ever behaves this way on purpose.'],
  }),
];

const ERRORS: readonly BehaviourIn<'errors'>[] = [
  b({
    id: 'errors.auth-missing-or-wrong', area: 'errors',
    description: 'A missing or wrong credential is 401 and a typed auth error; nothing lands.',
    ops: [CREATE_TRANSPORT, LS_REFS, PUSH],
    tests: [t('test/custom-exchange.test.js', 'wrong credential: auth (401), typed, thrown from the iteration'), t('test/adversarial.test.js', 'I6e the credential product: every source × user × password cell gets its stated header or typed refusal, equal to git where git has the input, and leaks nothing')],
    status: verified(git('test/adversarial.test.js', 'I6e the credential product: every source × user × password cell gets its stated header or typed refusal, equal to git where git has the input, and leaks nothing'), validatePly('auth: wrong bearer -> 401'), validatePly('auth: revoked Git-Token (auto-minted) -> upstream 403 typed'), plyWorker('err/bad_git_token'), hostile('auth/missing'), hostile('auth/garbage_header'), phase2Git('auth_paths')),
    notes: ['validate\'s 401 checks are ply-web\'s own bearer; only the revoked Git-Token check reaches Artifacts\' auth through ply.'],
  }),
  b({
    id: 'errors.receive-pack-forbidden', area: 'errors',
    description: 'A read-only credential pushing: 403 on receive-pack (advertisement or POST) is auth, and no ref moves.',
    ops: [PUSH],
    tests: [t('test/adversarial.test.js', 'receive-pack refused for this caller (403 on its POST and on its advertisement) is auth, and the ref did not move (#144)')],
    status: verified(git('test/adversarial.test.js', 'receive-pack refused for this caller (403 on its POST and on its advertisement) is auth, and the ref did not move (#144)'), validatePly('push rejected path (read-scoped token write)'), phase2Git('read_only_token_push')),
    notes: [],
  }),
  b({
    id: 'errors.repository-not-found', area: 'errors',
    description: 'A repository that does not exist: the advertisement answers 404, typed not_found.',
    ops: [LS_REFS, DISCOVER],
    tests: [t('test/adversarial.test.js', 'HTTP-level faults at every stage: statuses, non-git bodies, stall, drop, empty')],
    status: verified(plyWorker('err/no_repo')),
    notes: ['The 404 class is tested only with injected statuses; git http-backend\'s own 404 for a missing repository is not cited by any test.'],
  }),
  b({
    id: 'errors.http-status-classes', area: 'errors',
    description: 'Statuses 4xx/5xx/429 at each stage map to ply\'s typed classes, and a refused optional feature is not retried for them.',
    ops: [CREATE_TRANSPORT, FETCH_PACK, PUSH],
    tests: [t('test/adversarial.test.js', 'HTTP-level faults at every stage: statuses, non-git bodies, stall, drop, empty'), t('test/fetchobject-deepen-refusal.test.js', 'never asked again: 401, 403, 404, 429 and 500 stand as they are, with no advertisement read')],
    status: IMPLEMENTED,
    notes: ['Judged against ply\'s own table. No recorded run checks what Artifacts sends under rate limiting or a 5xx.'],
  }),
  b({
    id: 'errors.err-pkt-line', area: 'errors',
    description: 'An ERR pkt-line anywhere in a response is a typed remote error carrying the scrubbed message.',
    ops: [LS_REFS, FETCH_PACK],
    tests: [t('test/mutant-kill-tree.test.js', 'ERR upload-pack: not our ref x'), t('test/adversarial.test.js', 'I6b a credential echoed by the server reaches no error (any field) and no span: ERR, band 2/3, ng, hook output × 4 auth forms')],
    status: IMPLEMENTED,
    notes: ['ERR lines are injected; the real ones git and Artifacts send are cited only under fetch.want-unreachable-or-unknown.'],
  }),
  b({
    id: 'errors.not-git-response', area: 'errors',
    description: 'A 200 that is not git (HTML, wrong content type) is not_git, never parsed as protocol.',
    ops: [CREATE_TRANSPORT],
    tests: [t('test/custom-exchange.test.js', 'a server that is not git (HTML 200) is not_git'), t('test/http-options.test.js', 'the advertisement: its GET asks redirect manual; a foreign content type is not_git')],
    status: IMPLEMENTED,
    notes: [],
  }),
  b({
    id: 'errors.malformed-requests-to-server', area: 'errors',
    description: 'How the server answers malformed requests (bad pkt-line lengths, misplaced delimiters, unknown commands and capabilities).',
    ops: [],
    tests: [],
    status: unsupported('ply only writes well-formed requests; it has no mode that sends malformed ones.', hostile('pkt/nonhex_length'), hostile('pkt/giant_length_claim'), hostile('pkt/missing_flush'), hostile('proto/v2_unknown_command'), hostile('proto/unknown_capability')),
    notes: [],
  }),
];

const INTERRUPTED: readonly BehaviourIn<'interrupted'>[] = [
  b({
    id: 'interrupted.push-response-lost', area: 'interrupted',
    description: 'The server applies a push but the response is lost: ply reports ambiguous, the refs show the push, a retry is safe.',
    ops: [PUSH, RUN_TRANSFER, EDIT_FILE],
    tests: [t('test/adversarial.test.js', 'ambiguous push (response lost after server applied it): ref == our commit; a naive retry is match_count, content correct'), t('test/transfer-outcomes.test.js', 'a push applied whose response is dropped: the refs show it, the run goes on to done')],
    status: verified(git('test/adversarial.test.js', 'ambiguous push (response lost after server applied it): ref == our commit; a naive retry is match_count, content correct'), git('test/transfer-outcomes.test.js', 'a push applied whose response is dropped: the refs show it, the run goes on to done')),
    notes: ['No Artifacts evidence: no run has cut a push response from Artifacts.'],
  }),
  b({
    id: 'interrupted.push-body-cut', area: 'interrupted',
    description: 'A push request body that fails midway: nothing lands; failure before the first body pull is definite, after it ambiguous.',
    ops: [PUSH, PUSH_PACK],
    tests: [t('test/custom-exchange.test.js', 'a body stream that errors midway: a typed error from the iteration, the span records it, nothing lands'), t('test/push-pack-preabort.test.js', 'push with a pack sent as bytes: a signal already fired is the definite aborted with no request; a rejected fetch stays ambiguous')],
    status: verified(git('test/custom-exchange.test.js', 'a body stream that errors midway: a typed error from the iteration, the span records it, nothing lands'), hostile('http/partial_send_once'), hostile('http/cl_larger_than_body')),
    notes: [],
  }),
  b({
    id: 'interrupted.fetch-dropped-mid-response', area: 'interrupted',
    description: 'A fetch or advertisement response dropped or cut mid-body is a typed network error or pack_corrupt, never a partial result.',
    ops: [FETCH_PACK, READ_FILE],
    tests: [t('test/adversarial.test.js', 'HTTP-level faults at every stage: statuses, non-git bodies, stall, drop, empty'), t('test/http-options.test.js', 'a body that fails mid-read is the network error it is')],
    status: verified(git('test/space/pack-cut.test.js', 'cut: every byte offset of every pack is refused, typed, on every path')),
    notes: ['No Artifacts evidence: no run has dropped an Artifacts upload-pack response.'],
  }),
  b({
    id: 'interrupted.stall-timeouts', area: 'interrupted',
    description: 'A server that stalls before the first byte or mid-body is ended by the first-byte or idle timer, typed timeout.',
    ops: [EXCHANGE_CLOCK, CREATE_TRANSPORT],
    tests: [t('test/http-options.test.js', 'the transport reads the parsed timeout: the span carries it and a stalled request ends at it'), t('test/workerd.test.js', 'workerd: first-byte and idle timeouts; a long steady body or upload is not cut')],
    status: IMPLEMENTED,
    notes: ['Stalls are injected; no recorded run checks Artifacts\' own idle limits.'],
  }),
  b({
    id: 'interrupted.abort-during-push', area: 'interrupted',
    description: 'An external AbortSignal during a push: aborted if the body was never pulled, ambiguous once sent; git decides what landed.',
    ops: [PUSH, PUSH_PACK, RUN_TRANSFER],
    tests: [t('test/adversarial.test.js', 'external AbortSignal mid-stream'), t('test/transfer-outcomes.test.js', 'a real AbortSignal fired during the final push: ambiguous once sent, aborted when the body was never pulled; git decides what landed')],
    status: verified(git('test/transfer-outcomes.test.js', 'a real AbortSignal fired during the final push: ambiguous once sent, aborted when the body was never pulled; git decides what landed')),
    notes: ['No Artifacts evidence.'],
  }),
  b({
    id: 'interrupted.resumable-transfer', area: 'interrupted',
    description: 'A multi-step transfer paused or interrupted is resumed from refs, not from local state, and ends at the planned head.',
    ops: [RUN_TRANSFER],
    tests: [t('test/transfer-outcomes.test.js', 'maxSteps: a push that gets no answer and does not land is ambiguous, never paused; a pause names its last push')],
    status: verified(git('test/transfer-outcomes.test.js', 'maxSteps: a push that gets no answer and does not land is ambiguous, never paused; a pause names its last push')),
    notes: ['No Artifacts evidence.'],
  }),
];

const HTTP: readonly BehaviourIn<'http'>[] = [
  b({
    id: 'http.smart-http-discovery', area: 'http',
    description: 'GET info/refs?service=… then POST to the service, with Git-Protocol: version=2 on upload-pack only.',
    ops: [CREATE_TRANSPORT, DISCOVER],
    tests: [t('test/http-options.test.js', 'Git-Protocol: version=2 goes on upload-pack GET and POST, and on neither receive-pack request')],
    status: verified(git('test/space/advertisement.test.js', ADV_REAL), validatePly('discover'), plyWorker('discover/small'), phase2Git('http_version/HTTP/1.1'), phase2Git('http_version/HTTP/2')),
    notes: [],
  }),
  b({
    id: 'http.redirects', area: 'http',
    description: 'A 3xx on the advertisement is followed as git follows it (within policy); a 3xx on a POST is never followed.',
    ops: [REDIRECT_POLICY, CREATE_TRANSPORT],
    tests: [t('test/redirect.test.js', 'git oracle: origin × auth × follow × kind'), t('test/adversarial.test.js', 'I6c a 3xx is never followed: cross-origin on the GET and the POST')],
    status: verified(git('test/redirect.test.js', 'git oracle: origin × auth × follow × kind')),
    notes: ['No Artifacts evidence: Artifacts has not been seen to redirect.'],
  }),
  b({
    id: 'http.credential-forms', area: 'http',
    description: 'Bearer, Basic and URL-userinfo credentials produce the Authorization header git sends for the same input.',
    ops: [CREATE_TRANSPORT],
    tests: [t('test/adversarial.test.js', 'I6d URL userinfo authenticates fetch and push with the Authorization git sends for the same URL, byte for byte')],
    status: verified(git('test/adversarial.test.js', 'I6d URL userinfo authenticates fetch and push with the Authorization git sends for the same URL, byte for byte'), hostile('auth/basic_empty'), hostile('auth/malformed_scheme')),
    notes: [],
  }),
  b({
    id: 'http.chunked-request-body', area: 'http',
    description: 'A large push body streamed with chunked transfer-encoding (duplex half).',
    ops: [PUSH, PUSH_PACK],
    tests: [t('test/push-stream.test.js', 'a pack past INFLATE_CHUNK is streamed: duplex half, redirect error, chunked; git takes it')],
    status: verified(git('test/push-stream.test.js', 'a pack past INFLATE_CHUNK is streamed: duplex half, redirect error, chunked; git takes it'), phase2Wire('chunked_push/artifacts')),
    notes: ['ply\'s own streamed push to Artifacts is exercised by validate big20m only on the read side.'],
  }),
  b({
    id: 'http.large-response-body', area: 'http',
    description: 'A large upload-pack response is streamed under the pack caps.',
    ops: [READ_FILE, FETCH_PACK],
    tests: [t('test/adversarial.test.js', 'I4 maxPackBytes bounds the streamed body on every path: limit_exceeded within one frame of the cap, not timeout')],
    status: verified(git('test/adversarial.test.js', 'I4 maxPackBytes bounds the streamed body on every path: limit_exceeded within one frame of the cap, not timeout'), validatePly('big20m: first + warm n=25'), plyWorker('read/big'), compat('clone_full/big/v2')),
    notes: [],
  }),
  b({
    id: 'http.large-request-body', area: 'http',
    description: 'A large push request body (tens of MiB) reaches the server whole.',
    ops: [EDIT_FILE, PUSH],
    tests: [t('test/push-stream.test.js', 'memory: a 32 MiB streamed push holds well under one copy of the object (live arrayBuffers, gc-sampled)'), t('test/workerd.test.js', 'workerd: edit small file, 24 MB file, cache hit on second edit; git-verified')],
    status: verified(git('test/push-stream.test.js', 'memory: a 32 MiB streamed push holds well under one copy of the object (live arrayBuffers, gc-sampled)'), compat('large_blob_push_24m/scratch/v2')),
    notes: ['No ply push over a few MiB to Artifacts is recorded.'],
  }),
  b({
    id: 'http.sideband-keepalive', area: 'http',
    description: 'Empty band-1 keepalives while a hook runs do not end the push read.',
    ops: [PUSH],
    tests: [t('test/push-report-bound.test.js', '13,000 band-1 keepalives while a hook runs, then the report: landed')],
    status: IMPLEMENTED,
    notes: ['Keepalives are injected; whether Artifacts sends them is unrecorded.'],
  }),
  b({
    id: 'http.request-content-encoding', area: 'http',
    description: 'A gzip-encoded request body.',
    ops: [],
    tests: [],
    status: unsupported('ply never compresses a request body.', phase2Wire('gzip_request_body'), hostile('http/corrupt_gzip')),
    notes: [],
  }),
  b({
    id: 'http.content-length-framing', area: 'http',
    description: 'A request whose Content-Length disagrees with its body.',
    ops: [],
    tests: [],
    status: unsupported('ply\'s fetch sets the length from the body; it cannot misframe one.', hostile('http/cl_smaller_than_body'), hostile('http/cl_larger_than_body')),
    notes: [],
  }),
  b({
    id: 'http.expect-continue-and-dumb-http', area: 'http',
    description: 'Expect: 100-continue, and the dumb HTTP protocol.',
    ops: [],
    tests: [],
    status: unsupported('ply speaks only smart HTTP and never sends Expect.', phase2Wire('expect_100_continue'), phase2Wire('dumb_http')),
    notes: [],
  }),
];

export const BEHAVIOURS: readonly Behaviour[] = [
  ...REFS, ...CAPS, ...FETCH, ...PACK, ...PUSHES, ...CONCURRENCY, ...TAGS, ...ANCESTRY, ...ERRORS, ...INTERRUPTED, ...HTTP,
];
