// test/workerd.test.js alone (`npm run test:workerd`): the pipeline inside workerd. Outside the default suite and CI.
// mergeConfig concatenates arrays (base excludes this very file), so include/exclude are set on the merged result.
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

const config = mergeConfig(base, defineConfig({}));
config.test = { ...config.test, include: ['test/workerd.test.js'], exclude: ['**/node_modules/**'] };
export default config;
