// Branded refname types. A `Refname` is any fully qualified ref starting with `refs/`.
// Branch and tag names are stricter subsets. Parsing uses the existing validate.ts rules.
import { ok } from './result.js';
import type { Result } from './result.js';
import { fail } from './errors.js';
import type { ErrorOf } from './errors.js';
import { validateRef, validatePushRef } from './validate.js';

declare const refBrand: unique symbol;
declare const branchBrand: unique symbol;
declare const tagBrand: unique symbol;

export type Refname = string & { readonly [refBrand]: typeof refBrand };
export type BranchName = string & { readonly [branchBrand]: typeof branchBrand };
export type TagName = string & { readonly [tagBrand]: typeof tagBrand };

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const asRef = (v: string): Refname => v as Refname;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const asBranch = (v: string): BranchName => v as BranchName;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const asTag = (v: string): TagName => v as TagName;

export function parseRefname(value: unknown): Result<Refname, ErrorOf<'bad_request'>> {
  try { return ok(asRef(validateRef(value))); }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  catch (e) { return fail('bad_request', (e as { message?: string }).message ?? 'invalid ref', { what: 'ref', cause: e }); }
}

// A pushable branch name (refs/heads/* with at least two levels after refs/).
export function parseBranchName(value: unknown): Result<BranchName, ErrorOf<'bad_request'>> {
  try {
    const ref = validatePushRef(String(value), false);
    if (!ref.startsWith('refs/heads/')) return fail('bad_request', 'must start with refs/heads/', { what: 'branch' });
    return ok(asBranch(ref));
  } catch (e) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return fail('bad_request', (e as { message?: string }).message ?? 'invalid branch', { what: 'branch', cause: e });
  }
}

export function parseTagName(value: unknown): Result<TagName, ErrorOf<'bad_request'>> {
  try {
    const ref = validateRef(value);
    if (!ref.startsWith('refs/tags/')) return fail('bad_request', 'must start with refs/tags/', { what: 'tag' });
    return ok(asTag(ref));
  } catch (e) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return fail('bad_request', (e as { message?: string }).message ?? 'invalid tag', { what: 'tag', cause: e });
  }
}

