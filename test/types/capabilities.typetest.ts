// An omitted capability is the typed default. `undefined` is not a value tracer, fetch, clock, or storage can take.
import { readCommit } from '../../src/read.js';
import { createTransport } from '../../src/http.js';
import { editFile } from '../../src/edit.js';

const url = 'http://example.test/r.git';
readCommit(url, {});
createTransport(url);
const author = { name: 'Cap', email: 'cap@x', tz: '+0000' };
void editFile;

// @ts-expect-error tracer is the no-op when omitted; undefined is not a tracer
readCommit(url, {}, { tracer: undefined });
// @ts-expect-error fetch is the platform fetch when omitted; undefined is not a fetch
readCommit(url, {}, { fetch: undefined });
// @ts-expect-error clock is the system clock when omitted; undefined is not a clock
readCommit(url, {}, { clock: undefined });
// @ts-expect-error storage is a fresh map when omitted; undefined is not a store
readCommit(url, {}, { storage: undefined });
// @ts-expect-error tracer is the no-op when omitted; undefined is not a tracer
createTransport(url, { tracer: undefined });
// @ts-expect-error clock is the system clock when omitted; undefined is not a clock
createTransport(url, { clock: undefined });
// @ts-expect-error storage is a fresh map when omitted; undefined is not a store
createTransport(url, { storage: undefined });
// fetchImpl is the legacy name and may still be explicitly undefined
createTransport(url, { fetchImpl: undefined });
// @ts-expect-error tracer is the no-op when omitted; undefined is not a tracer
void editFile(url, { path: 'a', find: 'x', replace: 'y', author, message: 'm' }, { tracer: undefined });
