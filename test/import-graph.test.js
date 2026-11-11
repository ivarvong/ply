// The layering of src/: no module's evaluation depends, through value imports, on its own. A value-import cycle works
// only while every cross use is a hoisted function called after both modules have evaluated; a top-level const built
// from the other side throws at load (temporal dead zone), in whichever order a consumer's bundle happens to evaluate.
// The graph is read from the source text: `import`/`export … from './x.js'`, leaving out `import type`/`export type`.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url);
const EDGE = /^(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s+'\.\/([^']+)\.js'/gm;

function valueGraph() {
  const graph = new Map();
  for (const name of readdirSync(SRC).filter(f => f.endsWith('.ts'))) {
    const text = readFileSync(new URL(name, SRC), 'utf8');
    const to = new Set();
    for (const m of text.matchAll(EDGE)) if (m[1] === undefined) to.add(`${m[2]}.ts`);
    graph.set(name, to);
  }
  return graph;
}
// Every cycle's first closing edge, by depth-first search with an explicit stack (white, grey, black).
function cycles(graph) {
  const state = new Map();
  const found = [];
  for (const root of graph.keys()) {
    if (state.has(root)) continue;
    const stack = [[root, [...graph.get(root)]]];
    state.set(root, 'open');
    while (stack.length > 0) {
      const [node, rest] = stack.at(-1);
      const next = rest.pop();
      if (next === undefined) { state.set(node, 'done'); stack.pop(); continue; }
      if (!graph.has(next)) continue;
      if (state.get(next) === 'open') found.push(`${node} -> ${next}`);
      else if (!state.has(next)) { state.set(next, 'open'); stack.push([next, [...graph.get(next)]]); }
    }
  }
  return found;
}

test('src/ has no value-import cycle', () => {
  const graph = valueGraph();
  // the reader sees the graph: the entry module reaches the resolver and the encoders
  assert.ok(graph.get('index.ts').has('pack.ts'));
  assert.ok(graph.get('pack.ts').has('packresolve.ts'));
  assert.deepEqual(cycles(graph), []);
});
