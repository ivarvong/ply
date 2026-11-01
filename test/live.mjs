// Live smoke against a real remote (GitHub etc.). Read-only unless --push.
//   PLY_TOKEN=ghp_... node test/live.mjs https://github.com/o/r.git refs/heads/main path/to/file.txt [--push find replace]
import { GitHttp } from '../src/client.js';
import { editFile } from '../src/edit.js';
import {Tracer,  flattenLine} from '../src/otel.js';
import { jsonlExporter } from './jsonl.mjs';
import { parseCommit, parseTree, TYPE } from '../src/objects.js';
import { defaultCapabilities } from '../src/capabilities.js';

const [url, ref = 'refs/heads/main', path, flag, find, replace] = process.argv.slice(2);
const auth = process.env.PLY_TOKEN ? { token: process.env.PLY_TOKEN } : undefined;
const lines = [];
const file = await jsonlExporter('live-trace.jsonl');
const tracer = new Tracer({ exporter: l => { lines.push(l); file(l); } });
const c = new GitHttp(url, { auth, capabilities: { ...defaultCapabilities(), tracer } });
const { refs } = await c.lsRefs([ref]);
const head = refs.get(ref)?.oid; if (!head) throw new Error(`no ${ref}`);
const cf = await c.fetchPack({ wants: [head], filter: 'tree:0', deepen: 1 });
const commit = parseCommit(cf.objects.get(head).data);
console.log('head', head, 'tree', commit.tree, 'parents', commit.parents.length);
let tree = commit.tree;
for (const name of (path ?? '').split('/').filter(Boolean)) {
  const t = (await c.fetchPack({ wants: [tree], filter: 'tree:0' })).objects.get(tree);
  const e = parseTree(t.data).find(x => x.name === name); if (!e) throw new Error(`no ${name}`);
  console.log(' ', e.mode, e.oid, name, `(${t.data.length}B tree)`);
  tree = e.oid;
}
if (flag === '--push') {
  const r = await editFile(url, { ref, path, find, replace, author: { name: 'ply', email: 'ply@localhost' }, message: `ply: ${find} → ${replace}` }, { auth, capabilities: { ...defaultCapabilities(), tracer } });
  console.log('pushed', r);
}
file.close();
for (const s of lines.flatMap(flattenLine)) console.log(s.name.padEnd(26), s.durationMs.toFixed(0).padStart(5) + 'ms', 'req', s.attrs['http.request.body.size'] ?? '', 'resp', s.attrs['http.response.body.size'] ?? '', s.attrs['git.sideband.band2.frames'] ? `band2=${s.attrs['git.sideband.band2.frames']}` : '', s.status.code === 2 ? 'ERR ' + s.status.message : '');
