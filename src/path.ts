// Branded repository path type (slash-separated, validated) and helpers.
// A Path is a normalized string that validatePath accepted under configured limits.
import { ok } from './result.js';
import type { Result } from './result.js';
import { fail } from './errors.js';
import type { ErrorOf } from './errors.js';
import { validatePath } from './validate.js';
import type { Limits } from './limits.js';

declare const pathBrand: unique symbol;
export type Path = string & { readonly [pathBrand]: typeof pathBrand };

function isBrandedPath(value: string, comps: readonly string[]): value is Path {
  return value === comps.join('/');
}

export type ParsedPath = { readonly path: Path; readonly components: readonly string[] };

// @decoder parsePath prefix=path
export function parsePath(value: unknown, limits: Partial<Limits> | null | undefined): Result<ParsedPath, ErrorOf<'bad_request'>> {
  try {
    const comps = validatePath(value, limits);
    const joined = comps.join('/');
    if (!isBrandedPath(joined, comps)) return fail('bad_request', 'invalid path', { what: 'path' });
    return ok({ path: joined, components: comps });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid path';
    return fail('bad_request', msg, { what: 'path', cause: e });
  }
}

