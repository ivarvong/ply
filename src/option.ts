// The package root's matchOption (#301-3, #296). Inside ply, result.ts's matchOption is the eliminator: its
// arguments are typed and it returns the branch's value. At the root a caller's argument is unchecked input, and every
// public function answers a wrong shape or a callback that throws with an Err, never a throw (README "Errors"), so this
// one checks both arguments, runs the branch, and returns its value as Ok.
import type { ErrorOf } from './errors.js';
import { callbackFailed, fail } from './errors.js';
import type { Option, OptionHandlers, Result } from './result.js';
import { err, isNone, isSome, matchOption, ok } from './result.js';

const isHandlers = (h: unknown): boolean => typeof h === 'object' && h !== null && 'some' in h && 'none' in h && typeof h.some === 'function' && typeof h.none === 'function';

export function matchOptionChecked<T, R>(o: Option<T>, h: OptionHandlers<T, R>): Result<R, ErrorOf<'bad_request'>> {
  if (!isSome(o) && !isNone(o)) return fail('bad_request', 'matchOption: the option must be some(value) or none', { what: 'option' });
  if (!isHandlers(h)) return fail('bad_request', 'matchOption: the handlers must be { some, none } functions', { what: 'handlers' });
  try {
    return ok(matchOption(o, h));
  } catch (e) {
    return err(callbackFailed('matchOption handler', e));
  }
}
