import { limitError } from '../../src/limits.js';
import { VIEWER_CAPS } from './limits.ts';

export type Budget = {
  readonly maxBytes: number;
  readonly maxSubrequests: number;
  bytes: number;
  subrequests: number;
  addBytes(n: number): void;
  countSubrequest(): void;
  canSpend(extra?: number): boolean;
};

export function createBudget(maxBytes: number = VIEWER_CAPS.maxUpstreamBytes, maxSubrequests: number = VIEWER_CAPS.maxSubrequests): Budget {
  const budget: Budget = {
    maxBytes,
    maxSubrequests,
    bytes: 0,
    subrequests: 0,
    addBytes(n: number) {
      if (n < 0) throw limitError('upstream bytes', n, maxBytes);
      budget.bytes += n;
      if (budget.bytes > maxBytes) throw limitError('upstream bytes', budget.bytes, maxBytes);
    },
    countSubrequest() {
      budget.subrequests += 1;
      if (budget.subrequests > maxSubrequests) throw limitError('upstream requests', budget.subrequests, maxSubrequests);
    },
    canSpend(extra = 1) {
      return budget.subrequests + extra <= maxSubrequests && budget.bytes <= maxBytes;
    },
  };
  return budget;
}
