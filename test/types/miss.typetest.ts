// not_found carries a Miss, and an empty readCommit is a different value from a commit.
import { fail, type Miss, type PlyError } from '../../src/errors.js';
import { assertNever } from '../../src/result.js';
import type { CommitResult, EmptyCommit } from '../../src/read.js';

fail('not_found', 'missing', { miss: { kind: 'head_absent' } });
fail('not_found', 'missing', { miss: { kind: 'commit', miss: { kind: 'absent', oid: 'a'.repeat(40) } } });
// @ts-expect-error not_found requires miss
fail('not_found', 'missing');
// @ts-expect-error head_unborn requires target
fail('not_found', 'missing', { miss: { kind: 'head_unborn' } });

const label = (m: Miss): string => {
  switch (m.kind) {
    case 'ref': return m.ref;
    case 'head_unborn': return m.target;
    case 'head_absent': return 'absent';
    case 'path': return `${m.existingPath}/${m.missing}`;
    case 'not_directory': return m.mode;
    case 'is_directory': return m.tree;
    case 'submodule': return m.commit;
    case 'commit': return m.miss.kind === 'absent' ? m.miss.oid : m.miss.type;
    case 'repository': return 'repository';
  }
  return assertNever(m);
};
void label;
const missingKind = (m: Miss): string => {
  switch (m.kind) {
    case 'ref': return m.ref;
  }
  // @ts-expect-error not exhaustive: m is not never here
  return assertNever(m);
};
void missingKind;

declare const commit: CommitResult | EmptyCommit;
if ('empty' in commit) {
  const ref: string = commit.ref;
  void ref;
  // @ts-expect-error an unborn commit has no oid
  void commit.oid;
} else {
  const oid: string = commit.oid;
  void oid;
}

declare const e: PlyError;
if (e.code === 'not_found') {
  const kind: Miss['kind'] = e.miss.kind;
  void kind;
}
