// Full entry point. Bundles that only edit should import 'ply/edit' (src/edit.js): it pulls in only the free
// functions it uses. Everything here is tree-shakeable (no classes on the hot path, no module side effects).
export { editFile, scanInit, scanStep, scanFinish, validateSpec, decideHead, lookupEntry, buildCommitObjects, memFromScan, memAttrs, isLfsPointerPrefix, withCommitData } from './edit.js';
export { pushTree, fileEntries, buildTree, selectObjects, validateTreeSpec } from './tree.js'; // the Node directory walk is 'ply/tree-node'
export { checkoutTree, treeFiles, canonMode } from './checkout.js'; // writing into a directory is 'ply/checkout-node'
export { readFile, listTree, readCommit, commitView, resolveCommit, refCandidates, entryType, lsMode } from './read.js';
export { readLog, logWindow } from './log.js';
export { mergeBranch, fastForward, deleteBranch, mergeTrees, mergeBase, threeWay, bestBases } from './merge.js';
export { rebaseBranch, cherryPick, revertCommit, pickCommit, linearChain, carriedExtra } from './rebase.js';
export { ed25519Signer, generateSigner, signCommit, withGpgsig, sshPublicKey, armor } from './sign.js';
export { GitHttp, lsRefs, lsRefsBody, fetchBody, v2Init, v2Step, packStream, fetchObject, spInit, spStep, spFinish, fetchPack, negotiate, push, pushWithOptions, receiveCaps, discover, pushBody } from './client.js';
/**
 * 40 lowercase hex characters. git also accepts abbreviations, ref names, and uppercase hex; this type does not.
 * @typedef {import('./oid.js').Oid} Oid
 */
export { parseOid, parseCommitId, ZERO_OID } from './oid.js';
export { OID_HEX_CHARS, MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_TREE, MODE_COMMIT, BLOB_MODES } from './format.js';
export { spliceDelta, buildPack, encodeObjHeader, zlibDeflate, parsePack, resolvePack, applyDelta, makeDelta, packParseOpts } from './pack.js';
export { inflate, adler32 } from './inflate.js';
export { Sha1, toHex, fromHex, streamingSha1 } from './sha1.js';
export { hashObject, parseTree, encodeTree, treeSort, parseCommit, encodeCommit, encodeTag, ident, TYPE, TYPE_NAME } from './objects.js';
export { pkt, pkts, pktInit, pktStep, pktFinish } from './pktline.js';
export { Tracer, Span, KIND, arrayExporter, consoleExporter, flattenLine, fromAny, cpuNow, cpuSince } from './otel.js';
export { DEFAULT_LIMITS, withLimits, limitError } from './limits.js';
export { CODES, RETRY, thrown as fail, isPlyCode, retryPolicy, isRetryable, ambiguousAfterPush } from './errors.js';
export { CODE_DOCS } from './errors-doc.js';
export { operation, verifyRef } from './operation.js';
export { createTransport, redactUrl } from './http.js';
export { cachingFetch, memoryCache, isCacheableFetch, cacheKey } from './packcache.js';
export { isFilterRejection } from './fetch.js';
export { validateIdent, validateRef, validatePath } from './validate.js';
export { concat } from './bytes.js';
