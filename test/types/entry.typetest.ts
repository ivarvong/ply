// The package entry (#100): a consumer imports values and types from index.js, with no casts.
// tsconfig.isolated.json excludes this file (allowJs is false there; index.js is the entry).
import {
  fetchPack, push, spliceDelta, zlibDeflate, Tracer, arrayExporter, createTransport, discover, lsRefs, validateRef,
  fetchObject, packStream, spInit, spStep, spFinish, inflate, commitView, entryType, lsMode, refCandidates,
  isFilterRejection, isPlyCode, DEFAULT_LIMITS,
  type Transport, type ExportLine, type Exporter, type Limits, type FetchOpts, type SpState, type PackObject, type OperationOpts,
} from '../../src/index.js';

declare const transport: Transport;
declare const anyBytes: Uint8Array;
declare const shared: Uint8Array<SharedArrayBuffer>;

// @ts-expect-error kind is the literal 'http'
const kind: Transport['kind'] = 1;
void kind;

const exporter: Exporter = line => {
  const spans: number = line.resourceSpans.length;
  void spans;
};
const tracer = new Tracer({ exporter, maxEvents: 8, resource: { 'service.name': 'ply' } });
const collected = arrayExporter();
const sample: ExportLine = { resourceSpans: [] };
collected(sample);
const stored: number = collected.lines.length;
void stored;

const limits: Limits = DEFAULT_LIMITS;
const made: Transport = createTransport('https://example.test/repo.git', {
  tracer, userAgent: 'ply-web', limits, signal: new AbortController().signal, fetchImpl: globalThis.fetch, quirks: {},
});
void made;

const opts: OperationOpts = { tracer };
void opts;

const fetchOpts: FetchOpts = { wants: ['a'.repeat(40)], filter: 'blob:none' };

// fetchPack → push, and spliceDelta → zlibDeflate, through the entry. SharedArrayBuffer views are inputs.
const consumer = async (): Promise<void> => {
  const fetched = await fetchPack(transport, fetchOpts);
  const objects: PackObject[] = [...(fetched.objects?.values() ?? [])].map(o => ({ type: o.type, data: o.data }));
  await push(transport, { ref: validateRef('refs/heads/x'), oldOid: '0'.repeat(40), newOid: 'b'.repeat(40), objects });
  const { delta } = spliceDelta({ baseLen: 8, off: 0, oldLen: 1, insert: anyBytes });
  const deflated: Uint8Array<ArrayBuffer> = await zlibDeflate(delta);
  await zlibDeflate(shared);
  void deflated;

  const info = await discover(transport);
  const caps: ReadonlyMap<string, string> | Map<string, string> = info.caps;
  void caps;
  const listed = await lsRefs(transport, ['refs/heads/']);
  const head: string | null = listed.head;
  void head;
  const object = await fetchObject(transport, { oid: 'c'.repeat(40), filter: 'blob:none' });
  const view = commitView(object.data, limits);
  const tree: string | null = view.tree;
  void tree;
  const entry: string = entryType('100644');
  const mode: string = lsMode('100644');
  const names: readonly string[] = refCandidates('main');
  void entry; void mode; void names;
  const span = tracer.start('git.fetch');
  for await (const chunk of packStream(transport, fetchOpts, span)) {
    const bytes: Uint8Array = chunk;
    void bytes;
  }
  let cursor: SpState = spInit();
  const stepped = spStep(cursor, anyBytes);
  cursor = spFinish(stepped.state);
  const pieces: readonly Uint8Array[] = stepped.zlib;
  void cursor; void pieces;
  const inflated = inflate(anyBytes, 0, { expectedSize: 1, maxOutput: 8 });
  // `out` is a subarray of the growable buffer, so the published type is `Uint8Array` (any backing).
  const out: Uint8Array = inflated.out;
  void out;
  const rejected: boolean = isFilterRejection(new Error('no'));
  const known: boolean = isPlyCode('pack_corrupt');
  void rejected; void known;
};
void consumer;
