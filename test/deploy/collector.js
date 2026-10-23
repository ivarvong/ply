
import * as workers from "cloudflare:workers";
const tracing = workers.tracing;  // Cloudflare's in-process tracing API (absent locally: we fall back)

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (b, status = 200) => Response.json(b, { status });
const MARK = `<svg class=mark viewBox="0 0 16 16" aria-hidden=true><rect class=m0 x=2 y=3 width=11 height=2.4 rx=1.2 /><rect class=m1 x=4.5 y=6.8 width=6.5 height=2.4 rx=1.2 /><rect class=m2 x=7.5 y=10.6 width=6.5 height=2.4 rx=1.2 /></svg>`;
const html = (title, body, status = 200, nav = {}) => new Response(`<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content="dark light">
<title>${esc(title)} · otel</title>
<link rel=preconnect href=https://fonts.gstatic.com crossorigin>
<link rel=stylesheet href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>${CSS}</style>
<header class=bar><nav class=wrap><a class=brand href="${nav.home ?? "/"}">${MARK}<span>otel</span></a>
<span class=slash>/</span><span class=crumb>${esc(nav.crumb ?? "collector")}</span><a class=btn href="/demo">Run demo</a></nav></header>
<main class=wrap>${body}</main>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// ---- OTLP/JSON <-> rows ----------------------------------------------------
const KINDS = ["SPAN_KIND_UNSPECIFIED", "SPAN_KIND_INTERNAL", "SPAN_KIND_SERVER", "SPAN_KIND_CLIENT", "SPAN_KIND_PRODUCER", "SPAN_KIND_CONSUMER"];
const CODES = ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"];
const num = (v, names) => (typeof v === "string" ? Math.max(0, names.indexOf(v)) : v ?? 0);
const val = (v) => v == null ? null : v.stringValue ?? v.boolValue ?? v.doubleValue ??
  (v.intValue != null ? Number(v.intValue) : v.arrayValue ? (v.arrayValue.values ?? []).map(val)
   : v.kvlistValue ? attrs(v.kvlistValue.values) : v.bytesValue ?? null);
const attrs = (list = []) => Object.fromEntries(list.map((a) => [a.key, val(a.value)]));
const ms = (ns) => (ns == null ? null : Number(BigInt(ns) / 1000n) / 1000);

function fromOtlp(body) {
  const out = [];
  for (const rs of body.resourceSpans ?? []) {
    const service = attrs(rs.resource?.attributes)["service.name"] ?? "unknown_service";
    for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) out.push({
      trace_id: String(s.traceId ?? "").toLowerCase(), span_id: String(s.spanId ?? "").toLowerCase(),
      parent_span_id: s.parentSpanId ? s.parentSpanId.toLowerCase() : null, service, name: s.name,
      kind: num(s.kind, KINDS), start_ms: ms(s.startTimeUnixNano), end_ms: ms(s.endTimeUnixNano),
      status: num(s.status?.code, CODES),
      attrs: { ...attrs(s.attributes), ...(s.status?.message && { "status.message": s.status.message }) },
      events: (s.events ?? []).map((e) => ({ name: e.name, time_ms: ms(e.timeUnixNano), attrs: attrs(e.attributes) })),
    });
  }
  return out;
}

const any = (v) => typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) }
  : typeof v === "number" ? { doubleValue: v } : { stringValue: typeof v === "string" ? v : JSON.stringify(v) };
const kv = (o) => Object.entries(o ?? {}).filter(([, v]) => v != null).map(([key, v]) => ({ key, value: any(v) }));
const ns = (m) => (BigInt(Math.round(m * 1000)) * 1000n).toString();

function toOtlp(rows) {
  const by = Map.groupBy(rows, (r) => r.service);
  return { resourceSpans: [...by].map(([service, spans]) => ({
    resource: { attributes: kv({ "service.name": service }) },
    scopeSpans: [{ scope: { name: "otel-collector-do" }, spans: spans.map((r) => {
      const parse = (v, d) => (typeof v === "string" ? JSON.parse(v) : v ?? d);   // DB rows or live spans
      const a = parse(r.attrs, {}), events = parse(r.events, []);
      return { traceId: r.trace_id, spanId: r.span_id, ...(r.parent_span_id && { parentSpanId: r.parent_span_id }),
        name: r.name, kind: r.kind, startTimeUnixNano: ns(r.start_ms), endTimeUnixNano: ns(r.end_ms ?? r.start_ms),
        attributes: kv(Object.fromEntries(Object.entries(a).filter(([k]) => k !== "status.message"))), status: { code: r.status, ...(a["status.message"] && { message: a["status.message"] }) },
        events: events.map((e) => ({ name: e.name, timeUnixNano: ns(e.time_ms), attributes: kv(e.attrs) })) };
    }) }],
  })) };
}

const RETAIN_MS = 24 * 3600 * 1000;   // keep a day of traces
// ---- storage ---------------------------------------------------------------
export class Store extends workers.DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS spans (trace_id TEXT, span_id TEXT, parent_span_id TEXT,
      service TEXT, name TEXT, kind INT, start_ms REAL, end_ms REAL, status INT, attrs TEXT, events TEXT,
      PRIMARY KEY (trace_id, span_id))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS by_start ON spans (start_ms)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS metar (icao TEXT, observed_at TEXT, category TEXT, raw TEXT,
      PRIMARY KEY (icao, observed_at))`);
  }
  saveMetar(rows) {
    const cursors = rows.map((r) => {
      const c = this.sql.exec(`INSERT OR REPLACE INTO metar VALUES (?,?,?,?)`, r.icao, r.time, r.cat ?? null, r.raw);
      c.toArray();
      return c;
    });
    return { count: rows.length, meta: this.facts(cursors) };
  }
  // Facts only the DO can see, returned to the caller and recorded on its CLIENT span.
  facts(cursors) {
    const cold = !this.warm; this.warm = true;
    return { "db.rows_read": cursors.reduce((n, c) => n + c.rowsRead, 0),
             "db.rows_written": cursors.reduce((n, c) => n + c.rowsWritten, 0),
             "db.size_bytes": this.sql.databaseSize, "do.cold_start": cold };
  }
  insert(rows) {
    const cursors = rows.map((r) => {
      const c = this.sql.exec(`INSERT OR REPLACE INTO spans VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        r.trace_id, r.span_id, r.parent_span_id, r.service, r.name, r.kind, r.start_ms, r.end_ms, r.status,
        JSON.stringify(r.attrs), JSON.stringify(r.events ?? []));
      c.toArray();
      return c;
    });
    const pruned = this.sql.exec(`DELETE FROM spans WHERE start_ms < ?`, Date.now() - RETAIN_MS);
    pruned.toArray();
    return { count: rows.length, meta: { ...this.facts([...cursors, pruned]), "db.pruned_rows": pruned.rowsWritten } };
  }
  q(sql, ...params) {
    const c = this.sql.exec(sql, ...params), rows = c.toArray();
    return { rows, meta: { ...this.facts([c]), "db.response.returned_rows": rows.length } };
  }
}

// A CLIENT span around a DO call, carrying OTel DB semantic conventions plus the DO's own facts.
const dbCall = (me, name, op, text, fn) => me.span(name, async (set) => {
  set("db.system.name", "sqlite"); set("db.namespace", "durable-object:spans");
  set("db.operation.name", op); set("db.query.text", text.replace(/\s+/g, " ").trim());
  const { meta, ...out } = await fn();
  for (const [k, v] of Object.entries(meta)) set(k, v);
  return out;
}, 3);

// ---- self-instrumentation: wrap tracing.enterSpan, mirror spans into our own store
const ctxOf = (s) => { const c = s?.spanContext?.(); return c && !/^0+$/.test(c.traceId) ? c : null; };
class Self {
  constructor(name, traceparent) {
    // W3C traceparent (00-<trace>-<parent span>-<flags>) wins: it joins this request to its caller's trace.
    const tp = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent ?? "");
    const c = ctxOf(tracing?.getActiveSpan?.());
    this.traceId = tp?.[1] ?? c?.traceId ?? hex(16);
    this.spans = [];
    this.root = this.open(name, c?.spanId ?? hex(8), tp?.[2] ?? null, 2);
    this.root.attrs["cf.native_ids"] = !!c && !tp;   // true: same ids as Cloudflare's own trace
  }
  open(name, id, parent, kind) {
    const r = { trace_id: this.traceId, span_id: id, parent_span_id: parent, service: "otel-collector",
                name, kind, start_ms: Date.now(), end_ms: null, status: 0, attrs: {}, events: [] };
    this.spans.push(r);
    return r;
  }
  span(name, fn, kind = 1, parent = this.root.span_id) {
    const run = async (cf) => {
      const r = this.open(name, ctxOf(cf)?.spanId ?? hex(8), parent, kind);
      const set = (k, v) => { r.attrs[k] = v; cf?.setAttribute?.(k, v); };
      set.child = (n, f, k = 1) => this.span(n, f, k, r.span_id);          // nest under this span
      set.fail = (msg) => { r.status = 2; r.attrs["status.message"] = msg; };
      try { return await fn(set); }
      catch (e) { r.status = 2; r.attrs["exception.message"] = String(e?.message ?? e); throw e; }
      finally { r.end_ms = Date.now(); }
    };
    return tracing?.enterSpan ? tracing.enterSpan(name, run) : run(null);
  }
  end(status) {
    Object.assign(this.root, { end_ms: Date.now(), status: status >= 500 ? 2 : 1 });
    this.root.attrs["http.response.status_code"] = status;
    return this.spans;
  }
}

// ---- views -----------------------------------------------------------------
const CSS = `
:root{--bg:#0A0A0B;--panel:#111113;--raise:#17171A;--border:#232327;--border2:#303036;--grid:#1A1A1E;
  --text:#EDEDEF;--muted:#9A9AA3;--faint:#62626B;--accent:#F38020;--on-accent:#1A0E04;
  --server:#7C83FF;--client:#3CCB9F;--internal:#55555E;--err:#FF5A60;--ok:#3CCB9F;
  --vfr:#3CCB9F;--mvfr:#5B8DEF;--ifr:#FF5A60;--lifr:#D45BF0;
  --sans:Geist,ui-sans-serif,system-ui,sans-serif;--mono:"Geist Mono",ui-monospace,monospace}
@media (prefers-color-scheme:light){:root{--bg:#FAFAFA;--panel:#FFF;--raise:#F4F4F5;--border:#E7E7EA;--border2:#D6D6DC;
  --grid:#F1F1F3;--text:#18181B;--muted:#62626B;--faint:#9E9EA7;--server:#4F55E8;--client:#0E9A74;--internal:#B4B4BC;
  --err:#E5484D;--ok:#0E9A74;--vfr:#0E9A74;--mvfr:#2F6FE0;--ifr:#E5484D;--lifr:#B13FCF}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}code{font:12.5px var(--mono);color:var(--text)}
.wrap{max-width:1080px;margin:0 auto;padding-inline:20px}
:focus-visible{outline:2px solid var(--server);outline-offset:2px;border-radius:4px}
.bar{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 80%,transparent);
  backdrop-filter:saturate(1.4) blur(12px);-webkit-backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--border)}
.bar nav{display:flex;align-items:center;gap:10px;height:52px}
.brand{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:-.01em}
.mark{width:22px;height:22px;border-radius:6px;background:var(--accent);padding:3px;flex:none}
.mark rect{fill:var(--on-accent)}.mark .m1{opacity:.72}.mark .m2{opacity:.45}
.slash{color:var(--border2);font-size:18px}
.crumb{color:var(--muted);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border-radius:7px;font-size:13px;
  font-weight:500;white-space:nowrap;border:1px solid var(--border2);background:var(--panel);color:var(--text);transition:background .12s}
.btn:hover{background:var(--raise)}
.btn.primary{background:var(--accent);color:var(--on-accent);border-color:transparent}
.btn.primary:hover{background:color-mix(in srgb,var(--accent) 88%,#fff)}
main{padding-top:32px;padding-bottom:72px}
h1{font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-.025em;margin:0;overflow-wrap:anywhere}
.lede{color:var(--muted);margin:6px 0 0;max-width:62ch}
.head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:20px}
.mono{font:12.5px var(--mono)}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.panel+.panel{margin-top:16px}
.seg{display:inline-flex;padding:3px;gap:2px;border:1px solid var(--border);border-radius:9px;background:var(--panel)}
.seg a{padding:4px 12px;border-radius:6px;font-size:13px;color:var(--muted)}
.seg a:hover{color:var(--text)}
.seg a[aria-current]{background:var(--raise);color:var(--text);box-shadow:inset 0 0 0 1px var(--border2)}
.seg .n{color:var(--faint);font:11.5px var(--mono);margin-left:4px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
.dot.err{background:var(--err);box-shadow:0 0 0 3px color-mix(in srgb,var(--err) 22%,transparent)}
.pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;font-size:12px;font-weight:500;border:1px solid}
.pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:color-mix(in srgb,var(--ok) 9%,transparent)}
.pill.err{color:var(--err);border-color:color-mix(in srgb,var(--err) 40%,transparent);background:color-mix(in srgb,var(--err) 10%,transparent)}
.k1{--c:var(--internal)}.k2{--c:var(--server)}.k3,.k4,.k5{--c:var(--client)}.err{--c:var(--err)}

.thead,.trow{display:grid;grid-template-columns:8px minmax(0,1fr) 200px 84px 56px 84px;align-items:center;gap:0 18px;padding:0 18px}
.thead{height:36px;font-size:12px;color:var(--faint);background:var(--raise);border-bottom:1px solid var(--border)}
.trow{min-height:62px;border-bottom:1px solid var(--border);transition:background .12s}
.trow:last-child{border-bottom:0}.trow:hover{background:var(--raise)}.trow.self{opacity:.55}
.tname{min-width:0}.tname b{display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tname small{display:block;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.num{font:12.5px var(--mono);text-align:right;color:var(--muted);white-space:nowrap}.num.strong{color:var(--text)}
.g{display:block;width:100%}.g rect{fill:var(--c)}
.mm{display:none}
.empty{padding:48px 20px;text-align:center;color:var(--muted)}
.empty .btn{margin-top:14px}
.sh{padding:12px 18px;border-bottom:1px solid var(--border);font-weight:500}
.send pre{margin:0;padding:14px 18px;font:12.5px/1.75 var(--mono);color:var(--muted);overflow-x:auto}
@media (max-width:720px){
  .thead{display:none}
  .trow{grid-template-columns:8px minmax(0,1fr) auto;grid-template-areas:"d n dur" ". g g" ". m m";gap:8px 12px;padding:14px 16px}
  .trow>.dot{grid-area:d}.trow>.tname{grid-area:n}.trow>.g{grid-area:g}.trow>.dur{grid-area:dur}
  .trow>.spans,.trow>.age{display:none}.trow>.mm{display:block;grid-area:m;font-size:12px;color:var(--faint)}
  .tname small{display:none}
}

.idline{display:flex;align-items:center;gap:10px;margin-top:12px;color:var(--muted);min-width:0}
.head>div{min-width:0;max-width:100%}
.tid{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.idline .pill,.idline .copy{flex:none}
.copy{font:12px var(--sans);color:var(--muted);background:none;border:1px solid var(--border2);border-radius:6px;padding:2px 8px;cursor:pointer}
.copy:hover{color:var(--text)}
.wfp{margin-top:18px}
.wh,.wr>summary{display:grid;grid-template-columns:minmax(0,36%) minmax(0,1fr) 84px;align-items:stretch}
.wh{height:34px;font-size:12px;color:var(--faint);background:var(--raise);border-bottom:1px solid var(--border)}
.wh>span{display:flex;align-items:center}.wh>span:first-child{padding-left:18px}
.ruler{position:relative;border-left:1px solid var(--border)}
.ruler b{position:absolute;top:50%;transform:translate(-50%,-50%);font:400 11px var(--mono);white-space:nowrap}
.ruler b:first-child{transform:translate(6px,-50%)}
.wh .rt,.wr .rt{justify-content:flex-end;padding-right:18px}
.wr>summary{list-style:none;cursor:pointer;min-height:38px;border-bottom:1px solid var(--border)}
.wr>summary::-webkit-details-marker{display:none}
.wr>summary:hover,.wr[open]>summary{background:var(--raise)}
.sn{display:flex;align-items:center;gap:9px;padding:7px 10px 7px calc(18px + var(--d) * 16px);min-width:0}
.sn::before{content:"";width:8px;height:8px;border-radius:2px;background:var(--c);flex:none}
.sn b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sn small{color:var(--faint);font-size:12px;white-space:nowrap}
.err .sn b{color:var(--err)}
.tl{position:relative;border-left:1px solid var(--border);background-image:linear-gradient(to right,var(--grid) 1px,transparent 1px);
  background-size:var(--step) 100%}
.tl i{position:absolute;top:50%;height:10px;margin-top:-5px;min-width:2px;border-radius:3px;background:var(--c)}
.wr .rt{display:flex;align-items:center;font:12.5px var(--mono);color:var(--muted)}
.insp{background:var(--raise);border-bottom:1px solid var(--border);padding:12px 18px 16px calc(35px + var(--d) * 16px)}
.insp dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 20px;margin:0;font:12px/1.55 var(--mono)}
.insp dt{color:var(--muted)}.insp dd{margin:0;overflow-wrap:anywhere}
@media (max-width:720px){
  .wh{grid-template-columns:minmax(0,1fr) 72px}.wh>.ruler{display:none}
  .wr>summary{grid-template-columns:minmax(0,1fr) 72px;grid-template-areas:"n rt" "t t";padding-bottom:10px}
  .wr .sn{grid-area:n}.wr .rt{grid-area:rt}.sn small{display:none}
  .wr .tl{grid-area:t;height:6px;margin:0 18px 0 calc(35px + var(--d) * 16px);border:0;border-radius:3px;background:var(--grid)}
  .wr .tl i{height:6px;margin-top:-3px}
  .insp{padding-left:18px}
}
.foot{color:var(--faint);font-size:12px;margin-top:14px}

.st{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:3px 16px;padding:16px 18px;border-bottom:1px solid var(--border);align-items:center}
.st:last-child{border-bottom:0}
.icao{font:500 13px var(--mono)}.sname{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.raw{grid-column:2/-1;font:12px/1.55 var(--mono);color:var(--muted);overflow-wrap:anywhere}
.wx{grid-column:2/-1;font-size:12px;color:var(--faint)}
.cat{font:500 11.5px var(--mono);padding:2px 8px;border-radius:6px;color:var(--cc);border:1px solid color-mix(in srgb,var(--cc) 45%,transparent);
  background:color-mix(in srgb,var(--cc) 10%,transparent)}
.VFR{--cc:var(--vfr)}.MVFR{--cc:var(--mvfr)}.IFR{--cc:var(--ifr)}.LIFR{--cc:var(--lifr)}
.hero{max-width:560px;margin:8vh auto 0;text-align:center}
.hero .mark{width:44px;height:44px;border-radius:12px;padding:7px;margin:0 auto 20px}
.hero .lede{margin:10px auto 22px}
@media (prefers-reduced-motion:no-preference){.wr[open] .insp{animation:fade .14s ease-out}@keyframes fade{from{opacity:0}}}
`;

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? `${Math.round(s)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const kindClass = (s) => `k${s.kind}${s.status === 2 ? " err" : ""}`;

// Depth-first span order with each span's depth and position on the trace's time axis (0..1).
function layout(spans) {
  const ids = new Set(spans.map((s) => s.span_id));
  const t0 = Math.min(...spans.map((s) => s.start_ms));
  const total = Math.max(Math.max(...spans.map((s) => s.end_ms ?? s.start_ms)) - t0, 1);
  const kids = Map.groupBy(spans, (s) => (ids.has(s.parent_span_id) ? s.parent_span_id : "root"));
  const rows = [];
  const walk = (s, depth) => {
    const dur = (s.end_ms ?? s.start_ms) - s.start_ms;
    rows.push({ s, depth, dur, x: (s.start_ms - t0) / total, w: dur / total });
    for (const c of kids.get(s.span_id) ?? []) walk(c, depth + 1);
  };
  for (const r of kids.get("root") ?? []) walk(r, 0);
  return { rows, t0, total };
}

// The shape of a request in a line: one lane per depth, bars to scale.
function glyph(spans) {
  const { rows } = layout(spans), lanes = Math.min(Math.max(...rows.map((r) => r.depth)) + 1, 6);
  return `<svg class=g viewBox="0 0 300 ${lanes * 6}" preserveAspectRatio=none style="height:${lanes * 6}px" aria-hidden=true>${rows
    .filter((r) => r.depth < lanes).map((r) => `<rect class="${kindClass(r.s)}" x="${(r.x * 300).toFixed(1)}" y="${r.depth * 6}"
      width="${Math.max(r.w * 300, 2).toFixed(1)}" height=4 rx=1.5 />`).join("")}</svg>`;
}

function ticks(total) {
  const raw = total / 5, p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw);
  const list = [];
  for (let t = 0; t <= total * 0.94; t += step) list.push(t);
  return { list, step };
}
const tickLabel = (t) => (t >= 1000 ? `${+(t / 1000).toFixed(2)}s` : `${+t.toFixed(1)}ms`);


// ---- demo: a real, branching request worth tracing --------------------------
// Parallel METAR fetches, a DB write and read, then render.
const ROUTE = ["KJFK", "KORD", "KDEN", "KSFO"];
async function demo(db, me) {
  const obs = await me.span("weather along the route", async (set) => {
    set("route.stations", ROUTE.join(" "));
    const results = await Promise.all(ROUTE.map((icao) => set.child(`station ${icao}`, async (st) => {
      st("airport.icao", icao);
      try {
        const body = await st.child("GET aviationweather.gov", async (h) => {
          const u = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`;
          Object.entries({ "http.request.method": "GET", "url.full": u, "server.address": "aviationweather.gov" }).forEach(([k, v]) => h(k, v));
          const r = await fetch(u, { headers: { "user-agent": "otel-collector-demo" } });
          h("http.response.status_code", r.status);
          const text = await r.text();
          h("http.response.body.size", text.length);
          if (!r.ok) h.fail(`HTTP ${r.status}`);
          return text;
        }, 3);
        const o = await st.child("parse METAR", async (p) => {
          const [x] = body ? JSON.parse(body) : [];
          p("metar.found", !!x);
          if (x) { p("metar.flight_category", x.fltCat ?? "unknown"); p("metar.raw", x.rawOb); }
          return x;
        });
        if (!o) { st.fail(`no observation for ${icao}`); return { icao }; }
        return { icao, name: o.name, raw: o.rawOb, cat: o.fltCat, temp: o.temp, wind: o.wspd, time: o.reportTime };
      } catch (e) { st.fail(String(e?.message ?? e)); return { icao }; }
    })));
    set("route.observations", results.filter((r) => r.raw).length);
    return results;
  });
  const found = obs.filter((o) => o.raw);
  await dbCall(me, "INSERT metar", "INSERT", "INSERT OR REPLACE INTO metar VALUES (?,?,?,?)", () => db.saveMetar(found));
  const HQ = "SELECT icao, COUNT(*) AS observations FROM metar GROUP BY icao";
  const { rows: history } = await dbCall(me, "SELECT station history", "SELECT", HQ, () => db.q(HQ));
  const seen = Object.fromEntries(history.map((h) => [h.icao, h.observations]));
  return me.span("render page", async (set) => {
    set("stations.rendered", obs.length);
    return html("Weather demo", `<div class=head><div><h1>Weather along the route</h1>
        <p class=lede>Live METARs for ${plural(ROUTE.length, "station")} between New York and San Francisco, fetched in parallel.</p></div>
        <a class="btn primary" href="/t/${me.traceId}">View trace</a></div>
      <section class=panel>${obs.map((o) => `<div class=st><span class=icao>${esc(o.icao)}</span><span class=sname>${esc(o.name ?? "Unknown station")}</span>
        ${o.cat ? `<span class="cat ${esc(o.cat)}">${esc(o.cat)}</span>` : o.raw ? "" : `<span class="pill err">No data</span>`}
        ${o.raw ? `<span class=raw>${esc(o.raw)}</span><span class=wx>${esc(o.temp)} °C, wind ${esc(o.wind)} kt, seen ${plural(seen[o.icao] ?? 1, "time")}</span>`
          : `<span class=wx>No observation was returned for ${esc(o.icao)}.</span>`}</div>`).join("")}</section>
      <p class=foot>The trace is stored right after this page is sent. If it looks empty, reload it.</p>`, 200, { crumb: "weather demo" });
  });
}

function tracePage(id, spans, back) {
  const L = layout(spans), root = L.rows[0]?.s ?? spans[0], T = ticks(L.total);
  const errors = spans.filter((s) => s.status === 2).length;
  const reqMs = L.rows[0]?.dur ?? L.total, after = L.total - reqMs;   // root span = the request; the rest ran after the response
  const summary = `${fmt(reqMs)} request, ${plural(spans.length, "span")}${after > 0.5 ? `, ${fmt(after)} of background work after the response` : ""}`;
  const rows = L.rows.map(({ s, depth, x, w, dur }) => {
    const a = typeof s.attrs === "string" ? JSON.parse(s.attrs) : s.attrs, ev = JSON.parse(s.events ?? "[]");
    const facts = { service: s.service, kind: KINDS[s.kind]?.slice(10).toLowerCase(), offset: `+${fmt(s.start_ms - L.t0)}`, duration: fmt(dur), span_id: s.span_id, ...a };
    return `<details class="wr ${kindClass(s)}" style="--d:${depth}"><summary><span class=sn><b>${esc(s.name)}</b>${s.service !== root.service ? `<small>${esc(s.service)}</small>` : ""}</span>
      <span class=tl><i style="left:${x * 100}%;width:${w * 100}%"></i></span><span class=rt>${fmt(dur)}</span></summary>
      <div class=insp><dl>${Object.entries(facts).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("")}
      ${ev.map((e) => `<dt>event +${fmt(e.time_ms - L.t0)}</dt><dd>${esc(e.name)} ${esc(JSON.stringify(e.attrs))}</dd>`).join("")}</dl></div></details>`;
  }).join("");
  return html(root.name, `<div class=head><div><h1>${esc(root.name)}</h1>
      <div class=idline><span class="pill ${errors ? "err" : "ok"}"><span class="dot${errors ? " err" : ""}"></span>${errors ? plural(errors, "error") : "OK"}</span>
      <span class="mono tid">${id}</span><button class=copy type=button onclick="navigator.clipboard.writeText('${id}').then(()=>this.textContent='Copied')">Copy ID</button>
      <a class=copy href="?format=otlp">OTLP JSON</a></div></div></div>
    <p class=lede>${summary}.</p>
    <section class="panel wfp" style="--step:${(T.step / L.total) * 100}%">
      <div class=wh><span>Span</span><span class=ruler>${T.list.map((t) => `<b style="left:${(t / L.total) * 100}%">${tickLabel(t)}</b>`).join("")}</span><span class=rt>Duration</span></div>
      ${rows}</section>
    <p class=foot>Select a span to inspect it. CPU-only work reads about 0 ms because the Workers clock advances only during I/O.</p>`,
    200, { home: back, crumb: root.name });
}

function listPage(spans, url, token, all, hidden) {
  const q = "";
  const traces = [...Map.groupBy(spans, (s) => s.trace_id)];
  const rows = traces.map(([id, ss]) => {
    const L = layout(ss), root = L.rows[0]?.s ?? ss[0];
    const services = [...new Set(ss.map((s) => s.service))];
    const self = services.length === 1 && services[0] === "otel-collector" && root.name !== "GET /demo";
    const failed = ss.some((s) => s.status === 2);
    return `<a class="trow${self ? " self" : ""}" href="/t/${id}${q}"><span class="dot${failed ? " err" : ""}"></span>
      <span class=tname><b>${esc(root.name)}</b><small>${esc(services.join(", "))}</small></span>${glyph(ss)}
      <span class="num strong dur">${fmt(L.rows[0]?.dur ?? L.total)}</span><span class="num spans">${ss.length}</span><span class="num age">${ago(L.t0)}</span>
      <span class=mm>${esc(services.join(", "))}, ${plural(ss.length, "span")}, ${ago(L.t0)}</span></a>`;
  }).join("");
  const send = `export OTEL_EXPORTER_OTLP_ENDPOINT=${url.origin}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${token}"`;
  return html("Traces", `<div class=head><div><h1>Traces</h1><p class=lede>${traces.length ? `${plural(traces.length, "trace")}, newest first` : "No traces yet"}</p></div>
      <nav class=seg aria-label="Filter traces"><a href="/"${all ? "" : " aria-current=page"}>Incoming</a><a href="/?all=1"${all ? " aria-current=page" : ""}>All${!all && hidden ? `<span class=n>+${hidden}</span>` : ""}</a></nav></div>
    <section class=panel><div class=thead><span></span><span>Name</span><span>Shape</span><span class=num>Duration</span><span class=num>Spans</span><span class=num>Started</span></div>
      ${rows || `<div class=empty>Nothing has arrived yet.<br><a class="btn primary" href="/demo">Run the demo</a></div>`}</section>
    <section class="panel send"><div class=sh>Send traces here</div><pre>${esc(send)}</pre></section>`,
    200, { crumb: "traces" });
}

const routeOf = (p) => (/^\/t\/[0-9a-f]{32}$/.test(p) ? "/t/{trace_id}" : p);

async function route(req, url, env, db, me, authed) {
  if (url.pathname === "/v1/traces" && req.method === "POST") {
    if (!authed) return json({ error: "unauthorized" }, 401);
    if (!(req.headers.get("content-type") ?? "").includes("application/json"))
      return json({ error: "OTLP/HTTP JSON only (OTEL_EXPORTER_OTLP_PROTOCOL=http/json)" }, 415);
    const body = await me.span("read body", async (set) => {
      const text = await req.text();
      set("http.request.body.size", text.length);
      set("http.request.header.content-encoding", req.headers.get("content-encoding") ?? "identity");
      return JSON.parse(text);
    });
    const all = await me.span("parse otlp", async (set) => {
      const r = fromOtlp(body);
      set("otlp.resource_spans", body.resourceSpans?.length ?? 0); set("otlp.spans", r.length);
      set("otlp.services", [...new Set(r.map((s) => s.service))].join(","));
      return r;
    });
    const ok = all.filter((r) => /^[0-9a-f]{32}$/.test(r.trace_id) && /^[0-9a-f]{16}$/.test(r.span_id));
    await dbCall(me, "INSERT spans", "INSERT", "INSERT OR REPLACE INTO spans VALUES (?,?,?,?,?,?,?,?,?,?,?)", () => db.insert(ok));
    Object.assign(me.root.attrs, { "otlp.accepted_spans": ok.length, "otlp.rejected_spans": all.length - ok.length });
    return json(ok.length === all.length ? {} : { partialSuccess: {
      rejectedSpans: String(all.length - ok.length), errorMessage: "traceId must be 32 hex chars, spanId 16" } });
  }
  const m = url.pathname.match(/^\/t\/([0-9a-f]{32})$/);   // one trace: its id is the capability
  if (m) {
    const Q = `SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ms, rowid`;
    const { rows: spans } = await dbCall(me, "SELECT spans", "SELECT", Q, () => db.q(Q, m[1]));
    if (!spans.length) return html("Not found", `<div class=hero><h1>No trace with that ID</h1><p class=lede>It may still be arriving, or it was sent to a different collector. Reload in a moment.</p></div>`, 404);
    if (url.searchParams.get("format") === "otlp") return json(toOtlp(spans));
    return me.span("render trace", async (set) => { set("spans", spans.length); return tracePage(m[1], spans, "/"); });
  }
  if (url.pathname === "/demo") return demo(db, me);
  if (!authed) return html("Collector", `<div class=hero>${MARK}<h1>OpenTelemetry collector</h1>
    <p class=lede>Send OTLP/HTTP JSON to <code>/v1/traces</code> with a bearer token, then open <code>/?token=</code> once to sign this browser in.</p>
    <a class="btn primary" href="/demo">Run the demo</a></div>`, url.pathname === "/" ? 200 : 401);
  if (url.pathname === "/") {
    const all = url.searchParams.get("all") === "1";
    const interesting = "SUM(service != 'otel-collector') > 0 OR SUM(name = 'GET /demo') > 0";
    const Q = `WITH recent AS (SELECT trace_id, MIN(start_ms) AS t FROM spans GROUP BY trace_id
        ${all ? "" : `HAVING ${interesting}`} ORDER BY t DESC LIMIT 40)
      SELECT s.trace_id, s.span_id, s.parent_span_id, s.service, s.name, s.kind, s.start_ms, s.end_ms, s.status
      FROM spans s JOIN recent USING (trace_id) ORDER BY recent.t DESC, s.start_ms, s.rowid`;
    const HQ = `SELECT COUNT(*) AS n FROM (SELECT trace_id FROM spans GROUP BY trace_id HAVING NOT (${interesting}))`;
    const [{ rows }, { rows: [{ n: hidden }] }] = await Promise.all([
      dbCall(me, "SELECT recent traces", "SELECT", Q, () => db.q(Q)),
      dbCall(me, "COUNT housekeeping traces", "SELECT", HQ, () => db.q(HQ))]);
    return me.span("render list", async (set) => { set("spans", rows.length);
      return listPage(rows, url, env.TOKEN, all, hidden); });
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cookie = /(?:^|;\s*)otel_token=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "") || cookie || url.searchParams.get("token");
    // ?token= signs the browser in once: set a cookie and redirect to a clean URL, so links never carry the secret.
    if (req.method === "GET" && url.searchParams.has("token") && url.searchParams.get("token") === env.TOKEN) {
      url.searchParams.delete("token");
      return new Response(null, { status: 303, headers: { location: url.pathname + url.search,
        "set-cookie": `otel_token=${env.TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` } });
    }
    const db = env.STORE.get(env.STORE.idFromName("spans"));
    const httpRoute = routeOf(url.pathname), cf = req.cf ?? {};
    // A self-export is the collector shipping its own spans to itself. It must not be exported again (loop).
    const selfExport = req.headers.get(SELF_EXPORT) === "1" && presented === env.TOKEN;
    const me = new Self(`${req.method} ${httpRoute}`, selfExport ? req.headers.get("traceparent") : null);
    Object.assign(me.root.attrs, {   // never url.query: it can carry the token
      "http.request.method": req.method, "http.route": httpRoute, "url.path": url.pathname,
      "server.address": url.hostname, "network.protocol.name": cf.httpProtocol,
      "user_agent.original": (req.headers.get("user-agent") ?? "").slice(0, 200),
      "cloudflare.colo": cf.colo, "cloudflare.ray_id": req.headers.get("cf-ray"),
      "client.geo.country_iso_code": cf.country, "client.authenticated": presented === env.TOKEN });
    let res;
    try { res = await route(req, url, env, db, me, presented === env.TOKEN); }
    catch (e) { me.root.attrs["exception.message"] = String(e?.message ?? e); res = json({ error: "internal error" }, 500); }
    const spans = me.end(res.status);
    const housekeeping = !selfExport && req.method === "GET" && httpRoute !== "/demo";
    if (housekeeping && Math.random() >= SELF_SAMPLE) {
      // not recorded: page views would otherwise outnumber real traces
    } else if (selfExport) {
      me.root.attrs["otel.self_export"] = true;
      ctx.waitUntil(db.insert(spans));   // loop break: the exporter's own ingest is stored directly
    } else {
      ctx.waitUntil(exportToSelf(ctx, env, db, me, spans));
    }
    res.headers.set("x-trace-id", me.traceId);
    return res;
  },
};

// Ship our own spans through our own OTLP endpoint, over the ctx.exports loopback (no network,
// no bot challenge). traceparent makes that ingest a child of the request it describes.
const SELF_EXPORT = "x-otel-self-export";
const SELF_SAMPLE = 0.1;   // fraction of the collector's own page views that get traced
async function exportToSelf(ctx, env, db, me, spans) {
  const loopback = ctx.exports?.default;
  if (!loopback) return db.insert(spans);   // runtime without ctx.exports: store directly
  try {
    const r = await loopback.fetch("https://self/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.TOKEN}`,
                 [SELF_EXPORT]: "1", traceparent: `00-${me.traceId}-${me.root.span_id}-01` },
      body: JSON.stringify(toOtlp(spans)),
    });
    await r.body?.cancel();
    if (!r.ok) throw new Error(`self-export HTTP ${r.status}`);
  } catch (e) {
    me.root.attrs["otel.self_export.error"] = String(e?.message ?? e);
    return db.insert(spans);   // never lose our own spans
  }
}
