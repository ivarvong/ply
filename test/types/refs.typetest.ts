// compareVersionRefnames' error is a closed union on kind.
import { assertNever, matchKind } from '../../src/result.js';
import type { VersionRefnameError } from '../../src/refs.js';

declare const e: VersionRefnameError;
const which = matchKind(e, {
  not_string: x => x.which,
  not_bytes: x => x.which,
});
void which;
const missing = (err: VersionRefnameError): string => {
  switch (err.kind) {
    case 'not_string': return err.which;
    // @ts-expect-error not exhaustive: err is not never here
    default: return assertNever(err);
  }
};
void missing;
