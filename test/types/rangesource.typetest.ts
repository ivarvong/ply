// RangeSource.read's signal is optional in the type: an implementer may ignore it (a read of two parameters) and a
// direct caller may omit it. tsc is the judge; the expected behaviour is TypeScript's own assignability and call rules.
import { rangeFromBytes, type RangeSource } from '../../src/index.js';

const bytes = rangeFromBytes(new Uint8Array(4));

// a direct caller omits the signal, or passes one
const omitted = bytes.read(0, 4);
const passed = bytes.read(0, 4, new AbortController().signal);
void omitted; void passed;

// an implementer that ignores the signal is a RangeSource
// oxlint-disable-next-line typescript/promise-function-async -- the wrapped read's promise, returned as is
const two: RangeSource = { size: 4, read: (offset: number, length: number) => bytes.read(offset, length) };
void two;

// an implementer that requires the signal is not: a direct caller may omit it, so it has to work without one
// oxlint-disable-next-line typescript/promise-function-async -- as above
const needsSignal = (offset: number, length: number, signal: AbortSignal): ReturnType<RangeSource['read']> => { signal.throwIfAborted(); return bytes.read(offset, length); };
// @ts-expect-error a read that cannot be called without its signal
const three: RangeSource = { size: 4, read: needsSignal };
void three;
