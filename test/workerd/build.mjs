// Assemble a workerd config: esbuild bundles test/workerd/worker.mjs and the src modules it imports (.ts and .js, the
// `.js` specifiers resolving to `.ts` the way tsc and every consumer bundler resolve them) into one ES module, the shape
// a Workers deploy uploads. Only `cloudflare:*` stays external: workerd provides it. No minify, so stacks stay legible.
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function build({ port, outDir }) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  buildSync({
    entryPoints: [join(root, 'test/workerd/worker.mjs')], outfile: join(outDir, 'worker.mjs'),
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:*'], logLevel: 'warning',
  });
  const cfg = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .worker), (name = "internet", network = (allow = ["private", "public", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const worker :Workerd.Worker = (
  modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ],
  compatibilityDate = "2024-09-23",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "internet",
);
`;
  writeFileSync(join(outDir, 'config.capnp'), cfg);
  return join(outDir, 'config.capnp');
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(build({ port: +(process.argv[2] ?? 18787), outDir: process.argv[3] ?? '/tmp/ply-wd' }));
