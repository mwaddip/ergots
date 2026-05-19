# Plan: Phase 2h-b — `@ergots/ergoscript` ↔ `@ergots/avltree` integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire 13 `SAvlTree.*` method handlers in `@ergots/ergoscript` (registry 8 → 21), add `verifyAvlBatchPartial` to `@ergots/avltree` (v0.1.0 → v0.2.0) for V3+ partial-success semantics, and stabilize the SAvlTree wire-format slice + `AvlTreeData` runtime shape.

**Architecture:** Two packages bumped together. `@ergots/avltree` adds one targeted function. `@ergots/ergoscript` extends method-call dispatcher with 13 handlers (7 pure accessors + 6 verification ops calling into avltree). Fixture-gen extended with a per-handler corpus. TDD throughout — every handler is its own RED-GREEN cycle.

**Tech Stack:** TypeScript + vitest (TS side) + Rust + Cargo (fixture-gen side). `@noble/hashes@2.2.0` (no new deps). `@ergots/avltree` workspace alias.

**Design spec:** `docs/specs/2026-05-19-ergoscript-phase-2h-b-avltree-integration-design.md` (committed `b5932e0`).

---

## OVERRIDES preamble for every subagent dispatched against this plan

Every subagent implementing tasks below MUST receive this preamble (per `[[feedback-subagent-explicit-rules]]`):

> **OVERRIDES rules (project-wide; override conflicting defaults):**
>
> - **Rule #2 — Confidence escalation:** if confidence on a cryptographic invariant, byte-format detail, or V3+/V<3 failure-path semantic drops below 95%, halt and declare. Read sigma-rust source first.
> - **Rule #5 — Root-cause mandate:** no `try/catch` swallows, no retry loops, no flag-vars to skip broken logic. Fix the origin.
> - **Rule #6 — Forced verification:** run `npx tsc --noEmit` AND the affected workspace's `npm test` after every implementation step; FIX all errors before claiming done.
> - **Rule #7 — Context decay:** after 10+ messages, re-read files before editing them.
> - **Rule #8 — Edit integrity:** read-edit-read around every edit. Max 3 edits to the same file without a verification read between batches.
>
> **TDD Iron Law:** no production code without a failing test first.
> **Source-first discipline:** read `~/projects/ergots/external/sigma-rust/...` before writing TS.

---

## Phase ordering

**B → A → C → D → E → F → G → H.** Tight dependency chain:

- **B** runs first — generates ALL fixtures (no dependencies on TS code; uses sigma-rust + ergo_avltree_rust on Rust side). Unblocks every downstream test.
- **A** consumes B's `partial/insert-fail-at-3-of-5.json` fixture for the partial-success test. v0.2.0 ships verifyAvlBatchPartial.
- **C** consumes B's accessor fixtures for the wire-format round-trip test (`savltree/digest/basic.json` has the SAvlTree const we need).
- **D** depends on C (AvlTreeData runtime + wire format) and B (per-accessor fixtures).
- **E** depends only on C (pure adapter helpers; no fixtures needed).
- **F** depends on A + C + E + B (verifyAvlBatchPartial + adapter + tier-2 fixtures).
- **G** depends on F (mutation tests across verification op success-path fixtures).
- **H** is finalization.

Per `[[feedback-no-artificial-stops]]`: drive through B→A→C→D→E→F→G→H with per-task commits; only stop on verification failure or surprise.

Note: phase labels (A through H) follow the design-spec narrative ordering; execution ordering is B → A → C → D → E → F → G → H. The label letter does NOT determine execution priority.

---

## Phase A: `@ergots/avltree` v0.2.0 — `verifyAvlBatchPartial`

### Task A1 — Add `verifyAvlBatchPartial` (TDD red→green)

**Files:**
- Create: `packages/avltree/test/verify-batch-partial.test.ts`
- Modify: `packages/avltree/src/verify.ts`
- Modify: `packages/avltree/src/batch-verifier.ts` (expose post-failure digest if not already accessible)
- Modify: `packages/avltree/src/index.ts` (re-export `verifyAvlBatchPartial`)

- [ ] **Step A1.1: Read sigma-rust source for the partial-success digest read.**

```bash
sed -n '220,280p' /home/mwaddip/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/savltree.rs
```

Look for how sigma-rust reads `bv.digest()` after a `perform_one_operation` failure to confirm: the digest reflects only successful ops, never the failed op's partial state.

- [ ] **Step A1.2: Write failing test for the all-pass path (sanity check on wrapper isomorphism).**

Edit `packages/avltree/test/verify-batch-partial.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyAvlBatchPartial, verifyAvlBatch } from '../src/verify.ts'
import type { Operation } from '../src/operation.ts'

const fixturesDir = join(__dirname, 'fixtures')

// Pick an existing all-pass fixture from the v0.1.0 corpus.
// (Path may need adjusting based on actual fixture layout.)
const allPassFixture = JSON.parse(
  readFileSync(join(fixturesDir, 'corpus/insert-balanced-10.json'), 'utf8')
)

describe('verifyAvlBatchPartial: all-pass equivalence with verifyAvlBatch', () => {
  test('returns opsCompleted === operations.length on success', () => {
    const startingDigest = Uint8Array.from(Buffer.from(allPassFixture.starting_digest_hex, 'hex'))
    const proof = Uint8Array.from(Buffer.from(allPassFixture.proof_hex, 'hex'))
    const config = allPassFixture.config
    const operations: Operation[] = allPassFixture.operations.map(decodeOp)

    const partial = verifyAvlBatchPartial(startingDigest, proof, config, operations)
    expect(partial).not.toBeNull()
    expect(partial!.opsCompleted).toBe(operations.length)

    const batch = verifyAvlBatch(startingDigest, proof, config, operations)
    expect(batch).not.toBeNull()
    expect(partial!.newDigest).toEqual(batch!.newDigest)
    expect(partial!.results).toEqual(batch!.results)
  })
})

function decodeOp(o: any): Operation { /* tag dispatch; mirrors fixture-gen encoding */ return o }
```

Run: `cd packages/avltree && npx vitest run verify-batch-partial.test.ts`
Expected: FAIL with `verifyAvlBatchPartial is not a function`.

- [ ] **Step A1.3: Implement `verifyAvlBatchPartial`.**

Edit `packages/avltree/src/verify.ts`:

```ts
export function verifyAvlBatchPartial(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): { newDigest: Uint8Array; results: (Uint8Array | null)[]; opsCompleted: number } | null {
  // Reuse the existing shape validation
  validateConfig(config)
  validateStartingDigest(startingDigest)
  for (const op of operations) validateOpAgainstConfig(op, config)

  const verifier = new BatchAvlVerifier(startingDigest, proof, config)
  if (verifier.failed) return null  // verifier construct fail (proof decode, digest mismatch)

  const results: (Uint8Array | null)[] = []
  let opsCompleted = 0
  for (const op of operations) {
    const r = verifier.performOneOperation(op)
    if (r.failed) {
      // Take the digest as of the LAST successful op
      const partialDigest = verifier.digestAtLastSuccess()
      return { newDigest: partialDigest, results, opsCompleted }
    }
    results.push(r.oldValue)
    opsCompleted++
  }
  return { newDigest: verifier.digest(), results, opsCompleted }
}
```

Note: `BatchAvlVerifier.digestAtLastSuccess()` may need to be added — verify whether the verifier already exposes a digest that reflects last-success state, or whether a snapshot is needed. If sigma-rust's `bv.digest()` returns the post-failure (== last-success) digest naturally, then no new method needed — call `verifier.digest()`.

- [ ] **Step A1.4: Refactor `verifyAvlBatch` as wrapper.**

Edit `packages/avltree/src/verify.ts`:

```ts
export function verifyAvlBatch(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): VerifyAvlBatchResult | null {
  const partial = verifyAvlBatchPartial(startingDigest, proof, config, operations)
  if (partial === null) return null
  if (partial.opsCompleted < operations.length) return null
  return { newDigest: partial.newDigest, results: partial.results }
}
```

- [ ] **Step A1.5: Run all `@ergots/avltree` tests.**

Run: `cd packages/avltree && npm test 2>&1 | tail -20`
Expected: 140+ tests pass (140 existing + new partial test). Existing tests pass because `verifyAvlBatch` is now a thin wrapper byte-equivalent on the all-pass path.

- [ ] **Step A1.6: Write failing test for partial-success path.**

Add to `packages/avltree/test/verify-batch-partial.test.ts`:

```ts
test('returns partial result when op 3 of 5 fails (Insert on existing key)', () => {
  // Setup: starting tree has key K. Operations: Insert K1, Insert K2, Insert K (will fail), Insert K3, Insert K4.
  // Generate this fixture via fixture-gen (task B1 produces the fixture).
  const fixture = JSON.parse(
    readFileSync(join(fixturesDir, 'partial/insert-fail-at-3-of-5.json'), 'utf8')
  )
  const partial = verifyAvlBatchPartial(
    Uint8Array.from(Buffer.from(fixture.starting_digest_hex, 'hex')),
    Uint8Array.from(Buffer.from(fixture.proof_hex, 'hex')),
    fixture.config,
    fixture.operations.map(decodeOp),
  )
  expect(partial).not.toBeNull()
  expect(partial!.opsCompleted).toBe(2)  // first 2 ops succeeded
  expect(partial!.newDigest).toEqual(
    Uint8Array.from(Buffer.from(fixture.expected_digest_after_2_ops_hex, 'hex'))
  )
})
```

The fixture `partial/insert-fail-at-3-of-5.json` will be produced in Phase B. For now, write the test, see it fail, and proceed; Phase B fills the fixture.

Run: `cd packages/avltree && npx vitest run verify-batch-partial.test.ts`
Expected: 1 pass + 1 fail (fixture not found).

- [ ] **Step A1.7: Commit (test + implementation; fixture follows in Phase B).**

```bash
cd /home/mwaddip/projects/ergots
git add packages/avltree/src/verify.ts packages/avltree/src/batch-verifier.ts packages/avltree/src/index.ts packages/avltree/test/verify-batch-partial.test.ts
git commit -m "$(cat <<'EOF'
feat(avltree): add verifyAvlBatchPartial for V3+ partial-success semantics

verifyAvlBatch becomes a thin wrapper over verifyAvlBatchPartial:
  verifyAvlBatch(...) === verifyAvlBatchPartial(...) but returns null on
  partial-success (opsCompleted < operations.length).

verifyAvlBatchPartial returns { newDigest, results, opsCompleted } reflecting
the verifier state after the LAST successful operation (or the final state on
all-pass). On verifier construct failure (proof decode / digest mismatch)
returns null (no partial state to report).

Enables @ergots/ergoscript's V3+ SAvlTree.insert/update handlers to honor
sigma-rust's break-on-failure semantics.

Partial-path fixture follows in Phase B.
EOF
)"
```

### Task A2 — Update `facts/avltree.md` + bump version + commit

**Files:**
- Modify: `facts/avltree.md`
- Modify: `packages/avltree/package.json`

- [ ] **Step A2.1: Add `verifyAvlBatchPartial` row to `facts/avltree.md` public surface.**

Locate the "Primary export: `@ergots/avltree`" section. After `verifyAvlLookup`'s entry, insert:

```ts
verifyAvlBatchPartial(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): {
  newDigest: Uint8Array
  results: (Uint8Array | null)[]
  opsCompleted: number
} | null
```

Then add a per-function section mirroring the `verifyAvlBatch` entry's structure:

```markdown
#### `verifyAvlBatchPartial(startingDigest, proof, config, operations)`

- **Precondition:** Same shape validation as `verifyAvlBatch`.
- **Postcondition (success):** Returns `{ newDigest, results, opsCompleted }`. `opsCompleted` is the count of successful operations; `newDigest` reflects the verifier state after the last successful operation. On all-pass, `opsCompleted === operations.length`.
- **Postcondition (partial-success on op failure):** Stops iterating at the first failed operation. Returns the same shape with `opsCompleted < operations.length`. `newDigest` reflects verifier state as of the last successful op.
- **Postcondition (verifier construct failure):** Returns `null`. No partial state to report when the proof itself doesn't anchor.
- **Invariant:** Stateless. Same inputs always produce the same output.
- **Use case:** sigma-rust's V3+ `SAvlTree.insert` / `update` handlers (in `@ergots/ergoscript`'s phase 2h-b) gracefully break on per-entry failure and return a tree with the partial-success digest. `verifyAvlBatchPartial` is the API that supports this without exposing internal verifier state.
```

Also add to Source Mapping table (after the existing rows):

```markdown
| (TS-only; new v0.2.0) | `verifyAvlBatchPartial` (`verify.ts`) | Wrapper around per-op `BatchAvlVerifier.performOneOperation` loop with mid-loop break + digest snapshot. No direct Rust counterpart; sigma-rust handles the partial-success semantic inline in its eval handlers. |
```

- [ ] **Step A2.2: Bump version.**

Edit `packages/avltree/package.json`:

```json
"version": "0.2.0"
```

- [ ] **Step A2.3: Verify avltree still green.**

Run: `cd packages/avltree && npm test 2>&1 | tail -5`
Expected: same pass count as A1.6 (partial-success test still fails until B1 fixture lands, but every other test passes).

- [ ] **Step A2.4: Commit.**

```bash
git add facts/avltree.md packages/avltree/package.json
git commit -m "chore(avltree): bump to 0.2.0 + document verifyAvlBatchPartial in facts"
```

---

## Phase B: fixture-gen extension — Rust side

### Task B1 — Add `fixture-gen/src/cmds/ergoscript_savltree.rs`

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript_savltree.rs`
- Modify: `fixture-gen/src/cmds.rs` (register the new command module)
- Modify: `fixture-gen/src/main.rs` (wire the command into the dispatch table)

- [ ] **Step B1.1: Read fixture-gen patterns for prior phases.**

```bash
ls /home/mwaddip/projects/ergots/fixture-gen/src/cmds/
cat /home/mwaddip/projects/ergots/fixture-gen/src/cmds.rs
```

Identify the existing command structure. Pattern: each cmd module exposes a `pub fn run(out_dir: &Path) -> Result<()>` and is dispatched by name from `main.rs`.

- [ ] **Step B1.2: Read sigma-rust `try_eval_out` signature and the existing `ergoscript_method_handlers.rs` (or equivalent prior eval fixture-gen module).**

```bash
grep -rn "try_eval_out" /home/mwaddip/projects/ergots/fixture-gen/src/ | head -5
```

Lift the established pattern for generating eval fixtures: construct ErgoTree → eval via try_eval_out → emit JSON with `tree_hex`, `expected_value_kind`, `expected_value_data`, `expected_jit_cost`.

- [ ] **Step B1.3: Implement the cmd module.**

`fixture-gen/src/cmds/ergoscript_savltree.rs`:

```rust
//! Generate fixtures for @ergots/ergoscript phase 2h-b SAvlTree.* method handlers.
//!
//! Per design spec docs/specs/2026-05-19-ergoscript-phase-2h-b-avltree-integration-design.md.
//! Produces ~55-65 fixtures across 13 handlers + the avltree-partial test fixture.

use anyhow::Result;
use std::path::Path;

pub fn run(out_dir: &Path) -> Result<()> {
    let ergoscript_savltree_dir = out_dir
        .join("packages/ergoscript/test/fixtures/savltree");
    let avltree_partial_dir = out_dir
        .join("packages/avltree/test/fixtures/partial");

    std::fs::create_dir_all(&ergoscript_savltree_dir)?;
    std::fs::create_dir_all(&avltree_partial_dir)?;

    // === Tier 1 accessors ===
    digest_fixtures(&ergoscript_savltree_dir.join("digest"))?;
    enabled_operations_fixtures(&ergoscript_savltree_dir.join("enabledOperations"))?;
    key_length_fixtures(&ergoscript_savltree_dir.join("keyLength"))?;
    value_length_opt_fixtures(&ergoscript_savltree_dir.join("valueLengthOpt"))?;
    is_insert_allowed_fixtures(&ergoscript_savltree_dir.join("isInsertAllowed"))?;
    is_update_allowed_fixtures(&ergoscript_savltree_dir.join("isUpdateAllowed"))?;
    is_remove_allowed_fixtures(&ergoscript_savltree_dir.join("isRemoveAllowed"))?;

    // === Tier 2 verification ops ===
    contains_fixtures(&ergoscript_savltree_dir.join("contains"))?;
    get_fixtures(&ergoscript_savltree_dir.join("get"))?;
    get_many_fixtures(&ergoscript_savltree_dir.join("getMany"))?;
    insert_fixtures(&ergoscript_savltree_dir.join("insert"))?;
    update_fixtures(&ergoscript_savltree_dir.join("update"))?;
    remove_fixtures(&ergoscript_savltree_dir.join("remove"))?;

    // === avltree partial-success path ===
    avltree_partial_fixtures(&avltree_partial_dir)?;

    Ok(())
}

// Implementer note: each function below follows the same template:
//   1. construct AvlTreeData with parameterized treeFlags, keyLength, valueLengthOpt
//   2. (for verification ops) use BatchAVLProver to build a real AD proof
//   3. construct ErgoTree { Const(SAvlTree, AvlTreeData) + MethodCall(this, methodId, args) }
//   4. try_eval_out(tree, ctx) → expected value + jit_cost
//   5. emit JSON: { description, tree_hex, expected_value_kind, expected_value_data,
//                   expected_jit_cost, ergo_tree_version }
// Read the prior phase 2g.5 / 2g.6 fixture-gen modules for the established pattern.

fn digest_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn enabled_operations_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn key_length_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn value_length_opt_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn is_insert_allowed_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn is_update_allowed_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn is_remove_allowed_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn contains_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn get_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn get_many_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn insert_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn update_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
fn remove_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }

/// Generates the partial/insert-fail-at-3-of-5.json fixture that Task A1.6 consumes.
fn avltree_partial_fixtures(out: &Path) -> Result<()> { /* ... */ Ok(()) }
```

(Implementer: each helper function lifts the AvlTreeData + ErgoTree + try_eval_out pattern from the closest prior fixture-gen module — see e.g. `cmds/ergoscript_method_handlers.rs` or whichever fixture-gen module the prior 2g.6 commits added. Source-read first.)

- [ ] **Step B1.4: Register cmd in `fixture-gen/src/cmds.rs`.**

```rust
pub mod ergoscript_savltree;
```

- [ ] **Step B1.5: Wire cmd in `fixture-gen/src/main.rs`.**

Follow the existing dispatch pattern — add a match arm for `"ergoscript_savltree"`.

- [ ] **Step B1.6: Build + run fixture-gen.**

```bash
cd /home/mwaddip/projects/ergots/fixture-gen
cargo build --release
cargo run --release -- ergoscript_savltree
```

Expected: clean build; new fixtures emitted under `packages/ergoscript/test/fixtures/savltree/` and `packages/avltree/test/fixtures/partial/`.

- [ ] **Step B1.7: Re-run all fixture-gen commands to confirm determinism.**

```bash
cargo run --release
```

Expected: no diff against committed fixtures from prior phases.

- [ ] **Step B1.8: Verify avltree partial test now passes.**

```bash
cd /home/mwaddip/projects/ergots/packages/avltree && npm test 2>&1 | tail -10
```

Expected: All tests pass (the A1.6 partial test now has its fixture).

- [ ] **Step B1.9: Commit.**

```bash
cd /home/mwaddip/projects/ergots
git add fixture-gen/src/ packages/ergoscript/test/fixtures/savltree/ packages/avltree/test/fixtures/partial/
git commit -m "$(cat <<'EOF'
feat(fixture-gen): add ergoscript_savltree cmd for phase 2h-b fixtures

Emits ~55-65 fixtures across 13 SAvlTree.* method handlers (7 accessors
+ 6 verification ops). Generates AvlTreeData scenarios with varied treeFlags,
keyLength, valueLengthOpt. Verification-op fixtures use BatchAVLProver to
produce real AD proofs.

Also emits packages/avltree/test/fixtures/partial/ for the verifyAvlBatchPartial
test cases (V3+ partial-success path validation).

Per design spec docs/specs/2026-05-19-ergoscript-phase-2h-b-avltree-integration-design.md.
EOF
)"
```

---

## Phase C: `AvlTreeData` runtime + SAvlTree wire-format slice

### Task C1 — Promote `AvlTreeData` runtime shape (RED→GREEN)

**Files:**
- Modify: `packages/ergoscript/src/mir/types.ts`

- [ ] **Step C1.1: Read current `AvlTreeData` forward-declaration.**

```bash
grep -n "AvlTreeData" /home/mwaddip/projects/ergots/packages/ergoscript/src/mir/types.ts
```

Expected: a placeholder type with minimal fields (likely `{ raw: Uint8Array }` or similar).

- [ ] **Step C1.2: Read sigma-rust `AvlTreeData` source to confirm field shape.**

```bash
sed -n '56,69p' /home/mwaddip/projects/ergots/external/sigma-rust/ergotree-ir/src/mir/avl_tree_data.rs
```

Confirm: `digest: ADDigest` (33 bytes), `tree_flags: AvlTreeFlags(u8)`, `key_length: u32`, `value_length_opt: Option<Box<u32>>`.

- [ ] **Step C1.3: Promote the type in `mir/types.ts`.**

Replace the existing placeholder with:

```ts
/**
 * Runtime shape of an AVL+ tree value (mirrors sigma-rust ergotree-ir/src/mir/avl_tree_data.rs:60-69).
 *
 * `digest` is the 33-byte canonical form: 32-byte root hash + 1-byte tree height.
 *
 * `treeFlags` bit layout (per AvlTreeFlags::new in avl_tree_data.rs:16-25):
 *   bit 0 (0x01): insertAllowed
 *   bit 1 (0x02): updateAllowed
 *   bit 2 (0x04): removeAllowed
 *   bits 3-7: reserved
 */
export interface AvlTreeData {
  digest: Uint8Array              // exactly 33 bytes
  treeFlags: number               // u8
  keyLength: number               // u32; >= 0
  valueLengthOpt: number | null   // null when variable; non-null = fixed value length
}
```

- [ ] **Step C1.4: Run tsc to catch any consumers that broke.**

```bash
cd /home/mwaddip/projects/ergots/packages/ergoscript && npx tsc --noEmit
```

Expected: clean OR a small handful of consumer-side errors (likely none since the prior placeholder was unused). If errors surface, fix them inline before commit.

- [ ] **Step C1.5: Commit.**

```bash
cd /home/mwaddip/projects/ergots
git add packages/ergoscript/src/mir/types.ts
git commit -m "feat(ergoscript): stabilize AvlTreeData runtime shape

Promote AvlTreeData from phase-2a forward-declaration to stable struct:
{ digest: Uint8Array(33), treeFlags: u8, keyLength: u32, valueLengthOpt: u32 | null }.

Mirrors sigma-rust ergotree-ir/src/mir/avl_tree_data.rs:60-69.
Bit layout for treeFlags: bit 0 insert, bit 1 update, bit 2 remove.

Prereq for phase 2h-b SAvlTree.* method handlers."
```

### Task C2 — SAvlTree wire-format parse (RED→GREEN)

**Files:**
- Modify: `packages/ergoscript/src/wire/parse-svalue.ts`
- Create: `packages/ergoscript/test/wire/svalue-savltree.test.ts`

- [ ] **Step C2.1: Read sigma-rust `AvlTreeData::sigma_parse` source.**

```bash
sed -n '71,91p' /home/mwaddip/projects/ergots/external/sigma-rust/ergotree-ir/src/mir/avl_tree_data.rs
```

Order: ADDigest scorex_parse → u8 tree_flags → u32 key_length → Option<Box<u32>> value_length_opt.

Confirm `r.get_u32()` is fixed 4-byte little-endian (not VLQ) by reading the underlying `SigmaByteRead::get_u32` definition:

```bash
grep -rn "fn get_u32" /home/mwaddip/projects/ergots/external/sigma-rust/sigma-ser/src/ | head -5
```

- [ ] **Step C2.2: Write failing round-trip test using a fixture (any avltree fixture that includes an SAvlTree constant works).**

Edit `packages/ergoscript/test/wire/svalue-savltree.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSValue } from '../../src/wire/parse-svalue.ts'
import { serializeSValue } from '../../src/wire/serialize-svalue.ts'
import { ByteReader } from '../../src/wire/reader.ts'
import { ByteWriter } from '../../src/wire/writer.ts'
import type { SType } from '../../src/mir/types.ts'

const fixturesDir = join(__dirname, '..', 'fixtures')

describe('SAvlTree wire format round-trip', () => {
  test('parses + serializes AvlTreeData byte-identically', () => {
    // Use the first digest fixture (Tier 1 accessor); its tree_hex contains
    // a Const(SAvlTree, AvlTreeData) we can extract.
    const fxt = JSON.parse(
      readFileSync(join(fixturesDir, 'savltree/digest/basic.json'), 'utf8')
    )
    // The fixture's tree_hex is the full ErgoTree; for this test we want just
    // the SValue bytes. The fixture-gen also emits `savltree_const_hex` for
    // this purpose. (If it doesn't, add a getter and re-generate.)
    const bytes = Uint8Array.from(Buffer.from(fxt.savltree_const_hex, 'hex'))
    const tpe: SType = { tag: 'SAvlTree' }

    const r = new ByteReader(bytes)
    const parsed = parseSValue(tpe, r)
    expect(parsed.kind).toBe('AvlTree')
    expect(r.isExhausted).toBe(true)

    const w = new ByteWriter()
    serializeSValue(tpe, parsed, w)
    expect(w.toBytes()).toEqual(bytes)
  })
})
```

Run: `cd packages/ergoscript && npx vitest run wire/svalue-savltree.test.ts`
Expected: FAIL with `'not-implemented-phase-2a'` (the existing throw).

- [ ] **Step C2.3: Implement parse case for SAvlTree.**

Edit `packages/ergoscript/src/wire/parse-svalue.ts`. Locate the switch on `tpe.tag` and replace the `case 'SAvlTree':` throw with:

```ts
case 'SAvlTree': {
  // Port of sigma-rust AvlTreeData::sigma_parse (avl_tree_data.rs:79-90)
  const digest = readAdDigest(r)                  // scorex-encoded: u16 length + bytes
  const treeFlags = r.readU8()
  const keyLength = r.readU32()                   // fixed 4-byte LE
  const valueLengthOpt = readOptionU32(r)         // 0x00 None | 0x01 + u32 Some
  return {
    kind: 'AvlTree',
    value: { digest, treeFlags, keyLength, valueLengthOpt },
  }
}
```

Add helpers if not already present:

```ts
function readAdDigest(r: ByteReader): Uint8Array {
  // sigma-rust ergo_chain_types::ADDigest::scorex_parse: u16 length prefix + bytes
  const len = r.readU16()  // confirm method name; could be readUShort
  if (len !== 33) {
    throw new SValueParseError(`AvlTreeData.digest: expected 33 bytes, got ${len}`, 'avl-tree-digest-length')
  }
  return r.readBytes(33)
}

function readOptionU32(r: ByteReader): number | null {
  const tag = r.readU8()
  if (tag === 0) return null
  if (tag === 1) return r.readU32()
  throw new SValueParseError(`Option<u32>: invalid tag ${tag}`, 'invalid-option-tag')
}
```

Also: if `'avl-tree-digest-length'` is a new code, add it to the `SValueParseError` taxonomy in `errors.ts`. (Optional: reuse `'unreachable'` or similar — but a dedicated code helps debugging.)

Run: `cd packages/ergoscript && npx vitest run wire/svalue-savltree.test.ts`
Expected: parse passes; serialize fails (still throws not-impl).

- [ ] **Step C2.4: Commit progress so far (parse-only).**

```bash
cd /home/mwaddip/projects/ergots
git add packages/ergoscript/src/wire/parse-svalue.ts packages/ergoscript/src/errors.ts packages/ergoscript/test/wire/svalue-savltree.test.ts
git commit -m "feat(ergoscript): SAvlTree wire-format parse (phase 2h-b)

Replaces phase-2a 'not-implemented' throw with the AvlTreeData parser:
  digest: scorex-encoded (u16 length + 33 bytes)
  treeFlags: u8
  keyLength: u32 (fixed 4-byte LE)
  valueLengthOpt: Option<u32>

Mirrors sigma-rust avl_tree_data.rs:79-90."
```

### Task C3 — SAvlTree wire-format serialize (RED→GREEN)

**Files:**
- Modify: `packages/ergoscript/src/wire/serialize-svalue.ts`
- Modify: `facts/ergoscript-wire.md` (narrow `'not-implemented-phase-2a'` set to remove `SAvlTree`)

- [ ] **Step C3.1: Implement serialize case symmetric to parse.**

```ts
case 'SAvlTree': {
  // Port of sigma-rust AvlTreeData::sigma_serialize (avl_tree_data.rs:72-78)
  if (v.kind !== 'AvlTree') {
    throw new SValueSerializeError(
      `expected AvlTree SValue, got ${v.kind}`,
      'type-value-mismatch',
    )
  }
  const d = v.value
  writeAdDigest(w, d.digest)
  w.writeU8(d.treeFlags)
  w.writeU32(d.keyLength)
  writeOptionU32(w, d.valueLengthOpt)
  return
}
```

With symmetric helpers:

```ts
function writeAdDigest(w: ByteWriter, digest: Uint8Array): void {
  if (digest.length !== 33) {
    throw new SValueSerializeError(
      `AvlTreeData.digest: expected 33 bytes, got ${digest.length}`,
      'avl-tree-digest-length',
    )
  }
  w.writeU16(33)
  w.writeBytes(digest)
}

function writeOptionU32(w: ByteWriter, value: number | null): void {
  if (value === null) {
    w.writeU8(0)
  } else {
    w.writeU8(1)
    w.writeU32(value)
  }
}
```

Add `'avl-tree-digest-length'` to `SValueSerializeError` codes in `errors.ts` if not already there (or reuse from parse).

- [ ] **Step C3.2: Run round-trip test.**

Run: `cd packages/ergoscript && npx vitest run wire/svalue-savltree.test.ts`
Expected: PASS.

- [ ] **Step C3.3: Run full ergoscript tests.**

Run: `cd packages/ergoscript && npm test 2>&1 | tail -10`
Expected: 2658+ tests pass (existing + the new round-trip test).

- [ ] **Step C3.4: Update `facts/ergoscript-wire.md`.**

Locate the `SValueParseError` taxonomy in `facts/ergoscript-wire.md`. Edit the `'not-implemented-phase-2a'` enumeration: remove `SAvlTree` from the listed set (was `SAvlTree/SHeader/SPreHeader/SContext/SGlobal/SAny/SString/SFunc/STypeVar`, becomes `SHeader/SPreHeader/SContext/SGlobal/SAny/SString/SFunc/STypeVar`).

Same edit on `SValueSerializeError`'s `'not-implemented-phase-2a'` enumeration.

Add a brief Stop α-style note at the end of the file:

```markdown
## Phase 2h-b wire updates (SAvlTree)

`parseSValue(SAvlTree, …)` and `serializeSValue(SAvlTree, …)` ship in phase 2h-b, replacing the phase-2a `'not-implemented-phase-2a'` throw. Round-trip invariant byte-equal on all fixture entries. Other deferred SValue kinds (`SHeader`, `SPreHeader`, `SContext`, `SGlobal`, `SAny`, `SString`, `SFunc`, `STypeVar`) still throw `'not-implemented-phase-2a'`.
```

- [ ] **Step C3.5: Commit.**

```bash
git add packages/ergoscript/src/wire/serialize-svalue.ts packages/ergoscript/src/errors.ts facts/ergoscript-wire.md
git commit -m "feat(ergoscript): SAvlTree wire-format serialize + narrow not-impl set

Symmetric port of sigma-rust AvlTreeData::sigma_serialize (avl_tree_data.rs:72-78).
Removes SAvlTree from SValueParseError / SValueSerializeError's
'not-implemented-phase-2a' set in facts/ergoscript-wire.md."
```

---

## Phase D: Tier 1 accessor handlers (7 handlers, 7 tasks)

Each handler is its own RED-GREEN cycle. The first handler establishes the file (`eval/savltree.ts`); subsequent handlers extend it.

### Task D1 — `SAvlTree.digest` (methodId 1)

**Files:**
- Create: `packages/ergoscript/src/eval/savltree.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts` (register handler)
- Modify: `packages/ergoscript/src/errors.ts` (add `'avl-tree-obj-not-avl-tree'` to EvalErrorCode)
- Create: `packages/ergoscript/test/eval/savltree-accessors.test.ts`

- [ ] **Step D1.1: Read sigma-rust DIGEST_EVAL_FN.**

```bash
grep -n "DIGEST_EVAL_FN\|fn digest" /home/mwaddip/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/savltree.rs | head -10
```

Capture line range. Look for: (1) cost charge value (likely `ctx.add_cost(...)`); (2) Pattern A vs B; (3) return shape (Value::Coll of bytes).

- [ ] **Step D1.2: Write failing test.**

Edit `packages/ergoscript/test/eval/savltree-accessors.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseTree } from '../../src/wire/parse.ts'
import { evaluate } from '../../src/eval/eval.ts'

const fixturesDir = join(__dirname, '..', 'fixtures', 'savltree')

function runFixture(handlerName: string, scenario: string) {
  const fxt = JSON.parse(
    readFileSync(join(fixturesDir, handlerName, `${scenario}.json`), 'utf8')
  )
  const tree = parseTree(Uint8Array.from(Buffer.from(fxt.tree_hex, 'hex')))
  const ctx = { jitCostLimit: undefined, ...fxt.opts }
  const result = evaluate(tree, ctx)
  return { result, expectedValue: fxt.expected_value, expectedCost: fxt.expected_jit_cost, ctx }
}

describe('SAvlTree.digest', () => {
  const scenarios = readdirSync(join(fixturesDir, 'digest'))
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))

  for (const scenario of scenarios) {
    test(scenario, () => {
      const { result, expectedValue, expectedCost, ctx } = runFixture('digest', scenario)
      expect(result.kind).toBe('Coll')
      // Detailed comparison delegated to a shared SValue comparator helper
      expectSValueEquals(result, expectedValue)
      expect(ctx.jitCost).toBe(expectedCost)
    })
  }
})

// Helper: structural SValue compare (lift from existing test infrastructure if available;
// otherwise implement inline). Compares { kind, value, items, elem, etc. } recursively.
function expectSValueEquals(actual: any, expected: any): void { /* ... */ }
```

Run: `cd packages/ergoscript && npx vitest run eval/savltree-accessors.test.ts`
Expected: FAIL with `'method-not-implemented'` (registry has no entry for `(100, 1)`).

- [ ] **Step D1.3: Create `eval/savltree.ts` with the digest handler.**

```ts
/**
 * SAvlTree.* method-call handlers (phase 2h-b).
 *
 * Ports sigma-rust ergotree-interpreter/src/eval/savltree.rs handlers.
 * See facts/ergoscript-eval.md Method-handler registry for the full table.
 */

import type { EvalContext } from './context.ts'
import type { SValue } from '../mir/types.ts'
import { EvalError } from '../errors.ts'

function expectAvlTree(obj: SValue): asserts obj is { kind: 'AvlTree'; value: AvlTreeData } {
  if (obj.kind !== 'AvlTree') {
    throw new EvalError(`expected AvlTree receiver, got ${obj.kind}`, 'avl-tree-obj-not-avl-tree')
  }
}

/** Ports SAvlTree.digest handler (eval/savltree.rs:<line range from Step D1.1>). */
export function evalSAvlTreeDigest(
  ctx: EvalContext,
  obj: SValue,
  _args: SValue[],
): SValue {
  expectAvlTree(obj)
  ctx.addCost(/* TODO: cost from Step D1.1 */)
  return {
    kind: 'Coll',
    elem: { tag: 'SByte' },
    items: Array.from(obj.value.digest, b => ({ kind: 'Byte', value: b })),
  }
}
```

(Replace `/* TODO: cost ... */` with the actual cost value read in Step D1.1.)

- [ ] **Step D1.4: Register in `method-call.ts`.**

Locate the `HANDLERS` registry. Add:

```ts
import { evalSAvlTreeDigest } from './savltree.ts'

// ... inside HANDLERS map ...
HANDLERS.set(handlerKey(100, 1), evalSAvlTreeDigest)
```

(`handlerKey(typeId, methodId)` is the existing keying function.)

- [ ] **Step D1.5: Add `'avl-tree-obj-not-avl-tree'` to EvalErrorCode.**

Edit `packages/ergoscript/src/errors.ts`. Locate the `EvalErrorCode` type. Insert `| 'avl-tree-obj-not-avl-tree'` in the union.

- [ ] **Step D1.6: Run tests.**

Run: `cd packages/ergoscript && npx vitest run eval/savltree-accessors.test.ts`
Expected: PASS for digest scenarios.

- [ ] **Step D1.7: Run full ergoscript test suite + tsc.**

```bash
cd packages/ergoscript && npx tsc --noEmit && npm test 2>&1 | tail -10
```

Expected: both clean.

- [ ] **Step D1.8: Commit.**

```bash
cd /home/mwaddip/projects/ergots
git add packages/ergoscript/src/eval/savltree.ts packages/ergoscript/src/eval/method-call.ts packages/ergoscript/src/errors.ts packages/ergoscript/test/eval/savltree-accessors.test.ts
git commit -m "feat(ergoscript): SAvlTree.digest method handler (phase 2h-b)

First of 13 method handlers in 2h-b. Registry grows 8 → 9.
New EvalError code: 'avl-tree-obj-not-avl-tree' (43 → 44).

Per design spec docs/specs/2026-05-19-ergoscript-phase-2h-b-avltree-integration-design.md."
```

### Task D2 — `SAvlTree.enabledOperations` (methodId 2)

**Files:**
- Modify: `packages/ergoscript/src/eval/savltree.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts`
- (no new test file — extends `savltree-accessors.test.ts`)

- [ ] **Step D2.1: Read sigma-rust ENABLED_OPERATIONS_EVAL_FN for cost + body.**

```bash
grep -n "ENABLED_OPERATIONS_EVAL_FN" /home/mwaddip/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/savltree.rs
```

- [ ] **Step D2.2: Extend the accessor test file with the new scenario set.**

Add to `test/eval/savltree-accessors.test.ts`:

```ts
describe('SAvlTree.enabledOperations', () => {
  const scenarios = readdirSync(join(fixturesDir, 'enabledOperations'))
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))

  for (const scenario of scenarios) {
    test(scenario, () => {
      const { result, expectedValue, expectedCost, ctx } = runFixture('enabledOperations', scenario)
      expect(result.kind).toBe('Byte')
      expectSValueEquals(result, expectedValue)
      expect(ctx.jitCost).toBe(expectedCost)
    })
  }
})
```

Run: FAIL with `'method-not-implemented'`.

- [ ] **Step D2.3: Add handler to `savltree.ts`.**

```ts
/** Ports SAvlTree.enabledOperations handler (eval/savltree.rs:<line>). */
export function evalSAvlTreeEnabledOperations(
  ctx: EvalContext,
  obj: SValue,
  _args: SValue[],
): SValue {
  expectAvlTree(obj)
  ctx.addCost(/* cost from D2.1 */)
  return { kind: 'Byte', value: obj.value.treeFlags }
}
```

- [ ] **Step D2.4: Register in `method-call.ts`.**

```ts
HANDLERS.set(handlerKey(100, 2), evalSAvlTreeEnabledOperations)
```

- [ ] **Step D2.5: Verify + commit.**

```bash
cd packages/ergoscript && npx tsc --noEmit && npx vitest run eval/savltree-accessors.test.ts
```

Expected: PASS.

```bash
cd /home/mwaddip/projects/ergots
git commit -am "feat(ergoscript): SAvlTree.enabledOperations method handler"
```

### Tasks D3-D7 — Repeat pattern for remaining 5 accessors

Each follows the D2 template. Per-handler distinctions:

- **D3 — `SAvlTree.keyLength`** (methodId 3): returns `{kind:'Int', value: obj.value.keyLength}`.
- **D4 — `SAvlTree.valueLengthOpt`** (methodId 4): returns `{kind:'Option', elem:{tag:'SInt'}, value: obj.value.valueLengthOpt===null ? null : {kind:'Int', value:obj.value.valueLengthOpt}}`.
- **D5 — `SAvlTree.isInsertAllowed`** (methodId 5): returns `{kind:'Boolean', value: (obj.value.treeFlags & 0x01) !== 0}`.
- **D6 — `SAvlTree.isUpdateAllowed`** (methodId 6): returns `{kind:'Boolean', value: (obj.value.treeFlags & 0x02) !== 0}`.
- **D7 — `SAvlTree.isRemoveAllowed`** (methodId 7): returns `{kind:'Boolean', value: (obj.value.treeFlags & 0x04) !== 0}`.

For each: source-read cost, add handler, register, extend test, verify, commit.

After D7, registry = 8 + 7 = 15. EvalError codes = 44.

---

## Phase E: Adapter helpers

### Task E1 — `_avltree-adapter.ts` with TDD-tested helpers

**Files:**
- Create: `packages/ergoscript/src/eval/_avltree-adapter.ts`
- Create: `packages/ergoscript/test/eval/avltree-adapter.test.ts`

- [ ] **Step E1.1: Write failing test for each helper.**

```ts
import { describe, expect, test } from 'vitest'
import {
  avlTreeDataToConfig,
  buildSingleLookupOp,
  buildLookupOps,
  buildInsertOps,
  buildUpdateOps,
  buildRemoveOps,
  withUpdatedDigest,
  extractBytes,
  extractEntries,
} from '../../src/eval/_avltree-adapter.ts'

describe('avlTreeDataToConfig', () => {
  test('projects fields directly', () => {
    const tree = {
      digest: new Uint8Array(33),
      treeFlags: 0x07,
      keyLength: 32,
      valueLengthOpt: 64,
    }
    expect(avlTreeDataToConfig(tree)).toEqual({
      keyLength: 32,
      valueLengthOpt: 64,
    })
  })
})

describe('buildSingleLookupOp', () => {
  test('produces a 1-element Lookup array', () => {
    const key = new Uint8Array([0xAA, 0xBB])
    expect(buildSingleLookupOp(key)).toEqual([{ tag: 'Lookup', key }])
  })
})

describe('buildLookupOps', () => {
  test('maps each key to a Lookup', () => {
    const keys = [new Uint8Array([1]), new Uint8Array([2])]
    expect(buildLookupOps(keys)).toEqual([
      { tag: 'Lookup', key: keys[0] },
      { tag: 'Lookup', key: keys[1] },
    ])
  })
})

describe('buildInsertOps', () => {
  test('extracts key+value tuples from a Coll[Tuple] SValue', () => {
    const entries = {
      kind: 'Coll',
      elem: { tag: 'STuple', items: [{ tag: 'SColl', elem: { tag: 'SByte' } }, { tag: 'SColl', elem: { tag: 'SByte' } }] },
      items: [
        { kind: 'Tuple', items: [collOfBytes([1, 2]), collOfBytes([10, 20])] },
        { kind: 'Tuple', items: [collOfBytes([3, 4]), collOfBytes([30, 40])] },
      ],
    } as any
    expect(buildInsertOps(entries)).toEqual([
      { tag: 'Insert', key: new Uint8Array([1, 2]), value: new Uint8Array([10, 20]) },
      { tag: 'Insert', key: new Uint8Array([3, 4]), value: new Uint8Array([30, 40]) },
    ])
  })
})

// ... similar tests for buildUpdateOps, buildRemoveOps, withUpdatedDigest,
//     extractBytes, extractEntries

function collOfBytes(bytes: number[]): any {
  return {
    kind: 'Coll',
    elem: { tag: 'SByte' },
    items: bytes.map(b => ({ kind: 'Byte', value: b })),
  }
}
```

Run: FAIL (module doesn't exist).

- [ ] **Step E1.2: Implement adapter.**

```ts
import { EvalError } from '../errors.ts'
import type { SValue, AvlTreeData } from '../mir/types.ts'
import type { Operation, AvlTreeConfig } from '@ergots/avltree'

/** Pure projection: AvlTreeData → AvlTreeConfig. */
export function avlTreeDataToConfig(d: AvlTreeData): AvlTreeConfig {
  return {
    keyLength: d.keyLength,
    valueLengthOpt: d.valueLengthOpt,
  }
}

/** Single-key Lookup; for contains/get. */
export function buildSingleLookupOp(key: Uint8Array): Operation[] {
  return [{ tag: 'Lookup', key }]
}

/** Multi-key Lookup; for getMany. */
export function buildLookupOps(keys: Uint8Array[]): Operation[] {
  return keys.map(key => ({ tag: 'Lookup', key }))
}

/** Insert operations from a Coll[Tuple[Coll[Byte], Coll[Byte]]]. */
export function buildInsertOps(entries: SValue): Operation[] {
  const list = extractEntries(entries)
  return list.map(({ key, value }) => ({ tag: 'Insert', key, value }))
}

export function buildUpdateOps(entries: SValue): Operation[] {
  const list = extractEntries(entries)
  return list.map(({ key, value }) => ({ tag: 'Update', key, value }))
}

export function buildRemoveOps(keys: Uint8Array[]): Operation[] {
  return keys.map(key => ({ tag: 'Remove', key }))
}

/** Immutable: carry-forward all fields except digest. */
export function withUpdatedDigest(tree: AvlTreeData, newDigest: Uint8Array): AvlTreeData {
  return {
    digest: newDigest,
    treeFlags: tree.treeFlags,
    keyLength: tree.keyLength,
    valueLengthOpt: tree.valueLengthOpt,
  }
}

/** Coll[Byte] SValue → Uint8Array. Defensive shape check. */
export function extractBytes(v: SValue): Uint8Array {
  if (v.kind !== 'Coll') {
    throw new EvalError(`expected Coll[Byte], got ${v.kind}`, 'method-not-implemented')
  }
  const result = new Uint8Array(v.items.length)
  for (let i = 0; i < v.items.length; i++) {
    const item = v.items[i]!
    if (item.kind !== 'Byte') {
      throw new EvalError(`expected Byte item in Coll, got ${item.kind}`, 'method-not-implemented')
    }
    result[i] = item.value
  }
  return result
}

/** Coll[Coll[Byte]] SValue → Uint8Array[]. */
export function extractByteArrayList(v: SValue): Uint8Array[] {
  if (v.kind !== 'Coll') {
    throw new EvalError(`expected Coll[Coll[Byte]], got ${v.kind}`, 'method-not-implemented')
  }
  return v.items.map(extractBytes)
}

/** Coll[Tuple[Coll[Byte], Coll[Byte]]] SValue → { key, value }[]. */
export function extractEntries(v: SValue): { key: Uint8Array; value: Uint8Array }[] {
  if (v.kind !== 'Coll') {
    throw new EvalError(`expected Coll[Tuple], got ${v.kind}`, 'method-not-implemented')
  }
  return v.items.map(item => {
    if (item.kind !== 'Tuple' || item.items.length !== 2) {
      throw new EvalError(`expected Tuple[2], got ${item.kind}`, 'method-not-implemented')
    }
    return {
      key: extractBytes(item.items[0]!),
      value: extractBytes(item.items[1]!),
    }
  })
}
```

- [ ] **Step E1.3: Run + commit.**

```bash
cd packages/ergoscript && npx vitest run eval/avltree-adapter.test.ts && npx tsc --noEmit
git commit -am "feat(ergoscript): @ergots/avltree adapter helpers (phase 2h-b)"
```

---

## Phase F: Tier 2 verification op handlers (6 handlers, 6 tasks)

Each handler is its own RED-GREEN cycle. All extend `eval/savltree.ts` and register in `method-call.ts`.

### Task F1 — `SAvlTree.contains` (methodId 9)

**Files:**
- Modify: `packages/ergoscript/src/eval/savltree.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts`
- Create: `packages/ergoscript/test/eval/savltree-contains.test.ts`

- [ ] **Step F1.1: Read sigma-rust CONTAINS_EVAL_FN.**

```bash
grep -n "CONTAINS_EVAL_FN" /home/mwaddip/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/savltree.rs
```

Confirm: zero `ctx.add_cost` (no per-handler cost); failure → `false` (never throw); single-key Lookup.

- [ ] **Step F1.2: Write failing tests covering 3 scenarios.**

`test/eval/savltree-contains.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
// ... imports ...

const fixturesDir = join(__dirname, '..', 'fixtures', 'savltree', 'contains')

describe('SAvlTree.contains', () => {
  for (const scenario of readdirSync(fixturesDir).filter(f => f.endsWith('.json'))) {
    test(scenario.replace('.json', ''), () => {
      const fxt = JSON.parse(readFileSync(join(fixturesDir, scenario), 'utf8'))
      const tree = parseTree(Uint8Array.from(Buffer.from(fxt.tree_hex, 'hex')))
      const ctx = { jitCostLimit: undefined, ...fxt.opts }
      const result = evaluate(tree, ctx)
      expect(result.kind).toBe('Boolean')
      expectSValueEquals(result, fxt.expected_value)
      expect(ctx.jitCost).toBe(fxt.expected_jit_cost)
    })
  }
})
```

Expected fixtures: `key-present.json`, `key-absent.json`, `proof-mutated.json`. All produce `false` for the mutated proof case (this is contains's signature behavior).

Run: FAIL.

- [ ] **Step F1.3: Implement handler.**

Add to `eval/savltree.ts`:

```ts
import { verifyAvlBatch } from '@ergots/avltree'
import { avlTreeDataToConfig, buildSingleLookupOp, extractBytes } from './_avltree-adapter.ts'

/** Ports SAvlTree.contains handler (eval/savltree.rs:<lines>). */
export function evalSAvlTreeContains(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[],
): SValue {
  expectAvlTree(obj)
  if (args.length !== 2) {
    throw new EvalError(`contains: expected 2 args, got ${args.length}`, 'method-not-implemented')
  }
  const key = extractBytes(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildSingleLookupOp(key)
  const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
  // Per sigma-rust: any failure (proof OR op) → false. Lookup is read-only;
  // op failure means key not found OR proof structurally invalid → both false.
  if (r === null) return { kind: 'Boolean', value: false }
  const found = r.results[0] !== null
  return { kind: 'Boolean', value: found }
}
```

- [ ] **Step F1.4: Register.**

```ts
HANDLERS.set(handlerKey(100, 9), evalSAvlTreeContains)
```

- [ ] **Step F1.5: Verify + commit.**

```bash
cd packages/ergoscript && npx tsc --noEmit && npx vitest run eval/savltree-contains.test.ts
```

Expected: PASS.

```bash
git commit -am "feat(ergoscript): SAvlTree.contains method handler (phase 2h-b)"
```

### Task F2 — `SAvlTree.get` (methodId 10)

**Files:**
- Modify: `packages/ergoscript/src/eval/savltree.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts`
- Modify: `packages/ergoscript/src/errors.ts` (add `'avl-tree-proof-failed'`)
- Create: `packages/ergoscript/test/eval/savltree-get.test.ts`

- [ ] **Step F2.1: Read sigma-rust GET_EVAL_FN.**

Confirm: proof failure throws (not None). Key absent returns None. Key present returns Some.

- [ ] **Step F2.2: Add `'avl-tree-proof-failed'` to EvalErrorCode union (43 + 'avl-tree-obj-not-avl-tree' = 44, +1 = 45).**

- [ ] **Step F2.3: Write failing test.**

3 scenarios: `key-present.json`, `key-absent.json`, `proof-mutated.json`. The mutated case must throw `EvalError 'avl-tree-proof-failed'`.

- [ ] **Step F2.4: Implement.**

```ts
/** Ports SAvlTree.get handler (eval/savltree.rs:<lines>). */
export function evalSAvlTreeGet(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[],
): SValue {
  expectAvlTree(obj)
  if (args.length !== 2) {
    throw new EvalError(`get: expected 2 args, got ${args.length}`, 'method-not-implemented')
  }
  const key = extractBytes(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildSingleLookupOp(key)
  const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
  if (r === null) {
    throw new EvalError('get: AVL+ proof verification failed', 'avl-tree-proof-failed')
  }
  const found = r.results[0]
  if (found === null) {
    return { kind: 'Option', elem: { tag: 'SColl', elem: { tag: 'SByte' } }, value: null }
  }
  return {
    kind: 'Option',
    elem: { tag: 'SColl', elem: { tag: 'SByte' } },
    value: {
      kind: 'Coll',
      elem: { tag: 'SByte' },
      items: Array.from(found, b => ({ kind: 'Byte', value: b })),
    },
  }
}
```

- [ ] **Step F2.5: Register + verify + commit.**

```ts
HANDLERS.set(handlerKey(100, 10), evalSAvlTreeGet)
```

```bash
cd packages/ergoscript && npx tsc --noEmit && npx vitest run eval/savltree-get.test.ts
git commit -am "feat(ergoscript): SAvlTree.get method handler (phase 2h-b)

New EvalError code: 'avl-tree-proof-failed' (44 → 45)."
```

### Task F3 — `SAvlTree.getMany` (methodId 11)

**Files:**
- Modify: `packages/ergoscript/src/eval/savltree.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts`
- Create: `packages/ergoscript/test/eval/savltree-getmany.test.ts`

- [ ] **Step F3.1: Read sigma-rust GET_MANY_EVAL_FN.**

Confirm: any proof failure throws. Per-key absent returns per-key None inside the result Coll. Result type is `Coll[Option[Coll[Byte]]]`.

- [ ] **Step F3.2: Write failing test (4 scenarios: all-present, mixed, all-absent, proof-mutated).**

- [ ] **Step F3.3: Implement.**

```ts
import { extractByteArrayList, buildLookupOps } from './_avltree-adapter.ts'

/** Ports SAvlTree.getMany handler (eval/savltree.rs:<lines>). */
export function evalSAvlTreeGetMany(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[],
): SValue {
  expectAvlTree(obj)
  if (args.length !== 2) {
    throw new EvalError(`getMany: expected 2 args, got ${args.length}`, 'method-not-implemented')
  }
  const keys = extractByteArrayList(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildLookupOps(keys)
  const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
  if (r === null) {
    throw new EvalError('getMany: AVL+ proof verification failed', 'avl-tree-proof-failed')
  }
  const items: SValue[] = r.results.map(found =>
    found === null
      ? { kind: 'Option', elem: { tag: 'SColl', elem: { tag: 'SByte' } }, value: null }
      : {
          kind: 'Option',
          elem: { tag: 'SColl', elem: { tag: 'SByte' } },
          value: {
            kind: 'Coll',
            elem: { tag: 'SByte' },
            items: Array.from(found, b => ({ kind: 'Byte', value: b })),
          },
        },
  )
  return {
    kind: 'Coll',
    elem: { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } },
    items,
  }
}
```

- [ ] **Step F3.4: Register + verify + commit.**

```ts
HANDLERS.set(handlerKey(100, 11), evalSAvlTreeGetMany)
```

```bash
git commit -am "feat(ergoscript): SAvlTree.getMany method handler (phase 2h-b)"
```

### Task F4 — `SAvlTree.insert` (methodId 12)

**Files:**
- Modify: `packages/ergoscript/src/eval/savltree.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts`
- Create: `packages/ergoscript/test/eval/savltree-insert.test.ts`

- [ ] **Step F4.1: Read sigma-rust INSERT_EVAL_FN carefully — V<3 vs V3+ failure semantics.**

```bash
sed -n '210,280p' /home/mwaddip/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/savltree.rs
```

Confirm:
- `tree_flags.insert_allowed()` false → return `None` (no avltree call)
- Verifier construct fail → throw
- V<3 + per-op fail → throw
- V3+ + per-op fail → call `verifyAvlBatchPartial`; use `partial.newDigest`; return `Some(AvlTree with updated digest)`
- All-pass → return `Some(AvlTree with new digest)`

⚠️ **OVERRIDES #2 confidence escalation candidate**: if any detail above is <95% certain after source-read, halt and surface.

- [ ] **Step F4.2: Write failing tests covering 6 scenarios.**

Scenarios:
- `success-1-entry.json` — single Insert, all-pass
- `success-N-entries.json` — multi-entry, all-pass
- `disallowed.json` — `!insertAllowed` → Option None
- `v-pre-3-fail.json` — V<3, per-op fail → throw `'avl-tree-proof-failed'`
- `v3-partial-success.json` — V3+, per-op fail mid-batch → Some(tree with partial digest)
- `proof-mutated.json` — verifier construct fail → throw

- [ ] **Step F4.3: Implement.**

```ts
import { verifyAvlBatch, verifyAvlBatchPartial } from '@ergots/avltree'
import { buildInsertOps, withUpdatedDigest } from './_avltree-adapter.ts'

const INSERT_ALLOWED_BIT = 0x01

/** Ports SAvlTree.insert handler (eval/savltree.rs:<lines>). */
export function evalSAvlTreeInsert(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[],
): SValue {
  expectAvlTree(obj)
  if (args.length !== 2) {
    throw new EvalError(`insert: expected 2 args, got ${args.length}`, 'method-not-implemented')
  }
  if ((obj.value.treeFlags & INSERT_ALLOWED_BIT) === 0) {
    return { kind: 'Option', elem: { tag: 'SAvlTree' }, value: null }
  }
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildInsertOps(args[0]!)

  const treeVersion = ctx.treeVersion ?? 0
  if (treeVersion >= 3) {
    const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
    if (partial === null) {
      throw new EvalError('insert: AVL+ proof construct failed', 'avl-tree-proof-failed')
    }
    const newTree = withUpdatedDigest(obj.value, partial.newDigest)
    return {
      kind: 'Option',
      elem: { tag: 'SAvlTree' },
      value: { kind: 'AvlTree', value: newTree },
    }
  } else {
    const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
    if (r === null) {
      throw new EvalError('insert: AVL+ verification failed', 'avl-tree-proof-failed')
    }
    const newTree = withUpdatedDigest(obj.value, r.newDigest)
    return {
      kind: 'Option',
      elem: { tag: 'SAvlTree' },
      value: { kind: 'AvlTree', value: newTree },
    }
  }
}
```

- [ ] **Step F4.4: Register + verify + commit.**

```ts
HANDLERS.set(handlerKey(100, 12), evalSAvlTreeInsert)
```

```bash
cd packages/ergoscript && npx tsc --noEmit && npx vitest run eval/savltree-insert.test.ts
git commit -am "feat(ergoscript): SAvlTree.insert method handler with V3+ partial-success (phase 2h-b)"
```

### Task F5 — `SAvlTree.update` (methodId 13)

Same pattern as F4 — replace `INSERT_ALLOWED_BIT` with `UPDATE_ALLOWED_BIT = 0x02`, `buildInsertOps` with `buildUpdateOps`, methodId 13. Same V3+ partial path.

```bash
git commit -am "feat(ergoscript): SAvlTree.update method handler with V3+ partial-success (phase 2h-b)"
```

### Task F6 — `SAvlTree.remove` (methodId 14)

⚠️ **DIVERGENCE from F4/F5**: `remove` does NOT have V3+ break-on-failure. Per-op failure ALWAYS throws.

```ts
import { extractByteArrayList, buildRemoveOps } from './_avltree-adapter.ts'

const REMOVE_ALLOWED_BIT = 0x04

/** Ports SAvlTree.remove handler (eval/savltree.rs:<lines>). */
export function evalSAvlTreeRemove(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[],
): SValue {
  expectAvlTree(obj)
  if (args.length !== 2) {
    throw new EvalError(`remove: expected 2 args, got ${args.length}`, 'method-not-implemented')
  }
  if ((obj.value.treeFlags & REMOVE_ALLOWED_BIT) === 0) {
    return { kind: 'Option', elem: { tag: 'SAvlTree' }, value: null }
  }
  const keys = extractByteArrayList(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildRemoveOps(keys)
  // NO V3+ partial path — sigma-rust always throws on per-op fail in remove.
  const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
  if (r === null) {
    throw new EvalError('remove: AVL+ verification failed', 'avl-tree-proof-failed')
  }
  const newTree = withUpdatedDigest(obj.value, r.newDigest)
  return {
    kind: 'Option',
    elem: { tag: 'SAvlTree' },
    value: { kind: 'AvlTree', value: newTree },
  }
}
```

```ts
HANDLERS.set(handlerKey(100, 14), evalSAvlTreeRemove)
```

```bash
git commit -am "feat(ergoscript): SAvlTree.remove method handler (phase 2h-b)"
```

After F6, registry = 15 + 6 = 21. EvalError codes = 45.

---

## Phase G: Mutation testing (Layer C3.a)

### Task G1 — `savltree-mutation.test.ts`

**Files:**
- Create: `packages/ergoscript/test/eval/savltree-mutation.test.ts`

- [ ] **Step G1.1: Read prior Layer C3.a pattern from phase 2f Coll HOFs.**

```bash
find /home/mwaddip/projects/ergots/packages/ergoscript/test -name "*mutation*" | head -3
```

Lift the established mutation-test scaffold: for each fixture, iterate byte positions across the proof region, flip the byte, evaluate, assert the result either (a) matches expected failure behavior for that handler or (b) byte-equal to the unmutated result (tolerated-padding case — should be rare).

- [ ] **Step G1.2: Write the mutation test.**

```ts
import { describe, expect, test } from 'vitest'
// ... imports ...

const verificationHandlers = [
  { name: 'contains', expectedFailureKind: 'value-false' },
  { name: 'get',      expectedFailureKind: 'throw' },
  { name: 'getMany',  expectedFailureKind: 'throw' },
  { name: 'insert',   expectedFailureKind: 'throw-or-partial' },
  { name: 'update',   expectedFailureKind: 'throw-or-partial' },
  { name: 'remove',   expectedFailureKind: 'throw' },
]

for (const { name, expectedFailureKind } of verificationHandlers) {
  describe(`SAvlTree.${name} mutation testing`, () => {
    // For each fixture in the success path, mutate the proof region
    // byte-by-byte and assert the per-handler failure semantics.
    const dir = join(fixturesDir, name)
    const successFixtures = readdirSync(dir)
      .filter(f => f.startsWith('success') && f.endsWith('.json'))
      .map(f => f.replace('.json', ''))

    for (const scenario of successFixtures) {
      test(`${scenario}: ≥90% kill rate`, () => {
        const fxt = JSON.parse(readFileSync(join(dir, `${scenario}.json`), 'utf8'))
        // Mutate each byte in the proof region. Implementation detail: the fixture
        // includes `proof_region_start` and `proof_region_end` byte offsets into tree_hex.
        const stats = runMutations(fxt, expectedFailureKind)
        expect(stats.killRate).toBeGreaterThanOrEqual(0.9)
      })
    }
  })
}
```

(Implementer: `runMutations` lifts from prior Layer C3.a tests — flips one byte at a time across the proof region, calls evaluate, records throw vs return-equal-to-expected, computes kill rate.)

- [ ] **Step G1.3: Run + commit.**

```bash
cd packages/ergoscript && npx vitest run eval/savltree-mutation.test.ts
git commit -am "test(ergoscript): SAvlTree mutation testing (Layer C3.a, ≥90% kill rate)"
```

---

## Phase H: Final integration

### Task H1 — Update `facts/ergoscript-eval.md` registry + final verification

**Files:**
- Modify: `facts/ergoscript-eval.md`

- [ ] **Step H1.1: Extend Method-handler registry table.**

Add 13 rows after the existing 8:

```markdown
| 9  | `SAvlTree.digest`            | 100:1  | <source-read> | A | `Coll[Byte]`           | `eval/savltree.rs:<lines>` |
| 10 | `SAvlTree.enabledOperations` | 100:2  | <source-read> | A | `Byte`                 | `eval/savltree.rs:<lines>` |
| 11 | `SAvlTree.keyLength`         | 100:3  | <source-read> | A | `Int`                  | `eval/savltree.rs:<lines>` |
| 12 | `SAvlTree.valueLengthOpt`    | 100:4  | <source-read> | A | `Option[Int]`          | `eval/savltree.rs:<lines>` |
| 13 | `SAvlTree.isInsertAllowed`   | 100:5  | <source-read> | A | `Boolean`              | `eval/savltree.rs:<lines>` |
| 14 | `SAvlTree.isUpdateAllowed`   | 100:6  | <source-read> | A | `Boolean`              | `eval/savltree.rs:<lines>` |
| 15 | `SAvlTree.isRemoveAllowed`   | 100:7  | <source-read> | A | `Boolean`              | `eval/savltree.rs:<lines>` |
| 16 | `SAvlTree.contains`          | 100:9  | 0             | — | `Boolean`              | `eval/savltree.rs:<lines>` |
| 17 | `SAvlTree.get`               | 100:10 | 0             | — | `Option[Coll[Byte]]`   | `eval/savltree.rs:<lines>` |
| 18 | `SAvlTree.getMany`           | 100:11 | 0             | — | `Coll[Option[Coll[Byte]]]` | `eval/savltree.rs:<lines>` |
| 19 | `SAvlTree.insert`            | 100:12 | 0             | — | `Option[AvlTree]`      | `eval/savltree.rs:<lines>` |
| 20 | `SAvlTree.update`            | 100:13 | 0             | — | `Option[AvlTree]`      | `eval/savltree.rs:<lines>` |
| 21 | `SAvlTree.remove`            | 100:14 | 0             | — | `Option[AvlTree]`      | `eval/savltree.rs:<lines>` |
```

Fill in real cost values + line ranges from source-read.

- [ ] **Step H1.2: Add 2h-b changelog block.**

Insert after the existing 2g.6 block in the per-phase changelog section.

- [ ] **Step H1.3: Update EvalError taxonomy section (43 → 45 codes).**

Add a "Phase 2h-b codes" subsection:

```markdown
### Phase 2h-b codes (SAvlTree.* method handlers)

- **`'avl-tree-obj-not-avl-tree'`** — defensive receiver check on all 13 SAvlTree.* handlers when `obj.kind !== 'AvlTree'`. Wire-format invariants make this unreachable for parser-produced trees.
- **`'avl-tree-proof-failed'`** — thrown when `verifyAvlBatch` / `verifyAvlBatchPartial` returns `null` (proof construct OR per-op failure under sigma-rust's throw-path semantics: `get` / `getMany` / `remove` always throw; `insert` / `update` throw on V<3 per-op fail and on verifier construct fail regardless of version). Single code covers all proof-failure throw points per the compact-taxonomy decision from 2g.5.
```

- [ ] **Step H1.4: Update Coverage and stability section.**

```markdown
**Method-handler registry: 21 entries** (was 8; +13 from 2h-b).
```

- [ ] **Step H1.5: Update top-level Coverage summary in `facts/ergoscript.md`** (the meta hub).

Edit "Coverage summary" table:

```markdown
| Evaluator | 52 of ~70 `Expr` arms wired; 21 method-handler registry entries; 45 `EvalError` codes; mainnet C2 corpus `success` ≥ 18 (TBD post-2h-b uplift) |
```

- [ ] **Step H1.6: Run full verification suite.**

```bash
cd /home/mwaddip/projects/ergots
cd packages/avltree && npm test 2>&1 | tail -5
cd ../ergoscript && npm test 2>&1 | tail -5
cd ../nipopow && npm test 2>&1 | tail -5
cd ../.. && npx tsc --noEmit --build packages/*/tsconfig.json 2>&1 | tail -10
cd fixture-gen && cargo build --release 2>&1 | tail -3 && cargo run --release 2>&1 | tail -3
cd .. && git status
```

All must be clean. Working tree should be clean after the last commit.

- [ ] **Step H1.7: Commit.**

```bash
git add facts/ergoscript-eval.md facts/ergoscript.md
git commit -m "$(cat <<'EOF'
docs(ergoscript): facts updates for phase 2h-b (13 SAvlTree.* handlers)

facts/ergoscript-eval.md:
  - Method-handler registry: 8 → 21 entries
  - EvalError codes: 43 → 45 (+'avl-tree-obj-not-avl-tree', +'avl-tree-proof-failed')
  - New "Phase 2h-b" changelog block
  - Coverage summary updated

facts/ergoscript.md:
  - Top-level Coverage summary updated to reflect new registry size

Closes phase 2h-b. Next: Header-model slice (carries LastBlockUtxoRootHash)
or phase 2i predefs — decision pending.
EOF
)"
```

---

## Self-review notes

Per writing-plans skill self-review checklist:

- **Spec coverage:** Every section of the design spec has a corresponding phase. Phase A covers `verifyAvlBatchPartial`. Phase B covers fixture-gen. Phase C covers `AvlTreeData` runtime + wire-format slice. Phase D covers Tier 1 accessors. Phase E covers adapter helpers. Phase F covers Tier 2 verification ops. Phase G covers mutation testing. Phase H finalizes facts.

- **Placeholder scan:** Cost values in handlers are `<source-read>` placeholders that the implementer fills from sigma-rust at the relevant TDD step. This is per design — the spec deliberately says "source-read at implementation, not design." All other code is concrete.

- **Type consistency:** `AvlTreeData` field names (`digest`, `treeFlags`, `keyLength`, `valueLengthOpt`) are consistent across all tasks. `Operation` variant tags (`Lookup`, `Insert`, `Update`, `Remove`) match `@ergots/avltree`'s exported type. `EvalError` codes used in code samples match what's added to the type union. `handlerKey(typeId, methodId)` helper name is consistent.

- **Open follow-ups deferred to a separate session** (per spec's open items):
  - Sigma-rust per-accessor cost values (source-read at task time, not pre-decided)
  - ADDigest scorex_serialize byte layout details (source-read at C2.1)

---

## Pre-existing task list cross-reference

| Brainstorm task | Status |
|---|---|
| #1 Brainstorm 2h-b: clarifying questions | completed |
| #2 Brainstorm 2h-b: present design in sections | completed |
| #3 Write 2h-b design spec to docs/specs/ | completed (committed `b5932e0`) |
| #4 Address open publish-posture questions | pending — surface after this plan executes |
| #5 Transition to writing-plans skill for PLAN.md | (this file) |
