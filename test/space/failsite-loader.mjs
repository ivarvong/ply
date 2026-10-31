// Module-load hook for test/space/failsite-hook.mjs: serves src/errors.js with `fail` wrapped by the recorder. Only the
// declaration line changes (`export const fail =` becomes `const fail$ =`), so every other line and column of the module
// is where the file has it; the wrapper is appended after the last line.
let errorsUrl;
export function initialize(data) { errorsUrl = data.errors; }

export async function load(url, context, next) {
  const r = await next(url, context);
  if (url !== errorsUrl) return r;
  const src = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source);
  const decl = 'export const fail = (';
  if (!src.includes(decl)) throw new Error('failsite-loader: src/errors.js no longer declares `export const fail = (`; update the hook');
  const wrapped = `${src.replace(decl, 'const fail$ = (')}
export const fail = function fail(...args) { globalThis[Symbol.for('ply.failsite')]?.(fail); return fail$(...args); };
`;
  return { ...r, source: wrapped, shortCircuit: true };
}
