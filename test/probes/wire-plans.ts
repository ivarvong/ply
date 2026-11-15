// HTTP-level probes: requests written byte for byte (framing, encoding, malformed bodies, the v0 advertisement,
// object-info, a refused filter, the status of a request with a bad credential), each stating the answer a git server
// with Artifacts' known policy should give. ply has no form of most of them (the matrix calls those behaviours
// unsupported); they are here for the server's coverage, triangulated by independent clients: a raw socket (exact
// bytes), curl, and stock git or ply where either can send the request. test/probes/wire.mjs runs them;
// test/probes/wire.test.js holds the reference (git http-backend behind Node's HTTP server) to every expectation.
import type { Area, BehaviourId } from '../../src/probe-types.ts';

export type WireId = `${BehaviourId<Area>}#${string}`;
// Who sends the request: `raw` writes the bytes on a socket; `curl` is curl 8 given the same body and headers; `git`
// and `ply` send their own request for the same thing (GitForm, PlyForm).
export type Corner = 'raw' | 'curl' | 'git' | 'ply';
export type Encoding = { readonly tag: 'identity' } | { readonly tag: 'gzip' } | { readonly tag: 'gzip-corrupt' };
// length          Content-Length equal to the body
// length-off      Content-Length the body's length plus `by` (more: the client half-closes after the body)
// chunked         Transfer-Encoding: chunked, 8 KiB chunks
// expect-continue Content-Length and Expect: 100-continue; the body follows the interim 100 or 1.5 s of silence
export type Framing = { readonly tag: 'length' } | { readonly tag: 'length-off'; readonly by: number } | { readonly tag: 'chunked' } | { readonly tag: 'expect-continue' };
// The request body, built from the target's seed (base: main; next: its child, with a 64 KiB incompressible file):
//   ls-refs          v2 ls-refs for refs/heads/
//   object-info      v2 object-info: the size of base's a.txt
//   fetch-filter     v2 fetch of base with `filter <filter>` (the blob named is base's a.txt)
//   unknown-command  v2 command=frobnicate
//   push-create      v0 receive-pack: create refs/heads/wire-<corner> at next, with next's objects as a pack
//   bytes            the latin-1 text given, sent as is
//   ls-refs-no-flush v2 ls-refs whose arguments end without the flush packet
//   push-ref         v0 receive-pack: one command `<old> <new> <ref>` with `caps` after the NUL (report-status and an
//                    agent are always there), and next's objects as a pack when new is next (an empty pack otherwise);
//                    `<c>` in the ref is the sender's name, so senders of one plan write different refs
//   v2               a v2 request: `command=<command>`, the capability lines, a delimiter, the argument lines (`<base>`
//                    in a line is base's id), a flush
//   ls-refs-all      v2 ls-refs of every ref (no prefix), with peel and symrefs
export type OldNew = 'zero' | 'base' | 'next';
export type WireBody =
  | { readonly tag: 'ls-refs' }
  | { readonly tag: 'object-info' }
  | { readonly tag: 'fetch-filter'; readonly filter: string }
  | { readonly tag: 'unknown-command' }
  | { readonly tag: 'push-create' }
  | { readonly tag: 'bytes'; readonly latin1: string }
  | { readonly tag: 'ls-refs-no-flush' }
  | { readonly tag: 'push-ref'; readonly ref: string; readonly old: OldNew; readonly new: OldNew; readonly caps: string }
  | { readonly tag: 'v2'; readonly command: 'fetch' | 'ls-refs'; readonly capLines: readonly string[]; readonly argLines: readonly string[] }
  | { readonly tag: 'ls-refs-all' };
export type Service = 'git-upload-pack' | 'git-receive-pack';
export type ContentType = { readonly tag: 'service' } | { readonly tag: 'other'; readonly value: string };
// A credential a status probe presents (Artifacts only: git http-backend has no authentication):
//   none            no Authorization header
//   bogus           a well-formed bearer token that was never minted
//   revoked         the token `repos create` minted, after its revocation
//   missing-repo    the repository's own (repository-scoped) write token, on a path where no repository is
export type Credential = 'none' | 'bogus' | 'revoked' | 'missing-repo';
export type RpcRequest = { readonly tag: 'rpc'; readonly service: Service; readonly protocol: 'v0' | 'v2'; readonly contentType: ContentType; readonly encoding: Encoding; readonly framing: Framing; readonly body: WireBody };
export type WireRequest =
  | { readonly tag: 'advertise'; readonly service: string; readonly protocol: 'v0' | 'v2' }
  | RpcRequest
  | { readonly tag: 'credential'; readonly credential: Credential }
  // a plain GET of a path under the repository (the dumb HTTP protocol's files), no Git-Protocol header
  | { readonly tag: 'get'; readonly path: DumbPath };
export type DumbPath = '/info/refs' | '/HEAD' | '/objects/info/packs';
// What the target holds before the plan: main at base, or main plus `heads` branches under refs/heads/many/ (alternately
// at base and next) and `tags` lightweight tags under refs/tags/many/ at base.
export type WireSeedForm = { readonly tag: 'base' } | { readonly tag: 'many-refs'; readonly heads: number; readonly tags: number };
// The answer each sender should get:
//   v0-advertisement   200 with `# service=git-upload-pack`, then main at base and the capabilities
//   ls-refs-main       200, main at base in the ls-refs answer
//   landed             a report `unpack ok` and `ok` for the ref; the ref then at next
//   refused            the request does not succeed: status 400 or more, an ERR packet, a report naming an unpack error or
//                      `ng`, or no answer body at all; the sender's ref absent afterwards
//   object-info        if the v2 advertisement lists object-info: the size of base's a.txt; otherwise refused
//   status             one of these HTTP statuses on the info/refs GET (or, for ply and git, their class of it)
//   ref-landed         the sender's ref (`<c>` filled) created at next: a report `ok` for it (git, ply: landed), main at base,
//                      fsck clean
//   ref-refused        refused (as `refused`, or refused by the sending client before any request), and the repository
//                      exactly as seeded: no ref added, main at base, fsck clean
//   ref-either         one of the two, consistently (the server's choice: a length only a filesystem bounds)
//   dumb               a dumb-HTTP file: refused with a 4xx (a smart-only server), or served with the right content (info/refs:
//                      main at base; HEAD: `ref: refs/heads/main`; objects/info/packs: `P pack-<id>.pack` lines)
//   listing            every seeded ref with its id, nothing else (HEAD and peeled lines aside)
export type Answer =
  | { readonly tag: 'v0-advertisement' }
  | { readonly tag: 'ls-refs-main' }
  | { readonly tag: 'landed' }
  | { readonly tag: 'refused' }
  | { readonly tag: 'object-info' }
  | { readonly tag: 'status'; readonly statuses: readonly [HttpRefusal, ...HttpRefusal[]] }
  | { readonly tag: 'ref-landed'; readonly ref: string }
  | { readonly tag: 'ref-refused'; readonly ref: string }
  | { readonly tag: 'ref-either'; readonly ref: string }
  | { readonly tag: 'dumb'; readonly path: DumbPath }
  | { readonly tag: 'listing' };
export type HttpRefusal = 401 | 403 | 404;
// Stock git's own request for the same thing, and ply's:
export type GitForm =
  | { readonly tag: 'none'; readonly why: string }
  | { readonly tag: 'ls-remote-v0' } // git -c protocol.version=0 ls-remote
  | { readonly tag: 'push-chunked' } // git -c http.postBuffer=4096 push next:refs/heads/wire-git (chunked body)
  | { readonly tag: 'fetch-filter' } // git fetch --filter=<filter> of main into an empty repository
  | { readonly tag: 'ls-remote' } // git ls-remote, with the plan's credential
  | { readonly tag: 'push-ref' } // git push next:<the answer's ref>
  | { readonly tag: 'ls-remote-dumb' } // GIT_SMART_HTTP=0 git ls-remote: the dumb protocol's info/refs
  | { readonly tag: 'ls-remote-all'; readonly protocol: 'v0' | 'v2' }; // git ls-remote of every ref
export type PlyForm =
  | { readonly tag: 'none'; readonly why: string }
  | { readonly tag: 'fetch-filter' } // fetchPack({ wants: [base], filter })
  | { readonly tag: 'ls-refs' } // lsRefs, with the plan's credential
  | { readonly tag: 'push-ref' } // push({ commands: [create <the answer's ref> at next], objects: next's })
  | { readonly tag: 'ls-refs-all' }; // lsRefs() of every ref
export type WirePlan = {
  readonly id: WireId;
  readonly description: string;
  readonly request: WireRequest;
  readonly seed: WireSeedForm;
  readonly curl: boolean; // curl can send this request as written
  readonly git: GitForm;
  readonly ply: PlyForm;
  readonly expect: Answer;
};

const BASE: WireSeedForm = { tag: 'base' };
const GZIP: Encoding = { tag: 'gzip' };
const IDENTITY: Encoding = { tag: 'identity' };
const LENGTH: Framing = { tag: 'length' };
const SERVICE: ContentType = { tag: 'service' };
const NO_GIT = (why: string): GitForm => ({ tag: 'none', why });
const NO_PLY = (why: string): PlyForm => ({ tag: 'none', why });
const PLY_NEVER = NO_PLY('ply writes only well-formed, identity-encoded, Content-Length requests');
// upload-pack speaks v2, receive-pack v0 (git's own choice for each)
const rpc = (service: Service, body: WireBody): RpcRequest => ({ tag: 'rpc', service, protocol: service === 'git-upload-pack' ? 'v2' : 'v0', contentType: SERVICE, encoding: IDENTITY, framing: LENGTH, body });

// ---- ref and object semantics (phase 4) ----
// A create of `ref` at next with the given capabilities, raw only (curl would send the same bytes).
const RS = 'report-status';
const createRef = (ref: string, caps: string = RS): RpcRequest => rpc('git-receive-pack', { tag: 'push-ref', ref, old: 'zero', new: 'next', caps });
// A name receive-pack refuses ("funny refname"): stock git and ply refuse it before sending (a client-side refusal meets
// the answer: the server is asked by the raw sender alone).
const badName = (variant: string, ref: string, what: string): WirePlan => ({
  id: `push.ref-name-rules#${variant}`, description: `A create of ${what} is refused (check-ref-format); nothing is added.`,
  request: createRef(ref), seed: BASE, curl: false, git: { tag: 'push-ref' }, ply: { tag: 'push-ref' }, expect: { tag: 'ref-refused', ref },
});
const ONE_FORM = 'the name has one form, so a second sender would meet the first one\'s ref; ply\'s own check of it is test/space/refname.test.js';
const LONG = (n: number, c: string): string => c.repeat(n);
const PATH_OF = (components: number, width: number): string => Array.from({ length: components }, (_, i) => `${String(i).padStart(2, '0')}${LONG(width - 2, 'd')}`).join('/');
const MANY_REFS: WireSeedForm = { tag: 'many-refs', heads: 1500, tags: 500 };
const PHASE4: readonly WirePlan[] = [
  badName('dot-dot', 'refs/heads/a..b', '`refs/heads/a..b` (two dots)'),
  badName('at-brace', 'refs/heads/a@{b', '`refs/heads/a@{b` (`@{`)'),
  badName('lock-suffix', 'refs/heads/x.lock', '`refs/heads/x.lock` (a `.lock` suffix)'),
  badName('control-char', 'refs/heads/a\u0001b', 'a name with a control character (0x01)'),
  badName('del-char', 'refs/heads/a\u007fb', 'a name with DEL (0x7f)'),
  badName('space', 'refs/heads/a b', 'a name with a space'),
  badName('colon', 'refs/heads/a:b', 'a name with a colon'),
  badName('backslash', 'refs/heads/a\\b', 'a name with a backslash'),
  badName('double-slash', 'refs/heads//x', '`refs/heads//x` (an empty component)'),
  badName('trailing-slash', 'refs/heads/x/', '`refs/heads/x/` (a trailing slash)'),
  badName('trailing-dot', 'refs/heads/x.', '`refs/heads/x.` (a trailing dot)'),
  badName('dot-component', 'refs/heads/.x', '`refs/heads/.x` (a component starting with a dot)'),
  badName('bare-head', 'HEAD', '`HEAD` itself (not under refs/)'),
  { id: 'push.ref-name-rules#leading-dash', description: 'A create of `refs/heads/-<sender>` (a component starting with `-`, which check-ref-format allows and `git branch` does not) lands.', request: createRef('refs/heads/-<c>'), seed: BASE, curl: false, git: { tag: 'push-ref' }, ply: { tag: 'push-ref' }, expect: { tag: 'ref-landed', ref: 'refs/heads/-<c>' } },
  { id: 'push.ref-name-rules#refs-heads-at', description: 'A create of `refs/heads/@` (`@` alone is refused only as a whole name) lands.', request: createRef('refs/heads/@'), seed: BASE, curl: false, git: NO_GIT(ONE_FORM), ply: NO_PLY(ONE_FORM), expect: { tag: 'ref-landed', ref: 'refs/heads/@' } },
  { id: 'push.ref-name-rules#refs-heads-head', description: 'A create of `refs/heads/HEAD` (a branch named HEAD: a valid ref name receive-pack accepts) lands.', request: createRef('refs/heads/HEAD'), seed: BASE, curl: false, git: NO_GIT(ONE_FORM), ply: NO_PLY(ONE_FORM), expect: { tag: 'ref-landed', ref: 'refs/heads/HEAD' } },
  { id: 'push.ref-name-rules#component-200', description: 'A create of a branch whose last component is 200 bytes lands.', request: createRef(`refs/heads/<c>-${LONG(200, 'x')}`), seed: BASE, curl: false, git: { tag: 'push-ref' }, ply: { tag: 'push-ref' }, expect: { tag: 'ref-landed', ref: `refs/heads/<c>-${LONG(200, 'x')}` } },
  { id: 'push.ref-name-rules#path-1000', description: 'A create of a branch about 1000 bytes long in 19 components of 50 lands.', request: createRef(`refs/heads/<c>/${PATH_OF(19, 50)}`), seed: BASE, curl: false, git: { tag: 'push-ref' }, ply: { tag: 'push-ref' }, expect: { tag: 'ref-landed', ref: `refs/heads/<c>/${PATH_OF(19, 50)}` } },
  { id: 'push.ref-name-rules#component-300', description: 'A create of a branch whose last component is 300 bytes (over most filesystems\' 255-byte name limit): landed or refused, never half-written.', request: createRef(`refs/heads/<c>-${LONG(300, 'y')}`), seed: BASE, curl: false, git: { tag: 'push-ref' }, ply: { tag: 'push-ref' }, expect: { tag: 'ref-either', ref: `refs/heads/<c>-${LONG(300, 'y')}` } },
  { id: 'push.ref-name-rules#path-4000', description: 'A create of a branch about 4000 bytes long in 40 components of 99 (near PATH_MAX): landed or refused, never half-written.', request: createRef(`refs/heads/<c>/${PATH_OF(40, 99)}`), seed: BASE, curl: false, git: { tag: 'push-ref' }, ply: { tag: 'push-ref' }, expect: { tag: 'ref-either', ref: `refs/heads/<c>/${PATH_OF(40, 99)}` } },
  // ---- unknown capabilities ----
  { id: 'caps.receive-pack-capabilities#unknown-capability-on-push', description: 'A receive-pack command listing a capability the server never advertised (`frobnicate=1`) still lands: receive-pack ignores what it does not know.', request: createRef('refs/heads/wire-<c>', `${RS} frobnicate=1`), seed: BASE, curl: true, git: NO_GIT('git sends only capabilities the server advertised'), ply: NO_PLY('ply sends only capabilities the server advertised'), expect: { tag: 'ref-landed', ref: 'refs/heads/wire-<c>' } },
  { id: 'caps.v2-capability-advertisement#unknown-capability-line', description: 'A v2 fetch whose capability section carries `frobnicate=1`, never advertised, is refused.', request: rpc('git-upload-pack', { tag: 'v2', command: 'fetch', capLines: ['agent=ply-wire-probe', 'frobnicate=1'], argLines: ['want <base>', 'no-progress', 'done'] }), seed: BASE, curl: true, git: NO_GIT('git sends only advertised capabilities'), ply: NO_PLY('ply sends only advertised capabilities'), expect: { tag: 'refused' } },
  { id: 'caps.fetch-argument-gating#unknown-fetch-argument', description: 'A v2 fetch with an argument line no version of git defines (`frobnicate`) is refused.', request: rpc('git-upload-pack', { tag: 'v2', command: 'fetch', capLines: ['agent=ply-wire-probe'], argLines: ['want <base>', 'frobnicate', 'no-progress', 'done'] }), seed: BASE, curl: true, git: NO_GIT('git sends only arguments it defines'), ply: NO_PLY('ply sends only arguments it defines'), expect: { tag: 'refused' } },
  { id: 'refs.ls-refs-listing#unknown-argument', description: 'A v2 ls-refs with an argument line no version of git defines (`frobnicate`) is refused.', request: rpc('git-upload-pack', { tag: 'v2', command: 'ls-refs', capLines: ['agent=ply-wire-probe'], argLines: ['frobnicate', 'ref-prefix refs/heads/'] }), seed: BASE, curl: true, git: NO_GIT('git sends only arguments it defines'), ply: NO_PLY('ply sends only arguments it defines'), expect: { tag: 'refused' } },
  // ---- the dumb HTTP protocol ----
  { id: 'http.expect-continue-and-dumb-http#dumb-info-refs', description: 'GET info/refs with no service (the dumb protocol): refused with a 4xx, or main at base.', request: { tag: 'get', path: '/info/refs' }, seed: BASE, curl: false, git: { tag: 'ls-remote-dumb' }, ply: NO_PLY('ply speaks only smart HTTP'), expect: { tag: 'dumb', path: '/info/refs' } },
  { id: 'http.expect-continue-and-dumb-http#dumb-head', description: 'GET HEAD (the dumb protocol\'s symref file): refused with a 4xx, or `ref: refs/heads/main`.', request: { tag: 'get', path: '/HEAD' }, seed: BASE, curl: false, git: NO_GIT('git reads HEAD only after a dumb info/refs, which the info-refs plan covers'), ply: NO_PLY('ply speaks only smart HTTP'), expect: { tag: 'dumb', path: '/HEAD' } },
  { id: 'http.expect-continue-and-dumb-http#dumb-objects-info-packs', description: 'GET objects/info/packs: refused with a 4xx, or `P pack-<id>.pack` lines.', request: { tag: 'get', path: '/objects/info/packs' }, seed: BASE, curl: false, git: NO_GIT('git reads it only after a dumb info/refs, which the info-refs plan covers'), ply: NO_PLY('ply speaks only smart HTTP'), expect: { tag: 'dumb', path: '/objects/info/packs' } },
  // ---- a 2001-ref advertisement ----
  { id: 'refs.ls-refs-listing#two-thousand-refs', description: 'v2 ls-refs of a repository with main, 1500 branches and 500 tags lists all 2001 with their ids.', request: rpc('git-upload-pack', { tag: 'ls-refs-all' }), seed: MANY_REFS, curl: true, git: { tag: 'ls-remote-all', protocol: 'v2' }, ply: { tag: 'ls-refs-all' }, expect: { tag: 'listing' } },
  { id: 'refs.v0-upload-pack-advertisement#two-thousand-refs', description: 'The v0 upload-pack advertisement of the same 2001-ref repository lists all 2001 with their ids.', request: { tag: 'advertise', service: 'git-upload-pack', protocol: 'v0' }, seed: MANY_REFS, curl: true, git: { tag: 'ls-remote-all', protocol: 'v0' }, ply: NO_PLY('ply asks for v2 and refuses a v0 answer (src/caps.ts)'), expect: { tag: 'listing' } },
];

export const WIRE: readonly WirePlan[] = [
  // ---- request content encoding ----
  { id: 'http.request-content-encoding#gzip-ls-refs', description: 'A gzip-encoded v2 ls-refs (Content-Encoding: gzip) is read as the plain request: main at base.', request: { ...rpc('git-upload-pack', { tag: 'ls-refs' }), encoding: GZIP }, curl: true, git: NO_GIT('git gzips an upload-pack body only past 1 KiB of haves; not expressible as a fixed request'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'ls-refs-main' } },
  { id: 'http.request-content-encoding#gzip-receive-pack', description: 'A gzip-encoded receive-pack request (commands and pack) lands.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), encoding: GZIP }, curl: true, git: NO_GIT('git never gzips a receive-pack body'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'landed' } },
  { id: 'http.request-content-encoding#corrupt-gzip', description: 'A gzip receive-pack body whose deflate stream is damaged is refused, and the ref is not created.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), encoding: { tag: 'gzip-corrupt' } }, curl: true, git: NO_GIT('git never gzips a receive-pack body'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  // ---- framing ----
  { id: 'http.content-length-framing#chunked-receive-pack', description: 'A receive-pack request sent with Transfer-Encoding: chunked lands (stock git does this past http.postBuffer).', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), framing: { tag: 'chunked' } }, curl: true, git: { tag: 'push-chunked' }, ply: NO_PLY('ply always states the length (pushPack length)'), seed: BASE, expect: { tag: 'landed' } },
  { id: 'http.content-length-framing#length-short', description: 'A receive-pack request whose Content-Length is 64 bytes short of its body: the server reads a truncated pack and refuses it; the ref is not created.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), framing: { tag: 'length-off', by: -64 } }, curl: false, git: NO_GIT('git frames its own requests'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  { id: 'http.content-length-framing#length-long', description: 'A receive-pack request whose Content-Length is 64 bytes more than it sends before half-closing: refused, the ref is not created.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), framing: { tag: 'length-off', by: 64 } }, curl: false, git: NO_GIT('git frames its own requests'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  { id: 'http.expect-continue-and-dumb-http#expect-100-receive-pack', description: 'A receive-pack request with Expect: 100-continue lands, whether or not the server sends the interim 100.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), framing: { tag: 'expect-continue' } }, curl: true, git: NO_GIT('git sends no Expect header (it clears curl\'s)'), ply: NO_PLY('ply never sends Expect'), seed: BASE, expect: { tag: 'landed' } },
  // ---- malformed requests ----
  { id: 'errors.malformed-requests-to-server#nonhex-length', description: 'A v2 upload-pack body whose first pkt-line length is `zzzz` is refused.', request: rpc('git-upload-pack', { tag: 'bytes', latin1: 'zzzzcommand=ls-refs\n0000' }), curl: true, git: NO_GIT('git writes well-formed pkt-lines'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#oversized-length', description: 'A v2 upload-pack body whose first pkt-line claims 65535 bytes (over the 65520 maximum) and holds 16 is refused.', request: rpc('git-upload-pack', { tag: 'bytes', latin1: 'ffffcommand=ls-refs\n0000' }), curl: true, git: NO_GIT('git writes well-formed pkt-lines'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#missing-flush', description: 'A v2 ls-refs whose arguments end without a flush packet is refused (or answered with nothing).', request: rpc('git-upload-pack', { tag: 'ls-refs-no-flush' }), curl: true, git: NO_GIT('git writes well-formed pkt-lines'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#unknown-command', description: 'A v2 command=frobnicate is refused (ERR or 4xx).', request: rpc('git-upload-pack', { tag: 'unknown-command' }), curl: true, git: NO_GIT('git sends only commands it knows'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#wrong-content-type', description: 'A well-formed v2 ls-refs POSTed as text/plain is refused.', request: { ...rpc('git-upload-pack', { tag: 'ls-refs' }), contentType: { tag: 'other', value: 'text/plain' } }, curl: true, git: NO_GIT('git sends the service content type'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#bad-service', description: 'GET info/refs?service=git-frobnicate is refused.', request: { tag: 'advertise', service: 'git-frobnicate', protocol: 'v2' }, curl: true, git: NO_GIT('git names only real services'), ply: PLY_NEVER, seed: BASE, expect: { tag: 'refused' } },
  // ---- v0 advertisement, object-info, filter ----
  { id: 'refs.v0-upload-pack-advertisement#no-protocol-header', description: 'GET info/refs?service=git-upload-pack without Git-Protocol is the v0 advertisement: the service line, main at base, capabilities.', request: { tag: 'advertise', service: 'git-upload-pack', protocol: 'v0' }, curl: true, git: { tag: 'ls-remote-v0' }, ply: NO_PLY('ply asks for v2 and refuses a v0 answer (src/caps.ts)'), seed: BASE, expect: { tag: 'v0-advertisement' } },
  { id: 'caps.object-info#size', description: 'v2 object-info for base\'s a.txt: its size when the advertisement lists object-info, refused when it does not.', request: rpc('git-upload-pack', { tag: 'object-info' }), curl: true, git: NO_GIT('stock git 2.47 has no command that sends object-info over HTTP'), ply: NO_PLY('no ply operation sends object-info'), seed: BASE, expect: { tag: 'object-info' } },
  { id: 'fetch.filter-sparse-oid#refused', description: 'A v2 fetch with filter sparse:oid=<blob> is refused (blob:none is the only filter allowed).', request: rpc('git-upload-pack', { tag: 'fetch-filter', filter: 'sparse:oid' }), curl: true, git: { tag: 'fetch-filter' }, ply: { tag: 'fetch-filter' }, seed: BASE, expect: { tag: 'refused' } },
  // ---- status classes (Artifacts only) ----
  { id: 'errors.http-status-classes#no-credential', description: 'The upload-pack advertisement of a private repository with no credential: 401.', request: { tag: 'credential', credential: 'none' }, curl: true, git: { tag: 'ls-remote' }, ply: { tag: 'ls-refs' }, seed: BASE, expect: { tag: 'status', statuses: [401] } },
  { id: 'errors.http-status-classes#bogus-token', description: 'A bearer token that was never minted: 401.', request: { tag: 'credential', credential: 'bogus' }, curl: true, git: { tag: 'ls-remote' }, ply: { tag: 'ls-refs' }, seed: BASE, expect: { tag: 'status', statuses: [401] } },
  { id: 'errors.http-status-classes#revoked-token', description: 'A revoked token: 403.', request: { tag: 'credential', credential: 'revoked' }, curl: true, git: { tag: 'ls-remote' }, ply: { tag: 'ls-refs' }, seed: BASE, expect: { tag: 'status', statuses: [403] } },
  { id: 'errors.http-status-classes#missing-repo', description: 'A repository-scoped token on a path it does not cover, where no repository exists: 403 or 404 (whether the answer reveals that the repository is absent is the server\'s choice).', request: { tag: 'credential', credential: 'missing-repo' }, curl: true, git: { tag: 'ls-remote' }, ply: { tag: 'ls-refs' }, seed: BASE, expect: { tag: 'status', statuses: [403, 404] } },
  ...PHASE4,
];

// Corners a plan runs with, in order.
export function cornersOf(p: WirePlan): readonly Corner[] {
  return [
    'raw' as const,
    ...(p.curl ? ['curl' as const] : []),
    ...(p.git.tag === 'none' ? [] : ['git' as const]),
    ...(p.ply.tag === 'none' ? [] : ['ply' as const]),
  ];
}
// Whether the reference can answer the plan (git http-backend has no authentication).
export const onReference = (p: WirePlan): boolean => p.request.tag !== 'credential';

// Results that do not meet their plan's answer and are expected not to, each with its reason. An entry no result used,
// in a run that sent its plan to its target with its sender, fails that run.
export type WireAllow = { readonly plan: WireId; readonly target: 'ref' | 'art'; readonly corner: Corner; readonly cls: string; readonly reason: string };
export const WIRE_ALLOW: readonly WireAllow[] = [
  {
    plan: 'http.content-length-framing#length-long', target: 'ref', corner: 'raw', cls: 'status:400',
    reason: 'The reference\'s Node HTTP front end answers 400 when the client half-closes short of its Content-Length, but it has already piped the whole body to git http-backend, and the pack is complete (self-delimited, trailer intact), so receive-pack applies it: the client is told 400 and the ref exists. A property of test/server.js\'s shim, not of git; Artifacts\' answer is judged on its own.',
  },
];
