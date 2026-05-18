# `@mwaddip/ergots-ergoscript` — Interface Contract

The boundary contract for the ErgoScript / ErgoTree wire-format package. Other packages in this monorepo (the future wallet / transaction-broadcaster) read this file to know what they may rely on. The narrative rationale lives in `docs/specs/2026-05-13-ergoscript-interpreter-design.md`; this file is *only* the interface.

**Phase 2a complete.** Pins the *wire-format surface* — parse and serialize for every ErgoTree variant defined in the sigma-rust `ergotree-ir` crate, plus address ↔ ErgoTree round-trip helpers.

**Phase 2b complete (v0.2.0).** Adds an *evaluator scaffold* — `evaluate` / `evaluateWith` with an `EvalContext` (cost accumulator + optional limit), an `Env` for val-bindings, and 8 of ~70 `Expr` arms wired (`Const`, `ConstPlaceholder`, `BlockValue`, `ValDef`, `ValUse`, `Tuple`, `Collection`, `If`). Every other `Expr` variant throws `EvalError 'not-implemented-yet'`. Phases 2c–2j extend this surface additively; the public function signatures and error class are stable from v0.2.0 onward.

**Phase 2c complete (v0.2.0, additive).** Adds 3 more `Expr` arms: `BinOp` (all 22 sub-ops — Arith ×5, Bit ×5, Relation ×6, Logical ×6), `LogicalNot`, and `BoolToSigmaProp`. Total implemented arms: 11 of ~70. New `EvalError` codes: `'arith-overflow'`, `'arith-divide-by-zero'`, `'bin-op-kind-mismatch'`, `'bin-op-not-numeric'`, `'bin-op-not-boolean'`. No public API surface changes; existing caller code is unaffected.

**Phase 2d-A complete (v0.2.0, additive).** Adds 4 more `Expr` arms — the unary numeric-polymorphism quartet: `Negation`, `BitInversion`, `Upcast`, `Downcast`. Total implemented arms: 15 of ~70. One new `EvalError` code: `'downcast-overflow'` (distinct from `'arith-overflow'` so callers can dispatch on "narrowing specifically failed"). Step-1 refactor promoted `checkRange` + `maskToKind` from `bin-op/{arith,bit}.ts` into `bin-op/_numeric.ts`; `checkRange` gained a third parameter (error code string) so arith callers keep passing `'arith-overflow'` and the new downcast caller passes `'downcast-overflow'`. No public API surface changes; existing caller code is unaffected.

**Phase 2d-B complete (v0.2.0, additive).** Adds 2 more `Expr` arms — the `Coll[Boolean]` aggregator pair: `And` (all-true; empty Coll returns `true` per vacuous truth) and `Or` (any-true; empty Coll returns `false` per identity of Or). Total implemented arms: 17 of ~70. One new `EvalError` code: `'coll-not-boolean'` (defensive kind-check for non-`Coll[Boolean]` input). No public API surface changes; existing caller code is unaffected.

The package has not been `npm publish`-ed; downstream consumers in the monorepo currently import it through the workspace alias. Anything not in this document is implementation detail and may change without notice.

Authoritative wire-format reference: sigma-rust's `ergotree-ir/src/ergo_tree.rs`, `ergotree-ir/src/serialization/`, and `ergotree-ir/src/mir/` (branch `integration/ergots`, HEAD `ed5452cf` at time of writing). Where this file is silent, those are canonical.

## Scope

**Ships in this contract (phase 2a — wire format):**

1. Parse + serialize for the ErgoTree envelope: header byte, optional VLQ-u32 body size, optional segregated constants section, body Expr.
2. Parse + serialize for the full `Expr` discriminated union (68 variants — see `mir/types.ts`), wired through a central opcode-dispatch switch.
3. Parse + serialize for `SType` (the type-system union) and `SValue` (the runtime-value union), including all primitive variants, `SColl`, `STuple`, `SOption`, `SFunc`, `STypeVar`.
4. Parse for `SigmaBoolean` (the recursive proposition tree inside `SSigmaProp` constants) — opaque-bytes representation, structural decode only used for length determination.
5. P2PK recognition + 33-byte public-key extraction.
6. Base58check address ↔ `ErgoTree` round-trip for mainnet and testnet (P2PK and P2S).
7. Stateless: no I/O, no clock, no PRNG, no `globalThis` reads. Browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`. ESM only.

**Ships additionally (phase 2b — evaluator chassis + 8 arms):**

8. Public evaluator entry points: `evaluate(tree, opts?)`, `evaluateWith(tree, ctx)`, `makeContext(opts?)`.
9. `EvalContext` carrying a saturating `jitCost` accumulator with optional `jitCostLimit` enforcement. Cost values are sigma-rust-accurate per arm from day one (not no-op placeholders).
10. Immutable `Env` for `ValDef` bindings (clone-on-extend; lexical scoping naturally correct under TS).
11. Central exhaustive `evalExpr` switch on `Expr.tag` with `_exhaust: never` discriminant; adding a new `Expr` variant becomes a compile-time error until a corresponding arm exists.
12. 8 per-variant arms wired: `Const`, `ConstPlaceholder`, `BlockValue` (with `ADD_TO_ENV_COST` per `ValDef`), `ValDef` (top-level rejection), `ValUse`, `Tuple`, `Collection` (both `Exprs` and `BoolConstants` kinds), `If` (with short-circuit semantics + cost-correct branch skipping).
13. Layer C1 per-arm fixture validation: every arm's behavior (value + cost) is asserted against sigma-rust's `try_eval_out` oracle.

**Ships additionally (phase 2c — operators slice 1):**

14. 3 more per-variant arms wired: `BinOp` (central dispatcher delegating on `e.op.kind` to 4 per-family sub-arms), `LogicalNot`, `BoolToSigmaProp`.
15. All 22 `BinOp` sub-ops implemented across 4 families:
    - **Arith** (7): `Plus`, `Minus`, `Multiply`, `Divide`, `Modulo`, `Max`, `Min`. Compute in `bigint` internally with signed-range checks per kind (Byte/Short/Int/Long/BigInt256); throws `'arith-overflow'` on bounds violation, `'arith-divide-by-zero'` for `/0` and `%0`. Cost varies per op and per `is_bigint` (matches sigma-rust `bin_op.rs:198-207`).
    - **Relation** (6): `Lt`, `Le`, `Gt`, `Ge` (numeric ordering); `Eq`, `NEq` via the recursive `sValueEquals` comparer.
    - **Logical** (3): `And`, `Or` short-circuit on Boolean operands (right-side cost NOT charged when short-circuited); `Xor` is eager.
    - **Bit** (3 of 6): `BitAnd`, `BitOr`, `BitXor` with kind-uniform bigint masking + sign-preserving re-narrowing. The 3 shift ops (`BitShiftLeft`, `BitShiftRight`, `BitShiftRightZeroed`) throw `'not-implemented-yet'` matching sigma-rust's `EvalError::Misc` posture — sigma-rust delegates shifts to `SNumericTypeMethods` (a method-call IR path) not the BinOp arm.
16. `sValueEquals` recursive structural comparer covering primitives (Boolean / Byte / Short / Int / Long / BigInt / Unit), `GroupElement` (byte-equal), `SigmaProp` (byte-equal on opaque `.raw`), `Coll`, `Tuple`, `Option`. Cross-kind comparison returns `false` (no coercion). `Box` / `AvlTree` throw `'not-implemented-yet'` (their runtime shapes aren't in scope until phase 2h+). Cost is charged inside the comparer per per-type constants mirroring sigma-rust's `data_value_comparer.rs` (`EQ_PRIM_COST`, `EQ_BIGINT_COST`, `EQ_GROUP_ELEMENT_COST`, `EQ_TUPLE_COST`, `EQ_OPTION_COST`, `COLL_MATCH_TYPE_COST` + per-item).
17. 5 new `EvalError` codes documented in the v0.2.0 taxonomy below: `'arith-overflow'`, `'arith-divide-by-zero'`, `'bin-op-kind-mismatch'`, `'bin-op-not-numeric'`, `'bin-op-not-boolean'`.

**Ships additionally (phase 2d-A — numeric-poly unary arms):**

18. 4 more per-variant arms wired: `Negation` (numeric negate; overflow throws `'arith-overflow'`), `BitInversion` (bitwise complement; no overflow), `Upcast` (widen to target numeric kind read from `e.tpe`; no overflow), `Downcast` (narrow to target numeric kind; overflow throws `'downcast-overflow'`). All four are unary, numeric-only; result kind equals input kind for `Negation`/`BitInversion`, and equals the target kind on `e.tpe` for `Upcast`/`Downcast`.
19. One new `EvalError` code documented in the v0.2.0 taxonomy below: `'downcast-overflow'`. No other taxonomy changes; non-numeric input to any of the four arms reuses `'bin-op-not-numeric'` per the `LogicalNot` / `BoolToSigmaProp` precedent from 2c.
20. Step-1 refactor: `checkRange` and `maskToKind` promoted from `bin-op/{arith,bit}.ts` to `bin-op/_numeric.ts`. `checkRange` gains a third parameter (error code string) so 2c arith callers continue passing `'arith-overflow'` while the new `Downcast` caller passes `'downcast-overflow'`. `maskToKind` moves unchanged. Internal refactor only — no behavioral change to existing 2c fixtures.

**Ships additionally (phase 2d-B — Coll[Boolean] aggregator arms):**

21. 2 more per-variant arms wired: `And` (reduces `Coll[Boolean]` to
    `Boolean` via all-true; empty Coll returns `true` per vacuous
    truth) and `Or` (any-true; empty Coll returns `false` per identity
    of Or). Both arms charge cost AFTER eval-child via
    `addPerItemCost`; cost values differ per arm (And: `(10, 5, 32,
    n)`; Or: `(5, 5, 64, n)`).
22. One new `EvalError` code documented in the v0.2.0 taxonomy:
    `'coll-not-boolean'`. Reused by both arms for the defensive
    kind-check posture established by 2c's LogicalNot /
    BoolToSigmaProp.

**Ships additionally (phase 2e — lambdas + treeVersion + XorOf + V3 revisit):**

23. 3 more per-variant arms wired: `FuncValue` (constructs Lambda
    SValue; Fixed(5) cost; lazy body), `Apply` (invokes Lambda; Fixed(30)
    cost; immutable env extend; arity check), `XorOf` (Coll[Boolean]
    XOR aggregator with V0/V1-vs-V2+ semantics drift; reuses
    `'coll-not-boolean'`).
24. `EvalOpts` gains one optional field: `treeVersion?: number`.
    `evaluate(tree, opts)` auto-derives from `tree.header.version`.
    `evaluateWith(tree, ctx)` requires explicit setting. Arms reading
    `ctx.treeVersion` default to V0 (most-restrictive) on undefined.
25. Three new `EvalError` codes: `'tree-version-too-low'` (Upcast/
    Downcast V3 gating), `'apply-non-lambda'`, `'apply-arity-mismatch'`.
26. Behavior change on existing arms: Upcast (BigInt → BigInt no-op) and
    Downcast (any branch with BigInt source) now throw
    `'tree-version-too-low'` at `ctx.treeVersion < 3`, matching sigma-
    rust upstream. Previously TS silently accepted these branches at
    any version.

**Ships additionally (phase 2f medium — chain-state Context + 6 arms):**

40. 6 more per-variant arms wired: `GlobalVars` (Height / Inputs /
    Outputs / SelfBox / MinerPubKey / GroupGenerator, Fixed(10) cost;
    reads optional chain-state fields from `EvalContext`), `GetVar`
    (Fixed(10) cost; reads `ctx.extension.values[varId]` returning
    `Option[T]`; throws `'get-var-type-mismatch'` when stored type ≠
    requested type), `OptionGet` (Fixed(15) cost; unwraps
    `Option[T]`; throws `'option-empty'` on None), `OptionIsDefined`
    (Fixed(10) cost; returns Boolean), `OptionGetOrElse` (Fixed(15)
    cost; V3-gated lazy semantics — at `treeVersion < 3` both branches
    eval eagerly per JVM bug; at V3+ only the taken branch is
    evaluated, mirroring the XorOf V0/V1-vs-V2+ pattern from phase
    2e), `SelectField` (Fixed(10) cost; 1-based `fieldIndex` →
    0-based array access on `Tuple` SValue).
41. `EvalOpts` / `EvalContext` gains 6 new optional chain-state fields
    (all optional; undefined ⇒ throws `'context-field-missing'` if
    reached by an arm): `height?: number`, `selfBox?: ErgoBox`,
    `inputs?: ErgoBox[]`, `outputs?: ErgoBox[]`,
    `preHeader?: PreHeader`, `extension?: ContextExtension`.
42. Two new runtime stubs stabilized: `PreHeader` (version, parentId,
    timestamp, nBits, height, minerPk, votes) and `ContextExtension`
    (values: Record keyed by varId; same `{ tpe, value }` shape as
    `ErgoBox.registers`).
43. Six new `EvalError` codes: `'context-field-missing'` (any
    GlobalVars / GetVar arm reached with the required context field
    absent), `'get-var-type-mismatch'` (GetVar stored type ≠
    requested type), `'option-empty'` (OptionGet on None),
    `'option-input-not-option'` (OptionGet / OptionIsDefined /
    OptionGetOrElse received non-Option input), `'select-field-index-
    out-of-range'` (fieldIndex outside tuple bounds; unreachable from
    parser-produced trees — sigma-rust validates in-bounds at
    construction), `'select-field-input-not-tuple'` (SelectField
    received non-Tuple input; defensive, same posture as LogicalNot).

**Coverage after 2f medium complete:** 33 of ~70 `Expr` variants (27 prior + 6 in 2f medium: `GlobalVars`, `GetVar`, `OptionGet`, `OptionIsDefined`, `OptionGetOrElse`, `SelectField`); full chain-state Context model ships. Mainnet corpus aggregate stable: `success=0 not-impl=18 other=0` (the 18 reach GlobalVars or GetVar, now throwing `'context-field-missing'` instead of `'not-implemented-yet'` — both count in the `not-impl` bucket per the corpus-eval tolerance).

**Ships additionally (phase 2f Coll HOFs — 9 arms):**

44. 9 more per-variant arms wired: `SizeOf`, `Append`, `ByIndex`, `Slice`,
    `MapColl`, `Filter`, `Fold`, `Exists`, `ForAll`. Coverage: 33 → 42 of
    ~70 arms.
    - **`SizeOf`** — `Coll[T] → Int`; outer cost BEFORE eval-child (Pattern A):
      `Fixed(14)`. Throws `'coll-input-not-coll'` if child evaluates to a
      non-Coll SValue.
    - **`Append`** — `Coll[T] × Coll[T] → Coll[T]`; outer cost BEFORE
      eval-children (Pattern A): `addPerItemCost(20, 2, 128, result.length)`.
      Throws `'coll-input-not-coll'` for either non-Coll input.
    - **`ByIndex`** — `Coll[T] × Int [× Option[T]] → T`; outer cost BEFORE
      eval-input (Pattern A): `Fixed(30)`. Throws `'coll-input-not-coll'`
      for non-Coll collection input, `'coll-by-index-index-not-int'` for
      non-Int index expression result, `'coll-by-index-out-of-range'` when
      index is OOB and no default expression is present.
    - **`Slice`** — `Coll[T] × Int × Int → Coll[T]`; outer cost BEFORE
      eval-children (Pattern A): `addPerItemCost(10, 2, 128, result.length)`.
      Throws `'coll-input-not-coll'` for non-Coll input,
      `'coll-slice-bound-not-int'` for non-Int `from` or `until` result.
    - **`MapColl`** — `Coll[T] × (T → R) → Coll[R]`; Mixed cost-charging:
      outer `addPerItemCost(20, 2, 128, input.length)` BEFORE eval-input
      (Pattern A), plus per-iter `Fixed(1)` cost after each lambda call
      (Pattern B). Throws `'coll-input-not-coll'`, `'lambda-not-callable'`,
      `'lambda-result-type-mismatch'`.
    - **`Filter`** — `Coll[T] × (T → Boolean) → Coll[T]`; Mixed:
      `addPerItemCost(20, 2, 128, input.length)` BEFORE (Pattern A), plus
      `Fixed(1)` per iter (Pattern B). Throws `'coll-input-not-coll'`,
      `'lambda-not-callable'`, `'coll-elem-tpe-mismatch'` (declared element
      type from `condition.args[0].tpe` vs runtime item kind).
    - **`Fold`** — `Coll[T] × Zero × ((Zero, T) → Zero) → Zero`; Mixed:
      `addPerItemCost(20, 2, 128, input.length)` BEFORE (Pattern A), plus
      `Fixed(1)` per iter (Pattern B). Throws `'coll-input-not-coll'`,
      `'lambda-not-callable'`, `'lambda-result-type-mismatch'`.
    - **`Exists`** — `Coll[T] × (T → Boolean) → Boolean`; Mixed:
      `addPerItemCost(20, 2, 128, input.length)` BEFORE (Pattern A), plus
      `Fixed(1)` per iter (Pattern B); short-circuits on first `true` (no
      further cost charged after match). Throws `'coll-input-not-coll'`,
      `'lambda-not-callable'`, `'coll-elem-tpe-mismatch'`.
    - **`ForAll`** — `Coll[T] × (T → Boolean) → Boolean`; Mixed:
      `addPerItemCost(20, 2, 128, input.length)` BEFORE (Pattern A), plus
      `Fixed(1)` per iter (Pattern B); short-circuits on first `false`.
      Throws `'coll-input-not-coll'`, `'lambda-not-callable'`,
      `'coll-elem-tpe-mismatch'`.
45. **Seven new `EvalError` codes**: `'coll-input-not-coll'`,
    `'coll-elem-tpe-mismatch'`, `'coll-by-index-out-of-range'`,
    `'coll-by-index-index-not-int'`, `'coll-slice-bound-not-int'`,
    `'lambda-not-callable'`, `'lambda-result-type-mismatch'`.
46. **Cost-charging patterns clarified:**
    - **Pattern A (envelope-first):** outer cost charged BEFORE evaluating
      child expression(s). Applies to SizeOf, Append, ByIndex, Slice.
    - **Pattern B (per-iteration):** cost charged AFTER each loop iteration.
      Used alone for some arms (And/Or from 2d-B).
    - **Mixed (Pattern A + Pattern B coexisting):** applies to all five
      lambda HOFs (MapColl, Filter, Fold, Exists, ForAll). An outer chunked
      cost covers the collection traversal overhead; a per-iter Fixed(1)
      covers each lambda invocation. Both charges are present in the same
      arm; neither replaces the other.
47. **Port-level discrepancy (Filter / Exists / ForAll):** sigma-rust's
    `Filter`, `Exists`, and `ForAll` MIR structs carry an `elemTpe` field
    that is encoded on the wire. The TS MIR structs do NOT carry this field
    — the evaluator derives the declared element type from
    `condition.args[0].tpe` (the first parameter of the `FuncValue` lambda)
    for type-mismatch checks. This matches the actual on-wire and evaluator
    behavior; the discrepancy is at the TS MIR struct shape level only.
48. **Layer C3.a (eval mutation testing for Coll HOFs):** scoped mutation
    tests validate that the 9 new HOF arms reject semantically invalid
    inputs. Target: ≥ 90% mutation kill rate per arm. Mutations that are
    fundamentally unkillable (e.g., element-count mutations on a SizeOf
    fixture where an alternative valid Coll of different size would also
    parse and evaluate correctly) are recorded in an arm-specific allowlist;
    allowlisted mutations do not count against the kill rate. As of phase
    2f Coll HOFs, all 9 arms meet the ≥ 90% threshold.

**Ships additionally (phase 2g-medium — sigma protocol, leaf-only verifier):**

49. 2 more per-variant arms wired: `CreateProveDlog` (Pattern A, `Fixed(10)` cost) and `CreateProveDhTuple`
    (Pattern A, `Fixed(20)` cost). Coverage: 42 → 44 of ~70 arms.
    - **`CreateProveDlog`** — `GroupElement → SigmaProp`; outer cost BEFORE eval-child (Pattern A):
      `Fixed(10)`. Evaluates its single input expression, expects `kind: 'GroupElement'`, wraps the
      33-byte point as `{ kind: 'SigmaProp', value: { tag: 'ProveDlog', h } }`. No curve operation
      on the eval path. Source: `ergotree-interpreter/src/eval/create_provedlog.rs:10-29`.
    - **`CreateProveDhTuple`** — `GroupElement × GroupElement × GroupElement × GroupElement → SigmaProp`;
      outer cost BEFORE eval-children (Pattern A): `Fixed(20)`. Evaluates all four input expressions
      (`g`, `h`, `u`, `v`), expects each `kind: 'GroupElement'`, wraps as
      `{ kind: 'SigmaProp', value: { tag: 'ProveDhTuple', g, h, u, v } }`. No curve operation.
      Source: `ergotree-interpreter/src/eval/create_prove_dh_tuple.rs:12-25`.
50. **Structural `SigmaBoolean` type** — the opaque `{ raw: Uint8Array }` shape from phase 2a is
    replaced with a 6-variant discriminated union:
    ```ts
    type SigmaBoolean =
      | { tag: 'TrivialProp'; value: boolean }
      | { tag: 'ProveDlog'; h: Uint8Array }                // 33-byte SEC1 compressed
      | { tag: 'ProveDhTuple'; g: Uint8Array; h: Uint8Array; u: Uint8Array; v: Uint8Array }
      | { tag: 'Cand'; items: SigmaBoolean[] }
      | { tag: 'Cor'; items: SigmaBoolean[] }
      | { tag: 'Cthreshold'; k: number; items: SigmaBoolean[] }
    ```
    All 6 variants parse + serialize via the wire codec (round-trip byte-equal). The runtime verifier
    (this slice) walks only the 3 leaf-style variants; `Cand`/`Cor`/`Cthreshold` conjecture walks
    ship in `2g-combinators`. The `SValue.kind: 'SigmaProp'` container discriminator is unchanged;
    only the inner `.value` shape changed from opaque to structural.
    Invariants held by `parseSigmaBoolean`: `ProveDlog.h.length === 33`; `ProveDhTuple.{g,h,u,v}.length === 33`;
    `Cand.items.length >= 1`; `Cor.items.length >= 1`; `Cthreshold.items.length >= 1`
    (mirrors sigma-rust's `BoundedVec<T, 1, 255>`); `Cthreshold.k in [1, items.length]`.
51. **P2PK 50-JitCost short-circuit** — mirrors sigma-rust's `trivial_reduce` at
    `ergotree-interpreter/src/eval.rs:138-158, 268-278`. A tree whose root body is a plain
    `Const(SSigmaProp, _)` or a `ConstPlaceholder` resolving to a SigmaProp short-circuits with a
    flat `ctx.addCost(50)` (`EVAL_SIGMA_PROP_CONSTANT`). The short-circuit fires in
    `tryTrivialReduce(tree, ctx)` at the entry of `evaluate()` / `evaluateWith()` — NOT inside
    `evalConst`. Nested `SigmaProp` constants inside other expressions (e.g., as a sub-operand of a
    `BinOp`) go through `evalConst` and charge the standard 5. Without this short-circuit, bare P2PK
    trees undercharge by 10× vs sigma-rust.
52. **New public function: `verifySignature(sigmaBoolean, message, signature) → boolean`**. See
    public-surface section for precondition / postcondition / error-taxonomy.
53. **New error class: `VerifyError extends Error { code: string }`** with 5-code taxonomy; see the
    `VerifyError` taxonomy subsection below.
54. **One new `EvalError` code:** `'sigma-prop-input-not-group-element'` — `CreateProveDlog` /
    `CreateProveDhTuple` received an input `SValue` whose `kind !== 'GroupElement'`. Wire-format
    invariants make this unreachable for parser-produced trees (sigma-rust's `OneArgOpTryBuild` rejects
    non-GroupElement inputs at construction); defensive against `ConstantPlaceholder` injection and
    future MIR shape changes. Message includes the arm name and the actual kind.
55. **Two new `SigmaBooleanParseError` codes:** `'cthreshold-k-out-of-range'` (Cthreshold's `k` field
    is outside `[1, items.length]`) and `'sigma-conjecture-empty-items'` (Cand/Cor/Cthreshold parsed
    with `items.length === 0`; sigma-rust enforces `>= 1` via `BoundedVec<T, 1, 255>`). The existing
    codes (`'arity-out-of-range'`, `'unknown-opcode'`) from phase 2a stay.
56. **New runtime dependency:** `@noble/curves@2.2.0` (secp256k1 point ops + Schnorr-style verification).
    Pins the same version-locked pair as `@noble/hashes@2.2.0`. Added to `packages/ergoscript/package.json`.

**Ships additionally (phase 2g-combinators — sigma combinators + full conjecture verifier):**

57. **3 new eval arms** (coverage 44 → 47 of ~70 arms):
    - **`Atleast`** — `Int × Coll[SigmaProp] → SigmaProp`; Pattern B `addPerItemCost(20, 3, 5, n)` AFTER
      eval-children; calls `cthresholdReduce(k, items)` (where `k` is the Int bound extracted from
      `bound.value`). Defensive throws: `'atleast-bound-not-int'` (bound expression returned non-Int);
      `'atleast-bound-out-of-range'` (bound < 0, > 255, or > items.length — checked before delegating
      to `cthresholdReduce`). Source: `atleast.rs:19-58`.
    - **`SigmaAnd`** — `Coll[SigmaProp via items: Expr[]] → SigmaProp`; **Pattern A**
      `addPerItemCost(10, 2, 1, n)` BEFORE eval-children (per `sigma_and.rs:19`); calls
      `candNormalized(items)`. Note: MIR shape is `items: Expr[]` (each individually evaluated),
      NOT a single `Coll[SigmaProp]` input.
    - **`SigmaOr`** — symmetric to `SigmaAnd` but calls `corNormalized(items)`. Pattern A
      `addPerItemCost(10, 2, 1, n)` BEFORE eval-children.

58. **3 normalization helpers** in `mir/sigma-boolean-normalize.ts`:
    - **`cthresholdReduce(k, items)`** — direct port of `cthreshold.rs:34-84`. Collapses:
      `k === 0` → `TrivialProp(true)`; `k > items.length` → `TrivialProp(false)`; mid-loop
      short-circuits on `curr_k === 1` (→ Cor) or `curr_k === children_left` (→ Cand); final
      collapse rules post-loop. TrivialProp children are consumed without being appended.
    - **`candNormalized(items)`** — direct port of `cand.rs:29-50`. Filters `TrivialProp(true)`;
      returns `TrivialProp(false)` if any child is `TrivialProp(false)` (absorbing); returns
      `TrivialProp(true)` for empty list; unwraps single child; else `{ tag: 'Cand', items }`.
    - **`corNormalized(items)`** — direct port of `cor.rs:29-50`. Symmetric: filters
      `TrivialProp(false)`, absorbing `TrivialProp(true)`, identity `TrivialProp(false)` for empty list.

59. **GF(2^192) module** in `crypto/gf2_192.ts`:
    - **`Gf2_192Element` class**: internal `[bigint, bigint, bigint]` (three unsigned-64-bit BigInts).
      Operations: `add` (XOR), `multiply` (4-bit nibble table per `gf2_192.rs:82-153`), `sqr`,
      `invert` (Fermat's little theorem: z^(2^192 - 2)), `equals`, `isZero`, `isOne`.
      Static: `ZERO`, `ONE`, `fromBytes(bytes: Uint8Array)`, `toBytes(): Uint8Array`.
      Byte serialization: **24-byte LE-per-word** (little-endian within each 8-byte word, low word
      first, per `gf2_192.rs:315-324`). NOTE: this corrects the 2g-combinators design spec which
      said BE; source is authoritative.
      Irreducible polynomial: x^192 + x^7 + x^2 + x + 1. `IRRED_PENTANOMIAL = 0x87n`
      (`gf2_192.rs:31`: `(1i64 << 7) | (1i64 << 2) | (1i64 << 1) | 1i64`). NOTE: this corrects the
      design spec which said `0xE7`.
    - **`Gf2_192Poly` class**: Newton-form incremental construction (matching sigma-rust's
      `gf2_192poly.rs:71-115`). Operations: `interpolate(points, values, valueAtZero)` (fixture-gen
      path; passes through given points + (0, valueAtZero)); `fromCoefficientsAndConstant(bytes,
      constant)` (verifier path; reconstructs polynomial from proof coefficient bytes + parent
      challenge as degree-0 constant); `evaluate(x: number): Gf2_192Element` (Horner's method;
      `x` is 1-based child index in conjecture context); `toBytes(): Uint8Array` (serializes
      degree-1 through degree-N coefficients only, length = `degree * 24`; skips constant).
    - No new TS runtime dependencies. GF(2^192) is pure TS via `bigint`. Already on
      `@noble/curves@2.2.0` + `@noble/hashes@2.2.0` from 2g-medium.

60. **Verifier extension** — `verifySignature` now handles the FULL `SigmaBoolean` surface:
    - **`TrivialProp`** / **`ProveDlog`** / **`ProveDhTuple`**: unchanged from 2g-medium.
    - **`Cand`**: all children inherit the parent's 24-byte challenge. Per `sig_serializer.rs:174-186`.
      No per-child challenges in proof bytes for Cand. Recurse on each child; all must return `true`.
    - **`Cor`**: read explicit 24-byte challenges for first (n-1) children from proof bytes; last
      child's challenge = bitwise XOR(parent challenge, all (n-1) read challenges). Per
      `sig_serializer.rs:187-214`. Recurse on all n children with their per-child challenge.
    - **`Cthreshold`**: read `(n-k)*24` polynomial bytes (no length prefix; `n-k` derived from tree
      structure); reconstruct `Gf2_192Poly` with `constant = parent challenge as Gf2_192Element`;
      each child i (0-based array index) gets challenge = `polynomial.evaluate(i+1).toBytes()`
      (1-based eval point). Per `sig_serializer.rs:215-245`. Recurse on all n children.
    - **Fiat-Shamir internal-node byte layout**: `INTERNAL_NODE_PREFIX(0) | conj_type(0/1/2) |
      [k_byte if Cthreshold] | put_i16_be(n) | children...` (per `fiat_shamir.rs:170-201`).
    - The code `'conjecture-not-implemented'` becomes structurally unreachable but stays declared in
      `VerifyErrorCode` for ABI stability.
    - `ProofBytesReader.readBytes(n)` — new method reading exactly n bytes; throws
      `'truncated-signature'` on underrun. Used by Cthreshold verifier path.

61. **4 new `EvalError` codes** (36 → 40; note: the design spec said 39, but a 4th code was added
    during implementation for `Atleast`'s pre-`cthresholdReduce` bound check):
    - `'atleast-bound-not-int'` — `Atleast` arm: `bound` expression evaluated to non-Int.
    - `'atleast-bound-out-of-range'` — `Atleast` arm: `bound` (after Int extraction) is `< 0`,
      `> 255`, or `> items.length`. Checked before delegating to `cthresholdReduce`.
    - `'sigma-prop-coll-elem-not-sigma-prop'` — `Atleast`/`SigmaAnd`/`SigmaOr` (via
      `eval/_sigma-helpers.ts::expectSigmaProp`): a `Coll[SigmaProp]` item or individual `items`
      expression evaluated to a non-SigmaProp `SValue`.
    - `'sigma-prop-input-not-coll'` — `Atleast` (via `eval/_sigma-helpers.ts::extractSigmaPropColl`):
      `Atleast`'s `input` expression evaluated to non-Coll SValue. (`SigmaAnd`/`SigmaOr` take
      `items: Expr[]`, not a Coll input, so this code applies only to `Atleast`.)

62. **3 new `VerifyError` codes** (5 → 8):
    - `'cthreshold-polynomial-bytes-mismatch'` — currently thrown only on the defensive `k > n`
      check inside the verifier walk; reserved for future strict-check passes.
    - `'cor-derived-challenge-mismatch'` — reserved; not thrown in this slice.
    - `'cthreshold-derived-challenge-mismatch'` — reserved; not thrown in this slice.
    - (The existing `'conjecture-not-implemented'` code remains declared as RESERVED — no longer
      thrown by 2g-combinators; kept for ABI stability.)

**Coverage after 2g-combinators: 47 of ~70 `Expr` variants have implemented arms** (44 prior +
3 new: `Atleast`, `SigmaAnd`, `SigmaOr`). Full `SigmaBoolean` verifier surface shipped.

**Ships additionally (phase 2g.5 — method-call dispatch + C2 corpus unlocker):**

63. **4 new eval arms** (coverage 47 → 51 of ~70 arms):
    - **`Context`** — returns the `Value::Context` sentinel; cost 1 (Pattern A, charged via
      `ctx.addCost(1)`). Required for handlers that need to type-check their `obj` (currently
      `SContext.dataInputs`). Source: `ergotree-interpreter/src/eval/expr.rs:38`.
    - **`SigmaPropBytes`** — serializes a SigmaProp to its prop-bytes form; cost
      `addPerItemCost(35, 6, 1, 1)` (Pattern A, BEFORE eval-children); returns
      `Coll[Byte]` from `sigmaPropBytesOf(sigmaBoolean)`. Throws
      `'sigma-prop-bytes-input-not-sigma-prop'` if the input evaluates to a non-SigmaProp SValue.
      Source: `ergotree-interpreter/src/eval/sigma_prop_bytes.rs:9-24`.
    - **`MethodCall`** — dispatcher; cost 4 (Pattern A); evals obj + args; routes to per-method
      handler via `(typeId, methodId)` registry in `eval/method-call.ts`; throws
      `'method-not-implemented'` for unregistered pairs. Source:
      `ergotree-interpreter/src/eval/method_call.rs:11-23`.
    - **`PropertyCall`** — same dispatcher shape as `MethodCall` with empty args; cost 4
      (Pattern A); shares the same registry. Source:
      `ergotree-interpreter/src/eval/property_call.rs:10-20`.

64. **1 new `SValue` kind variant:** `{ kind: 'Context' }`. Mirrors sigma-rust's `Value::Context`.
    Required for handlers that type-check their `obj` argument — currently `SContext.dataInputs`
    checks `obj.kind === 'Context'`. Added to the `SValue` union in `mir/types.ts` alongside the
    other opaque sentinel kinds.

65. **`EvalOpts` / `EvalContext` gains 1 new optional field:**
    `dataInputs?: ErgoBox[]` — transaction data-inputs (read-only boxes). Mirrors sigma-rust's
    `Context::data_inputs` (`ergotree-ir/src/chain/context.rs`). `SContext.dataInputs` reads
    this. `undefined` is treated as empty (matches sigma-rust
    `map_or(Arc::new([]), ...)`). `makeContext` threads it through unchanged.

66. **New module: `eval/method-call.ts`** — exports `evalMethodCall` and `evalPropertyCall`
    dispatchers; contains the module-internal `HANDLERS` registry (a `Map<string, MethodHandler>`
    keyed by `"typeId:methodId"`); registers 3 handlers at module initialization:
    - **`SBox.tokens`** (`PropertyCall`, typeId=99, methodId=8): cost 15 (Pattern A within
      handler); returns `Coll[(Coll[Byte], Long)]` — each token as a `(tokenId, amount)` tuple.
      Throws `'method-not-implemented'` for non-Box obj (reuse per error-taxonomy Decision #1
      in design spec). Source: `ergotree-interpreter/src/eval/sbox.rs:72-79`.
    - **`SContext.dataInputs`** (`PropertyCall`, typeId=101, methodId=1): cost 15 (Pattern A
      within handler); validates `obj.kind === 'Context'` (throws `'context-obj-not-context'`
      on mismatch); returns `ctx.dataInputs ?? []` as `Coll[Box]`. Source:
      `ergotree-interpreter/src/eval/scontext.rs:17-31`.
    - **`SColl.indexOf`** (`MethodCall`, typeId=12, methodId=26): cost
      `addPerItemCost(20, 10, 2, n)` (Pattern B — charged AFTER extracting the Coll, BEFORE
      the linear search); `from < 0` clamped to 0; returns `Int` index of first matching element
      or `-1` if not found. Comparison via the existing `primitiveValueEqual` helper. Source:
      `ergotree-interpreter/src/eval/scoll.rs:21-50`.

67. **New module: `eval/sigma-prop-bytes.ts`** — exports `evalSigmaPropBytes`; calls
    `sigmaPropBytesOf(sigmaBoolean)` from `sigma/prop-bytes.ts` to serialize the inner
    `SigmaBoolean` to its prop-bytes form.

68. **New module: `eval/context.ts`** — exports `evalContext`; one-liner arm, `ctx.addCost(1)`;
    returns `{ kind: 'Context' }`.

69. **New module: `sigma/prop-bytes.ts`** — exports `sigmaPropBytesOf(sb: SigmaBoolean):
    Uint8Array`; factored from the fiat-shamir module so both `SigmaPropBytes` arm and the
    verifier path can share the same serialization logic without a circular dependency.

70. **3 new `EvalError` codes** (40 → 43; see updated EvalError taxonomy below):
    - `'sigma-prop-bytes-input-not-sigma-prop'`
    - `'method-not-implemented'`
    - `'context-obj-not-context'`

**Coverage after 2g.5: 51 of ~70 `Expr` variants have implemented arms.** C2 corpus
(`mainnet_boxes` subset evaluable by sigma-rust under a synthetic context) unlocked at
`success=18/18` — all 18 entries that reached `'context-field-missing'` or
`'not-implemented-yet'` in prior phases now evaluate cleanly when given a synthetic-context
stub (`outputs: []`, `inputs: []`, `selfBox: synthetic`, `dataInputs: []`). Phase 2g.5
**COMPLETE.** See `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md`.

**Ships additionally (phase 2g.6 — broader method-call surface; 1 Expr arm + 5 method handlers + 2 SValue variants):**

71. **1 new eval arm** (coverage 51 → 52 of ~70 arms):
    - **`Global`** — `GlobalType → Global` sentinel; Pattern A `ctx.addCost(5)` BEFORE
      returning `{ kind: 'Global' }`. Required so that method-call handlers that receive a
      `Global` object (e.g. `SGlobal.groupGenerator`) have a typed sentinel to validate
      against (`obj.kind === 'Global'`). Source:
      `ergotree-interpreter/src/eval/expr.rs:37-40`.

72. **2 new `SValue` variants** added to `mir/types.ts`:
    - **`{ kind: 'Global' }`** — opaque sentinel, no payload. Returned by the `Global`
      Expr arm (above) and consumed by `SGlobal` method handlers. Mirrors sigma-rust's
      `Value::Global`.
    - **`{ kind: 'PreHeader'; value: PreHeader }`** — value carrier. Returned by the
      `SContext.preHeader` PropertyCall handler and consumed by `SPreHeader.*` method
      handlers. `PreHeader` is the runtime stub already defined in phase 2f medium
      (`EvalOpts.preHeader?: PreHeader`); this variant wraps it in an `SValue` discriminant
      so it can flow through `evalExpr` and be matched on in subsequent method-call arms.

73. **5 new method handlers** in `eval/method-call.ts` (registry grows 3 → 8):
    - **`SGlobal.groupGenerator`** (`PropertyCall`, typeId=106, methodId=1): cost 10
      (Pattern A within handler); validates `obj.kind === 'Global'` (throws
      `'method-not-implemented'` on mismatch per error-taxonomy Decision #1); returns
      `{ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES }` — the 33-byte compressed
      secp256k1 generator point from `eval/_group-generator.ts` (already present from 2f
      medium `GlobalVars.GroupGenerator`). Source:
      `ergotree-interpreter/src/eval/sglobal.rs:32-41`.
    - **`SColl.zip`** (`MethodCall`, typeId=12, methodId=29): cost
      `addPerItemCost(10, 1, 10, obj.length)` (Pattern B — charged after obj `Coll`
      extraction; `n` is the obj's length, NOT `min(obj, arg)`); validates both inputs
      are `Coll` (throws `'method-not-implemented'` on mismatch); returns a
      `Coll[(A, B)]` — `{ kind: 'Coll', elem: { tag: 'STuple', items: [left.elem,
      right.elem] }, items: zipped }` where each item is `{ kind: 'Tuple', items:
      [lv, rv] }`. Truncates to the shorter collection (zip stops at the end of the
      shorter input). Source: `ergotree-interpreter/src/eval/scoll.rs:138-169`.
    - **`SColl.indices`** (`MethodCall`, typeId=12, methodId=14): cost
      `addPerItemCost(20, 2, 16, coll.length)` (Pattern B — charged after `Coll`
      extraction); validates input is `Coll` (throws `'method-not-implemented'` on
      mismatch); also throws `'method-not-implemented'` on overflow if `n > 2^31 - 1`
      (symmetry with sigma-rust's `i32::try_from` panic); returns a `Coll[Int]` of
      0-based indices `[0, 1, …, n-1]` of the same length as the input collection.
      Source: `ergotree-interpreter/src/eval/scoll.rs:171-193`.
    - **`SContext.preHeader`** (`PropertyCall`, typeId=101, methodId=3): cost 15 (Pattern A
      within handler); validates `obj.kind === 'Context'` (throws `'context-obj-not-context'`
      on mismatch — same code reused from `SContext.dataInputs`); reads
      `ctx.preHeader` and returns `{ kind: 'PreHeader', value: ctx.preHeader }`. If
      `ctx.preHeader` is absent throws `'context-field-missing'` (same code reused from 2f
      medium `GlobalVars`). Source: `ergotree-interpreter/src/eval/scontext.rs:72-81`.
    - **`SPreHeader.timestamp`** (`PropertyCall`, typeId=105, methodId=3): cost 10 (Pattern A
      within handler); validates `obj.kind === 'PreHeader'` (throws `'method-not-implemented'`
      on mismatch); returns `{ kind: 'Long', value: obj.value.timestamp }` (timestamp is
      already `bigint` in the `PreHeader` interface — no conversion). Source:
      `ergotree-interpreter/src/eval/spreheader.rs:20-24`.

74. **Zero new `EvalError` codes** — all 5 handlers reuse existing codes:
    `'method-not-implemented'` (obj-kind mismatch in SGlobal/SColl/SPreHeader handlers),
    `'context-obj-not-context'` (SContext.preHeader obj mismatch), and
    `'context-field-missing'` (SContext.preHeader when ctx.preHeader is absent). Total
    remains 43 (unchanged from 2g.5).

**Coverage after 2g.6: 52 of ~70 `Expr` variants have implemented arms** (51 prior + 1
new: `Global`). Method-call handler registry: 8 entries (was 3 from 2g.5; +5 from 2g.6:
`SGlobal.groupGenerator`, `SColl.zip`, `SColl.indices`, `SContext.preHeader`,
`SPreHeader.timestamp`). EvalError codes: 43 (unchanged). SValue variants: +2 (`Global`
sentinel, `PreHeader` value carrier). **Phase 2g.6 COMPLETE.**
See `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md`.

**Ships additionally (phase 2f Stop γ — Box canonical-bytes serializer + 3 hash extractors):**

36. 3 more per-variant arms wired: `ExtractBytes` (Box → Coll[Byte] of full canonical
    bytes; Fixed(12) cost BEFORE eval-child), `ExtractBytesWithNoRef` (Box → Coll[Byte]
    of canonical bytes WITHOUT tx_id + index; Fixed(12) cost BEFORE eval-child),
    `ExtractId` (Box → 32-byte blake2b-256 hash of canonical bytes; Fixed(12) cost BEFORE
    eval-child). All three follow the envelope-first cost-charging pattern (Pattern A).
37. New module `packages/ergoscript/src/wire/ergo-box-bytes.ts` exports `serializeBoxBytes`
    and `serializeBoxBytesWithoutRef` (reusable for the wallet phase). Internal refactor:
    the `SBox` arm in `serialize-svalue.ts` now delegates to a shared
    `writeBoxBodyWithoutRef` helper (no public-surface change).
38. First eval-time `blake2b` call in the package — uses the existing
    `@noble/hashes/blake2.js` dep from phase 2a. No new runtime dependency.
39. No new `EvalError` codes — all 3 Stop γ arms reuse `'extract-input-not-box'` from
    Stop α.

**Ships additionally (phase 2f Stop β — 2 structural Box-extract arms):**

33. 2 more per-variant arms wired: `ExtractRegisterAs` (Box → Option[T]
    with R0..R9 dispatch; R0..R3 synthesized from box fields, R4..R9
    read from `box.registers`; Fixed(50) cost BEFORE eval-child; type-
    assertion against `e.elemTpe` THROWS on mismatch — matches sigma-
    rust `extract_reg_as.rs:41-44`, NOT None) and `ExtractCreationInfo`
    (Box → Tuple[Int, Coll[Byte] (34 bytes: txId ++ BE u16 index)];
    Fixed(16) cost BEFORE eval-child).
34. **Two new `EvalError` codes:** `'register-id-out-of-range'`
    (registerId outside 0..=9 — mirrors sigma-rust
    `register/id.rs:32-48`) and `'register-type-mismatch'` (stored
    register's `tpe` ≠ `e.elemTpe`).
35. **Internal refactor:** Promotes the R3-synthesis helper
    `creationInfoTupleSValue(box: ErgoBox): SValue` from Task 4's
    local definition to a new shared module
    `packages/ergoscript/src/eval/_box-synthesis.ts`. Both
    ExtractRegisterAs (R3 case) and ExtractCreationInfo call the same
    helper; the 34-byte byte-array layout (32-byte txId ++ BE u16
    index) lives in one place. No public-surface change.

**Ships additionally (phase 2f Stop α — SBox wire + 2 Box-extract arms):**

27. 2 more per-variant arms wired: `ExtractAmount` (Box → Long;
    Fixed(8) cost BEFORE eval-child) and `ExtractScriptBytes` (Box →
    Coll[Byte] of box's serialized ErgoTree; Fixed(10) cost BEFORE
    eval-child). Both follow the envelope-first cost-charging pattern
    (Pattern A).
28. **SBox wire-format surface closes:** `parseSValue(SBox, …)` and
    `serializeSValue(SBox, …)` ship, replacing phase 2a's
    `'not-implemented-phase-2a'` throw for SBox specifically. Round-
    trip invariant byte-equal on all fixture entries. The other
    deferred SValue kinds (`SAvlTree`, `SHeader`, `SPreHeader`,
    `SContext`, `SGlobal`, `SAny`, `SString`, `SFunc`, `STypeVar`)
    still throw `'not-implemented-phase-2a'`.
29. **`ErgoBox.registers` runtime shape extends** from `Record<number,
    SValue | undefined>` to `Record<number, { tpe: SType; value:
    SValue } | undefined>`. Per-register `SType` carriage matches
    sigma-rust's `NonMandatoryRegisters` storing `Constant<'static>`
    and is required by the downstream `ExtractRegisterAs` arm's
    type-assertion (phase 2f Stop β).
30. **One new `EvalError` code:** `'extract-input-not-box'` (defensive
    kind-check shared across all 7 Box-extract arms; wire-format
    invariants make it unreachable for parser-produced trees).
31. **Three new `SValueParseError` codes:** `'sbox-tokens-out-of-
    range'` (count > 122), `'sbox-registers-out-of-range'` (count > 6),
    `'sbox-ergo-tree-no-size'` (parser cannot bound a `hasSize=false`
    ErgoTree without parsing the AST; all real on-chain boxes use v1+
    with `hasSize=true`).
32. **Four new `SValueSerializeError` codes:** `'token-id-length'`
    (token id ≠ 32 bytes), `'txid-length'` (txId ≠ 32 bytes),
    `'sbox-registers-not-dense'` (registers must be packed contiguously
    from R4 with no gaps; mirrors sigma-rust `register.rs:223`
    `NonDenselyPacked`), `'sbox-index-out-of-range'` (index outside
    u16 bounds).

**Coverage after 2f Stop γ:** 27 of ~70 `Expr` variants (24 prior + 3 in 2f Stop γ: `ExtractBytes`, `ExtractBytesWithNoRef`, `ExtractId`); 7 of 7 Box-extract arms shipped — **phase 2f narrow complete**.

**Coverage after 2f Stop β:** 24 of ~70 `Expr` variants (22 prior + 2 in 2f Stop β: `ExtractRegisterAs`, `ExtractCreationInfo`); 4 of 7 Box-extract arms shipped.

**Coverage after 2f Stop α:** 22 of ~70 `Expr` variants (20 prior + 2 in 2f Stop α: `ExtractAmount`, `ExtractScriptBytes`); 2 of 7 Box-extract arms shipped.

**Coverage after 2e:** 20 of ~70 `Expr` variants have implemented arms in v0.2.0 (8 from phase 2b + 3 from phase 2c: `BinOp`, `LogicalNot`, `BoolToSigmaProp` + 4 from phase 2d-A: `Negation`, `BitInversion`, `Upcast`, `Downcast` + 2 from phase 2d-B: `And`, `Or` + 3 from phase 2e: `FuncValue`, `Apply`, `XorOf`); every other variant throws `EvalError 'not-implemented-yet'`. Public function signatures (`evaluate`, `evaluateWith`, `makeContext`, `EvalError`) are stable from v0.2.0 onward — future arms slot into central dispatch without surface changes.

**Does NOT ship yet (deferred to upcoming phases):**

- **`Xor`** (byte-array XOR) — later phase (likely 2i alongside other predefs). Operates on
  `Coll[Byte] × Coll[Byte] → Coll[Byte]`; not a logical/threshold aggregator despite the name.
- Header chain-state model (`Header` runtime + header-accessor methods) — deferred to phase 2h or a future slice.
- **Broader method-call surface beyond the 8 registered handlers:** Header methods, Coll utilities (`.zipWith`, `.reverse`, `.flatten`, `.getOrElse`), `SNumericTypeMethods` Bit shifts, additional `SBox`/`SHeader`/`SPreHeader` methods. Phase 2g.6 shipped the 5 highest-demand handlers per the wider-corpus survey (`SGlobal.groupGenerator`, `SColl.zip`, `SColl.indices`, `SContext.preHeader`, `SPreHeader.timestamp`); the rest wait until phase 2i or corpus demand resurfaces. The registry infrastructure is fully shipped (phase 2g.5); adding handlers is a per-method micro-task.
- Sigma protocol prover (`prove`). `verifySignature` ships in 2g-medium (leaf-only: TrivialProp, ProveDlog, ProveDhTuple). Full conjecture-verifier coverage ships in 2g-combinators.
- AVL+ membership-proof verification (`verifyMembershipProof`, `lookupInTree`) — later phase.
- BinOp `Bit` shift ops via `SNumericTypeMethods` — when method-call dispatch lands.
- `Box` / `AvlTree` equality comparison (currently `'not-implemented-yet'` from `sValueEquals`) — when the chain-state model lands.
- Real-context cost validation (Layer C3) — calibration phase after all arms are in.
- `ergoscript-compiler` (`.es` source → bytes). Out of scope until upstream PR 862 settles. Would be a sibling package, not part of this one.
- AOT interpreter. Upstream is deprecating it; we target `R5.0-JIT-verify` semantics exclusively.
- Transaction building, key derivation, mnemonic handling, BIP32. Those belong to the phase 3 wallet package.
- Network or filesystem access. The package is a pure library.

## Public surface

### Primary export: `@mwaddip/ergots-ergoscript` (via `index.ts`)

```ts
parseTree(bytes: Uint8Array): ErgoTree
serializeTree(tree: ErgoTree): Uint8Array

isP2PK(tree: ErgoTree): boolean
p2pkPublicKey(tree: ErgoTree): Uint8Array | null
addressFromErgoTree(tree: ErgoTree, network: Network): string
ergoTreeFromAddress(address: string): ErgoTree

base58Encode(bytes: Uint8Array): string
base58Decode(s: string): Uint8Array

verifySignature(sigmaBoolean: SigmaBoolean, message: Uint8Array, signature: Uint8Array): boolean  // phase 2g-medium
class VerifyError extends Error { code: string }   // phase 2g-medium

const MAX_TREE_SIZE: 1_048_576    // 1 MB
const VERSION: '0.2.0'

type Network = 'mainnet' | 'testnet'
type AddressType = 'P2PK' | 'P2S'
type ErgoTree, TreeHeader, SType, SValue, Expr, SigmaBoolean
```

#### `parseTree(bytes)`

- **Precondition:** `bytes.length >= 1` and `bytes.length <= MAX_TREE_SIZE` (1 MB). The cap mirrors sigma-rust's practical bound (largest real-world ErgoTree in the PR 862 corpus is ergoraffle at 931 bytes); 1 MB is comfortably above that ceiling while bounding memory against adversarial inputs.
- **Postcondition (success):** Returns an `ErgoTree` whose `serializeTree` is byte-identical to the input. See `Round-trip invariant` below.
- **Postcondition (failure):** Throws `ErgoTreeParseError` for envelope-level malformations (`empty`, `oversized`, `body-size-overflow`, `too-many-constants`). Body-parse failures surface as `ExprParseError` from the body parser; SType / SValue failures surface as `STypeParseError` / `SValueParseError` / `SigmaBooleanParseError`. The envelope does not wrap them — callers see the typed failure surface from the innermost layer that rejected the bytes. `ReaderError` from the underlying cursor may also surface (`truncated`, `vlq-overflow`).

#### `serializeTree(tree)`

- **Precondition:** `tree` was either returned from `parseTree` or constructed satisfying the type invariants below. The `header.rawHeader` byte MUST be derivable from `header.version`, `header.hasSize`, and `header.constantSegregation` (the projection is round-trip-checked at serialize time). `constantTypes.length === constants.length` is required.
- **Postcondition:** Returns `Uint8Array` of length ≤ `MAX_TREE_SIZE`. For any `tree` returned by `parseTree(b)`, `serializeTree(parseTree(b))` equals `b` byte-for-byte.
- **Postcondition (failure):** Throws `ErgoTreeSerializeError` with `code` `'header-inconsistent'` (rawHeader mismatch) or `'constants-arity-mismatch'`. Body-serialize failures surface as `ExprSerializeError` (notably `'not-supported'` for the un-encodable `ZkProofBlock` variant).

#### `isP2PK(tree)` / `p2pkPublicKey(tree)`

- **Precondition:** `tree` is a valid `ErgoTree`.
- **Postcondition (`isP2PK`):** Returns `true` iff the tree's body is the canonical P2PK shape — `Const(SSigmaProp, ProveDlog(EcPoint))` or a `ConstPlaceholder` resolving to the same — matching sigma-rust's `Address::P2Pk.script()` recognition (`ergotree-ir/src/chain/address.rs:206-218`).
- **Postcondition (`p2pkPublicKey`):** Returns a defensive 33-byte copy of the compressed secp256k1 public key when `isP2PK(tree)` is true, else `null`. The returned buffer is fresh — mutating it does not affect the tree's internal storage.
- **Invariant:** Trees whose body is `CreateProveDlog(GroupElement)` (a derived form) are NOT classified as P2PK — sigma-rust only recognizes the canonical `Const(SSigmaProp, _)` form. Using a non-canonical shape would break the address → tree → address round-trip against any other Ergo implementation.

#### `addressFromErgoTree(tree, network)` / `ergoTreeFromAddress(address)`

- **Precondition (`addressFromErgoTree`):** `tree` is a valid `ErgoTree`; `network` is `'mainnet'` or `'testnet'`.
- **Postcondition (`addressFromErgoTree`):** Returns a base58check Ergo address. If `isP2PK(tree)`, the address is P2PK (content bytes are the 33-byte EcPoint only, NOT the serialized tree). Otherwise the address is P2S (content bytes are the full serialized ErgoTree).
- **Precondition (`ergoTreeFromAddress`):** `address` is a base58check Ergo address with valid checksum and a supported address type.
- **Postcondition (`ergoTreeFromAddress`):** Returns the `ErgoTree` encoded by the address. P2PK addresses are reconstructed by synthesizing canonical bytes (`0x00 0x08 0xcd <33 bytes pubkey>`) and parsing them — every returned tree goes through `parseTree`, so the type invariants below hold.
- **Postcondition (failure):** Throws `AddressDecodeError` with `code` `'bad-base58'`, `'too-short'`, `'checksum-mismatch'`, `'invalid-p2pk-length'`, `'p2sh-unsupported'`, or `'unknown-type'`. A P2S address carrying malformed tree bytes throws `ErgoTreeParseError` (or a downstream parser error) — those bubble up unwrapped.
- **Round-trip invariant:** For any tree `t` and matching network `n`, `ergoTreeFromAddress(addressFromErgoTree(t, n))` parses to a structurally equivalent `ErgoTree`. P2SH addresses are NOT round-trippable through this function (they are derived from a 24-byte hash, not a serialized tree) and decoding one throws `p2sh-unsupported`.

#### `verifySignature(sigmaBoolean, message, signature)` *(phase 2g-medium; extended in 2g-combinators)*

- **Precondition:** `sigmaBoolean` is a valid `SigmaBoolean` (typically the `.value` from a `SValue.kind: 'SigmaProp'`). `message` is any `Uint8Array` (the hash/message signed by the prover). `signature` is the serialized Schnorr proof bytes as produced by sigma-rust's prover (or an equivalent conformant prover).
- **Postcondition (success — full 6-variant surface from 2g-combinators):**
  - `TrivialProp(true)` → returns `true` (signature is ignored, per sigma-rust `verifier.rs:97`).
  - `TrivialProp(false)` → returns `false` (signature is ignored).
  - `ProveDlog` or `ProveDhTuple` → returns `true` if and only if the Schnorr-style proof in `signature` is valid for `sigmaBoolean` and `message`. Returns `false` for a syntactically valid but cryptographically incorrect proof. (A proof is syntactically valid if it contains a 24-byte challenge and the correct number of 32-byte scalars for the leaf type.)
  - `Cand` → verifies recursively; all children inherit the parent 24-byte challenge; returns `true` iff all children verify.
  - `Cor` → reads explicit challenges for first (n-1) children from proof bytes; derives last child's challenge via XOR(parent, read challenges); returns `true` iff all children verify.
  - `Cthreshold` → reads `(n-k)*24` polynomial coefficient bytes; reconstructs `Gf2_192Poly` with constant = parent challenge; each child i (0-based) gets challenge = `polynomial.evaluate(i+1)`; returns `true` iff all children verify.
- **Postcondition (failure):** Throws `VerifyError` in these cases:
  - `'conjecture-not-implemented'` — **RESERVED; no longer thrown** (2g-combinators ships the full conjecture walk). Code stays declared for ABI stability.
  - `'empty-signature'` — `signature.length === 0`. A typed throw (vs sigma-rust's `Ok(false)`) so callers can distinguish "no proof provided" from "incorrect proof". (Decision #5 in the design spec.)
  - `'truncated-signature'` — the signature ran out of bytes during tree-walk parsing (e.g., challenge present but 32-byte scalar bytes missing, or polynomial bytes shorter than `(n-k)*24`).
  - `'point-not-on-curve'` — a pubkey/component byte-array on a `ProveDlog` or `ProveDhTuple` leaf failed secp256k1 decompression (off-curve or invalid encoding).
  - `'scalar-out-of-range'` — **reserved; currently not thrown.** `scalarFromBytes` reduces mod n silently (mirroring sigma-rust's `Scalar::reduce_bytes` at `wscalar.rs:60-67`). Declared in `VerifyErrorCode` for a future slice.
  - `'cthreshold-polynomial-bytes-mismatch'` — thrown on defensive `k > n` check inside verifier; reserved for future strict-check passes.
  - `'cor-derived-challenge-mismatch'` — reserved; not thrown in this slice.
  - `'cthreshold-derived-challenge-mismatch'` — reserved; not thrown in this slice.
- **No tree-version gating.** The verifier does not read `treeVersion`; sigma-protocol verification is tree-version-independent.
- **Trailing bytes accepted.** Extra bytes after the last parsed scalar are silently ignored (mirrors sigma-rust's `proof_append_some_byte` proptest at `verifier.rs:229-235`).
- **Not a cost-charging operation.** `verifySignature` is a separate public function from `evaluate`; it does not interact with `EvalContext` or `jitCost`. Callers who want both evaluation cost and signature verification compose `evaluateWith` + `verifySignature` manually.

### Internal modules (current monorepo surface)

The package's `index.ts` exposes the consumer-facing surface above. Internal modules under `wire/`, `mir/`, and `crypto/` carry additional types and error classes that downstream packages in this monorepo (and the test suite) reach into directly while the package is pre-publish:

```ts
// wire/parse.ts
parseExpr(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes?: Map<number, SType>
): Expr

// wire/serialize.ts
serializeExpr(e: Expr, w: ByteWriter): void

// wire/parse-stype.ts / wire/serialize-stype.ts
parseSType(r: ByteReader): SType
serializeSType(t: SType, w: ByteWriter): void

// wire/parse-svalue.ts / wire/serialize-svalue.ts
parseSValue(tpe: SType, r: ByteReader): SValue
serializeSValue(tpe: SType, v: SValue, w: ByteWriter): void

// wire/sigma-boolean.ts
parseSigmaBoolean(r: ByteReader): SigmaBoolean
sigmaBooleanOpCode(sb: SigmaBoolean): number | null
proveDlogPublicKey(sb: SigmaBoolean): Uint8Array | null

// wire/reader.ts / wire/writer.ts
class ByteReader
class ByteWriter

// mir/expr-tpe.ts
exprTpe(e: Expr): SType
```

`parseExpr` accepts the parallel-indexed segregated constant arrays from the surrounding ErgoTree envelope. `constantTypes` is consulted by the `ConstantPlaceholder` handler to recover a placeholder's `SType` from its id; `constantValues` is reserved for substitution-at-parse-time semantics (sigma-rust's `substitute_placeholders` flag — not currently used). `valDefTypes` is a shared scope-wide `Map<ValId, SType>` populated by `ValDef` parsers and read by `ValUse` parsers (mirrors sigma-rust's `SigmaByteReader.val_def_type_store`); the outer envelope creates a fresh empty map per tree, and recursive descent shares it across the whole Expr graph.

Once the package publishes, these symbols will likely move behind a `/wire` subpath export (the proof package's `/envelope` pattern). Until then, this file documents their current shape so downstream packages can rely on them.

### Round-trip invariant

For any byte sequence `b` accepted by `parseTree`:

```
serializeTree(parseTree(b)) === b   (byte-equal)
```

This holds for every ErgoTree variant we ship. The phase 2a corpus test asserts this on 255 passing fixtures plus 1 mainnet-fixture stub plus 6 upstream-buggy fixtures (the 6 are excluded from byte-equality; sigma-rust itself does not round-trip them — see `fixture-gen/known_unstable.json`).

For the body-only round-trip (i.e., parsing a `parseExpr` output and reserializing through `serializeExpr` into a fresh `ByteWriter`), the same byte-equality invariant holds.

## Type invariants

These hold on every `ErgoTree` returned by the public API. Callers may rely on them without re-checking.

```ts
type Network = 'mainnet' | 'testnet'
type AddressType = 'P2PK' | 'P2S'

interface TreeHeader {
  version: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7   // bits 0..2 of rawHeader
  hasSize: boolean                          // bit 3: VLQ-u32 body size follows
  constantSegregation: boolean              // bit 4: segregated constants section
  rawHeader: number                         // original byte; derivable from the three fields above
}

interface ErgoTree {
  header: TreeHeader
  constantTypes: SType[]            // parallel to constants[]; required for byte-exact re-serialize
  constants: SValue[]               // empty when header.constantSegregation === false
  body: Expr                        // root expression
}

type SType =
  | { tag: 'SBoolean' } | { tag: 'SByte' } | { tag: 'SShort' }
  | { tag: 'SInt' } | { tag: 'SLong' } | { tag: 'SBigInt' }
  | { tag: 'SGroupElement' } | { tag: 'SSigmaProp' } | { tag: 'SBox' }
  | { tag: 'SAvlTree' } | { tag: 'SUnit' } | { tag: 'SAny' }
  | { tag: 'SHeader' } | { tag: 'SPreHeader' } | { tag: 'SContext' }
  | { tag: 'SGlobal' } | { tag: 'SString' }
  | { tag: 'SColl';  elem: SType }
  | { tag: 'STuple'; items: SType[] }
  | { tag: 'SOption'; elem: SType }
  | { tag: 'SFunc'; args: SType[]; result: SType; tpeParams: STypeVar[] }
  | { tag: 'STypeVar'; name: string }

type SValue =
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Byte' | 'Short' | 'Int'; value: number }
  | { kind: 'Long' | 'BigInt'; value: bigint }
  | { kind: 'GroupElement'; value: Uint8Array }   // 33-byte compressed secp256k1
  | { kind: 'SigmaProp'; value: SigmaBoolean }    // opaque raw bytes in phase 2a
  | { kind: 'Box'; value: ErgoBox }
  | { kind: 'AvlTree'; value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Coll'; elem: SType; items: SValue[] }
  | { kind: 'Tuple'; items: SValue[] }
  | { kind: 'Option'; elem: SType; value: SValue | null }
  | { kind: 'Lambda'; closure: Closure }
  | { kind: 'Context' }                              // phase 2g.5 — Context Expr arm sentinel
  | { kind: 'Global' }                               // phase 2g.6 — Global Expr arm sentinel
  | { kind: 'PreHeader'; value: PreHeader }          // phase 2g.6 — PreHeader value carrier
```

`Expr` is the 68-variant discriminated union over MIR nodes, keyed on `tag`. Each variant's payload mirrors sigma-rust's `mir/<variant>.rs` struct fields. Full list and per-variant shapes live in `packages/ergoscript/src/mir/types.ts`; adding a variant requires corresponding arms in `wire/parse.ts` and `wire/serialize.ts` (both files use exhaustive switches to make additions compile-time-visible).

- `rawHeader` is the on-wire byte. The `version`, `hasSize`, `constantSegregation` fields are derived projections kept on the struct so callers don't need to re-decode bits. `serializeTree` writes `rawHeader` directly but validates that it matches the derived fields — a hand-constructed `ErgoTree` with inconsistent fields is rejected at serialize time with `'header-inconsistent'`.
- `constantTypes` is parallel to `constants[]` and carries the per-constant `SType` recovered from the wire. It's necessary because a parsed `SValue` does not unambiguously encode its `SType` for some edge cases (empty `Coll`, `None` for `SOption`); sigma-rust avoids this because its `Constant { tpe, v }` couples them at the struct level.
- `SigmaBoolean` (phase 2g-medium) is a 6-variant discriminated union (`TrivialProp` / `ProveDlog` / `ProveDhTuple` / `Cand` / `Cor` / `Cthreshold`). Wire parser produces all 6; the runtime verifier (phase 2g-medium leaf-only) walks only the 3 leaf-style variants. Conjecture walks (`Cand`/`Cor` XOR challenge derivation; `Cthreshold` GF(2^192) polynomial Lagrange interpolation) ship in `2g-combinators`. The `SValue.kind: 'SigmaProp'` container discriminator is unchanged; `.value` changed from the phase 2a opaque `{ raw: Uint8Array }` shape to the structural 6-variant union.
- `ErgoBox`, `AvlTreeData`, and `Closure` are forward-declared in phase 2a. Their shapes are stable for the wire-format surface but evaluator-only fields may be added in later phases.

## Determinism and purity

- All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output.
- No async surface. Every function is synchronous. (Rationale: the parser hits VLQ loops and blake2b in tight inner sections; the async boundary would only add overhead.)
- No throwing on success paths. Throws indicate contract violations or input rejection — they're the typed failure surface.

## Browser-compat guarantees

Runtime support: Node ≥ 20, evergreen browsers with native ESM. Specifically:

- All Uint8Arrays. Never `Buffer`. (`Buffer.from(...)` does not exist in browsers.)
- `globalThis.crypto` is not used. Hashing comes from `@noble/hashes` only; secp256k1 curve operations come from `@noble/curves` (phase 2g-medium+). Both are browser-clean ESM packages.
- `bigint` is used for `SLong`, `SBigInt`, and 64-bit-safe VLQ reads. Browsers support `bigint` natively since 2020; no polyfill ships.
- No top-level `await`.
- No WASM. No `.wasm` blobs anywhere in the package, no direct or transitive WASM dependencies. CI scans `dist/` for `.wasm` files, `WebAssembly.instantiate`, Buffer/process/node:* references, and Scala.js identifier patterns (to catch accidental `sigma-js` imports).
- Bundle is ESM-only. The package's `exports` map deliberately omits CJS entry points.

## Error taxonomy

Every error class carries a `code: string` matching one of a fixed set of structural reasons for programmatic dispatch. `.message` is human-readable.

```ts
class ErgoTreeParseError      extends Error { code: string }
class ErgoTreeSerializeError  extends Error { code: string }
class ExprParseError          extends Error { code: string }
class ExprSerializeError      extends Error { code: string }
class STypeParseError         extends Error { code: string }
class STypeSerializeError     extends Error { code: string }
class SValueParseError        extends Error { code: string }
class SValueSerializeError    extends Error { code: string }
class SigmaBooleanParseError  extends Error { code: string }
class ExprTpeError            extends Error { code: string }
class ReaderError             extends Error { code: string }
class AddressDecodeError      extends Error { code: string }
class VerifyError             extends Error { code: string }   // phase 2g-medium
```

Per-class code enumeration (every code below is emitted by current source):

- **`ErgoTreeParseError`**: `'empty'`, `'oversized'`, `'body-size-overflow'`, `'too-many-constants'`, `'header-inconsistent'`.
- **`ErgoTreeSerializeError`**: `'header-inconsistent'`, `'constants-arity-mismatch'`.
- **`ExprParseError`**: `'not-implemented-yet'` (named in sigma-rust's opcode table but no TS handler — covers `OpTrue`, `OpFalse`, `UnitConstant`, `LastBlockUtxoRootHash`, `Select1..Select5`, `FlatMap`, `FunDef`, `SomeValue`, `NoneValue`, `TrivialPropFalse`, `TrivialPropTrue`, `ModQ`, `PlusModQ`, `MinusModQ`, `CollShiftLeft/Right/RightZeroed`, `CollRotateLeft/Right`); `'unknown-opcode'` (byte not in sigma-rust's opcode table at all); plus per-variant codes including `'apply-too-many-args'`, `'block-too-many-items'`, `'collection-size-out-of-range'`, `'deserialize-context-id-out-of-range'`, `'deserialize-register-id-out-of-range'`, `'extract-register-as-id-out-of-range'`, `'func-value-too-many-args'`, `'get-var-id-out-of-range'`, `'invalid-binop-opcode'`, `'invalid-constant-placeholder-id'`, `'invalid-option-tag'`, `'method-call-id-out-of-range'`, `'method-call-missing-type-arg'`, `'method-call-too-many-args'`, `'property-call-id-out-of-range'`, `'select-field-index-out-of-range'`, `'tuple-arity-out-of-range'`, `'unknown-binop-kind'`, `'val-def-rhs-tpe'`, `'val-use-unknown-id'`.
- **`ExprSerializeError`**: `'not-supported'` (the `ZkProofBlock` variant — matches sigma-rust's `NotSupported`); `'unknown-variant'` (compile-time-unreachable fallback for the exhaustive switch).
- **`STypeParseError`**: `'invalid-type-code'`, `'unsupported-type'`, `'invalid-tuple-length'`, `'invalid-stypevar-length'`, `'invalid-stypevar-utf8'`, `'invalid-sfunc-tpe-params'`.
- **`STypeSerializeError`**: `'tuple-too-short'`, `'tuple-too-long'`, `'stypevar-name-length'`, `'sfunc-tdom-too-long'`, `'sfunc-tpe-params-too-long'`, `'unreachable'`.
- **`SValueParseError`**: `'bigint-too-large'`, `'coll-length-out-of-range'`, `'not-implemented-phase-2a'` (still emitted for `SAvlTree`/`SHeader`/`SPreHeader`/`SContext`/`SGlobal`/`SAny`/`SString`/`SFunc`/`STypeVar`; `SBox` removed from this set in phase 2f Stop α), `'unreachable'`, `'sbox-tokens-out-of-range'`, `'sbox-registers-out-of-range'`, `'sbox-ergo-tree-no-size'`.
- **`SValueSerializeError`**: `'bigint-too-large'`, `'group-element-length'`, `'coll-length-out-of-range'`, `'coll-item-kind-mismatch'`, `'tuple-arity-mismatch'`, `'sigma-boolean-empty'`, `'type-value-mismatch'`, `'not-implemented-phase-2a'` (same deferred-kinds set as parse; `SBox` removed in phase 2f Stop α), `'unreachable'`, `'token-id-length'`, `'txid-length'`, `'sbox-registers-not-dense'`, `'sbox-index-out-of-range'`, `'sbox-tokens-out-of-range'`.
- **`SigmaBooleanParseError`**: `'arity-out-of-range'`, `'unknown-opcode'`, `'cthreshold-k-out-of-range'` (Cthreshold's `k` outside `[1, items.length]`; added phase 2g-medium), `'sigma-conjecture-empty-items'` (Cand/Cor/Cthreshold parsed with `items.length === 0`; added phase 2g-medium).
- **`ExprTpeError`** (raised by `exprTpe`, the SType-of-Expr projection): `'apply-func-not-sfunc'`, `'bin-op-kind-unhandled'`, `'by-index-input-not-scoll'`, `'option-get-input-not-soption'`, `'select-field-input-not-stuple'`, `'select-field-out-of-range'`, `'tpe-not-implemented'`.
- **`ReaderError`** (raised by `ByteReader`): `'truncated'`, `'vlq-overflow'`, `'slice-out-of-bounds'`.
- **`AddressDecodeError`**: `'bad-base58'`, `'too-short'`, `'checksum-mismatch'`, `'invalid-p2pk-length'`, `'p2sh-unsupported'`, `'unknown-type'`.
- **`VerifyError`** (phase 2g-medium + 2g-combinators; 8 codes total): `'conjecture-not-implemented'` (**RESERVED — no longer thrown** as of 2g-combinators; conjecture walk is now implemented; code stays declared for ABI stability), `'empty-signature'` (signature byte sequence is empty — typed throw per Decision #5 in the design spec; sigma-rust returns `Ok(false)` here), `'truncated-signature'` (proof ran out of bytes during tree-walk parsing — challenge present but scalar bytes missing, or Cthreshold polynomial bytes shorter than `(n-k)*24`), `'point-not-on-curve'` (SEC1 decode rejected a leaf pubkey/component — off-curve or malformed encoding). The code `'scalar-out-of-range'` is declared in `VerifyErrorCode` but currently **not thrown** — `scalarFromBytes` reduces mod n silently, matching sigma-rust's `Scalar::reduce_bytes` posture; reserved for a future slice. Three new codes added in 2g-combinators: `'cthreshold-polynomial-bytes-mismatch'` (thrown on defensive `k > n` check inside verifier walk; reserved for future strict checks), `'cor-derived-challenge-mismatch'` (**reserved; not thrown in this slice**), `'cthreshold-derived-challenge-mismatch'` (**reserved; not thrown in this slice**).

No other error classes are emitted by this package. Internal panics (e.g. a bug in `@noble/hashes` or `@noble/curves`) bubble up as plain `Error` — those represent contract violations *inside* the package and are bugs, not input-shape issues.

## Test plan summary

(Detail in `docs/specs/2026-05-13-ergoscript-interpreter-design.md` § Validation strategy.)

1. **Layer 1 — Parse + round-trip on every fixture**: `test/corpus.test.ts` loads the full fixture corpus (sigma-rust unit tests, ergoscript-compiler tests, real mainnet boxes, synthetic VLQ/SType edge cases) and asserts both structural parse correctness AND byte-identical round-trip. Current state: 255 passing fixtures + 1 mainnet stub + 6 fixtures flagged `known_unstable` (upstream sigma-rust itself does not round-trip them; tracked in `fixture-gen/known_unstable.json`).
2. **Layer 2 — Evaluation correctness**: per-arm unit tests under `test/eval/*.test.ts` (one file per implemented arm) cover happy paths, every `EvalError` code, and cost telemetry assertions. Layer C2 (`test/corpus-eval.test.ts`) cross-checks the TS evaluator against the sigma-rust eval oracle on every `mainnet_boxes` fixture whose body is fully covered by the implemented arms — 18 / 173 such fixtures are currently evaluable by sigma-rust under a synthetic-empty context; the rest hit `not-implemented-yet` and are skipped (informational aggregate logged). The 18 evaluable mainnet trees all still hit `'not-implemented-yet'` after phase 2d-B (they require arms beyond the current 17 — method calls, context access, collection HOFs, etc.); `other=0` confirms no undocumented codes are emitted. Phases 2e+ will progressively unlock more fixtures as arms land.
3. **Layer 3 — Mutation tests**: `test/parse-mutation.test.ts` performs single-byte flips at varied offsets across every fixture and asserts each mutation either throws one of the typed error classes above OR is byte-identical (a flip that lands in a tolerated padding region). Current state: 6221 mutations exercised; 66% throw a typed error class, 0 throw an untyped error, 100% taxonomy coverage (every error class above is hit at least once).
4. **Cross-runtime**: vitest runs every test under both `node` and `jsdom` environments. Current state: 2658/2658 ergoscript tests + 305 proof tests = 2963 total, passing in both runtimes. (+3 since phase 2g.5: phase 2g.6 Global arm + 5 method handlers fixtures + known-methods test updates.)

## v0.2.0 — Evaluator surface (phase 2b)

The phase 2b release adds a public evaluator entry point and the supporting context / cost / error types. Wire-format parse + serialize are unchanged from v0.1.0 (phase 2a); this section is purely additive.

### Public exports added in v0.2.0

```ts
evaluate(tree: ErgoTree, opts?: EvalOpts): SValue
evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue

makeContext(opts?: EvalOpts): EvalContext

class EvalError extends Error { code: string }

interface EvalOpts {
  jitCostLimit?: number          // undefined = unlimited (signing-style)
  constants?: SValue[]           // overrides tree.constants for ConstPlaceholder
  treeVersion?: number           // 0..7; auto-derived from tree.header.version in evaluate(); arms default to 0 on undefined
  // Chain-state fields (phase 2f medium + 2g.5):
  height?: number                // current block height
  selfBox?: ErgoBox              // spending box
  inputs?: ErgoBox[]             // transaction inputs
  outputs?: ErgoBox[]            // transaction outputs
  preHeader?: PreHeader          // pre-header of current block
  extension?: ContextExtension   // context-extension key-value map
  dataInputs?: ErgoBox[]         // transaction data-inputs (phase 2g.5)
}

interface EvalContext extends EvalOpts {
  jitCost: number                                                  // mutable accumulator
  addCost(amount: number): void
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void
}
```

`Env`, `evalExpr`, and the per-arm functions (`evalConst`, `evalIf`, `evalBlockValue`, …) are intentionally NOT exported — they are internal to the evaluator and may change without notice. Callers compose evaluation via the four entry points above.

#### `evaluate(tree, opts?)`

- **Precondition:** `tree` is a valid `ErgoTree` (typically returned by `parseTree`). `opts.constants`, when provided, must be parallel to whatever set of `ConstantPlaceholder` ids the tree's body references.
- **Postcondition (success):** Returns the `SValue` produced by evaluating `tree.body` under a freshly constructed `EvalContext`. The context is initialised with `constants: opts.constants ?? tree.constants` (so callers who want the tree's segregated constants picked up automatically don't need to do anything extra) and `jitCostLimit: opts.jitCostLimit` (defaulting to `undefined` = unlimited).
- **Postcondition (failure):** Throws `EvalError` with one of the codes enumerated below. Errors raised from inside the recursive evaluator (e.g. an unhandled variant deep inside a `BlockValue`) bubble up unwrapped — `evaluate` does not catch and rewrap.
- **Coverage caveat:** 52 of ~70 `Expr` variants currently have implemented arms (8 from 2b + 3 from 2c + 4 from 2d-A + 2 from 2d-B + 3 from 2e + 7 from 2f narrow + 6 from 2f medium: `GlobalVars`, `GetVar`, `OptionGet`, `OptionIsDefined`, `OptionGetOrElse`, `SelectField` + 9 from 2f Coll HOFs: `SizeOf`, `Append`, `ByIndex`, `Slice`, `MapColl`, `Filter`, `Fold`, `Exists`, `ForAll` + 2 from 2g-medium: `CreateProveDlog`, `CreateProveDhTuple` + 3 from 2g-combinators: `Atleast`, `SigmaAnd`, `SigmaOr` + 4 from 2g.5: `Context`, `SigmaPropBytes`, `MethodCall`, `PropertyCall` + 1 from 2g.6: `Global`). Any tree whose body — or whose evaluation reaches — any other variant throws `EvalError 'not-implemented-yet'`. Phases 2h–2j add the remaining arms; the `evaluate` signature itself is stable.

#### `evaluateWith(tree, ctx)`

- **Precondition:** `tree` is a valid `ErgoTree`. `ctx` is a caller-constructed `EvalContext` (typically from `makeContext(opts)`); the caller is responsible for setting `ctx.constants` if `ConstantPlaceholder` resolution is desired (`evaluateWith` does NOT default it from `tree.constants`, in contrast with `evaluate`).
- **Postcondition (success):** Returns the `SValue` produced by evaluating `tree.body` under the supplied `ctx`. The context is mutated in place — after the call returns, callers may inspect `ctx.jitCost` to read the total cost charged. This is the entry point used by tests and tooling that need post-eval cost telemetry.
- **Postcondition (failure):** Same `EvalError` taxonomy as `evaluate`. The context's `jitCost` reflects all cost charged up to (and including) the point of the throw — partial costs are NOT rolled back.

#### `makeContext(opts?)`

- **Precondition:** `opts` is a (possibly empty) `EvalOpts`.
- **Postcondition:** Returns a fresh `EvalContext` with `jitCost: 0`, `jitCostLimit: opts.jitCostLimit`, `constants: opts.constants`, and the `addCost` / `addPerItemCost` methods bound to the returned object.
- **Determinism:** Pure constructor; no I/O, no clock, no PRNG. Same opts in, structurally equivalent context out.

#### `EvalContext.addCost(amount)`

- **Semantics:** Saturating add — `ctx.jitCost = Math.min(ctx.jitCost + amount, Number.MAX_SAFE_INTEGER)`. The clamp is a defensive guard; in practice the cost limit (if set) trips long before saturation matters.
- **Limit enforcement:** If `ctx.jitCostLimit !== undefined` and the new total exceeds it, throws `EvalError 'cost-limit-exceeded'`. The throw happens *after* the cost is added to `jitCost` — callers inspecting `jitCost` after a cost-limit failure see the over-limit total, not the pre-add value.
- **Mirror of:** sigma-rust `Context::add_jit_cost` (`ergotree-ir/src/chain/context.rs:77-86`).

#### `EvalContext.addPerItemCost(base, perChunk, chunkSize, nItems)`

- **Semantics:** Composite charge — `addCost(base + ceil(nItems / chunkSize) * perChunk)`. Used by `BlockValue` envelope (`addPerItemCost(1, 1, 10, items.length)`) and by all 9 Coll HOF arms as their outer Pattern A charge (see phase 2f Coll HOFs ships-additionally block for per-arm parameters).
- **Formula:** `totalCharge = base + Math.ceil(nItems / chunkSize) * perChunk`. When `nItems === 0`, `Math.ceil(0 / chunkSize) === 0`, so only `base` is charged.
- **Limit enforcement:** Inherits from `addCost`; the *total* composite charge is checked against `jitCostLimit` after addition (not split into base + per-chunk sub-checks).
- **Mirror of:** sigma-rust `Context::add_per_item_jit_cost` (`ergotree-ir/src/chain/context.rs:88-99`).

### `EvalError` taxonomy (v0.2.0)

`EvalError` carries a `code: string` distinct from the wire-layer error classes. Every code below is emitted by current source under the conditions noted.

- **`'not-implemented-yet'`** — central dispatch (`eval/eval.ts`) hit an `Expr` variant with no arm yet (~26 variants remaining after phase 2g-medium). The arm tasks in phases 2g-combinators–2j progressively replace these with explicit cases. Message includes the offending `tag`.
- **`'cost-limit-exceeded'`** — `EvalContext.addCost` (and therefore `addPerItemCost`) detected `ctx.jitCost > ctx.jitCostLimit` after a charge. Only raised when the caller set `jitCostLimit` (the default of `undefined` skips the check entirely). Message includes the configured limit.
- **`'val-def-outside-block'`** — the `ValDef` arm was reached at the top level (or as an arbitrary sub-expression). `ValDef` is only structurally valid as an item inside `BlockValue.items`; reaching it elsewhere is a malformed-tree error. Mirrors sigma-rust's `EvalError::UnexpectedExpr` rejection in `eval.rs:66-68`.
- **`'val-use-unbound'`** — `ValUse(id)` referenced a `valId` with no binding in the current `Env`. The cost (5) is charged BEFORE the env lookup, mirroring sigma-rust, so an unbound `ValUse` still consumes 5 jitCost. Message includes the missing `valId`.
- **`'const-placeholder-id-out-of-range'`** — `ConstPlaceholder(id)` referenced an `id >= ctx.constants.length`. Message includes both `id` and `constants.length`.
- **`'const-placeholder-no-constants'`** — `ConstPlaceholder` was reached but `ctx.constants` is `undefined`. Most commonly hit when calling `evaluateWith` without setting `ctx.constants` (the higher-level `evaluate` defaults it from `tree.constants`).
- **`'if-condition-not-boolean'`** — the `If` arm's `condition` evaluated to an `SValue` whose `kind !== 'Boolean'`. Message includes the actual `kind`. Sigma-rust raises `EvalError::TryExtractFrom` here; we surface it as a typed code for cleaner programmatic dispatch.
- **`'collection-elem-kind-mismatch'`** — inside the `Collection` arm with `kind: 'Exprs'`, an evaluated item's `kind` did not match the declared `elemTpe`. This is a fail-fast guard that sigma-rust does not perform at eval time (the upstream type checker is supposed to have caught it); we add it as a defensive check on the verifier path. Only primitive types are validated; composite types (`SColl`, `STuple`, etc.) and chain-state types (`SBox`, `SAvlTree`, …) currently always match (deferred to later phases). Message includes the offending index, the actual `kind`, and the expected `tag`.
- **`'block-item-not-val-def'`** — inside the `BlockValue` arm, `items[i].tag !== 'ValDef'`. Mirrors sigma-rust's `EvalError::UnexpectedExpr` rejection in `block.rs:13-65`. Message includes the offending index and tag.

The following codes were added in phase 2c (BinOp / LogicalNot / BoolToSigmaProp arms):

- **`'arith-overflow'`** — `BinOp.Arith` (Plus / Minus / Multiply / Divide / Modulo) computed a result outside the operand kind's signed range. Mirrors sigma-rust's checked arithmetic via `NumOps::checked_*`. Message includes the op name, the kind, and the offending bigint result.
- **`'arith-divide-by-zero'`** — `BinOp.Arith.Divide` or `Modulo` with a right operand of zero. Checked before performing the operation. Message includes the op name.
- **`'bin-op-kind-mismatch'`** — operands of a BinOp that requires both operands to share the same kind (Arith, Bit, Relation-ordering) had different kinds. `Eq` and `NEq` do NOT throw this — they return `false` on kind mismatch instead. Message includes the op name, left kind, and right kind.
- **`'bin-op-not-numeric'`** — operand kind not in `{Byte, Short, Int, Long, BigInt}` for an op requiring numeric operands (Arith, Bit, Relation-ordering). Message includes the op name and the offending kind.
- **`'bin-op-not-boolean'`** — operand kind not `Boolean` for an op requiring Boolean operands (Logical ops, `LogicalNot`, `BoolToSigmaProp`). Message includes the op name and the offending kind.

The following code was added in phase 2d-A (numeric-polymorphism unary arms — Negation, BitInversion, Upcast, Downcast):

- **`'downcast-overflow'`** — `Downcast` arm narrowed an input value outside the target kind's signed range. Mirrors sigma-rust's `ArithmeticException` from `eval/downcast.rs`; surfaced as a distinct code (separate from `'arith-overflow'`) so callers can dispatch on "downcast specifically failed" vs other arith overflows. Message includes the offending bigint value, the target kind, and the target's signed range.

Note: `Negation` reuses `'arith-overflow'` (same semantic as `BinOp.Arith` overflow — `Negate(MIN_K)` is the only case). `BitInversion` has no overflow path (`maskToKind` always lands in range). `Upcast` has no overflow path (widening preserves the value). All four phase 2d-A arms reuse `'bin-op-not-numeric'` for non-numeric input, per the `LogicalNot` / `BoolToSigmaProp` precedent.

Note: shift ops (`BinOp.Bit.BitShiftLeft / BitShiftRight / BitShiftRightZeroed`) are not implemented — they throw `'not-implemented-yet'`, matching sigma-rust's `EvalError::Misc("no interpreter eval — use SNumericTypeMethods.shiftLeft/Right")` posture. A `'bit-shift-out-of-range'` code is reserved for when shift ops land via `SNumericTypeMethods` in a later phase (not currently emitted).

The following code was added in phase 2d-B (Coll[Boolean] aggregator arms — And, Or):

- **`'coll-not-boolean'`** — `And` or `Or` arm received an input value
  that wasn't `Coll[Boolean]`. Either `input.kind !== 'Coll'` (not a
  Coll at all) OR `input.kind === 'Coll'` but `items` contained a
  non-`Boolean` kind. Mirrors sigma-rust's
  `EvalError::TryExtractFrom` from `try_extract_into::<Vec<bool>>()`.
  Wire-format invariants (`And`/`Or` MIR structs are only constructed
  from `Coll[Boolean]` inputs by sigma-rust's type-checked compilation
  path) make this throw unreachable for correctly-typed parser-produced
  trees; defensive against `ConstantPlaceholder` injection and future
  MIR shape changes.
  Message includes the input's actual kind (and for Coll inputs with
  wrong-kind items, the offending item index + its kind).

The following codes were added in phase 2e (treeVersion plumbing + lambdas + XorOf):

- **`'tree-version-too-low'`** — Upcast/Downcast arm encountered a BigInt
  branch (Upcast: BigInt → BigInt; Downcast: source=BigInt to any
  target) at `ctx.treeVersion < 3`. Mirrors sigma-rust's eval-time V3
  gating per `eval/upcast.rs:18` (BigInt → BigInt no-op only) and
  `eval/downcast.rs` (every `downcast_to_*` function gates
  `Value::BigInt` on `tree_version >= V3`). Closes out the originally-
  deferred V3 gating divergence from slice 2d-A. Message includes the
  arm name, the offending version, and the BigInt side involved.

- **`'apply-non-lambda'`** — `Apply.func` evaluated to an `SValue`
  whose `kind !== 'Lambda'`. Sigma-rust raises `EvalError::UnexpectedValue`
  at `eval/apply.rs:50`; we surface as a typed code for cleaner
  programmatic dispatch. Message includes the actual kind.

- **`'apply-arity-mismatch'`** — `Apply.args.length !==
  Apply.func.closure.argIds.length`. Sigma-rust's `apply.rs:30` zip-
  iterates and silently truncates; we add an explicit defensive check
  (Iron Law of fail-fast). Placed BEFORE arg-eval (pure structural
  check). Message includes expected vs actual arg count.

The following code was added in phase 2f Stop α (Box-extract arms — defensive kind-check shared across all 7 arms):

- **`'extract-input-not-box'`** — `ExtractAmount` / `ExtractScriptBytes`
  (and future `ExtractRegisterAs` / `ExtractCreationInfo` /
  `ExtractBytes` / `ExtractBytesWithNoRef` / `ExtractId`) received
  input whose `kind !== 'Box'`. Sigma-rust enforces
  `input.post_eval_tpe == SBox` at construction time via each arm's
  `try_build`, making this throw unreachable for parser-produced trees;
  defensive against `ConstantPlaceholder` injection and future MIR
  shape changes. Message includes the input's actual kind.

The following codes were added in phase 2f Stop β (`ExtractRegisterAs`):

- **`'register-id-out-of-range'`** — `ExtractRegisterAs.registerId`
  outside the valid 0..=9 range. Mirrors sigma-rust
  `register/id.rs:32-48` `RegisterIdOutOfBounds`. Charged 50 jit cost
  before the throw (cost happens BEFORE the range check per Pattern A
  envelope-first ordering). Message includes the offending id.

- **`'register-type-mismatch'`** — `ExtractRegisterAs` found a register
  entry whose stored `tpe` differs from `e.elemTpe`. Sigma-rust THROWS
  here (NOT returns None) — surfaced as a typed code for programmatic
  dispatch per `extract_reg_as.rs:41-44`. Message includes the register
  id, the expected SType, and the stored SType.

The following codes were added in phase 2f medium (GlobalVars / GetVar / Option family / SelectField):

- **`'context-field-missing'`** — a `GlobalVars` arm (Height, Inputs,
  Outputs, SelfBox, MinerPubKey, GroupGenerator) or the `GetVar` arm
  was reached but the required `EvalContext` field is absent (`undefined`).
  This replaces `'not-implemented-yet'` for arms that are implemented
  but require a chain-state Context that the caller did not supply.
  Corpus eval with a synthetic-empty context produces this code;
  it is counted in the `not-impl` bucket by `corpus-eval.test.ts`.
  Message includes the arm name and the missing field.

- **`'get-var-type-mismatch'`** — `GetVar` found a context-extension
  entry at the requested `varId` but its stored `tpe` (on the
  `{ tpe, value }` entry in `ctx.extension.values`) did not match the
  arm's declared `var_tpe`. Mirrors sigma-rust `get_var.rs:22-35`
  `EvalError::TryExtractFrom`. Message includes the varId, expected
  type tag, and stored type tag.

- **`'option-empty'`** — `OptionGet` was called on an `Option` value
  whose `value === null` (i.e., `None`). Mirrors sigma-rust
  `option_get.rs:21` `EvalError::NotFound`. Message: "OptionGet:
  called on None".

- **`'option-input-not-option'`** — `OptionGet`, `OptionIsDefined`, or
  `OptionGetOrElse` received an input `SValue` whose `kind !== 'Option'`.
  Wire-format invariants make this unreachable for parser-produced trees
  (sigma-rust's type checker gates it at construction); defensive
  against `ConstantPlaceholder` injection. Mirrors sigma-rust
  `EvalError::UnexpectedExpr`. Message includes the actual kind.

- **`'select-field-index-out-of-range'`** — `SelectField.fieldIndex`
  (1-based) resolved to a zero-based index outside `[0, items.length)`.
  sigma-rust's `SelectField::new` rejects OOB at construction time, so
  this code is unreachable from parser-produced trees; defensive against
  hand-built MIR. Mirrors sigma-rust `EvalError::NotFound`. Message
  includes the fieldIndex and tuple length.

- **`'select-field-input-not-tuple'`** — `SelectField` received an
  input `SValue` whose `kind !== 'Tuple'`. Defensive posture matching
  LogicalNot / BoolToSigmaProp precedent from phase 2c. Mirrors
  sigma-rust `EvalError::UnexpectedValue`. Message includes the actual
  kind.

The following codes were added in phase 2f Coll HOFs (SizeOf, Append, ByIndex, Slice, MapColl, Filter, Fold, Exists, ForAll):

- **`'coll-input-not-coll'`** — any Coll HOF arm received an input
  `SValue` whose `kind !== 'Coll'`. Mirrors sigma-rust
  `EvalError::TryExtractFrom` for the `try_extract_into::<Vec<_>>()`
  call on the collection operand. Wire-format invariants make this
  unreachable for parser-produced trees; defensive against
  `ConstantPlaceholder` injection. Message includes the arm name and
  the actual kind.

- **`'coll-elem-tpe-mismatch'`** — Filter / Exists / ForAll arm: an
  element's runtime `kind` did not match the declared element type
  derived from `condition.args[0].tpe` (the FuncValue parameter type).
  Mirrors sigma-rust's type-checked construction guarantee; defensive
  check at eval time. Message includes the offending item index, the
  declared type tag, and the actual kind.

- **`'coll-by-index-out-of-range'`** — `ByIndex` arm: the index was
  outside `[0, coll.items.length)` and no default expression was
  provided. Mirrors sigma-rust `by_index.rs` `EvalError::NotFound`.
  Message includes the index and the collection length.

- **`'coll-by-index-index-not-int'`** — `ByIndex` arm: the index
  expression evaluated to an `SValue` whose `kind !== 'Int'`. Mirrors
  sigma-rust `EvalError::TryExtractFrom` for `try_extract_into::<i32>()`.
  Message includes the actual kind.

- **`'coll-slice-bound-not-int'`** — `Slice` arm: the `from` or `until`
  expression evaluated to an `SValue` whose `kind !== 'Int'`. Mirrors
  sigma-rust `EvalError::TryExtractFrom`. Message includes which bound
  (`from` / `until`) and the actual kind.

- **`'lambda-not-callable'`** — MapColl / Filter / Fold / Exists /
  ForAll arm: the function expression evaluated to an `SValue` whose
  `kind !== 'Lambda'`, OR the resulting Lambda's `closure.argIds` is
  empty (arity-0 lambda is not callable as a HOF predicate/transform).
  Mirrors sigma-rust `EvalError::UnexpectedValue` at the function-apply
  step inside the HOF loop. Message includes the actual kind (or
  `'Lambda-arity-0'` for the zero-args case).

- **`'lambda-result-type-mismatch'`** — MapColl / Fold arm: the lambda
  body returned an `SValue` whose `kind` did not match the expected
  result type. For MapColl the expected result type is inferred from the
  MIR node's `tpe.elem`; for Fold it is the accumulator's `kind`.
  Mirrors sigma-rust `EvalError::TryExtractFrom` on the per-iteration
  result. Message includes the expected kind and the actual kind.

The following code was added in phase 2g-medium (CreateProveDlog, CreateProveDhTuple eval arms):

- **`'sigma-prop-input-not-group-element'`** — `CreateProveDlog` or `CreateProveDhTuple` arm
  received an input `SValue` whose `kind !== 'GroupElement'`. Wire-format invariants make this
  unreachable for parser-produced trees (sigma-rust's `OneArgOpTryBuild` / `new` reject
  non-GroupElement inputs at construction time); defensive against `ConstantPlaceholder`
  injection and future MIR shape changes. Message includes the arm name and the actual kind.

The following codes were added in phase 2g-combinators (Atleast, SigmaAnd, SigmaOr eval arms):

- **`'atleast-bound-not-int'`** — `Atleast` arm: the `bound` expression evaluated to an `SValue`
  whose `kind !== 'Int'`. Wire-format invariants (sigma-rust's `Atleast::new` requires
  `bound.post_eval_tpe == SInt`) make this unreachable for parser-produced trees; defensive
  against `ConstantPlaceholder` injection. Message includes the actual kind.

- **`'atleast-bound-out-of-range'`** — `Atleast` arm: after extracting an `Int` bound, the value
  is `< 0`, `> 255`, or `> items.length`. Checked explicitly before delegating to
  `cthresholdReduce`, mirroring sigma-rust `atleast.rs:48-53` which rejects `bound > input.len()`
  as a runtime error. Message includes the bound value and (for `> items.length`) the collection
  length.

- **`'sigma-prop-coll-elem-not-sigma-prop'`** — `Atleast` / `SigmaAnd` / `SigmaOr` arm (via
  `eval/_sigma-helpers.ts::expectSigmaProp`): an item from a `Coll[SigmaProp]` or from the
  `items: Expr[]` array evaluated to an `SValue` whose `kind !== 'SigmaProp'`. Wire-format
  invariants enforce SSigmaProp for each item; defensive against `ConstantPlaceholder` injection.
  Message includes the arm name, the offending index, and the actual kind.

- **`'sigma-prop-input-not-coll'`** — `Atleast` arm (via `extractSigmaPropColl`): the `input`
  expression evaluated to an `SValue` whose `kind !== 'Coll'`. Applies only to `Atleast` (whose
  `input` is a single `Coll[SigmaProp]` expression); `SigmaAnd` / `SigmaOr` take `items: Expr[]`
  individually, so this code does not apply to them. Message includes the actual kind.

The following codes were added in phase 2g.5 (Context, SigmaPropBytes, MethodCall, PropertyCall arms):

- **`'sigma-prop-bytes-input-not-sigma-prop'`** — `SigmaPropBytes` arm received an input
  `SValue` whose `kind !== 'SigmaProp'`. Wire-format invariants (`OneArgOpTryBuild::try_build`
  checks `post_eval_tpe` at construction time) make this unreachable for parser-produced trees;
  defensive against `ConstantPlaceholder` injection. Source:
  `ergotree-interpreter/src/eval/sigma_prop_bytes.rs:18-23`. Message includes the actual kind.

- **`'method-not-implemented'`** — `MethodCall` / `PropertyCall` dispatcher: the
  `(typeId, methodId)` pair has no registered handler in the `HANDLERS` registry. Also reused
  for defensive shape mismatches inside registered handlers (e.g., `SBox.tokens` got a non-Box
  `obj`, `SColl.indexOf` got a non-Coll `obj`, or `SColl.indexOf` received the wrong number of
  args or wrong arg type). Error-taxonomy Decision #1 in the design spec: compact taxonomy;
  `'method-not-implemented'` covers both "dispatch miss" and "handler shape mismatch" to keep
  the code count low. Message includes the offending typeId/methodId or the shape mismatch
  detail.

- **`'context-obj-not-context'`** — `SContext.dataInputs` handler: the `obj` argument evaluated
  to an `SValue` whose `kind !== 'Context'`. Wire-format invariants (sigma-rust's
  `PropertyCall` construction via ergotree-ir type-checker) make this unreachable for
  parser-produced trees; defensive against `ConstantPlaceholder` injection or hand-crafted MIR
  trees. Source: `ergotree-interpreter/src/eval/scontext.rs:17-31`. Message includes the
  actual kind.

No other error codes are emitted by the v0.2.0 evaluator. Internal panics (e.g. a bug in a wire-layer helper called from an arm) bubble up as their typed error class (`ExprParseError`, `SValueParseError`, etc.) — those represent contract violations and are bugs, not eval-input issues.

### `VerifyError` taxonomy (phase 2g-medium + 2g-combinators; 8 codes total)

`VerifyError` is distinct from `EvalError`: it is thrown by `verifySignature` only, not by the
recursive evaluator. The two surfaces don't interact — a caller composing `evaluateWith` + `verifySignature` may encounter both, but they carry separate `code` namespaces.

- **`'conjecture-not-implemented'`** — **RESERVED; no longer thrown as of 2g-combinators.** Was
  thrown in 2g-medium when `verifySignature` encountered a `Cand`, `Cor`, or `Cthreshold` node.
  The full conjecture walk ships in 2g-combinators; this code stays declared in `VerifyErrorCode`
  for ABI stability. Callers that catch this code keep compiling and running — they will simply
  never see it thrown.

- **`'empty-signature'`** — `signature.length === 0`. Sigma-rust returns `Ok(false)` for an
  empty proof via the `[] => false` match arm in `verify_signature` (`verifier.rs:99-100`);
  the TS port surfaces this as a typed throw so callers can distinguish "no proof provided"
  from "cryptographically incorrect proof".
  (Acknowledged divergence from sigma-rust; Decision #5 in the design spec.)

- **`'truncated-signature'`** — the signature ran out of bytes before the tree-walk parsing
  completed. Cases: a 24-byte challenge was present but 32-byte scalar bytes were absent; OR
  Cthreshold polynomial bytes were shorter than `(n-k)*24` (no length prefix — the count is
  derived from the SigmaBoolean tree structure). Mirrors sigma-rust's `SigParsingError::ScalarRead*`
  family and `'truncated-signature'` throw in `readBytes(n)` for the polynomial-bytes path.

- **`'point-not-on-curve'`** — a pubkey or point-component byte-array on a `ProveDlog` or
  `ProveDhTuple` leaf failed secp256k1 decompression. Causes: off-curve coordinates,
  malformed encoding tag, or identity point where prohibited. `@noble/curves`'s
  `Point.fromBytes` rejects off-curve inputs by default.

- **`'scalar-out-of-range'`** — **reserved; currently not thrown.** `scalarFromBytes` reduces
  mod n silently, mirroring sigma-rust's `Scalar::reduce_bytes` at `wscalar.rs:60-67`. The
  code is declared in `VerifyErrorCode` for a future slice that chooses to surface
  raw-bytes-≥-group-order-n as a typed throw per Decision #6 in the design spec.

The following codes were added in phase 2g-combinators (conjecture verifier walk):

- **`'cthreshold-polynomial-bytes-mismatch'`** — thrown on the defensive `k > n` check inside
  the Cthreshold verifier walk (internal guard); reserved for future strict structural-validation
  passes. Rarely reached in practice (`parseSigmaBoolean` already rejects `k > items.length`
  at parse time per `'cthreshold-k-out-of-range'`).

- **`'cor-derived-challenge-mismatch'`** — **reserved; not thrown in this slice.** Declared for
  a future pass that explicitly validates the XOR-derived last child's challenge recomputes
  against the Fiat-Shamir hash.

- **`'cthreshold-derived-challenge-mismatch'`** — **reserved; not thrown in this slice.** Declared
  for a future pass that explicitly validates polynomial-derived child challenges against the
  Fiat-Shamir hash at each leaf.

### Coverage and stability

- **52 / ~70 `Expr` variants** have arms in v0.2.0 (8 from phase 2b + 3 from phase 2c: `BinOp`, `LogicalNot`, `BoolToSigmaProp` + 4 from phase 2d-A: `Negation`, `BitInversion`, `Upcast`, `Downcast` + 2 from phase 2d-B: `And`, `Or` + 3 from phase 2e: `FuncValue`, `Apply`, `XorOf` + 2 from phase 2f Stop α: `ExtractAmount`, `ExtractScriptBytes` + 2 from phase 2f Stop β: `ExtractRegisterAs`, `ExtractCreationInfo` + 3 from phase 2f Stop γ: `ExtractBytes`, `ExtractBytesWithNoRef`, `ExtractId` + 6 from phase 2f medium: `GlobalVars`, `GetVar`, `OptionGet`, `OptionIsDefined`, `OptionGetOrElse`, `SelectField` + 9 from phase 2f Coll HOFs: `SizeOf`, `Append`, `ByIndex`, `Slice`, `MapColl`, `Filter`, `Fold`, `Exists`, `ForAll` + 2 from phase 2g-medium: `CreateProveDlog`, `CreateProveDhTuple` + 3 from phase 2g-combinators: `Atleast`, `SigmaAnd`, `SigmaOr` + 4 from phase 2g.5: `Context`, `SigmaPropBytes`, `MethodCall`, `PropertyCall` + 1 from phase 2g.6: `Global`). Everything else throws `'not-implemented-yet'`. Real-world ErgoTree trees from the `mainnet_boxes` corpus are filtered against this coverage by `test/corpus-eval.test.ts` — only fixtures whose body uses exclusively the supported variants are exercised against the sigma-rust eval oracle for byte-equality. As of phase 2g.6 complete, the mainnet corpus aggregate is `success=18 not-impl=0 other=0` (corpus runs with synthetic-context stubs providing `outputs: []`, `inputs: []`, `selfBox: synthetic`, `dataInputs: []`).
- **Public function signatures are stable** from v0.2.0 onward. Future arms slot into the central dispatch (`eval/eval.ts`) without changing `evaluate`, `evaluateWith`, `makeContext`, or `EvalError`.
- **`EvalOpts` is open for additive growth.** Phase 2e added `treeVersion?: number`. Phase 2f medium added `height?: number`, `selfBox?: ErgoBox`, `inputs?: ErgoBox[]`, `outputs?: ErgoBox[]`, `preHeader?: PreHeader`, `extension?: ContextExtension` — all optional, all live. Phase 2g-medium adds no new `EvalOpts` fields (`verifySignature` is a separate public function, not part of eval cost accounting). Phase 2g-combinators adds no new `EvalOpts` fields. Phase 2g.5 adds `dataInputs?: ErgoBox[]` (read by the `SContext.dataInputs` PropertyCall handler). Phase 2g.6 adds no new `EvalOpts` fields — the existing `preHeader?: PreHeader` field from 2f medium is consumed by the new `SContext.preHeader` handler. Phase 2h may add `headers` when Header arms land.
- **`@noble/curves@2.2.0` added in phase 2g-medium.** Version-locked pair with `@noble/hashes@2.2.0`. Used by the secp256k1 adapter (`crypto/secp256k1.ts`) and the sigma verifier. Phase 2g-combinators adds no new runtime dependencies — `GF(2^192)` is pure TS via `bigint`; the existing `@noble/curves@2.2.0` + `@noble/hashes@2.2.0` pair is sufficient. Phase 2g.5 adds no new runtime dependencies.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — design rationale, phase plan, validation strategy, risks
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — phase 2g.6 design spec (5 method handlers + Global arm + 2 SValue variants)
- `facts/proof.md` — companion interface contract (and structural template for this file)
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — byte-format and implementation oracle
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical language specification for opcode semantics
- `~/projects/ergo_avltree_rust/` (branch `main`, HEAD `879545c`) — phase 2h pre-warning; reference AVL+ implementation with three upstream PRs applied (#10, #11, #13)
