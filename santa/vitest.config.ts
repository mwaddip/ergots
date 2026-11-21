import { defineConfig } from 'vitest/config'

// The harness specs under test/harness/ are SANTA's, kept byte-identical. Two of them (oracle, run) read a SANTA
// checkout and take it from SANTA_DIR; without one, the three that need none run.
const harness = process.env.SANTA_DIR
  ? ['test/harness/**/*.spec.ts']
  : ['test/harness/grading.spec.ts', 'test/harness/selection.spec.ts', 'test/harness/bounds.spec.ts']

export default defineConfig({
  test: { include: ['test/**/*.test.ts', ...harness] },
})
