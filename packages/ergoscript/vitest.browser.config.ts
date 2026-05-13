import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
    pool: 'forks',
    passWithNoTests: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
});
