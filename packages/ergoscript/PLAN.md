# Phase 2f (Narrow) Implementation Plan — `@mwaddip/ergots-ergoscript`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship phase 2f narrow: 7 static Box-extract evaluator arms (`ExtractAmount`, `ExtractScriptBytes`, `ExtractRegisterAs`, `ExtractCreationInfo`, `ExtractBytes`, `ExtractBytesWithNoRef`, `ExtractId`); close phase 2a's `'not-implemented-phase-2a'` gap for `SBox` in the wire layer; extend `ErgoBox.registers` to carry per-register `SType`; port the Box canonical-bytes serializer (reusable for the wallet phase). **20 → 27 of ~70 `Expr` arms wired.** Adds 3 new `EvalError` codes + 2 new `SValueParseError` codes.

**Architecture:** Three stops with explicit `STOP α / STOP β / STOP γ` markers so implementation pauses cleanly at any boundary. Stop α (foundation + 2 trivial arms): SBox wire parse+serialize + `ErgoBox.registers` shape extension + `ExtractAmount` + `ExtractScriptBytes`. Stop β (2 structural arms): `ExtractRegisterAs` (R0..R9 dispatch with R0..R3 synthesis + type-assertion throw) + `ExtractCreationInfo`. Stop γ (serializer + 3 hash arms): Box canonical-bytes serializer in `wire/ergo-box-bytes.ts` + `ExtractBytes` + `ExtractBytesWithNoRef` + `ExtractId` (= blake2b256 of canonical bytes). All 7 arms charge cost BEFORE eval-child (Pattern A — envelope-first; confirmed by source-read on every arm). No `EvalContext` chain-state fields in 2f narrow — defer to 2f medium when `GlobalVars` / `GetVar` consume them.

**Tech Stack:** TypeScript 5.5 (ES2022, ESM only), Vitest 2 with jsdom, Rust fixture-gen calling into sigma-rust's `ergotree-interpreter` crate at `integration/ergots@ed5452cf` via the `arbitrary` feature + `try_eval_out::<Value<'static>>` wedge. `@noble/hashes/blake2.js` (existing dep from phase 2a; first eval-time usage). No new runtime deps; no new dev deps.

**Source-first discipline:** Read sigma-rust per task before writing any TS. Authoritative sources for slice 2f narrow:

- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_amount.rs` — Fixed(8) cost, BEFORE eval-child
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_script_bytes.rs` — Fixed(10) cost, BEFORE eval-child
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_reg_as.rs` — Fixed(50) cost, R0..R9 dispatch, type-assertion throws on mismatch (line 41-44)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_creation_info.rs` — Fixed(16) cost, returns Tuple[Int, Coll[Byte]]
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_bytes.rs` — Fixed(12) cost
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_bytes_with_no_ref.rs` — Fixed(12) cost
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_id.rs` — Fixed(12) cost, blake2b256(sigma_serialize_bytes)
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box.rs` — ErgoBox struct (lines 62-80) + sigma_parse (217-225) + sigma_serialize (202-216) + box_id calc (149-153) + bytes_without_ref (195-198) + get_register / R0..R3 synthesis (155-198)
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box/register/id.rs` — RegisterId range validation (0..=9)
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_reg_as.rs` — MIR shape: `register_id: i8` + `elem_tpe: Arc<SType>`
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/data.rs` — SValue::Box wire dispatch into ErgoBox::sigma_parse

Full design rationale: `docs/specs/2026-05-15-ergoscript-phase-2f-design.md`.

**TDD discipline:** Iron Law per `CLAUDE.md` — no production code without a failing test first. Each task follows red → green → cost-assert → corpus-check → commit. Task 1 (SBox wire + ErgoBox reshape) is foundation-only — verify with a round-trip fixture before any eval arm depends on it.

---

## File Structure

**New files (TypeScript):**

| Path | Responsibility |
|---|---|
| `packages/ergoscript/src/eval/extract-amount.ts` | `evalExtractAmount` arm |
| `packages/ergoscript/src/eval/extract-script-bytes.ts` | `evalExtractScriptBytes` arm |
| `packages/ergoscript/src/eval/extract-register-as.ts` | `evalExtractRegisterAs` arm (R0..R9 dispatch) |
| `packages/ergoscript/src/eval/extract-creation-info.ts` | `evalExtractCreationInfo` arm |
| `packages/ergoscript/src/eval/extract-bytes.ts` | `evalExtractBytes` arm |
| `packages/ergoscript/src/eval/extract-bytes-with-no-ref.ts` | `evalExtractBytesWithNoRef` arm |
| `packages/ergoscript/src/eval/extract-id.ts` | `evalExtractId` arm |
| `packages/ergoscript/src/eval/_byte-coll.ts` | `bytesToCollByteSValue` helper (used by 5 of 7 arms) |
| `packages/ergoscript/src/wire/ergo-box-bytes.ts` | Box canonical-bytes serializer + bytes-without-ref variant |
| `packages/ergoscript/test/eval/extract-amount.test.ts` | Fixture-driven + 1 inline defensive test |
| `packages/ergoscript/test/eval/extract-script-bytes.test.ts` | Fixture-driven + 1 inline defensive test |
| `packages/ergoscript/test/eval/extract-register-as.test.ts` | Fixture-driven + 1 inline defensive test |
| `packages/ergoscript/test/eval/extract-creation-info.test.ts` | Fixture-driven + 1 inline defensive test |
| `packages/ergoscript/test/eval/extract-bytes.test.ts` | Fixture-driven + 1 inline defensive test |
| `packages/ergoscript/test/eval/extract-bytes-with-no-ref.test.ts` | Fixture-driven + 1 inline defensive test |
| `packages/ergoscript/test/eval/extract-id.test.ts` | Fixture-driven + 1 inline defensive test |
| `packages/ergoscript/test/wire/ergo-box-bytes.test.ts` | Box-serializer standalone tests (Stop γ Task 6) |
| `packages/ergoscript/test/fixtures/eval/extract-amount.json` | Generated by fixture-gen |
| `packages/ergoscript/test/fixtures/eval/extract-script-bytes.json` | Generated by fixture-gen |
| `packages/ergoscript/test/fixtures/eval/extract-register-as.json` | Generated by fixture-gen |
| `packages/ergoscript/test/fixtures/eval/extract-creation-info.json` | Generated by fixture-gen |
| `packages/ergoscript/test/fixtures/eval/extract-bytes.json` | Generated by fixture-gen |
| `packages/ergoscript/test/fixtures/eval/extract-bytes-with-no-ref.json` | Generated by fixture-gen |
| `packages/ergoscript/test/fixtures/eval/extract-id.json` | Generated by fixture-gen |
| `packages/ergoscript/test/fixtures/wire/sbox-roundtrip.json` | SBox round-trip fixture (Stop α Task 1) |
| `packages/ergoscript/test/fixtures/wire/ergo-box-bytes.json` | Standalone box-bytes fixture (Stop γ Task 6) |

**New files (Rust fixture-gen):**

| Path | Responsibility |
|---|---|
| `fixture-gen/src/cmds/ergoscript/eval/extract_amount.rs` | ExtractAmount entries |
| `fixture-gen/src/cmds/ergoscript/eval/extract_script_bytes.rs` | ExtractScriptBytes entries |
| `fixture-gen/src/cmds/ergoscript/eval/extract_register_as.rs` | ExtractRegisterAs entries spanning R0..R9 + error paths |
| `fixture-gen/src/cmds/ergoscript/eval/extract_creation_info.rs` | ExtractCreationInfo entries |
| `fixture-gen/src/cmds/ergoscript/eval/extract_bytes.rs` | ExtractBytes entries |
| `fixture-gen/src/cmds/ergoscript/eval/extract_bytes_with_no_ref.rs` | ExtractBytesWithNoRef entries |
| `fixture-gen/src/cmds/ergoscript/eval/extract_id.rs` | ExtractId entries |
| `fixture-gen/src/cmds/ergoscript/wire/sbox_roundtrip.rs` | SBox SValue round-trip fixture entries (Stop α Task 1) |
| `fixture-gen/src/cmds/ergoscript/wire/ergo_box_bytes.rs` | Box-bytes (full + no-ref) standalone fixture (Stop γ Task 6) |

**Modified files (TypeScript):**

| Path | Modification |
|---|---|
| `packages/ergoscript/src/mir/types.ts` | Reshape `ErgoBox.registers` from `Record<number, SValue \| undefined>` to `Record<number, { tpe: SType; value: SValue } \| undefined>` (Stop α Task 1) |
| `packages/ergoscript/src/wire/parse-svalue.ts` | Replace `case 'SBox'` in the deferred-kinds block with a real arm; remove 'SBox' from the deferred case list (Stop α Task 1) |
| `packages/ergoscript/src/wire/serialize-svalue.ts` | Symmetric: replace `case 'SBox'` with a real arm; remove 'SBox' from the deferred case list (Stop α Task 1) |
| `packages/ergoscript/src/eval/eval.ts` | Add 7 `case` lines to central dispatch — 2 in Stop α (after Task 2 and Task 3), 2 in Stop β (Tasks 4 and 5), 3 in Stop γ (Tasks 7 and 8). |

**Modified files (Rust fixture-gen):**

| Path | Modification |
|---|---|
| `fixture-gen/src/cmds/ergoscript/eval/mod.rs` | Re-export 7 new per-arm modules: `pub mod extract_amount;` etc. |
| `fixture-gen/src/cmds/ergoscript/wire/mod.rs` | Re-export 2 new wire modules: `pub mod sbox_roundtrip;` and `pub mod ergo_box_bytes;` (verify the wire submodule exists; if not, create it) |
| `fixture-gen/src/main.rs` | Wire 9 new `generate()` calls (7 eval-arm + 2 wire fixtures) alongside existing commands |

**Modified files (docs / memory) — Task 8 finalize only:**

| Path | Modification |
|---|---|
| `facts/ergoscript.md` | (1) Update SValue `parseSValue` / `serializeSValue` postcondition to remove SBox from the `'not-implemented-phase-2a'` set; (2) Modify "Does NOT ship yet" entry "Box / Context / Header chain-state model" → "Context / Header chain-state model" (Box runtime + Box-extract arms now ship); (3) Bump coverage line from "20 of ~70" to "27 of ~70 arms after phase 2f narrow; all 7 Box-extract arms shipped"; (4) Add phase 2f "Ships additionally" block listing the 7 arms + ErgoBox shape extension; (5) Add 3 new `EvalError` codes + 2 new `SValueParseError` codes to taxonomy |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` | Update: phase 2f narrow shipped (27 of ~70 arms); next is phase 2f medium (GlobalVars + GetVar + Option family + SelectField + chain-state fields on EvalContext) |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md` | Update the hook text for `project_ergots_direction` (2f narrow done) |
| `packages/ergoscript/SESSION_CONTEXT.md` | Fresh snapshot for phase 2f narrow done state |

**Unchanged (deliberately):**

- `packages/ergoscript/src/index.ts` — public surface unchanged; ErgoBox type re-exported from `mir/types.ts` still resolves correctly with the reshape (the change is structural-additive in the runtime, but the interface is exported from a single source-of-truth file)
- `packages/ergoscript/src/eval/eval-context.ts` — no chain-state fields added in 2f narrow (deferred to 2f medium per spec Decision #7)
- `packages/ergoscript/src/eval/evaluate.ts` / `evaluate-with.ts` — no signature changes
- `packages/ergoscript/test/_helpers/index.ts` — `hexToBytes` / `hydrateSValue` / `captureEvalError` already cover every new test file
- `packages/ergoscript/src/mir/stype-helpers.ts` — existing `sTypeEquals` reused by `evalExtractRegisterAs` directly (Stop β Task 4)
- `packages/ergoscript/src/wire/parse.ts` / `serialize.ts` — Expr-level dispatch for all 7 Extract* variants already shipped in phase 2a

---

## Conventions and workflow

These apply to every task. Don't repeat them per-task.

**Per-task arc:**
1. Read sigma-rust source for the arm (cited path in each task).
2. (Where applicable) Write the fixture-gen Rust module.
3. (Where applicable) Run `cargo run --release -p fixture-gen` from repo root; verify the new fixture file appears at the expected path.
4. (Where applicable) Verify determinism: run `cargo run --release -p fixture-gen` a second time; `git diff packages/ergoscript/test/fixtures/` must be empty.
5. Write the failing TS test (red).
6. Run `npx vitest run packages/ergoscript/test/eval/<arm>.test.ts`; verify FAIL with the expected reason.
7. Write the minimal TS arm implementation (green).
8. Wire the arm into central dispatch (`eval/eval.ts`) by adding the appropriate `case` line.
9. Run the per-arm test; verify PASS.
10. Run the full ergoscript suite: `npx vitest run packages/ergoscript/`; verify all previous tests still pass.
11. Run `npx tsc --noEmit -p packages/ergoscript`; verify zero errors.
12. Two-stage review (spec compliance + code quality) — orchestrator's job.
13. Commit (one commit per task; orchestrator may request a fix commit after review).

**Fixture-gen execution:** Always `cargo run --release -p fixture-gen` from `/home/mwaddip/projects/ergots`. Determinism check per task: regenerate, then `git diff packages/ergoscript/test/fixtures/` — must be empty.

**Cost values:** Read from sigma-rust per arm. Confirmed values for slice 2f narrow:

| Arm | Cost | Sigma-rust source |
|---|---|---|
| ExtractAmount | Fixed(8) | `eval/extract_amount.rs:15` |
| ExtractScriptBytes | Fixed(10) | `eval/extract_script_bytes.rs:15` |
| ExtractRegisterAs | Fixed(50) | `eval/extract_reg_as.rs:21` |
| ExtractCreationInfo | Fixed(16) | `eval/extract_creation_info.rs:15` |
| ExtractBytes | Fixed(12) | `eval/extract_bytes.rs:16` |
| ExtractBytesWithNoRef | Fixed(12) | `eval/extract_bytes_with_no_ref.rs:15` |
| ExtractId | Fixed(12) | `eval/extract_id.rs:16` |

**Cost-charging order: BEFORE eval-child for all 7 arms.** Pattern A from `[[reference-cost-charging-order-patterns]]` memory. Confirmed by source-read on every arm: each calls `ctx.add_jit_cost(N)?` then `self.input.eval(env, ctx)?`. The C1 fixture-equality is the gate; the per-arm header comment cites the sigma-rust line.

**Browser compatibility checks:** Every new TS module follows the existing hard rules (no `Buffer`, no `node:*` outside test files, no `globalThis.crypto`, no WASM, ESM only, no top-level await). `extract-id.ts` imports `blake2b` from `@noble/hashes/blake2.js` (existing dep from phase 2a per `[[reference-noble-hashes-blake2]]` memory).

**Two-stage review (per task):** Orchestrator dispatches two parallel review subagents after each task's green-+-typecheck-passes state:
- **Spec-compliance reviewer** — reads the design spec, this PLAN's task section, and the diff. Verifies behavior matches the design.
- **Code-quality reviewer** — reads the diff. Verifies test style, idioms, no `any` leaks, comments cite sigma-rust source lines.

**Commit message style:** HEREDOC format per CLAUDE.md. Trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` mandatory.

**STOP markers:** This PLAN has three explicit STOP markers between task groups (after Task 3 = STOP α, after Task 5 = STOP β, after Task 8 = STOP γ). Each STOP is a natural commit+push state with a `STOP α / β / γ` checklist (corpus re-run + facts update + memory updates + commit + push). Implementation can pause at any STOP and resume in a later session.

---

## Stop α — Foundation + 2 trivial arms

Three tasks: SBox wire parsing + ErgoBox reshape (Task 1), then ExtractAmount (Task 2), then ExtractScriptBytes (Task 3). Coverage after Stop α: **22 of ~70 arms; 2 of 7 Box-extract arms shipped.**

---

### Task 1: SBox wire parse + serialize + `ErgoBox.registers` extension

**Files:**
- Modify: `packages/ergoscript/src/mir/types.ts` (ErgoBox interface, ~line 66-84)
- Modify: `packages/ergoscript/src/wire/parse-svalue.ts` (case 'SBox' on line 240)
- Modify: `packages/ergoscript/src/wire/serialize-svalue.ts` (case 'SBox' on line 238)
- Create: `fixture-gen/src/cmds/ergoscript/wire/sbox_roundtrip.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/wire/mod.rs` (re-export the new module)
- Modify: `fixture-gen/src/main.rs` (wire `generate()` call)
- Create (generated): `packages/ergoscript/test/fixtures/wire/sbox-roundtrip.json`
- Create: `packages/ergoscript/test/wire/sbox-roundtrip.test.ts`

**Sigma-rust sources:**
- `ergotree-ir/src/chain/ergo_box.rs:202-216` (`sigma_serialize for ErgoBox`)
- `ergotree-ir/src/chain/ergo_box.rs:217-225` (`sigma_parse for ErgoBox` — delegates to `ErgoBoxCandidate::parse_body_with_indexed_digests`)
- `ergotree-ir/src/chain/ergo_box.rs:62-80` (`ErgoBox` struct fields)
- `ergotree-ir/src/chain/ergo_box/box_value.rs` (`BoxValue` VLQ-u64 encoding)
- `ergotree-ir/src/chain/ergo_box/register.rs` (additional_registers wire format — count + per-slot `Constant`)
- `ergotree-ir/src/serialization/data.rs` (SValue::Box dispatch into ErgoBox::sigma_parse)

**Key behavior:**

The SBox wire encoding is a flat sequence (no recursion into Expr; the ergo_tree is stored as size-prefixed raw bytes):

1. `value` — VLQ u64 (BoxValue wraps u64)
2. `ergo_tree_bytes` — size-prefixed: VLQ u32 size, then exactly that many raw bytes. The bytes are the canonical serialization of the inner ErgoTree (not parsed in this arm; consumers can call `parseTree` on the returned bytes).
3. `tokens` — VLQ u32 count, then per-token: 32-byte token id (raw bytes, no length prefix), VLQ u64 amount. Cap at `MAX_TOKENS_COUNT = 122` (sigma-rust `ergo_box.rs:87`). Tokens may be empty (count=0).
4. `additional_registers` — VLQ u32 count (0..=6 since only R4..R9 are non-mandatory), then per-register: parse `SType` via existing `parseSType`, then parse `SValue` of that type via recursive `parseSValue`. Stored at TS map keys `4 + i` (slot index = 4 + position).
5. `creation_height` — VLQ u32
6. `transaction_id` — 32 raw bytes
7. `index` — sigma-rust writes via `w.put_u16(self.index)` (`ergo_box.rs:214`). Read this as VLQ-u16 — sigma-ser's `put_u16` is VLQ-encoded per `sigma-ser/src/vlq_encode.rs`. Confirm by source-read at task time. (Note: ErgoBox.index is u16; cap at 65535.)

Symmetric serializer writes the same sequence in order. Round-trip invariant: `serializeSValue(SBox, parseSValue(SBox, bytes))` byte-equals input.

The `ErgoBox.registers` reshape (TypeScript): change `Record<number, SValue | undefined>` to `Record<number, { tpe: SType; value: SValue } | undefined>`. Per-register tpe carriage is needed by `ExtractRegisterAs`'s type-assertion (Task 4). The parser populates `{ tpe, value }` from the wire-format Constant entries.

New SValueParseError codes:
- `'sbox-tokens-out-of-range'` — tokens count > 122
- `'sbox-registers-out-of-range'` — additional_registers count > 6

- [ ] **Step 1: Read sigma-rust SBox parser source to confirm wire layout**

```bash
# Read sigma_parse + sigma_serialize for ErgoBox + helpers
sed -n '155,240p' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box.rs

# Check ErgoBoxCandidate::parse_body_with_indexed_digests (the actual parser body):
grep -rn "parse_body_with_indexed_digests\|fn serialize_box_with_indexed_digests" /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/

# Read BoxValue (VLQ u64 wrapper):
sed -n '1,80p' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box/box_value.rs

# Read additional_registers wire format:
grep -n "fn sigma_(parse|serialize)" /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box/register.rs
```

Confirm: the ergo_tree bytes are size-prefixed (VLQ u32 length + raw bytes), tokens count is VLQ-u32 (not u8 / u16), register count is VLQ-u32, index is VLQ-u16 (the `put_u16` helper in sigma-ser uses VLQ encoding). The script-reconstruction step is `ErgoTree::sigma_parse_bytes(ergo_tree_bytes)` — but we DON'T parse the tree in `parseSValue`. Just keep the bytes.

- [ ] **Step 2: Reshape `ErgoBox.registers` in `mir/types.ts`**

In `packages/ergoscript/src/mir/types.ts`, around line 66:

```ts
/**
 * Stub: on-chain box. Mirrors sigma-rust `ergotree-ir/src/chain/ergo_box.rs`
 * `ErgoBox` fields. ErgoTree is held as raw bytes here (deferred parse — the
 * interpreter `parseTree` lives in a later phase).
 */
export interface ErgoBox {
  /** nanoErg value (Rust `BoxValue`, a u64 wrapper). */
  value: bigint
  /** Guarding script as raw bytes; parse with `parseTree` if needed. */
  ergoTreeBytes: Uint8Array
  /**
   * Non-mandatory registers R4..R9 stored at keys 4..9. Each entry carries
   * both the declared `SType` (matching sigma-rust's `Constant<'static>`)
   * and the runtime `SValue`. Per-register tpe is required by
   * `ExtractRegisterAs`'s type-assertion check — see Task 4.
   *
   * Sparse: a missing register key (or one set to `undefined`) means the
   * register is absent and `ExtractRegisterAs` returns `Option::None`.
   *
   * Sigma-rust ref: `chain/ergo_box/register.rs` `NonMandatoryRegisters`
   * stores `Vec<Constant<'static>>`.
   */
  registers: Record<number, { tpe: SType; value: SValue } | undefined>
  /** Secondary tokens (id is 32-byte token-id, amount is u64 packed as bigint). */
  tokens: { id: Uint8Array; amount: bigint }[]
  /** Block height at which the box was created (Rust `u32`). */
  creationHeight: number
  /** 32-byte transaction id that produced this box. */
  txId: Uint8Array
  /** Index of this box in the producing transaction's outputs (Rust `u16`). */
  index: number
}
```

- [ ] **Step 3: Verify no existing code reads `ErgoBox.registers`**

```bash
rtk grep -rn "\.registers\b" packages/ergoscript/src/ packages/ergoscript/test/
```

Expected: zero hits outside of `mir/types.ts` itself. If hits appear, audit and resolve before proceeding. (Decision log #6 in the spec asserts no consumers exist; confirm.)

- [ ] **Step 4: Run typecheck to confirm no breakage from the reshape**

```bash
npx tsc --noEmit -p packages/ergoscript
```

Expected: zero errors. The reshape is a structural-only widening with no current consumers.

- [ ] **Step 5: Write the fixture-gen Rust module for SBox round-trip**

Create `fixture-gen/src/cmds/ergoscript/wire/sbox_roundtrip.rs`:

```rust
//! Phase 2f Stop α Task 1 — SBox wire round-trip fixture
//!
//! Emits trees containing `Const(SBox, <box>)` so the TS round-trip test
//! exercises both the new `parseSValue` / `serializeSValue` SBox arms.

use crate::cmds::ergoscript::wire::WireFixtureEntry;
use ergotree_ir::chain::context::Context;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use sigma_test_util::force_any_val;

pub fn generate() -> anyhow::Result<Vec<WireFixtureEntry>> {
    let mut entries = Vec::new();

    // Entry 1: SelfBox via Context (a realistic ErgoBox shape).
    let ctx = force_any_val::<Context>();
    let self_box = (*ctx.self_box).clone();
    let const_expr: Expr = Constant {
        tpe: SType::SBox,
        v: self_box.into(),
    }
    .into();
    let bytes = const_expr.sigma_serialize_bytes()?;
    entries.push(WireFixtureEntry {
        name: "sbox_self_box".to_string(),
        bytes_hex: hex::encode(&bytes),
        description: "Const(SBox, ctx.self_box) — realistic box from force_any_val<Context>".to_string(),
    });

    // Entry 2: empty registers + zero tokens (minimal box shape).
    // Build a synthetic box with empty additional_registers, no tokens, value=1.
    // ... (use ErgoBox::new with these inputs)
    // Skip details; the fixture-gen Rust crate exposes ErgoBox::new for synthesis.

    // Entry 3: box with multiple tokens (exercises tokens-vec encoding).
    // Entry 4: box with R4..R6 populated (exercises additional_registers encoding).
    // Entry 5: box with max-shape (value=u64::MAX, tokens.len()=122, regs R4..R9).

    Ok(entries)
}
```

Then in `fixture-gen/src/cmds/ergoscript/wire/mod.rs`, add `pub mod sbox_roundtrip;`. Verify the `wire/mod.rs` file already defines a `WireFixtureEntry` type used by sibling wire fixtures; if not, model it after an existing eval-fixture entry pattern.

In `fixture-gen/src/main.rs`, find the section that runs eval-fixture commands; add an analogous call for the new wire fixture:

```rust
generate_and_write(
    "packages/ergoscript/test/fixtures/wire/sbox-roundtrip.json",
    cmds::ergoscript::wire::sbox_roundtrip::generate()?,
)?;
```

- [ ] **Step 6: Generate the SBox round-trip fixture**

```bash
cd fixture-gen
cargo build --release
cargo run --release -p fixture-gen
cd ..
# Verify the file exists:
ls -la packages/ergoscript/test/fixtures/wire/sbox-roundtrip.json
# Verify determinism:
cargo run --release -p fixture-gen
git diff packages/ergoscript/test/fixtures/wire/sbox-roundtrip.json
# Expected: no diff.
```

- [ ] **Step 7: Write the failing test for SBox parse + round-trip**

Create `packages/ergoscript/test/wire/sbox-roundtrip.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseExpr } from '../../src/wire/parse'
import { serializeExpr } from '../../src/wire/serialize'
import { ByteReader } from '../../src/wire/reader'
import { ByteWriter } from '../../src/wire/writer'
import { hexToBytes } from '../_helpers'

interface WireFixtureEntry {
  name: string
  bytes_hex: string
  description: string
}

const FIXTURE_PATH = resolve(__dirname, '../fixtures/wire/sbox-roundtrip.json')
const entries: WireFixtureEntry[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

describe('SBox wire round-trip (phase 2f Stop α Task 1)', () => {
  for (const entry of entries) {
    it(`${entry.name} parses and re-serializes byte-identically`, () => {
      const bytes = hexToBytes(entry.bytes_hex)
      const reader = new ByteReader(bytes)
      const expr = parseExpr(reader, [], [])
      expect(reader.isExhausted()).toBe(true)
      const writer = new ByteWriter()
      serializeExpr(expr, writer)
      const reserialized = writer.toBytes()
      expect(Buffer.from(reserialized).toString('hex')).toBe(entry.bytes_hex)
    })
  }
})
```

Run to verify it fails:

```bash
npx vitest run packages/ergoscript/test/wire/sbox-roundtrip.test.ts
```

Expected: FAIL with `SValueParseError 'not-implemented-phase-2a'` (current SBox arm throws).

- [ ] **Step 8: Implement SBox parse in `wire/parse-svalue.ts`**

In `packages/ergoscript/src/wire/parse-svalue.ts`, find the `case 'SBox':` line (currently line 240, grouped with `SAvlTree`, `SHeader`, etc. throwing `'not-implemented-phase-2a'`).

Remove `SBox` from the deferred case list. Add a new arm BEFORE the deferred-kinds block:

```ts
    case 'SBox': {
      // SBox wire encoding (sigma-rust `chain/ergo_box.rs:202-225`):
      //   value: VLQ u64 (BoxValue)
      //   ergo_tree_bytes: VLQ u32 size + raw bytes
      //   tokens: VLQ u32 count, per-token: 32-byte id + VLQ u64 amount
      //   additional_registers: VLQ u32 count (0..=6), per-register: SType + SValue
      //   creation_height: VLQ u32
      //   transaction_id: 32 raw bytes
      //   index: VLQ u16
      //
      // We DON'T parse the inner ergo_tree (consumers can call parseTree if
      // needed). The SType in additional_registers entries is recursive into
      // parseSType + parseSValue.
      const value = r.readVlqBigIntUnsigned()
      const treeSize = r.readVlqU()
      const ergoTreeBytes = r.readBytes(treeSize).slice()

      const tokenCount = r.readVlqU()
      if (tokenCount > 122) {
        throw new SValueParseError(
          `SBox tokens count ${tokenCount} exceeds MAX_TOKENS_COUNT (122)`,
          'sbox-tokens-out-of-range'
        )
      }
      const tokens: { id: Uint8Array; amount: bigint }[] = []
      for (let i = 0; i < tokenCount; i++) {
        const id = r.readBytes(32).slice()
        const amount = r.readVlqBigIntUnsigned()
        tokens.push({ id, amount })
      }

      const regCount = r.readVlqU()
      if (regCount > 6) {
        throw new SValueParseError(
          `SBox additional_registers count ${regCount} exceeds 6 (R4..R9 only)`,
          'sbox-registers-out-of-range'
        )
      }
      const registers: Record<number, { tpe: SType; value: SValue } | undefined> = {}
      for (let i = 0; i < regCount; i++) {
        const tpe = parseSType(r)
        const v = parseSValue(tpe, r)
        registers[4 + i] = { tpe, value: v }
      }

      const creationHeight = Number(r.readVlqU())
      const txId = r.readBytes(32).slice()
      const index = Number(r.readVlqU())

      return {
        kind: 'Box',
        value: {
          value,
          ergoTreeBytes,
          registers,
          tokens,
          creationHeight,
          txId,
          index,
        },
      }
    }
```

You'll need to add an import at the top: `import { parseSType } from './parse-stype'`.

Verify `ByteReader.readVlqBigIntUnsigned()` exists (it should — used by the existing SLong/SBigInt paths). If only `readVlqBigInt` is available, check whether it returns the unsigned value directly or the ZigZag-decoded signed value. Per `parseSValue` line 132-134's signed path, the existing helper is `readVlqBigIntSigned`. The unsigned path uses `readVlqBigInt` directly (returns raw VLQ as bigint). Use whichever matches sigma-rust's `BoxValue` u64 read.

- [ ] **Step 9: Implement SBox serialize in `wire/serialize-svalue.ts`**

In `packages/ergoscript/src/wire/serialize-svalue.ts`, find `case 'SBox':` in the deferred-kinds block (line 238). Remove it from the deferred list. Add a new arm BEFORE the deferred block, symmetric to parse:

```ts
    case 'SBox': {
      const box = (v as { kind: 'Box'; value: ErgoBox }).value
      w.writeVlqBigIntUnsigned(box.value)
      w.writeVlqU(box.ergoTreeBytes.length)
      w.writeBytes(box.ergoTreeBytes)

      w.writeVlqU(box.tokens.length)
      for (const token of box.tokens) {
        if (token.id.length !== 32) {
          throw new SValueSerializeError(
            `SBox token id length ${token.id.length} must be 32`,
            'token-id-length'
          )
        }
        w.writeBytes(token.id)
        w.writeVlqBigIntUnsigned(token.amount)
      }

      // additional_registers: serialize R4..R9 in ascending key order.
      const regKeys = Object.keys(box.registers)
        .map((k) => Number(k))
        .filter((k) => k >= 4 && k <= 9 && box.registers[k] !== undefined)
        .sort((a, b) => a - b)
      w.writeVlqU(regKeys.length)
      for (const k of regKeys) {
        const entry = box.registers[k]!
        serializeSType(entry.tpe, w)
        serializeSValue(entry.tpe, entry.value, w)
      }

      w.writeVlqU(box.creationHeight)
      if (box.txId.length !== 32) {
        throw new SValueSerializeError(
          `SBox txId length ${box.txId.length} must be 32`,
          'txid-length'
        )
      }
      w.writeBytes(box.txId)
      w.writeVlqU(box.index)
      return
    }
```

Add at top of file: `import { serializeSType } from './serialize-stype'` and `import type { ErgoBox } from '../mir/types'`. New error codes: `'token-id-length'` and `'txid-length'` (defensive; should never fire on parsed boxes but protects against hand-built ErgoBox values).

- [ ] **Step 10: Run the round-trip test — verify PASS**

```bash
npx vitest run packages/ergoscript/test/wire/sbox-roundtrip.test.ts
```

Expected: all entries PASS.

- [ ] **Step 11: Run full ergoscript suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all 1609 existing tests + new SBox round-trip tests PASS; zero TS errors.

- [ ] **Step 12: Commit**

```bash
git add packages/ergoscript/src/mir/types.ts \
        packages/ergoscript/src/wire/parse-svalue.ts \
        packages/ergoscript/src/wire/serialize-svalue.ts \
        packages/ergoscript/test/wire/sbox-roundtrip.test.ts \
        packages/ergoscript/test/fixtures/wire/sbox-roundtrip.json \
        fixture-gen/src/cmds/ergoscript/wire/sbox_roundtrip.rs \
        fixture-gen/src/cmds/ergoscript/wire/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): SBox wire parse/serialize + ErgoBox.registers reshape (phase 2f Stop α task 1)

Closes phase 2a's 'not-implemented-phase-2a' gap for SBox. Reshapes
ErgoBox.registers to carry per-register SType (required by
ExtractRegisterAs's type-assertion in Task 4). Adds 'sbox-tokens-
out-of-range' + 'sbox-registers-out-of-range' SValueParseError codes;
'token-id-length' + 'txid-length' SValueSerializeError codes for the
defensive serializer-side checks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `ExtractAmount` arm + fixture

**Files:**
- Create: `packages/ergoscript/src/eval/extract-amount.ts`
- Create: `packages/ergoscript/test/eval/extract-amount.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/extract_amount.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (add `pub mod extract_amount;`)
- Modify: `fixture-gen/src/main.rs` (wire `generate()` call)
- Create (generated): `packages/ergoscript/test/fixtures/eval/extract-amount.json`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add `case 'ExtractAmount':`)

**Sigma-rust source:** `ergotree-interpreter/src/eval/extract_amount.rs:9-25`. Cost `Fixed(8)` charged BEFORE eval-child (line 15). Returns `Value::Long(box.value.as_i64())` on Box input; `EvalError::UnexpectedValue` otherwise.

**Key behavior:**
- Cost: Fixed(8), BEFORE eval-child.
- Defensive guard: throw `'extract-input-not-box'` if `input.kind !== 'Box'`.
- Returns `{ kind: 'Long', value: box.value }`.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_amount.rs
```

Confirm: `ctx.add_jit_cost(8)?` precedes `self.input.eval(env, ctx)?`. Match returns `Value::Long(b.value.as_i64())` for `Value::CBox(b)`.

- [ ] **Step 2: Write the fixture-gen Rust module**

Create `fixture-gen/src/cmds/ergoscript/eval/extract_amount.rs`:

```rust
//! Phase 2f Stop α Task 2 — ExtractAmount eval fixtures
//!
//! Cost Fixed(8) BEFORE eval-child. Returns Long(box.value).

use crate::cmds::ergoscript::eval::EvalFixtureEntry;
use ergotree_ir::chain::context::Context;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_amount::ExtractAmount;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use sigma_test_util::force_any_val;

pub fn generate() -> anyhow::Result<Vec<EvalFixtureEntry>> {
    let mut entries = Vec::new();
    let ctx = force_any_val::<Context>();

    // Entry: SelfBox via Const(SBox, ctx.self_box).
    let self_box = (*ctx.self_box).clone();
    let const_box: Expr = Constant {
        tpe: SType::SBox,
        v: self_box.clone().into(),
    }
    .into();
    let expr: Expr = ExtractAmount {
        input: Box::new(const_box),
    }
    .into();
    let bytes = expr.sigma_serialize_bytes()?;
    let expected_value = self_box.value.as_i64();
    entries.push(EvalFixtureEntry {
        name: "extract_amount_selfbox".to_string(),
        tree_bytes_hex: hex::encode(&bytes),
        opts_json: serde_json::json!({}).to_string(),
        expected_value_json: serde_json::json!({
            "kind": "Long",
            "value": expected_value.to_string()
        }).to_string(),
        expected_cost: 8,
        expected_error_code: None,
    });

    // Add more entries: boxes with varied `value` (0, 1, 1_000_000_000, MAX).
    // Add error entry: Const(SInt) input → expects 'extract-input-not-box'.
    // ... (mirror existing eval fixtures' multi-entry structure)

    Ok(entries)
}
```

Look at an existing simple eval-fixture (e.g., `negation.rs` or `bit_inversion.rs`) for the exact `EvalFixtureEntry` shape and error-entry helper if one exists.

Then in `eval/mod.rs`: `pub mod extract_amount;`. In `main.rs`: add the `generate_and_write` call.

- [ ] **Step 3: Generate the fixture**

```bash
cd fixture-gen && cargo run --release -p fixture-gen && cd ..
ls -la packages/ergoscript/test/fixtures/eval/extract-amount.json
# Determinism:
cd fixture-gen && cargo run --release -p fixture-gen && cd ..
git diff packages/ergoscript/test/fixtures/eval/extract-amount.json
# Expected: no diff.
```

- [ ] **Step 4: Write the failing TS test**

Create `packages/ergoscript/test/eval/extract-amount.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluate } from '../../src/eval/evaluate'
import { EvalError } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, captureEvalError } from '../_helpers'

interface EvalFixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: string
  expected_value_json: string
  expected_cost: number
  expected_error_code?: string | null
}

const FIXTURE_PATH = resolve(__dirname, '../fixtures/eval/extract-amount.json')
const entries: EvalFixtureEntry[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

describe('ExtractAmount eval (phase 2f Stop α Task 2)', () => {
  for (const entry of entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const opts = JSON.parse(entry.opts_json)
      if (entry.expected_error_code) {
        const err = captureEvalError(() => evaluate(tree, opts))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const result = evaluate(tree, opts)
        const expected = hydrateSValue(JSON.parse(entry.expected_value_json))
        expect(result).toEqual(expected)
      }
    })
  }

  it('non-Box input throws extract-input-not-box', () => {
    // Hand-built MIR: ExtractAmount with Const(SInt, 5) input — bypasses
    // sigma-rust's construction-time SBox check.
    const tree = {
      header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0 },
      constants: [],
      constantTypes: [],
      body: {
        tag: 'ExtractAmount' as const,
        input: {
          tag: 'Const' as const,
          tpe: { tag: 'SInt' as const },
          value: { kind: 'Int' as const, value: 5 },
        },
      },
    }
    const err = captureEvalError(() => evaluate(tree))
    expect(err.code).toBe('extract-input-not-box')
  })
})
```

Run to verify FAIL:

```bash
npx vitest run packages/ergoscript/test/eval/extract-amount.test.ts
```

Expected: FAIL with `EvalError 'not-implemented-yet'` (central dispatch fallback).

- [ ] **Step 5: Implement `evalExtractAmount`**

Create `packages/ergoscript/src/eval/extract-amount.ts`:

```ts
/**
 * ExtractAmount arm — Box → Long.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_amount.rs:9-25
 *   ctx.add_jit_cost(8)?;                            // BEFORE eval-child
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v { Value::CBox(b) => Value::Long(b.value.as_i64()), ... }
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]]).
 *
 * Defensive eval-time kind-check (`'extract-input-not-box'`) guards
 * against ConstantPlaceholder injection — same posture as 2c's
 * LogicalNot / 2d-B's And/Or defensive checks.
 */

import type { ExtractAmount, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: sigma-rust eval/extract_amount.rs:15 — inline literal `ctx.add_jit_cost(8)?`.
const EXTRACT_AMOUNT_COST = 8

export function evalExtractAmount(
  e: ExtractAmount,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_AMOUNT_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractAmount: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  return { kind: 'Long', value: input.value.value }
}
```

- [ ] **Step 6: Wire into central dispatch**

In `packages/ergoscript/src/eval/eval.ts`, add the import + case (alphabetical order or grouped with other Extract* — pick the existing convention):

```ts
import { evalExtractAmount } from './extract-amount'
// ... in the switch:
    case 'ExtractAmount':
      return evalExtractAmount(e, env, ctx)
```

- [ ] **Step 7: Run the per-arm test — verify PASS**

```bash
npx vitest run packages/ergoscript/test/eval/extract-amount.test.ts
```

Expected: all fixture entries + inline test PASS.

- [ ] **Step 8: Run the full ergoscript suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all prior tests + new ones PASS; zero TS errors.

- [ ] **Step 9: Commit**

```bash
git add packages/ergoscript/src/eval/extract-amount.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/extract-amount.test.ts \
        packages/ergoscript/test/fixtures/eval/extract-amount.json \
        fixture-gen/src/cmds/ergoscript/eval/extract_amount.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): ExtractAmount eval arm + extract-input-not-box code (phase 2f Stop α task 2)

Fixed(8) cost BEFORE eval-child. Defensive 'extract-input-not-box' code
shared across all 7 Box-extract arms — establishes the template.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `ExtractScriptBytes` arm + fixture + `_byte-coll.ts` helper

**Files:**
- Create: `packages/ergoscript/src/eval/_byte-coll.ts` (the `bytesToCollByteSValue` helper)
- Create: `packages/ergoscript/src/eval/extract-script-bytes.ts`
- Create: `packages/ergoscript/test/eval/extract-script-bytes.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/extract_script_bytes.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/extract-script-bytes.json`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add `case 'ExtractScriptBytes':`)

**Sigma-rust source:** `ergotree-interpreter/src/eval/extract_script_bytes.rs:9-25`. Cost `Fixed(10)` BEFORE eval-child. Returns `box.script_bytes()?` wrapped as Value::Coll (Coll[Byte]).

**Key behavior:**
- Cost: Fixed(10), BEFORE eval-child.
- Returns `Coll[Byte]` containing the box's ergoTreeBytes.
- Introduces the `bytesToCollByteSValue` helper used by 5 of 7 arms (this one + ExtractCreationInfo + ExtractBytes + ExtractBytesWithNoRef + ExtractId).

**Byte-signing convention:** TS Byte SValue is signed-i8 (range -128..=127). Confirmed by `wire/parse-svalue.ts:96-97` where `SByte` parsing does `(b << 24) >> 24` (sign-extend from u8 to signed i32). The helper must mirror this — each byte gets `(b << 24) >> 24` applied.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_script_bytes.rs
```

Confirm Fixed(10) cost BEFORE eval-child; `box.script_bytes()` returns the ErgoTree's canonical serialization.

- [ ] **Step 2: Implement `_byte-coll.ts` helper**

Create `packages/ergoscript/src/eval/_byte-coll.ts`:

```ts
/**
 * `bytesToCollByteSValue` — wrap a `Uint8Array` as a `Coll[Byte]` SValue.
 * Each byte is sign-extended from u8 to signed-i8 (range -128..=127),
 * matching the parser's `SByte` convention at `wire/parse-svalue.ts:96-97`.
 *
 * Used by phase 2f Stop α/β/γ Box-extract arms (ExtractScriptBytes,
 * ExtractCreationInfo, ExtractBytes, ExtractBytesWithNoRef, ExtractId).
 *
 * Promote-on-third-caller threshold met: 5 of 7 Box-extract arms call
 * this helper, so the shared file is justified per slice-B/2e YAGNI
 * precedent.
 */

import type { SType, SValue } from '../mir/types'

const SBYTE_TYPE: SType = { tag: 'SByte' }

export function bytesToCollByteSValue(bytes: Uint8Array): SValue {
  const items: SValue[] = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    // Sign-extend u8 → signed i32 in JS — matches parser convention.
    items[i] = { kind: 'Byte', value: (bytes[i]! << 24) >> 24 }
  }
  return { kind: 'Coll', elem: SBYTE_TYPE, items }
}
```

- [ ] **Step 3: Write the fixture-gen Rust module**

Create `fixture-gen/src/cmds/ergoscript/eval/extract_script_bytes.rs`:

```rust
//! Phase 2f Stop α Task 3 — ExtractScriptBytes eval fixtures.
//! Fixed(10) cost BEFORE eval-child. Returns Coll[Byte] of box's
//! serialized ErgoTree.

use crate::cmds::ergoscript::eval::EvalFixtureEntry;
use ergotree_ir::chain::context::Context;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_script_bytes::ExtractScriptBytes;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use sigma_test_util::force_any_val;
use sigma_util::AsVecI8;

pub fn generate() -> anyhow::Result<Vec<EvalFixtureEntry>> {
    let mut entries = Vec::new();
    let ctx = force_any_val::<Context>();

    let self_box = (*ctx.self_box).clone();
    let const_box: Expr = Constant {
        tpe: SType::SBox,
        v: self_box.clone().into(),
    }
    .into();
    let expr: Expr = ExtractScriptBytes {
        input: Box::new(const_box),
    }
    .into();
    let tree_bytes = expr.sigma_serialize_bytes()?;
    let script_bytes = self_box.script_bytes()?.as_vec_i8();
    let value_json = serde_json::json!({
        "kind": "Coll",
        "elem": { "tag": "SByte" },
        "items": script_bytes.iter().map(|b| {
            serde_json::json!({ "kind": "Byte", "value": *b as i32 })
        }).collect::<Vec<_>>()
    });
    entries.push(EvalFixtureEntry {
        name: "extract_script_bytes_selfbox".to_string(),
        tree_bytes_hex: hex::encode(&tree_bytes),
        opts_json: serde_json::json!({}).to_string(),
        expected_value_json: value_json.to_string(),
        expected_cost: 10,
        expected_error_code: None,
    });

    // Add entries with varied ergo_tree shapes (minimal, P2PK, larger).

    Ok(entries)
}
```

In `eval/mod.rs`: `pub mod extract_script_bytes;`. In `main.rs`: add the `generate_and_write` call.

- [ ] **Step 4: Generate the fixture**

```bash
cd fixture-gen && cargo run --release -p fixture-gen && cd ..
git diff packages/ergoscript/test/fixtures/eval/extract-script-bytes.json
# Expected: new file (first run); empty diff on second run for determinism.
```

- [ ] **Step 5: Write the failing TS test**

Create `packages/ergoscript/test/eval/extract-script-bytes.test.ts` (mirror Task 2's test file pattern with the new fixture path + the inline defensive test):

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluate } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, captureEvalError } from '../_helpers'

// ... identical structure to extract-amount.test.ts, with fixture path
// extract-script-bytes.json and inline test asserting 'extract-input-not-box'
// for a Const(SInt) input.
```

Run to verify FAIL:

```bash
npx vitest run packages/ergoscript/test/eval/extract-script-bytes.test.ts
```

Expected: FAIL with `'not-implemented-yet'`.

- [ ] **Step 6: Implement `evalExtractScriptBytes`**

Create `packages/ergoscript/src/eval/extract-script-bytes.ts`:

```ts
/**
 * ExtractScriptBytes arm — Box → Coll[Byte] of the box's serialized
 * guarding script (its ErgoTree canonical bytes).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_script_bytes.rs:9-25
 *   ctx.add_jit_cost(10)?;                           // BEFORE eval-child
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v { Value::CBox(b) => b.script_bytes()?.into(), ... }
 *
 * `box.script_bytes()` in sigma-rust serializes the inner ErgoTree.
 * In TS we already store the canonical bytes on `ErgoBox.ergoTreeBytes`
 * (the parser at phase 2f Task 1 captures them; sigma-rust reconstructs
 * via `ergo_tree.sigma_serialize_bytes()`).
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 */

import type { ExtractScriptBytes, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'

const EXTRACT_SCRIPT_BYTES_COST = 10

export function evalExtractScriptBytes(
  e: ExtractScriptBytes,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_SCRIPT_BYTES_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractScriptBytes: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  return bytesToCollByteSValue(input.value.ergoTreeBytes)
}
```

- [ ] **Step 7: Wire into central dispatch**

In `eval/eval.ts`:

```ts
import { evalExtractScriptBytes } from './extract-script-bytes'
// ...
    case 'ExtractScriptBytes':
      return evalExtractScriptBytes(e, env, ctx)
```

- [ ] **Step 8: Run tests + typecheck**

```bash
npx vitest run packages/ergoscript/test/eval/extract-script-bytes.test.ts
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all PASS, zero TS errors.

- [ ] **Step 9: Commit**

```bash
git add packages/ergoscript/src/eval/extract-script-bytes.ts \
        packages/ergoscript/src/eval/_byte-coll.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/extract-script-bytes.test.ts \
        packages/ergoscript/test/fixtures/eval/extract-script-bytes.json \
        fixture-gen/src/cmds/ergoscript/eval/extract_script_bytes.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): ExtractScriptBytes eval arm + bytesToCollByteSValue helper (phase 2f Stop α task 3)

Fixed(10) cost BEFORE eval-child. Introduces `_byte-coll.ts` helper
reused by ExtractCreationInfo (Task 5) and the Stop γ hash extractors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## STOP α

**State at this point:** Foundation + 2 of 7 Box-extract arms shipped. SBox wire format closed. `_byte-coll.ts` helper in place for downstream arms.

- [ ] **Stop α checklist:**

```bash
# 1. Run corpus eval gate
npx vitest run packages/ergoscript/test/corpus-eval.test.ts
# Expected: success=0 not-impl=18 other=0 (unchanged from prior slices).
```

- [ ] **Update `facts/ergoscript.md`:**
  - Add a "Phase 2f Stop α additions" block (insert after the 2e block, before "Coverage after 2e"):
    - `parseSValue` / `serializeSValue` SBox arms ship (replacing `'not-implemented-phase-2a'` throw for SBox specifically)
    - 1 new EvalError code: `'extract-input-not-box'`
    - 2 new SValueParseError codes: `'sbox-tokens-out-of-range'`, `'sbox-registers-out-of-range'`
    - 2 new SValueSerializeError codes: `'token-id-length'`, `'txid-length'`
    - ErgoBox.registers reshape (carries per-register SType)
  - Bump coverage line: "Coverage after 2f α: 22 of ~70 `Expr` arms; 2 of 7 Box-extract arms shipped"

- [ ] **Update memory `project_ergots_direction`:** "phase 2f Stop α shipped (22/70 arms; SBox wire closed). Next: Stop β = ExtractRegisterAs + ExtractCreationInfo."

- [ ] **Commit the docs/memory updates:**

```bash
git add facts/ergoscript.md
git commit -m "$(cat <<'EOF'
docs(ergoscript): facts/ergoscript.md — phase 2f Stop α surface (22 of ~70 arms)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Push to origin/master:**

```bash
git push origin master
```

(Or pause here — Stop α is a natural call-it-a-day point. Resume with Task 4.)

---

## Stop β — Structural extractors

Two tasks: ExtractRegisterAs (Task 4) and ExtractCreationInfo (Task 5). Coverage after Stop β: **24 of ~70 arms; 4 of 7 Box-extract arms shipped.**

---

### Task 4: `ExtractRegisterAs` arm + fixture

**Files:**
- Create: `packages/ergoscript/src/eval/extract-register-as.ts`
- Create: `packages/ergoscript/test/eval/extract-register-as.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/extract_register_as.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/extract-register-as.json`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add `case 'ExtractRegisterAs':`)

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/extract_reg_as.rs:15-48` (eval logic, R0..R9 via `get_register`)
- `ergotree-ir/src/chain/ergo_box.rs:155-198` (`get_register` + `tokens_raw` + `creation_info` synthesizers for R0..R3)
- `ergotree-ir/src/chain/ergo_box/register/id.rs:32-48` (RegisterId range validation)

**Key behavior:**

The largest arm in the slice. Six discrete sub-steps:

1. Charge Fixed(50) BEFORE eval-child.
2. Eval child to a Box value. Defensive check `'extract-input-not-box'`.
3. Validate `e.registerId ∈ [0, 9]`. Throw `'register-id-out-of-range'` otherwise.
4. Get register entry (`{ tpe, value }`):
   - **R0** synthesize `{ tpe: SLong, value: { kind: 'Long', value: box.value } }`
   - **R1** synthesize `{ tpe: SColl[SByte], value: bytesToCollByteSValue(box.ergoTreeBytes) }`
   - **R2** synthesize `{ tpe: SColl[STuple[SColl[SByte], SLong]], value: tokensToCollTupleSValue(box.tokens) }`
   - **R3** synthesize `{ tpe: STuple[SInt, SColl[SByte]], value: creationInfoTupleSValue(box) }`
   - **R4..R9** read `box.registers[e.registerId]`; if `undefined`, return `Option None`.
5. Type-assertion: if entry exists and `sTypeEquals(entry.tpe, e.elemTpe)` is false → throw `'register-type-mismatch'`. Sigma-rust THROWS here (NOT None) per `extract_reg_as.rs:41-44`.
6. Wrap entry value in `{ kind: 'Option', elem: e.elemTpe, value: entry.value }`. For absent R4..R9, wrap as `{ kind: 'Option', elem: e.elemTpe, value: null }`.

New EvalError codes:
- `'register-id-out-of-range'`
- `'register-type-mismatch'`

- [ ] **Step 1: Read sigma-rust sources**

```bash
cat /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_reg_as.rs
sed -n '155,200p' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box.rs
sed -n '32,48p' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box/register/id.rs
```

Confirm: type-mismatch throws (line 41-44); registerId range is signed i8 with 0..=9 valid; R0..R3 synthesis matches the table above.

- [ ] **Step 2: Write the fixture-gen Rust module**

Create `fixture-gen/src/cmds/ergoscript/eval/extract_register_as.rs`. Should have ~12 entries:

- R0/R1/R2/R3 happy paths with matching `elem_tpe` (SLong / SColl[SByte] / SColl[STuple[...]] / STuple[SInt, SColl[SByte]])
- R0 wrong type (expect SInt instead of SLong) → expects `'register-type-mismatch'`
- R4..R9 happy paths (test cases with stored types like SLong, SColl[SByte]); one absent register → expects Option None
- registerId = -1, registerId = 10 → expects `'register-id-out-of-range'`
- Non-Box input → expects `'extract-input-not-box'`

Model after sigma-rust's `eval_box_get_reg_r0` and `eval_box_get_reg_r0_wrong_type` tests at `extract_reg_as.rs:64-91`. Note that wrapping in `OptionGet` (used by sigma-rust's tests) is not appropriate here since OptionGet isn't yet wired — produce the Option SValue directly as the expected output.

Add `pub mod extract_register_as;` to `eval/mod.rs`; `generate_and_write` call in `main.rs`.

- [ ] **Step 3: Generate the fixture + determinism check**

```bash
cd fixture-gen && cargo run --release -p fixture-gen && cd ..
git diff packages/ergoscript/test/fixtures/eval/extract-register-as.json
# Expected: no diff on second run.
```

- [ ] **Step 4: Write the failing TS test**

Create `packages/ergoscript/test/eval/extract-register-as.test.ts` (fixture-driven for all entries + 1 inline test for non-Box input):

```ts
// ... same structure as prior eval tests ...

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluate } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, captureEvalError } from '../_helpers'

// ... fixture loop ...

it('non-Box input throws extract-input-not-box', () => {
  const tree = {
    header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0 },
    constants: [],
    constantTypes: [],
    body: {
      tag: 'ExtractRegisterAs' as const,
      input: {
        tag: 'Const' as const,
        tpe: { tag: 'SInt' as const },
        value: { kind: 'Int' as const, value: 5 },
      },
      registerId: 0,
      elemTpe: { tag: 'SLong' as const },
    },
  }
  const err = captureEvalError(() => evaluate(tree))
  expect(err.code).toBe('extract-input-not-box')
})
```

Run to verify FAIL:

```bash
npx vitest run packages/ergoscript/test/eval/extract-register-as.test.ts
```

Expected: FAIL with `'not-implemented-yet'`.

- [ ] **Step 5: Implement `evalExtractRegisterAs`**

Create `packages/ergoscript/src/eval/extract-register-as.ts`:

```ts
/**
 * ExtractRegisterAs arm — Box → Option[T], with type-assertion against
 * the expected element type. R0..R3 are mandatory registers synthesized
 * from box fields; R4..R9 are non-mandatory registers from the
 * additional_registers map.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_reg_as.rs:15-48
 *   ctx.add_jit_cost(50)?;                          // BEFORE eval-child
 *   let ir_box = self.input.eval(...)?.try_extract_into::<Ref<ErgoBox>>()?;
 *   let id: RegisterId = self.register_id.try_into()?;  // 0..=9 only
 *   let reg = ir_box.get_register(id)?;              // None for absent R4..R9
 *   match reg {
 *     Some(c) if c.tpe == *self.elem_tpe => Ok(Value::Opt(Some(c.v))),
 *     Some(c) => Err(EvalError::UnexpectedValue(...)),     // type-mismatch THROWS
 *     None => Ok(Value::Opt(None)),
 *   }
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 *
 * R0..R3 synthesis (sigma-rust `chain/ergo_box.rs:155-168`):
 *   R0: SLong(box.value)
 *   R1: SColl[SByte] of box.ergoTreeBytes (the canonical script bytes)
 *   R2: SColl[STuple[SColl[SByte], SLong]] of tokens (id × amount)
 *   R3: STuple[SInt, SColl[SByte]] of (creationHeight, txId ++ BE_u16(index))
 *
 * R4..R9: read box.registers[id]; if undefined, return Option None.
 *
 * Type-assertion: when entry exists and tpe ≠ elemTpe, sigma-rust THROWS
 * EvalError::UnexpectedValue (NOT returns None). Surfaced as typed code
 * 'register-type-mismatch' for programmatic dispatch.
 */

import type { ErgoBox, ExtractRegisterAs, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { sTypeEquals } from '../mir/stype-helpers'
import { bytesToCollByteSValue } from './_byte-coll'

const EXTRACT_REGISTER_AS_COST = 50

const SLONG: SType = { tag: 'SLong' }
const SINT: SType = { tag: 'SInt' }
const SBYTE: SType = { tag: 'SByte' }
const SCOLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }
const STUPLE_COLLBYTE_LONG: SType = {
  tag: 'STuple',
  items: [SCOLL_BYTE, SLONG],
}
const SCOLL_TOKEN: SType = { tag: 'SColl', elem: STUPLE_COLLBYTE_LONG }
const STUPLE_INT_COLLBYTE: SType = {
  tag: 'STuple',
  items: [SINT, SCOLL_BYTE],
}

function tokensToCollTupleSValue(
  tokens: { id: Uint8Array; amount: bigint }[]
): SValue {
  const items: SValue[] = tokens.map((t) => ({
    kind: 'Tuple',
    items: [bytesToCollByteSValue(t.id), { kind: 'Long', value: t.amount }],
  }))
  return { kind: 'Coll', elem: STUPLE_COLLBYTE_LONG, items }
}

function creationInfoTupleSValue(box: ErgoBox): SValue {
  // 34-byte byte-array: 32-byte txId concatenated with BE u16 of index.
  const combined = new Uint8Array(34)
  combined.set(box.txId, 0)
  combined[32] = (box.index >> 8) & 0xff
  combined[33] = box.index & 0xff
  return {
    kind: 'Tuple',
    items: [
      { kind: 'Int', value: box.creationHeight },
      bytesToCollByteSValue(combined),
    ],
  }
}

function getRegisterEntry(
  box: ErgoBox,
  id: number
): { tpe: SType; value: SValue } | undefined {
  switch (id) {
    case 0:
      return { tpe: SLONG, value: { kind: 'Long', value: box.value } }
    case 1:
      return {
        tpe: SCOLL_BYTE,
        value: bytesToCollByteSValue(box.ergoTreeBytes),
      }
    case 2:
      return { tpe: SCOLL_TOKEN, value: tokensToCollTupleSValue(box.tokens) }
    case 3:
      return {
        tpe: STUPLE_INT_COLLBYTE,
        value: creationInfoTupleSValue(box),
      }
    default:
      return box.registers[id]
  }
}

export function evalExtractRegisterAs(
  e: ExtractRegisterAs,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_REGISTER_AS_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractRegisterAs: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  if (e.registerId < 0 || e.registerId > 9) {
    throw new EvalError(
      `ExtractRegisterAs: registerId ${e.registerId} is out of range (0..=9)`,
      'register-id-out-of-range'
    )
  }
  const entry = getRegisterEntry(input.value, e.registerId)
  if (entry === undefined) {
    return { kind: 'Option', elem: e.elemTpe, value: null }
  }
  if (!sTypeEquals(entry.tpe, e.elemTpe)) {
    throw new EvalError(
      `ExtractRegisterAs: register R${e.registerId} type mismatch (expected ${
        e.elemTpe.tag
      }, got ${entry.tpe.tag})`,
      'register-type-mismatch'
    )
  }
  return { kind: 'Option', elem: e.elemTpe, value: entry.value }
}
```

- [ ] **Step 6: Wire into central dispatch**

In `eval/eval.ts`:

```ts
import { evalExtractRegisterAs } from './extract-register-as'
// ...
    case 'ExtractRegisterAs':
      return evalExtractRegisterAs(e, env, ctx)
```

- [ ] **Step 7: Run tests + typecheck**

```bash
npx vitest run packages/ergoscript/test/eval/extract-register-as.test.ts
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all PASS, zero TS errors.

- [ ] **Step 8: Commit**

```bash
git add packages/ergoscript/src/eval/extract-register-as.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/extract-register-as.test.ts \
        packages/ergoscript/test/fixtures/eval/extract-register-as.json \
        fixture-gen/src/cmds/ergoscript/eval/extract_register_as.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): ExtractRegisterAs eval arm + register-id-out-of-range + register-type-mismatch codes (phase 2f Stop β task 4)

Fixed(50) cost BEFORE eval-child. R0..R3 synthesized from box fields;
R4..R9 read from box.registers. Type-assertion throws on mismatch
(matches sigma-rust; NOT None).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `ExtractCreationInfo` arm + fixture

**Files:**
- Create: `packages/ergoscript/src/eval/extract-creation-info.ts`
- Create: `packages/ergoscript/test/eval/extract-creation-info.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/extract_creation_info.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/extract-creation-info.json`
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust source:** `ergotree-interpreter/src/eval/extract_creation_info.rs:9-25`; `ergotree-ir/src/chain/ergo_box.rs:187-192` (`creation_info` helper). Cost Fixed(16) BEFORE eval-child. Returns `(Int, Coll[Byte])` tuple where the byte-array is 34 bytes: 32-byte txId concatenated with BE u16 index.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_creation_info.rs
sed -n '187,200p' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box.rs
```

- [ ] **Step 2: Write the fixture-gen Rust module + run + verify determinism**

`fixture-gen/src/cmds/ergoscript/eval/extract_creation_info.rs`:

```rust
//! Phase 2f Stop β Task 5 — ExtractCreationInfo eval fixtures.
//! Fixed(16) cost BEFORE eval-child. Returns Tuple[Int, Coll[Byte]]
//! where the Coll[Byte] is 32-byte txId ++ BE u16 index = 34 bytes.

use crate::cmds::ergoscript::eval::EvalFixtureEntry;
use ergotree_ir::chain::context::Context;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_creation_info::ExtractCreationInfo;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use sigma_test_util::force_any_val;

pub fn generate() -> anyhow::Result<Vec<EvalFixtureEntry>> {
    let mut entries = Vec::new();
    let ctx = force_any_val::<Context>();

    let self_box = (*ctx.self_box).clone();
    let const_box: Expr = Constant {
        tpe: SType::SBox,
        v: self_box.clone().into(),
    }
    .into();
    let expr: Expr = ExtractCreationInfo::try_build(const_box)?.into();
    let tree_bytes = expr.sigma_serialize_bytes()?;

    let (height, bytes) = self_box.creation_info();
    let bytes_items: Vec<serde_json::Value> = bytes
        .iter()
        .map(|b| serde_json::json!({ "kind": "Byte", "value": *b as i32 }))
        .collect();

    let value_json = serde_json::json!({
        "kind": "Tuple",
        "items": [
            { "kind": "Int", "value": height },
            { "kind": "Coll", "elem": { "tag": "SByte" }, "items": bytes_items }
        ]
    });
    entries.push(EvalFixtureEntry {
        name: "extract_creation_info_selfbox".to_string(),
        tree_bytes_hex: hex::encode(&tree_bytes),
        opts_json: serde_json::json!({}).to_string(),
        expected_value_json: value_json.to_string(),
        expected_cost: 16,
        expected_error_code: None,
    });
    // Add 4 more entries with varied (height, txId, index) including index=0, index=65535.

    Ok(entries)
}
```

Wire and run as in prior tasks.

- [ ] **Step 3: Write the failing TS test**

Create `packages/ergoscript/test/eval/extract-creation-info.test.ts` (same fixture loop pattern + 1 inline defensive test for non-Box input → 'extract-input-not-box').

Run to verify FAIL with `'not-implemented-yet'`.

- [ ] **Step 4: Implement `evalExtractCreationInfo`**

Create `packages/ergoscript/src/eval/extract-creation-info.ts`:

```ts
/**
 * ExtractCreationInfo arm — Box → Tuple[Int, Coll[Byte]] where the
 * Coll[Byte] is a 34-byte concat: 32-byte txId + BE u16 of box index.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_creation_info.rs:9-25
 *   ctx.add_jit_cost(16)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.creation_info().into(), ... }
 *
 * `creation_info` (sigma-rust `chain/ergo_box.rs:187-192`):
 *   bytes = txId (32 bytes) ++ index.to_be_bytes()   (2 bytes; u16 BE)
 *   return (creation_height as i32, bytes)
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 */

import type { ExtractCreationInfo, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'

const EXTRACT_CREATION_INFO_COST = 16

const SBYTE: SType = { tag: 'SByte' }
const SCOLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }

export function evalExtractCreationInfo(
  e: ExtractCreationInfo,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_CREATION_INFO_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractCreationInfo: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  const box = input.value
  const combined = new Uint8Array(34)
  combined.set(box.txId, 0)
  combined[32] = (box.index >> 8) & 0xff
  combined[33] = box.index & 0xff
  return {
    kind: 'Tuple',
    items: [
      { kind: 'Int', value: box.creationHeight },
      bytesToCollByteSValue(combined),
    ],
  }
}
```

- [ ] **Step 5: Wire into dispatch + run tests + typecheck + commit**

```ts
// eval/eval.ts:
import { evalExtractCreationInfo } from './extract-creation-info'
    case 'ExtractCreationInfo':
      return evalExtractCreationInfo(e, env, ctx)
```

```bash
npx vitest run packages/ergoscript/test/eval/extract-creation-info.test.ts
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript

git add packages/ergoscript/src/eval/extract-creation-info.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/extract-creation-info.test.ts \
        packages/ergoscript/test/fixtures/eval/extract-creation-info.json \
        fixture-gen/src/cmds/ergoscript/eval/extract_creation_info.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): ExtractCreationInfo eval arm (phase 2f Stop β task 5)

Fixed(16) cost BEFORE eval-child. Returns Tuple[Int, Coll[Byte]] where
Coll[Byte] is the 34-byte concat (txId ++ BE u16 index).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## STOP β

**State at this point:** 4 of 7 Box-extract arms shipped. Everything that doesn't need the box-bytes serializer is done.

- [ ] **Stop β checklist:**

```bash
# 1. Corpus eval gate
npx vitest run packages/ergoscript/test/corpus-eval.test.ts
# Expected: success=0 not-impl=18 other=0 (still — corpus needs method calls).
```

- [ ] **Update `facts/ergoscript.md`:**
  - Add 2 new EvalError codes to taxonomy: `'register-id-out-of-range'`, `'register-type-mismatch'`
  - Bump coverage line: "Coverage after 2f β: 24 of ~70 `Expr` arms; 4 of 7 Box-extract arms shipped"

- [ ] **Update memory `project_ergots_direction`:** "phase 2f Stop β shipped (24/70 arms). Next: Stop γ = Box canonical-bytes serializer + ExtractBytes + ExtractBytesWithNoRef + ExtractId."

- [ ] **Commit + push:**

```bash
git add facts/ergoscript.md
git commit -m "$(cat <<'EOF'
docs(ergoscript): facts/ergoscript.md — phase 2f Stop β surface (24 of ~70 arms)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin master
```

(Or pause here — Stop β is a clean call-it-a-day point. Resume with Task 6.)

---

## Stop γ — Serializer + 3 hash extractors

Three tasks: Box canonical-bytes serializer (Task 6), ExtractBytes + ExtractBytesWithNoRef arms (Task 7), ExtractId arm + finalize (Task 8). Coverage after Stop γ: **27 of ~70 arms; 7 of 7 Box-extract arms shipped. Phase 2f narrow complete.**

---

### Task 6: Box canonical-bytes serializer (`wire/ergo-box-bytes.ts`)

**Files:**
- Create: `packages/ergoscript/src/wire/ergo-box-bytes.ts` — `serializeBoxBytes` + `serializeBoxBytesWithoutRef`
- Create: `packages/ergoscript/test/wire/ergo-box-bytes.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/wire/ergo_box_bytes.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/wire/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/wire/ergo-box-bytes.json`

**Sigma-rust source:**
- `ergotree-ir/src/chain/ergo_box.rs:202-216` (`sigma_serialize for ErgoBox`)
- `ergotree-ir/src/chain/ergo_box.rs:195-198` (`bytes_without_ref` — uses ErgoBoxCandidate's serializer)
- Both call into `serialize_box_with_indexed_digests` (first 5 fields); full version then writes tx_id + index.

**Key behavior:**

Two public functions:

```ts
serializeBoxBytes(box: ErgoBox): Uint8Array            // full canonical bytes
serializeBoxBytesWithoutRef(box: ErgoBox): Uint8Array  // omits tx_id + index
```

Both write the same first-5-field block:
1. `value` — VLQ u64
2. `ergoTreeBytes` — VLQ u32 size + raw bytes
3. `tokens` — VLQ u32 count + per-token: 32-byte id + VLQ u64 amount
4. `additional_registers` — VLQ u32 count + per-register: SType + SValue
5. `creation_height` — VLQ u32

`serializeBoxBytes` then appends:
6. `tx_id` — 32 raw bytes
7. `index` — VLQ u16

`serializeBoxBytesWithoutRef` stops after step 5.

NOTE: This serializer overlaps with the SBox arm in `serialize-svalue.ts` (Task 1). Task 1's SBox arm IS this serializer — both call into the same byte sequence. To avoid duplication, this Task 6 implementation lives in `wire/ergo-box-bytes.ts`, and `serialize-svalue.ts`'s SBox arm gets refactored to call `serializeBoxBytes(box, writer)` (or accept a writer-passing variant). Confirm at implementation time which arrangement is cleaner.

- [ ] **Step 1: Read sigma-rust source**

```bash
sed -n '200,225p' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box.rs
sed -n '195,200p' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box.rs
grep -rn "fn serialize_box_with_indexed_digests" /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/
```

- [ ] **Step 2: Write the fixture-gen Rust module + run + determinism**

Create `fixture-gen/src/cmds/ergoscript/wire/ergo_box_bytes.rs` — generates entries with both `expected_bytes_full_hex` and `expected_bytes_no_ref_hex` per box (from `box.sigma_serialize_bytes()` and `box.bytes_without_ref()`). ~5 entries spanning minimal box, rich box (multiple tokens + registers), max-shape box.

```rust
pub fn generate() -> anyhow::Result<Vec<BoxBytesFixtureEntry>> {
    // Schema:
    // - name
    // - box_input_json (the ErgoBox struct serialized as JSON; TS reconstructs from this)
    // - expected_bytes_full_hex (from box.sigma_serialize_bytes())
    // - expected_bytes_no_ref_hex (from box.bytes_without_ref())
    // ...
}
```

Define `BoxBytesFixtureEntry` either inline or in `wire/mod.rs` next to `WireFixtureEntry`.

Wire + run + determinism check.

- [ ] **Step 3: Write the failing TS test**

Create `packages/ergoscript/test/wire/ergo-box-bytes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  serializeBoxBytes,
  serializeBoxBytesWithoutRef,
} from '../../src/wire/ergo-box-bytes'
import type { ErgoBox } from '../../src/mir/types'
import { hexToBytes /* ... */ } from '../_helpers'

interface BoxBytesFixtureEntry {
  name: string
  box_input_json: string
  expected_bytes_full_hex: string
  expected_bytes_no_ref_hex: string
}

const FIXTURE_PATH = resolve(__dirname, '../fixtures/wire/ergo-box-bytes.json')
const entries: BoxBytesFixtureEntry[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

function rebuildBox(json: string): ErgoBox {
  // Reconstruct ErgoBox from the JSON shape emitted by fixture-gen.
  // Adjust field names + value rehydration as needed.
  const o = JSON.parse(json)
  return {
    value: BigInt(o.value),
    ergoTreeBytes: hexToBytes(o.ergoTreeBytes),
    registers: /* parse tpe + value per slot */,
    tokens: o.tokens.map((t: { id: string; amount: string }) => ({
      id: hexToBytes(t.id),
      amount: BigInt(t.amount),
    })),
    creationHeight: o.creationHeight,
    txId: hexToBytes(o.txId),
    index: o.index,
  }
}

describe('Box canonical-bytes serializer (phase 2f Stop γ Task 6)', () => {
  for (const entry of entries) {
    it(`${entry.name} — full bytes`, () => {
      const box = rebuildBox(entry.box_input_json)
      const bytes = serializeBoxBytes(box)
      expect(Buffer.from(bytes).toString('hex')).toBe(entry.expected_bytes_full_hex)
    })
    it(`${entry.name} — bytes without ref`, () => {
      const box = rebuildBox(entry.box_input_json)
      const bytes = serializeBoxBytesWithoutRef(box)
      expect(Buffer.from(bytes).toString('hex')).toBe(entry.expected_bytes_no_ref_hex)
    })
  }
})
```

Run to verify FAIL (module not found / function undefined).

- [ ] **Step 4: Implement `serializeBoxBytes` + `serializeBoxBytesWithoutRef`**

Create `packages/ergoscript/src/wire/ergo-box-bytes.ts`:

```ts
/**
 * Box canonical-bytes serializer. Mirrors sigma-rust
 * `sigma_serialize for ErgoBox` (`chain/ergo_box.rs:202-216`) and the
 * `bytes_without_ref` variant (`chain/ergo_box.rs:195-198`).
 *
 * Wire layout:
 *   value: VLQ u64 (BoxValue)
 *   ergo_tree_bytes: VLQ u32 size + raw bytes
 *   tokens: VLQ u32 count + per-token: 32-byte id + VLQ u64 amount
 *   additional_registers: VLQ u32 count + per-register: SType + SValue
 *   creation_height: VLQ u32
 *   [full only] transaction_id: 32 raw bytes
 *   [full only] index: VLQ u16
 *
 * The `serializeBoxBytesWithoutRef` variant matches sigma-rust's
 * `ErgoBoxCandidate` serialization (without tx_id + index). Used by
 * `ExtractBytesWithNoRef` (Task 7).
 *
 * Sigma-rust ref:
 *   chain/ergo_box.rs:202-216 (sigma_serialize for ErgoBox)
 *   chain/ergo_box.rs:195-198 (bytes_without_ref)
 */

import type { ErgoBox } from '../mir/types'
import { ByteWriter } from './writer'
import { serializeSType } from './serialize-stype'
import { serializeSValue } from './serialize-svalue'

function writeBodyWithoutRef(box: ErgoBox, w: ByteWriter): void {
  w.writeVlqBigIntUnsigned(box.value)
  w.writeVlqU(box.ergoTreeBytes.length)
  w.writeBytes(box.ergoTreeBytes)

  w.writeVlqU(box.tokens.length)
  for (const token of box.tokens) {
    w.writeBytes(token.id)
    w.writeVlqBigIntUnsigned(token.amount)
  }

  const regKeys = Object.keys(box.registers)
    .map((k) => Number(k))
    .filter((k) => k >= 4 && k <= 9 && box.registers[k] !== undefined)
    .sort((a, b) => a - b)
  w.writeVlqU(regKeys.length)
  for (const k of regKeys) {
    const entry = box.registers[k]!
    serializeSType(entry.tpe, w)
    serializeSValue(entry.tpe, entry.value, w)
  }

  w.writeVlqU(box.creationHeight)
}

export function serializeBoxBytes(box: ErgoBox): Uint8Array {
  const w = new ByteWriter()
  writeBodyWithoutRef(box, w)
  w.writeBytes(box.txId)
  w.writeVlqU(box.index)
  return w.toBytes()
}

export function serializeBoxBytesWithoutRef(box: ErgoBox): Uint8Array {
  const w = new ByteWriter()
  writeBodyWithoutRef(box, w)
  return w.toBytes()
}
```

If Task 1's `serialize-svalue.ts` SBox arm duplicates this body, refactor it to call `writeBodyWithoutRef` (or hoist a writer-shared helper). The reviewer will check for duplication.

- [ ] **Step 5: Run tests + typecheck**

```bash
npx vitest run packages/ergoscript/test/wire/ergo-box-bytes.test.ts
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ergoscript/src/wire/ergo-box-bytes.ts \
        packages/ergoscript/test/wire/ergo-box-bytes.test.ts \
        packages/ergoscript/test/fixtures/wire/ergo-box-bytes.json \
        fixture-gen/src/cmds/ergoscript/wire/ergo_box_bytes.rs \
        fixture-gen/src/cmds/ergoscript/wire/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): Box canonical-bytes serializer (phase 2f Stop γ task 6)

Ports sigma-rust's sigma_serialize for ErgoBox + bytes_without_ref
variant. Reusable for the wallet phase. Standalone tests assert
byte-for-byte agreement with fixture-gen-emitted bytes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `ExtractBytes` + `ExtractBytesWithNoRef` arms + fixtures

**Files:**
- Create: `packages/ergoscript/src/eval/extract-bytes.ts`
- Create: `packages/ergoscript/src/eval/extract-bytes-with-no-ref.ts`
- Create: `packages/ergoscript/test/eval/extract-bytes.test.ts`
- Create: `packages/ergoscript/test/eval/extract-bytes-with-no-ref.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/extract_bytes.rs`
- Create: `fixture-gen/src/cmds/ergoscript/eval/extract_bytes_with_no_ref.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create (generated): both eval-fixture JSON files
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust sources:**
- `ergotree-interpreter/src/eval/extract_bytes.rs:9-25` — Fixed(12), BEFORE eval-child
- `ergotree-interpreter/src/eval/extract_bytes_with_no_ref.rs:9-25` — Fixed(12), BEFORE eval-child

Both arms invoke the box's bytes serializer (full vs no-ref) and wrap the result as `Coll[Byte]`.

- [ ] **Step 1: Read sigma-rust sources**

```bash
cat /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_bytes.rs
cat /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_bytes_with_no_ref.rs
```

- [ ] **Step 2: Write the fixture-gen Rust modules**

`extract_bytes.rs`:

```rust
//! Phase 2f Stop γ Task 7 — ExtractBytes eval fixtures.
//! Fixed(12) cost BEFORE eval-child. Returns Coll[Byte] of canonical box bytes.

// Use ctx.self_box.sigma_serialize_bytes() (matches what sigma-rust eval returns).
// Build Const(SBox, box) → ExtractBytes(input).
// Assert expected_value is the Coll[Byte] form of those bytes.
```

`extract_bytes_with_no_ref.rs`: same shape but `box.bytes_without_ref()` for expected_value.

Wire both into mod.rs + main.rs.

- [ ] **Step 3: Generate fixtures + determinism check**

- [ ] **Step 4: Write the two failing TS tests**

Both files follow the fixture-loop pattern with a `'extract-input-not-box'` inline defensive test.

- [ ] **Step 5: Implement `evalExtractBytes`**

Create `packages/ergoscript/src/eval/extract-bytes.ts`:

```ts
/**
 * ExtractBytes arm — Box → Coll[Byte] of canonical box bytes.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_bytes.rs:9-25
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.sigma_serialize_bytes()?.into(), ... }
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 */

import type { ExtractBytes, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { serializeBoxBytes } from '../wire/ergo-box-bytes'

const EXTRACT_BYTES_COST = 12

export function evalExtractBytes(
  e: ExtractBytes,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_BYTES_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractBytes: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  return bytesToCollByteSValue(serializeBoxBytes(input.value))
}
```

- [ ] **Step 6: Implement `evalExtractBytesWithNoRef`**

Create `packages/ergoscript/src/eval/extract-bytes-with-no-ref.ts`:

```ts
/**
 * ExtractBytesWithNoRef arm — Box → Coll[Byte] of canonical box bytes
 * omitting transaction_id + index (the "candidate" form).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_bytes_with_no_ref.rs:9-25
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.bytes_without_ref()?.into(), ... }
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 */

import type { ExtractBytesWithNoRef, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { serializeBoxBytesWithoutRef } from '../wire/ergo-box-bytes'

const EXTRACT_BYTES_WITH_NO_REF_COST = 12

export function evalExtractBytesWithNoRef(
  e: ExtractBytesWithNoRef,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_BYTES_WITH_NO_REF_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractBytesWithNoRef: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  return bytesToCollByteSValue(serializeBoxBytesWithoutRef(input.value))
}
```

- [ ] **Step 7: Wire both into dispatch**

In `eval/eval.ts`:

```ts
import { evalExtractBytes } from './extract-bytes'
import { evalExtractBytesWithNoRef } from './extract-bytes-with-no-ref'
// ...
    case 'ExtractBytes':
      return evalExtractBytes(e, env, ctx)
    case 'ExtractBytesWithNoRef':
      return evalExtractBytesWithNoRef(e, env, ctx)
```

- [ ] **Step 8: Run tests + typecheck + commit**

```bash
npx vitest run packages/ergoscript/test/eval/extract-bytes.test.ts \
              packages/ergoscript/test/eval/extract-bytes-with-no-ref.test.ts
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript

git add packages/ergoscript/src/eval/extract-bytes.ts \
        packages/ergoscript/src/eval/extract-bytes-with-no-ref.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/extract-bytes.test.ts \
        packages/ergoscript/test/eval/extract-bytes-with-no-ref.test.ts \
        packages/ergoscript/test/fixtures/eval/extract-bytes.json \
        packages/ergoscript/test/fixtures/eval/extract-bytes-with-no-ref.json \
        fixture-gen/src/cmds/ergoscript/eval/extract_bytes.rs \
        fixture-gen/src/cmds/ergoscript/eval/extract_bytes_with_no_ref.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): ExtractBytes + ExtractBytesWithNoRef eval arms (phase 2f Stop γ task 7)

Both Fixed(12) cost BEFORE eval-child. Invoke the Task 6
serializeBoxBytes / serializeBoxBytesWithoutRef helpers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `ExtractId` arm + fixture + finalize

**Files:**
- Create: `packages/ergoscript/src/eval/extract-id.ts`
- Create: `packages/ergoscript/test/eval/extract-id.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/extract_id.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/extract-id.json`
- Modify: `packages/ergoscript/src/eval/eval.ts`
- Modify: `facts/ergoscript.md` (final updates)
- Modify (out-of-repo): `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`
- Modify (out-of-repo): `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md`
- Modify (out-of-repo): `packages/ergoscript/SESSION_CONTEXT.md` (gitignored — local-only snapshot)

**Sigma-rust source:** `ergotree-interpreter/src/eval/extract_id.rs:10-28`. Cost Fixed(12) BEFORE eval-child. Returns `blake2b256(sigma_serialize_bytes(box))` wrapped as Coll[Byte] (32 bytes).

In sigma-rust, `box.box_id()` is the cached field; we compute lazily via `blake2b256(serializeBoxBytes(box))` (per spec Decision #4).

**Key behavior:**
- Cost: Fixed(12), BEFORE eval-child.
- Returns `Coll[Byte]` of 32 bytes (blake2b-256 hash).
- First eval-time `blake2b` call in the package; uses `@noble/hashes/blake2.js`.

- [ ] **Step 1: Read sigma-rust source + confirm blake2b import path**

```bash
cat /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/extract_id.rs
sed -n '149,155p' /home/mwaddip/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box.rs

# Confirm noble-hashes blake2 import path used in proof package:
rtk grep -n "from '@noble/hashes" packages/proof/src/ | head -5
```

The proof package precedent: `import { blake2b } from '@noble/hashes/blake2.js'`. Use that.

- [ ] **Step 2: Write fixture-gen Rust module + run + determinism check**

`extract_id.rs`:

```rust
//! Phase 2f Stop γ Task 8 — ExtractId eval fixtures.
//! Fixed(12) cost BEFORE eval-child. Returns Coll[Byte] of 32-byte blake2b256 hash.

use crate::cmds::ergoscript::eval::EvalFixtureEntry;
use ergotree_ir::chain::context::Context;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_id::ExtractId;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use sigma_test_util::force_any_val;

pub fn generate() -> anyhow::Result<Vec<EvalFixtureEntry>> {
    let mut entries = Vec::new();
    let ctx = force_any_val::<Context>();

    let self_box = (*ctx.self_box).clone();
    let const_box: Expr = Constant {
        tpe: SType::SBox,
        v: self_box.clone().into(),
    }
    .into();
    let expr: Expr = ExtractId {
        input: Box::new(const_box),
    }
    .into();
    let tree_bytes = expr.sigma_serialize_bytes()?;

    // box_id() is cached; its bytes match blake2b256(sigma_serialize_bytes(box)).
    let id_bytes: Vec<i8> = self_box.box_id().into();
    let items: Vec<serde_json::Value> = id_bytes
        .iter()
        .map(|b| serde_json::json!({ "kind": "Byte", "value": *b as i32 }))
        .collect();
    let value_json = serde_json::json!({
        "kind": "Coll",
        "elem": { "tag": "SByte" },
        "items": items
    });
    entries.push(EvalFixtureEntry {
        name: "extract_id_selfbox".to_string(),
        tree_bytes_hex: hex::encode(&tree_bytes),
        opts_json: serde_json::json!({}).to_string(),
        expected_value_json: value_json.to_string(),
        expected_cost: 12,
        expected_error_code: None,
    });
    // Add 3 more entries with varied box shapes (minimal box, multi-token, etc).

    Ok(entries)
}
```

Wire + run + verify determinism.

- [ ] **Step 3: Write the failing TS test**

Create `packages/ergoscript/test/eval/extract-id.test.ts` — fixture-loop pattern + 1 inline defensive test.

- [ ] **Step 4: Implement `evalExtractId`**

Create `packages/ergoscript/src/eval/extract-id.ts`:

```ts
/**
 * ExtractId arm — Box → Coll[Byte] of 32-byte blake2b-256 hash of the
 * box's canonical bytes.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_id.rs:10-28
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.box_id().into(), ... }
 *
 * Sigma-rust caches `box_id` at construction via `calc_box_id()`. We
 * compute lazily here — sigma-rust caches for performance, not
 * correctness. No observable divergence in output bytes.
 *
 * `calc_box_id` (sigma-rust `chain/ergo_box.rs:149-153`):
 *   bytes = box.sigma_serialize_bytes()
 *   hash = blake2b256(bytes)
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 *
 * First eval-time blake2b call in the package — uses existing
 * `@noble/hashes/blake2.js` dep from phase 2a per the
 * [[reference-noble-hashes-blake2]] memory.
 */

import type { ExtractId, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { serializeBoxBytes } from '../wire/ergo-box-bytes'
import { blake2b } from '@noble/hashes/blake2.js'

const EXTRACT_ID_COST = 12

export function evalExtractId(e: ExtractId, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(EXTRACT_ID_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractId: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  const boxBytes = serializeBoxBytes(input.value)
  const hash = blake2b(boxBytes, { dkLen: 32 })
  return bytesToCollByteSValue(hash)
}
```

- [ ] **Step 5: Wire into dispatch**

```ts
// eval/eval.ts:
import { evalExtractId } from './extract-id'
    case 'ExtractId':
      return evalExtractId(e, env, ctx)
```

- [ ] **Step 6: Run tests + typecheck**

```bash
npx vitest run packages/ergoscript/test/eval/extract-id.test.ts
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all PASS (including cross-runtime hash agreement under both `node` and `jsdom`).

- [ ] **Step 7: Run corpus eval gate**

```bash
npx vitest run packages/ergoscript/test/corpus-eval.test.ts
```

Expected: `success=0 not-impl=18 other=0` (still — corpus needs method calls).

- [ ] **Step 8: Update `facts/ergoscript.md`**

Final updates capturing all 2f narrow changes:

1. Update the SBox `parseSValue` / `serializeSValue` postcondition descriptions to remove SBox from the `'not-implemented-phase-2a'` set.
2. Modify the "Does NOT ship yet" entry "Box / Context / Header chain-state model" to "Context / Header chain-state model (Box runtime + 7 Box-extract arms ship in 2f-narrow)".
3. Bump coverage line to "27 of ~70 arms after phase 2f narrow; 7 of 7 Box-extract arms shipped".
4. Add a phase 2f narrow "Ships additionally" block (insert after the 2e block):
   - The 7 Box-extract arms (ExtractAmount, ExtractScriptBytes, ExtractRegisterAs, ExtractCreationInfo, ExtractBytes, ExtractBytesWithNoRef, ExtractId)
   - SBox `parseSValue` / `serializeSValue` ship
   - `ErgoBox.registers` reshape carries per-register SType
5. Add to EvalError taxonomy: `'extract-input-not-box'`, `'register-id-out-of-range'`, `'register-type-mismatch'` (3 new codes; total 22).
6. Add to SValueParseError taxonomy: `'sbox-tokens-out-of-range'`, `'sbox-registers-out-of-range'`.
7. Add to SValueSerializeError taxonomy: `'token-id-length'`, `'txid-length'`.

- [ ] **Step 9: Update memory `project_ergots_direction`**

Edit `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`:

```markdown
---
name: project-ergots-direction
description: Current phase + next-up for the ergots monorepo; updated 2026-05-15 (phase 2f narrow shipped)
metadata:
  type: project
---

# Ergots project direction

**Phase 2f narrow shipped** as of 2026-05-15:
- 27 of ~70 Expr arms wired (20 prior + 7 Box-extract).
- SBox wire parse/serialize closes phase 2a's deferred SBox surface.
- 22 EvalError codes total (19 prior + 3 new in 2f narrow).

**Next: phase 2f medium** — GlobalVars (HEIGHT/SelfBox/Outputs/Inputs/MinerPubKey/GroupGenerator) + GetVar + Option family (OptionGet/OptionIsDefined/OptionGetOrElse) + SelectField + chain-state fields on EvalContext (height, selfBox, inputs, outputs, dataInputs, preHeader, headers, extension, vars).

(Other content as in prior version.)
```

- [ ] **Step 10: Update `MEMORY.md` hook text**

Edit `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md` — update the `project-ergots-direction` hook line to reflect phase 2f narrow shipped.

- [ ] **Step 11: Refresh `SESSION_CONTEXT.md`** (gitignored — local-only)

Edit `packages/ergoscript/SESSION_CONTEXT.md` with the fresh phase 2f narrow done snapshot (test counts, public surface, coverage line, files changed, key decisions).

- [ ] **Step 12: Commit the arm + final docs together (atomic finalize)**

```bash
git add packages/ergoscript/src/eval/extract-id.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/extract-id.test.ts \
        packages/ergoscript/test/fixtures/eval/extract-id.json \
        fixture-gen/src/cmds/ergoscript/eval/extract_id.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs \
        facts/ergoscript.md
git commit -m "$(cat <<'EOF'
feat(ergoscript): ExtractId eval arm + finalize phase 2f narrow (Stop γ task 8)

Final 2f narrow arm. Fixed(12) cost BEFORE eval-child. blake2b256 of
canonical box bytes via @noble/hashes. Lazy compute (sigma-rust caches
for performance; no correctness divergence). First eval-time hash in
the package.

Closes phase 2f narrow: 27 of ~70 arms; 7 of 7 Box-extract arms shipped;
SBox wire format closed; 3 new EvalError codes + 2 new SValueParseError
codes + 2 new SValueSerializeError codes total across the slice.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 13: Push to origin/master**

```bash
git push origin master
```

(Orchestrator confirms push before declaring phase 2f narrow done.)

---

## STOP γ

**Phase 2f narrow complete.** All 7 Box-extract arms shipped. SBox wire parsing closed. Box canonical-bytes serializer ported. ErgoBox.registers reshape complete.

**Final state:**
- 27 of ~70 Expr arms (20 prior + 7 in 2f narrow)
- 22 EvalError codes total (3 new this slice)
- 2 new SValueParseError codes
- 2 new SValueSerializeError codes
- Test count: 1609 + ~48 = ~1657 (verify in `SESSION_CONTEXT.md` after Task 8 Step 11)
- C2 corpus still `success=0 not-impl=18 other=0`
- C3 mutation testing still deferred
- No new runtime dependencies

**Next phase: 2f medium** — GlobalVars (6 cases) + GetVar + Option family (3 arms) + SelectField + chain-state fields on EvalContext. Then phase 2g for the sigma protocol (`@noble/curves` dep wave; unblocks deferred Atleast/SigmaAnd/SigmaOr).
