// The pinned fuzz stage of `npm test` (`npm run test:fuzz-pinned`): a fixed list of fuzzer runs, each with its seed
// or its case written here, so the gate runs the same cases every time and a red run is a regression, not a new draw.
//   node test/fuzz/pinned.mjs                 run the list; stop at the first failure and print its replay command
//   node test/fuzz/pinned.mjs --list          print the commands, run nothing
//   node test/fuzz/pinned.mjs --only codec    only the entries of that fuzzer
//   node test/fuzz/pinned.mjs --random        discovery (`npm run test:fuzz-random`): one fresh seed for every
//                                             seeded entry, printed first together with the command that replays it
//   node test/fuzz/pinned.mjs --seed 123      replay a --random run
// Seeds are never taken from the clock here. An entry with `fixed` is a regression case and keeps its seed/case in
// every mode. test/fuzz-pinned.test.js holds this list to "every command names --seed or --case".
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const NODE_ARGS = ['--import', './test/ts-resolve.mjs'];

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

// Runs the entries in order and stops at the first that exits non-zero. `spawn(argv)` returns the exit status.
export function runPinned(entries, { override = null, spawn, log }) {
  for (const entry of entries) {
    const argv = argvOf(entry, override);
    const status = spawn(argv);
    if (status !== 0) {
      log(`FUZZ-PINNED FAIL  ${entry.fuzzer}  ${label(argv)}  exit=${status}`);
      log(`replay: node ${argv.join(' ')}`);
      return 1;
    }
  }
  return 0;
}

function main(av) {
  const value = flag => { const i = av.indexOf(flag); return i < 0 ? null : av[i + 1]; };
  const only = value('--only'), given = value('--seed'), random = av.includes('--random');
  if (given !== null && !/^\d+$/.test(given)) { console.error(`--seed takes a non-negative integer, got ${given}`); return 2; }
  const override = given !== null ? Number(given) : random ? randomInt(1, 1_000_000_000) : null;
  if (given !== null) console.log(`fuzz-pinned: replaying seed=${override}`);
  else if (random) console.log(`fuzz-pinned: random mode, seed=${override}  replay: node test/fuzz/pinned.mjs --seed ${override}`);
  const entries = PINNED.filter(e => only === null || e.fuzzer === only);
  if (entries.length === 0) { console.error(`--only ${only}: no such fuzzer in the pinned list`); return 2; }
  if (av.includes('--list')) { for (const e of entries) console.log(`node ${argvOf(e, override).join(' ')}`); return 0; }
  const spawn = argv => {
    const r = spawnSync(process.execPath, argv, { stdio: 'inherit' });
    return r.status ?? 1; // killed by a signal: a failure
  };
  return runPinned(entries, { override, spawn, log: l => console.log(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
