// Branded refname types. A `Refname` is any fully qualified ref starting with `refs/`.
// Branch and tag names are stricter subsets. Parsing uses the existing validate.ts rules.
import { ok } from './result.js';
import type { Result } from './result.js';
import { fail, thrown } from './errors.js';
import type { ErrorOf } from './errors.js';
import { validateRef, validatePushRef } from './validate.js';

declare const refBrand: unique symbol;
declare const branchBrand: unique symbol;
declare const tagBrand: unique symbol;

export type Refname = string & { readonly [refBrand]: typeof refBrand };
export type BranchName = string & { readonly [branchBrand]: typeof branchBrand };
export type TagName = string & { readonly [tagBrand]: typeof tagBrand };

function isRefname(value: string): value is Refname { return value.startsWith('refs/'); }
function isBranchName(value: string): value is BranchName { return value.startsWith('refs/heads/'); }
function isTagName(value: string): value is TagName { return value.startsWith('refs/tags/'); }

// @decoder parseRefname prefix=refname
export function parseRefname(value: unknown): Result<Refname, ErrorOf<'bad_request'>> {
  try {
    const s = validateRef(value);
    if (!isRefname(s)) return fail('bad_request', 'invalid ref', { what: 'ref' });
    return ok(s);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid ref';
    return fail('bad_request', msg, { what: 'ref', cause: e });
  }
}

// A pushable branch name (refs/heads/* with at least two levels after refs/).
// @decoder parseBranchName prefix=refname
export function parseBranchName(value: unknown): Result<BranchName, ErrorOf<'bad_request'>> {
  try {
    const ref = validatePushRef(String(value), false);
    if (!isBranchName(ref)) return fail('bad_request', 'must start with refs/heads/', { what: 'branch' });
    return ok(ref);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid branch';
    return fail('bad_request', msg, { what: 'branch', cause: e });
  }
}

// A refname the source spells, checked once when the module loads. A bad literal is a programmer error.
function constantRefname(value: string): Refname {
  const r = parseRefname(value);
  if (!r.ok) throw thrown('internal', `${value} is not a refname`);
  return r.value;
}
// The branch an edit targets when the caller names none.
export const DEFAULT_REF: Refname = constantRefname('refs/heads/main');

// @decoder parseTagName prefix=refname
export function parseTagName(value: unknown): Result<TagName, ErrorOf<'bad_request'>> {
  try {
    const ref = validateRef(value);
    if (!isTagName(ref)) return fail('bad_request', 'must start with refs/tags/', { what: 'tag' });
    return ok(ref);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid tag';
    return fail('bad_request', msg, { what: 'tag', cause: e });
  }
}

