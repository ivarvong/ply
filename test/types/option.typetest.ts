// Compile-time checks for Option's algebra and the absence boundary. Every @ts-expect-error must stay an error.
import { fromNullable, fromNullish, readKey, unwrapOrAbsent } from '../../src/absent.js';
import { flatMapOption, getOrElse, mapOption, none, some, type Option } from '../../src/result.js';

// A raw platform missing value is not an Option. It has to come through the boundary.
// @ts-expect-error the platform missing value is not Some or None
const direct: Option<number> = undefined;

declare const mixed: number | null | undefined;
const cleaned: Option<number> = fromNullish(mixed);
const num: Option<number> = fromNullable(1 as number | undefined);
const text: Option<string> = mapOption(num, n => String(n));
const flat: Option<number> = flatMapOption(text, s => (s.length > 0 ? some(s.length) : none));
const fallback: number = getOrElse(flat, 0);
const back: number | undefined = unwrapOrAbsent(flat);

const row: { readonly a: number; readonly b?: number } = { a: 1 };
const present: Option<number> = readKey(row, 'a');
const missing: Option<number> = readKey(row, 'b');

void direct; void cleaned; void fallback; void back; void present; void missing;
