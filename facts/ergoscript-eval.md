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
- `sValueEquals` recursive structural comparer covering primitives, `GroupElement` (byte-equal), `SigmaProp` (byte-equal on opaque `.raw`) **(superseded F3 2026-06-07: recursive costed SigmaBoolean walk + identity-class ECPoints; see the F3 changelog line)**, `Coll`, `Tuple`, `Option`. Cross-kind comparison returns `false` (no coercion) — **later version-gated (2026-06-01): at `ctx.treeVersion < 3`, mismatched-NUMERIC `Eq`/`NEq` operands are coerced to the wider kind before comparison (JVM pre-V3 auto-upcast); see the `'bin-op-kind-mismatch'` taxonomy entry.** `Box` / `AvlTree` throw `'not-implemented-yet'` **(2c snapshot — superseded: structural equality via `boxEqual`/`avlTreeEqual`/`preHeaderEqual`/`headerEqual` landed phase 2e/2h)**. Cost charged per sigma-rust's `data_value_comparer.rs` constants.
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

- 9 more arms wired: `SizeOf` (Fixed(14) Pattern A), `Append` (`addPerItemCost(20, 2, 100, result.length)` Pattern A), `ByIndex` (Fixed(30) Pattern A), `Slice` (`addPerItemCost(10, 2, 100, result.length)` Pattern A), `MapColl` / `Filter` / `Fold` / `Exists` / `ForAll` (Mixed: outer `addPerItemCost(20, 2, 128, input.length)` Pattern A + per-iter Fixed(1) Pattern B).
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
  - **Tier 2 — 6 verification ops** (zero per-handler cost — **superseded by F4** 2026-06-07: Tier-2 now charges the JVM cost model; see the Tier-2 cost footnote): `contains` (100:9), `get` (100:10), `getMany` (100:11), `insert` (100:12), `update` (100:13), `remove` (100:14). Call into `@ergots/avltree` v0.2.0's `verifyAvlBatch` / `verifyAvlBatchPartial`.
- `AvlTreeData` runtime shape promoted from phase-2a forward-declaration to stable: `{ digest: Uint8Array(33), treeFlags: u8, keyLength: u32, valueLengthOpt: u32 | null }`.
- `_avltree-adapter.ts` added: 10 pure helpers bridging `AvlTreeData` → `@ergots/avltree`'s API (`avlTreeDataToConfig`, `buildLookupOps`, `buildInsertOps`, `buildUpdateOps`, `buildRemoveOps`, `withUpdatedDigest`, `extractBytes`, `extractByteArrayList`, `extractEntries`, `buildSingleLookupOp`).
- 2 new `EvalError` codes: `'avl-tree-obj-not-avl-tree'` (defensive), `'avl-tree-proof-failed'` (verifier failure). 43 → 45 total.
- Source-read corrections during implementation:
  - `contains` DOES throw on verifier construct failure (only per-op fail returns `false`). **[Superseded by F4:** construct failure now returns `false` like per-op fail — the JVM has no construct-throw path; the throw was the sigma-rust `?`-on-construct fork.**]**
  - `update` has NO V<3/V3+ split — always graceful break (returns Option None on per-op fail).
  - V3+ partial-success on `insert`/`update` returns `Option None`, NOT `Some(AvlTree with partial digest)` — sigma-rust poisons `root = null` on failure, post-loop digest is None.
  - `remove` confirmed: no V3+ break path; per-op fail always throws. **[Superseded by F4:** remove never throws — construct AND per-op failures → Option None; per-op results discarded (JVM `cfor`, no fast-break).**]**
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
  - **`SAvlTree.insertOrUpdate` (100:16)** — zero per-handler cost, **V3-gated at the dispatcher** (registered with `minVersion: 3`; pre-V3 trees reject via `'tree-version-too-low'` before the handler runs, incurring receiver-eval + dispatcher-envelope cost only). Calls into `@ergots/avltree`'s `verifyAvlBatch` with `InsertOrUpdate` ops (sigma-rust's `Operation::InsertOrUpdate` = upsert: insert when absent, update when present). Returns `Option[AvlTree]`; per-op failure surfaces as Option None (no throw); verifier construct failure throws `'avl-tree-proof-failed'`. Source: `eval/savltree.rs:441-498`; descriptor at `types/savltree.rs:377-403` with `min_version: ErgoTreeVersion::V3`. **[Superseded by F4** 2026-06-07: now charges isUpdateAllowed(15) + isInsertAllowed(15) + createVerifier PerItem(110,20,64) + UpdateAvlTree PerItem(120,20,1)×charged-ops + updateDigest Fixed(40) on success; construct failure → Option None, never throws. See registry row 100:16 + the Tier-2 cost footnote.**]**
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
  - **`CreateAvlTree`** — no inline cost (children-only). 4-input value constructor (Byte flags, Coll[Byte] digest, Int keyLength, Option[Int] valueLength). **AvlTreeFlags canonicalized to bits 0..2** via `flagsV.value & 0x07` — mirrors sigma-rust's `AvlTreeFlags::parse → new` round-trip stripping reserved bits 3..7 (`mir/avl_tree_data.rs`). KeyLength + valueLength use `>>> 0` (u32 bit-cast) — matches sigma-rust's `i32 as u32`. Digest length check (33 bytes) throws `'avl-tree-bad-digest-length'` (reused from 2h-d). **[Superseded by the F4 epilogue** 2026-06-07: the arm now rejects unconditionally with `'unsupported-eval-node'` — the JVM has no eval override (trees.scala:79-91); the sigma-rust evaluating arm was a convergent over-accept. The node's WIRE layout was also corrected (sigma-rust presence-tag → JVM 4-expr operands; see `facts/ergoscript-wire.md`).**]**
  - **`TreeLookup`** — no inline cost (children-only + verifier delegation). Thin wrap over `@ergots/avltree` v0.2.0's `verifyAvlLookup`. Double-null semantic: outer `null` (proof construct failure) throws `'avl-tree-proof-failed'`; inner `.value === null` (proof OK, key absent) returns `Option None`; `.value: Uint8Array` (key found) returns `Option Some<Coll[Byte]>`. Output element type: `SColl[SByte]`. **[Superseded by the F4 epilogue** 2026-06-07: the arm now rejects unconditionally with `'unsupported-eval-node'` — the JVM has no eval override (trees.scala:1322-1338); the sigma-rust evaluating arm was a convergent over-accept. `verifyAvlLookup` no longer has an ergoscript caller (the `@ergots/avltree` export stays).**]**
- 4 new `EvalError` codes (55 → 59):
  - `'sigma-prop-is-proven-no-eval'` (T2) — structural-throw code, mirrors sigma-rust's `Misc("SigmaPropIsProven has no interpreter eval...")` for byte-match-parity opcode 95.
  - `'group-op-input-not-group-element'` (T3 + T4) — shared by MultiplyGroup (both operands) and Exponentiate (base). Distinct from `'sigma-prop-input-not-group-element'` (2g-medium) which is for sigma-prop creation arms.
  - `'predef-input-not-bigint'` (T4) — Exponentiate's BigInt exponent. Future arms in the `ModQ` family (phase 2i-d) will reuse.
  - `'create-avl-tree-shape-mismatch'` (T5) — compact code covering 3 throw paths in CreateAvlTree (non-Byte flags, non-Int keyLength, non-Int valueLength); `.message` carries the specific field name. **[Superseded by the F4 epilogue 2026-06-07: the CreateAvlTree arm became an unconditional `'unsupported-eval-node'` reject (no JVM eval override), orphaning all 3 throw paths — code REMOVED from the taxonomy.]**
- 0 new method-handler registry entries (44 unchanged).
- Two pre-existing TS-from-sigma-rust divergences acknowledged (neither introduced by 2i-b):
  - **`DecodePoint` identity convention** — inherited from 2i-a. Affects `MultiplyGroup` and `Exponentiate` base decode (both use `decodePoint`). Pre-existing across verifier surface. **Resolved in phase 2i-d** — see the 2i-a section above and the central docstring at `crypto/secp256k1.ts:decodePoint` for the full rationale.
  - **`CreateAvlTree` keyLength bit-cast** — sigma-rust accepts negative i32 → huge u32 via `as u32` bit-cast; TS mirrors via `>>> 0`. Validated by oracle fixture `cat_negative_keylength`. **[Retired in the F4 epilogue** — the arm rejects unconditionally; the bit-cast code path and fixture are gone.**]**
- **Process finding (worth tracking as a follow-up):** sigma-rust `fixture-gen`'s `force_any_val::<T>()` is NOT deterministic across runs (`TestRunner::default()` uses a fresh proptest seed). Encountered repeatedly in T3 / T4 / T6. T4 worked around by hardcoding payloads; T3's `mg_random_random` fixture has the latent issue (the value byte-flips between two equivalent point orderings on regeneration). Not yet remediated.

**Phase 2i-b COMPLETE.** Method handler registry: 44 entries (unchanged). EvalError codes: 59. Eval arm coverage: 65 of ~70. Ergoscript test count: 3142. Total monorepo: 3720.

**Phase 2i-c — Deserialize family** (additive):

- 2 new eval arms wired (coverage 65 → 67 of ~70 `Expr` arms): `DeserializeContext`, `DeserializeRegister`.
- **Architecture: substitute-pre-pass.** Mirrors sigma-rust `eval.rs:203-250` + `mir/expr.rs:442-496`. New module `eval/_substitute-deserialize.ts` exports `treeHasDeserialize(tree)` and `substituteDeserialize(body, tree, ctx)`. `evaluate` / `evaluateWith` dispatch to a substitute-then-eval path when `treeHasDeserialize(tree)` is true; the rewritten body goes through `tryTrivialReduceExpr` (T5 refactor extracted from `tryTrivialReduce`) + `evalExpr`. The Deserialize* eval arms are **defensive throws** (`'deserialize-not-substituted'`) reachable only when substitution did NOT rewrite a node — either (a) `DeserializeRegister` with register absent + `default` null (sigma-rust `expr.rs:478-481` LEAVES the node unchanged), or (b) a Deserialize* node lurking inside an already-substituted inner Expr (sigma-rust's `try_rewrite_bu` does NOT re-walk substituted children).
- 5 new `EvalError` codes (59 → 64):
  - `'deserialize-context-key-not-found'` — DC arm: `ctx.extension.values[id]` undefined. Mirrors sigma-rust `SubstDeserializeError::ExtensionKeyNotFound`. **NOTE: REMOVED in F1 Task 3 (2026-06-06)** — the correct JVM behavior is to leave the node unchanged when the ctx var is absent or wrong-typed (failure-tolerant substitution), not to throw eagerly; code count 64 → 63 (and then further 63 → 62 from `'atleast-bound-out-of-range'` removal in Task 2, net 64 → 62, but the base at end of 2i-c was 64). See the F1 changelog below.
  - `'deserialize-input-not-byte-array'` — both arms: extension entry / register entry not `Coll[Byte]`. Mirrors `SubstDeserializeError::TryExtractFromError`.
  - `'deserialize-parse-failed'` — both arms: inner Expr bytes malformed. Wraps the underlying wire-layer error message in `.message`. Mirrors `SubstDeserializeError::ExprParsingError`.
  - `'deserialize-tpe-mismatch'` — both arms: `exprTpe(parsed) !== e.tpe`. Check runs on BOTH register-decoded inner AND `default` fallback (per `expr.rs:486-491`). Mirrors `SubstDeserializeError::ExprTpeError`.
  - `'deserialize-not-substituted'` — defensive eval-time throw on both Deserialize* arms (cases (a), (b), and (c) — see taxonomy below).
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
- Real-context cost validation (Layer C3) — phase 2j calibration.
- Long-tail parse-rejecting / deprecated arms (`OpTrue`/`OpFalse`/`UnitConstant`, `Select1-5`, `ModQ` family, `CollShift`/`CollRotate`) — phase 2i-d.

**Phase A3 — MethodCall/PropertyCall return-type resolver** (additive; value/representation only, NOT cost; 2026-06-01):

- New `mir/method-signatures.ts`: a declarative `MethodSignature { tDom, tRange, tpeParams? }` catalog keyed by `(typeId, methodId)`, transcribing the method's `SFunc` signature. `exprTpe` now consults it for both the `MethodCall` and `PropertyCall` arms via `resolveReturnTpe`, which returns a CLOSED `tRange` verbatim and falls back to `SAny` (the load-bearing cascade) for an unregistered method. A type-var `tRange` is resolved by the substitution engine (`mir/type-unify.ts`, **v6 P0** — see below) — bind vars from `receiver`/`argTpes`/`explicitTypeArgs`, substitute into `tRange`; an unbindable residual still falls back to `SAny`.
- Populated: `SGroupElement.getEncoded` (7:2) → `Coll[SByte]`; `SColl.indices` (12:14) → `Coll[SInt]`. Both have a closed `tRange` (the substitution path is exercised by `patch` 12:19, added in v6 P0).
- Closes SANTA v5 item **A3**: empty-input `flatMap` now returns the lambda body's static elem type (e.g. `Coll[SByte]`) instead of `Coll[SAny]`, matching JVM `sigma-state-6.0.3`. Resolves the R3(b) note above. **Value-only — zero cost change** (conformance `Coll()#0` cost stays 149; flatMap eval cost stays 70).
- **Dual-table sync invariant:** the signature catalog (`mir/method-signatures.ts`) and the method-handler registry (`eval/method-call.ts`) share the `(typeId, methodId)` namespace. A handler MAY exist without a signature (eval-only; the call's static type stays `SAny`), but every signature MUST agree with its handler's runtime element type (the static `tRange` equals the `elem`/shape the handler constructs). First generic-output method satisfying it: `SColl.patch` (12:19) — static `Coll[IV]` resolves to `Coll[receiver-elem]`, matching the handler's `{ elem: obj.elem }` (`eval/method-call.ts`). Mechanical enforcement is future work.

**Phase v6 P0 — type-var substitution engine** (additive; value/representation only, NOT cost; 2026-06-02): `mir/type-unify.ts` ports JVM `unifyTypes`/`unifyTypeLists`/`applySubst`; `resolveReturnTpe` now binds a generic method's `tRange` from its call-site operands (closed `tRange` keeps the A3 early-return; unbindable residual → `SAny`). `SColl.patch` (12:19, `Coll[IV]` output) registered as the first generic-output method. Full suite green; patch value+cost unchanged. Spec: `docs/specs/2026-06-02-ergoscript-v6-p0-typevar-substitution-engine-design.md`.
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

**Phase v6 P1 — numeric methods (Byte/Short/Int/Long/BigInt)** (additive; 40 new method handlers + 2 new `EvalError` codes; 2026-06-02):

- **40 new method handlers** (registry 54 → 94): 8 method ids × 5 numeric types (Byte typeId=2, Short=3, Int=4, Long=5, BigInt=6). All gated `treeVersion >= 3` via `minVersion: 3` on registry entries (second use of the dispatcher minVersion mechanism after `SHeader.checkPow` (104:16) and `SAvlTree.insertOrUpdate` (100:16)). All cost `FixedCost(JitCost(5))` Pattern A (charged before all ops including bounds throws). Source: `eval/_numeric-v6.ts` (`numericV6Handlers`) + `eval/method-call.ts` registration loop.
  - **`X.toBytes` (methodId 6)** → `Coll[SByte]` (closed `tRange`): big-endian two's complement byte representation. Width: 1/2/4/8 bytes for Byte/Short/Int/Long; minimal-width signed BE (`encodeBigIntBE`) for BigInt, mirroring Java `BigInteger.toByteArray()`.
  - **`X.toBits` (methodId 7)** → `Coll[SBoolean]` (closed `tRange`): big-endian bit expansion, MSB-first within each byte. Width: 8/16/32/64/256 bits.
  - **`X.bitwiseInverse` (methodId 8)** → `tNum` (generic-output via P0 substitution engine): bitwise NOT, signed-narrowed back to receiver kind (JS `~` + `checkRange` equivalent for Byte/Short/Int; BigInt stays in range — `~x = -x-1` preserves i256 bounds for in-range input).
  - **`X.bitwiseOr` / `X.bitwiseAnd` / `X.bitwiseXor` (methodIds 9/10/11)** → `tNum`: signed-narrowed bitwise ops. BigInt versions have no overflow check (JVM `CBigInt` has no constructor-check for and/or/xor — in-range inputs always produce in-range results).
  - **`X.shiftLeft` / `X.shiftRight` (methodIds 12/13)** → `tNum`: arithmetic shifts. Bounds-checked on `bits` before the shift — throws `'numeric-shift-out-of-range'` when `bits < 0` or `bits >= width`. `BigInt.shiftLeft` additionally checks the result against signed-256 range — throws `'bigint-result-out-of-range'` on overflow. `shiftRight` is arithmetic (signed, JVM `>>`) not logical.
- **2 new `EvalError` codes (66 → 68):** `'numeric-shift-out-of-range'`, `'bigint-result-out-of-range'`. See the EvalError taxonomy section for the full specifications.
- **[C1 final-review fix, same session]** Adversarial wrong-kind operand guards: 1 new `EvalError` code (68 → 69): `'numeric-method-bad-operand'`. All 5 factories (`makeToBytes`, `makeToBits`, `makeInverse`, `makeBinaryBitwise`, `makeShift`) now guard the receiver `obj` kind (and the arg kind for `makeBinaryBitwise`/`makeShift`) after `ctx.addCost(5)` and before reading `.value`. Without the guard, Byte/Short/Int handlers silently return garbage (`.value` is `undefined` → JS numeric coercion produces 0; no throw) and Long/BigInt handlers throw a raw `TypeError` (JS BigInt coercion on a non-bigint). Both are consensus over-accept vectors where the JVM (`asInstanceOf`) and sigma-rust (`try_extract_into`) both reject at eval. Source: `eval/_numeric-v6.ts:requireKind`.
- **Key design decisions (both caught in review; record for audit-response):**
  - **Gate is `treeVersion >= 3` (NOT `isV6Activated`).** An earlier draft used an activation flag; the correct gate is the ErgoTree version field, consistent with how the dispatcher enforces all v6 method gating. Caught during the Task 4 checkpoint review.
  - **BigInt is signed-256-bounded.** `shiftLeft` overflow throws `'bigint-result-out-of-range'` (JVM `toSignedBigIntValueExact`). An earlier draft treated BigInt as arbitrary-precision; the bounded model is correct per the JVM CBigInt contract. Caught during the Task 4 escalation gate.
- **Second consumer of the P0 type-var substitution engine** (after `SColl.patch` 12:19): the bitwise/shift methods (methodIds 8–13) have `tRange = tNum` (a type variable), so `resolveReturnTpe` must bind `tNum` from the receiver type to produce the closed return type. Registered in `mir/method-signatures.ts` via `numericV6Signatures()`.
- Full suite: **3510 green** (node + jsdom). `tsc --noEmit` clean.

**Phase v6 P1 COMPLETE (incl. C1 final-review fix).** Method handler registry: 94 entries. EvalError codes: 69. Eval arm coverage: 67/67 (unchanged — `MethodCall` arm was already wired; P1 adds METHOD-REGISTRY entries, not eval arms). Test count: 3527 (17 new guard tests).

**Phase v6 P2a — `SUnsignedBigInt` type core** (additive; 2 new `EvalError` codes; no new eval arms or method handlers; 2026-06-03):

- **`SUnsignedBigInt` added to the `SType` union** (type code 9, `SEmbeddable`; see `facts/ergoscript-wire.md` for the wire-layer additions). The `SValue` union gains `{ kind: 'UnsignedBigInt'; value: bigint }` — a distinct variant from `{ kind: 'BigInt'; value: bigint }` using the **unsigned magnitude** codec (see §Wire codec below). The `kind` distinction is required so `serializeSValue` selects the unsigned path and P2b method dispatch / operand guards can tell them apart (mirrors JVM's distinct `CUnsignedBigInt` wrapper at `SType.scala:194`). Adding the union member makes `tsc` flag every exhaustive `switch (v.kind)` that needs a new arm — compiler-guided completeness.

- **Permissive parse stance** (gate is the pass, NOT the wire layer): `parseSValue(SUnsignedBigInt, …)` and `serializeSValue(SUnsignedBigInt, …)` carry NO version check. The v3 gate lives entirely in `validateV6Types` (see below), keyed on the authoritative `ctx.treeVersion`. A parse-without-eval consumer (e.g. `parseTree` for tooling) accepts a UBI constant at any tree version — that is the same parse-residual shape the already-shipped `validateBinOpTypes` carries, and is consensus-irrelevant (consensus evaluates → the pass fires → reject pre-eval, zero cost).

- **New pre-eval pass `validateV6Types(tree, body, treeVersion)`** — wired into `dispatchTreeBody` (`eval/evaluate.ts`) beside `validateBinOpTypes`, BEFORE `tryTrivialReduce` / `evalExpr` and before any cost. Two surfaces walked:
  1. **`tree.constantTypes[]`** — every segregated constant's declared `SType`, deep-checked for a forbidden construct. Mandatory (review Finding 1): a dead or never-evaluated segregated constant typed `SUnsignedBigInt` — or a type annotation like `Coll[SUnsignedBigInt]` carrying no UBI elements — never appears as a body expression, yet the JVM deserializes segregated constants eagerly and rejects code 9/112 there. A value-level body walk cannot catch it; only a `constantTypes[]` walk can.
  2. **The body** — walk the `Expr` tree via `childrenOf` (from `_substitute-deserialize.ts`); for each node inspect its **wire-serialized type annotations** (NOT computed `exprTpe`) for a forbidden construct. Run on both `rewrittenBody` and raw `tree.body`, like `validateBinOpTypes`, so substituted-in `Deserialize*` sub-trees and CP→Const inlinings are covered.

  Reject (under `treeVersion < 3`) if any walked `SType` **is or contains** `SUnsignedBigInt` **or** `SFunc` (deep-walking `SColl.elem`, `SOption.elem`, `STuple.items`, `SFunc.args`/`result`). Error: `EvalError('v6-type-in-pre-v3-tree')`, message naming the construct + position.

  **Critical faithfulness rule — inspect serialized annotations, NOT computed `exprTpe`.** A v5 lambda's computed type is `SFunc` (synthesized by `exprTpe` of a `FuncValue`), but no `SFunc` type code is serialized for a first-order v5 lambda. Checking computed types would false-reject every valid v5 `map`/`fold` tree. The pass reads only the `.tpe` / `elemTpe` / `explicitTypeArgs` fields that came from `parseSType` on the wire. Annotation-carrying nodes (enumerated exhaustively, tsc-guided): `Const.tpe`, `ConstPlaceholder.tpe`, `Collection.elemTpe` (Exprs arm only; BoolConstants has none), `Upcast.tpe`, `Downcast.tpe`, `GetVar.tpe` (as `varTpe`), `ExtractRegisterAs.tpe` (as `elemTpe`), `DeserializeContext.tpe`, `DeserializeRegister.tpe`, `FuncValue.args[].tpe`, `MethodCall.explicitTypeArgs`. **`ValUse.tpe` is deliberately excluded**: it is computed from the enclosing `ValDef`'s RHS type at parse time (not deserialized from a type-code byte), so a higher-order `val f = <lambda>; … f …` would give `ValUse.tpe = SFunc` on a valid v5 tree and checking it would false-reject.

- **`SFunc`-112 closure** — the same `validateV6Types` pass also gates the serialized `SFunc` type code (112) under `treeVersion < 3`, closing a pre-existing parser over-accept: `parseSType` accepted code 112 unconditionally, but the JVM gates it on `isV3OrLaterErgoTreeVersion` (`TypeSerializer.scala:211`). A v5 tree with a serialized `SFunc` annotation is an over-accept = latent fork. The pass deep-checks for `SFunc` everywhere it checks for `SUnsignedBigInt`; closing it in the same pass avoids a separate walk. (Gets its own dedicated test cases — v5 tree with code-112 annotation ⇒ rejected; v6 ⇒ accepted; v5 with first-order lambda ⇒ passes.)

- **Operations not in P2a.** UBI **methods** (inherited numeric/bitwise ids 6–13, casts → P2b), modular arithmetic / conversions → P2c, `Upcast`/`Downcast` arms for UBI → P2b. A `UnsignedBigInt` SValue reaching an unsupported operation at eval throws `EvalError('unsigned-bigint-op-unsupported')`.

- **2 new `EvalError` codes (69 → 71):** `'v6-type-in-pre-v3-tree'`, `'unsigned-bigint-op-unsupported'`. See the EvalError taxonomy section.

- **Conformance** (option B gate — `dispatchTreeBody` runs pre-eval, covers `constantTypes[]` + `rewrittenBody` + raw `tree.body` at authoritative `ctx.treeVersion`): the accept/reject outcome for every input matches the JVM, which gates at type deserialization. The sole residual — `parseTree(v5 bytes with code 9/112)` succeeds where the JVM throws — is consensus-irrelevant (spend → eval → pass fires → reject) and the same shape as `validateBinOpTypes`'s parse-residual. Spec: `docs/specs/2026-06-03-ergoscript-v6-p2a-sunsignedbigint-type-core-design.md`.

**Phase v6 P2a DONE (2026-06-03).** Method handler registry: 94 entries (unchanged). EvalError codes: 71. Eval arm coverage: 67/67 (unchanged). Full suite: 3580 green (node + jsdom).

**Phase v6 P2b — `SUnsignedBigInt` numeric methods + casts** (additive; 8 new method handlers + 1 new `EvalError` code; 2026-06-03):

- **8 new method handlers** (registry 94 → 102): `UnsignedBigInt.toBytes/toBits/bitwiseInverse/bitwiseOr/bitwiseAnd/bitwiseXor/shiftLeft/shiftRight` (typeId 9, methodIds 6–13). All `minVersion: 3`. All `FixedCost(JitCost(5))` Pattern A. Three semantic differences from the `BigInt` (typeId 6) group: unsigned magnitude codec for `toBytes`/`toBits`; 256-bit fixed flip for `bitwiseInverse`; unsigned-overflow guard on `shiftLeft` (throws `'unsigned-bigint-out-of-range'`). Implementation: `eval/_numeric-v6.ts` 6th `NumV6` descriptor (`ubiDesc`; `kind: 'UnsignedBigInt'`, `typeId: 9`). `UBI_MAX = 2²⁵⁶−1` module constant added. The local `NumV6.kind` union widened to admit `'UnsignedBigInt'` — NOT the shared `NumericKind` (Critical 1: widening the shared predicate would flip `Negation(ubi)` from reject→accept, a fork). Source: JVM `methods.scala:309–459`, `CUnsignedBigInt.scala:16–94`, `UnsignedBigIntegerOps.scala:131–149`.

- **`mir/method-signatures.ts` extended** (Important 1): `NUMERIC_STYPE` gains `9: { tag: 'SUnsignedBigInt' }`. Without this, `exprTpe(ubi.bitwiseInverse)` → `SAny`; with it → `SUnsignedBigInt`. `ubi.toBytes` → `Coll[Byte]`, `ubi.toBits` → `Coll[Boolean]`. Closes the A3-class gap for empty-`Coll[UBI]` element typing.

- **`eval/downcast.ts` extended** — UBI branch at the top, before the existing signed-5 path. `downcastUBI(input, tpe)` dispatches the full §UBI cast matrix Downcast rows (see the UBI cast matrix section and the EvalError codes below). Cost predicate extended from `tpe.tag === 'SBigInt' ? 30 : 10` to `(tpe.tag === 'SBigInt' || tpe.tag === 'SUnsignedBigInt') ? 30 : 10` — the JVM charges 30 for a UBI target (`NumericCastCostKind`, `CostKind.scala:60–66`). Cost is charged BEFORE `tpe.downcast` runs, so a throwing cast still charges.

- **`eval/upcast.ts` extended** — symmetric `upcastUBI` branch (UBI cast matrix Upcast rows). Upcast was previously untouched; a hand-crafted `Upcast` node with a UBI source or UBI target is a valid v6 tree the JVM evaluates, and faithfulness requires mirroring every cell.

- **`eval/coll-map.ts` `inferSType` extended** — `case 'UnsignedBigInt': return { tag: 'SUnsignedBigInt' }` arm added. The `default:` throws `'coll-map-elem-type-infer-failed'`; without this arm, a non-empty `Coll[T].map(x => x.bitwiseInverse)` where T = UBI would throw on a valid v6 tree (a mini-fork). tsc does NOT force the arm (the `default` swallows it).

- **Version gating for casts:** no per-arm V3 guard inside `downcastUBI`/`upcastUBI`. A cast `tpe = SUnsignedBigInt` carries type code 9, which `validateV6Types` rejects pre-eval in a `< V3` tree; a UBI source value can only exist in a V3+ tree (P2a). The tree-level gate covers it — mirrors the JVM's `if isV3OrLater` on the signed-target UBI-source cases without a redundant per-arm check.

- **1 new `EvalError` code (71 → 72):** `'unsigned-bigint-out-of-range'` — shared by `UnsignedBigInt.shiftLeft` overflow (result `≥ 2²⁵⁶`) and negative-source cast to UBI target (Byte/Short/Int/Long/UBI→UBI path where signed source `< 0`). **`'unsigned-bigint-op-unsupported'`** (P2a code, 71 total pre-P2b) is **reused** (not new) for: UBI↔BigInt casts (both Downcast and Upcast) and UBI-source Upcast to a signed/BigInt target — all unsupported language operations.

- **UBI cast matrix** (faithful mirror of `SType.scala:419–590`; cost charged FIRST in all cells):

  | node | source → target | behaviour | cost |
  |---|---|---|---|
  | Downcast | UBI → Byte/Short/Int/Long | `ubi.toXExact` — range-check, throw `'downcast-overflow'` if outside signed range | 10 |
  | Downcast | UBI → BigInt | `SBigInt.downcast`: no UBI case ⇒ throw `'unsigned-bigint-op-unsupported'` | 30 |
  | Downcast/Upcast | UBI → UBI | identity (`v ≥ 0`) | 30 |
  | Downcast/Upcast | Byte/Short/Int/Long → UBI | `CUnsignedBigInt(valueOf(x))` if `x ≥ 0` else throw `'unsigned-bigint-out-of-range'` | 30 |
  | Downcast/Upcast | BigInt → UBI | `SUnsignedBigInt.*`: no BigInt case ⇒ throw `'unsigned-bigint-op-unsupported'` | 30 |
  | Upcast | UBI → Byte/Short/Int/Long/BigInt | `<signed/BigInt>.upcast`: no UBI case ⇒ throw `'unsigned-bigint-op-unsupported'` | 10 |

  The signed-5 path (neither source nor target UBI) is unchanged — validated by the v5 walk. `downcastUBI`/`upcastUBI` read the source value as a bigint directly (`input.value` for UBI, `BigInt(input.value)` for signed) and build UBI results inline — they do NOT call `valueToBigInt`/`bigIntToValue`/`sTypeToNumericKind`/shared `NUMERIC_KINDS` tables (those have no UBI arm — touching them would widen `isNumeric` and flip `Negation`/`Arith`/`Ordering` from reject to accept). `checkRange` (signed target) is reused.

- **Non-regression (Critical 1):** `Negation(ubiConst)`, UBI arith BinOps, UBI ordering BinOps remain rejecting (unchanged) — the UBI branch is at the TOP of the cast arms, isolated from the shared `isNumeric`/`NumericKind` path. Test pins ensure no widening.

- Source: JVM `SType.scala:419–590`, `CostKind.scala:60–66`, `trees.scala:404, 411–416, 436`.

**Phase v6 P2b DONE (2026-06-03).** Method handler registry: 102 entries. EvalError codes: 72. Full suite: 3602 green (node + jsdom). `tsc --noEmit` clean.

**Phase v6 P2c — `SUnsignedBigInt` plain BinOps + `toUnsigned`/`toSigned` bridges** (additive; 2 new method handlers + 0 new `EvalError` codes; 2026-06-03):

- **UBI BinOp operand support (all three BinOp families, V3-gated):** `SUnsignedBigInt` is now a valid operand for:
  - **Arithmetic BinOps** (`Plus`, `Minus`, `Multiply`, `Divide`, `Modulo`, `Min`, `Max`): both operands must be UBI; a mixed UBI/signed arith operand rejects at eval via `'bin-op-kind-mismatch'`. Implemented via a UBI branch at the top of `evalArithOp` (before the `isNumeric` guard) in `eval/bin-op/arith.ts`, delegating to the new helper `eval/bin-op/_ubi-binop.ts`. The shared `isNumeric` predicate is NOT widened (Critical 1 — unchanged).
  - **Ordering BinOps** (`Lt`, `Le`, `Gt`, `Ge`): both operands must be UBI; a mixed operand rejects. Implemented via a UBI branch in `evalRelationOp` in `eval/bin-op/relation.ts`, after `validateBinOpTypes` has already admitted the pair via the `isNumericTpe` UBI add (see below). Also in `_ubi-binop.ts`.
  - **Equality BinOps** (`Eq`, `NEq`): closes the two `'unsigned-bigint-op-unsupported'` stubs P2a left in `relation.ts` (`:553` scalar EQ, `:651` Coll-element EQ). UBI equality **mirrors BigInt exactly** — both scalar and `Coll[UBI]` paths are identical to their `SBigInt` counterparts (`DataValueComparer.scala:141-142`).
  - Version gate: inherited from `validateV6Types` (P2a) — a UBI value can only reach a P2c arm in a V3+ tree; no per-arm V3 guard needed inside the BinOp handlers.

- **UBI arith cost — the non-BigInt tier (the load-bearing fact):** every arith `costKind` in the JVM is `TypeBasedCost { case SBigInt => X; case _ => Y }`. `SUnsignedBigInt` is a distinct case object and takes `case _` (the non-BigInt tier). UBI arith costs are therefore **lower** than signed BigInt:
  - `Plus`, `Minus` — **15** (signed BigInt = 20)
  - `Multiply`, `Divide`, `Modulo` — **15** (signed BigInt = 25)
  - `Min`, `Max` — **5** (signed BigInt = 10)
  - Implemented via `arithCost(op, /*isBigInt*/ false)`, the same helper used by Byte/Short/Int/Long. Source: `trees.scala:752-849` (each `TypeBasedCost` site). No new cost constants are introduced.

- **UBI ordering and equality costs** (all mirror the signed case — same `case _` or identical constants):
  - Ordering (`Lt`/`Le`/`Gt`/`Ge`) — **20** (same as signed BigInt — the JVM cost match is `case SBigInt => 20; case _ => 20`). Reuses `RELATION_ORDERING_COST`. Source: `trees.scala:1095-1194`.
  - Scalar `Eq`/`NEq` — **5** (`EQ_BIGINT_COST`; same as signed BigInt — `case ubi: UnsignedBigInt => E.addFixedCost(EQ_BigInt)`). Source: `DataValueComparer.scala:343-351`.
  - `Coll[UBI]` `Eq`/`NEq` — `EQ_COA_BigInt` `PerItemCost` (identical to `Coll[BigInt]` — the JVM's `descriptors` maps both `BigIntRType` and `UnsignedBigIntRType` to `(EQ_BigInt, EQ_COA_BigInt)`, `DataValueComparer.scala:141-142`). This is a COA bulk-compare: one `EQ_COLL_BIGINT_PER_ITEM` `PerItemCost` charge, then a non-recursive element loop via `primitiveValueEqual` (no per-element cost). Reuses `EQ_COLL_BIGINT_PER_ITEM`. Not per-element recursion.

- **`validateBinOpTypes` UBI admission (Critical 1 — the fork the adversarial review caught):** `validateBinOpTypes` (`eval/validate-bin-op-types.ts`) has a pre-eval `isNumericTpe` predicate for the ordering (`Lt`/`Le`/`Gt`/`Ge`) `OnlyNumeric` pass. Before P2c it listed only `Byte`/`Short`/`Int`/`Long`/`BigInt`. A V3 `LT(ubi, ubi)` would throw `'bin-op-not-numeric'` pre-eval — a reject-where-JVM-accepts **fork** (`SUnsignedBigInt extends SNumericType` in the JVM). **Fix:** `isNumericTpe` gains `case 'SUnsignedBigInt': return true`. Effect: `LT(ubi,ubi)` passes (`sTypeEqualsModuloSAny` holds, `:93`); `LT(Int,ubi)` / `LT(ubi,Long)` still reject (SameType); `Eq` is unaffected (it uses `sTypeEqualsModuloSAny`, not `isNumericTpe`).

- **Value semantics:**
  - Plus/Minus/Multiply → bound-check `[0, 2²⁵⁶)`: throw `'unsigned-bigint-out-of-range'` on Minus underflow or Plus/Multiply overflow. Divide/Modulo → `'arith-divide-by-zero'` when divisor is zero. Modulo non-negative (no `rem < 0 ? rem + y` correction — UBI operands are non-negative, `divisionRemainder = mod` per `UnsignedBigIntegerOps.scala:87`). Min/Max → no overflow. Ordering → plain `bigint` compare. Equality → plain `bigint` value compare (mirrors BigInt exactly).
  - Mismatched operand (`Plus(ubi, Int)`, `LT(ubi, Long)` in a hand-crafted V3 tree): arith rejects at the UBI branch's `rv.kind !== 'UnsignedBigInt'` guard → `'bin-op-kind-mismatch'`; ordering/equality rejects pre-eval by `validateBinOpTypes`.
  - `Negation(ubi)` stays permanently rejecting — `UnsignedBigIntIsIntegral.negate = ???` (`UnsignedBigIntegerOps.scala:48`); the JVM charges `FixedCost(30)` then throws `NotImplementedError`. In ergots `Negation` never reaches a UBI branch (the `isNumeric`-false path rejects it before the UBI branch — `isNumeric` is NOT widened). A reject-outcome match; intermediate cost-on-failure is moot since the throw fails the whole eval.

- **2 new method handlers** (registry 102 → 104): both `minVersion: 3`, both with closed return types:
  - **`BigInt.toUnsigned` (6:14)** — `FixedCost(JitCost(5))` Pattern A; receiver `kind 'BigInt'`; throws `'unsigned-bigint-out-of-range'` if `value < 0n` (negative BigInt can't be represented unsigned); else `{ kind:'UnsignedBigInt', value }`. Receiver-kind guard throws `'numeric-method-bad-operand'` on wrong-kind receiver. Source: `methods.scala:543-549, 559-565`.
  - **`UnsignedBigInt.toSigned` (9:19)** — `FixedCost(JitCost(10))` Pattern A; receiver `kind 'UnsignedBigInt'`; throws `'bigint-result-out-of-range'` if `value ≥ 2²⁵⁵` (leftmost bit set — `toSignedBigIntValueExact`, `bitLength ≤ 255`); else `{ kind:'BigInt', value }`. Receiver-kind guard throws `'numeric-method-bad-operand'`. Source: `methods.scala:607-611`, `Extensions.scala:219-223`.

- **`mir/method-signatures.ts` extended:** `(6, 14) → SUnsignedBigInt` and `(9, 19) → SBigInt` added so `exprTpe` resolves the bridge returns (both closed; no type-var substitution; neither collides with the `numericV6Signatures()` 6–13 loop).

- **Stubs closed:** the two `'unsigned-bigint-op-unsupported'` sites in `relation.ts` (`:553` scalar `sValueEquals`, `:651` Coll-element `primitiveValueEqual`) are replaced with real equality implementations mirroring the `SBigInt` arms. After P2c, `'unsigned-bigint-op-unsupported'` survives only in `_cast-ubi.ts` (3 live throws: UBI↔BigInt cast + UBI-source Upcast rejects — P2b, still correct) plus the `eval-context.ts:26` EvalError doc-catalog comment.

- **0 new `EvalError` codes.** All error codes reuse existing symbols: `'unsigned-bigint-out-of-range'` (P2b), `'arith-divide-by-zero'` (phase 2c), `'bin-op-kind-mismatch'` (phase 2c), `'bigint-result-out-of-range'` (P1), `'numeric-method-bad-operand'` (P1).

**Phase v6 P2c DONE (2026-06-03).** Method handler registry: 104 entries. EvalError codes: 72 (unchanged). Full suite: 3624 green (node + jsdom). `tsc --noEmit` clean.

**Phase v6 P2d-1 — `SUnsignedBigInt` modular methods** (additive; 5 new method handlers + 0 new `EvalError` codes; 2026-06-03):

- **5 new method handlers** (registry 104 → 109), all `minVersion: 3`, all `FixedCost` Pattern A:
  | method | `typeId:methodId` | cost | semantics |
  |---|---|---|---|
  | `UnsignedBigInt.plusMod`     | 9:15 | 30 | `(a + that) mod m` |
  | `UnsignedBigInt.subtractMod` | 9:16 | 30 | `(a − that) mod m` (intermediate may be `< 0`) |
  | `UnsignedBigInt.multiplyMod` | 9:17 | 40 | `(a · that) mod m` |
  | `UnsignedBigInt.mod`         | 9:18 | 20 | `a mod m` |
  | `BigInt.toUnsignedMod`       | 6:15 | 15 | `aSigned mod m` → UBI (receiver may be `< 0`) |
- All reductions go through one Euclidean primitive `umod(x,m) = ((x % m) + m) % m` (`eval/_ubi-modular.ts`) — Java `BigInteger.mod` is Euclidean, JS `%` is a remainder. Result is always `∈ [0, m) ⊂ [0, 2²⁵⁶)`, so the UBI bound is satisfied for free — **no range/overflow path**.
- **0 new `EvalError` codes.** Only reachable error is `m == 0` (UBI is `≥ 0`, so `m ≤ 0 ⟺ m == 0`; JVM throws `ArithmeticException("BigInteger: modulus not positive")`) → reuses **`'arith-divide-by-zero'`** (same code `evalUBIArith` already uses for UBI modulo-by-zero). Wrong-kind operand → existing `'numeric-method-bad-operand'`.
- `mir/method-signatures.ts`: 5 closed-`tRange` `SUnsignedBigInt` entries (so `exprTpe` resolves results).
- Source: JVM `methods.scala:551-623`, `CUnsignedBigInt.scala:47-77`, `CBigInt.scala:77-79`. Oracle: `LanguageSpecificationV6.scala` `verifyCases`. Spec: `docs/specs/2026-06-03-ergoscript-v6-p2d1-ubi-modular-methods-design.md`.
- **Deferred to P2d-2:** `UnsignedBigInt.modInverse` (9:14, `FixedCost(150)`).

**Phase v6 P2d-1 DONE (2026-06-03).** Method handler registry: 109 entries. EvalError codes: 72 (unchanged). Eval arm coverage: 67/67 (unchanged — adds METHOD-REGISTRY entries, not eval arms). Full suite: 3658 green (node + jsdom). `tsc --noEmit` clean.

**Phase v6 P2d-2 — `SUnsignedBigInt.modInverse`** (additive; 1 new method handler + 1 new `EvalError` code; 2026-06-03):

- **1 new method handler** (registry 109 → 110), `minVersion: 3`, `FixedCost(150)` (`methods.scala:574`) Pattern A:
  | method | `typeId:methodId` | cost | semantics |
  |---|---|---|---|
  | `UnsignedBigInt.modInverse` | 9:14 | 150 | `b ∈ [0, m)` with `a·b ≡ 1 (mod m)` |
- Hand-rolled classic iterative **extended Euclidean** `umodInverse(a, m)` (`eval/_ubi-modular.ts`, beside `umod`) — JS `bigint` has no native modInverse. Reuses `umod` twice: reduce the base into `[0, m)`, normalize the Bézout coefficient into `[0, m)`. Result is always `∈ [0, m) ⊂ [0, 2²⁵⁶)`, so the UBI bound holds for free — **no range/overflow path**. `m == 1 → 0` falls out of the algorithm (no special case).
- **1 new `EvalError` code** (72 → 73): `'unsigned-bigint-not-invertible'` — `gcd(a, m) ≠ 1` (no multiplicative inverse). `m == 0` reuses `'arith-divide-by-zero'` (inherited via the first `umod` call); wrong-kind operand → existing `'numeric-method-bad-operand'`.
- `mir/method-signatures.ts`: 1 closed-`tRange` `(9, 14) → SUnsignedBigInt` entry.
- Source: JVM `methods.scala:574-576`, `CUnsignedBigInt.scala:57-59` (`wrappedValue.modInverse(m)`). Oracle: `LanguageSpecificationV6.scala:2874-2880` (`modInverse(12,5)=3`) + `BasicOpsSpecification.scala:590-628` (`modInverse(3,7)=5`; `m==0` throws). Spec: `docs/specs/2026-06-03-ergoscript-v6-p2d2-ubi-modinverse-design.md`.
- **P2 (`SUnsignedBigInt`) COMPLETE** — full v6 method surface landed (P2a type core · P2b methods+casts · P2c BinOps+bridges · P2d-1 modular · P2d-2 modInverse).

**Phase v6 P2d-2 DONE (2026-06-03).** Method handler registry: 110 entries. EvalError codes: 73. Eval arm coverage: 67/67 (unchanged). Full suite: 3669 green (node + jsdom). `tsc --noEmit` clean.

**Phase v6 P3 — Coll v6 methods (`reverse`/`startsWith`/`endsWith`/`get`)** (additive; 4 new method handlers + 0 new `EvalError` codes; 2026-06-03):

- **4 new method handlers** (typeId 12, methodIds 30–33), all gated `treeVersion >= 3`
  via `minVersion: 3` at the dispatcher. Source module `eval/scoll-v6.ts`. JVM source:
  `sigma/ast/methods.scala` `SCollectionMethods` `v6Methods` (`:1211-1216`, gated `:1221-1227`).
  - **`reverse` (12:30)** → `Coll[IV]` (generic, via the P0 substitution engine). Cost
    `addPerItemCost(20, 2, 100, n)` on the receiver length (`Append.costKind`,
    `transformers.scala:74-75`). Reverses the items, preserves elem type. Empty → empty.
  - **`startsWith` (12:31)** / **`endsWith` (12:32)** → `Boolean` (closed). Cost
    `addPerItemCost(10, 1, 10, n)` on the **receiver** length (`Zip_CostKind`,
    `methods.scala:1102-1103`). Element comparison is **cost-free** (`sValueStructuralEq`,
    NOT the costed `sValueEquals`) — the JVM's `Coll.startsWith`/`endsWith` are uncosted
    Scala ops, so the only charge is the one Zip envelope (contrast `indexOf`, which is
    per-comparison costed).
  - **`get` (12:33)** → `Option[IV]` (generic, via P0). Cost `FixedCost(30)`
    (`ByIndex.costKind`, `transformers.scala:285`). Total function: `0 ≤ i < len ?
    Some(item) : None` — negative/OOB return `None`, never throw.
- **Static typing:** 4 `mir/method-signatures.ts` entries. `reverse`/`get` carry type-var
  `tRange` (resolved by the P0 engine); `startsWith`/`endsWith` are closed `SBoolean`.
- **Cost-free structural equality:** `sValueEquals` (`eval/bin-op/relation.ts`) refactored
  into a cost-free core `compareSValues(a, b, ctx?)`; `sValueStructuralEq(a, b)` is the
  cost-free wrapper used by `startsWith`/`endsWith`. `sValueEquals` behavior is unchanged
  (it passes `ctx`).
- **No wire change** — the generic `MethodCall` path handles all four (`IV` is
  receiver-inferred; `explicitTypeArgs` empty, like `patch` 12:19).
- **Errors:** zero new codes — defensive receiver/arg-kind checks reuse
  `'method-not-implemented'` (the SColl MethodCall convention); pre-V3 invocation →
  `'tree-version-too-low'` (dispatcher gate). `get` OOB/negative is not an error.
- **Composite-element comparison:** `startsWith`/`endsWith` over colls whose elements are
  themselves composite (`Box`/`AvlTree`/`Header`/`PreHeader`/`Tuple`/`Coll`/`Option`) do a
  cost-free **structural** compare via `sValueStructuralEq` — NOT a throw — mirroring the JVM's
  element-wise `Coll.startsWith`. (`relation.ts` does field-by-field `boxEqual`/`avlTreeEqual`/
  `preHeaderEqual`/`headerEqual` since phase 2e; the stale "`Box`/`AvlTree` throw
  `'not-implemented-yet'`" notes at lines 22/245 predate that and are inaccurate — a pre-existing
  doc-drift, not P3.)
- **Residual** (adversarial-only, deferred to P8): a hand-crafted mismatched-elem
  `startsWith`/`endsWith` reaches eval (benign `false`) because the parser is permissive and
  `validateBinOpTypes` covers only `Relation` nodes; the general MethodCall-arg-type pre-eval
  pass is deferred.

**Phase v6 P4 — Global.some/none + V3 empty-args-MethodCall reject** (additive; 2 new method handlers + 1 new `EvalError` code; 2026-06-04):

- **2 new method handlers (registry 115 → 117):** both `SGlobal` methods, both V3-gated (`minVersion: 3`), both `FixedCost(JitCost(5))` Pattern A. Source: JVM `methods.scala:1986-1999`.
  - **`SGlobal.some` (106:9)** — `(SGlobal, T) → Option[T]`. Handler guards `obj.kind === 'Global'` AND `args.length === 1` (arity parity with `specialize_for`); constructs `{ kind:'Option', elem: explicitTypeArgs['T'], value: args[0] }`. `elem` is read from the wire explicit type arg `T` (present on both wire forms — MethodCall for 1-arg, PropertyCall for 0-arg). Full-tree eval cost 19: MethodCall envelope 4 + Global sentinel 5 + Const arg 5 + handler 5. Generic return `Option[T]` resolved by the P0 substitution engine. Source: `methods.scala:1986-1992`.
  - **`SGlobal.none` (106:10)** — `(SGlobal) → Option[T]`. Handler guards `obj.kind === 'Global'` AND `args.length === 0`; constructs `{ kind:'Option', elem: explicitTypeArgs['T'], value: null }` (None). `elem` from the wire explicit type arg `T`. Full-tree eval cost 14: PropertyCall envelope 4 + Global sentinel 5 + handler 5. Invoked via the **PropertyCall opcode** (0 args, carries `T` via the PropertyCall explicit-type-arg wire slice — see `facts/ergoscript-wire.md`). Source: `methods.scala:1994-1999`.
  - Both handlers reuse `'method-not-implemented'` for the `obj.kind !== 'Global'` guard (per compact-taxonomy Decision #1); the `minVersion: 3` dispatcher gate reuses `'tree-version-too-low'`. A missing `explicitTypeArgs['T']` is a parse/registry invariant violation (no dedicated code). The `Option` SValue `elem` field requires explicit wiring from `explicitTypeArgs['T']` for `none` (no runtime value to infer from).
- **1 new EvalError code (73 → 74): `'method-call-empty-args'`** — raised by a new pre-eval, zero-cost, whole-tree pass `validateMethodCallArity(body, treeVersion)` in `eval/validate-method-call-arity.ts`, wired into `dispatchTreeBody` (`eval/evaluate.ts`) on the post-substitution body, before `tryTrivialReduce`/`evalExpr` and before any cost (so a rejected tree yields no value and **zero JIT cost**). The pass rejects any **`MethodCall`-opcode node** (`tag: 'MethodCall'`, NOT `PropertyCall`) with `args.length === 0` when `treeVersion >= 3`. Mirrors the JVM `MethodCallSerializer.parse` assertion `if (isV3OrLaterErgoTreeVersion) assert(args.nonEmpty)` (`MethodCallSerializer.scala:53-55`). Method-agnostic (the JVM asserts before `from_ids`, so any `typeId:methodId` is covered). **Pre-V3 grandfathered** — the assert is version-gated; pre-V3 empty-args MethodCall nodes remain accepted (matching JVM). Closes: (1) the new `none`-via-MethodCall-opcode over-accept (using MethodCall opcode for a zero-arg method is adversarially reachable post-P4); (2) the pre-existing `groupGenerator` (106:1) over-accept (zero-arg, MethodCall opcode, V3+ trees). Implementation mirrors `validateBinOpTypes` (`eval/validate-bin-op-types.ts`), using the exported `childrenOf` from `_substitute-deserialize.ts`.

**Phase v6 P4 COMPLETE (2026-06-04).** Method handler registry: 117 entries. EvalError codes: 74. Eval arm coverage: 67/67 (unchanged — adds METHOD-REGISTRY entries and a pre-eval pass, not eval arms). Full suite: 3721 green (node + jsdom). `tsc --noEmit` clean.

**Phase v6 P5a — `Global.serialize` (106:3) + `Global.deserializeTo` (106:4)** (additive; 2 new method handlers + 2 new `EvalError` codes; 2026-06-04):

- **2 new method handlers (registry 117 → 119):** both `SGlobal` methods, both V3-gated (`minVersion: 3`). Source: JVM `methods.scala:1957` (serialize), `:1906` (deserializeTo).
  - **`SGlobal.serialize` (106:3)** — `(SGlobal, T) → Coll[Byte]`. Handler derives `T` from the RUNTIME value via `sValueType(v)` (NOT `exprTpe` — the static type is `SAny` for many generic inputs), charges `ctx.addCost(10)` (StartWriter) then `serializeCost(T, v, ctx)` (analytical DynamicCost walk mirroring JVM `DataSerializer.serialize` per-write costs), then drives `serializeSValue(T, v, treeVersion, w)`. Non-serializable values (`Lambda`/`Global`/`PreHeader`/`Context` — `sValueType` returns `SAny`) cause `serializeSValue` to throw → wrapped as `'global-serialize-failed'`. MethodCall opcode; NO wire type arg (T inferred from runtime value). **V3-gated** (`minVersion: 3`). **Residual (adversarial-only):** hand-crafted V1 header with `powDistance=0` → scorex-shaped bytes diverge from JVM (sigma-rust-vs-JVM Autolykos-V1 d=0 fork); real V1 headers have d≠0; V1 unreachable via `Context.headers` on a V3+ chain; cost JVM-faithful regardless. See P5a design spec §Open items.
  - **`SGlobal.deserializeTo[T]` (106:4)** — `(SGlobal, Coll[Byte]) → T`. Charges `ctx.addPerItemCost(100, 32, 32, bytes.length)` BEFORE parsing (even on failure), then `parseSValue(T, ctx.treeVersion, new ByteReader(bytes))`. Generic `T` resolved from `explicitTypeArgs['T']` (guaranteed by the wire parser). Trailing bytes ignored (JVM faithfulness pin). MaxTreeDepth(110) enforced via the SHARED reader-level counter (data-driven, not type-structural — a deeply-nested type with empty data is accepted). MethodCall opcode; carries explicit `T` wire type arg (already in `wire/mir/explicit-type-args.ts:106:4`). **V3-gated** (`minVersion: 3`).
- **Shared `sValueType` helper** (`eval/svalue-type.ts`): complete runtime-value→SType derivation for every serializable kind, extending the prior `coll-map.ts` `inferSType` with `Header` and `String` arms; `coll-map.ts` refactored to import it (behavior-preserving).
- **`serializeCost` analytical walk** (`eval/serialize-cost.ts`): mirrors JVM `SigmaByteWriter` per-primitive costs for every `SType` arm including complex types (SAvlTree, SHeader, SBox with register `putType` cost). Decoupled from the byte-writing path so `serializeSValue` remains byte-validated from phase 2a.
  - **F2 correction (2026-06-06) — `putUByte` = 1, not 0.** The initial P5a walk modeled all bare `putUByte(x)` calls as cost-0 (inheriting the `putUInt`-is-0 logic). This was wrong: the JVM scorex `Writer` trait's `putUByte(x)` delegates to `put(x.toByte)`, which routes through the virtual `SigmaByteWriter.put(Byte)` implementation at line 45–48 → `addFixedCost(PutByteCost)` (PutByteCost = 1). By contrast, bare `putUInt(x: Long)` genuinely charges 0 (the two are asymmetric: `putUByte` → `put`, `putUInt` → no cost in the Writer trait). **Sites corrected (verified 4 ways: JVM dispatch chain, scorex-util jar bytecode, eni `add_put_byte_cost` sites, arithmetic confirmation from `serialize_Header` blessed cost 333 = StartWriter(10) + serializeHeaderWithoutPow(244) + putUByte(1) + pow(78)):**
    - **Box** `ErgoBoxCandidate.scala:144` (`nTokens` count) + `:166` (`nRegs` count): +2 per Box → closes all 10 Box cost rows (+139→141 or +142→144 etc.)
    - **AvlTree** `AvlTreeData.scala:76` (`flags` byte): +1 per AvlTree → closes both AvlTree cost rows (+126→127)
    - **Header-v1** `ErgoHeader.scala:68` (`dLen` byte): +1 → closes the `deserializeTo_header` v1 row (803→804)
    - **Header-v2** `HeaderWithoutPow.scala:61-62` (`unparsedLen` byte): +1 → visible on `serialize_Header` 333 and `deserializeTo_header` 677 (previously masked by the timestamp panic)
    - **Tuple-register count** (`DataInfo` overload for register writes): +1 when a register value is a Tuple
    - **Type-serializer length bytes** (`types.rs:456` >4-tuple len, `:467` SFunc tDom len, `:475` SFunc tpeParams len, `types/stype_param.rs:81` STypeVar name len): +1 per site, charging PutByteCost(1) via the JVM path — **eni divergence:** eni does NOT charge these four type-length bytes (nor the STypeVar name-bytes chunk cost at `types/stype_param.rs:81-82`). JVM is canonical; only the >4-tuple site is adversarially reachable (5-tuple register types, cost pin 84). The eni divergence was ROUTED via SANTA 2026-06-06 and SANTA-verified in place (sigma-rust fix to land on `jit-costing-final`, cherry-picked to eni).
  - All `putUByte`-as-0 prose in the file has been replaced with the corrected model above.
- **Zero wire change.** `106:4` was already in `explicit-type-args.ts`; `106:3` deliberately absent (T inferred at eval, no wire type bytes).
- **MaxTreeDepth unified (T2.5, 2026-06-04):** the data-path depth guard was implemented as a SHARED reader-level counter on `@ergots/scorex` `ByteReader` (`enterDepth`/`exitDepth`, default cap 110), bumped at three central funnels (`parseExpr`, `parseSValue`, `parseSigmaBoolean`) — replacing the piecemeal threaded-`depth` param approach. All nesting kinds (expr-tree, data, sigma-boolean, box-register) participate. Over-depth raises `ReaderError('max-tree-depth-exceeded')` (single faithful JVM analogue), caught at the `deserializeTo` boundary → `'global-deserialize-failed'`. Boundary tests cover every kind at 110-accept / 111-reject.
- **2 new `EvalError` codes (74 → 76):** `'global-serialize-failed'` (serialize: non-serializable value type), `'global-deserialize-failed'` (deserializeTo: malformed/truncated bytes, oversized BigInt/UBI, actual parse recursion > MaxTreeDepth(110)).
- **Round-trip property** (`deserializeTo[T](serialize[T](x)) == x`) verified across full type domain: Byte, Short, Int, Long, BigInt, UnsignedBigInt, Coll[Byte], Coll[Int], Option[Int] (None + Some), Tuple, GroupElement, AvlTree, Header (V2), Box (no regs; with Int reg; with Coll[Byte] reg). V1 excluded from round-trip (sigma-rust-vs-JVM d=0 fork — adversarial-only residual).
- **Wire-confirm:** `106:3` MethodCall carries NO explicit type arg bytes on the wire (wire round-trip → `explicitTypeArgs = {}`); `106:4` DOES carry `T` (wire round-trip → `explicitTypeArgs = { T: SInt }` or equivalent).

**Phase v6 P5a COMPLETE (2026-06-04).** Method handler registry: 119 entries. EvalError codes: 76. Eval arm coverage: 67/67 (unchanged — adds METHOD-REGISTRY entries, not eval arms). Full suite: **3822 green** (node + jsdom). `tsc --noEmit` clean. Includes the T2.5 structural `MaxTreeDepth`(110) reader-level counter (shared `@ergots/scorex` `ByteReader`, bumped at parseExpr/parseSValue/parseSigmaBoolean + box-register Expr) and the T7 Tuple-Expr-register serialize-cost fix. One deferred residual: V1-Header d=0 byte-shape sigma-rust-vs-JVM fork in scorex → v6 scorex work.

**Phase v6 P5b-1 — `Global.fromBigEndianBytes` (106:5)** (additive; 1 new method handler + 1 new `EvalError` code; 2026-06-04):

- **1 new method handler (registry 119 → 120):** `SGlobal.fromBigEndianBytes[T]`, V3-gated (`minVersion: 3`), `FixedCost(10)`. Generic over the six numeric types; `T` resolved from `explicitTypeArgs['T']` (wire). Decodes big-endian bytes — signed two's-complement for Byte/Short/Int/Long (inline) + BigInt (`signedBeBytesToBigInt`); unsigned magnitude for UnsignedBigInt (new `unsignedBeBytesToBigInt` in `eval/_byte-coll.ts`). Per-type exact-length (Byte=1/Short=2/Int=4/Long=8) or max-length (BigInt/UBI ≤32) validation; BigInt rejects empty (JVM `new BigInteger(byte[0])` throws), UBI empty → 0. `FixedCost(10)` charged BEFORE validation/decode (even on failure). Non-numeric `T` rejected at eval (handler default branch). Inverse of P1 `toBytes`. Source: JVM `methods.scala:1925-1932`, `CSigmaDslBuilder.scala:225-261`.
- **Zero wire change** — `106:5` already in `wire/mir/explicit-type-args.ts`; rides the deserializeTo (106:4) explicit-type-arg MethodCall path.
- **1 new `EvalError` code (76 → 77):** `'global-from-bigendian-bytes-failed'` (covers wrong length, oversized BigInt/UBI, empty-BigInt, unsupported non-numeric `T`).
- **Signed-256 no-op confirmed (independent adversarial review):** a ≤32-byte two's-complement value always fits signed-256 (JVM `toSignedBigIntValueExact` = `bitLength() ≤ 255`; the 32-byte extremes `0x80·00…` = −2²⁵⁵ and `0x7f·ff…` = 2²⁵⁵−1 both have `bitLength == 255`), so the BigInt arm needs no explicit range check.
- **Phase v6 P5b-1 COMPLETE (2026-06-04).** Method handler registry: 120 entries. EvalError codes: 77. Eval arm coverage: 67/67 (unchanged — adds a METHOD-REGISTRY entry, not an eval arm). Full suite: **3842 green** (node + jsdom; avltree 156 / nipopow 247 / scorex 177). `tsc --noEmit` clean (all 4 workspaces).

**Phase v6 P5c — `Global.powHit` (106:8)** (additive; 1 new method handler + 1 new `EvalError` code; docs-only until code lands):

- **1 new method handler (registry 122 → 123):** `SGlobal.powHit`, V3-gated (`minVersion: 3`). Source: JVM `methods.scala` (SGlobal `powHitMethod`, `methodId = 8`).
  - **`SGlobal.powHit` (106:8)** — `(SGlobal, Int, Coll[Byte], Coll[Byte], Coll[Byte], Int) → SUnsignedBigInt`. Args: `k: Int`, `msg: Coll[Byte]`, `nonce: Coll[Byte]`, `h: Coll[Byte]`, `N: Int`. Returns the Autolykos-2 PoW hit as `SUnsignedBigInt`.
  - **Cost** (`PowHitCostKind`, JVM `CostKind.scala:79-87`): `FixedCost` charged BEFORE the guards with value `500 + (k+1) * (floor((msg.len+nonce.len+h.len)/128) + 1) * 7`. Uses `CalcBlake2b256.costKind` constants (chunkSize=128, perChunkCost=7). Cost is charged from the raw `k` arg BEFORE the parameter guards fire — a guard-throwing call still incurs the full cost.
  - **Parameter guards** (after cost): `k < 2`, `k > 32`, or `N < 16` → throws `EvalError('pow-hit-invalid-params')`, mapping `@ergots/scorex`'s `PowHitInvalidParamsError`. Also covers the structural `obj.kind !== 'Global'` / `args.length !== 5` defensive guards (same compact-taxonomy code `'pow-hit-invalid-params'` for all guard throws, per Decision #1).
  - **Computation**: delegates to `@ergots/scorex`'s `autolykosHitForMessageWithChecks(k, msg, nonce, h, N)` (Architecture C″ shared hit core; JVM `Autolykos2PowValidation.hitForVersion2ForMessageWithChecks`, `Autolykos2PowValidation.scala:115-120`). Returns `{ kind: 'UnsignedBigInt', value: bigint }`.
- **`mir/method-signatures.ts` resolver entry**: `(106, 8) → SUnsignedBigInt` (closed `tRange`; non-generic return, no type-var substitution needed).
- **1 new `EvalError` code (79 → 80):** `'pow-hit-invalid-params'` — see taxonomy below.
- **No new `SValue` variants.** Returns existing `{ kind: 'UnsignedBigInt' }` (added in v6 P2a).
- **No wire change.** Rides the generic `MethodCall` dispatch path (typeId 106, methodId 8, 5 args); the wire layer already handles any `MethodCall` shape.

**Phase v6 P5c COMPLETE (docs-only).** Method handler registry: 123 entries. EvalError codes: 80. Eval arm coverage: 67/67 (unchanged — adds a METHOD-REGISTRY entry, not an eval arm). Source: JVM `sigma/ast/methods.scala:1884-1900`, `sigma/ast/CostKind.scala:71-88`, `sigma/pow/Autolykos2PowValidation.scala:115-137`.

**Phase v6 P6 — higher-order lambdas (first-class functions)** (1 new eval-arm-equivalent — `FunDef`-as-`ValDef`; **1 new `EvalError` code** `'apply-unresolved-type-var'`; 2026-06-05):

- **Initial framing was incomplete.** The P6 design spec initially framed this phase as "eval engine already supports HOF — just add FunDef parse + exprTpe fix." That was true for the happy path, but the real work also included two consensus-critical fixes: **lexical-scoping (closures)** and the **type-var-apply reject**. Both are documented below.

- **First-class-function support (verified, not assumed).** ergots evaluates **functions stored in composite types** (tuples/collections), selected/indexed out via `SelectField`/`ByIndex`, passed as values, and `Apply`'d. The machinery landed in phase 2e and after: `FuncValue` → Lambda SValue (Fixed(5)), a generic `Apply` that evaluates its `func` **expression** and invokes the resulting Lambda (Fixed(30) + `ADD_TO_ENV_COST`(5)/arg, arity-checked), plus `SelectField`/`ByIndex`/`Tuple`. Verified against the JVM-blessed conformance vector (`higher_order_lambdas.json`): value `Coll[Int][2,3]`, **cost 408**, both exact at ErgoTree v3; rejected at v2.

- **The v6 version gate is purely the `SFunc` type code (112).** `FuncValue`/`Apply` deserialize at every tree version (the JVM registers them unconditionally); the only function-related gate is the `SFunc` type code at V3+ (`TypeSerializer.scala:211`). ergots reproduces this in the `validateV6Types` pre-eval pass (P2a): it deep-walks the wire-serialized type annotations (including `FuncValue.args[].tpe`, and recurses `SColl.elem`/`STuple.items`/`SFunc.args`/`SFunc.result`) and rejects an `SFunc` appearing in any serialized type annotation under `treeVersion < 3` with `EvalError('v6-type-in-pre-v3-tree')`. No new gate is added in P6 — the existing pass already covers `SFunc`-in-composite and `SFunc`-in-`FunDef`-`rhs`. (See the P2a changelog entry and the `'v6-type-in-pre-v3-tree'` taxonomy entry; the wire-layer permissive-parse / pre-eval-gate split is documented in [`facts/ergoscript-wire.md`](./ergoscript-wire.md).)

- **`FunDef` evaluates as a `ValDef` (Fix 1 — wire under-accept).** A `FunDef` is a `ValDef` carrying a non-empty `tpeArgs: STypeVar[]` (a polymorphic `let f[T] = rhs`); see the `FunDef` wire section in [`facts/ergoscript-wire.md`](./ergoscript-wire.md). Previously the wire layer parse-rejected the `0xd7` opcode; P6 parses it. **Eval is unchanged:** `eval/val-def.ts` + `eval/block-value.ts` bind a `ValDef` by evaluating `rhs` and binding `id → v`; the `tpeArgs` are **eval-irrelevant** (type parameters are not inspected at runtime), exactly mirroring the JVM `BlockValue.eval` which casts every block item to `ValDef`, evaluates `rhs`, and ignores `tpeArgs`. The bind charges the same `ADD_TO_ENV_COST`(5) per `BlockValue` item as a plain `ValDef` — no new cost. Eval-arm coverage now includes `FunDef` (as a `ValDef`-tagged node). All-version (NOT V3-gated), matching the JVM.

- **`exprTpe(Apply)` `SAny` relaxation (Fix 2 — over-reject on unresolved func type).** `mir/expr-tpe.ts` previously threw `ExprTpeError('apply-func-not-sfunc')` when `exprTpe(e.func)` was not `SFunc` — **including when it was `SAny`**. The sibling arms `ByIndex` and `OptionGet` instead relax `SAny → SAny` (the documented PropertyCall/MethodCall SAny-cascade convention while a method-return type is unresolved). P6 makes the `Apply` arm match: when the func's static type is `SAny`, return `{ tag: 'SAny' }`; keep the throw for any *other* non-`SFunc` tag (a genuinely malformed AST). **Value-only, zero cost** — it only widens an internal throw to the same `SAny` the siblings already produce. The runtime `Apply` arm still concretely checks the evaluated value is a Lambda.

- **Lexical scoping (closures) — the prior dynamic-scoping was wrong for v6 (Fix 3).** Prior to P6, the `Closure` SValue carried only `{ argIds, body }` — no captured environment. Every invocation site (direct `Apply` + the 7 lambda HOF arms: `coll-map`, `coll-fold`, `coll-filter`, `coll-exists`, `coll-forall`, `scoll-flat-map`, `soption-map`) evaluated the body in **the caller's env** extended with args. This is dynamic scoping, which matches sigma-rust's pre-v6 behavior but **not the JVM** for v6 closures. P6 fixes it: `FuncValue` captures its definition-site environment (`capturedEnv: env`) into the `Closure` SValue; all 7 HOF arms + the direct `Apply` arm now evaluate the body in `closure.capturedEnv` extended with the per-call arg bindings — not the caller's env. **Concrete effect:** currying `{ val add = (a:Int)=>(b:Int)=>a+b; add(3)(1) }` now correctly evaluates to `Int 4` (previously `'val-use-unbound'` because `a` was not in the caller's env at the inner `Apply`). No cost change. Source: JVM `BlockValue.eval` + `FuncValue` closure semantics (`values.scala:911-1004`; `LanguageSpecificationV6.scala:1603-1672`); canonical for v6 (not sigma-rust, which has the same dynamic-scoping issue pre-v6 fixes).

- **Type-var-apply reject — new `EvalError` code `'apply-unresolved-type-var'` (Fix 4).** Applying a lambda (closure) whose declared argument type is — or structurally contains — an unresolved `STypeVar` throws `EvalError('apply-unresolved-type-var')` at the apply-time arg binding, **at every lambda-invocation site** (`apply.ts` + the 7 HOF arms), BEFORE the arg is bound — independent of whether the body reads the arg. New helper `eval/_lambda.ts:assertArgTypeResolved` performs a deep structural check (`containsTypeVar`). The JVM rejects such an application: resolving the type-var arg's runtime RType fails (`stypeToRType(STypeVar)` → `RuntimeException: Unknown type T`). A type-var lambda that is bound-but-never-applied evaluates fine (the binding itself is OK, the `FunDef` / `ValDef` bind only evaluates `rhs` and ignores `tpeArgs`); this fires ONLY at apply-time. The closure's `argTpes: SType[]` field (parallel to `argIds`) carries the declared arg types, added in P6 to `FuncValue` → they are captured at `FuncValue` eval time alongside `capturedEnv`. Honest compiler-produced trees never apply a type-var-arg lambda (polymorphic FunDefs are monomorphized at the call site); this is an adversarial over-accept. Source: JVM `stypeToRType(STypeVar)` → `RuntimeException("Unknown type T")`; SANTA vector `HOF_FunDef_type_var_body.json` (blessed_by `jvm:sigma-state-6.0.3`).

- **Conformance.** `test/conformance/cost-v6.test.ts` runs JVM-blessed SANTA vectors (`vectors/eval/v6/`, blessed_by `jvm:sigma-state-6.0.3`):
  - `higher_order_lambdas.json` (a function stored in an `SPair`, `SelectField`'d out + applied): `Coll(1,2) → Coll[Int][2,3]`, cost 408 (ErgoTree v3); an in-test v2-reject companion pins `'v6-type-in-pre-v3-tree'` (the `SFunc`-in-`SPair` gate).
  - `HOF_FunDef_polymorphic_identity.json` (FunDef `0xd7`, concrete body): `id(7) → 7`, cost 58 (1 entry).
  - `HOF_currying_Apply_of_Apply.json`: `add(3)(1) → 4`, cost 119 — verifies the lexical-scoping fix.
  - `HOF_function_in_Coll_of_SFunc.json`: `fs(0)(5) → 6`, cost 130 (1 entry).
  - `HOF_FunDef_type_var_body.json` (4 entries): bound-but-never-applied `{ val id[T]={(x:T)=>x}; 5 } → 5` (accept) + 3 type-var-*applied* cases → `'apply-unresolved-type-var'` (reject).
  - `Global.powHit_varying_k.json` (P5c follow-up): k=2/16/31 → blessed `UnsignedBigInt` value + cost 535/633/738; `Global.powHit_require_boundary.json`: k=1/33/N=15 → reject.
  - Full suite **3891 green** (node + jsdom), `tsc --noEmit` clean.

- **1 new `EvalError` code** (80 → **81**): `'apply-unresolved-type-var'`. Wire-layer `ExprParseError('fun-def-tpe-arg-not-type-var')` (Task 3, `19c5481`) was added earlier in P6 and is documented in [`facts/ergoscript-wire.md`](./ergoscript-wire.md). Source: JVM `data/shared/src/main/scala/sigma/ast/values.scala:911-1004` (`FunDef`-is-`ValDef`; `BlockValue.eval` ignores `tpeArgs`), `serialization/TypeSerializer.scala:111,211` (`SFunc` V3 gate), `LanguageSpecificationV6.scala:1603-1672` (the canonical HOF feature). Spec: `docs/specs/2026-06-05-ergoscript-v6-p6-higher-order-lambdas-design.md`.

**F3 (2026-06-07):** SigmaProp `Eq`/`NEq` cost = MatchType(1)/node + EQ_GroupElement(172)/ECPoint
compared (recursive walk in `eval/bin-op/_sigma-boolean-eq.ts`, JVM `DataValueComparer.scala:253-282,353-361`),
replacing the flat `EQ_PRIM_COST=3` byte-compare; conjecture-left vs different-variant-right throws
`'sigma-boolean-compare-unsupported'` (value fork closed); ECPoint equality gains the 0x00-lead
identity class — in the walk AND the bare-GroupElement scalar/bulk arms (second value fork closed).
`serializeCost` gains the `SSigmaProp` arm (`addSigmaBooleanCost`: opcode 1/node, dlog +36, DHT +144,
conjecture counts putUShort(3) each; putUShort=3 source-verified). The walks recurse depth-guard-free:
parse-bounded (reader level 110) for wire trees, cost-bounded for eval-constructed conjectures —
the JVM's own posture. Codes 79→80.

- **F3.5 (2026-06-07):** signed-i64 view extended from the F2 timestamps to ALL u64-wire→SLong
  surfaces — `Box.value` (ExtractAmount + R0), token amounts (SBox.tokens 99:8 + R2 tuples):
  `BigInt.asIntN(64,·)` at the view, raw u64 kept on `ErgoBox` (JVM unbounded-getULong + `as Long`;
  SANTA `Box.signed_view_u64` ×9 blessed; the boundary fix also closed latent consumer throws —
  pre-fix `serialize(b.value)` of a >2⁶³ box hit `numeric-out-of-range` where the JVM serializes
  the signed Long). `SOption.map` charges `ADD_TO_ENV_COST(5)` per lambda invocation on the Some
  path (JVM AddToEnvironmentDesc, charge order verified exact incl. the type-var reject between
  the 20 and the 5; blessed 65/65/39; second site of the Apply class — the 5 remaining Coll HOF
  arms are vector-ask-gated, see the conformance ledger). 0 new EvalError codes. The F3
  conjecture-throw fix is now empirically blessed (`EQ_of_SigmaProp_conjecture_mismatch` ×4
  vendored green; sigma-rust shared the fork, routed via SANTA).

## Public surface (v0.3.0)

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
- **Coverage caveat:** 67 of 67 implementable `Expr` variants have implemented arms. 18 wire opcodes (ModQ family, OpTrue/False, UnitConstant, Select1-5, CollShift/Rotate families, SomeValue, NoneValue) are reserved in sigma-rust's `OpCode` enum but unconditionally parse-rejected — sigma-rust itself never dispatches them. We mirror via `ExprParseError 'opcode-reserved'`. (`FunDef` (`0xd7`) was the 19th — v6 P6 now parses it as a `ValDef` carrying `tpeArgs` and evaluates it via the `ValDef` arm; see the P6 changelog above and [`facts/ergoscript-wire.md`](./ergoscript-wire.md).) A further 4 (LastBlockUtxoRootHash, FlatMap, TrivialPropFalse, TrivialPropTrue) are routed through other dispatch paths in sigma-rust (PropertyCall id 9, SColl method-call, SSigmaProp nesting); their top-level direct-dispatch `'not-implemented-yet'` status remains under separate review. Trees whose body reaches a not-yet-implemented method-call handler or an eval path with a defensive `EvalError 'not-implemented-yet'` (5 sites: `eval.ts:229`, `global-vars.ts:136`, `bin-op/relation.ts` ×2, `bin-op/bit.ts:58`) still throw at runtime. The `evaluate` signature itself is stable; phase 2j adds cost calibration.

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
  /** Per-input context extensions, indexed by SPENDING-TRANSACTION input position — mirrors JVM
   *  spendingTransaction.inputs(i).extension (CContext.scala:76-83). SContext.getVarFromInput (101:12)
   *  reads this. May legitimately differ in length from `inputs` (the JVM's own blessed
   *  getVarFromInput vector has tx.inputs = 0 while ctx.inputs = 1) — never validate length equality.
   *  Invariant (documented, not enforced): when both are supplied, inputExtensions[selfIndex] ≡ extension.
   *  Absent ⇒ every getVarFromInput lookup → None. */
  inputExtensions?: ContextExtension[]    // phase v6 P7a — getVarFromInput context model
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
  | { tag: 'SUnsignedBigInt' }                        // v6 P2a — type code 9; permissive parse, pre-eval gate
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
  | { kind: 'UnsignedBigInt'; value: bigint }         // v6 P2a — distinct from BigInt; unsigned magnitude
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

## `EvalError` taxonomy (79 codes)

`EvalError` carries a `code: string` distinct from the wire-layer error classes. Every code below is emitted by current source under the conditions noted. P2b added 1 new code (`'unsigned-bigint-out-of-range'`) and extended `'unsigned-bigint-op-unsupported'` (P2a) to also cover UBI cast arm rejects. P2d-2 added `'unsigned-bigint-not-invertible'` (73 total). P3 adds 0 new codes. P4 adds 1 new code (`'method-call-empty-args'`; 74 total). P5a adds 2 new codes (`'global-serialize-failed'`, `'global-deserialize-failed'`; 76 total). P5b-1 adds 1 new code (`'global-from-bigendian-bytes-failed'`; 77 total). P5b-2 adds 2 new codes (`'global-encode-nbits-failed'`, `'global-decode-nbits-failed'`; 79 total). P5c adds 1 new code (`'pow-hit-invalid-params'`; 80 total). P6 adds 1 new code (`'apply-unresolved-type-var'`; 81 total). **F1 (2026-06-06) removes 2 codes** (`'atleast-bound-out-of-range'` Task 2, `'deserialize-context-key-not-found'` Task 3): 81 → **79**. **F3 (2026-06-07) adds 1 new code** (`'sigma-boolean-compare-unsupported'`): 79 → **80**. **F4 epilogue Task 2 (2026-06-07) adds 1 + removes 1** (`'unsupported-eval-node'` added for the TreeLookup/CreateAvlTree unconditional rejects; `'create-avl-tree-shape-mismatch'` removed — orphaned by the CreateAvlTree reject): net 80 → **80**. **F4 epilogue Task 3 (2026-06-07) removes 1** (`'avl-tree-bad-digest-length'` retired — JVM `CAvlTree.scala:31-34` no-require, any digest length accepted): 80 → **79**.

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
- **`'bin-op-kind-mismatch'`** — a BinOp requiring same-kind operands (Arith, Bit, Relation-ordering) got different kinds. **Mismatched-NUMERIC operands are version-gated** (mirrors the JVM deserializer's auto-upcast, `DeserializationSigmaBuilder.applyUpcast`, `SigmaBuilder.scala:750-756`, gated `ergoTreeVersion < 3`): at `ctx.treeVersion < 3`, Arith / Relation-ordering / `Eq` / `NEq` **coerce** the narrower operand to the wider — charging one `Upcast` (10/30 by target) and evaluating at the wider kind (arith result widens; `Eq`/`NEq` value can flip `false`→`true`) — instead of throwing / returning false. At `treeVersion >= 3` the mismatch is rejected: Arith / ordering throw this code at eval, and **#2's pre-eval pass `validateBinOpTypes`** (2026-06-02) rejects concretely-typed mismatched comparison/equality whole-tree (incl. dead branches) before eval — `'bin-op-kind-mismatch'` for the SameType violation, `'bin-op-not-numeric'` for the ordering OnlyNumeric violation. The eval-arm `Eq`/`NEq`→`false` / coerce behavior now applies only to operands the pass SKIPS (static type `SAny`). **Bit** ops are NOT in the upcast class (`BitOp` bypasses `applyUpcast`) → always this code on mismatch. Non-numeric (or numeric-vs-non-numeric) mismatch is never coerced. **P2c:** a UBI arith BinOp with a non-UBI other operand (e.g. `Plus(ubi, Int)` in a hand-crafted V3 tree) also throws this code — the `arith.ts` UBI branch guards `rv.kind !== 'UnsignedBigInt'`. UBI ordering/equality mismatches are caught pre-eval by `validateBinOpTypes` (SameType). Spec: `docs/specs/2026-06-01-ergoscript-mismatched-numeric-coercion-design.md` (#1) + `2026-06-02-ergoscript-binop-sametype-strictness-design.md` (#2) + `docs/specs/2026-06-03-ergoscript-v6-p2c-sunsignedbigint-binops-bridges-design.md` (P2c).
- **`'bin-op-not-numeric'`** — at EVAL time, operand kind not in `{Byte, Short, Int, Long, BigInt}` for an op requiring numeric operands (the eval-time `isNumeric` in `eval/bin-op/_numeric.ts` is **NOT** widened for UBI — Critical 1; a UBI operand is handled by a local branch BEFORE this guard, so it never throws this code at eval). Also raised PRE-EVAL by #2's `validateBinOpTypes` for an ordering (`Lt`/`Le`/`Gt`/`Ge`) operand whose static type is concretely non-numeric (`OnlyNumeric`); P2c added `SUnsignedBigInt` to that pass's **separate** `isNumericTpe` predicate so a V3+ `LT(ubi,ubi)` is admitted (a UBI ordering operand in a pre-V3 tree is gated earlier by `validateV6Types`, P2a, not here).
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
- ~~`'atleast-bound-out-of-range'`~~ — **REMOVED in F1 Task 2 (2026-06-06).** The JVM `Atleast` arm applies degenerate-bound reductions BEFORE any range check: `bound ≤ 0` → `TrivialProp(true)` (SigmaAnd of empty = vacuous truth); `bound > items.length` → `TrivialProp(false)` (unachievable threshold — AFTER the item-count is known at eval, so cost is still charged per-item via Pattern B before the reduction). There is **no eval-time 255-bound cap** — the 255-CHILDREN limit (`MaxChildrenCount`) on the collection length is a separate constraint (deferred to F5, currently un-enforced in ergots). Cost is unchanged: the per-item `addPerItemCost(20, 3, 5, n)` is always charged before the reductions run. Both degenerate reductions land on the side of a live `cthresholdReduce` path and produce a `SigmaProp(TrivialProp)` SValue directly. Source: JVM `CSigmaDslBuilder.atLeast` + sigma-rust `atleast.ts` (ergo-node-integration); pinned by SANTA conformance vectors `atLeast_bound_zero.json` / `atLeast_bound_exceeds_size.json`.
- **`'sigma-prop-coll-elem-not-sigma-prop'`** — `Atleast` / `SigmaAnd` / `SigmaOr` arm (via `eval/_sigma-helpers.ts::expectSigmaProp`): an item evaluated to non-SigmaProp.
- **`'sigma-prop-input-not-coll'`** — `Atleast` arm (via `extractSigmaPropColl`): the `input` expression evaluated to non-Coll. (`SigmaAnd`/`SigmaOr` take `items: Expr[]`, not a Coll input, so this code applies only to `Atleast`.)

### Phase 2g.5 codes (Context, SigmaPropBytes, MethodCall, PropertyCall)

- **`'sigma-prop-bytes-input-not-sigma-prop'`** — `SigmaPropBytes` arm received an input `SValue` whose `kind !== 'SigmaProp'`. Wire-format invariants make this unreachable for parser-produced trees.
- **`'method-not-implemented'`** — `MethodCall` / `PropertyCall` dispatcher: the `(typeId, methodId)` pair has no registered handler in the `HANDLERS` registry. Also reused for defensive shape mismatches inside registered handlers (per error-taxonomy Decision #1: compact taxonomy — covers both "dispatch miss" and "handler shape mismatch" to keep the code count low). Reused by all 2g.5 + 2g.6 handlers for obj-kind defensive throws.
- **`'context-obj-not-context'`** — `SContext.dataInputs` handler (and `SContext.preHeader` handler from 2g.6): the `obj` argument evaluated to an `SValue` whose `kind !== 'Context'`. Wire-format invariants make this unreachable for parser-produced trees.

Phase 2g.6 added ZERO new codes — all 5 handlers reuse the codes above.

### Phase 2h-b codes (SAvlTree.* method handlers)

- **`'avl-tree-obj-not-avl-tree'`** — defensive receiver check on all 13 SAvlTree.* handlers when `obj.kind !== 'AvlTree'`. Wire-format invariants make this unreachable for parser-produced trees.
- **`'avl-tree-proof-failed'`** — thrown when `@ergots/avltree`'s `verifyAvlBatch` / `verifyAvlBatchPartial` returns `null` AND the method's JVM contract calls for a throw on that path. **JVM-canonical construct-fail routing** (F4, 2026-06-07): the JVM `BatchAVLVerifier` wraps construction in `Try{…}.toOption`; `CAvlTreeVerifier.logError` is a no-op; a bad proof yields `topNode = None`, not a throw. Observable routing per method:
  - `contains` (100:9) — construct-fail → **`false`** (NOT a throw; JVM-canonical); per-op fail → `false`. Neither path throws `'avl-tree-proof-failed'`. Cost charged before the probe: cv PerItem(110,20,64) + 1 Lookup PerItem(40,10,1).
  - `get` (100:10) — construct-fail → throws `'avl-tree-proof-failed'` (charged: cv + 1 lookup first); per-op fail → throws (same). Key-absent → `None` (no throw).
  - `getMany` (100:11) — construct-fail with ≥1 key → throws `'avl-tree-proof-failed'` (charged: cv + 1 lookup); zero-keys → empty Coll, NO throw even on construct-fail (charged: cv only); first Lookup Failure → throws; per-key absence → per-key None.
  - `insert` (100:12) — construct-fail: **V<3 throws** `'avl-tree-proof-failed'` **(requires ≥1 op; zero-ops → None at every version)**, **V3+ → None** (no throw; construct-fail joins the first-op-fail path). Per-op fail: V<3 throws, V3+ → None. Charged-ops on construct-fail: `min(1, ops.length)` — zero-ops → 0 charges, ≥1-op → 1 charge.
  - `update` (100:13) — construct-fail → **None** (no throw, no version split); per-op fail → None.
  - `remove` (100:14) — construct-fail → **None** (never throws); per-op fail → None (never throws; ops always charged, digest(15) always charged).
  - `insertOrUpdate` (100:16) — construct-fail → **None** (never throws); per-op fail → None.

  **Op-shape mismatches join the per-op-fail path (F4 T7.5, 2026-06-07).** scorex checks key shape per-op at the head of `returnResultOfOneOperation` (`require(key > -inf)`, `require(key < +inf)`, `require(key.length == keyLength)` — ±inf = all-0x00/all-0xFF × keyLength) and value length (fixed-value trees, value-carrying ops) at the `modifyHelper` write branches; each violation is a `Failure` AT THAT OP'S INDEX (ops before it replay normally; the tree then poisons). Verified against scrypto 3.0.0 bytecode + `ergo_avltree_rust` (`authenticated_tree_ops.rs:226-229,291,314`). The handlers emulate this with a pre-scan (`firstShapeBadOpIndex`) + prefix-slice (`verifyWithShapeRouting`) because `@ergots/avltree`'s public API validates shapes upfront (throws `AvlVerifyError` — which must never escape the evaluator). Whichever failure comes first in op order wins. Construct-shape violations (`keyLength <= 0`, fixed `valueLengthOpt < 0`, `digest.length != 33` — scorex reconstruction requires, swallowed) route as construct-fail with **treeHeight 0** for the per-op charges (the requires fire before `rootNodeHeight` is assigned; lookup family charges base-only `nItems=0`, modify family `max(0,1)=1`). No `AvlVerifyError` reaches script evaluation on any input.

Single code per the compact-taxonomy decision from 2g.5; granular per-cause codes are noise without caller value (these are all "the script's assumption about chain state was wrong" and not branched-on by callers).

### Phase 2h-c.1 codes (SHeader.* method handlers)

- **`'header-obj-not-header'`** — defensive receiver check on all 15 SHeader handlers when `obj.kind !== 'Header'`. Wire-format invariants make this unreachable for parser-produced trees.

### Phase 2h-c.2 codes (SHeader.checkPow)

- **`'autolykos-v1-not-supported'`** — `SHeader.checkPow` handler caught an `AutolykosV1NotSupportedError` from `verifyAutolykosV2`. Mirrors sigma-rust's `AutolykosPowSchemeError::Unsupported` (`autolykos_pow_scheme.rs:322-324`). Real Ergo nodes (incl. ergo-node-rust) skip v1 PoW verification structurally; this code is the surface for the unusual case where `ctx.headers` includes a V1 header AND the script invokes `checkPow` on it.

### Phase 2h-d codes (SAvlTree.updateDigest) — F4 epilogue update

- **`'avl-tree-bad-digest-length'`** — **RETIRED in F4 epilogue (2026-06-07).** JVM `CAvlTree.scala:31-34` has no length require on `updateDigest`; any `Coll[Byte]` length is accepted verbatim. The code mirrored sigma-rust's `ADDigest::try_from` length-check failure, which was a convergent over-reject not present in the JVM. Codes: 80 → 79. Blessed vectors: `AvlTree.updateDigest_any_length.json` (3-byte, empty, 40-byte → Some(AvlTree) cost 46; 3-byte readback via `.digest` → Coll[1,2,3] cost 65).

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
- ~~`'create-avl-tree-shape-mismatch'`~~ — **REMOVED in the F4 epilogue (2026-06-07).** The `CreateAvlTree` arm became an unconditional `'unsupported-eval-node'` reject (the JVM has no eval override for the node), orphaning all 3 shape-mismatch throw paths (non-Byte flags, non-Int keyLength, non-Int valueLength). See the F4-epilogue code section below.

`TreeLookup` introduced ZERO new codes in 2i-b — it reused `'avl-tree-obj-not-avl-tree'`, `'predef-input-not-byte-array'`, and `'avl-tree-proof-failed'`. **All three uses retired in the F4 epilogue** — the arm now rejects unconditionally with `'unsupported-eval-node'` before any operand check (the three reused codes keep their other throw sites).

### Phase 2i-c codes (deserialize family)

- ~~`'deserialize-context-key-not-found'`~~ — **REMOVED in F1 Task 3 (2026-06-06).** The JVM `Interpreter.scala:110-123` `substDeserialize` returns `None` when a `DeserializeContext` ctx var is absent (key not found) or wrong-typed — leaving the node UNCHANGED in the expression tree. The node stays in place without throwing; it is only evaluated (and throws `'deserialize-not-substituted'`) if it reaches a live execution branch. The original ergots implementation eagerly threw during the substitute pass, mis-porting pre-fix sigma-rust behavior. **DR/DC asymmetry preserved (both JVM-faithful):** `DeserializeRegister` with a wrong-typed register entry STILL throws eagerly (`'deserialize-input-not-byte-array'`) — the JVM erases to `ClassCastException` at that site, which sigma-rust (eni) mirrors as an immediate error. Only the DC absent-key and DC wrong-typed-var sites are now failure-tolerant (return node unchanged). Pinned by SANTA conformance vectors `dead-branch-absent#0` / `dead-branch-wrong-type#1`. Source: JVM `Interpreter.scala:110-125`, sigma-rust `mir/expr.rs:442-496` (eni branch `ergo-node-integration`).
- **`'deserialize-input-not-byte-array'`** — `DeserializeContext` / `DeserializeRegister` substitute pass: the context-extension entry / register entry's `tpe` is not `SColl<SByte>` (or its `value` is not a `Coll` with Byte items). For DC: only reached when the var IS found and IS a byte array that fails extraction — not for absent/wrong-typed vars (those return node unchanged, per the F1 fix). For DR: reached eagerly on wrong-typed register entry (JVM erasure → `ClassCastException` → ergots throws; the DR asymmetry is preserved). Mirrors sigma-rust `SubstDeserializeError::TryExtractFromError` via `try_extract_into::<Vec<u8>>()` failure at `mir/expr.rs:459` (DC) and `:472` (DR).
- **`'deserialize-parse-failed'`** — `DeserializeContext` / `DeserializeRegister` substitute pass: the inner Expr bytes (decoded from `ctx.extension` or `selfBox.registers`) fail to parse. Wraps the underlying wire-layer error class + message in `.message`. Mirrors `SubstDeserializeError::ExprParsingError(SigmaParsingError)` at `mir/expr.rs:725` and the inner parse calls at `:462-464` (DC) / `:474` (DR).
- **`'deserialize-tpe-mismatch'`** — `DeserializeContext` / `DeserializeRegister` substitute pass: `exprTpe(parsed) !== e.tpe`. Check runs on BOTH the register-decoded inner Expr AND the `default` fallback Expr (per `mir/expr.rs:486-491` — applied post-`.or(default.as_deref().cloned())`). Mirrors `SubstDeserializeError::ExprTpeError { expected, actual }` at line 727.
- **`'deserialize-not-substituted'`** — `DeserializeContext` / `DeserializeRegister` eval-time defensive throw. Reached when the substitute pass did NOT rewrite a node. Three cases: (a) `DeserializeRegister` with register absent + `e.default === null` — sigma-rust `substitute_deserialize` returns `Ok(())` LEAVING the node unchanged per `mir/expr.rs:478-481` ("When script in register is not found, and default is not defined, leave DeserializeRegisterNode unchanged, which will error on evaluation"); the defensive throw is the canonical mirror. (b) `DeserializeContext` with an absent or wrong-typed ctx var — the F1-fixed failure-tolerant path also leaves the node unchanged; this throw is reached if that node appears in a LIVE execution branch (the dead-branch case never reaches eval). (c) Recursive Deserialize: an outer Deserialize* decoded to an inner Expr containing another Deserialize* node — sigma-rust's `try_rewrite_bu` does NOT re-walk substituted children (`mir/expr.rs:397-408`), so the inner Deserialize survives and trips this throw.

### Phase v5 Coll-update codes (Coll.updated / Coll.updateMany)

- **`'coll-update-index-out-of-range'`** — `SColl.updated` (12:20) / `SColl.updateMany` (12:21): a target index is out of bounds for the receiver Coll. Genuine runtime error (indices are runtime `Int` values, not type-constrained); a NEGATIVE index wraps to a huge `usize` in sigma-rust ⇒ also OOB. Source: sigma-rust `UPDATED_EVAL_FN` / `UPDATE_MANY_EVAL_FN` (`eval/scoll.rs`, branch `ergo-node-integration`).
- **`'coll-update-many-length-mismatch'`** — `SColl.updateMany` (12:21): the `indexes` and `values` colls differ in length (genuine runtime error — lengths aren't constrained by the `Coll[T].updateMany(Coll[Int], Coll[T])` signature). Checked before the per-index OOB loop. Source: same.

### Phase v6 P1 — numeric method codes (Byte/Short/Int/Long/BigInt; all require `treeVersion >= 3`)

- **`'numeric-shift-out-of-range'`** — any `X.shiftLeft` or `X.shiftRight` (typeIds 2–6, methodIds 12–13) when the `bits` argument is outside `[0, width)` where `width` is 8/16/32/64/256 for Byte/Short/Int/Long/BigInt respectively. Both `bits < 0` and `bits >= width` are rejected. Mirrors the JVM `ExactIntegral.shiftLeft`/`shiftRight` range guard (scala/ExactIntegral.scala) and `BigIntegerOps` range guard (CBigInt.scala). Source: `eval/_numeric-v6.ts:makeShift`.
- **`'bigint-result-out-of-range'`** — any v6 BigInt operation whose result falls outside signed-256 range `[-2^255, 2^255 - 1]`. Currently reachable only via `BigInt.shiftLeft` (methodId 12), which can produce a result with bitLength > 255. `shiftRight` on an in-range value always stays in-range. Mirrors the JVM `CBigInt` constructor's `toSignedBigIntValueExact` (Extensions.scala:219) which throws `ArithmeticException` when `bitLength() > 255`. Distinct from `'byte-array-to-bigint-out-of-range'` (2i-a, which is for the `ByteArrayToBigInt` predef rejecting an over-width input). Source: `eval/_numeric-v6.ts:checkBigInt256`.
- **`'numeric-method-bad-operand'`** — any of the 40 v6 numeric method handlers when the receiver `obj` or an operand argument (arg for `makeBinaryBitwise` / bits arg for `makeShift`) evaluates to an unexpected `kind`. Mirrors the JVM `asInstanceOf` / sigma-rust `try_extract_into` rejection at eval. Wire-format invariants (MethodCall construction enforces typed args at build time) make this unreachable for parser-produced trees; defensive against hand-crafted MIR (adversarial wrong-kind constant injected as `obj` or `args[0]`). Without this guard, wrong-kind Byte/Short/Int operands silently return garbage; wrong-kind Long/BigInt operands throw a raw `TypeError` — both are consensus over-accept vectors. The guard is unconditional at runtime (concrete `obj.kind` is always concrete, never SAny — this is NOT a static `exprTpe` check). Source: `eval/_numeric-v6.ts:requireKind` (final-review C1 fix).

### Phase v6 P2a codes (`SUnsignedBigInt` type core)

- **`'v6-type-in-pre-v3-tree'`** — `validateV6Types` pre-eval pass: a walked `SType` is or contains `SUnsignedBigInt` (type code 9) **or** `SFunc` (type code 112) in a tree with `treeVersion < 3`. Fired on wire-serialized type annotations (NOT computed `exprTpe` — a v5 `map`/`fold` lambda's computed type is `SFunc` but carries no serialized code-112 annotation and must NOT be rejected). Zero JIT cost — the pass runs before `addCost` is ever called. Matches the JVM rejection at type deserialization (`TypeSerializer.scala:211` for SFunc; `getEmbeddableType`/`embeddableV5` for SUnsignedBigInt), applied instead at the authoritative `ctx.treeVersion` post-parse. Both `tree.constantTypes[]` (segregated-constant declared types) and the Expr body (via `childrenOf`) are walked — the `constantTypes[]` walk is mandatory for dead segregated constants and empty-typed-coll constants that carry no decoded UBI value but whose type annotation exposes the forbidden construct. Source: `eval/validate-v6-types.ts:validateV6Types`.
- **`'unsigned-bigint-op-unsupported'`** — a `UnsignedBigInt` SValue reached an eval arm or method handler that has not yet been implemented for UBI operands. All UBI methods (numeric/bitwise ids 6–13), casts (`Upcast`/`Downcast` for UBI), and modular-arithmetic ops are deferred to P2b/P2c. A v6 tree that evaluates a UBI constant successfully but then applies an unsupported op will throw this code. Distinct from `'not-implemented-yet'` (which is for unknown `Expr.tag` arms) — this code signals a known UBI-specific operation not yet wired. Source: emitted today from the comparison/equality value arms in `eval/bin-op/relation.ts` (a UBI operand reaching `sValueEquals`/`primitiveValueEqual`); further arms (methods/casts/modular) emit it as UBI operations land in P2b/P2c.

### Phase v6 P2b codes (`SUnsignedBigInt` numeric methods + casts)

- **`'unsigned-bigint-out-of-range'`** — a value fell outside the unsigned 256-bit range `[0, 2²⁵⁶)`. Two sources: (1) `UnsignedBigInt.shiftLeft` (9:12): after the bits-range guard (which fires first for `bits < 0` or `bits >= 256`), if the shifted result has `bitLength > 256` — mirrors the JVM `CUnsignedBigInt` constructor's rejection of `bitLength > 256` (`CUnsignedBigInt.scala:16–22`); (2) `Downcast`/`Upcast` with a signed Byte/Short/Int/Long source cast to UBI target where the signed value `< 0` — mirrors `CUnsignedBigInt(valueOf(x))` which rejects a negative `x` with an "unsigned-magnitude" throw. Distinct from `'bigint-result-out-of-range'` (P1, which is the signed-256 overflow on `BigInt.shiftLeft`). Source: `UnsignedBigIntegerOps.scala:131–149`, `CUnsignedBigInt.scala:16–22`, `SType.scala:522–543`.
- **`'unsigned-bigint-op-unsupported'`** (reused from P2a) — extended in P2b to cover the unsupported UBI cast conversions: (1) `Downcast(UBI, SBigInt)` — `SBigInt.downcast` has no UBI case in the JVM (`SType.scala:465–479`); (2) `Downcast/Upcast(BigInt, SUnsignedBigInt)` — `SUnsignedBigInt.*` has no BigInt case (`SType.scala:559–590`); (3) `Upcast(UBI, Byte/Short/Int/Long/BigInt)` — the signed/BigInt `upcast` has no UBI case. All semantically "this UBI↔BigInt or UBI-source-Upcast is not a supported language operation" — the language routes UBI↔BigInt conversions through `toUnsigned`/`toSigned` methods (P2c). **P2a** emitted this code from the two `relation.ts` stubs (`:553` scalar EQ, `:651` Coll-element EQ); P2b adds the cast-arm sources. **P2c** replaces the two `relation.ts` stubs with real implementations — after P2c, this code survives only in `_cast-ubi.ts` (3 live throws) plus the `eval-context.ts:26` doc-catalog comment. Source: `SType.scala:419–590`.
- **`'downcast-overflow'`** (existing, reused) — `Downcast(UBI, Byte/Short/Int/Long)` where the UBI magnitude exceeds the signed target's range. Same code as the pre-existing signed-narrowing case; the UBI arm reuses `checkRange(v, target, 'downcast-overflow')`. No new code. Source: `SType.scala:419–431` (`ubi.toXExact`).

Note: the version gate for casts is `validateV6Types` (P2a, walks `Upcast.tpe`/`Downcast.tpe`), not a per-arm check inside `downcastUBI`/`upcastUBI`.

### Phase v6 P2c codes (`SUnsignedBigInt` BinOps + bridge methods)

**P2c introduces ZERO new `EvalError` codes.** All error paths reuse existing symbols:

- **`'unsigned-bigint-out-of-range'`** (P2b) — **extended** to cover arith BinOp overflow/underflow: `Minus` underflow (`result < 0n`), `Plus`/`Multiply` overflow (`result > UBI_MAX = 2²⁵⁶−1`), and `BigInt.toUnsigned` (6:14) with a negative receiver (`value < 0n`). Mirrors `CUnsignedBigInt.{add,subtract,multiply}` → `toUnsignedBigIntValueExact` (`CUnsignedBigInt.scala:14-22`; `Extensions.scala:234-240`) and `BigInt.toUnsigned` "throws on negative" (`methods.scala:543-549`).
- **`'arith-divide-by-zero'`** (phase 2c) — reused by UBI `Divide` and `Modulo` when the right operand is zero. Same posture as signed numeric div/mod.
- **`'bin-op-kind-mismatch'`** (phase 2c) — reused when a UBI arith BinOp encounters a non-UBI other operand (e.g. `Plus(ubi, Int)` in a hand-crafted V3 tree). The `arith.ts` UBI branch guards `rv.kind !== 'UnsignedBigInt'`; ordering/equality mismatches are caught pre-eval by `validateBinOpTypes` (SameType).
- **`'bigint-result-out-of-range'`** (P1) — reused by `UnsignedBigInt.toSigned` (9:19) when `value ≥ 2²⁵⁵` (leftmost bit set). Mirrors `toSignedBigIntValueExact` requiring `bitLength ≤ 255` (`Extensions.scala:219-223`).
- **`'numeric-method-bad-operand'`** (P1) — reused by both bridge handlers (`BigInt.toUnsigned`, `UnsignedBigInt.toSigned`) for a wrong-kind receiver. Same `requireKind` guard pattern as all P1 numeric handlers. Source: `eval/_numeric-v6.ts:requireKind`.

### Phase v6 P4 code (Global.some/none + empty-args-MethodCall reject)

- **`'method-call-empty-args'`** — `validateMethodCallArity` pre-eval pass: a walked `MethodCall`-opcode node (`tag: 'MethodCall'`, NOT `PropertyCall`) has `args.length === 0` in a tree with `treeVersion >= 3`. Zero JIT cost — the pass runs before any `addCost` call. Method-agnostic (no `typeId`/`methodId` lookup; any zero-arg MethodCall in V3+ is rejected, including `groupGenerator` 106:1 and the adversarial `none`-via-MethodCall form 106:10). **Pre-V3 trees are grandfathered** — the pass does NOT reject at `treeVersion < 3`, matching the JVM version gate on the assert (`MethodCallSerializer.scala:53-55`). `PropertyCall` (the legitimate zero-arg opcode) is never rejected by this pass. Source: `eval/validate-method-call-arity.ts:validateMethodCallArity`.

### Phase v6 P5a codes (Global.serialize / Global.deserializeTo)

- **`'global-serialize-failed'`** — `SGlobal.serialize` (106:3): the sigma-serialization of the argument value failed. Raised when the internal `serializeSValue`/`serializeSType` round-trip throws for a value type that cannot be expressed in the wire format (e.g. a `'Lambda'` or `'Context'` SValue kind). Note: `serialize` derives the type `T` from the RUNTIME value's kind (NOT from `exprTpe` — the static type is always `Coll[Byte]`). V3-gated (`minVersion: 3`). Source: JVM `sigma/ast/methods.scala:1957`.
- **`'global-deserialize-failed'`** — `SGlobal.deserializeTo[T]` (106:4): the supplied `Coll[Byte]` bytes failed to parse as an SValue of type `T` via the data codec (`DataSerializer.deserialize`). Raised on malformed/truncated bytes, an oversized BigInt/UnsignedBigInt (> 32 bytes), or actual parse recursion deeper than `MaxTreeDepth` (110, data-driven — a deep TYPE with empty data is accepted; the bound is the shared `@ergots/scorex` `ByteReader` level counter, which raises `ReaderError('max-tree-depth-exceeded')` — caught here and re-coded). There is NO ErgoTree body parse and NO `exprTpe` match — `T` drives the parse directly. V3-gated (`minVersion: 3`). Source: JVM `sigma/ast/methods.scala:1906`.

### Phase v6 P5b-1 code (Global.fromBigEndianBytes)

- **`'global-from-bigendian-bytes-failed'`** — `SGlobal.fromBigEndianBytes[T]` (106:5): the supplied bytes could not be decoded as type `T`. Raised on wrong exact length (Byte≠1/Short≠2/Int≠4/Long≠8), oversized BigInt/UnsignedBigInt (>32 bytes), empty bytes for BigInt (JVM `new BigInteger(byte[0])` throws; UBI empty → 0 is accepted), or an unsupported non-numeric `T` (rejected at EVAL via the handler default branch — the JVM's unsupported-type throw is in the runtime body, not at deserialize). `FixedCost(10)` is charged before this throw. V3-gated (`minVersion: 3`). Source: JVM `sigma/ast/methods.scala:1925`, `CSigmaDslBuilder.scala:225-261`.

### Phase v6 P5b-2 codes (Global.encodeNbits / Global.decodeNbits)

- **`'global-encode-nbits-failed'`** — `SGlobal.encodeNbits` (106:6): defensive obj-kind/arity guards only. The handler has no faithful failure path for a valid ≤256-bit `SBigInt` input (`size ≤ 33` so `size << 24` cannot overflow); the error code exists solely for the `obj.kind !== 'Global'` / `args.length !== 1` defensive guards (unreachable on well-typed V3 trees). `FixedCost(25)` is charged before any guard throw. V3-gated (`minVersion: 3`). Source: JVM `methods.scala:1939`, `CSigmaDslBuilder.scala:190-194`.
- **`'global-decode-nbits-failed'`** — `SGlobal.decodeNbits` (106:7): the low-32-bit-truncated input decoded to a value whose signed bit-length exceeds 255 (signed-256 overflow reject), plus the defensive obj-kind/arity guards. The JVM's `CBigInt(NBitsUtils.decodeCompactBits(l).bigInteger.toSignedBigIntValueExact)` throws `ArithmeticException` when `bitLength > 255`; sigma-rust's `.try_into::<BigInt256>()` errors identically. Reachable for large exponent bytes (e.g. `size ≥ 0x21` with a high mantissa). The blessed `0x207fffff` has bit-length exactly 255 and accepts. `FixedCost(50)` is charged before this throw. V3-gated (`minVersion: 3`). Source: JVM `methods.scala:1944`, `CSigmaDslBuilder.scala:195-197`.

### Phase v6 P5c code (Global.powHit)

- **`'pow-hit-invalid-params'`** — `SGlobal.powHit` (106:8): the Autolykos-2 parameter guards failed (`k < 2`, `k > 32`, or `N < 16`), OR the structural `obj.kind !== 'Global'` / `args.length !== 5` defensive guards fired. Maps `@ergots/scorex`'s `PowHitInvalidParamsError` (thrown by `autolykosHitForMessageWithChecks`). `PowHitCostKind.cost(k, msg, nonce, h)` is charged BEFORE any guard throws — a guard-failing call still pays the full cost. V3-gated (`minVersion: 3`); pre-V3 dispatch throws `'tree-version-too-low'` (zero cost) instead. Source: JVM `Autolykos2PowValidation.hitForVersion2ForMessageWithChecks` (`Autolykos2PowValidation.scala:115-120`) — `require` guards translated to `PowHitInvalidParamsError` in scorex, re-coded here.

### Phase v6 P6 code (HOF lambdas / closures / type-var-apply reject)

- **`'apply-unresolved-type-var'`** — `Apply` arm + all 7 lambda HOF arms (`MapColl`, `Fold`, `Filter`, `Exists`, `ForAll`, `SColl.flatMap`, `SOption.map`): thrown at the apply-time arg binding when `closure.argTpes[i]` is — or structurally contains — an `STypeVar`. Raised by `eval/_lambda.ts:assertArgTypeResolved` BEFORE the arg is bound, independent of whether the body reads the arg. A type-var lambda that is bound but never applied evaluates fine (the `FunDef`/`ValDef` bind only evaluates `rhs` and ignores `tpeArgs`); this code fires only at apply-time. Mirrors the JVM `stypeToRType(STypeVar)` → `RuntimeException("Unknown type T")` in sigma-state 6.0.3. Honest compiler-produced trees never apply a type-var-arg lambda (polymorphic FunDefs are monomorphized at the call site); this is an adversarial over-accept guard. Source: SANTA vector `HOF_FunDef_type_var_body.json` (blessed_by `jvm:sigma-state-6.0.3`); `eval/_lambda.ts:assertArgTypeResolved`.

### Phase v6 P7a — 3 new method handlers, 0 new EvalError codes

**Registry 122 → 125. EvalError codes remain 81 (pre-F1).**

Three per-type method handlers are added in this phase. All gate on `minVersion: 3` via the dispatcher. No new `EvalError` codes are introduced — each handler reuses existing codes.

**`SBox.getReg[T]` (99:19, `getRegMethodV6`)** — `FixedCost(JitCost(50))` (= `ExtractRegisterAs.costKind`), Pattern A. Carries an explicit type arg `T` on the wire (`methods.scala:1338-1347`, `methods.scala` `Seq(tT)` declaration). Runtime semantics = `CBox.getReg` (`CBox.scala:32-44`): index `i` out of `[0, 9]` → `None`; absent register → `None`; defined + `sTypeEquals(stored.tpe, T)` → `Some(value)`; defined + mismatch → throws `'register-type-mismatch'` (the stored entry is typed but wrong — JVM `InvalidType`, `CBox.scala:41`). Reuses `getRegisterEntry` from `extract-register-as.ts` (R0–R3 synthesis included). The id-7 sibling (`getRegV5`) stays **unregistered**: it deserializes at every version (JVM id 7 is in `commonBoxMethods`) but eval-throws `'method-not-implemented'` on every call, at every tree version — because JVM reflection lookup of `"getRegV5"` on `classOf[Box]` → `NoSuchMethodException` on both JVM and JS platforms (`SigmaDsl.scala:490` declares only `getReg`, not `getRegV5`). Wire implication: `MethodCall(99, 7, ...)` carries **no** type-arg bytes (id 7 declares no explicit type args); the prior sigma-rust-shaped registry entry `99:7 → ['T']` mis-consumed one SType byte and is REMOVED in this phase (see `facts/ergoscript-wire.md`).

**`SContext.getVarFromInput[T]` (101:12, `getVarFromInputMethod`)** — `FixedCost(JitCost(10))` (= `GetVar.costKind`), Pattern A. Carries an explicit type arg `T` on the wire — the existing `101:12 → ['T']` entry in `wire/mir/explicit-type-args.ts` already matches the JVM; no wire change. Context model extension: reads `ctx.inputExtensions[inputIdx].values[varId]` — the new additive optional `inputExtensions?: ContextExtension[]` field on `EvalOpts`/`EvalContext`, indexed by SPENDING-TRANSACTION input position (mirrors JVM `spendingTransaction.inputs(i).extension`, `CContext.scala:76-83`). Semantics are **total, never throws**: `inputIdx` (Short) out of `[0, inputExtensions.length)` or field absent → `None`; varId missing at that input → `None`; stored entry + type mismatch → `None` (NOT a throw — see asymmetry note below). `getVar` (self) keeps reading `ctx.extension` unchanged.

**`SGroupElement.expUnsigned` (7:6, `ExponentiateUnsignedMethod`)** — `FixedCost(JitCost(900))` (= `Exponentiate.costKind`), Pattern A. Monomorphic — no explicit type args, zero wire change. Shares the `expPoint(baseBytes, k)` helper with the existing v5 `Exponentiate` arm (`eval/exponentiate.ts`): `decodePoint` → identity-base guard (`base.is0()` → 33 zero bytes; noble multiply-on-ZERO is uncontracted — guard is defense-in-depth mirroring sigma-rust, see `crypto/secp256k1.ts expPoint`) → `pointMul` (UBI scalar ∈ [0, 2²⁵⁶) reduced mod n) → `encodePoint`. Scalar edges: `g^0 = g^order = identity` (33 zero bytes); `g^1 = g`. Blessed JVM vectors (`LanguageSpecificationV6.scala:2475-2493`) pin all three edges. The identity-base guard and mod-n reduction are shared with the Exponentiate arm — no new crypto code.

**Three-way type-mismatch asymmetry (deliberate JVM behavior, pinned by tests):**

- `GetVar` (self, `CContext.scala:61-75`) **throws** `'get-var-type-mismatch'` on a stored var whose type ≠ requested type.
- `SBox.getReg` (`CBox.scala:41`) **throws** `'register-type-mismatch'` on a stored register whose type ≠ `T`.
- `SContext.getVarFromInput` (`CContext.scala:77-82`, `case _ => None`) **returns None** — a type mismatch is not distinguished from "var absent."

This asymmetry is a JVM API design decision, not a bug. Tests in this phase pin all three behaviors side-by-side to prevent accidental unification.

**MaxTreeDepth (110) — unified across ALL deserialization (cross-cutting, consensus).** Faithful port of the JVM single shared counter `CoreByteReader.level` (cap `SigmaConstants.MaxTreeDepth = 110`): one counter on the `@ergots/scorex` `ByteReader` (`enterDepth`/`exitDepth`, default `maxTreeDepth = 110`), bumped at the three central recursion funnels — the expr-node parser (`parseExpr`/`parseExprWithFirstByte` ≡ JVM `ValueSerializer.deserialize`), the data-value parser (`parseSValue` ≡ `CoreDataSerializer.deserialize`), and the SigmaBoolean parser (`parseSigmaBoolean` ≡ `SigmaBoolean.serializer.parse`). Because every ergots parser threads the one reader, ALL nesting kinds participate automatically — expr-tree (`parseTree`), data (`deserializeTo`), sigma-booleans (`deserializeTo[SigmaProp]`), and box internals (registers + a `hasSize=false` nested ergoTree; a `hasSize=true` body is skipped, matching the JVM Unparsed fallback). Off-by-one: a fresh level-0 reader sets level 1 on the first call and rejects the call that would set level 111 (boundary 110 accept / 111 reject). Over-depth raises `ReaderError('max-tree-depth-exceeded')`, which propagates unwrapped from the wire layer (like `ReaderError('truncated')`) or is caught at the `deserializeTo` boundary → `'global-deserialize-failed'`. The earlier piecemeal threaded-`depth` param on `parseSValue` (data path only) was replaced by this; no real mainnet tree (validated h=2→tip) nests near 110, so behavior is preserved for all real inputs and only adversarial >110 structures are newly rejected (matching the JVM). `@ergots/nipopow`'s block-codec parsers never call `enterDepth`, so the shared reader change is a no-op for them.

### F1 — chain-reachable value forks (atLeast degenerate bounds + DeserializeContext failure-tolerant substitution) — 2 codes REMOVED, 81 → **79**

Committed 2026-06-06 (commits `eb09892`/`f5dd083` atLeast, `5580a75`/`b614d6e` DC). Conformance: all F1 SANTA vectors green.

**Task 2 — `'atleast-bound-out-of-range'` REMOVED.** `Atleast` now applies JVM-faithful degenerate-bound reductions: `bound ≤ 0 → TrivialProp(true)`; `bound > items.length → TrivialProp(false)`. Both reductions fire AFTER the per-item cost pass (cost unchanged — Pattern B `addPerItemCost(20, 3, 5, n)` is always charged). The removed code guarded `bound < 0 || bound > 255 || bound > items.length`; the 255-bound cap is a separate concern (deferred to F5 — the 255-CHILDREN cap on input-coll length remains un-enforced in ergots; see §F5 in the conformance-run spec for the ordering question). `'atleast-bound-not-int'` stays (non-Int `bound` is still an error). Source: JVM `CSigmaDslBuilder.atLeast`; sigma-rust `atleast.ts` (ergo-node-integration).

**Task 3 — `'deserialize-context-key-not-found'` REMOVED.** `DeserializeContext` substitution is now failure-tolerant: absent ctx var AND wrong-typed ctx var both return the node UNCHANGED (no throw during the substitute pass). The node is only evaluated if it reaches a live branch; at eval-time the defensive `'deserialize-not-substituted'` throw fires instead. **DR/DC asymmetry preserved:** `DeserializeRegister` with a wrong-typed register entry STILL throws eagerly (`'deserialize-input-not-byte-array'`) — the JVM erases to `ClassCastException` there. Source: JVM `Interpreter.scala:110-125`; sigma-rust `mir/expr.rs:442-496` (ergo-node-integration confirms failure-tolerant DC). Pinned by SANTA `dead-branch-absent#0` / `dead-branch-wrong-type#1` at **blessed cost 20** — the F1 failure-tolerant path itself adds no charge; the cost is the `substituteConstants` pre-pass that `treeHasDeserialize` triggers (CP→Const @ 5 each), mainnet-validated at h=3850. Initially blessed 12 (SANTA's lazy eval seam), re-blessed 12→20 as Decision A (JVM/consensus leads); see the conformance-run spec §F1 OPEN BLOCKER → RESOLVED.

### F3 code (EQ-of-SigmaProp costed walk, 2026-06-07)

- **`'sigma-boolean-compare-unsupported'`** — `Eq`/`NEq` over two `SigmaProp`s where the LEFT
  SigmaBoolean is a conjecture (`Cand`/`Cor`/`Cthreshold`) and the RIGHT is a different
  variant. Mirrors the JVM `DataValueComparer.equalSigmaBoolean` `case _ => sys.error`
  (`:278-281`) — the guarded conjecture cases fall through. ASYMMETRIC by design:
  leaf-left vs conjecture-right returns `false` (no throw). Cost-then-throw (the node's
  MatchType is charged at entry). Reachable from honest scripts: `(pkA && pkB) == pkC`.

### F4-epilogue code (TreeLookup + CreateAvlTree unconditional eval reject, 2026-06-07)

- **`'unsupported-eval-node'`** — the `TreeLookup` (opcode 0xb7) and `CreateAvlTree`
  (opcode 0xb6) Expr arms. The JVM has NO eval override for either node — `costKind =
  Value.notSupportedError` (trees.scala:1334-1337 TreeLookup, :87-91 CreateAvlTree;
  CreateAvlTree carries `// TODO v6.0: implement eval`, issue #907) and the default
  `Value.eval` fires `sys.error("Should be overriden in ...")` (values.scala:102). EVERY
  evaluation throws JVM-side, so both arms reject unconditionally: nothing charged, no
  operand evaluated. Both nodes still PARSE (the JVM parses them; wire arms stay).
  Mainnet history is JVM-validated ⇒ no mainnet block ever evaluated either node ⇒ the
  reject cannot fork against chain history. The previous evaluating arms were sigma-rust
  ports; sigma-rust (eni) convergently over-accepts both (routed via SANTA). JVM-blessed
  pins: `AvlTree.unsupported_eval_nodes.json` (tree_lookup @v2) +
  `AvlTree.unsupported_eval_nodes_v6.json` (tree_lookup + create_avl_tree @v3),
  blessed_by jvm:sigma-state-6.0.3.

No other error codes are emitted by the current evaluator. Internal panics (e.g. a bug in a wire-layer helper called from an arm) bubble up as their typed error class — those represent contract violations and are bugs, not eval-input issues.

## Dispatcher minVersion gating (phase 2h-c.2)

The method-call dispatcher consults an optional `minVersion?: number` field on each registry entry. When set, the dispatcher throws `EvalError('tree-version-too-low')` if `(ctx.treeVersion ?? 0) < entry.minVersion`, BEFORE invoking the handler. This is sigma-rust-parity with `MethodDesc.min_version`-level gating: V<N reject incurs receiver-eval cost + envelope cost (4) but NOT the handler's own cost (e.g., 700 for `checkPow`).

Registry entries using `minVersion: 3` (V3-gated): `SHeader.checkPow` (104:16; phase 2h-c.2), `SAvlTree.insertOrUpdate` (100:16; phase 2h-d), all **40 v6 numeric-method handlers** (typeIds 2–6, methodIds 6–13; phase v6 P1), the **8 v6 UnsignedBigInt method handlers** (typeId 9, methodIds 6–13; phase v6 P2b), the **2 v6 bridge methods** (`BigInt.toUnsigned` 6:14 and `UnsignedBigInt.toSigned` 9:19; phase v6 P2c), the **2 v6 P4 SGlobal methods** (`SGlobal.some` 106:9 and `SGlobal.none` 106:10; phase v6 P4), the **2 v6 P5a SGlobal methods** (`SGlobal.serialize` 106:3 and `SGlobal.deserializeTo` 106:4; phase v6 P5a), the **v6 P5b-1 `SGlobal.fromBigEndianBytes`** (106:5), the **v6 P5b-2 methods** (`SGlobal.encodeNbits` 106:6 and `SGlobal.decodeNbits` 106:7), the **v6 P5c method** (`SGlobal.powHit` 106:8), and the **3 v6 P7a methods** (`SBox.getReg[T]` 99:19, `SContext.getVarFromInput[T]` 101:12, `SGroupElement.expUnsigned` 7:6) — all mirror JVM `isV3OrLaterErgoTreeVersion` gating.

## Method-handler registry (125 entries)

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
| 8 | `SPreHeader.timestamp` | 105:3 | 10 | A | `{kind:'Long', value: BigInt.asIntN(64, obj.value.timestamp)}` — presents the signed i64 view of the u64 struct field (`SPreHeader.timestamp` is typed `SLong` = signed; JVM `as Long`; u64-max surfaces as Long(−1)). The struct field itself is a u64 bigint; `hydratePreHeader` stores it losslessly (no `MAX_SAFE_INTEGER` guard). F2: **bigint** (was number pre-F2). | `eval/spreheader.rs:20-24` |
| 9 | `SAvlTree.digest` | 100:1 | 15 | A | `Coll[Byte]` | `eval/savltree.rs:28-34` |
| 10 | `SAvlTree.enabledOperations` | 100:2 | 15 | A | `Byte` | `eval/savltree.rs:36-40` |
| 11 | `SAvlTree.keyLength` | 100:3 | 15 | A | `Int` | `eval/savltree.rs:42-46` |
| 12 | `SAvlTree.valueLengthOpt` | 100:4 | 15 | A | `Option[Int]` | `eval/savltree.rs:48-57` |
| 13 | `SAvlTree.isInsertAllowed` | 100:5 | 15 | A | `Boolean` | `eval/savltree.rs:59-63` |
| 14 | `SAvlTree.isUpdateAllowed` | 100:6 | 15 | A | `Boolean` | `eval/savltree.rs:65-69` |
| 15 | `SAvlTree.isRemoveAllowed` | 100:7 | 15 | A | `Boolean` | `eval/savltree.rs:71-75` |
| 16 | `SAvlTree.contains` | 100:9 | `createVerifier PerItem(110,20,64) on proof.length` + `LookupAvlTree PerItem(40,10,1) × 1` (raw treeHeight, no floor) | A | `Boolean` — isInsertAllowed(15) NOT checked; construct-fail → `false` (never throws); per-op fail → `false`; digest NOT called | `eval/savltree.rs:339-381` |
| 17 | `SAvlTree.get` | 100:10 | `createVerifier PerItem(110,20,64) on proof.length` + `LookupAvlTree PerItem(40,10,1) × 1` (raw treeHeight) | A | `Option[Coll[Byte]]` — construct-fail throws `'avl-tree-proof-failed'` (charged: cv+lookup); per-op fail throws (same); key-absent → `None`; key-present → `Some` | `eval/savltree.rs:104-150` |
| 18 | `SAvlTree.getMany` | 100:11 | `createVerifier PerItem(110,20,64) on proof.length` + `LookupAvlTree PerItem(40,10,1) × charged-lookups` (raw treeHeight; full success → k, construct-fail → `min(1, k)`, op-fail at key i → opsCompleted+1) | A | `Coll[Option[Coll[Byte]]]` — construct-fail with ≥1 key throws `'avl-tree-proof-failed'`; **zero-keys → empty Coll, no throw even on construct-fail** (JVM keys.map over empty runs zero lookups); first Lookup Failure throws; per-key absence → per-key None | `eval/savltree.rs:152-212` |
| 19 | `SAvlTree.insert` | 100:12 | `isInsertAllowed Fixed(15)` charge-then-check → None if denied; `createVerifier PerItem(110,20,64) on proof.length`; `InsertIntoAvlTree PerItem(40,10,1) × charged-ops` (`max(treeHeight,1)`; full success → ops.length, construct-fail → `min(1, ops.length)`, op-fail → opsCompleted+1); success: `updateDigest Fixed(40)` + `Some(tree)` | A | `Option[AvlTree]` — isInsertAllowed denied → `None` (no cv, no per-op); construct-fail: V<3 throws `'avl-tree-proof-failed'` **(≥1 op only; zero-ops → None at every version)**, V3+ → `None`; per-op fail: V<3 throws, V3+ → `None` | `eval/savltree.rs:214-277` |
| 20 | `SAvlTree.update` | 100:13 | `isUpdateAllowed Fixed(15)` charge-then-check → None if denied; `createVerifier PerItem(110,20,64) on proof.length`; `UpdateAvlTree PerItem(120,20,1) × charged-ops` (`max(treeHeight,1)`; full success → ops.length, construct-fail → 1, op-fail → opsCompleted+1); success: `updateDigest Fixed(40)` + `Some(tree)` | A | `Option[AvlTree]` — isUpdateAllowed denied → `None`; construct-fail → `None` (no throw, no version split); per-op fail → `None` (no version split) | `eval/savltree.rs:383-439` |
| 21 | `SAvlTree.remove` | 100:14 | `isRemoveAllowed Fixed(15)` charge-then-check → None if denied; `createVerifier PerItem(110,20,64) on proof.length`; `RemoveAvlTree PerItem(100,15,1) × ops.length` (`max(treeHeight,1)`) ALWAYS (cfor loop, no break); `digest Fixed(15)` UNCONDITIONAL (even on poisoned verifier); success: `updateDigest Fixed(40)` + `Some(tree)` | A | `Option[AvlTree]` — isRemoveAllowed denied → `None`; construct-fail → `None` (never throws); per-op fail → `None` (never throws); digest(15) always charged | `eval/savltree.rs:279-337` |
| 22 | `SHeader.id` | 104:1 | 10 | A | `Coll[Byte]` (32) | `eval/sheader.rs:22-26` |
| 23 | `SHeader.version` | 104:2 | 10 | A | `Byte` (u8→i8) | `:16-20` |
| 24 | `SHeader.parentId` | 104:3 | 10 | A | `Coll[Byte]` (32) | `:28-32` |
| 25 | `SHeader.adProofsRoot` | 104:4 | 10 | A | `Coll[Byte]` (32) | `:34-38` |
| 26 | `SHeader.stateRoot` | 104:5 | 10 | A | `Coll[Byte]` (33) — type-system says SAvlTree but eval returns Coll[Byte] | `:40-44` |
| 27 | `SHeader.transactionsRoot` | 104:6 | 10 | A | `Coll[Byte]` (32) | `:46-50` |
| 28 | `SHeader.timestamp` | 104:7 | 10 | A | `Long` — signed i64 view via `BigInt.asIntN(64, header.timestamp)` (JVM `as Long`; `SHeader.timestamp` is typed `SLong`; u64-max surfaces as Long(−1)). F2: `Header.timestamp` is now a u64 **bigint** (was number pre-F2, guarded at `MAX_SAFE_INTEGER`); the eval accessor applies the signed view. | `:58-62` |
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
| 41 | `SAvlTree.updateDigest` | 100:15 | 40 | A | `AvlTree` — projects new digest VERBATIM at any length (JVM `CAvlTree.scala:31-34` no-require; F4 epilogue); `'avl-tree-bad-digest-length'` retired | `eval/savltree.rs:90-102` |
| 42 | `SAvlTree.insertOrUpdate` | 100:16 | `isUpdateAllowed Fixed(15)` THEN `isInsertAllowed Fixed(15)` (both ALWAYS, flag order: update first); `createVerifier PerItem(110,20,64) on proof.length`; `UpdateAvlTree PerItem(120,20,1) × charged-ops` (`max(treeHeight,1)`; full success → ops.length, construct-fail → 1, op-fail → opsCompleted+1); success: `updateDigest Fixed(40)` + `Some(tree)` | A | `Option[AvlTree]` — V3-gated (`minVersion: 3`); upsert (insert-absent/update-present); construct-fail → `None` (never throws; JVM swallows in `CAvlTreeVerifier`); per-op fail → `None`; flags-deny: only flag costs charged, no cv, → `None` | `eval/savltree.rs:441-498` |
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
| 53 | `SColl.patch` | 12:19 | `addPerItemCost(30, 2, 10, n)` | B | `Coll[T]` = `input[0,from)` ++ `patch` ++ `input[from+replaced,)` (`from`/`replaced` each independently clamped ≥0); campaign iter-28 | `eval/scoll.rs:195-236` PATCH_EVAL_FN |
| 54 | `SOption.map` | 36:7 | 20 | A | `Option[OV]` — lambda HOF: `Some(t)`→`Some(f t)`, `None`→`None`; campaign iter-29; body in `eval/soption-map.ts` | `eval/soption.rs:13-60` map_eval |
| 55 | `Byte.toBytes` | 2:6 | 5 | A | `Coll[Byte]` (1 byte) — **V3-gated** | JVM `SNumericTypeMethods.toBytes` |
| 56 | `Byte.toBits` | 2:7 | 5 | A | `Coll[Boolean]` (8 bits, MSB-first) — V3-gated | JVM `SNumericTypeMethods.toBits` |
| 57 | `Byte.bitwiseInverse` | 2:8 | 5 | A | `Byte` — V3-gated | JVM `SNumericTypeMethods.bitwiseInverse` |
| 58 | `Byte.bitwiseOr` | 2:9 | 5 | A | `Byte` — V3-gated | JVM `SNumericTypeMethods.bitwiseOr` |
| 59 | `Byte.bitwiseAnd` | 2:10 | 5 | A | `Byte` — V3-gated | JVM `SNumericTypeMethods.bitwiseAnd` |
| 60 | `Byte.bitwiseXor` | 2:11 | 5 | A | `Byte` — V3-gated | JVM `SNumericTypeMethods.bitwiseXor` |
| 61 | `Byte.shiftLeft` | 2:12 | 5 | A | `Byte` — V3-gated; bits∈[0,8) else `'numeric-shift-out-of-range'` | JVM `SNumericTypeMethods.shiftLeft` |
| 62 | `Byte.shiftRight` | 2:13 | 5 | A | `Byte` — V3-gated; bits∈[0,8) else `'numeric-shift-out-of-range'` | JVM `SNumericTypeMethods.shiftRight` |
| 63 | `Short.toBytes` | 3:6 | 5 | A | `Coll[Byte]` (2 bytes BE) — V3-gated | JVM `SNumericTypeMethods.toBytes` |
| 64 | `Short.toBits` | 3:7 | 5 | A | `Coll[Boolean]` (16 bits, MSB-first) — V3-gated | JVM `SNumericTypeMethods.toBits` |
| 65 | `Short.bitwiseInverse` | 3:8 | 5 | A | `Short` — V3-gated | JVM `SNumericTypeMethods.bitwiseInverse` |
| 66 | `Short.bitwiseOr` | 3:9 | 5 | A | `Short` — V3-gated | JVM `SNumericTypeMethods.bitwiseOr` |
| 67 | `Short.bitwiseAnd` | 3:10 | 5 | A | `Short` — V3-gated | JVM `SNumericTypeMethods.bitwiseAnd` |
| 68 | `Short.bitwiseXor` | 3:11 | 5 | A | `Short` — V3-gated | JVM `SNumericTypeMethods.bitwiseXor` |
| 69 | `Short.shiftLeft` | 3:12 | 5 | A | `Short` — V3-gated; bits∈[0,16) | JVM `SNumericTypeMethods.shiftLeft` |
| 70 | `Short.shiftRight` | 3:13 | 5 | A | `Short` — V3-gated; bits∈[0,16) | JVM `SNumericTypeMethods.shiftRight` |
| 71 | `Int.toBytes` | 4:6 | 5 | A | `Coll[Byte]` (4 bytes BE) — V3-gated | JVM `SNumericTypeMethods.toBytes` |
| 72 | `Int.toBits` | 4:7 | 5 | A | `Coll[Boolean]` (32 bits, MSB-first) — V3-gated | JVM `SNumericTypeMethods.toBits` |
| 73 | `Int.bitwiseInverse` | 4:8 | 5 | A | `Int` — V3-gated | JVM `SNumericTypeMethods.bitwiseInverse` |
| 74 | `Int.bitwiseOr` | 4:9 | 5 | A | `Int` — V3-gated | JVM `SNumericTypeMethods.bitwiseOr` |
| 75 | `Int.bitwiseAnd` | 4:10 | 5 | A | `Int` — V3-gated | JVM `SNumericTypeMethods.bitwiseAnd` |
| 76 | `Int.bitwiseXor` | 4:11 | 5 | A | `Int` — V3-gated | JVM `SNumericTypeMethods.bitwiseXor` |
| 77 | `Int.shiftLeft` | 4:12 | 5 | A | `Int` — V3-gated; bits∈[0,32) | JVM `SNumericTypeMethods.shiftLeft` |
| 78 | `Int.shiftRight` | 4:13 | 5 | A | `Int` — V3-gated; bits∈[0,32) | JVM `SNumericTypeMethods.shiftRight` |
| 79 | `Long.toBytes` | 5:6 | 5 | A | `Coll[Byte]` (8 bytes BE) — V3-gated | JVM `SNumericTypeMethods.toBytes` |
| 80 | `Long.toBits` | 5:7 | 5 | A | `Coll[Boolean]` (64 bits, MSB-first) — V3-gated | JVM `SNumericTypeMethods.toBits` |
| 81 | `Long.bitwiseInverse` | 5:8 | 5 | A | `Long` — V3-gated | JVM `SNumericTypeMethods.bitwiseInverse` |
| 82 | `Long.bitwiseOr` | 5:9 | 5 | A | `Long` — V3-gated | JVM `SNumericTypeMethods.bitwiseOr` |
| 83 | `Long.bitwiseAnd` | 5:10 | 5 | A | `Long` — V3-gated | JVM `SNumericTypeMethods.bitwiseAnd` |
| 84 | `Long.bitwiseXor` | 5:11 | 5 | A | `Long` — V3-gated | JVM `SNumericTypeMethods.bitwiseXor` |
| 85 | `Long.shiftLeft` | 5:12 | 5 | A | `Long` — V3-gated; bits∈[0,64) | JVM `SNumericTypeMethods.shiftLeft` |
| 86 | `Long.shiftRight` | 5:13 | 5 | A | `Long` — V3-gated; bits∈[0,64) | JVM `SNumericTypeMethods.shiftRight` |
| 87 | `BigInt.toBytes` | 6:6 | 5 | A | `Coll[Byte]` (minimal-width signed BE via `encodeBigIntBE` ≡ Java `BigInteger.toByteArray()`) — V3-gated | JVM `SNumericTypeMethods.toBytes` |
| 88 | `BigInt.toBits` | 6:7 | 5 | A | `Coll[Boolean]` (256 bits, MSB-first) — V3-gated | JVM `SNumericTypeMethods.toBits` |
| 89 | `BigInt.bitwiseInverse` | 6:8 | 5 | A | `BigInt` — V3-gated; no overflow check (`~x = -x-1` preserves i256 bounds for in-range input) | JVM `SNumericTypeMethods.bitwiseInverse` |
| 90 | `BigInt.bitwiseOr` | 6:9 | 5 | A | `BigInt` — V3-gated; no overflow check | JVM `SNumericTypeMethods.bitwiseOr` |
| 91 | `BigInt.bitwiseAnd` | 6:10 | 5 | A | `BigInt` — V3-gated; no overflow check | JVM `SNumericTypeMethods.bitwiseAnd` |
| 92 | `BigInt.bitwiseXor` | 6:11 | 5 | A | `BigInt` — V3-gated; no overflow check | JVM `SNumericTypeMethods.bitwiseXor` |
| 93 | `BigInt.shiftLeft` | 6:12 | 5 | A | `BigInt` — V3-gated; bits∈[0,256); result range-checked to i256 → `'bigint-result-out-of-range'` on overflow | JVM `SNumericTypeMethods.shiftLeft` |
| 94 | `BigInt.shiftRight` | 6:13 | 5 | A | `BigInt` — V3-gated; bits∈[0,256); result always in-range for in-range input | JVM `SNumericTypeMethods.shiftRight` |
| 95 | `UnsignedBigInt.toBytes` | 9:6 | 5 | A | `Coll[Byte]` (minimal unsigned BE, no sign pad; `0 → []`, `2²⁵⁶−1 → 32×0xFF`) — **V3-gated** | JVM `SNumericTypeMethods.toBytes` via `CUnsignedBigInt.toBytes = asUnsignedByteArray` |
| 96 | `UnsignedBigInt.toBits` | 9:7 | 5 | A | `Coll[Boolean]` (minimal-byte width, MSB-first; same `toBE` path as `toBytes`) — V3-gated | JVM `ExactNumeric.scala:44–58` `toBits = toBigEndianBytes(x)` expanded to bits |
| 97 | `UnsignedBigInt.bitwiseInverse` | 9:8 | 5 | A | `UnsignedBigInt` (256-bit flip: `UBI_MAX − x` where `UBI_MAX = 2²⁵⁶−1`; NOT `~x` which would go negative) — V3-gated | JVM `CUnsignedBigInt` `bitwiseInverse = ~` over `asUnsignedByteArray(32,·)` |
| 98 | `UnsignedBigInt.bitwiseOr` | 9:9 | 5 | A | `UnsignedBigInt` — V3-gated; no overflow (non-negative result trivially in `[0, 2²⁵⁶−1]`) | JVM `SNumericTypeMethods.bitwiseOr` |
| 99 | `UnsignedBigInt.bitwiseAnd` | 9:10 | 5 | A | `UnsignedBigInt` — V3-gated; no overflow | JVM `SNumericTypeMethods.bitwiseAnd` |
| 100 | `UnsignedBigInt.bitwiseXor` | 9:11 | 5 | A | `UnsignedBigInt` — V3-gated; no overflow | JVM `SNumericTypeMethods.bitwiseXor` |
| 101 | `UnsignedBigInt.shiftLeft` | 9:12 | 5 | A | `UnsignedBigInt` — V3-gated; bits range guard first (`bits < 0` or `bits >= 256` → `'numeric-shift-out-of-range'`); then magnitude guard: result `≥ 2²⁵⁶` → `'unsigned-bigint-out-of-range'` | JVM `UnsignedBigIntegerOps.scala:131–149` range guard + `CUnsignedBigInt` constructor rejects `bitLength > 256` |
| 102 | `UnsignedBigInt.shiftRight` | 9:13 | 5 | A | `UnsignedBigInt` — V3-gated; bits range guard: bits∈[0,256) else `'numeric-shift-out-of-range'`; result always in `[0, 2²⁵⁶−1]` for in-range input | JVM `SNumericTypeMethods.shiftRight` |
| 103 | `BigInt.toUnsigned` | 6:14 | 5 | A | `UnsignedBigInt` — **V3-gated** (`minVersion: 3`); negative receiver → `'unsigned-bigint-out-of-range'`; wrong-kind receiver → `'numeric-method-bad-operand'`; else `{ kind:'UnsignedBigInt', value }` | JVM `methods.scala:543-549, 559-565` |
| 104 | `UnsignedBigInt.toSigned` | 9:19 | 10 | A | `SBigInt` — **V3-gated** (`minVersion: 3`); receiver `≥ 2²⁵⁵` (leftmost bit set) → `'bigint-result-out-of-range'`; wrong-kind receiver → `'numeric-method-bad-operand'`; else `{ kind:'BigInt', value }` | JVM `methods.scala:607-611`, `Extensions.scala:219-223` |
| 111 | `SColl.reverse` | 12:30 | `addPerItemCost(20,2,100,n)` | B | `Coll[IV]` (generic, via P0 substitution engine); reverses items, preserves elem type; empty → empty — **V3-gated** (`minVersion: 3`) | JVM `sigma/ast/methods.scala:1211-1216, 1221-1227`; `transformers.scala:74-75` |
| 112 | `SColl.startsWith` | 12:31 | `addPerItemCost(10,1,10,n)` on receiver length | B | `Boolean` (closed) — element comparison via cost-free `sValueStructuralEq` (NOT the costed `sValueEquals`); `n` = receiver length — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1102-1103` (Zip_CostKind) |
| 113 | `SColl.endsWith` | 12:32 | `addPerItemCost(10,1,10,n)` on receiver length | B | `Boolean` (closed) — same cost model and element-comparison as `startsWith`; checks suffix alignment — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1102-1103` (Zip_CostKind) |
| 114 | `SColl.get` | 12:33 | `FixedCost(30)` | A | `Option[IV]` (generic, via P0 substitution engine); `0 ≤ i < len ? Some(item) : None` — negative/OOB return `None`, never throw — **V3-gated** (`minVersion: 3`) | JVM `ByIndex.costKind`; `transformers.scala:285` |
| 115 | `SGlobal.some` | 106:9 | `FixedCost(JitCost(5))` | A | `Option[T]` (generic, via P0 substitution engine); wraps `args[0]` in `Some`; `elem` from `explicitTypeArgs['T']`; guards `obj.kind === 'Global'` AND `args.length === 1` (arity parity); MethodCall opcode — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1986-1992` |
| 116 | `SGlobal.none` | 106:10 | `FixedCost(JitCost(5))` | A | `Option[T]` (generic, via P0 substitution engine); returns `None` (`value: null`); `elem` from `explicitTypeArgs['T']`; guards `obj.kind === 'Global'` AND `args.length === 0`; PropertyCall opcode — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1994-1999` |
| 117 | `SGlobal.serialize` | 106:3 | DynamicCost via analytical walk (see design spec §cost-model) | A | `Coll[Byte]` (closed return type; T derived from runtime value kind, NOT `exprTpe`); guards `obj.kind === 'Global'` AND `args.length === 1`; MethodCall opcode; NO wire type arg (T inferred from value) — **V3-gated** (`minVersion: 3`). **Residual (adversarial-only):** `serialize`/`deserializeTo[Header]` of a hand-crafted V1 header with `powDistance=0` produces `@ergots/scorex`-shaped bytes (`d_len=1, d_bytes=[0x00]`) that diverge from the JVM (`d_len=0, d_bytes=[]`) — a pre-existing sigma-rust-vs-JVM fork in scorex's Autolykos-V1 d-encoding; real V1 headers have d≠0 and V1 is unreachable via `Context.headers` on a V3+ chain. The serialize COST is JVM-faithful regardless. Tracked in the P5a design spec §Open items pending a scorex validation-model decision. | JVM `methods.scala:1957` |
| 118 | `SGlobal.deserializeTo[T]` | 106:4 | `PerItemCost(100, 32, 32)` on input byte length | A | generic `T` (resolved from `explicitTypeArgs['T']` at call site via P0 engine); parses `args[0]` bytes as an SValue of type `T` via the data codec (`DataSerializer.deserialize` — NO ErgoTree body parse, NO `exprTpe` match); trailing bytes ignored; `MaxTreeDepth(110)` enforced data-driven via the SHARED reader-level counter (`@ergots/scorex` `ByteReader.enterDepth`/`exitDepth`, default cap 110) — actual parse-recursion depth, NOT type nesting (a deep type with empty data is accepted); a FRESH reader defaults to 110 like the JVM's fresh reader, and over-depth raises `ReaderError('max-tree-depth-exceeded')` caught → `'global-deserialize-failed'`; guards `obj.kind === 'Global'` AND `args.length === 1`; MethodCall opcode — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1906` |
| 119 | `SGlobal.fromBigEndianBytes[T]` | 106:5 | `FixedCost(10)` | A | generic `T` (resolved from `explicitTypeArgs['T']` at the call site via the P0 engine); decodes `args[0]` big-endian bytes into a value of type `T` — per-type exact-length (Byte=1/Short=2/Int=4/Long=8) or max-length (BigInt/UBI ≤32; BigInt also rejects empty) validation; signed two's-complement for Byte..BigInt, unsigned magnitude for UBI; non-numeric `T` rejected at eval (default branch); `FixedCost(10)` charged BEFORE validation/decode (even on failure); guards `obj.kind === 'Global'` AND `args.length === 1`; MethodCall opcode; carries explicit `T` wire type arg (already in `wire/mir/explicit-type-args.ts:106:5`) — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1925` |
| 120 | `SGlobal.encodeNbits` | 106:6 | `FixedCost(25)` | A | `(SGlobal, SBigInt) → SLong` (closed return type); encodes a signed `SBigInt` as a Bitcoin-compact ("nBits") `SLong` via `encodeCompactBits` (port of JVM `NBitsUtils.encodeCompactBits`, ergoscript-local `eval/_nbits.ts`); no reject path for valid ≤256-bit input (`size ≤ 33` precludes `size << 24` overflow); `FixedCost(25)` charged BEFORE math (even on defensive guard throws); guards `obj.kind === 'Global'` AND `args.length === 1`; MethodCall opcode; NO wire type arg (non-generic) — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1939`, `CSigmaDslBuilder.scala:190-194` |
| 121 | `SGlobal.decodeNbits` | 106:7 | `FixedCost(50)` | A | `(SGlobal, SLong) → SBigInt` (closed return type); decodes a Bitcoin-compact `SLong` to a signed `SBigInt` via `@ergots/scorex` `decodeCompactBits` (low-32-bit truncation: `Number(BigInt.asUintN(32, l))` — bits 32–63 are ignored, matching JVM `NBitsUtils.decodeCompactBits` and sigma-rust `nbits as u32`); signed-256 range-check post-decode: throws `'global-decode-nbits-failed'` when `bitLength > 255` (JVM `.toSignedBigIntValueExact`; sigma-rust `.try_into::<BigInt256>()`); `FixedCost(50)` charged BEFORE decode/range-check (even on failure); guards `obj.kind === 'Global'` AND `args.length === 1`; MethodCall opcode; NO wire type arg (non-generic) — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1944`, `CSigmaDslBuilder.scala:195-197` |
| 122 | `SGlobal.powHit` | 106:8 | `PowHitCostKind`: `500 + (k+1) * (floor((msg.len+nonce.len+h.len)/128) + 1) * 7` (charged from raw `k` BEFORE guards) | A | `(SGlobal, Int, Coll[Byte], Coll[Byte], Coll[Byte], Int) → SUnsignedBigInt` (closed return type); computes Autolykos-2 PoW hit via `@ergots/scorex` `autolykosHitForMessageWithChecks(k, msg, nonce, h, N)`; guards: `obj.kind === 'Global'` AND `args.length === 5`, then k<2/k>32/N<16 → `'pow-hit-invalid-params'`; cost charged BEFORE guards; MethodCall opcode; NO wire type arg (non-generic) — **V3-gated** (`minVersion: 3`) | JVM `methods.scala:1884-1900`, `CostKind.scala:71-88`, `Autolykos2PowValidation.scala:115-137` |
| 123 | `SBox.getReg[T]` | 99:19 | `FixedCost(JitCost(50))` (= `ExtractRegisterAs.costKind`) | A | `Option[T]` with explicit type arg `T`; runtime index `i` (`args[0]`): `i < 0` or `i > 9` → `None`; absent register → `None`; defined + `sTypeEquals(stored.tpe, T)` → `Some(value)`; defined + mismatch → throws `'register-type-mismatch'`; reuses `getRegisterEntry` (R0–R3 synthesis included); cost charged BEFORE checks (Pattern A) — **V3-gated** (`minVersion: 3`); explicit type arg `T` on wire (JVM `getRegMethodV6`, `methods.scala:1338-1347`). NOTE: id 7 (`getRegV5`) stays unregistered — deserializes at every version but eval-throws `'method-not-implemented'` (JVM reflection miss; see §2.3 of the P7a spec and the `facts/ergoscript-wire.md` explicit-type-args correction). | JVM `CBox.scala:32-44`, `methods.scala:1338-1347` |
| 124 | `SContext.getVarFromInput[T]` | 101:12 | `FixedCost(JitCost(10))` (= `GetVar.costKind`) | A | `Option[T]` with explicit type arg `T`; **total, never throws** — `inputIdx` (Short) OOB or absent from `ctx.inputExtensions`, or varId missing at that input, or type mismatch → ALL return `None`; reads `ctx.inputExtensions[inputIdx].values[varId]`; `ctx.inputExtensions` absent ⇒ every lookup → `None`; cost charged BEFORE checks (Pattern A) — **V3-gated** (`minVersion: 3`). The three-way mismatch asymmetry (self-`getVar` throws `'get-var-type-mismatch'` / `getReg` throws `'register-type-mismatch'` / `getVarFromInput` returns `None`) is deliberate JVM behavior pinned by tests (see §3.3 of the P7a spec). Var-id matching is byte-identity with the JVM's signed-Byte Map keys: the handler normalizes its signed Byte operand into the unsigned 0-255 key domain (& 0xff). | JVM `CContext.scala:76-83`, `methods.scala:1755-1765` |
| 125 | `SGroupElement.expUnsigned` | 7:6 | `FixedCost(JitCost(900))` (= `Exponentiate.costKind`) | A | `GroupElement`; same point-exponentiation path as the v5 `Exponentiate` arm; calls shared `expPoint(baseBytes, k)` (`crypto/secp256k1.ts`) covering: `decodePoint` → identity-base guard (`base.is0()` → 33 zero bytes; noble multiply-on-ZERO is **uncontracted** — guard is defense-in-depth mirroring sigma-rust `ec_point.rs:113-118`) → `pointMul` (UBI scalar ∈ [0, 2²⁵⁶) reduced mod n; `g^0 = g^order = identity`) → `encodePoint`; monomorphic, no explicit type args, zero wire change — **V3-gated** (`minVersion: 3`) | JVM `CGroupElement.scala:22-26`, `methods.scala:656-660`, `trees.scala:1042-1046` |

(Rows 50-52 are the v5 `negate`/`updated`/`updateMany` handlers. `updateMany` perChunkCost is **2** per the canonical JVM `methods.scala:1055` — the stale vendored `integration/ergots` checkout reads 1; cost was sourced from the JVM + the n=14 conformance vector, not that checkout.)

(Rows 53-54 — `SColl.patch` (iter-28) and `SOption.map` (iter-29) — were added during the walker campaign and tabled 2026-06-02.)

(Rows 55–94 — the v6 P1 numeric methods — are 40 entries across 5 numeric types × 8 method ids (6–13). All gate on `treeVersion >= 3` via `minVersion: 3` on the HANDLERS registry; the dispatcher rejects V<3 trees BEFORE invoking the handler (zero handler-cost on V<3 reject). All cost `FixedCost(JitCost(5))` Pattern A. The `bitwiseInverse`/`bitwiseOr`/`bitwiseAnd`/`bitwiseXor`/`shiftLeft`/`shiftRight` methods (ids 8–13) have `tRange = tNum` (type-variable return type resolved by the P0 substitution engine at call sites — see `mir/method-signatures.ts:numericV6Signatures`). The `toBytes`/`toBits` methods (ids 6–7) have closed `tRange` (`Coll[SByte]` / `Coll[SBoolean]`). Implementation: `eval/_numeric-v6.ts` + registration loop in `eval/method-call.ts`.)

(Rows 95–102 — the v6 P2b `SUnsignedBigInt` numeric methods — are 8 entries at typeId 9, methodIds 6–13. All gate on `treeVersion >= 3` via `minVersion: 3`, exactly like the P1 signed-numeric group (rows 55–94). All cost `FixedCost(JitCost(5))` Pattern A. Three semantic differences from their `BigInt` (typeId 6) counterparts: (1) `toBytes`/`toBits` (ids 6–7) use the unsigned-magnitude codec (`encodeUnsignedBigIntBE` — no sign pad, `0 → []`, `2²⁵⁶−1 → 32×0xFF`), mirroring `CUnsignedBigInt.toBytes = asUnsignedByteArray`; (2) `bitwiseInverse` (id 8) performs a 256-bit fixed-width flip (`UBI_MAX − x` where `UBI_MAX = 2²⁵⁶−1`) rather than `~x` (which would go negative and is semantically signed); (3) `shiftLeft` (id 12) has a magnitude guard AFTER the bits-range guard — a result `≥ 2²⁵⁶` throws `'unsigned-bigint-out-of-range'` (signed `BigInt.shiftLeft` throws `'bigint-result-out-of-range'` instead). `shiftRight`, `bitwiseOr`, `bitwiseAnd`, `bitwiseXor` (ids 13, 9–11) have identical signed/unsigned behavior (non-negative result trivially in-range). The `bitwiseInverse`/`bitwiseOr`/`bitwiseAnd`/`bitwiseXor`/`shiftLeft`/`shiftRight` methods (ids 8–13) have `tRange = tNum` substituted to `SUnsignedBigInt` by the P0 engine (typeId 9 must be registered in `mir/method-signatures.ts:NUMERIC_STYPE`); `toBytes`/`toBits` have closed `tRange`. Implementation: `eval/_numeric-v6.ts` `ubiDesc` (6th `NumV6` descriptor) + same registration loop as P1.)

(Rows 103–104 — the v6 P2c bridge methods — are 2 entries closing the `toUnsigned`/`toSigned` conversions between `SBigInt` and `SUnsignedBigInt`. Both gate on `treeVersion >= 3` via `minVersion: 3`. `BigInt.toUnsigned` (6:14) costs `FixedCost(JitCost(5))` Pattern A and converts a signed BigInt to unsigned (negative receiver → `'unsigned-bigint-out-of-range'`). `UnsignedBigInt.toSigned` (9:19) costs `FixedCost(JitCost(10))` Pattern A and converts an unsigned BigInt to signed (receiver `≥ 2²⁵⁵` → `'bigint-result-out-of-range'`; leftmost-bit set = signed overflow). Both gain `mir/method-signatures.ts` entries so `exprTpe` resolves the bridge return types (both closed). Both share the `requireKind` receiver guard (`'numeric-method-bad-operand'` on wrong-kind receiver). Note: the cost of these two bridges (`5` and `10`) falls into the **non-BigInt tier** for the same reason as the arith BinOps — the JVM's `TypeBasedCost` match has `case SBigInt => X; case _ => Y` and `SUnsignedBigInt ≠ SBigInt`. Source: `methods.scala:543-565, 607-611`.)

(`SColl.zip`'s `n` = obj length, NOT `min(obj, arg)` — Pattern B charges based on obj's length per sigma-rust.)

(The 13 `SAvlTree.*` handlers come from phase 2h-b. Tier-1 accessors 9-15 charge cost 15 BEFORE projecting over runtime `AvlTreeData` fields, no `@ergots/avltree` call. Tier-2 verification ops (rows 16-21 + row 42) implement the JVM cost model from `CErgoTreeEvaluator.scala:67-254` + `CostKind.scala:24-32`; sources: `methods.scala:1391-1516`. Shared cost components: **createVerifier** `PerItem(110,20,64)` on `proof.length`; **LookupAvlTree** `PerItem(40,10,1)` on raw `treeHeight` (`digest[32]` — scorex `rootNodeHeight = startingDigest.last & 0xff`); **InsertIntoAvlTree** `PerItem(40,10,1)` on `max(treeHeight,1)`; **UpdateAvlTree** `PerItem(120,20,1)` on `max(treeHeight,1)` (used by update AND insertOrUpdate); **RemoveAvlTree** `PerItem(100,15,1)` on `max(treeHeight,1)`; flag-check **Fixed(15)** per flag; **digest** `Fixed(15)` unconditional in remove; **updateDigest** `Fixed(40)` on success only. All Tier-2 charges are Pattern A (charge BEFORE guarded work; `addSeqCost` wraps in JVM; eni places charge first). Charged-op arithmetic: full success → ops.length; construct-fail → `min(1, ops.length)` via forall break at first op **(zero-ops → 0 charges, ≥1-op → 1 charge)**; per-op fail → opsCompleted+1; remove uses ops.length ALWAYS (cfor, no break). **Construct-fail routing (JVM-canonical):** `BatchAVLVerifier` construction wraps in `Try{…}.toOption`; `CAvlTreeVerifier` overrides `logError` to no-op; a bad proof yields verifier with `topNode = None`, NOT a throw. Observable routing: contains → false; get/getMany → throw `'avl-tree-proof-failed'` (charged: cv + 1 lookup first); insert: V<3 → throw **(≥1 op required; zero-ops → None at every version)**, V3+ → None; update → None; remove → None; insertOrUpdate → None. **Op-shape routing (F4 T7.5):** a wrong-length key, ±infinity key (all-0x00/all-0xFF × keyLength), or wrong-length value (fixed-value trees, insert-family) fails AT ITS OP INDEX per scorex's per-op requires (scrypto 3.0.0 bytecode; `ergo_avltree_rust authenticated_tree_ops.rs:226-229,291,314`) — ops before it replay against the proof; routing/charges then follow the per-op-fail rules above. Handlers pre-scan (`firstShapeBadOpIndex`) and slice the replay prefix (`verifyWithShapeRouting`) so `@ergots/avltree`'s upfront `AvlVerifyError` validation is never tripped. Construct-shape violations (keyLength ≤ 0, fixed valueLength < 0, digest ≠ 33 B) are construct-fail with **treeHeight 0** (scorex assigns `rootNodeHeight` after those requires) — lookup charges use `nItems=0` (base only), modify charges `max(0,1)=1`.)

(The 17 handlers from phase 2h-c.1 — entries 22-38 — are 15 `SHeader.*` accessors (typeId 104, methodIds 1-15) at Fixed(10) Pattern A each, plus `SContext.headers` (101:2) and `SContext.lastBlockUtxoRootHash` (101:9) at Fixed(15) Pattern A. The SContext handlers join the existing `SContext.dataInputs` (101:1) and `SContext.preHeader` (101:3) in the registry. Entry 39 from phase 2h-c.2 is `SHeader.checkPow` (104:16) at Fixed(700) Pattern A with `minVersion: 3` dispatcher gating.)

(The 3 `SAvlTree.*` handlers from phase 2h-d — entries 40-42 — close the final three `SAvlTree.*` methods. `updateOperations` (100:8) and `updateDigest` (100:15) are pure Tier-1-shaped projections (cost 45 / 40, Pattern A, no `@ergots/avltree` call); `insertOrUpdate` (100:16) is a Tier-2 upsert gated at the dispatcher via `minVersion: 3` — charges isUpdateAllowed(15) THEN isInsertAllowed(15) (both always, in that order), then createVerifier PerItem(110,20,64), then UpdateAvlTree PerItem(120,20,1) × charged-ops on max(treeHeight,1), then updateDigest Fixed(40) on success. Construct-fail → None (never throws). See row 42 and the Tier-2 footnote above for the full cost model.)

(The 2 handlers from phase 2h-f — entries 43-44 — close the two Tier-3 long-tail deferrals from the 2g.6 demand survey. `SGroupElement.getEncoded` (7:2) is a Pattern A Fixed(250) returning the 33-byte SEC1-compressed point as `Coll[Byte]`. `SColl.flatMap` (12:15) is a Pattern B `addPerItemCost(60, 10, 8, n)` lambda HOF with concat semantics + body-restriction (MethodCall body with non-empty args → `'lambda-not-callable'`, mirroring sigma-rust `scoll.rs:78-84`). The handler lives in the new module `eval/scoll-flat-map.ts`; the dispatcher passes `{ mc, env }` via the new optional `extra` arg added to `HandlerFn` in 2h-f T8. The 2g.6 survey labeled this method "flatten" — that was wrong; flatten doesn't exist on the sigma-rust surface. Two divergences from sigma-rust on flatMap's lambda static typing: **(R3a)** the elem-type check `sTypeEquals(input.elem, lambdaArgTpe)` runs only when `mc.args[0]` is an inline `FuncValue` MIR node — skipped for ValUse-source lambdas because the runtime `Closure` SValue has no `argTpes`. Mirrors the existing `coll-map.ts:94-108` convention. **(R3b)** the output elem type from `exprTpe(closure.body)` returns `SAny` for `PropertyCall` and `MethodCall` body shapes (SMethod resolver not yet online in phase 2a; the canonical flatMap body `x.indices` IS a PropertyCall, so SAny is the common case). The handler tolerates SAny pre-loop and refines from `itemRes.elem` after the first iter. **Consequence: empty-input flatMap with a PropertyCall body returns `Coll[SAny]` (sigma-rust returns `Coll[T]` concrete via SMethod resolver — but only the elem-type information is lost; the items field is correct).** Future work: extend `Closure` to carry `argTpes` and/or bring the SMethod resolver online — both also affect MapColl/Filter/Fold/Exists/ForAll's static-typing accuracy.)

## Coverage and stability

**67 of 67 implementable `Expr` variants** have arms (post-2i-c). 18 variants in sigma-rust's `OpCode` enum are reserved-but-never-dispatched and parse-reject via `ExprParseError 'opcode-reserved'` (was 19 — `FunDef` (`0xd7`) is parsed + evaluated as a `ValDef` from v6 P6); 4 more (LastBlockUtxoRootHash, FlatMap, TrivialPropFalse, TrivialPropTrue) parse-reject via `'not-implemented-yet'` pending separate review of their top-level direct-dispatch status (routed elsewhere in sigma-rust). The 67 implementable variants:
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
- 5 from phase 2i-b: `SigmaPropIsProven`, `MultiplyGroup`, `Exponentiate`, `CreateAvlTree`, `TreeLookup` — `CreateAvlTree` + `TreeLookup` flipped to unconditional rejects (`'unsupported-eval-node'`) in the F4 epilogue (the JVM has no eval override for either; they still parse). `SigmaPropIsProven` was already an unconditional structural throw.
- 2 from phase 2i-c: `DeserializeContext`, `DeserializeRegister`

Everything else throws `'not-implemented-yet'`. Real-world ErgoTree trees from the `mainnet_boxes` corpus are filtered against this coverage by `test/corpus-eval.test.ts` — only fixtures whose body uses exclusively the supported variants are exercised against the sigma-rust eval oracle for byte-equality. As of phase 2g.6 complete, the mainnet corpus aggregate is `success=18 not-impl=0 other=0` (synthetic-context stubs: `outputs: []`, `inputs: []`, `selfBox: synthetic`, `dataInputs: []`). Phase 2h-b adds 13 method handlers but no new `Expr` arms — coverage remains 52 / ~70; post-2h-b uplift to C2 corpus TBD on next corpus run. Phase 2h-c.1 adds 17 more method handlers but no new `Expr` arms — coverage remains 52 / ~70; post-2h-c.1 uplift to C2 corpus TBD on next corpus run. Phase 2h-c.2 adds 1 more method handler but no new `Expr` arms — coverage remains 52 / ~70. Phase 2h-d adds 3 more method handlers (closing the final three `SAvlTree.*` methods) but no new `Expr` arms — coverage remains 52 / ~70. Phase 2h-f adds 2 more method handlers (`SGroupElement.getEncoded` + `SColl.flatMap`) but no new `Expr` arms — coverage remains 52 / ~70. Phase 2i-a adds 8 new `Expr` arms (pure-bytes predefs) — coverage advances to 60 / ~70; post-2i-a uplift to C2 corpus TBD on next corpus run.

**Full suite (F2 close-out gate, 2026-06-06): avltree 156 / ergoscript 3987 / nipopow 247 / scorex 187 — all green; tsc clean (all 4 packages).** (F2 added 6 SANTA conformance vectors and corrected `putUByte` cost + timestamp bigint; registry and EvalError code count unchanged vs P7a.)

**Method-handler registry: 125 entries** (was 8 before 2h-b; +13 from 2h-b — 7 Tier-1 accessors at typeId:methodId 100:1..100:7 + 6 Tier-2 verification ops at 100:9..100:14; +17 from 2h-c.1 — 15 `SHeader.*` accessors at 104:1..104:15 + 2 `SContext.*` additions at 101:2 and 101:9; +1 from 2h-c.2 — `SHeader.checkPow` at 104:16; +3 from 2h-d — `SAvlTree.updateOperations` at 100:8, `SAvlTree.updateDigest` at 100:15, and `SAvlTree.insertOrUpdate` at 100:16 with dispatcher `minVersion: 3` gating; +2 from 2h-f — `SGroupElement.getEncoded` at 7:2 and `SColl.flatMap` at 12:15; +1 from 2j-b arm-coverage parallel session — `SContext.minerPubKey` at 101:10, Pattern A cost 20 returning the 33-byte SEC1-compressed `ctx.preHeader.minerPk` as `Coll[Byte]`; mirrors sigma-rust `MINER_PUBKEY_EVAL_FN`. Surfaced as a halt at mainnet h=208788; +1 from 2j-b iter-4 arm-coverage parallel session — `SPreHeader.minerPk` at 105:6, Pattern A cost 10 returning the raw 33-byte miner pubkey as `SGroupElement` (NOT sigma-serialized — receiver-side counterpart to row 45 which returns `Coll[Byte]`); mirrors sigma-rust `MINER_PK_EVAL_FN`. Surfaced as a halt at mainnet h=228633; +1 from 2j-b iter-5 arm-coverage parallel session — `SContext.selfBoxIndex` at 101:8, Pattern A cost 20 returning 0-based `ctx.inputs.indexOf(ctx.selfBox)` gated by `activated_script_version >= 2`; mirrors sigma-rust `SELF_BOX_INDEX_EVAL_FN`. Surfaced as a halt at mainnet h=342,964; +1 from 2j-b iter-10 arm-coverage parallel session — `SPreHeader.parentId` at 105:2, Pattern A cost 10 returning the 32-byte `ctx.preHeader.parentId` as `Coll[Byte]` (contrast row 46 `SPreHeader.minerPk` which returns `SGroupElement` of raw pubkey); mirrors sigma-rust `PARENT_ID_EVAL_FN`. Surfaced as a halt at mainnet h=679,337; +1 from 2j-b iter-11 arm-coverage parallel session — `SPreHeader.height` at 105:5, Pattern A cost 10 returning `obj.value.height` as `Int` (sigma-rust `as i32`); mirrors sigma-rust `HEIGHT_EVAL_FN`. Surfaced as a halt at mainnet h=679,837; +40 from v6 P1 — `Byte/Short/Int/Long/BigInt.toBytes/toBits/bitwiseInverse/bitwiseOr/bitwiseAnd/bitwiseXor/shiftLeft/shiftRight` (typeIds 2–6, methodIds 6–13), all `minVersion: 3` via the dispatcher gate, `FixedCost(JitCost(5))`; +8 from v6 P2b — `UnsignedBigInt.toBytes/toBits/bitwiseInverse/bitwiseOr/bitwiseAnd/bitwiseXor/shiftLeft/shiftRight` (typeId 9, methodIds 6–13), all `minVersion: 3`, `FixedCost(JitCost(5))`, implementation in `eval/_numeric-v6.ts` `ubiDesc`; +2 from v6 P2c — `BigInt.toUnsigned` (6:14) `FixedCost(5)` and `UnsignedBigInt.toSigned` (9:19) `FixedCost(10)`, both `minVersion: 3`, bridge the signed↔unsigned BigInt boundary; +5 from v6 P2d-1 — `UnsignedBigInt.plusMod` (9:15), `subtractMod` (9:16), `multiplyMod` (9:17), `mod` (9:18), `BigInt.toUnsignedMod` (6:15), all `minVersion: 3`; +1 from v6 P2d-2 — `UnsignedBigInt.modInverse` (9:14), `minVersion: 3`, `FixedCost(150)`; +4 from v6 P3 — `SColl.reverse` (12:30), `SColl.startsWith` (12:31), `SColl.endsWith` (12:32), `SColl.get` (12:33), all `minVersion: 3`; +2 from v6 P4 — `SGlobal.some` (106:9) `FixedCost(JitCost(5))` Pattern A, `minVersion: 3`, generic return `Option[T]` via P0 engine; `SGlobal.none` (106:10) `FixedCost(JitCost(5))` Pattern A, `minVersion: 3`, PropertyCall opcode, generic return `Option[T]` via P0 engine; +2 from v6 P5a — `SGlobal.serialize` (106:3) DynamicCost Pattern A, `minVersion: 3`, closed return `Coll[Byte]`, T derived from runtime value kind; `SGlobal.deserializeTo` (106:4) `PerItemCost(100, 32, 32)` Pattern A, `minVersion: 3`, generic return `T` via P0 engine; +1 from v6 P5b-1 — `SGlobal.fromBigEndianBytes` (106:5) `FixedCost(10)`, `minVersion: 3`, generic return `T` via the P0 engine; +1 from v6 P5c — `SGlobal.powHit` (106:8) `PowHitCostKind`, `minVersion: 3`, closed return `SUnsignedBigInt`, delegates to `@ergots/scorex` `autolykosHitForMessageWithChecks`; +3 from v6 P7a — `SBox.getReg[T]` (99:19) `FixedCost(50)`, `minVersion: 3`, generic `Option[T]` with explicit type arg; `SContext.getVarFromInput[T]` (101:12) `FixedCost(10)`, `minVersion: 3`, generic `Option[T]` with explicit type arg, total/never-throws; `SGroupElement.expUnsigned` (7:6) `FixedCost(900)`, `minVersion: 3`, monomorphic `GroupElement`, shared `expPoint` helper). **Note on historical per-phase running tally:** the P2d-2 changelog entry above reads "110 entries"; this was a tally drift that did not count the loop-registered numeric/UBI handlers (48 entries across v6 P1 + P2b). The correct count as of v6 P3 completion was 114 (66 individual `HANDLERS.set` calls + 48 loop-registered entries); the section header has always been authoritative. After v6 P4 the count is 116; after v6 P5a the count is 118; after v6 P5b-1 the count is 119; after v6 P5b-2 the count is 121; after v6 P5c the count is 122; after v6 P7a the count is 125. (chain corrected 2026-06-06: a P3-era recount was one high — 67+48 claimed vs 66+48 actual; values shown are the true counts, verified by static count + runtime probe)

**Public function signatures are stable** from v0.2.0 onward. Future arms slot into central dispatch (`eval/eval.ts`) without changing `evaluate`, `evaluateWith`, `makeContext`, or `EvalError`.

**`EvalOpts` is open for additive growth.** Phase 2e added `treeVersion?: number`. Phase 2f medium added 6 chain-state fields. Phase 2g.5 added `dataInputs?: ErgoBox[]`. Phase 2g.6 added no new fields (the existing `preHeader?: PreHeader` from 2f medium is consumed by the new `SContext.preHeader` handler). Phase 2h-b added no new fields (the `SAvlTree.*` handlers receive the receiver `AvlTreeData` through the method-call arg surface, not via context). Phase 2h-c.1 added `headers?: Header[]`. Phase v6 P7a adds `inputExtensions?: ContextExtension[]` (per-input context extensions indexed by spending-transaction input position, consumed by `SContext.getVarFromInput` 101:12; absent ⇒ every lookup → None; see interface block above for the invariant).

**`@noble/curves@2.2.0` added in phase 2g-medium.** Version-locked with `@noble/hashes@2.2.0`. Used by the secp256k1 adapter (`crypto/secp256k1.ts`) and the sigma verifier (see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md)).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting guarantees
- [`facts/ergoscript-wire.md`](./ergoscript-wire.md) — wire format (parseTree, serializeTree, ErgoTreeParseError/SerializeError)
- [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) — sigma-protocol verifier (`SigmaBoolean`, `verifySignature`, `VerifyError`)
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` — method-call dispatcher
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — phase 2g.6 (5 new method handlers + Global arm)
- `docs/specs/2026-05-20-ergoscript-phase-2i-a-pure-bytes-predefs-design.md` — most recent eval phase (8 new Expr arms: hash predefs + byte<->numeric conversions + Xor + DecodePoint + SubstConstants)
