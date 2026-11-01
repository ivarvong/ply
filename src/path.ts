// Branded repository path type (slash-separated, validated) and helpers.
// A Path is a normalized string that validatePath accepted under configured limits.
import type { Result } from './result.js';
import { mapErr } from './result.js';
import { plyError } from './errors.js';
import type { ErrorOf } from './errors.js';
import { validatePathResult } from './validate.js';
import type { Limits } from './limits.js';
import type { Input } from './absent.js';

declare const pathBrand: unique symbol;
// validate.ts grants the brand: validatePathResult returns a Path only after every check.
export type Path = string & { readonly [pathBrand]: typeof pathBrand };

export type ParsedPath = { readonly path: Path; readonly components: readonly string[] };

// Every refusal is a bad_request about the path (`what: 'path'`), whatever it checked (a limit, a component, the bytes);
// the validator's own error is its cause.
// @decoder parsePath prefix=path
export function parsePath(value: unknown, limits: Input<Limits> | null = null): Result<ParsedPath, ErrorOf<'bad_request'>> {
  return mapErr(validatePathResult(value, limits), e => plyError('bad_request', e.message, { what: 'path', cause: e }));
}
