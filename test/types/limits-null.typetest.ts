// No Limits key takes null (#271): maxResolveWork is derived only when the key is left out, and a spread preset asks
// for the derived value with withDerivedWork (README Limits). `tsc --noEmit` must pass; every @ts-expect-error must
// still be an error.
import { DEFAULT_LIMITS, WORKER_LIMITS, parseLimits, withDerivedWork, withLimits, type Limits, type LimitsInput } from '../../src/limits.js';

const MIB = 1024 * 1024;

// README Limits: `withDerivedWork({ ...DEFAULT_LIMITS, maxInflatedTotal: 16 MiB })` is bounded at 128 MiB
const derived = withDerivedWork({ ...DEFAULT_LIMITS, maxInflatedTotal: 16 * MIB });
const readme: LimitsInput = derived;
const parsed = parseLimits(readme);
void parseLimits({ maxInflatedTotal: 16 * MIB });
const made: Limits = withLimits(withDerivedWork({ ...WORKER_LIMITS, maxInflatedTotal: 1024 * MIB }));

// what comes back holds a number there, never null
const work: number = made.maxResolveWork;
void work;
if (parsed.ok) { const checked: number = parsed.value.maxResolveWork; void checked; }

// null is not a limit, on any key
// @ts-expect-error maxResolveWork: null is not a limit (#271)
void parseLimits({ maxResolveWork: null });
// @ts-expect-error maxResolveWork: null is not a limit (#271)
void withLimits({ ...DEFAULT_LIMITS, maxResolveWork: null });
// @ts-expect-error maxObjectSize: null is not a limit
const other: LimitsInput = { maxObjectSize: null };
void other;
// @ts-expect-error maxInflatedTotal: null is not a limit
void withLimits({ maxInflatedTotal: null });
// withDerivedWork's record has no maxResolveWork to read
// @ts-expect-error the key is taken out
void derived.maxResolveWork;
