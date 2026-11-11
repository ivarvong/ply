// The repository's own gates, held to what GitHub documents, not to what the workflow files happen to say.
//
// Expected values come from the GitHub Actions documentation:
//  - `on.workflow_run` fires for the named workflow's runs; `github.event.workflow_run.conclusion`, `.event`,
//    `.head_branch`, `.head_sha` and `.head_repository.full_name` describe the run that finished. In a
//    workflow_run-triggered workflow `github.sha` is the tip of the default branch, NOT the commit the finished
//    run tested, so the tested commit must be read from `workflow_run.head_sha`.
//  - `head_branch` is the branch name in the head repository: a pull request from a fork's `main` also has
//    head_branch `main`, so `event == 'push'` and the head repository must be checked as well.
// No YAML parser (no dependencies): the assertions are on the exact lines a reviewer would read.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Every test/**/*.test.js on disk: the directory itself, not the planner's view of it.
const testFiles = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : testFiles(`${dir}/${e.name}`);
  return e.name.endsWith('.test.js') ? [`${dir}/${e.name}`] : [];
});
// Comments are not configuration: a `# on: push` must not satisfy or fail a check.
const code = (text) => text.split('\n').filter((l) => !/^\s*#/u.test(l)).join('\n');

test('notify-ply-web dispatches only after ci succeeded for that exact commit on main', () => {
  const y = code(read('.github/workflows/notify-ply-web.yml'));
  // The trigger: ci's completion, never the push itself (a push is not yet judged by anything).
  assert.doesNotMatch(y, /^ {2}push:/mu, 'must not trigger on push: the commit is not yet judged');
  assert.match(y, /^on:\n {2}workflow_run:\n {4}workflows: \[ci\]\n {4}types: \[completed\]\n/mu);
  assert.equal(read('.github/workflows/ci.yml').split('\n')[0], 'name: ci', 'workflow_run matches ci by this name');
  // The job condition: a successful run, of a push (not a pull request), to main, of this repository.
  const cond = /^ {4}if: >-\n((?: {6}.*\n)+)/mu.exec(y)?.[1].replace(/\s+/gu, ' ').trim();
  assert.equal(
    cond,
    "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && "
      + "github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository",
  );
  // The sha: the commit ci judged. github.sha here would be whatever main's tip is when the run finishes.
  assert.match(y, /^ {10}COMMIT_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}$/mu);
  assert.doesNotMatch(y, /github\.sha/u);
});

test('notify-ply-web sends the judged sha, once, from its one conditional job', () => {
  const raw = read('.github/workflows/notify-ply-web.yml');
  const y = code(raw);
  // GitHub sets $GITHUB_SHA from the same context as github.sha: in a workflow_run run it is the default branch's
  // tip, not the commit ci judged. Not even a comment may spell it: ply-web's README documented this file with it.
  assert.doesNotMatch(raw, /GITHUB_SHA/u, 'GITHUB_SHA is the default branch tip in a workflow_run run');
  // One job (the conditional one above) with one step: a second job or step would dispatch outside the condition.
  const jobs = [...y.slice(y.indexOf('\njobs:\n')).matchAll(/^ {2}([A-Za-z0-9_-]+):/gmu)].map((m) => m[1]);
  assert.deepEqual(jobs, ['dispatch']);
  assert.equal((y.match(/^ {6}- /gmu) ?? []).length, 1, 'exactly one step');
  // One request, to ply-web's repository_dispatch endpoint (REST: POST /repos/{owner}/{repo}/dispatches).
  assert.equal((y.match(/dispatches/gu) ?? []).length, 1, 'exactly one dispatches call');
  assert.equal((y.match(/\bgh api\b/gu) ?? []).length, 1);
  assert.doesNotMatch(y, /\bcurl\b|\bwget\b/u);
  assert.match(y, /gh api --method POST repos\/ivarvong\/ply-web\/dispatches --input - <<EOF\n/u);
  // The body, as the REST API documents it: {event_type, client_payload}. The sha is the shell's COMMIT_SHA (the
  // env line asserted above binds it to workflow_run.head_sha) and nothing else.
  const body = /<<EOF\n\s*(.*)\n\s*EOF$/mu.exec(y)?.[1];
  assert.deepEqual(JSON.parse(body ?? ''), { event_type: 'ply-main-updated', client_payload: { sha: '${COMMIT_SHA}' } });
  // Nothing in the script can compute another sha: no command substitution, and the only shell variables read are
  // the two the step's env declares. (`${{ ... }}` is a GitHub expression, removed before looking for shell ones.)
  const shell = y.replace(/\$\{\{.*?\}\}/gu, '');
  assert.doesNotMatch(shell, /\$\(|`/u, 'no command substitution');
  const vars = new Set([...shell.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/gu)].map((m) => m[1]));
  assert.deepEqual([...vars].sort(), ['COMMIT_SHA', 'PLY_WEB_DISPATCH_TOKEN']);
});

test('npm run check is the pre-push gate: typecheck, lint, the registry test, the dist check', () => {
  const { scripts } = JSON.parse(read('package.json'));
  assert.equal(typeof scripts.check, 'string', 'package.json has no check script');
  const steps = scripts.check.split(' && ');
  assert.deepEqual(steps.slice(0, 4), ['npm run typecheck', 'npm run lint', 'vitest run test/space/registry.test.js', 'npm run build']);
  // The dist check is the one CI runs, word for word, so the two cannot drift.
  const ciDist = /^ {8}run: npm run build && (node -e .*)$/mu.exec(read('.github/workflows/ci.yml'))?.[1];
  assert.equal(steps[4], ciDist);
  assert.equal(steps.length, 5);
  // Documented where a contributor looks for it.
  assert.match(read('CONTEXT.md'), /^npm run check\b/mu);
});

test('nightly: every job checks out the one sha the seed job resolved, never a moving main', () => {
  const y = code(read('.github/workflows/nightly.yml'));
  // Counted by hand in nightly.yml: fuzz, test-shard, test, pack-cut-full and sweep check the repository out.
  const checkouts = y.match(/^ {6}- uses: actions\/checkout@/gmu) ?? [];
  assert.equal(checkouts.length, 5);
  const refs = [...y.matchAll(/^ {10}ref: (.*)$/gmu)].map((m) => m[1]);
  assert.deepEqual(refs, Array.from({ length: 5 }, () => '${{ needs.seed.outputs.sha }}'));
  // `needs.seed.outputs.sha` is empty in a job that does not need seed, and an empty ref checks out the default.
  const jobs = y.slice(y.indexOf('\njobs:\n')).split(/^ {2}(?=[a-z-]+:$)/mu).slice(1);
  for (const job of jobs) {
    if (!job.includes('actions/checkout@')) continue;
    assert.match(job, /^ {4}needs: (?:seed|\[seed(?:, [a-z-]+)*\])$/mu, `job ${job.split(':')[0]} checks out but does not need seed`);
  }
  // The sha is resolved once, validated as a commit id, and published as the seed job's output.
  assert.match(y, /^ {6}sha: \$\{\{ steps\.seed\.outputs\.sha \}\}$/mu);
  assert.match(y, /git ls-remote "https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git" refs\/heads\/main/u);
  assert.match(y, /\[\[ "\$sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u);
});

test('every test file has a weight in test/durations.json, so the shard planner never guesses', () => {
  // vitest.config.ts weighs a file with no entry as the heaviest known file (494 s on 2026-11-11). Two sub-second
  // files without entries moved ci's replayed plan from 1052/1051/1051/1051 summed seconds per shard to
  // 806/1298/805/1298. The convention (vitest.config.ts): a new file gets its local seconds, rounded up.
  const known = JSON.parse(read('test/durations.json'));
  assert.deepEqual(testFiles('test').filter((f) => !(f in known)), [], 'add each file with its local seconds, rounded up');
  for (const [file, seconds] of Object.entries(known)) assert.ok(Number.isInteger(seconds) && seconds >= 0, `${file}: ${seconds}`);
});
