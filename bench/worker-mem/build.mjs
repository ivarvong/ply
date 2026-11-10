// Bundles worker.mjs (against ply's built dist/) with esbuild and writes cf Build Output, so `cf deploy --prebuilt`
// uploads exactly this bundle. Run `npm run build` at the repo root first; run.mjs does both.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, WORKER, NAMESPACE } from './lib.mjs';

// The paid plan's ceiling for one HTTP request's CPU (developers.cloudflare.com/workers/platform/limits).
const CPU_LIMIT_MS = 300_000;

export function workerConfig({ pendingCells = 'off' } = {}) {
  return {
    name: WORKER,
    compatibilityDate: '2026-10-19',
    compatibilityFlags: [],
    limits: { cpuMs: CPU_LIMIT_MS },
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: false, headSamplingRate: 1 },
    },
    workersDev: true,
    previewUrls: false,
    env: {
      MEMLAB_TOKEN: { type: 'secret' },
      REPOS: { type: 'artifacts', namespace: NAMESPACE },
      VERSION: { type: 'version-metadata' },
      PENDING_CELLS: { type: 'text', value: pendingCells },
      // Scratch spool for the resolve cell (created once: cf r2 buckets create --name ply-memlab-spool).
      SPOOL: { type: 'r2', name: 'ply-memlab-spool' },
    },
    exports: { default: { type: 'worker', cache: { enabled: false } } },
    manifest: { type: 'partial', mainModule: 'index.js', modules: {} },
  };
}

export { CPU_LIMIT_MS };
export async function buildOutput(opts = {}) {
  const out = join(HERE, '.cloudflare', 'output', 'v0');
  rmSync(out, { recursive: true, force: true });
  const bundleDir = join(out, 'workers', 'default', 'bundle');
  mkdirSync(bundleDir, { recursive: true });
  await build({
    entryPoints: [join(HERE, 'worker.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile: join(bundleDir, 'index.js'),
    logLevel: 'warning',
    // The pending cells probe exports that land later (#234 pushPack, #236 scanPackIndex); undefined is the signal.
    logOverride: { 'import-is-undefined': 'silent' },
    define: { __PLY_SHA__: JSON.stringify(opts.plySha ?? 'unknown'), __CPU_LIMIT_MS__: String(CPU_LIMIT_MS) },
  });
  writeFileSync(join(out, 'config.json'), JSON.stringify({ buildContext: { isPreview: false, mode: 'production' } }, null, 1));
  writeFileSync(join(out, 'workers', 'default', 'worker.config.json'), JSON.stringify(workerConfig(opts), null, 1));
  return { bundleBytes: statSync(join(bundleDir, 'index.js')).size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await buildOutput();
  console.log(`built ${r.bundleBytes} bytes`);
}
