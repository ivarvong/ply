import { records, classifier, diffScript } from '/home/claude/ply/src/linemerge.js';
import { Rng } from '/home/claude/ply/test/fuzz/prng.js';
const enc = s => new TextEncoder().encode(s);
let best = null;
for (let i = 0; i < 200000 && !(best && best.n < 9); i++) {
  const rng = new Rng(i); const V = ['a\n', 'b\n', 'c\n'];
  const n = rng.int(3, 10), a = Array.from({ length: n }, () => rng.pick(V)), m = rng.int(3, 10), b = Array.from({ length: m }, () => rng.pick(V));
  const cl = classifier(), A = records(enc(a.join('')), cl), B = records(enc(b.join('')), cl);
  const x = JSON.stringify(diffScript(A, B, { rediff: 'myers' })), y = JSON.stringify(diffScript(A, B, { rediff: 'skip' }));
  if (x !== y && (!best || n + m < best.n)) best = { n: n + m, a: a.join(''), b: b.join(''), x, y };
}
console.log(JSON.stringify(best));
