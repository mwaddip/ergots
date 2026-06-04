# ErgoScript v6 — P5b-2: `Global.encodeNbits` (106:6) + `Global.decodeNbits` (106:7)

**Date:** 2026-06-04 · **Branch:** `ergoscript-v6` · **Status:** design (approved, pre-plan)
**Umbrella:** `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` (P5 — Global functions)
**Predecessor:** P5b-1 (`fromBigEndianBytes`) — `docs/specs/2026-06-04-ergoscript-v6-p5b1-from-bigendian-bytes-design.md`

## 1. Context and the P5b split

The umbrella scoped **P5b** as three "numeric/compact decoders." Source-reading the canonical JVM
showed `fromBigEndianBytes` is a separate, mechanical unit (shipped as **P5b-1**). This spec is the
second batch:

- **P5b-2 (this spec):** `encodeNbits` (106:6) + `decodeNbits` (106:7) — the Bitcoin-compact ("nBits")
  pair. `decodeNbits` *reuses* the already-tested `@ergots/scorex` `decodeCompactBits`; `encodeNbits`
  is the one genuinely-new piece, carrying the CLAUDE.md "Bitcoin-compact sign-bit handling"
  crypto-confidence escalation.

`powHit` (106:8) remains **P5c** (Autolykos-v2 hit; crypto carve-out).

This pair is carved from `fromBigEndianBytes` per the focused-specs preference and the P2d-1/P2d-2
precedent (mechanical methods split from the crypto-confidence piece).

## 2. The functions (canonical source)

JVM `data/.../sigma/ast/methods.scala`:

```
private lazy val EncodeNBitsCost = FixedCost(JitCost(25))                          // :1934
private lazy val DecodeNBitsCost = FixedCost(JitCost(50))                          // :1936
... "encodeNbits", SFunc(Array(SGlobal, SBigInt), SLong), 6, EncodeNBitsCost ...  // :1939
... "decodeNbits", SFunc(Array(SGlobal, SLong),   SBigInt), 7, DecodeNBitsCost ...// :1944
```

| method | id | signature | cost | notes |
|---|---|---|---|---|
| `encodeNbits` | 106:6 | `(SGlobal, SBigInt) → SLong` | `FixedCost(25)` | non-generic; MethodCall (0xdc) |
| `decodeNbits` | 106:7 | `(SGlobal, SLong) → SBigInt` | `FixedCost(50)` | non-generic; MethodCall (0xdc) |

- **Version gate:** both are in the `isV3OrLaterErgoTreeVersion` branch of `getMethods()`
  (`methods.scala:2002-2014`) → ergots `minVersion: 3`.
- **Eval bodies** (`data/.../sigma/data/CSigmaDslBuilder.scala:190-197`):
  ```
  encodeNbits(bi)  = NBitsUtils.encodeCompactBits(bi)
  decodeNbits(l)   = CBigInt(NBitsUtils.decodeCompactBits(l).bigInteger.toSignedBigIntValueExact)
                     //                                       ^ "Result is limited to 256 bits"
  ```
- **The algorithm:** `core/.../sigma/util/NBitsUtils.scala` (`decodeCompactBits`, `encodeCompactBits`).

## 3. Scope

**In:** the two eval handlers + cost + two `method-signatures` entries + the new `encodeCompactBits`
port (ergoscript-local) + two error codes + tests.
**Out:** `fromBigEndianBytes` (P5b-1, done), `powHit` (P5c). **No scorex changes** (decode reuses the
*existing public* `@ergots/scorex` `decodeCompactBits`, exported at `index.ts:41`). **No wire changes**
(see §4).

## 4. Wire — zero new code (verified)

Both methods are **non-generic** regular `MethodCall`s (`(SGlobal, scalar) → scalar`, no type vars), so
they ride the existing MethodCall reader/writer/dispatcher with no explicit-type-args plumbing (unlike
106:5). No `wire/mir/explicit-type-args.ts` entry, no parser/serializer/registry byte change. Wiring is
purely two `HANDLERS.set(...)` registrations in `eval/method-call.ts` (mirroring 106:5 at line 505, minus
the `explicitTypeArgs` argument).

## 5. Architecture — all ergoscript-local

1. **`mir/method-signatures.ts`** — add `key(106, 6)` and `key(106, 7)`, both **closed `tRange`** (no
   generics):
   - `106:6` → `tDom: [SGlobal, SBigInt]`, `tRange: SLong`
   - `106:7` → `tDom: [SGlobal, SLong]`, `tRange: SBigInt`

   Keeps `exprTpe` faithful (concrete return types) for downstream type checks (e.g.
   `validateBinOpTypes` SameType). Inserted beside the existing 106:3/4/5 entries.

2. **New `eval/_nbits.ts`** — the nbits helpers, ergoscript-local:
   - `encodeCompactBits(value: bigint): bigint` — the new port (§7), reusing
     `encodeBigIntBE` (`wire/serialize-svalue.ts`) for the Java `toByteArray().length`.
   - (decode needs no new helper — the handler calls scorex `decodeCompactBits` directly.)

3. **New `eval/global-encode-nbits.ts`** — handler for 106:6 (§7).

4. **New `eval/global-decode-nbits.ts`** — handler for 106:7 (§6).

5. **Register** both at 106:6 / 106:7 in `eval/method-call.ts`, `minVersion: 3`.

Both handlers mirror the P5b-1 shape: `obj.kind === 'Global'` + `args.length === 1` guards (defensive;
unreachable on well-typed V3 trees), **cost charged first** (§8), then the typed arg extraction and the
math.

## 6. Decode semantics — `decodeNbits` (106:7)

Faithful to `CSigmaDslBuilder.decodeNbits` + `NBitsUtils.decodeCompactBits`:

1. Extract the `SLong` arg → `bigint` `l`.
2. **Low-32 adapter:** `decodeCompactBits(Number(BigInt.asUintN(32, l)))`. The JVM reads only bits 0–31
   (`(compact >> 24) & 0xFF` for the exponent, bits 0–23 for the mantissa); bits 32–63 are ignored.
   sigma-rust confirms this with `nbits as u32` (`ergo-node-integration` `sglobal.rs`). Inside `decodeCompactBits` every mask
   reduces to a non-negative ≤23-bit value, so passing the low-32 bits as a JS `number` is safe.
3. **Signed-256 range-check (reject path):** the JVM's `.toSignedBigIntValueExact` throws when
   `bitLength > 255`; sigma-rust's `.try_into::<BigInt256>()` errors identically (`ergo-node-integration` `sglobal.rs`). The
   handler rejects with `global-decode-nbits-failed` when the decoded value's signed bit-length exceeds
   255. Reachable for large exponent bytes (e.g. `size ≥ 0x21` with a high mantissa). The blessed
   `0x207fffff` sits exactly on the boundary (bit-length 255 → accept).
4. Return `{ kind: 'BigInt', value }`.

### Reuse equivalence (verified, not assumed)

Our scorex `decodeCompactBits` (`nbits.ts`, the sigma-rust-shaped form) was traced byte-for-byte against
JVM `NBitsUtils.decodeCompactBits` (the MPI form) and they agree on all three regimes — `size ≤ 3`
(top-`size` mantissa bytes ≡ `mantissa >> 8·(3−size)`), `size > 3` (`mantissa << 8·(size−3)`), and the
`0x00800000` sign bit (≡ the MPI first-byte top bit). So reuse is faithful; only the low-32 adapter and
the post-decode range-check are decode-specific.

## 7. Encode semantics — `encodeNbits` (106:6)  ·  the crypto-confidence piece

Faithful port of `NBitsUtils.encodeCompactBits` (cross-checked against sigma-rust
`encode_compact_bits` on `ergo-node-integration` — same algorithm, identical on both branches; the
`size < 3` vs JVM `size <= 3` branch split is immaterial, both shift by zero at `size == 3`):

```
size   = encodeBigIntBE(value).length             // Java BigInteger.toByteArray().length
result = size <= 3 ? asIntN64(longValue << 8·(3−size))
                   : longValue(value >> 8·(size−3))   // arithmetic >>
if (result & 0x00800000) { result = asIntN64(result >> 8); size += 1 }   // sign-bit carry
result |= size << 24
if (value < 0) result |= 0x00800000
return asIntN64(result)
```

where `longValue(x) = BigInt.asIntN(64, x)` (Scala `BigInt.longValue` = low 64 bits, sign-extended; the
sigma-rust `truncate` fn, `autolykos_pow_scheme.rs:88-99`).

**Crypto subtleties (the escalation), each pinned by a test:**

- **`size` = Java `toByteArray().length`** — minimal two's-complement length *with* sign byte.
  `encodeBigIntBE` is the tested mirror: `0 → [0x00]` (len 1), a positive value whose top byte ≥ 0x80
  gets a leading `0x00` (len +1), negatives are two's-complement. Verified `encodeBigIntBE(0n).length === 1`
  (`serialize-svalue.ts:595`), so `encode(0) → 0x01000000`.
- **The `0x00800000` sign-bit carry** — the CLAUDE.md Bitcoin-compact escalation point; replicated exactly.
- **Negative inputs are reachable and quirky.** `encodeNbits` takes `SBigInt`, which can be negative;
  the JVM handles `signum == −1` explicitly, so it is **not** a clean inverse of decode for negatives.
  Worked example (hand-traced *and* matched by sigma-rust's `test_eval_encode_nbits` on
  `ergo-node-integration`): `encodeNbits(−0x12345600) = −0x1235`. Per the consensus-correctness rule (adversarial path carries
  equal weight) this must match byte-for-byte; it is pinned by the sigma-rust cross-check vector (§10).
- **No reject path.** Input is an already-valid ≤256-bit `SBigInt`, so `size ≤ 33` → the `size << 24`
  int-overflow cannot occur. The defensive guards (obj-kind/arity) use `global-encode-nbits-failed`.

All `bigint` arithmetic uses `BigInt.asIntN(64, ·)` at each Java-`long` boundary and arithmetic `>>`,
faithfully reproducing 64-bit signed semantics.

## 8. Cost and error taxonomy

- **Cost (JVM canonical):** `encodeNbits` `FixedCost(25)`, `decodeNbits` `FixedCost(50)`, each
  **charged before** the arg math (decode charges 50 even when the range-check subsequently rejects),
  matching the JVM method-dispatch order and the P5b-1 cost-before-work pin. Call-site total = MethodCall
  dispatcher cost + the FixedCost + the cost of evaluating the scalar argument.
  - **No sigma-rust divergence.** The canonical `ergo-node-integration` branch already charges
    `add_jit_cost(25)` / `add_jit_cost(50)` (commented "Scala ... FixedCost(JitCost(25/50))") and pins it
    with a regression test `nbits_methods_charge_scala_costkinds`. The **stale** vendored
    `external/sigma-rust @ integration/ergots` working tree charges `10/10` — a debug-edit artifact, NOT a
    real divergence ([[reference_sigma_rust_branch_canonical]]). v6 cross-checks must read
    `git show ergo-node-integration:…`, never the vendored working tree. JVM
    (`methods.scala:1934-1936`) is the canonical cost source: **25 / 50**.
- **Error codes — two new (one per method, per the P5a/P5b-1 convention):**
  - `global-decode-nbits-failed` — covers the signed-256 overflow reject + the defensive obj-kind/arity
    guards.
  - `global-encode-nbits-failed` — defensive obj-kind/arity guards only (no faithful failure path).
  Registry codes 77 → 79.

## 9. Edge cases and risks

- **Negative encode (the residual).** Reachable adversarially; no JVM-blessed vector exists (the JVM
  spec blesses only positive encode + a negative *decode*). Mitigation: the line-by-line port +
  the sigma-rust `−0x12345600 → −0x1235` cross-check vector, which independently matches the hand-trace.
  Confidence ≥95%.
- **Decode reject boundary.** `0x207fffff` (bit-length 255) accepts; an exponent byte large enough to
  push bit-length > 255 rejects. Pin both the boundary-accept and an over-boundary reject.
- **Low-32 truncation.** A high-bits-set `SLong` (e.g. `0xFFFFFFFF_04123456`) must decode identically to
  `0x04123456`; a negative `SLong` (e.g. `−1` → low-32 `0xFFFFFFFF` → huge) must reject. Pin both.
- **`size << 24` overflow** — precluded by the SBigInt ≤256-bit precondition (`size ≤ 33`); no guard
  needed, but a max-magnitude positive vector exercises the large-`size` path.
- **Round-trips hold for positives only.** `encode(decode(x)) == x` for the positive blessed pairs (e.g.
  `0x04123456 ↔ 0x12345600`, `0x207fffff ↔ 0x7fffff·256²⁹`); do **not** assert round-trips for negatives.

## 10. Testing strategy

Per CLAUDE.md TDD: vector → RED → GREEN → refactor, one behavior per test; node + jsdom both green;
`tsc --noEmit` clean across all four workspaces. Vectors are labelled by provenance —
**JVM-blessed = canonical**, **sigma-rust = value cross-check**.

**`encodeNbits` (output `SLong`):**

| input `SBigInt` | expected `Long` | source |
|---|---|---|
| `1146584469340160` (dec) | `117707472` | JVM `LanguageSpecificationV6:2385` |
| `0x130e0…0` | `0x180130e0` | JVM `:2386` |
| `0x7fffff0…0` (32 B) | `0x207fffff` | JVM `:2387` |
| `0x12345600` | `0x04123456` | sigma-rust (eni) `test_eval_encode_nbits` |
| `−0x12345600` | `−0x1235` | sigma-rust (eni) `test_eval_encode_nbits` (**negative residual**) |
| `0` | `0x01000000` | derived (`encodeBigIntBE(0)=[0x00]`) |

**`decodeNbits` (output `SBigInt`):**

| input `Long` | expected `BigInt` | source |
|---|---|---|
| `0x207fffff` | `0x7fffff·256²⁹` (bit-len 255, boundary) | JVM `:2405` |
| `0x04923456` | `−0x12345600` | JVM `:2406` |
| `0x04123456` | `0x12345600` | JVM `:2407` |
| `0x01003456` | `0` | JVM `:2408` |
| `0x01123456` | `0x12` | sigma-rust (eni) `test_eval_decode_nbits` |
| `0x05123456` | `0x1234560000` | sigma-rust (eni) `test_eval_decode_nbits` |

**Adversarial / edge:** decode over-boundary input → `global-decode-nbits-failed`; decode high-bits-set
`SLong` (truncation); decode negative `SLong` → reject; **pre-V3 reject** for both methods
(`treeVersion < 3`); defensive arity/obj-kind guards.

**Cost:** assert call-site totals (dispatcher + 25/50 + arg eval) against the JVM `verifyCases` totals
where extractable; explicitly pin 25 ≠ sigma-rust's 10 for encode and 50 ≠ 10 for decode.

## 11. Deliverables

- `mir/method-signatures.ts` — 106:6 + 106:7 entries (closed `tRange`).
- `eval/_nbits.ts` — `encodeCompactBits` port (+ its own unit tests).
- `eval/global-encode-nbits.ts`, `eval/global-decode-nbits.ts` — handlers.
- `eval/method-call.ts` — two `HANDLERS.set` registrations, `minVersion: 3`.
- Two new `EvalError` codes (`global-encode-nbits-failed`, `global-decode-nbits-failed`).
- Tests under `test/eval/`.
- **`facts/ergoscript-eval.md`** (facts/ is **Task 1** of the plan) — registry +2 (→ 122), the 106:6 /
  106:7 rows, the two new codes (→ 79), the V3 gate; the umbrella P5 ledger flipped P5b-2 → DONE.

## 12. References

**Canonical (JVM `~/projects/sigmastate-interpreter/`):**
- `core/.../sigma/util/NBitsUtils.scala` (`decodeCompactBits`, `encodeCompactBits`, `decodeMPI`).
- `data/.../sigma/ast/methods.scala:1934-1946` (methods + costs), `:2002-2014` (V3 gate).
- `data/.../sigma/data/CSigmaDslBuilder.scala:190-197` (eval bodies; decode range-check).
- `sc/.../sigma/LanguageSpecificationV6.scala:2373-2412` (blessed encode + decode vectors).

**Value cross-check (non-canonical) — read the CLEAN `ergo-node-integration` branch
(`git show ergo-node-integration:…`), NOT the stale vendored `integration/ergots` working tree
([[reference_sigma_rust_branch_canonical]]):**
- `ergo-chain-types/src/autolykos_pow_scheme.rs` (`decode_compact_bits`, `encode_compact_bits` —
  identical on both branches; the JVM `NBitsUtils` is the canonical algorithm).
- `ergotree-interpreter/src/eval/sglobal.rs` — `ENCODE/DECODE_NBITS_EVAL_FN` (cost `25`/`50` on the clean
  branch + regression test `nbits_methods_charge_scala_costkinds`; the vendored tree's `10/10` is a stale
  debug-edit), the decode `try_into::<BigInt256>` range-check + `nbits as u32` truncation, and
  `test_eval_encode_nbits` / `test_eval_decode_nbits` (value vectors incl. the negative encode).

**ergots scaffolding to reuse/mirror:**
- `@ergots/scorex` `decodeCompactBits` (`packages/scorex/src/nbits.ts:18`, public at `index.ts:41`).
- `wire/serialize-svalue.ts:594` (`encodeBigIntBE` = Java `toByteArray` mirror, incl. `0 → [0x00]`).
- `eval/global-from-bigendian-bytes.ts` (P5b-1 handler template — cost-first, guards, SValue construction).
- `eval/method-call.ts:505` (106:5 registration template).
