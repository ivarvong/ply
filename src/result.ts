// Errors as values. A fallible function returns Result<T, E>; it does not throw. `throw` is reserved for
// programmer bugs (assertNever). Plain frozen-shape objects: no classes, no runtime dependency, nothing to tree-shake.

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// The compile-time exhaustiveness check. A switch over a union lists every member and has no `default`;
// the next statement is `assertNever(x)`. A new member leaves `x` short of `never`, so the call does not type-check.
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
