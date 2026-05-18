# `@mwaddip/ergots-ergoscript` — Sigma-Protocol Verifier Contract

This file documents the **sigma-protocol verifier slice** of the `@mwaddip/ergots-ergoscript` boundary contract (phases 2g-medium and 2g-combinators). It covers the public `verifySignature` entry point, the `SigmaBoolean` 6-variant discriminated union, the `VerifyError` taxonomy, and pointers to the internal helpers.

For cross-cutting guarantees see [`facts/ergoscript.md`](./ergoscript.md). For the evaluator surface (which produces `SValue.SigmaProp` values consumed by `verifySignature`) see [`facts/ergoscript-eval.md`](./ergoscript-eval.md). For the wire-format parser that produces `SigmaBoolean` from on-wire bytes see [`facts/ergoscript-wire.md`](./ergoscript-wire.md).

## Scope (per-phase changelog)

**Phase 2g-medium — sigma protocol, leaf-only verifier** (additive):

- 2 new eval arms (`CreateProveDlog` Fixed(10), `CreateProveDhTuple` Fixed(20)) — see [`facts/ergoscript-eval.md`](./ergoscript-eval.md) for these (they live in the eval slice; coverage 42 → 44 arms).
- **Structural `SigmaBoolean` type** — the opaque `{ raw: Uint8Array }` shape from phase 2a is replaced with a 6-variant discriminated union (see Types section below). All 6 variants parse + serialize via the wire codec (round-trip byte-equal). The runtime verifier (this slice) walks only the 3 leaf-style variants in 2g-medium; full conjecture walks ship in 2g-combinators. The `SValue.kind: 'SigmaProp'` container discriminator is unchanged; only the inner `.value` shape changed from opaque to structural.
- **P2PK 50-JitCost short-circuit** — mirrors sigma-rust's `trivial_reduce` at `eval.rs:138-158, 268-278`. A tree whose root body is a plain `Const(SSigmaProp, _)` or a `ConstPlaceholder` resolving to a SigmaProp short-circuits with a flat `ctx.addCost(50)` (`EVAL_SIGMA_PROP_CONSTANT`). The short-circuit fires in `tryTrivialReduce(tree, ctx)` at the entry of `evaluate()` / `evaluateWith()` — NOT inside `evalConst`. Without this short-circuit, bare P2PK trees undercharge by 10× vs sigma-rust.
- **New public function: `verifySignature(sigmaBoolean, message, signature) → boolean`** (see Public surface section).
- **New error class: `VerifyError extends Error { code: string }`** with 5-code initial taxonomy (extended to 8 in 2g-combinators).
- **New runtime dependency:** `@noble/curves@2.2.0` (secp256k1 point ops + Schnorr-style verification). Version-locked pair with `@noble/hashes@2.2.0`.

**Phase 2g-combinators — sigma combinators + full conjecture verifier** (additive):

- 3 new eval arms (`Atleast`, `SigmaAnd`, `SigmaOr`) — see [`facts/ergoscript-eval.md`](./ergoscript-eval.md) (coverage 44 → 47).
- 3 normalization helpers in `mir/sigma-boolean-normalize.ts`: `cthresholdReduce(k, items)` (direct port of `cthreshold.rs:34-84`); `candNormalized(items)` (direct port of `cand.rs:29-50`); `corNormalized(items)` (direct port of `cor.rs:29-50`).
- **GF(2^192) module** in `crypto/gf2_192.ts`: pure-TS via `bigint`. `Gf2_192Element` class (operations: add via XOR, multiply via 4-bit nibble table per `gf2_192.rs:82-153`, sqr, invert via Fermat z^(2^192 - 2), equals, isZero, isOne, fromBytes/toBytes). `Gf2_192Poly` class (Newton-form incremental interpolation matching sigma-rust's `gf2_192poly.rs:71-115`; `interpolate`, `fromCoefficientsAndConstant`, `evaluate(x: number)` via Horner; `toBytes` serializes degree-1 through degree-N coefficients only, skips constant). **Byte serialization: 24-byte LE-per-word.** **Irreducible polynomial: x^192 + x^7 + x^2 + x + 1** with `IRRED_PENTANOMIAL = 0x87n`. No new TS runtime dependencies (already on `@noble/curves@2.2.0` + `@noble/hashes@2.2.0`).
- **Verifier extension** — `verifySignature` now handles the FULL `SigmaBoolean` surface (see Public surface section for verification rules per variant).
- **Fiat-Shamir internal-node byte layout:** `INTERNAL_NODE_PREFIX(0) | conj_type(0/1/2) | [k_byte if Cthreshold] | put_i16_be(n) | children...` (per `fiat_shamir.rs:170-201`).
- **`ProofBytesReader.readBytes(n)`** — new method reading exactly n bytes; throws `'truncated-signature'` on underrun. Used by Cthreshold verifier path.
- 3 new `VerifyError` codes added (5 → 8). The code `'conjecture-not-implemented'` becomes structurally unreachable but stays declared for ABI stability.

**Coverage after 2g-combinators:** Full `SigmaBoolean` verifier surface shipped (leaf + conjecture walk).

## Public surface

```ts
verifySignature(sigmaBoolean: SigmaBoolean, message: Uint8Array, signature: Uint8Array): boolean
class VerifyError extends Error { code: string }
type SigmaBoolean = ... // see Types section
```

### `verifySignature(sigmaBoolean, message, signature)` *(phase 2g-medium; extended in 2g-combinators)*

- **Precondition:** `sigmaBoolean` is a valid `SigmaBoolean` (typically the `.value` from an `SValue.kind: 'SigmaProp'`). `message` is any `Uint8Array` (the hash/message signed by the prover). `signature` is the serialized Schnorr proof bytes as produced by sigma-rust's prover (or an equivalent conformant prover).

- **Postcondition (success — full 6-variant surface from 2g-combinators):**
  - **`TrivialProp(true)`** → returns `true` (signature is ignored, per sigma-rust `verifier.rs:97`).
  - **`TrivialProp(false)`** → returns `false` (signature is ignored).
  - **`ProveDlog`** or **`ProveDhTuple`** → returns `true` if and only if the Schnorr-style proof in `signature` is valid for `sigmaBoolean` and `message`. Returns `false` for a syntactically valid but cryptographically incorrect proof. (A proof is syntactically valid if it contains a 24-byte challenge and the correct number of 32-byte scalars for the leaf type.)
  - **`Cand`** → verifies recursively; all children inherit the parent 24-byte challenge (per `sig_serializer.rs:174-186` — no per-child challenges in proof bytes for Cand); returns `true` iff all children verify.
  - **`Cor`** → reads explicit 24-byte challenges for first (n-1) children from proof bytes; derives last child's challenge via XOR(parent, read challenges) (per `sig_serializer.rs:187-214`); returns `true` iff all children verify.
  - **`Cthreshold`** → reads `(n-k)*24` polynomial coefficient bytes (no length prefix — count derived from tree structure); reconstructs `Gf2_192Poly` with constant = parent challenge as `Gf2_192Element`; each child i (0-based array index) gets challenge = `polynomial.evaluate(i+1).toBytes()` (1-based eval point, per `sig_serializer.rs:215-245`); returns `true` iff all children verify.

- **Postcondition (failure):** Throws `VerifyError` in these cases (see VerifyError taxonomy section for full details):
  - `'empty-signature'`, `'truncated-signature'`, `'point-not-on-curve'`, `'cthreshold-polynomial-bytes-mismatch'`.
  - Other declared codes (`'conjecture-not-implemented'`, `'scalar-out-of-range'`, `'cor-derived-challenge-mismatch'`, `'cthreshold-derived-challenge-mismatch'`) are reserved but currently unreachable; see taxonomy section.

- **No tree-version gating.** The verifier does not read `treeVersion`; sigma-protocol verification is tree-version-independent.

- **Trailing bytes accepted.** Extra bytes after the last parsed scalar are silently ignored (mirrors sigma-rust's `proof_append_some_byte` proptest at `verifier.rs:229-235`).

- **Not a cost-charging operation.** `verifySignature` is a separate public function from `evaluate`; it does not interact with `EvalContext` or `jitCost`. Callers who want both evaluation cost and signature verification compose `evaluateWith` + `verifySignature` manually.

## Types

### `SigmaBoolean` (6-variant discriminated union)

```ts
type SigmaBoolean =
  | { tag: 'TrivialProp'; value: boolean }
  | { tag: 'ProveDlog'; h: Uint8Array }                // 33-byte SEC1 compressed
  | { tag: 'ProveDhTuple'; g: Uint8Array; h: Uint8Array; u: Uint8Array; v: Uint8Array }
  | { tag: 'Cand'; items: SigmaBoolean[] }
  | { tag: 'Cor'; items: SigmaBoolean[] }
  | { tag: 'Cthreshold'; k: number; items: SigmaBoolean[] }
```

`SigmaBoolean` is produced by:
1. The wire parser (`parseSigmaBoolean`) when decoding `SSigmaProp` constants — see [`facts/ergoscript-wire.md`](./ergoscript-wire.md).
2. The evaluator when `SValue.SigmaProp.value` is produced by `CreateProveDlog` / `CreateProveDhTuple` arms — see [`facts/ergoscript-eval.md`](./ergoscript-eval.md).

It is consumed by `verifySignature` (this slice) and by the eval-side `SigmaPropBytes` arm (which serializes back to bytes).

**Invariants** (held by `parseSigmaBoolean`):
- `ProveDlog.h.length === 33`
- `ProveDhTuple.{g,h,u,v}.length === 33`
- `Cand.items.length >= 1`
- `Cor.items.length >= 1`
- `Cthreshold.items.length >= 1` (mirrors sigma-rust's `BoundedVec<T, 1, 255>`)
- `Cthreshold.k in [1, items.length]`

## `VerifyError` taxonomy (8 codes total)

`VerifyError` is distinct from `EvalError`: it is thrown by `verifySignature` only, not by the recursive evaluator. The two surfaces don't interact — a caller composing `evaluateWith` + `verifySignature` may encounter both, but they carry separate `code` namespaces.

### Phase 2g-medium codes

- **`'conjecture-not-implemented'`** — **RESERVED; no longer thrown as of 2g-combinators.** Was thrown in 2g-medium when `verifySignature` encountered a `Cand`, `Cor`, or `Cthreshold` node. The full conjecture walk ships in 2g-combinators; this code stays declared in `VerifyErrorCode` for ABI stability. Callers that catch this code keep compiling and running — they will simply never see it thrown.

- **`'empty-signature'`** — `signature.length === 0`. Sigma-rust returns `Ok(false)` for an empty proof via the `[] => false` match arm in `verify_signature` (`verifier.rs:99-100`); the TS port surfaces this as a typed throw so callers can distinguish "no proof provided" from "cryptographically incorrect proof". (Acknowledged divergence from sigma-rust; Decision #5 in the design spec.)

- **`'truncated-signature'`** — the signature ran out of bytes before the tree-walk parsing completed. Cases: a 24-byte challenge was present but 32-byte scalar bytes were absent; OR Cthreshold polynomial bytes were shorter than `(n-k)*24` (no length prefix — the count is derived from the SigmaBoolean tree structure). Mirrors sigma-rust's `SigParsingError::ScalarRead*` family and `ProofBytesReader.readBytes(n)` throw for the polynomial-bytes path.

- **`'point-not-on-curve'`** — a pubkey or point-component byte-array on a `ProveDlog` or `ProveDhTuple` leaf failed secp256k1 decompression. Causes: off-curve coordinates, malformed encoding tag, or identity point where prohibited. `@noble/curves`'s `Point.fromBytes` rejects off-curve inputs by default.

- **`'scalar-out-of-range'`** — **reserved; currently not thrown.** `scalarFromBytes` reduces mod n silently, mirroring sigma-rust's `Scalar::reduce_bytes` at `wscalar.rs:60-67`. The code is declared in `VerifyErrorCode` for a future slice that chooses to surface raw-bytes-≥-group-order-n as a typed throw per Decision #6 in the design spec.

### Phase 2g-combinators codes (conjecture verifier walk)

- **`'cthreshold-polynomial-bytes-mismatch'`** — thrown on the defensive `k > n` check inside the Cthreshold verifier walk (internal guard); reserved for future strict structural-validation passes. Rarely reached in practice (`parseSigmaBoolean` already rejects `k > items.length` at parse time per `'cthreshold-k-out-of-range'` — see [`facts/ergoscript-wire.md`](./ergoscript-wire.md) `SigmaBooleanParseError` codes).

- **`'cor-derived-challenge-mismatch'`** — **reserved; not thrown in this slice.** Declared for a future pass that explicitly validates the XOR-derived last child's challenge recomputes against the Fiat-Shamir hash.

- **`'cthreshold-derived-challenge-mismatch'`** — **reserved; not thrown in this slice.** Declared for a future pass that explicitly validates polynomial-derived child challenges against the Fiat-Shamir hash at each leaf.

## Internal helpers (not part of the public contract)

The verifier composes from several internal modules. These are not part of the published API but useful for understanding the implementation:

- **`eval/sigma/verifier.ts`** — the `verifySignature` core. Tree-walks `SigmaBoolean`, dispatches to leaf or conjecture verification per variant.
- **`eval/sigma/fiat-shamir.ts`** — Fiat-Shamir challenge construction. Hashes the SigmaBoolean tree byte-encoding + message + commitment bytes to derive the root 24-byte challenge.
- **`eval/sigma/prop-bytes.ts`** — `SigmaBoolean → bytes` serialization. Factored from `fiat-shamir.ts` in phase 2g.5 so both the `SigmaPropBytes` eval arm and the verifier path can share serialization logic without a circular dependency.
- **`eval/sigma/sig-serializer.ts`** — `ProofBytesReader` with `readBytes(n)` and challenge/scalar reads. Tracks the cursor position through the proof byte sequence as the verifier walks the tree.
- **`crypto/gf2_192.ts`** — GF(2^192) module for `Cthreshold` polynomial interpolation. `Gf2_192Element` and `Gf2_192Poly` classes (see phase 2g-combinators changelog above for details).
- **`crypto/secp256k1.ts`** — `@noble/curves` adapter for `ProveDlog` / `ProveDhTuple` Schnorr verification. Exposes `decodePoint(bytes: Uint8Array) → Point`, point arithmetic, and scalar operations.

See `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` and `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md` for design rationale.

## Coverage

Full `SigmaBoolean` verifier surface shipped:
- **Leaf variants (phase 2g-medium):** `TrivialProp(true|false)`, `ProveDlog`, `ProveDhTuple`.
- **Conjecture variants (phase 2g-combinators):** `Cand` (parent challenge inherited), `Cor` (XOR-derived last challenge), `Cthreshold` (GF(2^192) polynomial Lagrange interpolation).

8 `VerifyError` codes declared (3 unreachable in current code but kept for ABI stability).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting guarantees
- [`facts/ergoscript-wire.md`](./ergoscript-wire.md) — wire format (`parseSigmaBoolean` produces `SigmaBoolean`; `SigmaBooleanParseError` taxonomy lives there)
- [`facts/ergoscript-eval.md`](./ergoscript-eval.md) — evaluator (produces `SValue.SigmaProp`; `CreateProveDlog` / `CreateProveDhTuple` / `Atleast` / `SigmaAnd` / `SigmaOr` eval arms)
- `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` — leaf-verifier design
- `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md` — conjecture-verifier design
