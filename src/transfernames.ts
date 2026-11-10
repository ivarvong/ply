// Resumable transfer (#238), the names: a transfer's key, its temp ref, the target ref, and the checks a plan read back
// from storage gets. Branded here only, so a target ref never stands where a temp ref is deleted, and the reverse.
import type { PlyError } from './errors.js';
import { fail } from './errors.js';
import type { Result } from './result.js';
import { ok } from './result.js';
import { parseOid } from './oid.js';
import type { Refname } from './refname.js';
import { validatePushRef } from './validate.js';
import { Sha1 } from './sha1.js';
import { te } from './bytes.js';

export type { Refname };
declare const tempRefBrand: unique symbol;
// A temp ref: a pushable ref under the transfer prefix, named by the plan's key (tempRefOf).
export type TempRef = Refname & { readonly [tempRefBrand]: typeof tempRefBrand };
const isUnder = (r: Refname, prefix: string): r is TempRef => prefix.endsWith('/') && r.length > prefix.length && r.startsWith(prefix);

export const sha1Hex = (s: string): string => new Sha1().update(te.encode(s)).hex();

// The target ref, as git would push it (a ref under refs/ with two components there, never refs/@). Any value.
export function targetRef(value: unknown): Result<Refname, PlyError> {
  const r = validatePushRef(value, false);
  return r.ok ? r : fail('bad_request', `transfer: ref: ${r.error.message}`, { what: 'ref', cause: r.error });
}
// The temp ref for `key` under `prefix`, checked as a ref git would push and as one under the prefix.
export function tempRefOf(prefix: string, key: string): Result<TempRef, PlyError> {
  const r = validatePushRef(`${prefix}${key}`, false);
  if (!r.ok) return fail('bad_request', `transfer: tempPrefix: ${r.error.message}`, { what: 'tempPrefix', cause: r.error });
  return isUnder(r.value, prefix) ? ok(r.value) : fail('bad_request', 'transfer: tempPrefix must end in "/"', { what: 'tempPrefix' });
}
// A ref read back that git would push (a temp ref's prefix is the plan's, held by its hash).
export const isPushRef = (v: unknown): boolean => validatePushRef(v, false).ok;
export const isOid = (v: unknown): boolean => parseOid(v).ok;
// An Option of an id, as JSON gives it back: {"tag":"none"} or {"tag":"some","value":<id>}.
export function isOptionOid(o: unknown): boolean {
  if (typeof o !== 'object' || o === null) return false;
  const tag: unknown = Reflect.get(o, 'tag');
  return tag === 'none' || (tag === 'some' && isOid(Reflect.get(o, 'value')));
}
export const isList = (v: unknown): boolean => Array.isArray(v);
