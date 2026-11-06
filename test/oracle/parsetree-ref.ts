// parseTree as it was before #207 (src/objects.ts at c91c9cf: the mode decoded and matched by a regex, take() for the
// id, a concatenated key per directory, Object.assign entries on a per-tree prototype), its name checks from
// test/oracle/dotnames-ref.ts: kept in test/ as the oracle test/parsetree.test.js holds src/objects.ts parseTree to,
// entry by entry (mode, name, oid, offsets) and refusal by refusal (code and message).
import { fail } from '../../src/errors.js';
import type { ErrorOf } from '../../src/errors.js';
import type { Err, Result } from '../../src/result.js';
import { ok, err } from '../../src/result.js';
import { toOid } from '../../src/sha1.js';
import { td, concat, take, decodeBytes } from '../../src/bytes.js';
import { DEFAULT_LIMITS, limitError, parseLimits } from '../../src/limits.js';
import type { LimitsInput } from '../../src/limits.js';
import {
  OID_BYTES, TREE_MODE_SEP, TREE_NUL, MODE_TREE, MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_COMMIT, MODE_S_IFREG, MODE_S_IFLNK,
  MODE_OWNER_EXEC, TREE_MAX_NAME_BYTES, MODE_S_IFMT, MODE_S_IFDIR, MODE_BITS, MODE_LOW_DIGITS, TREE_SORT_SLASH, TREE_ENTRY_MIN,
} from '../../src/format.js';
import { isDotGitNameRef, isDotFileNameRef } from './dotnames-ref.ts';

type Mode = typeof MODE_BLOB | typeof MODE_EXEC | typeof MODE_LINK | typeof MODE_TREE | typeof MODE_COMMIT;
export type RefEntry = { readonly mode: Mode; readonly name: string; readonly oid: string; readonly oidOffset: number; readonly entryOffset: number };
type RefError = ErrorOf<'pack_corrupt'> | ErrorOf<'limit_exceeded'> | ErrorOf<'bad_request'>;

const cmpBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
};
const lowBits = (mode: string): number => Number.parseInt(mode.slice(-MODE_LOW_DIGITS), 8) & MODE_BITS;
const isDirMode = (mode: string): boolean => (lowBits(mode) & MODE_S_IFMT) === MODE_S_IFDIR;
function canonMode(mode: string): Mode {
  const m = lowBits(mode), type = m & MODE_S_IFMT;
  if (type === MODE_S_IFREG) return m & MODE_OWNER_EXEC ? MODE_EXEC : MODE_BLOB;
  if (type === MODE_S_IFLNK) return MODE_LINK;
  if (type === MODE_S_IFDIR) return MODE_TREE;
  return MODE_COMMIT;
}
const SLASH = Uint8Array.of(TREE_SORT_SLASH);
const badTree = (why: string): Err<ErrorOf<'pack_corrupt'>> => fail('pack_corrupt', `tree: ${why}`);
const completeTreeFrames = (data: Uint8Array, maxEntries: number): number => {
  const stop = maxEntries + 1;
  let p = 0;
  let n = 0;
  while (p < data.length && n < stop) {
    const sp = data.indexOf(TREE_MODE_SEP, p);
    if (sp < p) return n;
    const nul = data.indexOf(TREE_NUL, sp + 1);
    if (nul < sp + 1 || data.length - (nul + 1) < OID_BYTES) return n;
    n += 1;
    p = nul + 1 + OID_BYTES;
  }
  return n;
};

export function parseTreeRef(data: Uint8Array, limits: LimitsInput = DEFAULT_LIMITS): Result<RefEntry[], RefError> {
  const checked = parseLimits(limits);
  if (!checked.ok) return checked;
  const maxEntries = checked.value.maxTreeEntries;
  const wide = data.length > maxEntries * TREE_ENTRY_MIN;
  const over = wide && completeTreeFrames(data, maxEntries) > maxEntries;
  const entries: RefEntry[] = [];
  const seen = new Set<string>();
  let p = 0;
  let count = 0;
  let prevKey: Uint8Array | null = null;
  while (p < data.length) {
    if (count >= maxEntries) return err(limitError('tree entries', count + 1, maxEntries));
    const sp = data.indexOf(TREE_MODE_SEP, p);
    if (sp < p) return badTree('malformed entry');
    const nul = data.indexOf(TREE_NUL, sp + 1);
    if (nul < sp + 1) return badTree('malformed entry');
    const raw: string = td.decode(data.subarray(p, sp));
    const nameBytes: Uint8Array = data.subarray(sp + 1, nul);
    const name: string = decodeBytes(nameBytes);
    const oid = take(data, nul + 1, OID_BYTES);
    if (!oid.ok) return oid;
    const oidBytes: Uint8Array = oid.value;
    if (raw.length === 0) return badTree('empty mode');
    if (!/^[0-7]+$/u.test(raw)) return badTree('malformed mode');
    if (name.length === 0) return badTree('empty name');
    if (raw[0] === '0') return badTree('zero-padded mode');
    const mode = canonMode(raw);
    if (name.includes('/')) return badTree('full pathname');
    if (name === '.' || name === '..' || isDotGitNameRef(nameBytes)) return badTree('bad name');
    if (nameBytes.length > TREE_MAX_NAME_BYTES) return badTree('large pathname');
    if (oidBytes.every(b => b === 0)) return badTree('null sha1');
    if (isDotFileNameRef(nameBytes, 'gitmodules')) {
      if (mode === MODE_LINK) return badTree('.gitmodules is a symbolic link');
      if (mode === MODE_TREE || mode === MODE_COMMIT) return badTree('.gitmodules is not a blob');
    }
    if ((mode === MODE_TREE || mode === MODE_COMMIT) && isDotFileNameRef(nameBytes, 'gitattributes')) return badTree('.gitattributes is not a blob');
    if (seen.has(name)) return badTree(`duplicate entry ${JSON.stringify(name)}`);
    seen.add(name);
    const key: Uint8Array = isDirMode(raw) ? concat([nameBytes, SLASH]) : nameBytes;
    if (prevKey !== null && cmpBytes(prevKey, key) >= 0) return badTree('not strictly sorted');
    prevKey = key;
    if (!over) entries.push({ mode, name, oid: toOid(oidBytes), oidOffset: nul + 1, entryOffset: p });
    count += 1;
    p = nul + 1 + OID_BYTES;
  }
  return ok(entries);
}
