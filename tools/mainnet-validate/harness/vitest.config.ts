import { defineConfig } from 'vitest/config';

// Harness is Node-only tooling (spawns the Rust shim, hits the filesystem,
// reads package.json files via `import.meta.url`). The `node` environment
// is the only one that makes sense here — no jsdom even at test time.
//
// Layout matches the `@ergots/*` packages' convention: `test/**/*.test.ts`.
//
// # Sequential file execution
//
// The T13 integration tests under `test/integration/` spawn the Rust shim
// as a subprocess; each shim instance opens the modifier store redb via
// `Database::create` (read-write, exclusive process lock — see
// `ergo-node-rust/store/src/redb.rs:189-193`). With `fileParallelism:
// true` (vitest's default), two integration files targeting the same
// fixture race on the redb lock and the loser sees the shim crash with
// "could not acquire lock". This is the root cause of an early T13 flake
// (empty stdout, exit 1) — the test wasn't slow or under-timed; its
// subprocess never got past `Database::create`.
//
// Sequential file execution serializes the shim opens against any
// shared fixture. Unit tests (`test/*.test.ts`) cost ~1 ms each, so the
// throughput hit is negligible. Per-test parallelism within a file is
// still enabled (vitest's default) but irrelevant here because each
// integration test uses `await` end-to-end.
//
// Alternative considered + rejected: per-test redb copies. The mainnet
// fixture is 25 GB; copying it per test would take seconds per copy and
// exhaust /tmp. Sequential file execution is the structural fix.
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        pool: 'forks',
        fileParallelism: false,
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
});
