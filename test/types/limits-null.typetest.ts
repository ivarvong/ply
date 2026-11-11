// maxResolveWork: null means derived (README Limits), and the public input types say so: the README example compiles
// through parseLimits (LimitsInput) and through withLimits. `tsc --noEmit` must pass; every @ts-expect-error must still
// be an error.
import { DEFAULT_LIMITS, WORKER_LIMITS, parseLimits, withLimits, type Limits, type LimitsInput } from '../../src/limits.js';

const MIB = 1024 * 1024;

// README Limits: `{ ...DEFAULT_LIMITS, maxInflatedTotal: 16 MiB, maxResolveWork: null }` is bounded at 128 MiB
const readme: LimitsInput = { ...DEFAULT_LIMITS, maxInflatedTotal: 16 * MIB, maxResolveWork: null };
const parsed = parseLimits(readme);
void parseLimits({ ...DEFAULT_LIMITS, maxInflatedTotal: 16 * MIB, maxResolveWork: null });
void parseLimits({ maxResolveWork: null });
const made: Limits = withLimits({ ...DEFAULT_LIMITS, maxInflatedTotal: 16 * MIB, maxResolveWork: null });
void withLimits({ ...WORKER_LIMITS, maxInflatedTotal: 1024 * MIB, maxResolveWork: null });

// what comes back holds a number there, never null
const work: number = made.maxResolveWork;
void work;
if (parsed.ok) { const checked: number = parsed.value.maxResolveWork; void checked; }

// null is the derived value on this key only: any other key given as null is bad_request, and a type error
// @ts-expect-error maxObjectSize: null is not a limit
const other: LimitsInput = { maxObjectSize: null };
void other;
// @ts-expect-error maxInflatedTotal: null is not a limit
void withLimits({ maxInflatedTotal: null });
