import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/runner.ts'],
  format: ['esm'],
  target: 'es2022',
  clean: true,
  splitting: false, // keep each entry self-contained so the runner bin's main-guard isn't hoisted into a shared chunk
  banner: { js: '#!/usr/bin/env node' },
})
