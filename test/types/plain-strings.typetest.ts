// Every public entry takes refs and paths as plain `string`: each checks them at run time (validateRef, validatePushRef,
// validatePath → bad_request) and keeps the Refname / Path brands inside. readme.typetest.ts covers the README calls;
// this file covers the rest. `tsc --noEmit` must pass.
import { editFile, validateSpec } from '../../src/edit.js';
import { commitChanges, type Change } from '../../src/changes.js';
import { pushTree } from '../../src/tree.js';
import { pushDir } from '../../src/tree-node.js';
import { readFile, listTree, readCommit } from '../../src/read.js';
import { readLog } from '../../src/log.js';
import { checkoutTree } from '../../src/checkout.js';
import { checkoutDir } from '../../src/checkout-node.js';
import { mergeBranch, fastForward, deleteRef } from '../../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit, pickCommit } from '../../src/rebase.js';
import { createBranch, deleteBranch, createTag } from '../../src/refops.js';
import { GitHttp } from '../../src/client.js';
import { push, type Command } from '../../src/push.js';
import { Tracer } from '../../src/otel.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import type { Transport } from '../../src/transport.js';

declare const url: string;
declare const ref: string;
declare const path: string;
declare const oid: string;
declare const t: Transport;
const tracer = new Tracer();
const author = { name: 'a', email: 'a@x' };

await editFile(url, { ref, base: ref, path, find: 'a', replace: 'b', author, message: 'm' }, { tracer });
void validateSpec({ ref, path, find: 'a', replace: 'b', author, message: 'm' }, DEFAULT_LIMITS);
const changes: Change[] = [
  { kind: 'create', path, content: 'x' }, { kind: 'write', path, content: 'x', mode: '100755' },
  { kind: 'edit', path, find: 'a', replace: 'b' }, { kind: 'delete', path }, { kind: 'rename', from: path, to: path },
];
await commitChanges(url, { ref, base: ref, changes, author, message: 'm' }, { tracer });
await pushTree(url, { ref, base: ref, files: { [path]: 'x' }, author, message: 'm' }, { tracer });
await pushDir(url, { dir: '.', ref, author, message: 'm' }, { tracer });
await readFile(url, { ref, path }, { tracer });
await listTree(url, { ref, path }, { tracer });
await readCommit(url, { ref }, { tracer });
await readLog(url, { ref, limit: 5 }, { tracer });
await checkoutTree(url, { ref, path }, { tracer });
await checkoutDir(url, { dir: './out', ref, path }, { tracer });
await checkoutDir(url, { dir: './out' }, { tracer });
await mergeBranch(url, { ref, from: ref, author }, { tracer });
await rebaseBranch(url, { ref, onto: ref, committer: author }, { tracer });
await cherryPick(url, { ref, commit: oid, committer: author }, { tracer });
await revertCommit(url, { ref, commit: oid, committer: author }, { tracer });
await pickCommit(url, { ref, commit: oid, committer: author, revert: true }, { tracer });
await createBranch(url, { ref, from: ref }, { tracer, verify: true });
await deleteBranch(url, { ref, expected: oid }, { tracer });
await deleteBranch(url, { ref }, { tracer });
await createTag(url, { name: ref, target: ref, message: 'm', tagger: author }, { tracer });
await fastForward(t, { ref, from: oid, to: oid });
await deleteRef(t, { ref, oid });
const command: Command = { ref, oldOid: oid, newOid: oid };
await push(t, { ref, oldOid: oid, newOid: oid, objects: [] });
await push(t, { commands: [command] });
const client = GitHttp.create(url);
if (client.ok) await client.value.push({ ref, oldOid: oid, newOid: oid, objects: [], atomic: false });

// HttpOptions in, HttpSettings out (#156): settings come only from parseHttpOptions
import { parseHttpOptions, type HttpSettings } from '../../src/http.js';
const settings = parseHttpOptions(url, { userAgent: 'x', limits: DEFAULT_LIMITS });
if (settings.ok) { const s: HttpSettings = settings.value; const n: number = s.requestTimeoutMs; void n; }
// @ts-expect-error a plain record is not HttpSettings (the brand)
const forgedSettings: HttpSettings = { requestTimeoutMs: 1 };
void forgedSettings;
