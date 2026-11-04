// Decoding a v2 upload-pack request: the inverse of fetchBody (fetch.ts) and lsRefsBody (lsrefs.ts), for the cache
// that has to say what a request asks for (packcache.ts exchangeKind, verifyFetchAnswer). A pkt-line step machine
// over the frames pktStep reads, one line at a time (no pattern over the whole body), as git's serve.c process_request
// reads it: `command=<name>`, capability lines, a delim, the command's arguments, a flush, and nothing after it.
// Every argument upload-pack.c process_args (fetch) and ls-refs.c (ls-refs) accepts is decoded; anything else is
// refused, so a request the cache cannot read is never judged pure.
/* oxlint-disable require-unicode-regexp -- ASCII wire text; `u` costs a byte per literal */
import type { ErrorOf } from './errors.js';
import type { PktFrame } from './pktline.js';
import type { Result } from './result.js';
import { fail } from './errors.js';
import { decodeBytes } from './bytes.js';
import { pktInit, pktStep, pktFinish } from './pktline.js';
import { OID_HEX_CHARS } from './format.js';
import { assertNever, ok } from './result.js';

export type LsRefsRequest = {
  readonly command: 'ls-refs';
  readonly caps: readonly string[];
  readonly prefixes: readonly string[];
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
};
// The fields of FetchConfig (fetch.ts) with their absent values (an empty filter, a zero deepen and deepen-since), so
// parseUploadPackRequest(fetchBody(x)) is x with its defaults filled; plus what git sends and ply does not.
export type FetchRequest = {
  readonly command: 'fetch';
  readonly caps: readonly string[];
  readonly wants: readonly string[];
  readonly wantRefs: readonly string[];
  readonly haves: readonly string[];
  readonly shallows: readonly string[];
  readonly filter: string;
  readonly deepen: number;
  readonly deepenSince: number;
  readonly deepenNot: readonly string[];
  readonly deepenRelative: boolean;
  readonly thinPack: boolean;
  readonly ofsDelta: boolean;
  readonly includeTag: boolean;
  readonly noProgress: boolean;
  readonly done: boolean;
  readonly sidebandAll: boolean;
  readonly waitForDone: boolean;
  readonly packfileUris: string;
};
export type UploadPackRequest = LsRefsRequest | FetchRequest;

type Bad = ErrorOf<'protocol'>;
const bad = (msg: string): Result<never, Bad> => fail('protocol', `upload-pack request: ${msg}`);

const OID = new RegExp(`^[0-9a-fA-F]{${OID_HEX_CHARS}}$`);
const DIGITS = /^[0-9]+$/;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K] };

const lsRefsInit = (caps: string[]): Mutable<LsRefsRequest> => ({ command: 'ls-refs', caps, prefixes: [], peel: false, symrefs: false, unborn: false });
const fetchInit = (caps: string[]): Mutable<FetchRequest> => ({
  command: 'fetch', caps, wants: [], wantRefs: [], haves: [], shallows: [], filter: '', deepen: 0, deepenSince: 0, deepenNot: [],
  deepenRelative: false, thinPack: false, ofsDelta: false, includeTag: false, noProgress: false, done: false, sidebandAll: false, waitForDone: false, packfileUris: '',
});

// A positive count: git's upload-pack dies on a deepen or deepen-since it cannot read as one (fetchBody leaves 0 out).
function count(value: string, what: string): Result<number, Bad> {
  const n = Number(value);
  if (!DIGITS.test(value) || !Number.isSafeInteger(n) || n === 0) return bad(`${what} must be a positive integer`);
  return ok(n);
}

const FETCH_FLAGS = {
  'done': 'done', 'thin-pack': 'thinPack', 'ofs-delta': 'ofsDelta', 'include-tag': 'includeTag', 'no-progress': 'noProgress',
  'deepen-relative': 'deepenRelative', 'sideband-all': 'sidebandAll', 'wait-for-done': 'waitForDone',
} as const;
const FETCH_OIDS = { want: 'wants', have: 'haves', shallow: 'shallows' } as const;
const FETCH_NAMES = { 'want-ref': 'wantRefs', 'deepen-not': 'deepenNot' } as const;
const isKey = <O extends object>(o: O, k: string): k is Extract<keyof O, string> => Object.hasOwn(o, k);

// The single-valued arguments: a second one is refused, as git dies on a second filter.
const FETCH_ONCE = { 'filter': 'filter', 'packfile-uris': 'packfileUris' } as const;
const FETCH_COUNTS = { 'deepen': 'deepen', 'deepen-since': 'deepenSince' } as const;

// One fetch argument: a flag, an oid, a name, or one of the single-valued arguments.
function fetchArg(r: Mutable<FetchRequest>, key: string, value: string | null): Result<null, Bad> {
  if (value === null) {
    if (!isKey(FETCH_FLAGS, key)) return bad(`unknown fetch argument ${JSON.stringify(key)}`);
    r[FETCH_FLAGS[key]] = true;
    return ok(null);
  }
  if (isKey(FETCH_OIDS, key)) {
    if (!OID.test(value)) return bad(`${key} must be a ${OID_HEX_CHARS}-hex oid`);
    r[FETCH_OIDS[key]].push(value);
    return ok(null);
  }
  if (isKey(FETCH_NAMES, key)) {
    if (value === '') return bad(`${key} needs a value`);
    r[FETCH_NAMES[key]].push(value);
    return ok(null);
  }
  if (isKey(FETCH_ONCE, key)) {
    const field = FETCH_ONCE[key];
    if (r[field] !== '' || value === '') return bad(`${key} must be given once, with a value`);
    r[field] = value;
    return ok(null);
  }
  if (isKey(FETCH_COUNTS, key)) {
    const field = FETCH_COUNTS[key];
    const n = count(value, key);
    if (!n.ok) return n;
    if (r[field] !== 0) return bad(`a second ${key}`);
    r[field] = n.value;
    return ok(null);
  }
  return bad(`unknown fetch argument ${JSON.stringify(key)}`);
}

function lsRefsArg(r: Mutable<LsRefsRequest>, key: string, value: string | null): Result<null, Bad> {
  if (value === null && (key === 'peel' || key === 'symrefs' || key === 'unborn')) { r[key] = true; return ok(null); }
  // an empty prefix is a prefix (lsRefsBody writes one, git matches every ref with it)
  if (key === 'ref-prefix' && value !== null) { r.prefixes.push(value); return ok(null); }
  return bad(`unknown ls-refs argument ${JSON.stringify(key)}`);
}

// The machine: `command` (the first line), `caps` (until the delim, or a flush when there are no arguments), `args`
// (until the flush), `ended` (nothing may follow).
type ReqState =
  | { readonly tag: 'command' }
  | { readonly tag: 'caps'; readonly command: 'fetch' | 'ls-refs'; readonly caps: string[] }
  | { readonly tag: 'args'; readonly request: Mutable<UploadPackRequest> }
  | { readonly tag: 'ended'; readonly request: Mutable<UploadPackRequest> };

// git's packet reader chomps one trailing LF (PACKET_READ_CHOMP_NEWLINE): `want x` and `want x\n` are one line.
const lineOf = (payload: Uint8Array): string => { const s = decodeBytes(payload); return s.endsWith('\n') ? s.slice(0, -1) : s; };
const COMMAND = 'command=';
const start = (command: 'fetch' | 'ls-refs', caps: string[]): Mutable<UploadPackRequest> => (command === 'fetch' ? fetchInit(caps) : lsRefsInit(caps));

function commandLine(f: PktFrame): Result<ReqState, Bad> {
  if (f.kind !== 'data') return bad(`${f.kind} before the command line`);
  const line = lineOf(f.payload);
  if (!line.startsWith(COMMAND)) return bad('the first line is not command=<name>');
  const command = line.slice(COMMAND.length);
  if (command !== 'fetch' && command !== 'ls-refs') return bad(`unsupported command ${JSON.stringify(command)}`);
  return ok({ tag: 'caps', command, caps: [] });
}

function argLine(st: Extract<ReqState, { readonly tag: 'args' }>, f: PktFrame): Result<ReqState, Bad> {
  if (f.kind === 'flush') return ok({ tag: 'ended', request: st.request });
  if (f.kind !== 'data') return bad(`a second ${f.kind}`);
  const line = lineOf(f.payload);
  const sp = line.indexOf(' ');
  const key = sp < 0 ? line : line.slice(0, sp);
  const value = sp < 0 ? null : line.slice(sp + 1);
  const r = st.request.command === 'fetch' ? fetchArg(st.request, key, value) : lsRefsArg(st.request, key, value);
  return r.ok ? ok(st) : r;
}

function reqStep(st: ReqState, f: PktFrame): Result<ReqState, Bad> {
  if (f.kind === 'end') return bad('response-end inside a request');
  switch (st.tag) {
    case 'ended': return bad(`${f.kind} after the flush that ends the request`);
    case 'command': return commandLine(f);
    case 'caps': {
      if (f.kind === 'data') { st.caps.push(lineOf(f.payload)); return ok(st); }
      const request = start(st.command, st.caps);
      return ok(f.kind === 'delim' ? { tag: 'args', request } : { tag: 'ended', request });
    }
    case 'args': return argLine(st, f);
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st);
}

// @decoder parseUploadPackRequest prefix=upload-pack-request
export function parseUploadPackRequest(body: Uint8Array): Result<UploadPackRequest, Bad> {
  const read = pktStep(pktInit(), body);
  if (!read.ok) return read;
  const fin = pktFinish(read.value.state);
  if (!fin.ok) return fin;
  let st: ReqState = { tag: 'command' };
  for (const f of read.value.frames) {
    const next = reqStep(st, f);
    if (!next.ok) return next;
    st = next.value;
  }
  if (st.tag !== 'ended') return bad('no flush ends the request');
  return ok(st.request);
}
