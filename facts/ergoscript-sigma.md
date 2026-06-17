# `@ergots/ergoscript` — Sigma-Protocol Verifier Contract

This file documents the **sigma-protocol verifier slice** of the `@ergots/ergoscript` boundary contract. It covers the public `verifySignature` entry point, the `SigmaBoolean` 6-variant discriminated union, the `VerifyError` taxonomy, and pointers to the internal helpers.

For cross-cutting guarantees see [`facts/ergoscript.md`](./ergoscript.md). For the evaluator surface (which produces `SValue.SigmaProp` values consumed by `verifySignature`) see [`facts/ergoscript-eval.md`](./ergoscript-eval.md). For the wire-format parser that produces `SigmaBoolean` from on-wire bytes see [`facts/ergoscript-wire.md`](./ergoscript-wire.md).

## Scope

The verifier handles the full `SigmaBoolean` surface: the `TrivialProp(true|false)` constants, the `ProveDlog` and `ProveDhTuple` Schnorr-style leaves, and the `Cand` / `Cor` / `Cthreshold` conjectures. Leaf verification runs on `@noble/curves@2.2.0` (secp256k1 point ops; version-locked with `@noble/hashes@2.2.0`); the `Cthreshold` polynomial reconstruction runs on a pure-TS GF(2^192) module that adds no further runtime dependency. All 6 variants parse and serialize through the wire codec round-trip byte-equal.

`verifySignature` is the public entry point. The `SValue.SigmaProp` values it consumes are produced by the eval-side `CreateProveDlog` (Fixed(10)) / `CreateProveDhTuple` (Fixed(20)) / `Atleast` / `SigmaAnd` / `SigmaOr` arms — see [`facts/ergoscript-eval.md`](./ergoscript-eval.md).

## Public surface

```ts
verifySignature(sigmaBoolean: SigmaBoolean, message: Uint8Array, signature: Uint8Array): boolean
estimateCryptoCost(sigmaBoolean: SigmaBoolean): number   // JitCost units
class VerifyError extends Error { code: string }
type SigmaBoolean = ... // see Types section
```

### `verifySignature(sigmaBoolean, message, signature)`

- **Precondition:** `sigmaBoolean` is a valid `SigmaBoolean` (typically the `.value` from an `SValue.kind: 'SigmaProp'`). `message` is any `Uint8Array` (the hash/message signed by the prover). `signature` is the serialized Schnorr proof bytes as produced by sigma-rust's prover (or an equivalent conformant prover).

- **Postcondition (success — full 6-variant surface):**
  - **`TrivialProp(true)`** → returns `true` (signature is ignored, per sigma-rust `verifier.rs:97`).
  - **`TrivialProp(false)`** → returns `false` (signature is ignored).
  - **`ProveDlog`** or **`ProveDhTuple`** → returns `true` if and only if the Schnorr-style proof in `signature` is valid for `sigmaBoolean` and `message`. Returns `false` for a syntactically valid but cryptographically incorrect proof. (A proof is syntactically valid if it contains a 24-byte challenge plus the correct number of z scalars for the leaf type. **Scalar reads are lenient:** `ProofBytesReader.readScalarBytes` reads UP TO 32 bytes and left-pads with zeros when fewer remain — mirrors sigma-rust `read_scalar` at `sig_serializer.rs:250-255`. Prover-side leading-zero stripping is on-wire; surfaced first at mainnet h=220541 with a 55-byte P2PK signature.)
  - **`Cand`** → verifies recursively; all children inherit the parent 24-byte challenge (per `sig_serializer.rs:174-186` — no per-child challenges in proof bytes for Cand); returns `true` iff all children verify.
  - **`Cor`** → reads explicit 24-byte challenges for first (n-1) children from proof bytes; derives last child's challenge via XOR(parent, read challenges) (per `sig_serializer.rs:187-214`); returns `true` iff all children verify.
  - **`Cthreshold`** → reads `(n-k)*24` polynomial coefficient bytes (no length prefix — count derived from tree structure); reconstructs `Gf2_192Poly` with constant = parent challenge as `Gf2_192Element`; each child i (0-based array index) gets challenge = `polynomial.evaluate(i+1).toBytes()` (1-based eval point, per `sig_serializer.rs:215-245`); returns `true` iff all children verify.

- **Postcondition (failure):** Throws `VerifyError` in these cases (see VerifyError taxonomy section for full details):
  - Thrown by the current verifier: `'empty-signature'`, `'truncated-signature'`, `'point-not-on-curve'`, `'cthreshold-polynomial-bytes-mismatch'`, `'invalid-sigma-tree'`.
  - Other declared codes (`'conjecture-not-implemented'`, `'scalar-out-of-range'`, `'cor-derived-challenge-mismatch'`, `'cthreshold-derived-challenge-mismatch'`) are reserved but currently unreachable; see taxonomy section.

- **No tree-version gating.** The verifier does not read `treeVersion`; sigma-protocol verification is tree-version-independent.

- **Trailing bytes accepted.** Extra bytes after the last parsed scalar are silently ignored (mirrors sigma-rust's `proof_append_some_byte` proptest at `verifier.rs:229-235`).

- **Not a cost-charging operation.** `verifySignature` is a separate public function from `evaluate`; it does not interact with `EvalContext` or `jitCost`. Callers who want both evaluation cost and signature verification compose `evaluateWith` + `verifySignature` manually.

### `estimateCryptoCost(sigmaBoolean)`

```ts
estimateCryptoCost(sigmaBoolean: SigmaBoolean): number   // JitCost units
```

Estimates the ahead-of-time sigma-protocol *verification* cost of a reduced `SigmaBoolean`, in **JitCost units** (the tx cost model scales to block cost via `floor(·/10)`). Pure structural walk; no crypto is performed. The cost-companion of `verifySignature` (it costs what `verifySignature` will verify).

Constants are taken from the JVM `Interpreter.estimateCryptoVerifyCost` (`sigmastate-interpreter Interpreter.scala:554-591`, canonical for v6):

| variant | cost (JIT) |
|---|---|
| `TrivialProp` | 0 |
| `ProveDlog` | 3980 (`ParseChallenge` 10 + `ComputeCommitments_Schnorr` 3400 + `ToBytes_Schnorr` 570) |
| `ProveDhTuple` | 7140 (10 + `ComputeCommitments_DHT` 6450 + `ToBytes_DHT` 680) |
| `Cand` / `Cor` | `15 + Σ children` (`ToBytes_ProofTreeConjecture` 15) |
| `Cthreshold(n, k)` | `(10 + 10·nCoefs) + (3 + 3·nCoefs)·n + 15 + Σ children`, `nCoefs = n − k` |

**Divergence note:** the vendored sigma-rust `crypto_cost.rs` omits the `+15` (`ToBytes_ProofTreeConjecture`) for `Cthreshold` — its own test asserts 11978 for 2-of-3-dlog where the JVM (and ergots) give 11993. ergots follows the JVM. Consumed by `@ergots/transaction`'s `validateStateful` block-cost model.

## SigmaProp-constant trivial-reduce (eval cost)

A tree whose root body is a plain `Const(SSigmaProp, _)` or a `ConstPlaceholder` resolving to a SigmaProp short-circuits with a flat `ctx.addCost(50)` (`EVAL_SIGMA_PROP_CONSTANT`), mirroring sigma-rust's `trivial_reduce` at `eval.rs:138-158, 268-278`. The short-circuit fires in `tryTrivialReduce(tree, ctx)` at the entry of `evaluate()` / `evaluateWith()` — NOT inside `evalConst`. Without it, bare P2PK trees undercharge by 10× vs sigma-rust. (This is an eval-time cost behavior; `verifySignature` itself charges no cost — see the note above.)

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
- **GE canonical-bytes:** `ProveDlog.h` and `ProveDhTuple.{g,h,u,v}` are canonical SEC1 — exactly 33 zero bytes (identity) or a curve-validated `0x02`/`0x03`-lead compressed point. 0x00-lead wire payloads NORMALIZE to the canonical identity; invalid non-0x00-lead payloads throw `SigmaBooleanParseError('ec-point-invalid')`. Mirrors the JVM, which parses these leaves through `GroupElementSerializer.parse` (`SigmaBoolean.scala:36-44,71-80`). Eval-side producers already conform (`CreateProveDlog`/`CreateProveDhTuple` consume canonical `SValue.GroupElement` values — see the GE canonical-bytes invariant in [`facts/ergoscript-eval.md`](./ergoscript-eval.md)). The verifier and `SigmaPropBytes` may rely on canonicality; the identity-aware `ecPointEqual` stays as defense-in-depth.
- `Cand.items.length >= 1`
- `Cor.items.length >= 1`
- `Cthreshold.items.length >= 1` (mirrors sigma-rust's `BoundedVec<T, 1, 255>`)
- `Cthreshold.k in [1, items.length]`

## `VerifyError` taxonomy (9 codes)

`VerifyError` is distinct from `EvalError`: it is thrown by `verifySignature` only, not by the recursive evaluator. The two surfaces don't interact — a caller composing `evaluateWith` + `verifySignature` may encounter both, but they carry separate `code` namespaces. Of the 9 declared codes, 5 are thrown by the current verifier and 4 are reserved — declared in `VerifyErrorCode` for ABI stability and future strict-check passes, never thrown today.

### Leaf and signature-read codes

- **`'empty-signature'`** — `signature.length === 0`. Sigma-rust returns `Ok(false)` for an empty proof via the `[] => false` match arm in `verify_signature` (`verifier.rs:99-100`); the TS port surfaces this as a typed throw so callers can distinguish "no proof provided" from "cryptographically incorrect proof". (Acknowledged divergence from sigma-rust; Decision #5 in the design spec.)

- **`'truncated-signature'`** — the signature ran out of bytes during a STRICT read in the tree-walk. Cases: a 24-byte challenge could not be read in full (`ProofBytesReader.readChallenge` underrun); OR Cthreshold polynomial bytes were shorter than `(n-k)*24` (no length prefix — the count is derived from the SigmaBoolean tree structure; `ProofBytesReader.readBytes(n)` underrun). Mirrors sigma-rust's `SigParsingError::ChallengeRead` and `SigParsingError::CthresholdCoeffRead`. **Scalar reads are lenient** (left-pad with zeros up to 32) and never throw this code — they instead return a near-zero scalar that fails downstream Fiat-Shamir comparison, surfacing as `returns false`.

- **`'point-not-on-curve'`** — a pubkey or point-component byte-array on a `ProveDlog` or `ProveDhTuple` leaf failed secp256k1 decompression. Causes: off-curve coordinates, malformed encoding tag, or identity point where prohibited. `@noble/curves`'s `Point.fromBytes` rejects off-curve inputs by default.

- **`'scalar-out-of-range'`** — **reserved; currently not thrown.** `scalarFromBytes` reduces mod n silently, mirroring sigma-rust's `Scalar::reduce_bytes` at `wscalar.rs:60-67`. The code is declared in `VerifyErrorCode` for a future slice that chooses to surface raw-bytes-≥-group-order-n as a typed throw per Decision #6 in the design spec.

### Conjecture-walk codes

- **`'conjecture-not-implemented'`** — **RESERVED; never thrown.** Was thrown when `verifySignature` encountered a `Cand`, `Cor`, or `Cthreshold` node before the conjecture walk existed. The verifier now handles the full conjecture surface; this code stays declared in `VerifyErrorCode` for ABI stability. Callers that catch this code keep compiling and running — they will simply never see it thrown.

- **`'cthreshold-polynomial-bytes-mismatch'`** — thrown on the defensive `k > n` check inside the Cthreshold verifier walk (internal guard); reserved for future strict structural-validation passes. Rarely reached in practice (`parseSigmaBoolean` already rejects `k > items.length` at parse time per `'cthreshold-k-out-of-range'` — see [`facts/ergoscript-wire.md`](./ergoscript-wire.md) `SigmaBooleanParseError` codes).

- **`'cor-derived-challenge-mismatch'`** — **reserved; not thrown.** Declared for a future pass that explicitly validates the XOR-derived last child's challenge recomputes against the Fiat-Shamir hash.

- **`'cthreshold-derived-challenge-mismatch'`** — **reserved; not thrown.** Declared for a future pass that explicitly validates polynomial-derived child challenges against the Fiat-Shamir hash at each leaf.

### Structural-validation code

- **`'invalid-sigma-tree'`** — thrown when `verifySignature` is invoked on a hand-constructed `SigmaBoolean` whose structure violates wire-format invariants the parser enforces. Specifically: `Cand` / `Cor` / `Cthreshold` with empty `items`, or `Cthreshold` with `k < 1`. The wire parser produces `SigmaBooleanParseError` ('sigma-conjecture-empty-items' or 'cthreshold-k-out-of-range') for these shapes; this code is the parallel surface for callers who construct `SigmaBoolean` programmatically and skip parse. The three structural checks are unified under this one code; the `Cor` zero-children branch previously threw `'truncated-signature'`, a misnomer.

## Internal helpers (not part of the public contract)

The verifier composes from several internal modules. These are not part of the published API but useful for understanding the implementation:

- **`sigma/verifier.ts`** — the `verifySignature` core. Tree-walks `SigmaBoolean`, dispatches to leaf or conjecture verification per variant.
- **`sigma/fiat-shamir.ts`** — Fiat-Shamir challenge construction. Hashes the SigmaBoolean tree byte-encoding + message + commitment bytes to derive the root 24-byte challenge. Internal-node byte layout: `INTERNAL_NODE_PREFIX(0) | conj_type(0/1/2) | [k_byte if Cthreshold] | put_i16_be(n) | children...` (per `fiat_shamir.rs:170-201`).
- **`sigma/prop-bytes.ts`** — `SigmaBoolean → bytes` serialization. Factored from `fiat-shamir.ts` so both the `SigmaPropBytes` eval arm and the verifier path can share serialization logic without a circular dependency.
- **`sigma/sig-serializer.ts`** — `ProofBytesReader` with `readBytes(n)` (reads exactly n bytes; throws `'truncated-signature'` on underrun; used by the Cthreshold verifier path) and challenge/scalar reads. Tracks the cursor position through the proof byte sequence as the verifier walks the tree.
- **`mir/sigma-boolean-normalize.ts`** — conjecture normalization helpers: `cthresholdReduce(k, items)` (direct port of `cthreshold.rs:34-84`), `candNormalized(items)` (direct port of `cand.rs:29-50`), `corNormalized(items)` (direct port of `cor.rs:29-50`).
- **`crypto/gf2_192.ts`** — GF(2^192) module for `Cthreshold` polynomial interpolation, pure-TS via `bigint`. `Gf2_192Element` class (add via XOR, multiply via 4-bit nibble table per `gf2_192.rs:82-153`, sqr, invert via Fermat z^(2^192 - 2), equals, isZero, isOne, fromBytes/toBytes) and `Gf2_192Poly` class (Newton-form incremental interpolation matching sigma-rust's `gf2_192poly.rs:71-115`; `interpolate`, `fromCoefficientsAndConstant`, `evaluate(x: number)` via Horner; `toBytes` serializes degree-1 through degree-N coefficients only, skipping the constant). Byte serialization is 24-byte LE-per-word. Irreducible polynomial x^192 + x^7 + x^2 + x + 1, with `IRRED_PENTANOMIAL = 0x87n`.
- **`crypto/secp256k1.ts`** — `@noble/curves` adapter for `ProveDlog` / `ProveDhTuple` Schnorr verification. Exposes `decodePoint(bytes: Uint8Array) → Point`, point arithmetic, and scalar operations. **DecodePoint divergence note (deliberate strict-reject):** our `decodePoint` requires all 33 bytes to be zero to recognize identity; sigma-rust's `ec_point.rs:139-151` dispatches on `buf[0] != 0` alone and would silently treat malformed `[0x00, non-zero...]` inputs as identity. Production-unreachable (sigma-rust's serializer always emits identity as exactly 33 zero bytes); strict-reject chosen as a safety margin against hostile inputs. See the central docstring at `packages/ergoscript/src/crypto/secp256k1.ts:decodePoint` for full rationale. Affects 9 invocations across 4 files (verifier.ts ×5, decode-point.ts, multiply-group.ts ×2, exponentiate.ts).

See `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` and `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md` for design rationale.

## Coverage

Full `SigmaBoolean` verifier surface shipped:
- **Leaf variants:** `TrivialProp(true|false)`, `ProveDlog`, `ProveDhTuple`.
- **Conjecture variants:** `Cand` (parent challenge inherited), `Cor` (XOR-derived last challenge), `Cthreshold` (GF(2^192) polynomial Lagrange interpolation).

9 `VerifyError` codes declared (4 reserved/unreachable in current code but kept for ABI stability).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting guarantees
- [`facts/ergoscript-wire.md`](./ergoscript-wire.md) — wire format (`parseSigmaBoolean` produces `SigmaBoolean`; `SigmaBooleanParseError` taxonomy lives there)
- [`facts/ergoscript-eval.md`](./ergoscript-eval.md) — evaluator (produces `SValue.SigmaProp`; `CreateProveDlog` / `CreateProveDhTuple` / `Atleast` / `SigmaAnd` / `SigmaOr` eval arms)
- `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` — leaf-verifier design
- `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md` — conjecture-verifier design
