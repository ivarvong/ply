// A proxy in front of the git http-backend server, for the cells about the wire rather than the repository.
// The first path segment `~<mode>` picks what it does to the exchange and is stripped before git sees the path:
//   ~v0, ~v1        the Git-Protocol header removed, or set to version=1: a server that answers in protocol v0
//   ~delay-<ms>     each response held <ms> before its status line (a slow server)
//   ~stall-<ms>     each response's headers and first chunk sent, then <ms> of silence before the rest (a stalled body)
//   ~frame-<L>      an upload-pack response's packfile section re-framed: every band-1 frame is a pkt-line of total
//                   length L (the last one shorter). L = 4 inserts one empty "0004" pkt-line before the pack, L = 5
//                   one band-only frame ("0005\x01"), each followed by the pack in git's own 65520-byte frames.
// The same URL serves git's client, which is the oracle for the frame cells.
import http from 'node:http';

/** @param {number} n */
const hex4 = n => n.toString(16).padStart(4, '0');

/** @param {Buffer} body @param {number} L */
export function reframe(body, L) {
  /** @type {Buffer[]} */
  const out = [];
  let p = 0;
  let inPack = false;
  /** @type {Buffer[]} */
  const band1 = [];
  /** @type {Buffer[]} */
  const others = [];
  const flushPack = () => {
    const data = Buffer.concat(band1);
    const emit = (/** @type {Buffer} */ chunk) => out.push(Buffer.from(hex4(chunk.length + 5)), Buffer.from([1]), chunk);
    if (L === 4) out.push(Buffer.from('0004'));
    if (L === 5) out.push(Buffer.from('0005'), Buffer.from([1]));
    const size = L >= 6 ? L - 5 : 65515;
    for (let i = 0; i < data.length; i += size) emit(data.subarray(i, Math.min(data.length, i + size)));
    out.push(...others);
  };
  while (p + 4 <= body.length) {
    const len = parseInt(body.subarray(p, p + 4).toString('latin1'), 16);
    if (!Number.isFinite(len)) throw new Error(`shim: bad pkt-line length at ${p}`);
    if (len < 4) {
      if (inPack && len === 0) { flushPack(); inPack = false; }
      out.push(body.subarray(p, p + 4));
      p += 4;
      continue;
    }
    const pkt = body.subarray(p, p + len);
    p += len;
    if (inPack) {
      if (pkt[4] === 1) band1.push(pkt.subarray(5));
      else others.push(pkt);
      continue;
    }
    out.push(pkt);
    if (pkt.subarray(4).toString('latin1') === 'packfile\n') inPack = true;
  }
  if (inPack) flushPack();
  out.push(body.subarray(p));
  return Buffer.concat(out);
}

/** @param {string} upstreamUrl */
export function startShim(upstreamUrl) {
  const up = new URL(upstreamUrl);
  const server = http.createServer((req, res) => {
    const m = /^\/~([a-z0-9]+)(?:-(\d+))?(\/.*)$/.exec(req.url ?? '');
    const mode = m ? m[1] : '';
    const arg = m && m[2] ? Number(m[2]) : 0;
    const path = m ? m[3] : (req.url ?? '/');
    const headers = { ...req.headers, host: up.host };
    if (mode === 'v0') delete headers['git-protocol'];
    if (mode === 'v1') headers['git-protocol'] = 'version=1';
    const reframing = mode === 'frame' && req.method === 'POST' && path.endsWith('/git-upload-pack');
    const p = http.request({ host: up.hostname, port: up.port, path, method: req.method, headers }, r => {
      const respond = () => {
        if (reframing) {
          /** @type {Buffer[]} */
          const parts = [];
          r.on('data', d => parts.push(d));
          r.on('end', () => {
            const body = reframe(Buffer.concat(parts), arg);
            const h = { ...r.headers };
            delete h['content-length'];
            delete h['transfer-encoding'];
            h['content-length'] = String(body.length);
            res.writeHead(r.statusCode ?? 502, h);
            res.end(body);
          });
          return;
        }
        res.writeHead(r.statusCode ?? 502, r.headers);
        if (mode !== 'stall') { r.pipe(res); return; }
        let first = true;
        let waiting = false;
        let ended = false;
        r.on('data', d => {
          if (!first) { res.write(d); return; }
          first = false;
          // the first bytes now; everything after them waits out the stall
          res.write(d.subarray(0, Math.min(d.length, 64)));
          r.pause();
          waiting = true;
          const t = setTimeout(() => {
            waiting = false;
            if (res.destroyed) return;
            res.write(d.subarray(Math.min(d.length, 64)));
            if (ended) res.end(); else r.resume();
          }, arg);
          res.on('close', () => clearTimeout(t));
        });
        r.on('end', () => { ended = true; if (!waiting) res.end(); });
      };
      if (mode === 'delay') {
        const t = setTimeout(respond, arg);
        res.on('close', () => clearTimeout(t));
      } else respond();
    });
    p.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); });
    req.pipe(p);
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
    resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections?.(); }) });
  }));
}
