# Phase 2i-c — Deserialize family (eval-side)

**Status:** Draft (2026-05-21). Pre-reviewer pass.
**Author:** Claude Opus 4.7 (1M context) under user direction.
**Phase scope:** Wire eval semantics for `DeserializeContext` + `DeserializeRegister` `Expr` arms.

**Preceding phase:** 2i-b (curve + AVL + sigma-trivial predefs; 5 new arms, 65/~70 coverage, 59 EvalError codes).
**Phase plan:** umbrella spec `docs/specs/2026-05-13-ergoscript-interpreter-design.md`. 2i-c closes the recursive-eval architectural lift; sibling 2i-d closes long-tail parse-rejecting/deprecated arms; 2j adds real-context cost calibration.

---

## Goal

Implement runtime evaluation for the two `Expr` arms that consume **untrusted bytes** from the runtime context and parse them back into `Expr` for evaluation:

1. **`DeserializeContext`** — reads `ctx.extension.values[id]` as `Coll[Byte]`, decodes bytes as an `Expr`, evaluates that `Expr` in the current context.
2. **`DeserializeRegister`** — reads `ctx.selfBox.registers[reg]` as `Coll[Byte]`, decodes bytes as an `Expr`, evaluates it. If the register is absent, fall back to `default` (an inline `Expr` baked into the outer tree); throw if both are absent.

Both arms already parse + serialize at the wire layer (`wire/mir/deserialize-context.ts` and `wire/mir/deserialize-register.ts`); the gap is **eval semantics** + **`exprTpe` coverage**.

**Targets** (revised post-reviewer-pass, see "Reviewer findings applied" at the end):

- Eval-arm coverage: 65 of ~70 → **67 of ~70** (+2 arms).
- `EvalError` codes: 59 → **64** (+5 new). Was +6 in the initial draft; reviewer correctly flagged that `'deserialize-register-not-found'` is a synthesized non-case — when the register is absent AND `default` is null, sigma-rust LEAVES the node unchanged in the substitute pass (see `mir/expr.rs:478-481`) and the defensive throw `'deserialize-not-substituted'` covers it at eval time.
- Method-handler registry: 44 (unchanged — these are `Expr` arms, not method calls).
- New test count target: 3142 (ergoscript) → **~3200–3220** (+60–80). Reduced from +78–98 per reviewer's more realistic estimate.

## Non-goals

- **No new dispatcher gating.** Neither arm carries a `minVersion` on its dispatcher entry. (The inner Expr's V3-gated arms — Upcast/Downcast on BigInt, `insertOrUpdate`, `checkPow` — will gate themselves when evaluated normally.)
- **No new runtime dependency.** Both arms compose from existing infrastructure (`parseExpr`, `evalExpr`, `exprTpe`, `sTypeEquals`, `collByteToUint8Array`).
- **No `gas`/cost-budget overhaul.** Cost charging is whatever the inner Expr's recursive eval charges. The substitution itself is free (matches sigma-rust).
- **No proof-of-soundness for non-terminating scripts.** A `DeserializeContext` whose extension value encodes itself (the `eval_recursive` test in sigma-rust) trips the `'cost-limit-exceeded'` guard, not a static cycle detector. This is the same posture sigma-rust takes — recursive Deserialize substitutions throw at eval-time, not at substitute-time.

## Motivation

These are the only two `Expr` arms that turn untrusted runtime bytes back into executable script. Wallet relayers and DEX contracts use `DeserializeRegister` to encode "spending policy in the box itself" patterns. `DeserializeContext` is used for "spending policy via signer-provided witness." Both are foundational for any consensus-critical evaluator — they bridge the gap between static parse-time analysis and runtime execution.

The C2 mainnet-corpus impact is modest (~5 trees observed in informal sampling); the bigger win is **closing the dynamic-eval architectural gap** that's blocked phase 2i-d and 2j from running their corpus runs on these specific trees. Without 2i-c, those trees hit `'not-implemented-yet'`.

## Architecture

### Decision: substitute-pre-pass vs in-place per-arm eval

Two designs are viable. The spec recommends **substitute-pre-pass** (Option B); Option A is presented as the rejected alternative.

#### Option B — substitute-pre-pass (RECOMMENDED)

Mirrors sigma-rust's `eval.rs:203-250` design. **Note:** `tryTrivialReduce` currently takes `(tree, ctx)` and reads `tree.body` (`packages/ergoscript/src/eval/evaluate.ts:29`). T5 refactors this — extracts `tryTrivialReduceExpr(body, ctx)` so the substituted-body path can call it directly without synthesizing a fake tree:

```
evaluate(tree, opts):
  ctx = makeContext(opts)              // ctx.constants = tree.constants always
  if treeHasDeserialize(tree):
    rewrittenBody = substituteDeserialize(tree.body, tree, ctx)
    return tryTrivialReduceExpr(rewrittenBody, ctx) ?? evalExpr(rewrittenBody, emptyEnv, ctx)
  else:
    return tryTrivialReduce(tree, ctx) ?? evalExpr(tree.body, emptyEnv, ctx)
```

**Architectural divergence from sigma-rust (deliberate, cost-equivalent):**

Sigma-rust's substitute path calls `tree.proposition()` (`eval.rs:206`) which eagerly substitutes `ConstantPlaceholder` nodes with their resolved `Constant` values BEFORE running `substitute_deserialize`. Sigma-rust then calls `trivial_reduce` and `inner()` on the placeholder-free body, and explicitly does NOT set up `ctx.with_constants` (so any leftover placeholder would fail).

Our `evaluate` sets `ctx.constants = tree.constants` for ALL paths. Our `tryTrivialReduce` (and downstream `evalConstPlaceholder`) consults `ctx.constants` for `ConstPlaceholder` resolution. This is a different code path with identical observable behavior: the P2PK 50-JitCost short-circuit fires on `Const(SSigmaProp)` AND `ConstPlaceholder(SSigmaProp)` at the substituted-body root, matching sigma-rust's cost-integer output.

This divergence is deliberate. It removes a 100+ LOC eager-substitution pass without changing any test's value or cost output. Tests with a substituted body that contains a `ConstPlaceholder` inside a non-trivial-reduce subtree confirm parity.

`substituteDeserialize` is a bottom-up tree rewrite that:
- Locates every `DeserializeContext` / `DeserializeRegister` node.
- For each, decodes bytes via the runtime context, parses bytes as `Expr`, validates `exprTpe(parsed) === e.tpe`, splices `parsed` in place of the Deserialize* node.
- Does NOT recursively rewrite the spliced `parsed` Expr's own Deserialize* children (mirrors sigma-rust `try_rewrite_bu` semantics — recursive Deserialize-in-inner-Expr trips at eval-time, not substitute-time).

The Deserialize* eval arms become **defensive throws**: if the dispatcher reaches a `DeserializeContext` / `DeserializeRegister` node at eval time, it means substitution didn't reach it (i.e., it lived inside a substituted inner Expr). Throw `'deserialize-not-substituted'`.

**Why this is the recommended approach:**

1. **Sigma-rust parity on the P2PK short-circuit.** A degenerate tree whose body is `DeserializeContext` decoding to `Const(SSigmaProp, ProveDlog(g))` charges flat 50 JitCost via `EVAL_SIGMA_PROP_CONSTANT` in sigma-rust. Option B preserves this because `tryTrivialReduce` runs on the rewritten body. Option A diverges — it would charge the Const arm's Fixed(1) and lose 49 JitCost. Although this corner case is unlikely on mainnet (real scripts have surrounding logic), cost-integer parity is consensus-critical.

2. **Recursive Deserialize ergonomics.** A recursive Deserialize encoded via `ctx[1] = sigma_serialize(DeserializeContext{id=1})` will hit eval-time throw `'deserialize-not-substituted'` (or, with deep recursion, `'cost-limit-exceeded'`) in Option B. Option A would produce the same behavior via a different code path (`evalDeserializeContext` recurses into `evalExpr(parsed)` which dispatches back into `evalDeserializeContext`). Both terminate; B has cleaner error semantics.

3. **Mirrors sigma-rust file structure.** The wire `mir/deserialize_*.rs` files in sigma-rust contain ONLY tests — no `Evaluable` impl. The substitute pass lives in `mir/expr.rs::substitute_deserialize`. Our `_substitute-deserialize.ts` parallels this layout.

4. **Clean separation of concerns.** The substitution pass owns "untrusted-bytes-to-trusted-Expr" lifting; the eval arms remain pure pattern-match-and-evaluate. No special-case cost logic inside the Deserialize* eval arms.

#### Option A — in-place per-arm eval (REJECTED, captured for completeness)

`evalDeserializeContext` and `evalDeserializeRegister` would each parse bytes inline and recursively call `evalExpr(parsed, env, ctx)`. No substitution pass.

Rejected because:
- Loses cost parity on the P2PK short-circuit corner case (see B.1 above).
- Inner Expr's `'cost-limit-exceeded'` guards depend on the OUTER `ctx`, which is fine — but recursive Deserialize-in-inner-Expr would re-enter the arm, charging extra recursion overhead not present in sigma-rust.
- Tighter coupling to the per-arm structure where the natural sigma-rust mirror is a pre-pass.

### Substitution pass design

```ts
// File: packages/ergoscript/src/eval/_substitute-deserialize.ts

import type { ErgoTree } from '../wire/types'
import type { Expr } from '../mir/types'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { ByteReader } from '@ergots/scorex'
import { parseExpr } from '../wire/parse'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEquals } from '../mir/stype-helpers'
import { collByteToUint8Array } from './_byte-coll'

/**
 * Returns true if the tree's body contains any DeserializeContext or
 * DeserializeRegister node. Mirrors sigma-rust Expr::has_deserialize
 * (ergotree-ir/src/mir/expr.rs:431-438).
 */
export function treeHasDeserialize(tree: ErgoTree): boolean { ... }

/**
 * Bottom-up rewrite of `body`, splicing in inner-Exprs decoded from
 * ctx.extension / ctx.selfBox. Mirrors sigma-rust Expr::substitute_deserialize
 * (mir/expr.rs:442-496). Does NOT charge cost — pre-eval pass.
 *
 * Throws EvalError with one of:
 *   'deserialize-context-key-not-found'           (extension.values[id] undefined)
 *   'deserialize-input-not-byte-array'            (entry.tpe !== SColl<SByte>)
 *   'deserialize-parse-failed'                    (inner Expr bytes malformed; wraps wire error in .message)
 *   'deserialize-tpe-mismatch'                    (exprTpe(parsed) !== e.tpe)
 *   'context-field-missing'                       (ctx.extension/ctx.selfBox undefined)
 *
 * Critical: when the register is absent AND `default` is null, the substitution
 * pass LEAVES the DeserializeRegister node unchanged (mirrors sigma-rust
 * mir/expr.rs:478-481 "When script in register is not found, and default is
 * not defined, leave DeserializeRegisterNode unchanged, which will error on
 * evaluation"). The eval-time defensive throw 'deserialize-not-substituted'
 * catches this on the next dispatch step. The same applies to recursive
 * Deserialize references inside substituted-in inner Exprs.
 */
export function substituteDeserialize(
  body: Expr,
  tree: ErgoTree,
  ctx: EvalContext,
): Expr { ... }
```

Walking rules:

- **Order:** bottom-up (children rewritten before parent). Matches `try_rewrite_bu` (`mir/expr.rs:397-408` confirmed: `rewrite_bu_inner` does NOT re-walk substituted children).
- **Inner-Expr parser invocation:** `parseExpr(reader, [], [], new Map(), ctx.treeVersion ?? tree.header.version)`. Inner bytes parse with **empty constants** — confirmed against sigma-rust `serialization/constant_placeholder.rs:14-24` which REJECTS at parse with `ConstantForPlaceholderNotFound` when the store has no entry. Our `parseConstantPlaceholder` at `packages/ergoscript/src/wire/mir/constant-placeholder.ts:43-49` mirrors with `constantTypes`-range-check rejection. If the inner Expr contains a `ConstantPlaceholder`, parsing fails → `'deserialize-parse-failed'`.
- **Tree-version propagation:** the inner Expr is parsed under `ctx.treeVersion` (which `evaluate` auto-derives from `tree.header.version`). This matches sigma-rust's `with_tree_version(ctx.tree_version(), Expr::sigma_parse)`.
- **Type-check:** `sTypeEquals(exprTpe(parsed), e.tpe)`. Mismatch → `'deserialize-tpe-mismatch'`. Check runs on BOTH the register-decoded inner Expr AND the `default` fallback Expr — sigma-rust `expr.rs:486-491` applies it post-`.or(default.as_deref().cloned())`.
- **Substituted Expr's interior is NOT re-walked.** A `DeserializeContext` lurking in the parsed inner Expr stays unsubstituted; the eval-time throw `'deserialize-not-substituted'` catches it. Matches sigma-rust `try_rewrite_bu`.
- **No reader-at-EOF assertion on inner parse.** Sigma-rust's `from_bytes(&vec).with_tree_version(...).Expr::sigma_parse` does NOT require the inner reader to be exhausted after the Expr parse. We mirror — trailing bytes past the parsed inner Expr are silently ignored.

### Eval arm design (defensive throws)

```ts
// File: packages/ergoscript/src/eval/deserialize-context.ts

import type { DeserializeContext } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

/**
 * Defensive throw — substituteDeserialize should rewrite this node before eval.
 * Reachable only when the node lives inside an already-substituted inner Expr
 * (matches sigma-rust eval/deserialize_context.rs which contains ONLY tests —
 * no Evaluable impl; falls through to "not implemented" at eval-time).
 */
export function evalDeserializeContext(
  e: DeserializeContext,
  _env: Env,
  _ctx: EvalContext,
): never {
  throw new EvalError(
    `DeserializeContext: node reached eval — substitute pass did not rewrite ` +
      `(likely nested in an inner-Expr from substitution). id=${e.id} tpe=${e.tpe.tag}`,
    'deserialize-not-substituted',
  )
}
```

`evalDeserializeRegister` follows the same shape.

### exprTpe coverage

Add two cases to `mir/expr-tpe.ts`:

```ts
case 'DeserializeContext':
case 'DeserializeRegister':
  return e.tpe
```

Both arms carry their declared result type on the `e.tpe` field; no recursive descent needed.

### Tree-version invariants

The inner Expr inherits `ctx.treeVersion` from the outer tree. The inner Expr's eval arms (e.g., Upcast/Downcast on BigInt) consult `ctx.treeVersion` directly and throw `'tree-version-too-low'` on V<3 trees with V3-gated arms. This is correct — the inner Expr executes under the SAME tree-version as the outer, since the outer tree's `header.version` defines the runtime semantics.

This carries one subtle implication: a V3 tree's inner Expr (parsed from context bytes) MAY use V3-gated arms. If the inner bytes were created by a V0 prover but encoded a V3 arm, the parse would either succeed (if V0 parser accepts the V3 arm's opcode) or fail (if the V3 arm uses an opcode unknown in V0). Sigma-rust's `with_tree_version` parser threads tree-version through the parse, so V3-only opcodes throw at parse time in V0 contexts. We mirror.

## Error taxonomy

Five new `EvalError` codes (59 → 64). The codes follow the 2g.5/2i-b compact-taxonomy convention — per-failure-class, shared across both arms where the failure class is identical.

| Code | Source path | Description |
|---|---|---|
| `'deserialize-context-key-not-found'` | substituteDeserialize, DeserializeContext branch | `ctx.extension.values[e.id]` is undefined. Mirrors sigma-rust `SubstDeserializeError::ExtensionKeyNotFound(id)`. Message includes the id for symmetry with sigma-rust. |
| `'deserialize-input-not-byte-array'` | both branches | Context-extension entry / register entry has `tpe !== SColl<SByte>` or `value.kind !== 'Coll'` with non-Byte items. Mirrors sigma-rust `SubstDeserializeError::TryExtractFromError`. |
| `'deserialize-parse-failed'` | both branches | Inner Expr bytes are malformed (wraps the underlying wire parse error class + message in `.message`). Mirrors sigma-rust `SubstDeserializeError::ExprParsingError`. |
| `'deserialize-tpe-mismatch'` | both branches | `exprTpe(parsed) !== e.tpe`. Mirrors sigma-rust `SubstDeserializeError::ExprTpeError { expected, actual }`. |
| `'deserialize-not-substituted'` | both eval arms (defensive throws) | The Deserialize* node was reached at eval time — substitution did not rewrite it. Triggered when (a) DeserializeRegister with register absent + default null (substitute leaves node, per `expr.rs:478-481`); (b) the node lives inside an inner Expr decoded from runtime bytes (recursive Deserialize). |

**Why not a separate `'deserialize-register-not-found'` code:** the initial draft proposed it. Reviewer correctly observed that sigma-rust's `substitute_deserialize` (`mir/expr.rs:478-481`) returns `Ok(())` when the register is absent AND `default` is None — the node is LEFT UNCHANGED in the tree, and the eval-time throw catches it. There's no substitute-time error path for this case. `SubstDeserializeError::RegisterNotFound` exists in the Rust enum (line 721) but is never constructed in `substitute_deserialize`. We mirror — drop the substitute-time code, rely on `'deserialize-not-substituted'`.

**Reuse of existing codes:**

- `'context-field-missing'` (Phase 2f medium) — reused when `ctx.extension === undefined` or `ctx.selfBox === undefined`. The substitution pass needs these context fields to do its work; their absence is a chain-state-setup gap, not a Deserialize-specific failure.

**Alternative taxonomy considered (and rejected):**

A maximally-compact 2-code design (`'deserialize-context-error'`, `'deserialize-register-error'`) packs all 4 substitution failure paths under per-arm umbrellas via `.message`. Rejected because the failure paths are distinct enough that callers may want to dispatch on them (e.g., a relayer might want to surface "key not found" differently from "wrong type"). The 5-code design balances compactness with dispatch-usefulness.

## Test strategy

Two-layer validation (mirrors 2i-b):

### Layer C1 — fixture-driven oracle tests

Fixture-gen modules emit JSON with:
- `tree_bytes_hex` — serialized outer ErgoTree (contains the `DeserializeContext` / `DeserializeRegister` arm in the body)
- `context_extension_json` (for DeserializeContext) — `{ id: u8, value_bytes_hex: hex }` to populate `ctx.extension`
- `self_box_registers_json` (for DeserializeRegister) — `{ reg: u8, value_bytes_hex: hex }` to populate `ctx.selfBox.registers`
- `opts_json` — `treeVersion` etc.
- `expected_value` (for success scenarios) — JSON-encoded SValue
- `expected_cost` — total JitCost charged
- `expected_error` (for throw scenarios) — substring match for `EvalError.message`
- `expected_error_code` (for throw scenarios) — exact match for `EvalError.code`

Fixture-gen uses sigma-rust's `try_eval_with_deserialize` for SUCCESS scenarios and most THROW scenarios — this is the entry point that runs the substitute pass before eval. **Exception:** the "register absent + default null" case (e.g., `dr_throw_no_register_no_default`) uses `try_eval_out` instead, because sigma-rust's substitute pass LEAVES the node unchanged in that case (per `expr.rs:478-481`); the eval-time throw is what fires. The sigma-rust test `eval_reg_is_empty` (sub-case at `deserialize_register.rs:69`) demonstrates this distinction. Our parallel TS test asserts `'deserialize-not-substituted'`.

**`DeserializeContext` scenarios (~8):**

- `dc_bool_true` — context value decodes to `Const(SBoolean, true)`; expected value `true`, cost = const cost.
- `dc_height_eq_compare` — context value decodes to `BinOp(NEq, Height, 1i32)`; expected boolean comparison result.
- `dc_v3_unsigned_bigint` — V3 tree, context decodes to `Const(SUnsignedBigInt, zero)`; V<3 throw, V3 success (mirrors `deserialize_v6_type` test).
- `dc_throw_key_not_found` — context map is empty; expected throw `'deserialize-context-key-not-found'`.
- `dc_throw_wrong_input_type` — context value is `1i32`, not `Coll[Byte]`; expected throw `'deserialize-input-not-byte-array'`.
- `dc_throw_parse_failed` — context value is malformed Expr bytes (e.g., truncated opcode stream); expected throw `'deserialize-parse-failed'`.
- `dc_throw_tpe_mismatch` — context value decodes to `Const(SInt, 5)` but arm declares `tpe=SBoolean`; expected throw `'deserialize-tpe-mismatch'`.
- `dc_throw_recursive` — context value decodes to `DeserializeContext{id=same}`; expected throw `'deserialize-not-substituted'` (or `'cost-limit-exceeded'` depending on substitution-pass behavior on inner Expr — to verify in implementation).

**`DeserializeRegister` scenarios (~8):**

- `dr_r4_bool_neq` — R4 register decodes to `BinOp(NEq, Height, 1i32)`; expected success.
- `dr_r5_default_int` — R5 absent, default = `Const(SInt, 1)`; expected `1i32`.
- `dr_throw_no_register_no_default` — R5 absent, default null; expected throw `'deserialize-not-substituted'` at eval time (substitute pass leaves the node unchanged; defensive eval-time throw fires). Test fixture uses `try_eval_out`, not `try_eval_with_deserialize`.
- `dr_throw_register_wrong_type` — R4 stores `Const(SInt, 1)` (not `Coll[Byte]`); expected throw `'deserialize-input-not-byte-array'`.
- `dr_throw_default_wrong_type` — R5 absent, default = `Const(SBoolean, true)` but arm declares `tpe=SInt`; expected throw `'deserialize-tpe-mismatch'`.
- `dr_throw_inner_wrong_type` — R4 register decodes to `Const(SInt, 1)` but arm declares `tpe=SBoolean`; expected throw `'deserialize-tpe-mismatch'` (mirrors `evaluated_expr_wrong_type`).
- `dr_throw_parse_failed` — R4 register stores malformed Expr bytes; expected throw `'deserialize-parse-failed'`.
- `dr_default_used_when_register_absent` — R5 absent, default = `BinOp(NEq, Height, 0i32)`; expected success (validates default-path eval).

### Layer C3.a — mutation testing

Mutate fixture bytes (outer tree bytes + inner Expr bytes in context/register) at varied offsets. Target ≥ 90% kill rate per arm.

Expected categories:
- Outer-tree mutations: trip `ErgoTreeParseError` or downstream eval throws.
- Inner-Expr-bytes mutations: trip `'deserialize-parse-failed'` or `'deserialize-tpe-mismatch'` if parsed but wrong type.
- Type-field mutations on the Deserialize* arm: trip `'deserialize-tpe-mismatch'`.
- Register-id mutations (DeserializeRegister): trip parse-time `'deserialize-register-id-out-of-range'`.
- Context-id mutations (DeserializeContext): produce different lookups, mostly throwing `'deserialize-context-key-not-found'`.

Exemptions: tolerated mutations that preserve byte-equality (e.g., flipping an unused reserved bit).

## Source mapping to sigma-rust

| Rust source (pinned `integration/ergots`) | TS file |
|---|---|
| `ergotree-ir/src/mir/deserialize_context.rs` (struct + wire codec) | `packages/ergoscript/src/wire/mir/deserialize-context.ts` (already present) |
| `ergotree-ir/src/mir/deserialize_register.rs` (struct + wire codec) | `packages/ergoscript/src/wire/mir/deserialize-register.ts` (already present) |
| `ergotree-ir/src/mir/expr.rs:431-438` (`has_deserialize`) | `packages/ergoscript/src/eval/_substitute-deserialize.ts::treeHasDeserialize` |
| `ergotree-ir/src/mir/expr.rs:442-496` (`substitute_deserialize`) | `packages/ergoscript/src/eval/_substitute-deserialize.ts::substituteDeserialize` |
| `ergotree-ir/src/mir/expr.rs:713-728` (`SubstDeserializeError` enum) | `packages/ergoscript/src/eval/errors.ts::EvalErrorCode` (additive: 5 new codes — reviewer correction: lives in `errors.ts:49`, not `eval-context.ts`) |
| `ergotree-interpreter/src/eval.rs:203-250` (substitution dispatch in main eval loop) | `packages/ergoscript/src/eval/eval.ts::evaluate`/`evaluateWith` (additive: pre-eval substitute call) |
| `ergotree-interpreter/src/eval/deserialize_context.rs` (test-only file; no Evaluable impl) | `packages/ergoscript/src/eval/deserialize-context.ts` (defensive throw) |
| `ergotree-interpreter/src/eval/deserialize_register.rs` (test-only file; no Evaluable impl) | `packages/ergoscript/src/eval/deserialize-register.ts` (defensive throw) |

## Execution order

Tasks ordered simplest → most architecturally invasive:

```
T1   PLAN.md committed (overwrites 2i-b plan)
T2   exprTpe coverage (DeserializeContext + DeserializeRegister cases) + new
     EvalErrorCode entries in eval/errors.ts (5 codes; 'deserialize-not-substituted'
     is wired to the defensive-throw arms in T3)
T3   Defensive-throw eval arms wired (DeserializeContext, DeserializeRegister)
     — both throw 'deserialize-not-substituted'; switch cases in eval.ts
T4   substituteDeserialize module — treeHasDeserialize + substitute walker
     — type-checked, no fixtures yet. Uses parseExpr(r, [], [], new Map(), treeVersion)
     for inner Expr (ConstantPlaceholder in inner bytes fails parse — verified post-review).
T5   evaluate / evaluateWith integration. Two sub-steps:
     T5.a  Refactor tryTrivialReduce: extract `tryTrivialReduceExpr(body, ctx)` from
           the current `tryTrivialReduce(tree, ctx)` (which reads tree.body inline at
           evaluate.ts:29-49). The existing function becomes a thin wrapper. This
           refactor is mechanical — no behavior change, all 3720 tests still pass.
     T5.b  Wire the substitute-pre-pass: in evaluate() and evaluateWith(),
           if treeHasDeserialize(tree) call substituteDeserialize then dispatch
           via tryTrivialReduceExpr ?? evalExpr.
T6   DeserializeContext oracle fixtures (8 scenarios) — fixture-gen module + JSON
T7   DeserializeContext RED test (no eval support yet, will assert against fixture)
T8   DeserializeContext GREEN — should pass after T4-T5 land
T9   DeserializeContext mutation tests (Layer C3.a)
T10  DeserializeRegister oracle fixtures (8 scenarios)
T11  DeserializeRegister RED test
T12  DeserializeRegister GREEN — should pass after T4-T5 land
T13  DeserializeRegister mutation tests (Layer C3.a)
T14  facts/ergoscript-eval.md sweep
T15  README + SESSION_CONTEXT + HANDOFF_PROMPT sweep + push
```

**Why T2 lands before T4:** `substituteDeserialize` calls `exprTpe(parsed)` for the type-check. The parsed inner Expr is never a Deserialize* node directly (it came from sigma-serialized bytes), so strictly speaking T2's `exprTpe` cases on DeserializeContext/DeserializeRegister are NOT consumed by T4. BUT — `exprTpe` is also called from many other locations (Apply, BinOp typed comparators, SelectField, etc.). A tree containing a Deserialize* node at any leaf could trip `exprTpe` through one of those paths before substitution runs. Landing T2 first is the safe ordering.

T6-T9 and T10-T13 run sequentially (one arm at a time), per the 2i-b 4-commit-per-arm pattern (fixture-gen → RED → GREEN → mutation).

Expected commit count: ~17-21 commits (T1=1, T2=1, T3=1, T4=1, T5.a=1, T5.b=1, T6-T9=4, T10-T13=4, T14=1, T15=1).

## Risk hotspots

1. **Substitution pass cost-charging.** Sigma-rust charges nothing in `substitute_deserialize`; cost arrives via the inner Expr's eval. Our `substituteDeserialize` must follow the same posture — no `ctx.addCost` calls anywhere in the walker. **Mitigation:** explicit code review of the walker for cost-touching code paths; oracle fixtures assert cost-integer equality, which traps any rogue cost charge.

2. **Inner-Expr parsing with empty constants — RESOLVED (reviewer pass).** Sigma-rust's `sigma_byte_reader::from_bytes(&vec)` creates a reader with no `constant_store`. Initial draft speculated sigma-rust might use lazy placeholder resolution. Reviewer pass verified against `external/sigma-rust/ergotree-ir/src/serialization/constant_placeholder.rs:14-24`: `ConstantPlaceholder::sigma_parse` REJECTS with `ConstantForPlaceholderNotFound` when the store has no entry. Our `parseConstantPlaceholder` at `packages/ergoscript/src/wire/mir/constant-placeholder.ts:43-49` mirrors via `constantTypes`-range-check rejection. **Resolution:** call `parseExpr(r, [], [], new Map(), ctx.treeVersion ?? tree.header.version)` — inner-Expr placeholders fail at parse, mapped to `'deserialize-parse-failed'`. No code change needed beyond using the right arguments.

3. **`tree.has_deserialize()` traversal cost.** Sigma-rust uses `iter().any(|c| matches!(c, ...))` which scans every node. Our `treeHasDeserialize` must do the same; an early-return on first match keeps it O(n) worst-case. **Mitigation:** unit-test the traversal on a tree without deserialize nodes and assert it returns false (no false positives on un-related tags).

4. **Tree-version threading.** Inner Expr is parsed under `ctx.treeVersion`. If `ctx.treeVersion === undefined`, default to `tree.header.version`. The arms reading `ctx.treeVersion` at eval-time (Upcast/Downcast on BigInt; `insertOrUpdate`) already default to V0 on undefined, so inner-Expr eval works correctly. **Mitigation:** explicit fixture with V3 inner Expr in a V3 outer tree (`dc_v3_unsigned_bigint`).

5. **Recursive Deserialize ergonomics.** A `DeserializeContext` whose extension value decodes to a `DeserializeContext` pointing to the SAME var ID creates infinite substitution potential. Sigma-rust's `try_rewrite_bu` does NOT re-walk substituted Expr's interior, so the inner Deserialize stays put and trips at eval-time (no Evaluable impl). Our parallel: the substituted inner Expr's interior is NOT re-walked, and the inner Deserialize* hits `evalDeserializeContext`'s defensive throw `'deserialize-not-substituted'`. **Mitigation:** explicit fixture `dc_throw_recursive`. Expected throw code documented.

6. **Default-Expr type-check (DeserializeRegister).** When the register is absent and `e.default` is provided, sigma-rust still runs `exprTpe(default) === e.tpe` (per the test `eval_reg_is_empty` which expects `ExprTpeError` on a default with wrong type). Our `substituteDeserialize` must validate `exprTpe(default)` too. **Mitigation:** explicit fixture `dr_throw_default_wrong_type`.

7. **P2PK 50-JitCost short-circuit on substituted body.** If the substituted body is a `Const(SSigmaProp, ProveDlog(g))` or a placeholder resolving to one, `tryTrivialReduce` MUST fire (50 JitCost via `EVAL_SIGMA_PROP_CONSTANT`), not the per-arm Const cost. **Mitigation:** explicit fixture with a `Const(SSigmaProp)` inner body; assert cost === 50. Sigma-rust's main eval loop runs `trivial_reduce` on the rewritten body — our integration must do the same.

8. **Sigma-rust's `set_deserialize(true)` flag — RESOLVED (reviewer pass).** Sigma-rust sets a reader-side flag during inner-Expr parse. Reviewer verified against `external/sigma-rust/ergotree-ir/src/serialization/sigma_byte_reader.rs:138-144`: `set_deserialize` mutates only `was_deserialize: bool`, a marker consumed downstream by `sigma_parse_sized` (line 171) to populate a `has_deserialize` hint on the parsed tree. The flag NEVER gates parse behavior. **Resolution:** our parser doesn't need to track this flag. No code change.

## Confidence check (OVERRIDES #2 — crypto/cost path)

**Confidence: 97%** on the substitution-pre-pass architecture (post-reviewer pass).

- The substitute-then-eval architecture is verified against sigma-rust `eval.rs:203-250` and `mir/expr.rs:442-496` directly. No remaining unresolved source-reads.
- The P2PK short-circuit on a substituted SigmaProp body is load-bearing; fixture pins it explicitly (`dc_const_sigmaprop_inner` to be added in T6). Cost-parity verified by oracle assertion on charged JitCost.
- Risk Hotspot 2 (inner-Expr placeholders) RESOLVED — reject at parse per `constant_placeholder.rs:14-24`.
- Risk Hotspot 8 (`set_deserialize` flag) RESOLVED — marker only per `sigma_byte_reader.rs:138-144`.
- One architectural divergence (deliberate, cost-equivalent): we keep `ctx.constants` populated for all paths; sigma-rust's substitute path uses `tree.proposition()` to eagerly substitute placeholders. Same observable behavior. Documented in the Architecture section.

**Escalation status:** none. The 3% residual uncertainty is on the recursive-Deserialize test (`dc_throw_recursive`) — whether it trips `'deserialize-not-substituted'` (defensive throw, our preferred path) or `'cost-limit-exceeded'` (deeper recursion through evalExpr → substitute → ...). Both are acceptable outcomes; behavior validated by fixture during T8/T12 implementation.

## Rollback plan

Single-revert per task. Each commit is independently revertible:

- T1: revert PLAN.md.
- T2-T5: revert the architectural-lift commits. Tree falls back to throwing `'not-implemented-yet'` on Deserialize* arms (current state).
- T6+: revert per-arm commits independently.

If a deep regression surfaces (e.g., the substitute pass mistakenly applies to a tree without Deserialize*), revert T5 and T4. T2-T3 stand alone.

## Cross-references

- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/mir/expr.rs:431-728` — `has_deserialize`, `substitute_deserialize`, `SubstDeserializeError`.
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval.rs:203-250` — main eval-loop substitute dispatch.
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/deserialize_context.rs` — tests only (no Evaluable impl).
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/deserialize_register.rs` — tests only.
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/serialization/constant_placeholder.rs:14-24` — placeholder parse rejection (RH2 resolution).
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/serialization/sigma_byte_reader.rs:138-144` — `set_deserialize` marker (RH8 resolution).
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec.
- `docs/specs/2026-05-21-ergoscript-phase-2i-b-curve-avl-sigma-trivial-design.md` — preceding sibling spec; reference for fixture template.
- `docs/specs/2026-05-20-ergoscript-phase-2i-a-pure-bytes-predefs-design.md` — earlier sibling.
- `facts/ergoscript-eval.md` — public contract for the evaluator surface; updated in T14.

## Reviewer findings applied (2026-05-21)

Spec was reviewed by a general-purpose reviewer subagent dispatched with the explicit instructions: challenge the substitute-pre-pass architecture, verify Risk Hotspots 2 + 8 against source, audit cost-charging claims, audit error taxonomy. Reviewer returned 3 ★★★ critical findings, 4 ★★ moderate findings, 4 ★ minor findings.

**★★★ Critical findings (all applied inline):**

1. **`'deserialize-register-not-found'` is structurally wrong.** Sigma-rust's `substitute_deserialize` (`mir/expr.rs:478-481`) returns `Ok(())` leaving the node unchanged when register absent + default null; the eval-time `'deserialize-not-substituted'` is the canonical path. Spec updated: dropped the substitute-time code (5 new codes, not 6; 59 → 64). Test `eval_reg_is_empty` first sub-case at `deserialize_register.rs:69` uses `try_eval_out` (not `try_eval_with_deserialize`), confirming.

2. **`tryTrivialReduce` signature mismatch.** Current `tryTrivialReduce(tree, ctx)` reads `tree.body` inline (`evaluate.ts:29-49`). Spec updated: T5 split into T5.a (mechanical refactor to extract `tryTrivialReduceExpr(body, ctx)`) and T5.b (the substitute integration). T5.a is no-behavior-change; T5.b is the architectural lift.

3. **Placeholder divergence on substituted body.** Reviewer correctly noted that sigma-rust's `tree.proposition()` eagerly substitutes `ConstantPlaceholder` before `substitute_deserialize`, leaving a placeholder-free body. Our `evaluate` keeps `ctx.constants` populated and `tryTrivialReduce` already handles `ConstPlaceholder` (verified at `evaluate.ts:36-47`). Resolution: this is a deliberate architectural divergence — same observable cost + value, simpler code path. Documented in the Architecture section as "Architectural divergence from sigma-rust (deliberate, cost-equivalent)."

**★★ Moderate findings (folded into spec body):**

1. RH2 (inner-Expr placeholders) RESOLVED — reject at parse, no lazy resolution. Spec section updated.
2. RH8 (`set_deserialize` flag) RESOLVED — marker only, no parse-behavior effect. Spec section updated.
3. Source-mapping table inaccuracy — `EvalErrorCode` lives in `errors.ts`, not `eval-context.ts`. Fixed.
4. `try_eval_out` vs `try_eval_with_deserialize` distinction in fixtures for register-absent-no-default case. Test strategy updated.

**★ Minor findings (acknowledged):**

1. `'deserialize-context-key-not-found'` message includes the id for sigma-rust symmetry. Captured in taxonomy table.
2. Test count estimate adjusted from +78–98 to +60–80.
3. New EvalErrorCode entries belong in `errors.ts`, not `eval-context.ts`. Captured in T2 description.
4. T2/T4-T5 ordering rationale stated explicitly in the Execution order section.

**Additional reviewer recommendation captured:** "Do not require inner reader at EOF" — sigma-rust's `from_bytes(&vec).with_tree_version(...).Expr::sigma_parse` does not assert the reader is exhausted after the Expr parse. Folded into Walking rules.

Net effect: spec confidence raised from 92% to 97%; one critical-flagged divergence reclassified as deliberate-and-cost-equivalent; two deferred Risk Hotspots resolved; execution order refined with explicit T5 split.
