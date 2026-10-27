// A stalled response body must still hit requestTimeoutMs after a GC. AbortSignal.timeout() does not:
// AbortSignal.any holds its sources weakly, and the timeout signal is retained only by that weak timer.
import http from 'node:http';
import { createTransport } from '../src/http.js';
import { withLimits } from '../src/limits.js';

if (typeof globalThis.gc !== 'function') {
  console.error('node --expose-gc is required');
  process.exit(2);
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
  res.write(Buffer.from('0000'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const ms = 300;
const span = { set() {}, event() {} };
const transport = createTransport(`http://127.0.0.1:${port}/r.git`, {
  limits: withLimits({ requestTimeoutMs: ms }),
  tracer: { span: async (_name, _opts, fn) => fn(span) },
});
const gcTimer = setInterval(() => globalThis.gc(), 30);
const t0 = Date.now();
let code = 'ok';
try {
  for await (const frame of transport.frames('git-upload-pack', new Uint8Array(0), span)) void frame;
} catch (e) {
  code = e.code;
}
clearInterval(gcTimer);
server.close();
const dt = Date.now() - t0;
if (code !== 'timeout' || dt > 1_500) {
  console.error(`code=${code} dt=${dt}`);
  process.exit(1);
}
console.log(`timeout in ${dt}ms`);
