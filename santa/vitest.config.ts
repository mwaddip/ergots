import { configDefaults, defineConfig } from 'vitest/config'

// The harness specs under test/harness/ are SANTA's, kept byte-identical. Two of them read a SANTA checkout and take
// it from SANTA_DIR; they run when it is set. Every other spec there runs always.
const needSanta = process.env.SANTA_DIR ? [] : ['test/harness/oracle.spec.ts', 'test/harness/run.spec.ts']

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/harness/**/*.spec.ts'],
    exclude: [...configDefaults.exclude, ...needSanta],
  },
})
