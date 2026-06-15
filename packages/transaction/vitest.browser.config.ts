import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
    pool: 'forks',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
});
