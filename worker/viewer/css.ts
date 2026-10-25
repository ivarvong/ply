function steps(): string {
  let css = '';
  for (let i = 0; i <= 100; i++) css += `.o${i}{left:${i}%}.w${i}{width:${i}%}\n`;
  return css;
}

export const VIEWER_CSS = `
:root { color-scheme: light; --bg:#f6f8fa; --card:#fff; --ink:#1f2328; --muted:#656d76; --line:#d0d7de; --link:#0969da; --bar:#eaeef2; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; color: var(--ink); background: var(--bg); }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top { display: flex; gap: 1rem; align-items: baseline; padding: .75rem 1.25rem; background: #24292f; color: #fff; }
header.top a { color: #fff; font-weight: 650; }
header.top span { color: #b7c0c8; }
main { max-width: 1080px; margin: 0 auto; padding: 1rem 1.25rem 3rem; }
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: .9rem 1rem; margin: .75rem 0; }
form.home { display: flex; gap: .5rem; flex-wrap: wrap; }
input[type=url], input[type=text] { flex: 1; min-width: 16rem; font: inherit; padding: .45rem .6rem; border: 1px solid var(--line); border-radius: 6px; }
button { font: inherit; background: #1f883d; color: #fff; border: 0; border-radius: 6px; padding: .45rem .8rem; cursor: pointer; }
.crumbs { font-family: ui-monospace, monospace; font-size: 13px; margin: .4rem 0; }
ul.refs, ul.log { list-style: none; padding: 0; margin: 0; }
ul.refs li, ul.log li { padding: .15rem 0; font-family: ui-monospace, monospace; font-size: 12px; }
table.files { width: 100%; border-collapse: collapse; }
table.files th, table.files td { text-align: left; padding: .35rem .4rem; border-top: 1px solid var(--line); font-family: ui-monospace, monospace; font-size: 12px; }
table.files th { color: var(--muted); font-weight: 600; }
.oid { color: var(--muted); }
pre, .code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
pre.msg { white-space: pre-wrap; margin: .4rem 0 0; }
.code { background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: auto; }
.code div { display: grid; grid-template-columns: 3.5rem 1fr; }
.code .ln { color: var(--muted); text-align: right; padding: 0 .6rem; user-select: none; }
.code .src { white-space: pre; padding-right: .6rem; }
.banner { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 8px; padding: .6rem .8rem; margin: .75rem 0; }
.error { background: #ffebe9; border: 1px solid #ff8182; }
.legend { display: flex; flex-wrap: wrap; gap: .7rem; font-size: 12px; margin: .4rem 0; }
.sw { display: inline-block; width: .8rem; height: .8rem; border-radius: 2px; vertical-align: -1px; margin-right: .25rem; }
.t-commit { background: #1f6feb; }
.t-tree { background: #1a7f37; }
.t-blob { background: #6e7781; }
.t-tag { background: #8250df; }
.t-ofs_delta { background: #bf8700; }
.t-ref_delta { background: #cf222e; }
.t-header, .t-trailer { background: #24292f; }
.packbar { display: flex; height: 28px; width: 100%; border-radius: 4px; overflow: hidden; background: var(--bar); }
.packbar a, .packbar span { display: block; height: 100%; flex: none; }
.packbar a.on { outline: 2px solid #000; }
.trace .row { display: grid; grid-template-columns: 16rem 1fr 18rem; gap: .5rem; align-items: center; margin: .35rem 0; }
.track { position: relative; height: 16px; background: var(--bar); border-radius: 3px; }
.bar { position: absolute; top: 1px; bottom: 1px; border-radius: 2px; }
.c-err { background: #cf222e; }
.c-hit { background: #1a7f37; }
.c-discover, .c-refs { background: #0969da; }
.c-fetch { background: #8250df; }
.c-fallback { background: #bf8700; }
.meta, .detail { color: var(--muted); font-size: 12px; }
.detail { margin: 0 0 .4rem 16.5rem; white-space: pre-wrap; }
footer { color: var(--muted); font-size: 12px; margin-top: 1.5rem; }
@media (max-width: 800px) {
  .trace .row { grid-template-columns: 1fr; }
  .detail { margin-left: 0; }
}
${steps()}
`;
