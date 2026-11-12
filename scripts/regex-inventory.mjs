// The checked inventory of every regular expression under src/ (scripts/regex-gate.mjs explains the rules).
//
// One row per (file, pattern text). `input` is the most hostile text the call sites hand the pattern:
//   remote    bytes a server sent (advertisements, reports, error text, redirect targets)
//   stored    repository or cached content read back (objects, .git files, saved indexes): untrusted too
//   caller    an argument of the public API
//   internal  a constant of this library
// `linear` says why matching costs time linear in the input. `adversarial(n)` builds about n characters of the input
// that makes the pattern work hardest (the longest run it can consume, then a character that makes it fail);
// test/regex-linear.test.js times it at n, 2n and 4n. `op` is how the call site applies the pattern (exec by default).
// `knownBad` names where the fix is: the gate lists the row instead of refusing it, the ratio test asserts the
// generator really is superlinear, and the row fails the gate once the pattern is gone from the source.
const rep = (s, n) => s.repeat(Math.max(1, Math.floor(n / s.length)));
const run = (ch, tail = '!') => n => ch.repeat(n) + tail;
const row = (file, pattern, input, linear, adversarial, more = {}) => ({ file, pattern, input, linear, adversarial, ...more });
const ONE_START = 'anchored at ^: one start, one character class run, then a single failure';
const NO_RUN = 'no quantifier above {0,1}: a bounded number of steps at each start';
const FIXED = 'anchored at ^ with a fixed repeat count: at most that many steps';

export const INVENTORY = [
  row('src/attributes.ts', String.raw`/^[-A-Za-z0-9_.]+$/u`, 'stored', ONE_START, run('a')),
  row('src/caps.ts', String.raw`/[ \t\n\v\f\r]+/`, 'remote', 'split: each run is consumed once and nothing follows it that can fail', n => rep(' '.repeat(63) + 'x', n), { op: 'split' }),
  row('src/caps.ts', String.raw`/\n$/`, 'remote', NO_RUN, run('\n', 'x'), { op: 'replace' }),
  row('src/changes.ts', String.raw`/^[0-9a-fA-F]{40}$/u`, 'caller', FIXED, run('a', '')),
  row('src/checkout.ts', String.raw`/^[1-7][0-7]*$/`, 'stored', ONE_START, run('1', '9')),
  row('src/edit.ts', String.raw`/^[0-9a-fA-F]{40}$/u`, 'caller', FIXED, run('a', '')),
  row('src/errors.ts', String.raw`/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu`, 'remote',
    'one character class and no quantifier: one step at each start; the global replaceAll never revisits a match, and its callback writes one fixed-size escape for each',
    n => rep('‮\u{E0001}', n), { op: 'replace' }),
  row('src/fetch.ts', String.raw`/\n$/`, 'remote', NO_RUN, run('\n', 'x'), { op: 'replace' }),
  row('src/fetch.ts', String.raw`/only blob:none is supported|unsupported (git )?fetch filter/i`, 'remote',
    'fixed phrases, one optional fixed group, no run: a bounded number of steps at each start (the "filter … not" run is read by hand, ply#274)', n => rep('unsupported git fetch filte', n)),
  row('src/http.ts', String.raw`/^[0-9A-Za-z._-]+$/`, 'caller', ONE_START, run('a', ' ')),
  row('src/http.ts', String.raw`/%([0-9a-f]{2})/gi`, 'caller', 'three characters at most per start, and a global replace never revisits a match', n => rep('%4', n), { op: 'replace' }),
  row('src/http.ts', String.raw`/[\0\r\n]/`, 'caller', NO_RUN, run('a', '')),
  row('src/http.ts', String.raw`/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*@/i`, 'caller', 'anchored at ^; the scheme run ends at ":" (not in its class), the authority run backtracks once for "@"', n => `a://${'a'.repeat(n)}/`),
  row('src/http.ts', String.raw`/^[\t -~]+$/`, 'caller', ONE_START, run('a', '\0')),
  row('src/http.ts', String.raw`/\/$/`, 'remote', NO_RUN, run('/', 'x'), { op: 'replace', count: 3 }),
  row('src/http.ts', String.raw`/^Basic\s/i`, 'caller', 'anchored at ^, no run', n => `Basic${' '.repeat(n)}`),
  row('src/http.ts', String.raw`/^Basic\s+/i`, 'caller', 'anchored at ^, one run, nothing after it that can fail', n => `Basic${' '.repeat(n)}`, { op: 'replace' }),
  row('src/http.ts', String.raw`/^\S+\s+/`, 'caller', 'anchored at ^; \\S and \\s are disjoint, so the first run backtracks once', run('a', ''), { op: 'replace' }),
  row('src/lsrefs.ts', 'new RegExp(`^[0-9a-fA-F]{${SHA256_HEX_CHARS}}$`)', 'remote', FIXED, run('a', ''), { build: () => /^[0-9a-fA-F]{64}$/ }),
  row('src/merge.ts', String.raw`/\n?$/u`, 'caller', NO_RUN, run('\n', 'x'), { op: 'replace' }),
  row('src/mergeio.ts', String.raw`/^refs\/heads\//u`, 'caller', 'anchored at ^, a literal', n => rep('refs/heads/', n), { op: 'replace' }),
  row('src/objects.ts', String.raw`/^[0-9]$/u`, 'stored', 'anchored at ^, one character', run('1', '')),
  row('src/objects.ts', String.raw`/\s+/u`, 'stored', 'split: each run is consumed once and nothing follows it that can fail', n => rep(' '.repeat(63) + 'x', n), { op: 'split' }),
  row('src/objects.ts', String.raw`/^\d+$/u`, 'stored', ONE_START, run('1', 'x')),
  row('src/objects.ts', String.raw`/[\0\n]/u`, 'caller', NO_RUN, run('a', '')),
  row('src/packindex.ts', String.raw`/^[0-9a-f]{40}$/u`, 'stored', FIXED, run('a', '')),
  row('src/packrangeresolve.ts', String.raw`/^[0-9a-f]{40}$/u`, 'caller', FIXED, run('a', '')),
  row('src/packsaved.ts', String.raw`/^[0-9a-f]{40}$/u`, 'stored', FIXED, run('a', '')),
  row('src/push.ts', String.raw`/ .*/u`, 'internal', 'applied to the UA constant; nothing follows the run that can fail', undefined, { count: 2 }),
  row('src/push.ts', String.raw`/^[ -~]+$/u`, 'remote', ONE_START, run('a', '\0')),
  row('src/push.ts', String.raw`/^[0-9]{1,9}$|^[0-9]{1,9}[.][0-9]{1,6}$/u`, 'remote',
    'each alternative is anchored at ^, every repeat is bounded and a required "." separates the two digit runs: at most 16 characters are read, whatever the length', n => `${'1'.repeat(9)}.${'1'.repeat(n)}`),
  row('src/push.ts', String.raw`/^(failed to lock|stale ref)$|fetch first|non-fast-forward|already exists/u`, 'remote', 'literal alternatives: at most the longest literal at each start', n => rep('fetch firs', n)),
  row('src/push.ts', String.raw`/\r?\n|\r/u`, 'remote', NO_RUN, run('\r', ''), { op: 'split' }),
  row('src/push.ts', String.raw`/\n$/u`, 'remote', NO_RUN, run('\n', 'x'), { op: 'replace' }),
  row('src/read.ts', String.raw`/^[0-9a-f]{40}$/`, 'caller', FIXED, run('a', '')),
  row('src/read.ts', String.raw`/^[0-9a-f]{4,39}$/`, 'caller', FIXED, run('a', '')),
  row('src/read.ts', String.raw`/^gpgsig(-sha256)? /`, 'stored', 'anchored at ^, literals only', n => rep('gpgsig-sha256', n)),
  row('src/read.ts', String.raw`/\/$/`, 'caller', NO_RUN, run('/', 'x'), { op: 'replace' }),
  row('src/rebase.ts', String.raw`/\n+$/u`, 'stored', 'NOT linear: every newline of a run that does not end the text starts the run again', run('\n', 'x'), { op: 'replace', knownBad: 'fix/review-rebase' }),
  row('src/receivecaps.ts', 'new RegExp(`^[0-9a-f]{${n}} [^ ]`, \'u\')', 'remote', FIXED, run('a', ''), { build: () => /^[0-9a-f]{40} [^ ]/u }),
  row('src/receivecaps.ts', 'new RegExp(`^shallow [0-9a-f]{${n}}$`, \'u\')', 'remote', FIXED, n => `shallow ${'a'.repeat(n)}`, { build: () => /^shallow [0-9a-f]{40}$/u }),
  row('src/receivecaps.ts', String.raw`/\n$/u`, 'remote', NO_RUN, run('\n', 'x'), { op: 'replace', count: 2 }),
  row('src/repo-node.ts', String.raw`/^[0-9a-f]{40}$/u`, 'stored', FIXED, run('a', '')),
  row('src/repo-node.ts', String.raw`/^gitdir: (.+)$/mu`, 'stored', '^ under m starts once per line and .+ cannot leave its line, which $ under m always accepts', n => rep('gitdir: \n', n)),
  row('src/repo-node.ts', String.raw`/^\[([^\]\s"]+)(\s+"([^"]*)")?\]$/u`, 'stored', 'anchored at ^; the name, space and quoted runs are pairwise disjoint classes', n => `[a "${'b'.repeat(n)}`),
  row('src/repo-node.ts', String.raw`/^([A-Za-z][\w-]*)\s*(=\s*(\S[^\n\r\u2028\u2029]*|))?$/u`, 'stored', 'anchored at ^; name, \\s and \\S are disjoint, so each run has one place to end and backtracks once (ply#274)', n => `a=${' '.repeat(n)}x\ry`),
  row('src/repo-node.ts', String.raw`/^([0-9a-f]{40}) (refs\/\S+)$/u`, 'stored', 'anchored at ^; one \\S run that backtracks once', n => `${'a'.repeat(40)} refs/${'a'.repeat(n)} x`),
  row('src/repo-node.ts', String.raw`/^(commit|tree|blob|tag) (\d+)$/u`, 'stored', ONE_START, n => `blob ${'1'.repeat(n)}x`),
  row('src/repo-node.ts', String.raw`/\s/u`, 'caller', NO_RUN, run('a', '')),
  row('src/scrub.ts', String.raw`/[0-9]/u`, 'remote', NO_RUN, run('a', '')),
  row('src/sign.ts', String.raw`/\n$/u`, 'caller', NO_RUN, run('\n', 'x'), { op: 'replace' }),
  row('src/uprequest.ts', 'new RegExp(`^[0-9a-fA-F]{${OID_HEX_CHARS}}$`)', 'caller', FIXED, run('a', ''), { build: () => /^[0-9a-fA-F]{40}$/ }),
  row('src/uprequest.ts', String.raw`/^[0-9]+$/`, 'caller', ONE_START, run('1', 'x')),
  row('src/validate.ts', 'new RegExp(`^[+-][0-9]{${IDENT_TZ_DIGITS}}$`, \'u\')', 'caller', FIXED, n => `+${'1'.repeat(n)}`, { build: () => /^[+-][0-9]{4}$/u }),
  row('src/validate.ts', String.raw`/[\0\n<>]/u`, 'caller', NO_RUN, run('a', '')),
  row('src/validate.ts', String.raw`/[\0\r\n]/u`, 'caller', NO_RUN, run('a', '')),
  row('src/validate.ts', String.raw`/[\0-\u001F\u007F ~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.$|\.lock(\/|$)|^\/|\/\.|^\./u`, 'remote', 'alternatives of literals and single classes: at most six characters at each start', n => rep('.loc', n).replace(/^\./u, 'a')),
  row('src/validate.ts', String.raw`/^\.gitmodules$/i`, 'stored', 'anchored at ^, a literal', n => rep('.gitmodules', n)),
  row('src/validate.ts', String.raw`/[:<>"|?*\u0001-\u001F]/u`, 'stored', NO_RUN, run('a', '')),
  row('src/validate.ts', String.raw`/[ .]$/u`, 'stored', NO_RUN, run(' ', 'x')),
  row('src/validate.ts', String.raw`/^(aux|prn|nul|con|com[1-9]|lpt[0-9]|conin\$|conout\$) *([.:]|$)/i`, 'stored', 'anchored at ^; one run of spaces that backtracks once', n => `aux${' '.repeat(n)}x`),
];
