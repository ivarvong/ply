// Expected differences between runs, each with its reason. A difference not listed here is a finding; an entry that no
// difference used, in a run that evaluated its scenario and pair, fails that run (an entry may not outlive its cause).
// Entries name exact rendered values (evaluate.ts), so a changed behaviour is a new finding, not a silent match.
import type { Allow } from './types.js';

export const ALLOW: readonly Allow[] = [
  {
    scenario: 'push.size-limits#pack-over-cap', pair: 'art-ply~ref-ply', field: 'error', left: 's0=limit_exceeded', right: 's0=push_rejected',
    reason: 'Both refuse the 66 MiB pack and leave main unchanged (outcome rejected on both). ply reads the server\'s stated cap (`push is <n> MiB, limit is <m> MiB`, src/push.ts parseReceivePackTooLarge) as limit_exceeded; git http-backend\'s receive.maxInputSize refusal is `unpack unpacker error`, its reason only on band 2, which ply reports as push_rejected. Stock git reads band 2 on both and agrees with itself.',
  },
];
