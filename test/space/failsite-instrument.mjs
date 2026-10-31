// The one rewrite gate c's recorder makes, shared by both ways src/ runs under test: node's own loader (worker threads
// and child processes, test/space/failsite-hook.mjs) and vitest's transform (the test files themselves, the plugin in
// vitest.config.ts). It serves src/errors.ts with one call added at the head of plyError's implementation, on the
// declaration's own line: every other line of the module, and every line and column of every other module, is where
// the file has it. plyError is the constructor every fail site reaches (`fail`, `thrown`, the wrappers and limits.ts
// all build their error with it), so a stack captured there names the site.
//
// Only runs when PLY_FAILSITES is set; src/, the bundle and its size are untouched.
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const ERRORS = join(ROOT, 'src/errors.ts');
export const ERRORS_URL = pathToFileURL(ERRORS).href;
export const KEY = Symbol.for('ply.failsite');
const DECL = 'export function plyError(code: string, message: string, extra?: object): Thrown {';

export function instrument(source) {
  if (!source.includes(DECL)) throw new Error(`failsite: src/errors.ts no longer declares \`${DECL}\`; update test/space/failsite-instrument.mjs`);
  return source.replace(DECL, `${DECL} globalThis[Symbol.for('ply.failsite')]?.(plyError);`);
}
