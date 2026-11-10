// `npm run coverage` only (vitest.config.ts adds this file when NODE_V8_COVERAGE is set): vitest ends its forks
// without the normal exit that makes node write NODE_V8_COVERAGE, so each file's fork writes its counts here.
import { afterAll } from 'vitest';
import { takeCoverage } from 'node:v8';

afterAll(() => { takeCoverage(); });
