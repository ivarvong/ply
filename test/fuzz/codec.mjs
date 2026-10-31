// High-volume differential fuzz of the pure codecs. No git server; just node:zlib / node:crypto as oracles for
// inflate and SHA-1, and git's own patch_delta (via `git index-pack --fix-thin` on a one-delta pack) for deltas.
//   node test/fuzz/codec.mjs [--n 200000] [--seed 1]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Rng, splitRandom } from './prng.js';
import { inflate } from '../../src/inflate.js';
import { Sha1 } from '../../src/sha1.js';
import { applyDelta, spliceDelta, makeDelta, buildPack, parsePack, resolvePack } from '../../src/pack.js';
import { pktInit, pktStep, pkt } from '../../src/pktline.js';
import { concat } from '../../src/bytes.js';
import { zlibBound } from '../../src/format.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '200000', 10), SEED = parseInt(args.seed ?? String(Date.now() % 1e9), 10);
const rng = new Rng(SEED);
const fails = [], counts = {};
const tick = k => counts[k] = (counts[k] ?? 0) + 1;
const t0 = Date.now();

// data generators biased toward what deflate cares about: runs, repeats at every distance class, random, structured
function gen() {
  const kind = rng.weighted([['random', 3], ['run', 2], ['repeat', 3], ['text', 2], ['mixed', 2], ['empty', 1], ['one', 1]]);
  tick(`data.${kind}`);
  const n = rng.weighted([[rng.int(0, 64), 3], [rng.int(64, 4096), 3], [rng.int(4096, 70000), 2], [rng.int(70000, 300000), 1]]);
  switch (kind) {
    case 'empty': return new Uint8Array(0);
    case 'one': return Uint8Array.of(rng.int(0, 255));
    case 'random': return rng.bytes(n);
    case 'run': return new Uint8Array(n).fill(rng.int(0, 255));
    case 'repeat': { const d = rng.pick([1, 2, 3, 4, 5, 7, 8, 9, 13, 31, 32, 33, 257, 258, 259, 1024, 4096, 32767, 32768, 32769, rng.int(1, 32768)]); const pat = rng.bytes(Math.min(d, n || 1)); const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = pat[i % pat.length]; return out; }
    case 'text': { const w = ['the', 'inflate', 'huffman', 'delta', 'pack', '\n', ' ', 'git', 'object', 'stream']; let s = ''; while (s.length < n) s += rng.pick(w); return new TextEncoder().encode(s.slice(0, n)); }
    case 'mixed': { const parts = []; let len = 0; while (len < n) { const p = rng.bool() ? rng.bytes(rng.int(1, 2000)) : new Uint8Array(rng.int(1, 2000)).fill(rng.int(0, 255)); parts.push(p); len += p.length; } return concat(parts).subarray(0, n); }
  }
}

// a git repo for delta judging: one-delta thin packs against a stored base
const dir = mkdtempSync(join(tmpdir(), 'gw-codec-'));
execFileSync('git', ['-C', dir, 'init', '-q']);
const gitHash = (data) => execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { input: data }).toString().trim();

for (let i = 0; i < N; i++) {
  const which = rng.weighted([['inflate', 6], ['sha1', 1], ['delta', 2], ['delta-git', 0.3], ['pkt', 1]]);
  try {
    if (which === 'inflate') {
      const d = gen();
      const level = rng.int(-1, 9), strategy = rng.pick([0, 0, 0, 1, 2, 3, 4]), memLevel = rng.int(1, 9), windowBits = rng.pick([9, 10, 12, 15, 15, 15]);
      const z = zlib.deflateSync(d, { level, strategy, memLevel, windowBits });
      tick(`inflate.level.${level}`); tick(`inflate.strategy.${strategy}`); tick(`inflate.wbits.${windowBits}`);
      const pre = rng.bytes(rng.int(0, 3)), post = rng.bytes(rng.int(0, 3));
      const buf = concat([pre, z, post]);
      if (z.length > zlibBound(d.length)) throw new Error(`zlib emitted ${z.length} B for ${d.length} B, over zlibBound ${zlibBound(d.length)} (level ${level}, strategy ${strategy}, memLevel ${memLevel}, windowBits ${windowBits})`);
      tick('inflate.under_zlib_bound');
      const r = inflate(buf, pre.length, rng.bool() ? { expectedSize: d.length } : {});
      if (r.consumed !== z.length) throw new Error(`consumed ${r.consumed} != ${z.length}`);
      if (r.out.length !== d.length || !Buffer.from(r.out).equals(Buffer.from(d))) throw new Error('content mismatch');
      // truncation at a random point must throw (never return success, never hang)
      if (z.length > 2 && rng.bool(0.3)) { const cut = rng.int(1, z.length - 1); let ok = false; try { inflate(z.subarray(0, cut)); ok = true; } catch { } if (ok) throw new Error(`truncated at ${cut}/${z.length} returned success`); tick('inflate.truncated'); }
      // single bit flip in the body must throw or produce a different output (adler catches) — never silently equal output with wrong consumed
      if (z.length > 8 && rng.bool(0.2)) { const m = z.slice(); const at = rng.int(2, z.length - 5); m[at] ^= 1 << rng.int(0, 7); let r2 = null; try { r2 = inflate(m); } catch { tick('inflate.flip.rejected'); } if (r2 && Buffer.from(r2.out).equals(Buffer.from(d)) && r2.consumed === z.length) tick('inflate.flip.benign'); else if (r2) throw new Error('bit flip accepted with different output (adler should catch)'); }
    } else if (which === 'sha1') {
      const d = gen(); const h = new Sha1(); for (const c of splitRandom(rng, d, { maxChunks: 50 })) h.update(c);
      if (h.hex() !== crypto.createHash('sha1').update(d).digest('hex')) throw new Error('sha1 mismatch');
    } else if (which === 'delta' || which === 'delta-git') {
      const base = gen(); const off = rng.int(0, base.length), oldLen = rng.int(0, base.length - off); const ins = rng.bool(0.3) ? new Uint8Array(0) : gen().subarray(0, rng.int(0, 70000));
      const target = concat([base.subarray(0, off), ins, base.subarray(off + oldLen)]);
      // git refuses a delta whose result IS its base ("REF_DELTA already resolved (duplicate base)"): identical content must
      // never be sent as a delta. editFile returns noop before building a pack; the generator just skips it here.
      if (Buffer.from(target).equals(Buffer.from(base))) { tick('delta.identity-skipped'); continue; }
      const d1 = spliceDelta({ baseLen: base.length, off, oldLen, insert: ins }).delta, d2 = makeDelta(base, target).delta;
      for (const [name, delta] of [['splice', d1], ['make', d2]]) {
        if (delta.length < 4) { tick('delta.min-size'); continue; }
        const r = applyDelta(base, delta); if (!Buffer.from(r.out).equals(Buffer.from(target))) throw new Error(`${name} apply mismatch`);
        if (which === 'delta-git' && base.length > 0) {
          const baseOid = gitHash(base);
          const { pack } = await buildPack([{ type: 3, data: delta, baseOid }]);
          try { execFileSync('git', ['-C', dir, 'index-pack', '--fix-thin', '--strict', '--stdin'], { input: pack, stdio: 'pipe' }); }
          catch (e) { throw new Error(`${name}: git rejected delta (base ${base.length}B off=${off} old=${oldLen} ins=${ins.length} delta=${delta.length}B): ${(e.stderr || '').toString().trim().split('\n').pop()}`); }
          const targetOid = crypto.createHash('sha1').update(`blob ${target.length}\0`).update(target).digest('hex');
          const got = execFileSync('git', ['-C', dir, 'cat-file', 'blob', targetOid]);
          if (!got.equals(Buffer.from(target))) throw new Error(`${name}: git patch_delta produced different bytes`);
          tick('delta.git-judged');
        }
      }
      tick(`delta.copyops.${Math.min(5, Math.ceil(off / 65536) + Math.ceil((base.length - off - oldLen) / 65536))}`);
    } else if (which === 'pkt') {
      const frames = Array.from({ length: rng.int(0, 40) }, () => rng.weighted([[{ kind: 'data', payload: rng.bytes(rng.pick([0, 1, 100, 65516, rng.int(0, 65516)])) }, 6], [{ kind: 'flush' }, 2], [{ kind: 'delim' }, 1], [{ kind: 'end' }, 1]]));
      const enc = concat(frames.map(f => f.kind === 'data' ? pkt(f.payload) : new TextEncoder().encode(f.kind === 'flush' ? '0000' : f.kind === 'delim' ? '0001' : '0002')));
      let st = pktInit(); const got = [];
      for (const c of splitRandom(rng, enc, { maxChunks: 64 })) { const r = pktStep(st, c); st = r.state; got.push(...r.frames); }
      if (got.length !== frames.length || got.some((g, k) => g.kind !== frames[k].kind || (g.kind === 'data' && !Buffer.from(g.payload).equals(Buffer.from(frames[k].payload))))) throw new Error('pkt mismatch');
    }
  } catch (e) {
    fails.push({ i, which, seed: SEED, msg: e.message });
    console.log(`FAIL #${i} ${which}: ${e.message}`);
    if (fails.length > 20) break;
  }
  if (i % 20000 === 0 && i) process.stdout.write(`  ${i}/${N} ${((Date.now() - t0) / 1000) | 0}s\n`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`\n${N} cases in ${((Date.now() - t0) / 1000) | 0}s, ${fails.length} failures\n` + Object.entries(counts).sort().map(([k, v]) => `${String(v).padStart(7)} ${k}`).join('\n'));
process.exit(fails.length ? 1 : 0);
