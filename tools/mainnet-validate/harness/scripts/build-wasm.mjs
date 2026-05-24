#!/usr/bin/env node
/**
 * Verifies sigma-rust HEAD matches the pin, then invokes the upstream
 * WASM build script. Run via `npm run build:wasm`.
 *
 * The pin (harness/wasm-build/sigma-rust-commit.txt) is the contract
 * between the harness and the upstream binding surface. If sigma-rust
 * HEAD drifts away from the pin, the cost-oracle binding may no longer
 * exist or its signature may have changed — refusing to build prevents
 * silent breakage.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, '..');
const repoRoot = join(harnessRoot, '..', '..', '..');
const sigmaRustDir = join(repoRoot, 'external', 'sigma-rust');
const bindingsDir = join(sigmaRustDir, 'bindings', 'ergo-lib-wasm');
const commitPin = join(harnessRoot, 'wasm-build', 'sigma-rust-commit.txt');

if (!existsSync(commitPin)) {
    console.error(`ERR: missing commit pin ${commitPin}. Task 1 should have created it.`);
    process.exit(1);
}
const expected = readFileSync(commitPin, 'utf8').trim();
const actual = execSync('git rev-parse HEAD', { cwd: sigmaRustDir }).toString().trim();
if (expected !== actual) {
    console.error(`ERR: sigma-rust HEAD (${actual}) does not match pin (${expected}).`);
    console.error(`Either update the pin (after cost-oracle parity tests still pass) or checkout the pinned commit:`);
    console.error(`  cd ${sigmaRustDir} && git checkout ${expected}`);
    process.exit(1);
}
console.error(`building WASM from sigma-rust@${actual.slice(0, 12)}...`);
execSync('npm run build-nodejs', { cwd: bindingsDir, stdio: 'inherit' });
console.error('WASM build complete: pkg-nodejs/');
