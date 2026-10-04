import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.js', 'tests/integration/**/*.spec.js'],
    environment: 'node',
    testTimeout: 20000,
  },
});
