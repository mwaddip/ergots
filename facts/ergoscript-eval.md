# `@ergots/ergoscript` — Evaluator Surface Contract

This file documents the **evaluator slice** of the `@ergots/ergoscript` boundary contract. It is also the canonical home for the `SValue` / `SType` / `Expr` discriminated unions, which are produced by the wire layer (see [`facts/ergoscript-wire.md`](./ergoscript-wire.md)) and consumed across the package.

For cross-cutting guarantees (browser-compat, determinism, etc.) see [`facts/ergoscript.md`](./ergoscript.md). For the sigma-protocol verifier (which consumes `SValue.SigmaProp` produced by this layer) see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md).

## Scope

The evaluator is a partial interpreter over `ErgoTree`. Its public surface is `evaluate(tree, opts?)`, `evaluateWith(tree, ctx)`, and `makeContext(opts?)`; it returns the `SValue` produced by evaluating `tree.body` and accumulates a saturating `jitCost` whose per-operation charges are `sigma-rust`-accurate (not no-op placeholders). It covers every implementable `Expr` variant (68 of 68 — see Coverage) plus an extensive method-call surface routed through a `(typeId, methodId)` handler registry. Both the v5 language and the v6 (ErgoTree V3) additions are supported: the v6 numeric/`UnsignedBigInt`/`SGlobal`/`SColl`/`SBox`/`SContext`/`SGroupElement` methods are gated at the dispatcher on `treeVersion >= 3`, and three zero-cost pre-eval passes reject adversarially-constructed trees (mismatched-type comparisons, v6 type constructs in pre-V3 trees, and V3+ empty-args method calls) before any cost is charged. Costs and values are validated against the full mainnet chain (genesis→tip vs the `sigma-rust` reference) and a JVM `sigma-state`-blessed conformance suite, both with zero unresolved divergences.

## Public surface

```ts
evaluate(tree: ErgoTree, opts?: EvalOpts): SValue
evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue
makeContext(opts?: EvalOpts): EvalContext

class EvalError extends Error { code: string }
```

Public function signatures are stable from v0.2.0 onward; new arms slot into central dispatch (`eval/eval.ts`) without changing `evaluate`, `evaluateWith`, `makeContext`, or `EvalError`. `Env`, `evalExpr`, and the per-arm functions (`evalConst`, `evalIf`, `evalBlockValue`, …) are intentionally NOT exported — they are internal to the evaluator and may change without notice.

### `evaluate(tree, opts?)`

- **Precondition:** `tree` is a valid `ErgoTree` (typically returned by `parseTree`). `opts.constants`, when provided, must be parallel to whatever set of `ConstantPlaceholder` ids the tree's body references.
- **Postcondition (success):** Returns the `SValue` produced by evaluating `tree.body` under a freshly constructed `EvalContext`. The context is initialised with `constants: opts.constants ?? tree.constants` and `jitCostLimit: opts.jitCostLimit` (defaulting to `undefined` = unlimited).
- **Postcondition (failure):** Throws `EvalError` with one of the codes enumerated below. Errors raised inside the recursive evaluator bubble up unwrapped — `evaluate` does not catch and rewrap.
- **Coverage caveat:** 68 of 68 implementable `Expr` variants have implemented arms (see Coverage). 21 wire opcodes are reserved in sigma-rust's `OpCode` enum but unconditionally parse-rejected (`ExprParseError 'opcode-reserved'`); the JVM rejects each identically via `CheckValidOpCode`. Trees whose body reaches a not-yet-implemented method-call handler or an eval path with a defensive `EvalError 'not-implemented-yet'` (3 sites: `eval.ts:232`, `global-vars.ts:136`, `bin-op/bit.ts:58` — the BinOp shift ops, which sigma-rust delegates to `SNumericTypeMethods` rather than the BinOp arm) still throw at runtime.

### `evaluateWith(tree, ctx)`

- **Precondition:** `tree` is a valid `ErgoTree`. `ctx` is a caller-constructed `EvalContext` (typically from `makeContext(opts)`); the caller is responsible for setting `ctx.constants` if `ConstantPlaceholder` resolution is desired (`evaluateWith` does NOT default it from `tree.constants`).
- **Postcondition (success):** Returns the `SValue` produced by evaluating `tree.body` under the supplied `ctx`. The context is mutated in place — after the call returns, callers may inspect `ctx.jitCost` to read the total cost charged.
- **Postcondition (failure):** Same `EvalError` taxonomy as `evaluate`. The context's `jitCost` reflects all cost charged up to (and including) the point of the throw — partial costs are NOT rolled back.

### `makeContext(opts?)`

- **Precondition:** `opts` is a (possibly empty) `EvalOpts`.
- **Postcondition:** Returns a fresh `EvalContext` with `jitCost: 0`, `jitCostLimit: opts.jitCostLimit`, `constants: opts.constants`, and the `addCost` / `addPerItemCost` methods bound to the returned object.
- **Determinism:** Pure constructor; no I/O, no clock, no PRNG. Same opts in, structurally equivalent context out.

## Interfaces

```ts
interface EvalOpts {
  jitCostLimit?: number          // undefined = unlimited (signing-style)
  constants?: SValue[]           // overrides tree.constants for ConstPlaceholder
  treeVersion?: number           // 0..7; auto-derived from tree.header.version in evaluate(); arms default to 0 on undefined
  // Chain-state fields:
  height?: number                // current block height
  selfBox?: ErgoBox              // spending box
  inputs?: ErgoBox[]             // transaction inputs
  outputs?: ErgoBox[]            // transaction outputs
  preHeader?: PreHeader          // pre-header of current block (also consumed by the SContext.preHeader handler)
  extension?: ContextExtension   // context-extension key-value map
  dataInputs?: ErgoBox[]         // transaction data-inputs
  headers?: Header[]             // block headers (sigma-rust [Header; 10] simulated as Header[])
  /** Per-input context extensions, indexed by SPENDING-TRANSACTION input position — mirrors JVM
   *  spendingTransaction.inputs(i).extension (CContext.scala:76-83). SContext.getVarFromInput (101:12)
   *  reads this. May legitimately differ in length from `inputs` (the JVM's own blessed
   *  getVarFromInput vector has tx.inputs = 0 while ctx.inputs = 1) — never validate length equality.
   *  Invariant (documented, not enforced): when both are supplied, inputExtensions[selfIndex] ≡ extension.
   *  Absent ⇒ every getVarFromInput lookup → None. */
  inputExtensions?: ContextExtension[]    // getVarFromInput context model
  lastBlockUtxoRootHash?: AvlTreeData      // independent SContext.lastBlockUtxoRootHash (101:9) source; JVM ErgoLikeContext.lastBlockUtxoRoot. TWO readers: the 101:9 PropertyCall handler AND the bare 0xa6 op-form arm (eval/last-block-utxo-root-hash.ts, FixedCost(15), values.scala:1490-1501). Absent ⇒ either reader throws 'context-field-missing'. Cost differs by wire form: 15 op-form vs 20 PropertyCall (4 dispatcher + 1 Context obj + 15 handler). Walker supplies avlTreeFromDigest(headers[0].stateRoot); conformance dummy ctx supplies AvlTreeData.dummy.
}

interface EvalContext extends EvalOpts {
  jitCost: number                                                  // mutable accumulator
  addCost(amount: number): void
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void
}
```

`EvalOpts` is open for additive growth — new chain-state fields slot in without breaking the public functions.

### `EvalContext.addCost(amount)`

- **Semantics:** Saturating add — `ctx.jitCost = Math.min(ctx.jitCost + amount, Number.MAX_SAFE_INTEGER)`. The clamp is a defensive guard; in practice the cost limit (if set) trips long before saturation matters.
- **Limit enforcement:** If `ctx.jitCostLimit !== undefined` and the new total exceeds it, throws `EvalError 'cost-limit-exceeded'`. The throw happens *after* the cost is added to `jitCost` — callers inspecting `jitCost` after a cost-limit failure see the over-limit total, not the pre-add value.
- **Mirror of:** sigma-rust `Context::add_jit_cost` (`ergotree-ir/src/chain/context.rs:77-86`).

### `EvalContext.addPerItemCost(base, perChunk, chunkSize, nItems)`

- **Semantics:** Composite charge — `addCost(base + chunks(nItems) * perChunk)` where `chunks(n) = max(0, trunc((n - 1) / chunkSize) + 1)` (the Scala consensus `PerItemCost.chunks`, toward-zero division). Used by the `BlockValue` envelope (`addPerItemCost(1, 1, 10, items.length)`) and by all 9 Coll HOF arms as their outer Pattern A charge.
- **Formula:** `totalCharge = base + (Math.trunc((nItems - 1) / chunkSize) + 1) * perChunk` (clamped to ≥ 0 chunks). Equals `ceil(nItems / chunkSize)` for `nItems ≥ 1`; differs only at `nItems === 0`, where a `chunkSize ≥ 2` element still costs one chunk (`base + perChunk`) while `chunkSize === 1` costs `base` only — see `eval-context.ts:155-163` and memory `reference_per_item_cost_n0_jvm_divergence`. NOTE the `n` fed in is the count of items *actually processed*, not always the full length: Coll-equality charges it on the count compared before the first inequality (JVM charge-after-loop, `relation.ts` Coll arm).
- **Limit enforcement:** Inherits from `addCost`; the *total* composite charge is checked against `jitCostLimit` after addition (not split into base + per-chunk sub-checks).
- **Mirror of:** sigma-rust `Context::add_per_item_jit_cost` (`ergotree-ir/src/chain/context.rs:88-99`).

## Type invariants (canonical home for SValue / SType / Expr)

These hold on every `SValue` returned by the evaluator. Callers may rely on them without re-checking. The wire layer ([`facts/ergoscript-wire.md`](./ergoscript-wire.md)) produces these types from on-wire bytes.

```ts
type SType =
  | { tag: 'SBoolean' } | { tag: 'SByte' } | { tag: 'SShort' }
  | { tag: 'SInt' } | { tag: 'SLong' } | { tag: 'SBigInt' }
  | { tag: 'SUnsignedBigInt' }                        // type code 9; permissive parse, pre-eval gate
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
  | { kind: 'UnsignedBigInt'; value: bigint }         // distinct from BigInt; unsigned magnitude
  | { kind: 'GroupElement'; value: Uint8Array }   // 33 bytes, CANONICAL SEC1: 33×00 identity | curve-validated 02/03-lead — see invariant bullet below
  | { kind: 'SigmaProp'; value: SigmaBoolean }    // see facts/ergoscript-sigma.md for SigmaBoolean
  | { kind: 'Box'; value: ErgoBox }
  | { kind: 'AvlTree'; value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Coll'; elem: SType; items: SValue[] }
  | { kind: 'Tuple'; items: SValue[] }
  | { kind: 'Option'; elem: SType; value: SValue | null }
  | { kind: 'Lambda'; closure: Closure }
  | { kind: 'Context' }                              // Context Expr arm sentinel
  | { kind: 'Global' }                               // Global Expr arm sentinel
  | { kind: 'PreHeader'; value: PreHeader }          // PreHeader value carrier
  | { kind: 'Header'; value: Header }               // Header value carrier
```

`Expr` is the 69-variant discriminated union over MIR nodes, keyed on `tag`. Each variant's payload mirrors sigma-rust's `mir/<variant>.rs` struct fields (except `LastBlockUtxoRootHash` — a JVM-only case object with no sigma-rust MIR counterpart, serialized as a bare `0xa6` opcode per JVM `CaseObjectSerialization`, `ValueSerializer.scala:87`; sigma-rust errors on these bytes). Full list and per-variant shapes live in `packages/ergoscript/src/mir/types.ts`; adding a variant requires corresponding arms in `wire/parse.ts` and `wire/serialize.ts` (both files use exhaustive switches to make additions compile-time-visible).

- `constantTypes` (on `ErgoTree`) is parallel to `constants[]` and carries the per-constant `SType` recovered from the wire. It's necessary because a parsed `SValue` does not unambiguously encode its `SType` for some edge cases (empty `Coll`, `None` for `SOption`).
- `ErgoBox`, `AvlTreeData`, and `Closure` are stable shapes; evaluator-only fields may be added in later work.
- `PreHeader`: `{ version, parentId: Uint8Array(32), timestamp: bigint, nBits, height, minerPk: Uint8Array(33), votes: Uint8Array(3) }`.
- `ContextExtension`: `{ values: Record<number, { tpe: SType; value: SValue }> }` — keyed by varId, same `{ tpe, value }` shape as `ErgoBox.registers`.
- **`Closure`** carries `{ argIds, argTpes: SType[], body, capturedEnv: Env }` — closures capture their definition-site environment (lexical scoping), and `argTpes` runs parallel to `argIds` so apply-time can reject an unresolved-`STypeVar` argument. See "Higher-order functions" below.
- **GE canonical-bytes invariant:** every `SValue.GroupElement.value` is canonical SEC1 — exactly 33 zero bytes (the identity) or a curve-validated `0x02`/`0x03`-lead compressed point. Enforced at every value ingress: the SValue GE data-parse arm (constants, box registers, `deserializeTo[GroupElement]`) — 0x00-lead inputs NORMALIZE to the canonical identity, non-0x00-lead inputs must curve-decode or the wire layer throws `'group-element-invalid-point'` (see `facts/ergoscript-wire.md`); the `deserializeTo[Header]` hydration leg (minerPk + v1 powOnetimePk — the JVM routes both through `GroupElementSerializer.parse`); SigmaBoolean leaf points (ProveDlog.h, ProveDHTuple g/h/u/v — same validate+normalize under `SigmaBooleanParseError('ec-point-invalid')`; the carrier is `SigmaBoolean`, see `facts/ergoscript-sigma.md`); and the `DecodePoint` eval arm (already conformant — decodes then re-encodes canonically). Mirrors the JVM, whose in-memory value is the decoded point object (`GroupElementSerializer.parse` :35-42 — identity for ANY 0x00-lead, bytes 1..32 discarded) and whose serialization emits canonical bytes (`GroupElementSerializer.scala:20-33`). Egress (`getEncoded`, `Global.serialize`, equality) relies on the invariant with no per-site normalization. NOTE the box-EQ interplay: normalization erases the garbage-vs-canonical distinction at the SValue layer, so byte-basis box equality compares byte-derived identity (box ids / retained bytes), never normalized values or their re-serialization (see Equality semantics below).

## Method return-type resolution

`exprTpe` (`mir/expr-tpe.ts`) computes a node's static `SType`. For `MethodCall` / `PropertyCall` nodes it consults a declarative signature catalog (`mir/method-signatures.ts`): a `MethodSignature { tDom, tRange, tpeParams? }` keyed by `(typeId, methodId)`, transcribing each method's `SFunc` signature. `resolveReturnTpe` returns a CLOSED `tRange` verbatim; a type-var `tRange` is resolved by the substitution engine (`mir/type-unify.ts`, a port of JVM `unifyTypes`/`unifyTypeLists`/`applySubst`) — binding vars from `receiver`/`argTpes`/`explicitTypeArgs` and substituting into `tRange`. An unregistered method, or an unbindable type-var residual, falls back to `SAny`.

- **The `SAny` cascade is load-bearing.** An operand whose static type resolves to `SAny` is SKIPPED by static checks (the pre-eval gates and HOF element-type checks), never rejected — sigma-rust tracks the concrete runtime type and accepts, so rejecting on `SAny` would be a false positive (memory `reference_sany_type_checks_skip_not_fail`). Runtime values stay concrete; only the *static* view is `SAny`.
- **Dual-table sync invariant.** The signature catalog (`mir/method-signatures.ts`) and the method-handler registry (`eval/method-call.ts`) share the `(typeId, methodId)` namespace. A handler MAY exist without a signature (eval-only; the call's static type stays `SAny`), but every signature MUST agree with its handler's runtime element type (the static `tRange` equals the `elem`/shape the handler constructs). The first generic-output method satisfying it is `SColl.patch` (12:19) — static `Coll[IV]` resolves to `Coll[receiver-elem]`, matching the handler's `{ elem: obj.elem }`. Mechanical enforcement is future work. Replacing a handler's `SAny` static type with a concrete signature is **not consensus-neutral**: it lets static passes engage where they previously skipped an `SAny` operand. `SAvlTree.insertOrUpdate` (100:16 → `Option[AvlTree]`) and `SHeader.checkPow` (104:16 → `SBoolean`) carry closed-`tRange` signatures so that e.g. `Eq(checkPow(…), Int)` at V3 now rejects (`'bin-op-kind-mismatch'` via `validateBinOpTypes`) where it formerly over-accepted — matching JVM `check2(SameType)`. This is a faithfulness GAIN (closes an adversarial over-acceptance), not a fork: no honest tree is affected.

## Pre-eval validation gates

Three whole-tree passes run in `dispatchTreeBody` (`eval/evaluate.ts`) on the **post-substitution** body (and, where noted, on `tree.constantTypes[]` and the raw `tree.body`), BEFORE `tryTrivialReduce` / `evalExpr` and before any cost — so a rejected tree yields no value and **zero JIT cost**, with no cost-fixture impact. They walk the tree via the exported `childrenOf` (`_substitute-deserialize.ts`). None of them live in `parseTree`: the wire parser stays permissive (byte-roundtrip is load-bearing), so a parse-without-eval consumer accepts these adversarial shapes — consensus-irrelevant, since consensus always evaluates and the pass fires pre-eval.

- **`validateBinOpTypes(body, treeVersion)`** — mirrors the JVM deserializer's `check2` constraints (`equalityOp → check2(SameType)`; `comparisonOp → check2(OnlyNumeric) + check2(SameType)`; `SigmaBuilder.scala:679/689`). Rejects a `Relation` node (only `Relation`; Arith/Bit/Logical have no JVM `check2`) whose concretely-typed operands violate the rule: `Eq`/`NEq` → `'bin-op-kind-mismatch'` when operand types differ (unless both numeric AND `treeVersion < 3`, which are coerced at eval — see the BinOp section); `Lt`/`Le`/`Gt`/`Ge` → `'bin-op-not-numeric'` on a concretely-non-numeric operand and `'bin-op-kind-mismatch'` on a numeric-mismatch at `treeVersion >= 3`. An `SAny`-typed operand is SKIPPED (the cascade), so the eval-arm coerce/`false` behavior remains the runtime fallback for those.
- **`validateV6Types(tree, body, treeVersion)`** — rejects (under `treeVersion < 3`) any `SType` that **is or contains** `SUnsignedBigInt` (type code 9) **or** `SFunc` (type code 112), deep-walking `SColl.elem`/`SOption.elem`/`STuple.items`/`SFunc.args`/`SFunc.result` → `'v6-type-in-pre-v3-tree'`. Two surfaces are walked: `tree.constantTypes[]` (segregated-constant declared types — mandatory: a dead or empty-typed-coll segregated constant carries no body expression yet the JVM deserializes it eagerly and rejects code 9/112 there) and the body. **Critical faithfulness rule — inspect serialized type annotations, NOT computed `exprTpe`.** A first-order v5 lambda's computed type is `SFunc`, but no `SFunc` code is serialized for it; checking computed types would false-reject every valid v5 `map`/`fold`. The pass reads only the wire-deserialized annotation fields (`Const.tpe`, `ConstPlaceholder.tpe`, `Collection.elemTpe`, `Upcast.tpe`, `Downcast.tpe`, `GetVar.tpe`, `ExtractRegisterAs.tpe`, `DeserializeContext.tpe`, `DeserializeRegister.tpe`, `FuncValue.args[].tpe`, `MethodCall.explicitTypeArgs`, `PropertyCall.explicitTypeArgs`). `ValUse.tpe` is **deliberately excluded** — it is computed from the enclosing `ValDef`'s RHS type at parse time, not deserialized from a type-code byte, so a higher-order `val f = <lambda>; … f …` would give `ValUse.tpe = SFunc` on a valid v5 tree. The `SFunc`-112 leg closes a parser over-accept (`parseSType` accepted code 112 unconditionally, but the JVM gates it on `isV3OrLaterErgoTreeVersion`, `TypeSerializer.scala:111`/`TypeSerializer.scala:211`). **Residual** (adversarial-only): the broader v6-**method**-version gate is eval-time (the dispatcher `minVersion` → `'tree-version-too-low'`) and is bypassed in a dead branch, so a pre-V3 dead-branch `none[SInt]` still over-accepts where the JVM rejects via the method-version gate; closing it needs a whole-tree `validateMethodVersions` pre-pass.
- **`validateMethodCallArity(body, treeVersion)`** — rejects any `MethodCall`-opcode node (`tag: 'MethodCall'`, NOT `PropertyCall`) with `args.length === 0` when `treeVersion >= 3` → `'method-call-empty-args'`. Mirrors the JVM `MethodCallSerializer.parse` assert `if (isV3OrLaterErgoTreeVersion) assert(args.nonEmpty)` (`MethodCallSerializer.scala:53-55`). Method-agnostic; pre-V3 grandfathered. Closes the adversarial `none`-via-MethodCall-opcode and `groupGenerator` (106:1) zero-arg over-accepts.

Separately, when `tree.header.constantSegregation` is true, `dispatchTreeBody` runs `substituteConstants(tree.body, tree.constants, tree.constantTypes)` BEFORE `substituteDeserialize`, mirroring sigma-rust `eval.rs:206` (`tree.proposition()` → `substitute_constants` → `substitute_deserialize`, `eval.rs:203`). This matters for cost faithfulness: a segregated deserialize tree's `ConstantPlaceholder`s reach `evalExpr` as inlined `Const` nodes charging `Fixed(5)` (the eager-substitute basis), not the lazy `ConstantPlaceholder = Fixed(1)` of the `ctx.constants`-lookup path. The non-deserialize path stays on lazy resolution (sigma-rust's `with_constants` branch, `eval.rs:259`), which intentionally charges 1 per CP.

## `EvalError` taxonomy (84 codes)

`EvalError` carries a `code: string` distinct from the wire-layer error classes (`ExprParseError`, `SerializeError`), the sigma-verifier classes (`facts/ergoscript-sigma.md`), and the scorex `ReaderError` (`'truncated'`, `'max-tree-depth-exceeded'`) — all of which can surface unwrapped when their layers are called from an eval arm. The 84 live codes follow, grouped by area. Internal panics (e.g. a bug in a wire-layer helper called from an arm) bubble up as their typed error class — those are contract violations and bugs, not eval-input issues.

### Infrastructure / cross-cutting

- **`'not-implemented-yet'`** — central dispatch (`eval/eval.ts`) hit an `Expr` variant or eval path with no arm yet. Message includes the offending `tag`. (Replaced the older wire placeholder `'not-implemented-phase-2a'` on the SHeader parse path.)
- **`'cost-limit-exceeded'`** — `EvalContext.addCost` (and therefore `addPerItemCost`) detected `ctx.jitCost > ctx.jitCostLimit` after a charge. Only raised when the caller set `jitCostLimit`.

### Const / Block / Val

- **`'const-placeholder-id-out-of-range'`** — `ConstPlaceholder(id)` referenced an `id >= ctx.constants.length`.
- **`'const-placeholder-no-constants'`** — `ConstPlaceholder` was reached but `ctx.constants` is `undefined`.
- **`'val-def-outside-block'`** — the `ValDef` arm was reached at the top level (or as an arbitrary sub-expression). `ValDef` is only structurally valid as an item inside `BlockValue.items`.
- **`'val-use-unbound'`** — `ValUse(id)` referenced a `valId` with no binding in the current `Env`. Cost 5 is charged BEFORE the env lookup (mirrors sigma-rust).
- **`'block-item-not-val-def'`** — inside the `BlockValue` arm, `items[i].tag !== 'ValDef'`.

### If / Collection / Tuple

- **`'if-condition-not-boolean'`** — the `If` arm's `condition` evaluated to an `SValue` whose `kind !== 'Boolean'`.
- **`'collection-elem-kind-mismatch'`** — inside the `Collection` arm with `kind: 'Exprs'`, an evaluated item's `kind` did not match the declared `elemTpe` (defensive guard).
- **`'tuple-invalid-arity'`** — Tuple EXPR node evaluated with arity ≠ 2. JVM `values.scala:797-798`: v5.0+ evaluates only pairs; thrown BEFORE any item eval and BEFORE the Fixed(15) envelope (zero cost contribution). Distinct from `'unsupported-eval-node'` — the node IS supported at arity 2. Inline tuple-N CONSTANTS at non-checkType'd positions evaluate on both sides (`Constant.eval` bypasses `Tuple.eval`); at checkType'd positions the JVM rejects (`values.scala:801`; the `'unsupported-value-type'` checkType class). Adversarial-only.

### BinOp / arithmetic / logical

- **`'arith-overflow'`** — `BinOp.Arith` computed a result outside the operand kind's signed range. Mirrors sigma-rust's checked arithmetic. Also reused by `Negation` (`Negate(MIN_K)`).
- **`'arith-divide-by-zero'`** — `BinOp.Arith.Divide` or `Modulo` with a right operand of zero. Checked before performing the operation. Reused by UBI `Divide`/`Modulo` and the UBI modular methods' `m == 0` path.
- **`'bin-op-kind-mismatch'`** — a BinOp requiring same-kind operands (Arith, Bit, Relation-ordering) got different kinds. **Mismatched-NUMERIC operands are version-gated** (mirrors the JVM deserializer's auto-upcast, `DeserializationSigmaBuilder.applyUpcast`, `SigmaBuilder.scala:750-756`, gated `ergoTreeVersion < 3`): at `ctx.treeVersion < 3`, Arith / Relation-ordering / `Eq` / `NEq` **coerce** the narrower operand to the wider — charging one `Upcast` (10/30 by target) and evaluating at the wider kind (arith result widens; `Eq`/`NEq` value can flip `false`→`true`) — instead of throwing / returning false. At `treeVersion >= 3` the mismatch is rejected: Arith / ordering throw this code at eval, and `validateBinOpTypes` rejects concretely-typed mismatched comparison/equality whole-tree (incl. dead branches) before eval. The eval-arm `Eq`/`NEq`→`false` / coerce behavior now applies only to operands the pass SKIPS (static type `SAny`). **Bit** ops are NOT in the upcast class (`BitOp` bypasses `applyUpcast`) → always this code on mismatch. A UBI arith BinOp with a non-UBI other operand (e.g. `Plus(ubi, Int)` in a hand-crafted V3 tree) also throws this code (the `arith.ts` UBI branch guards `rv.kind !== 'UnsignedBigInt'`); UBI ordering/equality mismatches are caught pre-eval by `validateBinOpTypes`.
- **`'bin-op-not-numeric'`** — at EVAL time, operand kind not in `{Byte, Short, Int, Long, BigInt}` for an op requiring numeric operands (the eval-time `isNumeric` in `eval/bin-op/_numeric.ts` is **NOT** widened for UBI — a UBI operand is handled by a local branch BEFORE this guard, so it never throws this code at eval, and `Negation(ubi)` stays permanently rejecting per `UnsignedBigIntegerOps.scala:48`). Also raised PRE-EVAL by `validateBinOpTypes` for an ordering operand whose static type is concretely non-numeric (`OnlyNumeric`); the pass's separate `isNumericTpe` predicate admits `SUnsignedBigInt` so a V3+ `LT(ubi,ubi)` is accepted (a UBI ordering operand in a pre-V3 tree is gated earlier by `validateV6Types`).
- **`'bin-op-not-boolean'`** — operand kind not `Boolean` for an op requiring Boolean operands (logical ops; also `BoolToSigmaProp`).
- **`'coll-not-boolean'`** — `And` / `Or` / `XorOf` arm received an input value that wasn't `Coll[Boolean]` (either `kind !== 'Coll'` or a Coll with a non-Boolean element). Wire-format invariants make this unreachable for parser-produced trees; defensive against `ConstantPlaceholder` injection.

### Numeric cast (Upcast / Downcast)

- **`'tree-version-too-low'`** — also the dispatcher's V3-gate code (see Dispatcher gating). On the Upcast/Downcast arms: a BigInt branch (Upcast: BigInt → BigInt; Downcast: source=BigInt) at `ctx.treeVersion < 3`. Mirrors sigma-rust's V3 gating (`eval/upcast.rs:18`, `eval/downcast.rs`).
- **`'downcast-overflow'`** — `Downcast` narrowed an input value outside the target kind's signed range. Distinct from `'arith-overflow'` so callers can dispatch on "narrowing specifically failed." Reused by `Downcast(UBI, Byte/Short/Int/Long)` when the UBI magnitude exceeds the signed target's range (`SType.scala:419-431` `ubi.toXExact`). `BitInversion` and `Upcast` have no overflow paths.

### FuncValue / Apply (higher-order functions)

- **`'apply-non-lambda'`** — `Apply.func` evaluated to an `SValue` whose `kind !== 'Lambda'`.
- **`'apply-arity-mismatch'`** — `Apply.args.length !== Apply.func.closure.argIds.length`. Explicit structural defensive check (sigma-rust silently truncates), fired BEFORE any arg eval; also the JVM-faithful reject for a wrong-arg-count application of a non-unary lambda.
- **`'apply-unresolved-type-var'`** — `Apply` arm + all 7 lambda HOF arms (`MapColl`, `Fold`, `Filter`, `Exists`, `ForAll`, `SColl.flatMap`, `SOption.map`): thrown at the apply-time arg binding when `closure.argTpes[i]` is — or structurally contains — an `STypeVar`. Raised by `eval/_lambda.ts:assertArgTypeResolved` BEFORE the arg is bound, independent of whether the body reads the arg. A type-var lambda that is bound but never applied evaluates fine (the `FunDef`/`ValDef` bind only evaluates `rhs` and ignores `tpeArgs`). Mirrors the JVM `stypeToRType(STypeVar)` → `RuntimeException("Unknown type T")`. Honest compiler-produced trees monomorphize polymorphic FunDefs at the call site; this is an adversarial over-accept guard. (The related wire-layer `ExprParseError('fun-def-tpe-arg-not-type-var')` and the `exprTpe`-internal `'apply-func-not-sfunc'` — relaxed to return `SAny` when the func's static type is `SAny`, matching `ByIndex`/`OptionGet` — are documented in [`facts/ergoscript-wire.md`](./ergoscript-wire.md).)

### Box-extract

- **`'extract-input-not-box'`** — `ExtractAmount` / `ExtractScriptBytes` / `ExtractRegisterAs` / `ExtractCreationInfo` / `ExtractBytes` / `ExtractBytesWithNoRef` / `ExtractId` received input whose `kind !== 'Box'`. Unreachable for parser-produced trees.
- **`'register-id-out-of-range'`** — `ExtractRegisterAs.registerId` outside the valid 0..=9 range. Charged 50 jit cost before the throw (Pattern A).
- **`'register-type-mismatch'`** — `ExtractRegisterAs` (and `SBox.getReg` 99:19) found a register entry whose stored `tpe` differs from the requested type. Sigma-rust THROWS here, NOT returns None (`extract_reg_as.rs:41-44`).

### Context / GlobalVars / GetVar / Option / SelectField

- **`'context-field-missing'`** — a `GlobalVars` arm (Height/Inputs/Outputs/SelfBox/MinerPubKey/GroupGenerator), the `GetVar` arm, the Deserialize substitute pass (DC needs `ctx.extension`, DR needs `ctx.selfBox`), the bare `0xa6` `LastBlockUtxoRootHash` op-form arm, or an SContext handler (`preHeader` 101:3, `selfBoxIndex` 101:8, `lastBlockUtxoRootHash` 101:9, `minerPubKey` 101:10 — but NOT `headers` 101:2, whose absence is the empty Coll) was reached but the required `EvalContext` field is absent.
- **`'get-var-type-mismatch'`** — `GetVar` (self) found a context-extension entry at the requested `varId` but its stored `tpe` did not match the arm's declared `var_tpe` (JVM `CContext.scala:61-75`). (Contrast `SContext.getVarFromInput` 101:12, which returns None on a type mismatch — see the asymmetry note in the registry section.)
- **`'option-empty'`** — `OptionGet` was called on an `Option` value whose `value === null` (None).
- **`'option-input-not-option'`** — `OptionGet`, `OptionIsDefined`, or `OptionGetOrElse` received an input whose `kind !== 'Option'`.
- **`'select-field-index-out-of-range'`** — `SelectField.fieldIndex` (1-based) resolved to a zero-based index outside `[0, items.length)`. Unreachable from parser-produced trees.
- **`'select-field-input-not-tuple'`** — `SelectField` received an input whose `kind !== 'Tuple'`.
- **`'select-field-non-pair'`** — `SelectField` received a `Tuple` input whose arity ≠ 2. The JVM `SelectField.eval` matches ONLY a runtime `Tuple2` (`transformers.scala:297-308`); a non-pair tuple is a `Coll[Any]` at runtime → `Value.typeError`. Adversarial-only.
- **`'unsupported-value-type'`** — a value flowing through a checkType seam (Tuple item, ConcreteCollection item, BlockValue valdef/result, ValUse, ConstantPlaceholder) has a DECLARED type that is a non-pair `STuple` (items.length ≠ 2) or non-unary `SFunc` (tDom.length ≠ 1). Mirrors JVM `SType.isValueOfType` (`SType.scala:200-205`) which `sys.error`s "Unsupported tuple type"/"Unsupported function type" — these declared types are wire-constructible but the JVM cannot represent their values. Emitted by the shared `assertValueTypeSupported(tpe)` helper (top-level, non-recursive; nesting covered by per-item seam calls). Adversarial-only. The FuncValue/Apply param+body `SFunc` arms (the closure path) are deliberately NOT hooked — a non-unary `FuncValue` rejects via this code at the BlockValue valdef-rhs binding when the Lambda flows through a binding (bound-never-applied rejects; dead-branch accepts), and wrong-arg-count `Apply` rejects via `'apply-arity-mismatch'`.

### Collection HOFs

- **`'coll-input-not-coll'`** — any Coll HOF arm received an input whose `kind !== 'Coll'`. Defensive against `ConstantPlaceholder` injection.
- **`'coll-elem-tpe-mismatch'`** — Filter / Exists / ForAll arm: an element's runtime `kind` did not match the declared element type derived from `condition.args[0].tpe`.
- **`'coll-by-index-out-of-range'`** — `ByIndex` arm: index outside `[0, coll.items.length)` and no default expression provided.
- **`'coll-by-index-index-not-int'`** — `ByIndex` arm: the index expression evaluated to a non-`Int`.
- **`'coll-slice-bound-not-int'`** — `Slice` arm: the `from` or `until` expression evaluated to a non-`Int`.
- **`'lambda-not-callable'`** — MapColl / Filter / Fold / Exists / ForAll / flatMap arm: the function expression evaluated to a non-Lambda, OR the resulting Lambda's `closure.argIds` is empty. Also the flatMap body-restriction: a `MethodCall` body with non-empty args (`scoll.rs:78-84`).
- **`'lambda-result-type-mismatch'`** — MapColl / Fold arm: the lambda body returned an `SValue` whose `kind` did not match the expected result type.
- **`'coll-update-index-out-of-range'`** — `SColl.updated` (12:20) / `SColl.updateMany` (12:21): a target index is out of bounds for the receiver Coll. Genuine runtime error; a NEGATIVE index wraps to a huge `usize` in sigma-rust ⇒ also OOB.
- **`'coll-update-many-length-mismatch'`** — `SColl.updateMany` (12:21): `indexes` and `values` differ in length. Checked before the per-index OOB loop.
- **`'coll-map-elem-type-infer-failed'`** — `sValueType` (`eval/svalue-type.ts:66`) / the predecessor `inferSType` (`eval/coll-map.ts`): the `default` arm of the exhaustive `switch (v.kind)` over every `SValue` variant. tsc-provably unreachable under strict mode; the runtime tripwire that fires if a NEW `SValue.kind` is added without a corresponding `sValueType` arm. Counted per the defensive-code convention (precedent: `'unsigned-bigint-negative'` and `'sigma-prop-is-proven-no-eval'` are documented as defensive/unreachable guards).

### Sigma-protocol arms

- **`'sigma-prop-input-not-group-element'`** — `CreateProveDlog` or `CreateProveDhTuple` arm received input whose `kind !== 'GroupElement'`. Unreachable for parser-produced trees.
- **`'sigma-prop-bytes-input-not-sigma-prop'`** — `SigmaPropBytes` arm received input whose `kind !== 'SigmaProp'`. Unreachable for parser-produced trees.
- **`'sigma-prop-is-proven-no-eval'`** — `SigmaPropIsProven` arm always throws structurally (no `e.input` eval, no cost). Mirrors sigma-rust `sigma_prop_is_proven.rs:11-25`; opcode 95 exists for byte-match parity with Scala sigmastate (whose typer rewrites `prop.isProven` to this node; the AOT graph-IR rewrite elides it before evaluation).
- **`'sigma-boolean-compare-unsupported'`** — `Eq`/`NEq` over two `SigmaProp`s where the LEFT SigmaBoolean is a conjecture (`Cand`/`Cor`/`Cthreshold`) and the RIGHT is a different variant. Mirrors the JVM `DataValueComparer.equalSigmaBoolean` `case _ => sys.error` (`DataValueComparer.scala:278-281`). ASYMMETRIC by design: leaf-left vs conjecture-right returns `false` (no throw). Cost-then-throw (the node's MatchType is charged at entry). Reachable from honest scripts: `(pkA && pkB) == pkC`.

### Atleast / sigma combinators

- **`'atleast-bound-not-int'`** — `Atleast` arm: the `bound` expression evaluated to a non-`Int`.
- **`'atleast-too-many-children'`** — `Atleast` arm: the evaluated input collection holds MORE than 255 SigmaProps (`MaxChildrenCountForAtLeastOp = 255`, JVM `SigmaConstants.scala:65`; CTHRESHOLD's GF(2^192) polynomial arithmetic takes single-byte inputs). Thrown AFTER the Pattern-B per-item charge and BEFORE the degenerate-bound reductions — the JVM order: `AtLeast.eval` (`trees.scala:314-320`) charges, then `CSigmaDslBuilder.atLeast` caps (`CSigmaDslBuilder.scala:102-108`) before `AtLeast.reduce` (whose degenerates live inside, `trees.scala:340-359`). So `atLeast(0, >255 children)` THROWS — it does not reduce to TrueProp. eni applies the cap only in the non-degenerate path (a JVM↔sigma-rust fork; ergots follows the JVM). Adversarial-only.
- **`'sigma-prop-coll-elem-not-sigma-prop'`** — `Atleast` / `SigmaAnd` / `SigmaOr` arm (via `expectSigmaProp`): an item evaluated to non-SigmaProp.
- **`'sigma-prop-input-not-coll'`** — `Atleast` arm (via `extractSigmaPropColl`): the `input` evaluated to non-Coll. (`SigmaAnd`/`SigmaOr` take `items: Expr[]`, so this applies only to `Atleast`.)

### Method-call dispatch

- **`'method-not-implemented'`** — `MethodCall` / `PropertyCall` dispatcher: the `(typeId, methodId)` pair has no registered handler. Also reused for defensive shape mismatches inside registered handlers (compact taxonomy: covers both "dispatch miss" and "handler shape mismatch"). All non-SContext handlers reuse it for obj-kind defensive throws.
- **`'context-obj-not-context'`** — `SContext.dataInputs` / `SContext.preHeader` handler: the `obj` argument evaluated to an `SValue` whose `kind !== 'Context'`. Unreachable for parser-produced trees.

### AVL-tree

- **`'avl-tree-obj-not-avl-tree'`** — defensive receiver check on all `SAvlTree.*` handlers when `obj.kind !== 'AvlTree'`. Unreachable for parser-produced trees.
- **`'avl-tree-proof-failed'`** — thrown when a Tier-2 verification op fails AND the method's JVM contract calls for a throw on that path. **JVM-canonical construct-fail routing:** the JVM `BatchAVLVerifier` wraps construction in `Try{…}.toOption`, `CAvlTreeVerifier.logError` is a no-op, so a bad proof yields `topNode = None`, not a throw. Observable routing per method:
  - `contains` (100:9) — construct-fail → **`false`** (never throws); per-op fail → `false`.
  - `get` (100:10) — construct-fail → throws (charged: createVerifier + 1 lookup first); per-op fail → throws; key-absent → `None`.
  - `getMany` (100:11) — construct-fail with ≥1 key → throws; zero-keys → empty Coll, NO throw even on construct-fail; first Lookup Failure → throws; per-key absence → per-key None.
  - `insert` (100:12) — construct-fail: **V<3 throws (≥1 op required; zero-ops → None at every version)**, **V3+ → None**. Per-op fail: V<3 throws, V3+ → None.
  - `update` (100:13) — construct-fail → **None** (no version split); per-op fail → None.
  - `remove` (100:14) — construct-fail → **None** (never throws); per-op fail → None.
  - `insertOrUpdate` (100:16) — construct-fail → **None** (never throws); per-op fail → None.

  **Op-shape mismatches join the per-op-fail path.** scorex checks key shape per-op (`require(key > -inf)`, `< +inf`, `length == keyLength`; ±inf = all-0x00/all-0xFF × keyLength) and value length at the write branches; each violation is a `Failure` AT THAT OP'S INDEX (ops before it replay; the tree then poisons). Verified against scrypto 3.0.0 bytecode + `ergo_avltree_rust` (`authenticated_tree_ops.rs:226-229,291,314`). The handlers emulate this with a pre-scan (`firstShapeBadOpIndex`) + prefix-slice (`verifyWithShapeRouting`) because `@ergots/avltree`'s public API validates shapes upfront (throws `AvlVerifyError`, which must never escape the evaluator). Construct-shape violations (`keyLength <= 0`, fixed `valueLengthOpt < 0`, `digest.length != 33` — scorex reconstruction requires) route as construct-fail with **treeHeight 0** for the per-op charges. Single code per the compact-taxonomy decision; granular per-cause codes are noise (all "the script's assumption about chain state was wrong," not branched-on by callers).
- **`'autolykos-v1-not-supported'`** — `SHeader.checkPow` handler caught an `AutolykosV1NotSupportedError` from `verifyAutolykosV2` (`@ergots/scorex`). Mirrors sigma-rust `AutolykosPowSchemeError::Unsupported` (`autolykos_pow_scheme.rs:322-324`). Real Ergo nodes skip v1 PoW verification structurally; this surfaces the unusual case where `ctx.headers` includes a V1 header AND a script invokes `checkPow` on it.

### Header / PreHeader

- **`'header-obj-not-header'`** — defensive receiver check on all 15 `SHeader.*` handlers when `obj.kind !== 'Header'`. Unreachable for parser-produced trees.

### Pure-bytes predefs

- **`'predef-input-not-byte-array'`** — defensive `Coll[Byte]` kind-check shared by `CalcBlake2b256`, `CalcSha256`, `ByteArrayToLong`, `ByteArrayToBigInt`, `Xor` (both operands), `DecodePoint`. Unreachable for parser-produced trees.
- **`'byte-array-to-long-too-short'`** — `ByteArrayToLong`: input `Coll[Byte]` had `length < 8`. The comparison is `< 8`, NOT `!= 8`: trailing bytes after the first 8 are silently ignored (sigma-rust `byte_array_to_long.rs:62-65` `eval_skip_tail`). Charged Pattern A cost 16 BEFORE the throw.
- **`'predef-input-not-long'`** — `LongToByteArray`: input `kind !== 'Long'`. Unreachable for parser-produced trees.
- **`'byte-array-to-bigint-empty'`** — `ByteArrayToBigInt`: input length 0. Distinct from the out-of-range code (JVM throws on empty rather than defaulting to BigInt(0)).
- **`'byte-array-to-bigint-out-of-range'`** — `ByteArrayToBigInt`: signed-BE-decoded value outside `[I256_MIN, I256_MAX]` = `[-2^255, 2^255 - 1]`. Length is NOT capped at 32: 33+ byte inputs with redundant sign-extension bytes succeed when their effective value fits in i256.
- **`'decode-point-invalid'`** — `DecodePoint`: the 33-byte SEC1-compressed input failed `decodePoint` adapter validation. Charged Pattern A cost 300 BEFORE the throw.
- **`'subst-constants-error'`** — `SubstConstants` (CONSENSUS-CRITICAL — output bytes go on-chain): compact code covering 6 throw paths (positions vs newValues length mismatch; element type mismatch vs the template's constant type at a position; newValues not a Coll; positions not a Coll; scriptBytes not Coll[Byte]; serializer-level substitution error from `substituteConstantsBytes` — bad template bytes / too-many-constants). Out-of-range positions are a no-op, NOT a throw (JVM `getPositionsBackref` parity); the cost is sized by the TEMPLATE's `constants.length`, not positions.length (sigma-rust `subst_const.rs:221-283`). Per the compact-taxonomy decision; distinguished by `.message`.

### Curve / group predefs

- **`'group-op-input-not-group-element'`** — `MultiplyGroup` (both operands) and `Exponentiate` (base) when input `kind !== 'GroupElement'`. Distinct from `'sigma-prop-input-not-group-element'` (which is for sigma-prop creation arms). Unreachable for parser-produced trees.
- **`'predef-input-not-bigint'`** — `Exponentiate` arm when exponent `kind !== 'BigInt'`. Unreachable for parser-produced trees.

### Deserialize family

- **`'deserialize-input-not-byte-array'`** — `DeserializeContext` / `DeserializeRegister` substitute pass: the context-extension / register entry's `tpe` is not `SColl<SByte>` (or its `value` is not a `Coll` of Byte items). For DC: only when the var IS found and IS a byte array that fails extraction (absent/wrong-typed DC vars leave the node unchanged — see the asymmetry below). For DR: reached eagerly on a wrong-typed register entry (JVM erasure → `ClassCastException`). Mirrors sigma-rust `try_extract_into::<Vec<u8>>()` failure (`mir/expr.rs:459`).
- **`'deserialize-parse-failed'`** — substitute pass: the inner Expr bytes (from `ctx.extension` / `selfBox.registers`) fail to parse. Wraps the underlying wire-layer error message. Mirrors `SubstDeserializeError::ExprParsingError` (`mir/expr.rs:725`).
- **`'deserialize-tpe-mismatch'`** — substitute pass: `exprTpe(parsed) !== e.tpe`. Runs on BOTH the register-decoded inner Expr AND the `default` fallback (`mir/expr.rs:486-491`). Mirrors `SubstDeserializeError::ExprTpeError`.
- **`'deserialize-not-substituted'`** — eval-time defensive throw on both Deserialize* arms, reached when the substitute pass did NOT rewrite the node: (a) `DeserializeRegister` with register absent + `default === null` — sigma-rust `substitute_deserialize` returns `Ok(())` leaving the node unchanged (`mir/expr.rs:478-481`); (b) a LIVE `DeserializeContext` over an absent or wrong-typed ctx var (the failure-tolerant path leaves the node; this throw fires only if it reaches a live branch — a dead branch never reaches eval); (c) recursive Deserialize — an outer Deserialize* decoded to an inner Expr containing another Deserialize* (sigma-rust's `try_rewrite_bu` does NOT re-walk substituted children, `mir/expr.rs:397-408`).

**DC/DR asymmetry (both JVM-faithful):** a `DeserializeContext` over an absent OR wrong-typed ctx var leaves the node UNCHANGED (no throw during the substitute pass; JVM `Interpreter.scala:110-125` `substDeserialize` returns `None`), erroring only via `'deserialize-not-substituted'` if it reaches a live branch. A `DeserializeRegister` over a wrong-typed register entry STILL throws eagerly (`'deserialize-input-not-byte-array'`) — the JVM erases to `ClassCastException` there.

### v6 numeric methods (Byte/Short/Int/Long/BigInt; all require `treeVersion >= 3`)

- **`'numeric-shift-out-of-range'`** — any `X.shiftLeft` / `X.shiftRight` (typeIds 2–6, methodIds 12–13) when `bits` is outside `[0, width)` (width 8/16/32/64/256). Both `bits < 0` and `bits >= width` rejected. Mirrors the JVM `ExactIntegral.shiftLeft`/`shiftRight` + `BigIntegerOps` (`CBigInt.scala`) range guards.
- **`'bigint-result-out-of-range'`** — any v6 BigInt operation whose result falls outside signed-256 `[-2^255, 2^255 - 1]`. Reachable via `BigInt.shiftLeft` and `UnsignedBigInt.toSigned` (9:19, when receiver `≥ 2^255`). Mirrors the JVM `CBigInt` constructor `.toSignedBigIntValueExact` (`Extensions.scala:219`, bitLength > 255). Distinct from `'byte-array-to-bigint-out-of-range'` (a predef-input reject, not an arithmetic result).
- **`'numeric-method-bad-operand'`** — any of the 40 v6 numeric method handlers (and the two bridges) when the receiver `obj` or an operand argument evaluates to an unexpected `kind`. Mirrors the JVM `asInstanceOf` / sigma-rust `try_extract_into` rejection. Unreachable for parser-produced trees; defensive against hand-crafted MIR (wrong-kind constant injected as `obj`/`args[0]` — without the guard Byte/Short/Int silently return garbage and Long/BigInt throw a raw `TypeError`, both consensus over-accepts). Unconditional at runtime (concrete `obj.kind` is never `SAny` — this is NOT a static `exprTpe` check). Source: `eval/_numeric-v6.ts:requireKind`.

### v6 `UnsignedBigInt`

- **`'v6-type-in-pre-v3-tree'`** — `validateV6Types` pre-eval pass (see Pre-eval gates): an `SUnsignedBigInt` (type code 9) or `SFunc` (type code 112) construct in a `treeVersion < 3` tree. Zero JIT cost. Source: `eval/validate-v6-types.ts`.
- **`'unsigned-bigint-op-unsupported'`** — a `UnsignedBigInt` SValue reached an operation with no JVM path. Survives only in the UBI cast matrix (`eval/_cast-ubi.ts`): UBI↔BigInt casts (both directions) and UBI-source `Upcast` to a signed/BigInt target — the language routes UBI↔BigInt through `toUnsigned`/`toSigned` instead (`SType.scala:419-590`). (Originally also emitted from the two `relation.ts` equality stubs, later replaced with real UBI equality.)
- **`'unsigned-bigint-out-of-range'`** — a value fell outside unsigned `[0, 2^256)`. Sources: `UnsignedBigInt.shiftLeft` (9:12) result with `bitLength > 256` (after the bits-range guard); arith BinOp `Minus` underflow / `Plus`/`Multiply` overflow; a signed Byte/Short/Int/Long source cast to a UBI target where the value `< 0` (`CUnsignedBigInt(valueOf(x))`); and `BigInt.toUnsigned` (6:14) with a negative receiver. Mirrors `CUnsignedBigInt` constructor `bitLength > 256` reject (`CUnsignedBigInt.scala:14-22`, `CUnsignedBigInt.scala:16-22`), `UnsignedBigIntegerOps.scala:131-149`, and `Extensions.scala:234-240` (`toUnsignedBigIntValueExact`).
- **`'unsigned-bigint-not-invertible'`** — `UnsignedBigInt.modInverse(a, m)` (9:14): `gcd(a, m) ≠ 1`, no modular inverse exists. (`m == 0` reuses `'arith-divide-by-zero'`.) Source: `eval/_ubi-modular.ts` `umodInverse`.

### Global predefs (serialize / nbits / powHit / big-endian)

- **`'global-serialize-failed'`** — `SGlobal.serialize` (106:3): the sigma-serialization of the argument value failed (e.g. a `'Lambda'` or `'Context'` SValue kind, which have no on-wire encoding). `T` is derived from the RUNTIME value kind, not `exprTpe`. Source: JVM `methods.scala:1957`.
- **`'global-deserialize-failed'`** — `SGlobal.deserializeTo[T]` (106:4): the supplied `Coll[Byte]` failed to parse as an SValue of type `T` via the data codec — malformed/truncated bytes, an oversized BigInt/UnsignedBigInt (> 32 bytes), or actual parse recursion deeper than `MaxTreeDepth` (110, data-driven; the shared `@ergots/scorex` `ByteReader` level counter raises `ReaderError('max-tree-depth-exceeded')`, caught and re-coded). No ErgoTree body parse, no `exprTpe` match — `T` drives the parse directly. Source: JVM `methods.scala:1906`.
- **`'global-from-bigendian-bytes-failed'`** — `SGlobal.fromBigEndianBytes[T]` (106:5): wrong exact length (Byte≠1/Short≠2/Int≠4/Long≠8), oversized BigInt/UnsignedBigInt (>32 bytes), empty bytes for BigInt (JVM `new BigInteger(byte[0])` throws; UBI empty → 0 accepted), or unsupported non-numeric `T`. `FixedCost(10)` charged before the throw. Source: JVM `methods.scala:1925`.
- **`'global-encode-nbits-failed'`** — `SGlobal.encodeNbits` (106:6): defensive obj-kind/arity guards only — no faithful failure path for a valid ≤256-bit `SBigInt` input (`size ≤ 33` so `size << 24` cannot overflow). `FixedCost(25)` charged before any guard throw. Source: JVM `methods.scala:1939`.
- **`'global-decode-nbits-failed'`** — `SGlobal.decodeNbits` (106:7): the low-32-bit-truncated input decoded to a value whose signed bit-length exceeds 255 (JVM `.toSignedBigIntValueExact`; sigma-rust `.try_into::<BigInt256>()`), plus the defensive guards. `FixedCost(50)` charged before the throw. Source: JVM `methods.scala:1944`.
- **`'pow-hit-invalid-params'`** — `SGlobal.powHit` (106:8): the Autolykos-2 parameter guards failed (`k < 2`, `k > 32`, or `N < 16`), OR the structural `obj.kind !== 'Global'` / `args.length !== 5` guards. Maps `@ergots/scorex`'s `PowHitInvalidParamsError`. `PowHitCostKind` (`CostKind.scala:79-87`) cost is charged BEFORE any guard throw — a guard-failing call still pays the full cost. Source: JVM `Autolykos2PowValidation.scala:115-120`.

### Retired / non-emitted codes (kept for provenance)

These tokens appear in the source/history but are NOT live EvalError codes. Listed so reviewers don't mistake their absence from the live taxonomy for a drop:

- **`'atleast-bound-out-of-range'`** — removed. The JVM `Atleast` applies degenerate-bound reductions before any range check: `bound ≤ 0` → `TrivialProp(true)`; `bound > items.length` → `TrivialProp(false)` (after the per-item charge). There is no eval-time 255-*bound* cap; the 255-*children* cap is the separate `'atleast-too-many-children'`.
- **`'deserialize-context-key-not-found'`** — removed. An absent/wrong-typed `DeserializeContext` var now leaves the node unchanged (JVM-faithful failure-tolerant substitution); a LIVE such node errors via `'deserialize-not-substituted'`.
- **`'create-avl-tree-shape-mismatch'`** — removed. The `CreateAvlTree` arm became an unconditional `'unsupported-eval-node'` reject (no JVM eval override), orphaning its 3 shape-mismatch throw paths.
- **`'avl-tree-bad-digest-length'`** — retired. JVM `CAvlTree.scala:31-34` has no length require on `updateDigest`; any `Coll[Byte]` length is accepted verbatim. The 33-byte gate mirrored sigma-rust's `ADDigest::try_from`, a convergent over-reject.
- **`'unsupported-eval-node'`** — the `TreeLookup` (opcode 0xb7) and `CreateAvlTree` (opcode 0xb6) Expr arms reject unconditionally with this code. The JVM has NO eval override for either node (`costKind = Value.notSupportedError`, `trees.scala:1322-1338`/`trees.scala:1334-1337` TreeLookup, `trees.scala:79-91` CreateAvlTree; CreateAvlTree carries `// TODO v6.0: implement eval`, issue #907) and the default `Value.eval` fires `sys.error` (`values.scala:102`). Every evaluation throws JVM-side, so both arms reject: nothing charged, no operand evaluated. Both nodes still PARSE. Mainnet history is JVM-validated ⇒ no block ever evaluated either node ⇒ the reject cannot fork against chain history. The previous evaluating arms were sigma-rust ports (eni convergently over-accepts both).
- **`'unsigned-bigint-negative'`** — an invented code, never emitted (the wire layer rejects negative UBI structurally); kept here as a defensive-code-convention precedent reference.

## Eval-arm cost reference

The per-`Expr`-arm cost model (the method-call surface is in the registry table below). **Pattern A** = envelope cost charged BEFORE eval-children; **Pattern B** = per-iteration cost charged AFTER each loop iteration; **Mixed** = both (used by all 5 lambda HOF arms). Costs are `sigma-rust`-accurate (mainnet-validated genesis→tip) and JVM-conformance-blessed.

| Expr arm | Cost | Pattern | Notes |
|---|---|---|---|
| `Const` | 5 (`evalConst`) | A | flat |
| `ConstPlaceholder` | 1 (lazy-resolve path) / 5 (substituted-in `Const`) | A | see the constantSegregation note under Pre-eval gates |
| `BlockValue` | `addPerItemCost(1, 1, 10, items.length)` + `ADD_TO_ENV_COST(5)` per `ValDef` bind | B | |
| `ValDef` / `FunDef` | bind = `ADD_TO_ENV_COST(5)` (charged by `BlockValue`) | — | `FunDef` is a `ValDef` carrying `tpeArgs`; `tpeArgs` are eval-irrelevant (`values.scala:911`) |
| `ValUse` | 5 (before env lookup) | A | |
| `Tuple` | 15 | A | arity ≠ 2 throws `'tuple-invalid-arity'` before items + envelope |
| `Collection` | (children only) | — | `Exprs` and `BoolConstants` kinds |
| `If` | (children only; short-circuit) | — | only the taken branch is evaluated + charged |
| `BinOp` Arith | Plus/Minus 15 (BigInt 20); Multiply/Divide/Modulo 15 (BigInt 25); Max/Min 5 (BigInt 10) | A | UBI takes the non-BigInt tier (`trees.scala:752-849`) |
| `BinOp` Relation-ordering | 20 (`Lt`/`Le`/`Gt`/`Ge`, all kinds incl. UBI) | A | `trees.scala:1095-1194` |
| `BinOp` Eq/NEq | `EQ_PRIM 3` / `EQ_BIGINT 5`; composite per the equality walk (below) | A | UBI mirrors BigInt (`DataValueComparer.scala:141,343`) |
| `BinOp` Logical | And/Or short-circuit (right side not charged when short-circuited); Xor eager | — | |
| `BinOp` Bit | BitAnd/BitOr/BitXor (kind-uniform bigint mask); shifts throw `'not-implemented-yet'` | — | shifts delegate to `SNumericTypeMethods`, not the BinOp arm |
| `LogicalNot` / `BoolToSigmaProp` | per sigma-rust | — | |
| `Negation` / `BitInversion` | numeric, per kind | A | `Negation` overflow → `'arith-overflow'` |
| `Upcast` / `Downcast` | 10 (BigInt/UBI target 30) | A | charged before the cast runs (a throwing cast still charges); see the UBI cast matrix below |
| `And` / `Or` (Coll[Boolean]) | `addPerItemCost(10, 5, 32, n)` / `addPerItemCost(5, 5, 64, n)` | B | empty Coll → true / false |
| `XorOf` | Coll[Boolean] XOR; V0/V1-vs-V2+ semantics drift | B | reuses `'coll-not-boolean'` |
| `ExtractAmount` | 8 | A | |
| `ExtractScriptBytes` | 10 | A | box's serialized ErgoTree |
| `ExtractRegisterAs` | 50 | A | R0..R9; type-assertion mismatch THROWS `'register-type-mismatch'` (not None) |
| `ExtractCreationInfo` | 16 | A | `Tuple[Int, Coll[Byte](34): txId ++ BE u16 index]` |
| `ExtractBytes` / `ExtractBytesWithNoRef` / `ExtractId` | 12 each | A | full canonical bytes / without txId+index / blake2b-256 of canonical bytes |
| `GlobalVars` | 10 | A | Height/Inputs/Outputs/SelfBox/MinerPubKey/GroupGenerator |
| `GetVar` | 10 | A | reads `ctx.extension.values[varId]` |
| `OptionGet` / `OptionGetOrElse` | 15 | A | `OptionGetOrElse` V3-gated lazy semantics; `OptionGet` None → `'option-empty'` |
| `OptionIsDefined` | 10 | A | |
| `SelectField` | 10 | A | 1-based fieldIndex |
| `SizeOf` | 14 | A | |
| `Append` | `addPerItemCost(20, 2, 100, result.length)` | A | |
| `ByIndex` | 30 | A | |
| `Slice` | `addPerItemCost(10, 2, 100, result.length)` | A | negative `until` clamps to empty (memory `reference_slice_negative_until_jvm_divergence`) |
| `MapColl` / `Filter` / `Fold` / `Exists` / `ForAll` | outer `addPerItemCost(20, 2, 128, input.length)` + per-iter `Fixed(1)` | Mixed | Filter/Exists/ForAll derive the declared elem type from `condition.args[0].tpe` (the TS MIR structs carry no `elemTpe` field) |
| `Context` | 1 | A | returns the `{ kind: 'Context' }` sentinel |
| `Global` | 5 | A | returns the `{ kind: 'Global' }` sentinel |
| `SigmaPropBytes` | `addPerItemCost(35, 6, 1, 1)` | A | |
| `MethodCall` / `PropertyCall` | 4 (dispatcher envelope) | A | routes via the `(typeId, methodId)` registry |
| `CalcBlake2b256` | `addPerItemCost(20, 7, 128, n)` | B | `@noble/hashes/blake2.js` blake2b, `dkLen: 32` |
| `CalcSha256` | `addPerItemCost(80, 8, 64, n)` | B | `@noble/hashes/sha2.js` sha256 |
| `ByteArrayToLong` | 16 | A | first 8 bytes BE → i64; trailing ignored |
| `LongToByteArray` | 17 | A | i64 → 8 bytes BE |
| `ByteArrayToBigInt` | 30 | A | signed BE → bigint, range-checked to i256 |
| `Xor` | `addPerItemCost(10, 2, 128, l_length)` | B | truncating-zip; output length `min(left, right)`; no length-mismatch error |
| `DecodePoint` | 300 | A | reuses `crypto/secp256k1.ts:decodePoint`; ANY 0x00-lead ⇒ identity (memory `reference_decodepoint_zero_lead_identity`) |
| `SubstConstants` | `addPerItemCost(100, 100, 1, template.constants.length)` | B | CONSENSUS-CRITICAL bytes-in/bytes-out; cost sized by the TEMPLATE's constants.length (`subst_const.rs:221-283`); serializer-level (`substituteConstantsBytes`) — copies the tree body verbatim, mirroring JVM `ErgoTreeSerializer.substituteConstants`; out-of-range positions are a no-op, duplicate positions first-wins |
| `MultiplyGroup` | 40 | A | group op = point ADDITION (`ec_point.rs:74-80` `Mul = ProjectivePoint::add`); reuses `pointAdd` |
| `Exponentiate` | 900 | A | scalar mult; REQUIRES explicit identity-base guard (`@noble/curves` `Point.multiply` does not short-circuit on `Point.ZERO`); mirrors sigma-rust `ec_point.rs:111-119` (identity guard `ec_point.rs:113-118`) |
| `SigmaPropIsProven` | (none) | — | structural throw `'sigma-prop-is-proven-no-eval'`; no eval of `e.input`, no cost |
| `CreateAvlTree` / `TreeLookup` | (none) | — | unconditional `'unsupported-eval-node'` reject (no JVM eval override) |
| `DeserializeContext` / `DeserializeRegister` | (substitute-pre-pass) | — | the arms are defensive `'deserialize-not-substituted'` throws; the work happens in `substituteDeserialize` (`eval.rs:203-250`, `mir/expr.rs:442-496`) |
| `LastBlockUtxoRootHash` (bare `0xa6` op-form) | 15 | A | reads `ctx.lastBlockUtxoRootHash` (`values.scala:1490-1501`, FixedCost at `values.scala:1495`); same field as the 101:9 PropertyCall handler, cost differs by wire shape (15 vs 20) |

**UBI cast matrix** (Upcast/Downcast arms with a UBI source or target; faithful mirror of `SType.scala:419-590`; cost charged FIRST in all cells):

| node | source → target | behaviour | cost |
|---|---|---|---|
| Downcast | UBI → Byte/Short/Int/Long | `ubi.toXExact` — range-check, throw `'downcast-overflow'` if outside signed range | 10 |
| Downcast | UBI → BigInt | `SBigInt.downcast` has no UBI case ⇒ `'unsigned-bigint-op-unsupported'` | 30 |
| Downcast/Upcast | UBI → UBI | identity (`v ≥ 0`) | 30 |
| Downcast/Upcast | Byte/Short/Int/Long → UBI | `CUnsignedBigInt(valueOf(x))` if `x ≥ 0` else `'unsigned-bigint-out-of-range'` | 30 |
| Downcast/Upcast | BigInt → UBI | `SUnsignedBigInt.*` has no BigInt case ⇒ `'unsigned-bigint-op-unsupported'` | 30 |
| Upcast | UBI → Byte/Short/Int/Long/BigInt | the signed/BigInt `upcast` has no UBI case ⇒ `'unsigned-bigint-op-unsupported'` | 10 |

The UBI branch sits at the TOP of the cast arms, isolated from the shared `isNumeric`/`NumericKind` path (`CostKind.scala:60-66` for the cost-30 NumericCast tier; `trees.scala:404,411-416,436`; per-cell `SType.scala:465` UBI→BigInt, `SType.scala:522` signed→UBI, `SType.scala:559` BigInt→UBI). Widening the shared predicate would flip `Negation(ubi)` / UBI arith / UBI ordering from reject to accept — a fork. The signed-5 path (neither source nor target UBI) is unchanged.

**UBI BinOp semantics** (V3-gated; both operands must be UBI, else `'bin-op-kind-mismatch'` at eval for arith or pre-eval via `validateBinOpTypes` for ordering/equality): Plus/Minus/Multiply bound-check `[0, 2^256)`; Divide/Modulo → `'arith-divide-by-zero'` on zero; Modulo is non-negative (`UnsignedBigIntegerOps.scala:87`); ordering/equality are plain `bigint` compares mirroring BigInt (`methods.scala:309-459`, `SType.scala:194` for the distinct `CUnsignedBigInt` wrapper). UBI arith takes the non-BigInt cost tier (Plus/Minus 15, Multiply/Divide/Modulo 15, Min/Max 5); ordering 20; scalar Eq/NEq 5; `Coll[UBI]` Eq/NEq is a COA bulk-compare (one PerItem charge, then a non-recursive element loop — `DataValueComparer.scala:141-142`; scalar Eq/NEq `DataValueComparer.scala:343-351`). The UBI modular methods (registry rows 105–110) reduce through one Euclidean primitive `umod` (`CUnsignedBigInt.scala:47-77`, `methods.scala:551-623`, `CBigInt.scala:77-79`; modInverse `CUnsignedBigInt.scala:57-59`, `methods.scala:574-576`, oracle `BasicOpsSpecification.scala:590-628`).

**Equality semantics** (the JVM verdict basis per compared kind, `DataValueComparer.scala:44-71` flat per-type costs EQ_GroupElement 172 / EQ_Box 6 / EQ_PreHeader 4 / EQ_Header 6):
- Bare `GroupElement` and `Coll[GroupElement]`-elementwise Eq/NEq = **value basis** — identity-aware `ecPointEqual` under EQ_GroupElement(172) (`DataValueComparer.scala:284-291,340-341`).
- `SigmaProp` Eq/NEq = recursive costed SigmaBoolean walk — MatchType(1)/node + EQ_GroupElement(172)/ECPoint compared (`DataValueComparer.scala:253-282,353-361`); conjecture-left vs different-variant-right throws `'sigma-boolean-compare-unsupported'`.
- `Box` Eq/NEq = **byte basis** — JVM `ErgoBox.equals` compares ids = blake2b over the serialized input bytes (`ErgoBox.scala:94-97`), so `boxEqual` is a pure id compare (blake2b over retained-or-canonical bytes, via `boxIdOf`/`boxBytesOf`): two boxes differing only in garbage-vs-canonical identity-GE register encodings are UNEQUAL (both decode to the identity point; the ids still differ).
- `Header` Eq/NEq = **id basis** — `CHeader.equals` compares ids = blake2b over the cached input bytes (`ErgoHeader.scala:133-140`); the 13-field walk in `headerEqual` (incl. `id`) is verdict-equivalent.
- `PreHeader` = field basis in the JVM but adversarially unreachable (no SPreHeader DataSerializer arm); byte-field compare kept, document-only.

`serializeCost` (`eval/serialize-cost.ts`) is the analytical DynamicCost walk backing `SGlobal.serialize` (registry row 117): it mirrors the JVM `SigmaByteWriter` per-primitive costs for every `SType` arm including complex types. `putUByte(x)` charges 1 (the JVM scorex `Writer.putUByte` delegates to `put(Byte)` → `addFixedCost(PutByteCost)`), whereas bare `putUInt(x: Long)` charges 0 — the two are asymmetric. Sites charging the `putUByte` byte: Box `nTokens`/`nRegs` counts (`ErgoBoxCandidate.scala:144`,`:166`), AvlTree flags (`AvlTreeData.scala:76`), Header-v1 `dLen` (`ErgoHeader.scala:68`), Header-v2 `unparsedLen` (`HeaderWithoutPow.scala:61-62`), Tuple-register count, and the type-serializer length bytes (`types.rs:456` >4-tuple len; `stype_param.rs:81` STypeVar name len) — the latter is a JVM↔eni divergence (eni does not charge these; JVM is canonical, only the >4-tuple site is adversarially reachable). GE serialization emits canonical bytes by the GE canonical-bytes invariant (`GroupElementSerializer.scala:20-33`).

## Dispatcher minVersion gating

The method-call dispatcher consults an optional `minVersion?: number` field on each registry entry. When set, it throws `EvalError('tree-version-too-low')` if `(ctx.treeVersion ?? 0) < entry.minVersion`, BEFORE invoking the handler. This is sigma-rust-parity with `MethodDesc.min_version` gating (and mirrors JVM `isV3OrLaterErgoTreeVersion`): a V<N reject incurs receiver-eval cost + the dispatcher envelope (4) but NOT the handler's own cost (e.g. 700 for `checkPow`).

Entries using `minVersion: 3` (V3-gated): `SHeader.checkPow` (104:16), `SAvlTree.insertOrUpdate` (100:16), all 40 v6 numeric-method handlers (typeIds 2–6, methodIds 6–13), the 8 v6 `UnsignedBigInt` method handlers (typeId 9, methodIds 6–13), the 6 v6 `UnsignedBigInt` modular methods + `BigInt.toUnsignedMod` (9:14–18, 6:15), the 2 v6 bridge methods (`BigInt.toUnsigned` 6:14, `UnsignedBigInt.toSigned` 9:19), the 4 v6 `SColl` methods (12:30–33), the 2 v6 `SGlobal.some`/`none` (106:9/10), the 5 other v6 `SGlobal` methods (`serialize` 106:3, `deserializeTo` 106:4, `fromBigEndianBytes` 106:5, `encodeNbits` 106:6, `decodeNbits` 106:7, `powHit` 106:8), and the 3 per-type methods (`SBox.getReg[T]` 99:19, `SContext.getVarFromInput[T]` 101:12, `SGroupElement.expUnsigned` 7:6).

## Method-handler registry (128 entries)

The `MethodCall` / `PropertyCall` dispatcher in `eval/method-call.ts` routes through a `(typeId, methodId)` → handler registry (80 individual `HANDLERS.set` calls + 48 loop-registered v6 numeric/UBI entries = 128). Per the compact-taxonomy decision, all defensive obj-kind throws reuse `'method-not-implemented'` (or `'context-obj-not-context'` for SContext handlers).

| # | Method | typeId:methodId | Cost | Pattern | Returns | Sigma-rust source |
|---|---|---|---|---|---|---|
| 1 | `SBox.tokens` | 99:8 | 15 | A | `Coll[(Coll[Byte], Long)]` | `eval/sbox.rs:72-79` |
| 2 | `SContext.dataInputs` | 101:1 | 15 | A | `Coll[Box]` from `ctx.dataInputs ?? []` | `eval/scontext.rs:17-31` |
| 3 | `SColl.indexOf` | 12:26 | `addPerItemCost(20, 10, 2, n)` | B | `Int` (index or -1; `from < 0` clamped to 0) | `eval/scoll.rs:21-50` |
| 4 | `SGlobal.groupGenerator` | 106:1 | 10 | A | `GroupElement` (33-byte SEC1 from `GROUP_GENERATOR_BYTES`) | `eval/sglobal.rs:32-41` |
| 5 | `SColl.zip` | 12:29 | `addPerItemCost(10, 1, 10, obj.length)` | B | `Coll[STuple[T1, T2]]` truncated to shorter; `n` = obj length, NOT `min(obj, arg)` | `eval/scoll.rs:138-169` |
| 6 | `SColl.indices` | 12:14 | `addPerItemCost(20, 2, 16, n)` | B | `Coll[Int]` = `[0, …, n-1]`; throws on `n > 2^31-1` | `eval/scoll.rs:171-193` |
| 7 | `SContext.preHeader` | 101:3 | 15 | A | `{kind:'PreHeader', value: ctx.preHeader}`; throws `'context-field-missing'` on undefined | `eval/scontext.rs:72-81` |
| 8 | `SPreHeader.timestamp` | 105:3 | 10 | A | `{kind:'Long', value: BigInt.asIntN(64, obj.value.timestamp)}` — signed i64 view of the u64 struct field (typed `SLong`; u64-max surfaces as Long(−1)); `hydratePreHeader` stores it losslessly | `eval/spreheader.rs:20-24` |
| 9 | `SAvlTree.digest` | 100:1 | 15 | A | `Coll[Byte]` | `eval/savltree.rs:28-34` |
| 10 | `SAvlTree.enabledOperations` | 100:2 | 15 | A | `Byte` | `eval/savltree.rs:36-40` |
| 11 | `SAvlTree.keyLength` | 100:3 | 15 | A | `Int` — i32 view `keyLength \| 0` (JVM `AvlTreeData.scala:84` `getUInt().toInt`; wire [2^31,2^32) wraps negative; deserialize-only asymmetry) | `eval/savltree.rs:42-46` |
| 12 | `SAvlTree.valueLengthOpt` | 100:4 | 15 | A | `Option[Int]` — same i32 view on the Some payload (`valueLengthOpt \| 0`; JVM `AvlTreeData.scala:85`) | `eval/savltree.rs:48-57` |
| 13 | `SAvlTree.isInsertAllowed` | 100:5 | 15 | A | `Boolean` | `eval/savltree.rs:59-63` |
| 14 | `SAvlTree.isUpdateAllowed` | 100:6 | 15 | A | `Boolean` | `eval/savltree.rs:65-69` |
| 15 | `SAvlTree.isRemoveAllowed` | 100:7 | 15 | A | `Boolean` | `eval/savltree.rs:71-75` |
| 16 | `SAvlTree.contains` | 100:9 | `createVerifier PerItem(110,20,64) on proof.length` + `LookupAvlTree PerItem(40,10,1) × 1` (raw treeHeight) | A | `Boolean` — construct-fail → `false` (never throws); per-op fail → `false`; digest NOT called | `eval/savltree.rs:339-381` |
| 17 | `SAvlTree.get` | 100:10 | `createVerifier PerItem(110,20,64)` + `LookupAvlTree PerItem(40,10,1) × 1` | A | `Option[Coll[Byte]]` — construct-fail throws (charged: cv+lookup); per-op fail throws; key-absent → `None` | `eval/savltree.rs:104-150` |
| 18 | `SAvlTree.getMany` | 100:11 | `createVerifier PerItem(110,20,64)` + `LookupAvlTree PerItem(40,10,1) × charged-lookups` | A | `Coll[Option[Coll[Byte]]]` — construct-fail with ≥1 key throws; zero-keys → empty Coll, no throw; per-key absence → per-key None | `eval/savltree.rs:152-212` |
| 19 | `SAvlTree.insert` | 100:12 | `isInsertAllowed Fixed(15)` → None if denied; `createVerifier PerItem(110,20,64)`; `InsertIntoAvlTree PerItem(40,10,1) × charged-ops` (`max(treeHeight,1)`); success: `updateDigest Fixed(40)` | A | `Option[AvlTree]` — denied → None; construct-fail: V<3 throws (≥1 op only), V3+ → None; per-op fail: V<3 throws, V3+ → None | `eval/savltree.rs:214-277` (V3 break `savltree.rs:259-266`) |
| 20 | `SAvlTree.update` | 100:13 | `isUpdateAllowed Fixed(15)` → None if denied; `createVerifier PerItem(110,20,64)`; `UpdateAvlTree PerItem(120,20,1) × charged-ops`; success: `updateDigest Fixed(40)` | A | `Option[AvlTree]` — denied → None; construct-fail → None (no version split); per-op fail → None | `eval/savltree.rs:383-439` (unconditional break `savltree.rs:420-429`) |
| 21 | `SAvlTree.remove` | 100:14 | `isRemoveAllowed Fixed(15)` → None if denied; `createVerifier PerItem(110,20,64)`; `RemoveAvlTree PerItem(100,15,1) × ops.length` ALWAYS (cfor, no break); `digest Fixed(15)` UNCONDITIONAL; success: `updateDigest Fixed(40)` | A | `Option[AvlTree]` — denied → None; construct-fail → None (never throws); per-op fail → None | `eval/savltree.rs:279-337` |
| 22 | `SHeader.id` | 104:1 | 10 | A | `Coll[Byte]` (32) | `eval/sheader.rs:22-26` |
| 23 | `SHeader.version` | 104:2 | 10 | A | `Byte` (u8→i8) | `eval/sheader.rs:16-20` |
| 24 | `SHeader.parentId` | 104:3 | 10 | A | `Coll[Byte]` (32) | `:28-32` |
| 25 | `SHeader.adProofsRoot` | 104:4 | 10 | A | `Coll[Byte]` (32) | `:34-38` |
| 26 | `SHeader.stateRoot` | 104:5 | 10 | A | `AvlTree` synthesized from the 33-byte stateRoot digest (flags `0b111`, keyLength 32, valueLengthOpt None) — JVM `CHeader.scala:29` `CAvlTree(avlTreeFromDigest(...))`; ergots LEADS sigma-rust (which returns Coll[Byte] and declares `SType::SAvlTree`, `sheader.rs:40-44`/`sheader.rs:127`) | `:40-44` (JVM canonical) |
| 27 | `SHeader.transactionsRoot` | 104:6 | 10 | A | `Coll[Byte]` (32) | `:46-50` |
| 28 | `SHeader.timestamp` | 104:7 | 10 | A | `Long` — signed i64 view via `BigInt.asIntN(64, header.timestamp)` (typed `SLong`; u64-max → Long(−1)); `Header.timestamp` is a u64 bigint | `:58-62` |
| 29 | `SHeader.nBits` | 104:8 | 10 | A | `Long` | `:64-68` |
| 30 | `SHeader.height` | 104:9 | 10 | A | `Int` | `:70-74` |
| 31 | `SHeader.extensionRoot` | 104:10 | 10 | A | `Coll[Byte]` (32) | `:52-56` |
| 32 | `SHeader.minerPk` | 104:11 | 10 | A | `GroupElement` (33) | `:76-80` |
| 33 | `SHeader.powOnetimePk` | 104:12 | 10 | A | `GroupElement` (33) = `powSolution.w`; v1 → parsed `w`, v2 → **generator** (JVM `ErgoHeader.scala:57-58` `wForV2 = dlogGroup.generator`); ergots LEADS sigma-rust (`EcPoint::default()` identity, `sheader.rs:82-86`) | `:82-86` (JVM canonical) |
| 34 | `SHeader.powNonce` | 104:13 | 10 | A | `Coll[Byte]` (8) | `:88-92` |
| 35 | `SHeader.powDistance` | 104:14 | 10 | A | `BigInt`; `0n` when null | `:94-107` |
| 36 | `SHeader.votes` | 104:15 | 10 | A | `Coll[Byte]` (3) | `:109-113` |
| 37 | `SContext.headers` | 101:2 | 15 | A | `Coll[Header]` from `ctx.headers`; throws `'context-field-missing'` if undefined | `eval/scontext.rs:58-70` |
| 38 | `SContext.lastBlockUtxoRootHash` | 101:9 | 15 | A | `AvlTree` from the independent `ctx.lastBlockUtxoRootHash` field (JVM `ErgoLikeContext.lastBlockUtxoRoot`); throws `'context-field-missing'` if absent. NOT derived from `ctx.headers[0].stateRoot` (that was sigma-rust `scontext.rs:83-99`) | `ErgoLikeContext` (JVM canonical) |
| 39 | `SHeader.checkPow` | 104:16 | 700 | A | `Boolean` — V3-gated; v1 header throws `'autolykos-v1-not-supported'` | `eval/sheader.rs:115-124` |
| 40 | `SAvlTree.updateOperations` | 100:8 | 45 | A | `AvlTree` — projects new `treeFlags`; pure (no `@ergots/avltree` call) | `eval/savltree.rs:77-88` |
| 41 | `SAvlTree.updateDigest` | 100:15 | 40 | A | `AvlTree` — projects new digest VERBATIM at any length (JVM `CAvlTree.scala:31-34` no-require) | `eval/savltree.rs:90-102` |
| 42 | `SAvlTree.insertOrUpdate` | 100:16 | `isUpdateAllowed Fixed(15)` THEN `isInsertAllowed Fixed(15)` (both ALWAYS, update first); `createVerifier PerItem(110,20,64)`; `UpdateAvlTree PerItem(120,20,1) × charged-ops`; success: `updateDigest Fixed(40)` | A | `Option[AvlTree]` — V3-gated; upsert (insert-absent/update-present); construct-fail → None (never throws); per-op fail → None; flags-deny → None | `eval/savltree.rs:441-498`; descriptor `savltree.rs:377-403` (`min_version: V3`) |
| 43 | `SGroupElement.getEncoded` | 7:2 | 250 | A | `Coll[Byte]` (33 SEC1-compressed; output canonical by the GE invariant) | `eval/sgroup_elem.rs:15-26` |
| 44 | `SColl.flatMap` | 12:15 | `addPerItemCost(60,10,8,n)` | B | `Coll[OV]` (lambda HOF + concat); body-restriction `'lambda-not-callable'` if body is MethodCall with non-empty args; two R3 lambda-static-typing divergences from sigma-rust (see footnote) | `eval/scoll.rs:52-136` |
| 45 | `SContext.minerPubKey` | 101:10 | 20 | A | `Coll[Byte]` (33 SEC1-compressed `ctx.preHeader.minerPk`); throws `'context-field-missing'` if undefined | `eval/scontext.rs:101-115` |
| 46 | `SPreHeader.minerPk` | 105:6 | 10 | A | `GroupElement` (raw 33-byte `obj.value.minerPk`; NOT sigma-serialized — contrast row 45) | `eval/spreheader.rs:38-42` |
| 47 | `SContext.selfBoxIndex` | 101:8 | 20 | A | `Int` — 0-based index of `ctx.selfBox` in `ctx.inputs` via reference equality; gated by `activated_script_version = saturating_sub(preHeader.version, 1)` — pre-V2 blocks return -1 (JVM bug #603 compat, BLOCK-level not tree-level, memory `feedback-tree-version-gate`). Throws `'context-field-missing'` for missing preHeader/selfBox/inputs on V2+ or selfBox-not-in-inputs. First exercised at mainnet h=342,964 | `eval/scontext.rs:33-57` |
| 48 | `SPreHeader.parentId` | 105:2 | 10 | A | `Coll[Byte]` (32-byte `obj.value.parentId`, sign-extended per byte; contrast row 46) | `eval/spreheader.rs:14-18` |
| 49 | `SPreHeader.height` | 105:5 | 10 | A | `Int` (`obj.value.height`, JS number passthrough — sigma-rust `as i32`) | `eval/spreheader.rs:32-36` |
| 50 | `SGroupElement.negate` | 7:5 | 45 | A | `GroupElement` (additive inverse `−P`; flips SEC1 parity prefix; identity → identity) | `eval/sgroup_elem.rs` (ergo-node-integration) |
| 51 | `SColl.updated` | 12:20 | `addPerItemCost(20, 1, 10, n)` | B | `Coll[T]` (copy, index `i`→`v`); OOB → `'coll-update-index-out-of-range'` | `eval/scoll.rs` (ergo-node-integration) |
| 52 | `SColl.updateMany` | 12:21 | `addPerItemCost(20, 2, 10, n)` | B | `Coll[T]` (each `idx[k]`→`val[k]`, last-write-wins); len-mismatch → `'coll-update-many-length-mismatch'`, OOB → `'coll-update-index-out-of-range'`. **perChunkCost is 2** per canonical JVM `methods.scala:1055` (the stale vendored `integration/ergots` checkout reads 1; cost sourced from the JVM + the n=14 conformance vector). Input/values elem-type-mismatch check OMITTED — unreachable for type-checked trees and a strict `SType` compare would false-positive against `SAny`-typed colls | `eval/scoll.rs` (ergo-node-integration) |
| 53 | `SColl.patch` | 12:19 | `addPerItemCost(30, 2, 10, n)` | B | `Coll[T]` = `input[0,from)` ++ `patch` ++ `input[from+replaced,)` (`from`/`replaced` each independently clamped ≥0) | `eval/scoll.rs:195-236` PATCH_EVAL_FN |
| 54 | `SOption.map` | 36:7 | 20 (+ `ADD_TO_ENV_COST(5)` per lambda invocation on the Some path) | A | `Option[OV]` — lambda HOF: `Some(t)`→`Some(f t)`, `None`→`None` | `eval/soption.rs:13-60` map_eval |
| 55–94 | numeric methods `X.{toBytes,toBits,bitwiseInverse,bitwiseOr,bitwiseAnd,bitwiseXor,shiftLeft,shiftRight}` for X ∈ {Byte 2, Short 3, Int 4, Long 5, BigInt 6} | typeIds 2–6, methodIds 6–13 | 5 | A | per receiver kind | JVM `SNumericTypeMethods`; see footnote |
| 95–102 | `UnsignedBigInt.{toBytes,toBits,bitwiseInverse,bitwiseOr,bitwiseAnd,bitwiseXor,shiftLeft,shiftRight}` | typeId 9, methodIds 6–13 | 5 | A | `UnsignedBigInt` / `Coll[Byte]` / `Coll[Boolean]` | JVM `methods.scala:309-459`; see footnote |
| 103 | `BigInt.toUnsigned` | 6:14 | 5 | A | `UnsignedBigInt` — negative receiver → `'unsigned-bigint-out-of-range'`; wrong-kind → `'numeric-method-bad-operand'` | JVM `methods.scala:543-549, 559-565` |
| 104 | `UnsignedBigInt.toSigned` | 9:19 | 10 | A | `SBigInt` — receiver `≥ 2^255` → `'bigint-result-out-of-range'`; wrong-kind → `'numeric-method-bad-operand'` | JVM `methods.scala:607-611`, `Extensions.scala:219-223` |
| 105 | `UnsignedBigInt.plusMod` | 9:15 | 30 | A | `UnsignedBigInt` — `(a + that) mod m`; `m == 0` → `'arith-divide-by-zero'` | JVM `methods.scala:551-623`, `CUnsignedBigInt.scala:47-77` |
| 106 | `UnsignedBigInt.subtractMod` | 9:16 | 30 | A | `UnsignedBigInt` — `(a − that) mod m` (Euclidean `umod`) | JVM `methods.scala:551`, `CUnsignedBigInt.scala:47` |
| 107 | `UnsignedBigInt.multiplyMod` | 9:17 | 40 | A | `UnsignedBigInt` — `(a · that) mod m` | JVM `methods.scala:551`, `CUnsignedBigInt.scala:47` |
| 108 | `UnsignedBigInt.mod` | 9:18 | 20 | A | `UnsignedBigInt` — `a mod m` | JVM `methods.scala:551`, `CUnsignedBigInt.scala:47` |
| 109 | `BigInt.toUnsignedMod` | 6:15 | 15 | A | `UnsignedBigInt` — `aSigned mod m` → UBI (receiver may be `< 0`) | JVM `methods.scala:551`, `CBigInt.scala:77-79` |
| 110 | `UnsignedBigInt.modInverse` | 9:14 | 150 | A | `UnsignedBigInt` — `b ∈ [0, m)` with `a·b ≡ 1 (mod m)`; `gcd ≠ 1` → `'unsigned-bigint-not-invertible'` | JVM `methods.scala:574-576`, `CUnsignedBigInt.scala:57-59`, oracle `BasicOpsSpecification.scala:590-628` |
| 111 | `SColl.reverse` | 12:30 | `addPerItemCost(20,2,100,n)` | B | `Coll[IV]` (generic, via the type-var substitution engine); reverses items, preserves elem type; empty → empty — V3-gated | JVM `methods.scala:1211-1216, 1221-1227`; `transformers.scala:74-75` |
| 112 | `SColl.startsWith` | 12:31 | `addPerItemCost(10,1,10,n)` on receiver length | B | `Boolean` (closed) — element comparison via cost-free `sValueStructuralEq` (NOT costed `sValueEquals`) — V3-gated | JVM `methods.scala:1102-1103` (Zip_CostKind) |
| 113 | `SColl.endsWith` | 12:32 | `addPerItemCost(10,1,10,n)` on receiver length | B | `Boolean` (closed) — same cost + element-comparison as `startsWith`; suffix alignment — V3-gated | JVM `methods.scala:1102-1103` |
| 114 | `SColl.get` | 12:33 | `FixedCost(30)` | A | `Option[IV]` (generic, via the type-var substitution engine); `0 ≤ i < len ? Some : None` — negative/OOB → None, never throw — V3-gated | JVM `ByIndex.costKind`; `transformers.scala:285` |
| 115 | `SGlobal.some` | 106:9 | `FixedCost(5)` | A | `Option[T]` (generic, via the type-var substitution engine); wraps `args[0]`; `elem` from `explicitTypeArgs['T']`; guards arity 1; MethodCall opcode — V3-gated | JVM `methods.scala:1986-1992` |
| 116 | `SGlobal.none` | 106:10 | `FixedCost(5)` | A | `Option[T]` (generic, via the type-var substitution engine); `None`; `elem` from `explicitTypeArgs['T']`; guards arity 0; PropertyCall opcode — V3-gated | JVM `methods.scala:1994-1999` |
| 117 | `SGlobal.serialize` | 106:3 | DynamicCost via `serializeCost` (see Eval-arm cost reference) | A | `Coll[Byte]` (closed; T derived from runtime value kind, NOT `exprTpe`); MethodCall opcode; NO wire type arg — V3-gated. **Residual (adversarial-only):** `serialize`/`deserializeTo[Header]` of a hand-crafted V1 header with `powDistance=0` produces `@ergots/scorex`-shaped bytes diverging from the JVM (sigma-rust-vs-JVM Autolykos-V1 d=0 fork); real V1 headers have d≠0, V1 unreachable via `Context.headers` on a V3+ chain; the COST is JVM-faithful regardless | JVM `methods.scala:1957` |
| 118 | `SGlobal.deserializeTo[T]` | 106:4 | `PerItemCost(100, 32, 32)` on input byte length | A | generic `T` (from `explicitTypeArgs['T']` via the type-var substitution engine); parses `args[0]` as an SValue of `T` (`DataSerializer.deserialize` — NO ErgoTree body parse, NO `exprTpe` match); trailing bytes ignored; `MaxTreeDepth(110)` data-driven via the shared reader-level counter; MethodCall opcode — V3-gated | JVM `methods.scala:1906` |
| 119 | `SGlobal.fromBigEndianBytes[T]` | 106:5 | `FixedCost(10)` | A | generic `T` (from `explicitTypeArgs['T']` via the type-var substitution engine); decodes BE bytes — per-type exact/max-length validation; signed two's-complement for Byte..BigInt, unsigned magnitude for UBI; `FixedCost(10)` before validation; MethodCall opcode — V3-gated | JVM `methods.scala:1925`, `CSigmaDslBuilder.scala:225-261` |
| 120 | `SGlobal.encodeNbits` | 106:6 | `FixedCost(25)` | A | `(SGlobal, SBigInt) → SLong` (closed); `encodeCompactBits` (port of JVM `NBitsUtils.encodeCompactBits`); no reject path for valid ≤256-bit input; MethodCall opcode; NO wire type arg — V3-gated | JVM `methods.scala:1939`, `CSigmaDslBuilder.scala:190-194` |
| 121 | `SGlobal.decodeNbits` | 106:7 | `FixedCost(50)` | A | `(SGlobal, SLong) → SBigInt` (closed); `@ergots/scorex` `decodeCompactBits` (low-32-bit truncation); signed-256 range-check post-decode → `'global-decode-nbits-failed'`; MethodCall opcode; NO wire type arg — V3-gated | JVM `methods.scala:1944`, `CSigmaDslBuilder.scala:195-197` |
| 122 | `SGlobal.powHit` | 106:8 | `PowHitCostKind`: `500 + (k+1) * (floor((msg.len+nonce.len+h.len)/128) + 1) * 7` (charged from raw `k` BEFORE guards) | A | `(SGlobal, Int, Coll[Byte], Coll[Byte], Coll[Byte], Int) → SUnsignedBigInt` (closed); `@ergots/scorex` `autolykosHitForMessageWithChecks`; k<2/k>32/N<16 → `'pow-hit-invalid-params'`; MethodCall opcode; NO wire type arg — V3-gated | JVM `methods.scala:1884-1900`, `CostKind.scala:71-88`, `Autolykos2PowValidation.scala:115-137` |
| 123 | `SBox.getReg[T]` | 99:19 | `FixedCost(50)` (= `ExtractRegisterAs.costKind`) | A | `Option[T]` with explicit type arg `T`; `i < 0`/`i > 9` → None; absent → None; defined + match → `Some`; defined + mismatch → `'register-type-mismatch'` (`CBox.scala:41`); reuses `getRegisterEntry` (R0–R3 synthesis) — V3-gated. NOTE: id 7 (`getRegV5`) stays unregistered — deserializes at every version but eval-throws `'method-not-implemented'` (JVM reflection miss, `SigmaDsl.scala:490`) | JVM `CBox.scala:32-44`, `methods.scala:1338-1347` |
| 124 | `SContext.getVarFromInput[T]` | 101:12 | `FixedCost(10)` (= `GetVar.costKind`) | A | `Option[T]` with explicit type arg `T`; **total, never throws** — `inputIdx` (Short) OOB/absent, varId missing, or type mismatch → ALL None (`CContext.scala:77` `case _ => None`); reads `ctx.inputExtensions[inputIdx].values[varId]` (var-id byte-identity `& 0xff`); absent `inputExtensions` ⇒ every lookup None — V3-gated. The three-way mismatch asymmetry (getVar throws / getReg throws / getVarFromInput → None) is deliberate JVM behavior, pinned by tests | JVM `CContext.scala:76-83`, `methods.scala:1755-1765` |
| 125 | `SGroupElement.expUnsigned` | 7:6 | `FixedCost(900)` (= `Exponentiate.costKind`) | A | `GroupElement`; shares `expPoint(baseBytes, k)` with the v5 `Exponentiate` arm (`decodePoint` → identity-base guard → `pointMul` UBI scalar ∈ [0, 2^256) reduced mod n → `encodePoint`); monomorphic, zero wire change — V3-gated | JVM `CGroupElement.scala:22-26`, `methods.scala:656-660`, `trees.scala:1042-1046` |
| 126 | `SPreHeader.version` | 105:1 | 10 | A | `Byte` (`obj.value.version`) — no version gate | JVM `methods.scala:1841` |
| 127 | `SPreHeader.nBits` | 105:4 | 10 | A | `Long` (`BigInt(obj.value.nBits)`; struct field u32, accessor typed `SLong`) — no version gate | JVM `methods.scala:1844` |
| 128 | `SPreHeader.votes` | 105:7 | 10 | A | `Coll[Byte]` (3-byte `obj.value.votes`) — no version gate | JVM `methods.scala:1847` |

**Footnotes.**

- **Rows 55–94 (v6 numeric methods)** — 40 entries across 5 numeric types × 8 method ids (6–13), `FixedCost(5)` Pattern A, loop-registered in `eval/method-call.ts` from `eval/_numeric-v6.ts` (`numericV6Handlers`). The bitwise/shift methods (ids 8–13) have `tRange = tNum` (type-variable return resolved by the type-var substitution engine, `mir/method-signatures.ts:numericV6Signatures`); `toBytes`/`toBits` (ids 6–7) have closed `tRange` (`Coll[SByte]` / `Coll[SBoolean]`). `BigInt.shiftLeft` result range-checks to i256 → `'bigint-result-out-of-range'`; shift bits outside `[0,width)` → `'numeric-shift-out-of-range'`.
- **Rows 95–102 (v6 UnsignedBigInt methods)** — 8 entries at typeId 9, same loop, `FixedCost(5)` Pattern A (`eval/_numeric-v6.ts` `ubiDesc`). Three differences from the `BigInt` group: unsigned-magnitude codec for `toBytes`/`toBits` (`0 → []`, `2^256−1 → 32×0xFF`; `toBits` expands the BE bytes per `ExactNumeric.scala:44-58`); 256-bit fixed flip for `bitwiseInverse` (`UBI_MAX − x`, not `~x`); a magnitude guard on `shiftLeft` (result `≥ 2^256` → `'unsigned-bigint-out-of-range'`).
- **AVL Tier-2 cost model (rows 16–21 + 42)** — implements the JVM cost model (`CErgoTreeEvaluator.scala:67-254`, `CostKind.scala:24-32`; sources `methods.scala:1391-1516`). Shared components: createVerifier `PerItem(110,20,64)` on `proof.length`; LookupAvlTree `PerItem(40,10,1)` on raw `treeHeight` (`digest[32]`, scorex `rootNodeHeight = startingDigest.last & 0xff`); InsertIntoAvlTree `PerItem(40,10,1)` and UpdateAvlTree `PerItem(120,20,1)` and RemoveAvlTree `PerItem(100,15,1)` on `max(treeHeight,1)`; flag-check `Fixed(15)` per flag; `digest Fixed(15)` unconditional in remove; `updateDigest Fixed(40)` on success only. All Pattern A. Charged-op arithmetic: full success → ops.length; construct-fail → `min(1, ops.length)`; per-op fail → opsCompleted+1; remove uses ops.length ALWAYS.
- **Row 44 (flatMap) — two TS-from-sigma-rust lambda-static-typing divergences (both inherited, both load-bearing):** (R3a) the elem-type check `sTypeEquals(input.elem, lambdaArgTpe)` runs only when `mc.args[0]` is an inline `FuncValue` MIR node (the runtime `Closure` SValue has no `argTpes` for this purpose), mirroring `coll-map.ts:94-108`; sigma-rust always runs it via the runtime lambda. (R3b) `exprTpe(closure.body)` returns the body's resolved static type via the method-return-type resolver — for a closed-`tRange` or type-var-resolvable PropertyCall/MethodCall body the empty-input output elem is concrete (matching sigma-rust/JVM); an unresolvable body still falls back to `Coll[SAny]`, refined from the first iter's `elem` on non-empty input. The same SMethod-resolution path also feeds MapColl/Filter/Fold/Exists/ForAll static-typing accuracy.

## Coverage and stability

**68 of 68 implementable `Expr` variants** have arms. 21 variants in sigma-rust's `OpCode` enum are reserved-but-never-dispatched and parse-reject via `ExprParseError 'opcode-reserved'` (FlatMap, TrivialPropFalse, TrivialPropTrue among them — the JVM rejects all three via `CheckValidOpCode`; their non-bare forms reach us elsewhere: flatMap as an `SColl` method-call, the TrivialProp pair as a SigmaBoolean leaf in a `SigmaPropConstant`). `FunDef` (`0xd7`) is NOT reserved — it parses and evaluates as a `ValDef` carrying `tpeArgs`. The implementable variants:

- Const, ConstPlaceholder, BlockValue, ValDef, ValUse, Tuple, Collection, If
- BinOp, LogicalNot, BoolToSigmaProp
- Negation, BitInversion, Upcast, Downcast
- And, Or, XorOf
- FuncValue, Apply
- ExtractAmount, ExtractScriptBytes, ExtractRegisterAs, ExtractCreationInfo, ExtractBytes, ExtractBytesWithNoRef, ExtractId
- GlobalVars, GetVar, OptionGet, OptionIsDefined, OptionGetOrElse, SelectField
- SizeOf, Append, ByIndex, Slice, MapColl, Filter, Fold, Exists, ForAll
- CreateProveDlog, CreateProveDhTuple
- Atleast, SigmaAnd, SigmaOr
- Context, SigmaPropBytes, MethodCall, PropertyCall, Global
- CalcBlake2b256, CalcSha256, ByteArrayToLong, LongToByteArray, ByteArrayToBigInt, Xor, DecodePoint, SubstConstants
- SigmaPropIsProven, MultiplyGroup, Exponentiate — plus `CreateAvlTree` and `TreeLookup`, which PARSE but reject unconditionally at eval (`'unsupported-eval-node'`; no JVM eval override)
- DeserializeContext, DeserializeRegister
- `LastBlockUtxoRootHash` — the bare `0xa6` op-form (JVM-only case object)

Everything else throws `'not-implemented-yet'`. Real-world ErgoTree trees from the `mainnet_boxes` corpus are filtered against this coverage by `test/corpus-eval.test.ts`; only fixtures whose body uses exclusively supported variants are exercised against the reference oracle for value + cost equality. Costs and values are validated against the full mainnet chain (genesis→tip vs `sigma-rust`) and a JVM `sigma-state`-blessed conformance suite, both with zero unresolved divergences.

**`@noble/curves@2.2.0`** is version-locked with `@noble/hashes@2.2.0`; used by the secp256k1 adapter (`crypto/secp256k1.ts`) and the sigma verifier ([`facts/ergoscript-sigma.md`](./ergoscript-sigma.md)).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting guarantees
- [`facts/ergoscript-wire.md`](./ergoscript-wire.md) — wire format (parseTree, serializeTree, ErgoTreeParseError/SerializeError)
- [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) — sigma-protocol verifier (`SigmaBoolean`, `verifySignature`, `VerifyError`)
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (phase plan, risks, validation strategy)
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` — method-call dispatcher design
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — method-handler design
- `docs/specs/2026-05-20-ergoscript-phase-2i-a-pure-bytes-predefs-design.md` — pure-bytes predef arms design
