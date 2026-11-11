// What commitChanges has read about the ref its single streamed edit writes: the compare-and-swap editFile's push must
// assert. It travels beside the edit's options, keyed by that options object, and not in them: this module is not a
// package entry (package.json "exports") and no entry re-exports it, so only this library can set an expectation and
// editFile's public options stay as they were.
import { fromNullish } from './absent.js';
import { getOrElse } from './result.js';

const expectations = new WeakMap<object, boolean>();

// `create` true: the ref was absent (zero old oid). false: it existed (the parent is asserted).
export function expecting<O extends object>(options: O, create: boolean): O {
  expectations.set(options, create);
  return options;
}

// The expectation set for exactly this options object; null when there is none (the edit's own reads decide).
export function expectedCreate(options: object): boolean | null {
  return getOrElse<boolean | null>(fromNullish(expectations.get(options)), null);
}
