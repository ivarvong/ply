// Every test starts with no remembered quirks (#136): src/transport.ts keeps one record per remote URL for transports
// made without a `quirks` object, and many tests fake different servers at the same URL. A test that wants the memo
// across operations gets it within the test.
import { beforeEach } from 'vitest';
import { forgetQuirks } from '../src/transport.js';

beforeEach(() => { forgetQuirks(); });
