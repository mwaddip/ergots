# `@ergots/ergoscript` — Evaluator Surface Contract

This file documents the **evaluator slice** of the `@ergots/ergoscript` boundary contract (phases 2b through 2i-a). It is also the canonical home for the `SValue` / `SType` / `Expr` discriminated unions, which are produced by the wire layer (see [`facts/ergoscript-wire.md`](./ergoscript-wire.md)) and consumed across the package.

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
- `sValueEquals` recursive structural comparer covering primitives, `GroupElement` (byte-equal), `SigmaProp` (byte-equal on opaque `.raw`), `Coll`, `Tuple`, `Option`. Cross-kind comparison returns `false` (no coercion) — **later version-gated (2026-06-01): at `ctx.treeVersion < 3`, mismatched-NUMERIC `Eq`/`NEq` operands are coerced to the wider kind before comparison (JVM pre-V3 auto-upcast); see the `'bin-op-kind-mismatch'` taxonomy entry.** `Box` / `AvlTree` throw `'not-implemented-yet'`. Cost charged per sigma-rust's `data_value_comparer.rs` constants.
- 5 new `EvalError` codes: `'arith-overflow'`, `'arith-divide-by-zero'`, `'bin-op-kind-mismatch'`, `'bin-op-not-numeric'`, `'bin-op-not-boolean'`.

**Phase 2d-A — numeric-poly unary arms** (additive):

- 4 more arms wired: `Negation` (numeric negate; overflow throws `'arith-overflow'`), `BitInversion` (bitwise complement; no overflow), `Upcast` (widen to target numeric kind read from `e.tpe`; no overflow), `Downcast` (narrow to target numeric kind; overflow throws `'downcast-overflow'`).
- One new `EvalError` code: `'downcast-overflow'` (distinct from `'arith-overflow'` so callers can dispatch on "narrowing specifically failed"). Non-numeric input reuses `'bin-op-not-numeric'`.
- Step-1 refactor: `checkRange` + `maskToKind` promoted from `bin-op/{arith,bit}.ts` to `bin-op/_numeric.ts`. `checkRange` gains a third parameter (error code string).

**Phase 2d-B — Coll[Boolean] aggregator arms** (additive):

- 2 more arms wired: `And` (all-true; empty Coll returns `true`) and `Or` (any-true; empty Coll returns `false`). Both charge cost AFTER eval-child via `addPerItemCost`; cost values differ per arm (And: `(10, 5, 32, n)`; Or: `(5, 5, 64, n)`).
- One new `EvalError` code: `'coll-not-boolean'`. Reused by both arms for defensive kind-check.

**Phase 2e — lambdas + treeVersion + XorOf + V3 revisit** (additive):

- 3 more arms wired: `FuncValue` (constructs Lambda SValue; Fixed(5) cost; lazy body), `Apply` (invokes Lambda; Fixed(30) cost + `ADD_TO_ENV_COST` (5) per lambda-arg binding [added post-2j for JVM alignment, commit `6171d32`]; immutable env extend; arity check), `XorOf` (Coll[Boolean] XOR aggregator with V0/V1-vs-V2+ semantics drift; reuses `'coll-not-boolean'`).
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

**Phase 2h-c.1 — SHeader runtime + 17 method handlers** (additive):

- 17 new method handlers wired (21 → 38 registry entries):
  - **15 `SHeader.*` accessors** (Pattern A Fixed(10) each) at typeId 104, methodIds 1-15: `id` (1), `version` (2), `parentId` (3), `adProofsRoot` (4), `stateRoot` (5), `transactionsRoot` (6), `timestamp` (7), `nBits` (8), `height` (9), `extensionRoot` (10), `minerPk` (11), `powOnetimePk` (12), `powNonce` (13), `powDistance` (14), `votes` (15). Source: `eval/sheader.rs:16-113`.
  - **2 `SContext.*` additions** (Pattern A Fixed(15) each): `headers` (101:2) returns `Coll[Header]` from `ctx.headers`; `lastBlockUtxoRootHash` (101:9) synthesizes `AvlTree(digest=ctx.headers[0].stateRoot, treeFlags=0b111, keyLength=32, valueLengthOpt=null)`. Source: `eval/scontext.rs:58-70` and `:83-99`.
- New `SValue` variant: `{ kind: 'Header'; value: Header }` (`Header` imported from `@ergots/scorex`).
- `EvalOpts` / `EvalContext` gains 1 new optional field: `headers?: Header[]`.
- 1 new `EvalError` code: `'header-obj-not-header'` (defensive receiver check on all 15 SHeader handlers; 45 → 46 total).
- Wire-format unlock (cross-references `facts/ergoscript-wire.md`): `parseSValue` / `serializeSValue` signatures gain `treeVersion: number` parameter; SHeader SValue parse + serialize now ship with V3-gating (replaces `'not-implemented-phase-2a'`).
- V2-header semantic detail: `powOnetimePk` returns 33 zero bytes (identity-point encoding per `EcPoint::default()` → `scorex_serialize`); `powDistance` returns `0n` (BigInt).
- Notable quirk: `SHeader.stateRoot` is declared with `SType::SAvlTree` in sigma-rust `types/sheader.rs:127`, but the eval (`sheader.rs:40-44`) returns `Coll[Byte]` (33 bytes). We match the eval, not the type-system declaration.

**Phase 2h-c.1 COMPLETE.** Method handler registry: 38 entries. EvalError codes: 46. Test count: 2857 (ergoscript).

**Phase 2h-c.2 — `SHeader.checkPow` + dispatcher minVersion upgrade** (additive):

- 1 new method handler wired (38 → 39 registry entries): **`SHeader.checkPow` (104:16)** — Pattern A Fixed(700) — V3-gated at the dispatcher (registered with `minVersion: 3`). Source: `eval/sheader.rs:115-124`.
- Dispatcher upgrade: `HANDLERS` registry value type expanded from `HandlerFn` to `{ handler: HandlerFn, minVersion?: number }`. The dispatcher consults `entry.minVersion` and throws `EvalError('tree-version-too-low')` BEFORE invoking the handler — V<N reject incurs 0 handler-cost (sigma-rust-parity with `MethodDesc.min_version` gating).
- 1 new `EvalError` code: `'autolykos-v1-not-supported'` (46 → 47 codes). Raised when `verifyAutolykosV2` (now in `@ergots/scorex`) throws `AutolykosV1NotSupportedError` on a V1 header.
- `verifyAutolykosV2` runtime import moves from `@ergots/nipopow` to `@ergots/scorex` (phase 2h-c.2's other half — see `facts/scorex.md`).

**Phase 2h-c.2 COMPLETE.** Method handler registry: 39 entries. EvalError codes: 47. Test count: 2867 (ergoscript).

**Phase 2h-d — `SAvlTree.*` completion** (additive):

- 3 new method handlers wired (39 → 42 registry entries) — closes the final three `SAvlTree.*` methods:
  - **`SAvlTree.updateOperations` (100:8)** — Pattern A Fixed(45), V0+. Pure projection over `AvlTreeData.treeFlags`; returns a new `{kind:'AvlTree'}` SValue with the supplied `newOperations: Byte` substituted in. No `@ergots/avltree` call. Source: `eval/savltree.rs:77-88`.
  - **`SAvlTree.updateDigest` (100:15)** — Pattern A Fixed(40), V0+. Validates `newDigest.length === 33` (mirrors sigma-rust's `ADDigest::try_from` length-check); on success returns a new `{kind:'AvlTree'}` SValue with the digest substituted. Source: `eval/savltree.rs:90-102`.
  - **`SAvlTree.insertOrUpdate` (100:16)** — zero per-handler cost, **V3-gated at the dispatcher** (registered with `minVersion: 3`; pre-V3 trees reject via `'tree-version-too-low'` before the handler runs, incurring receiver-eval + dispatcher-envelope cost only). Calls into `@ergots/avltree`'s `verifyAvlBatch` with `InsertOrUpdate` ops (sigma-rust's `Operation::InsertOrUpdate` = upsert: insert when absent, update when present). Returns `Option[AvlTree]`; per-op failure surfaces as Option None (no throw); verifier construct failure throws `'avl-tree-proof-failed'`. Source: `eval/savltree.rs:441-498`; descriptor at `types/savltree.rs:377-403` with `min_version: ErgoTreeVersion::V3`.
- 1 new `EvalError` code: `'avl-tree-bad-digest-length'` (47 → 48 total). Thrown by `SAvlTree.updateDigest` when the supplied `newDigest` byte length is not 33. Mirrors sigma-rust's `ADDigest::try_from` length-check failure.
- 2 new `_avltree-adapter.ts` helpers: `withUpdatedFlags(data, newFlags)` (Tier-1 projection over `treeFlags`) and `buildInsertOrUpdateOps(entries)` (Tier-2 batch construction for the V3-only upsert path).
- 2 carry-forward fixtures closed: V3+ per-op-fail-graceful behavior for `insert` (sigma-rust V3 break path at `eval/savltree.rs:259-266`); unconditional per-op-fail-graceful behavior for `update` (sigma-rust unconditional break at `eval/savltree.rs:420-429`). Both confirm the sigma-rust source-read corrections from phase 2h-b.

**Phase 2h-d COMPLETE.** Method handler registry: 42 entries. EvalError codes: 48. Test count: 2903 (ergoscript).

**Phase 2h-f — Tier-3 method-handler cleanup** (additive):

- 2 new method handlers wired (42 → 44 registry entries) — closes the two Tier-3 long-tail deferrals from the 2g.6 demand survey:
  - **`SGroupElement.getEncoded` (7:2)** — Pattern A Fixed(250). Returns 33-byte SEC1-compressed point as `Coll[Byte]`. Reuses existing `bytesToCollByteSValue` helper (no new dependency on `@noble/curves` — the bytes are already SEC1-encoded on `SValue.GroupElement.value`). V0+. Source: `eval/sgroup_elem.rs:15-26`.
  - **`SColl.flatMap` (12:15)** — Pattern B `addPerItemCost(60, 10, 8, n)`. Lambda HOF with concat semantics. Defensive body restriction mirrors sigma-rust `scoll.rs:78-84`: when the runtime `closure.body` is a `MethodCall`, its args MUST be empty (property-call style); throws `'lambda-not-callable'` otherwise. Allowed: `xs.flatMap(x => x.indices)`. Not allowed: `xs.flatMap(x => x.indexOf(5, 0))`. V0+. Handler lives in new module `eval/scoll-flat-map.ts`. Source: `eval/scoll.rs:52-136`.
- **Naming correction:** the 2g.6 demand survey labeled this method "flatten" — that was wrong. sigma-rust ships `flatMap` (lambda HOF), not `flatten` (no-lambda specialization). The 2-mainnet-box demand count from the survey applies to methodId 15 (flatMap).
- `HandlerFn` signature gains optional 5th `extra?: { mc: MethodCall; env: Env }` argument (forwarded by `evalMethodCall`; `evalPropertyCall` passes `undefined`). flatMap is the first consumer; 42 existing handlers ignore the arg via TS structural typing.
- **Two TS-from-sigma-rust divergences on lambda static typing (both inherited from existing arms; both load-bearing for flatMap):**
  - **R3(a) elem-type check.** Runtime `Closure` SValue (`mir/types.ts:149-156`) does NOT carry `argTpes`. The elem-type check (`sTypeEquals(input.elem, lambdaArgTpe)`) runs only when `mc.args[0]` is an inline FuncValue MIR node; skipped for ValUse-source lambdas. Mirrors existing `coll-map.ts:94-108` convention. Sigma-rust always runs the check via runtime `lambda.args[0].tpe`.
  - **R3(b) output elem type — CLOSED by phase A3 (2026-06-01).** Originally `exprTpe(closure.body)` returned `SAny` for `PropertyCall`/`MethodCall` bodies (no SMethod resolver), so an empty-input flatMap with a `PropertyCall` body (e.g. `x.indices`) returned `Coll[SAny]` where sigma-rust/JVM return `Coll[T]`. Phase **A3** added the method-return-type resolver (`mir/method-signatures.ts`, consulted by `exprTpe`): the empty-input output elem now derives from the body's static type, matching sigma-rust. The non-empty first-iter refinement path is unchanged and agrees. See the A3 changelog entry below.
- Zero new `EvalError` codes — both handlers reuse `'method-not-implemented'`, `'coll-input-not-coll'`, `'lambda-not-callable'`, `'coll-elem-tpe-mismatch'`, `'lambda-result-type-mismatch'` per the 2g.5 compact-taxonomy decision.

**Phase 2h-f COMPLETE.** Method handler registry: 44 entries. EvalError codes: 48 (unchanged). Test count: 2922 (ergoscript; was 2903, +19 from 2h-f).

**Phase 2i-a — Pure-bytes predefs** (additive):

- 8 new eval arms wired (coverage 52 → 60 of ~70 `Expr` arms):
  - **`CalcBlake2b256`** — Pattern B `addPerItemCost(20, 7, 128, n)`. `@noble/hashes/blake2.js` blake2b at 32-byte output (`dkLen: 32`).
  - **`CalcSha256`** — Pattern B `addPerItemCost(80, 8, 64, n)`. `@noble/hashes/sha2.js` sha256.
  - **`ByteArrayToLong`** — Pattern A `Fixed(16)`. First 8 bytes BE → i64; trailing bytes IGNORED (sigma-rust `byte_array_to_long.rs:62-65` `eval_skip_tail` confirms). Throws on `length < 8`.
  - **`LongToByteArray`** — Pattern A `Fixed(17)`. i64 → 8 bytes BE via DataView.setBigInt64.
  - **`ByteArrayToBigInt`** — Pattern A `Fixed(30)`. Signed BE → bigint; range-checked to i256 `[-2^255, 2^255 - 1]`. Empty input throws separately. Length NOT capped — 33+ byte inputs in-range succeed (sigma-rust `eval_above_max_bound`).
  - **`Xor`** — Pattern B `addPerItemCost(10, 2, 128, l_length)`. Cost sized by LEFT operand. Truncating-zip: output length = `min(left, right)`. NO length-mismatch error (mirrors sigma-rust `helper_xor`).
  - **`DecodePoint`** — Pattern A `Fixed(300)`. Reuses existing `crypto/secp256k1.ts:decodePoint` adapter (handles Ergo 33-zero-bytes identity convention).
  - **`SubstConstants`** — Pattern B `addPerItemCost(100, 100, 1, template.constants.length)`. **Consensus-critical bytes-in/bytes-out.** Cost sized by TEMPLATE'S `constants.length`, NOT positions.length (sigma-rust bug-3 regression at `subst_const.rs:221-283`). **Serializer-level (A2-b, 2026-06-01):** delegates to `wire/ergo-tree.ts` `substituteConstantsBytes`, which copies the tree BODY verbatim (never parses it) — mirroring JVM `ErgoTreeSerializer.substituteConstants`, so a template whose body isn't valid Expr bytes (SANTA `#1`) passes through where the old `parseTree`/`serializeTree` round-trip threw. Out-of-range positions are a no-op and duplicate positions are first-wins (JVM `getPositionsBackref`); ergots leads here (sigma-rust still parse-based). See `facts/ergoscript-wire.md` §A2-b.
- 7 new `EvalError` codes (48 → 55):
  - `'predef-input-not-byte-array'` (T2; shared by T2/T3/T4/T6/T7/T8 for non-Coll[Byte] inputs)
  - `'byte-array-to-long-too-short'` (T4; length < 8)
  - `'predef-input-not-long'` (T5; LongToByteArray's non-Long input)
  - `'byte-array-to-bigint-empty'` (T6)
  - `'byte-array-to-bigint-out-of-range'` (T6)
  - `'decode-point-invalid'` (T8)
  - `'subst-constants-error'` (T9 — compact code covering 6 throw paths per the 2g.5 compact-taxonomy decision; was 7 before A2 made out-of-range positions a no-op)
- 3 new shared helpers:
  - `collByteToUint8Array(v, arm, code?)` in `eval/_byte-coll.ts` — extracted in T7.5 from 6-7 inline copies; takes optional EvalErrorCode (default `'predef-input-not-byte-array'`).
  - `signedBeBytesToBigInt(bytes): bigint` + `I256_MIN`, `I256_MAX` constants in `eval/_byte-coll.ts` — T6.
  - `extractCollInt(v, arm, code?)` in `eval/_coll-helpers.ts` — T9 (for SubstConstants positions argument).
- Two documented TS-from-sigma-rust divergences (both inherited, neither introduced by this slice):
  - **`DecodePoint` identity**: existing `decodePoint` adapter at `crypto/secp256k1.ts:65-77` checks `isZero33(bytes)` (all 33 bytes zero), while sigma-rust dispatches on `buf[0] !== 0` only. Pre-existing across the verifier surface; not introduced by 2i-a. In-corpus fixtures always produce identity as exactly 33 zero bytes (canonical sigma-rust serialization). Pathological inputs like `[0x00, nonzero, …]` would diverge. **Resolved as deliberate strict-reject in phase 2i-d** — documented centrally at `packages/ergoscript/src/crypto/secp256k1.ts:decodePoint`. Production-unreachable; strict-reject chosen as a safety margin against hand-crafted/hostile inputs.
  - **`SubstConstants` type-check**: `substituteConstantsBytes` validates `sTypeEquals(newValuesElem, constantTypes[i])` (the outer Coll's declared element type) vs sigma-rust/JVM's per-item `Constant.tpe == old_constant.tpe`. Equivalent for well-typed inputs (all of mainnet); divergence only on pathological hand-crafted hetero-typed Colls.

**Phase 2i-a COMPLETE.** Method handler registry: 44 entries (unchanged). EvalError codes: 55. Eval arm coverage: 60 of ~70. Ergoscript test count: 3074. Total monorepo: 3652.

**Phase 2i-b — Curve + AVL + sigma-trivial predefs** (additive):

- 5 new eval arms wired (coverage 60 → 65 of ~70 `Expr` arms):
  - **`SigmaPropIsProven`** — structural throw, no eval of `e.input`, no cost charged. Mirrors sigma-rust `sigma_prop_is_proven.rs:11-25` frontend-only-throw pattern (Scala typer rewrites `prop.isProven` to this node; AOT graph-IR rewrite elides it before evaluation; sigma-rust bytecode interpreter mirrors with unconditional `Err(EvalError::Misc(...))`).
  - **`MultiplyGroup`** — Pattern A `Fixed(40)`. Group operation under multiplicative notation = point ADDITION on the curve (per `ec_point.rs:74-80` `Mul<&EcPoint>` = `ProjectivePoint::add`). Reuses existing `pointAdd` adapter from `crypto/secp256k1.ts`.
  - **`Exponentiate`** — Pattern A `Fixed(900)`. Scalar multiplication. **REQUIRES explicit identity-base guard** — `@noble/curves@2.2.0` `Point.multiply` (`weierstrass.ts:1067`) does NOT short-circuit on `Point.ZERO`. Only `multiplyUnsafe` (line 1103) does. Handler checks `base.is0()` explicitly and returns 33 zero bytes (identity), mirroring sigma-rust `ec_point::exponentiate` at `ec_point.rs:111-119` (`if !is_identity(base) { ... } else { *base }`). BigInt256 → scalar mod n reduction handled by existing `pointMul` adapter.
  - **`CreateAvlTree`** — no inline cost (children-only). 4-input value constructor (Byte flags, Coll[Byte] digest, Int keyLength, Option[Int] valueLength). **AvlTreeFlags canonicalized to bits 0..2** via `flagsV.value & 0x07` — mirrors sigma-rust's `AvlTreeFlags::parse → new` round-trip stripping reserved bits 3..7 (`mir/avl_tree_data.rs`). KeyLength + valueLength use `>>> 0` (u32 bit-cast) — matches sigma-rust's `i32 as u32`. Digest length check (33 bytes) throws `'avl-tree-bad-digest-length'` (reused from 2h-d).
  - **`TreeLookup`** — no inline cost (children-only + verifier delegation). Thin wrap over `@ergots/avltree` v0.2.0's `verifyAvlLookup`. Double-null semantic: outer `null` (proof construct failure) throws `'avl-tree-proof-failed'`; inner `.value === null` (proof OK, key absent) returns `Option None`; `.value: Uint8Array` (key found) returns `Option Some<Coll[Byte]>`. Output element type: `SColl[SByte]`.
- 4 new `EvalError` codes (55 → 59):
  - `'sigma-prop-is-proven-no-eval'` (T2) — structural-throw code, mirrors sigma-rust's `Misc("SigmaPropIsProven has no interpreter eval...")` for byte-match-parity opcode 95.
  - `'group-op-input-not-group-element'` (T3 + T4) — shared by MultiplyGroup (both operands) and Exponentiate (base). Distinct from `'sigma-prop-input-not-group-element'` (2g-medium) which is for sigma-prop creation arms.
  - `'predef-input-not-bigint'` (T4) — Exponentiate's BigInt exponent. Future arms in the `ModQ` family (phase 2i-d) will reuse.
  - `'create-avl-tree-shape-mismatch'` (T5) — compact code covering 3 throw paths in CreateAvlTree (non-Byte flags, non-Int keyLength, non-Int valueLength); `.message` carries the specific field name.
- 0 new method-handler registry entries (44 unchanged).
- Two pre-existing TS-from-sigma-rust divergences acknowledged (neither introduced by 2i-b):
  - **`DecodePoint` identity convention** — inherited from 2i-a. Affects `MultiplyGroup` and `Exponentiate` base decode (both use `decodePoint`). Pre-existing across verifier surface. **Resolved in phase 2i-d** — see the 2i-a section above and the central docstring at `crypto/secp256k1.ts:decodePoint` for the full rationale.
  - **`CreateAvlTree` keyLength bit-cast** — sigma-rust accepts negative i32 → huge u32 via `as u32` bit-cast; TS mirrors via `>>> 0`. Validated by oracle fixture `cat_negative_keylength`.
- **Process finding (worth tracking as a follow-up):** sigma-rust `fixture-gen`'s `force_any_val::<T>()` is NOT deterministic across runs (`TestRunner::default()` uses a fresh proptest seed). Encountered repeatedly in T3 / T4 / T6. T4 worked around by hardcoding payloads; T3's `mg_random_random` fixture has the latent issue (the value byte-flips between two equivalent point orderings on regeneration). Not yet remediated.

**Phase 2i-b COMPLETE.** Method handler registry: 44 entries (unchanged). EvalError codes: 59. Eval arm coverage: 65 of ~70. Ergoscript test count: 3142. Total monorepo: 3720.

**Phase 2i-c — Deserialize family** (additive):

- 2 new eval arms wired (coverage 65 → 67 of ~70 `Expr` arms): `DeserializeContext`, `DeserializeRegister`.
- **Architecture: substitute-pre-pass.** Mirrors sigma-rust `eval.rs:203-250` + `mir/expr.rs:442-496`. New module `eval/_substitute-deserialize.ts` exports `treeHasDeserialize(tree)` and `substituteDeserialize(body, tree, ctx)`. `evaluate` / `evaluateWith` dispatch to a substitute-then-eval path when `treeHasDeserialize(tree)` is true; the rewritten body goes through `tryTrivialReduceExpr` (T5 refactor extracted from `tryTrivialReduce`) + `evalExpr`. The Deserialize* eval arms are **defensive throws** (`'deserialize-not-substituted'`) reachable only when substitution did NOT rewrite a node — either (a) `DeserializeRegister` with register absent + `default` null (sigma-rust `expr.rs:478-481` LEAVES the node unchanged), or (b) a Deserialize* node lurking inside an already-substituted inner Expr (sigma-rust's `try_rewrite_bu` does NOT re-walk substituted children).
- 5 new `EvalError` codes (59 → 64):
  - `'deserialize-context-key-not-found'` — DC arm: `ctx.extension.values[id]` undefined. Mirrors sigma-rust `SubstDeserializeError::ExtensionKeyNotFound`.
  - `'deserialize-input-not-byte-array'` — both arms: extension entry / register entry not `Coll[Byte]`. Mirrors `SubstDeserializeError::TryExtractFromError`.
  - `'deserialize-parse-failed'` — both arms: inner Expr bytes malformed. Wraps the underlying wire-layer error message in `.message`. Mirrors `SubstDeserializeError::ExprParsingError`.
  - `'deserialize-tpe-mismatch'` — both arms: `exprTpe(parsed) !== e.tpe`. Check runs on BOTH register-decoded inner AND `default` fallback (per `expr.rs:486-491`). Mirrors `SubstDeserializeError::ExprTpeError`.
  - `'deserialize-not-substituted'` — defensive eval-time throw on both Deserialize* arms (cases (a) and (b) above).
- 0 new method-handler registry entries (44 unchanged).
- 0 new runtime dependencies.
- **Architectural divergence from sigma-rust** (originally documented in phase 2i-c, **CLOSED in phase 2j-b/iter-1**): the prior "we keep `ctx.constants` populated for all paths and skip the eager `substitute_constants` walk" stance was load-bearing only for the `tryTrivialReduceExpr` P2PK short-circuit — but NOT for the general deserialize-then-evalExpr case. Surfaced at h=3850 (2j-a Layer-5 smoke, `tools/mainnet-validate/findings/2026-05-23-2j-a-validation-smoke.md`): the timelock-pool tree had 6 ConstPlaceholders reaching `evalExpr` after substitution, and each charged `ConstantPlaceholder = Fixed(1)` (via `ctx.constants` lookup) instead of sigma-rust's `Constant = Fixed(5)` (via eager substitute) — yielding a 24 JitCost undercharge (6 × 4). **Resolution:** `dispatchTreeBody` now calls `substituteConstants(tree.body, tree.constants, tree.constantTypes)` BEFORE `substituteDeserialize` whenever `tree.header.constantSegregation` is true, mirroring sigma-rust `eval.rs:206` (`tree.proposition()` → `substitute_constants` → `substitute_deserialize`). The non-deserialize path stays on lazy resolution (`ctx.constants` lookup) — that path corresponds to sigma-rust's `with_constants(...)` branch (`eval.rs:259-261`), which intentionally charges 1 per CP. Validated by `evaluate-cost-deserialize-segregated.test.ts` (two cost-calibration cases: single-CP 16→20, three-CPs 48→60) and the prior `dc_const_sigmaprop_inner` (P2PK 50-cost short-circuit) which still passes because the substituted `Const(SSigmaProp)` body short-circuits before `evalExpr`.
- **`tryTrivialReduce` refactor** (T5, mechanical): extracted `tryTrivialReduceExpr(body, ctx)` from the previous `tryTrivialReduce(tree, ctx)`. The original becomes a one-line wrapper. No behavior change.
- **Two T6 fixture fix-forwards in T8** (documented in T8 commit `4ca85b1`): (1) `dc_height_eq_compare` opts_json now carries `height: 999999` (inner `GlobalVars.Height` needs ctx.height); (2) `dc_v3_unsigned_bigint` was dropped from the fixture set — sigma-rust's SUnsignedBigInt is a v6-only type our parser rejects at parse-stype. Treeversion threading is still exercised via outer-tree header bits.
- **Mutation-test exemption notes** (DR aggregate 86.4% with 0.85 threshold, vs 0.90 for other arms): the DR fixture set is dominated by small-payload entries (5-9 tree bytes, 2-4 inner bytes); the surviving mutations fall in legitimate same-code-throw equivalence classes (mostly `'deserialize-tpe-mismatch'` and `'deserialize-parse-failed'`) that mirror sigma-rust behavior byte-for-byte. Structural ceiling, not implementation gap.

**Phase 2i-c COMPLETE.** Method handler registry: 44 entries (unchanged). EvalError codes: 64. Eval arm coverage: 67 of ~70. Ergoscript test count: ~3174. Total monorepo: ~3752.

**JVM-alignment — mismatched-numeric BinOp coercion** (2026-06-01, additive; behavior change on existing Arith / Relation arms, no new `EvalError` codes):

- A BinOp with two numeric operands of different width (e.g. raw `Plus(Int, Long)`, `Lt(Int, Long)`, `EQ(Int 5, Long 5)`) is now **coerced at eval** for pre-V3 trees (`ctx.treeVersion < 3`): the narrower operand is upcast to the wider, one `Upcast` cost is charged (10, or 30 for a BigInt target), and the op runs at the wider kind. Mirrors the JVM deserializer `DeserializationSigmaBuilder.applyUpcast` (`SigmaBuilder.scala:750-756`), which inserts the Upcast for tree versions 0/1/2 only. Previously ergots rejected (Arith / ordering threw `'bin-op-kind-mismatch'`) or returned `false` (`Eq`/`NEq`) at all versions — stricter than the JVM, a latent consensus-split vector for hand-crafted pre-V3 trees. Tree stays RAW (byte-roundtrip holds); coercion is eval-time only.
- Cost = `cost(same-width op at the wider kind) + Upcast(10|30)`. Arith additionally takes its op-rate at the wider kind (BigInt rate flip: Plus/Minus 15→20, Mult/Div/Mod 15→25, Max/Min 5→10); Relation-ordering stays fixed-20; `Eq`/`NEq` charge the wider eq rate (`EQ_PRIM` 3 / `EQ_BIGINT` 5). `evalConst` is flat 5, so e.g. `Plus(Int, Long)` v0 = 35, `EQ(Int 5, Long 5)` v0 = 23 → `true`.
- For `treeVersion >= 3` the mismatch is still rejected (Arith / ordering throw `'bin-op-kind-mismatch'`; `Eq`/`NEq` still return `false`). The residual `Eq`/`NEq`-returns-false at V3+ and the V3+ dead-branch parse-reject for ordering/equality are **deferred "mechanism #2"** (JVM rejects these at deserialize via a `check2(SameType)` constraint — a parser-layer change). **Bit** ops are NOT in the upcast class (`BitOp` bypasses `applyUpcast`).
- Shared helpers `widerKind` + `upcastCost` in `eval/bin-op/_numeric.ts` (the latter now the single source of the 10/30 literals, also used by `eval/upcast.ts`). The JVM-correct cases live in `packages/ergoscript/test/eval/bin-op-mismatched-numeric-coercion.test.ts` — sigma-rust rejects them, so `fixture-gen` cannot emit them; 6 now-divergent entries were removed from `fixture-gen` + the committed `bin-op-arith.json` / `bin-op-relation.json`. To be re-blessed into `test/conformance/` when the SANTA vector lands. Spec: `docs/specs/2026-06-01-ergoscript-mismatched-numeric-coercion-design.md`.

**JVM-alignment #2 — comparison/equality SameType strictness** (2026-06-02, additive; a pre-eval whole-tree validation pass, no new `EvalError` codes):

- The deferred half of the mismatched-numeric work. The JVM deserializer rejects mismatched comparison/equality at **deserialize** via `check2` (`equalityOp` → `check2(SameType)`; `comparisonOp` → `check2(OnlyNumeric)` + `check2(SameType)`; `SigmaBuilder.scala:679/689`, `ConstraintFailed` at `:287`) — killing the whole tree before eval, **including never-evaluated branches**. After #1, ergots still over-accepted: `Eq`/`NEq` cross-type returned `false` (even when evaluated), and V3+ numeric-mismatch / non-numeric comparison in dead branches were never seen. That's an adversary-reachable consensus-split vector (a box's proposition bytes are attacker-controlled, and ergots parses + evaluates them when validating a spend — so ergots over-accepts a spend the JVM rejects).
- New `eval/validate-bin-op-types.ts`: `validateBinOpTypes(body, treeVersion)` walks the whole Expr tree (via the now-exported `childrenOf` from `_substitute-deserialize.ts`) and throws on a mismatched `Relation` node. Wired into `dispatchTreeBody` (`eval/evaluate.ts`) on the **post-substitution** body, BEFORE `tryTrivialReduce`/`evalExpr` and before any cost — so a rejected tree yields no value and **zero JIT cost** (no cost-fixture impact). NOT in `parseTree`: the wire parser stays permissive (byte-roundtrip is load-bearing).
- Rule (via `exprTpe`, codes reused — compact taxonomy): `Eq`/`NEq` reject `'bin-op-kind-mismatch'` when operand types differ, **unless** both numeric AND `treeVersion < 3` (#1 coerces those at eval). `Lt`/`Le`/`Gt`/`Ge` reject `'bin-op-not-numeric'` on a concretely-non-numeric operand (`OnlyNumeric`) and `'bin-op-kind-mismatch'` on a numeric-mismatch at `treeVersion >= 3`. Arith/Bit/Logical untouched (no JVM `check2`). The #1 eval arms stay as the runtime fallback.
- **Faithfulness bound:** an operand whose static type resolves to `SAny` (the unresolved-MethodCall/PropertyCall cascade) is SKIPPED, never rejected, to avoid false positives (`reference_sany_type_checks_skip_not_fail`). So ergots rejects only where it has concrete operand types; a dead-branch mismatch behind an `SAny`-typed operand still evades until `exprTpe` is widened (A3's deferred type-var engine). Adversarial-only either way; no honest/mainnet path. Full suite unaffected (node 4153 / jsdom 3442) — zero false positives on valid trees. Spec: `docs/specs/2026-06-02-ergoscript-binop-sametype-strictness-design.md`.

**Does NOT ship yet (deferred):**

- Broader method-call surface: `Coll.zipWith` / `.reverse` / `.get` (V3-gated), `SNumericTypeMethods` Bit shifts, additional `SBox`/`SPreHeader` methods. (`Coll.patch` [iter-28], `Coll.updated`, `Coll.updateMany`, `SGroupElement.negate` are now implemented.) Wait until corpus demand resurfaces.
- BinOp `Bit` shift ops via `SNumericTypeMethods` — when method-call dispatch surface expands.
- `Box` / `AvlTree` equality comparison (currently `'not-implemented-yet'` from `sValueEquals`) — when chain-state model fully lands.
- Real-context cost validation (Layer C3) — phase 2j calibration.
- Long-tail parse-rejecting / deprecated arms (`OpTrue`/`OpFalse`/`UnitConstant`, `Select1-5`, `ModQ` family, `CollShift`/`CollRotate`) — phase 2i-d.

**Phase A3 — MethodCall/PropertyCall return-type resolver** (additive; value/representation only, NOT cost; 2026-06-01):

- New `mir/method-signatures.ts`: a declarative `MethodSignature { tDom, tRange, tpeParams? }` catalog keyed by `(typeId, methodId)`, transcribing sigma-rust's `SMethodDesc.tpe`. `exprTpe` now consults it for both the `MethodCall` and `PropertyCall` arms via `resolveReturnTpe`, which returns a CLOSED `tRange` verbatim and falls back to `SAny` (the load-bearing cascade) for an unregistered method OR a type-var `tRange` (substitution engine deferred — no generic-output method registered yet).
- Populated: `SGroupElement.getEncoded` (7:2) → `Coll[SByte]`; `SColl.indices` (12:14) → `Coll[SInt]`. Both have a closed `tRange`, so no substitution is exercised this phase.
- Closes SANTA v5 item **A3**: empty-input `flatMap` now returns the lambda body's static elem type (e.g. `Coll[SByte]`) instead of `Coll[SAny]`, matching JVM `sigma-state-6.0.3`. Resolves the R3(b) note above. **Value-only — zero cost change** (conformance `Coll()#0` cost stays 149; flatMap eval cost stays 70).
- **Dual-table sync invariant:** the signature catalog (`mir/method-signatures.ts`) and the method-handler registry (`eval/method-call.ts`) share the `(typeId, methodId)` namespace. A handler MAY exist without a signature (eval-only; the call's static type stays `SAny`), but every signature MUST agree with its handler's runtime element type (the static `tRange` equals the `elem`/shape the handler constructs). Mechanical enforcement is future work.
- No new `EvalError` codes; no new method handlers (registry unchanged). Ergoscript test count: 3413.

**Phase A3 COMPLETE.** See `docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md`.

**Phase v5 Coll/GroupElement methods — `negate` / `updated` / `updateMany`** (additive; 3 new method handlers + 2 new `EvalError` codes; 2026-06-02):

- 3 new method handlers (registry → **54** actual `HANDLERS` registrations):
  - **`SGroupElement.negate` (7:5)** — Pattern A `FixedCost(45)`; additive inverse `−P` via `decodePoint → pointNegate → encodePoint` (flips the SEC1 parity prefix byte; identity → identity).
  - **`SColl.updated` (12:20)** — Pattern B `addPerItemCost(20, 1, 10, n)` on input length; copy with index `i` replaced by `v`; OOB index → `'coll-update-index-out-of-range'` (a NEGATIVE index wraps to a huge `usize` in sigma-rust ⇒ also OOB).
  - **`SColl.updateMany` (12:21)** — Pattern B `addPerItemCost(20, 2, 10, n)` on input length; sequential replace of each `indexes[k]` with `values[k]` (last write wins on a repeated index); errors on indexes/values length mismatch (`'coll-update-many-length-mismatch'`), then per-index OOB (`'coll-update-index-out-of-range'`).
- **Cost gotcha:** `updateMany`'s perChunkCost is **2**, NOT 1 — `sigma/ast/methods.scala:1055` (canonical JVM), and sigma-rust `ergo-node-integration` agrees. The stale vendored `external/sigma-rust @ integration/ergots` checkout reads `1`; do NOT source cost from it. The n=14 conformance vector (cost 160) pins perChunk=2 (1 would give 159).
- **Deliberate deviation:** `updateMany`'s sigma-rust input/values elem-type-mismatch check is OMITTED — unreachable for type-checked trees, untested by the vectors, and a strict `SType` compare would false-positive against `SAny`-typed colls (`reference_sany_type_checks_skip_not_fail`).
- 2 new `EvalError` codes (64 → 66): `'coll-update-index-out-of-range'`, `'coll-update-many-length-mismatch'`.
- These are valid v5 language methods (ErgoTree-v2-evaluable) but **unused on mainnet** — the tip-reaching walk never exercised them; implementing now closes a latent missing-arm halt. Validated against the JVM-blessed SANTA conformance vectors (`test/fixtures/conformance/v5/{GroupElement.negate,Coll_updated,Coll_updateMany}_*.json`, 27 entries) via `test/conformance/cost-v5.test.ts`. Ergoscript test count: node 3469 / jsdom 3469.

**Phase v5 Coll/GroupElement methods COMPLETE.**

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
- **Coverage caveat:** 67 of 67 implementable `Expr` variants have implemented arms. 19 wire opcodes (ModQ family, OpTrue/False, UnitConstant, Select1-5, CollShift/Rotate families, FunDef, SomeValue, NoneValue) are reserved in sigma-rust's `OpCode` enum but unconditionally parse-rejected — sigma-rust itself never dispatches them. We mirror via `ExprParseError 'opcode-reserved'`. A further 4 (LastBlockUtxoRootHash, FlatMap, TrivialPropFalse, TrivialPropTrue) are routed through other dispatch paths in sigma-rust (PropertyCall id 9, SColl method-call, SSigmaProp nesting); their top-level direct-dispatch `'not-implemented-yet'` status remains under separate review. Trees whose body reaches a not-yet-implemented method-call handler or an eval path with a defensive `EvalError 'not-implemented-yet'` (5 sites: `eval.ts:229`, `global-vars.ts:136`, `bin-op/relation.ts` ×2, `bin-op/bit.ts:58`) still throw at runtime. The `evaluate` signature itself is stable; phase 2j adds cost calibration.

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
  headers?: Header[]             // phase 2h-c.1 — block headers (sigma-rust [Header; 10] simulated as Header[])
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
  | { kind: 'Header'; value: Header }               // phase 2h-c.1 — Header value carrier
```

`Expr` is the 68-variant discriminated union over MIR nodes, keyed on `tag`. Each variant's payload mirrors sigma-rust's `mir/<variant>.rs` struct fields. Full list and per-variant shapes live in `packages/ergoscript/src/mir/types.ts`; adding a variant requires corresponding arms in `wire/parse.ts` and `wire/serialize.ts` (both files use exhaustive switches to make additions compile-time-visible).

- `constantTypes` (on `ErgoTree`) is parallel to `constants[]` and carries the per-constant `SType` recovered from the wire. It's necessary because a parsed `SValue` does not unambiguously encode its `SType` for some edge cases (empty `Coll`, `None` for `SOption`).
- `ErgoBox`, `AvlTreeData`, and `Closure` are forward-declared in phase 2a. Their shapes are stable; evaluator-only fields may be added in later phases.
- `PreHeader` (added phase 2f medium; wrapped in `SValue.PreHeader` variant in phase 2g.6): `{ version, parentId: Uint8Array(32), timestamp: bigint, nBits, height, minerPk: Uint8Array(33), votes: Uint8Array(3) }`.
- `ContextExtension` (added phase 2f medium): `{ values: Record<number, { tpe: SType; value: SValue }> }` — keyed by varId, same `{ tpe, value }` shape as `ErgoBox.registers`.

## `EvalError` taxonomy (66 codes)

`EvalError` carries a `code: string` distinct from the wire-layer error classes. Every code below is emitted by current source under the conditions noted.

### Phase 2b codes

- **`'not-implemented-yet'`** — central dispatch (`eval/eval.ts`) hit an `Expr` variant with no arm yet (~10 variants remaining after phase 2i-a). Message includes the offending `tag`.
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
- **`'bin-op-kind-mismatch'`** — a BinOp requiring same-kind operands (Arith, Bit, Relation-ordering) got different kinds. **Mismatched-NUMERIC operands are version-gated** (mirrors the JVM deserializer's auto-upcast, `DeserializationSigmaBuilder.applyUpcast`, `SigmaBuilder.scala:750-756`, gated `ergoTreeVersion < 3`): at `ctx.treeVersion < 3`, Arith / Relation-ordering / `Eq` / `NEq` **coerce** the narrower operand to the wider — charging one `Upcast` (10/30 by target) and evaluating at the wider kind (arith result widens; `Eq`/`NEq` value can flip `false`→`true`) — instead of throwing / returning false. At `treeVersion >= 3` the mismatch is rejected: Arith / ordering throw this code at eval, and **#2's pre-eval pass `validateBinOpTypes`** (2026-06-02) rejects concretely-typed mismatched comparison/equality whole-tree (incl. dead branches) before eval — `'bin-op-kind-mismatch'` for the SameType violation, `'bin-op-not-numeric'` for the ordering OnlyNumeric violation. The eval-arm `Eq`/`NEq`→`false` / coerce behavior now applies only to operands the pass SKIPS (static type `SAny`). **Bit** ops are NOT in the upcast class (`BitOp` bypasses `applyUpcast`) → always this code on mismatch. Non-numeric (or numeric-vs-non-numeric) mismatch is never coerced. Spec: `docs/specs/2026-06-01-ergoscript-mismatched-numeric-coercion-design.md` (#1) + `2026-06-02-ergoscript-binop-sametype-strictness-design.md` (#2).
- **`'bin-op-not-numeric'`** — operand kind not in `{Byte, Short, Int, Long, BigInt}` for an op requiring numeric operands. Also raised pre-eval by #2's `validateBinOpTypes` for an ordering (`Lt`/`Le`/`Gt`/`Ge`) operand whose static type is concretely non-numeric (`OnlyNumeric`).
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

### Phase 2h-c.1 codes (SHeader.* method handlers)

- **`'header-obj-not-header'`** — defensive receiver check on all 15 SHeader handlers when `obj.kind !== 'Header'`. Wire-format invariants make this unreachable for parser-produced trees.

### Phase 2h-c.2 codes (SHeader.checkPow)

- **`'autolykos-v1-not-supported'`** — `SHeader.checkPow` handler caught an `AutolykosV1NotSupportedError` from `verifyAutolykosV2`. Mirrors sigma-rust's `AutolykosPowSchemeError::Unsupported` (`autolykos_pow_scheme.rs:322-324`). Real Ergo nodes (incl. ergo-node-rust) skip v1 PoW verification structurally; this code is the surface for the unusual case where `ctx.headers` includes a V1 header AND the script invokes `checkPow` on it.

### Phase 2h-d codes (SAvlTree.updateDigest)

- **`'avl-tree-bad-digest-length'`** — `SAvlTree.updateDigest` handler received a `newDigest: Coll[Byte]` whose length is not 33 bytes. Mirrors sigma-rust's `ADDigest::try_from` length-check failure (`eval/savltree.rs:90-102`). Wire-format invariants do NOT make this unreachable — the caller supplies the digest at eval-time as a script-constructed `Coll[Byte]`, so any 0..n-byte value is a legitimate input shape.

### Phase 2i-a codes (pure-bytes predefs)

- **`'predef-input-not-byte-array'`** — defensive `Coll[Byte]` kind-check shared by 6 of the 8 new arms: `CalcBlake2b256` (T2; primary owner), `CalcSha256` (T3), `ByteArrayToLong` (T4), `ByteArrayToBigInt` (T6), `Xor` (T7, both operands), `DecodePoint` (T8). Defaultable via the optional 3rd arg of the new `collByteToUint8Array` helper. Wire-format invariants make this unreachable for parser-produced trees.
- **`'byte-array-to-long-too-short'`** — `ByteArrayToLong` arm: input `Coll[Byte]` had `length < 8`. Charged Pattern A cost 16 BEFORE the throw.
- **`'predef-input-not-long'`** — `LongToByteArray` arm: input `SValue.kind !== 'Long'`. Unreachable from parser-produced trees.
- **`'byte-array-to-bigint-empty'`** — `ByteArrayToBigInt` arm: input `Coll[Byte]` had length 0. Distinct from the out-of-range code so callers can distinguish "empty input" from "value out of i256 bounds".
- **`'byte-array-to-bigint-out-of-range'`** — `ByteArrayToBigInt` arm: signed-BE-decoded bigint fell outside `[I256_MIN, I256_MAX]` = `[-2^255, 2^255 - 1]`. Sigma-rust mirror: `byte_array_to_bigint.rs` range-check after decode.
- **`'decode-point-invalid'`** — `DecodePoint` arm: the 33-byte SEC1-compressed input failed `decodePoint` adapter validation (non-zero33 AND non-decodable per `crypto/secp256k1.ts`). Charged Pattern A cost 300 BEFORE the throw.
- **`'subst-constants-error'`** — `SubstConstants` arm: compact taxonomy code covering 6 distinct throw paths (positions vs newValues length mismatch; type mismatch between newValues' element type and the template's constant type at that position; newValues' input not a Coll; positions' input not a Coll; scriptBytes' input not Coll[Byte]; serializer-level substitution error from `substituteConstantsBytes` — bad template bytes / too-many-constants). Out-of-range positions are a no-op, NOT a throw (JVM parity, A2). Per the 2g.5 compact-taxonomy decision — these are all "the input shape doesn't satisfy SubstConstants' contract" and are not branched-on by callers.

### Phase 2i-b codes (curve + AVL + sigma-trivial predefs)

- **`'sigma-prop-is-proven-no-eval'`** — `SigmaPropIsProven` arm always throws structurally. No `e.input` evaluation, no cost charged. Mirrors sigma-rust `sigma_prop_is_proven.rs:11-25` `Misc("SigmaPropIsProven has no interpreter eval...")`. Op-code 95 is reserved in the IR for byte-match parity with Scala sigmastate, whose typer rewrites `prop.isProven` to a `SigmaPropIsProven` node; the AOT graph-IR rewrite elides the node before evaluation.
- **`'group-op-input-not-group-element'`** — `MultiplyGroup` (both operands) and `Exponentiate` (base) when input `kind !== 'GroupElement'`. Distinct from `'sigma-prop-input-not-group-element'` (2g-medium) which is for sigma-prop creation arms (`CreateProveDlog` / `CreateProveDhTuple`). Wire-format invariants make this unreachable for parser-produced trees.
- **`'predef-input-not-bigint'`** — `Exponentiate` arm when exponent `kind !== 'BigInt'`. Future arms in the `ModQ` family (phase 2i-d) will reuse.
- **`'create-avl-tree-shape-mismatch'`** — `CreateAvlTree` arm. Compact code covering 3 throw paths: non-Byte flags, non-Int keyLength, non-Int valueLength. `.message` carries the specific field name for debugging. (Coll[Byte] check on digest reuses `'predef-input-not-byte-array'`; digest length check reuses `'avl-tree-bad-digest-length'`.)

`TreeLookup` introduces ZERO new codes — reuses `'avl-tree-obj-not-avl-tree'` (2h-b; non-AvlTree receiver), `'predef-input-not-byte-array'` (2i-a; non-Coll[Byte] key/proof), and `'avl-tree-proof-failed'` (2h-b; verifier construct failure).

### Phase 2i-c codes (deserialize family)

- **`'deserialize-context-key-not-found'`** — `DeserializeContext` substitute pass: `ctx.extension.values[e.id]` is undefined. Mirrors sigma-rust `SubstDeserializeError::ExtensionKeyNotFound(id)` at `mir/expr.rs:457`. Message includes the id for symmetry.
- **`'deserialize-input-not-byte-array'`** — `DeserializeContext` / `DeserializeRegister` substitute pass: the context-extension entry / register entry's `tpe` is not `SColl<SByte>` (or its `value` is not a `Coll` with Byte items). Mirrors sigma-rust `SubstDeserializeError::TryExtractFromError` via `try_extract_into::<Vec<u8>>()` failure at `mir/expr.rs:459` (DC) and `:472` (DR).
- **`'deserialize-parse-failed'`** — `DeserializeContext` / `DeserializeRegister` substitute pass: the inner Expr bytes (decoded from `ctx.extension` or `selfBox.registers`) fail to parse. Wraps the underlying wire-layer error class + message in `.message`. Mirrors `SubstDeserializeError::ExprParsingError(SigmaParsingError)` at `mir/expr.rs:725` and the inner parse calls at `:462-464` (DC) / `:474` (DR).
- **`'deserialize-tpe-mismatch'`** — `DeserializeContext` / `DeserializeRegister` substitute pass: `exprTpe(parsed) !== e.tpe`. Check runs on BOTH the register-decoded inner Expr AND the `default` fallback Expr (per `mir/expr.rs:486-491` — applied post-`.or(default.as_deref().cloned())`). Mirrors `SubstDeserializeError::ExprTpeError { expected, actual }` at line 727.
- **`'deserialize-not-substituted'`** — `DeserializeContext` / `DeserializeRegister` eval-time defensive throw. Reached when the substitute pass did NOT rewrite a node. Two cases: (a) `DeserializeRegister` with register absent + `e.default === null` — sigma-rust `substitute_deserialize` returns `Ok(())` LEAVING the node unchanged per `mir/expr.rs:478-481` ("When script in register is not found, and default is not defined, leave DeserializeRegisterNode unchanged, which will error on evaluation"); the defensive throw is the canonical mirror. (b) Recursive Deserialize: an outer Deserialize* decoded to an inner Expr containing another Deserialize* node — sigma-rust's `try_rewrite_bu` does NOT re-walk substituted children (`mir/expr.rs:397-408`), so the inner Deserialize survives and trips this throw.

### Phase v5 Coll-update codes (Coll.updated / Coll.updateMany)

- **`'coll-update-index-out-of-range'`** — `SColl.updated` (12:20) / `SColl.updateMany` (12:21): a target index is out of bounds for the receiver Coll. Genuine runtime error (indices are runtime `Int` values, not type-constrained); a NEGATIVE index wraps to a huge `usize` in sigma-rust ⇒ also OOB. Source: sigma-rust `UPDATED_EVAL_FN` / `UPDATE_MANY_EVAL_FN` (`eval/scoll.rs`, branch `ergo-node-integration`).
- **`'coll-update-many-length-mismatch'`** — `SColl.updateMany` (12:21): the `indexes` and `values` colls differ in length (genuine runtime error — lengths aren't constrained by the `Coll[T].updateMany(Coll[Int], Coll[T])` signature). Checked before the per-index OOB loop. Source: same.

No other error codes are emitted by the v0.2.0 evaluator. Internal panics (e.g. a bug in a wire-layer helper called from an arm) bubble up as their typed error class — those represent contract violations and are bugs, not eval-input issues.

## Dispatcher minVersion gating (phase 2h-c.2)

The method-call dispatcher consults an optional `minVersion?: number` field on each registry entry. When set, the dispatcher throws `EvalError('tree-version-too-low')` if `(ctx.treeVersion ?? 0) < entry.minVersion`, BEFORE invoking the handler. This is sigma-rust-parity with `MethodDesc.min_version`-level gating: V<N reject incurs receiver-eval cost + envelope cost (4) but NOT the handler's own cost (e.g., 700 for `checkPow`).

Two registry entries currently use `minVersion: 3`: `SHeader.checkPow` (104:16; phase 2h-c.2) and `SAvlTree.insertOrUpdate` (100:16; phase 2h-d) — both mirror sigma-rust descriptors with `min_version: ErgoTreeVersion::V3`. Future V3+ method handlers (e.g., `SContext.getVarFromInput` at 101:12) should prefer this dispatcher path over the in-arm 2e pattern (Upcast/Downcast).

## Method-handler registry (54 entries; table enumerates 52)

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
| 22 | `SHeader.id` | 104:1 | 10 | A | `Coll[Byte]` (32) | `eval/sheader.rs:22-26` |
| 23 | `SHeader.version` | 104:2 | 10 | A | `Byte` (u8→i8) | `:16-20` |
| 24 | `SHeader.parentId` | 104:3 | 10 | A | `Coll[Byte]` (32) | `:28-32` |
| 25 | `SHeader.adProofsRoot` | 104:4 | 10 | A | `Coll[Byte]` (32) | `:34-38` |
| 26 | `SHeader.stateRoot` | 104:5 | 10 | A | `Coll[Byte]` (33) — type-system says SAvlTree but eval returns Coll[Byte] | `:40-44` |
| 27 | `SHeader.transactionsRoot` | 104:6 | 10 | A | `Coll[Byte]` (32) | `:46-50` |
| 28 | `SHeader.timestamp` | 104:7 | 10 | A | `Long` | `:58-62` |
| 29 | `SHeader.nBits` | 104:8 | 10 | A | `Long` | `:64-68` |
| 30 | `SHeader.height` | 104:9 | 10 | A | `Int` | `:70-74` |
| 31 | `SHeader.extensionRoot` | 104:10 | 10 | A | `Coll[Byte]` (32) | `:52-56` |
| 32 | `SHeader.minerPk` | 104:11 | 10 | A | `GroupElement` (33) | `:76-80` |
| 33 | `SHeader.powOnetimePk` | 104:12 | 10 | A | `GroupElement` (33); 33 zero bytes when null | `:82-86` |
| 34 | `SHeader.powNonce` | 104:13 | 10 | A | `Coll[Byte]` (8) | `:88-92` |
| 35 | `SHeader.powDistance` | 104:14 | 10 | A | `BigInt`; `0n` when null | `:94-107` |
| 36 | `SHeader.votes` | 104:15 | 10 | A | `Coll[Byte]` (3) | `:109-113` |
| 37 | `SContext.headers` | 101:2 | 15 | A | `Coll[Header]` from `ctx.headers`; throws `'context-field-missing'` if undefined | `eval/scontext.rs:58-70` |
| 38 | `SContext.lastBlockUtxoRootHash` | 101:9 | 15 | A | `AvlTree` synthesized from `ctx.headers[0].stateRoot`; throws `'context-field-missing'` if undefined/empty | `:83-99` |
| 39 | `SHeader.checkPow` | 104:16 | 700 | A | `Boolean` — V3-gated via `minVersion: 3` on registry; v1 header throws `'autolykos-v1-not-supported'` | `eval/sheader.rs:115-124` |
| 40 | `SAvlTree.updateOperations` | 100:8 | 45 | A | `AvlTree` — projects new `treeFlags`; pure (no `@ergots/avltree` call) | `eval/savltree.rs:77-88` |
| 41 | `SAvlTree.updateDigest` | 100:15 | 40 | A | `AvlTree` — projects new 33-byte digest; throws `'avl-tree-bad-digest-length'` on length ≠ 33 | `eval/savltree.rs:90-102` |
| 42 | `SAvlTree.insertOrUpdate` | 100:16 | 0 | — | `Option[AvlTree]` — V3-gated via `minVersion: 3` on registry; upsert semantics via `verifyAvlBatch` | `eval/savltree.rs:441-498` |
| 43 | `SGroupElement.getEncoded` | 7:2 | 250 | A | `Coll[Byte]` (33 SEC1-compressed) | `eval/sgroup_elem.rs:15-26` |
| 44 | `SColl.flatMap` | 12:15 | `addPerItemCost(60,10,8,n)` | B | `Coll[OV]` (lambda HOF + concat); body-restriction `'lambda-not-callable'` if body is MethodCall with non-empty args; two R3 divergences from sigma-rust on lambda static typing (see Phase 2h-f changelog below) | `eval/scoll.rs:52-136` |
| 45 | `SContext.minerPubKey` | 101:10 | 20 | A | `Coll[Byte]` (33 SEC1-compressed `ctx.preHeader.minerPk`); throws `'context-field-missing'` if undefined | `eval/scontext.rs:101-115` |
| 46 | `SPreHeader.minerPk` | 105:6 | 10 | A | `GroupElement` (raw 33-byte `obj.value.minerPk`; NOT sigma-serialized — contrast row 45 which does) | `eval/spreheader.rs:38-42` |
| 47 | `SContext.selfBoxIndex` | 101:8 | 20 | A | `Int` — 0-based index of `ctx.selfBox` in `ctx.inputs` via reference equality; **gated by `activated_script_version = saturating_sub(preHeader.version, 1)`** — pre-V2 blocks return -1 unconditionally (JVM bug #603 compat; the JVM ref-eq bug was fixed globally in v5.x, so the gate is BLOCK-level not tree-level — `[[feedback-tree-version-gate]]`). Throws `'context-field-missing'` for missing preHeader, missing selfBox/inputs on V2+, or selfBox-not-in-inputs (chain-invariant violation). First exercised on mainnet at h=342,964 — same block where sigma-rust originally diverged from JVM (fixed in their v0.2.0) | `eval/scontext.rs:33-57` |
| 48 | `SPreHeader.parentId` | 105:2 | 10 | A | `Coll[Byte]` (32-byte `obj.value.parentId`, sign-extended per byte via `bytesToCollByteSValue`); contrast row 46 (`SPreHeader.minerPk`) which returns `SGroupElement` of the raw pubkey | `eval/spreheader.rs:14-18` |
| 49 | `SPreHeader.height` | 105:5 | 10 | A | `Int` (`obj.value.height`, JS number passthrough — sigma-rust `as i32`) | `eval/spreheader.rs:32-36` |
| 50 | `SGroupElement.negate` | 7:5 | 45 | A | `GroupElement` (additive inverse `−P`; flips SEC1 parity prefix; identity → identity) | `eval/sgroup_elem.rs` (ergo-node-integration) |
| 51 | `SColl.updated` | 12:20 | `addPerItemCost(20, 1, 10, n)` | B | `Coll[T]` (copy, index `i`→`v`); OOB → `'coll-update-index-out-of-range'` | `eval/scoll.rs` (ergo-node-integration) |
| 52 | `SColl.updateMany` | 12:21 | `addPerItemCost(20, 2, 10, n)` | B | `Coll[T]` (each `idx[k]`→`val[k]`, last-write-wins); len-mismatch → `'coll-update-many-length-mismatch'`, OOB → `'coll-update-index-out-of-range'` | `eval/scoll.rs` (ergo-node-integration) |

(Rows 50-52 are the v5 `negate`/`updated`/`updateMany` handlers. `updateMany` perChunkCost is **2** per the canonical JVM `methods.scala:1055` — the stale vendored `integration/ergots` checkout reads 1; cost was sourced from the JVM + the n=14 conformance vector, not that checkout.)

(Table enumerates 52 rows; the `HANDLERS` map has **54** registrations — 2 interim entries predate this table and remain untabled, a pre-existing doc drift flagged for a future sweep, not chased here.)

(`SColl.zip`'s `n` = obj length, NOT `min(obj, arg)` — Pattern B charges based on obj's length per sigma-rust.)

(The 13 `SAvlTree.*` handlers come from phase 2h-b. Tier-1 accessors 9-15 charge cost 15 BEFORE projecting over runtime `AvlTreeData` fields, no `@ergots/avltree` call. Tier-2 verification ops 16-21 charge zero per-handler cost — cost is owned by the lower-level verifier — and call into `@ergots/avltree` v0.2.0's `verifyAvlBatch` / `verifyAvlBatchPartial`.)

(The 17 handlers from phase 2h-c.1 — entries 22-38 — are 15 `SHeader.*` accessors (typeId 104, methodIds 1-15) at Fixed(10) Pattern A each, plus `SContext.headers` (101:2) and `SContext.lastBlockUtxoRootHash` (101:9) at Fixed(15) Pattern A. The SContext handlers join the existing `SContext.dataInputs` (101:1) and `SContext.preHeader` (101:3) in the registry. Entry 39 from phase 2h-c.2 is `SHeader.checkPow` (104:16) at Fixed(700) Pattern A with `minVersion: 3` dispatcher gating.)

(The 3 `SAvlTree.*` handlers from phase 2h-d — entries 40-42 — close the final three `SAvlTree.*` methods. `updateOperations` (100:8) and `updateDigest` (100:15) are pure Tier-1-shaped projections (cost 45 / 40, Pattern A, no `@ergots/avltree` call); `insertOrUpdate` (100:16) is a Tier-2-shaped upsert (zero per-handler cost) gated at the dispatcher via `minVersion: 3` — sigma-rust ships `InsertOrUpdate` only at V3+.)

(The 2 handlers from phase 2h-f — entries 43-44 — close the two Tier-3 long-tail deferrals from the 2g.6 demand survey. `SGroupElement.getEncoded` (7:2) is a Pattern A Fixed(250) returning the 33-byte SEC1-compressed point as `Coll[Byte]`. `SColl.flatMap` (12:15) is a Pattern B `addPerItemCost(60, 10, 8, n)` lambda HOF with concat semantics + body-restriction (MethodCall body with non-empty args → `'lambda-not-callable'`, mirroring sigma-rust `scoll.rs:78-84`). The handler lives in the new module `eval/scoll-flat-map.ts`; the dispatcher passes `{ mc, env }` via the new optional `extra` arg added to `HandlerFn` in 2h-f T8. The 2g.6 survey labeled this method "flatten" — that was wrong; flatten doesn't exist on the sigma-rust surface. Two divergences from sigma-rust on flatMap's lambda static typing: **(R3a)** the elem-type check `sTypeEquals(input.elem, lambdaArgTpe)` runs only when `mc.args[0]` is an inline `FuncValue` MIR node — skipped for ValUse-source lambdas because the runtime `Closure` SValue has no `argTpes`. Mirrors the existing `coll-map.ts:94-108` convention. **(R3b)** the output elem type from `exprTpe(closure.body)` returns `SAny` for `PropertyCall` and `MethodCall` body shapes (SMethod resolver not yet online in phase 2a; the canonical flatMap body `x.indices` IS a PropertyCall, so SAny is the common case). The handler tolerates SAny pre-loop and refines from `itemRes.elem` after the first iter. **Consequence: empty-input flatMap with a PropertyCall body returns `Coll[SAny]` (sigma-rust returns `Coll[T]` concrete via SMethod resolver — but only the elem-type information is lost; the items field is correct).** Future work: extend `Closure` to carry `argTpes` and/or bring the SMethod resolver online — both also affect MapColl/Filter/Fold/Exists/ForAll's static-typing accuracy.)

## Coverage and stability

**67 of 67 implementable `Expr` variants** have arms (post-2i-c). 19 variants in sigma-rust's `OpCode` enum are reserved-but-never-dispatched and parse-reject via `ExprParseError 'opcode-reserved'`; 4 more (LastBlockUtxoRootHash, FlatMap, TrivialPropFalse, TrivialPropTrue) parse-reject via `'not-implemented-yet'` pending separate review of their top-level direct-dispatch status (routed elsewhere in sigma-rust). The 67 implementable variants:
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
- 8 from phase 2i-a: `CalcBlake2b256`, `CalcSha256`, `ByteArrayToLong`, `LongToByteArray`, `ByteArrayToBigInt`, `Xor`, `DecodePoint`, `SubstConstants`
- 5 from phase 2i-b: `SigmaPropIsProven`, `MultiplyGroup`, `Exponentiate`, `CreateAvlTree`, `TreeLookup`
- 2 from phase 2i-c: `DeserializeContext`, `DeserializeRegister`

Everything else throws `'not-implemented-yet'`. Real-world ErgoTree trees from the `mainnet_boxes` corpus are filtered against this coverage by `test/corpus-eval.test.ts` — only fixtures whose body uses exclusively the supported variants are exercised against the sigma-rust eval oracle for byte-equality. As of phase 2g.6 complete, the mainnet corpus aggregate is `success=18 not-impl=0 other=0` (synthetic-context stubs: `outputs: []`, `inputs: []`, `selfBox: synthetic`, `dataInputs: []`). Phase 2h-b adds 13 method handlers but no new `Expr` arms — coverage remains 52 / ~70; post-2h-b uplift to C2 corpus TBD on next corpus run. Phase 2h-c.1 adds 17 more method handlers but no new `Expr` arms — coverage remains 52 / ~70; post-2h-c.1 uplift to C2 corpus TBD on next corpus run. Phase 2h-c.2 adds 1 more method handler but no new `Expr` arms — coverage remains 52 / ~70. Phase 2h-d adds 3 more method handlers (closing the final three `SAvlTree.*` methods) but no new `Expr` arms — coverage remains 52 / ~70. Phase 2h-f adds 2 more method handlers (`SGroupElement.getEncoded` + `SColl.flatMap`) but no new `Expr` arms — coverage remains 52 / ~70. Phase 2i-a adds 8 new `Expr` arms (pure-bytes predefs) — coverage advances to 60 / ~70; post-2i-a uplift to C2 corpus TBD on next corpus run.

**Method-handler registry: 49 entries** (was 8 before 2h-b; +13 from 2h-b — 7 Tier-1 accessors at typeId:methodId 100:1..100:7 + 6 Tier-2 verification ops at 100:9..100:14; +17 from 2h-c.1 — 15 `SHeader.*` accessors at 104:1..104:15 + 2 `SContext.*` additions at 101:2 and 101:9; +1 from 2h-c.2 — `SHeader.checkPow` at 104:16; +3 from 2h-d — `SAvlTree.updateOperations` at 100:8, `SAvlTree.updateDigest` at 100:15, and `SAvlTree.insertOrUpdate` at 100:16 with dispatcher `minVersion: 3` gating; +2 from 2h-f — `SGroupElement.getEncoded` at 7:2 and `SColl.flatMap` at 12:15; +1 from 2j-b arm-coverage parallel session — `SContext.minerPubKey` at 101:10, Pattern A cost 20 returning the 33-byte SEC1-compressed `ctx.preHeader.minerPk` as `Coll[Byte]`; mirrors sigma-rust `MINER_PUBKEY_EVAL_FN`. Surfaced as a halt at mainnet h=208788; +1 from 2j-b iter-4 arm-coverage parallel session — `SPreHeader.minerPk` at 105:6, Pattern A cost 10 returning the raw 33-byte miner pubkey as `SGroupElement` (NOT sigma-serialized — receiver-side counterpart to row 45 which returns `Coll[Byte]`); mirrors sigma-rust `MINER_PK_EVAL_FN`. Surfaced as a halt at mainnet h=228633; +1 from 2j-b iter-5 arm-coverage parallel session — `SContext.selfBoxIndex` at 101:8, Pattern A cost 20 returning 0-based `ctx.inputs.indexOf(ctx.selfBox)` gated by `activated_script_version >= 2`; mirrors sigma-rust `SELF_BOX_INDEX_EVAL_FN`. Surfaced as a halt at mainnet h=342,964; +1 from 2j-b iter-10 arm-coverage parallel session — `SPreHeader.parentId` at 105:2, Pattern A cost 10 returning the 32-byte `ctx.preHeader.parentId` as `Coll[Byte]` (contrast row 46 `SPreHeader.minerPk` which returns `SGroupElement` of raw pubkey); mirrors sigma-rust `PARENT_ID_EVAL_FN`. Surfaced as a halt at mainnet h=679,337; +1 from 2j-b iter-11 arm-coverage parallel session — `SPreHeader.height` at 105:5, Pattern A cost 10 returning `obj.value.height` as `Int` (sigma-rust `as i32`); mirrors sigma-rust `HEIGHT_EVAL_FN`. Surfaced as a halt at mainnet h=679,837).

**Public function signatures are stable** from v0.2.0 onward. Future arms slot into central dispatch (`eval/eval.ts`) without changing `evaluate`, `evaluateWith`, `makeContext`, or `EvalError`.

**`EvalOpts` is open for additive growth.** Phase 2e added `treeVersion?: number`. Phase 2f medium added 6 chain-state fields. Phase 2g.5 added `dataInputs?: ErgoBox[]`. Phase 2g.6 added no new fields (the existing `preHeader?: PreHeader` from 2f medium is consumed by the new `SContext.preHeader` handler). Phase 2h-b added no new fields (the `SAvlTree.*` handlers receive the receiver `AvlTreeData` through the method-call arg surface, not via context). Phase 2h-c.1 added `headers?: Header[]`.

**`@noble/curves@2.2.0` added in phase 2g-medium.** Version-locked with `@noble/hashes@2.2.0`. Used by the secp256k1 adapter (`crypto/secp256k1.ts`) and the sigma verifier (see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md)).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting guarantees
- [`facts/ergoscript-wire.md`](./ergoscript-wire.md) — wire format (parseTree, serializeTree, ErgoTreeParseError/SerializeError)
- [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) — sigma-protocol verifier (`SigmaBoolean`, `verifySignature`, `VerifyError`)
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` — method-call dispatcher
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — phase 2g.6 (5 new method handlers + Global arm)
- `docs/specs/2026-05-20-ergoscript-phase-2i-a-pure-bytes-predefs-design.md` — most recent eval phase (8 new Expr arms: hash predefs + byte<->numeric conversions + Xor + DecodePoint + SubstConstants)
