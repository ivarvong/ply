// Resumable transfer, the pack a step reads (#260): a resumed request rebuilds its TransferPack from a saved index
// (packsaved.ts) when the caller kept one, and scans and resolves the spool only when it has none or the one it has is
// refused. The pack is named by the spool's own last 20 bytes (its trailer) and length, so an index saved for another
// spool, or a spool replaced under the same name, is never used.
//
//   loadTransferPack(dst, source, saved, opts)  → { from: TransferPack, loaded, saved }
//     loaded: 'saved'     the saved index and resolved columns, no read of the spool but its trailer
//             'resolved'  the saved index (it had no resolved columns), resolved again over the spool
//             'scanned'   scanned and resolved; `refused` says why a saved index was not used (none: there was none)
//     saved:  the bytes to keep for the next request (the saved ones when they were used, else a fresh encoding)
//
// Span: git.transfer.load (under dst's parent) with git.transfer.load.from, .refused, .saved_bytes, .entries and
// git.pack.trailer; a scan's refusal is the span's error.
import type { PlyError } from './errors.js';
import type { Option, Result } from './result.js';
import { ok, some, none } from './result.js';
import type { Input } from './absent.js';
import { withDefaults } from './absent.js';
import type { ScanIndexOpts, ScannedPack } from './packscanindex.js';
import { scanPackIndex } from './packscanindex.js';
import type { ResolveRangeOpts } from './packrangeresolve.js';
import { resolvePackRange } from './packrangeresolve.js';
import type { RangeSource } from './rangesource.js';
import type { TransferPack } from './transferplan.js';
import type { SavedIndex, SavedIndexRefusal } from './packsaved.js';
import { decodeSavedIndex, encodeSavedIndex, describeRefusal, packIdentity } from './packsaved.js';
import type { Span } from './otel.js';
import { KIND } from './otel.js';
import type { Transport } from './transport.js';
import { spanned } from './transport.js';

export type Loaded = { readonly tag: 'saved' } | { readonly tag: 'resolved' } | { readonly tag: 'scanned'; readonly refused: Option<SavedIndexRefusal> };
export type LoadedPack = { readonly from: TransferPack; readonly loaded: Loaded; readonly saved: Uint8Array };
export type LoadConfig = { readonly scan: Partial<ScanIndexOpts>; readonly resolve: Partial<ResolveRangeOpts> };
export type LoadOpts = Input<LoadConfig>;

async function resolved(source: RangeSource, pack: ScannedPack, cfg: LoadConfig, loaded: Loaded): Promise<Result<LoadedPack, PlyError>> {
  const r = await resolvePackRange(pack, source, cfg.resolve);
  if (!r.ok) return r;
  const saved = encodeSavedIndex(pack, some(r.value));
  return saved.ok ? ok({ from: { source, pack, resolved: r.value }, loaded, saved: saved.value }) : saved;
}
async function scanned(source: RangeSource, cfg: LoadConfig, refused: Option<SavedIndexRefusal>): Promise<Result<LoadedPack, PlyError>> {
  const whole = await source.read(0, source.size);
  if (!whole.ok) return whole;
  const pack = await scanPackIndex(whole.value, cfg.scan);
  if (!pack.ok) return pack;
  return resolved(source, pack.value, cfg, { tag: 'scanned', refused });
}

// A saved index read back: used as it is, resolved again when it has no resolved columns, or refused (a scan, and why).
async function fromSaved(source: RangeSource, cfg: LoadConfig, span: Span, bytes: Uint8Array, decoded: Result<SavedIndex, SavedIndexRefusal>): Promise<Result<LoadedPack, PlyError>> {
  if (!decoded.ok) {
    span.set({ 'git.transfer.load.refused': decoded.error.tag, 'git.transfer.load.refused_reason': describeRefusal(decoded.error) });
    const again = await scanned(source, cfg, some(decoded.error));
    return again;
  }
  const { pack, resolved: kept } = decoded.value;
  if (kept.tag === 'none') {
    const r = await resolved(source, pack, cfg, { tag: 'resolved' });
    return r;
  }
  return ok({ from: { source, pack, resolved: kept.value }, loaded: { tag: 'saved' }, saved: bytes });
}

// See the top of this file.
export async function loadTransferPack(dst: Transport, source: RangeSource, saved: Option<Uint8Array>, opts: LoadOpts = {}): Promise<Result<LoadedPack, PlyError>> {
  const cfg = withDefaults<LoadConfig>(opts, { scan: {}, resolve: {} });
  const span0 = { parent: dst.parent, kind: KIND.INTERNAL, attrs: { 'git.transfer.load.saved_in': saved.tag === 'some' ? saved.value.length : 0, 'git.transfer.spool.bytes': source.size }, scrub: dst.scrub };
  const r = await spanned(dst, 'git.transfer.load', span0, async (span: Span): Promise<Result<LoadedPack, PlyError>> => {
    const id = await packIdentity(source);
    if (!id.ok) return id;
    span.set({ 'git.pack.trailer': id.value.trailer });
    const out = saved.tag === 'none' ? await scanned(source, cfg, none) : await fromSaved(source, cfg, span, saved.value, decodeSavedIndex(saved.value, id.value));
    if (out.ok) span.set({ 'git.transfer.load.from': out.value.loaded.tag, 'git.transfer.load.saved_bytes': out.value.saved.length, 'git.transfer.load.entries': out.value.from.pack.count });
    return out;
  });
  return r;
}
