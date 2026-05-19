# API — `@ergots/nipopow`

Public surface for the verifier package. The wire format and verification semantics this implements come from `ergo-nipopow` (sigma-rust); see `facts/nipopow.md` in the repo root for the load-bearing interface contract.

## Entry points

| Import path | Purpose |
|---|---|
| `@ergots/nipopow` | Parse, serialize, verify, and compare NiPoPoW proofs |
| `@ergots/nipopow/envelope` | P2P wire envelope for message codes 90 / 91 |

All exports are ESM. The package targets Node ≥ 20 and evergreen browsers; no `Buffer`, `node:crypto`, or other Node built-ins.

---

## Scope and consensus caveat

`verifyProof` is a **structural + Autolykos-v2 verifier**, not a standalone consensus verifier.

What it validates:

- Proof framing (parse, size bounds, shape invariants).
- Parent linkage and interlink consistency across the prefix and prefix→suffix-head boundary.
- Strictly-increasing heights across the proof.
- For each version ≥ 2 header, the Autolykos v2 solution under that header's **self-declared** `nBits` target.

What it does NOT validate:

- That `nBits` is the consensus difficulty for the header's height under the network's difficulty-adjustment rule.
- That the header's version is valid for its height under the network's hard-fork schedule.
- Anchoring to a trusted checkpoint or known chain tip.
- Anchoring of the interlinks proof to `header.extensionRoot` (see Limitations in `facts/nipopow.md`).
- Autolykos v1 PoW for version 1 headers (those headers are accepted structurally).

An attacker who controls proof construction can present a proof whose work target is chosen freely; `verifyProof` will accept it as long as the framing, linkage, and self-declared PoW are internally consistent. **For any security-critical use, combine `verifyProof` with an external consensus verifier that knows the network's difficulty schedule, hard-fork heights, and a trusted anchor.** Full consensus header validation is a planned future phase of this project.

---

## Primary export

```ts
import {
  parseProof, serializeProof,
  verifyProof, verifyParsedProof,
  compareProofs,
  type NipopowProof, type Header, type PoPowHeader, type AutolykosSolution,
  type VerifyOptions, type VerificationResult,
  ProofParseError, ProofVerificationError,
} from '@ergots/nipopow';
```

### `parseProof(bytes)`

```ts
function parseProof(bytes: Uint8Array): NipopowProof;
```

Parse the canonical NiPoPoW wire format into a `NipopowProof` struct.

- **Precondition:** `1 ≤ bytes.length ≤ 2_000_000`.
- **Returns:** A `NipopowProof` whose serialization is byte-identical to the input.
- **Throws:** `ProofParseError` with `.code` in `'empty-proof' | 'truncated' | 'trailing-bytes' | 'vlq-overflow' | 'oversized' | 'unexpected-tag' | 'invalid-m' | 'invalid-k' | 'invalid-interlinks-empty'`. The function never silently produces a partial proof.

```ts
const proof = parseProof(proofBytes);
console.log(proof.m, proof.k, proof.prefix.length);
```

### `serializeProof(proof)`

```ts
function serializeProof(proof: NipopowProof): Uint8Array;
```

Inverse of `parseProof`. For any well-formed proof bytes `b`, `serializeProof(parseProof(b))` equals `b` byte-for-byte.

- **Precondition:** `proof` was either returned from `parseProof` or constructed satisfying the type invariants below.
- **Returns:** `Uint8Array` of length ≤ 2_000_000.

### `verifyProof(bytes, opts?)`

```ts
function verifyProof(bytes: Uint8Array, opts?: VerifyOptions): VerificationResult;
```

Structural + Autolykos-v2 verification pipeline: parse → connections → strictly-increasing heights → optional per-header PoW against each header's self-declared `nBits`. **Not a consensus verifier** — see [Scope and consensus caveat](#scope-and-consensus-caveat) above before relying on the result.

- **Default `opts.checkPoW`:** `true`.
- **Returns:** `VerificationResult` (see types below).
- **Throws:** `ProofVerificationError` with `.code` in `'parse-failed' | 'invalid-connections' | 'non-increasing-heights' | 'pow-failed' | 'v1-header-after-v2-activation' | 'invalid-interlinks-proof' | 'empty-proof'`. Parse failures wrap the underlying `ProofParseError` via `.cause`.

```ts
try {
  const result = verifyProof(proofBytes);
  console.log('verified, tip at height', result.suffixTipHeight);
} catch (e) {
  if (e instanceof ProofVerificationError && e.code === 'pow-failed') {
    // ...
  }
}
```

### `verifyParsedProof(proof, opts?)`

```ts
function verifyParsedProof(proof: NipopowProof, opts?: VerifyOptions): VerificationResult;
```

Same checks as `verifyProof`, but operates on an already-parsed `NipopowProof`. Useful when the proof is held in memory (e.g. constructed programmatically, or being re-verified after a previous parse) and re-parsing isn't desired.

- **Throws:** `ProofVerificationError` with the same codes as `verifyProof` (minus `'parse-failed'`, which doesn't apply here).

### `compareProofs(a, b)`

```ts
function compareProofs(a: Uint8Array, b: Uint8Array): boolean;
```

Pairwise "is A better than B" per KMZ17 §4.3 best-arg comparison. Used to choose a proof when multiple peers offer alternatives.

- **Returns:** `true` iff `a` is strictly better than `b`.
- **Throws:** `ProofParseError` if either argument is malformed (parse failures throw; the function does not silently return `false`).
- **Invariant:** `compareProofs(a, b)` and `compareProofs(b, a)` are never both `true`. Equivalent proofs return `false` in both directions.

---

## Envelope subpath

```ts
import {
  parseGetNipopowProof, serializeGetNipopowProof,
  parseNipopowProofEnvelope, serializeNipopowProofEnvelope,
  GET_NIPOPOW_PROOF, NIPOPOW_PROOF,
  GET_NIPOPOW_PROOF_MAX_SIZE, NIPOPOW_PROOF_MAX_SIZE,
  type GetNipopowProofRequest,
  EnvelopeParseError,
} from '@ergots/nipopow/envelope';
```

### Constants

| Name | Value | Meaning |
|---|---|---|
| `GET_NIPOPOW_PROOF` | `90` | P2P message code: peer requests a proof |
| `NIPOPOW_PROOF` | `91` | P2P message code: peer sends a proof |
| `GET_NIPOPOW_PROOF_MAX_SIZE` | `1000` | Max body bytes for a code-90 frame |
| `NIPOPOW_PROOF_MAX_SIZE` | `2_000_000` | Max body bytes for a code-91 frame |

### `parseGetNipopowProof(body)`

```ts
function parseGetNipopowProof(body: Uint8Array): GetNipopowProofRequest;
```

Parse the body of a code-90 (`GetNipopowProof`) message.

- **Precondition:** `body.length ≤ GET_NIPOPOW_PROOF_MAX_SIZE`.
- **Returns:** `{ m, k, headerId, futurePad? }` where `m > 0`, `k > 0`, `m + k ≤ 1000`, `headerId` is either `null` or a 32-byte `Uint8Array`. `futurePad` carries any trailing forward-compat bytes for byte-exact round-trip.
- **Throws:** `EnvelopeParseError` with `.code` in `'oversized' | 'invalid-mk' | 'truncated' | 'malformed'`.

### `serializeGetNipopowProof(req)`

```ts
function serializeGetNipopowProof(req: GetNipopowProofRequest): Uint8Array;
```

Inverse of `parseGetNipopowProof`. Round-trip is byte-exact including `futurePad`.

### `parseNipopowProofEnvelope(body)`

```ts
function parseNipopowProofEnvelope(body: Uint8Array): Uint8Array;
```

Strip the code-91 (`NipopowProof`) envelope and return the inner proof bytes, suitable for passing to `parseProof` or `verifyProof`.

- **Precondition:** `body.length ≤ NIPOPOW_PROOF_MAX_SIZE`.
- **Returns:** Inner proof bytes (`Uint8Array` of length `1 .. 2_000_000 - 1`).
- **Throws:** `EnvelopeParseError` with `.code` in `'oversized' | 'invalid-length' | 'truncated'`.

> **Round-trip note:** future-padding bytes are intentionally stripped on parse. Code-91 is a framing codec — its output is always passed to `parseProof`, never re-emitted verbatim. `serializeNipopowProofEnvelope` produces a normalized envelope with `pad_length = 0`. (Code-90 preserves padding; code-91 doesn't. See `facts/nipopow.md` §Round-trip invariant.)

### `serializeNipopowProofEnvelope(innerProof)`

```ts
function serializeNipopowProofEnvelope(innerProof: Uint8Array): Uint8Array;
```

Wrap inner proof bytes in a code-91 envelope. Useful when relaying a proof to a peer that expects the wire envelope.

- **Throws:** Plain `Error` (programmer error) if `innerProof.length === 0` or `≥ 2_000_000`.

---

## Types

### `NipopowProof`

```ts
interface NipopowProof {
  m: number;              // > 0; min superchain length parameter
  k: number;              // > 0; suffix length parameter
  prefix: PoPowHeader[];  // length >= 1; heights strictly increasing
  suffixHead: PoPowHeader; // height > prefix[last].height
  suffixTail: Header[];   // length == k - 1; strictly increasing from suffixHead.height + 1
}
```

### `PoPowHeader`

```ts
interface PoPowHeader {
  header: Header;
  interlinks: Uint8Array[];    // each 32 bytes (BlockId); interlinks[0] is genesis_id
  interlinksProof: BatchMerkleProof; // see note below: anchors to interlinks-only-root, NOT header.extensionRoot
}
```

> **Anchoring note (audit NIP-06).** `interlinksProof` proves the
> PoPowHeader's interlinks vector against the **interlinks-only Merkle root**
> (computed from `packInterlinks(interlinks)`), NOT against
> `header.extensionRoot`. For mainnet blocks whose extension contains only
> interlinks (no votes/params), the two roots coincide; for blocks with
> richer extensions they diverge, and verification anchors to the
> interlinks-only-root only. Full `header.extensionRoot` anchoring is a
> planned future phase. See `facts/nipopow.md` "Limitations".

`BatchMerkleProof` is structurally accessible but not currently re-exported as a named type. Most callers don't need to inspect it directly — `verifyProof` handles validation.

### `Header`

```ts
interface Header {
  version: number;              // 0..=255
  id: Uint8Array;               // 32 bytes; derived via blake2b256 (not on wire)
  parentId: Uint8Array;         // 32 bytes
  adProofsRoot: Uint8Array;     // 32 bytes
  stateRoot: Uint8Array;        // 33 bytes (ADDigest = 32-byte digest + 1-byte tree height)
  transactionRoot: Uint8Array;  // 32 bytes
  timestamp: number;            // ms since epoch
  nBits: number;                // Bitcoin-compact difficulty (u32)
  height: number;               // u32; > 0
  extensionRoot: Uint8Array;    // 32 bytes
  autolykosSolution: AutolykosSolution;
  votes: Uint8Array;            // 3 bytes
  unparsedBytes: Uint8Array;    // forward-compat field (only present if version > 1)
}
```

### `AutolykosSolution`

```ts
interface AutolykosSolution {
  minerPk: Uint8Array;             // 33 bytes (compressed secp256k1 point)
  powOnetimePk: Uint8Array | null; // v1 only: 33 bytes
  nonce: Uint8Array;               // 8 bytes
  powDistance: bigint | null;      // v1 only: big-endian unsigned int
}
```

### `VerifyOptions` / `VerificationResult`

```ts
interface VerifyOptions {
  checkPoW?: boolean;            // default: true
  v2ActivationHeight?: number;   // default: V2_ACTIVATION_HEIGHT_MAINNET (417792)
}

interface VerificationResult {
  suffixTipHeight: number;  // highest header.height in the proof
  totalHeaders: number;     // prefix.length + 1 + suffixTail.length
  continuous: false;        // always false (continuous-mode proofs not supported in v1)
  headers: Header[];        // every header in the proof, in strictly-increasing height order
}
```

When `checkPoW: true`, version-1 headers at heights at or above `v2ActivationHeight` are rejected with `'v1-header-after-v2-activation'`. Version-1 headers below the threshold are accepted structurally (Autolykos v1 PoW is not implemented in this package). When `checkPoW: false`, the threshold is not consulted (caller is responsible for PoW externally).

The default `V2_ACTIVATION_HEIGHT_MAINNET = 417792` is exported from the primary entry point; callers verifying proofs from a non-mainnet network should override `v2ActivationHeight` with that network's activation height.

### `GetNipopowProofRequest`

```ts
interface GetNipopowProofRequest {
  m: number;                  // > 0
  k: number;                  // > 0
  headerId: Uint8Array | null; // 32 bytes, or null for "current tip"
  futurePad?: Uint8Array;     // forward-compat bytes; preserved on round-trip
}
```

---

## Error classes

All three classes extend `Error` and carry a `.code: string` for programmatic dispatch.

```ts
class ProofParseError extends Error {
  readonly code: string;
}

class ProofVerificationError extends Error {
  readonly code: string;
}

class EnvelopeParseError extends Error {
  readonly code: string;
}
```

### `ProofParseError` codes

Thrown by `parseProof` (and indirectly by `verifyProof` via `.cause`).

| Code | Meaning |
|---|---|
| `'empty-proof'` | Input bytes have length 0 |
| `'oversized'` | Input bytes exceed `NIPOPOW_PROOF_MAX_SIZE`, or a size field exceeds its declared bound |
| `'truncated'` | Input bytes end before all declared fields are read |
| `'trailing-bytes'` | Input bytes are followed by content after the last declared field |
| `'vlq-overflow'` | A VLQ-encoded field exceeds its declared bit width (e.g. u32 from a 6-byte VLQ) |
| `'unexpected-tag'` | A discriminant byte doesn't match any known variant |
| `'invalid-m'` | Parsed `m === 0`. `m` is the minimum superchain-length parameter and must be `> 0`; values `<= 0` would produce a non-terminating loop in `compareProofs` (audit NIP-03). |
| `'invalid-k'` | Parsed `k === 0`. `k` is the suffix-length parameter and must be `> 0` (matches sigma-rust's `NipopowProof::new` constructor invariant; audit NIP-04). |
| `'invalid-interlinks-empty'` | A PoPowHeader parsed with `interlinks.length === 0`. Empty interlinks make `check_interlinks_proof` vacuously true (no anchoring); we reject at parse rather than relying on downstream connection checks (audit NIP-05). |

### `ProofVerificationError` codes

Thrown by `verifyProof` and `verifyParsedProof`.

| Code | Meaning |
|---|---|
| `'parse-failed'` | Parsing failed (wraps the underlying `ProofParseError` via `.cause`); thrown by `verifyProof` only |
| `'invalid-connections'` | A header pair in the prefix or at the prefix/suffix-head boundary fails parent-linkage check (interlink or parent-id match within the 11-entry lookback window) |
| `'non-increasing-heights'` | Two adjacent headers in the proof have non-strictly-increasing heights |
| `'pow-failed'` | A version ≥ 2 header's Autolykos v2 solution doesn't satisfy that header's **self-declared** `nBits` target. (The target itself is not validated against consensus chain parameters — see [Scope and consensus caveat](#scope-and-consensus-caveat).) |
| `'v1-header-after-v2-activation'` | A version 1 header appears at a height at or above `opts.v2ActivationHeight` (default mainnet 417792). Audit finding NIP-02: prevents an attacker from bypassing PoW by marking forged high-height headers as V1. Only thrown when `checkPoW: true`. |
| `'invalid-interlinks-proof'` | A PoPowHeader's interlinks Merkle proof does not verify against the interlinks-only Merkle root (see [`facts/nipopow.md`](../../facts/nipopow.md) "Limitations" — anchoring is interlinks-only-root, not `header.extensionRoot`). |
| `'empty-proof'` | Defensive; unreachable for any well-formed proof |

### `EnvelopeParseError` codes

Thrown by `parseGetNipopowProof` and `parseNipopowProofEnvelope`.

| Code | Meaning |
|---|---|
| `'oversized'` | Body exceeds its frame's max size (1000 for code 90, 2_000_000 for code 91) |
| `'invalid-mk'` | `m ≤ 0`, `k ≤ 0`, or `m + k > 1000` (code 90 only) |
| `'invalid-length'` | Declared inner proof length is 0 or ≥ 2_000_000 (code 91 only) |
| `'truncated'` | Body ends before all declared fields are read |
| `'malformed'` | A discriminant byte is invalid (e.g. `header_id_present` not 0 or 1) |

---

## Conventions

- **All byte sequences are `Uint8Array`.** Never `Buffer`. Hash digests, IDs, and proof bytes all use the same type.
- **Heights, timestamps, m, k, version are `number`.** JS `Number` is safe up to 2^53; u32 values fit comfortably.
- **`bigint` for arithmetic on `n_bits`-derived targets and `pow_distance`.** Anything that can exceed `Number.MAX_SAFE_INTEGER` uses `bigint`.
- **No async surface.** Every function is synchronous. Hashing is a tight loop; the async boundary would only add overhead.
- **No I/O, no globals.** Pure functions: same inputs always produce the same output.
- **Throws on input rejection.** Parse and verify errors throw typed exceptions with `.code` for programmatic dispatch. Programmer-error invariants (out-of-range writes, contract violations) throw plain `Error`.

## See also

- `facts/nipopow.md` (repo root) — load-bearing interface contract referenced by downstream packages
- `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` — design rationale, validation strategy, risks
- [KMZ17 paper](https://eprint.iacr.org/2017/963) — original NiPoPoW spec
- [sigma-rust `ergo-nipopow`](https://github.com/ergoplatform/sigma-rust/tree/develop/ergo-nipopow) — reference Rust implementation
