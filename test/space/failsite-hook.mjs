// Fail-site recorder (gate c). Preloaded with `node --import ./test/space/failsite-hook.mjs` when PLY_FAILSITES names a
// directory; a no-op otherwise. It never touches src/: a module-load hook rewrites src/errors.js as it is imported, in
// memory, so that `fail` records the stack of every call and then builds the error exactly as before. The shipped file,
// the bundle and its size are unchanged, and a process without the flag runs the original module.
//
// Why a load hook and not a branch in fail(): a `globalThis` check in errors.js would ship in every bundle and run on
// every error; V8 coverage (NODE_V8_COVERAGE) would also work but says only that a range ran, not through which call
// chain, so a wrapper (`proto(msg)`, `take(..., code)`) would hide the decision that called it. A stack names every
// call site on the way, so the wrapper's caller is recorded as the site it is.
//
// Each process writes <dir>/<pid>-<n>.json at exit: { runner: the script or test file, platform, frames: { "src/x.js:L:C": n } },
// one count per src/ frame of every recorded stack. test/space/holes.js maps frames to inventory sites.
import { register } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = process.env.PLY_FAILSITES;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = Symbol.for('ply.failsite');

if (DIR && !globalThis[KEY]) {
  const out = isAbsolute(DIR) ? DIR : join(ROOT, DIR);
  mkdirSync(out, { recursive: true });
  const frames = new Map();
  const SRC = `${pathToFileURL(join(ROOT, 'src')).href}/`;
  globalThis[KEY] = holder => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const o = {};
    Error.captureStackTrace(o, holder);
    Error.stackTraceLimit = limit;
    const seen = new Set();
    for (const line of o.stack.split('\n').slice(1)) {
      const m = /(file:\/\/[^\s)]+):(\d+):(\d+)\)?$/.exec(line);
      if (!m || !m[1].startsWith(SRC)) continue;
      const key = `${relative(ROOT, fileURLToPath(m[1]))}:${m[2]}:${m[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frames.set(key, (frames.get(key) ?? 0) + 1);
    }
  };
  let n = 0;
  // written even with no frames: the record also says which runner ran on which platform (the Linux gate)
  process.on('exit', () => {
    const runner = process.argv[1] ? relative(ROOT, process.argv[1]) : '(eval)';
    writeFileSync(join(out, `${process.pid}-${n++}.json`), JSON.stringify({ runner, platform: process.platform, frames: Object.fromEntries(frames) }));
  });
  register('./failsite-loader.mjs', import.meta.url, { data: { errors: pathToFileURL(join(ROOT, 'src/errors.js')).href } });
}
