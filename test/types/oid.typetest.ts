// Oid is a brand: a string is not an Oid, and an Oid is a string.
import { parseOid, parseCommitId, ZERO_OID, type Oid } from '../../src/oid.js';

const branded: Oid = ZERO_OID;
const asString: string = ZERO_OID;
void branded; void asString;

// @ts-expect-error a plain string is not an Oid
const plain: Oid = 'a'.repeat(40);
void plain;

const parsed = parseOid('a'.repeat(40));
if (parsed.ok) {
  const value: Oid = parsed.value;
  const text: string = parsed.value;
  void value; void text;
}
const commit = parseCommitId(ZERO_OID);
if (commit.ok) {
  const value: Oid = commit.value;
  void value;
}
