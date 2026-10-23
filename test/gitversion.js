// The oracle's own version decides which of git's two compaction behaviors our line merge must reproduce:
// git ≥ 2.54 re-diffs a shifted group with Myers (yc/histogram-hunk-shift-fix), older git does not.
import { spawnSync } from 'node:child_process';
export const gitVersion = (bin = process.env.GIT_BIN ?? 'git') => {
  const m = /git version (\d+)\.(\d+)/.exec(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout);
  return m ? [+m[1], +m[2]] : [0, 0];
};
export const oracleRediff = (bin) => { const [maj, min] = gitVersion(bin); return maj > 2 || (maj === 2 && min >= 54) ? 'myers' : 'skip'; };
