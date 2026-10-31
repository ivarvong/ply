// Preloaded into every mutation-run test process (stryker.conf.json tap.nodeArgs). Two failure modes of a mutant that
// the test process itself cannot be trusted to stop, since a mutant can block its event loop for good:
//  - memory. Without `out.set(p, …)` in pkt() (src/pktline.js:22) a test process grew past 23 GB resident inside
//    Stryker's timeout window, mostly ArrayBuffers that --max-old-space-size does not bound. On a 16 GB CI runner that
//    took the runner down ("received a shutdown signal", runs 41203243420 and 41204344306), not just the mutant.
//  - orphans. On a timeout Stryker kills its test-runner worker, not the `node <test file>` the worker spawned.
// So a separate sh watches the process: past PLY_MUTANT_RSS_KB resident (default 3 GB; the unmutated files peak well
// under 1 GB each), or once the parent is gone, it SIGKILLs it. A killed test process exits without reporting a failed
// test, which Stryker's tap runner reports as RuntimeError and scripts/mutate.mjs counts as detected, as the command
// runner counted any crash; left alone the same mutant would have run into Stryker's timeout, also detected.
'use strict';
const { spawn } = require('node:child_process');
const limit = Number(process.env.PLY_MUTANT_RSS_KB ?? 3 * 1024 * 1024);
const me = process.pid, parent = process.ppid;
spawn('/bin/sh', ['-c', `
  while kill -0 ${parent} 2>/dev/null && kill -0 ${me} 2>/dev/null; do
    rss=$(ps -o rss= -p ${me} 2>/dev/null | tr -d ' ')
    if [ -n "$rss" ] && [ "$rss" -gt ${limit} ]; then echo "stryker-parent-guard: test process ${me} at $rss KB resident, over ${limit}; killed" >&2; break; fi
    sleep 0.2
  done
  kill -9 ${me} 2>/dev/null`], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] }).unref();
