// Stock git's answers, classified the way ply's are (src/probe-evaluate.ts plyOutcome): `git push --porcelain` ref lines
// and a `git fetch` exit, mapped onto ply's error-class names so wording differences between servers are normalized
// before comparison. Only the in-repository runner (runner.mjs) runs stock git, so this stays out of `ply/probes`.
import type { Classified } from '../../src/probe-evaluate.ts';
import type { Outcome } from '../../src/probe-types.ts';

// A refusal reason stock git printed for one ref, as the error class ply would give it. Wording differs between servers
// ("failed to update ref", "stale ref", "incorrect old value provided"); the class is what is compared.
// A refusal git makes itself because its advertisement already shows another writer's value ("stale info" for a lease,
// "fetch first" for a create or update without force) is the same conflict the server's compare-and-swap reports when
// git read the advertisement a moment earlier: which one a racing client sees is timing, so both are cas_conflict.
export function gitReasonClass(reason: string, stderr: string): string {
  if (/stale info|fetch first/.test(reason)) return 'cas_conflict';
  if (/atomic push failure|atomic transaction failed/.test(reason)) return 'atomic_sibling';
  if (/non-fast-forward/.test(reason)) return 'not_fast_forward';
  if (/failed to update ref|failed to lock|cannot lock|incorrect old value|stale ref|already exists|does not exist|bad ref|reference/.test(reason)) return 'cas_conflict';
  if (/exceeds maximum|too large|limit is|maximum allowed/i.test(`${reason}\n${stderr}`)) return 'limit_exceeded';
  return 'push_rejected';
}

const OK_FLAGS = new Set([' ', '+', '-', '*', '=']);
// `git push --porcelain`: a `<flag>\t<src>:<dst>\t<summary>` line per ref (git-push(1) OUTPUT). No ref line and a
// non-zero exit is a push whose answer git never read: ambiguous.
// `creates`: the refs the plan creates (zero old id). git refuses a create of a ref its advertisement already shows as
// "non-fast-forward" (or "fetch first"): for a create that is the conflict, not a history rule.
// `git fetch`: landed when it exits 0; a low-speed abort is the timeout class, anything else a failed fetch.
export function gitFetchOutcome(status: number | null, stderr: string): Classified {
  const tail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  if (status === 0) return { outcome: 'landed', error: null, detail: 'fetched' };
  if (/too slow|timed out|Timeout was reached/i.test(stderr)) return { outcome: 'rejected', error: 'timeout', detail: tail };
  return { outcome: 'rejected', error: 'fetch_failed', detail: tail };
}

export function gitOutcome(status: number | null, stdout: string, stderr: string, creates: ReadonlySet<string> = new Set()): Classified {
  const refs = stdout.split('\n').filter(l => /^[ +\-*=!]\t[^\t]*:[^\t]*\t/.test(l)).map(l => {
    const [flag = '!', spec = '', summary = ''] = l.split('\t');
    const reason = /\(([^)]*)\)\s*$/.exec(summary)?.[1] ?? summary;
    return { ok: OK_FLAGS.has(flag), reason: creates.has(spec.slice(spec.indexOf(':') + 1)) && reason === 'non-fast-forward' ? 'fetch first' : reason };
  });
  const tail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  if (refs.length === 0) return status === 0 ? { outcome: 'landed', error: null, detail: 'no ref lines' } : { outcome: 'ambiguous', error: 'ambiguous', detail: tail };
  const bad = refs.filter(r => !r.ok);
  if (bad.length === 0 && status === 0) return { outcome: 'landed', error: null, detail: 'ok' };
  if (bad.length === 0) return { outcome: 'ambiguous', error: 'ambiguous', detail: tail };
  if (bad.length < refs.length) return { outcome: 'partial', error: 'push_partial', detail: bad.map(b => b.reason).join('; ') };
  const classes = bad.map(b => gitReasonClass(b.reason, stderr));
  const error = classes.find(c => c !== 'atomic_sibling') ?? 'cas_conflict';
  const outcome: Outcome = error === 'cas_conflict' ? 'conflict' : 'rejected';
  return { outcome, error, detail: bad.map(b => b.reason).join('; ') };
}
