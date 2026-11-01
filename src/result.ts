// Errors as values. A fallible function returns Result<T, E>; it does not throw. `throw` is reserved for
// programmer bugs (assertNever). Plain frozen-shape objects: no classes, no runtime dependency, nothing to tree-shake.

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// The compile-time exhaustiveness check: a `default:` that receives anything but `never` is a type error.
export function assertNever(x: never): never {
  throw new Error(`unreachable: ${String(x)}`);
}

// Sequencing without exceptions. `andThen` short-circuits on the first Err; the error types union.
export const map = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> => (r.ok ? ok(f(r.value)) : r);
export const mapErr = <T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> => (r.ok ? r : err(f(r.error)));
export const andThen = <T, U, E, F>(r: Result<T, E>, f: (t: T) => Result<U, F>): Result<U, E | F> => (r.ok ? f(r.value) : r);

// Exhaustive match over a tagged union: one handler per tag, checked by the compiler (a missing or extra tag
// does not type-check), each handler receiving the narrowed member.
export type Handlers<U extends { readonly code: string }, R> = { readonly [K in U['code']]: (u: Extract<U, { readonly code: K }>) => R };
export const match = <U extends { readonly code: string }, R>(u: U, h: Handlers<U, R>): R =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- h[u.code] is the handler for u's own member (Handlers)
  (h[u.code as U['code']] as (u: U) => R)(u);

// The same check for a union discriminated by `kind` (a typed miss, or one operation's error union).
export type KindHandlers<U extends { readonly kind: string }, R> = { readonly [K in U['kind']]: (u: Extract<U, { readonly kind: K }>) => R };
export const matchKind = <U extends { readonly kind: string }, R>(u: U, h: KindHandlers<U, R>): R =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- h[u.kind] is the handler for u's own member (KindHandlers)
  (h[u.kind as U['kind']] as (u: U) => R)(u);

// What a span records as `error.kind`. A typed miss is the discriminant callers switch on (#131); an operation
// that distinguishes variants of one code sets `kind`; `reason` is the closed sub-reason (#76); otherwise the code.
const FALLBACK_KIND = 'Error';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const stringField = (v: Record<string, unknown>, key: string): string | null => {
  if (!Object.hasOwn(v, key)) return null;
  const value = v[key];
  return typeof value === 'string' ? value : null;
};
export function errorKind(e: unknown): string {
  if (!isRecord(e)) return FALLBACK_KIND;
  const miss = e['miss'];
  if (isRecord(miss)) {
    const missKind = stringField(miss, 'kind');
    if (missKind !== null) return missKind;
  }
  const kind = stringField(e, 'kind');
  if (kind !== null) return kind;
  const reason = stringField(e, 'reason');
  if (reason !== null) return reason;
  const code = stringField(e, 'code');
  if (code !== null) return code;
  return FALLBACK_KIND;
}
export const errorKindAttr = (e: unknown): { readonly 'error.kind': string } => ({ 'error.kind': errorKind(e) });

// Absence, in the same closed-tag style as a typed miss (t134u). A missing value is None.
// Result keeps its `ok` discriminant (the 0.2.0 decision). Option uses `tag`. The helpers below are the composition.
export type Some<T> = { readonly tag: 'some'; readonly value: T };
export type None = { readonly tag: 'none' };
export type Option<T> = Some<T> | None;

export const some = <T>(value: T): Some<T> => ({ tag: 'some', value });
export const none: None = { tag: 'none' };

export const isSome = <T>(o: Option<T>): o is Some<T> => o.tag === 'some';
export const isNone = <T>(o: Option<T>): o is None => o.tag === 'none';

export type OptionHandlers<T, R> = { readonly some: (value: T) => R; readonly none: (absent: None) => R };
export const matchOption = <T, R>(o: Option<T>, h: OptionHandlers<T, R>): R => {
  if (o.tag === 'none') return h.none(o);
  // Not a method call named `some`: that is Array#some to the linter.
  const present = h.some;
  return present(o.value);
};

// Ok becomes Some. Err becomes None; the error is dropped on purpose (None carries no reason).
export const resultToOption = <T, E>(r: Result<T, E>): Option<T> => (r.ok ? some(r.value) : none);

// Some becomes Ok. None becomes Err(error). The error is required: None has nothing to put there.
export const optionToResult = <T, E>(o: Option<T>, error: E): Result<T, E> => (o.tag === 'some' ? ok(o.value) : err(error));

// Ok(Some(v)) → Some(Ok(v)); Ok(None) → None; Err(e) → Some(Err(e)).
export const transposeResultOption = <T, E>(r: Result<Option<T>, E>): Option<Result<T, E>> => {
  if (!r.ok) return some(err(r.error));
  return r.value.tag === 'some' ? some(ok(r.value.value)) : none;
};

// Some(Ok(v)) → Ok(Some(v)); Some(Err(e)) → Err(e); None → Ok(None).
export const transposeOptionResult = <T, E>(o: Option<Result<T, E>>): Result<Option<T>, E> => {
  if (o.tag === 'none') return ok(none);
  return o.value.ok ? ok(some(o.value.value)) : err(o.value.error);
};

// map, flatMap, and getOrElse. matchOption is the exhaustive eliminator; these are its two branches.
// Names follow matchOption: `map` is already Result's. None is returned as itself, so a chain does not allocate a fresh absence.
// getOrElse takes a value the caller already computed. A fallback that should run only on None belongs in matchOption.
export const mapOption = <T, U>(o: Option<T>, f: (value: T) => U): Option<U> => (o.tag === 'some' ? some(f(o.value)) : o);

export const flatMapOption = <T, U>(o: Option<T>, f: (value: T) => Option<U>): Option<U> => (o.tag === 'some' ? f(o.value) : o);

export const getOrElse = <T>(o: Option<T>, fallback: T): T => (o.tag === 'some' ? o.value : fallback);
