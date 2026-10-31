// Credential redaction, shared by both transports (http.js builds one from its Authorization; sshgit.js from a
// secret-shaped login name). Its own module so the SSH entry does not carry the HTTP transport.

// The Basic user is a name on most hosts (`x-access-token`, `oauth2`, `git`, a login) and a secret on some (a deploy
// token, a PAT given as the user). Scrubbing a name would mangle legitimate server text ("denied to ivar"), so the user
// is scrubbed only when it is secret-shaped: at least 16 characters with a digit. Every token format seen (ghp_…, glpat-…,
// hex, base64) is; every conventional user name is not. Below 4 characters nothing is scrubbed (it would eat text).
// A user with no password beside it is the whole credential (the token-as-user form) and is a secret at 16 characters,
// digit or not: a GitLab or GitHub token without one would otherwise stay readable.
export const MIN_SECRET = 4;
export const SECRET_USER_CHARS = 16;
export const secretShaped = (s: unknown): boolean => typeof s === 'string' && s.length >= SECRET_USER_CHARS && /[0-9]/u.test(s);
export const secretUser = (user: unknown, hasPassword: boolean): boolean => secretShaped(user) || (!hasPassword && typeof user === 'string' && user.length >= SECRET_USER_CHARS);

// text → text with every secret replaced by '[redacted]'; null when there is nothing to hide. Server text is kept as a
// tail or a prefix in places (progress, hook output, a quoted line), so a secret can arrive cut: any run of FRAGMENT or
// more characters of a secret is redacted, not only whole ones. 12 characters of a random token cannot occur by chance
// (a 12-hex window of a commit oid matches a hex token's with p ≈ 1e-13); shorter secrets are matched whole.
export const FRAGMENT = 12;
export const REDACTED = '[redacted]';
export function scrubber(values: readonly unknown[]): ((text: unknown) => string) | null {
  const secrets = values.filter((x): x is string => typeof x === 'string' && x.length >= MIN_SECRET);
  if (secrets.length === 0) return null;
  const whole = secrets.filter(x => x.length < FRAGMENT);
  const grams = new Set<string>();
  for (const x of secrets) for (let i = 0; i + FRAGMENT <= x.length; i++) grams.add(x.slice(i, i + FRAGMENT));
  const cut = (s: string): string => {
    let end = -1, from = 0, out = '', start = -1;
    for (let i = 0; i + FRAGMENT <= s.length; i++) {
      if (!grams.has(s.slice(i, i + FRAGMENT))) continue;
      if (i > end) { if (start >= 0) { out += s.slice(from, start) + REDACTED; from = end; } start = i; }
      end = i + FRAGMENT;
    }
    return start < 0 ? s : out + s.slice(from, start) + REDACTED + s.slice(end);
  };
  // oxlint-disable-next-line unicorn/no-array-reduce -- one expression; the loop form costs 17 B on every entry
  return text => whole.reduce((acc, x) => acc.split(x).join(REDACTED), cut(String(text)));
}
