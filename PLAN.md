# Phase 2i-b — Curve + AVL + sigma-trivial predefs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto → halt and declare; #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads]. Per `[[feedback-subagent-explicit-rules]]`, this is load-bearing.

**Spec:** `docs/specs/2026-05-21-ergoscript-phase-2i-b-curve-avl-sigma-trivial-design.md` (HEAD will land at PLAN.md commit)

**Goal:** Wire eval arms for 5 `Expr` variants — `SigmaPropIsProven`, `MultiplyGroup`, `Exponentiate`, `CreateAvlTree`, `TreeLookup`. Closes curve-arithmetic, AVL+ value-constructor, AVL+ single-key lookup, and sigma-trivial frontend-only-throw surfaces.

**Architecture:** Each arm is a single-file handler in `packages/ergoscript/src/eval/`, dispatched from the central `evalExpr` switch in `eval.ts`. Each validated byte-for-byte against sigma-rust's `try_eval_out` oracle via fixture-gen-generated JSON (except `SigmaPropIsProven` which captures the structural-throw shape). TDD red-green cycle per arm: fixture-gen → RED test → GREEN handler → mutation tests → commit. Execute simplest first.

**Tech Stack:** TypeScript (vitest, node + jsdom cross-runtime), `@noble/hashes@2.2.0`, `@noble/curves@2.2.0`, `@ergots/avltree@0.2.0` (workspace), Rust `fixture-gen` crate, sigma-rust branch `integration/ergots`.

**Invariants:** Coverage 60 → 65 `Expr` arms; EvalError codes 55 → 59 (+4 new); method-handler registry unchanged at 44; 34 new oracle fixtures; ~106 new tests (3652 → ~3758).

---

## Task ordering (simplest → most complex)

```
T1   PLAN.md committed (this document)
T2   SigmaPropIsProven   ← structural throw, simplest (3 commits, no mutation tests)
T3   MultiplyGroup       ← Pattern A Fixed(40), thin wrap of pointAdd
T4   Exponentiate        ← Pattern A Fixed(900), pointMul + identity-base guard
T5   CreateAvlTree       ← 4-input value constructor, no inline cost
T6   TreeLookup          ← thin wrap over verifyAvlLookup, no inline cost
T7   facts/ergoscript-eval.md sweep
T8   README + SESSION_CONTEXT + HANDOFF_PROMPT sweep + push
```

---

## Task 1: Commit PLAN.md

**Files:**
- Create: `/home/mwaddip/projects/ergots/PLAN.md` (this file, overwrites previous 2i-a plan)

- [ ] **Step 1: Stage and commit**

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): overwrite PLAN.md with phase 2i-b execution plan

Per HANDOFF_PROMPT.md convention: PLAN.md is the in-flight phase's task list,
overwritten at each phase boundary. Spec at
docs/specs/2026-05-21-ergoscript-phase-2i-b-curve-avl-sigma-trivial-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: 1 file changed, ~500+ insertions.

---

## Task 2: `SigmaPropIsProven` — frontend-only structural throw (3 commits)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/sigma_prop_is_proven.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (add `pub mod sigma_prop_is_proven;`)
- Modify: `fixture-gen/src/main.rs` (append generate-and-write block)
- Create: `packages/ergoscript/test/fixtures/eval/sigma-prop-is-proven.json` (output of fixture-gen)
- Create: `packages/ergoscript/src/eval/sigma-prop-is-proven.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add import + switch case)
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (add `'sigma-prop-is-proven-no-eval'` to `EvalErrorCode` union)
- Create: `packages/ergoscript/test/eval/sigma-prop-is-proven.test.ts`

**Source:** `ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25` — structural throw, no eval of input, no cost.

**Special property:** This arm has NO mutation tests (no input bytes to mutate) — T2 commit shape is 3 (fixture-gen + RED + GREEN), not the 4-commit T3-T6 pattern.

- [ ] **Step 1: Write fixture-gen module**

The fixture captures the `EvalError::Misc` shape, not a value. Use `try_eval_out` and assert it returns an `Err`; capture the error message in the JSON oracle.

```rust
//! SigmaPropIsProven arm — captures the structural-throw shape.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25
//!   Always returns Err(EvalError::Misc("SigmaPropIsProven has no interpreter eval..."))
//!   regardless of input. _env and _ctx are unused.

// Build a tree with body = SigmaPropIsProven(Const(SSigmaProp, ProveDlog(generator)))
// (the input doesn't matter since it's never evaluated; we just need a syntactically valid tree).
//
// Expected JSON shape: { "name": "...", "tree_bytes_hex": "...", "opts_json": {},
//                       "expected_error": "SigmaPropIsProven has no interpreter eval" }
//
// Single scenario: sigma_prop_is_proven_const_sigma_prop_input
```

Helper modification: Add an `expected_error: Option<String>` field to the common fixture type if not already present (mirrors 2i-a's throw-fixture pattern). Alternatively use a separate `ThrowFixture` struct.

- [ ] **Step 2: Regenerate + commit fixture**

```bash
cd fixture-gen
cargo run --release
cd ..
git diff packages/ergoscript/test/fixtures/eval/sigma-prop-is-proven.json
git add fixture-gen/src/cmds/ergoscript/eval/sigma_prop_is_proven.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/sigma-prop-is-proven.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): SigmaPropIsProven throw-shape fixture

Captures sigma-rust's EvalError::Misc throw shape. The arm has no value-side
output — try_eval_out returns an Err result; we serialize the error message
to JSON as the oracle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: RED — write TS oracle test against the fixture**

Create `packages/ergoscript/test/eval/sigma-prop-is-proven.test.ts`. The test loads the fixture, parses the tree, calls `evaluate`, asserts:
1. It throws `EvalError`.
2. `.code === 'sigma-prop-is-proven-no-eval'`.
3. `.message` substring-matches the fixture's `expected_error`.

```ts
import { describe, it, expect } from 'vitest'
import { evaluate } from '../../src/index.js'
import { parseTree } from '../../src/wire/parse-tree.js'
import { EvalError } from '../../src/eval/eval-context.js'
import { hexToBytes } from '../helpers.js'
import fixture from '../fixtures/eval/sigma-prop-is-proven.json'

describe('SigmaPropIsProven eval', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      expect(() => evaluate(tree, {})).toThrow(EvalError)
      try { evaluate(tree, {}) } catch (e) {
        expect((e as EvalError).code).toBe('sigma-prop-is-proven-no-eval')
        expect((e as Error).message).toContain('SigmaPropIsProven has no interpreter eval')
      }
    })
  }
})
```

Run test → should FAIL with `'not-implemented-yet'` because the arm isn't wired yet.

```bash
cd packages/ergoscript && npx vitest run test/eval/sigma-prop-is-proven.test.ts
```

Commit:

```bash
git add packages/ergoscript/test/eval/sigma-prop-is-proven.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): RED — SigmaPropIsProven oracle test (no handler yet)

Test fails with 'not-implemented-yet' until T2's GREEN step wires the handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: GREEN — implement handler + wire into eval.ts**

Create `packages/ergoscript/src/eval/sigma-prop-is-proven.ts`:

```ts
/**
 * SigmaPropIsProven eval arm — structural throw (no eval, no cost).
 *
 * Source: ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25
 *
 * Op-code 95 is reserved in the IR for byte-match parity with Scala
 * sigmastate, whose typer rewrites `prop.isProven` to a SigmaPropIsProven
 * node. The AOT graph-IR rewrite removes the node before evaluation; the
 * bytecode interpreter therefore receives a node that always throws.
 *
 * Sigma-rust's eval is `(_env, _ctx) → Err(Misc(...))` — both args
 * underscored, no read of `self.input`, no cost charged. We mirror.
 */
import type { SigmaPropIsProven } from '../mir/types.js'
import type { Env } from './env.js'
import type { EvalContext } from './eval-context.js'
import { EvalError } from './eval-context.js'

export function evalSigmaPropIsProven(
  _e: SigmaPropIsProven,
  _env: Env,
  _ctx: EvalContext,
): never {
  throw new EvalError(
    'SigmaPropIsProven has no interpreter eval (frontend-only — Scala graph-IR rewrites elide it; sigma-rust mirrors as a structural throw)',
    'sigma-prop-is-proven-no-eval',
  )
}
```

Modify `packages/ergoscript/src/eval/eval-context.ts` — add `'sigma-prop-is-proven-no-eval'` to the `EvalErrorCode` union.

Modify `packages/ergoscript/src/eval/eval.ts` — add the switch case:

```ts
import { evalSigmaPropIsProven } from './sigma-prop-is-proven.js'
// ...
case 'SigmaPropIsProven': return evalSigmaPropIsProven(e, env, ctx)
```

**Verification commands** (REQUIRED — OVERRIDES rule #6):

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json                          # CLEAN
cd packages/ergoscript && npx vitest run test/eval/sigma-prop-is-proven.test.ts  # PASS
cd packages/ergoscript && npx vitest run                                        # all ergoscript pass
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts      # jsdom pass
```

Commit:

```bash
git add packages/ergoscript/src/eval/sigma-prop-is-proven.ts \
        packages/ergoscript/src/eval/eval-context.ts \
        packages/ergoscript/src/eval/eval.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): SigmaPropIsProven eval arm (frontend-only structural throw)

Wires opcode 95 — Scala typer's `prop.isProven` lowering. AOT graph-IR
rewrite elides the node before evaluation; sigma-rust mirrors as a
structural throw. We mirror in TS.

NO eval of e.input, NO cost charged. New EvalErrorCode
'sigma-prop-is-proven-no-eval' (55 → 56 codes; eval arm coverage 60 → 61).

Layer C1 oracle fixture validates the throw shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Step 5 SKIPPED — no mutation testing.** The arm has no input bytes to mutate.

---

## Task 3: `MultiplyGroup` — Pattern A, Fixed(40), 2 GroupElement inputs (4 commits)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/multiply_group.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` + `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/multiply-group.json`
- Create: `packages/ergoscript/src/eval/multiply-group.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (add `'group-op-input-not-group-element'`)
- Create: `packages/ergoscript/test/eval/multiply-group.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/multiply-group.test.ts`

**Source:** `ergotree-interpreter/src/eval/multiply_group.rs:9-29` + `ergo-chain-types/src/ec_point.rs:74-80` (Mul<&EcPoint> = ProjectivePoint::add).

**Cost pattern:** A `Fixed(40)` — charge BEFORE eval-children.

**6 fixtures:** gen+gen, gen+identity, identity+identity, random+random, asymmetric (point + its inverse), 2 throw cases (non-GroupElement left, non-GroupElement right).

- [ ] **Step 1: Write fixture-gen module**

```rust
//! MultiplyGroup arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/multiply_group.rs:9-29
//!   ctx.add_jit_cost(40)?;
//!   let left_v = self.left.eval(env, ctx)?;
//!   let right_v = self.right.eval(env, ctx)?;
//!   match (&left_v, &right_v) {
//!       (Value::GroupElement(l), Value::GroupElement(r)) => Ok(((**l) * r).into()),
//!       _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! Note: `(**l) * r` dispatches to Mul<&EcPoint> at ec_point.rs:74-80, which
//! is point ADDITION on the curve (multiplicative-notation group).
//!
//! Cost ordering: Pattern A — BEFORE eval-child.

// Scenarios (6):
// - mg_gen_gen          : g + g   (point doubling)
// - mg_gen_identity     : g + 0   = g
// - mg_identity_identity: 0 + 0   = 0
// - mg_random_random    : random P + random Q (force_any_val each)
// - mg_asymmetric       : g + (-g) = 0  (additive inverse)
```

Build the trees, evaluate via `try_eval_out`, capture value + cost. Throw-path fixtures are constructed synthetically (non-GroupElement input via direct AST manipulation) and assert `try_eval_out` returns `Err`.

- [ ] **Step 2: Regenerate + commit fixture**

```bash
cd fixture-gen && cargo run --release && cd ..
git diff packages/ergoscript/test/fixtures/eval/multiply-group.json
git add fixture-gen/ packages/ergoscript/test/fixtures/eval/multiply-group.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): MultiplyGroup oracle fixtures (6 scenarios)

Pattern A Fixed(40). Group "multiply" = curve addition under multiplicative
notation (ec_point.rs:74-80 Mul<&EcPoint> = ProjectivePoint::add).

Scenarios: gen+gen (point doubling), gen+identity, identity+identity,
random+random, asymmetric (g + -g = identity), non-GroupElement inputs (left+right throw paths).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: RED — write TS oracle test**

`packages/ergoscript/test/eval/multiply-group.test.ts` — same pattern as the 2i-a oracle tests. Load fixture, parse tree, evaluate, assert value bytes + cost integer.

Run test → should FAIL with `'not-implemented-yet'`.

Commit:

```
test(ergoscript): RED — MultiplyGroup oracle test (no handler yet)
```

- [ ] **Step 4: GREEN — implement handler + wire**

```ts
/**
 * MultiplyGroup eval arm — Pattern A, Fixed(40).
 *
 * Source: ergotree-interpreter/src/eval/multiply_group.rs:9-29
 *         ergo-chain-types/src/ec_point.rs:74-80 (Mul<&EcPoint> = ProjectivePoint::add)
 *
 * Group operation under multiplicative notation: `left * right` on EcPoint
 * dispatches to point ADDITION. We use `pointAdd` (thin wrap of @noble/curves
 * Point.add) to match exactly.
 */
import type { MultiplyGroup } from '../mir/types.js'
import type { Env } from './env.js'
import type { EvalContext } from './eval-context.js'
import { EvalError } from './eval-context.js'
import { evalExpr } from './eval.js'
import { decodePoint, encodePoint, pointAdd } from '../crypto/secp256k1.js'

export function evalMultiplyGroup(e: MultiplyGroup, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(40)
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  if (leftV.kind !== 'GroupElement') {
    throw new EvalError(
      `MultiplyGroup: expected GroupElement left input, got '${leftV.kind}'`,
      'group-op-input-not-group-element',
    )
  }
  if (rightV.kind !== 'GroupElement') {
    throw new EvalError(
      `MultiplyGroup: expected GroupElement right input, got '${rightV.kind}'`,
      'group-op-input-not-group-element',
    )
  }
  const left = decodePoint(leftV.value)
  const right = decodePoint(rightV.value)
  const result = pointAdd(left, right)
  return { kind: 'GroupElement', value: encodePoint(result) }
}
```

Modify `eval-context.ts` to add `'group-op-input-not-group-element'`. Modify `eval.ts` to add the case.

**Verification commands** (REQUIRED):

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json                            # CLEAN
cd packages/ergoscript && npx vitest run test/eval/multiply-group.test.ts        # PASS
cd packages/ergoscript && npx vitest run                                          # all ergoscript pass
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts        # jsdom pass
```

Commit:

```
feat(ergoscript): MultiplyGroup eval arm (Pattern A Fixed(40))
```

- [ ] **Step 5: Mutation testing (Layer C3.a)**

Create `packages/ergoscript/test/eval-mutation/multiply-group.test.ts`. Use the existing harness from phase 2h-e. Target ≥ 90% kill rate. Mutate the 33-byte SEC1 GroupElement bytes — most mutations should trip `decodePoint` (off-curve check) or produce a different point (byte-equal kill).

Commit:

```
test(ergoscript): MultiplyGroup mutation testing (Layer C3.a)
```

---

## Task 4: `Exponentiate` — Pattern A, Fixed(900), GroupElement base + BigInt exponent (4 commits)

**Files:**
- Same shape as T3: fixture-gen module + JSON + handler + test + mutation test
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (add `'predef-input-not-bigint'`)

**Source:** `ergotree-interpreter/src/eval/exponentiate.rs:13-33` + `ergo-chain-types/src/ec_point.rs:111-119` (identity short-circuit).

**Cost pattern:** A `Fixed(900)` — charge BEFORE eval-children.

**CRITICAL — explicit identity-base guard required.** Per spec Risk Hotspot 4: `@noble/curves@2.2.0` `Point.multiply` does NOT short-circuit on `Point.ZERO`. Our handler must guard explicitly.

**9 fixtures:** gen^1, gen^0, gen^k random, identity^k (validates the guard), gen^-1, gen^(n-1), gen^n (≡ identity), gen^(2^255 - 1) i256 max, gen^(-2^255) i256 min, plus 2 throw cases.

- [ ] **Step 1: Write fixture-gen module**

```rust
//! Exponentiate arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/exponentiate.rs:13-33
//!   ctx.add_jit_cost(900)?;
//!   let left_v = self.left.eval(env, ctx)?.try_extract_into()?;
//!   let right_v = self.right.eval(env, ctx)?.try_extract_into()?;
//!   exponentiate(left_v, right_v)
//!
//! Then ec_point::exponentiate at ec_point.rs:111-119:
//!   if !is_identity(base) { EcPoint(base.0 * exponent) } else { *base }
//!
//! Pattern A — cost BEFORE eval-children. Identity-base short-circuits.

// Scenarios (9):
// - exp_gen_1            : g^1   = g
// - exp_gen_0            : g^0   = identity
// - exp_gen_random       : g^k random in-range (via force_any_val)
// - exp_identity_k       : identity^k = identity (validates TS guard)
// - exp_gen_minus_1      : g^-1  = -g (curve inverse)
// - exp_gen_n_minus_1    : g^(n-1) = -g (same as above; oracle equality validates)
// - exp_gen_n            : g^n   = identity (mod n reduction → 0 → identity)
// - exp_gen_i256_max     : g^(2^255 - 1) — largest positive i256
// - exp_gen_i256_min     : g^(-2^255)    — most negative i256
// - throw_non_grp_base   : (synthetic) base = SLong instead of GroupElement
// - throw_non_bigint_exp : (synthetic) exponent = SInt instead of BigInt256
```

- [ ] **Step 2: Regenerate + commit fixture**

```
test(fixture-gen): Exponentiate oracle fixtures (9 scenarios + 2 throws)
```

- [ ] **Step 3: RED**

```
test(ergoscript): RED — Exponentiate oracle test (no handler yet)
```

- [ ] **Step 4: GREEN — implement handler with REQUIRED identity-base guard**

```ts
/**
 * Exponentiate eval arm — Pattern A, Fixed(900).
 *
 * Source: ergotree-interpreter/src/eval/exponentiate.rs:13-33
 *         ergo-chain-types/src/ec_point.rs:111-119 (identity-base short-circuit)
 *         ergotree-ir/src/sigma_protocol/dlog_group.rs:60-64 (bigint256_to_scalar = mod n)
 *
 * **CRITICAL identity-base guard.** Per spec Risk Hotspot 4: @noble/curves@2.2.0
 * Point.multiply (weierstrass.ts:1067) does NOT short-circuit on Point.ZERO.
 * Only multiplyUnsafe (line 1103) does. Our pointMul calls Point.multiply.
 * So pointMul(Point.ZERO, k) executes wNAF on identity → UB / off-curve.
 * Sigma-rust short-circuits identity bases explicitly. We must mirror.
 */
import type { Exponentiate } from '../mir/types.js'
import type { Env } from './env.js'
import type { EvalContext } from './eval-context.js'
import { EvalError } from './eval-context.js'
import { evalExpr } from './eval.js'
import { decodePoint, encodePoint, pointMul } from '../crypto/secp256k1.js'

export function evalExponentiate(e: Exponentiate, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(900)
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  if (leftV.kind !== 'GroupElement') {
    throw new EvalError(
      `Exponentiate: expected GroupElement base, got '${leftV.kind}'`,
      'group-op-input-not-group-element',
    )
  }
  if (rightV.kind !== 'BigInt') {
    throw new EvalError(
      `Exponentiate: expected BigInt exponent, got '${rightV.kind}'`,
      'predef-input-not-bigint',
    )
  }
  const base = decodePoint(leftV.value)
  // Mirror sigma-rust's `if !is_identity(base) { ... } else { *base }` short-circuit.
  // REQUIRED — @noble/curves Point.multiply does not handle identity bases.
  if (base.is0()) {
    return { kind: 'GroupElement', value: new Uint8Array(33) }  // identity (Ergo: 33 zero bytes)
  }
  const result = pointMul(base, rightV.value)  // pointMul reduces mod n internally
  return { kind: 'GroupElement', value: encodePoint(result) }
}
```

**Verification:** the `exp_identity_k` fixture exercises the guard. Oracle expects 33 zero bytes; TS handler returns 33 zero bytes via the guard.

```
feat(ergoscript): Exponentiate eval arm (Pattern A Fixed(900) + identity-base guard)
```

- [ ] **Step 5: Mutation testing**

Mutate 33-byte GroupElement bytes and BigInt bytes. Target ≥ 90% kill rate.

```
test(ergoscript): Exponentiate mutation testing (Layer C3.a)
```

---

## Task 5: `CreateAvlTree` — 4-input constructor, no inline cost (4 commits)

**Files:**
- Same shape as T3/T4
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (add `'create-avl-tree-shape-mismatch'`)
- May modify: `packages/ergoscript/src/eval/_byte-coll.ts` if `collByteToUint8Array` needs the `'create-avl-tree-shape-mismatch'` override (use default `'predef-input-not-byte-array'` for digest non-Coll case)

**Source:** `ergotree-interpreter/src/eval/create_avl_tree.rs:15-41` + `ergotree-ir/src/mir/avl_tree_data.rs::AvlTreeFlags::parse` (canonicalizes to 3 bits).

**Cost pattern:** None inline — children-only cost.

**CRITICAL — AvlTreeFlags canonicalization (`flagsV.value & 0x07`).** Per spec Risk Hotspot 5b: `AvlTreeFlags::parse` strips reserved bits 3..7. TS handler must apply `& 0x07` to match the sigma-rust in-memory AvlTreeData (oracle equality target). The wire-parse path (2h-b) preserves all 8 bits — different path, different behavior, both correct.

**Keylength bit-cast (`>>> 0`).** Per spec Risk Hotspot 5: sigma-rust does `i32 as u32`, a bit-cast. TS `>>> 0` matches.

**11 fixtures:** 3 happy (flags-off+None, flags-on+Some(5), mid-flags+Some(0)) + 4 edge (valueLength=2^31-1, negative-keyLength, large-keyLength, flags=0xFF→0x07) + 4 throw (digest wrong-length, non-Byte flags, non-Coll digest, non-Int keyLength).

- [ ] **Step 1: Write fixture-gen module**

```rust
//! CreateAvlTree arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/create_avl_tree.rs:15-41
//!   No add_jit_cost call — children-only.
//!   Eval order: flags → digest → keyLength → optional valueLength.
//!   AvlTreeFlags::parse canonicalizes to bits 0..2 (mir/avl_tree_data.rs).
//!   ADDigest::try_from enforces length === 33.
//!
//! Pattern: none inline.
//! Output: Value::AvlTree(Box<AvlTreeData>).

// Scenarios (11):
// Happy:
//   cat_flags_0_no_vlen        : flags=0, digest=mid, keyLength=32, valueLength=None
//   cat_flags_7_vlen_5         : flags=7, digest=mid, keyLength=32, valueLength=Some(5)
//   cat_flags_3_vlen_0         : flags=3, digest=mid, keyLength=32, valueLength=Some(0)
// Edge:
//   cat_valuelen_i32_max       : flags=1, valueLength=Some(i32::MAX)
//   cat_negative_keylength     : flags=0, keyLength=i32::MIN  (bit-cast → huge u32)
//   cat_large_keylength        : flags=0, keyLength=2147483647 (i32::MAX → u32 2147483647)
//   cat_flags_FF_canonicalize  : flags=0xFFu8 as i8 (= -1) → AvlTreeFlags(0x07) ★
// Throw:
//   cat_throw_digest_32bytes   : digest=32-byte (instead of 33) → EvalError::AvlTree
//   cat_throw_non_byte_flags   : (synthetic) flags=SInt
//   cat_throw_non_coll_digest  : (synthetic) digest=SInt
//   cat_throw_non_int_keylength: (synthetic) keyLength=SLong
```

★ The `cat_flags_FF_canonicalize` fixture is the canary against a regression dropping the `& 0x07` mask. Oracle's expected `tree_flags` is 0x07 for input 0xFF.

- [ ] **Step 2-5: regenerate fixture → RED → GREEN → mutation tests**

Handler skeleton matches the spec's pseudocode (§"Per-arm handler design"). Wire into eval.ts.

```
test(fixture-gen): CreateAvlTree oracle fixtures (11 scenarios)
test(ergoscript): RED — CreateAvlTree oracle test (no handler yet)
feat(ergoscript): CreateAvlTree eval arm (no inline cost; flags canonicalized)
test(ergoscript): CreateAvlTree mutation testing (Layer C3.a)
```

**Verification:** the `cat_flags_FF_canonicalize` fixture is consensus-critical — its presence asserts the `& 0x07` mask. If the handler accidentally uses `& 0xff`, this single test fails.

---

## Task 6: `TreeLookup` — thin wrap over verifyAvlLookup, no inline cost (4 commits)

**Files:**
- Same shape as T5
- May reuse existing `_avltree-adapter.ts::avlTreeDataToConfig`

**Source:** `ergotree-interpreter/src/eval/tree_lookup.rs:20-65`.

**Cost pattern:** None inline.

**Double-null semantic:** per spec Risk Hotspot 6 — `verifyAvlLookup` returns:
- `null` → proof construct failure → TS throws `'avl-tree-proof-failed'`
- `{ value: null }` → key absent → TS returns `Option None`
- `{ value: Uint8Array }` → key found → TS returns `Option Some<Coll[Byte]>`

**7 fixtures:** 3 happy (key-found at low key, key-absent in 10-leaf, single-leaf-tree found) + 1 edge (key-found at boundary high key in balanced-10) + 3 throw (malformed-proof, wrong-digest, non-AvlTree receiver).

- [ ] **Step 1: Write fixture-gen module**

```rust
//! TreeLookup arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/tree_lookup.rs:20-65
//!   No add_jit_cost — children-only.
//!   Eval order: tree → key → proof → BatchAVLVerifier::new → perform_one_operation(Lookup).
//!
//! Returns Value::Opt:
//!   Ok(opt) → Option (None or Some(Coll[Byte]))
//!   Err(_)  → EvalError::AvlTree("Tree proof is incorrect ...")
//!
//! Use BatchAVLProver in fixture-gen (mirrors create_avl_tree.rs:65-93 pattern)
//! to build the source-of-truth pre-state tree + proof.

// Scenarios (7):
// - tl_found_in_10_leaf_low_key       : Insert keys 0..10, lookup key=2 → Some(...)
// - tl_absent_in_10_leaf              : Insert keys 0..10, lookup key=100 → None
// - tl_single_leaf_found              : Insert one entry, lookup that key
// - tl_found_in_10_leaf_boundary_key  : Insert keys 0..10, lookup key=9 → Some(...)
// - tl_throw_malformed_proof          : Insert keys 0..10, mutate proof bytes → throws
// - tl_throw_wrong_digest             : Insert keys 0..10, modify starting_digest → throws
// - tl_throw_non_avl_receiver         : (synthetic) tree=SInt → throws
```

- [ ] **Step 2-5: regenerate fixture → RED → GREEN → mutation tests**

Handler matches spec pseudocode. Wire into eval.ts. No new error codes — reuses `'avl-tree-obj-not-avl-tree'` + `'predef-input-not-byte-array'` + `'avl-tree-proof-failed'`.

```
test(fixture-gen): TreeLookup oracle fixtures (7 scenarios)
test(ergoscript): RED — TreeLookup oracle test (no handler yet)
feat(ergoscript): TreeLookup eval arm (no inline cost; thin verifyAvlLookup wrap)
test(ergoscript): TreeLookup mutation testing (Layer C3.a)
```

---

## Task 7: facts/ergoscript-eval.md sweep (1 commit)

**Files:**
- Modify: `/home/mwaddip/projects/ergots/facts/ergoscript-eval.md`
- Modify: `/home/mwaddip/projects/ergots/facts/ergoscript.md` (meta hub coverage table)

**Changes:**

1. Add 2i-b changelog entry under "Scope (per-phase changelog)":

```markdown
**Phase 2i-b — Curve + AVL + sigma-trivial predefs** (additive):

- 5 new eval arms wired (coverage 60 → 65 of ~70 `Expr` arms):
  - `SigmaPropIsProven` — structural throw, no eval, no cost. Mirrors sigma-rust frontend-only-throw pattern.
  - `MultiplyGroup` — Pattern A Fixed(40). Group operation under multiplicative notation = point addition on curve. Reuses existing `pointAdd` adapter.
  - `Exponentiate` — Pattern A Fixed(900). Scalar multiplication. **REQUIRES explicit identity-base guard** — @noble/curves@2.2.0 `Point.multiply` does not short-circuit `Point.ZERO`.
  - `CreateAvlTree` — no inline cost, children-only. 4-input constructor. **AvlTreeFlags canonicalized to bits 0..2** (`flagsV.value & 0x07`) mirroring sigma-rust `AvlTreeFlags::parse → new`. KeyLength bit-cast `>>> 0` (matches sigma-rust `i32 as u32`).
  - `TreeLookup` — no inline cost, children-only + verifier delegation. Thin wrap over `@ergots/avltree`'s `verifyAvlLookup`. Double-null semantic: outer null = throw, inner null = Option None.
- 4 new `EvalError` codes (55 → 59):
  - `'sigma-prop-is-proven-no-eval'` (T2 — frontend-only structural throw)
  - `'group-op-input-not-group-element'` (T3 + T4 — shared by MultiplyGroup and Exponentiate)
  - `'predef-input-not-bigint'` (T4 — Exponentiate's BigInt exponent)
  - `'create-avl-tree-shape-mismatch'` (T5 — compact code covering flags/keyLength/valueLength type errors)
- 0 new method-handler-registry entries (44 unchanged).
- Two pre-existing TS-from-sigma-rust divergences acknowledged (neither introduced by 2i-b):
  - DecodePoint identity convention (also affects MultiplyGroup and Exponentiate base decode).
  - `key_length` bit-cast: sigma-rust silently accepts negative-i32 → huge-u32 keyLength; TS mirrors.

**Phase 2i-b COMPLETE.** Method handler registry: 44 entries (unchanged). EvalError codes: 59. Eval arm coverage: 65 of ~70. Ergoscript test count: ~3180. Total monorepo: ~3758.
```

2. Update the `EvalError` taxonomy section with the 4 new codes (one section per arm or grouped under "Phase 2i-b codes"):

```markdown
### Phase 2i-b codes (curve + AVL + sigma-trivial predefs)

- **`'sigma-prop-is-proven-no-eval'`** — `SigmaPropIsProven` arm always throws structurally. No `e.input` evaluation, no cost charged. Mirrors sigma-rust `sigma_prop_is_proven.rs:22-24` `Misc("SigmaPropIsProven has no interpreter eval...")`.
- **`'group-op-input-not-group-element'`** — `MultiplyGroup` (both operands) and `Exponentiate` (base) when input `kind !== 'GroupElement'`. Distinct from `'sigma-prop-input-not-group-element'` (2g-medium) which is for sigma-prop creation arms.
- **`'predef-input-not-bigint'`** — `Exponentiate` arm when exponent `kind !== 'BigInt'`. Future arms in the `ModQ` family (phase 2i-d) will reuse.
- **`'create-avl-tree-shape-mismatch'`** — `CreateAvlTree` arm. Compact code covering 3 throw paths: non-Byte flags, non-Int keyLength, non-Int valueLength. `.message` carries the specific field name.
```

3. Update the Coverage summary table in `facts/ergoscript.md` (meta hub):
   - "Evaluator: 60 of ~70" → "65 of ~70"
   - Test count: 2922 + 156 + 245 + 177 = 3500 → 3074 + 156 + 245 + 177 = 3652 → ~3180 + 156 + 245 + 177 = ~3758
   - EvalError codes: 48 → 59 (was 55 post-2i-a, now 59 post-2i-b)

- [ ] **Step 1: Apply edits to both facts files**

- [ ] **Step 2: Commit**

```bash
git add facts/ergoscript-eval.md facts/ergoscript.md
git commit -m "$(cat <<'EOF'
docs(ergoscript): facts sweep for phase 2i-b (60->65 arms, +4 EvalError codes)

Per-phase changelog entry for 2i-b. Adds 5 new arms: SigmaPropIsProven,
MultiplyGroup, Exponentiate, CreateAvlTree, TreeLookup. Adds 4 new EvalError
codes. Method-handler registry unchanged at 44. Documents 2 pre-existing
TS-from-sigma-rust divergences (DecodePoint identity convention; keyLength
bit-cast).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: README + SESSION_CONTEXT + HANDOFF_PROMPT sweep + push (1 commit + push)

**Files:**
- Modify: `README.md` (Packages table — ergoscript row test counts, eval arm coverage, recent-phase line)
- Modify: `SESSION_CONTEXT.md` (overwrite with phase 2i-b summary; mirror 2i-a structure)
- Modify: `HANDOFF_PROMPT.md` (next-phase queue: 2i-c becomes the natural next step)

- [ ] **Step 1: Apply edits to all three files**

- [ ] **Step 2: Verify final state (REQUIRED — OVERRIDES rule #6)**

```bash
# TypeScript clean per-package
npx tsc --noEmit -p packages/scorex/tsconfig.json                          # CLEAN
npx tsc --noEmit -p packages/nipopow/tsconfig.json                         # CLEAN
npx tsc --noEmit -p packages/avltree/tsconfig.json                         # CLEAN
npx tsc --noEmit -p packages/ergoscript/tsconfig.json                      # CLEAN

# All tests pass under node
node_modules/.bin/vitest run packages/                                      # all pass

# All tests pass under jsdom (cross-runtime)
cd packages/scorex && npx vitest run --config vitest.browser.config.ts     # PASS
cd packages/nipopow && npx vitest run --config vitest.browser.config.ts    # PASS
cd packages/avltree && npx vitest run --config vitest.browser.config.ts    # PASS
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts # PASS

# Fixture determinism
cd fixture-gen && cargo run --release                                       # zero diff after re-run
git diff --exit-code packages/                                              # BYTE_IDENTICAL
git status                                                                  # CLEAN (modulo audit20260519/)
```

- [ ] **Step 3: Commit**

```bash
git add README.md SESSION_CONTEXT.md HANDOFF_PROMPT.md
git commit -m "$(cat <<'EOF'
docs: refresh README + SESSION_CONTEXT + HANDOFF_PROMPT for phase 2i-b

Phase 2i-b COMPLETE. 5 new eval arms (SigmaPropIsProven, MultiplyGroup,
Exponentiate, CreateAvlTree, TreeLookup). Eval arm coverage 60 → 65 of ~70.
EvalError codes 55 → 59. Method-handler registry unchanged at 44. Total
tests ~3758. Next phase: 2i-c (DeserializeContext + DeserializeRegister
— recursive-eval architectural lift).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push**

```bash
git push origin master
```

---

## Risk hotspots (carried from spec)

1. **Identity-point arithmetic** — explicit guard in `Exponentiate`; oracle fixture `exp_identity_k` validates.
2. **BigInt256 → scalar reduction** — `pointMul`'s internal mod-n reduction matches sigma-rust's `bigint256_to_scalar`. Oracle fixtures cover negative exponents, exact i256 bounds, exponents ≡ 0 mod n.
3. **DecodePoint adapter divergence** — pre-existing, inherited from 2i-a; not introduced by 2i-b. No follow-up in this slice.
4. **`pointMul(Point.ZERO, k)` UB** — addressed via explicit guard in `evalExponentiate` (verified against @noble/curves source — line 1067 has no short-circuit).
5. **`CreateAvlTree` keyLength bit-cast** — `>>> 0` matches `i32 as u32`. Oracle fixture for negative keyLength validates.
5b. **`CreateAvlTree` flags canonicalization** — `& 0x07` mirrors `AvlTreeFlags::parse → new` stripping bits 3..7. Oracle fixture `cat_flags_FF_canonicalize` is the canary.
6. **`TreeLookup` double-null** — outer null = throw, inner null = Option None. Fixture matrix distinguishes both.
7. **`SigmaPropIsProven` fixture-gen** — captures `{ "expected_error": "..." }` shape; TS test branches on error-field presence.

---

## Expected outcome

- Eval-arm coverage: 60 → 65
- EvalError codes: 55 → 59 (+4)
- Method-handler registry: 44 (unchanged)
- Ergoscript test count: 3074 → ~3180
- Total monorepo tests: 3652 → ~3758
- Commits: ~22 (T1=1, T2=3, T3-T6=4 each, T7=1, T8=1)
- Working tree clean modulo gitignored `audit20260519/`
- Origin pushed
