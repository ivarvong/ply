// Capabilities is a total record: tracer, fetch, clock and storage are all required.
import { readCommit } from '../../src/read.js';
import { createTransport } from '../../src/http.js';
import { editFile } from '../../src/edit.js';
import {
  adoptCapabilities, defaultCapabilities, freshStorage, noopTracer, platformFetch, systemClock,
  type Capabilities, type Clock,
} from '../../src/capabilities.js';

const url = 'http://example.test/r.git';
readCommit(url, {});
createTransport(url);

const caps: Capabilities = defaultCapabilities();
const again: Capabilities = adoptCapabilities({});
const custom: Capabilities = { tracer: noopTracer, fetch: platformFetch, clock: systemClock, storage: freshStorage() };
const clock: Clock = { now: () => 0, cpu: () => null };
const withClock = { tracer: noopTracer, clock, capabilities: custom };
void readCommit(url, {}, withClock);
void caps;
void again;
void editFile;

// @ts-expect-error every capability is required
const missing: Capabilities = { tracer: noopTracer, fetch: platformFetch, clock: systemClock };
void missing;
