// Run a list of commands one after another and measure them from the outside: wall time, and the memory of the whole
// process tree each one starts. One measured client run = one invocation of this file, so the sampling loop never
// shares an event loop with the server or the harness.
//   node bench/compare/measure.mjs <spec.json>      spec: { steps: [{ argv, cwd?, env?, stdout? }], intervalMs?, memory? }
// Prints one JSON line: { ok, elapsedMs, steps: [...], memory: {...} }.
//
// Memory. Every step is spawned detached, which makes it a session leader (setsid); every process it forks inherits
// the session id, and a process cannot join another session, so "session id == the step's pid" names the tree even
// after a parent exits and its children are re-parented. Each sample reads, for every live process of the session:
//   /proc/<pid>/smaps_rollup   Pss and Rss (kB), summed over the tree
//   /proc/<pid>/status         VmHWM, that process's own high-water RSS as the kernel keeps it
// and the result is the peak of each sum over the samples and the largest single VmHWM seen. Sampling is a lower
// bound: memory that rises and falls between two samples, or a process shorter than one interval, is not seen. The
// interval actually achieved is reported. Where /proc/<pid>/smaps_rollup does not exist (not Linux, or a restricted
// /proc) memory is reported as unavailable with the reason, never as a number.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from 'node:fs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const intervalMs = spec.intervalMs ?? 1;
const timeoutMs = spec.timeoutMs ?? 300_000;
const memoryReason = spec.memory === false ? 'disabled (--no-memory)'
  : process.platform !== 'linux' ? `no /proc on ${process.platform}`
    : !existsSync('/proc/self/smaps_rollup') ? '/proc/<pid>/smaps_rollup is not available' : null;

const numeric = /^\d+$/;
const kb = (text, key) => { const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text); return m ? Number(m[1]) * 1024 : 0; };
const read = file => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
// The session id is the 4th field after the command name, which is in parentheses and may itself hold ") ".
const sessionOf = pid => { const s = read(`/proc/${pid}/stat`); return s === null ? null : Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[3]); };

const peak = { pss: 0, rss: 0, hwm: 0, hwmComm: null, samples: 0, pids: new Set(), comms: new Set(), gaps: [] };
function sample(root, foreign, tree) {
  for (const name of readdirSync('/proc')) {
    if (!numeric.test(name)) continue;
    const pid = Number(name);
    if (foreign.has(pid) || tree.has(pid)) continue;
    const sid = sessionOf(pid);
    if (sid === root) tree.add(pid); else if (sid !== null) foreign.add(pid);
  }
  let pss = 0, rss = 0;
  for (const pid of tree) {
    const roll = read(`/proc/${pid}/smaps_rollup`), status = read(`/proc/${pid}/status`);
    if (roll === null || status === null) { tree.delete(pid); continue; }
    pss += kb(roll, 'Pss'); rss += kb(roll, 'Rss');
    const hwm = kb(status, 'VmHWM'), comm = /^Name:\s+(.*)$/m.exec(status)?.[1] ?? '?';
    peak.pids.add(pid); peak.comms.add(comm);
    if (hwm > peak.hwm) { peak.hwm = hwm; peak.hwmComm = comm; }
  }
  peak.samples++;
  if (pss > peak.pss) peak.pss = pss;
  if (rss > peak.rss) peak.rss = rss;
}

function run(step) {
  return new Promise(resolve => {
    const out = step.stdout ? openSync(step.stdout, 'w') : null;
    const foreign = memoryReason === null ? new Set(readdirSync('/proc').filter(n => numeric.test(n)).map(Number)) : null;
    const tree = new Set();
    const t0 = process.hrtime.bigint();
    const child = spawn(step.argv[0], step.argv.slice(1), { cwd: step.cwd, env: step.env ?? process.env, detached: true, stdio: ['ignore', out ?? 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false, last = t0;
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const finish = (status, signal, error) => {
      if (done) return;
      done = true;
      if (out !== null) closeSync(out);
      resolve({ argv0: step.argv.slice(0, 3).join(' '), status, signal, error: error?.message ?? null, ms: Number(process.hrtime.bigint() - t0) / 1e6, stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) });
    };
    // a step that outlives the limit is killed with its whole process group and reported as a failure
    const limit = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } finish(null, 'SIGKILL', new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.on('close', () => clearTimeout(limit));
    child.on('error', e => finish(null, null, e));
    child.on('close', (status, signal) => finish(status, signal, null));
    if (memoryReason !== null || child.pid === undefined) return;
    const tick = () => {
      if (done) return;
      const now = process.hrtime.bigint();
      if (peak.samples) peak.gaps.push(Number(now - last) / 1e6);
      last = now;
      sample(child.pid, foreign, tree);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const steps = [];
const start = process.hrtime.bigint();
for (const step of spec.steps) {
  const r = await run(step);
  steps.push(r);
  if (r.status !== 0) break;
}
const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
const gaps = peak.gaps.sort((a, b) => a - b);
const memory = memoryReason !== null
  ? { available: false, unavailable: memoryReason }
  : {
    available: true, peakPssBytes: peak.pss, peakRssSumBytes: peak.rss, maxProcessHwmBytes: peak.hwm, largestProcess: peak.hwmComm,
    samples: peak.samples, processesSeen: peak.pids.size, commands: [...peak.comms].sort(),
    sampleIntervalMs: gaps.length ? { median: gaps[Math.floor(gaps.length / 2)], max: gaps.at(-1) } : null,
  };
process.stdout.write(`${JSON.stringify({ ok: steps.length === spec.steps.length && steps.every(s => s.status === 0), elapsedMs, steps, memory })}\n`);
