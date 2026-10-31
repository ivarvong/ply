// The ref-name space (refname.space.js, #73): every cell's name asked of real git three ways — check-ref-format, and a
// real receive-pack's answer to a create and to a delete of it — and ply must agree on every cell: validateRef with
// check-ref-format, validatePushRef with receive-pack ("funny refname" or not), and push() refuses before sending
// exactly the names receive-pack calls funny.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cells, COMPONENTS, DEPTHS } from './refname.space.js';
import { validateRef, validatePushRef } from '../../src/validate.js';
import { pkt, FLUSH } from '../../src/pktline.js';
import { concat, te } from '../../src/bytes.js';
import { runPush } from './harness.js';
import { createHash } from 'node:crypto';

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
const ZERO = '0'.repeat(40);
const accepts = f => { try { f(); return true; } catch (e) { if (e.code !== 'bad_request') throw e; return false; } };

// git check-ref-format <name>, for every name, a few at a time
async function checkRefFormat(names) {
  const out = Array.from({ length: names.length });
  let next = 0;
  const one = i => new Promise((res, rej) => {
    const p = spawn('git', ['check-ref-format', names[i]], { env: ENV, stdio: 'ignore' });
    p.on('error', rej); p.on('close', code => { out[i] = code === 0; res(); });
  });
  await Promise.all(Array.from({ length: 16 }, async () => { while (next < names.length) await one(next++); }));
  return out;
}

// One real `git receive-pack --stateless-rpc` answering one command per name, as a client sends them: true where git
// answered "ng <name> funny refname". Every other answer (ok, a D/F conflict between two cells' names) is not funny.
function receivePackFunny(dir, names, { oldOid, newOid }) {
  const lines = names.map((n, i) => pkt(concat([te.encode(`${oldOid} ${newOid} `), te.encode(n), te.encode(i === 0 ? '\0report-status delete-refs\n' : '\n')])));
  const head = new Uint8Array(12); head.set(te.encode('PACK')); head[7] = 2; // version 2, 0 objects
  const pack = newOid === ZERO ? [] : [head, createHash('sha1').update(head).digest()];
  const r = spawnSync('git', ['receive-pack', '--stateless-rpc', dir], { env: ENV, input: concat([...lines, FLUSH, ...pack]), maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, `receive-pack: ${r.stderr}`);
  // the report: pkt lines "unpack ok", then one "ok <ref>" / "ng <ref> <reason>" per command, in command order
  const buf = r.stdout, report = [];
  for (let i = 0; i < buf.length;) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (len === 0) { i += 4; continue; }
    report.push(buf.subarray(i + 4, i + len)); i += len;
  }
  assert.equal(report[0].toString(), 'unpack ok\n');
  assert.equal(report.length, names.length + 1, 'one status per command');
  return names.map((n, i) => {
    const line = report[i + 1], ref = Buffer.from(te.encode(n));
    const status = line.subarray(0, 3).toString();
    assert.ok((status === 'ok ' || status === 'ng ') && line.subarray(3, 3 + ref.length).equals(ref), `status ${i} is for ${JSON.stringify(n)}: ${JSON.stringify(line.toString())}`);
    return status === 'ng ' && line.subarray(3 + ref.length).toString() === ' funny refname\n';
  });
}

test('ref names: ply agrees with git check-ref-format and receive-pack on every cell', { timeout: 300_000 }, async () => {
  const all = cells(), names = all.map(c => c.name);
  assert.equal(new Set(names).size, names.length, 'cells are distinct names');
  const root = mkdtempSync(join(tmpdir(), 'ply-refname-'));
  try {
    const dir = join(root, 'srv.git');
    spawnSync('git', ['init', '-q', '--bare', dir], { env: ENV });
    const tree = spawnSync('git', ['mktree'], { cwd: dir, env: ENV, input: '' }).stdout.toString().trim();
    const C = spawnSync('git', ['commit-tree', tree, '-m', 'c'], { cwd: dir, env: ENV }).stdout.toString().trim();
    assert.match(C, /^[0-9a-f]{40}$/);
    const t0 = performance.now();
    const format = await checkRefFormat(names);
    const t1 = performance.now();
    const createFunny = receivePackFunny(dir, names, { oldOid: ZERO, newOid: C });
    const deleteFunny = receivePackFunny(dir, names, { oldOid: C, newOid: ZERO });
    const ms = performance.now() - t0;
    const wrong = [], mainWrong = [], tally = { format: 0, create: 0, delete: 0 };
    for (let i = 0; i < all.length; i++) {
      const n = names[i], id = `${all[i].id} ${JSON.stringify(n)}`;
      const git = { format: format[i], create: !createFunny[i], delete: !deleteFunny[i] };
      const ply = { format: accepts(() => validateRef(n)), create: accepts(() => validatePushRef(n, false)), delete: accepts(() => validatePushRef(n, true)) };
      for (const k of Object.keys(git)) {
        if (git[k]) tally[k]++;
        if (git[k] !== ply[k]) wrong.push(`${id} ${k}: git ${git[k] ? 'accepts' : 'refuses'}, ply ${ply[k] ? 'accepts' : 'refuses'}`);
      }
      // what main (validateRef alone before every push) did with the same cell
      for (const k of ['create', 'delete']) if (ply.format !== git[k]) mainWrong.push(`${id} ${k}`);
    }
    console.log(`  refname: ${all.length} cells (${COMPONENTS.length} components at depths ${DEPTHS.join('/')} + a U+0001–U+00FF sweep) × 3 questions, git ${spawnSync('git', ['--version']).stdout.toString().trim()} in ${(ms / 1000).toFixed(1)} s (check-ref-format ${((t1 - t0) / 1000).toFixed(1)} s); git accepts: format ${tally.format}, create ${tally.create}, delete ${tally.delete}; ply disagrees ${wrong.length}; validateRef-before-push (main) disagreed ${mainWrong.length}`);
    for (const w of wrong.slice(0, 20)) console.log(`    ${w}`);
    for (const w of mainWrong) console.log(`    main: ${w}`);
    assert.deepEqual(wrong, []);
    // push() refuses exactly git's funny names before sending a byte, and lets the rest through to the server
    const sample = all.filter((_, i) => i % 7 === 0 || createFunny[i] !== !format[i] || deleteFunny[i] !== !format[i]);
    for (const c of sample) {
      const i = all.indexOf(c);
      for (const [del, funny] of [[false, createFunny[i]], [true, deleteFunny[i]]]) {
        const got = await runPush({ commands: [{ ref: c.name, oldOid: del ? C : ZERO, newOid: del ? ZERO : C }], opts: { sideband: false }, limits: { maxRefs: 8, maxReportLines: 16, maxPackBytes: 1 << 20 } }, { drop: 'never' });
        const refusedBeforeSend = got.tag === 'preSend' && got.code === 'bad_request';
        assert.equal(refusedBeforeSend, funny, `${c.id} ${JSON.stringify(c.name)} ${del ? 'delete' : 'create'}: push() ${JSON.stringify(got)}, receive-pack ${funny ? 'funny' : 'not funny'}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
