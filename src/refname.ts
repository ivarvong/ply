// Branded refname types. A `Refname` is any fully qualified ref starting with `refs/`.
// Branch and tag names are stricter subsets. Parsing uses the validate.ts rules, which grant the Refname brand.
import { ok, mapErr } from './result.js';
import type { Result } from './result.js';
import { fail, plyError, thrown } from './errors.js';
import type { ErrorOf } from './errors.js';
import { validateRefResult, validatePushRefResult } from './validate.js';

declare const refBrand: unique symbol;
declare const branchBrand: unique symbol;
declare const tagBrand: unique symbol;

export type Refname = string & { readonly [refBrand]: typeof refBrand };
export type BranchName = string & { readonly [branchBrand]: typeof branchBrand };
export type TagName = string & { readonly [tagBrand]: typeof tagBrand };

function isBranchName(value: string): value is BranchName { return value.startsWith('refs/heads/'); }
function isTagName(value: string): value is TagName { return value.startsWith('refs/tags/'); }

type Bad = ErrorOf<'bad_request'>;
// Each parser re-labels a validator's refusal for the thing parsed (`what`), with the validator's error as its cause.

// @decoder parseRefname prefix=refname
export function parseRefname(value: unknown): Result<Refname, Bad> {
  return mapErr(validateRefResult(value), e => plyError('bad_request', e.message, { what: 'ref', cause: e }));
}

// A pushable branch name (refs/heads/* with at least two levels after refs/).
// @decoder parseBranchName prefix=refname
export function parseBranchName(value: unknown): Result<BranchName, Bad> {
  const ref = mapErr(validatePushRefResult(String(value), false), e => plyError('bad_request', e.message, { what: 'branch', cause: e }));
  if (!ref.ok) return ref;
  if (!isBranchName(ref.value)) return fail('bad_request', 'must start with refs/heads/', { what: 'branch' });
  return ok(ref.value);
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
export function parseTagName(value: unknown): Result<TagName, Bad> {
  const ref = mapErr(validateRefResult(value), e => plyError('bad_request', e.message, { what: 'tag', cause: e }));
  if (!ref.ok) return ref;
  if (!isTagName(ref.value)) return fail('bad_request', 'must start with refs/tags/', { what: 'tag' });
  return ok(ref.value);
}
