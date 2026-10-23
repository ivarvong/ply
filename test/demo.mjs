// Demo: one edit against the 10 GB / 1000-commit repo, narrated from the OTLP spans, then verified by git.
//   node test/demo.mjs [--dir /tmp/bigrepo]
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { statSync, readdirSync } from 'node:fs';
import { startGitServer } from './server.js';
import { editFile } from '../src/edit.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const DIR = process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : '/tmp/bigrepo';
const bare = join(DIR, 'big.git');
const git = a => execFileSync('git', ['-C', bare, ...a], { encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
const du = d => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? du(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
const fmt = n => n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(2)} GB` : n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
const W = 70;
const line = (l, r = '') => console.log('  ' + l.padEnd(W - r.length) + r);
const hr = () => console.log('  ' + '─'.repeat(W));

const head = git(['rev-parse', 'main']);
const headBytes = git(['ls-tree', '-r', '-l', 'main']).split('\n').reduce((n, l) => n + (+l.split(/\s+/)[3] || 0), 0);
const rev = Math.floor((+git(['rev-list', '--count', 'main']) - 1) / 50) * 50;
const PATH = 'src/mod17/file9.ts', FIND = `MARK_${rev}`, REPLACE = `EDITED_${rev}`;

console.log();
line('REPO', git(['rev-list', '--count', 'main']) + ' commits');
line('  on disk', fmt(du(join(bare, 'objects/pack'))) + ' (packed, bitmap + multi-pack-index)');
line('  at HEAD', `${fmt(headBytes)} in ${git(['ls-tree', '-r', 'main']).split('\n').length} files`);
line('  HEAD', head);
console.log();
line('EDIT', `${PATH}: "${FIND}" → "${REPLACE}"`);
hr();

const srv = await startGitServer(DIR);
const exporter = arrayExporter();
const t0 = Date.now();
const r = await editFile(`${srv.url}/big.git`, { path: PATH, find: FIND, replace: REPLACE, author: { name: 'demo', email: 'demo@edge' }, message: 'demo edit' }, { tracer: new Tracer({ exporter }), verify: true });
const wall = Date.now() - t0;
await srv.close();
const spans = exporter.lines.flatMap(flattenLine);

let totalIn = 0, totalOut = 0, n = 0;
for (const s of spans.filter(s => /upload-pack|receive-pack/.test(s.name)).sort((a, b) => a.start - b.start)) {
  const a = s.attrs; const inB = a['http.response.body.size'] ?? 0, outB = a['http.request.body.size'] ?? 0; totalIn += inB; totalOut += outB;
  const what = s.name.includes('ls-refs') ? `ls-refs ${a['git.ls_refs.prefixes']?.[0] ?? ''}` : s.name.includes('receive') ? `push  ${a['git.push.pack.objects']} objects (commit + ${a['git.push.pack.objects'] - 2} tree deltas + blob delta), thin` : `fetch want ${(a['git.fetch.wants']?.[0] ?? '').slice(0, 12)}… ${a['git.fetch.filter'] ? 'filter=' + a['git.fetch.filter'] : ''} ${a['git.fetch.deepen'] ? 'deepen=' + a['git.fetch.deepen'] : ''} → ${a['git.pack.objects'] ?? 1} object${a['git.pack.inflated.bytes'] ? ', ' + fmt(a['git.pack.inflated.bytes']) + ' inflated' : ''}`;
  line(`${++n}. ${what}`, `${String(outB).padStart(5)} B out  ${String(inB).padStart(6)} B in  ${String(Math.round(s.durationMs)).padStart(4)} ms`);
}
hr();
const root = spans.find(s => s.name === 'git.edit');
line('TOTAL', `${totalOut} B out  ${totalIn} B in  ${wall} ms`);
line('  peak single allocation', fmt(root.attrs['mem.alloc.max_single']));
line('  bytes allocated, whole edit', fmt(root.attrs['mem.alloc.bytes']));
line('  blob', `${fmt(r.baseLen)} streamed, never held; delta: 3 ops`);
line('  vs. git clone --depth 1 of the same HEAD', '≈ 13.3 MB in');
line('  vs. textbook blobless (blob:none)', '≈ 28 KB in');
console.log();
line('RESULT', `commit ${r.newCommit.slice(0, 12)} (parent ${r.oldCommit.slice(0, 12)}), verified by re-reading the ref`);
hr();
line('git says:');
line(`  rev-parse main`, git(['rev-parse', 'main']) === r.newCommit ? '== our commit' : 'MISMATCH');
line(`  diff --stat ${r.oldCommit.slice(0, 7)}..main`, git(['diff', '--shortstat', r.oldCommit, 'main']));
line(`  grep ${REPLACE} main:${PATH}`, git(['grep', '-c', REPLACE, 'main', '--', PATH]).split(':').pop() + ' match');
line(`  fsck --strict --connectivity-only`, git(['fsck', '--strict', '--connectivity-only', '--no-dangling']) || 'clean');
line(`  log -1 --format=%an/%s`, git(['log', '-1', '--format=%an / %s', 'main']));
console.log();
git(['update-ref', 'refs/heads/main', head]); // leave the repo as we found it
