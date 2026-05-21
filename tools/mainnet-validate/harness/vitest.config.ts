import { defineConfig } from 'vitest/config';

// Harness is Node-only tooling (spawns the Rust shim, hits the filesystem,
// reads package.json files via `import.meta.url`). The `node` environment
// is the only one that makes sense here — no jsdom even at test time.
//
// Layout matches the `@ergots/*` packages' convention: `test/**/*.test.ts`.
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        pool: 'forks',
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
});
