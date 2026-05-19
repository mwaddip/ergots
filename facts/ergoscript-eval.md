# `@ergots/ergoscript` — Evaluator Surface Contract

This file documents the **evaluator slice** of the `@ergots/ergoscript` boundary contract (phases 2b through 2g.6). It is also the canonical home for the `SValue` / `SType` / `Expr` discriminated unions, which are produced by the wire layer (see [`facts/ergoscript-wire.md`](./ergoscript-wire.md)) and consumed across the package.

For cross-cutting guarantees (browser-compat, determinism, etc.) see [`facts/ergoscript.md`](./ergoscript.md). For the sigma-protocol verifier (which consumes `SValue.SigmaProp` produced by this layer) see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md).

## Scope (per-phase changelog)

**Phase 2b — evaluator chassis + 8 arms** (v0.2.0):

- Public evaluator entry points: `evaluate(tree, opts?)`, `evaluateWith(tree, ctx)`, `makeContext(opts?)`.
- `EvalContext` carrying a saturating `jitCost` accumulator with optional `jitCostLimit` enforcement. Cost values are sigma-rust-accurate per arm from day one (not no-op placeholders).
- Immutable `Env` for `ValDef` bindings (clone-on-extend; lexical scoping naturally correct under TS).
- Central exhaustive `evalExpr` switch on `Expr.tag` with `_exhaust: never` discriminant; adding a new `Expr` variant becomes a compile-time error until a corresponding arm exists.
- 8 per-variant arms wired: `Const`, `ConstPlaceholder`, `BlockValue` (with `ADD_TO_ENV_COST` per `ValDef`), `ValDef` (top-level rejection), `ValUse`, `Tuple`, `Collection` (both `Exprs` and `BoolConstants` kinds), `If` (with short-circuit semantics + cost-correct branch skipping).
- Layer C1 per-arm fixture validation: every arm's behavior (value + cost) is asserted against sigma-rust's `try_eval_out` oracle.

**Phase 2c — operators slice 1** (additive, v0.2.0):

- 3 more arms wired: `BinOp` (central dispatcher delegating on `e.op.kind` to 4 per-family sub-arms), `LogicalNot`, `BoolToSigmaProp`.
- All 22 `BinOp` sub-ops implemented across 4 families: **Arith** (7: Plus, Minus, Multiply, Divide, Modulo, Max, Min; checks bounds per kind; throws `'arith-overflow'` on bounds violation, `'arith-divide-by-zero'` for `/0` and `%0`); **Relation** (6: Lt, Le, Gt, Ge, Eq, NEq); **Logical** (3: And, Or short-circuit on Boolean operands — right-side cost NOT charged when short-circuited — and eager Xor); **Bit** (3 of 6: BitAnd, BitOr, BitXor with kind-uniform bigint masking + sign-preserving re-narrowing; the 3 shift ops throw `'not-implemented-yet'` — sigma-rust delegates them to `SNumericTypeMethods` not the BinOp arm).
- `sValueEquals` recursive structural comparer covering primitives, `GroupElement` (byte-equal), `SigmaProp` (byte-equal on opaque `.raw`), `Coll`, `Tuple`, `Option`. Cross-kind comparison returns `false` (no coercion). `Box` / `AvlTree` throw `'not-implemented-yet'`. Cost charged per sigma-rust's `data_value_comparer.rs` constants.
- 5 new `EvalError` codes: `'arith-overflow'`, `'arith-divide-by-zero'`, `'bin-op-kind-mismatch'`, `'bin-op-not-numeric'`, `'bin-op-not-boolean'`.

**Phase 2d-A — numeric-poly unary arms** (additive):

- 4 more arms wired: `Negation` (numeric negate; overflow throws `'arith-overflow'`), `BitInversion` (bitwise complement; no overflow), `Upcast` (widen to target numeric kind read from `e.tpe`; no overflow), `Downcast` (narrow to target numeric kind; overflow throws `'downcast-overflow'`).
- One new `EvalError` code: `'downcast-overflow'` (distinct from `'arith-overflow'` so callers can dispatch on "narrowing specifically failed"). Non-numeric input reuses `'bin-op-not-numeric'`.
- Step-1 refactor: `checkRange` + `maskToKind` promoted from `bin-op/{arith,bit}.ts` to `bin-op/_numeric.ts`. `checkRange` gains a third parameter (error code string).

**Phase 2d-B — Coll[Boolean] aggregator arms** (additive):

- 2 more arms wired: `And` (all-true; empty Coll returns `true`) and `Or` (any-true; empty Coll returns `false`). Both charge cost AFTER eval-child via `addPerItemCost`; cost values differ per arm (And: `(10, 5, 32, n)`; Or: `(5, 5, 64, n)`).
- One new `EvalError` code: `'coll-not-boolean'`. Reused by both arms for defensive kind-check.

**Phase 2e — lambdas + treeVersion + XorOf + V3 revisit** (additive):

- 3 more arms wired: `FuncValue` (constructs Lambda SValue; Fixed(5) cost; lazy body), `Apply` (invokes Lambda; Fixed(30) cost; immutable env extend; arity check), `XorOf` (Coll[Boolean] XOR aggregator with V0/V1-vs-V2+ semantics drift; reuses `'coll-not-boolean'`).
- `EvalOpts` gains one optional field: `treeVersion?: number`. `evaluate(tree, opts)` auto-derives from `tree.header.version`. `evaluateWith(tree, ctx)` requires explicit setting. Arms reading `ctx.treeVersion` default to V0 (most-restrictive) on undefined.
- Three new `EvalError` codes: `'tree-version-too-low'` (Upcast/Downcast V3 gating), `'apply-non-lambda'`, `'apply-arity-mismatch'`.
- Behavior change on existing arms: Upcast (BigInt → BigInt no-op) and Downcast (any branch with BigInt source) now throw `'tree-version-too-low'` at `ctx.treeVersion < 3`, matching sigma-rust upstream.

**Phase 2f Stop α — SBox + 2 Box-extract arms** (additive):

- 2 more arms wired: `ExtractAmount` (Box → Long; Fixed(8) cost BEFORE eval-child) and `ExtractScriptBytes` (Box → Coll[Byte] of box's serialized ErgoTree; Fixed(10) cost BEFORE eval-child).
- One new `EvalError` code: `'extract-input-not-box'` (defensive kind-check shared across all 7 Box-extract arms).

**Phase 2f Stop β — 2 structural Box-extract arms** (additive):

- 2 more arms wired: `ExtractRegisterAs` (Box → Option[T] with R0..R9 dispatch; Fixed(50) cost BEFORE eval-child; type-assertion against `e.elemTpe` THROWS on mismatch — matches sigma-rust `extract_reg_as.rs:41-44`, NOT None) and `ExtractCreationInfo` (Box → Tuple[Int, Coll[Byte] (34 bytes: txId ++ BE u16 index)]; Fixed(16) cost BEFORE eval-child).
- Two new `EvalError` codes: `'register-id-out-of-range'` (registerId outside 0..=9) and `'register-type-mismatch'` (stored register's `tpe` ≠ `e.elemTpe`).
- Internal refactor: Promotes the R3-synthesis helper `creationInfoTupleSValue(box)` to a new shared module `packages/ergoscript/src/eval/_box-synthesis.ts`.

**Phase 2f Stop γ — Box canonical-bytes serializer + 3 hash extractors** (additive):

- 3 more arms wired: `ExtractBytes` (Box → Coll[Byte] of full canonical bytes; Fixed(12) cost BEFORE eval-child), `ExtractBytesWithNoRef` (Box → Coll[Byte] WITHOUT tx_id + index; Fixed(12) cost), `ExtractId` (Box → 32-byte blake2b-256 hash of canonical bytes; Fixed(12) cost). All Pattern A.
- No new `EvalError` codes — all 3 reuse `'extract-input-not-box'` from Stop α.

**Phase 2f medium — chain-state Context + 6 arms** (additive):

- 6 more arms wired: `GlobalVars` (Height / Inputs / Outputs / SelfBox / MinerPubKey / GroupGenerator; Fixed(10) cost; reads optional chain-state from `EvalContext`), `GetVar` (Fixed(10); reads `ctx.extension.values[varId]`; throws `'get-var-type-mismatch'` when stored type ≠ requested type), `OptionGet` (Fixed(15); throws `'option-empty'` on None), `OptionIsDefined` (Fixed(10); returns Boolean), `OptionGetOrElse` (Fixed(15); V3-gated lazy semantics), `SelectField` (Fixed(10); 1-based fieldIndex → 0-based array access on `Tuple`).
- `EvalOpts` / `EvalContext` gains 6 new optional chain-state fields: `height?`, `selfBox?`, `inputs?`, `outputs?`, `preHeader?`, `extension?`.
- Two new runtime stubs stabilized: `PreHeader` and `ContextExtension`.
- Six new `EvalError` codes: `'context-field-missing'`, `'get-var-type-mismatch'`, `'option-empty'`, `'option-input-not-option'`, `'select-field-index-out-of-range'`, `'select-field-input-not-tuple'`.

**Phase 2f Coll HOFs — 9 collection arms** (additive):

- 9 more arms wired: `SizeOf` (Fixed(14) Pattern A), `Append` (`addPerItemCost(20, 2, 128, result.length)` Pattern A), `ByIndex` (Fixed(30) Pattern A), `Slice` (`addPerItemCost(10, 2, 128, result.length)` Pattern A), `MapColl` / `Filter` / `Fold` / `Exists` / `ForAll` (Mixed: outer `addPerItemCost(20, 2, 128, input.length)` Pattern A + per-iter Fixed(1) Pattern B).
- Cost-charging patterns clarified: **Pattern A** (envelope-first, outer cost BEFORE eval-children); **Pattern B** (per-iteration, AFTER each loop iteration); **Mixed** (both coexisting, used by all 5 lambda HOFs).
- 7 new `EvalError` codes: `'coll-input-not-coll'`, `'coll-elem-tpe-mismatch'`, `'coll-by-index-out-of-range'`, `'coll-by-index-index-not-int'`, `'coll-slice-bound-not-int'`, `'lambda-not-callable'`, `'lambda-result-type-mismatch'`.
- Port-level discrepancy: sigma-rust's Filter/Exists/ForAll MIR structs carry an `elemTpe` field; the TS MIR structs do NOT — the evaluator derives the declared element type from `condition.args[0].tpe`.
- Layer C3.a (mutation testing) for the 9 HOF arms at ≥ 90% kill rate per arm.

**Phase 2g.5 — method-call dispatch + C2 corpus unlocker** (additive):

- 4 more arms wired: `Context` (returns `Value::Context` sentinel; cost 1 Pattern A), `SigmaPropBytes` (cost `addPerItemCost(35, 6, 1, 1)` Pattern A; returns `Coll[Byte]`; throws `'sigma-prop-bytes-input-not-sigma-prop'` on non-SigmaProp input), `MethodCall` (dispatcher; cost 4 Pattern A; routes via `(typeId, methodId)` registry in `eval/method-call.ts`), `PropertyCall` (same dispatcher shape with empty args; cost 4 Pattern A).
- 1 new `SValue` kind variant: `{ kind: 'Context' }`. Mirrors sigma-rust's `Value::Context`.
- `EvalOpts` / `EvalContext` gains 1 new optional field: `dataInputs?: ErgoBox[]`.
- 3 handlers registered in the method-call registry: `SBox.tokens`, `SContext.dataInputs`, `SColl.indexOf` (see Method-handler registry section).
- 3 new `EvalError` codes: `'sigma-prop-bytes-input-not-sigma-prop'`, `'method-not-implemented'`, `'context-obj-not-context'`. Total 40 → 43 codes.
- C2 corpus unlocked at `success=18/18` (all 18 evaluable mainnet trees now evaluate cleanly under synthetic-context stubs).

**Phase 2g.6 — broader method-call surface** (additive):

- 1 new arm wired: `Global` (Pattern A `ctx.addCost(5)` BEFORE returning `{ kind: 'Global' }` sentinel). Coverage 51 → 52.
- 2 new `SValue` variants: `{ kind: 'Global' }` (sentinel) and `{ kind: 'PreHeader'; value: PreHeader }` (value carrier).
- 5 new method handlers in registry (3 → 8 total): `SGlobal.groupGenerator`, `SColl.zip`, `SColl.indices`, `SContext.preHeader`, `SPreHeader.timestamp` (see Method-handler registry section).
- Zero new `EvalError` codes — all 5 handlers reuse existing `'method-not-implemented'`, `'context-obj-not-context'`, `'context-field-missing'`. Total remains 43.

**Coverage after 2g.6 complete: 52 of ~70 `Expr` variants have implemented arms.** Method-call handler registry: 8 entries. SValue variants: include `Global` + `PreHeader` post-2g.6. **Phase 2g.6 COMPLETE.** See `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md`.

**Phase 2h-b — `@ergots/avltree` integration** (additive):

- 13 new method handlers wired (8 → 21 registry entries):
  - **Tier 1 — 7 accessors** (Pattern A cost 15 each): `digest` (100:1), `enabledOperations` (100:2), `keyLength` (100:3), `valueLengthOpt` (100:4), `isInsertAllowed` (100:5), `isUpdateAllowed` (100:6), `isRemoveAllowed` (100:7). Pure projection over `AvlTreeData` runtime fields; no `@ergots/avltree` call.
  - **Tier 2 — 6 verification ops** (zero per-handler cost): `contains` (100:9), `get` (100:10), `getMany` (100:11), `insert` (100:12), `update` (100:13), `remove` (100:14). Call into `@ergots/avltree` v0.2.0's `verifyAvlBatch` / `verifyAvlBatchPartial`.
- `AvlTreeData` runtime shape promoted from phase-2a forward-declaration to stable: `{ digest: Uint8Array(33), treeFlags: u8, keyLength: u32, valueLengthOpt: u32 | null }`.
- `_avltree-adapter.ts` added: 10 pure helpers bridging `AvlTreeData` → `@ergots/avltree`'s API (`avlTreeDataToConfig`, `buildLookupOps`, `buildInsertOps`, `buildUpdateOps`, `buildRemoveOps`, `withUpdatedDigest`, `extractBytes`, `extractByteArrayList`, `extractEntries`, `buildSingleLookupOp`).
- 2 new `EvalError` codes: `'avl-tree-obj-not-avl-tree'` (defensive), `'avl-tree-proof-failed'` (verifier failure). 43 → 45 total.
- Source-read corrections during implementation:
  - `contains` DOES throw on verifier construct failure (only per-op fail returns `false`).
  - `update` has NO V<3/V3+ split — always graceful break (returns Option None on per-op fail).
  - V3+ partial-success on `insert`/`update` returns `Option None`, NOT `Some(AvlTree with partial digest)` — sigma-rust poisons `root = null` on failure, post-loop digest is None.
  - `remove` confirmed: no V3+ break path; per-op fail always throws.
- 47 fixture-driven tests (28 accessor + 19 verification op) + 7 throw-path tests + 21 mutation tests.

**Phase 2h-b COMPLETE.** Method handler registry: 21 entries. EvalError codes: 45. Test count: 2787 + 21 = 2808.

**Does NOT ship yet (deferred):**

- **`Xor`** (byte-array XOR) — phase 2i alongside other predefs.
- Header chain-state model (`Header` runtime + header-accessor methods) — phase 2h-c or later.
- Broader method-call surface beyond the 21 registered handlers: Header methods, `Coll.zipWith` / `.reverse` / `.flatten` / `.getOrElse`, `SNumericTypeMethods` Bit shifts, additional `SBox`/`SHeader`/`SPreHeader` methods, the 3 remaining `SAvlTree.*` methods (`updateOperations`/`updateDigest`/`insertOrUpdate`). Wait until phase 2i or corpus demand resurfaces.
- BinOp `Bit` shift ops via `SNumericTypeMethods` — when method-call dispatch surface expands.
- `Box` / `AvlTree` equality comparison (currently `'not-implemented-yet'` from `sValueEquals`) — when chain-state model fully lands.
- Real-context cost validation (Layer C3) — phase 2j calibration.

## Public surface (v0.2.0)

```ts
evaluate(tree: ErgoTree, opts?: EvalOpts): SValue
evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue
makeContext(opts?: EvalOpts): EvalContext

class EvalError extends Error { code: string }
```

`Env`, `evalExpr`, and the per-arm functions (`evalConst`, `evalIf`, `evalBlockValue`, …) are intentionally NOT exported — they are internal to the evaluator and may change without notice.

### `evaluate(tree, opts?)`

- **Precondition:** `tree` is a valid `ErgoTree` (typically returned by `parseTree`). `opts.constants`, when provided, must be parallel to whatever set of `ConstantPlaceholder` ids the tree's body references.
- **Postcondition (success):** Returns the `SValue` produced by evaluating `tree.body` under a freshly constructed `EvalContext`. The context is initialised with `constants: opts.constants ?? tree.constants` and `jitCostLimit: opts.jitCostLimit` (defaulting to `undefined` = unlimited).
- **Postcondition (failure):** Throws `EvalError` with one of the codes enumerated below. Errors raised inside the recursive evaluator bubble up unwrapped — `evaluate` does not catch and rewrap.
- **Coverage caveat:** 52 of ~70 `Expr` variants currently have implemented arms. Any tree whose body — or whose evaluation reaches — any other variant throws `EvalError 'not-implemented-yet'`. Phases 2h–2j add remaining arms; the `evaluate` signature itself is stable.

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
  // Chain-state fields (phase 2f medium + 2g.5):
  height?: number                // current block height
  selfBox?: ErgoBox              // spending box
  inputs?: ErgoBox[]             // transaction inputs
  outputs?: ErgoBox[]            // transaction outputs
  preHeader?: PreHeader          // pre-header of current block (also consumed by SContext.preHeader handler from 2g.6)
  extension?: ContextExtension   // context-extension key-value map
  dataInputs?: ErgoBox[]         // transaction data-inputs (phase 2g.5)
}

interface EvalContext extends EvalOpts {
  jitCost: number                                                  // mutable accumulator
  addCost(amount: number): void
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void
}
```

### `EvalContext.addCost(amount)`

- **Semantics:** Saturating add — `ctx.jitCost = Math.min(ctx.jitCost + amount, Number.MAX_SAFE_INTEGER)`. The clamp is a defensive guard; in practice the cost limit (if set) trips long before saturation matters.
- **Limit enforcement:** If `ctx.jitCostLimit !== undefined` and the new total exceeds it, throws `EvalError 'cost-limit-exceeded'`. The throw happens *after* the cost is added to `jitCost` — callers inspecting `jitCost` after a cost-limit failure see the over-limit total, not the pre-add value.
- **Mirror of:** sigma-rust `Context::add_jit_cost` (`ergotree-ir/src/chain/context.rs:77-86`).

### `EvalContext.addPerItemCost(base, perChunk, chunkSize, nItems)`

- **Semantics:** Composite charge — `addCost(base + ceil(nItems / chunkSize) * perChunk)`. Used by `BlockValue` envelope (`addPerItemCost(1, 1, 10, items.length)`) and by all 9 Coll HOF arms as their outer Pattern A charge.
- **Formula:** `totalCharge = base + Math.ceil(nItems / chunkSize) * perChunk`. When `nItems === 0`, `Math.ceil(0 / chunkSize) === 0`, so only `base` is charged.
- **Limit enforcement:** Inherits from `addCost`; the *total* composite charge is checked against `jitCostLimit` after addition (not split into base + per-chunk sub-checks).
- **Mirror of:** sigma-rust `Context::add_per_item_jit_cost` (`ergotree-ir/src/chain/context.rs:88-99`).

## Type invariants (canonical home for SValue / SType / Expr)

These hold on every `SValue` returned by the evaluator. Callers may rely on them without re-checking. The wire layer ([`facts/ergoscript-wire.md`](./ergoscript-wire.md)) produces these types from on-wire bytes.

```ts
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
  | { kind: 'SigmaProp'; value: SigmaBoolean }    // see facts/ergoscript-sigma.md for SigmaBoolean
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

- `constantTypes` (on `ErgoTree`) is parallel to `constants[]` and carries the per-constant `SType` recovered from the wire. It's necessary because a parsed `SValue` does not unambiguously encode its `SType` for some edge cases (empty `Coll`, `None` for `SOption`).
- `ErgoBox`, `AvlTreeData`, and `Closure` are forward-declared in phase 2a. Their shapes are stable; evaluator-only fields may be added in later phases.
- `PreHeader` (added phase 2f medium; wrapped in `SValue.PreHeader` variant in phase 2g.6): `{ version, parentId: Uint8Array(32), timestamp: bigint, nBits, height, minerPk: Uint8Array(33), votes: Uint8Array(3) }`.
- `ContextExtension` (added phase 2f medium): `{ values: Record<number, { tpe: SType; value: SValue }> }` — keyed by varId, same `{ tpe, value }` shape as `ErgoBox.registers`.

## `EvalError` taxonomy (45 codes)

`EvalError` carries a `code: string` distinct from the wire-layer error classes. Every code below is emitted by current source under the conditions noted.

### Phase 2b codes

- **`'not-implemented-yet'`** — central dispatch (`eval/eval.ts`) hit an `Expr` variant with no arm yet (~18 variants remaining after phase 2g.6). Message includes the offending `tag`.
- **`'cost-limit-exceeded'`** — `EvalContext.addCost` (and therefore `addPerItemCost`) detected `ctx.jitCost > ctx.jitCostLimit` after a charge. Only raised when the caller set `jitCostLimit` (default `undefined` skips the check).
- **`'val-def-outside-block'`** — the `ValDef` arm was reached at the top level (or as an arbitrary sub-expression). `ValDef` is only structurally valid as an item inside `BlockValue.items`.
- **`'val-use-unbound'`** — `ValUse(id)` referenced a `valId` with no binding in the current `Env`. Cost 5 is charged BEFORE the env lookup (mirrors sigma-rust).
- **`'const-placeholder-id-out-of-range'`** — `ConstPlaceholder(id)` referenced an `id >= ctx.constants.length`.
- **`'const-placeholder-no-constants'`** — `ConstPlaceholder` was reached but `ctx.constants` is `undefined`.
- **`'if-condition-not-boolean'`** — the `If` arm's `condition` evaluated to an `SValue` whose `kind !== 'Boolean'`.
- **`'collection-elem-kind-mismatch'`** — inside the `Collection` arm with `kind: 'Exprs'`, an evaluated item's `kind` did not match the declared `elemTpe` (defensive guard).
- **`'block-item-not-val-def'`** — inside the `BlockValue` arm, `items[i].tag !== 'ValDef'`.

### Phase 2c codes (BinOp / LogicalNot / BoolToSigmaProp)

- **`'arith-overflow'`** — `BinOp.Arith` computed a result outside the operand kind's signed range. Mirrors sigma-rust's checked arithmetic.
- **`'arith-divide-by-zero'`** — `BinOp.Arith.Divide` or `Modulo` with a right operand of zero. Checked before performing the operation.
- **`'bin-op-kind-mismatch'`** — operands of a BinOp that requires both operands to share the same kind (Arith, Bit, Relation-ordering) had different kinds. `Eq` and `NEq` do NOT throw this — they return `false` on kind mismatch.
- **`'bin-op-not-numeric'`** — operand kind not in `{Byte, Short, Int, Long, BigInt}` for an op requiring numeric operands.
- **`'bin-op-not-boolean'`** — operand kind not `Boolean` for an op requiring Boolean operands.

### Phase 2d-A code (numeric-poly unary arms)

- **`'downcast-overflow'`** — `Downcast` arm narrowed an input value outside the target kind's signed range. Surfaced as distinct code (separate from `'arith-overflow'`) so callers can dispatch on "downcast specifically failed" vs other arith overflows.

`Negation` reuses `'arith-overflow'` (`Negate(MIN_K)`). `BitInversion` and `Upcast` have no overflow paths. All four arms reuse `'bin-op-not-numeric'` for non-numeric input. Shift ops throw `'not-implemented-yet'` (deferred to `SNumericTypeMethods` via method dispatch).

### Phase 2d-B code (And, Or)

- **`'coll-not-boolean'`** — `And` or `Or` arm received an input value that wasn't `Coll[Boolean]`. Either `input.kind !== 'Coll'` OR `input.kind === 'Coll'` but `items` contained a non-Boolean kind. Wire-format invariants make this unreachable for parser-produced trees; defensive against `ConstantPlaceholder` injection.

### Phase 2e codes (treeVersion + lambdas + XorOf)

- **`'tree-version-too-low'`** — Upcast/Downcast arm encountered a BigInt branch (Upcast: BigInt → BigInt; Downcast: source=BigInt) at `ctx.treeVersion < 3`. Mirrors sigma-rust's V3 gating per `eval/upcast.rs:18` and `eval/downcast.rs`.
- **`'apply-non-lambda'`** — `Apply.func` evaluated to an `SValue` whose `kind !== 'Lambda'`.
- **`'apply-arity-mismatch'`** — `Apply.args.length !== Apply.func.closure.argIds.length`. Explicit defensive check (sigma-rust silently truncates).

### Phase 2f Stop α code (Box-extract arms)

- **`'extract-input-not-box'`** — `ExtractAmount` / `ExtractScriptBytes` / `ExtractRegisterAs` / `ExtractCreationInfo` / `ExtractBytes` / `ExtractBytesWithNoRef` / `ExtractId` received input whose `kind !== 'Box'`. Wire-format invariants make this unreachable for parser-produced trees.

### Phase 2f Stop β codes (ExtractRegisterAs)

- **`'register-id-out-of-range'`** — `ExtractRegisterAs.registerId` outside the valid 0..=9 range. Charged 50 jit cost before the throw (Pattern A).
- **`'register-type-mismatch'`** — `ExtractRegisterAs` found a register entry whose stored `tpe` differs from `e.elemTpe`. Sigma-rust THROWS here (NOT returns None).

### Phase 2f medium codes (GlobalVars / GetVar / Option family / SelectField)

- **`'context-field-missing'`** — a `GlobalVars` arm (Height, Inputs, Outputs, SelfBox, MinerPubKey, GroupGenerator), the `GetVar` arm, or the `SContext.preHeader` handler was reached but the required `EvalContext` field is absent (`undefined`). Counted in the `not-impl` bucket by `corpus-eval.test.ts`. Also consumed by the `SContext.preHeader` handler from phase 2g.6.
- **`'get-var-type-mismatch'`** — `GetVar` found a context-extension entry at the requested `varId` but its stored `tpe` did not match the arm's declared `var_tpe`.
- **`'option-empty'`** — `OptionGet` was called on an `Option` value whose `value === null` (i.e., `None`).
- **`'option-input-not-option'`** — `OptionGet`, `OptionIsDefined`, or `OptionGetOrElse` received an input `SValue` whose `kind !== 'Option'`.
- **`'select-field-index-out-of-range'`** — `SelectField.fieldIndex` (1-based) resolved to a zero-based index outside `[0, items.length)`. Unreachable from parser-produced trees.
- **`'select-field-input-not-tuple'`** — `SelectField` received an input `SValue` whose `kind !== 'Tuple'`.

### Phase 2f Coll HOFs codes (SizeOf, Append, ByIndex, Slice, MapColl, Filter, Fold, Exists, ForAll)

- **`'coll-input-not-coll'`** — any Coll HOF arm received an input `SValue` whose `kind !== 'Coll'`. Defensive against `ConstantPlaceholder` injection.
- **`'coll-elem-tpe-mismatch'`** — Filter / Exists / ForAll arm: an element's runtime `kind` did not match the declared element type derived from `condition.args[0].tpe`.
- **`'coll-by-index-out-of-range'`** — `ByIndex` arm: the index was outside `[0, coll.items.length)` and no default expression was provided.
- **`'coll-by-index-index-not-int'`** — `ByIndex` arm: the index expression evaluated to an `SValue` whose `kind !== 'Int'`.
- **`'coll-slice-bound-not-int'`** — `Slice` arm: the `from` or `until` expression evaluated to an `SValue` whose `kind !== 'Int'`.
- **`'lambda-not-callable'`** — MapColl / Filter / Fold / Exists / ForAll arm: the function expression evaluated to a non-Lambda, OR the resulting Lambda's `closure.argIds` is empty.
- **`'lambda-result-type-mismatch'`** — MapColl / Fold arm: the lambda body returned an `SValue` whose `kind` did not match the expected result type.

### Phase 2g-medium code (CreateProveDlog, CreateProveDhTuple eval arms)

- **`'sigma-prop-input-not-group-element'`** — `CreateProveDlog` or `CreateProveDhTuple` arm received an input `SValue` whose `kind !== 'GroupElement'`. Wire-format invariants make this unreachable for parser-produced trees.

### Phase 2g-combinators codes (Atleast, SigmaAnd, SigmaOr eval arms)

- **`'atleast-bound-not-int'`** — `Atleast` arm: the `bound` expression evaluated to an `SValue` whose `kind !== 'Int'`.
- **`'atleast-bound-out-of-range'`** — `Atleast` arm: after extracting an `Int` bound, the value is `< 0`, `> 255`, or `> items.length`. Checked before delegating to `cthresholdReduce`.
- **`'sigma-prop-coll-elem-not-sigma-prop'`** — `Atleast` / `SigmaAnd` / `SigmaOr` arm (via `eval/_sigma-helpers.ts::expectSigmaProp`): an item evaluated to non-SigmaProp.
- **`'sigma-prop-input-not-coll'`** — `Atleast` arm (via `extractSigmaPropColl`): the `input` expression evaluated to non-Coll. (`SigmaAnd`/`SigmaOr` take `items: Expr[]`, not a Coll input, so this code applies only to `Atleast`.)

### Phase 2g.5 codes (Context, SigmaPropBytes, MethodCall, PropertyCall)

- **`'sigma-prop-bytes-input-not-sigma-prop'`** — `SigmaPropBytes` arm received an input `SValue` whose `kind !== 'SigmaProp'`. Wire-format invariants make this unreachable for parser-produced trees.
- **`'method-not-implemented'`** — `MethodCall` / `PropertyCall` dispatcher: the `(typeId, methodId)` pair has no registered handler in the `HANDLERS` registry. Also reused for defensive shape mismatches inside registered handlers (per error-taxonomy Decision #1: compact taxonomy — covers both "dispatch miss" and "handler shape mismatch" to keep the code count low). Reused by all 2g.5 + 2g.6 handlers for obj-kind defensive throws.
- **`'context-obj-not-context'`** — `SContext.dataInputs` handler (and `SContext.preHeader` handler from 2g.6): the `obj` argument evaluated to an `SValue` whose `kind !== 'Context'`. Wire-format invariants make this unreachable for parser-produced trees.

Phase 2g.6 added ZERO new codes — all 5 handlers reuse the codes above.

### Phase 2h-b codes (SAvlTree.* method handlers)

- **`'avl-tree-obj-not-avl-tree'`** — defensive receiver check on all 13 SAvlTree.* handlers when `obj.kind !== 'AvlTree'`. Wire-format invariants make this unreachable for parser-produced trees.
- **`'avl-tree-proof-failed'`** — thrown when `@ergots/avltree`'s `verifyAvlBatch` / `verifyAvlBatchPartial` returns `null` (verifier construct failure: proof decode or digest mismatch). Sigma-rust-parity throw points:
  - `get` (100:10) — verifier construct fail; per-op fail surfaces as `results[0] === null` → Option None (no throw)
  - `getMany` (100:11) — verifier construct fail; per-key absence surfaces as per-key None in result Coll
  - `insert` (100:12) — verifier construct fail (always); V<3 per-op fail also throws via `verifyAvlBatch` returning null when `opsCompleted < ops.length`
  - `update` (100:13) — verifier construct fail; per-op fail surfaces as Option None (sigma-rust has unconditional graceful break — confirmed in Phase F source-read; no V<3 throw path)
  - `remove` (100:14) — verifier construct fail OR per-op fail (no V3+ break for remove)
  - `contains` (100:9) — verifier construct fail throws; per-op fail returns `false` (asymmetry confirmed in Phase F source-read at `eval/savltree.rs:372` vs `:379`)

Single code per the compact-taxonomy decision from 2g.5; granular per-cause codes are noise without caller value (these are all "the script's assumption about chain state was wrong" and not branched-on by callers).

No other error codes are emitted by the v0.2.0 evaluator. Internal panics (e.g. a bug in a wire-layer helper called from an arm) bubble up as their typed error class — those represent contract violations and are bugs, not eval-input issues.

## Method-handler registry (21 entries)

The `MethodCall` / `PropertyCall` dispatcher in `eval/method-call.ts` routes through a `(typeId, methodId)` → handler registry. Per error-taxonomy Decision #1, all defensive obj-kind throws reuse `'method-not-implemented'` (or the existing `'context-obj-not-context'` for SContext handlers).

| # | Method | typeId:methodId | Cost | Pattern | Returns | Sigma-rust source |
|---|---|---|---|---|---|---|
| 1 | `SBox.tokens` | 99:8 | 15 | A | `Coll[(Coll[Byte], Long)]` | `eval/sbox.rs:72-79` |
| 2 | `SContext.dataInputs` | 101:1 | 15 | A | `Coll[Box]` from `ctx.dataInputs ?? []` | `eval/scontext.rs:17-31` |
| 3 | `SColl.indexOf` | 12:26 | `addPerItemCost(20, 10, 2, n)` | B | `Int` (index or -1; `from < 0` clamped to 0) | `eval/scoll.rs:21-50` |
| 4 | `SGlobal.groupGenerator` | 106:1 | 10 | A | `GroupElement` (33-byte SEC1 from `GROUP_GENERATOR_BYTES`) | `eval/sglobal.rs:32-41` |
| 5 | `SColl.zip` | 12:29 | `addPerItemCost(10, 1, 10, obj.length)` | B | `Coll[STuple[T1, T2]]` truncated to shorter | `eval/scoll.rs:138-169` |
| 6 | `SColl.indices` | 12:14 | `addPerItemCost(20, 2, 16, n)` | B | `Coll[Int]` = `[0, …, n-1]`; throws on `n > 2^31-1` | `eval/scoll.rs:171-193` |
| 7 | `SContext.preHeader` | 101:3 | 15 | A | `{kind:'PreHeader', value: ctx.preHeader}`; throws `'context-field-missing'` on undefined | `eval/scontext.rs:72-81` |
| 8 | `SPreHeader.timestamp` | 105:3 | 10 | A | `{kind:'Long', value: obj.value.timestamp}` (bigint passthrough) | `eval/spreheader.rs:20-24` |
| 9 | `SAvlTree.digest` | 100:1 | 15 | A | `Coll[Byte]` | `eval/savltree.rs:28-34` |
| 10 | `SAvlTree.enabledOperations` | 100:2 | 15 | A | `Byte` | `eval/savltree.rs:36-40` |
| 11 | `SAvlTree.keyLength` | 100:3 | 15 | A | `Int` | `eval/savltree.rs:42-46` |
| 12 | `SAvlTree.valueLengthOpt` | 100:4 | 15 | A | `Option[Int]` | `eval/savltree.rs:48-57` |
| 13 | `SAvlTree.isInsertAllowed` | 100:5 | 15 | A | `Boolean` | `eval/savltree.rs:59-63` |
| 14 | `SAvlTree.isUpdateAllowed` | 100:6 | 15 | A | `Boolean` | `eval/savltree.rs:65-69` |
| 15 | `SAvlTree.isRemoveAllowed` | 100:7 | 15 | A | `Boolean` | `eval/savltree.rs:71-75` |
| 16 | `SAvlTree.contains` | 100:9 | 0 | — | `Boolean` | `eval/savltree.rs:339-381` |
| 17 | `SAvlTree.get` | 100:10 | 0 | — | `Option[Coll[Byte]]` | `eval/savltree.rs:104-150` |
| 18 | `SAvlTree.getMany` | 100:11 | 0 | — | `Coll[Option[Coll[Byte]]]` | `eval/savltree.rs:152-212` |
| 19 | `SAvlTree.insert` | 100:12 | 0 | — | `Option[AvlTree]` | `eval/savltree.rs:214-277` |
| 20 | `SAvlTree.update` | 100:13 | 0 | — | `Option[AvlTree]` | `eval/savltree.rs:383-439` |
| 21 | `SAvlTree.remove` | 100:14 | 0 | — | `Option[AvlTree]` | `eval/savltree.rs:279-337` |

(`SColl.zip`'s `n` = obj length, NOT `min(obj, arg)` — Pattern B charges based on obj's length per sigma-rust.)

(The 13 `SAvlTree.*` handlers come from phase 2h-b. Tier-1 accessors 9-15 charge cost 15 BEFORE projecting over runtime `AvlTreeData` fields, no `@ergots/avltree` call. Tier-2 verification ops 16-21 charge zero per-handler cost — cost is owned by the lower-level verifier — and call into `@ergots/avltree` v0.2.0's `verifyAvlBatch` / `verifyAvlBatchPartial`.)

## Coverage and stability

**52 / ~70 `Expr` variants** have arms in v0.2.0:
- 8 from phase 2b
- 3 from phase 2c: `BinOp`, `LogicalNot`, `BoolToSigmaProp`
- 4 from phase 2d-A: `Negation`, `BitInversion`, `Upcast`, `Downcast`
- 2 from phase 2d-B: `And`, `Or`
- 3 from phase 2e: `FuncValue`, `Apply`, `XorOf`
- 2 from phase 2f Stop α: `ExtractAmount`, `ExtractScriptBytes`
- 2 from phase 2f Stop β: `ExtractRegisterAs`, `ExtractCreationInfo`
- 3 from phase 2f Stop γ: `ExtractBytes`, `ExtractBytesWithNoRef`, `ExtractId`
- 6 from phase 2f medium: `GlobalVars`, `GetVar`, `OptionGet`, `OptionIsDefined`, `OptionGetOrElse`, `SelectField`
- 9 from phase 2f Coll HOFs: `SizeOf`, `Append`, `ByIndex`, `Slice`, `MapColl`, `Filter`, `Fold`, `Exists`, `ForAll`
- 2 from phase 2g-medium: `CreateProveDlog`, `CreateProveDhTuple`
- 3 from phase 2g-combinators: `Atleast`, `SigmaAnd`, `SigmaOr`
- 4 from phase 2g.5: `Context`, `SigmaPropBytes`, `MethodCall`, `PropertyCall`
- 1 from phase 2g.6: `Global`

Everything else throws `'not-implemented-yet'`. Real-world ErgoTree trees from the `mainnet_boxes` corpus are filtered against this coverage by `test/corpus-eval.test.ts` — only fixtures whose body uses exclusively the supported variants are exercised against the sigma-rust eval oracle for byte-equality. As of phase 2g.6 complete, the mainnet corpus aggregate is `success=18 not-impl=0 other=0` (synthetic-context stubs: `outputs: []`, `inputs: []`, `selfBox: synthetic`, `dataInputs: []`). Phase 2h-b adds 13 method handlers but no new `Expr` arms — coverage remains 52 / ~70; post-2h-b uplift to C2 corpus TBD on next corpus run.

**Method-handler registry: 21 entries** (was 8 before 2h-b; +13 from 2h-b — 7 Tier-1 accessors at typeId:methodId 100:1..100:7 + 6 Tier-2 verification ops at 100:9..100:14).

**Public function signatures are stable** from v0.2.0 onward. Future arms slot into central dispatch (`eval/eval.ts`) without changing `evaluate`, `evaluateWith`, `makeContext`, or `EvalError`.

**`EvalOpts` is open for additive growth.** Phase 2e added `treeVersion?: number`. Phase 2f medium added 6 chain-state fields. Phase 2g.5 added `dataInputs?: ErgoBox[]`. Phase 2g.6 added no new fields (the existing `preHeader?: PreHeader` from 2f medium is consumed by the new `SContext.preHeader` handler). Phase 2h-b added no new fields (the `SAvlTree.*` handlers receive the receiver `AvlTreeData` through the method-call arg surface, not via context). Phase 2h-c may add `headers` when Header arms land.

**`@noble/curves@2.2.0` added in phase 2g-medium.** Version-locked with `@noble/hashes@2.2.0`. Used by the secp256k1 adapter (`crypto/secp256k1.ts`) and the sigma verifier (see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md)).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting guarantees
- [`facts/ergoscript-wire.md`](./ergoscript-wire.md) — wire format (parseTree, serializeTree, ErgoTreeParseError/SerializeError)
- [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) — sigma-protocol verifier (`SigmaBoolean`, `verifySignature`, `VerifyError`)
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` — method-call dispatcher
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — most recent eval phase (5 new method handlers + Global arm)
