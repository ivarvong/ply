// The pinned fuzz stage of `npm test` (`npm run test:fuzz-pinned`): a fixed list of fuzzer runs, each with its seed
// or its case written here, so the gate runs the same cases every time and a red run is a regression, not a new draw.
//   node test/fuzz/pinned.mjs                 run the list; stop at the first failure and print its replay command
//   node test/fuzz/pinned.mjs --list          print the commands, run nothing
//   node test/fuzz/pinned.mjs --only codec    only the entries of that fuzzer
//   node test/fuzz/pinned.mjs --random        discovery (`npm run test:fuzz-random`): one fresh seed for every
//                                             seeded entry, printed first together with the command that replays it
//   node test/fuzz/pinned.mjs --seed 123      replay a --random run
//   node test/fuzz/pinned.mjs --timeout-s 60  per-entry timeout (default 900 s): a fuzzer that has not exited by
//                                             then is killed and reported as a failure with its seed
// Every entry prints its fuzzer and seed before it starts. An unknown argument is refused (exit 2), never ignored.
// Seeds are never taken from the clock here. An entry with `fixed` is a regression case and keeps its seed/case in
// every mode. test/fuzz-pinned.test.js holds this list to "every command names --seed or --case".
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NODE_ARGS = ['--import', './test/ts-resolve.mjs'];
// Per entry. The slowest entry, codec --n 20000, took 148 s at load 30-45 on 16 cores (review of b706d77), so 15
// minutes is a hang and not a slow run. `--timeout-s` changes it for a manual run; the gate script takes no flags.
export const ENTRY_TIMEOUT_MS = 15 * 60_000;

export const PINNED = [
  { fuzzer: 'run', args: ['--n', '60'], seed: 1 },
  { fuzzer: 'hostile', args: ['--n', '60'], seed: 1 },
  { fuzzer: 'hostile', args: ['--case', '2366521731'], fixed: true },
  { fuzzer: 'below-hash', args: ['--n', '20'], seed: 1 },
  { fuzzer: 'below-hash', args: ['--seed', '20261030', '--n', '100', '--case', '1730047880'], fixed: true },
  { fuzzer: 'git-semantic', args: ['--n', '20'], seed: 1 },
  { fuzzer: 'liar', args: ['--n', '60'], seed: 1 },
  { fuzzer: 'liar', args: ['--op', 'mergebase', '--n', '40'], seed: 1 },
  { fuzzer: 'protocol', args: ['--n', '100'], seed: 1 },
  { fuzzer: 'packs', args: ['--n', '40'], seed: 1 },
  { fuzzer: 'packgen', args: ['--n', '60'], seed: 1 },
  { fuzzer: 'codec', args: ['--n', '20000'], seed: 1 },
  { fuzzer: 'usergiven', args: [], seed: 500 },
  { fuzzer: 'attributes', args: ['--n', '40'], seed: 1 },
  { fuzzer: 'linemerge', args: ['--n', '300'], seed: 1 },
  { fuzzer: 'linemerge', args: ['--n', '200', '--runs'], seed: 1 },
  { fuzzer: 'linemerge', args: ['--n', '150', '--driver', 'union'], seed: 1 },
  { fuzzer: 'diffscript', args: ['--n', '60'], seed: 1 },
  { fuzzer: 'diffscript', args: ['--n', '4', '--huge'], seed: 1 },
];

// The node argv of one entry. `override` replaces the seed of every entry that is not a fixed regression case.
export function argvOf(entry, override = null) {
  const seed = entry.fixed ? [] : ['--seed', String(override ?? entry.seed)];
  return [...NODE_ARGS, `test/fuzz/${entry.fuzzer}.mjs`, ...entry.args, ...seed];
}

function label(argv) {
  const at = flag => { const i = argv.indexOf(flag); return i < 0 ? [] : [`${flag.slice(2)}=${argv[i + 1]}`]; };
  return [...at('--seed'), ...at('--case')].join(' ');
}

// One entry as a child process. A child that has not exited after `timeoutMs` is killed (SIGKILL, so a child stuck
// in a system call dies too) and reported as hung: the stage fails instead of waiting forever.
export function spawnEntry(argv, timeoutMs) {
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT') return { status: 1, hung: true };
  return { status: r.status ?? 1, hung: false }; // killed by a signal, or not started: a failure
}

// Runs the entries in order and stops at the first that fails. Each entry's fuzzer and seed are printed before it
// starts, and again with the replay command when it fails. `spawn(argv)` returns the exit status, or
// `{ status, hung }` as spawnEntry does.
export function runPinned(entries, { override = null, spawn, log, timeoutMs = ENTRY_TIMEOUT_MS }) {
  for (const entry of entries) {
    const argv = argvOf(entry, override);
    log(`fuzz-pinned: start  ${entry.fuzzer}  ${label(argv)}  (node ${argv.join(' ')})`);
    const r = spawn(argv), res = typeof r === 'number' ? { status: r, hung: false } : r;
    if (res.hung || res.status !== 0) {
      const how = res.hung ? `hang: no exit within ${timeoutMs / 1000} s, killed` : `exit=${res.status}`;
      log(`FUZZ-PINNED FAIL  ${entry.fuzzer}  ${label(argv)}  ${how}`);
      log(`replay: node ${argv.join(' ')}`);
      return 1;
    }
  }
  return 0;
}

const FLAGS = new Map([['--list', 0], ['--random', 0], ['--only', 1], ['--seed', 1], ['--timeout-s', 1]]);
function usage(msg) {
  console.error(`${msg}\nusage: node test/fuzz/pinned.mjs [--list] [--only <fuzzer>] [--random | --seed <n>] [--timeout-s <n>]`);
  return 2;
}

function main(av) {
  // Every argument is a known flag or a known flag's value; anything else is refused, never ignored.
  const opt = new Map();
  for (let i = 0; i < av.length; i++) {
    const takes = FLAGS.get(av[i]);
    if (takes === undefined) return usage(`unknown argument ${av[i]}`);
    if (takes === 1 && i + 1 >= av.length) return usage(`${av[i]} takes a value`);
    opt.set(av[i], takes === 1 ? av[++i] : true);
  }
  const only = opt.get('--only') ?? null, given = opt.get('--seed') ?? null, random = opt.has('--random');
  const int = v => /^\d+$/.test(v) && Number.isSafeInteger(Number(v));
  if (given !== null && !int(given)) return usage(`--seed takes a non-negative integer below 2^53, got ${given}`);
  if (given !== null && random) return usage('--seed and --random exclude each other');
  const secs = opt.get('--timeout-s') ?? null;
  if (secs !== null && !(int(secs) && Number(secs) > 0)) return usage(`--timeout-s takes a positive integer, got ${secs}`);
  const timeoutMs = secs !== null ? Number(secs) * 1000 : ENTRY_TIMEOUT_MS;
  const entries = PINNED.filter(e => only === null || e.fuzzer === only);
  if (entries.length === 0) return usage(`--only ${only}: no such fuzzer in the pinned list`);
  const override = given !== null ? Number(given) : random ? randomInt(1, 1_000_000_000) : null;
  if (given !== null) console.log(`fuzz-pinned: replaying seed=${override}`);
  else if (random) console.log(`fuzz-pinned: random mode, seed=${override}  replay: node test/fuzz/pinned.mjs --seed ${override}`);
  if (opt.has('--list')) { for (const e of entries) console.log(`node ${argvOf(e, override).join(' ')}`); return 0; }
  const status = runPinned(entries, { override, timeoutMs, spawn: argv => spawnEntry(argv, timeoutMs), log: l => console.log(l) });
  if (status !== 0 && random) console.log(`fuzz-pinned: random mode failed, seed=${override}  replay: node test/fuzz/pinned.mjs --seed ${override}`);
  return status;
}

// Entry point when run as a script, also through a symlinked path: node resolves the main module to its real path,
// so argv[1] and import.meta.url are compared as real paths (compared as strings, a symlinked path ran nothing and
// exited 0).
const real = p => { try { return realpathSync(p); } catch { return null; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
