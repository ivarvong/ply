// Parse once (#156): what the parsers return is branded, and the brand is still a string to a reader. `tsc --noEmit`
// must pass; every @ts-expect-error must still be an error.
import type { Oid } from '../../src/oid.js';
import { hashObject, parseTree, type ObjType, type TreeEntry } from '../../src/objects.js';
import { parseLsRefLine, type LsRef } from '../../src/lsrefs.js';
import { readObjHeader, parsePack } from '../../src/packresolve.js';
import { validateWire, type WireField } from '../../src/validate.js';
import { fetchBody, fetchRequest, type FetchRequest } from '../../src/fetch.js';
import { Sha1 } from '../../src/sha1.js';

// object ids made from bytes in hand
const hashed: Oid = hashObject('blob', new Uint8Array(0));
const digest: Oid = new Sha1().hex();
const text: string = hashed;
void digest; void text;
const tree = parseTree(new Uint8Array(0));
if (tree.ok) for (const e of tree.value) { const entry: TreeEntry = e; const id: Oid = entry.oid; void id; }
const line = parseLsRefLine('');
if (line.ok && line.value !== null) { const r: LsRef = line.value; const id: Oid = r.oid; const peeled: Oid | null = r.peeled; void id; void peeled; }

// a pack header's type is one of the six, and a parsed REF base is an Oid
const header = readObjHeader(new Uint8Array(0), 0);
if (header.ok) { const t: ObjType = header.value.type; void t; }
const pack = parsePack(new Uint8Array(0));
if (pack.ok) for (const o of pack.value.objects) { const t: ObjType = o.type; const base: Oid | null = o.baseOid; void t; void base; }

// a wire field is made only by validateWire
// @ts-expect-error a plain string is not a WireField
const forged: WireField = 'x';
void forged;
const wire = validateWire('x', 'field');
if (wire.ok) { const w: WireField = wire.value; const s: string = w; void s; }

// FetchOpts stays plain strings in; the parsed request is wire fields
void fetchBody({ wants: ['a'.repeat(40)], filter: 'blob:none', deepen: 1 });
const req = fetchRequest({ wants: ['a'.repeat(40)] });
if (req.ok) { const r: FetchRequest = req.value; for (const w of r.wants) { const want: Oid = w; void want; } for (const h of r.haves) { const have: WireField = h; void have; } }
// @ts-expect-error a FetchRequest is not built from plain strings
const forgedReq: FetchRequest = { wants: ['x'], haves: [], shallows: [], deepenNot: [], filter: null, deepen: 0, deepenSince: 0, deepenRelative: false, thinPack: false, ofsDelta: true, includeTag: false, noProgress: true, done: true };
void forgedReq;

// part 2: listed names, parsed commits, tree entries, ids at the entries, the edit plan
import type { ListedName } from '../../src/lsrefs.js';
import { parseCommit, treeEntryOf, encodeEntries, type EntryOf, type Mode } from '../../src/objects.js';
import { mergeBaseOf, type MergeBase } from '../../src/merge.js';
import { objectAt } from '../../src/fetch.js';
import { commitById } from '../../src/commit.js';
import { validateSpec, type EditBase } from '../../src/edit.js';
import type { Transport } from '../../src/transport.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
declare const tr: Transport;
if (line.ok && line.value !== null) { const n: ListedName = line.value.name; const s: string = n; void s; }
// @ts-expect-error a plain string is not a listed name
const forgedName: ListedName = 'HEAD';
void forgedName;
const commit = parseCommit(new Uint8Array(0));
if (commit.ok) { const tree: Oid = commit.value.tree; const parents: readonly Oid[] = commit.value.parents; void tree; void parents; }
const entry = treeEntryOf({ mode: '100644', name: 'f', oid: 'a'.repeat(40) });
if (entry.ok) { const e: EntryOf = entry.value; const m: Mode = e.mode; const id: Oid = e.oid; void m; void id; void encodeEntries([e]); }
// @ts-expect-error encodeEntries takes parsed entries, not plain strings
void encodeEntries([{ mode: '100644', name: 'f', oid: 'a'.repeat(40) }]);
// @ts-expect-error the internals take an Oid
void objectAt(tr, 'a'.repeat(40));
// @ts-expect-error the internals take an Oid
void commitById(tr, 'a'.repeat(40));
// @ts-expect-error the internals take an Oid
void mergeBaseOf(tr, 'a'.repeat(40), 'a'.repeat(40));
if (header.ok) { void objectAt(tr, hashed); void commitById(tr, hashed); }
const mb = await mergeBaseOf(tr, hashed, hashed);
if (mb.ok) { const r: MergeBase = mb.value; const base: Oid | null = r.base; void base; for (const [k] of r.commits) { const id: Oid = k; void id; } }
const plan = validateSpec({ path: 'a', find: 'x', replace: 'y', author: { name: 'n', email: 'e' }, message: 'm' }, DEFAULT_LIMITS);
if (plan.ok) { const b: EditBase = plan.value.base; if (b.kind === 'commit') { const id: Oid = b.oid; void id; } const h: Oid | null = plan.value.head; void h; }
