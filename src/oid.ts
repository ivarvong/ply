// Object ids as a type. A full SHA-1 name is 40 lowercase hex characters (gitformat-pack(5)). git's revision
// parser also accepts a unique abbreviation, a ref name, and uppercase hex; parseOid does not. The zero id is a
// real object name (a compare-and-swap "ref does not exist") and not a commit.
import { ok } from './result.js';
import type { Result } from './result.js';
import { fail } from './errors.js';
import type { ErrorOf } from './errors.js';
import { OID_HEX_CHARS, HEX_DIGIT_MIN, HEX_DIGIT_MAX, HEX_LOWER_MIN, HEX_LOWER_MAX, ZERO_OID as ZERO_OID_TEXT } from './format.js';

declare const oidBrand: unique symbol;
/** 40 lowercase hex characters. Not an abbreviation, a ref name, or uppercase. */
export type Oid = string & { readonly [oidBrand]: typeof oidBrand };

// The brand is a type: a string of OID_HEX_CHARS characters is an Oid. parseOid calls this only after the hex check.
// Forty '0' characters are the zero id, so the fallback (a string that was not that long) is still an Oid.
function isBrandedOid(value: string): value is Oid {
  return value.length === OID_HEX_CHARS;
}
function oidOf(value: string): Oid {
  if (isBrandedOid(value)) return value;
  return oidOf(ZERO_OID_TEXT);
}

export const ZERO_OID: Oid = oidOf(ZERO_OID_TEXT);

// codePointAt's type includes undefined; an index inside the string is a code point. -1 is not hex.
function codeAt(value: string, i: number): number {
  const c = value.codePointAt(i);
  if (c === undefined) return -1;
  return c;
}

// 40 lowercase hex. A String object is not a string. Anything else is bad_request: the wrong type, the wrong length,
// or a character that is not `0-9` or `a-f`. A strict prefix of a valid id is the length error (prefix closure).
// @decoder parseOid prefix=oid
export function parseOid(value: unknown): Result<Oid, ErrorOf<'bad_request'>> {
  if (typeof value !== 'string') return fail('bad_request', 'oid must be a string', { what: 'oid', got: value });
  if (value.length !== OID_HEX_CHARS) return fail('bad_request', `oid must be ${OID_HEX_CHARS} lowercase hex characters`, { what: 'oid', got: value });
  for (let i = 0; i < value.length; i++) {
    const c = codeAt(value, i);
    const digit = c >= HEX_DIGIT_MIN && c <= HEX_DIGIT_MAX;
    const lower = c >= HEX_LOWER_MIN && c <= HEX_LOWER_MAX;
    if (!digit && !lower) return fail('bad_request', 'oid must be lowercase hex', { what: 'oid', got: value });
  }
  return ok(oidOf(value));
}

// parseOid, and bad_request when the id is ZERO_OID. The zero id names no commit. A strict prefix is not a commit id.
// @decoder parseCommitId prefix=commit-id
export function parseCommitId(value: unknown): Result<Oid, ErrorOf<'bad_request'>> {
  const parsed = parseOid(value);
  if (!parsed.ok) return parsed;
  if (parsed.value === ZERO_OID) return fail('bad_request', 'the zero oid is not a commit', { what: 'commit', got: value });
  return ok(parsed.value);
}
