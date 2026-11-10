// Input sources for the memory cells (test/stream/cell.mjs), as plain iterator objects instead of generators (#249).
//
// A suspended generator on node 22 (V8 12.4) keeps every register of its frame, so the piece it yielded last, and the
// `{ value }` of an inner for-of, stay reachable after the consumer dropped them. A heap snapshot at the peak of the
// scan-work cell found three such 16 KiB pieces retained by the `parameters_and_registers` of `sealed`, `body` and
// `storedMember` (49,152 B: node 22's whole overage over node 24 there); node 24 (V8 13.6) keeps none. These sources
// keep only their position between calls, so a cell measures the same bytes on both: the piece being fed is the
// caller's, and nothing older is reachable from the source.
//
// Each source is an iterator (and iterable) over Uint8Array pieces; `step` returns the next piece or END.
import crypto from 'node:crypto';

export const END = Symbol('end');
const DONE = Object.freeze({ done: true, value: undefined });

export function source(step) {
  return {
    next() { const v = step(); return v === END ? DONE : { done: false, value: v }; },
    [Symbol.iterator]() { return this; },
  };
}
// The same source as an AsyncIterable, without an async frame of its own to hold a piece.
export function asAsync(src) {
  return { [Symbol.asyncIterator]() { return { next: () => Promise.resolve(src.next()) }; } };
}
// One piece, dropped once it is handed over.
export const once = piece => { let held = [piece]; return source(() => { const out = held.length > 0 ? held[0] : END; held = []; return out; }); };
// The sources made by `makers`, one after another; only the current one is held.
export function seq(makers) {
  let i = 0, cur = makers.length > 0 ? makers[0]() : once(new Uint8Array(0));
  return source(() => {
    for (;;) {
      const n = cur.next();
      if (!n.done) return n.value;
      i += 1;
      if (i >= makers.length) return END;
      cur = makers[i]();
    }
  });
}
// `count` sources from `make(i)`, one after another.
export function repeat(count, make) {
  let i = 0, cur = null;
  return source(() => {
    for (;;) {
      if (cur !== null) { const n = cur.next(); if (!n.done) return n.value; cur = null; }
      if (i >= count) return END;
      cur = make(i);
      i += 1;
    }
  });
}
// The pieces of `src`, then the SHA-1 of them (a pack trailer).
export function sealed(src) {
  const sha = crypto.createHash('sha1');
  let open = true;
  return source(() => {
    if (!open) return END;
    const n = src.next();
    if (!n.done) { sha.update(n.value); return n.value; }
    open = false;
    return new Uint8Array(sha.digest());
  });
}
// `src` regrouped into `size`-byte chunks, as a transport hands a body over. The chunk being filled is held here
// until it is full: one chunk, by design.
export function chunked(src, size) {
  let piece = null, off = 0, ended = false;
  return source(() => {
    if (ended) return END;
    const buf = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      if (piece === null || off === piece.length) {
        const n = src.next();
        if (n.done) { ended = true; piece = null; return at > 0 ? buf.subarray(0, at) : END; }
        piece = n.value; off = 0;
      }
      const k = Math.min(size - at, piece.length - off);
      buf.set(piece.subarray(off, off + k), at);
      at += k; off += k;
    }
    if (off === piece.length) piece = null;
    return buf;
  });
}
// `src` framed into band-1 pkt-lines of `room` payload bytes, after a `packfile` line and before a flush: a v2 fetch
// response as it is read. Holds the unframed remainder (under one frame).
export function framed(src, room) {
  const te = new TextEncoder();
  const frame = payload => { const f = new Uint8Array(4 + payload.length); f.set(te.encode((payload.length + 4).toString(16).padStart(4, '0'))); f.set(payload, 4); return f; };
  let state = 'head', pending = new Uint8Array(0);
  const band1 = bytes => { const p = new Uint8Array(1 + bytes.length); p[0] = 1; p.set(bytes, 1); return frame(p); };
  return source(() => {
    for (;;) {
      switch (state) {
        case 'head': state = 'body'; return frame(te.encode('packfile\n'));
        case 'body': {
          if (pending.length >= room) { const out = band1(pending.subarray(0, room)); pending = pending.slice(room); return out; }
          const n = src.next();
          if (n.done) { state = 'tail'; continue; }
          const joined = new Uint8Array(pending.length + n.value.length);
          joined.set(pending); joined.set(n.value, pending.length);
          pending = joined;
          continue;
        }
        case 'tail': { state = 'flush'; if (pending.length === 0) continue; const out = band1(pending); pending = new Uint8Array(0); return out; }
        case 'flush': state = 'end'; return te.encode('0000');
        default: return END;
      }
    }
  });
}
// Read `stream` to its end, handing each item to `each`, from read callbacks rather than an async function: a `for
// await` loop's frame keeps the item before the current one in a register while it waits for the next (a heap snapshot
// of the pkt-iter cell found one 65,516 B frame held so on node 24 too), and that is the consumer's memory, not the
// adapter's under test.
export function drain(stream, each) {
  const reader = stream.getReader();
  return new Promise((resolve, reject) => {
    const step = () => reader.read().then(r => { if (r.done) { resolve(); return; } each(r.value); step(); }, reject);
    step();
  });
}
