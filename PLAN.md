# Plan: Phase 2h-c.0 — `@ergots/scorex` extraction

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the Scorex wire-codec layer (`ByteReader`, `ByteWriter`, `ReaderError`, VLQ + ZigZag VLQ encoders/decoders) and block-Header data types (`Header`, `AutolykosSolution`, digest helpers) from `@ergots/nipopow` and `@ergots/ergoscript` into a new shared workspace package `@ergots/scorex` v0.1.0. Add three Fleet-inspired ergonomic helpers (`readOption`/`writeOption`, `readArray`/`writeArray`, `readBool`/`writeBool`). Net regression target: zero — all 3318 existing tests must remain green.

**Architecture:** A refactor, not a greenfield package. ~702 LOC of audited code moves; the greenfield delta is the package skeleton + the three additive helper pairs (~150 LOC). Uses ergoscript's existing `ByteReader`/`ByteWriter` shape as the unified base (nipopow's is a subset). Transitional shim files in nipopow + ergoscript re-export from `@ergots/scorex` during migration so internal call sites compile unchanged until the final cleanup pass.

**Tech Stack:** TypeScript + vitest (cross-runtime: node + jsdom). `@noble/hashes@2.2.0` (no new deps). Workspace alias `@ergots/scorex`.

**Design spec:** `docs/specs/2026-05-19-ergots-scorex-package-design.md` (committed in this session).

---

## OVERRIDES preamble for every subagent dispatched against this plan

Every subagent implementing tasks below MUST receive this preamble (per `[[feedback-subagent-explicit-rules]]`):

> **OVERRIDES rules (project-wide; override conflicting defaults):**
>
> - **Rule #2 — Confidence escalation:** if confidence on a byte-format detail or VLQ edge case drops below 95%, halt and declare. Read sigma-rust source first.
> - **Rule #5 — Root-cause mandate:** no `try/catch` swallows, no retry loops, no flag-vars to skip broken logic. Fix the origin.
> - **Rule #6 — Forced verification:** run `npx tsc --noEmit` AND the affected workspace's `npm test` after every implementation step; FIX all errors before claiming done.
> - **Rule #7 — Context decay:** after 10+ messages, re-read files before editing them.
> - **Rule #8 — Edit integrity:** read-edit-read around every edit. Max 3 edits to the same file without a verification read between batches.
>
> **TDD Iron Law:** no production code without a failing test first. (For pure-movement steps in this plan — Phase 1 skeleton, Phase 2 file moves, Phase 3 file moves — TDD is satisfied by the pre-existing test suite running green after the move. New helper code in Phase 2 follows strict TDD red→green.)
> **Source-first discipline:** read `~/projects/sigma-rust/sigma-rust/...` before writing TS that touches wire-format semantics.
> **Browser-first hard rules** (CLAUDE.md): no `Buffer`, no `node:*`, no `process`, no WASM, no top-level await. ESM only.

---

## Phase ordering

Strict sequential — each phase depends on the previous landing cleanly:

1. **Phase 1** — Create `packages/scorex/` skeleton (empty package; workspace alias resolves).
2. **Phase 2** — Move `ByteReader` / `ByteWriter` / `ReaderError` / VLQ to scorex; add transitional shims in nipopow + ergoscript; add the three Fleet-inspired helpers TDD red→green.
3. **Phase 3** — Move `digests.ts` / `autolykos-solution.ts` / `header.ts` to scorex; add transitional shims in nipopow.
4. **Phase 4** — (Optional cleanup) Refactor inline `0x00`/`0x01` option tags and inline length-prefixed array reads across nipopow + ergoscript to use `readOption`/`writeOption`/`readArray`/`writeArray`.
5. **Phase 5** — Delete transitional shim files. All internal callers now import directly from `@ergots/scorex`.
6. **Phase 6** — Write `facts/scorex.md`; update `facts/nipopow.md` cross-refs; final verification.

Per `[[feedback-no-artificial-stops]]`: drive through Phase 1 → Phase 6 with per-task commits; only stop on verification failure or surprise.

---

## Phase 1: `packages/scorex/` skeleton

### Task 1.1 — Create directory structure

**Files:**
- Create: `packages/scorex/src/index.ts` (empty barrel)
- Create: `packages/scorex/test/.gitkeep`

- [ ] **Step 1.1.1: Create the directory and placeholder files.**

```bash
mkdir -p /home/mwaddip/projects/ergots/packages/scorex/src
mkdir -p /home/mwaddip/projects/ergots/packages/scorex/test
touch /home/mwaddip/projects/ergots/packages/scorex/test/.gitkeep
```

- [ ] **Step 1.1.2: Write minimal `src/index.ts`.**

Edit `packages/scorex/src/index.ts`:

```ts
// @ergots/scorex v0.1.0 — Scorex wire-codec layer + block-Header types.
// Phase 2h-c.0 extraction (in progress); exports added as files are moved.
export {}
```

### Task 1.2 — Write package config files

**Files:**
- Create: `packages/scorex/package.json`
- Create: `packages/scorex/tsconfig.json`
- Create: `packages/scorex/vitest.config.ts`
- Create: `packages/scorex/vitest.browser.config.ts`
- Create: `packages/scorex/tsup.config.ts`
- Create: `packages/scorex/LICENSE`

- [ ] **Step 1.2.1: Write `packages/scorex/package.json`.**

Use `packages/avltree/package.json` as template, substituting name/description/keywords:

```json
{
  "name": "@ergots/scorex",
  "version": "0.1.0",
  "publishConfig": { "access": "public" },
  "description": "Pure-TypeScript Scorex wire codec (VLQ, ZigZag VLQ, ByteReader/Writer) plus Ergo block-Header / AutolykosSolution data types shared across @ergots/* packages.",
  "type": "module",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/mwaddip/ergots.git",
    "directory": "packages/scorex"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "src", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:browser": "vitest run --config vitest.browser.config.ts",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@noble/hashes": "2.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "jsdom": "^29.1.1",
    "tsup": "^8.5.1",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "engines": { "node": ">=20" },
  "keywords": ["ergo", "scorex", "vlq", "serialization", "blockchain", "browser"]
}
```

- [ ] **Step 1.2.2: Write `packages/scorex/tsconfig.json`.**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 1.2.3: Write `packages/scorex/vitest.config.ts`.**

```ts
import { defineConfig } from 'vitest/config';

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
```

- [ ] **Step 1.2.4: Write `packages/scorex/vitest.browser.config.ts`.**

```ts
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
```

- [ ] **Step 1.2.5: Write `packages/scorex/tsup.config.ts`.**

```ts
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
```

- [ ] **Step 1.2.6: Copy LICENSE.**

```bash
cp /home/mwaddip/projects/ergots/packages/avltree/LICENSE /home/mwaddip/projects/ergots/packages/scorex/LICENSE
```

### Task 1.3 — Declare workspace alias in consumer packages

**Files:**
- Modify: `packages/nipopow/package.json` (add `@ergots/scorex` to dependencies)
- Modify: `packages/ergoscript/package.json` (add `@ergots/scorex` to dependencies)

- [ ] **Step 1.3.1: Read current consumer package.json dependencies.**

```bash
grep -A 5 '"dependencies"' /home/mwaddip/projects/ergots/packages/nipopow/package.json
grep -A 5 '"dependencies"' /home/mwaddip/projects/ergots/packages/ergoscript/package.json
```

- [ ] **Step 1.3.2: Add `"@ergots/scorex": "0.1.0"` to `packages/nipopow/package.json` dependencies.**

Use Edit tool to insert into the dependencies object. Resulting block should be (preserve existing `@noble/hashes` entry):

```json
  "dependencies": {
    "@ergots/scorex": "0.1.0",
    "@noble/hashes": "2.2.0"
  },
```

- [ ] **Step 1.3.3: Add `"@ergots/scorex": "0.1.0"` to `packages/ergoscript/package.json` dependencies.**

Same insertion pattern. Preserve all existing deps (`@ergots/avltree`, `@noble/curves`, `@noble/hashes`):

```json
  "dependencies": {
    "@ergots/avltree": "0.2.0",
    "@ergots/scorex": "0.1.0",
    "@noble/curves": "2.2.0",
    "@noble/hashes": "2.2.0"
  },
```

### Task 1.4 — Resolve workspace and verify clean baseline

- [ ] **Step 1.4.1: Run `npm install` from repo root.**

```bash
cd /home/mwaddip/projects/ergots && npm install 2>&1 | tail -10
```

Expected: completes without errors. Verify workspace alias by running:

```bash
ls -la /home/mwaddip/projects/ergots/node_modules/@ergots/scorex
```

Expected: symlink to `packages/scorex`.

- [ ] **Step 1.4.2: Typecheck the new empty package.**

```bash
cd /home/mwaddip/projects/ergots && npx tsc --noEmit -p packages/scorex/tsconfig.json 2>&1 | tail -5
```

Expected: zero errors.

- [ ] **Step 1.4.3: Typecheck unchanged consumer packages.**

```bash
cd /home/mwaddip/projects/ergots && npx tsc --noEmit -p packages/nipopow/tsconfig.json 2>&1 | tail -5
cd /home/mwaddip/projects/ergots && npx tsc --noEmit -p packages/ergoscript/tsconfig.json 2>&1 | tail -5
```

Expected: zero errors in both.

- [ ] **Step 1.4.4: Run all consumer tests to confirm baseline is unchanged.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/nipopow/ packages/ergoscript/ 2>&1 | tail -10
```

Expected: 335 (nipopow) + 2827 (ergoscript) = 3162 tests pass.

### Task 1.5 — Commit the skeleton

- [ ] **Step 1.5.1: Stage and commit.**

```bash
cd /home/mwaddip/projects/ergots
git add packages/scorex/ packages/nipopow/package.json packages/ergoscript/package.json package-lock.json
git commit -m "$(cat <<'EOF'
build(scorex): create @ergots/scorex v0.1.0 package skeleton

Phase 2h-c.0 step 1/6 — empty package with package.json, tsconfig,
vitest configs (node + jsdom), tsup config, LICENSE. Declared as
workspace dependency in @ergots/nipopow and @ergots/ergoscript.

No functional changes. All 3162 consumer tests remain green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds with no pre-commit hook failures.

---

## Phase 2: Move codec layer + add Fleet-inspired helpers

### Task 2.1 — Move ByteReader to `@ergots/scorex/src/reader.ts`

**Files:**
- Create: `packages/scorex/src/errors.ts`
- Create: `packages/scorex/src/reader.ts`
- Modify: `packages/scorex/src/index.ts` (export new symbols)

- [ ] **Step 2.1.1: Read ergoscript's existing reader and writer to know what's being moved.**

```bash
cat /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/reader.ts | head -50
cat /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/writer.ts | head -50
```

- [ ] **Step 2.1.2: Create `packages/scorex/src/errors.ts` with single-source ReaderError.**

```ts
/**
 * @ergots/scorex — wire-codec error class.
 *
 * Thrown by ByteReader on malformed bytes (truncation, VLQ overflow, etc.).
 * Carries a structural `code: string` matching a fixed enum of reasons for
 * programmatic dispatch (instanceof + .code).
 */
export class ReaderError extends Error {
  constructor(message: string, public readonly code: 'truncated' | 'vlq-overflow' | 'slice-out-of-bounds') {
    super(message);
    this.name = 'ReaderError';
  }
}
```

- [ ] **Step 2.1.3: Move ergoscript's reader.ts content into `packages/scorex/src/reader.ts`.**

```bash
cp /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/reader.ts /home/mwaddip/projects/ergots/packages/scorex/src/reader.ts
```

Then edit the copy:
- Remove the duplicate `ReaderError` declaration; replace with `import { ReaderError } from './errors.ts';`.
- Verify no other imports reference `./wire/...` paths (this is a fresh package; all imports must be relative-internal or `@noble/hashes` style).

- [ ] **Step 2.1.4: Update `packages/scorex/src/index.ts` to re-export.**

```ts
export { ByteReader } from './reader.ts';
export { ReaderError } from './errors.ts';
```

- [ ] **Step 2.1.5: Typecheck the new file.**

```bash
cd /home/mwaddip/projects/ergots && npx tsc --noEmit -p packages/scorex/tsconfig.json 2>&1 | tail -5
```

Expected: zero errors.

### Task 2.2 — Move ByteWriter to `@ergots/scorex/src/writer.ts`

**Files:**
- Create: `packages/scorex/src/writer.ts`
- Modify: `packages/scorex/src/index.ts`

- [ ] **Step 2.2.1: Move ergoscript's writer.ts.**

```bash
cp /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/writer.ts /home/mwaddip/projects/ergots/packages/scorex/src/writer.ts
```

Edit the copy:
- Verify no imports reference `./wire/...` paths.
- If the writer imports `ReaderError` for any reason (it shouldn't), redirect to `./errors.ts`.

- [ ] **Step 2.2.2: Update `packages/scorex/src/index.ts`.**

```ts
export { ByteReader } from './reader.ts';
export { ByteWriter } from './writer.ts';
export { ReaderError } from './errors.ts';
```

- [ ] **Step 2.2.3: Typecheck.**

```bash
cd /home/mwaddip/projects/ergots && npx tsc --noEmit -p packages/scorex/tsconfig.json 2>&1 | tail -5
```

Expected: zero errors.

### Task 2.3 — Move VLQ free functions and add as scorex exports

**Files:**
- Create: `packages/scorex/src/vlq.ts`
- Modify: `packages/scorex/src/index.ts`

- [ ] **Step 2.3.1: Read nipopow's VLQ implementation.**

```bash
cat /home/mwaddip/projects/ergots/packages/nipopow/src/scorex/vlq.ts
```

- [ ] **Step 2.3.2: Create `packages/scorex/src/vlq.ts` with the free-function API.**

Copy the content from `packages/nipopow/src/scorex/vlq.ts`, updating import paths:
- `import { ByteReader } from './reader.ts';` (was `./reader.ts` — same relative path; just verify after copy).
- `import { ReaderError } from './errors.ts';` if any error-throwing path uses it.

Exported symbols (same as nipopow's vlq.ts):
- `encodeVlqU(value: bigint): Uint8Array`
- `decodeVlqU(reader: ByteReader): bigint`
- `encodeVlqZigZag(value: bigint): Uint8Array`
- `decodeVlqZigZag(reader: ByteReader): bigint`
- `readVlqU32(reader: ByteReader, fieldName: string): number`

**DRY follow-up (per spec):** After both `reader.ts` (which already contains ergoscript's instance-method VLQ logic) and `vlq.ts` (nipopow's free-function logic) coexist in `packages/scorex/src/`, audit for duplicated VLQ-decode loops. Spec calls for "backed by the same code paths as the reader/writer instance methods (DRY via shared internal `_decodeVlqU`/`_encodeVlqU` helpers)". If both implementations are byte-equivalent (verified via the moved test suites), refactor one path to delegate to the other — typically the free functions delegate to ByteReader/ByteWriter via a thin wrapper. Defer if both paths' tests pass and the duplication is small; capture as a follow-up commit.

- [ ] **Step 2.3.3: Update `packages/scorex/src/index.ts`.**

```ts
export { ByteReader } from './reader.ts';
export { ByteWriter } from './writer.ts';
export { ReaderError } from './errors.ts';
export {
  encodeVlqU,
  decodeVlqU,
  encodeVlqZigZag,
  decodeVlqZigZag,
  readVlqU32,
} from './vlq.ts';
```

- [ ] **Step 2.3.4: Typecheck.**

```bash
cd /home/mwaddip/projects/ergots && npx tsc --noEmit -p packages/scorex/tsconfig.json 2>&1 | tail -5
```

Expected: zero errors.

### Task 2.4 — Add transitional shims in nipopow + ergoscript

**Files:**
- Modify: `packages/nipopow/src/scorex/reader.ts` (replace with re-export shim)
- Modify: `packages/nipopow/src/scorex/writer.ts` (replace with re-export shim)
- Modify: `packages/nipopow/src/scorex/vlq.ts` (replace with re-export shim)
- Modify: `packages/ergoscript/src/wire/reader.ts` (replace with re-export shim)
- Modify: `packages/ergoscript/src/wire/writer.ts` (replace with re-export shim)

- [ ] **Step 2.4.1: Replace `packages/nipopow/src/scorex/reader.ts` with a re-export shim.**

```ts
// Transitional shim — Phase 2h-c.0. Delete after all nipopow internal
// callers import directly from '@ergots/scorex' (Phase 5 of PLAN.md).
export { ByteReader, ReaderError } from '@ergots/scorex';
```

- [ ] **Step 2.4.2: Replace `packages/nipopow/src/scorex/writer.ts` with a re-export shim.**

```ts
// Transitional shim — Phase 2h-c.0. Delete after Phase 5.
export { ByteWriter } from '@ergots/scorex';
```

- [ ] **Step 2.4.3: Replace `packages/nipopow/src/scorex/vlq.ts` with a re-export shim.**

```ts
// Transitional shim — Phase 2h-c.0. Delete after Phase 5.
export {
  encodeVlqU,
  decodeVlqU,
  encodeVlqZigZag,
  decodeVlqZigZag,
  readVlqU32,
} from '@ergots/scorex';
```

- [ ] **Step 2.4.4: Replace `packages/ergoscript/src/wire/reader.ts` with a re-export shim.**

```ts
// Transitional shim — Phase 2h-c.0. Delete after Phase 5.
export { ByteReader, ReaderError } from '@ergots/scorex';
```

- [ ] **Step 2.4.5: Replace `packages/ergoscript/src/wire/writer.ts` with a re-export shim.**

```ts
// Transitional shim — Phase 2h-c.0. Delete after Phase 5.
export { ByteWriter } from '@ergots/scorex';
```

- [ ] **Step 2.4.6: Typecheck all packages.**

```bash
cd /home/mwaddip/projects/ergots
npx tsc --noEmit -p packages/scorex/tsconfig.json 2>&1 | tail -5
npx tsc --noEmit -p packages/nipopow/tsconfig.json 2>&1 | tail -5
npx tsc --noEmit -p packages/ergoscript/tsconfig.json 2>&1 | tail -5
```

Expected: zero errors in all three.

- [ ] **Step 2.4.7: Run all tests to confirm zero regression.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/ packages/nipopow/ packages/ergoscript/ packages/avltree/ 2>&1 | tail -15
```

Expected: 3318 tests pass (avltree unaffected: 156; nipopow: 335; ergoscript: 2827; scorex: 0 since no test files yet).

### Task 2.5 — Move existing codec tests to scorex

**Files:**
- Create: `packages/scorex/test/reader.test.ts` (moved from ergoscript)
- Create: `packages/scorex/test/writer.test.ts` (moved from ergoscript)
- Create: `packages/scorex/test/vlq.test.ts` (moved from nipopow)
- Delete: `packages/ergoscript/test/wire/reader.test.ts`
- Delete: `packages/ergoscript/test/wire/writer.test.ts`
- Delete: `packages/nipopow/test/scorex/vlq.test.ts`
- Delete: `packages/nipopow/test/scorex/reader.test.ts` if it exists
- Delete: `packages/nipopow/test/scorex/writer.test.ts` if it exists

- [ ] **Step 2.5.1: Locate existing codec tests.**

```bash
find /home/mwaddip/projects/ergots/packages/ergoscript/test -name 'reader.test.ts' -o -name 'writer.test.ts' | head -5
find /home/mwaddip/projects/ergots/packages/nipopow/test -name 'vlq.test.ts' -o -name 'reader.test.ts' -o -name 'writer.test.ts' | head -5
```

- [ ] **Step 2.5.2: Move ergoscript's reader.test.ts and writer.test.ts to scorex.**

```bash
git mv /home/mwaddip/projects/ergots/packages/ergoscript/test/wire/reader.test.ts /home/mwaddip/projects/ergots/packages/scorex/test/reader.test.ts
git mv /home/mwaddip/projects/ergots/packages/ergoscript/test/wire/writer.test.ts /home/mwaddip/projects/ergots/packages/scorex/test/writer.test.ts
```

Edit the moved files to update imports:
- Find: `from '../../src/wire/reader.ts'` or `from '../src/wire/reader.ts'`
- Replace with: `from '@ergots/scorex'` (preferred) or `from '../src/reader.ts'`

- [ ] **Step 2.5.3: Move nipopow's vlq.test.ts to scorex.**

```bash
git mv /home/mwaddip/projects/ergots/packages/nipopow/test/scorex/vlq.test.ts /home/mwaddip/projects/ergots/packages/scorex/test/vlq.test.ts
```

Edit imports same way. If nipopow has reader.test.ts / writer.test.ts under `test/scorex/`, also move them.

- [ ] **Step 2.5.4: Run scorex tests to verify they pass.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/ 2>&1 | tail -15
```

Expected: all moved tests pass.

- [ ] **Step 2.5.5: Run all packages' tests to verify no regression elsewhere.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/ 2>&1 | tail -15
```

Expected: total test count unchanged (3318) — tests just live in a different package now.

### Task 2.6 — TDD: add `readBool` / `writeBool` (helper pair 1 of 3)

**Files:**
- Create: `packages/scorex/test/option-array.test.ts`
- Modify: `packages/scorex/src/reader.ts`
- Modify: `packages/scorex/src/writer.ts`

- [ ] **Step 2.6.1: Write failing test.**

Create `packages/scorex/test/option-array.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { ByteReader, ByteWriter } from '../src/index.ts';

describe('readBool / writeBool', () => {
  test('writeBool(true) emits 0x01', () => {
    const w = new ByteWriter();
    w.writeBool(true);
    expect(w.toBytes()).toEqual(new Uint8Array([0x01]));
  });

  test('writeBool(false) emits 0x00', () => {
    const w = new ByteWriter();
    w.writeBool(false);
    expect(w.toBytes()).toEqual(new Uint8Array([0x00]));
  });

  test('readBool round-trips both values', () => {
    for (const v of [true, false]) {
      const w = new ByteWriter();
      w.writeBool(v);
      const r = new ByteReader(w.toBytes());
      expect(r.readBool()).toBe(v);
      expect(r.isExhausted).toBe(true);
    }
  });

  test('readBool rejects non-{0,1} byte', () => {
    const r = new ByteReader(new Uint8Array([0x02]));
    expect(() => r.readBool()).toThrow();
  });
});
```

Run: `cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/test/option-array.test.ts 2>&1 | tail -10`
Expected: 4 fails with "readBool is not a function" / "writeBool is not a function".

- [ ] **Step 2.6.2: Implement `writeBool` in `packages/scorex/src/writer.ts`.**

Add to the `ByteWriter` class body:

```ts
  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }
```

- [ ] **Step 2.6.3: Implement `readBool` in `packages/scorex/src/reader.ts`.**

Add to the `ByteReader` class body. Use the existing `ReaderError` import:

```ts
  readBool(): boolean {
    const b = this.readU8();
    if (b === 0) return false;
    if (b === 1) return true;
    throw new ReaderError(`readBool: expected 0 or 1, got ${b}`, 'truncated');
  }
```

Note: the `'truncated'` code is a reuse for "wire-shape violation"; this matches the spec's commitment to "no new error codes introduced by this extraction".

- [ ] **Step 2.6.4: Run tests.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/test/option-array.test.ts 2>&1 | tail -10
```

Expected: all 4 tests pass.

### Task 2.7 — TDD: add `readOption` / `writeOption` (helper pair 2 of 3)

**Files:**
- Modify: `packages/scorex/test/option-array.test.ts` (append)
- Modify: `packages/scorex/src/reader.ts`
- Modify: `packages/scorex/src/writer.ts`

- [ ] **Step 2.7.1: Append failing tests to `packages/scorex/test/option-array.test.ts`.**

```ts
describe('readOption / writeOption', () => {
  test('writeOption(null) emits 0x00', () => {
    const w = new ByteWriter();
    w.writeOption<number>(null, (w, v) => w.writeU8(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0x00]));
  });

  test('writeOption(value, ser) emits 0x01 + ser bytes', () => {
    const w = new ByteWriter();
    w.writeOption<number>(42, (w, v) => w.writeU8(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0x01, 42]));
  });

  test('readOption round-trips null and value', () => {
    for (const v of [null, 7] as Array<number | null>) {
      const w = new ByteWriter();
      w.writeOption<number>(v, (w, v) => w.writeU8(v));
      const r = new ByteReader(w.toBytes());
      const decoded = r.readOption<number>((r) => r.readU8());
      expect(decoded).toEqual(v);
      expect(r.isExhausted).toBe(true);
    }
  });

  test('readOption rejects malformed tag byte', () => {
    const r = new ByteReader(new Uint8Array([0x02, 0x00]));
    expect(() => r.readOption<number>((r) => r.readU8())).toThrow();
  });
});
```

Run: `cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/test/option-array.test.ts 2>&1 | tail -10`
Expected: 4 new failures.

- [ ] **Step 2.7.2: Implement `writeOption`.**

Add to `ByteWriter` class body:

```ts
  writeOption<T>(value: T | null, serializer: (w: ByteWriter, v: T) => void): void {
    if (value === null) {
      this.writeU8(0);
      return;
    }
    this.writeU8(1);
    serializer(this, value);
  }
```

- [ ] **Step 2.7.3: Implement `readOption`.**

Add to `ByteReader` class body:

```ts
  readOption<T>(reader: (r: ByteReader) => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return reader(this);
    throw new ReaderError(`readOption: expected tag 0 or 1, got ${tag}`, 'truncated');
  }
```

- [ ] **Step 2.7.4: Run tests.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/test/option-array.test.ts 2>&1 | tail -10
```

Expected: all 8 tests pass (4 from Task 2.6 + 4 new).

### Task 2.8 — TDD: add `readArray` / `writeArray` (helper pair 3 of 3)

**Files:**
- Modify: `packages/scorex/test/option-array.test.ts` (append)
- Modify: `packages/scorex/src/reader.ts`
- Modify: `packages/scorex/src/writer.ts`

- [ ] **Step 2.8.1: Append failing tests.**

```ts
describe('readArray / writeArray', () => {
  test('writeArray([]) emits single 0x00 VLQ length', () => {
    const w = new ByteWriter();
    w.writeArray<number>([], (w, v) => w.writeU8(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0x00]));
  });

  test('writeArray([1,2,3]) emits VLQ length + items', () => {
    const w = new ByteWriter();
    w.writeArray<number>([1, 2, 3], (w, v) => w.writeU8(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0x03, 1, 2, 3]));
  });

  test('readArray round-trips empty, small, and multi-byte-length arrays', () => {
    for (const arr of [
      [] as number[],
      [9] as number[],
      Array.from({ length: 256 }, (_, i) => i % 200), // multi-byte VLQ length
    ]) {
      const w = new ByteWriter();
      w.writeArray<number>(arr, (w, v) => w.writeU8(v));
      const r = new ByteReader(w.toBytes());
      const decoded = r.readArray<number>((r) => r.readU8());
      expect(decoded).toEqual(arr);
      expect(r.isExhausted).toBe(true);
    }
  });

  test('readArray throws on truncated element stream', () => {
    // length = 3, but only 2 bytes follow.
    const r = new ByteReader(new Uint8Array([0x03, 1, 2]));
    expect(() => r.readArray<number>((r) => r.readU8())).toThrow();
  });
});
```

Run: `cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/test/option-array.test.ts 2>&1 | tail -10`
Expected: 4 new failures.

- [ ] **Step 2.8.2: Implement `writeArray`.**

Add to `ByteWriter` class body:

```ts
  writeArray<T>(items: T[], serializer: (w: ByteWriter, item: T) => void): void {
    this.writeVlqU(items.length);
    for (const item of items) serializer(this, item);
  }
```

- [ ] **Step 2.8.3: Implement `readArray`.**

Add to `ByteReader` class body:

```ts
  readArray<T>(reader: (r: ByteReader) => T): T[] {
    const length = this.readVlqU();
    const out: T[] = new Array(length);
    for (let i = 0; i < length; i++) out[i] = reader(this);
    return out;
  }
```

- [ ] **Step 2.8.4: Run all scorex tests.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/ 2>&1 | tail -10
```

Expected: all 12 helper tests pass plus the moved reader/writer/vlq tests.

- [ ] **Step 2.8.5: Run cross-runtime (jsdom) variant.**

```bash
cd /home/mwaddip/projects/ergots/packages/scorex && npx vitest run --config vitest.browser.config.ts 2>&1 | tail -10
```

Expected: same pass count under jsdom.

- [ ] **Step 2.8.6: Run all consumer tests to confirm zero regression.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/ 2>&1 | tail -15
```

Expected: 3318 total tests pass (avltree 156 + nipopow 335 + ergoscript 2827 + scorex moved tests).

- [ ] **Step 2.8.7: Commit Phase 2.**

```bash
cd /home/mwaddip/projects/ergots
git add packages/scorex/ packages/nipopow/src/scorex/ packages/ergoscript/src/wire/reader.ts packages/ergoscript/src/wire/writer.ts packages/ergoscript/test/wire/ packages/nipopow/test/scorex/ 2>/dev/null || true
# git add commands above may produce no-ops for deletions; use status to verify:
git status
git add -A packages/scorex/ packages/nipopow/ packages/ergoscript/
git commit -m "$(cat <<'EOF'
refactor(scorex): move ByteReader/ByteWriter/VLQ + add Option/Array/Bool helpers

Phase 2h-c.0 step 2/6. Moves the wire-codec layer from
packages/ergoscript/src/wire/{reader,writer}.ts and packages/nipopow/src/scorex/*.ts
into @ergots/scorex/src/. Transitional shims (re-exports from @ergots/scorex) keep
internal callers compiling unchanged; shims are removed in Phase 5.

Adds three Fleet-inspired helpers TDD red-green:
  - readBool / writeBool
  - readOption / writeOption (callback-based)
  - readArray / writeArray (VLQ-length-prefixed, callback-based)

Test suite: 3318 tests pass (unchanged count; tests moved into @ergots/scorex
keep their names + fixtures). Cross-runtime green (node + jsdom).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: Move digests + Header + AutolykosSolution

### Task 3.1 — Move `digests.ts` to scorex

**Files:**
- Create: `packages/scorex/src/digests.ts`
- Modify: `packages/nipopow/src/digests.ts` (replace with re-export shim)
- Modify: `packages/scorex/src/index.ts` (export digest helpers)

- [ ] **Step 3.1.1: Move file content.**

```bash
cp /home/mwaddip/projects/ergots/packages/nipopow/src/digests.ts /home/mwaddip/projects/ergots/packages/scorex/src/digests.ts
```

Edit `packages/scorex/src/digests.ts` to fix relative imports:
- Find: `from './scorex/reader.ts'` → replace with `from './reader.ts'`
- Find: `from './scorex/writer.ts'` → replace with `from './writer.ts'`

- [ ] **Step 3.1.2: Update `packages/scorex/src/index.ts`.**

Append:

```ts
export {
  BLOCK_ID_LEN,
  DIGEST32_LEN,
  EC_POINT_LEN,
  readFixed,
  writeFixed,
} from './digests.ts';
```

(Adjust the export list to match actual exports of `digests.ts`; verify with the existing nipopow file's exports.)

- [ ] **Step 3.1.3: Replace `packages/nipopow/src/digests.ts` with a re-export shim.**

```ts
// Transitional shim — Phase 2h-c.0. Delete after Phase 5.
export {
  BLOCK_ID_LEN,
  DIGEST32_LEN,
  EC_POINT_LEN,
  readFixed,
  writeFixed,
} from '@ergots/scorex';
```

- [ ] **Step 3.1.4: Typecheck.**

```bash
cd /home/mwaddip/projects/ergots
npx tsc --noEmit -p packages/scorex/tsconfig.json 2>&1 | tail -5
npx tsc --noEmit -p packages/nipopow/tsconfig.json 2>&1 | tail -5
```

Expected: zero errors.

### Task 3.2 — Move `autolykos-solution.ts` to scorex

**Files:**
- Create: `packages/scorex/src/autolykos-solution.ts`
- Modify: `packages/nipopow/src/autolykos-solution.ts` (re-export shim)
- Modify: `packages/scorex/src/index.ts`
- Move: `packages/nipopow/test/autolykos-solution.test.ts` → `packages/scorex/test/autolykos-solution.test.ts`

- [ ] **Step 3.2.1: Move file content.**

```bash
cp /home/mwaddip/projects/ergots/packages/nipopow/src/autolykos-solution.ts /home/mwaddip/projects/ergots/packages/scorex/src/autolykos-solution.ts
```

Edit to fix imports:
- `from './scorex/reader.ts'` → `from './reader.ts'`
- `from './scorex/writer.ts'` → `from './writer.ts'`
- `from './digests.ts'` (no change — same relative path)

- [ ] **Step 3.2.2: Update `packages/scorex/src/index.ts`.**

Append:

```ts
export type { AutolykosSolution } from './autolykos-solution.ts';
export {
  parseAutolykosSolution,
  serializeAutolykosSolution,
} from './autolykos-solution.ts';
```

(Adjust to match actual exports; the nipopow file may not have all four — verify before writing.)

- [ ] **Step 3.2.3: Replace `packages/nipopow/src/autolykos-solution.ts` with a re-export shim.**

```ts
// Transitional shim — Phase 2h-c.0. Delete after Phase 5.
export type { AutolykosSolution } from '@ergots/scorex';
export { parseAutolykosSolution, serializeAutolykosSolution } from '@ergots/scorex';
```

- [ ] **Step 3.2.4: Move the test file.**

```bash
git mv /home/mwaddip/projects/ergots/packages/nipopow/test/autolykos-solution.test.ts /home/mwaddip/projects/ergots/packages/scorex/test/autolykos-solution.test.ts
```

Edit imports:
- Find: `from '../src/autolykos-solution.ts'` → replace with `from '@ergots/scorex'` or `from '../src/autolykos-solution.ts'`.
- Also update any reader/writer imports.

- [ ] **Step 3.2.5: Run scorex + nipopow tests.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/scorex/ packages/nipopow/ 2>&1 | tail -10
```

Expected: total count unchanged (335 + scorex including new autolykos-solution.test.ts).

### Task 3.3 — Move `header.ts` to scorex

**Files:**
- Create: `packages/scorex/src/header.ts`
- Modify: `packages/nipopow/src/header.ts` (re-export shim)
- Modify: `packages/scorex/src/index.ts`
- Move: `packages/nipopow/test/header.test.ts` → `packages/scorex/test/header.test.ts`

- [ ] **Step 3.3.1: Move file content.**

```bash
cp /home/mwaddip/projects/ergots/packages/nipopow/src/header.ts /home/mwaddip/projects/ergots/packages/scorex/src/header.ts
```

Edit to fix imports:
- `from './scorex/reader.ts'` → `from './reader.ts'`
- `from './scorex/writer.ts'` → `from './writer.ts'`
- `from './digests.ts'` (no change)
- `from './autolykos-solution.ts'` (no change)
- `from '@noble/hashes/blake2.js'` (no change — third-party dep)

- [ ] **Step 3.3.2: Update `packages/scorex/src/index.ts`.**

Append:

```ts
export type { Header } from './header.ts';
export {
  parseHeader,
  serializeHeader,
} from './header.ts';
```

- [ ] **Step 3.3.3: Replace `packages/nipopow/src/header.ts` with a re-export shim.**

```ts
// Transitional shim — Phase 2h-c.0. Delete after Phase 5.
export type { Header } from '@ergots/scorex';
export { parseHeader, serializeHeader } from '@ergots/scorex';
```

- [ ] **Step 3.3.4: Move the test file.**

```bash
git mv /home/mwaddip/projects/ergots/packages/nipopow/test/header.test.ts /home/mwaddip/projects/ergots/packages/scorex/test/header.test.ts
```

Edit imports to point at `@ergots/scorex` (or `../src/header.ts`).

- [ ] **Step 3.3.5: Run all tests across all packages.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/ 2>&1 | tail -15
```

Expected: 3318 total tests pass.

- [ ] **Step 3.3.6: Verify cross-runtime green.**

```bash
cd /home/mwaddip/projects/ergots/packages/scorex && npx vitest run --config vitest.browser.config.ts 2>&1 | tail -10
```

Expected: same pass count under jsdom.

### Task 3.4 — Commit Phase 3

- [ ] **Step 3.4.1: Stage and commit.**

```bash
cd /home/mwaddip/projects/ergots
git add -A packages/scorex/ packages/nipopow/
git commit -m "$(cat <<'EOF'
refactor(scorex): move digests + Header + AutolykosSolution to @ergots/scorex

Phase 2h-c.0 step 3/6. Moves nipopow's shared block-header data layer:
  - packages/nipopow/src/digests.ts → @ergots/scorex/src/digests.ts
  - packages/nipopow/src/autolykos-solution.ts → @ergots/scorex/src/autolykos-solution.ts
  - packages/nipopow/src/header.ts → @ergots/scorex/src/header.ts

Plus the corresponding test files (header.test.ts, autolykos-solution.test.ts)
which now live in packages/scorex/test/. Transitional shims in nipopow keep
internal callers compiling unchanged; removed in Phase 5.

Note: @ergots/nipopow's autolykos-v2.ts (the PoW verifier) stays in nipopow.
Phase 2h-c.2 will likely promote it to @ergots/scorex when @ergots/ergoscript
needs SHeader.checkPow, but that's a separate spec.

Test suite: 3318 tests pass. Cross-runtime green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: Optional cleanup pass — refactor inline call sites to use helpers

This phase is **optional** in the sense that all tests already pass without it. Its purpose is to dedupe the ~30+ inline `0x00`/`0x01` option tags and inline VLQ-length-prefixed-array reads that exist across both packages. Per `[[feedback-no-artificial-stops]]` — drive through.

### Task 4.1 — Audit and refactor `Option` tag sites

**Files (search-and-refactor):**
- Modify: `packages/ergoscript/src/wire/parse-svalue.ts`
- Modify: `packages/ergoscript/src/wire/serialize-svalue.ts`
- Modify: `packages/ergoscript/src/wire/parse.ts` (per-arm option handling — verify with grep)
- Modify: `packages/nipopow/src/proof.ts` (interlinks option handling — verify)
- Modify: any other inline `0x00`/`0x01` tag sites surfaced by grep

- [ ] **Step 4.1.1: Find candidate sites.**

```bash
cd /home/mwaddip/projects/ergots
grep -rn '0x01.*tag\|tag.*0x01\|readU8.*===.*1\|readU8.*===.*0' packages/nipopow/src/ packages/ergoscript/src/ | head -30
```

For each match, judge: is this a 0x00/0x01-tagged option pattern? If yes, refactor to use `readOption` / `writeOption`. If it's a special opcode dispatch or non-option boolean check, skip.

- [ ] **Step 4.1.2: Refactor `parse-svalue.ts` Option branch.**

Locate the SOption parser (search for `case 'SOption'` or `case SType.SOption`). The current shape will look like:

```ts
const tag = reader.readU8();
let value: SValue | null;
if (tag === 0) value = null;
else if (tag === 1) value = parseSValue(elemTpe, reader);
else throw new SValueParseError(...);
```

Replace with:

```ts
const value = reader.readOption<SValue>((r) => parseSValue(elemTpe, r));
```

(Verify the error class match — if existing code throws `SValueParseError` for malformed tag, the `readOption` throw of `ReaderError` is a behavior change. Decision: keep `SValueParseError` for the SOption case by wrapping or by leaving this site alone. Use grep + the existing test suite to confirm: if tests assert `SValueParseError instanceof`, do NOT refactor this site; leave it inline.)

- [ ] **Step 4.1.3: Refactor `valueLengthOpt` site in ergoscript SAvlTree wire.**

Located in `parse-svalue.ts` / `serialize-svalue.ts` for `case 'SAvlTree'`. Same refactor as Step 4.1.2 — replace inline tag-byte handling with `readOption<number>((r) => r.readVlqU())` / `writeOption<number>(v, (w, x) => w.writeVlqU(x))`.

- [ ] **Step 4.1.4: Run all tests after each refactor batch.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/ 2>&1 | tail -10
```

Expected: 3318 pass. If any test fails, halt and investigate (likely an error-class divergence per Step 4.1.2 note).

### Task 4.2 — Audit and refactor length-prefixed-array sites

- [ ] **Step 4.2.1: Find candidate sites.**

```bash
cd /home/mwaddip/projects/ergots
grep -rn 'readVlqU()\|writeVlqU(.*length)' packages/nipopow/src/ packages/ergoscript/src/ | head -30
```

For each match: is the VLQ length immediately followed by a loop reading/writing N items of a uniform type? If yes, candidate for `readArray` / `writeArray`. If the length is used for other purposes (e.g., bounds-checking a single byte sequence read via `readBytes(n)`), skip.

- [ ] **Step 4.2.2: Refactor obvious sites.**

Common candidates (verify with grep):
- `NipopowProof.prefix` parser (length-prefixed `PoPowHeader[]`)
- `NipopowProof.suffixTail` parser
- `PoPowHeader.interlinks` parser
- `ErgoBox.tokens` parser
- `ErgoBox.additionalRegisters` parser (be careful — registers are keyed, not a flat array; may not fit `readArray`)
- `SValue` `Coll` arm

Pattern, before:

```ts
const length = reader.readVlqU();
const items: T[] = [];
for (let i = 0; i < length; i++) items.push(parseT(reader));
```

After:

```ts
const items = reader.readArray<T>((r) => parseT(r));
```

- [ ] **Step 4.2.3: Run all tests after each refactor batch.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/ 2>&1 | tail -10
```

Expected: 3318 pass.

### Task 4.3 — Audit and refactor `Bool` sites

- [ ] **Step 4.3.1: Find candidate sites.**

```bash
cd /home/mwaddip/projects/ergots
grep -rn 'readU8()' packages/nipopow/src/ packages/ergoscript/src/ | grep -iE 'bool|boolean' | head -10
```

Most "bool" reads in this codebase are inside the `parseSValue(SBoolean, r)` flow, which already calls `readU8()`. Whether to refactor that to `readBool()` is debatable — `readBool` adds error-on-non-{0,1} that `readU8()` doesn't. Decision: only refactor where the strict 0/1 check is wanted (e.g., the SBoolean SValue parser); leave other `readU8()` calls alone.

- [ ] **Step 4.3.2: Refactor `SBoolean` SValue parser if applicable.**

Locate in `parse-svalue.ts`:

```ts
// before
const v = reader.readU8();
return { kind: 'Boolean', value: v !== 0 };

// after
return { kind: 'Boolean', value: reader.readBool() };
```

This is a behavior tightening — previously any non-zero byte became `true`; now only `0x01` does. Verify against sigma-rust: does sigma-rust reject non-{0,1} bytes? **If sigma-rust accepts any non-zero byte as true, do NOT refactor this site** (would create a spurious parse rejection).

- [ ] **Step 4.3.3: Source-read sigma-rust for SBoolean.**

```bash
grep -rn 'SBoolean\|Value::Boolean' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/data.rs | head -10
```

Read the SBoolean parse branch. If it strict-checks 0/1, the refactor is safe. If it accepts any non-zero as true, leave the site alone and document in the task log.

- [ ] **Step 4.3.4: Run all tests.**

```bash
cd /home/mwaddip/projects/ergots && npx vitest run packages/ 2>&1 | tail -10
```

Expected: 3318 pass.

### Task 4.4 — Commit Phase 4

- [ ] **Step 4.4.1: Stage and commit.**

```bash
cd /home/mwaddip/projects/ergots
git add -A packages/nipopow/src/ packages/ergoscript/src/
git commit -m "$(cat <<'EOF'
refactor: replace inline option/array codecs with @ergots/scorex helpers

Phase 2h-c.0 step 4/6 (optional cleanup). Replaces inline 0x00/0x01 option
tag handling and inline VLQ-length-prefixed array reads/writes with the
new readOption/writeOption + readArray/writeArray helpers from @ergots/scorex.

Sites refactored:
  [list the actual sites touched, e.g.:]
  - ergoscript: SAvlTree.valueLengthOpt encoding
  - nipopow: PoPowHeader.interlinks length-prefix
  - ergoscript: SColl wire codec length-prefix
  ...

Sites deliberately NOT refactored (with reason):
  - ergoscript SOption SValue parser — keeps SValueParseError throw on
    malformed tag (readOption would throw ReaderError, a behavior change)
  - ErgoBox.additionalRegisters — keyed, not a flat array

Test suite: 3318 tests pass. No behavior change beyond strict 0/1 boolean
tightening on SBoolean SValue parser (only if Step 4.3.3 source-read
confirmed sigma-rust does the same).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5: Delete transitional shims

### Task 5.1 — Audit shim usage and delete

**Files to delete (after confirming no callers remain):**
- Delete: `packages/nipopow/src/scorex/reader.ts`
- Delete: `packages/nipopow/src/scorex/writer.ts`
- Delete: `packages/nipopow/src/scorex/vlq.ts`
- Delete: `packages/nipopow/src/scorex/` (empty directory)
- Delete: `packages/nipopow/src/digests.ts`
- Delete: `packages/nipopow/src/header.ts` (or keep as type-only re-export, per spec "Open questions")
- Delete: `packages/nipopow/src/autolykos-solution.ts` (same caveat)
- Delete: `packages/ergoscript/src/wire/reader.ts`
- Delete: `packages/ergoscript/src/wire/writer.ts`

- [ ] **Step 5.1.1: Find remaining internal callers of each shim file.**

```bash
cd /home/mwaddip/projects/ergots
echo "=== nipopow scorex shims ==="
grep -rn "from.*['\"]\\.\\.*scorex/reader" packages/nipopow/src/ 2>/dev/null
grep -rn "from.*['\"]\\.\\.*scorex/writer" packages/nipopow/src/ 2>/dev/null
grep -rn "from.*['\"]\\.\\.*scorex/vlq" packages/nipopow/src/ 2>/dev/null
echo "=== nipopow Header/AutolykosSolution shims ==="
grep -rn "from.*['\"]\\.\\.*header\\b" packages/nipopow/src/ 2>/dev/null
grep -rn "from.*['\"]\\.\\.*autolykos-solution" packages/nipopow/src/ 2>/dev/null
grep -rn "from.*['\"]\\.\\.*digests" packages/nipopow/src/ 2>/dev/null
echo "=== ergoscript wire shims ==="
grep -rn "from.*['\"]\\.\\.*wire/reader" packages/ergoscript/src/ 2>/dev/null
grep -rn "from.*['\"]\\.\\.*wire/writer" packages/ergoscript/src/ 2>/dev/null
```

For each callable found, edit the import to point at `@ergots/scorex` instead. Example:

```ts
// before
import { ByteReader } from './scorex/reader.ts';
// after
import { ByteReader } from '@ergots/scorex';
```

- [ ] **Step 5.1.2: After all internal callers updated, run typecheck + tests.**

```bash
cd /home/mwaddip/projects/ergots
npx tsc --noEmit -p packages/nipopow/tsconfig.json 2>&1 | tail -5
npx tsc --noEmit -p packages/ergoscript/tsconfig.json 2>&1 | tail -5
npx vitest run packages/ 2>&1 | tail -10
```

Expected: zero TS errors; 3318 tests pass.

- [ ] **Step 5.1.3: Decide on `Header` / `AutolykosSolution` re-export from `@ergots/nipopow`.**

Per spec "Open questions": yes, re-export. Edit `packages/nipopow/src/index.ts` to add:

```ts
// Re-exports of scorex types for backward compatibility with external
// callers using `import { Header } from '@ergots/nipopow'`.
export type { Header, AutolykosSolution } from '@ergots/scorex';
```

Then delete the source files (the shims) — the re-export from `index.ts` covers any external consumer.

- [ ] **Step 5.1.4: Delete shim files.**

```bash
cd /home/mwaddip/projects/ergots
rm packages/nipopow/src/scorex/reader.ts
rm packages/nipopow/src/scorex/writer.ts
rm packages/nipopow/src/scorex/vlq.ts
rmdir packages/nipopow/src/scorex/ 2>/dev/null || true
rm packages/nipopow/src/header.ts
rm packages/nipopow/src/autolykos-solution.ts
rm packages/nipopow/src/digests.ts
rm packages/ergoscript/src/wire/reader.ts
rm packages/ergoscript/src/wire/writer.ts
```

- [ ] **Step 5.1.5: Re-run typecheck + tests.**

```bash
cd /home/mwaddip/projects/ergots
npx tsc --noEmit -p packages/nipopow/tsconfig.json 2>&1 | tail -5
npx tsc --noEmit -p packages/ergoscript/tsconfig.json 2>&1 | tail -5
npx vitest run packages/ 2>&1 | tail -15
```

Expected: zero errors; 3318 pass.

- [ ] **Step 5.1.6: Commit Phase 5.**

```bash
cd /home/mwaddip/projects/ergots
git add -A packages/nipopow/ packages/ergoscript/
git commit -m "$(cat <<'EOF'
refactor: delete transitional shims; nipopow + ergoscript import from @ergots/scorex

Phase 2h-c.0 step 5/6. After Phase 4's cleanup pass, all internal callers
in @ergots/nipopow and @ergots/ergoscript import the codec layer (ByteReader,
ByteWriter, VLQ, ReaderError) and block-header types (Header,
AutolykosSolution, digest helpers) directly from @ergots/scorex.

Deleted shim files:
  packages/nipopow/src/scorex/{reader,writer,vlq}.ts
  packages/nipopow/src/{header,autolykos-solution,digests}.ts
  packages/ergoscript/src/wire/{reader,writer}.ts

@ergots/nipopow's public surface re-exports Header and AutolykosSolution types
from @ergots/scorex via index.ts so external consumers using
'import { Header } from \"@ergots/nipopow\"' continue to work.

Test suite: 3318 tests pass. Cross-runtime green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6: `facts/scorex.md` + final verification

### Task 6.1 — Write `facts/scorex.md`

**Files:**
- Create: `facts/scorex.md`
- Modify: `facts/nipopow.md` (update Header/AutolykosSolution refs to point at scorex.md)
- Modify: `CLAUDE.md` (add `facts/scorex.md` to the read-first list)

- [ ] **Step 6.1.1: Write `facts/scorex.md` following the boundary-contract convention.**

Use `facts/avltree.md` as the structural template. Required sections:

1. Title + scope statement (one-paragraph)
2. Authoritative source-of-truth pointer (sigma-rust ergotree-ir + sigma-ser)
3. **Ships in this contract (v0.1.0)** — bullet list
4. **Does NOT ship** — bullet list (no Autolykos v2 verifier; no SValue/SType/Expr; no ErgoBox; no base58)
5. Public surface listing — code block with full ts signatures (ByteReader class API, ByteWriter class API, VLQ free functions, digest helpers, Header / AutolykosSolution types + codecs)
6. Type invariants — Header fields (33-byte ADDigest stateRoot, etc.), AutolykosSolution V1-vs-V2 differences
7. Cross-cutting guarantees — purity, sync, browser-compat, ESM-only, no-WASM
8. Test corpus — moved tests with counts (reader.test, writer.test, vlq.test, header.test, autolykos-solution.test, option-array.test)
9. Source mapping table — maps each scorex symbol to its sigma-rust/scorex-ser source location
10. Cross-references

Length target: ~250-300 lines (similar to `facts/avltree.md` v0.2.0).

- [ ] **Step 6.1.2: Update `facts/nipopow.md` to cross-reference scorex.md.**

Find the existing references to `Header`, `AutolykosSolution`, `ByteReader`, etc. in `facts/nipopow.md`. Replace inline definitions with one-line references like:

```
- `Header` — defined in [`facts/scorex.md`](./scorex.md); see that contract for the canonical shape and wire format.
```

- [ ] **Step 6.1.3: Update `CLAUDE.md` read-first list.**

Locate the "Read-first files" section in `CLAUDE.md`. Add `facts/scorex.md` as the first entry under `facts/`, since it's now the foundational contract that other facts files reference:

```
- `facts/scorex.md` — `@ergots/scorex` interface (codec layer + block-Header types; shared by other packages)
- `facts/nipopow.md` — `@ergots/nipopow` interface
- ... (existing list)
```

### Task 6.2 — Final verification + commit

- [ ] **Step 6.2.1: Run the project-wide verification command suite from CLAUDE.md.**

```bash
cd /home/mwaddip/projects/ergots
echo "=== typecheck all packages ==="
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
echo "=== test all packages (node) ==="
npx vitest run packages/
echo "=== test scorex under jsdom ==="
cd packages/scorex && npx vitest run --config vitest.browser.config.ts
cd /home/mwaddip/projects/ergots
echo "=== fixture-gen smoke check ==="
cd fixture-gen && cargo build --release 2>&1 | tail -5
```

Expected: zero TS errors; 3318 vitest pass under node; same pass under jsdom for scorex; cargo build clean (fixture-gen unaffected by this TS-side refactor).

- [ ] **Step 6.2.2: Commit Phase 6.**

```bash
cd /home/mwaddip/projects/ergots
git add facts/scorex.md facts/nipopow.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(scorex): add facts/scorex.md interface contract; update cross-refs

Phase 2h-c.0 step 6/6 — finalization. Adds the boundary-contract document
for @ergots/scorex v0.1.0 to facts/scorex.md, structured per the project's
existing facts/*.md convention (avltree.md as template).

facts/nipopow.md updated to cross-reference scorex.md for the now-shared
Header / AutolykosSolution / ByteReader / ByteWriter / VLQ surface.
CLAUDE.md read-first list updated to include facts/scorex.md.

Phase 2h-c.0 (extraction) complete. Successor phase 2h-c.1 (SHeader runtime
+ 17 method handlers in @ergots/ergoscript) lands separately.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6.2.3: Verify final repo state.**

```bash
cd /home/mwaddip/projects/ergots
git log --oneline -7
git status
```

Expected: 7 new commits since the audit-completion baseline (b9cabb8). Working tree clean modulo gitignored `audit20260519/`.

---

## Post-completion checklist

After all six phases land:

- [ ] All 3318 tests pass under both `node` and `jsdom`.
- [ ] `npx tsc --noEmit` clean for all four packages (scorex + nipopow + avltree + ergoscript).
- [ ] `cargo build --release` clean for fixture-gen (no fixture regeneration needed — TS-side refactor only).
- [ ] `packages/scorex/dist/` does NOT exist yet (no `npm run build` invoked; published-bundle smoke check is a separate publish-prep concern, not part of 2h-c.0).
- [ ] `facts/scorex.md` exists; `facts/nipopow.md` references it; `CLAUDE.md` lists it.
- [ ] Git working tree clean. ~6-7 commits ahead of `origin/master`. No push (per project workflow expectations — commits stay local until user requests push).

---

## Cross-references

- Spec: `docs/specs/2026-05-19-ergots-scorex-package-design.md`
- Sibling contract: `facts/avltree.md` (v0.2.0 — template for facts/scorex.md style + depth)
- Sibling contract: `facts/nipopow.md` (will be updated in Task 6.1.2)
- sigma-rust wire-format oracle: `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/` and `sigma-ser/src/vlq_encode.rs`
- Fleet SDK comparator: <https://github.com/fleet-sdk/fleet/tree/master/packages/serializer/src/coders>
- Audit-cleared baseline (this plan's starting point): commit `b9cabb8`
- Successor plan target: `docs/specs/2026-05-19-ergoscript-phase-2h-c-1-sheader-design.md` (TBD — written after 2h-c.0 lands)
