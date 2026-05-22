# Phase 2j-a — Cost-Oracle Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** OVERRIDES rules apply, especially #6 (verification commands must pass before claiming any task done), #5 (root-cause mandate), #7 (re-read files before editing after 10+ messages), #8 (read→edit→read). Per `[[feedback-subagent-explicit-rules]]`.

**Spec:** `docs/specs/2026-05-22-ergoscript-2j-a-cost-oracle-design.md` (v2, reviewer-pass applied; HEAD `47e513f`)

**Goal:** Build a uniform divergence-surfacing channel between sigma-rust's evaluator (oracle) and our TS `ctx.jitCost` accumulator. Enable a TDD-loop pattern where each smoke-walk halt becomes one focused fix-N. **2j-a ships the wiring + one short validation smoke. Iterative fixes are 2j-b+.**

**Architecture (one-paragraph summary):** Shim's `BlockBundle` CBOR stream gains per-input `oracle_cost` (`u64`), `oracle_succeeded` (`bool`), `oracle_error` (`Option<String>`) computed by invoking sigma-rust's public `reduce_to_crypto(tree, ctx)` and reading `ctx.jit_cost_value()` directly. Harness's existing per-input `evaluate(tree, opts)` call captures our `ctx.jitCost`; new comparison halts with structured `error-report.json` at phase `'evaluate-cost'` (cost differs) or `'evaluate-oracle-mismatch'` (eval success/failure disagreement). Halt-on-first-divergence, mirroring fix-1/2/3 pattern.

**Invariants:**
- All four existing harness validation passes (header / output-roundtrip / evaluate / verify-signature) keep their current order and semantics. Cost-equivalence is a sub-step of the evaluate pass.
- No ergoscript-package changes in 2j-a. Existing 3782 tests stay green by construction.
- Shim reads `ctx.jit_cost_value()` directly. NEVER `ReductionResult.cost` (that's `jit_cost / 10`).
- Shim invokes `reduce_to_crypto(tree, ctx)` (public). NEVER `expr.eval(env, ctx)` (`Evaluable::eval` is `pub(crate)`).

---

## Task ordering

```
T1   PLAN.md committed (this document)
T2   Verification gate: source-read ergo-lib for TransactionContext::new
     + ContextExtensionProvider accessibility. Decide (a)/(b)/(c) per spec.
T3   Shim cost_oracle.rs new module + 5 unit tests
T4   Shim protocol.rs CBOR extension + protocol-version bump + 2 tests
T5   Shim block_walker.rs integration of compute_oracle_cost per input
T6   Harness protocol.ts type extension + error-report.ts new phase classes
T7   Harness validate-tx.ts cost-diff logic + bigint→number narrowing +
     5 unit tests
T8   Harness halt-path.test.ts 2 integration tests (mock-shim fault-injection)
T9   Layer-5 validation smoke (--max-height 100) + findings doc
T10  SESSION_CONTEXT + HANDOFF + facts/READMEs sweep + memory + push
```

Total: 10 commits (T1 + T2 doc-or-code + T3-T9 each + T10).

---

## Task 1: Commit PLAN.md

**Files:**
- Create: `PLAN.md` (this file)

- [ ] **Step 1: Stage and commit.**

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): add phase 2j-a cost-oracle wiring execution plan

10-task plan implementing the cost-equivalence channel between sigma-rust
(oracle) and our TS evaluator. Mirrors fix-3 plan structure. Each task
ends with verification + per-OVERRIDES gates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Verify commit landed.**

```bash
git log --oneline -2
```

Expected: top two commits are `docs(plan): add phase 2j-a ...` and `docs: add phase 2j-a cost-oracle wiring design (reviewer pass)`.

---

## Task 2: Verification gate — Context construction path

**Goal:** Decide between three implementation paths from the spec before writing T3 code, so T3 stays focused on the cost-oracle logic.

**Spec branches:**
- (a) Reuse `ergo-lib`'s `TransactionContext::new` if `pub`-accessible from shim.
- (b) Implement minimal local `ContextExtensionProvider` adapter (~20 lines).
- (c) Enable `arbitrary` feature on `ergotree-interpreter` as a reference (still read `jit_cost_value()` directly).

**Files:**
- Read: `external/sigma-rust/ergo-lib/src/wallet/tx_context.rs` (TransactionContext::new visibility)
- Read: `external/sigma-rust/ergotree-ir/src/chain/context.rs:47` (`ContextExtensionProvider` trait def + any existing impls)
- Read: `external/sigma-rust/ergo-lib/src/wallet/signing.rs:114` (reference construction site)
- Possibly modify: `tools/mainnet-validate/shim/Cargo.toml` (only if path (c) chosen — add `arbitrary` feature)

- [ ] **Step 1: Source-read `ergo-lib::wallet::tx_context::TransactionContext`.**

```bash
grep -n "pub struct TransactionContext\|impl TransactionContext\|pub fn new" /home/mwaddip/projects/ergots/external/sigma-rust/ergo-lib/src/wallet/tx_context.rs | head -20
```

Confirm whether `TransactionContext::new` (or equivalent constructor) is `pub` AND whether the resulting `TransactionContext` can produce a `Context<'_>` via a `pub` method.

- [ ] **Step 2: Source-read `ContextExtensionProvider` trait + existing impls.**

```bash
grep -rn "trait ContextExtensionProvider\|impl ContextExtensionProvider" /home/mwaddip/projects/ergots/external/sigma-rust/ 2>&1 | head -20
```

Confirm trait visibility and existing impls (e.g., `ergo-lib`'s `&Transaction`).

- [ ] **Step 3: Decide path (a)/(b)/(c).**

Decision rule:
- If `TransactionContext::new` is `pub` AND can produce a `Context` we can feed `reduce_to_crypto` → path (a). No code changes in T2; T3 uses ergo-lib helpers.
- If `ContextExtensionProvider` trait is `pub` but no existing impl matches `Vec<ContextExtensionEntry>` (the shim's storage shape) → path (b). T2 implements a small adapter.
- If neither holds → path (c). T2 enables `arbitrary` feature; T3 still reads `jit_cost_value()` directly.

- [ ] **Step 4 (path-dependent): If (b), write the adapter.**

For path (b), create `tools/mainnet-validate/shim/src/context_extension_adapter.rs`:

```rust
use ergotree_ir::chain::context::ContextExtensionProvider;
use ergotree_ir::mir::constant::Constant;
use crate::protocol::ContextExtensionEntry;

pub struct VecContextExtensionAdapter<'a> {
    pub entries: &'a [ContextExtensionEntry],
}

impl<'a> ContextExtensionProvider for VecContextExtensionAdapter<'a> {
    fn get(&self, key: i8) -> Option<&Constant> {
        // ContextExtensionEntry currently stores raw bytes; we need to
        // parse to Constant. Look at the existing harness path in
        // harness/src/validate-tx.ts (buildContextExtension at line ~536)
        // to mirror the parse logic. If the adapter needs a parse step,
        // it MUST mirror exactly what the harness does — context-fidelity
        // is load-bearing.
        unimplemented!("parse ContextExtensionEntry.value_bytes into Constant; mirror harness/src/validate-tx.ts:536")
    }
}
```

- [ ] **Step 4 (path-dependent): If (c), enable feature.**

For path (c), edit `tools/mainnet-validate/shim/Cargo.toml`:

```toml
[dependencies]
ergotree-interpreter = { path = "../../../external/sigma-rust/ergotree-interpreter", features = ["arbitrary"] }
```

Then audit:

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo tree --features arbitrary 2>&1 | head -30
```

If the dep tree adds substantial weight (e.g., `proptest` + transitive deps), reconsider path (a) or (b). Document the audit outcome in the commit message.

- [ ] **Step 5: Commit T2 outcome.**

If path (a) (no code change):

```bash
git commit --allow-empty -m "$(cat <<'EOF'
docs(2j-a/T2): verification gate — Context construction via ergo-lib::TransactionContext

Source-read confirms ergo-lib::wallet::tx_context::TransactionContext::new
is pub-accessible from the shim. Path (a) chosen: T3 will reuse the
ergo-lib helpers directly without local adapter or feature flag.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If path (b):

```bash
git add tools/mainnet-validate/shim/src/context_extension_adapter.rs tools/mainnet-validate/shim/src/lib.rs  # if lib.rs needs module declaration
git commit -m "feat(2j-a/T2): add VecContextExtensionAdapter for shim Context construction

Path (b) chosen: ergo-lib's TransactionContext::new path was not
sufficient. Local adapter implements ContextExtensionProvider over the
shim's Vec<ContextExtensionEntry> storage shape, mirroring harness/src/validate-tx.ts:536 parse logic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If path (c):

```bash
git add tools/mainnet-validate/shim/Cargo.toml tools/mainnet-validate/shim/Cargo.lock
git commit -m "build(2j-a/T2): enable arbitrary feature on ergotree-interpreter

Path (c) chosen: TransactionContext::new and ContextExtensionProvider
trait visibility prevent path (a)/(b). cargo tree audit attached in
commit body. Shim will use try_eval_out as a reference for
context-construction shape; reads ctx.jit_cost_value() directly (never
ReductionResult.cost).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Shim cost_oracle.rs — module + unit tests

**Files:**
- Create: `tools/mainnet-validate/shim/src/cost_oracle.rs`
- Modify: `tools/mainnet-validate/shim/src/lib.rs` or wherever modules are declared (add `pub mod cost_oracle;`)
- Test: same file under `#[cfg(test)] mod tests`

- [ ] **Step 1: Read `tools/mainnet-validate/shim/src/protocol.rs` to understand current types** (`BlockBundle`, `TxBundle`, `InputBundle`, `ContextExtensionEntry`).

- [ ] **Step 2: Read `tools/mainnet-validate/harness/src/validate-tx.ts` lines 481-558 to confirm field-by-field context construction.**

```bash
sed -n '481,558p' /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/src/validate-tx.ts
```

This is the canonical reference for what each `EvalOpts` field looks like; the shim's `cost_oracle::build_context` MUST mirror exactly.

- [ ] **Step 3: Write the module skeleton.**

Create `tools/mainnet-validate/shim/src/cost_oracle.rs`:

```rust
//! Cost oracle for phase 2j-a divergence-surfacing channel.
//!
//! Computes sigma-rust's per-input cost via `reduce_to_crypto(tree, ctx)`
//! and reads `ctx.jit_cost_value()` directly. Result rides along on
//! `InputBundle.oracle_cost` for the harness to compare against our TS
//! `ctx.jitCost`.
//!
//! CRITICAL: this module must NEVER use `ReductionResult.cost`
//! (`eval.rs:174` shows that's `jit_cost / 10`). The harness's TS
//! `ctx.jitCost` mirrors the raw JitCost, so we must read jit_cost_value()
//! directly post-eval.
//!
//! Source mapping:
//! - `ergotree-ir/src/chain/context.rs:24-55` (Context struct)
//! - `ergotree-ir/src/chain/context.rs:49`    (pub jit_cost: Cell<u64>)
//! - `ergotree-ir/src/chain/context.rs:102`   (jit_cost_value getter)
//! - `ergotree-interpreter/src/eval.rs:161`   (reduce_to_crypto entry)
//! - Harness reference: `harness/src/validate-tx.ts:481-558`

use crate::protocol::{InputBundle, TxBundle, BlockBundle};
// Imports for sigma-rust types — exact paths depend on T2's path decision.

pub struct CostOracleResult {
    pub cost: u64,
    pub is_ok: bool,
    pub error_msg: Option<String>,
}

pub fn compute_oracle_cost(
    spent_box_bytes: &[u8],
    block: &BlockBundle,
    tx: &TxBundle,
    input_index: usize,
    headers_rolling_window: &[Vec<u8>],
) -> CostOracleResult {
    // Step 1: parse spent_box_bytes -> ErgoBox -> ErgoTree
    // Step 2: build Context with all required fields (see spec §Components)
    //   - height, selfBox, inputs, outputs, dataInputs, preHeader, headers,
    //     extension (via ContextExtensionProvider), tree_version (per-input
    //     derived from spent box's tree header), jit_cost: Cell::new(0),
    //     jit_cost_limit: Some(block.parameters.max_block_cost as u64 * 10 or default),
    //     constants: tree.constants slice when present
    // Step 3: reduce_to_crypto(&tree, &ctx) -> Result<ReductionResult, EvalError>
    // Step 4: read raw cost via ctx.jit_cost_value() — IGNORE result.cost (that's /10)
    // Step 5: return CostOracleResult { cost, is_ok, error_msg }

    todo!("implement per T2's chosen path (a)/(b)/(c)")
}
```

- [ ] **Step 4: Write 5 failing unit tests (Layer 1 RED).**

Append to `cost_oracle.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // Helpers to construct synthetic BlockBundle / TxBundle / InputBundle
    // for testing. The shim's protocol.rs likely already has test helpers;
    // reuse if present.

    #[test]
    fn pattern_a_arm_sanity() {
        // Build a synthetic tree exercising a Pattern A fixed-cost arm
        // (e.g., a tree consisting solely of ExtractAmount on SelfBox —
        // cost 8 per Fixed(8)). Pre-eval cost includes the 50-cost
        // EVAL_SIGMA_PROP_CONSTANT short-circuit charged by
        // reduce_to_crypto if the body wraps in SigmaProp. Verify the
        // exact accumulated jit_cost.
        let expected = 58u64;  // 50 short-circuit + 8 ExtractAmount
                                // (adjust per actual sigma-rust accumulator
                                // — verify by source-reading or running
                                // sigma-rust's own tests for this arm)

        let result = compute_oracle_cost_test_helper(synthetic_tree_extract_amount());
        assert!(result.is_ok);
        assert_eq!(result.cost, expected);
    }

    #[test]
    fn pattern_b_arm_sanity() {
        // Pattern B HOF (e.g., SizeOf on Coll[Int] with 5 items) —
        // cost scales per addPerItemCost(14, ..., 1).
        // Verify the formula matches.
        // (Specific expected cost: compute by source-reading
        // ergotree-interpreter/src/eval/scoll.rs::SizeOf cost-charging.)
        todo!("flesh out after pattern_a_arm_sanity is green and cost extraction confirmed")
    }

    #[test]
    fn mixed_pattern_lambda_hof() {
        // Pattern A outer (Coll HOF envelope) + Pattern B inner (per-iter
        // Fixed(1)). MapColl over Coll[Int] with 3 items, lambda is
        // identity. Verify both Pattern A AND Pattern B charges land.
        todo!("flesh out after pattern_b_arm_sanity")
    }

    #[test]
    fn error_path_partial_cost() {
        // Tree that throws mid-eval (e.g., Atleast with bound > items
        // length). Verify cost reflects partial accumulation up to throw
        // + is_ok: false + error_msg: Some(...).
        let result = compute_oracle_cost_test_helper(synthetic_tree_atleast_bad_bound());
        assert!(!result.is_ok);
        assert!(result.error_msg.is_some());
        assert!(result.cost > 0);  // some cost was charged before the throw
    }

    #[test]
    fn context_fidelity_treeversion() {
        // Tree using a V3-gated arm (e.g., Upcast BigInt path). At
        // tree_version 0, throws 'tree-version-too-low'; at v3, succeeds.
        // Verify cost differs by the V<3 reject path vs V3+ path.
        let result_v0 = compute_oracle_cost_test_helper_at_version(synthetic_tree_v3_upcast(), 0);
        let result_v3 = compute_oracle_cost_test_helper_at_version(synthetic_tree_v3_upcast(), 3);
        assert!(!result_v0.is_ok);
        assert!(result_v3.is_ok);
    }
}
```

- [ ] **Step 5: Add module declaration.**

Edit `tools/mainnet-validate/shim/src/main.rs` (or `lib.rs` if present) to add `mod cost_oracle;` near the other module declarations.

- [ ] **Step 6: Run RED tests to confirm they fail.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo test --release cost_oracle 2>&1 | tail -20
```

Expected: 5 failures with `todo!` panics or compile-errors against the unimplemented `compute_oracle_cost`.

- [ ] **Step 7: Implement `compute_oracle_cost` per T2's chosen path.**

Replace `todo!()` body with concrete code. Skeleton for path (a):

```rust
pub fn compute_oracle_cost(
    spent_box_bytes: &[u8],
    block: &BlockBundle,
    tx: &TxBundle,
    input_index: usize,
    headers_rolling_window: &[Vec<u8>],
) -> CostOracleResult {
    use ergotree_interpreter::eval::reduce_to_crypto;
    use ergo_lib::chain::ergo_box::ErgoBox;
    use sigma_ser::ScorexSerializable;
    use std::cell::Cell;

    // Parse spent box
    let spent_box = match ErgoBox::sigma_parse_bytes(spent_box_bytes) {
        Ok(b) => b,
        Err(e) => return CostOracleResult {
            cost: 0, is_ok: false,
            error_msg: Some(format!("spent_box_parse: {}", e)),
        },
    };

    let tree = spent_box.ergo_tree.clone();
    let tree_version = tree.version();

    // Build Context — exact construction depends on path (a)/(b)/(c).
    // For path (a), use TransactionContext::new and extract its Context.
    // For path (b), construct Context directly with VecContextExtensionAdapter.
    // ... (details depend on T2 outcome)

    // Reset jit_cost (or use a freshly-constructed Context with jit_cost: 0)
    let ctx = /* constructed Context */;

    match reduce_to_crypto(&tree, &ctx) {
        Ok(_reduction_result) => {
            // CRITICAL: do NOT use _reduction_result.cost (that's /10).
            // Read jit_cost_value() directly.
            CostOracleResult {
                cost: ctx.jit_cost_value(),
                is_ok: true,
                error_msg: None,
            }
        }
        Err(e) => CostOracleResult {
            cost: ctx.jit_cost_value(),  // partial cost at throw
            is_ok: false,
            error_msg: Some(format!("{}", e)),
        },
    }
}
```

- [ ] **Step 8: Run tests; iterate until all 5 green.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo test --release cost_oracle 2>&1 | tail -20
```

Expected: 5 passing tests.

If a test value (e.g., expected cost `58u64`) is wrong, source-read sigma-rust's per-arm cost-charging code OR run a quick sigma-rust integration test that emits the cost; align test expectation to oracle reality. Per `[[reference-source-first-discipline]]` — sigma-rust is canonical.

- [ ] **Step 9: Verify per OVERRIDES rule #6.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo build --release 2>&1 | tail -10
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo test --release 2>&1 | tail -5
```

Expected: build clean. Test summary shows 22 (existing) + 5 (new) = 27 passing in shim.

- [ ] **Step 10: Commit.**

```bash
git add tools/mainnet-validate/shim/src/cost_oracle.rs tools/mainnet-validate/shim/src/main.rs
git commit -m "$(cat <<'EOF'
feat(2j-a/T3): add cost_oracle module + 5 unit tests

Implements compute_oracle_cost via sigma-rust's public reduce_to_crypto
entry point; reads ctx.jit_cost_value() directly (NOT
ReductionResult.cost, which is /10). Covers Pattern A, Pattern B, mixed
HOF, error-path partial-cost, and treeVersion-fidelity test cases.

Context construction follows T2's chosen path. All chain-state fields
mirror harness/src/validate-tx.ts:481-558 per the context-fidelity
discipline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Shim protocol.rs CBOR extension + protocol-version bump

**Files:**
- Modify: `tools/mainnet-validate/shim/src/protocol.rs` (extend `InputBundle`; add `PROTOCOL_VERSION` constant)
- Test: same file under `#[cfg(test)] mod tests` (add 2 roundtrip tests)

- [ ] **Step 1: Read current `protocol.rs` to understand serialization pattern.**

```bash
sed -n '1,160p' /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/src/protocol.rs
```

- [ ] **Step 2: Add 2 failing roundtrip tests (Layer 2 RED).**

Append to `protocol.rs` under `#[cfg(test)] mod tests`:

```rust
#[test]
fn input_bundle_with_oracle_cost_roundtrips() {
    let original = InputBundle {
        box_id: [0u8; 32],
        spent_box_bytes: vec![0xde, 0xad],
        signature_bytes: vec![0xbe, 0xef],
        context_extension: vec![],
        oracle_cost: 12345u64,
        oracle_succeeded: true,
        oracle_error: None,
    };

    let encoded = ciborium::ser::into_vec(&original).expect("encode");
    let decoded: InputBundle = ciborium::de::from_reader(&encoded[..]).expect("decode");

    assert_eq!(decoded.oracle_cost, 12345u64);
    assert!(decoded.oracle_succeeded);
    assert!(decoded.oracle_error.is_none());
}

#[test]
fn input_bundle_with_oracle_error_roundtrips() {
    let original = InputBundle {
        box_id: [0u8; 32],
        spent_box_bytes: vec![],
        signature_bytes: vec![],
        context_extension: vec![],
        oracle_cost: 42u64,
        oracle_succeeded: false,
        oracle_error: Some("simulated eval error".to_string()),
    };

    let encoded = ciborium::ser::into_vec(&original).expect("encode");
    let decoded: InputBundle = ciborium::de::from_reader(&encoded[..]).expect("decode");

    assert_eq!(decoded.oracle_cost, 42u64);
    assert!(!decoded.oracle_succeeded);
    assert_eq!(decoded.oracle_error.as_deref(), Some("simulated eval error"));
}
```

- [ ] **Step 3: Run RED tests; confirm failure.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo test --release protocol::tests::input_bundle_with_oracle 2>&1 | tail -10
```

Expected: compile-error or "field does not exist" failures.

- [ ] **Step 4: Extend `InputBundle` + add `PROTOCOL_VERSION`.**

Edit `protocol.rs`:

```rust
/// Shim wire-protocol version. Bumped at 2j-a phase to surface
/// schema-mismatch at startup vs missing-field crashes at first block.
pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InputBundle {
    pub box_id: [u8; 32],
    pub spent_box_bytes: Vec<u8>,
    pub signature_bytes: Vec<u8>,
    pub context_extension: Vec<ContextExtensionEntry>,
    // 2j-a additions:
    pub oracle_cost: u64,
    pub oracle_succeeded: bool,
    pub oracle_error: Option<String>,
}
```

If the shim has a startup handshake that emits a version banner, extend it to emit `PROTOCOL_VERSION`. Otherwise add a startup line:

```rust
// In shim's main.rs startup:
eprintln!("shim: protocol_version={}", protocol::PROTOCOL_VERSION);
```

- [ ] **Step 5: Run tests until green.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo test --release protocol 2>&1 | tail -10
```

Expected: 2 new tests pass.

- [ ] **Step 6: Verify per OVERRIDES rule #6.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo build --release 2>&1 | tail -5
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo test --release 2>&1 | tail -5
```

Expected: build clean; test summary shows 22 + 5 + 2 = 29 passing.

- [ ] **Step 7: Commit.**

```bash
git add tools/mainnet-validate/shim/src/protocol.rs tools/mainnet-validate/shim/src/main.rs
git commit -m "$(cat <<'EOF'
feat(2j-a/T4): extend InputBundle CBOR shape + bump PROTOCOL_VERSION to 2

Adds oracle_cost: u64, oracle_succeeded: bool, oracle_error:
Option<String> to InputBundle. CBOR is wire-additive (struct-as-map) so
old harness builds reading new shim bundles would ignore unknown keys;
what changes is the harness-side schema expectation. PROTOCOL_VERSION
bump surfaces schema-mismatch cleanly at startup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Shim block_walker.rs integration

**Files:**
- Modify: `tools/mainnet-validate/shim/src/block_walker.rs` (call `compute_oracle_cost` per input during `TxBundle` assembly)

- [ ] **Step 1: Read `block_walker.rs` to find where `InputBundle` is constructed.**

```bash
grep -n "InputBundle\s*{" /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/src/block_walker.rs
```

- [ ] **Step 2: Add `compute_oracle_cost` invocation per input.**

At the InputBundle construction site, replace existing literal struct with computed-cost variant:

```rust
let oracle = crate::cost_oracle::compute_oracle_cost(
    &spent_box_bytes,
    /* block: */ &block_bundle_under_construction,  // adjust to whatever local var holds it
    /* tx: */ &current_tx,
    /* input_index: */ idx,
    /* headers_rolling_window: */ &rolling_headers,
);

let input_bundle = InputBundle {
    box_id,
    spent_box_bytes,
    signature_bytes,
    context_extension,
    oracle_cost: oracle.cost,
    oracle_succeeded: oracle.is_ok,
    oracle_error: oracle.error_msg,
};
```

**Critical:** the `block_bundle_under_construction` needs to be partially built (height, header_bytes, parameters present; previous txs accumulating). If the walker builds outputs before inputs cost-eval, fine. If it walks inputs first, refactor minimally to give `compute_oracle_cost` the context it needs — but DO NOT restructure the walker beyond what's necessary.

- [ ] **Step 3: Run existing block_walker tests.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo test --release block_walker 2>&1 | tail -10
```

Expected: existing tests still pass. The `ingest_block_walks_synthetic_genesis_block_end_to_end` test (from fix-2 T7) may need its synthetic input expanded — the test's synthetic genesis ErgoTree must now be `compute_oracle_cost`-evaluable. If it isn't (e.g., bare null bytes), wrap a minimal valid SigmaProp around it.

- [ ] **Step 4: Verify per OVERRIDES rule #6.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo build --release 2>&1 | tail -5
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/shim && cargo test --release 2>&1 | tail -5
```

Expected: all 29 tests passing.

- [ ] **Step 5: Commit.**

```bash
git add tools/mainnet-validate/shim/src/block_walker.rs
git commit -m "$(cat <<'EOF'
feat(2j-a/T5): wire cost_oracle into block_walker per-input bundle assembly

block_walker now calls compute_oracle_cost per InputBundle during
TxBundle construction. Result populates the new oracle_cost /
oracle_succeeded / oracle_error fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Harness protocol.ts + error-report.ts extensions

**Files:**
- Modify: `tools/mainnet-validate/harness/src/protocol.ts` (extend `InputBundle` TS interface; assert protocol-version match)
- Modify: `tools/mainnet-validate/harness/src/error-report.ts` (new phase classes + payload types)
- (No new tests in this task — types only)

- [ ] **Step 1: Read current `protocol.ts`.**

```bash
sed -n '1,80p' /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/src/protocol.ts
```

- [ ] **Step 2: Extend `InputBundle` interface to match new CBOR shape.**

Edit `tools/mainnet-validate/harness/src/protocol.ts`:

```ts
export interface InputBundle {
  boxId: Uint8Array
  spentBoxBytes: Uint8Array
  signatureBytes: Uint8Array
  contextExtension: ContextExtensionEntry[]
  // 2j-a additions:
  oracleCost: bigint      // u64 on the wire; bigint in TS to preserve range
  oracleSucceeded: boolean
  oracleError: string | null
}
```

If `protocol.ts` has a `PROTOCOL_VERSION` constant or version-check, bump to 2 and add error handling for mismatch:

```ts
export const EXPECTED_SHIM_PROTOCOL_VERSION = 2

// In the shim spawn / handshake code:
if (shimVersion !== EXPECTED_SHIM_PROTOCOL_VERSION) {
  throw new Error(
    `Shim protocol version mismatch: expected ${EXPECTED_SHIM_PROTOCOL_VERSION}, got ${shimVersion}. ` +
    `Rebuild the shim or delete --sidecar-path / --checkpoint-path and re-walk from h=1.`,
  )
}
```

If there's no existing version-check infrastructure, just add the constant; the actual handshake hook can land in T8's halt-path test setup.

- [ ] **Step 3: Read current `error-report.ts`.**

```bash
sed -n '1,120p' /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/src/error-report.ts
```

- [ ] **Step 4: Add new phase classes + payload types.**

Edit `error-report.ts`:

```ts
export type Phase =
  | 'header'
  | 'output-roundtrip'
  | 'evaluate'
  | 'verify-signature'
  | 'shim'
  | 'evaluate-cost'              // 2j-a
  | 'evaluate-oracle-mismatch'   // 2j-a

export interface EvaluateCostPayload {
  expected: number    // oracle cost (narrowed from bigint; cost-overflow throws if > MAX_SAFE_INTEGER)
  actual: number      // our ctx.jitCost
  delta: number       // expected - actual
}

export interface EvaluateOracleMismatchPayload {
  code: 'ours-succeeded-oracle-errored' | 'ours-errored-oracle-succeeded'
  oracleError: string | null
  ourError: string | null
  ourEvaluateCost: number | null   // partial cost at our throw, if applicable
}

// Extend the union for the report's "data" / "payload" field, depending
// on the existing shape. Mirror the existing pattern (likely a tagged
// union or a Record<Phase, PayloadShape>).
```

- [ ] **Step 5: Verify TypeScript compiles cleanly.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 6: Verify existing tests still pass.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npm test 2>&1 | tail -10
```

Expected: 74 passing (no new tests added in this task).

- [ ] **Step 7: Commit.**

```bash
git add tools/mainnet-validate/harness/src/protocol.ts tools/mainnet-validate/harness/src/error-report.ts
git commit -m "$(cat <<'EOF'
feat(2j-a/T6): extend harness protocol + error-report for cost-equivalence

Adds InputBundle.oracleCost (bigint), oracleSucceeded (boolean),
oracleError (string | null) to mirror the shim's CBOR extension.
EXPECTED_SHIM_PROTOCOL_VERSION constant bumped to 2 with clear startup
mismatch message.

error-report adds 'evaluate-cost' and 'evaluate-oracle-mismatch' phase
classes with structured payload types.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Harness validate-tx.ts cost-diff logic + unit tests

**Files:**
- Modify: `tools/mainnet-validate/harness/src/validate-tx.ts` (wrap evaluate() in try; add tri-modal diff)
- Test: `tools/mainnet-validate/harness/test/validate-tx.test.ts` (5 new unit tests)

- [ ] **Step 1: Read `validate-tx.ts:481-558` to see current evaluate-pass.**

```bash
sed -n '481,558p' /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/src/validate-tx.ts
```

- [ ] **Step 2: Write 5 failing unit tests (Layer 3 RED).**

Create or extend `tools/mainnet-validate/harness/test/validate-tx.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateTx } from '../src/validate-tx'
import { HarnessError } from '../src/errors'
// Helpers for constructing synthetic InputBundle / opts / etc.

describe('validate-tx cost-equivalence (phase 2j-a)', () => {
  it('cost matches → returns normally', async () => {
    const opts = makeBaseOpts()
    const inputBundle = makeInputBundle({
      oracleCost: 50n,           // bigint
      oracleSucceeded: true,
      oracleError: null,
    })
    // Build a tree whose our-eval also produces cost 50 (e.g., bare P2PK)
    const tree = parseTree(p2pkBytesFor(testPubkey()))

    await expect(validateTx(tree, inputBundle, opts)).resolves.toBeDefined()
  })

  it('cost mismatch → throws HarnessError("cost-drift")', async () => {
    const opts = makeBaseOpts()
    const inputBundle = makeInputBundle({
      oracleCost: 999n,          // mismatched against ours-50
      oracleSucceeded: true,
      oracleError: null,
    })
    const tree = parseTree(p2pkBytesFor(testPubkey()))

    await expect(validateTx(tree, inputBundle, opts)).rejects.toMatchObject({
      code: 'cost-drift',
      payload: { expected: 999, actual: 50, delta: 949 },
    })
  })

  it('ours succeeds, oracle errors → throws oracle-mismatch / ours-succeeded-oracle-errored', async () => {
    const opts = makeBaseOpts()
    const inputBundle = makeInputBundle({
      oracleCost: 0n,
      oracleSucceeded: false,
      oracleError: 'simulated oracle error',
    })
    const tree = parseTree(p2pkBytesFor(testPubkey()))

    await expect(validateTx(tree, inputBundle, opts)).rejects.toMatchObject({
      code: 'oracle-mismatch',
      payload: { code: 'ours-succeeded-oracle-errored', oracleError: 'simulated oracle error' },
    })
  })

  it('ours errors, oracle succeeds → throws oracle-mismatch / ours-errored-oracle-succeeded', async () => {
    const opts = makeBaseOpts()
    const inputBundle = makeInputBundle({
      oracleCost: 100n,
      oracleSucceeded: true,
      oracleError: null,
    })
    // Tree that throws on eval (e.g., a tree exercising a not-implemented arm)
    const tree = treeThatOurEvalThrowsOn()

    await expect(validateTx(tree, inputBundle, opts)).rejects.toMatchObject({
      code: 'oracle-mismatch',
      payload: { code: 'ours-errored-oracle-succeeded', oracleCost: 100 },
    })
  })

  it('cost-overflow guard → throws when oracleCost > MAX_SAFE_INTEGER', async () => {
    const opts = makeBaseOpts()
    const inputBundle = makeInputBundle({
      oracleCost: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      oracleSucceeded: true,
      oracleError: null,
    })
    const tree = parseTree(p2pkBytesFor(testPubkey()))

    await expect(validateTx(tree, inputBundle, opts)).rejects.toMatchObject({
      code: 'cost-overflow',
    })
  })
})
```

- [ ] **Step 3: Run RED tests to confirm failures.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npx vitest run test/validate-tx.test.ts 2>&1 | tail -15
```

Expected: 5 failures (likely "function does not return X" or "no such throw" assertions).

- [ ] **Step 4: Implement cost-diff logic in `validate-tx.ts`.**

In `validate-tx.ts` at the evaluate-pass loop (~line 548), wrap with try/catch + diff. Final shape per spec:

```ts
// oracleCost arrives as bigint; narrow to number with overflow guard.
const oracleCostBig = inputBundle.oracleCost
if (oracleCostBig > BigInt(Number.MAX_SAFE_INTEGER)) {
  throw new HarnessError('cost-overflow', {
    oracleCost: oracleCostBig.toString(),
    txId: bytesToHex(tx.txId),
    inputIndex: idx,
    ergoTreeHex: bytesToHex(ergoTreeBytes),
  })
}
const oracleCost = Number(oracleCostBig)

let result
try {
  result = evaluate(tree, opts)
} catch (ourErr) {
  if (inputBundle.oracleSucceeded) {
    throw new HarnessError('oracle-mismatch', {
      code: 'ours-errored-oracle-succeeded',
      ourError: (ourErr as Error).message,
      oracleError: null,
      ourEvaluateCost: null,
      txId: bytesToHex(tx.txId),
      inputIndex: idx,
      ergoTreeHex: bytesToHex(ergoTreeBytes),
    })
  }
  throw ourErr   // both errored → existing 'evaluate' phase handler
}

// our eval succeeded
if (!inputBundle.oracleSucceeded) {
  throw new HarnessError('oracle-mismatch', {
    code: 'ours-succeeded-oracle-errored',
    ourError: null,
    oracleError: inputBundle.oracleError,
    ourEvaluateCost: result.ctx.jitCost,
    txId: bytesToHex(tx.txId),
    inputIndex: idx,
    ergoTreeHex: bytesToHex(ergoTreeBytes),
  })
}

if (result.ctx.jitCost !== oracleCost) {
  throw new HarnessError('cost-drift', {
    expected: oracleCost,
    actual: result.ctx.jitCost,
    delta: oracleCost - result.ctx.jitCost,
    txId: bytesToHex(tx.txId),
    inputIndex: idx,
    ergoTreeHex: bytesToHex(ergoTreeBytes),
  })
}

// continue to verify-signature pass (existing code)
```

If `HarnessError` doesn't yet take a structured payload, extend `errors.ts` minimally:

```ts
export class HarnessError extends Error {
  constructor(
    public readonly code: string,
    public readonly payload: Record<string, unknown>,
  ) {
    super(`HarnessError(${code})`)
  }
}
```

- [ ] **Step 5: Run tests; iterate until all 5 green.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npx vitest run test/validate-tx.test.ts 2>&1 | tail -10
```

Expected: 5 new tests passing.

- [ ] **Step 6: Verify per OVERRIDES rule #6.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npx tsc --noEmit 2>&1 | tail -5
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npm test 2>&1 | tail -5
```

Expected: tsc clean. Test summary shows 74 + 5 = 79 passing.

- [ ] **Step 7: Commit.**

```bash
git add tools/mainnet-validate/harness/src/validate-tx.ts tools/mainnet-validate/harness/src/errors.ts tools/mainnet-validate/harness/test/validate-tx.test.ts
git commit -m "$(cat <<'EOF'
feat(2j-a/T7): wire cost-diff into validate-tx evaluate pass + 5 unit tests

Adds tri-modal comparison between our ctx.jitCost and oracle's
inputBundle.oracleCost after each per-input evaluate() call. Halts
on first divergence: 'cost-drift' (cost differs), 'oracle-mismatch'
('ours-succeeded-oracle-errored' or 'ours-errored-oracle-succeeded'),
'cost-overflow' (oracleCost > MAX_SAFE_INTEGER).

bigint→number narrowing happens with explicit guard so cost comparisons
work in JS number domain without precision loss within mainnet's
practical bounds.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Harness halt-path integration tests (mock-shim fault-injection)

**Files:**
- Modify or create: `tools/mainnet-validate/harness/test/halt-path.test.ts` (add 2 new `it()` cases)
- Possibly modify: `tools/mainnet-validate/harness/test/_helpers/mock-shim.ts` (or wherever the existing halt-path tests get their fake bundles)

- [ ] **Step 1: Read existing halt-path.test.ts to understand fault-injection idiom.**

```bash
sed -n '1,120p' /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/test/halt-path.test.ts
```

Identify how the existing tests (e.g., fix-2 T9 / fix-3 T6) inject faults — typically by spawning a mock shim that emits specific bundles, OR by directly invoking the validation loop with pre-built BlockBundles.

- [ ] **Step 2: Add 2 new failing integration tests (Layer 4 RED).**

```ts
describe('halt-path integration — cost-equivalence (phase 2j-a)', () => {
  it('halts with structured error-report.json on cost-drift', async () => {
    // Mock shim emits a BlockBundle where oracleCost mismatches our
    // expected eval cost. Run the harness loop until halt; assert
    // error-report.json exists, parses cleanly, and has phase
    // 'evaluate-cost' with the expected payload shape.
    const errorReportPath = makeTempPath()
    const mockShim = mockShimEmittingMismatch({
      height: 1,
      injectedOracleCost: 999n,
      // (our eval on this synthetic tree will return cost 50, mismatch)
    })

    await expect(
      runHarness({
        shim: mockShim,
        errorReportPath,
        maxHeight: 5,
      }),
    ).rejects.toThrow(/cost-drift|HarnessError/i)

    const report = JSON.parse(await fs.readFile(errorReportPath, 'utf-8'))
    expect(report.phase).toBe('evaluate-cost')
    expect(report.errorCode).toBe('cost-drift')
    expect(report.evaluateCost.expected).toBe(999)
    expect(report.evaluateCost.actual).toBe(50)
    expect(report.evaluateCost.delta).toBe(949)
    expect(report.location.txId).toMatch(/^[0-9a-f]{64}$/)
    expect(report.location.inputIndex).toBeTypeOf('number')
    expect(report.location.ergoTreeHex).toMatch(/^[0-9a-f]+$/)
    expect(report.bundleExcerpt.headerHex).toMatch(/^[0-9a-f]+$/)
  })

  it('halts with structured error-report.json on oracle-mismatch (ours-succeeded-oracle-errored)', async () => {
    const errorReportPath = makeTempPath()
    const mockShim = mockShimEmittingMismatch({
      height: 1,
      injectedOracleSucceeded: false,
      injectedOracleError: 'simulated oracle eval error',
    })

    await expect(
      runHarness({
        shim: mockShim,
        errorReportPath,
        maxHeight: 5,
      }),
    ).rejects.toThrow(/oracle-mismatch|HarnessError/i)

    const report = JSON.parse(await fs.readFile(errorReportPath, 'utf-8'))
    expect(report.phase).toBe('evaluate-oracle-mismatch')
    expect(report.errorCode).toBe('ours-succeeded-oracle-errored')
    expect(report.oracleError).toBe('simulated oracle eval error')
  })
})
```

If `mockShimEmittingMismatch` doesn't already exist, create it as a small helper in `tools/mainnet-validate/harness/test/_helpers/mock-shim.ts`:

```ts
import { ShimClient } from '../../src/protocol'

/** Returns a mock ShimClient that emits one BlockBundle per call,
 *  injecting the specified oracle-cost / oracle-succeeded / oracle-error
 *  values into every input. */
export function mockShimEmittingMismatch(opts: {
  height: number
  injectedOracleCost?: bigint
  injectedOracleSucceeded?: boolean
  injectedOracleError?: string | null
}): ShimClient {
  // Build a minimal valid BlockBundle (header bytes, single tx, single
  // input, valid spent box bytes for a bare P2PK tree).
  // Then override the oracle_* fields per opts.
  // ...
  return /* a ShimClient stub */
}
```

- [ ] **Step 3: Run RED tests to confirm failures.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npx vitest run test/halt-path.test.ts 2>&1 | tail -10
```

Expected: 2 failures (mock-shim doesn't exist yet, OR error-report.json fields don't match).

- [ ] **Step 4: Implement mock-shim helper and ensure validation loop writes error-report.json with new fields.**

The validation loop in `harness/src/main.ts` (or wherever) likely already has an error-report-writing step that fires on any HarnessError thrown from validateBlock. T7's code change made validate-tx throw the new HarnessError codes; T8's job is to confirm the writer captures payload correctly.

If the writer's switch on `phase` doesn't yet handle `'evaluate-cost'` / `'evaluate-oracle-mismatch'`, extend it now.

- [ ] **Step 5: Run tests; iterate until all 2 green.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npx vitest run test/halt-path.test.ts 2>&1 | tail -10
```

Expected: 2 new tests passing.

- [ ] **Step 6: Verify per OVERRIDES rule #6.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npx tsc --noEmit 2>&1 | tail -5
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npm test 2>&1 | tail -5
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npm run build 2>&1 | tail -5
```

Expected: tsc clean, 74 + 5 + 2 = 81 passing, build clean.

- [ ] **Step 7: Commit.**

```bash
git add tools/mainnet-validate/harness/test/halt-path.test.ts tools/mainnet-validate/harness/test/_helpers/mock-shim.ts tools/mainnet-validate/harness/src/error-report.ts
git commit -m "$(cat <<'EOF'
test(2j-a/T8): halt-path integration tests for cost-drift + oracle-mismatch

Mock-shim fault-injection emits BlockBundles with deliberately-mismatched
oracle_cost / oracle_succeeded values. Asserts the harness writes
well-formed error-report.json at phase 'evaluate-cost' or
'evaluate-oracle-mismatch' with full payload shape (location,
evaluateCost or oracleError, headerHex).

Real-shim env-var fault-injection deferred to future-work; mock-shim
covers 2j-a's done criterion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Layer-5 validation smoke + findings doc

**Files:**
- Create: `tools/mainnet-validate/findings/2026-MM-DD-2j-a-validation-smoke.md` (replace MM-DD with actual date when running)

- [ ] **Step 1: Build the harness dist (refresh after T6-T8).**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npm run build 2>&1 | tail -5
```

- [ ] **Step 2: Delete any stale sidecar/checkpoint from prior smoke walks.**

```bash
rm -f /tmp/t-2j-a-sidecar.redb /tmp/t-2j-a-checkpoint.json /tmp/t-2j-a-error-report.json
```

- [ ] **Step 3: Run validation smoke at `--max-height 100`.**

```bash
timeout 600 node /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/dist/main.js \
  --network mainnet \
  --store-path /tmp/ergots-2j-pre-smoke-data/modifiers.redb \
  --sidecar-path /tmp/t-2j-a-sidecar.redb \
  --checkpoint-path /tmp/t-2j-a-checkpoint.json \
  --error-report-path /tmp/t-2j-a-error-report.json \
  --start-height 1 --max-height 100 --sleep-ms 0 2>&1 | tail -30
```

- [ ] **Step 4: Interpret outcome.**

Three possible outcomes:

  (a) **Clean walk to h=100** — checkpoint has `lastValidatedHeight: 100, tipReachedAt: <timestamp>`; no error-report.json (deleted on tip-reach). Bump `--max-height` to 1000; if clean, to 10000. If still clean, ship 2j-a with "wiring validated through h=N" finding and 2j-b starts from N+1.

  (b) **Halt with structured error-report.json** at `'evaluate-cost'` or `'evaluate-oracle-mismatch'` — the first surfaced RED. Document the site in the findings doc; that data feeds the 2j-b spec.

  (c) **Halt with non-structured error** (panic, crash, missing fields) — wiring bug. Diagnose and fix; do NOT ship 2j-a until smoke completes one of (a) or (b).

- [ ] **Step 5: Write findings doc.**

Create `tools/mainnet-validate/findings/2026-MM-DD-2j-a-validation-smoke.md` (substitute MM-DD with actual date):

```markdown
# 2j-a Layer-5 validation smoke findings (YYYY-MM-DD)

## Spec success criterion

Wiring validated end-to-end on real mainnet data; either clean walk OR
structured halt with well-formed error-report.json at one of the new
phase classes. Both outcomes ship 2j-a; failing outcome is non-structured
crash, which blocks ship.

## Result

[ONE OF: "clean walk to h=N" / "halt at h=N phase X errorCode Y" /
"non-structured crash (BLOCKING)"]

```
[paste smoke stdout tail]
```

## Stats

| metric | value |
|---|---|
| start | 1 |
| max | [N] |
| validated to | [N or halt-height] |
| blocks | [count] |
| txs | [count] |
| inputs | [count] |
| evaluate+verifySignature passes | [count] |
| elapsed | [seconds] |

## Implication for 2j-b

[If clean: "next smoke starts at h=N+1; 2j-b initial scope is whatever
RED surfaces at deeper heights."]

[If halt: "surfaced site documented above; 2j-b RED is the per-arm
fixture test against this (tx, input, ergoTree). Source-read the
relevant arm in sigma-rust before writing GREEN."]

## Artifacts

- `/tmp/t-2j-a-sidecar.redb` — sidecar with h=1..[N] walked
- `/tmp/t-2j-a-checkpoint.json` — lastValidatedHeight=[N], tipReachedAt=[ts or null]
- `/tmp/t-2j-a-error-report.json` — [present if halt; absent if clean]

All gitignored by location (under `/tmp/`).
```

- [ ] **Step 6: Commit findings.**

```bash
git add tools/mainnet-validate/findings/2026-MM-DD-2j-a-validation-smoke.md
git commit -m "$(cat <<'EOF'
docs(2j-a/T9): Layer-5 validation smoke findings

[Briefly describe outcome: clean walk depth OR surfaced site.]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Docs sweep + memory + push

**Files:**
- Modify: `SESSION_CONTEXT.md` (gitignored; refresh with 2j-a closure)
- Modify: `HANDOFF_PROMPT.md` (gitignored; strike 2j-a from pending phases; set next as 2j-b)
- Modify: `tools/mainnet-validate/README.md` (add `'evaluate-cost'` and `'evaluate-oracle-mismatch'` phase classes to the table at line ~131)
- Modify: `facts/ergoscript.md` (if coverage caveats mention cost calibration deferred — add note that 2j-a wiring landed; per-arm calibration ongoing in 2j-b)
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` (refresh for 2j-a closure)
- Push: `origin/master`

- [ ] **Step 1: Refresh SESSION_CONTEXT.md.**

Overwrite with current state:

```markdown
# SESSION_CONTEXT.md — ergots

**Last updated:** [YYYY-MM-DD] (phase 2j-a cost-oracle wiring)
**Current state:** Phase 2j-a COMPLETE. 10 commits landed since `ca50e24` (end of fix-3). HEAD at `<new-HEAD>`. Push pending T10.

...
[Mirror the fix-3 SESSION_CONTEXT structure: phase summary, key results
table, items closed, commits list, verification commands, open
decisions, source-read findings if any, repo state at handoff, process
notes.]
```

- [ ] **Step 2: Refresh HANDOFF_PROMPT.md.**

Mirror the fix-3 HANDOFF_PROMPT pattern: opening sentence reflecting 2j-a closure, state summary, phase plan status (✅ 2j-a, ⏳ 2j-b next), carry-forward list, "Before you do anything, read these files in order" sequence, repo state.

- [ ] **Step 3: Update `tools/mainnet-validate/README.md` "Phase classes" table.**

Find the table at line ~131:

```bash
sed -n '125,140p' /home/mwaddip/projects/ergots/tools/mainnet-validate/README.md
```

Add two new rows:

```markdown
| `evaluate-cost` | `validate-tx.ts` cost-diff sub-step | `cost-drift`, `cost-overflow` |
| `evaluate-oracle-mismatch` | `validate-tx.ts` cost-diff sub-step | `ours-succeeded-oracle-errored`, `ours-errored-oracle-succeeded` |
```

Also extend the "Triage flow" numbered list to mention these new phases.

- [ ] **Step 4: Update memory `project_ergots_direction.md`.**

Refresh with: "Phase 2j-a (cost-oracle wiring) COMPLETE. ... [test counts] ... [N commits since ca50e24] ... Next: 2j-b first focused fix from T9 findings." Update the MEMORY.md index entry's hook line.

- [ ] **Step 5: Verify all gates one final time.**

```bash
cd /home/mwaddip/projects/ergots && \
  git status && \
  cd tools/mainnet-validate/shim && cargo test --release 2>&1 | tail -3 && \
  cd ../../tools/mainnet-validate/harness && npm test 2>&1 | tail -3 && \
  cd ../../ && git log --oneline ca50e24..HEAD
```

Expected: status clean modulo `audit20260519/`; shim 29 passing; harness 81 passing; ~10 commits ahead of ca50e24.

- [ ] **Step 6: Push.**

```bash
git push origin master
```

Per OVERRIDES: never `--force`, never `--no-verify`.

- [ ] **Step 7: Commit the docs sweep itself.**

Wait — the docs sweep (Steps 1-4) committed BEFORE the push in Step 6. Let me reorder:

Actually the cleanest path is:
  - Step 1-4: edit doc files
  - Step 4.5: commit doc sweep
  - Step 5: verify
  - Step 6: push

So the commit happens in 4.5 (re-numbered):

```bash
git add SESSION_CONTEXT.md HANDOFF_PROMPT.md tools/mainnet-validate/README.md facts/ergoscript.md
git commit -m "$(cat <<'EOF'
docs(2j-a/T10): refresh SESSION_CONTEXT + HANDOFF + facts + README

Closes phase 2j-a. Sweep covers:
- README.md phase-class table (new evaluate-cost / evaluate-oracle-mismatch)
- facts/ergoscript.md cost-calibration status note
- SESSION_CONTEXT / HANDOFF refresh for 2j-b kickoff

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Then push.

---

## Done criterion

- All 10 tasks committed (T1 + T2 + T3 + T4 + T5 + T6 + T7 + T8 + T9 + T10).
- `git status` clean modulo `audit20260519/`.
- `origin/master` aligned (pushed).
- `cargo build --release` clean in `tools/mainnet-validate/shim/`.
- `cargo test --release` clean in `tools/mainnet-validate/shim/` (29 passing).
- `npm test` clean in `tools/mainnet-validate/harness/` (81 passing).
- `npm run build` clean in `tools/mainnet-validate/harness/`.
- Existing ergots-package tests stay green (3782 unchanged).
- T9 smoke completed with one of:
  - Clean walk to `--max-height N` (any N ≥ 100), OR
  - Halt with well-formed `error-report.json` at phase `'evaluate-cost'` or `'evaluate-oracle-mismatch'`.
- T9 findings doc landed.

**Explicitly NOT in 2j-a done criterion:**

- Surfacing any specific predicted RED.
- Fixing any cost-drift or oracle-mismatch (that's 2j-b+).
- Writing fixture-driven RED tests in `packages/ergoscript/test/eval/` for any surfaced drift (also 2j-b+).
- Lesson-learned sweeps (also 2j-b+).
- CI gate on cost-equivalence.
- 2j-a-stats parallel mini-spec (separate work).
