// Parent of the heap sweep. It does not import the inflater: the child does, so a mutation run does not
// re-execute the sweep for every covered line.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

function rssKb(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    for (const line of text.split('\n')) {
      if (line.startsWith('VmRSS:')) return Number(line.split(/\s+/)[1]);
    }
  } catch { /* the child has already exited */ }
  return 0;
}
function run(mode, heap) {
  const args = ['--expose-gc'];
  if (heap > 0) args.push(`--max-old-space-size=${heap}`);
  args.push('--import', './test/ts-resolve.mjs', 'test/stream/cell.mjs', mode);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: process.env });
    let out = '';
    let err = '';
    let rss = 0;
    const timer = setInterval(() => {
      const kb = rssKb(child.pid);
      if (kb > rss) rss = kb;
    }, 20);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearInterval(timer);
      if (code !== 0) {
        reject(new Error(`${mode} heap ${heap} exit ${code}\n${err}\n${out}`));
        return;
      }
      const line = out.trim().split('\n').at(-1);
      resolve({ ...JSON.parse(line), rssPeak: rss * 1024 });
    });
  });
}

test('streamed inflate and pack scan stay inside the peak bound on a 64 MiB and a 128 MiB heap', async () => {
  const beforeInflate = await run('before-inflate', 0);
  const drop64 = await run('drop', 64);
  const drop128 = await run('drop', 128);
  const materialize = await run('materialize', 128);
  const beforePack = await run('before-pack', 0);
  const scan64 = await run('scan', 64);
  const scan128 = await run('scan', 128);
  const report = { beforeInflate, drop64, drop128, materialize, beforePack, scan64, scan128 };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(drop64.abDelta <= drop64.bound);
  assert.ok(drop128.abDelta <= drop128.bound);
  assert.ok(materialize.abDelta <= materialize.bound);
  assert.ok(scan64.abDelta <= scan64.bound);
  assert.ok(scan128.abDelta <= scan128.bound);
  assert.ok(drop64.rss < beforeInflate.rss, `drop rss ${drop64.rss} vs buffered inflate rss ${beforeInflate.rss}`);
  assert.ok(scan64.rss < beforePack.rss, `scan rss ${scan64.rss} vs buffered pack rss ${beforePack.rss}`);
});
