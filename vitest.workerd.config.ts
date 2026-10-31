// test/workerd.test.js alone (`npm run test:workerd`): the pipeline inside workerd. Outside the default suite and CI.
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default mergeConfig(base, defineConfig({ test: { include: ['test/workerd.test.js'], exclude: ['**/node_modules/**'] } }));
