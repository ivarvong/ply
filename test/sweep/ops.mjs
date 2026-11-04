// The sweep operations that only need fetch: shared by the node cell (cell.mjs) and the workerd worker
// (test/workerd/worker.mjs), so a workerd cell runs the same code path as its node twin. No node: imports here.
import { readFile, listTree } from '../../src/read.js';
import { readLog } from '../../src/log.js';
import { editFile } from '../../src/edit.js';
import { pushTree } from '../../src/tree.js';
import { mergeBranch } from '../../src/merge.js';
import { rebaseBranch } from '../../src/rebase.js';
import { GitHttp } from '../../src/client.js';
import { unwrap, unwrapAsync } from '../unwrap.js';

const author = { name: 'sweep', email: 'sweep@example.com' };
const when = 1700000000;

/** @param {ReadableStream<Uint8Array>} stream */
async function drain(stream) {
  let len = 0;
  for await (const chunk of stream) len += chunk.byteLength;
  return len;
}

/** @param {any} cell @param {any} opts @returns {Record<string, () => Promise<Record<string, unknown>>>} */
export function fetchOps(cell, opts) {
  return {
    async readFile() {
      const r = await unwrapAsync(readFile(cell.url, { ref: cell.ref ?? null, path: cell.path }, opts));
      const len = await drain(r.stream);
      return { blob: r.blob, size: r.size, len };
    },
    async listTree() {
      const r = await unwrapAsync(listTree(cell.url, { ref: cell.ref ?? null, path: cell.path ?? '' }, opts));
      return { tree: r.tree, n: r.entries.length };
    },
    async readLog() {
      const r = await unwrapAsync(readLog(cell.url, { ref: cell.ref ?? 'main', limit: cell.limit }, opts));
      return { n: r.commits.length, truncated: r.truncated };
    },
    async lsRefs() {
      const r = await unwrapAsync(unwrap(GitHttp.create(cell.url, opts)).lsRefs(cell.prefixes ?? []));
      return { n: r.refs.size, head: r.head };
    },
    async editFile() {
      const r = await unwrapAsync(editFile(cell.url, { path: cell.path, find: cell.find, replace: cell.replace, author, message: 'sweep', time: when }, opts));
      return { commit: r.newCommit };
    },
    async pushTree() {
      /** @type {Record<string, Uint8Array>} */
      const files = {};
      for (let i = 0; i < cell.nfiles; i++) files[`f/${String(i).padStart(7, '0')}.bin`] = new Uint8Array(cell.size).fill((i + 1) & 255);
      const r = await unwrapAsync(pushTree(cell.url, { ref: 'refs/heads/main', files, author, message: 'sweep', time: when }, opts));
      return { commit: r.newCommit, noop: r.noop };
    },
    async merge() {
      const r = await unwrapAsync(mergeBranch(cell.url, { ref: 'refs/heads/main', from: cell.from, author, message: 'sweep merge', time: when }, opts));
      return { outcome: r.outcome, base: r.base };
    },
    async rebase() {
      const r = await unwrapAsync(rebaseBranch(cell.url, { ref: cell.ref, onto: cell.onto, committer: author, time: when }, opts));
      return { outcome: r.outcome, oid: r.oid, commits: r.commits ?? null };
    },
    // One v2 fetch with the cell's wants, haves and deepen; the counts are what ply read from the section lines.
    async fetchPack() {
      const c = unwrap(GitHttp.create(cell.url, opts));
      const r = await unwrapAsync(c.fetchPack({ wants: cell.wants, haves: cell.haves ?? [], deepen: cell.deepen ?? 0, done: cell.done ?? true, filter: cell.filter ?? '' }));
      return { acks: r.acks.length, ready: r.ready, shallow: r.shallow.length, n: r.parsed?.stats.count ?? 0 };
    },
  };
}

/** A typed refusal (a ply error with a code) or a crash, as one JSON-able record. @param {unknown} e */
export function failure(e) {
  const err = /** @type {{ code?: unknown, name?: string, message?: string, got?: unknown, max?: unknown, what?: unknown }} */ (e);
  const typed = !!err && typeof err.code === 'string' && err.name !== 'TypeError' && err.name !== 'RangeError';
  return {
    status: typed ? 'refused' : 'crash',
    code: typeof err?.code === 'string' ? err.code : null,
    name: err?.name ?? null,
    what: typeof err?.what === 'string' ? err.what : null,
    got: typeof err?.got === 'number' ? err.got : null,
    max: typeof err?.max === 'number' ? err.max : null,
    msg: String(err?.message ?? e).slice(0, 300),
  };
}
