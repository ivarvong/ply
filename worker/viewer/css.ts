function steps(): string {
  let css = '';
  for (let i = 0; i <= 100; i++) css += `.o${i}{left:${i}%}.w${i}{width:${i}%}\n`;
  return css;
}

export const VIEWER_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f8fa;
  --card: #ffffff;
  --ink: #1f2328;
  --muted: #59636e;
  --line: #d1d9e0;
  --link: #0969da;
  --bar: #eaeef2;
  --header: #24292f;
  --header-ink: #ffffff;
  --header-muted: #b7c0c8;
  --ok: #1a7f37;
  --warn-bg: #fff8c5;
  --warn-line: #d4a72c;
  --err: #cf222e;
  --err-bg: #ffebe9;
  --err-line: #ff8182;
  --hl: #fff8c5;
  --chain: #ddf4ff;
  --code: #f6f8fa;
  --chip: #ffffff;
  --focus: #0969da;
  --shadow: 0 1px 0 rgba(31, 35, 40, .04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --card: #161b22;
    --ink: #e6edf3;
    --muted: #8d96a0;
    --line: #30363d;
    --link: #4493f8;
    --bar: #21262d;
    --header: #010409;
    --header-ink: #e6edf3;
    --header-muted: #8d96a0;
    --ok: #3fb950;
    --warn-bg: #2d2305;
    --warn-line: #9e6a03;
    --err: #f85149;
    --err-bg: #3d1214;
    --err-line: #f85149;
    --hl: #3d2e00;
    --chain: #12263a;
    --code: #0d1117;
    --chip: #21262d;
    --focus: #4493f8;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
header.top { display: flex; gap: 1rem; align-items: baseline; padding: .85rem 1.25rem; background: var(--header); color: var(--header-ink); }
header.top a { color: var(--header-ink); font-weight: 650; letter-spacing: -.01em; }
header.top span { color: var(--header-muted); font-size: .9rem; }
main { max-width: 1100px; margin: 0 auto; padding: 1.25rem 1.25rem 3rem; }
h1 { font-size: 1.6rem; font-weight: 620; letter-spacing: -.02em; margin: 0 0 .35rem; }
h2 { font-size: 1rem; margin: 0 0 .6rem; }
h3, h4, h5 { margin: .8rem 0 .3rem; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; margin: .9rem 0; box-shadow: var(--shadow); }
.hero { font-size: 1.05rem; max-width: 42rem; }
form.home { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; margin: 1rem 0; }
input[type=text], select {
  font: inherit; color: var(--ink); background: var(--card);
  padding: .7rem .8rem; border: 1px solid var(--line); border-radius: 8px;
}
input[type=text] { flex: 1; min-width: min(100%, 18rem); }
input[type=text].big { font-size: 1.05rem; padding: .85rem 1rem; }
button, .chip {
  font: inherit; background: var(--ok); color: #fff; border: 0; border-radius: 8px;
  padding: .7rem 1rem; cursor: pointer; text-decoration: none;
}
button.ghost, .chip { background: var(--chip); color: var(--ink); border: 1px solid var(--line); }
button[data-copied="1"] { outline: 2px solid var(--ok); }
.chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: .4rem 0 1rem; }
.hosts { display: flex; flex-wrap: wrap; gap: .4rem; padding: 0; margin: .3rem 0 0; list-style: none; }
.hosts li { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85rem; background: var(--code); border: 1px solid var(--line); border-radius: 999px; padding: .15rem .6rem; }
.repo-head { display: flex; flex-wrap: wrap; gap: .75rem 1rem; align-items: center; justify-content: space-between; }
.crumbs { font-size: 1.05rem; margin: .2rem 0 .6rem; word-break: break-word; }
.crumbs a { font-weight: 600; }
.crumbs .sep { color: var(--muted); margin: 0 .2rem; }
.switchers { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; }
.switchers form { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
.switchers label { font-size: .85rem; color: var(--muted); display: flex; gap: .35rem; align-items: center; }
.switchers select, .switchers input { padding: .35rem .5rem; }
.switchers button { padding: .35rem .7rem; }
.ico { width: 1rem; height: 1rem; vertical-align: -2px; margin-right: .35rem; color: var(--link); }
table.files { width: 100%; border-collapse: collapse; }
table.files th, table.files td { text-align: left; padding: .45rem .4rem; border-top: 1px solid var(--line); }
table.files th { color: var(--muted); font-weight: 600; font-size: .8rem; }
table.files td.name { font-weight: 550; }
table.files tr.on, table.files tr:target { background: var(--hl); }
table.files tr.chain { background: var(--chain); }
.oid { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85rem; }
ul.log { list-style: none; padding: 0; margin: 0; }
ul.log li { padding: .2rem 0; }
pre, .code, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre.msg, .md pre { white-space: pre-wrap; margin: .4rem 0 0; background: var(--code); border-radius: 8px; padding: .7rem .8rem; }
.md { font-size: .95rem; }
.md code { background: var(--code); padding: .05rem .3rem; border-radius: 4px; }
.code { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: auto; }
.line { display: grid; grid-template-columns: 3.4rem 1fr; }
.line:target, .line.on { background: var(--hl); }
.ln { color: var(--muted); text-align: right; padding: 0 .7rem; user-select: none; }
.src { white-space: pre; padding-right: .8rem; }
.filebar { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; justify-content: space-between; }
.banner { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: .7rem .85rem; margin: .75rem 0; }
.error { background: var(--err-bg); border-color: var(--err-line); }
.legend { display: flex; flex-wrap: wrap; gap: .75rem; font-size: .85rem; margin: .5rem 0; }
.sw { display: inline-block; width: .85rem; height: .85rem; border-radius: 2px; vertical-align: -1px; margin-right: .25rem; }
.t-commit { background: #1f6feb; }
.t-tree { background: #1a7f37; }
.t-blob { background: #6e7781; }
.t-tag { background: #8250df; }
.t-ofs_delta { background: #bf8700; }
.t-ref_delta { background: #cf222e; }
.t-header, .t-trailer { background: #24292f; }
@media (prefers-color-scheme: dark) {
  .t-header, .t-trailer { background: #6e7681; }
  .t-blob { background: #8b949e; }
}
.packbar { display: flex; height: 36px; width: 100%; border-radius: 6px; overflow: hidden; background: var(--bar); }
.packbar a, .packbar span { display: block; height: 100%; flex: none; min-width: 2px; }
.packbar a.on, .packbar a:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.stats { display: flex; flex-wrap: wrap; gap: .4rem .9rem; margin: .2rem 0 .6rem; }
.stats strong { font-variant-numeric: tabular-nums; }
.trace > summary {
  position: sticky; top: 0; z-index: 2; cursor: pointer; list-style: none;
  background: var(--card); padding: .15rem 0 .4rem; font-weight: 620;
}
.trace > summary::-webkit-details-marker { display: none; }
.pill { display: inline-block; background: var(--code); border: 1px solid var(--line); border-radius: 999px; padding: .2rem .7rem; font-size: .9rem; }
.span { border-top: 1px solid var(--line); padding: .45rem 0; }
.span > summary { display: grid; grid-template-columns: minmax(9rem, 16rem) 1fr minmax(8rem, 16rem); gap: .55rem; align-items: center; cursor: pointer; }
.span.err .name { color: var(--err); font-weight: 650; }
.track { position: relative; height: 18px; background: var(--bar); border-radius: 4px; }
.bar { position: absolute; top: 2px; bottom: 2px; border-radius: 3px; min-width: 3px; }
.c-err { background: var(--err); }
.c-hit { background: var(--ok); }
.c-discover, .c-refs { background: var(--link); }
.c-fetch { background: #8250df; }
.c-fallback { background: #bf8700; }
.meta, .detail { color: var(--muted); font-size: .82rem; }
.detail { margin: .35rem 0 0; white-space: pre-wrap; }
.name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82rem; }
footer { color: var(--muted); font-size: .8rem; margin-top: 1.75rem; }
.next { margin-top: .6rem; }
@media (max-width: 800px) {
  main { padding: 1rem .85rem 2.5rem; }
  h1 { font-size: 1.35rem; }
  .span > summary { grid-template-columns: 1fr; }
  .switchers form { width: 100%; }
  table.files { font-size: .9rem; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
${steps()}
`;
