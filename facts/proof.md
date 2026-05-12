# `@mwaddip/ergots-proof` — Interface Contract

The boundary contract for the verifier package. Other packages in this monorepo (`gossip`, `light-client`) read this file to know what they may rely on. The narrative rationale lives in `docs/specs/2026-05-12-nipopow-proof-verifier-design.md`; this file is *only* the interface.

Authoritative wire-format reference: `~/projects/ergo-node-rust/facts/nipopow.md` (P2P envelope) and `~/projects/ergo-node-rust/chain/src/nipopow_proof.rs` (proof validation semantics). Where this file is silent, those are canonical.

## Scope

**Ships in this contract:**

1. Parse + serialize for `NipopowProof`, `PoPowHeader`, `Header`, `AutolykosSolution`, `BlockId`, interlinks merkle proof, and `n_bits` target unpacking.
2. Stateless verification: structural checks (heights, connections) + optional Autolykos v2 PoW.
3. Pairwise comparison (KMZ17 §4.3 "is A better than B").
4. P2P envelope codec for message codes 90 (`GetNipopowProof`) and 91 (`NipopowProof`), exposed via the `/envelope` subpath.
5. Browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`. ESM only.

**Does NOT ship:**

- Proof construction (`build_nipopow_proof` in the Rust). Requires header-chain + extension cache; out of scope.
- Multi-peer best-arg orchestration (collecting/voting on multiple proofs from multiple peers). The pairwise `compareProofs` is in; the orchestration is not.
- Continuous-mode proofs. `VerificationResult.continuous` is always `false`, mirroring `chain/src/nipopow_proof.rs:43-44`.
- Transport, storage, sync. All caller-provided.
- Signature verification on the miner public key. `AutolykosSolution.minerPk` is consumed as raw bytes only.

## Public surface

### Primary export: `@mwaddip/ergots-proof`

```ts
parseProof(bytes: Uint8Array): NipopowProof
serializeProof(proof: NipopowProof): Uint8Array
verifyProof(bytes: Uint8Array, opts?: VerifyOptions): VerificationResult
compareProofs(a: Uint8Array, b: Uint8Array): boolean
```

#### `parseProof(bytes)`

- **Precondition:** `bytes.length >= 1` and `bytes.length <= 2_000_000`. (The 2 MB cap mirrors JVM `SizeLimit`; envelope-level cap already enforced this if the caller went through the envelope codec.)
- **Postcondition (success):** Returns a `NipopowProof` whose serialization is byte-identical to the input. See `Round-trip invariant` below.
- **Postcondition (failure):** Throws `ProofParseError` with a structural reason (`empty-proof`, `truncated`, `vlq-overflow`, `oversized`, `unexpected-tag`). The function does NOT silently produce a partial proof.

#### `serializeProof(proof)`

- **Precondition:** `proof` was either returned from `parseProof` or constructed satisfying the type invariants below.
- **Postcondition:** Returns `Uint8Array` of length ≤ 2_000_000. For any `proof` returned by `parseProof(b)`, `serializeProof(parseProof(b))` equals `b` byte-for-byte.

#### `verifyProof(bytes, opts)`

`VerifyOptions = { checkPoW?: boolean }` — default `{ checkPoW: true }`.

- **Precondition:** Same as `parseProof`.
- **Postcondition (success):** Returns `VerificationResult` where:
  - `headers.length === totalHeaders`
  - `headers` heights are strictly increasing
  - `headers[headers.length - 1].height === suffixTipHeight`
  - `continuous === false`
  - If `checkPoW === true`, every `header` in `headers` has a valid Autolykos v2 solution under its `nBits` target
  - Parent-linkage connections (`has_valid_connections` in the Rust) hold across the proof
- **Postcondition (failure):** Throws `ProofVerificationError` with one of: `invalid-connections`, `non-increasing-heights`, `pow-failed`, `empty-proof`, `parse-failed` (when bytes don't parse — wraps `ProofParseError`).
- **Invariant:** Stateless. No filesystem, network, or `globalThis` access. Same inputs → same result, every call.

#### `compareProofs(a, b)`

- **Precondition:** Both `a` and `b` are valid proof byte sequences. (Parse failures throw; do NOT silently return `false`.)
- **Postcondition:** Returns `true` iff `a` is strictly better than `b` per KMZ17 §4.3 (`is_better_than` in the Rust).
- **Invariant:** `compareProofs(a, b)` and `compareProofs(b, a)` are not both `true`. Equivalent proofs return `false` in both directions.

### Subpath export: `@mwaddip/ergots-proof/envelope`

```ts
parseGetNipopowProof(body: Uint8Array): GetNipopowProofRequest
serializeGetNipopowProof(req: GetNipopowProofRequest): Uint8Array
parseNipopowProofEnvelope(body: Uint8Array): Uint8Array
serializeNipopowProofEnvelope(innerProof: Uint8Array): Uint8Array

const GET_NIPOPOW_PROOF: 90
const NIPOPOW_PROOF: 91
const GET_NIPOPOW_PROOF_MAX_SIZE: 1000
const NIPOPOW_PROOF_MAX_SIZE: 2_000_000
```

#### `parseGetNipopowProof(body)`

- **Precondition:** `body.length <= GET_NIPOPOW_PROOF_MAX_SIZE` (1000).
- **Postcondition (success):** Returns `{ m, k, headerId }` where `m > 0`, `k > 0`, `m + k <= 1000`, and `headerId` is either `null` (use tip) or a 32-byte `Uint8Array`.
- **Postcondition (failure):** Throws `EnvelopeParseError` for any: oversized body, `m <= 0`, `k <= 0`, `m + k > 1000`, truncation, malformed VLQ, or invalid `headerId` length.

#### `parseNipopowProofEnvelope(body)`

- **Precondition:** `body.length <= NIPOPOW_PROOF_MAX_SIZE` (2_000_000).
- **Postcondition (success):** Returns the inner proof bytes (a `Uint8Array`), suitable for passing to `parseProof` or `verifyProof`. Length is `> 0` and `< 2_000_000`.
- **Postcondition (failure):** Throws `EnvelopeParseError` on oversized body, zero-length proof, oversized proof length declaration, or truncation.

#### Round-trip invariant

For every well-formed input `body`:

```
serializeGetNipopowProof(parseGetNipopowProof(body)) === body  (byte-equal)
serializeNipopowProofEnvelope(parseNipopowProofEnvelope(body)) === body  (byte-equal)
```

Future-padding bytes (the `future_pad_length` field) are preserved on round-trip — the codec does not strip them silently.

## Type invariants

These hold on every `NipopowProof` returned by the public API. Callers may rely on them without re-checking.

```ts
type BlockId = Uint8Array      // length 32
type Digest32 = Uint8Array     // length 32

interface Header {
  version: number              // 0..=255
  id: BlockId                  // derived from serialization; not present on the wire
  parentId: BlockId
  adProofsRoot: Digest32
  stateRoot: Uint8Array        // length 33 (ADDigest = 32-byte digest + 1-byte tree height)
  transactionRoot: Digest32
  timestamp: number            // i.e. ms since epoch, but stored as the network's 8-byte unsigned
  nBits: number                // Bitcoin-compact difficulty target encoding (u32)
  height: number               // u32; > 0
  extensionRoot: Digest32
  autolykosSolution: AutolykosSolution
  votes: Uint8Array            // length 3
  unparsedBytes: Uint8Array    // forward-compat field; preserved on round-trip
}

interface PoPowHeader {
  header: Header
  interlinks: BlockId[]        // length >= 1; interlinks[0] is genesis_id
  interlinksProof: BatchMerkleProof
}

interface NipopowProof {
  m: number                    // build parameter, > 0
  k: number                    // build parameter, > 0
  prefix: PoPowHeader[]        // length >= 1; heights strictly increasing
  suffixHead: PoPowHeader      // suffixHead.header.height > prefix[last].header.height
  suffixTail: Header[]         // length == k - 1; heights strictly increasing from suffixHead.height + 1
}
```

- `BlockId` is always 32 bytes. The codec rejects shorter/longer inputs at parse time.
- `interlinks[0]` for *any* `PoPowHeader` in *any* valid proof is the canonical genesis id of the chain the proof is for. Verifiers do not check this themselves — proofs from one network won't link properly when compared against another, and `compareProofs` will return `false` in both directions.
- `unparsedBytes` on `Header` is reserved for forward-compatibility. The wire format may have appended fields in a future version; the codec captures them as-is to keep round-trip integrity.

## Determinism and purity

- All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output.
- No async surface. Every function is synchronous. (Rationale: the verifier hits blake2b-256 in tight loops; the async boundary would only add overhead without enabling concurrency.)
- No throwing on success paths. Throws indicate contract violations or input rejection — they're the typed failure surface.

## Browser-compat guarantees

Runtime support: Node ≥ 20, evergreen browsers with native ESM. Specifically:

- All Uint8Arrays. Never `Buffer`. (`Buffer.from(...)` does not exist in browsers.)
- `globalThis.crypto` is not used. Hashing comes from `@noble/hashes` only.
- `bigint` is used for `n_bits` target unpacking and `compareProofs` difficulty math. Browsers support `bigint` natively since 2020; no polyfill ships.
- No top-level `await`.
- Bundle is ESM-only. The package's `exports` map deliberately omits CJS entry points.

## Error taxonomy

```ts
class ProofParseError extends Error          // recoverable; bytes are malformed
class ProofVerificationError extends Error   // recoverable; proof parses but fails validation
class EnvelopeParseError extends Error       // recoverable; P2P envelope bytes malformed
```

Each error's `.message` is human-readable; each carries a `code: string` matching the postcondition reason strings above (`'truncated'`, `'pow-failed'`, etc.) for programmatic dispatch.

No other error classes are exported from this package. Internal panics (e.g. blake2b implementation bugs) bubble up as plain `Error` — those represent contract violations *inside* the package and are bugs, not input-shape issues.

## Test plan summary

(Detail in `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` § Validation strategy.)

1. **Round-trip fixtures**: every fixture parses and re-serializes byte-identically.
2. **Verification fixtures**: every layer-1 + layer-2 fixture passes `verifyProof`; the returned `VerificationResult` matches the JSON captured by `fixture-gen`.
3. **Mutation fixtures**: every single-byte flip rejected by `verifyProof`.
4. **Envelope fixtures**: P2P codes 90/91 round-trip; JVM-captured request bytes parse and re-serialize byte-identically.
5. **Cross-runtime**: vitest runs each test under both `node` and `jsdom` environments.

## Cross-references

- `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` — design rationale, validation strategy, risks
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/ergo-node-rust/facts/nipopow.md` — wire format canonical source
- `~/projects/ergo-node-rust/chain/src/nipopow_proof.rs` — verification semantics canonical source
- sigma-rust `ergo-nipopow` crate — `NipopowAlgos`, `NipopowProof`, `NipopowProofSerializer`
