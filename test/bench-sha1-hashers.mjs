#!/usr/bin/env node
/**
 * Compare streaming SHA-1 backends on identical inputs (correctness first: digests must match).
 * Usage: node test/bench-sha1-hashers.mjs [bytes=20971520]
 * Reports ms and MB/s for: js Sha1, DigestStream (if present), crypto.subtle.digest one-shot.
 */
import { createHash } from 'node:crypto';
import { Sha1, streamingSha1, toHex } from '../dist/sha1.js';

const BYTES = Number(process.argv[2] || 20 * 1024 * 1024);
const CHUNK = 64 * 1024;
const pattern = new Uint8Array(CHUNK);
for (let i = 0; i < CHUNK; i++) pattern[i] = (i * 17 + 3) & 0xff;

function* chunks(n) {
  let left = n;
  while (left > 0) {
    const take = Math.min(CHUNK, left);
    yield pattern.subarray(0, take);
    left -= take;
  }
}

async function runJs(n) {
  const h = new Sha1();
  const t0 = performance.now();
  for (const c of chunks(n)) h.update(c);
  const hex = h.hex();
  return { ms: performance.now() - t0, hex };
}

async function runStreaming(n) {
  const h = streamingSha1();
  const t0 = performance.now();
  for (const c of chunks(n)) await h.update(c);
  const hex = await h.hex();
  return { ms: performance.now() - t0, hex, kind: h.kind };
}

async function runSubtle(n) {
  // one-shot: concatenate (the crypto.subtle.digest shape — not a streaming option)
  const buf = new Uint8Array(n);
  let off = 0;
  for (const c of chunks(n)) { buf.set(c, off); off += c.byteLength; }
  const t0 = performance.now();
  const dig = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return { ms: performance.now() - t0, hex: toHex(dig) };
}

async function runNodeCrypto(n) {
  const h = createHash('sha1');
  const t0 = performance.now();
  for (const c of chunks(n)) h.update(c);
  const hex = h.digest('hex');
  return { ms: performance.now() - t0, hex };
}

const ref = await runJs(BYTES);
const stream = await runStreaming(BYTES);
const node = await runNodeCrypto(BYTES);
let subtle = null;
try { subtle = await runSubtle(BYTES); } catch (e) { subtle = { error: String(e) }; }

const mb = BYTES / (1024 * 1024);
const row = (name, r) => {
  if (r.error) return { name, error: r.error };
  const ok = r.hex === ref.hex;
  return { name, ms: +r.ms.toFixed(1), mib_s: +(mb / (r.ms / 1000)).toFixed(1), hex_ok: ok, kind: r.kind };
};

const out = {
  bytes: BYTES,
  results: [
    row('js Sha1', ref),
    row(`streamingSha1 (${stream.kind})`, stream),
    row('node:crypto createHash', node),
    subtle.error ? { name: 'crypto.subtle.digest (one-shot)', error: subtle.error } : row('crypto.subtle.digest (one-shot)', subtle),
  ],
};
console.log(JSON.stringify(out, null, 2));
if (out.results.some(r => r.hex_ok === false)) process.exit(2);
