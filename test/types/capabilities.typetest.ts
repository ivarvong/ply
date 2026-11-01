// Capabilities is a total record: tracer, fetch, clock and storage are all required.
import { readCommit } from '../../src/read.js';
import { createTransport } from '../../src/http.js';
import { editFile } from '../../src/edit.js';
import {
  defaultCapabilities, freshStorage, noopTracer, platformFetch, systemClock,
  type Capabilities, type Clock,
} from '../../src/capabilities.js';

const url = 'http://example.test/r.git';
readCommit(url, {});
createTransport(url);

const caps: Capabilities = defaultCapabilities();
const custom: Capabilities = { tracer: noopTracer, fetch: platformFetch, clock: systemClock, storage: freshStorage() };
const clock: Clock = { now: () => 0, cpu: () => null };
const withClock = { capabilities: { ...defaultCapabilities(), clock } };
void readCommit(url, {}, withClock);
void caps;
void custom;
void editFile;

// @ts-expect-error every capability is required
const missing: Capabilities = { tracer: noopTracer, fetch: platformFetch, clock: systemClock };
void missing;
