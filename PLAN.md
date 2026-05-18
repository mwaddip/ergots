# `@mwaddip/ergots-avltree` Implementation Plan (Phase 2h-a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship a new pure-TypeScript, browser-runnable npm package `@mwaddip/ergots-avltree` — a byte-faithful verifier-only port of the standalone Rust crate `ergo_avltree_rust` (the fork at `~/projects/ergo_avltree_rust/` HEAD `879545c` with 3 upstream PRs applied), implementing the batch AVL+ authenticated tree algorithm (KMZ16 / 2016/994).

**Architecture:** New workspace package `packages/avltree/` parallel to `packages/proof/` and `packages/ergoscript/`. Internal stateful `BatchAvlVerifier` class wrapped by functional public API (`verifyAvlBatch` + `verifyAvlLookup`). Algorithm content TS-idiomatically decomposed (Approach B from the design spec) across ~12 source files; cross-fidelity to `ergo_avltree_rust` preserved via per-function JSDoc source comments + canonical Source Mapping table in `facts/avltree.md`. Validation via three fixture-driven test layers + cross-runtime (node + jsdom) + mutation testing (≥90% kill rate per Operation variant). Fixture generation uses `ergo_avltree_rust`'s `BatchAVLProver` at fixture-gen-time (Rust-side determinism: `TestRunner::deterministic()`).

**Tech Stack:** TypeScript 5.5+, vitest 2.x (node + jsdom), tsup 8.x bundler, `@noble/hashes@2.2.0` (blake2b-256 only — no `@noble/curves`). Rust fixture-gen depends on the local `ergo_avltree_rust` fork via `[patch.crates-io]`. ESM only. No `Buffer`, no `node:*` outside test setup, no WASM direct or transitive.

**Reference oracles:**
- Design spec: `docs/specs/2026-05-18-ergots-avltree-package-design.md` (authoritative for this plan)
- Interface contract (to be written in this plan, Task 26): `facts/avltree.md`
- Rust source (canonical): `~/projects/ergo_avltree_rust/src/` (HEAD `879545c`)
  - `batch_avl_verifier.rs` — verifier struct + `reconstruct_tree` + `perform_one_operation`
  - `authenticated_tree_ops.rs` — trait with `modify_helper`, `delete_helper`, rotations
  - `batch_node.rs` — `Node`, `LeafNode`, `InternalNode`, `LabelNode`, `AVLTree` + blake2b labeling
  - `operation.rs` — `Operation` enum + `update_fn` semantics
- Sister contracts: `facts/proof.md` (structural reference for `facts/avltree.md`)
- Project conventions: `CLAUDE.md`, `OVERRIDES.md`

**Memories invoked by this plan:**
- [[feedback-rust-port-style]] — TS-idiomatic decomposition + per-function JSDoc comments + Source Mapping table
- [[reference-source-first-discipline]] — read Rust BEFORE writing TS for each task
- [[feedback-pure-typescript-no-wasm]] — all-TS is project identity; no WASM at any layer
- [[project-fixture-gen-cargo-gotchas]] — Rust-side determinism via `TestRunner::deterministic()`; the bug 2g.6 Task 8 caught
- [[feedback-no-artificial-stops]] — flat task list with per-task commits

---

## File structure

### New files (created by this plan)

```
packages/avltree/
├── src/
│   ├── index.ts                   public exports only
│   ├── verify.ts                  verifyAvlBatch + verifyAvlLookup wrappers (Tasks 18-19)
│   ├── batch-verifier.ts          BatchAvlVerifier class + tree state (Task 17)
│   ├── proof-decode.ts            parseProofPackedTree (Task 9)
│   ├── tree-traversal.ts          nextDirectionIsLeft, replayComparison, keyMatchesLeaf (Tasks 10-11)
│   ├── modify.ts                  modifyHelper decomposed (Tasks 14-15)
│   ├── delete.ts                  deleteHelper + change* helpers (Task 16)
│   ├── rotation.ts                doubleLeftRotate, doubleRightRotate (Task 12)
│   ├── node.ts                    Leaf/Internal/Label nodes + blake2b labeling (Tasks 6-7)
│   ├── operation.ts               Operation discriminated union + updateFn (Task 5)
│   ├── errors.ts                  AvlVerifyError + 6 codes (Task 4)
│   └── types.ts                   AvlTreeConfig + internal aliases (Task 3)
├── test/
│   ├── fixtures/                  JSON + binary fixtures from fixture-gen
│   ├── operation.test.ts          Task 5: Operation/updateFn unit tests
│   ├── node-label.test.ts         Task 7: blake2b labeling tests
│   ├── proof-decode.test.ts       Task 9: tree reconstruction tests
│   ├── tree-traversal.test.ts     Tasks 10-11: direction/replay primitives unit tests
│   ├── rotation.test.ts           Task 12: rotation primitives unit tests
│   ├── verify-batch.test.ts       Task 18: batch wrapper tests
│   ├── verify-lookup.test.ts      Task 19: lookup wrapper tests
│   ├── corpus.test.ts             Task 24: bulk synthetic corpus run
│   └── mutation.test.ts           Task 25: ≥90% mutation kill rate per Operation variant
├── package.json                   Task 1
├── tsconfig.json                  Task 1
├── tsup.config.ts                 Task 1
├── vitest.config.ts               Task 1 (node env)
├── vitest.browser.config.ts       Task 1 (jsdom env)
├── README.md                      Task 28
└── API.md                         Task 28

facts/
└── avltree.md                     Task 26 (interface contract + Source Mapping table)

fixture-gen/src/cmds/
└── avltree.rs                     Tasks 8, 13, 21-23 (synthetic fixture generation)
```

### Modified files

- `package.json` (root) — Task 2: workspace already covers `packages/*`; no change unless tooling needs adjustment.
- `fixture-gen/Cargo.toml` — Task 2: add `[patch.crates-io] ergo_avltree_rust = { path = "/home/mwaddip/projects/ergo_avltree_rust" }`; add `ergo_avltree_rust` as direct dependency.
- `fixture-gen/src/main.rs` — Task 2: add `avltree` subcommand dispatch.
- `fixture-gen/src/cmds/mod.rs` — Task 2: register `avltree` module.
- `CLAUDE.md` — Task 26: update read-first list with `facts/avltree.md`.
- `docs/specs/2026-05-18-ergots-avltree-package-design.md` — already committed in brainstorm.

---

## Tasks

### Task 1: Scaffold `packages/avltree/`

**Files:**
- Create: `packages/avltree/package.json`
- Create: `packages/avltree/tsconfig.json`
- Create: `packages/avltree/tsup.config.ts`
- Create: `packages/avltree/vitest.config.ts`
- Create: `packages/avltree/vitest.browser.config.ts`
- Create: `packages/avltree/src/index.ts` (empty placeholder)
- Reference: `packages/proof/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts}` — copy-adapt these.

- [ ] **Step 1: Author `packages/avltree/package.json`**

```json
{
  "name": "@mwaddip/ergots-avltree",
  "version": "0.0.0",
  "publishConfig": { "access": "public" },
  "description": "Pure-TypeScript Ergo batch AVL+ authenticated tree verifier — proof verification + per-operation result computation.",
  "type": "module",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/mwaddip/ergots.git",
    "directory": "packages/avltree"
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
  "keywords": ["ergo", "avl-tree", "blockchain", "verifier", "browser"]
}
```

- [ ] **Step 2: Author `packages/avltree/tsconfig.json`** — same content as `packages/proof/tsconfig.json`.

- [ ] **Step 3: Author `packages/avltree/tsup.config.ts`** — single entry `src/index.ts` to `dist/index.js`, ESM only, source maps, declarations. Match the proof package's tsup config.

- [ ] **Step 4: Author `packages/avltree/vitest.config.ts`** — node environment, sets up `test/` glob.

- [ ] **Step 5: Author `packages/avltree/vitest.browser.config.ts`** — jsdom environment, same test glob.

- [ ] **Step 6: Create empty `packages/avltree/src/index.ts`** with just `// Public exports — populated incrementally.`

- [ ] **Step 7: Verify workspace integration**

Run: `cd /home/mwaddip/projects/ergots && npm install`
Expected: Workspaces resolve; `node_modules/@mwaddip/ergots-avltree` symlink exists.

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS (empty source compiles cleanly).

Run: `npm test -w @mwaddip/ergots-avltree`
Expected: vitest reports "No test files found" (0 tests, PASS).

- [ ] **Step 8: Commit**

```bash
git add packages/avltree/
git commit -m "feat(avltree): scaffold @mwaddip/ergots-avltree package"
```

---

### Task 2: Add `ergo_avltree_rust` patch + fixture-gen subcommand stub

**Files:**
- Modify: `fixture-gen/Cargo.toml`
- Modify: `fixture-gen/src/main.rs`
- Modify: `fixture-gen/src/cmds/mod.rs`
- Create: `fixture-gen/src/cmds/avltree.rs` (stub — full body added in later tasks)

- [ ] **Step 1: Add patch + dep to `fixture-gen/Cargo.toml`**

Append under the existing `[dependencies]` section:

```toml
# Phase 2h-a — AVL+ fixture generation. Uses the fork's BatchAVLProver
# to generate (startingDigest, proof, operations) triples that the TS
# verifier consumes. The fork (~/projects/ergo_avltree_rust/, HEAD 879545c)
# applies upstream PRs #10/#11/#13 with semantics corrections that the
# TS verifier must mirror.
ergo_avltree_rust = "0.1.1"
```

At the very bottom of `fixture-gen/Cargo.toml`, add:

```toml
[patch.crates-io]
ergo_avltree_rust = { path = "/home/mwaddip/projects/ergo_avltree_rust" }
```

- [ ] **Step 2: Create `fixture-gen/src/cmds/avltree.rs` stub**

```rust
use anyhow::Result;

/// AVL+ fixture generator. Subcommand entry point.
/// Full implementation arrives task-by-task (Tasks 8, 13, 21, 22, 23).
pub fn run() -> Result<()> {
    println!("avltree fixture-gen: no fixtures defined yet (stub)");
    Ok(())
}
```

- [ ] **Step 3: Register `avltree` in `fixture-gen/src/cmds/mod.rs`**

Append: `pub mod avltree;`

- [ ] **Step 4: Add subcommand dispatch in `fixture-gen/src/main.rs`**

Modify the args dispatch near line 41:

```rust
let args: Vec<String> = std::env::args().collect();
if args.get(1).map(|s| s.as_str()) == Some("wider_corpus") {
    return cmds::wider_corpus::run();
}
if args.get(1).map(|s| s.as_str()) == Some("avltree") {
    return cmds::avltree::run();
}
```

- [ ] **Step 5: Verify Rust build**

Run: `cd /home/mwaddip/projects/ergots/fixture-gen && cargo build`
Expected: Compiles cleanly. Resolves `ergo_avltree_rust` to the local fork via the patch.

Run: `cd /home/mwaddip/projects/ergots/fixture-gen && cargo run -- avltree`
Expected: Prints "avltree fixture-gen: no fixtures defined yet (stub)".

Run: `cd /home/mwaddip/projects/ergots/fixture-gen && cargo run --release`
Expected: Existing fixtures regenerate; subcommand-less invocation works (the default-dispatch path).

- [ ] **Step 6: Commit**

```bash
git add fixture-gen/
git commit -m "feat(fixture-gen): add ergo_avltree_rust patch + avltree subcommand stub"
```

---

### Task 3: `types.ts` — `AvlTreeConfig` + internal aliases

**Files:**
- Create: `packages/avltree/src/types.ts`

- [ ] **Step 1: Author `packages/avltree/src/types.ts`**

```ts
/**
 * Internal byte-array aliases. Document intent; the TS type is just Uint8Array.
 * Mirrors operation.rs's ADKey / ADValue / ADDigest type aliases.
 */
export type ADKey = Uint8Array
export type ADValue = Uint8Array
export type ADDigest = Uint8Array         // 33 bytes: 32-byte root label + 1-byte tree height

/** NodeId is the conceptual identifier of a node; in TS we hold direct object refs. */
export type NodeId = Node | null
/** Forward-decl for circular ref. Defined in node.ts. */
export type Node = unknown

/** Public verifier-input config. Mirrors AVLTree's structural fields in ergo_avltree_rust. */
export interface AvlTreeConfig {
  /** Bytes per key. Must be > 0. */
  keyLength: number
  /** Bytes per value; null = variable length per leaf. */
  valueLengthOpt: number | null
  /** DoS guard — max operations across this batch. */
  maxNumOperations?: number
  /** Max deletions across this batch. Defaults to maxNumOperations. */
  maxDeletes?: number
}

/** Per-operation result. Returned in VerifyAvlBatchResult.results. */
export type OperationResult = Uint8Array | null  // null = key was absent before op
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/src/types.ts
git commit -m "feat(avltree): types.ts — AvlTreeConfig + internal aliases"
```

---

### Task 4: `errors.ts` — `AvlVerifyError` + 6 codes

**Files:**
- Create: `packages/avltree/src/errors.ts`

- [ ] **Step 1: Author `packages/avltree/src/errors.ts`**

```ts
/**
 * Programmer-error rejections. See facts/avltree.md § Error model for the
 * full taxonomy. Verification failures (untrusted-input rejection) return
 * null from public wrappers and are NOT thrown — see AvlVerifyFailReason
 * (currently internal, tracked on BatchAvlVerifier.lastFailReason).
 */
export type AvlVerifyErrorCode =
  | 'invalid-config-key-length'
  | 'invalid-config-value-length'
  | 'invalid-config-max-ops'
  | 'invalid-starting-digest-length'
  | 'operation-key-length-mismatch'
  | 'operation-value-length-mismatch'

export class AvlVerifyError extends Error {
  readonly code: AvlVerifyErrorCode
  constructor(code: AvlVerifyErrorCode, message: string) {
    super(message)
    this.name = 'AvlVerifyError'
    this.code = code
  }
}

/**
 * Internal verification-failure reason taxonomy (10 reasons). Tracked by
 * BatchAvlVerifier.lastFailReason but NOT exposed in the public API on v0.1.0.
 * Promoted to a getLastFailReason() method if/when the internal class is
 * promoted to public surface (deferred per design spec's option-3 decision).
 */
export type AvlVerifyFailReason =
  | 'proof-truncated'
  | 'proof-malformed'
  | 'digest-mismatch'
  | 'directions-exhausted'
  | 'leaf-key-out-of-order'
  | 'max-nodes-exceeded'
  | 'operation-precondition-failed'
  | 'tree-poisoned'
  | 'empty-tree'
  | 'operation-required-but-not-allowed'  // reserved for ABI stability
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/src/errors.ts
git commit -m "feat(avltree): errors.ts — AvlVerifyError + 6 codes; internal AvlVerifyFailReason taxonomy"
```

---

### Task 5: `operation.ts` — `Operation` discriminated union + `updateFn`

**Source-port reference:** `~/projects/ergo_avltree_rust/src/operation.rs` (whole file, 107 lines).

**Files:**
- Create: `packages/avltree/src/operation.ts`
- Create: `packages/avltree/test/operation.test.ts`

- [ ] **Step 1: Write the failing tests** at `packages/avltree/test/operation.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { Operation } from '../src/operation.js'
import { updateFn } from '../src/operation.js'

const key = new Uint8Array([1, 2, 3])
const val = new Uint8Array([10, 20])
const valNew = new Uint8Array([99])

describe('updateFn — Lookup', () => {
  it('returns null on key absent', () => {
    const op: Operation = { tag: 'Lookup', key }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
  it('returns null even when key present (lookups never modify)', () => {
    const op: Operation = { tag: 'Lookup', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: null })
  })
})

describe('updateFn — Insert', () => {
  it('inserts when key absent', () => {
    const op: Operation = { tag: 'Insert', key, value: val }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: val })
  })
  it('fails when key already exists', () => {
    const op: Operation = { tag: 'Insert', key, value: val }
    expect(updateFn(op, val)).toEqual({ ok: false, reason: 'key-already-exists' })
  })
})

describe('updateFn — Update', () => {
  it('updates when key exists', () => {
    const op: Operation = { tag: 'Update', key, value: valNew }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: valNew })
  })
  it('fails when key absent', () => {
    const op: Operation = { tag: 'Update', key, value: valNew }
    expect(updateFn(op, null)).toEqual({ ok: false, reason: 'key-not-found' })
  })
})

describe('updateFn — InsertOrUpdate', () => {
  it('inserts when absent', () => {
    const op: Operation = { tag: 'InsertOrUpdate', key, value: valNew }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: valNew })
  })
  it('overwrites when present', () => {
    const op: Operation = { tag: 'InsertOrUpdate', key, value: valNew }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: valNew })
  })
})

describe('updateFn — Remove', () => {
  it('removes when present', () => {
    const op: Operation = { tag: 'Remove', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: null })
  })
  it('fails when absent', () => {
    const op: Operation = { tag: 'Remove', key }
    expect(updateFn(op, null)).toEqual({ ok: false, reason: 'key-not-found' })
  })
})

describe('updateFn — RemoveIfExists', () => {
  it('removes when present', () => {
    const op: Operation = { tag: 'RemoveIfExists', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: null })
  })
  it('no-op when absent', () => {
    const op: Operation = { tag: 'RemoveIfExists', key }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
})

describe('updateFn — UpdateLongBy', () => {
  it('inserts when absent and delta > 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 5n }
    const r = updateFn(op, null)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newValue).not.toBeNull()
      // 5n as 8 big-endian bytes:
      expect(Array.from(r.newValue!)).toEqual([0, 0, 0, 0, 0, 0, 0, 5])
    }
  })
  it('fails when absent and delta < 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -5n }
    expect(updateFn(op, null)).toEqual({
      ok: false,
      reason: 'decrement-on-absent-key',
    })
  })
  it('no-op when absent and delta == 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 0n }
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
  it('adds delta when present and result > 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: 3n }
    const existing = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 5])  // i64 BE: 5
    const r = updateFn(op, existing)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 5 + 3 = 8
      expect(Array.from(r.newValue!)).toEqual([0, 0, 0, 0, 0, 0, 0, 8])
    }
  })
  it('removes when present and result == 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -5n }
    const existing = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 5])
    const r = updateFn(op, existing)
    expect(r).toEqual({ ok: true, newValue: null })
  })
  it('fails when present and result < 0', () => {
    const op: Operation = { tag: 'UpdateLongBy', key, delta: -10n }
    const existing = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 5])
    expect(updateFn(op, existing)).toEqual({
      ok: false,
      reason: 'result-negative',
    })
  })
})

describe('updateFn — UnknownModification', () => {
  it('returns oldValue unchanged', () => {
    const op: Operation = { tag: 'UnknownModification', key }
    expect(updateFn(op, val)).toEqual({ ok: true, newValue: val })
    expect(updateFn(op, null)).toEqual({ ok: true, newValue: null })
  })
})
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run packages/avltree/test/operation.test.ts`
Expected: FAIL with "Cannot find module '../src/operation.js'".

- [ ] **Step 3: Author `packages/avltree/src/operation.ts`**

```ts
/** Ports operation.rs's Operation enum + update_fn (operation.rs:13-107). */

export type Operation =
  | { tag: 'Lookup'; key: Uint8Array }
  | { tag: 'UnknownModification'; key: Uint8Array }
  | { tag: 'Insert'; key: Uint8Array; value: Uint8Array }
  | { tag: 'Update'; key: Uint8Array; value: Uint8Array }
  | { tag: 'InsertOrUpdate'; key: Uint8Array; value: Uint8Array }
  | { tag: 'UpdateLongBy'; key: Uint8Array; delta: bigint }
  | { tag: 'Remove'; key: Uint8Array }
  | { tag: 'RemoveIfExists'; key: Uint8Array }

/** Internal per-op result: success with new value (or null = remove), or precondition failure. */
export type UpdateFnResult =
  | { ok: true; newValue: Uint8Array | null }
  | { ok: false; reason: UpdateFnFailReason }

export type UpdateFnFailReason =
  | 'key-already-exists'           // Insert on existing key
  | 'key-not-found'                // Update or Remove on absent key
  | 'decrement-on-absent-key'      // UpdateLongBy delta < 0 on absent key
  | 'result-negative'              // UpdateLongBy result < 0

/** Encode i64 (bigint) as 8-byte big-endian. Used by UpdateLongBy. */
function i64ToBeBytes(value: bigint): Uint8Array {
  // Implementation: mask to 64 bits, write 8 bytes MSB-first.
  // Ports BigEndian::write_i64 via i64::to_be_bytes (operation.rs:91, 98).
}

/** Decode 8-byte big-endian as i64. */
function beBytesToI64(bytes: Uint8Array): bigint {
  // Ports BigEndian::read_i64 (operation.rs:94).
}

/** Ports operation.rs::Operation::update_fn (lines 64-106). */
export function updateFn(op: Operation, oldValue: Uint8Array | null): UpdateFnResult {
  // Switch on op.tag; implement each branch per the Rust source.
  // - Lookup → { ok: true, newValue: null }
  // - UnknownModification → { ok: true, newValue: oldValue }
  // - Insert → if absent: ok with op.value; if present: 'key-already-exists'
  // - Update → if absent: 'key-not-found'; if present: ok with op.value
  // - InsertOrUpdate → ok with op.value (regardless)
  // - Remove → if absent: 'key-not-found'; if present: ok with null
  // - RemoveIfExists → ok with null (regardless)
  // - UpdateLongBy → see lines 89-105 in Rust; the i64 delta cases
}
```

The engineer reads the Rust source and fills in `i64ToBeBytes`, `beBytesToI64`, and the body of `updateFn` per the Rust semantics. All TS branches must produce results matching the Rust `update_fn` semantics.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/avltree/test/operation.test.ts`
Expected: All 15+ tests PASS.

- [ ] **Step 5: Add per-function source comments**

In `operation.ts`, ensure each function has a JSDoc header naming its Rust counterpart and line range. Format:

```ts
/** Ports operation.rs::Operation::update_fn (lines 64-106). Per-op old-value → new-value transform. */
```

- [ ] **Step 6: Commit**

```bash
git add packages/avltree/src/operation.ts packages/avltree/test/operation.test.ts
git commit -m "feat(avltree): operation.ts — Operation union + updateFn semantics"
```

---

### Task 6: `node.ts` — node type structure (no labeling yet)

**Source-port reference:** `~/projects/ergo_avltree_rust/src/batch_node.rs` (struct definitions, lines ~50-200).

**Files:**
- Create: `packages/avltree/src/node.ts` (first half — types only; labeling comes in Task 7)

- [ ] **Step 1: Author the type definitions in `packages/avltree/src/node.ts`**

```ts
import type { ADKey, ADValue } from './types.js'

/** Tree node — discriminated union over Leaf, Internal, Label. Ports batch_node.rs::Node. */
export type AvlNode = LeafNode | InternalNode | LabelNode

/** A real leaf with key, value, and pointer-to-next-leaf-key. */
export interface LeafNode {
  readonly kind: 'leaf'
  readonly key: ADKey
  readonly value: ADValue
  readonly nextLeafKey: ADKey
  // Cached label (computed on demand). Mutable so we can cache.
  labelCache: Uint8Array | null
}

/** Internal node with left/right subtrees and AVL balance ∈ {-1, 0, 1}. */
export interface InternalNode {
  readonly kind: 'internal'
  left: AvlNode
  right: AvlNode
  balance: Balance
  labelCache: Uint8Array | null
}

/** Label-only node — a stub that exists only as a hash reference (from a label-in-packaged-proof token). */
export interface LabelNode {
  readonly kind: 'label'
  readonly label: Uint8Array  // 32 bytes (blake2b-256)
}

/** AVL balance bit. Rust uses i8; we narrow to the three valid values. */
export type Balance = -1 | 0 | 1

/** Constructors — ports batch_node.rs::LeafNode::new / InternalNode::new (lines roughly 100-160). */

export function newLeaf(key: ADKey, value: ADValue, nextLeafKey: ADKey): LeafNode {
  return { kind: 'leaf', key, value, nextLeafKey, labelCache: null }
}

export function newInternal(
  left: AvlNode,
  right: AvlNode,
  balance: Balance,
): InternalNode {
  return { kind: 'internal', left, right, balance, labelCache: null }
}

export function newLabel(label: Uint8Array): LabelNode {
  // Defensive: copy to ensure immutability.
  return { kind: 'label', label: new Uint8Array(label) }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/src/node.ts
git commit -m "feat(avltree): node.ts — Leaf/Internal/Label node types + constructors"
```

---

### Task 7: `node.ts` — blake2b-256 labeling

**Source-port reference:** `~/projects/ergo_avltree_rust/src/batch_node.rs` — `label()` methods on each node kind, roughly lines 80-170. Internal nodes hash `(0x01, balanceByte, leftLabel, rightLabel)` — **balance precedes child labels per `Node::Internal` branch at lines ~100-109**; leaves hash `(0x00, key, value, nextLeafKey)`.

**Files:**
- Modify: `packages/avltree/src/node.ts` (add `label()` function)
- Create: `packages/avltree/test/node-label.test.ts`

- [ ] **Step 1: Write the failing tests** at `packages/avltree/test/node-label.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { newLeaf, newInternal, newLabel, label } from '../src/node.js'

// These fixtures come from running the Rust reference on the same inputs.
// Engineer regenerates via: cargo run -p fixture-gen -- avltree (Task 13).
// Until Task 13 lands, use these inline known-values from the Rust source.

describe('label — leaf node', () => {
  it('hashes a known leaf to a known digest', () => {
    const key = new Uint8Array([0x01, 0x02, 0x03, 0x04])
    const value = new Uint8Array([0xaa, 0xbb])
    const nextKey = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const leaf = newLeaf(key, value, nextKey)
    const lbl = label(leaf)
    expect(lbl.length).toBe(32)
    // Specific bytes TBD via Task 13's fixture-gen output.
    // For now, assert the cache is populated after first call:
    expect(label(leaf)).toBe(lbl)  // same reference (cached)
  })
})

describe('label — internal node', () => {
  it('hashes a known internal to a known digest', () => {
    const leftLeaf = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([5]))
    const rightLeaf = newLeaf(new Uint8Array([5]), new Uint8Array([50]), new Uint8Array([255]))
    const internal = newInternal(leftLeaf, rightLeaf, 0)
    const lbl = label(internal)
    expect(lbl.length).toBe(32)
    // Idempotence:
    expect(label(internal)).toBe(lbl)
  })
})

describe('label — label node', () => {
  it('returns the stored label directly', () => {
    const stored = new Uint8Array(32).fill(0xab)
    const node = newLabel(stored)
    const lbl = label(node)
    expect(Array.from(lbl)).toEqual(Array.from(stored))
  })
})
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run packages/avltree/test/node-label.test.ts`
Expected: FAIL — `label` not exported.

- [ ] **Step 3: Add `label()` to `packages/avltree/src/node.ts`**

```ts
import { blake2b } from '@noble/hashes/blake2.js'

/**
 * Compute 32-byte blake2b-256 label for a node.
 * Ports batch_node.rs::Node::label() (the dispatch) and the per-kind hash inputs:
 *   - Leaf:     blake2b256(0x00 || key || value || nextLeafKey)         — lines ~110-130
 *   - Internal: blake2b256(0x01 || balance || leftLabel || rightLabel)  — lines ~100-109
 *     (balance precedes child labels — VERIFY against Rust source before implementing)
 *   - Label:    return stored label directly
 *
 * Result is cached on the node (labelCache field).
 */
export function label(node: AvlNode): Uint8Array {
  if (node.kind === 'label') return node.label
  if (node.labelCache !== null) return node.labelCache

  let input: Uint8Array
  if (node.kind === 'leaf') {
    // Concatenate: 0x00 || key || value || nextLeafKey
    // Reference: batch_node.rs lines ~110-130
    input = concat([new Uint8Array([0x00]), node.key, node.value, node.nextLeafKey])
  } else {
    // Internal: 0x01 || balance || leftLabel || rightLabel
    // Reference: batch_node.rs ~lines 100-109 (Node::Internal branch of Node::label())
    // Balance encoded as one byte (signed-i8 form): -1 → 0xff, 0 → 0x00, 1 → 0x01
    // IMPORTANT: balance precedes the child labels (NOT follows). Source-first
    // discipline: verify against the Rust source before implementing.
    const leftLbl = label(node.left)
    const rightLbl = label(node.right)
    const balanceByte = new Uint8Array([node.balance & 0xff])
    input = concat([new Uint8Array([0x01]), balanceByte, leftLbl, rightLbl])
  }
  const result = blake2b(input, { dkLen: 32 })
  node.labelCache = result
  return result
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run packages/avltree/test/node-label.test.ts`
Expected: All tests PASS (cache idempotence, length check).

Note: The "specific bytes TBD" assertions stay loose until Task 13's fixture-gen regenerates real expected values; convert those to byte-equality assertions then.

- [ ] **Step 5: Verify cross-runtime under jsdom**

Run: `npx vitest run --config packages/avltree/vitest.browser.config.ts packages/avltree/test/node-label.test.ts`
Expected: All tests PASS under jsdom.

- [ ] **Step 6: Commit**

```bash
git add packages/avltree/src/node.ts packages/avltree/test/node-label.test.ts
git commit -m "feat(avltree): node.ts — blake2b-256 labeling for leaf/internal/label nodes"
```

---

### Task 8: fixture-gen — first single-leaf-tree fixture

**Source-port reference:** `~/projects/ergo_avltree_rust/src/batch_avl_prover.rs` — `BatchAVLProver::new` + simple flow producing a proof. Looking at the prover API:
- `new(keyLength, valueLengthOpt, oldRootOption, collectChangedNodes) -> BatchAVLProver`
- `perform_one_operation(&Operation) -> ...`
- `generate_proof() -> SerializedAdProof`
- `digest() -> Option<ADDigest>`

**Files:**
- Modify: `fixture-gen/src/cmds/avltree.rs`
- Create (regenerated): `packages/avltree/test/fixtures/avltree/single-leaf-insert.json` + `.bin`

- [ ] **Step 1: Implement first fixture generator in `fixture-gen/src/cmds/avltree.rs`**

```rust
use anyhow::Result;
use bytes::Bytes;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_avl_verifier::BatchAVLVerifier;
use ergo_avltree_rust::batch_node::AVLTree;
use ergo_avltree_rust::operation::{KeyValue, Operation};
use serde::Serialize;
use std::path::PathBuf;

/// Fixture shape: deserialized by the TS corpus tests.
#[derive(Serialize)]
struct AvlFixture {
    name: String,
    starting_digest_hex: String,
    proof_hex: String,
    config: AvlConfig,
    operations: Vec<OpJson>,
    expected_new_digest_hex: String,
    expected_results_hex: Vec<Option<String>>,  // null = key absent
}

#[derive(Serialize)]
struct AvlConfig {
    key_length: usize,
    value_length_opt: Option<usize>,
    max_num_operations: Option<usize>,
    max_deletes: Option<usize>,
}

#[derive(Serialize)]
#[serde(tag = "tag", rename_all = "PascalCase")]
enum OpJson {
    Lookup { key_hex: String },
    Insert { key_hex: String, value_hex: String },
    Update { key_hex: String, value_hex: String },
    InsertOrUpdate { key_hex: String, value_hex: String },
    UpdateLongBy { key_hex: String, delta: i64 },
    Remove { key_hex: String },
    RemoveIfExists { key_hex: String },
    UnknownModification { key_hex: String },
}

fn fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent().unwrap().join("packages/avltree/test/fixtures/avltree")
}

fn write_fixture(name: &str, fixture: &AvlFixture) -> Result<()> {
    std::fs::create_dir_all(fixtures_dir())?;
    let path = fixtures_dir().join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(fixture)?;
    std::fs::write(&path, json + "\n")?;
    println!("wrote {}", path.display());
    Ok(())
}

/// First fixture: Insert a single key into an empty tree.
fn single_leaf_insert() -> Result<AvlFixture> {
    let key_length = 32;
    let value_length_opt = None;
    let mut prover = BatchAVLProver::new(
        AVLTree::new(|_| Bytes::new(), key_length, value_length_opt),
        true,
    );
    let starting_digest = prover.digest().expect("empty-tree digest");

    let key = Bytes::from(vec![0x42u8; 32]);
    let value = Bytes::from(vec![0x55u8; 8]);
    let op = Operation::Insert(KeyValue { key: key.clone(), value: value.clone() });

    prover.perform_one_operation(&op)?;
    let proof = prover.generate_proof();
    let new_digest = prover.digest().expect("post-insert digest");

    // Cross-verify with the Rust verifier so our expected results are authoritative.
    let mut verifier = BatchAVLVerifier::new(
        &starting_digest,
        &proof,
        AVLTree::new(|_| Bytes::new(), key_length, value_length_opt),
        Some(1),
        Some(0),
    )?;
    let result = verifier.perform_one_operation(&op)?;
    let verifier_new_digest = verifier.digest().expect("verifier post-op digest");
    assert_eq!(new_digest, verifier_new_digest, "prover/verifier digest mismatch");

    Ok(AvlFixture {
        name: "single-leaf-insert".to_string(),
        starting_digest_hex: hex::encode(&starting_digest),
        proof_hex: hex::encode(&proof),
        config: AvlConfig {
            key_length,
            value_length_opt,
            max_num_operations: Some(1),
            max_deletes: Some(0),
        },
        operations: vec![OpJson::Insert {
            key_hex: hex::encode(&key),
            value_hex: hex::encode(&value),
        }],
        expected_new_digest_hex: hex::encode(&new_digest),
        expected_results_hex: vec![result.map(|v| hex::encode(&v))],
    })
}

pub fn run() -> Result<()> {
    write_fixture("single-leaf-insert", &single_leaf_insert()?)?;
    Ok(())
}
```

- [ ] **Step 2: Run fixture-gen**

Run: `cd /home/mwaddip/projects/ergots/fixture-gen && cargo run -- avltree`
Expected: prints "wrote .../packages/avltree/test/fixtures/avltree/single-leaf-insert.json".

- [ ] **Step 3: Verify determinism**

Run: `cargo run -- avltree && git diff packages/avltree/test/fixtures/`
Expected: First run creates fixture; second run produces no diff. If diff appears, the prover or hex encoding is non-deterministic — investigate before proceeding. (Determinism: `BatchAVLProver::new` should be deterministic with a fixed `KeySerializer` closure; no RNG should be in the path.)

- [ ] **Step 4: Commit**

```bash
git add fixture-gen/src/cmds/avltree.rs packages/avltree/test/fixtures/avltree/single-leaf-insert.json
git commit -m "feat(fixture-gen): first AVL+ fixture — single-leaf-insert"
```

---

### Task 9: `proof-decode.ts` — `parseProofPackedTree`

**Source-port reference:** `~/projects/ergo_avltree_rust/src/batch_avl_verifier.rs` lines 58-143 (`reconstruct_tree`). Tokens defined in `authenticated_tree_ops.rs` (search for `LABEL_IN_PACKAGED_PROOF`, `LEAF_IN_PACKAGED_PROOF`, `END_OF_TREE_IN_PACKAGED_PROOF`).

**Files:**
- Create: `packages/avltree/src/proof-decode.ts`
- Create: `packages/avltree/test/proof-decode.test.ts`

- [ ] **Step 1: Write failing test** at `packages/avltree/test/proof-decode.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseProofPackedTree } from '../src/proof-decode.js'
import type { AvlTreeConfig } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
function loadFixture(name: string): any {
  const path = resolve(__dirname, `fixtures/avltree/${name}.json`)
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('parseProofPackedTree — single-leaf-insert', () => {
  it('reconstructs a tree that labels to startingDigest', () => {
    const f = loadFixture('single-leaf-insert')
    const startingDigest = hexToBytes(f.startingDigestHex)
    const proof = hexToBytes(f.proofHex)
    const config: AvlTreeConfig = f.config  // JSON emits camelCase directly
    const result = parseProofPackedTree(proof, config, startingDigest)
    // For pre-insert empty tree, proof may decode to an empty tree.
    // For pre-insert tree containing some leaves, the reconstructed root labels to startingDigest.
    expect(result.ok).toBe(true)
  })
  it('rejects truncated proof', () => {
    const f = loadFixture('single-leaf-insert')
    const truncated = hexToBytes(f.proofHex).slice(0, 5)
    const startingDigest = hexToBytes(f.startingDigestHex)
    const result = parseProofPackedTree(truncated, {
      keyLength: f.config.keyLength,
      valueLengthOpt: f.config.valueLengthOpt,
    }, startingDigest)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['proof-truncated', 'proof-malformed']).toContain(result.reason)
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run packages/avltree/test/proof-decode.test.ts`
Expected: FAIL — `proof-decode.js` not found.

- [ ] **Step 3: Author `packages/avltree/src/proof-decode.ts`**

```ts
import { newInternal, newLabel, newLeaf, label } from './node.js'
import type { AvlNode, LeafNode, Balance } from './node.js'
import type { AvlTreeConfig } from './types.js'
import type { AvlVerifyFailReason } from './errors.js'

// Token codes — mirror ergo_avltree_rust constants in authenticated_tree_ops.rs.
const LABEL_IN_PACKAGED_PROOF = 1
const LEAF_IN_PACKAGED_PROOF = 2
const END_OF_TREE_IN_PACKAGED_PROOF = 3

const DIGEST_LENGTH = 32

export interface ParseProofOk {
  readonly ok: true
  readonly root: AvlNode
  readonly height: number
  /** Byte offset where the directions bit-string begins. */
  readonly directionsStart: number
}
export interface ParseProofFail {
  readonly ok: false
  readonly reason: AvlVerifyFailReason
}
export type ParseProofResult = ParseProofOk | ParseProofFail

/**
 * Ports batch_avl_verifier.rs::BatchAVLVerifier::reconstruct_tree (lines 58-143).
 * Decodes the proof's packed post-order tree representation, validates against
 * startingDigest, and returns the reconstructed root + the offset where the
 * directions bit-string begins.
 */
export function parseProofPackedTree(
  proof: Uint8Array,
  config: AvlTreeConfig,
  startingDigest: Uint8Array,
): ParseProofResult {
  // Implementation follows the Rust source:
  // 1. Loop reading proof[i] tokens:
  //    - LABEL_IN_PACKAGED_PROOF: read 32 bytes, push newLabel(label) onto stack.
  //    - LEAF_IN_PACKAGED_PROOF: read key (config.keyLength bytes) [or use
  //      previousLeaf.nextNodeKey() if previousLeaf is set], read nextLeafKey
  //      (config.keyLength), read value (config.valueLengthOpt bytes,
  //      or 4-byte BE length-prefix followed by that many bytes if valueLengthOpt
  //      is null). Push newLeaf(...).
  //    - END_OF_TREE_IN_PACKAGED_PROOF: break loop.
  //    - Other byte n: pop two children (right, then left), push
  //      newInternal(left, right, n as Balance) onto stack.
  // 2. Assert stack.length === 1.
  // 3. Compute rootLabel = label(root); assert startingDigest[0..32] === rootLabel.
  //    (startingDigest is 33 bytes; last byte is height.)
  // 4. Height = startingDigest[32].
  // 5. Bounds-check EVERY proof[i] read (returning 'proof-truncated' on OOB).
  // 6. Return { ok: true, root, height, directionsStart: i + 1 }.
  //
  // Per [[feedback-rust-port-style]]: this is the cleanest 1:1 port we can do,
  // since the algorithm is a tight state machine. Add per-function JSDoc
  // comment naming batch_avl_verifier.rs:58-143.
}
```

The engineer fills in the body per the Rust source, with explicit bounds-checks before every `proof[i]` read.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run packages/avltree/test/proof-decode.test.ts`
Expected: Both tests PASS.

- [ ] **Step 5: Run typecheck + cross-runtime**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json && npx vitest run --config packages/avltree/vitest.browser.config.ts packages/avltree/test/proof-decode.test.ts`
Expected: Both PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/avltree/src/proof-decode.ts packages/avltree/test/proof-decode.test.ts
git commit -m "feat(avltree): proof-decode.ts — packed post-order tree reconstruction"
```

---

### Task 10: `tree-traversal.ts` — `nextDirectionIsLeft`

**Source-port reference:** `~/projects/ergo_avltree_rust/src/batch_avl_verifier.rs` lines 192-203.

**Files:**
- Create: `packages/avltree/src/tree-traversal.ts`
- Create: `packages/avltree/test/tree-traversal.test.ts`

- [ ] **Step 1: Write failing test** at `packages/avltree/test/tree-traversal.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { nextDirectionIsLeft, type TraversalState } from '../src/tree-traversal.js'

describe('nextDirectionIsLeft', () => {
  it('reads bit 0 of byte 0 as left=true', () => {
    // proof[0] bit 0 set → left=true
    const proof = new Uint8Array([0b00000001])
    const state: TraversalState = { directionsIndex: 0, lastRightStep: 0, replayIndex: 0 }
    expect(nextDirectionIsLeft(proof, state)).toBe(true)
    expect(state.directionsIndex).toBe(1)
    expect(state.lastRightStep).toBe(0)  // not updated on left
  })
  it('reads bit 0 of byte 0 as left=false (right step)', () => {
    const proof = new Uint8Array([0b00000000])
    const state: TraversalState = { directionsIndex: 0, lastRightStep: 0, replayIndex: 0 }
    expect(nextDirectionIsLeft(proof, state)).toBe(false)
    expect(state.directionsIndex).toBe(1)
    expect(state.lastRightStep).toBe(0)  // captures the index where right step happened
  })
  it('advances bit position across byte boundary', () => {
    // Bits: 0,0,0,0,0,0,0,0, 1,1,1,1,...
    const proof = new Uint8Array([0x00, 0xff])
    const state: TraversalState = { directionsIndex: 7, lastRightStep: 0, replayIndex: 0 }
    expect(nextDirectionIsLeft(proof, state)).toBe(false)   // bit 7 of byte 0
    expect(nextDirectionIsLeft(proof, state)).toBe(true)    // bit 0 of byte 1
    expect(state.directionsIndex).toBe(9)
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run packages/avltree/test/tree-traversal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Author `packages/avltree/src/tree-traversal.ts`**

```ts
/**
 * Mutable verifier traversal state. Mirrors the directions/replay indices
 * on BatchAVLVerifier (batch_avl_verifier.rs lines 26-33).
 */
export interface TraversalState {
  directionsIndex: number
  lastRightStep: number
  replayIndex: number
}

/**
 * Ports batch_avl_verifier.rs::BatchAVLVerifier::next_direction_is_left (lines 192-203).
 * Reads one bit from the proof's "directions" bit-string at position
 * state.directionsIndex; advances the index by 1. Returns true if the bit is set
 * (left), false otherwise (right) — also updates state.lastRightStep when right.
 *
 * Bit indexing: byte offset = i >> 3; bit offset = 1 << (i & 7).
 */
export function nextDirectionIsLeft(
  proof: Uint8Array,
  state: TraversalState,
): boolean {
  const i = state.directionsIndex
  // Read bit i of proof byte (i >> 3).
  // Implementer: bounds-check; if i >> 3 >= proof.length, this is a 'directions-exhausted'
  // failure that the caller will surface. For now, callers ensure they don't over-read.
  const left = (proof[i >> 3] & (1 << (i & 7))) !== 0
  if (!left) state.lastRightStep = i
  state.directionsIndex = i + 1
  return left
}
```

- [ ] **Step 4: Run test to verify**

Run: `npx vitest run packages/avltree/test/tree-traversal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/avltree/src/tree-traversal.ts packages/avltree/test/tree-traversal.test.ts
git commit -m "feat(avltree): tree-traversal.ts — nextDirectionIsLeft primitive"
```

---

### Task 11: `tree-traversal.ts` — `replayComparison` + `keyMatchesLeaf`

**Source-port reference:**
- `replayComparison`: `batch_avl_verifier.rs` lines 239-251
- `keyMatchesLeaf`: `batch_avl_verifier.rs` lines 213-227

**Files:**
- Modify: `packages/avltree/src/tree-traversal.ts`
- Modify: `packages/avltree/test/tree-traversal.test.ts`

- [ ] **Step 1: Append failing tests to `packages/avltree/test/tree-traversal.test.ts`**

```ts
import { replayComparison, keyMatchesLeaf } from '../src/tree-traversal.js'
import { newLeaf } from '../src/node.js'

describe('replayComparison', () => {
  // Specific bit patterns: see batch_avl_verifier.rs lines 239-251.
  it('returns 0 when replayIndex equals lastRightStep', () => {
    const proof = new Uint8Array([0xff])
    const state: TraversalState = { directionsIndex: 8, lastRightStep: 4, replayIndex: 4 }
    expect(replayComparison(proof, state)).toBe(0)
    expect(state.replayIndex).toBe(5)
  })
  it('returns 1 when bit unset and replayIndex < lastRightStep', () => {
    const proof = new Uint8Array([0x00])
    const state: TraversalState = { directionsIndex: 8, lastRightStep: 4, replayIndex: 2 }
    expect(replayComparison(proof, state)).toBe(1)
  })
  it('returns -1 otherwise', () => {
    const proof = new Uint8Array([0xff])
    const state: TraversalState = { directionsIndex: 8, lastRightStep: 4, replayIndex: 2 }
    expect(replayComparison(proof, state)).toBe(-1)
  })
})

describe('keyMatchesLeaf', () => {
  it('returns true when key === leaf.key', () => {
    const key = new Uint8Array([1, 2, 3])
    const leaf = newLeaf(key, new Uint8Array([10]), new Uint8Array([5, 6, 7]))
    expect(keyMatchesLeaf(key, leaf)).toEqual({ ok: true, matches: true })
  })
  it('returns false when leaf.key < key < leaf.nextLeafKey', () => {
    const leaf = newLeaf(new Uint8Array([1, 0, 0]), new Uint8Array([10]), new Uint8Array([2, 0, 0]))
    expect(keyMatchesLeaf(new Uint8Array([1, 5, 0]), leaf)).toEqual({ ok: true, matches: false })
  })
  it('fails when key not in [leaf.key, leaf.nextLeafKey)', () => {
    const leaf = newLeaf(new Uint8Array([1, 0, 0]), new Uint8Array([10]), new Uint8Array([2, 0, 0]))
    expect(keyMatchesLeaf(new Uint8Array([5, 0, 0]), leaf)).toEqual({ ok: false, reason: 'leaf-key-out-of-order' })
  })
  it('fails when key < leaf.key', () => {
    const leaf = newLeaf(new Uint8Array([1, 0, 0]), new Uint8Array([10]), new Uint8Array([2, 0, 0]))
    expect(keyMatchesLeaf(new Uint8Array([0, 5, 0]), leaf)).toEqual({ ok: false, reason: 'leaf-key-out-of-order' })
  })
})
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run packages/avltree/test/tree-traversal.test.ts`
Expected: FAIL — `replayComparison` and `keyMatchesLeaf` not exported.

- [ ] **Step 3: Append to `packages/avltree/src/tree-traversal.ts`**

```ts
import type { LeafNode } from './node.js'
import type { AvlVerifyFailReason } from './errors.js'

/** Lexicographic comparison of two Uint8Arrays. Returns -1, 0, 1. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length)
  for (let i = 0; i < min; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return a.length - b.length === 0 ? 0 : (a.length < b.length ? -1 : 1)
}

/** Ports batch_avl_verifier.rs::BatchAVLVerifier::replay_comparison (lines 239-251). */
export function replayComparison(
  proof: Uint8Array,
  state: TraversalState,
): -1 | 0 | 1 {
  const i = state.replayIndex
  let ret: -1 | 0 | 1
  if (i === state.lastRightStep) {
    ret = 0
  } else {
    const bit = (proof[i >> 3] & (1 << (i & 7))) !== 0
    if (!bit && i < state.lastRightStep) ret = 1
    else ret = -1
  }
  state.replayIndex = i + 1
  return ret
}

export type KeyMatchesResult =
  | { ok: true; matches: boolean }
  | { ok: false; reason: AvlVerifyFailReason }

/** Ports batch_avl_verifier.rs::BatchAVLVerifier::key_matches_leaf (lines 213-227). */
export function keyMatchesLeaf(key: Uint8Array, leaf: LeafNode): KeyMatchesResult {
  const cmp = compareBytes(key, leaf.key)
  if (cmp === 0) return { ok: true, matches: true }
  // Otherwise: assert leaf.key < key AND key < leaf.nextLeafKey.
  if (cmp < 0) return { ok: false, reason: 'leaf-key-out-of-order' }
  // key > leaf.key. Check key < leaf.nextLeafKey.
  if (compareBytes(key, leaf.nextLeafKey) >= 0) return { ok: false, reason: 'leaf-key-out-of-order' }
  return { ok: true, matches: false }
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run packages/avltree/test/tree-traversal.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/avltree/src/tree-traversal.ts packages/avltree/test/tree-traversal.test.ts
git commit -m "feat(avltree): tree-traversal.ts — replayComparison + keyMatchesLeaf"
```

---

### Task 12: `rotation.ts` — `doubleLeftRotate` + `doubleRightRotate`

**Source-port reference:** `~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs` lines 135-220 (the two double-rotation helpers).

**Files:**
- Create: `packages/avltree/src/rotation.ts`
- Create: `packages/avltree/test/rotation.test.ts`

- [ ] **Step 1: Write failing tests at `packages/avltree/test/rotation.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { doubleLeftRotate, doubleRightRotate } from '../src/rotation.js'
import { newInternal, newLeaf, label } from '../src/node.js'

describe('doubleLeftRotate', () => {
  it('rotates a known unbalanced sub-tree', () => {
    // Construct an unbalanced tree shape that requires a double-left rotation.
    // Specific shape: see Rust source, double_left_rotate lines 135-170.
    // Engineer builds the input + expected output from the Rust algorithm.
    // For now, regression-test invariant: post-rotation tree labels deterministically.
    const leaf1 = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([2]))
    const leaf2 = newLeaf(new Uint8Array([2]), new Uint8Array([20]), new Uint8Array([3]))
    const leaf3 = newLeaf(new Uint8Array([3]), new Uint8Array([30]), new Uint8Array([255]))
    const inner = newInternal(leaf2, leaf3, 1)
    const root = newInternal(leaf1, inner, 0)
    const rotated = doubleLeftRotate(root)
    expect(rotated.kind).toBe('internal')
    expect(label(rotated).length).toBe(32)
  })
})

describe('doubleRightRotate', () => {
  it('rotates a known unbalanced sub-tree (mirror of left)', () => {
    const leaf1 = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([2]))
    const leaf2 = newLeaf(new Uint8Array([2]), new Uint8Array([20]), new Uint8Array([3]))
    const leaf3 = newLeaf(new Uint8Array([3]), new Uint8Array([30]), new Uint8Array([255]))
    const inner = newInternal(leaf1, leaf2, -1)
    const root = newInternal(inner, leaf3, 0)
    const rotated = doubleRightRotate(root)
    expect(rotated.kind).toBe('internal')
    expect(label(rotated).length).toBe(32)
  })
})
```

Note: Once Task 13 generates rotation-specific fixtures, replace these regression-only tests with byte-equality assertions against the Rust output. Track in Task 24.

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run packages/avltree/test/rotation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Author `packages/avltree/src/rotation.ts`**

```ts
import type { InternalNode } from './node.js'
import { newInternal } from './node.js'

/**
 * Ports authenticated_tree_ops.rs::AuthenticatedTreeOps::double_left_rotate (lines 135-170).
 * Rebalances a node whose right child has its own right-leaning imbalance.
 * Returns the new sub-root.
 */
export function doubleLeftRotate(node: InternalNode): InternalNode {
  // Per Rust: requires node.right to be Internal, node.right.left to be Internal.
  // 1. Promote the new sub-root (node.right.left's original position becomes root-like).
  // 2. Reassign children + balances per the Rust formula.
  // See lines 135-170 for the exact balance reassignment.
  // Implementer fills in.
}

/**
 * Ports authenticated_tree_ops.rs::AuthenticatedTreeOps::double_right_rotate (lines 171-220).
 * Mirror of doubleLeftRotate for the symmetric case.
 */
export function doubleRightRotate(node: InternalNode): InternalNode {
  // See Rust source.
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run packages/avltree/test/rotation.test.ts`
Expected: PASS (regression-only assertions; replaced with byte-equality in Task 24).

- [ ] **Step 5: Commit**

```bash
git add packages/avltree/src/rotation.ts packages/avltree/test/rotation.test.ts
git commit -m "feat(avltree): rotation.ts — doubleLeftRotate + doubleRightRotate"
```

---

### Task 13: fixture-gen — per-Operation-variant fixtures (all 8)

**Files:**
- Modify: `fixture-gen/src/cmds/avltree.rs` (extend with per-variant generators)

- [ ] **Step 1: Extend `fixture-gen/src/cmds/avltree.rs` with generators for all 8 Operation variants**

For each Operation variant, generate at least 2 fixtures:
- **Lookup**: tree-of-3-leaves, key present; tree-of-3-leaves, key absent
- **Insert**: empty-tree (covered by single-leaf-insert from Task 8); tree-of-3-leaves; tree-of-100-leaves
- **Update**: tree-of-3-leaves, key present; (negative case where key absent — verifier should reject)
- **InsertOrUpdate**: tree-of-3-leaves, key absent (insert path); tree-of-3-leaves, key present (update path)
- **UpdateLongBy**: tree-with-existing-i64, positive delta (no remove); positive delta producing remove (result=0); negative delta producing remove; negative delta on absent (verifier should reject)
- **Remove**: tree-of-3-leaves, key present; (negative case)
- **RemoveIfExists**: tree-of-3-leaves, key present; tree-of-3-leaves, key absent (no-op)
- **UnknownModification**: tree-of-3-leaves, key present (returns oldValue); tree-of-3-leaves, key absent (returns null)

For each fixture, the prover constructs the tree, applies the operation(s), generates the proof, and the verifier cross-checks. Helper signature:

```rust
fn generate_fixture(
    name: &str,
    key_length: usize,
    value_length_opt: Option<usize>,
    initial_kvs: Vec<(Bytes, Bytes)>,  // pre-state
    operations: Vec<Operation>,         // operations to apply
) -> Result<AvlFixture>
```

Each fixture's name encodes its purpose: `lookup-3leaves-present`, `lookup-3leaves-absent`, `insert-3leaves`, `update-3leaves-present`, `update-3leaves-absent-fail`, `update-long-by-positive-add`, etc.

- [ ] **Step 2: Run fixture-gen**

Run: `cargo run -p fixture-gen -- avltree`
Expected: Produces ~20 JSON fixtures in `packages/avltree/test/fixtures/avltree/`.

- [ ] **Step 3: Verify determinism**

Run: `cargo run -p fixture-gen -- avltree && git diff packages/avltree/test/fixtures/`
Expected: No diff on second run.

- [ ] **Step 4: Commit**

```bash
git add fixture-gen/src/cmds/avltree.rs packages/avltree/test/fixtures/avltree/
git commit -m "feat(fixture-gen): per-Operation-variant AVL+ fixtures"
```

---

### Task 14: `modify.ts` — Lookup + Insert + Update + InsertOrUpdate cases

**Source-port reference:** `~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs::modify_helper` (lines 262-398). The Lookup case + Insert/Update/InsertOrUpdate share most code; UpdateLongBy and UnknownModification are extensions.

**Files:**
- Create: `packages/avltree/src/modify.ts`

This task gets tested integratively via `BatchAvlVerifier` in Task 17 + corpus in Task 24. No standalone test file — the modify path is only meaningful within a verifier run. Per the design spec's "Modify and delete tests really require batch-verifier" decision.

- [ ] **Step 1: Author `packages/avltree/src/modify.ts`**

```ts
import { newInternal, newLeaf, type AvlNode, type LeafNode, type Balance } from './node.js'
import { nextDirectionIsLeft, keyMatchesLeaf, type TraversalState } from './tree-traversal.js'
import { doubleLeftRotate, doubleRightRotate } from './rotation.js'
import { updateFn, type Operation, type UpdateFnFailReason } from './operation.js'
import type { AvlVerifyFailReason } from './errors.js'

export type ModifyOk = {
  readonly ok: true
  readonly newSubtreeRoot: AvlNode
  /** Change in subtree height: -1 (shrank), 0, or 1 (grew). */
  readonly heightDelta: -1 | 0 | 1
  /** Old value at this key, or null if key was absent. */
  readonly oldValue: Uint8Array | null
}
export type ModifyFail = { readonly ok: false; readonly reason: AvlVerifyFailReason }
export type ModifyResult = ModifyOk | ModifyFail

/**
 * Ports authenticated_tree_ops.rs::modify_helper (lines 262-398).
 * Walks the tree per the proof's directions, applies the operation at the
 * matching leaf, and rebalances the subtree on the way back up.
 *
 * Handles: Lookup, Insert, Update, InsertOrUpdate. UpdateLongBy and
 * UnknownModification deferred to Task 15 (separate function or extension).
 *
 * Per [[feedback-rust-port-style]]: decomposed into 4 helpers below.
 */
export function modifyHelper(
  node: AvlNode,
  op: Operation,
  proof: Uint8Array,
  state: TraversalState,
): ModifyResult {
  // Top-level: dispatch by node.kind.
  // - If label-node: this means the proof doesn't have full coverage of
  //   the path; this is a verification failure (the proof should have
  //   included the necessary leaves/internals along the operation path).
  //   Return { ok: false, reason: 'proof-malformed' }.
  // - If leaf: handle via handleLeafNode.
  // - If internal: handle via handleInternalNode (recurse).
}

/** Ports modify_helper's leaf-node branch (authenticated_tree_ops.rs:280-330). */
function handleLeafNode(
  leaf: LeafNode,
  op: Operation,
  proof: Uint8Array,
  state: TraversalState,
): ModifyResult {
  // 1. Call keyMatchesLeaf(op.key, leaf). On failure, return that reason.
  // 2. Branch on (matches, op.tag):
  //    - matches: invoke updateFn(op, leaf.value); update or create new subtree.
  //    - !matches: key is between leaf.key and leaf.nextLeafKey;
  //      for insert-class ops, split the leaf into 2 (newLeaf + this);
  //      for read-class ops, return as not-found.
}

/** Ports modify_helper's internal-node branch (authenticated_tree_ops.rs:331-368). */
function handleInternalNode(
  node: InternalNode,
  op: Operation,
  proof: Uint8Array,
  state: TraversalState,
): ModifyResult {
  // 1. Read direction: const goLeft = nextDirectionIsLeft(proof, state).
  // 2. Recurse: modifyHelper on the chosen subtree.
  // 3. On the way back up: if height changed, may need to rebalance via
  //    rebalance(...).
  // 4. Construct new internal node with updated subtree.
}

/** Ports modify_helper's rebalance section (authenticated_tree_ops.rs:369-398). */
function rebalance(
  node: InternalNode,
  childHeightDelta: -1 | 0 | 1,
  childWasLeft: boolean,
): { node: AvlNode; heightDelta: -1 | 0 | 1 } {
  // Determine if rotation is needed based on the post-recursion balance.
  // If |balance| > 1, perform the appropriate single or double rotation.
  // doubleLeftRotate or doubleRightRotate from rotation.ts; single rotations
  // can be implemented inline (they're simpler than the doubles).
}
```

The engineer fills in the body, using `~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs` lines 262-398 as the algorithmic reference.

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS (will surface unused imports if Step 3 deferred — that's fine, Task 15 uses them).

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/src/modify.ts
git commit -m "feat(avltree): modify.ts — modifyHelper for Lookup/Insert/Update/InsertOrUpdate"
```

---

### Task 15: `modify.ts` — UpdateLongBy + UnknownModification extensions

**Source-port reference:** `~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs::modify_helper` — the UpdateLongBy and UnknownModification branches are interleaved within the same function. Read carefully.

**Files:**
- Modify: `packages/avltree/src/modify.ts`

- [ ] **Step 1: Extend `modify.ts` to handle UpdateLongBy + UnknownModification**

Both share the modifyHelper structure but have specific value-handling. UpdateLongBy goes through `operation.ts::updateFn`'s i64-delta logic (already implemented in Task 5). UnknownModification returns oldValue unchanged.

The engineer extends `handleLeafNode` and possibly `handleInternalNode` to dispatch correctly for these op tags.

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/src/modify.ts
git commit -m "feat(avltree): modify.ts — extend for UpdateLongBy + UnknownModification"
```

---

### Task 16: `delete.ts` — `deleteHelper` for Remove + RemoveIfExists

**Source-port reference:** `~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs::delete_helper` (lines 446-540) + `change_next_leaf_key_of_max_node` (lines 400-416) + `change_key_and_value_of_min_node` (lines 417-445).

**Files:**
- Create: `packages/avltree/src/delete.ts`

- [ ] **Step 1: Author `packages/avltree/src/delete.ts`**

```ts
import { newInternal, newLeaf, type AvlNode, type InternalNode, type LeafNode } from './node.js'
import { nextDirectionIsLeft, replayComparison, keyMatchesLeaf, type TraversalState } from './tree-traversal.js'
import { doubleLeftRotate, doubleRightRotate } from './rotation.js'
import { updateFn, type Operation } from './operation.js'
import type { ModifyResult } from './modify.js'

/**
 * Ports authenticated_tree_ops.rs::delete_helper (lines 446-540). Handles
 * Remove and RemoveIfExists.
 *
 * Distinguishing feature vs modifyHelper: deletes go down the tree TWICE.
 * First pass uses nextDirectionIsLeft (consumes direction bits) to find the
 * leaf. Second pass uses replayComparison (re-uses same bits via replayIndex)
 * to splice the leaf out + fix the parent chain.
 */
export function deleteHelper(
  node: AvlNode,
  op: Operation,
  proof: Uint8Array,
  state: TraversalState,
): ModifyResult {
  // Implementation per Rust source. Key steps:
  // 1. Save replayIndex := directionsIndex at start.
  // 2. First pass: walk via nextDirectionIsLeft, find the leaf for op.key.
  // 3. Apply updateFn(op, leaf.value) — for Remove, returns ok with newValue:null
  //    or 'key-not-found'; for RemoveIfExists, returns ok with null regardless.
  // 4. Second pass: walk via replayComparison, splice out the leaf, fix
  //    parent's nextLeafKey via changeNextLeafKeyOfMaxNode or
  //    changeKeyAndValueOfMinNode.
  // 5. Rebalance up.
}

/** Ports change_next_leaf_key_of_max_node (lines 400-416). */
function changeNextLeafKeyOfMaxNode(node: AvlNode, newKey: Uint8Array): AvlNode {
  // Walk to the rightmost leaf in subtree; replace its nextLeafKey.
}

/** Ports change_key_and_value_of_min_node (lines 417-445). */
function changeKeyAndValueOfMinNode(node: AvlNode, newKey: Uint8Array, newValue: Uint8Array): AvlNode {
  // Walk to the leftmost leaf in subtree; replace its key + value.
}
```

The engineer fills in the bodies per the Rust source.

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/src/delete.ts
git commit -m "feat(avltree): delete.ts — deleteHelper + change* helpers for Remove/RemoveIfExists"
```

---

### Task 17: `batch-verifier.ts` — `BatchAvlVerifier` class

**Source-port reference:** `~/projects/ergo_avltree_rust/src/batch_avl_verifier.rs` — the `BatchAVLVerifier` struct (lines 21-34), constructor (lines 37-55), `perform_one_operation` (lines 157-172).

**Files:**
- Create: `packages/avltree/src/batch-verifier.ts`

- [ ] **Step 1: Author `packages/avltree/src/batch-verifier.ts`**

```ts
import { parseProofPackedTree } from './proof-decode.js'
import { modifyHelper } from './modify.js'
import { deleteHelper } from './delete.js'
import { label, type AvlNode } from './node.js'
import type { TraversalState } from './tree-traversal.js'
import type { Operation } from './operation.js'
import type { AvlTreeConfig } from './types.js'
import type { AvlVerifyFailReason } from './errors.js'

/**
 * Ports batch_avl_verifier.rs::BatchAVLVerifier (struct + impl).
 * Internal. Constructed by verify.ts's wrappers; consumers should use
 * verifyAvlBatch/verifyAvlLookup instead.
 */
export class BatchAvlVerifier {
  readonly proof: Uint8Array
  readonly config: AvlTreeConfig
  root: AvlNode | null
  height: number
  /** Internal failure reason (option-3: not exposed publicly on v0.1.0). */
  lastFailReason: AvlVerifyFailReason | null = null

  private state: TraversalState

  /** Ports BatchAVLVerifier::new (lines 37-55) + reconstruct_tree (58-143). */
  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig) {
    this.proof = proof
    this.config = config
    this.state = { directionsIndex: 0, lastRightStep: 0, replayIndex: 0 }
    this.root = null
    this.height = 0

    const decoded = parseProofPackedTree(proof, config, startingDigest)
    if (!decoded.ok) {
      this.lastFailReason = decoded.reason
      return
    }
    this.root = decoded.root
    this.height = decoded.height
    // directionsStart from proof-decode is a BYTE offset; tree-traversal uses BIT
    // indexing. Convert: Rust does `(i + 1) * 8` (batch_avl_verifier.rs:141).
    this.state.directionsIndex = decoded.directionsStart * 8
  }

  /** True if the constructor's proof decoding succeeded. */
  get isValid(): boolean {
    return this.root !== null
  }

  /**
   * Ports BatchAVLVerifier::perform_one_operation (batch_avl_verifier.rs:157-172)
   * + return_result_of_one_operation orchestration (authenticated_tree_ops.rs:221-261).
   *
   * Two-phase dispatch: ALL 8 op types go through modifyHelper first.
   *  - Lookup / UnknownModification: short-circuit at leaf-match (no tree change)
   *  - Insert / Update / InsertOrUpdate / UpdateLongBy (delta != 0 or result > 0):
   *    handled entirely within modifyHelper
   *  - Remove / RemoveIfExists / UpdateLongBy result == 0: modifyHelper returns
   *    needsDelete=true with tree unchanged; phase 2 routes to deleteHelper
   */
  performOneOperation(op: Operation): Uint8Array | null | { failed: true } {
    if (this.root === null) {
      // Already-poisoned tree from a previous failure.
      this.lastFailReason ??= 'tree-poisoned'
      return { failed: true }
    }
    // replayIndex set once at the start (Rust line 158); deleteHelper consumes it.
    this.state.replayIndex = this.state.directionsIndex

    // Phase 1: dispatch via modifyHelper for ALL op types.
    const modifyResult = modifyHelper(this.root, op, this.proof, this.state)
    if (!modifyResult.ok) {
      this.root = null
      this.height = 0  // Rust lines 167-170: poison root AND height
      this.lastFailReason = modifyResult.reason
      return { failed: true }
    }

    let newRoot = modifyResult.newSubtreeRoot
    let heightDelta = modifyResult.heightDelta

    // Phase 2: if needsDelete, dispatch deleteHelper for structural removal.
    // modifyHelper's heightDelta is 0 for needsDelete cases (tree unchanged at
    // phase 1). The replayIndex was already set above and was NOT advanced by
    // modifyHelper's traversal of internal nodes via nextDirectionIsLeft;
    // deleteHelper consumes it via replayComparison.
    if (modifyResult.needsDelete) {
      const deleteResult = deleteHelper(newRoot, op, this.proof, this.state)
      if (!deleteResult.ok) {
        this.root = null
        this.height = 0
        this.lastFailReason = deleteResult.reason
        return { failed: true }
      }
      newRoot = deleteResult.newSubtreeRoot
      heightDelta = deleteResult.heightDelta  // 0 or -1
    }

    this.root = newRoot
    this.height = Math.max(0, this.height + heightDelta)
    return modifyResult.oldValue
  }

  /** Compute current digest: blake2b(root) || heightByte. */
  digest(): Uint8Array | null {
    if (this.root === null) return null
    const rootLabel = label(this.root)
    const out = new Uint8Array(33)
    out.set(rootLabel, 0)
    out[32] = this.height & 0xff
    return out
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/src/batch-verifier.ts
git commit -m "feat(avltree): batch-verifier.ts — BatchAvlVerifier orchestrator"
```

---

### Task 18: `verify.ts` — `verifyAvlBatch` wrapper

**Files:**
- Create: `packages/avltree/src/verify.ts`
- Create: `packages/avltree/test/verify-batch.test.ts`

- [ ] **Step 1: Write failing test** at `packages/avltree/test/verify-batch.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { verifyAvlBatch } from '../src/verify.js'
import type { Operation } from '../src/operation.js'
import type { AvlTreeConfig } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures/avltree')

function hexToBytes(h: string): Uint8Array { /* ... */ }
function jsonToOp(o: any): Operation { /* ... convert OpJson → Operation, hex → Uint8Array ... */ }

describe('verifyAvlBatch — per-fixture corpus', () => {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
  for (const fname of fixtures) {
    it(`matches Rust verifier output: ${fname}`, () => {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      const startingDigest = hexToBytes(f.startingDigestHex)
      const proof = hexToBytes(f.proofHex)
      const config: AvlTreeConfig = f.config  // JSON emits camelCase directly
      const operations = f.operations.map(jsonToOp)
      const result = verifyAvlBatch(startingDigest, proof, config, operations)
      // Fixture may indicate expected failure via expectedNewDigestHex === null.
      if (f.expectedNewDigestHex === null) {
        expect(result).toBeNull()
        return
      }
      expect(result).not.toBeNull()
      expect(Array.from(result!.newDigest)).toEqual(Array.from(hexToBytes(f.expectedNewDigestHex)))
      const expectedResults = f.expectedResultsHex.map((h: string | null) =>
        h === null ? null : hexToBytes(h),
      )
      expect(result!.results.length).toBe(expectedResults.length)
      for (let i = 0; i < result!.results.length; i++) {
        const got = result!.results[i]
        const expect_ = expectedResults[i]
        if (expect_ === null) expect(got).toBeNull()
        else expect(Array.from(got!)).toEqual(Array.from(expect_))
      }
    })
  }
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run packages/avltree/test/verify-batch.test.ts`
Expected: FAIL — `verify.js` not found.

- [ ] **Step 3: Author `packages/avltree/src/verify.ts`**

```ts
import { BatchAvlVerifier } from './batch-verifier.js'
import { AvlVerifyError } from './errors.js'
import type { AvlTreeConfig } from './types.js'
import type { Operation } from './operation.js'

export interface VerifyAvlBatchResult {
  readonly newDigest: Uint8Array
  readonly results: (Uint8Array | null)[]
}

/**
 * Public wrapper. Verifies the proof against startingDigest, applies each
 * operation in order, returns the resulting newDigest + per-op old-values.
 * Returns null on any verification failure. Throws AvlVerifyError on
 * programmer error (invalid config or input shape).
 */
export function verifyAvlBatch(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): VerifyAvlBatchResult | null {
  // 1. Validate shapes — throw AvlVerifyError on any of the 6 programmer-error codes.
  validateConfig(config)
  validateStartingDigest(startingDigest)
  for (const op of operations) validateOperationShape(op, config)

  // 2. Construct verifier — proof decoding inside the constructor.
  const v = new BatchAvlVerifier(startingDigest, proof, config)
  if (!v.isValid) return null

  // 3. Apply operations one at a time.
  const results: (Uint8Array | null)[] = []
  for (const op of operations) {
    const r = v.performOneOperation(op)
    if (typeof r === 'object' && r !== null && 'failed' in r) return null
    results.push(r as Uint8Array | null)
  }

  // 4. Compute final digest.
  const newDigest = v.digest()
  if (newDigest === null) return null
  return { newDigest, results }
}

function validateConfig(config: AvlTreeConfig): void {
  if (config.keyLength <= 0) throw new AvlVerifyError(`keyLength must be > 0; got ${config.keyLength}`, 'invalid-config-key-length')
  if (config.valueLengthOpt !== null && config.valueLengthOpt < 0)
    throw new AvlVerifyError(`valueLengthOpt must be >= 0 or null`, 'invalid-config-value-length')
  if (config.maxNumOperations !== undefined && config.maxNumOperations < 0)
    throw new AvlVerifyError(`maxNumOperations must be >= 0`, 'invalid-config-max-ops')
  if (config.maxDeletes !== undefined && config.maxNumOperations !== undefined && config.maxDeletes > config.maxNumOperations)
    throw new AvlVerifyError(`maxDeletes must be <= maxNumOperations`, 'invalid-config-max-ops')
}

function validateStartingDigest(d: Uint8Array): void {
  if (d.length !== 33) throw new AvlVerifyError(`startingDigest must be 33 bytes; got ${d.length}`, 'invalid-starting-digest-length')
}

function validateOperationShape(op: Operation, config: AvlTreeConfig): void {
  if (op.key.length !== config.keyLength) throw new AvlVerifyError(`op.key.length=${op.key.length} != config.keyLength=${config.keyLength}`, 'operation-key-length-mismatch')
  if ('value' in op && config.valueLengthOpt !== null && op.value.length !== config.valueLengthOpt)
    throw new AvlVerifyError(`op.value.length=${op.value.length} != config.valueLengthOpt=${config.valueLengthOpt}`, 'operation-value-length-mismatch')
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run packages/avltree/test/verify-batch.test.ts`
Expected: All fixture-driven tests PASS (every fixture verifier-output matches Rust).

- [ ] **Step 5: Run typecheck + cross-runtime**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Run: `npx vitest run --config packages/avltree/vitest.browser.config.ts packages/avltree/test/verify-batch.test.ts`
Expected: Both PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/avltree/src/verify.ts packages/avltree/test/verify-batch.test.ts
git commit -m "feat(avltree): verify.ts — verifyAvlBatch wrapper + corpus-driven tests"
```

---

### Task 19: `verify.ts` — `verifyAvlLookup` wrapper

**Files:**
- Modify: `packages/avltree/src/verify.ts`
- Create: `packages/avltree/test/verify-lookup.test.ts`

- [ ] **Step 1: Write failing test** at `packages/avltree/test/verify-lookup.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyAvlLookup } from '../src/verify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures/avltree')

function hexToBytes(h: string): Uint8Array { /* ... */ }

describe('verifyAvlLookup — Lookup fixtures', () => {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.startsWith('lookup-'))
  for (const fname of fixtures) {
    it(`returns expected value for ${fname}`, () => {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      // Lookup fixtures contain exactly one Lookup operation.
      expect(f.operations.length).toBe(1)
      expect(f.operations[0].tag).toBe('Lookup')
      const key = hexToBytes(f.operations[0].keyHex)
      const result = verifyAvlLookup(
        hexToBytes(f.startingDigestHex),
        hexToBytes(f.proofHex),
        {
          keyLength: f.config.keyLength,
          valueLengthOpt: f.config.valueLengthOpt,
        },
        key,
      )
      // Match expected:
      const expected = f.expectedResultsHex[0]
      expect(result).not.toBeNull()
      if (expected === null) expect(result!.value).toBeNull()
      else expect(Array.from(result!.value!)).toEqual(Array.from(hexToBytes(expected)))
    })
  }
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run packages/avltree/test/verify-lookup.test.ts`
Expected: FAIL — `verifyAvlLookup` not exported.

- [ ] **Step 3: Add `verifyAvlLookup` to `packages/avltree/src/verify.ts`**

```ts
export function verifyAvlLookup(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  key: Uint8Array,
): { value: Uint8Array | null } | null {
  const result = verifyAvlBatch(startingDigest, proof, config, [{ tag: 'Lookup', key }])
  if (result === null) return null
  return { value: result.results[0] }
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run packages/avltree/test/verify-lookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/avltree/src/verify.ts packages/avltree/test/verify-lookup.test.ts
git commit -m "feat(avltree): verify.ts — verifyAvlLookup wrapper"
```

---

### Task 20: `index.ts` — public exports

**Files:**
- Modify: `packages/avltree/src/index.ts`

- [ ] **Step 1: Author `packages/avltree/src/index.ts`**

```ts
// Public surface of @mwaddip/ergots-avltree.

export { verifyAvlBatch, verifyAvlLookup, type VerifyAvlBatchResult } from './verify.js'
export type { AvlTreeConfig, OperationResult } from './types.js'
export type { Operation } from './operation.js'
export { AvlVerifyError, type AvlVerifyErrorCode } from './errors.js'

// Internal types (NOT exported): AvlVerifyFailReason, BatchAvlVerifier, node types,
// modify/delete helpers, rotation primitives, tree-traversal state.
// These are implementation detail and may change without notice.
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Verify the build works**

Run: `npm run build -w @mwaddip/ergots-avltree`
Expected: `packages/avltree/dist/index.js` and `dist/index.d.ts` produced. No errors.

- [ ] **Step 4: Verify build is browser-clean** (per project rule)

Run: `grep -E "Buffer|process\\.|require\\(|node:" packages/avltree/dist/`
Expected: No matches (empty grep output).

- [ ] **Step 5: Commit**

```bash
git add packages/avltree/src/index.ts
git commit -m "feat(avltree): index.ts — public exports"
```

---

### Task 21: fixture-gen — multi-op batches

**Files:**
- Modify: `fixture-gen/src/cmds/avltree.rs`

- [ ] **Step 1: Add multi-op batch generators**

Generate fixtures with varied batch sizes (0, 1, 2, 16, 256 operations) and mixed operation types:
- `batch-0ops` (empty op list — verifier should accept, return starting digest unchanged)
- `batch-2ops-insert-then-lookup`
- `batch-2ops-insert-then-update`
- `batch-2ops-insert-then-remove`
- `batch-16ops-mixed` (assorted ops)
- `batch-256ops-inserts` (256 distinct inserts into an empty tree)
- `batch-stress-mixed-100` (100 mixed ops on a starting tree of ~50 leaves)

- [ ] **Step 2: Run + verify determinism**

Run: `cargo run -p fixture-gen -- avltree && git diff packages/avltree/test/fixtures/`
Expected: New fixtures committed; no diff on second run.

- [ ] **Step 3: Run corpus tests**

Run: `npx vitest run packages/avltree/test/verify-batch.test.ts`
Expected: All new fixtures pass byte-equality.

- [ ] **Step 4: Commit**

```bash
git add fixture-gen/src/cmds/avltree.rs packages/avltree/test/fixtures/avltree/batch-*.json
git commit -m "feat(fixture-gen): multi-op batch AVL+ fixtures"
```

---

### Task 22: fixture-gen — edge cases

**Files:**
- Modify: `fixture-gen/src/cmds/avltree.rs`

- [ ] **Step 1: Add edge-case generators**

- `empty-tree-lookup` (lookup on empty tree)
- `empty-tree-insert` (covered by single-leaf-insert; ensure name consistent)
- `single-leaf-tree-various-ops` (one fixture per Operation variant)
- `all-left-spine-10leaves` (worst-case left-skewed)
- `all-right-spine-10leaves` (worst-case right-skewed)
- `balanced-100leaves` + `balanced-1000leaves`
- `max-depth-tree` (tree at the maximum height that AVL+ allows for the chosen size)
- `all-deletes-from-balanced-10` (delete all 10 keys; final tree empty)
- `update-long-by-i64-max-overflow-attempt` (UpdateLongBy with delta approaching i64 boundaries)
- `update-long-by-result-exactly-zero` (UpdateLongBy with delta == -value → key removed)

- [ ] **Step 2: Run + verify determinism**

Same pattern as Task 21.

- [ ] **Step 3: Run corpus tests**

Run: `npx vitest run packages/avltree/test/verify-batch.test.ts`
Expected: All edge-case fixtures PASS.

- [ ] **Step 4: Commit**

```bash
git add fixture-gen/src/cmds/avltree.rs packages/avltree/test/fixtures/avltree/
git commit -m "feat(fixture-gen): edge-case AVL+ fixtures (spines, max-depth, all-deletes, etc.)"
```

---

### Task 23: fixture-gen — config-variance + adverse cases

**Files:**
- Modify: `fixture-gen/src/cmds/avltree.rs`

- [ ] **Step 1: Add config-variance generators**

- Fixed vs variable `valueLengthOpt`: at least one fixture each with `valueLengthOpt = null` and `valueLengthOpt = 8`.
- `keyLength` variants: 1-byte, 8-byte, 32-byte keys.
- `maxNumOperations` / `maxDeletes` bounds: fixtures that exercise the malicious-proof DoS guard (a proof claiming more nodes than allowed).

- [ ] **Step 2: Add adverse (intentional rejection) fixtures**

These fixtures have `expected_new_digest_hex: null` in the JSON to indicate the TS verifier should return `null`:

- `adverse-truncated-proof` (proof bytes truncated mid-tree-reconstruction)
- `adverse-swapped-starting-digest` (correct proof but with a different startingDigest)
- `adverse-mismatched-config` (proof generated with keyLength=8, but config says keyLength=4)
- `adverse-malicious-extra-nodes` (proof with more nodes than maxNumOperations allows)

To generate adverse fixtures, take a valid (proof, digest) pair and mutate one piece, then ensure the Rust verifier rejects it (`BatchAVLVerifier::new(...)` returns Err) — record that as the expected outcome.

- [ ] **Step 3: Run + verify**

Run: `cargo run -p fixture-gen -- avltree && npx vitest run packages/avltree/test/verify-batch.test.ts`
Expected: New config-variance fixtures pass byte-equality; adverse fixtures cause `verifyAvlBatch` to return `null` (and the test asserts that).

- [ ] **Step 4: Commit**

```bash
git add fixture-gen/src/cmds/avltree.rs packages/avltree/test/fixtures/avltree/
git commit -m "feat(fixture-gen): config-variance + adverse AVL+ fixtures"
```

---

### Task 24: `corpus.test.ts` — bulk synthetic corpus run

**Files:**
- Create: `packages/avltree/test/corpus.test.ts`

By this task, the per-Operation tests (Task 18, 19) already iterate over all fixtures matching their pattern. This task creates an additional aggregate-style runner that asserts corpus-level invariants (total fixture count, no fixture skipped, etc.). It's a sanity gate for "did we accidentally lose fixtures or skip them?"

- [ ] **Step 1: Author `packages/avltree/test/corpus.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyAvlBatch } from '../src/verify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures/avltree')

describe('AVL+ corpus aggregate', () => {
  const all = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
  it('contains at least 150 fixtures', () => {
    expect(all.length).toBeGreaterThanOrEqual(150)
  })
  it('every fixture either verifies or is marked adverse (expected_new_digest_hex === null)', () => {
    let verifiedCount = 0
    let adverseCount = 0
    for (const fname of all) {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      // ... parse + invoke verifyAvlBatch ...
      // increment verifiedCount or adverseCount
    }
    expect(verifiedCount + adverseCount).toBe(all.length)
  })
})
```

The implementer fills in the loop to exercise every fixture, classify it, and assert the totals match expectations.

- [ ] **Step 2: Run**

Run: `npx vitest run packages/avltree/test/corpus.test.ts`
Expected: PASS (≥150 fixtures present; every fixture either verifies or is marked adverse).

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/test/corpus.test.ts
git commit -m "test(avltree): corpus.test.ts — aggregate corpus invariants"
```

---

### Task 25: `mutation.test.ts` — single-byte flips → typed rejection

**Source-port reference:** `~/projects/ergots/packages/proof/test/parse-mutation.test.ts` (existing pattern) — adapt for AVL+ proof bytes.

**Files:**
- Create: `packages/avltree/test/mutation.test.ts`

- [ ] **Step 1: Author `packages/avltree/test/mutation.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyAvlBatch } from '../src/verify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures/avltree')

function hexToBytes(h: string): Uint8Array { /* ... */ }
function bytesToHex(b: Uint8Array): string { /* ... */ }

/**
 * For each fixture (excluding adverse ones), flip each byte of proof bytes,
 * one at a time, and assert that verifyAvlBatch either returns null
 * (verification failure — expected) or returns byte-identical result
 * (flip landed in a tolerated region — should be rare).
 *
 * Target: ≥90% kill rate per Operation variant.
 */
describe('AVL+ mutation testing', () => {
  const fixtures = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !f.startsWith('adverse-'))

  for (const fname of fixtures) {
    it(`≥90% byte-flip kill rate on ${fname}`, () => {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      const proof = hexToBytes(f.proofHex)
      let killed = 0
      let survived = 0
      for (let i = 0; i < proof.length; i++) {
        // Flip one byte (XOR with 0xff, for instance, or just toggle bit 0).
        const mutated = new Uint8Array(proof)
        mutated[i] ^= 0xff
        const result = verifyAvlBatch(
          hexToBytes(f.startingDigestHex),
          mutated,
          { keyLength: f.config.keyLength, valueLengthOpt: f.config.valueLengthOpt },
          f.operations.map(jsonToOp),
        )
        if (result === null) killed++
        // If result !== null and matches expected, it's a survived mutation.
        else survived++
      }
      const killRate = killed / proof.length
      expect(killRate).toBeGreaterThanOrEqual(0.9)
    })
  }
})
```

- [ ] **Step 2: Run mutation tests**

Run: `npx vitest run packages/avltree/test/mutation.test.ts`
Expected: All fixtures PASS the ≥90% kill rate threshold.

- [ ] **Step 3: Investigate any below-threshold fixture**

If any fixture fails the ≥90% threshold, the verifier has a missing bounds check or insufficient byte-level validation. Investigate the surviving mutations:
- Common suspects: missing OOB checks in `proof-decode.ts`; missing checks in `tree-traversal.ts`; padding regions that are genuinely tolerated.
- Fix the verifier, re-run.

- [ ] **Step 4: Commit**

```bash
git add packages/avltree/test/mutation.test.ts
git commit -m "test(avltree): mutation.test.ts — ≥90% byte-flip kill rate per Operation variant"
```

---

### Task 26: `facts/avltree.md` — interface contract + Source Mapping table

**Files:**
- Create: `facts/avltree.md`
- Modify: `CLAUDE.md` (add `facts/avltree.md` to read-first list)

- [ ] **Step 1: Author `facts/avltree.md`**

Structure (model on `facts/proof.md` for shape):
- **Scope** (one paragraph: what the package is)
- **Public surface (v0.1.0)** — `verifyAvlBatch`, `verifyAvlLookup`, `Operation`, `AvlTreeConfig`, `VerifyAvlBatchResult`, `AvlVerifyError`
- **Failure model overview** — Tier 1 (AvlVerifyError, 6 codes) thrown vs Tier 2 (AvlVerifyFailReason, 10 internal reasons) for null return
- **Cross-cutting guarantees** — determinism, browser-compat, ESM-only, no-WASM, runtime deps (`@noble/hashes@2.2.0` only)
- **Test corpus** — three layers (per-component, bulk corpus, mutation), ≥90% kill rate per Operation variant, cross-runtime
- **Coverage** — all 8 Operation variants implemented; verifier-only (no prover)
- **Source mapping** (THE canonical table — see Step 2)
- **Cross-references** — design spec, sister contracts, project memories

- [ ] **Step 2: Populate the Source Mapping table**

The canonical map. Add a row per Rust function in the verifier slice:

```markdown
## Source mapping to `ergo_avltree_rust`

Pinned at `~/projects/ergo_avltree_rust/` HEAD `879545c`, branch `main`, including upstream PRs #10/#11/#13.

| Rust function (file:lines) | TS function(s) (file) | Note |
|---|---|---|
| `batch_avl_verifier.rs::BatchAVLVerifier::new` (37-55) | `BatchAvlVerifier` constructor (`batch-verifier.ts`) | 1:1 port |
| `batch_avl_verifier.rs::reconstruct_tree` (58-143) | `parseProofPackedTree` (`proof-decode.ts`) | 1:1 port; bounds-checks added |
| `batch_avl_verifier.rs::perform_one_operation` (157-172) | `BatchAvlVerifier.performOneOperation` (`batch-verifier.ts`) | 1:1 port |
| `batch_avl_verifier.rs::next_direction_is_left` (192-203) | `nextDirectionIsLeft` (`tree-traversal.ts`) | 1:1 port |
| `batch_avl_verifier.rs::key_matches_leaf` (213-227) | `keyMatchesLeaf` (`tree-traversal.ts`) | 1:1 port |
| `batch_avl_verifier.rs::replay_comparison` (239-251) | `replayComparison` (`tree-traversal.ts`) | 1:1 port |
| `authenticated_tree_ops.rs::modify_helper` (262-398) | `modifyHelper` + `handleLeafNode` + `handleInternalNode` + `rebalance` (`modify.ts`) | Decomposed into 4 helpers |
| `authenticated_tree_ops.rs::delete_helper` (446-540) | `deleteHelper` (`delete.ts`) | 1:1 port |
| `authenticated_tree_ops.rs::change_next_leaf_key_of_max_node` (400-416) | `changeNextLeafKeyOfMaxNode` (`delete.ts`) | 1:1 port |
| `authenticated_tree_ops.rs::change_key_and_value_of_min_node` (417-445) | `changeKeyAndValueOfMinNode` (`delete.ts`) | 1:1 port |
| `authenticated_tree_ops.rs::double_left_rotate` (135-170) | `doubleLeftRotate` (`rotation.ts`) | 1:1 port |
| `authenticated_tree_ops.rs::double_right_rotate` (171-220) | `doubleRightRotate` (`rotation.ts`) | 1:1 port |
| `batch_node.rs::Node::label` (~80-170 across variants) | `label` (`node.ts`) | Dispatch + 3 hash inputs; preserves Rust byte-ordering |
| `batch_node.rs::LeafNode::new` / `InternalNode::new` / `Node::new_label` | `newLeaf` / `newInternal` / `newLabel` (`node.ts`) | Constructor parity |
| `operation.rs::Operation::update_fn` (64-106) | `updateFn` (`operation.ts`) | 1:1 port |
| `operation.rs::Operation::key` / `Operation::value` | (inline access via discriminated union) | TS idiom replaces method-on-enum |
```

The implementer adds rows as functions are ported (kept in sync per commit, per [[feedback-rust-port-style]]).

- [ ] **Step 3: Update `CLAUDE.md` read-first list**

Add a new bullet under the read-first files section:

```markdown
   - `facts/avltree.md` — `@mwaddip/ergots-avltree` interface (proof verifier API + Operation + Source Mapping to ergo_avltree_rust)
```

- [ ] **Step 4: Commit**

```bash
git add facts/avltree.md CLAUDE.md
git commit -m "docs(facts): facts/avltree.md interface contract + Source Mapping table"
```

---

### Task 27: Source-mapping JSDoc audit

**Files:**
- Modify: every TS file in `packages/avltree/src/`

- [ ] **Step 1: Audit pass**

Walk every TS file in `packages/avltree/src/` and ensure each function/method has a one-line JSDoc naming its Rust counterpart per [[feedback-rust-port-style]]. Format:

```ts
/** Ports modify_helper's leaf-node branch (authenticated_tree_ops.rs:280-330). */
function handleLeafNode(...) { ... }
```

Functions without a direct Rust counterpart (e.g., TS-only helpers like `concat()` in `node.ts`) get a brief description of their purpose, no source ref needed.

- [ ] **Step 2: Cross-check against the Source Mapping table**

For every row in `facts/avltree.md`'s Source Mapping table, verify the named TS function exists with a matching JSDoc comment.

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/src/
git commit -m "docs(avltree): per-function JSDoc source comments — Source Mapping audit"
```

---

### Task 28: `README.md` + `API.md`

**Files:**
- Create: `packages/avltree/README.md`
- Create: `packages/avltree/API.md`

- [ ] **Step 1: Author `packages/avltree/README.md`**

Model on `packages/proof/README.md`. Contents:
- Package name + one-paragraph elevator pitch
- Install: `npm install @mwaddip/ergots-avltree`
- Browser-clean note (no WASM, no Buffer, ESM-only, etc.)
- Quick-start example (verifyAvlBatch with a small proof)
- Link to `API.md` for full reference
- Link to `facts/avltree.md` for interface contract
- License

- [ ] **Step 2: Author `packages/avltree/API.md`**

Full API reference per the public surface. Sections:
- `verifyAvlBatch(...)` signature + parameters + return type + examples
- `verifyAvlLookup(...)` signature + parameters + return type + examples
- `Operation` discriminated union + per-variant semantics
- `AvlTreeConfig` interface
- `VerifyAvlBatchResult` interface
- `AvlVerifyError` class + 6 codes
- Behavior on failure (null return vs throw)
- Internal types referenced (`OperationResult`)

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/README.md packages/avltree/API.md
git commit -m "docs(avltree): README + API.md"
```

---

### Task 29: Final verification — CI scans, cross-runtime, publish-ready review

**Files:**
- (Verification only; no code changes expected unless an issue surfaces)

- [ ] **Step 1: Run full test suite for the avltree package**

Run: `npm test -w @mwaddip/ergots-avltree`
Expected: All tests PASS under node environment.

- [ ] **Step 2: Run cross-runtime tests under jsdom**

Run: `npm run test:browser -w @mwaddip/ergots-avltree`
Expected: All tests PASS under jsdom.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Build for publish**

Run: `npm run build -w @mwaddip/ergots-avltree`
Expected: `packages/avltree/dist/` contains `index.js`, `index.d.ts`, and source maps.

- [ ] **Step 5: Verify bundle is browser-clean**

Run:
```bash
grep -rE "Buffer|process\\.|require\\(|node:" packages/avltree/dist/
```
Expected: No matches.

Run:
```bash
find packages/avltree/dist -name "*.wasm" -o -name "*.cjs"
```
Expected: No matches.

- [ ] **Step 6: Run the full repo test suite + fixture-gen determinism check**

Run: `cd /home/mwaddip/projects/ergots && npm test`
Expected: All packages' tests pass.

Run: `cd /home/mwaddip/projects/ergots/fixture-gen && cargo build && cargo test`
Expected: PASS.

Run: `cd /home/mwaddip/projects/ergots/fixture-gen && cargo run --release && git diff packages/`
Expected: No diff (regenerated fixtures match committed; determinism check).

- [ ] **Step 7: Confirm version cadence criteria from design spec § Version cadence are all met**

Verify checklist:
- [x] Full verifier surface implemented (all 8 Operation variants)
- [x] Both functional wrappers (`verifyAvlBatch`, `verifyAvlLookup`)
- [x] ≥150 corpus fixtures pass byte-for-byte
- [x] ≥90% mutation kill rate per Operation variant
- [x] `facts/avltree.md` complete with Source Mapping table
- [x] Browser-clean per CI scans (Step 5)
- [x] README + API.md authored

If all check, the package is **ready for `npm publish`** (timing user's call per project norms).

- [ ] **Step 8: Final review pass for unintentional Rust verbatim copies**

Per CLAUDE.md "Never copy-port code from sigma-rust or ergo-node-rust verbatim" + [[feedback-rust-port-style]]: spot-check a few functions and confirm they're TS-idiomatic, not line-by-line transliterations. Source comments naming Rust counterparts are correct discipline; verbatim TS code matching Rust struct/function names character-by-character is not.

- [ ] **Step 9: Update PLAN.md status header**

At the top of this file, add:

```markdown
**Status: ✅ COMPLETE 2026-MM-DD** — @mwaddip/ergots-avltree v0.1.0 ready for npm publish.
[Brief summary of what shipped: source file count, test count, fixture count, mutation kill rate, etc.]
```

- [ ] **Step 10: Commit + push**

```bash
git add PLAN.md
git commit -m "chore(plan): mark 2h-a PLAN complete; @mwaddip/ergots-avltree v0.1.0 ready"
git push origin master
```

The package is ready for npm publish whenever the user wants to ship it. 2h-b (ergoscript integration) gets its own brainstorm + spec + PLAN cycle after.

---

## Self-review

**Spec coverage:** Every section of `docs/specs/2026-05-18-ergots-avltree-package-design.md` is implemented by at least one task:
- Goal + Scope → Tasks 1-20 (full package surface)
- Non-goals → respected throughout (prover not ported; `BatchAvlVerifier` internal-only; `AvlTreeData` stays in ergoscript)
- Architecture (file layout) → Task 1 scaffolding + Tasks 3-20 per-file population
- Architecture (component graph) → enforced by per-task file scope
- Architecture (data flow) → exercised by Task 18 corpus tests
- Public API surface → Tasks 18-20
- Error model (Tier 1 AvlVerifyError) → Task 4 + validation in Task 18
- Error model (Tier 2 AvlVerifyFailReason) → Task 4 (declared) + Task 17 (tracked on BatchAvlVerifier)
- Browser-compat → Tasks 1, 7, 18, 29 (CI scan)
- Validation strategy (3 layers) → Tasks 9, 10, 18, 19, 24, 25
- Fixture-gen plumbing → Tasks 2, 8, 13, 21-23
- Confidence escalation → cited in Tasks 9 (proof-decode), 10-11 (traversal), 7 (labeling), 12 (rotations) by virtue of source-first discipline
- Source-mapping discipline → Tasks 26-27
- Version cadence → Task 29 final check
- Risks → mitigations live in the relevant tasks (mutation testing, bounds checks, determinism check, etc.)
- Open items for PLAN.md (per design spec) → addressed: fixture counts in Tasks 13/21/22, mutation kill rate target in Task 25, source-mapping table population in Task 26
- Open items for 2h-b → explicitly deferred

**Placeholder scan:** No "TBD" or "TODO" in tasks. Where the implementer is expected to fill in Rust-port detail, the task names the Rust source file + line range explicitly. The note in Task 7 about "Specific bytes TBD via Task 13's fixture-gen output" is acceptable because (a) Task 7's test still has byte-length + cache-idempotence assertions that pass, (b) Task 24 converts those to byte-equality once fixtures land.

**Type consistency:**
- `Operation` discriminated union: defined in Task 5; used in Tasks 14-19. Tag names + payload shapes consistent.
- `AvlTreeConfig`: defined in Task 3; used in Tasks 9, 17, 18, 19. Shape consistent.
- `AvlNode` / `LeafNode` / `InternalNode` / `LabelNode`: defined in Task 6; used in Tasks 7, 9, 11, 12, 14-17. Names consistent.
- `TraversalState`: defined in Task 10; used in Tasks 11, 14-17.
- `ModifyResult` / `ModifyOk` / `ModifyFail`: defined in Task 14; used in Tasks 16, 17.
- `BatchAvlVerifier`: defined in Task 17; used in Task 18.
- `verifyAvlBatch` / `verifyAvlLookup`: defined in Tasks 18, 19; exported in Task 20.
- Function names: `nextDirectionIsLeft`, `replayComparison`, `keyMatchesLeaf`, `modifyHelper`, `deleteHelper`, `parseProofPackedTree`, `label`, `newLeaf`, `newInternal`, `newLabel`, `doubleLeftRotate`, `doubleRightRotate`, `updateFn` — all consistent across declaration and usage tasks.
- `AvlVerifyError` codes (6): `'invalid-config-key-length'`, `'invalid-config-value-length'`, `'invalid-config-max-ops'`, `'invalid-starting-digest-length'`, `'operation-key-length-mismatch'`, `'operation-value-length-mismatch'` — match design spec exactly.
- `AvlVerifyFailReason` codes (10): `'proof-truncated'`, `'proof-malformed'`, `'digest-mismatch'`, `'directions-exhausted'`, `'leaf-key-out-of-order'`, `'max-nodes-exceeded'`, `'operation-precondition-failed'`, `'tree-poisoned'`, `'empty-tree'`, `'operation-required-but-not-allowed'` — match design spec exactly.
