// Random trees for the differential test of parseTree (#207): src/objects.ts against the parser before it
// (test/oracle/parsetree-ref.ts). Shared by test/parsetree.test.js and test/fuzz/parsetree.mjs.
import { parseTree } from '../src/objects.js';
import { parseTreeRef } from './oracle/parsetree-ref.ts';
import { randomName, SPELLINGS } from './dotnames-corpus.js';

const enc = s => new TextEncoder().encode(s);
// Modes git writes, ones it canonicalizes, and ones fsck refuses (empty, zero-padded, not octal, not ASCII)
const MODES = ['100644', '100755', '120000', '40000', '160000', '100664', '100700', '40755', '1', '7', '777777', '140000', '1040000',
  '7100644', '300644', '777777777777777777777777040000', '0', '040000', '00', '', '8', 'g7', '1006 44', '10064é', '﻿100644', '-1', '4000a'];
const WORDS = ['a', 'b', 'd', 'd.x', 'd0', 'D', 'src', 'README.md', 'é', 'é', 'a/b', '.', '..', '', 'x'.repeat(4097), 'x'.repeat(4096), '﻿README'];
const sortKey = e => [...e.name, ...(e.dir ? [0x2f] : [])];
const cmp = (a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };

export function randomTree(r) {
  const n = r.int(4) === 0 ? r.int(3) : 1 + r.int(12);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const mode = r.int(5) === 0 ? r.pick(MODES) : r.pick(MODES.slice(0, 5));
    const k = r.int(10);
    const name = k < 4 ? enc(r.pick(WORDS)) : k < 6 ? randomName(r) : k < 7 ? enc(r.pick(SPELLINGS)) : enc(`f${r.int(1000)}`);
    const oid = new Uint8Array(20);
    if (r.int(20) !== 0) for (let j = 0; j < 20; j++) oid[j] = r.int(256);
    const low = Number.parseInt(mode.slice(-6), 8) & 0xffff;
    entries.push({ mode: enc(mode), name, oid, dir: /^[0-7]+$/.test(mode) && (low & 0o170000) === 0o40000 });
  }
  if (r.int(4) !== 0) entries.sort(cmp);
  if (r.int(10) === 0 && entries.length > 0) entries.push(entries[r.int(entries.length)]);
  const parts = [];
  for (const e of entries) parts.push(...e.mode, ...(r.int(50) === 0 ? [] : [0x20]), ...e.name, ...(r.int(50) === 0 ? [] : [0]), ...e.oid);
  let bytes = Uint8Array.from(parts);
  if (r.int(15) === 0 && bytes.length > 0) bytes = bytes.subarray(0, r.int(bytes.length));
  const limits = r.int(8) === 0 ? { maxTreeEntries: r.int(6) } : {};
  return { bytes, limits };
}

const view = r => (r.ok ? { ok: true, entries: r.value.map(e => ({ mode: e.mode, name: e.name, oid: e.oid, oidOffset: e.oidOffset, entryOffset: e.entryOffset })) } : { ok: false, code: r.error.code, message: r.error.message });
// The first tree on which the two parsers differ (a repro), or null; counts accepted and refused trees
export function judgeTrees(trees, stats = { n: 0, accepted: 0, refused: {} }) {
  for (const { bytes, limits } of trees) {
    const want = view(parseTreeRef(bytes, limits));
    const got = view(parseTree(bytes, limits));
    stats.n++;
    if (want.ok) stats.accepted++; else stats.refused[want.message.replace(/".*"/u, '"…"').replace(/\d+/gu, 'N')] = (stats.refused[want.message.replace(/".*"/u, '"…"').replace(/\d+/gu, 'N')] ?? 0) + 1;
    if (JSON.stringify(want) !== JSON.stringify(got)) return { hex: Buffer.from(bytes).toString('hex'), limits, want, got };
  }
  return null;
}
