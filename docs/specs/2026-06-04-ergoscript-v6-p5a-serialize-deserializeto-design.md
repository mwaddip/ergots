# ErgoScript v6 (ErgoTree V3) — P5a: `Global.serialize` + `Global.deserializeTo`

**Date:** 2026-06-04
**Status:** COMPLETE (2026-06-04) — implemented (T1–T7) + reviewed; one deferred residual (V1-Header d=0 byte-shape → v6 scorex work)
**Branch:** `ergoscript-v6`
**Scope owner:** `@ergots/ergoscript`
**Umbrella:** `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` (P5 ledger)

This is the first slice of **P5 (Global functions)**, which decomposes into:

- **P5a** — `serialize` (106:3) + `deserializeTo` (106:4)  ← *this spec*
- **P5b** — `fromBigEndianBytes` (106:5) + `encodeNbits` (106:6) + `decodeNbits` (106:7)
- **P5c** — `powHit` (106:8) — Autolykos v2, carved for the 95% crypto-confidence bar

The seam is by machinery: P5a is the value/data-codec pair (inverse round-trip, both
re-drive ergots' existing `serializeSValue`/`parseSValue`); P5b is the numeric/compact
decoders; P5c is the PoW carve-out. All independently orderable (no inter-deps; all the
generics ride P0, done; `powHit` returns `SUnsignedBigInt`, P2 done).

## Scope

- **In:** eval + JIT cost for `Global.serialize[T](value: T): Coll[Byte]` (106:3) and
  `Global.deserializeTo[T](bytes: Coll[Byte]): T` (106:4), both gated ErgoTree version ≥ 3
  (`minVersion: 3`). Full data-type domain (every type `DataSerializer` handles):
  Boolean, Byte, Short, Int, Long, BigInt, UnsignedBigInt, GroupElement, SigmaProp,
  Unit, Coll[T], Tuple, Option[T], Box, AvlTree, Header, String.
- **Out:** `fromBigEndianBytes`/`encodeNbits`/`decodeNbits`/`powHit` (P5b/P5c). No wire
  mutation/roundtrip re-hardening (the codecs are already byte-validated from phase 2a).

## Canonical source (JVM — sole oracle)

`~/projects/sigmastate-interpreter/`:
- `data/.../sigma/ast/methods.scala` — `serializeMethod` (1957-1984), `deserializeToMethod`
  (1906-1955), registration (2006-2011), `deserializeCostKind` (1904).
- `data/.../sigma/serialization/{DataSerializer,CoreDataSerializer,SigmaByteWriter,
  ValueSerializer,ConstantSerializer,MethodCallSerializer}.scala` — formats + per-write costs.
- `data/.../sigma/data/CSigmaDslBuilder.scala:277-282` — `deserializeTo` runtime body.
- `sc/.../sigma/LanguageSpecificationV6.scala` — `verifyCases`: serialize 76-201,
  deserializeTo 1674-1794 (cost+value oracle).

## What's verified up front (the findings that shape this)

1. **Zero new wire code.** The MethodCall opcode (0xdc) already parses explicit type args
   (`wire/mir/method-call.ts`), and the shared registry `wire/mir/explicit-type-args.ts:56`
   already lists `106:4` (deserializeTo carries `T`). `serialize` carries **no** wire type
   arg — the JVM `serializeMethod` `SMethod` ctor declares no `explicitTypeArgs`, and
   `MethodCallSerializer` only writes type args for methods that declare them
   (`MethodCallSerializer.scala:23-33`); `T` is inferred from the value arg. So P5a adds
   **handlers + signatures only**. Do **not** add `106:3` to the explicit-type-args registry.
2. **Reuse the existing codecs.** `serializeSValue(t, v, treeVersion, w)`
   (`wire/serialize-svalue.ts:139`) and `parseSValue(t, treeVersion, r)`
   (`wire/parse-svalue.ts:157`) are ergots' byte-identical analog of the JVM
   `DataSerializer.serialize`/`deserialize`. `serialize`/`deserializeTo` drive them from
   inside eval. `serialize` global output = the data bytes only (no type prefix), confirmed
   by the verifyCases (`serialize[Byte](-128)` → `[0x80]`, 1 byte).
3. **`deserializeTo` is a *sibling* of the Deserialize family, not an extension.**
   `DeserializeContext`/`DeserializeRegister` (`eval/deserialize-*.ts`) pull bytes from
   context vars / registers and are compile-time substituted (they throw at eval).
   `deserializeTo` takes arbitrary runtime bytes and is a normal runtime method. No overlap.
4. **`serialize`'s `T` comes from the runtime value, not `exprTpe`.** See "serialize / type
   resolution" below — this is the load-bearing correctness decision.
5. **Handler template = P4 `some`/`none`** (`eval/method-call.ts:430-482`): `HANDLERS.set(
   handlerKey(106, n), { handler, minVersion: 3 })`; handler `(obj, args, ctx,
   explicitTypeArgs, extra?) => SValue`; Pattern-A `ctx.addCost(...)` then `obj.kind` /
   `args.length` guards.

---

## `deserializeTo` (106:4) — the simple half

**Signature** (`method-signatures.ts`): `tDom = [SGlobal, Coll[SByte]]`, `tRange = STypeVar 'T'`,
`tpeParams = [{name:'T'}]`. Generic `tRange` resolved by the P0 engine via the wire explicit
type arg (the `none` precedent: `T` is read off the wire, `resolveReturnTpe` substitutes).

**Cost:** `PerItemCost(base=100, perChunk=32, chunkSize=32)` over **input `bytes.length`**
(`deserializeCostKind`, `methods.scala:1904`; charged via `addSeqCost(…, bytes.length, …)`,
`methods.scala:1951`). In ergots: `ctx.addPerItemCost(100, 32, 32, bytes.length)` (existing
API, `eval-context.ts:122`). Structure-independent — every target type costs the same for a
given input length. Oracle check: 33 input bytes → `100 + ((33-1)/32+1)*32 = 100 + 2*32 = 164`
(matches the GroupElement verifyCase). **Cost is charged before deserializing** (so it's
charged even on a parse failure) — matches the JVM `addSeqCost` ordering.

**Body:**
1. `ctx.addPerItemCost(100, 32, 32, bytes.length)`.
2. `obj.kind === 'Global'` guard; `args.length === 1` guard.
3. `bytes = collByteToUint8Array(args[0], 'Global.deserializeTo')` (`eval/_byte-coll.ts`).
4. `T = explicitTypeArgs['T']!` (guaranteed by the wire parser).
5. `value = parseSValue(T, ctx.treeVersion ?? 0, new ByteReader(bytes))`.
6. return `value`.

**Faithfulness pins (each a fork if wrong):**
- **Trailing bytes are IGNORED — do NOT require the reader exhausted.** The JVM does not
  check `r.isExhausted()` after `DataSerializer.deserialize` (`CSigmaDslBuilder.scala:277-282`
  reads exactly what the type needs and discards the rest). Adding the "obvious clean"
  trailing-byte check would reject where the JVM accepts.
- **Depth bound = `MaxTreeDepth` 110, DATA-DRIVEN (not type-structural).** The JVM caps
  recursion via `r.level` (`CoreByteReader.level_=` throws when level > 110;
  `CoreDataSerializer.deserialize` increments level once per ACTUAL recursive call, descending
  only into elements that are PRESENT). So a deeply-nested *type* whose *data* is empty/shallow
  (e.g. `deserializeTo[Coll[Coll[…111…]]]` of an empty outer coll) is **accepted** — the JVM
  returns an empty coll at recursion depth 1. The bound is on the actual parse-recursion depth,
  NOT on `T`'s nesting depth (an earlier draft of this spec had that backwards — caught in
  code-quality review). **CLOSED STRUCTURALLY (T2.5, 2026-06-04):** the initial implementation
  threaded a `depth`/`maxDepth` param through `parseSValue` (data path ONLY); a code-quality
  review flagged that as piecemeal — the SSigmaProp→`parseSigmaBoolean` conjecture nesting, the
  box-register sub-parse, and the general expr-tree/Constant path were all un-counted (each a
  fork). That threaded param was REPLACED by a single shared reader-level counter on
  `@ergots/scorex` `ByteReader` (`level` + `maxTreeDepth` default 110, `enterDepth`/`exitDepth`),
  bumped at the three central recursion funnels — `parseExpr` (≡ JVM `ValueSerializer`),
  `parseSValue` (≡ `CoreDataSerializer`), `parseSigmaBoolean` (≡ `SigmaBoolean.serializer`).
  Because every ergots parser threads the one reader, ALL nesting kinds are now bounded uniformly
  (the previously-documented box-register + whole-tree-Constant residuals are CLOSED). A fresh
  `ByteReader` defaults to 110 (mirroring the JVM's fresh reader), so `parseTree`, box parse,
  `deserializeTo`, and DeserializeContext/Register re-parses are all bounded as the JVM bounds
  them. The `hasSize=true` ErgoTree body forks a sub-reader that INHERITS the parent level
  (`forkSubReader`), matching the JVM's single-reader `positionLimit` approach. Over-depth raises
  `ReaderError('max-tree-depth-exceeded')` (the single faithful analogue of the JVM
  `DeserializeCallDepthExceeded`), caught at the `deserializeTo` boundary → `global-deserialize-failed`.
- **Oversized data throws** (BigInt/UBI > 32 bytes) — `parseSValue` already enforces this
  (the SBigInt/SUnsignedBigInt arms); maps to a deserialize-failure EvalError.

**Errors:** wrap any `SValueParseError` (malformed bytes, oversized, depth) raised by
`parseSValue` in an `EvalError` with code `'global-deserialize-failed'` (1 new code; the
specific cause is preserved in the message). Cost already charged (step 1).

---

## `serialize` (106:3) — the substantive half

**Signature:** `tDom = [SGlobal, STypeVar 'T']`, `tRange = Coll[SByte]` (**closed** — returned
verbatim by `resolveReturnTpe`), `tpeParams = [{name:'T'}]`. No wire type arg (finding 1).

### Type resolution — `T` from the runtime value (the load-bearing decision)

The JVM serializes by `mc.args(0).tpe` (the static arg type, `methods.scala:1982`). ergots'
static `exprTpe` is **incomplete** (returns `SAny` for unresolved MethodCall/PropertyCall
returns — the iter-19 class), so using it would **throw where the JVM succeeds** on honest
trees (e.g. `serialize(coll.map(f))`) — a consensus fork.

**Decision: derive `T` from the runtime value, never from `exprTpe`.** ergots' runtime
values carry their own types — `Coll` carries `elem: SType`, `Option` carries `elem`
(`mir/types.ts:873,875`), tuples carry per-item values — so a value→type function is total
and concrete on real values (even an empty `Coll[Int]` knows its element type).

This is **faithful, not a workaround**: `DataSerializer` has no case for
`SAny`/`SFunc`/`SContext`/`SGlobal`/`SPreHeader` (`CoreDataSerializer` default →
`SerializerException`), so the JVM only serializes successfully when the type is concrete and
serializable. The runtime value hands us exactly that concrete type. Therefore ergots
succeeds **iff** the JVM succeeds, with the same type → same bytes, same cost. `exprTpe`/SAny
never enters the path, so its incompleteness is irrelevant here.

**The SAny adversarial edge is empty** (verified): the only constructs that yield an
`SAny`-typed expression (`getVar[SAny]`, `getReg[SAny]`, `deserializeTo[SAny]`) deserialize
their payload via `DataSerializer.deserialize`, which **throws at deserialization** for SAny —
so no JVM-accepted tree ever evaluates a concrete value with SAny static type into
`serialize`. There is no tree where the JVM throws-at-serialize that runtime-type derivation
would make ergots accept.

**Implementation:** factor a complete `sValueType(v: SValue): SType` used by `serialize`.
The existing `inferSType` (`eval/coll-map.ts:223`) is the starting point but is **incomplete**
for this use — it lacks arms for **`Header`** (which *is* in the deserializeTo verifyCases:
`deserializeTo[Header](serialize(header))`), **`String`**, `PreHeader`, `Context`, `Global`,
and maps `Lambda → SAny`. Extend/rename it to a shared `sValueType` covering every
serializable kind; for non-serializable kinds (`Lambda`/`PreHeader`/`Context`/`Global`)
return a sentinel that makes `serializeSValue` throw — matching the JVM (which also throws).
*(Refactor `coll-map.ts` to consume the shared helper; behavior-preserving for Map.)*

### Cost — `DynamicCost` via an analytical walk

The JVM cost is **`DynamicCost`** = `StartWriterCost(10)` + the sum of per-primitive-write
costs accrued as `DataSerializer` walks the value (`serialize_eval`, `methods.scala:1968-1984`
installs cost callbacks on the writer). It is **structure-dependent, not byte-count**:
`serialize[Int](MIN)` is 10 bytes but costs `10 + 3 = 13`; `serialize[Coll[Byte]](1,2,3)` is
4 bytes but costs `10 + 3 + (3+3) = 19`.

ergots has **no per-write cost mechanism** (`eval-context.ts` is FixedCost/PerItemCost only).
**Approach: an analytical cost walk `serializeCost(t, v, ctx)`** that switches on `t.tag`
(mirroring `serializeSValue`) and charges `ctx.addCost(…)` per primitive the JVM would write.

> **Why not instrument a writer** (route `serializeSValue` through a cost-tracking
> `ByteWriter`)? ergots' `ByteWriter` API *collapses* distinctions the JVM cost depends on:
> `writeVlqU` is used for both Coll/BigInt length (JVM `putUShort`, cost **3**) and Box
> `creationHeight` / AvlTree `keyLength` (JVM `put_u32`/`putUInt`, cost **0**). A uniform
> per-method charge mis-costs Box/AvlTree; making it faithful would mean editing the
> byte-validated `serializeSValue`. The analytical walk decouples cost from the byte writer
> and is validated by the blessed vectors. Acceptable cost: a second walk mirroring
> `serializeSValue`, kept in sync (the 6 simple `verifyCases` pin the constants; byte
> fixtures pin the sequence).

**Primitive cost table** (from `SigmaByteWriter.scala`, agent-verified `file:line`):

| JVM primitive | cost | used by |
|---|---|---|
| `StartWriter` | 10 | once, top of serialize |
| `put` / `putByte` / `putBoolean` | 1 | SByte (1 byte), SBoolean, Header.version |
| `putShort`/`putInt`/`putLong` (signed) | 3 | SShort, SInt, SLong |
| `putUShort` / `put_u16` | 3 | Coll/BigInt/UBI length, Box.index |
| `putULong` / `put_u64` | 3 | Box.value, token.amount, Header.timestamp |
| `putUInt(DataInfo)` / `put_u32` | 3 | Box.creationHeight, Header.height, AvlTree.keyLength, token.index |
| `putUByte` | **0** | token count, register count, AvlTree flags, unparsed-len |
| `putBytes(n)` | 3 + n | all raw byte blobs (PerItemCost(3,1,1)) |
| `putBits(nbits)` | 3 + nbits | Coll[Boolean] |
| `putOption` (tag) | 1 | Option, AvlTree.valueLengthOpt |

> **Note** — the JVM packs `put_u32`/`put_u16` distinctly: `Box.creationHeight` and
> `AvlTree.keyLength` cost **3** here via `putUInt(DataInfo)`/`put_u32` *with* an info arg
> (`PutUnsignedNumericCost`), **not** 0. The 0-cost `putUInt` is the no-arg overload, not used
> on these paths. (Resolved against `ErgoBoxCandidate.scala:143`, `AvlTreeData.scala:77`,
> `SigmaByteWriter.scala:109-113`.) The implementer pins each from source during TDD.

**Per-`SType` cost rules** (`cost = StartWriter(10) + walk(t,v)`):

- **SBoolean** = 1 · **SByte** = 1 · **SShort/SInt/SLong** = 3 · **SUnit** = 0.
- **SBigInt / SUnsignedBigInt** = 3 (`putUShort` len) + (3 + dataLen) (`putBytes`).
- **SGroupElement** = 3 + 33 = 36 (`putBytes(33)`).
- **SColl[SByte]** = 3 (len) + (3 + n). **SColl[SBoolean]** = 3 + (3 + n) (`putBits`).
  **SColl[T] general** = 3 (len) + Σ walk(elem, item).
- **STuple** = Σ walk(item) (no length prefix).
- **SOption** = 1 (tag) + (Some ? walk(elem, inner) : 0).
- **SString** = 3 (len) + (3 + utf8Len). *(SString length is `putUShort` here — confirm vs
  `putUInt` during TDD; not reachable from a normal `T` but covered for completeness.)*
- **SAvlTree** = 36 (digest `putBytes(33)`) + 0 (flags) + 3 (keyLength) + (1 | 1+3) (option).
- **SHeader** (V3 gate) = the fixed `HeaderWithoutPow` sequence + the version-2 Autolykos
  solution: `put(version)=1` + 4×`putBytes(32)=35` (parentId, ADProofsRoot, transactionsRoot,
  extensionRoot) + `putBytes(33)=36` (stateRoot) + `putULong(timestamp)=3` +
  `putBytes(nBits 4)=7` + `putUInt(height)=3` + `putBytes(votes 3)=6` +
  `putUByte(unparsedLen)=0` + `putBytes(unparsed)=3+u` + solution V2:
  `GroupElement.serialize(pk)=36` + `putBytes(n=8)=11`. Transcribe from
  `HeaderWithoutPow.scala:47-65` + `ErgoHeader.scala:62-87`; validate by round-trip.
- **SBox** = `putULong(value)=3` + `putBytes(ergoTree)=3+treeLen` + `putUInt(creationHeight)=3`
  + `putUByte(nTokens)=0` + Σtokens[`putUInt(idx)=3` + `putULong(amount)=3`] +
  `putUByte(nRegs)=0` + Σregisters[**putType cost** + walk(regTpe, regVal)] +
  `putBytes(txId 32)=35` + `putUShort(index)=3`. The register `putType cost` = the
  type-serialization cost = number of bytes `serializeSType(regTpe)` writes × 1 (each a `put`).
  *(Confirmed register path: no opcode, no envelope — `ConstantSerializer.serialize` =
  `putType` + `DataSerializer.serialize`, via the cost writer with no constant store.)*

**Body:**
1. `T = sValueType(args[0])`.
2. `ctx.addCost(10)` (StartWriter), then `serializeCost(T, args[0], ctx)` (the walk; charges
   per primitive). *(Equivalently a single walk that also emits bytes — but we keep bytes in
   `serializeSValue` and cost in `serializeCost` to avoid touching the validated serializer.)*
3. `obj.kind === 'Global'` guard; `args.length === 1` guard.
4. `w = new ByteWriter(); serializeSValue(T, args[0], ctx.treeVersion ?? 0, w)`.
5. return `bytesToCollByteSValue(w.toBytes())`.

**Cost ordering:** the JVM charges `StartWriterCost` first, then per-write *during*
serialization. We charge `addCost(10)` + the full `serializeCost` walk **before** writing
bytes (or interleaved — same total). Charging before the byte write is fine: the only
observable is the total + the cost-limit throw point, and the walk visits the same primitives.

**Errors:** a non-serializable `T` (sentinel from `sValueType`, or `serializeSValue` throwing
`'not-implemented-phase-2a'` for SAny/SFunc/etc.) maps to `EvalError 'global-serialize-failed'`
— matching the JVM throw. Bounds violations from `serializeSValue` (e.g. a value out of range)
also map there.

---

## Wire

No changes. `106:4` is already in `explicit-type-args.ts` (deserializeTo carries `T`); the
MethodCall opcode parses/serializes it. `serialize` (106:3) is **not** added to the registry
(it carries no wire type arg). Confirm a `106:3` MethodCall round-trips with zero trailing
type-arg bytes.

## Method signatures

Add to `mir/method-signatures.ts`:
- `106:3` serialize — `tDom: [{SGlobal}, {STypeVar 'T'}]`, `tRange: {SColl, elem:{SByte}}`
  (closed), `tpeParams: [{name:'T'}]`.
- `106:4` deserializeTo — `tDom: [{SGlobal}, {SColl, elem:{SByte}}]`, `tRange: {STypeVar 'T'}`,
  `tpeParams: [{name:'T'}]`.

## Error taxonomy

2 new `EvalError` codes (registry/code counts updated in facts/): `'global-serialize-failed'`,
`'global-deserialize-failed'`. *(If the depth bound is implemented as a distinct error,
`'deserialize-max-depth-exceeded'` is a 3rd; otherwise it rolls into deserialize-failed.)*

## Testing

- **Oracle = JVM `verifyCases`** — serialize totals from `LanguageSpecificationV6.scala:76-201`
  (Byte/Short/Int/Long/Coll[Byte]/Tuple), deserializeTo from 1674-1794
  (GroupElement/Header/BigInt round-trips). Extract exact `tree_bytes_hex` + cost during TDD.
- **Full-tree cost gotcha** (per the P2c process-find): the blessed `verifyCases` cost is the
  *whole tree* cost — it includes per-`Const` eval (5 each) + the MethodCall dispatcher
  envelope (4) on top of the method's `StartWriter(10) + walk`. Compute expected totals
  accordingly; don't assert the method portion alone.
- **Round-trip property:** `deserializeTo[T](serialize(x)) == x` across all supported types
  (the JVM's own test shape). Strong cross-check for both halves + `sValueType`.
- **Cost composition for complex types** (Box/Header/AvlTree, no standalone blessed vector):
  validity rests on (a) the per-write *constants* — pinned by the 6 simple serialize vectors —
  and (b) the write *sequence* — pinned by the existing byte-roundtrip fixtures
  (`serializeSValue(box)` is byte-identical to the JVM). Cost = sequence × constants is correct
  by composition; add explicit serialize-cost tests for a Box-with-registers, a Header, and an
  AvlTree using model-derived expected costs, cross-checked against the round-trip total.
- **Adversarial:** malformed `deserializeTo` bytes (truncated, wrong type lead) → typed throw;
  oversized BigInt/UBI → throw; **depth > 110** → throw (the new bound); trailing bytes after a
  valid value → **accepted** (pin the non-fork); `serialize` of a value whose runtime type is
  non-serializable → typed throw.
- **Gate:** `tsc --noEmit` clean (4 pkgs); full suite green (node + jsdom).

## facts/ updates (Task 1 of the plan, contract-first)

`facts/ergoscript-eval.md`: registry 117 → 119 (serialize, deserializeTo); EvalError codes
74 → 76 (+`global-serialize-failed`, +`global-deserialize-failed`); SGlobal method table rows
106:3 / 106:4 with cost kinds (serialize = DynamicCost-via-walk; deserializeTo =
PerItemCost(100,32,32) on input length); note the runtime-type-derivation decision +
the deserialize depth bound. `facts/ergoscript-wire.md`: note `serialize` carries no wire type
arg; `deserializeTo` reuses the existing MethodCall explicit-type-arg slice (no wire change).

## Sequencing (for the plan)

1. facts/ + umbrella ledger update (contract-first).
2. `deserializeTo` (handler + signature + cost + depth bound + tests) — small; proves the
   handler/signature/round-trip scaffolding.
3. `sValueType` shared helper (extend/rename `inferSType`; cover Header/String/etc.;
   behavior-preserving for Map).
4. `serialize` simple types (scalars/BigInt/UBI/GroupElement/Coll/Tuple/Option) + the
   `serializeCost` walk core (pin constants vs the 6 verifyCases).
5. `serialize` complex types (AvlTree, Header, Box incl. register `putType` cost).
6. Round-trip + adversarial coverage; final review.

## Open items / risks

- **Depth bound (110)** — FULLY RESOLVED (T2.5, 2026-06-04). The original threaded-`maxDepth`
  param on `parseSValue` (data path only) was replaced by a single shared reader-level counter
  on `@ergots/scorex` `ByteReader` (`enterDepth`/`exitDepth`, default cap 110), incremented at
  the three central recursion funnels (`parseExpr`, `parseSValue`, `parseSigmaBoolean`). Both
  previously-deferred residuals — box-register sub-parse depth AND whole-tree Constant/expr
  depth — are now CLOSED, because all parsers share the one reader. Boundary tests cover every
  nesting kind (expr-tree, data Coll/Option, sigma-boolean, box-register) at 110-accept /
  111-reject; full suite (3744) + all real-tree fixtures unaffected (node + jsdom). See the
  faithfulness pin above.
- **`put_u32` vs no-arg `putUInt` cost** on Box.creationHeight / AvlTree.keyLength / token
  index / Header.height — pinned to 3 (DataInfo overload) above; re-verify each call site
  during TDD against `SigmaByteWriter.scala`.
- **`putType` (register) cost** = serializeSType byte-count × `put`(1); confirm TypeSerializer
  writes type bytes via `put` (cost 1) per byte (vs `putBytes`).
- No standalone blessed serialize(Box/Header/AvlTree) cost vector → relies on the
  composition argument above; the round-trip totals are the backstop.
- **Tuple-Expr register serialize-cost — CLOSED (T7 final-review fix, 2026-06-04).**
  `serialize(Box)` of a box with a Tuple-Expr (`opaqueBytes`) register was throwing in the cost
  walk while the byte path + the JVM accept it (over-reject fork; reachable via context boxes,
  e.g. h=855,650 R8 `(SByte 102, SByte 99)`). Fixed by `addRegisterExprCost`, which cost-walks the
  register's raw bytes and charges the JVM `putValue` path (`put(OP_TUPLE)=1` + `putUByte(count)=0`
  + per-item: Const → `putType`+`DataSerializer`, nested Tuple → recurse). The `(SByte,SByte)`
  register costs 5.
- **V1-Header `d=0` byte-shape fork — DEFERRED to v6 scorex work (user call, 2026-06-04)** — adversarial-only.
  `serialize`/`deserializeTo` for a hand-crafted V1 (block-version-1) `Header` with
  `powDistance=0` produces bytes shaped by `@ergots/scorex` (following sigma-rust):
  `d_len=1, d_bytes=[0x00]` = 2 bytes. The JVM instead serializes d=0 as `d_len=0, d_bytes=[]`
  = 1 byte (Scala `BigIntegers.asUnsignedByteArray` of `BigInteger.ZERO` returns empty).
  Source: `sigma-rust/ergo-chain-types/src/header.rs AutolykosSolution::serialize_bytes(v1)`;
  JVM: `AutolykosSolutionSerializer.scala:45-51`. This is a **pre-existing sigma-rust-vs-JVM
  fork in `@ergots/scorex`'s Autolykos-V1 d-encoding**, not introduced by P5a. Scope: fully
  adversarial — real V1 mainnet headers have non-zero powDistance (d=0 is not a valid PoW
  solution), and V1 blocks are unreachable via `Context.headers` on a V3+ chain (tree-version
  gate). The serialize COST is JVM-faithful regardless of the d-encoding fork. The round-trip
  test for Header is therefore restricted to V2 (version ≥ 2) only. Tracked pending a
  validation-model decision (sigma-rust vs JVM for scorex's Autolykos-V1 d-encoding) — to be made
  when the v6 scorex part is built; DEFERRED there per the user (2026-06-04).
