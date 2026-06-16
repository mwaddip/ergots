import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  // OPS-04: see packages/nipopow/tsup.config.ts for rationale.
  sourcemap: false,
  target: 'es2022',
  platform: 'neutral',
});
