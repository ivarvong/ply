// The package entry (#100): a consumer imports values and types from index, with no casts.
import {
  fetchPack, push, spliceDelta, zlibDeflate, Tracer, arrayExporter, createTransport, discover, lsRefs,
  fetchObject, packStream, spInit, spStep, spFinish, inflate, commitView, entryType, lsMode, refCandidates,
  isFilterRejection, isPlyCode, DEFAULT_LIMITS, parseRefname,
  type Transport, type ExportLine, type Exporter, type Limits, type FetchOpts, type SpState, type PackObject, type OperationOpts,
  type TransferRun, type LastPush, type LastStep,
} from '../../src/index.js';

// A paused transfer's two facts (LastPush and LastStep, public beside TransferRun). The unions and the paused shape are
// written out here from README's transfer section, not read from src/transfer.ts: a member added, dropped or renamed
// there, a field renamed, or either export removed from the entry fails this file (tsconfig.check.json compiles it).
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const lastPushIs: Same<LastPush, 'none' | 'acknowledged' | 'refused' | 'unanswered'> = true;
const lastStepIs: Same<LastStep, 'none' | 'landed' | 'not_shown'> = true;
const pausedIs: Same<Extract<TransferRun, { readonly tag: 'paused' }>, {
  readonly tag: 'paused'; readonly step: number; readonly pushes: number; readonly reason: 'max_steps' | 'settling';
  readonly lastPush: 'none' | 'acknowledged' | 'refused' | 'unanswered'; readonly lastStep: 'none' | 'landed' | 'not_shown';
}> = true;
void lastPushIs; void lastStepIs; void pausedIs;
// a consumer reads both fields off a pause with no cast, and a done run has neither
const pauseFacts = (run: TransferRun): readonly [LastPush, LastStep] | null => (run.tag === 'paused' ? [run.lastPush, run.lastStep] : null);
void pauseFacts;
// @ts-expect-error a done run states no last push
const doneFacts = (run: Extract<TransferRun, { readonly tag: 'done' }>): LastPush => run.lastPush;
void doneFacts;

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
const made = createTransport('https://example.test/repo.git', {
  tracer, userAgent: 'ply-web', limits, signal: new AbortController().signal, fetchImpl: globalThis.fetch, quirks: {},
});
if (made.ok) { const madeT: Transport = made.value; void madeT; }

const opts: OperationOpts = { tracer };
void opts;

const fetchOpts: FetchOpts = { wants: ['a'.repeat(40)], filter: 'blob:none' };

// fetchPack → push, and spliceDelta → zlibDeflate, through the entry. SharedArrayBuffer views are inputs.
const consumer = async (): Promise<void> => {
  const fetchedR = await fetchPack(transport, fetchOpts);
  if (!fetchedR.ok) return;
  const fetched = fetchedR.value;
  const objects: PackObject[] = [...(fetched.objects?.values() ?? [])].map(o => ({ type: o.type, data: o.data }));
  // helper: unwrap a Result Ok (type-level)
  const expectOk = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => (r.ok ? r.value : (null as unknown as T));
  const ref = expectOk(parseRefname('refs/heads/x'));
  await push(transport, { ref, oldOid: '0'.repeat(40), newOid: 'b'.repeat(40), objects });
  const { delta } = spliceDelta({ baseLen: 8, off: 0, oldLen: 1, insert: anyBytes });
  const deflated: Uint8Array<ArrayBuffer> = await zlibDeflate(delta);
  await zlibDeflate(shared);
  void deflated;

  const infoR = await discover(transport);
  if (!infoR.ok) return;
  const info = infoR.value;
  const caps: ReadonlyMap<string, string> | Map<string, string> = info.caps;
  void caps;
  const listedR = await lsRefs(transport, ['refs/heads/']);
  if (!listedR.ok) return;
  const head: string | null = listedR.value.head;
  void head;
  const objectR = await fetchObject(transport, { oid: 'c'.repeat(40), filter: 'blob:none' });
  if (!objectR.ok) return;
  const object = objectR.value;
  const view = commitView(object.data, limits);
  const tree: string | null = view.ok ? view.value.tree : null;
  void tree;
  const entry: string = entryType('100644');
  const mode: string = lsMode('100644');
  const names: readonly string[] = expectOk(refCandidates('main'));
  void entry; void mode; void names;
  const span = tracer.start('git.fetch');
  for await (const chunk of packStream(transport, fetchOpts, span)) {
    const bytes: Uint8Array = chunk;
    void bytes;
  }
  let cursor: SpState = spInit();
  const steppedR = spStep(cursor, anyBytes);
  if (!steppedR.ok) return;
  const stepped = steppedR.value;
  const finished = spFinish(stepped.state);
  if (!finished.ok) return;
  cursor = finished.value;
  const pieces: readonly Uint8Array[] = stepped.zlib;
  void cursor; void pieces;
  const inflated = inflate(anyBytes, 0, { expectedSize: 1, maxOutput: 8 });
  if (!inflated.ok) return;
  // `out` is a subarray of the growable buffer, so the published type is `Uint8Array` (any backing).
  const out: Uint8Array = inflated.value.out;
  void out;
  const rejected: boolean = isFilterRejection(new Error('no'));
  const known: boolean = isPlyCode('pack_corrupt');
  void rejected; void known;
};
void consumer;
