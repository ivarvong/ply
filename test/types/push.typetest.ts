// Compile-time checks for the push cluster: `tsc --noEmit` must pass; every @ts-expect-error must still be an error.
import { assertNever } from '../../src/result.js';
import { push, decideOutcome, outcomeResult, type CheckedCaps, type Outcome, type PushError, type PushOptions, type PushTransport } from '../../src/push.js';
import { checkPushCaps } from '../../src/receivecaps.js';

declare const t: PushTransport;
const del = { commands: [{ ref: 'refs/heads/a', oldOid: '0'.repeat(40), newOid: '0'.repeat(40) }] } as const;

// atomic and push options reach the request only as capabilities checked against the advertisement
// @ts-expect-error raw atomic is not a push option
void push(t, { ...del, atomic: true });
// @ts-expect-error raw push options are not a push option
void push(t, { ...del, pushOptions: ['x'] });
// @ts-expect-error a CheckedCaps is made only by checkPushCaps (the brand)
const forged: CheckedCaps = { atomic: true, pushOptions: [] };
void forged;
const checked = checkPushCaps(new Set(['atomic']), { atomic: true });
if (checked.ok) { const o: PushOptions = { ...del, checked: checked.value }; void push(t, o); }

// the outcome is a closed union: an exhaustive switch compiles, a missing case does not
const verdict = (o: Outcome): string => {
  switch (o.tag) {
    case 'landed': return 'landed';
    case 'rejected': return `${o.code}: ${o.refs.map(r => `${r.ref} ${r.cls}`).join()}`;
    case 'partial': return o.landed.join();
    case 'ambiguous': return o.why;
  }
  return assertNever(o);
};
void verdict(decideOutcome({ tag: 'malformed', why: 'w' }));
const incomplete = (o: Outcome): string => {
  switch (o.tag) {
    case 'landed': case 'rejected': case 'partial': return o.tag;
  }
  // @ts-expect-error 'ambiguous' is not handled
  return assertNever(o);
};
void incomplete;

// the Result's error side is exactly the push codes, each with its payload
const handle = (e: PushError): string => {
  switch (e.code) {
    case 'push_rejected': case 'not_fast_forward': return e.message;
    case 'cas_conflict': return `${e.expected} ${e.actual}`;
    case 'push_partial': return e.landed.join() + e.rejected.map(r => r.ref).join();
    case 'ambiguous': return String(e.original);
  }
  return assertNever(e);
};
const r = outcomeResult({ tag: 'landed' }, { report: null, hookOutput: '', remote: undefined, commands: [] });
if (!r.ok) void handle(r.error);
