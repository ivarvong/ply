// The package entry exports the same brand. tsconfig.isolated.json excludes this file: it imports index.js,
// and that config sets allowJs false.
import { parseOid, parseCommitId, ZERO_OID, OID_HEX_CHARS, MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_TREE, MODE_COMMIT, BLOB_MODES, type Oid } from '../../src/index.js';

const branded: Oid = ZERO_OID;
const asString: string = ZERO_OID;
void branded; void asString; void OID_HEX_CHARS; void MODE_BLOB; void MODE_EXEC; void MODE_LINK; void MODE_TREE; void MODE_COMMIT; void BLOB_MODES;

// @ts-expect-error a plain string is not an Oid
const plain: Oid = 'a'.repeat(40);
void plain;

const parsed = parseOid('ab'.repeat(20));
if (parsed.ok) {
  const value: Oid = parsed.value;
  void value;
}
const commit = parseCommitId('c'.repeat(40));
if (commit.ok) {
  const value: Oid = commit.value;
  void value;
}
