// Nightly deep fuzz, one fuzzer per call:  node scripts/nightly-fuzz.mjs <seed> <fuzzer.mjs> [args...]
// Runs test/fuzz/<fuzzer.mjs> --seed <seed> [args...], streams its output, and on failure prints the seed, the failing
// cases and one `reproduce:` command per case (the lines the nightly issue quotes), plus a step summary on Actions.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [seedArg, fuzzer, ...rest] = process.argv.slice(2);
if (!/^\d+$/.test(seedArg ?? '') || !/^[a-z-]+\.mjs$/.test(fuzzer ?? '')) {
  console.error('usage: node scripts/nightly-fuzz.mjs <seed> <fuzzer.mjs> [args...]');
  process.exit(2);
}
const seed = seedArg;
const argv = [`test/fuzz/${fuzzer}`, '--seed', seed, ...rest];
const base = `node ${argv.join(' ')}`;
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const n = (() => { const i = rest.indexOf('--n'); return i < 0 ? null : rest[i + 1]; })();
const flags = rest.filter((a, i) => a !== '--n' && rest[i - 1] !== '--n');
const withN = k => `node test/fuzz/${fuzzer} --seed ${seed} --n ${k} ${flags.join(' ')}`.trim();

// one reproduce command per failing case, from the line the fuzzer prints for it
const RULES = [
  [/repro: (node test\/fuzz\/\S+ --case \d+)/, m => m[1]], // run, hostile, liar, protocol: the case seed alone
  [/^FAIL #\s*(\d+)/, m => withN(+m[1] + 1)], // packs, packgen, codec: one stream from --seed, case i is the (i+1)th
  // below-hash, git-semantic: a random case `kind#<seed>` is picked by its seed, a fixed case by its name
  [/^(?:FAIL|DIVERGE)\s+(\S+?):?\s/, m => `${withN(n ?? 20)} --case ${/#(\d+)$/.test(m[1]) ? m[1].match(/#(\d+)$/)[1] : q(m[1])}`],
  [/^WRONG case (\d+)/, m => `${withN(n ?? 2000)} --case ${m[1]}`], // linemerge
  [/^case (\d+) \(seed/, m => `${withN(n ?? 200)} --case ${m[1]}`], // attributes
  [/^case (\d+): n=/, m => withN(+m[1] + 1)], // diffscript: no --case; the (c+1)th diff of this seed
];

const out = [];
// src/ keeps .js specifiers for .ts files; the hook resolves them under plain node (test/ts-resolve.mjs).
const hook = fileURLToPath(new URL('../test/ts-resolve.mjs', import.meta.url));
const child = spawn(process.execPath, ['--import', hook, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
let buf = '';
const onData = (stream, d) => { stream.write(d); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1); } };
child.stdout.on('data', d => onData(process.stdout, d));
child.stderr.on('data', d => onData(process.stderr, d));
const code = await new Promise(r => child.on('close', (c, sig) => r(c ?? (sig ? 128 : 1))));
if (buf) out.push(buf);
if (code === 0) process.exit(0);

const repro = [];
for (const line of out) {
  for (const [re, f] of RULES) { const m = line.trim().match(re); if (m) { repro.push(f(m)); break; } }
}
const uniq = [...new Set(repro)];
if (!uniq.length) uniq.push(base); // a crash, or no per-case line: the whole run is deterministic from the seed
const lines = [`NIGHTLY-FAIL ${fuzzer} seed=${seed} exit=${code} command: ${base}`, ...uniq.slice(0, 10).map(c => `NIGHTLY-FAIL ${fuzzer} seed=${seed} reproduce: ${c}`)];
if (uniq.length > 10) lines.push(`NIGHTLY-FAIL ${fuzzer} seed=${seed} ... ${uniq.length - 10} more failing cases`);
console.log('\n' + lines.join('\n'));
for (const l of lines) console.log(`::error title=${fuzzer} seed ${seed}::${l}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${fuzzer} failed (seed ${seed})\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
process.exit(code);
