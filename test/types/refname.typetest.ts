// RefName is the ref validateRef parsed. A raw string is not one, and HEAD is not a RefName.
import { validateRef, validatePushRef, type RefName } from '../../src/validate.js';
import { refCandidates } from '../../src/read.js';

const named: RefName = validateRef('refs/heads/main');
const pushed: RefName = validatePushRef('refs/heads/main', false);
const queries: ReadonlyArray<RefName | 'HEAD'> = refCandidates('main');

// @ts-expect-error a raw string has not been parsed
const raw: RefName = 'refs/heads/main';
void named;
void pushed;
void queries;
void raw;
