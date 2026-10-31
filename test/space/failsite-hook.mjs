// Fail-site recorder (gate c). Preloaded with `--import ./test/space/failsite-hook.mjs` (through NODE_OPTIONS, so every
// process and worker thread the suite starts loads it too) when PLY_FAILSITES names a directory; a no-op otherwise.
// It never touches src/: src/errors.ts is rewritten as it is loaded (test/space/failsite-instrument.mjs), here by a
// module-load hook for code node loads itself, and by the vitest plugin in vitest.config.ts for code vitest transforms.
//
// Why a load hook and not a branch in plyError: a `globalThis` check in errors.ts would ship in every bundle and run on
// every error; V8 coverage would also work but says only that a range ran, not through which call chain, so a wrapper
// (`badTree(why)`, `take(..., code)`) would hide the decision that called it. A stack names every call site on the way,
// so the wrapper's caller is recorded as the site it is.
//
// Records: <dir>/<pid>-<thread>-<runner>.json = { runner, platform, frames: { "src/x.ts:L:C": n } }, one count per src/
// frame of every recorded stack, rewritten whenever the thread reaches a frame it had not reached (a vitest fork or a
// worker thread may be stopped without an exit event) and at exit. The runner is the test file: the vitest setup file
// (test/space/failsite-setup.js) names it and exports it as PLY_FAILSITE_RUNNER to the workers and children it starts;
// a plain node process is its own script. test/space/holes.js maps frames to inventory sites.
import { registerHooks } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, threadId } from 'node:worker_threads';
import { ROOT, ERRORS_URL, KEY, instrument } from './failsite-instrument.mjs';

const DIR = process.env.PLY_FAILSITES;

if (DIR && !globalThis[KEY]) {
  const out = isAbsolute(DIR) ? DIR : join(ROOT, DIR);
  mkdirSync(out, { recursive: true });
  const SRC = `${join(ROOT, 'src')}/`;
  const byRunner = new Map(); // runner -> Map(frame -> n)
  let named = null;
  const runner = () => named ?? process.env.PLY_FAILSITE_RUNNER ?? (process.argv[1] ? relative(ROOT, process.argv[1]) : '(eval)');
  const thread = isMainThread ? 'm' : `w${threadId}`;
  const save = r => writeFileSync(join(out, `${process.pid}-${thread}-${r.replace(/[^\w.-]+/g, '_')}.json`),
    JSON.stringify({ runner: r, platform: process.platform, frames: Object.fromEntries(byRunner.get(r) ?? []) }));
  const recorder = holder => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const o = {};
    Error.captureStackTrace(o, holder);
    Error.stackTraceLimit = limit;
    const r = runner();
    if (!byRunner.has(r)) byRunner.set(r, new Map());
    const frames = byRunner.get(r);
    const seen = new Set();
    let fresh = false;
    // node prints file:// URLs; vitest's source-mapped stacks print paths
    for (const line of o.stack.split('\n').slice(1)) {
      const m = /\(?((?:file:\/\/)?\/[^\s()]+):(\d+):(\d+)\)?$/.exec(line);
      if (!m) continue;
      const file = m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1];
      if (!file.startsWith(SRC)) continue;
      const key = `${relative(ROOT, file)}:${m[2]}:${m[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!frames.has(key)) fresh = true;
      frames.set(key, (frames.get(key) ?? 0) + 1);
    }
    if (fresh) save(r);
  };
  // the vitest setup file names the test file this process (or thread) is running; written at once, even with no
  // frames: the record also says which runner ran on which platform (the Linux gate)
  recorder.runner = r => { named = r; if (!byRunner.has(r)) byRunner.set(r, new Map()); save(r); };
  globalThis[KEY] = recorder;
  process.on('exit', () => {
    // a process that recorded nothing is still a record (it ran), unless it is a tool: npx, vitest's own process
    const r = runner();
    if (!byRunner.size && !r.startsWith('..') && !r.startsWith('node_modules')) byRunner.set(r, new Map());
    for (const k of byRunner.keys()) save(k);
  });
  registerHooks({
    load(url, context, next) {
      const r = next(url, context);
      if (url !== ERRORS_URL) return r;
      const source = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source);
      return { ...r, source: instrument(source) };
    },
  });
}
