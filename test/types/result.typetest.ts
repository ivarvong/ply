// Compile-time checks: `tsc --noEmit` must pass; every @ts-expect-error must still be an error.
import { assertNever, match, matchKind, matchOption, ok, some, none, optionToResult, resultToOption, transposeOptionResult, transposeResultOption, andThen, type Option, type Result } from '../../src/result.js';
import { fail, type PlyError, type Code, type Miss } from '../../src/errors.js';

const r: Result<number, PlyError> = Math.random() > 0.5 ? ok(1) : fail('timeout', 't');
if (r.ok) { const n: number = r.value; void n; } else { const c: Code = r.error.code; void c; }
// @ts-expect-error value is not accessible without narrowing
void r.value;

// exhaustive switch
const describe = (e: PlyError): string => {
  switch (e.code) {
    case 'http': return `status ${e.status}`; // narrowed: status exists
    case 'limit_exceeded': return `${e.what} ${e.got} > ${e.max}`;
    case 'ambiguous': return String(e.original ?? 'unknown');
    case 'cas_conflict': return `${e.expected} != ${e.actual}`;
    case 'match_count': return String(e.matches);
    case 'merge_conflict': return e.conflicts.join(',');
    case 'bad_request': case 'unsupported': case 'network': case 'timeout': case 'aborted': case 'auth':
    case 'not_found': case 'rate_limited': case 'upstream_5xx': case 'not_git':
    case 'protocol': case 'pack_corrupt': case 'remote_error': case 'lfs_pointer':
    case 'push_rejected': case 'push_partial': case 'not_fast_forward':
    case 'not_linear': case 'unrelated_histories': case 'internal':
      return e.message;
  }
  return assertNever(e);
};
void describe;
const missingCase = (e: PlyError): string => {
  switch (e.code) {
    case 'http': return 'x';
  }
  // @ts-expect-error not exhaustive: e is not never here
  return assertNever(e);
};
void missingCase;

// payload required by code
fail('http', 'x', { status: 500 });
// @ts-expect-error http requires status
fail('http', 'x');
// @ts-expect-error timeout takes no payload
fail('timeout', 'x', { status: 1 });
// @ts-expect-error unknown code
fail('nope', 'x');

// match: every tag, and only tags
type Step = { code: 'more'; n: number } | { code: 'done' };
const s = { code: 'more', n: 1 } as Step;
match(s, { more: x => x.n, done: () => 0 });
// @ts-expect-error missing handler
match(s, { more: x => x.n });
// @ts-expect-error extra handler
match(s, { more: x => x.n, done: () => 0, other: () => 1 });

// matchKind: the #131 miss union, and any operation error discriminated by kind
declare const miss: Miss;
const missLabel = matchKind(miss, {
  ref: x => x.ref,
  head_unborn: x => x.target,
  head_absent: () => 'absent',
  path: x => x.missing,
  not_directory: x => x.mode,
  is_directory: x => x.tree,
  submodule: x => x.commit,
  commit: x => x.miss.kind,
  repository: () => 'repository',
});
void missLabel;
// @ts-expect-error missing kind handler
matchKind(miss, { ref: x => x.ref });

type OpErr = { readonly kind: 'not_string'; readonly which: 'left' } | { readonly kind: 'not_bytes'; readonly which: 'right' };
declare const opErr: OpErr;
matchKind(opErr, { not_string: x => x.which, not_bytes: x => x.which });
// @ts-expect-error missing not_bytes
matchKind(opErr, { not_string: x => x.which });

// Option: both tags, and it composes with Result.
const present: Option<number> = some(1);
const absent: Option<number> = none;
matchOption(present, { some: n => n, none: () => 0 });
// @ts-expect-error missing none
matchOption(present, { some: n => n });
const back: Result<number, 'missing'> = optionToResult(absent, 'missing');
const dropped: Option<number> = resultToOption(back);
const nested: Option<Result<number, 'missing'>> = transposeResultOption(ok(absent));
const flat: Result<Option<number>, 'missing'> = transposeOptionResult(some(ok(1)));
void dropped; void nested; void flat;

// andThen unions error types
const a = andThen(ok(1) as Result<number, 'e1'>, n => (n > 0 ? ok(String(n)) : { ok: false as const, error: 'e2' as const }));
const e: Result<string, 'e1' | 'e2'> = a; void e;
