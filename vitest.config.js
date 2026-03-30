import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 10000,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
  },
});
