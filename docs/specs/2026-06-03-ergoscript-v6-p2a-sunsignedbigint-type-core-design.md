# ErgoScript v6 — P2a: `SUnsignedBigInt` type core (wire + value + version gate)

**Date:** 2026-06-03
**Status:** draft (brainstorm complete; pending adversarial review + user sign-off)
**Branch:** `ergoscript-v6`
**Umbrella:** `2026-06-02-ergoscript-v6-umbrella-design.md` — this is **P2a**, the first of the
three P2 sub-phases agreed with the user (P2a type core → P2b numeric+cast methods → P2c
modular arithmetic + conversions). Sequential: spec P2a → build P2a → spec P2b → …

## 1. Goal & scope

Make `SUnsignedBigInt` a **first-class constant** end-to-end, nothing more:

- It exists in the `SType` and `SValue` unions.
- A `SUnsignedBigInt` **constant** parses from the wire, evaluates to its value, and
  re-serializes **byte-identically**; `exprTpe` reports `SUnsignedBigInt`.
- It is **version-gated**: a tree carrying the type is accepted iff ErgoTree
  version ≥ 3, rejected (pre-eval, zero cost) otherwise — matching the JVM.

**Explicitly out of P2a (deferred):**

- All methods — the inherited numeric/bitwise family (ids 6–13) and casts → **P2b**.
- Modular arithmetic (`modInverse`/`plusMod`/`subtractMod`/`multiplyMod`/`mod`) +
  conversions (`toSigned`, `BigInt.toUnsigned`/`toUnsignedMod`) → **P2c**.
- `Upcast`/`Downcast` arms for `SUnsignedBigInt` (numeric casts lower to these) → **P2b**.
- `mir/method-signatures.ts` catalog entries (only needed once methods exist) → **P2b**.

## 2. Canonical source (JVM `sigma-state`, confirmed by direct read)

All references are `~/projects/sigmastate-interpreter/`. v6 canonical source is the JVM
**only** (no sigma-rust dependency, no Rust fixture-gen — per the umbrella).

| Fact | Source |
|---|---|
| `SUnsignedBigInt` — type code **9**, `SEmbeddable` + `SNumericType`, 256-bit, `MaxSizeInBytes` = `SBigInt.MaxSizeInBytes` (32) | `core/.../sigma/ast/SType.scala:547`+ |
| Added to the type universe / receiver map / `isValueOfType` under **`isV3OrLaterErgoTreeVersion`** (tree version ≥ 3) | `SType.scala:117` (`allPredefTypes`), `:167` (`types`), `:194` (`isValueOfType`) |
| Embeddable id→type table includes idx 9 only in `embeddableV6`, selected by `isV3OrLaterErgoTreeVersion` | `core/.../serialization/TypeSerializer.scala:257-267` |
| Value **serialize** = `BigIntegers.asUnsignedByteArray` (unsigned magnitude BE), `putUShort` length; **deserialize** = `fromUnsignedByteArray`, `getUShort` length, cap `SBigInt.MaxSizeInBytes` | `core/.../serialization/CoreDataSerializer.scala:39-42, 118-124` |
| `SFunc` serialized type code (112) gated on `isV3OrLaterErgoTreeVersion` (the parallel v3+-only type construct) | `TypeSerializer.scala:111, 211` |

**Not** the gate (node-consensus, out of ergots scope): the `isV6Activated` branches at
`methods.scala:131` and `TypeSerializer.scala:19` select the soft-fork *validation-rule*
opcode (`CheckPrimitiveTypeCode` vs `…V6`, rule 1007→1017 / 1011→1016). That is block-version
activation machinery the project deliberately does not model. The in-scope gate everywhere
that matters for eval/cost faithfulness is **`treeVersion >= 3`** — the same gate P1 uses.

Scorex `putUShort`/`getUShort` are VLQ-encoded (single byte for 0–32), so ergots' existing
`writeVlqU`/`readVlqU` length framing matches the JVM length prefix exactly.

## 3. The value codec — distinct from `SBigInt` (consensus-critical)

`SUnsignedBigInt` is **not** a copy of the `SBigInt` arm. The encodings differ:

| | `SBigInt` (existing) | `SUnsignedBigInt` (P2a) |
|---|---|---|
| Encode | `toByteArray` — signed two's-complement, minimal (high-bit-set positive ⇒ leading `0x00`) | `asUnsignedByteArray` — unsigned magnitude, minimal (no sign padding) |
| Decode | `new BigInteger(bytes)` — signed | `fromUnsignedByteArray(bytes)` — unsigned magnitude |
| Range fit in 32 B | `[-2^255, 2^255−1]` | `[0, 2^256−1]` |

Confirmed edge cases (each becomes a vector), verified against **sigma's own**
`core/.../sigma/crypto/BigIntegers.scala` — **not** BouncyCastle. The serializer imports
`sigma.crypto.BigIntegers` (`CoreDataSerializer.scala:5`), whose reimplementation **drops
BouncyCastle's `&& length != 1` guard** — which changes the zero case. (An earlier draft of
this spec read the BouncyCastle impl and got `0` backwards; corrected below.)

- **`0` → `[]` (empty, length 0).** `asUnsignedByteArray(0)` strips the leading zero
  **unconditionally** (`BigIntegers.scala:110-118`: `if (bytes(0) == 0) strip`), so
  `toByteArray` (`[0x00]`) ⇒ empty. On the wire: VLQ length `0`, no value bytes (`00`). **This
  is the opposite of `SBigInt`**, where `0 → [0x00]` (`encodeBigIntBE`,
  `serialize-svalue.ts:557`) — carrying SBigInt's behavior over emits `01 00` and **forks**.
- **No high-bit sign padding.** `128` (`0x80`) ⇒ `[0x80]` (1 byte), where `SBigInt` emits
  `[0x00, 0x80]`. The encoder must be a **fresh magnitude encoder**, not a tweak of
  `encodeBigIntBE` (whose high-bit `unshift(0x00)`, `serialize-svalue.ts:566-567`, must NOT be
  carried over). This is the canonical distinctness test.
- **Full 256-bit range.** `2^255` ⇒ `0x80` + 31×`0x00` (32 bytes); `2^256−1` ⇒ 32×`0xFF` —
  values `SBigInt`'s signed 32-byte codec cannot represent as positive.
- **Length-0 on the wire decodes to `0`** (`fromUnsignedByteArray([])` = `new BigInteger(1,[])`
  = 0, `BigIntegers.scala:102`; the deserializer does **not** reject size 0,
  `CoreDataSerializer.scala:118-124`). ergots **must accept** length-0 → `0n` — rejecting it
  would be stricter than the JVM = fork. With the corrected encoder, `0` round-trips
  canonically as length-0 (symmetric). NB this **differs from `SBigInt`**, which rejects
  length-0 (audit ERG-03; sigma-rust `from_be_slice` returns `None`).
- **Decode cap 32 bytes** (`> 32` ⇒ reject, `CoreDataSerializer.scala:120`). NB the JVM
  **serialize** path has **no** length cap (no `require(fitsIn256Bits)`, unlike `SBigInt` at
  `CoreDataSerializer.scala:35`). ergots keeps a **defensive** encoder guard (an out-of-range
  UBI is an internal invariant violation, unreachable from a valid parse or a v6 method), but
  it is *defensive*, not a JVM-serialize mirror.
- **Non-canonical inputs decode but don't round-trip byte-identically.** A leading-zero
  encoding (e.g. `[0x00, 0x05]`) decodes to `5` and re-encodes canonically to `[0x05]` — same
  as `SBigInt`. Not a fork (the consensus tree hash uses the captured original proposition
  bytes, not a re-serialization), but the test author must **not** assert byte-identity on a
  non-canonical UBI vector.

New helpers, paralleling `encodeBigIntBE`/`decodeBigIntBE`:

- `encodeUnsignedBigIntBE(v: bigint): Uint8Array` — `v < 0n` ⇒ throw (UBI is non-negative);
  else emit minimal unsigned BE magnitude bytes (the `while (n > 0n) { unshift(n & 0xff);
  n >>= 8 }` loop), **no high-bit pad**. This naturally yields `[]` for `0` (the loop never
  runs) — matching sigma's `asUnsignedByteArray(0) = []`.
- `decodeUnsignedBigIntBE(bytes: Uint8Array): bigint` — fold bytes as unsigned magnitude BE
  (`[]` → `0n`).

## 4. The version gate — design decision (option B: permissive parse + pre-eval pass)

The JVM gates type code 9 at **type deserialization** (`getEmbeddableType` →
`embeddableV5` has no index 9 ⇒ a v5 tree rejects code 9). ergots cannot gate there cheaply:
`parseSType` takes no version, and `treeVersion` is **not threaded through the expr
recursion** — `parseExpr` defaults `treeVersion = 0` (`parse.ts:137/168`) and every mir
handler calls the recursion **without** it (`parse.ts:187, 201, …`), so only a top-level
`Constant` ever sees the real version.

**Decision — option B:** keep the parser permissive (accept code 9 → `SUnsignedBigInt`
always) and enforce the gate in a **pre-eval whole-tree type-validation pass**, wired into
`dispatchTreeBody` beside `validateBinOpTypes`. This is the exact pattern ergots already uses
for the v6 BinOp `SameType` strictness (`eval/validate-bin-op-types.ts`): parser stays
permissive (byte-roundtrip is load-bearing), consensus rejection happens before any eval or
cost charge.

**Rejected — option A** (thread `treeVersion` through `parseSType` to gate exactly where the
JVM does): would require first threading version through `parseExpr` + ~60 mir handlers + the
`parseSType` call sites — a disproportionate cross-cutting refactor that folds a large
pre-existing threading-gap fix into P2a. Both options reject the **same** trees (JVM at parse,
ergots pre-eval); the consensus contract is about *which trees*, not *when* — so A buys no
faithfulness, only risk. Worse, **A is not even correct as-is**: because `treeVersion` is not
threaded through the parse recursion (`parseExpr` passes it only to top-level constants;
recursive mir-handler calls default it to 0), a parse-time gate sees version 0 for any *nested*
type and cannot tell v5 from v6 — it would false-reject v6 nested UBI/SFunc or over-accept the
v5 case. Making A correct *requires* the full threading fix first; B gates at the authoritative
`ctx.treeVersion` and is correct without it (§4.2).

### 4.1 The pass: `eval/validate-v6-types.ts` → `validateV6Types(tree, treeVersion)`

Two surfaces must be walked — the body **and** the segregated constant block:

1. **`tree.constantTypes[]`** — every segregated constant's declared `SType`, deep-checked for a
   forbidden construct. **Mandatory** (review Finding 1): a v6-only-typed segregated constant
   that no `ConstPlaceholder` references (a *dead* constant), or only a never-evaluated branch
   references, never appears as a body annotation, yet the JVM deserializes **all** segregated
   constants eagerly (constants block before the body) and rejects code 9/112 there. The empty
   `Coll[UBI]` segregated constant is the proof case: no UBI *value* is decoded (no elements), so
   only its *type* reveals the v6 construct — a value-level check cannot catch it. `childrenOf`
   walks only `Expr` children and never reaches `tree.constantTypes`, so this is a distinct walk.
2. **The body** — walk the Expr tree via `childrenOf` (from `_substitute-deserialize.ts`); for
   each node inspect its **wire-serialized type annotations** for a forbidden construct. Run on
   both the substituted (`rewrittenBody`) and raw (`tree.body`) bodies, like `validateBinOpTypes`,
   so substituted-in `Deserialize*` sub-trees and CP→Const inlinings are covered.

Reject (under `treeVersion < 3`) if any walked `SType` **is or contains** `SUnsignedBigInt`
**or** `SFunc` (deep-walking `SColl.elem`, `SOption.elem`, `STuple.items`, `SFunc.args`/`result`).

**Not a parse-time value-codec gate (rejecting review Finding 1b).** The review suggested also
gating UBI *values* in the `parseSValue`/`serializeSValue` arms, mirroring the existing `SHeader`
precedent. We do **not**: the version-threading gap (§4) means a *nested inline* UBI constant
parses with `treeVersion = 0`, so a parse-time gate would **false-reject a valid v6 tree** with a
nested inline UBI value — a fork the wrong way (the `SHeader` arm carries this same latent flaw,
harmless only because nested `SHeader` literals don't occur). The eval-time pass over
`[constantTypes[] + body]` keyed on the **authoritative `ctx.treeVersion`** is both complete and
immune to the gap. The UBI `parseSValue`/`serializeSValue` arms therefore stay **permissive**
(decode/encode the value; no version check) — the gate is the pass.

**Critical faithfulness rule — inspect serialized annotations, NOT computed `exprTpe`.**
A v5 lambda's *computed* type is `SFunc` (`exprTpe` of a `FuncValue` synthesizes one,
`expr-tpe.ts:57-64`), but no `SFunc` **type code** is serialized for a first-order v5 lambda.
Checking computed types would false-reject every valid v5 tree with a `map`/`fold` callback —
the wrong-direction fork. The pass therefore reads only the `.tpe` / `elemTpe` / `args[].tpe`
/ `explicitTypeArgs` fields that came from `parseSType` on the wire. The annotation-carrying
nodes (a small, enumerable set): `Const.tpe`, `ConstPlaceholder.tpe`, `ValUse.tpe`,
`Collection.elemTpe`, `Upcast.tpe`, `Downcast.tpe`, `GetVar.tpe`, `ExtractRegisterAs.tpe`,
`DeserializeContext.tpe`, `DeserializeRegister.tpe`, `FuncValue.args[].tpe`,
`MethodCall.explicitTypeArgs`. (Honest v5 lambda arg types are first-order, never `SFunc`, so
`FuncValue.args[].tpe` is safe to check.)

Completeness of the enumerator is the pass's main risk; mitigate by (a) enumerating per Expr
tag exhaustively, tsc-guided, and (b) adversarial tests placing the forbidden type in each
annotation position.

Error: a new `EvalError` code `'v6-type-in-pre-v3-tree'`, message naming the construct +
position. (Rejection point/error differs from a permissive-parse value-decode failure on a
malformed v5 tree, but the **accept/reject outcome matches** the JVM — which is the contract.)

### 4.2 Conformance (verified by source-read)

Option B is acceptable only if it is fully conformant at the consensus boundary — no input
where ergots and the JVM disagree on accept/reject. Verified:

- **Consensus = eval.** A spend always parses *and evaluates* the proposition, so
  `dispatchTreeBody` runs `validateV6Types` on every tree before any cost/eval — on `tree.body`
  and the post-substitution `rewrittenBody` **and `tree.constantTypes[]`** (§4.1,
  `evaluate.ts:121-131`), using the authoritative `ctx.treeVersion`. A v5 tree with code 9/112
  is rejected pre-eval, zero cost, exactly as the JVM rejects it at deserialize. Eval never runs
  on a rejected tree → no divergent result.
- **Deserialized sub-trees (attacker-controlled bytes) — the sharp case.**
  `DeserializeContext`/`Register` build a sub-tree from context/register bytes at eval.
  `substituteDeserialize` **eagerly** parses those into `rewrittenBody` *before* the pass
  (`_substitute-deserialize.ts:195`, version `ctx.treeVersion ?? tree.header.version` at `:200`),
  and the pass walks `rewrittenBody`. So code 9/112 inside a deserialized sub-tree is caught
  with the authoritative version. Confirmed, not assumed.
- **The sole residual — parse-without-eval.** `parseTree(v5 bytes with code 9/112)` *succeeds*
  in ergots where the JVM throws at deserialize. Consensus-irrelevant (consensus evaluates →
  the pass fires → reject) and adversarially unreachable as a consensus break. It is the **same
  kind** of residual the already-shipped #2 (`validateBinOpTypes`) carries — though P2a's pass
  covers a surface #2 never had to: v6 *types* also live in the segregated-constant block
  (`tree.constantTypes`), where BinOp operands never did (review Finding 1). So "same as #2"
  holds for the *parse-residual shape*, not the *walk coverage*.
- **Why not A (beyond invasiveness):** `treeVersion` is not threaded through the parse
  recursion, so a parse-time gate mis-gates nested types (sees version 0); A is not correct
  without the full threading fix. B gates at `ctx.treeVersion` post-parse → correct as-is.
- **Out-of-scope carve-out (not a P2a divergence; review Finding 6):** a tree-version-3 tree
  evaluated in a pre-activation context (block-activation < 3) is JVM-rejected at
  `VersionContext`'s `require(ergoTreeVersion <= activatedVersion)`, independent of type codes.
  ergots does not model block-activation height (node-consensus territory, consistent with P1
  and the umbrella scope) and trusts the caller's `treeVersion`. So "conformant for every input"
  means *given a correct `treeVersion`*; the activation guard is the deliberately-out-of-scope
  node layer.

The one residual condition for full conformance is **enumerator completeness** (§4.1): the pass
must inspect every serialized type-annotation position. That is an engineering obligation —
exhaustive per-tag enumeration (tsc-guided) + one adversarial test per position — not an
inherent gap.

## 5. Finding — SFunc-112 v5 over-accept (recorded; dedicated task)

ergots' `parse-stype.ts` accepts type code **112** (`SFunc`) **unconditionally** (no version
gate), whereas the JVM gates it on `isV3OrLaterErgoTreeVersion` (`TypeSerializer.scala:211`;
a v5 tree falls to `case _ ⇒ CheckTypeCode ⇒ reject`). So a v5 tree carrying type code 112 is
an ergots **over-accept** = latent fork. Adversarial-only (no honest v5 compiler emits a
function-typed annotation; not mainnet-reachable pre-v6) — but per the consensus-correctness
discipline the adversarial path carries equal weight, and the user's explicit instruction is
that findings like this **must not be left behind**.

`SFunc` is the same class as `SUnsignedBigInt` — a v3+-only **type construct** leaking into
pre-v3 trees — so the *same* `validateV6Types` pass closes it (it already deep-walks for
`SFunc`). It gets its **own dedicated plan task** (subagent-friendly), with its own tests:

- v5 tree with serialized type code 112 ⇒ **rejected** (`'v6-type-in-pre-v3-tree'`).
- v6 tree (version ≥ 3) with type code 112 ⇒ **accepted** (parses, as today).
- **v5 tree with a first-order `map`/`fold` lambda ⇒ still PASSES** (no false-reject — guards
  the computed-vs-serialized `SFunc` subtlety of §4.1).
- **dead segregated `SFunc`-typed constant** under v5 ⇒ rejected (the same `constantTypes[]`
  walk as UBI — the pass deep-checks for `SFunc` everywhere it checks for `SUnsignedBigInt`).

## 6. New `SValue` kind

Add `{ kind: 'UnsignedBigInt'; value: bigint }` to the `SValue` union (`mir/types.ts`). Storage
reuses JS `bigint`; the **kind** (not the value) distinguishes it from `SBigInt` — required so
`serializeSValue` selects the unsigned codec, `assertKind` guards it, and (P2b) method dispatch
/ operand guards can tell them apart. Mirrors the JVM's distinct `CUnsignedBigInt` wrapper
(`isValueOfType` checks `UnsignedBigInt` separately, `SType.scala:194`).

Adding the union member makes **tsc flag every exhaustive `switch (v.kind)`** that needs a new
arm (serialize, any eval operand handling, JSON marshalling) — compiler-guided completeness.

## 7. Work list (files)

Contract-first: **facts/ is Task 1 of the implementation plan** (per project discipline),
before code.

- `facts/ergoscript-wire.md` — type code 9 + the unsigned-magnitude value codec + permissive-
  parse note.
- `facts/ergoscript-eval.md` — new `SValue` kind, the `validateV6Types` pre-eval pass, new
  `EvalError` code, the SFunc-112 finding.
- `facts/ergoscript.md` — lookup-table touch if the meta hub enumerates types/codes.
- `mir/types.ts` — `SType` += `{ tag: 'SUnsignedBigInt' }`; `SValue` += UBI kind.
- `wire/parse-stype.ts` — code 9 → `{ tag: 'SUnsignedBigInt' }` (remove the throw); doc the
  permissive stance (gate is the pass).
- `wire/serialize-stype.ts` — `SUnsignedBigInt` → 9 in `embeddablePrimitiveCode` **and** the
  main `serializeSType` switch (keeps composite compact-forms `Coll[UBI]`, `Option[UBI]`,
  pairs working).
- `wire/parse-svalue.ts` — `SUnsignedBigInt` arm: VLQ len, decode-cap 32, `decodeUnsignedBigIntBE`
  (accept len 0 → `0n`). **Permissive — no version check** (gate is the pass).
- `wire/serialize-svalue.ts` — `SUnsignedBigInt` arm: `assertKind`, `encodeUnsignedBigIntBE`
  (`0 → []`, fresh magnitude encoder, defensive 32-cap); the two new codec helpers. Permissive.
- `eval/validate-v6-types.ts` (new) — the pass: walks `tree.constantTypes[]` **and** the body
  (per-tag annotation enumerator) + deep-SType forbidden-construct walk (UBI + SFunc), keyed on
  `ctx.treeVersion`.
- `eval/evaluate.ts` — wire `validateV6Types(tree, treeVersion)` into `dispatchTreeBody` (covers
  `constantTypes[]`, `rewrittenBody`, and raw `body`).
- `eval/eval-context.ts` — register `'v6-type-in-pre-v3-tree'` `EvalError` code.
- `eval.ts` / `expr-tpe.ts` — expected **no** per-kind change (Const flows generically,
  confirmed); add arms only where tsc exhaustiveness demands.

## 8. Test strategy (TDD; oracle = hand-derived JVM-confirmed bytes)

No Rust fixture-gen for v6. Vectors are hand-constructed from the §2/§3 confirmed JVM codec
(and, where available, `LanguageSpecificationV6.scala` `tree_bytes_hex` for UBI constants).
Each its own RED→GREEN (Iron Law).

- **Codec round-trip** (v6 tree, version 3): small value; **`0` → `[]` (wire `00`)**;
  `128` → `[0x80]`; multi-byte high-bit (`2^255` → `0x80`+31×`0x00`); `2^256−1` → 32×`0xFF`;
  `> 32`-byte decode reject; **length-0 decode → `0`**; **non-canonical `[0x00,0x05]` decodes to
  `5`** (re-encodes `[0x05]` — do NOT assert byte-identity on this vector).
- **Codec distinctness:** a high-bit-set value's UBI bytes ≠ the `SBigInt` bytes for the same
  numeric value (`128` → `[0x80]` vs `[0x00,0x80]`); and `0` → `[]` vs SBigInt `[0x00]`.
- **Constant end-to-end:** parse → `exprTpe` = `SUnsignedBigInt` → eval returns
  `{kind:'UnsignedBigInt'}` → serialize byte-identical.
- **Composite forms:** `Coll[SUnsignedBigInt]`, `Option[SUnsignedBigInt]`, `(Int, UBI)` type
  encodings round-trip (compact-form codes).
- **Version gate:** v6 tree with a UBI constant ⇒ accepted; v5 tree (version < 3) with a UBI
  constant ⇒ rejected pre-eval, **zero JIT cost**; UBI nested in `Coll`/`Option`/tuple/
  `explicitTypeArgs`/`FuncValue` arg under v5 ⇒ rejected (enumerator completeness).
- **Segregated-constant gate (review Finding 1):** under v5 — a **dead** segregated UBI scalar
  constant (no placeholder references it) ⇒ rejected; an **empty `Coll[UBI]`** segregated
  constant ⇒ rejected (proves the `constantTypes[]` walk is mandatory — no value decoded); a UBI
  segregated constant referenced only in a dead `If` branch ⇒ rejected.
- **SFunc gate (dedicated task):** v5 code-112 ⇒ rejected; v6 code-112 ⇒ accepted; **v5 tree
  with a first-order lambda ⇒ passes** (no false-reject).

## 9. Risks

- **Codec byte-exactness** (length-0, magnitude vs two's-complement, 0→`[0x00]`) — consensus-
  critical; pinned by vectors against the confirmed JVM behavior. Confidence high (source read
  directly), but this is the crypto-adjacent care item.
- **Enumerator completeness** — a missed annotation position = silent over-accept. Mitigation:
  exhaustive per-tag enumeration (tsc-guided) + per-position adversarial tests.
- **Computed-vs-serialized `SFunc`** (§4.1) — the false-reject trap; guarded by the explicit
  "v5 lambda still passes" test.
- **Pass coverage** — `validateV6Types` runs only on the eval path (`dispatchTreeBody`), same
  as `validateBinOpTypes`; a parse-without-eval consumer wouldn't get it. Consistent with the
  existing precedent; acceptable.

## 10. Confidence

High on the type/codec/gate facts (all source-confirmed by direct read). The two care-items
are codec byte-exactness and enumerator completeness — both pinned by TDD vectors. No part of
P2a is below the 95% crypto/consensus bar; the modular-arithmetic crypto path is entirely P2c.

## 11. Living-umbrella callback

On completion, update the umbrella P2 ledger entry: P2a status → DONE, note the option-B gate
decision, the new `SValue` kind + `validateV6Types` pass, and the SFunc-112 finding closure.
