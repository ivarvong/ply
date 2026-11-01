// Branded file/tree mode types. The underlying representation is a canonical numeric mode string.
import { ok } from './result.js';
import type { Result } from './result.js';
import { fail } from './errors.js';
import type { ErrorOf } from './errors.js';

declare const modeBrand: unique symbol;
export type Mode = string & { readonly [modeBrand]: typeof modeBrand };

declare const blobModeBrand: unique symbol;
export type BlobMode = '100644' | '100755' | '120000' & { readonly [blobModeBrand]: typeof blobModeBrand };

export type TreeMode = '40000' & Mode;
export type CommitMode = '160000' & Mode; // gitlink (submodule)

const isBlobMode = (m: string): m is '100644' | '100755' | '120000' =>
  m === '100644' || m === '100755' || m === '120000';

export function parseMode(value: unknown): Result<Mode, ErrorOf<'bad_request'>> {
  if (typeof value !== 'string') return fail('bad_request', 'mode must be a string', { what: 'mode' });
  if (!/^(100644|100755|120000|40000|160000)$/.test(value)) return fail('bad_request', 'invalid mode', { what: 'mode' });
  return ok(value as Mode);
}

export function parseBlobMode(value: unknown): Result<BlobMode, ErrorOf<'bad_request'>> {
  if (typeof value !== 'string') return fail('bad_request', 'mode must be a string', { what: 'mode' });
  if (!isBlobMode(value)) return fail('bad_request', 'invalid blob mode', { what: 'mode' });
  return ok(value as BlobMode);
}

