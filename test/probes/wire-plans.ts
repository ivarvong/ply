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
export type WireBody =
  | { readonly tag: 'ls-refs' }
  | { readonly tag: 'object-info' }
  | { readonly tag: 'fetch-filter'; readonly filter: string }
  | { readonly tag: 'unknown-command' }
  | { readonly tag: 'push-create' }
  | { readonly tag: 'bytes'; readonly latin1: string }
  | { readonly tag: 'ls-refs-no-flush' };
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
  | { readonly tag: 'credential'; readonly credential: Credential };
// The answer each sender should get:
//   v0-advertisement   200 with `# service=git-upload-pack`, then main at base and the capabilities
//   ls-refs-main       200, main at base in the ls-refs answer
//   landed             a report `unpack ok` and `ok` for the ref; the ref then at next
//   refused            the request does not succeed: status 400 or more, an ERR packet, a report naming an unpack error or
//                      `ng`, or no answer body at all; the sender's ref absent afterwards
//   object-info        if the v2 advertisement lists object-info: the size of base's a.txt; otherwise refused
//   status             one of these HTTP statuses on the info/refs GET (or, for ply and git, their class of it)
export type Answer =
  | { readonly tag: 'v0-advertisement' }
  | { readonly tag: 'ls-refs-main' }
  | { readonly tag: 'landed' }
  | { readonly tag: 'refused' }
  | { readonly tag: 'object-info' }
  | { readonly tag: 'status'; readonly statuses: readonly [HttpRefusal, ...HttpRefusal[]] };
export type HttpRefusal = 401 | 403 | 404;
// Stock git's own request for the same thing, and ply's:
export type GitForm =
  | { readonly tag: 'none'; readonly why: string }
  | { readonly tag: 'ls-remote-v0' } // git -c protocol.version=0 ls-remote
  | { readonly tag: 'push-chunked' } // git -c http.postBuffer=4096 push next:refs/heads/wire-git (chunked body)
  | { readonly tag: 'fetch-filter' } // git fetch --filter=<filter> of main into an empty repository
  | { readonly tag: 'ls-remote' }; // git ls-remote, with the plan's credential
export type PlyForm =
  | { readonly tag: 'none'; readonly why: string }
  | { readonly tag: 'fetch-filter' } // fetchPack({ wants: [base], filter })
  | { readonly tag: 'ls-refs' }; // lsRefs, with the plan's credential
export type WirePlan = {
  readonly id: WireId;
  readonly description: string;
  readonly request: WireRequest;
  readonly curl: boolean; // curl can send this request as written
  readonly git: GitForm;
  readonly ply: PlyForm;
  readonly expect: Answer;
};

const GZIP: Encoding = { tag: 'gzip' };
const IDENTITY: Encoding = { tag: 'identity' };
const LENGTH: Framing = { tag: 'length' };
const SERVICE: ContentType = { tag: 'service' };
const NO_GIT = (why: string): GitForm => ({ tag: 'none', why });
const NO_PLY = (why: string): PlyForm => ({ tag: 'none', why });
const PLY_NEVER = NO_PLY('ply writes only well-formed, identity-encoded, Content-Length requests');
// upload-pack speaks v2, receive-pack v0 (git's own choice for each)
const rpc = (service: Service, body: WireBody): RpcRequest => ({ tag: 'rpc', service, protocol: service === 'git-upload-pack' ? 'v2' : 'v0', contentType: SERVICE, encoding: IDENTITY, framing: LENGTH, body });

export const WIRE: readonly WirePlan[] = [
  // ---- request content encoding ----
  { id: 'http.request-content-encoding#gzip-ls-refs', description: 'A gzip-encoded v2 ls-refs (Content-Encoding: gzip) is read as the plain request: main at base.', request: { ...rpc('git-upload-pack', { tag: 'ls-refs' }), encoding: GZIP }, curl: true, git: NO_GIT('git gzips an upload-pack body only past 1 KiB of haves; not expressible as a fixed request'), ply: PLY_NEVER, expect: { tag: 'ls-refs-main' } },
  { id: 'http.request-content-encoding#gzip-receive-pack', description: 'A gzip-encoded receive-pack request (commands and pack) lands.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), encoding: GZIP }, curl: true, git: NO_GIT('git never gzips a receive-pack body'), ply: PLY_NEVER, expect: { tag: 'landed' } },
  { id: 'http.request-content-encoding#corrupt-gzip', description: 'A gzip receive-pack body whose deflate stream is damaged is refused, and the ref is not created.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), encoding: { tag: 'gzip-corrupt' } }, curl: true, git: NO_GIT('git never gzips a receive-pack body'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  // ---- framing ----
  { id: 'http.content-length-framing#chunked-receive-pack', description: 'A receive-pack request sent with Transfer-Encoding: chunked lands (stock git does this past http.postBuffer).', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), framing: { tag: 'chunked' } }, curl: true, git: { tag: 'push-chunked' }, ply: NO_PLY('ply always states the length (pushPack length)'), expect: { tag: 'landed' } },
  { id: 'http.content-length-framing#length-short', description: 'A receive-pack request whose Content-Length is 64 bytes short of its body: the server reads a truncated pack and refuses it; the ref is not created.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), framing: { tag: 'length-off', by: -64 } }, curl: false, git: NO_GIT('git frames its own requests'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  { id: 'http.content-length-framing#length-long', description: 'A receive-pack request whose Content-Length is 64 bytes more than it sends before half-closing: refused, the ref is not created.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), framing: { tag: 'length-off', by: 64 } }, curl: false, git: NO_GIT('git frames its own requests'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  { id: 'http.expect-continue-and-dumb-http#expect-100-receive-pack', description: 'A receive-pack request with Expect: 100-continue lands, whether or not the server sends the interim 100.', request: { ...rpc('git-receive-pack', { tag: 'push-create' }), framing: { tag: 'expect-continue' } }, curl: true, git: NO_GIT('git sends no Expect header (it clears curl\'s)'), ply: NO_PLY('ply never sends Expect'), expect: { tag: 'landed' } },
  // ---- malformed requests ----
  { id: 'errors.malformed-requests-to-server#nonhex-length', description: 'A v2 upload-pack body whose first pkt-line length is `zzzz` is refused.', request: rpc('git-upload-pack', { tag: 'bytes', latin1: 'zzzzcommand=ls-refs\n0000' }), curl: true, git: NO_GIT('git writes well-formed pkt-lines'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#oversized-length', description: 'A v2 upload-pack body whose first pkt-line claims 65535 bytes (over the 65520 maximum) and holds 16 is refused.', request: rpc('git-upload-pack', { tag: 'bytes', latin1: 'ffffcommand=ls-refs\n0000' }), curl: true, git: NO_GIT('git writes well-formed pkt-lines'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#missing-flush', description: 'A v2 ls-refs whose arguments end without a flush packet is refused (or answered with nothing).', request: rpc('git-upload-pack', { tag: 'ls-refs-no-flush' }), curl: true, git: NO_GIT('git writes well-formed pkt-lines'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#unknown-command', description: 'A v2 command=frobnicate is refused (ERR or 4xx).', request: rpc('git-upload-pack', { tag: 'unknown-command' }), curl: true, git: NO_GIT('git sends only commands it knows'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#wrong-content-type', description: 'A well-formed v2 ls-refs POSTed as text/plain is refused.', request: { ...rpc('git-upload-pack', { tag: 'ls-refs' }), contentType: { tag: 'other', value: 'text/plain' } }, curl: true, git: NO_GIT('git sends the service content type'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  { id: 'errors.malformed-requests-to-server#bad-service', description: 'GET info/refs?service=git-frobnicate is refused.', request: { tag: 'advertise', service: 'git-frobnicate', protocol: 'v2' }, curl: true, git: NO_GIT('git names only real services'), ply: PLY_NEVER, expect: { tag: 'refused' } },
  // ---- v0 advertisement, object-info, filter ----
  { id: 'refs.v0-upload-pack-advertisement#no-protocol-header', description: 'GET info/refs?service=git-upload-pack without Git-Protocol is the v0 advertisement: the service line, main at base, capabilities.', request: { tag: 'advertise', service: 'git-upload-pack', protocol: 'v0' }, curl: true, git: { tag: 'ls-remote-v0' }, ply: NO_PLY('ply asks for v2 and refuses a v0 answer (src/caps.ts)'), expect: { tag: 'v0-advertisement' } },
  { id: 'caps.object-info#size', description: 'v2 object-info for base\'s a.txt: its size when the advertisement lists object-info, refused when it does not.', request: rpc('git-upload-pack', { tag: 'object-info' }), curl: true, git: NO_GIT('stock git 2.47 has no command that sends object-info over HTTP'), ply: NO_PLY('no ply operation sends object-info'), expect: { tag: 'object-info' } },
  { id: 'fetch.filter-sparse-oid#refused', description: 'A v2 fetch with filter sparse:oid=<blob> is refused (blob:none is the only filter allowed).', request: rpc('git-upload-pack', { tag: 'fetch-filter', filter: 'sparse:oid' }), curl: true, git: { tag: 'fetch-filter' }, ply: { tag: 'fetch-filter' }, expect: { tag: 'refused' } },
  // ---- status classes (Artifacts only) ----
  { id: 'errors.http-status-classes#no-credential', description: 'The upload-pack advertisement of a private repository with no credential: 401.', request: { tag: 'credential', credential: 'none' }, curl: true, git: { tag: 'ls-remote' }, ply: { tag: 'ls-refs' }, expect: { tag: 'status', statuses: [401] } },
  { id: 'errors.http-status-classes#bogus-token', description: 'A bearer token that was never minted: 401.', request: { tag: 'credential', credential: 'bogus' }, curl: true, git: { tag: 'ls-remote' }, ply: { tag: 'ls-refs' }, expect: { tag: 'status', statuses: [401] } },
  { id: 'errors.http-status-classes#revoked-token', description: 'A revoked token: 403.', request: { tag: 'credential', credential: 'revoked' }, curl: true, git: { tag: 'ls-remote' }, ply: { tag: 'ls-refs' }, expect: { tag: 'status', statuses: [403] } },
  { id: 'errors.http-status-classes#missing-repo', description: 'A repository-scoped token on a path it does not cover, where no repository exists: 403 or 404 (whether the answer reveals that the repository is absent is the server\'s choice).', request: { tag: 'credential', credential: 'missing-repo' }, curl: true, git: { tag: 'ls-remote' }, ply: { tag: 'ls-refs' }, expect: { tag: 'status', statuses: [403, 404] } },
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
