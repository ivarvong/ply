// RefName is the ref validateRef parsed. A raw string is not one, and HEAD is not a RefName.
import { validateRef, validatePushRef, type RefName } from '../../src/validate.js';
import { refCandidates } from '../../src/read.js';
import type { Command } from '../../src/push.js';

const named: RefName = validateRef('refs/heads/main');
const pushed: RefName = validatePushRef('refs/heads/main', false);
const queries: ReadonlyArray<RefName | 'HEAD'> = refCandidates('main');
const command: Command = { ref: pushed, oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40) };

// @ts-expect-error a raw string has not been parsed
const raw: RefName = 'refs/heads/main';
// @ts-expect-error a push command takes a RefName, not a raw string
const rawCommand: Command = { ref: 'refs/heads/main', oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40) };
void named;
void pushed;
void queries;
void command;
void raw;
void rawCommand;
