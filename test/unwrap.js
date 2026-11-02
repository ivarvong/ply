// Test-side adapters for the Result API (0.2.0: every public function returns Result, docs/STACK.md "Public API
// policy"). A test that asserted a rejection or a throw keeps its assertion by wrapping the call:
//
//   await assert.rejects(unwrapAsync(editFile(url, spec, opts)), e => e.code === 'match_count');
//   assert.throws(() => unwrap(parseTree(bytes)), e => e.code === 'pack_corrupt');
//   const { newCommit } = await unwrapAsync(editFile(url, spec, opts));
//
// A test about the Result itself asserts it directly (`r.ok`, `errOf(r).code`). These live in test/ only: src/ has no
// throwing wrapper after the cut-over.

/** The value of an Ok; the Err's error is thrown. */
export function unwrap(r) {
  if (r.ok) return r.value;
  throw r.error;
}

/** unwrap, for a promise of a Result. */
export async function unwrapAsync(p) {
  return unwrap(await p);
}

/** The error of an Err; an Ok fails the test with its value. */
export function errOf(r) {
  if (r.ok) throw new Error(`expected an Err, got Ok(${JSON.stringify(r.value)?.slice(0, 200)})`);
  return r.error;
}
