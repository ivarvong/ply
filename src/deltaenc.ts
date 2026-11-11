// Delta instructions, encoded (gitformat-pack "Deltified representation"): the size varint, copy and insert opcodes, a
// delta from its instructions, and the structural splice the edit pipeline sends. A leaf: pack.ts (the pack builder)
// and packresolve.ts (makeDelta) both import it, and it imports neither.
import { concat } from './bytes.js';
import {
  BYTE_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE, OBJ_SIZE_NEXT_BASE,
  DELTA_COPY, DELTA_COPY_MAX, DELTA_INSERT_MAX, DELTA_OFF_SHIFT,
  DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3,
} from './format.js';

export function encodeVarint(n: number): Uint8Array { // delta header style: 7-bit LE groups
  const out: number[] = [];
  let rest = n;
  do { let b = rest & OBJ_SIZE_NEXT_MASK; rest = Math.floor(rest / OBJ_SIZE_NEXT_BASE); if (rest > 0) b |= OBJ_CONTINUE; out.push(b); } while (rest > 0);
  return Uint8Array.from(out);
}
export const copyOp = (off: number, len: number): Uint8Array => {
  let op = DELTA_COPY;
  const b: number[] = [];
  let o = off;
  let l = len === DELTA_COPY_MAX ? 0 : len;
  if (o & BYTE_MASK) { op |= DELTA_COPY_OFF1; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { op |= DELTA_COPY_OFF2; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { op |= DELTA_COPY_OFF3; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { op |= DELTA_COPY_OFF4; b.push(o & BYTE_MASK); }
  if (l & BYTE_MASK) { op |= DELTA_COPY_LEN1; b.push(l & BYTE_MASK); } l >>>= DELTA_OFF_SHIFT;
  if (l & BYTE_MASK) { op |= DELTA_COPY_LEN2; b.push(l & BYTE_MASK); } l >>>= DELTA_OFF_SHIFT;
  if (l & BYTE_MASK) { op |= DELTA_COPY_LEN3; b.push(l & BYTE_MASK); }
  return Uint8Array.of(op, ...b);
};
export const copyOps = (off: number, len: number): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  let o = off;
  let left = len;
  while (left > 0) { const n = Math.min(left, DELTA_COPY_MAX); parts.push(copyOp(o, n)); o += n; left -= n; }
  return parts;
};
export const insertOps = (bytes: Uint8Array): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += DELTA_INSERT_MAX) {
    const chunk = bytes.subarray(i, Math.min(i + DELTA_INSERT_MAX, bytes.length));
    parts.push(Uint8Array.of(chunk.length), chunk);
  }
  return parts;
};

// One delta instruction (gitformat-pack "Deltified representation"): copy `len` bytes of the source from `off`, or insert
// the literal bytes. A copy longer than DELTA_COPY_MAX or an insert longer than DELTA_INSERT_MAX is one instruction
// here and as many opcodes as it takes on the wire (encodeDeltaOps).
export type DeltaOp = { readonly tag: 'copy'; readonly off: number; readonly len: number } | { readonly tag: 'insert'; readonly bytes: Uint8Array };
// A delta's bytes from its sizes and instructions.
export function encodeDeltaOps(srcSize: number, dstSize: number, ops: readonly DeltaOp[]): Uint8Array<ArrayBuffer> {
  const parts = [encodeVarint(srcSize), encodeVarint(dstSize)];
  for (const op of ops) parts.push(...(op.tag === 'copy' ? copyOps(op.off, op.len) : insertOps(op.bytes)));
  return concat(parts);
}

// Structural delta: base with [off, off+oldLen) replaced by `insert`. Pure; needs no base bytes. The instructions are a
// copy of the prefix, the insert, and a copy of the tail, each only when it is not empty.
export type Splice = { readonly baseLen: number; readonly off: number; readonly oldLen: number; readonly insert: Uint8Array };
export type SplicedDelta = { readonly delta: Uint8Array<ArrayBuffer>; readonly resultLen: number; readonly ops: { readonly copy: number; readonly insert: number }; readonly program: readonly DeltaOp[] };
export function spliceDelta({ baseLen, off, oldLen, insert }: Splice): SplicedDelta {
  const resultLen = baseLen - oldLen + insert.length;
  const tail = baseLen - off - oldLen;
  const program: DeltaOp[] = [];
  if (off > 0) program.push({ tag: 'copy', off: 0, len: off });
  if (insert.length > 0) program.push({ tag: 'insert', bytes: insert });
  if (tail > 0) program.push({ tag: 'copy', off: off + oldLen, len: tail });
  // Stryker disable next-line EqualityOperator,ConditionalExpression: an empty prefix or tail is Math.ceil(0) = 0 copies either way
  return { delta: encodeDeltaOps(baseLen, resultLen, program), resultLen, program, ops: { copy: (off > 0 ? Math.ceil(off / DELTA_COPY_MAX) : 0) + (tail > 0 ? Math.ceil(tail / DELTA_COPY_MAX) : 0), insert: Math.ceil(insert.length / DELTA_INSERT_MAX) } };
}
