# ErgoScript v6 — P5b-1: `Global.fromBigEndianBytes` (106:5)

**Date:** 2026-06-04 · **Branch:** `ergoscript-v6` · **Status:** design (approved, pre-plan)
**Umbrella:** `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` (P5 — Global functions)
**Predecessor:** P5a (`serialize`/`deserializeTo`) — `docs/specs/2026-06-04-ergoscript-v6-p5a-serialize-deserializeto-design.md`

## 1. Context and the P5b split

The umbrella scoped **P5b** as three "numeric/compact decoders" bundled: `fromBigEndianBytes`
(106:5), `encodeNbits` (106:6), `decodeNbits` (106:7). Source-reading the canonical JVM
(`sigmastate-interpreter`) before committing showed these are **two unrelated units**:

- **`fromBigEndianBytes`** — a *generic* decoder (over the six numeric types), `FixedCost(10)`,
  the inverse of P1's `toBytes`, riding P5a's `deserializeTo` wire path. Mechanical.
- **`encodeNbits` + `decodeNbits`** — the Bitcoin-compact ("nBits") pair: non-generic,
  `FixedCost(25)`/`FixedCost(50)`, whose `decodeNbits` *reuses* the already-tested
  `@ergots/scorex` `decodeCompactBits` (Autolykos PoW-target path) and whose `encodeNbits`
  is the one genuinely-new piece carrying the CLAUDE.md "Bitcoin-compact sign-bit handling"
  crypto-confidence escalation.

Per the focused-specs preference and the **P2d-1 / P2d-2 precedent** (mechanical methods carved
from the `modInverse` crypto-confidence piece), P5b is split into small batches:

- **P5b-1 (this spec):** `fromBigEndianBytes`.
- **P5b-2 (next):** `encodeNbits` + `decodeNbits` — the nbits pair, carrying the crypto bar.

`powHit` (106:8) remains **P5c** (Autolykos-v2 hit; crypto carve-out).

## 2. The function (canonical source)

`SGlobal.fromBigEndianBytes` — JVM `data/.../sigma/ast/methods.scala`:

```
private val BigEndianBytesCostKind = FixedCost(JitCost(10))            // :1922
lazy val FromBigEndianBytesMethod = SMethod(
  this, "fromBigEndianBytes",
  SFunc(Array(SGlobal, SByteArray), tT, Array(paramT)), 5,             // :1925-1926
  BigEndianBytesCostKind, Seq(tT))                                     //   explicit type arg T
```

- **typeId/methodId:** 106:5.
- **Signature:** `(SGlobal, Coll[Byte]) → T`, `tpeParams = [T]`, `explicitTypeArgs = [T]`.
  `T` is **not** inferable from the argument (always `Coll[Byte]`) — it is carried explicitly
  on the wire and read back at eval, exactly as `deserializeTo` (106:4) does.
- **Cost:** `FixedCost(10)`.
- **Version gate:** in the `isV3OrLaterErgoTreeVersion` branch of `v6Methods`
  (`methods.scala:2008-2014`) → ergots `minVersion: 3`.
- **Predef wiring** (`SigmaPredef.scala:486-503`): builds
  `MethodCall(Global, FromBigEndianBytesMethod.withConcreteTypes(Map(tT -> resType)), args, Map(tT -> resType))`
  — i.e. a `MethodCall` (0xdc) carrying one explicit type arg.

## 3. Scope

**In:** the 106:5 eval handler + cost + the `method-signatures` entry + tests.
**Out:** `encodeNbits`/`decodeNbits` (P5b-2), `powHit` (P5c). No wire-format changes
(see §4). No new numeric SValue kinds (all six already exist through P2).

## 4. Wire — zero new code (verified, not assumed)

`packages/ergoscript/src/wire/mir/explicit-type-args.ts:57` **already registers**
`SGLOBAL 106 → { 5: ['T'] }`. So the MethodCall reader/writer already consumes/emits the one
inline `SType` for `T`, and the dispatcher already delivers it to handlers as
`explicitTypeArgs['T']` (the `deserializeTo` handler consumes it identically). The shapes are
the same `SFunc((SGlobal, Coll[Byte]) → tT, [paramT])` as 106:4. **No parser, serializer, or
registry byte changes.**

## 5. Architecture

Three touches, each mirroring the P5a `deserializeTo` analog:

1. **`mir/method-signatures.ts`** — add `key(106, 5)` as a verbatim copy of the 106:4 entry
   (`mir/method-signatures.ts:163-167`):
   ```
   tDom: [{ tag: 'SGlobal' }, { tag: 'SColl', elem: { tag: 'SByte' } }],
   tRange: { tag: 'STypeVar', name: 'T' },
   tpeParams: [{ name: 'T' }],
   ```
   This makes `resolveReturnTpe` hand back the concrete `T` (from the explicit type arg),
   keeping `exprTpe` faithful for any downstream type checks.

2. **New `eval/global-from-bigendian-bytes.ts`** — structurally mirrors
   `eval/global-deserialize-to.ts`:
   - guard `obj.kind === 'Global'` and `args.length === 1` (defensive, pre-decode);
   - extract the byte payload (`collByteToUint8Array`);
   - **charge `FixedCost(10)` first** (before validation/decode — see §7);
   - read `const T = explicitTypeArgs['T']!`;
   - dispatch on `T` and decode (§6); wrap any failure in the single error code (§7).

3. **Register** the handler at 106:5 in the SGlobal method dispatch (where 106:4 is wired),
   with `minVersion: 3`, receiving `explicitTypeArgs`.

## 6. Decode semantics (faithful to `CSigmaDslBuilder.fromBigEndianBytes`, :225-261)

| `T` | length rule | decode | result kind |
|---|---|---|---|
| `SByte` | `== 1` | `bytes[0]` | Byte |
| `SShort` | `== 2` | big-endian signed 16-bit | Short |
| `SInt` | `== 4` | big-endian signed 32-bit | Int |
| `SLong` | `== 8` | big-endian signed 64-bit | Long |
| `SBigInt` | `≤ 32` (`SBigInt.MaxSizeInBytes`) | signed two's-complement, range-checked to fit signed-256 (`toSignedBigIntValueExact`) | BigInt |
| `SUnsignedBigInt` | `≤ 32` (`SUnsignedBigInt.MaxSizeInBytes`) | unsigned big-endian magnitude (`BigIntegers.fromUnsignedByteArray`) | UnsignedBigInt |
| anything else | — | **reject** (JVM `case _ => throw IllegalArgumentException`) | — |

### Reuse approach (approved, **conditional on byte-faithful results on the happy AND adversarial paths**)

`fromBigEndianBytes` is the inverse of P1's `toBytes` (`eval/_numeric-v6.ts`). Implement it as a
thin dispatcher that **reuses existing, fixture-tested primitives** rather than six fresh
decoders:

- fixed-width big-endian signed decode for Byte/Short/Int/Long — the inverse of the P1
  `toBytes` big-endian encode;
- P1's **signed-256 range check** (the existing `bigint-result-out-of-range` boundary logic)
  for the BigInt path;
- P2a's **UBI unsigned-magnitude codec** for the UnsignedBigInt path.

**Hard requirement (user condition):** each reused primitive must reproduce the JVM result
*exactly* on both valid and adversarial inputs — these primitives were originally written for
*other* callers (wire codecs, arithmetic results), so reuse is only valid where the semantics
coincide byte-for-byte. The §9 test matrix is the enforcement: any divergence fails a test, and
that path falls back to a `fromBigEndianBytes`-local decoder. Exact primitive names are pinned
in the implementation plan.

## 7. Cost and error taxonomy

- **Cost:** `FixedCost(10)`, **charged before** length-validation and decode — even when the
  call subsequently fails (wrong length, oversized, unsupported `T`). This matches the JVM
  method-dispatch ordering (the `case _`/length throws are inside the runtime body, after the
  evaluator has added the fixed method cost) and is identical to the deserializeTo
  "cost-before-parse" pin. Call-site total = MethodCall dispatcher cost + `FixedCost(10)` + the
  cost of evaluating the byte-Coll argument.
- **Error code — one new:** `global-from-bigendian-bytes-failed`, covering all three failure
  modes (wrong exact/maximum length, BigInt/UBI oversized, unsupported non-numeric `T`). Mirrors
  deserializeTo's single `global-deserialize-failed`; the JVM lumps these as exceptions too.
- **Adversarial `T` rejected at *eval*, not deserialize.** The JVM's unsupported-type `throw`
  is in the runtime body, so an adversarial `fromBigEndianBytes[Boolean]` tree *deserializes
  fine* and *fails at eval*. Faithful behavior = reject in the handler's default branch; **no
  pre-eval whole-tree pass** (unlike `validateBinOpTypes`/`validateMethodCallArity`, which mirror
  JVM *deserialize*-time asserts — this one is a runtime check).

## 8. Edge cases and risks

- **Empty-bytes asymmetry.** UBI of `[]` → `0` (BouncyCastle `fromUnsignedByteArray([])` = ZERO,
  accept). BigInt of `[]` — Java `new BigInteger(new byte[0])` is believed to **throw**
  (`NumberFormatException`, "Zero length BigInteger") → reject. Confidence ~90%; **resolved
  during implementation** by a dedicated test, verified against JVM `BigInteger` semantics (and,
  if needed, the optional sigma-rust `ergo-node-integration` cross-check), not asserted blind.
- **Signed-256 boundary.** A 32-byte BigInt with the top bit set is a valid *negative* value
  (`toSignedBigIntValueExact` two's-complement); the range check accepts iff it fits signed-256.
  Reuse P1's existing boundary logic and pin both the largest-positive and most-negative cases.
- **Reuse correctness (see §6).** The standing risk is a reused primitive that diverges from the
  JVM on an adversarial input; mitigated by the §9 adversarial matrix.

## 9. Testing strategy

Value oracle = the six typed round-trips in `LanguageSpecificationV6.scala:2022-2237`
(`fromBigEndianBytes[T](x.toBytes) == x` for Byte/Short/Int/Long/BigInt/UnsignedBigInt). Per
CLAUDE.md TDD: fixture/vector → RED → GREEN → refactor, one behavior per test.

- **Happy path:** the six round-trips; representative + boundary values per type (0, −1, type
  min/max; BigInt signed-256 extremes; UBI 0 and 32-byte max).
- **Cost:** assert the call-site total (dispatcher + `FixedCost(10)` + arg eval); cross-check
  against the `LanguageSpecificationV6` blessed totals where extractable.
- **Adversarial:** wrong exact length (Byte≠1, Short≠2, Int≠4, Long≠8); oversized BigInt/UBI
  (>32 bytes); empty bytes per type (the §8 asymmetry); **non-numeric `T`** (e.g.
  `fromBigEndianBytes[Boolean]`) — a wire-valid tree that must reject at eval with
  `global-from-bigendian-bytes-failed`; **pre-V3 reject** (the method is unavailable for
  `treeVersion < 3`).
- **Node + jsdom** both green; `tsc --noEmit` clean across all four workspaces.

## 10. Deliverables

- `mir/method-signatures.ts` — 106:5 entry.
- `eval/global-from-bigendian-bytes.ts` — handler (+ dispatch registration, `minVersion: 3`).
- One new `EvalError` code `global-from-bigendian-bytes-failed`.
- Tests under `test/eval/`.
- `facts/ergoscript-eval.md` — registry +1 (→ 120), the 106:5 row, the new code, gate; the
  umbrella P5 ledger updated to reflect the P5b-1/P5b-2 split. (facts/ is Task 1 of the plan.)

## 11. References

**Canonical (JVM `~/projects/sigmastate-interpreter/`):**
- `data/.../sigma/ast/methods.scala:1922-1932` (method + cost), `:2008-2014` (V3 gate).
- `data/.../sigma/data/CSigmaDslBuilder.scala:225-261` (decode body, per type).
- `data/.../sigma/ast/SigmaPredef.scala:486-503` (predef → MethodCall + type-arg map).
- `sc/.../sigma/LanguageSpecificationV6.scala:2022-2237` (six typed round-trip vectors).

**ergots scaffolding to reuse/mirror:**
- `wire/mir/explicit-type-args.ts:57` (106:5 already registered — wire is ready).
- `mir/method-signatures.ts:163-167` (106:4 template).
- `eval/global-deserialize-to.ts` (handler template — eval-time `T`, cost-first, error-wrap).
- `eval/_numeric-v6.ts` (P1 `toBytes` — the inverse; signed-256 range logic).
