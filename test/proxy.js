// Fault-injection proxy in front of the real git server. The fault decision is a pure function of the
// exchange context: fault(ctx) → spec. ctx = { stage: 'ls-refs'|'fetch'|'receive-pack', n (index within stage),
// i (global index), status, headers, bytes (upstream body), reqBody }.
// spec: { type: 'pass' } | { type: 'bytes', bytes, chunks? } | { type: 'status', status, body?, contentType? }
//     | { type: 'stall' } | { type: 'drop', after? } | { type: 'slow', chunk, delayMs }
import http from 'node:http';

export function startProxy(upstreamUrl, fault) {
  const up = new URL(upstreamUrl);
  const counts = {};
  let i = 0;
  const log = [];
  const server = http.createServer((req, res) => {
    const reqChunks = [];
    req.on('data', d => reqChunks.push(d));
    req.on('end', () => {
      const reqBody = Buffer.concat(reqChunks);
      const stage = req.url.endsWith('git-receive-pack') ? 'receive-pack' : /command=ls-refs/.test(reqBody.subarray(0, 40).toString()) ? 'ls-refs' : 'fetch';
      const n = counts[stage] = (counts[stage] ?? 0) + 1;
      const ctx = { stage, n: n - 1, i: i++, reqBody, headers: req.headers };
      // a fault may answer without forwarding anything upstream (server never saw the request)
      let pre = null;
      try { pre = fault({ ...ctx, phase: 'request', bytes: new Uint8Array(0) }); } catch { pre = null; } // faults that need the upstream bytes are called later
      if (pre && pre.type === 'bytes' && pre.noForward) {
        log.push({ stage, n: ctx.n, spec: 'bytes(noForward)', detail: pre.name ?? '' });
        Promise.resolve(pre.bytes).then(b => { res.writeHead(pre.status ?? 200, { 'content-type': pre.contentType ?? `application/x-${stage === 'receive-pack' ? 'git-receive-pack' : 'git-upload-pack'}-result` }); res.end(Buffer.from(b)); });
        return;
      }
      const upReq = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, upRes => {
        const chunks = [];
        upRes.on('data', d => chunks.push(d));
        upRes.on('end', async () => {
          const bytes = new Uint8Array(Buffer.concat(chunks));
          const spec = fault({ ...ctx, status: upRes.statusCode, headers: upRes.headers, bytes }) ?? { type: 'pass' };
          if (spec.bytes && typeof spec.bytes.then === 'function') spec.bytes = await spec.bytes;
          log.push({ stage, n: ctx.n, spec: spec.type, detail: spec.name ?? '' });
          const hdrs = { 'content-type': upRes.headers['content-type'] ?? 'application/octet-stream', 'cache-control': 'no-cache' };
          switch (spec.type) {
            case 'pass': res.writeHead(upRes.statusCode, hdrs); res.end(Buffer.from(bytes)); break;
            case 'bytes': {
              res.writeHead(spec.status ?? upRes.statusCode, { ...hdrs, ...(spec.contentType ? { 'content-type': spec.contentType } : {}) });
              const b = Buffer.from(spec.bytes);
              if (spec.chunks) { let o = 0; for (const c of spec.chunks) { if (o >= b.length) break; res.write(b.subarray(o, o + c)); o += c; await new Promise(r => setTimeout(r, spec.delayMs ?? 0)); } res.write(b.subarray(o)); res.end(); }
              else res.end(b);
              break;
            }
            case 'status': res.writeHead(spec.status, { 'content-type': spec.contentType ?? 'text/html' }); res.end(spec.body ?? '<html>login</html>'); break;
            case 'stall': res.writeHead(upRes.statusCode, hdrs); if (spec.partial) res.write(Buffer.from(bytes.subarray(0, spec.partial))); /* never end */ break;
            case 'drop': { res.writeHead(upRes.statusCode, hdrs); if (spec.after) res.write(Buffer.from(bytes.subarray(0, spec.after))); res.destroy(); break; }
            case 'slow': { res.writeHead(upRes.statusCode, hdrs); const b = Buffer.from(bytes); for (let o = 0; o < b.length; o += spec.chunk) { res.write(b.subarray(o, o + spec.chunk)); await new Promise(r => setTimeout(r, spec.delayMs)); } res.end(); break; }
            default: throw new Error(`bad fault spec ${spec.type}`);
          }
        });
      });
      upReq.on('error', () => { res.writeHead(502); res.end(); });
      upReq.end(reqBody);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, log, counts,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  })));
}
