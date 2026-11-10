// GENERATED from README.md "Custom exchanges on a transport" by test/custom-exchange.test.js (UPDATE_README_TYPETEST=1
// rewrites it). The block as a TypeScript consumer writes it: `npm run typecheck` compiles it.
const url: string = 'https://git.example.com/acme/site.git';
const opts = { auth: { token: process.env['GIT_TOKEN'] ?? '' } };
import { createTransport, Tracer, KIND, ZERO_OID, TYPE, buildPack, hashObject, encodeTree, encodeCommit } from '../../src/index.js';
import type { EndedSpan } from '../../src/index.js';
import { frames } from '../../src/transport.js';
import { pushBody, streamInit, streamStep, streamFinish, classifyReport } from '../../src/push.js';
import type { StreamState } from '../../src/push.js';

// what to send: a root commit holding one file
const file = new TextEncoder().encode('hello\n');
const tree = encodeTree([{ mode: '100644', name: 'hello.txt', oid: hashObject('blob', file) }]);
if (!tree.ok) throw tree.error;
const made = encodeCommit({ tree: hashObject('tree', tree.value), author: 'Me <me@example.com> 1700000000 +0000', message: 'hello\n' });
if (!made.ok) throw made.error;
const commit = hashObject('commit', made.value);
const objects = [{ type: TYPE.BLOB, data: file }, { type: TYPE.TREE, data: tree.value }, { type: TYPE.COMMIT, data: made.value }];

const spans: EndedSpan[] = [];
const t = createTransport(url, { ...opts, tracer: new Tracer({ onEnd: s => spans.push(s) }) });
if (!t.ok) throw t.error;
// the request: the commands as pkt-lines and a flush, then the pack, as one stream of known length
const commands = [{ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: commit }];
const prefix = pushBody({ commands, caps: ['report-status', 'side-band-64k', 'agent=me/1'] });
if (!prefix.ok) throw prefix.error;
const { pack } = await buildPack(objects);
const stream = new ReadableStream({ start(c) { c.enqueue(prefix.value); c.enqueue(pack); c.close(); } });
const body = { stream, length: prefix.value.length + pack.length };
const span = t.value.tracer.start('custom receive-pack', { kind: KIND.CLIENT, scrub: t.value.scrub });
let reply: StreamState = streamInit(true);  // side-band-64k: the report in band 1, progress in band 2
try {
  for await (const f of frames(t.value, 'git-receive-pack', body, span)) {
    const stepped = streamStep(reply, f);
    if (!stepped.ok) throw stepped.error;
    reply = stepped.value;
  }
} catch (e) { span.error(e); throw e; } finally { span.end(); }
const done = streamFinish(reply);
if (done.tag !== 'report') throw new Error(`no report: ${done.why}`);
const report = classifyReport(done.lines, commands);  // { tag: 'statuses', refs: [{ ref, ok: true, reason: '' }] }
if (report.tag !== 'statuses' || !report.refs.every(r => r.ok)) throw new Error(`refused: ${JSON.stringify(report)}`);
