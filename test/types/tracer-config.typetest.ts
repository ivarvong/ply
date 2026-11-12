// TracerConfig.onTelemetryError is optional: a consumer's whole TracerConfig written before the hook existed still
// type-checks. The hook's types are named from the package entry.
import type { TelemetryErrorSink, TelemetryHook } from '../../src/index.js';
import type { TracerConfig } from '../../src/otel.js';

// every key TracerConfig had on main ec337c5, and no onTelemetryError
const before: TracerConfig = { exporter: () => { /* dropped */ }, onEnd: null, resource: {}, scope: { name: 'app', version: '1' }, maxEvents: 8 };
const sink: TelemetryErrorSink = (error, at) => { const hook: TelemetryHook = at.hook; const span: string = at.span; void [error, hook, span]; };
const withHook: TracerConfig = { ...before, onTelemetryError: sink };
const withNone: TracerConfig = { ...before, onTelemetryError: null };
void [withHook, withNone];

const internal: TelemetryHook = 'internal';
// @ts-expect-error not a hook ply reports
const unknownHook: TelemetryHook = 'transport';
void [internal, unknownHook];
