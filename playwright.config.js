import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.js',
  timeout: 60000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-output/playwright',
  // в CI трасса упавшего теста (действия, сеть страниц, консоль) попадает в артефакт e2e-test-output — для разбора зависаний
  use: { trace: process.env.CI ? 'retain-on-failure' : 'off' },
});
