// Assemble a workerd config: copy src/*.js and the worker into a flat bundle dir with import specifiers rewritten.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function build({ port, outDir }) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const mods = [];
  for (const f of readdirSync(join(root, 'src'))) {
    if (!f.endsWith('.js') || f === 'ssh-node.js') continue; // node:net has no place in the Workers bundle
    writeFileSync(join(outDir, f), readFileSync(join(root, 'src', f), 'utf8').replace(/from '\.\/([\w.-]+)'/g, "from '$1'"));
    mods.push(f);
  }
  writeFileSync(join(outDir, 'worker.mjs'), readFileSync(join(root, 'test/workerd/worker.mjs'), 'utf8').replace(/from '\.\.\/\.\.\/src\/([\w.-]+)'/g, "from '$1'"));
  const cfg = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .worker), (name = "internet", network = (allow = ["private", "public", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const worker :Workerd.Worker = (
  modules = [ (name = "worker.mjs", esModule = embed "worker.mjs"), ${mods.map(m => `(name = "${m}", esModule = embed "${m}")`).join(', ')} ],
  compatibilityDate = "2024-09-23",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "internet",
);
`;
  writeFileSync(join(outDir, 'config.capnp'), cfg);
  return join(outDir, 'config.capnp');
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(build({ port: +(process.argv[2] ?? 18787), outDir: process.argv[3] ?? '/tmp/ply-wd' }));
