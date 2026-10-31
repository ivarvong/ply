// The ssh-service space, as code: what ply reports when the SSH session is fine and the git service behind it is not.
// Two tagged unions: the service (which git command the client runs) and the server's outcome (what the host does with
// it). Every pair is a cell. The oracle is git over OpenSSH against the same real sshd (test/sshd.js), whose forced
// command (test/space/ssh-service.test.js) produces each outcome: `git ls-remote` for upload-pack, `git push` for
// receive-pack. git's outcome class is ok / refused, and for a refusal the server's own line, which git prints; ply's
// is a typed code whose message carries the same line. git itself types none of them ("Could not read from remote
// repository" for all), so ply's code is decided by the text, as HTTP's is by the status (src/sshgit.js refusalCode).

export const SERVICE = { name: 'service', doc: 'the git command on the channel', variants: [
  { tag: 'uploadPack', command: 'git-upload-pack', why: 'fetch side, protocol v2 (GIT_PROTOCOL=version=2); ply: lsRefs; git: ls-remote' },
  { tag: 'receivePack', command: 'git-receive-pack', why: 'push side, protocol v0 advertisement; ply: receiveCaps; git: push' },
] };

export const OUTCOME = { name: 'outcome', doc: 'what the host does with the command', variants: [
  { tag: 'exists', why: 'a bare repository: the service runs' },
  { tag: 'missing', why: 'no such path: git\'s enter_repo fails, "fatal: \'<path>\' does not appear to be a git repository", exit 128' },
  { tag: 'notRepo', why: 'an empty directory: the same message from git' },
  { tag: 'unreadable', why: 'a repository the login cannot read (mode 000): the same message from git (unless the login is root)' },
  { tag: 'absent', why: 'the host has no git on PATH: the shell\'s "git-upload-pack: command not found" (bash) / "not found" (dash), exit 127' },
  { tag: 'hostNotFound', why: 'a hosting forced command refusing an unknown or invisible repository: "ERROR: Repository not found." (GitHub\'s text)' },
  { tag: 'hostDenied', why: 'a hosting forced command refusing a repository the key may not use: "ERROR: Permission to o/r.git denied to u." (GitHub\'s text)' },
  { tag: 'silent', why: 'a forced command that exits 1 and says nothing' },
  { tag: 'warning', why: 'a forced command that writes a warning to stderr, then runs the service' },
  { tag: 'emptyAdvertisement', why: 'stdout is a lone flush-pkt "0000", then the command reads its stdin to the end and exits 0: git\'s v0 advertisement of an empty repository with no capability line, from a server that takes whatever the client sends' },
] };

export const AXES = [SERVICE, OUTCOME];
export function* cells() { for (const service of SERVICE.variants) for (const outcome of OUTCOME.variants) yield { service, outcome }; }
export const cellId = c => `${c.service.tag}/${c.outcome.tag}`;

// The server's line for an outcome (what git prints, and ply's message must carry); null for none.
export const serverLine = (c, path) => ({
  missing: `'${path}' does not appear to be a git repository`, notRepo: `'${path}' does not appear to be a git repository`, unreadable: `'${path}' does not appear to be a git repository`,
  absent: `${c.service.command}: `, hostNotFound: 'ERROR: Repository not found.', hostDenied: 'ERROR: Permission to o/r.git denied to u.',
}[c.outcome.tag] ?? null);

export const DIVERGENCE = {
  'receivePack/emptyAdvertisement': 'git reads a lone flush as an empty repository with no capabilities and pushes blind: without report-status it never learns whether the server took the update, prints "[new branch]" and exits 0 when the transport does. ply refuses an advertisement with no capability line (`protocol`): it will not send a pack it cannot confirm',
  'uploadPack/emptyAdvertisement': 'git reads a lone flush as a v0 advertisement of an empty repository and lists nothing (exit 0). ply speaks only protocol v2 over ssh and refuses a server that answered in v0 (`unsupported`), as it does for a server without AcceptEnv GIT_PROTOCOL',
};

const ok = { tag: 'ok' };
const refused = (code, message) => ({ tag: 'refused', code, message });
// `root`: whether the sshd login is root (mode 000 does not stop root)
export function expected(c, { root = false } = {}) {
  const s = c.service.command;
  const ply = {
    exists: ok, warning: ok,
    missing: refused('not_found', new RegExp(`${s} ended before its advertisement \\(exit 128\\): fatal: '.*' does not appear to be a git repository`)),
    notRepo: refused('not_found', new RegExp(`${s} ended before its advertisement \\(exit 128\\): fatal: '.*' does not appear to be a git repository`)),
    unreadable: root ? ok : refused('not_found', new RegExp(`${s} ended before its advertisement \\(exit 128\\): fatal: '.*' does not appear to be a git repository`)),
    absent: refused('remote_error', new RegExp(`${s} ended before its advertisement \\(exit 127\\): .*${s}: (command )?not found`)),
    hostNotFound: refused('not_found', new RegExp(`${s} ended before its advertisement \\(exit 1\\): ERROR: Repository not found\\.$`)),
    hostDenied: refused('auth', new RegExp(`${s} ended before its advertisement \\(exit 1\\): ERROR: Permission to o/r\\.git denied to u\\.$`)),
    silent: refused('remote_error', new RegExp(`${s} ended before its advertisement \\(exit 1\\)$`)),
    emptyAdvertisement: c.service.tag === 'uploadPack' ? refused('unsupported', /did not speak protocol v2 \(first line ""\)/) : refused('protocol', /git-receive-pack sent an empty advertisement/),
  }[c.outcome.tag];
  const git = DIVERGENCE[cellId(c)] ? (ply.tag === 'ok' ? 'refused' : 'ok') : (ply.tag === 'ok' ? 'ok' : 'refused');
  return { ply, git };
}
