// Full entry point. Bundles that only edit should import 'ply/edit' (src/edit.ts): it pulls in only the free
// functions it uses. Everything here is tree-shakeable (no classes on the hot path, no module side effects).
// Re-exports only: each name's documentation is on its declaration.

// ---- write: edit, commit, push a tree ----
export { editFile, scanInit, scanStep, scanFinish, validateSpec, decideHead, lookupEntry, memFromScan, memAttrs, isLfsPointerPrefix } from './edit.js';
export { buildCommitObjects, withCommitData } from './commit-build.js';
export type { Change, CommitChangesSpec, CommitChangesResult } from './changes.js';
export { commitChanges } from './changes.js';
export { pushTree, fileEntries, buildTree, selectObjects, validateTreeSpec } from './tree.js'; // the Node directory walk is 'ply/tree-node'
export { checkoutTree, treeFiles, canonMode } from './checkout.js'; // writing into a directory is 'ply/checkout-node'

// ---- read ----
export type { AbbrevResolution, OpenedBlob } from './read.js';
export type { Miss, CommitMiss } from './errors.js';
export { readFile, listTree, readCommit, commitView, resolveCommit, resolveAbbrev, refCandidates, entryType, lsMode, walkPath, walkCommit, fetchCommit, openBlob, readBlob } from './read.js';
export { readLog, logWindow, logOn } from './log.js';

// ---- refs, merge, rebase, sign ----
export { mergeBranch, fastForward, deleteRef, mergeTrees, mergeBase, threeWay, bestBases } from './merge.js';
export { createBranch, deleteBranch, createTag, deleteTag, listRefs } from './refops.js';
export { syncRef } from './sync.js';
export { rebaseBranch, cherryPick, revertCommit, pickCommit, linearChain } from './rebase.js';
export { ed25519Signer, generateSigner, signCommit, withGpgsig, sshPublicKey, armor } from './sign.js';

// ---- wire ----
export { GitHttp, lsRefs, lsRefsBody, fetchBody, v2Init, v2Step, packStream, fetchObject, spInit, spStep, spFinish, fetchPack, negotiate, push, pushWithOptions, receiveCaps, discover, pushBody, forgetQuirks } from './client.js';
export type { Transport } from './transport.js';
export type { ExportLine, Exporter, EndedSpan, SpanSink, FlatSpan } from './otel.js';
export type { Limits, CheckedLimits, LimitsInput } from './limits.js';
export type { FetchOpts, SpState } from './fetch.js';
export type { OperationOpts, Outcome } from './operation.js';
export type { PackObject } from './push.js';

// ---- ids, names, paths ----
export type { Oid } from './oid.js';
export { parseOid, parseCommitId, ZERO_OID } from './oid.js';
export { OID_HEX_CHARS, MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_TREE, MODE_COMMIT, BLOB_MODES } from './format.js';
export type { Refname, BranchName, TagName } from './refname.js';
export type { Path } from './path.js';
export { parseRefname, parseBranchName, parseTagName } from './refname.js';
export { parsePath } from './path.js';

// ---- objects and packs ----
export type { PackLayout, PackLayoutObject, PackBase, ObjBase, ObjSize, DeltaProgram, PackObjectInput, ParsedObject, ParsedPack, ResolvedObjType } from './packresolve.js';
export type { DeltaOp } from './pack.js';
export { spliceDelta, encodeDeltaOps, buildPack, encodeObjHeader, zlibDeflate, parsePack, resolvePack, describePack, applyDelta, parseDelta, applyProgram, deltaOps, makeDelta, packParseOpts } from './pack.js';
export { encodeDelta, planDeltas } from './delta.js'; // pushing a local repository is 'ply/repo-node'
export { objectsForPack, reachableObjects, mapStore } from './packwalk.js';
export { encodePackIndex, indexPack, layoutPackIndex } from './packindex.js';
export { inflate } from './inflate.js';

// ---- pulls: bytes in as they arrive, one piece out at a time; a refusal is a value that sticks (#172) ----
export { inflateInit, inflateReset, inflateFeed, inflatePull, inflateEnd, inflateUnread, declaredBound, cappedBound, zlibWrap, rawWrap } from './inflatestream.js';
export type { InflateStream, InflatePiece, InflateStreamOpts, StreamBound, StreamWrap, InflateStats, InflateError } from './inflatestream.js';
export { parsePackInit, parsePackFeed, parsePackPull, parsePackEnd, parsePackClose, packScanOpts, workBudget, WORK_BUDGET, RETAIN_BUDGET } from './packstream.js';
export type { PackScan, PackPiece, PackScanOpts, PackError, ScanBudget } from './packstream.js';
export { sidebandStep } from './fetch.js';
export type { SidebandCounters, SidebandPiece, Sidebanded, SidebandError } from './fetch.js';
export { Sha1, toHex, fromHex, streamingSha1 } from './sha1.js';
export { hashObject, parseTree, encodeTree, treeSort, parseCommit, encodeCommit, parseTag, encodeTag, ident, TYPE, TYPE_NAME, TYPE_ID } from './objects.js';
export { pkt, pkts, pktInit, pktStep, pktFinish } from './pktline.js';

// ---- tracing, limits, errors, transport ----
export { Tracer, Span, KIND, arrayExporter, consoleExporter, flattenLine, fromAny } from './otel.js';
export { DEFAULT_LIMITS, WORKER_LIMITS, LIMIT_OBJECT_OVERHEAD, withLimits, parseLimits, limitError } from './limits.js';
export { CODES, RETRY, fail, plyError, isPlyCode, retryPolicy, isRetryable, ambiguousAfterPush } from './errors.js';
export { CODE_DOCS } from './errors-doc.js';
export { operation, verifyRef } from './operation.js';
export { createTransport, redactUrl } from './http.js';
export { cachingFetch, memoryCache, isCacheableFetch, cacheKey, exchangeKind, isPureFetch, verifyFetchAnswer, parseUploadPackRequest } from './packcache.js';
export { BLOB_CACHE_MAX_BYTES, BLOB_CACHE_MAX_AGE_SECONDS, BLOB_CACHE_HEADER, BLOB_OID_HEADER } from './blobcache.js';
export { isFilterRejection, isFilterRefusal } from './fetch.js';
export { fetchPackFiltered } from './fetchpack.js';
export { validateIdent, validateRef, validatePath } from './validate.js';
export { compareVersionRefnames } from './refs.js';
export { concat } from './bytes.js';
export { assertNever } from './result.js';
