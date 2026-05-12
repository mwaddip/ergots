import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/envelope.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
});
