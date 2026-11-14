// README "Results": decodeSavedIndex's error is one union discriminated by `tag` (#301-3, #296), so a switch over
// its eight tags with no default type-checks as exhaustive, and the root matchOption returns a Result.
import { assertNever, decodeSavedIndex, matchOption, some } from '../../src/index.js';

declare const bytes: Uint8Array;
const r = decodeSavedIndex(bytes, { trailer: '0'.repeat(40), bytes: 32 });
if (!r.ok) {
  const e = r.error;
  switch (e.tag) {
    case 'not_saved_index': case 'version': case 'truncated': case 'corrupt': case 'other_pack': case 'malformed': case 'limit_exceeded': break;
    case 'bad_argument': { const what: 'bytes' | 'want' = e.what; void what; break; }
    default: assertNever(e);
  }
}
const m = matchOption(some(1), { some: n => n + 1, none: () => 0 });
if (m.ok) { const n: number = m.value; void n; } else { const code: 'bad_request' = m.error.code; void code; }
