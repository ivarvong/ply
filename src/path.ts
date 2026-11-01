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

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const asPath = (v: string): Path => v as Path;

export type ParsedPath = { readonly path: Path; readonly components: readonly string[] };

export function parsePath(value: unknown, limits: Partial<Limits> | null | undefined): Result<ParsedPath, ErrorOf<'bad_request'>> {
  try {
    const comps = validatePath(value, limits);
    return ok({ path: asPath(comps.join('/')), components: comps });
  } catch (e) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return fail('bad_request', (e as { message?: string }).message ?? 'invalid path', { what: 'path', cause: e });
  }
}

