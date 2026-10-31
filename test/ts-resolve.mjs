// Run src/ from source under plain node: a relative `./x.js` import resolves to `./x.ts` when only the .ts exists.
// Source keeps `.js` specifiers (TypeScript's nodenext convention: tsc and vitest map them to .ts already, and dist/
// needs no rewrite), so converting a module renames one file and touches no importer. Node's own type stripping
// (>= 22.18) then runs the .ts. Loaded with `node --import ./test/ts-resolve.mjs` and, for every child process and
// worker a test starts, through NODE_OPTIONS (test/vitest-setup.js sets it).
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.\.?\//.test(specifier) || !specifier.endsWith('.js')) throw e;
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
