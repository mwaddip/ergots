# ErgoScript Interpreter — Phase 2c Design Spec

**Status:** Draft
**Date:** 2026-05-14
**Package:** `@mwaddip/ergots-ergoscript` (phase 2c — operators, first slice)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec)
**Sister spec:** `docs/specs/2026-05-14-ergoscript-phase-2b-design.md` (phase 2b — evaluator chassis + 8 arms)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-14 (post-2b)

## Goal

Ship the first half of the operator surface — every `BinOp` sub-op plus
two unary arms — wired into phase 2b's central exhaustive dispatch. By
the end of 2c, real ErgoScript trees that combine integer arithmetic,
boolean logic, comparison, and bitwise operations evaluate against the
sigma-rust oracle byte-for-byte. The other half of the operator surface
(numeric-polymorphism arms, Coll[Boolean] aggregators, `Atleast`) lands
in a follow-up slice; deliberately split to keep each phase in
phase 2b's 3–5-hour rhythm and let the numeric-polymorphism work cluster
into one focused slice rather than mixing concerns.

Concretely, 6 new evaluator arm modules cover 24 distinct evaluable
behaviours:

- `BinOp` central dispatcher + 4 per-family sub-arms (`evalArithOp`,
  `evalRelationOp`, `evalLogicalOp`, `evalBitOp`) covering all 22 BinOp
  sub-ops.
- `evalLogicalNot` — unary `!` on Boolean.
- `evalBoolToSigmaProp` — wraps a Boolean as `TrivialProp(b)`
  SigmaBoolean leaf; SigmaProp stays opaque (no structural decode).

Public surface unchanged from v0.2.0 — phase 2c is purely additive
internal arm growth. No npm publish.

## Non-goals (phase 2c)

- **Numeric-polymorphism arms.** `Negation`, `BitInversion`, `Upcast`,
  `Downcast` — they share `SNumeric` machinery and cluster naturally
  with the Coll[Boolean] aggregators in the next slice.
- **Coll[Boolean] aggregators.** `And`/`Or`/`Xor` over `Coll[Boolean]`,
  plus `Atleast` over `Coll[SigmaProp]` — deferred to the next slice
  alongside the numeric-poly arms.
- **Structured SigmaProp.** `SValue.kind: 'SigmaProp'` stays opaque
  (`{ raw: Uint8Array }`). Structural decode of `SigmaBoolean` lands
  in phase 2g (sigma protocol). `BoolToSigmaProp` constructs canonical
  `TrivialProp` wire bytes via a localised helper; no structural
  representation introduced.
- **Box/AvlTree equality.** `Eq`/`NEq` on `Box` / `AvlTree` operands
  throws `'not-implemented-yet'`. Those SValue shapes don't exist at
  runtime yet (chain-state model is phase 2e; AVL+ is phase 2h).
- **Lambdas, Box/Context, collection HOFs, sigma protocol, AVL+,
  predefs.** All deferred to their respective phases per the umbrella.
- **Eval-level mutation testing.** Phase 2a's parse-mutation suite
  (6221 flips, 100% taxonomy coverage) remains in place. Eval mutation
  is deferred — see Validation strategy § Layer C3.
- **`evaluateConstant(expr)` / `isConstantTree(tree)` helpers.**
  Mentioned in the umbrella but not shipped here — no concrete consumer.

## Architecture

### Directory layout

```
packages/ergoscript/src/eval/
├── eval.ts                    (existing — adds 3 new cases)
├── bin-op.ts                  NEW: delegates on e.kind.kind to one of 4 sub-arms
├── bin-op/                    NEW: per-family sub-modules
│   ├── arith.ts               evalArithOp + checked arithmetic helpers
│   ├── relation.ts            evalRelationOp + the structural sValueEquals comparer
│   ├── logical.ts             evalLogicalOp (short-circuit And/Or, eager Xor)
│   └── bit.ts                 evalBitOp + bitwise helpers across Byte/Short/Int/Long/BigInt
├── logical-not.ts             NEW: evalLogicalNot
├── bool-to-sigma-prop.ts      NEW: evalBoolToSigmaProp + inline TrivialProp byte helper
└── ...                        (existing 2b arms unchanged)
```

Each new arm is one exported function `eval<Variant>(e, env, ctx) =>
SValue`. The central `evalExpr` in `eval/eval.ts` gains three new
`case` lines: `BinOp` → `evalBinOp`, `LogicalNot` → `evalLogicalNot`,
`BoolToSigmaProp` → `evalBoolToSigmaProp`. The 60+ remaining variants
still fall through to the `'not-implemented-yet'` default. Adding a new
`Expr` variant to `mir/types.ts` remains a compile-time error in the
central switch via `_exhaust: never`.

### Dispatch pattern

```ts
// eval/eval.ts (excerpt, additions in **bold** in commentary)
export function evalExpr(e: Expr, env: Env, ctx: EvalContext): SValue {
  switch (e.tag) {
    case 'Const':              return evalConst(e, env, ctx)
    case 'ConstPlaceholder':   return evalConstPlaceholder(e, env, ctx)
    case 'BlockValue':         return evalBlockValue(e, env, ctx)
    case 'ValDef':             return evalValDef(e, env, ctx)
    case 'ValUse':             return evalValUse(e, env, ctx)
    case 'Tuple':              return evalTuple(e, env, ctx)
    case 'Collection':         return evalCollection(e, env, ctx)
    case 'If':                 return evalIf(e, env, ctx)
    case 'BinOp':              return evalBinOp(e, env, ctx)         // NEW
    case 'LogicalNot':         return evalLogicalNot(e, env, ctx)    // NEW
    case 'BoolToSigmaProp':    return evalBoolToSigmaProp(e, env, ctx) // NEW
    // ~57 more arms across the remaining phases
    default: { /* _exhaust: never + 'not-implemented-yet' throw */ }
  }
}
```

`evalBinOp(e, env, ctx)` itself is a thin one-of-four switch on
`e.kind.kind`:

```ts
// eval/bin-op.ts
export function evalBinOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  switch (e.kind.kind) {
    case 'Arith':     return evalArithOp(e, env, ctx)
    case 'Relation':  return evalRelationOp(e, env, ctx)
    case 'Logical':   return evalLogicalOp(e, env, ctx)
    case 'Bit':       return evalBitOp(e, env, ctx)
    default: {
      // Exhaustiveness gate: BinOpKind is a closed 4-member union.
      // Adding a new kind becomes a compile-time error here.
      const _exhaust: never = e.kind
      throw new Error(`evalBinOp: unreachable kind ${JSON.stringify(_exhaust)}`)
    }
  }
}
```

Per-family sub-arms eval both operands themselves (sigma-rust mostly
does the same; a couple of paths eval one side, branch on it, then eval
the other only conditionally — the short-circuit cases noted in
§ Semantics).

### Shared helpers

Two cross-cutting helpers live with the arm that owns them:

- **`bin-op/arith.ts`** carries `checkedNumericArith(op, kind, a, b)`
  — promotes to `bigint`, computes, range-checks against the kind's
  signed range, throws `'arith-overflow'` on violation, narrows back
  to `number` for `Byte`/`Short`/`Int`. One overflow-check path; sigma-rust uses
  primitive-typed `checked_*` per kind, bigint-everywhere is the
  cleaner TS version.
- **`bin-op/relation.ts`** carries `sValueEquals(a, b)` as a
  self-contained recursive function. ~80 LOC, exhaustive switch on
  `kind`. Not re-exported from `_helpers/` — it's an evaluator
  semantic, not a test fixture utility. Box/AvlTree branches throw
  `'not-implemented-yet'`.

The `TrivialProp` byte construction in `bool-to-sigma-prop.ts` is a
5-line inline helper, not a separate module. The exact opcode byte
comes from sigma-rust's `ergotree-ir/src/sigma_protocol/sigma_boolean.rs`
codec — the implementer reads the source rather than copying a number
into this spec.

No new runtime dependencies. No new test-side helpers (the
`hexToBytes` / `hydrateSValue` shared in `test/_helpers/index.ts` from
this session already covers every new test file).

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative oracle
for every per-op behaviour. The items below are the ones worth pinning
in the spec because they're load-bearing or easy to get wrong; for any
behaviour not noted here, sigma-rust source wins.

**Arithmetic overflow.** Every `ArithOp` other than `Max`/`Min` can
overflow. Bounds:

| Kind | Range |
|---|---|
| `Byte` | [−2⁷, 2⁷ − 1] |
| `Short` | [−2¹⁵, 2¹⁵ − 1] |
| `Int` | [−2³¹, 2³¹ − 1] |
| `Long` | [−2⁶³, 2⁶³ − 1] |
| `BigInt` | [−2²⁵⁵, 2²⁵⁵ − 1] |

Note `BigInt` is Ergo's 256-bit signed range, not arbitrary precision.
Compute in `bigint`, range-check post-compute, throw
`'arith-overflow'` on violation. Narrow back to `number` before
returning the `SValue` for `Byte`/`Short`/`Int`. Mirrors sigma-rust's
`checked_add` / `checked_sub` / `checked_mul` / `checked_div` /
`checked_rem` (each returning `Option<T>` where `None` → overflow →
typed error).

**Divide / Modulo by zero.** `Divide` and `Modulo` throw
`'arith-divide-by-zero'` when the right operand is zero, before
performing the op. Sigma-rust raises
`EvalError::ArithmeticException("divide by zero")`; we surface as the
typed code.

**Operand kind consistency.** For `ArithOp` and `BitOp`, both operands
must share `kind`. For `RelationOp.Eq`/`NEq`, kind mismatch returns
`false` (not an error — matches sigma-rust's `data_value_comparer`
posture). For `Lt`/`Le`/`Gt`/`Ge`, both operands must share `kind` and
be numeric (Byte/Short/Int/Long/BigInt). Kind mismatches in non-Eq
relation throw `'bin-op-kind-mismatch'`. Non-numeric operands to
ordering throw `'bin-op-not-numeric'`.

**Logical short-circuit.** `LogicalOp.And`: eval left; if `false`,
return `false` without evaluating right. `LogicalOp.Or`: eval left; if
`true`, return `true` without evaluating right. `LogicalOp.Xor`: always
eval both. Mirrors sigma-rust's `bin_op.rs` And/Or `eval_op_lazy` vs
Xor's eager path. Cost for the non-evaluated branch is NOT charged
(same posture as 2b's `If` arm).

**Structural equality.** `sValueEquals(a, b)`:

- Different `kind`: returns `false` (not error).
- `Boolean`/`Byte`/`Short`/`Int`: JS `===` on `.value`.
- `Long`/`BigInt`: bigint `===`.
- `Unit`: always `true`.
- `GroupElement`: byte-equal on the 33-byte payload.
- `SigmaProp`: byte-equal on opaque `.raw`. Correct because sigma-rust's
  wire encoding is canonical — equal propositions serialise to equal
  bytes.
- `Coll`: same `elem` (recursive SType equality) + same length +
  pairwise recursive `sValueEquals` on items.
- `Tuple`: same arity + pairwise recursive.
- `Option`: both `null` → `true`; one null and one not → `false`; both
  non-null → recursive.
- `Box`/`AvlTree`: throws `'not-implemented-yet'`.

**Bit-shift bounds.** `BitShiftLeft`/`BitShiftRight`/`BitShiftRightZeroed`
throw `'bit-shift-out-of-range'` when the shift amount is negative or
≥ the operand's bit-width (8 for Byte, 16 for Short, 32 for Int, 64 for
Long, 256 for BigInt). Mirrors sigma-rust's shift validation.

**Cost values.** Per arm, copied from sigma-rust at the pinned rev and
asserted via Layer C1 fixtures from day one. Same posture as 2b. Each
per-arm PR cites `eval/<file>.rs:LINE` for the cost value. Specific
integers are NOT locked in this spec — the fixture-gen output is the
source of truth.

**BoolToSigmaProp encoding.** The wire bytes for `TrivialProp(b)` are
1 opcode byte + 1 bool byte. The exact opcode comes from sigma-rust's
`ergotree-ir/src/sigma_protocol/sigma_boolean.rs` codec — implementer
reads the source. Resulting SValue is `{ kind: 'SigmaProp', value: { raw: <2 bytes> } }`.

## Validation strategy

Three-layer discipline, mirroring 2b. Cost validation continues the
layered C1/C2/C3 strategy.

### Layer C1 — per-arm fixture-gen oracles

Six new fixture-gen Rust modules under `fixture-gen/src/cmds/ergoscript/eval/`:

- `bin_op_arith.rs` — one entry per ArithOp (7 ops) × cross-section of
  numeric kinds (Byte/Short/Int/Long/BigInt), plus explicit
  overflow-triggering and divide-by-zero entries that capture
  sigma-rust's error kind. ~25 entries.
- `bin_op_relation.rs` — `Eq`/`NEq` over each comparable kind
  (~10 entries covering primitives, Coll, Tuple, Option, GroupElement,
  SigmaProp opaque, plus same-kind / different-kind crosses);
  `Lt`/`Le`/`Gt`/`Ge` over numeric kinds. ~25 entries.
- `bin_op_logical.rs` — And/Or short-circuit pairs (one entry per
  truth-table cell × verifying cost doesn't charge non-evaluated
  branch); Xor truth-table. ~10 entries.
- `bin_op_bit.rs` — each BitOp × numeric kinds, plus shift-overflow /
  negative-shift edge cases. ~15 entries.
- `logical_not.rs` — !true and !false. 2 entries.
- `bool_to_sigma_prop.rs` — true and false. 2 entries.

Each entry follows 2b's schema:
`{ name, tree_bytes_hex, opts_json, expected_value_json, expected_cost }`
(or `expected_error_code` for failure cases). Same
`try_eval_out::<Value<'static>>` wedge via the `arbitrary` feature on
`ergotree-interpreter`. Determinism guarded via
`TestRunner::deterministic()` for any random-input synthesis (same
posture as 2b's Task-16 fix).

The TS test file per arm (`test/eval/bin-op-arith.test.ts`, etc.) loads
the fixture, parses the tree, evaluates with the same opts, asserts
value-equality AND cost-equality against the captured oracle. Uses the
shared `hexToBytes` / `hydrateSValue` from
`test/_helpers/index.ts` (already in place after this session's commit
`3b120b9`).

### Layer C2 — mainnet_boxes corpus growth

The existing `test/corpus-eval.test.ts` runs unchanged. With 2c's arms
wired, the evaluable subset grows from 0/18 (2b end-state) toward
whatever fraction of those 18 trees use only 2b+2c-supported variants.
Expected growth: substantial — `BinOp` is the most-used MIR node in
real ErgoScript.

The tightened `expect(other).toBe(0)` assertion from commit `cc1c7a3`
will fail loudly if any tree throws an undocumented EvalError code as
a regression.

### Layer C3 — eval-level mutation testing (deferred)

The umbrella spec parks this at "2c+ when there are enough arms".
Concrete decision for this slice: **skip eval mutation**. Rationale:

- Phase 2a's parse-mutation suite (6221 flips, 100% taxonomy coverage)
  remains the load-bearing mutation defense for parse-time errors.
- Eval-level mutations on already-parseable trees mostly degrade to
  "value diff or typed throw" smoke tests with low signal-to-noise.
  Most flips that affect eval also affect parse and are caught earlier.
- The mutation budget is better invested in a later phase: 2e adds
  substantial new error surface around Box/Context model; 2f adds
  collection HOFs whose structural recursion has bugs that parse-time
  mutation can't catch.

Revisit at 2e or 2f kickoff brainstorm.

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. Phase 2c adds no new
browser-incompatible primitives — `bigint` arithmetic, byte-buffer
construction for TrivialProp, structural equality — all already
cross-runtime in 2a/2b.

## Browser compatibility

Hard rules carried verbatim from 2a/2b, no new exceptions:

- All `Uint8Array`. Never `Buffer`.
- No `node:*` outside test files.
- No `globalThis.crypto` or `node:crypto`.
- No WASM dependencies, direct or transitive.
- ESM only, ES2022 target.
- `bigint` for `SLong`/`SBigInt` and intermediate arithmetic.
- No top-level `await`.

Phase 2c adds no runtime dependencies. `@noble/curves` waits until 2g.

## Dependencies

Runtime: unchanged from 2a/2b (`@noble/hashes` 2.2.0).

Dev: unchanged from 2a/2b.

## Error taxonomy

New codes on the existing `EvalError` class. No new error class
shipped; same surface as v0.2.0.

| Code | Throw site | Meaning |
|---|---|---|
| `arith-overflow` | `bin-op/arith.ts` (Plus/Minus/Multiply/Divide/Modulo) | Computed result outside the kind's signed range. Message includes op, kind, offending bigint result. |
| `arith-divide-by-zero` | `bin-op/arith.ts` (Divide/Modulo) | Right operand evaluated to zero. Checked before performing the op. |
| `bin-op-kind-mismatch` | arith.ts, bit.ts, relation.ts (ordering only), logical.ts | Operands have different `kind` for an op that requires same-kind operands. Eq/NEq do NOT throw — they return `false`. |
| `bin-op-not-numeric` | arith.ts, bit.ts, relation.ts (ordering only) | Operand kind isn't in {Byte, Short, Int, Long, BigInt} for an op that requires numeric operands. |
| `bin-op-not-boolean` | logical.ts, logical-not.ts, bool-to-sigma-prop.ts | Operand kind isn't `Boolean` for an op that requires Boolean operands. |
| `bit-shift-out-of-range` | bin-op/bit.ts (shift ops) | Shift amount negative or ≥ operand bit-width. |

The existing `'not-implemented-yet'` continues to cover `Eq`/`NEq` on
`Box`/`AvlTree` operands (until 2e/2h land those SValue shapes). All
new codes documented additively in `facts/ergoscript.md`'s v0.2.0
EvalError taxonomy section — no breaking changes to existing codes.

## Sequencing

Simplest-first execution, subagent-driven per task using 2b's workflow
(fresh subagent per task, two-stage review: spec compliance + code
quality). Each task ships fixture-gen Rust module + arm + per-arm test
file in a single subagent dispatch.

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 1 | `LogicalNot` arm + fixture | `eval/logical_not.rs` (43 LOC) | Trivial. Establishes the 2c arm-task template against the new types. |
| 2 | `BoolToSigmaProp` arm + fixture | `eval/bool_to_sigma.rs` (97 LOC) | Introduces the inline TrivialProp byte helper. Confirms opaque-SigmaProp posture works end-to-end. |
| 3 | `BinOp` central dispatch + `evalBinOp` skeleton | — | Wires `BinOp` into central `evalExpr`; the four sub-arm cases throw `'not-implemented-yet'` for now. One task, no fixture (exercised by parent dispatch tests). |
| 4 | `evalBitOp` + fixture | `eval/bin_op.rs` (Bit family) | Simplest BinOp family — no overflow, no short-circuit, no equality polymorphism. Establishes the per-sub-arm fixture pattern. |
| 5 | `evalLogicalOp` + fixture | `eval/bin_op.rs` (Logical family) | Introduces short-circuit cost-charging semantics. Smaller op set (And/Or/Xor). |
| 6 | `evalRelationOp` + fixture (ordering ops only) | `eval/bin_op.rs` (Relation family, ordering subset) | Lt/Le/Gt/Ge over numerics. No equality polymorphism yet. |
| 7 | `sValueEquals` helper + `evalRelationOp` Eq/NEq extension + fixture | `eval/data_value_comparer.rs` (8.2 KB) | Adds the structural comparer. Extends the relation fixture with Eq/NEq entries; updates `evalRelationOp` to dispatch. |
| 8 | `evalArithOp` + fixture | `eval/bin_op.rs` (Arith family) | Largest sub-arm. Introduces overflow + divide-by-zero. |
| 9 | Layer C2 corpus re-run + facts update | — | Run `corpus-eval.test.ts`; confirm `other === 0` stays green and the evaluable subset grew. Update `facts/ergoscript.md`'s v0.2.0 EvalError taxonomy section with the 6 new codes. Update `MEMORY.md`'s `project_ergots_direction` with phase-2c-done state. |
| 10 | Phase 2c final review + commit-and-push | — | Same final-review posture as 2b's final commits. |

10 subagent tasks vs phase 2b's 18 — smaller because 2c has fewer
distinct arm modules (six vs eight) and heavy-lifting is concentrated
in arms 7 and 8. Estimated wall clock: 3–4 hours.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cost values copied incorrectly from sigma-rust | Per-arm comment cites `eval/<file>.rs:LINE`; PR-time review checks the cited value. C1 fixture-gen captures and asserts per-arm cost from day one (same as 2b). |
| Overflow check off-by-one (signed range boundaries) | Range constants pinned in `bin-op/arith.ts` against sigma-rust source. Layer C1 fixtures include explicit boundary entries (MAX+1, MIN-1, etc.) that exercise both sides. |
| `sValueEquals` recursion misses an SValue kind | Exhaustiveness via `_exhaust: never` discriminant in the switch — adding a new SValue kind without a comparer arm becomes a compile-time error. |
| `data_value_comparer.rs` is 8.2 KB and intricate | Task 7 is the largest. Two-stage review specifically checks the recursive cases (Coll, Tuple, Option) against representative sigma-rust test data. |
| TrivialProp opcode byte mistyped | Implementer reads sigma-rust source live; fixture-gen for `bool_to_sigma_prop` asserts the wire bytes round-trip through our SigmaBoolean parser. |
| Short-circuit cost-charging asymmetry across And/Or/Xor | C1 fixtures for `bin_op_logical` include entries where the non-evaluated branch is an out-of-range `ConstPlaceholder` (would throw if evaluated). Cost assertions on those entries lock the "non-taken branch not charged" invariant. |
| Bit-shift behaviour drift across kinds (e.g. 0xff shifted left as Byte vs Int) | C1 fixtures explicitly exercise each kind. The arm always promotes to `bigint`, shifts, then narrows + range-checks — single code path. |
| `'arith-overflow'` masking real bugs by being too liberal | Range constants are sigma-rust-source-derived. C1 fixtures include both overflow cases (must throw) AND boundary-safe cases (must succeed); both directions validated. |

## Open questions

1. **Cost-charging order for short-circuit ops.** Sigma-rust charges
   the envelope `Fixed(1)` cost, then evaluates left, then conditionally
   evaluates right. Confirm: should we charge envelope cost BEFORE
   evaluating either operand (matching sigma-rust precisely), or after?
   Resolves to "before, matching sigma-rust" — captured in C1 fixture
   schemas; implementer reads sigma-rust to confirm exact order.

2. **`Max`/`Min` cost.** Sigma-rust treats these as `ArithOp` despite
   not being capable of overflow. Confirm same cost as Plus/Minus
   (probably `Fixed(1)`) — captured in C1 fixture, but worth noting
   as a "looks like it should be different but isn't" gotcha.

3. **Eq/NEq cost.** Sigma-rust's `data_value_comparer` charges
   per-comparison; the total cost for a Coll equality depends on the
   recursion depth. Need to verify our C1 fixture for Eq captures the
   total cost correctly (it will if we use `try_eval_out::<Value<'static>>(&tree.proposition()?, &ctx)`
   and read `ctx.jit_cost_value()` post-eval). Same wedge as 2b's
   BlockValue fixtures.

4. **Bit-shift on BigInt.** BigInt is 256-bit signed in Ergo;
   right-shift by 255 of `MIN_BIGINT` should produce `-1`. Confirm
   sign-preserving arithmetic shift right vs zero-fill right behaviour
   matches sigma-rust on the boundary cases. C1 fixtures cover this.

None are blockers. All resolve by source-reading + fixture-driven TDD.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella
  phase plan (2a–2j)
- `docs/specs/2026-05-14-ergoscript-phase-2b-design.md` — phase 2b
  focused design (evaluator chassis + 8 arms)
- `facts/ergoscript.md` — boundary contract, extended additively per
  phase
- `facts/proof.md` — sister contract for the proof package
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`,
  HEAD `ed5452cf`) — byte-format and implementation oracle. Phase 2c
  authoritative refs:
  - `ergotree-interpreter/src/eval/bin_op.rs`
  - `ergotree-interpreter/src/eval/data_value_comparer.rs`
  - `ergotree-interpreter/src/eval/logical_not.rs`
  - `ergotree-interpreter/src/eval/bool_to_sigma.rs`
  - `ergotree-interpreter/src/eval/costs.rs`
  - `ergotree-ir/src/sigma_protocol/sigma_boolean.rs` (TrivialProp opcode)
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical
  language specification (per-op semantics, equality rules)
