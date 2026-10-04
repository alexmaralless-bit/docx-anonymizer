import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.js',
  timeout: 60000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-output/playwright',
});
