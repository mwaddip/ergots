# Phase 2j-a — Cost-equivalence oracle wiring in the mainnet-validate harness

**Status:** Draft v1 (2026-05-22).
**Author:** Claude Opus 4.7 (1M context) under user direction.
**Phase scope:** Build a uniform divergence-surfacing channel between sigma-rust's evaluator (oracle) and our TS `ctx.jitCost` accumulator. Enable the TDD-loop pattern where each surfaced divergence becomes one focused fix.

**Preceding phase:** 2j-pre fix-3 (Or/Xor/Atleast exprTpe arms; 6 commits on origin/master; HEAD `ca50e24`).
**Umbrella spec:** [`2026-05-13-ergoscript-interpreter-design.md`](2026-05-13-ergoscript-interpreter-design.md) phase 2j (cost accounting / v1.0.0 release gate).

---

## Goal

Build a **uniform divergence-surfacing channel** between sigma-rust's evaluator (acting as oracle) and our TS evaluator. Each smoke-walk halt — whether cost-drift, our-eval-throws-while-oracle-succeeds, or oracle-throws-while-our-eval-succeeds — surfaces one correctness gap in our evaluator surface (cost-charging OR arm coverage OR cross-side semantic divergence). Each gap becomes one focused fix-N spec downstream: RED = per-arm fixture test capturing the surfaced (input, oracle expectation), GREEN = sigma-rust-source-verified TS patch, findings entry under `tools/mainnet-validate/findings/` documenting the surfaced site.

The accumulating `findings/` folder becomes the **empirical inventory** of what mainnet actually exercises in our evaluator surface — chain-driven prioritization, not enumeration-from-source-code.

## Non-goals

- **NOT the TDD-loop runner.** This spec ships the wiring + one short validation smoke (`--max-height 100`) confirming the machinery works end-to-end on real data. The iterative "walk → halt → fix → re-walk" loop is 2j-b, 2j-c, ... and is OUT OF 2j-a's scope.
- **NOT a CI gate.** Cost-equivalence CI on a deep-chain corpus comes after several fix-N iterations have driven the smoke to clean walks of meaningful depth.
- **NOT new ergots-package exports.** All changes live in `tools/mainnet-validate/shim/` and `tools/mainnet-validate/harness/`. The ergoscript package surface is unchanged. (The 2j-a-stats parallel mini-spec — chain stats piggyback — would add one opt-in `EvalOpts.evalArmCounts` field; that's a separate spec.)
- **NOT changes to the four existing harness validation passes** (header / output-roundtrip / evaluate / verify-signature). The cost-equivalence check is an additive sub-step at the end of the existing evaluate pass.
- **NOT enumeration of expected drifts.** No upfront list of "we predict these 14 exprTpe arms surface in this order." The smoke determines order organically.

## Motivation

Three converging reasons:

1. **Per-arm cost tests are insufficient for v1.0.0 cost-equivalence.** The unit-level cost tests in `packages/ergoscript/test/eval/*.test.ts` enforce per-arm cost-integer equality against `try_eval_out` on synthetic inputs. They do NOT exercise arm interactions on real-mainnet workloads — where cost-charging order, treeVersion gating, nested method-call dispatchers, and Pattern-A/B mixes can interact. The umbrella spec calls this "Layer C3 real-context calibration" and gates v1.0.0 on it.

2. **The harness already walks every block, tx, input.** It already constructs `EvalOpts` per-input identically to what `try_eval_out` would consume on the Rust side. Adding a cost-oracle comparison is a small additive layer on top of existing machinery — not a new validation pipeline.

3. **The TDD-loop framing makes the scope finite.** Each surfaced divergence is one fix-N. Each fix-N is one RED + GREEN + findings entry. No upfront enumeration; no scope creep into v1.0.0's other gate items (method-handler completeness, AVL+ semantics, etc.).

## Architecture

### One-paragraph summary

The shim's existing per-block `BlockBundle` CBOR stream gains a new `oracle_cost: u64` field on each `InputBundle`, computed by invoking sigma-rust's public `reduce_to_crypto(tree, ctx)` entry point on the spent box's ErgoTree and reading back `ctx.jit_cost_value()` directly. (Do NOT use `ReductionResult.cost` — that's `jit_cost / 10` and would yield off-by-10 mismatches on every input.) The harness's existing per-input `evaluate(tree, opts)` call captures our `ctx.jitCost`; a new step compares both integers; mismatch halts with a structured `error-report.json` at a new phase class `'evaluate-cost'`. Cross-side eval-success disagreements (our succeeds + oracle errors, or vice versa) surface as `'evaluate-oracle-mismatch'`. Same halt-on-first-divergence pattern as fix-1/2/3.

### Components

**Shim side (`tools/mainnet-validate/shim/`, Rust):**

- **New `src/cost_oracle.rs`** — single function `compute_oracle_cost(spent_box_bytes, tx_ctx) -> CostOracleResult`. Constructs a sigma-rust `Context<'_>` from `BlockBundle` chain-state, parses the spent box's ErgoTree, invokes the public `reduce_to_crypto(tree, ctx)` entry point (at `ergotree-interpreter/src/eval.rs:161`; same path used by `ergo-lib/src/wallet/signing.rs:114`), reads back `ctx.jit_cost_value()` directly. Result is `{ cost: u64, is_ok: bool, error_msg: Option<String> }`. **Critical:** do NOT use `ReductionResult.cost` — that value is `jit_cost / 10` (block cost, not JitCost). Required `Context` fields (per `ergotree-ir/src/chain/context.rs:24-55`): `height`, `selfBox`, `inputs`, `outputs`, `dataInputs`, `preHeader`, `headers`, `extension` (via `ContextExtensionProvider`), `tree_version: Cell<ErgoTreeVersion>` (per-input, derived from spent box's tree header), `jit_cost: Cell<u64>` (zero-init), `jit_cost_limit: Option<u64>` (mirror harness `jitCostLimit`), `constants: Option<&[Constant]>` (REQUIRED if the tree uses `ConstPlaceholder` — the common path; pass the segregated-constants array from the parsed tree).
- **Extend `src/protocol.rs`** — append `oracle_cost: u64`, `oracle_succeeded: bool`, `oracle_error: Option<String>` to `InputBundle`. **CBOR is wire-additive** (serde_cbor / ciborium emits structs as maps with named keys per `shim/src/protocol.rs:67-68` comment), so the wire format itself doesn't break. What changes is the harness-side schema expectation: new harness builds require the new fields to be present. Bump shim protocol-version constant (`PROTOCOL_VERSION: u32 = 2`; current is implicit v1) for a clean version-mismatch detection at startup rather than a missing-field crash at first block.
- **Extend `src/block_walker.rs`** — invoke `cost_oracle::compute_oracle_cost` per input during `TxBundle` assembly.
- **`Cargo.toml`** — verify whether `ergo-lib`'s `Context` construction helpers (e.g., `TransactionContext::new` at `ergo-lib/src/wallet/tx_context.rs`) are `pub`-accessible from the shim. If yes, no feature flags needed. If no (or if direct `Context::new` requires a non-public `ContextExtensionProvider` impl), either: (a) implement a minimal local `ContextExtensionProvider` adapter for `Vec<ContextExtensionEntry>`; (b) enable the `arbitrary` feature on `ergotree-interpreter` to access `test_util::try_eval_out` AS A REFERENCE for context-construction shape (we still read `ctx.jit_cost_value()` directly, not `ReductionResult.cost`). **T2's verification gate decides between (a) and (b).**

**Harness side (`tools/mainnet-validate/harness/`, TS):**

- **Extend `src/protocol.ts`** — mirror CBOR shape: add `oracleCost: bigint`, `oracleSucceeded: boolean`, `oracleError: string | null` to the `InputBundle` TS interface. Bump expected protocol-version in the shim-spawn handshake.
- **Extend `src/validate-tx.ts`** — wrap the existing `evaluate(tree, opts)` call at line ~548 in a try-block (whether or not one exists today; T7 verifies during implementation), and add a tri-modal comparison:

  ```ts
  // oracleCost arrives as bigint from CBOR (u64 source); our jitCost is `number`.
  // Convert oracle to number for comparison; throw 'cost-overflow' on the
  // unlikely case that oracleCost > Number.MAX_SAFE_INTEGER (2^53 - 1).
  // Mainnet costs are far below this; the guard is defensive.
  const oracleCostBig = inputBundle.oracleCost              // bigint
  if (oracleCostBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError('cost-overflow', { oracleCost: oracleCostBig, ... })
  }
  const oracleCost = Number(oracleCostBig)                  // number, safe-narrowed

  let result, oursOk
  try {
    result = evaluate(tree, opts)
    oursOk = true
  } catch (ourErr) {
    if (inputBundle.oracleSucceeded) {
      throw new HarnessError('oracle-mismatch',
        { code: 'ours-errored-oracle-succeeded',
          ourError: ourErr.message, oracleCost, ... })
    }
    throw ourErr   // both errored → existing 'evaluate' phase handler fires
  }

  // ours OK ⇒ reach here
  if (!inputBundle.oracleSucceeded) {
    throw new HarnessError('oracle-mismatch',
      { code: 'ours-succeeded-oracle-errored',
        oracleError: inputBundle.oracleError, ourCost: result.ctx.jitCost, ... })
  }
  if (result.ctx.jitCost !== oracleCost) {
    throw new HarnessError('cost-drift',
      { expected: oracleCost, actual: result.ctx.jitCost,
        delta: oracleCost - result.ctx.jitCost, ... })
  }
  // both OK, costs match ⇒ continue
  ```

- **Extend `src/error-report.ts`** — new phase classes `'evaluate-cost'` and `'evaluate-oracle-mismatch'`; new payload fields per the data flow section below.

### Data flow — per-input sequence

```
shim                                              harness
─────                                             ───────
walker.next_block(h)                              spawn shim (existing)
  ↓
for tx in block:
  for input in tx.inputs:
    ergo_tree    = parse(input.spent_box_bytes.ergoTree)
    ctx          = build_context(block, tx, input)
    cost_result  = compute_oracle_cost(ergo_tree, ctx)
    inputBundle.oracleCost      = cost_result.cost
    inputBundle.oracleSucceeded = cost_result.is_ok
    inputBundle.oracleError     = cost_result.error_msg
CBOR-encode BlockBundle                  ──▶      decode BlockBundle
                                                    ↓
                                                  for tx in block:
                                                    for input in tx.inputs:
                                                      try {
                                                        result = evaluate(tree, opts)
                                                      } catch (ourErr) {
                                                        if (input.oracleSucceeded) {
                                                          throw HarnessError('oracle-mismatch',
                                                            { code: 'ours-errored-oracle-succeeded', ... })
                                                        }
                                                        // existing 'evaluate' phase handler
                                                        throw ourErr
                                                      }
                                                      if (!input.oracleSucceeded) {
                                                        throw HarnessError('oracle-mismatch',
                                                          { code: 'ours-succeeded-oracle-errored', ... })
                                                      }
                                                      if (result.ctx.jitCost !== input.oracleCost) {
                                                        throw HarnessError('cost-drift', { ... })
                                                      }
                                                      // continue to verify-signature pass
```

### Tri-modal outcome table

| our eval | oracle eval | action |
|---|---|---|
| OK | OK | compare cost; equal → continue; unequal → halt `'evaluate-cost'` |
| OK | err | halt `'evaluate-oracle-mismatch'` / `'ours-succeeded-oracle-errored'` |
| err | OK | halt `'evaluate-oracle-mismatch'` / `'ours-errored-oracle-succeeded'` |
| err | err | continue (existing `'evaluate'` phase wrote error-report.json on our side; tighter oracle-vs-ours error-code equivalence is carry-forward) |

### `error-report.json` payload extensions (additive to existing schema)

```jsonc
// phase 'evaluate-cost' — both eval'd; cost differs
{
  "phase": "evaluate-cost",
  "errorClass": "HarnessError",
  "errorCode": "cost-drift",
  "location": {
    "txIndex": <int>,
    "txId": <hex>,
    "inputIndex": <int>,
    "ergoTreeHex": <hex>
  },
  "evaluateCost": {
    "expected": <u64 oracle cost>,
    "actual":   <number our cost>,
    "delta":    <expected - actual signed>
  },
  "bundleExcerpt": { "headerHex": <hex> }
}

// phase 'evaluate-oracle-mismatch' — eval success/failure disagreement
{
  "phase": "evaluate-oracle-mismatch",
  "errorClass": "HarnessError",
  "errorCode": "ours-succeeded-oracle-errored" | "ours-errored-oracle-succeeded",
  "location": { ... },
  "oracleError":     <string or null>,
  "ourError":        <string or null>,
  "ourEvaluateCost": <number or null>,    // partial cost at our throw, if applicable
  "bundleExcerpt": { "headerHex": <hex> }
}
```

### Per-fix-N convention (each downstream fix-N obeys this)

Documented here so each fix-N spec inherits the structure:

1. **RED → new fixture-driven per-arm test under `packages/ergoscript/test/eval/`.** Captures the surfaced drift as a permanent test: input that reproduces the divergence (extracted from `bundleExcerpt.headerHex` + `location.ergoTreeHex` + the surrounding context), expected oracle cost, expected SValue. Lives independently of the harness; future regressions caught even when the harness isn't running.
2. **Findings entry at `tools/mainnet-validate/findings/YYYY-MM-DD-fix-N-<topic>.md`.** Mirrors fix-1/2/3 shape: surfaced site, root-cause analysis with sigma-rust source line cite, GREEN delta description, smoke result post-fix.
3. **Lesson-learned sweep.** Is the drift an instance of a PATTERN (e.g., "Pattern-A arms in family X consistently undercharge")? If yes:
   - Update `facts/ergoscript-eval.md` cost-pattern guidance.
   - Surface a memory entry under `~/.claude/projects/-home-mwaddip-projects-ergots/memory/` (likely `reference-cost-*` family).
   - Proactively sweep adjacent arms in the same family — `[[feedback-correctness-over-effort]]` applied to cost.

## Error taxonomy

**New `HarnessError` codes (additive to existing classes):**

- `'cost-drift'` — both sides eval'd; oracle cost != ours.
- `'oracle-mismatch'` (with `code: 'ours-succeeded-oracle-errored' | 'ours-errored-oracle-succeeded'`) — eval success/failure disagreement.
- `'cost-overflow'` — oracle cost exceeds `Number.MAX_SAFE_INTEGER` (2^53 - 1). Defensive; not expected on mainnet (cost values are far below this bound). Surfaced as a structured halt rather than a silent narrowing-loss-of-precision bug.

**New shim error code (in `MissingUtxo`-style enum):**

- `'cost-oracle-failed'` — internal shim error if `compute_oracle_cost` itself crashes (panic, not a sigma-rust eval-error). Distinct from sigma-rust eval errors which ride along on `oracle_succeeded: false` + `oracle_error: Some(...)`. Rare — represents a bug in the shim adapter, not a chain divergence.

**No new `EvalError` codes** — the ergoscript package is unchanged in 2j-a.

## Test strategy

### Layer 1 — Rust unit tests (`shim/src/cost_oracle.rs::tests`, ~5 new)

- **Pattern A arm sanity** — synthetic tree with a Fixed-cost arm; assert oracle cost matches the expected constant. E.g., `ExtractAmount`, `Fixed(8)`.
- **Pattern B arm sanity** — synthetic tree with a HOF arm + N-item input; assert oracle cost scales per `addPerItemCost(base, perChunk, chunkSize, n)`.
- **Mixed Pattern A+B** — lambda HOF over Coll; outer Pattern A + inner Pattern B coexist.
- **Error-path partial cost** — tree that throws mid-eval (e.g., `Atleast` with `bound > items.length`); assert oracle returns the partial cost accumulated up to the throw + `is_ok: false` + `error_msg: Some(...)`.
- **Context-fidelity** — tree that reads `HEIGHT` and exercises treeVersion-gated semantics (e.g., V3-only `SAvlTree.insertOrUpdate`); assert cost differs by V<3 reject path vs V3+ path correctly.

### Layer 2 — Shim CBOR roundtrip (`shim/src/protocol.rs::tests`, ~2 new)

- Encode/decode an `InputBundle` carrying `oracle_cost` + `oracle_succeeded` + `oracle_error` round-trips byte-equal.
- Protocol-version bump constant is present in the encode output; harness's mismatched-version path can be exercised manually (separate Layer-4 integration test).

### Layer 3 — Harness TS unit tests (`harness/test/validate-tx.test.ts`, ~5 new)

- Cost matches → no throw, returns normally.
- Cost mismatch → throws `HarnessError('cost-drift')` with `{ expected, actual, delta }` payload.
- Our succeeds, oracle errors → throws `HarnessError('oracle-mismatch')` / `'ours-succeeded-oracle-errored'`.
- Ours errors, oracle succeeds → throws `HarnessError('oracle-mismatch')` / `'ours-errored-oracle-succeeded'`.
- Both error → no oracle-mismatch throw; existing `'evaluate'` phase fires unchanged.

### Layer 4 — Harness halt-path integration tests (`harness/test/halt-path.test.ts`, ~2 new)

- Fault-injection via mock shim (or `--inject-cost-drift-at-height H` env-var on the real shim) → `error-report.json` at phase `'evaluate-cost'` with full payload shape (location, evaluateCost, headerHex).
- Fault-injection for `'evaluate-oracle-mismatch'` (one direction is sufficient for the integration test; both directions covered at unit level).

### Layer 5 — Validation smoke (post-implementation; the 2j-a closing task)

- Run on the existing `/tmp/ergots-2j-pre-smoke-data/modifiers.redb` snapshot from h=1 with `--max-height 100`.
- **Two passing outcomes:**
  - **Clean walk to h=100** → confirms wiring runs end-to-end on real data without false positives. Findings doc: "wiring validated; no divergence in h=1..100. Deeper smokes are 2j-b's territory."
  - **Halt before h=100 with structured `error-report.json`** → confirms wiring works AND surfaces the first naturally-occurring RED. Findings doc records the site; that data feeds the 2j-b spec.
- Either outcome ships 2j-a. Both are positive signals about the wiring.
- **Failing outcome:** smoke crashes with a non-structured error, or `error-report.json` is malformed, or the shim's `compute_oracle_cost` panics. That's a wiring bug → fix and re-run before declaring 2j-a done.

### Layer 6 — Verification gates per OVERRIDES rule #6

- `cargo build --release --manifest-path tools/mainnet-validate/shim/Cargo.toml` — clean.
- `cargo test --release --manifest-path tools/mainnet-validate/shim/Cargo.toml` — 22+5+2 = 29 passing.
- `cd tools/mainnet-validate/harness && npm test` — 74+5+2 = 81 passing.
- `cd tools/mainnet-validate/harness && npm run build` — clean (dist refreshed).
- No ergots-package changes in 2j-a → no `npx tsc --noEmit -p packages/*` re-runs needed (existing 3782 tests stay green by construction).

### Mutation testing

**No new mutation tests at the 2j-a wiring layer.** The diff logic is straightforward equality; mutation here would just rediscover that flipping `===` to `!==` causes test failures. Per-arm cost-charging code (unchanged in 2j-a, mutated downstream by 2j-b/c/...) already has Layer-C3.a mutation testing per existing convention.

## Source mapping to sigma-rust

| Rust source (pinned `integration/ergots`) | TS / shim impact |
|---|---|
| `ergotree-ir/src/chain/context.rs:24-55` (`Context` struct + field set) | Shim's `cost_oracle.rs` constructs a fresh `Context<'_>` per input; ALL fields are load-bearing for cost parity |
| `ergotree-ir/src/chain/context.rs:49` (`pub jit_cost: Cell<u64>`) | Shim reads via `ctx.jit_cost_value()` (line 102 getter); zero-initialised per input |
| `ergotree-ir/src/chain/context.rs:102-104` (`jit_cost_value` getter) | Shim's primary read point for accumulated cost — NEVER use `ReductionResult.cost` (that's `/10`) |
| `ergotree-ir/src/chain/context.rs:106-108` (`reset_jit_cost` setter) | Shim resets between evaluations OR allocates a fresh Context per input |
| `ergotree-interpreter/src/eval.rs:161` (`reduce_to_crypto`, **public** entry point) | Shim's eval invocation site. Same entry point `ergo-lib/src/wallet/signing.rs:114` uses |
| `ergotree-interpreter/src/eval.rs:174` (`(jit_cost - cost_before) / 10`) | **Reference for why we must read jit_cost_value() directly** — the `/10` happens before `ReductionResult.cost` is returned |
| `ergotree-interpreter/src/eval.rs:213-214` (`EVAL_SIGMA_PROP_CONSTANT = 50`) | Bare P2PK 50-cost short-circuit — symmetric between sigma-rust and our `tryTrivialReduce` (both charge 50; no spurious mismatch expected on bare P2PK boxes) |
| `ergotree-interpreter/src/eval.rs:325` (`pub(crate) trait Evaluable`) | **Why we don't use `expr.eval` directly** — the trait is not `pub`; `reduce_to_crypto` is the public alternative |
| `ergotree-interpreter/src/eval.rs:555-564` (`try_eval_out`, `cfg(feature="arbitrary")` only) | Reference shape only; not the invocation path |
| `ergo-lib/src/wallet/tx_context.rs::TransactionContext::new` | Helper for constructing `Context` if `pub`; T2 verifies. Fallback: implement minimal `ContextExtensionProvider` locally |

## Execution order

```
T1   Spec lands (this file) + PLAN.md committed
T2   Verification gate: source-read `ergo-lib/src/wallet/tx_context.rs`
     to confirm `TransactionContext::new` / Context-construction
     helpers are `pub`-accessible from shim. Decide between:
       (a) reuse ergo-lib helpers (preferred — no feature flags), OR
       (b) implement minimal local `ContextExtensionProvider` adapter, OR
       (c) enable `arbitrary` feature on ergotree-interpreter as a
           reference for context-construction shape.
     Decision documented inline as a SPEC-CONFIRMING commit (no code
     changes if (a) is feasible; small Cargo.toml + adapter if (b) or (c)).
T3   Shim cost_oracle.rs new module — calls `reduce_to_crypto(tree, ctx)`,
     reads `ctx.jit_cost_value()` directly. Constructs Context with all
     required fields (height, selfBox, inputs, outputs, dataInputs,
     preHeader, headers, extension, tree_version, jit_cost_limit,
     constants). 5 unit tests (Pattern A, Pattern B, Mixed, error-path
     partial, context-fidelity for treeVersion + constants).
T4   Shim protocol.rs CBOR extension + protocol-version bump + 2
     roundtrip tests
T5   Shim block_walker.rs integration of compute_oracle_cost per input
T6   Harness protocol.ts type extension + error-report.ts new phase
     classes + payload types (incl. 'cost-overflow' code)
T7   Harness validate-tx.ts cost-diff logic + bigint→number narrowing
     + 5 unit tests (cost match, cost mismatch, both error directions,
     cost-overflow guard)
T8   Harness halt-path.test.ts 2 integration tests (mock-shim
     fault-injection — committed in this spec as the chosen path;
     real-shim env-var injection deferred to future-work if needed)
T9   Layer-5 validation smoke (--max-height 100) + findings doc at
     tools/mainnet-validate/findings/2026-MM-DD-2j-a-validation-smoke.md
T10  SESSION_CONTEXT + HANDOFF + facts/READMEs sweep + memory refresh
     + push
```

Expected commit count: 10. T2 may be a doc-only / verification commit if (a) holds; small code commit if (b)/(c). Total: 10 commits regardless.

## Done criterion

**Required for ship:**

- All 10 tasks committed.
- `cargo build --release` clean in `tools/mainnet-validate/shim/`.
- `cargo test --release` clean in `tools/mainnet-validate/shim/` (29 passing, +7 new).
- `npm test` clean in `tools/mainnet-validate/harness/` (81 passing, +7 new).
- `npm run build` clean in `tools/mainnet-validate/harness/`.
- Existing ergots-package tests stay green (3782) — no package changes in 2j-a.
- Layer-5 validation smoke (T9) completes; either:
  - Clean walk to `--max-height 100`, OR
  - Halt with well-formed `error-report.json` at a meaningful phase (`'evaluate-cost'` or `'evaluate-oracle-mismatch'`) that locates the divergence.
- T9 findings doc lands documenting the smoke outcome.
- `git status` clean modulo `audit20260519/`.
- `origin/master` aligned.

**Explicitly NOT in 2j-a done criterion:**

- Walking past `--max-height 100`.
- Surfacing any specific predicted RED.
- Fixing any cost-drift or oracle-mismatch (that's 2j-b+).
- Writing fixture-driven RED tests in `packages/ergoscript/test/eval/` for any surfaced drift (also 2j-b+).
- Lesson-learned sweeps (also 2j-b+).
- CI gate on cost-equivalence.

## Risk hotspots

1. **Context-fidelity drift between shim and harness.** Both reconstruct `EvalContext` from the same `BlockBundle` but in different languages. A field-construction divergence (e.g., one side passes empty `dataInputs`, the other passes `null`; or one side derives `tree_version` from spent box vs from outer envelope) produces spurious cost mismatches. `Context` requires ALL fields listed in Components → `cost_oracle.rs` (height, selfBox, inputs, outputs, dataInputs, preHeader, headers, extension, tree_version, jit_cost, jit_cost_limit, constants). Omitting any single one is a load-bearing bug. *Mitigation:* T3 unit tests cover each field independently; smoke walk validates on real data; per-field source-comment mapping in `cost_oracle::build_context`.

2. **Cost-scale-factor confusion.** sigma-rust's `ReductionResult.cost` field is `jit_cost / 10` (block cost), NOT the raw JitCost value. Reading `ReductionResult.cost` would produce an off-by-10 mismatch on every input. *Mitigation:* source mapping table explicitly cites `eval.rs:174` showing the `/10` conversion; T3 unit tests assert `oracle_cost == expected_jit_cost` not `expected_block_cost`; spec language consistently says "read `ctx.jit_cost_value()` directly".

3. **Bare P2PK 50-cost short-circuit symmetry.** Sigma-rust's `reduce_to_crypto` triggers a 50-`EVAL_SIGMA_PROP_CONSTANT` short-circuit for bare `Const(SSigmaProp, _)` trees (per `eval.rs:213-214`); our `tryTrivialReduceExpr` mirrors this (charges 50 before bypassing `evalExpr`). The two are symmetric — both sides land at exactly 50 for bare P2PK. *Implication:* if the first smoke walk shows cost-drift on every bare-P2PK input (the dominant mainnet shape — likely >90% of inputs), the wiring has a bug; don't waste a fix-N spec investigating per-arm cost-charging. Re-check oracle / harness coordination first.

4. **Shim-side performance overhead.** Adding `reduce_to_crypto` per input per block roughly doubles per-block shim compute. Mainnet trees are small (median P2PK ~5 bytes; rare large contracts ~1KB) so the cost is bounded. *Mitigation:* measure post-implementation; add `--no-cost-oracle` opt-out flag (default-on) if intolerable.

5. **CBOR `InputBundle` shape change.** CBOR encoding itself is wire-additive (struct → map with named keys), so old harness builds reading new shim bundles would ignore the new keys without crashing. What changes is the harness-side schema expectation. *Mitigation:* bump shim protocol-version constant; harness's existing `libraryVersions` mismatch warning fires at startup. Operator docs: "after upgrading 2j-a, delete `--sidecar-path` and `--checkpoint-path` and re-walk from h=1 to ensure consistent state."

6. **`Context` construction may require `ContextExtensionProvider` impl.** Per `context.rs:47`, `Context.extension_provider: &dyn ContextExtensionProvider` is a trait object. Source-read whether `ergo-lib` provides a public impl over `Vec<ContextExtensionEntry>` (the shim's storage shape). *Mitigation:* T2 verification gate makes the decision; fallback is a ~20-line local adapter implementing the trait.

7. **Both-error path is lenient (no oracle-vs-ours error-code comparison).** A bug in our error-classification could go undetected when oracle also errors. Particular known false-negative path: our TS throws `EvalError('cost-limit-exceeded')` when ctx.jitCost > limit; sigma-rust throws a different `EvalError::CostError` variant. If our limit-trip happens before oracle's (because our cost-charging is heavier on some arm), both error — but for *different reasons*, masking a real cost-undercharge bug. *Mitigation:* explicit carry-forward item; per-arm fixture tests in `packages/ergoscript/test/eval/` already enforce error-code expectations at unit level for tested cost-charging code.

8. **First smoke may surface a "shallow" drift that masks deeper issues downstream.** Standard TDD-loop hazard, but exists in 2j-b/c/... territory, not 2j-a. *Mitigation:* per-fix-N convention's lesson-learned step proactively sweeps adjacent arms.

9. **Stretch outcome — first smoke walks to h=100 cleanly without halting.** Possible (2j-pre fix-3 surfaced no halt at h ≤ 20644 for its narrow gap). Indicates no early-mainnet divergence at this depth; either bump `--max-height` in T9 (still within 2j-a) or ship as-is with findings noting clean depth and defer the deeper RED-finding walks to 2j-b. *Decision in T9:* if smoke walks h=1..100 cleanly in under 5 minutes, bump to 1000; if still clean, bump to 10000; if still clean, ship 2j-a with "wiring validated through h=10000" finding and 2j-b starts from there.

10. **Non-deterministic context construction in the shim** (e.g., HashMap iteration order in `context_extension` parsing). *Mitigation:* source-read the shim's reconstruction; lock down any non-deterministic order via `BTreeMap` / sorted iteration.

## Confidence check (OVERRIDES rule #2)

**Per-component (post reviewer-pass v2):**

| sub-component | confidence | notes |
|---|---|---|
| Mechanical wiring (CBOR + harness diff) | 98% | Straightforward additive change |
| `Context::jit_cost` accessibility | 99% | Confirmed `pub Cell<u64>` at context.rs:49 + public getter at :102 |
| Eval entry point selection | 96% | `reduce_to_crypto` confirmed public per reviewer; `Evaluable::eval` ruled out |
| Cost-scale interpretation | 99% | `ReductionResult.cost = jit_cost/10` confirmed; spec mandates direct `jit_cost_value()` reads |
| Shim oracle correctness | 93% | Context-fidelity + Context construction (ContextExtensionProvider impl path) residual |
| Context-fidelity in initial implementation | 92% | Cross-language field-by-field translation; covered by per-field unit tests + smoke |
| **Overall (2j-a spec mechanics)** | **~94%** | Just below 95%; flagged not escalated (see below) |

**Borderline OVERRIDES rule #2 status.** Overall confidence sits at ~94%, just below the 95% escalation threshold. Reviewer-pass adjusted this down from the v1 spec's claimed 95% based on three uncertainty sources: (a) `TransactionContext::new` accessibility from shim is unverified (T2 verification gate covers); (b) `ContextExtensionProvider` impl path may require a local adapter; (c) per-input Context construction has more required fields than v1 listed.

> ⚠️ **ESCALATION ADVISORY (borderline)**
> My confidence on Context-construction-from-shim is ~93%. I recommend T2 explicitly verify `TransactionContext::new` / `ContextExtensionProvider` accessibility before T3 starts. Suggested approach: source-read `ergo-lib/src/wallet/tx_context.rs` and `ergotree-ir/src/chain/context.rs:47` to confirm the construction path; if `ContextExtensionProvider` impl is needed, write the ~20-line adapter as part of T2 (not T3) so T3 stays focused on the cost-oracle logic.

This IS a cost-path phase (cost-equivalence wiring is consensus-critical for v1.0.0 when it ships). The 94% level is acceptable for the spec because: (a) the wiring is mechanically simple; (b) the cost-charging code itself is unchanged in 2j-a; (c) the smoke is the empirical correctness check; (d) T2 verification gate retires the largest uncertainty before implementation work begins.

## Rollback plan

Single-revert per task; each commit independently revertible:

- **T1:** revert spec + PLAN. No code coupling.
- **T2:** revert Cargo.toml changes. No-op if Cargo.toml wasn't touched.
- **T3:** revert `cost_oracle.rs` addition. Module is new; clean delete.
- **T4:** revert CBOR extension + protocol-version bump. CBOR stays at v1; existing tests pass.
- **T5:** revert `block_walker.rs` integration. Walker reverts to non-cost emission.
- **T6:** revert TS type + error-report extensions. Same reasoning.
- **T7:** revert TS cost-diff logic + unit tests.
- **T8:** revert integration tests.
- **T9:** revert findings doc.
- **T10:** revert SESSION_CONTEXT + HANDOFF + facts/README + memory updates.

If a deep regression surfaces during T9's smoke (e.g., the shim crashes on a specific block, or oracle cost is consistently 0 indicating a wiring bug), revert T5 to disable the cost-oracle emission while keeping the other infrastructure; ships 2j-a as "harness extension ready; cost-oracle integration deferred to 2j-a follow-up."

## Carry-forward / future work

- **2j-a-stats** — parallel mini-spec, chain-statistics piggyback. Adds one opt-in `EvalOpts.evalArmCounts` field; harness-side `WalkStats` accumulator; `--stats-path` CLI flag. Lands separately; not blocking 2j-a.
- **2j-b, 2j-c, ... fix-list** — each smoke-walk halt becomes one focused fix per the established pattern. Surfaced organically by walking deeper than 2j-a's `--max-height 100` (or whatever depth T9 reached).
- **Both-error cross-comparison tightening** — refine the oracle-vs-ours error-code equivalence check. Currently we tolerate any err-err pair; tighter check would catch our-side mis-classification.
- **CI gate on cost-equivalence** — defer until the smoke walks cleanly to deep mainnet heights (likely tens of thousands of blocks after several fix-N iterations).
- **14 latent exprTpe arms + 5 eval-side `'not-implemented-yet'` arms** — surface organically through fix-N loop (NOT pre-enumerated). See `facts/ergoscript.md` and `facts/ergoscript-eval.md` for the current latent set.
- **8 confirmed-or-likely-dead opcodes** (per `[[project-kushti-dead-opcodes]]`) — ModQ family (3) confirmed removable, CollShift/Rotate (5) likely removable. Separate cleanup spec; never reaches `evaluate` so unaffected by 2j proper.

## Cross-references

- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/chain/context.rs:49-109` — `Context::jit_cost` field + accessors.
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval.rs:555-564` — `try_eval_out` reference signature.
- `~/projects/ergots/tools/mainnet-validate/shim/src/protocol.rs:134-144` — current `BlockBundle` / `TxBundle` / `InputBundle` CBOR shape.
- `~/projects/ergots/tools/mainnet-validate/shim/src/block_walker.rs` — shim's per-block walker (T5 target).
- `~/projects/ergots/tools/mainnet-validate/harness/src/validate-tx.ts:481-558` — harness's per-input evaluate pass (T7 target).
- `~/projects/ergots/tools/mainnet-validate/harness/src/error-report.ts` — error-report writer (T6 target).
- `~/projects/ergots/docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (phase 2j cost-accounting context).
- `~/projects/ergots/docs/specs/2026-05-22-ergoscript-2j-pre-fix-3-atleast-exprtpe-design.md` — most recent preceding fix-N spec; structural template for downstream 2j-b/c specs.
- `~/projects/ergots/tools/mainnet-validate/README.md` — harness invocation + halt-interpretation docs (likely needs T10 sweep for new phase classes).
- `~/projects/ergots/facts/ergoscript-eval.md` — current evaluator-surface contract; touched only by downstream fix-N specs, NOT by 2j-a.

## Reviewer findings applied (2026-05-22, v1 → v2)

Spec was reviewed by a general-purpose subagent dispatched with explicit instructions to verify context-fidelity correctness, `Context::jit_cost` accessibility, bigint↔number conversion correctness, CBOR additivity, tri-modal completeness, P2PK short-circuit symmetry, and source-citation accuracy.

**★★★ Critical findings (all applied inline):**

1. **C1 — `Evaluable::eval` is `pub(crate)`; not callable from shim.** Spec v1 said "invoke `expr.eval(env, ctx)`" — would have failed to compile. **Applied:** Architecture, Components, Source-mapping table, T3 task body, and Risk #2 all updated to use the public `reduce_to_crypto(tree, ctx)` entry point (`eval.rs:161`; same path `ergo-lib/src/wallet/signing.rs:114` uses).

2. **C2 — Cost-scale-factor mismatch.** `ReductionResult.cost = jit_cost / 10` (block cost). Spec v1 didn't flag this; T3 implementer would have produced an off-by-10 mismatch on every input. **Applied:** Architecture one-paragraph summary explicitly says "do NOT use `ReductionResult.cost`"; Source-mapping table cites `eval.rs:174` showing the `/10` conversion; new Risk #2 documents the trap; T3 task body mandates `jit_cost_value()` direct read.

3. **C3 — Context construction requires more fields than v1 listed.** `Context` (per `context.rs:24-55`) needs `tree_version`, `extension_provider` (`ContextExtensionProvider` trait object), `jit_cost_limit`, `constants` in addition to v1's listed chain-state. **Applied:** Components → `cost_oracle.rs` bullet expanded with full required-field list; Risk #1 expanded; new Risk #6 specifically about `ContextExtensionProvider` impl path; T2 verification gate retires this uncertainty before T3 starts.

**★★ Moderate findings (applied):**

4. **M1 — CBOR additivity overstated.** Spec v1 said "CBOR shape becomes breaking." Per reviewer's source-read of `harness/src/protocol.ts:2-22` (uses `cbor-x` with `mapsAsObjects`) and `shim/src/protocol.rs:67-68` (struct as named-key map), CBOR encoding itself is wire-additive. **Applied:** Components → `protocol.rs` bullet reworded to "wire-additive; what changes is the harness-side schema expectation"; Risk #5 reframed.

5. **M2 — err/err with different error codes is a known false-negative.** **Applied:** Risk #7 (formerly #5) expanded with concrete example (TS `'cost-limit-exceeded'` vs sigma-rust `EvalError::CostError` for the same condition).

6. **M3 — Fault-injection ambiguity.** Spec v1 left mock-shim vs real-shim env-var open. **Applied:** T8 commits to mock-shim; real-shim env-var deferred to future-work if needed.

7. **M4 — P2PK 50-cost short-circuit symmetry should be flagged.** Both sides charge 50; on bare P2PK boxes (>90% of mainnet inputs), no spurious mismatch expected. **Applied:** Source-mapping table cites `eval.rs:213-214` showing `EVAL_SIGMA_PROP_CONSTANT = 50`; new Risk #3 documents the implication (if first smoke shows cost-drift on every bare-P2PK input, wiring has a bug; don't waste fix-N effort).

**★ Minor findings (acknowledged):**

8. **Mi1** — Source citation off-by-one (`context.rs:107-109` → `:106-108`). **Applied:** source mapping table updated.
9. **Mi2** — Naming consistency (`oracle_cost` snake / `oracleCost` camel) verified OK by reviewer; no change.
10. **Mi3** — Findings-folder filename pattern verified OK; no change.

**Verification gaps (carried into T2 as explicit verification work):**

- VG1: `ergo-lib::TransactionContext::new` public-accessibility from shim — T2 verification gate.
- VG2: `Cell<u64>` thread-safety in shim — single-threaded usage assumed and locked in.

**Net effect:** confidence v1 95% → v2 94% (borderline; advisory escalation note added per OVERRIDES rule #2). Recommendation: **REVISE → SHIP** (per reviewer); all critical findings folded. Estimated revision scope of 3-4 paragraphs (architecture, source-mapping table, T3 task body, Risk #1) → applied exactly.
