# `@ergots/nipopow` — Interface Contract

The boundary contract for the verifier package. Downstream consumers read this file to know what they may rely on. The narrative rationale lives in `docs/specs/2026-05-12-nipopow-proof-verifier-design.md`; this file is *only* the interface.

Authoritative wire-format reference: `~/projects/ergo-node-rust/facts/nipopow.md` (P2P envelope) and `~/projects/ergo-node-rust/chain/src/nipopow_proof.rs` (proof validation semantics). Where this file is silent, those are canonical.

## Scope

**Ships in this contract:**

1. Parse + serialize for `NipopowProof`, `PoPowHeader`, interlinks merkle proof, and `n_bits` target unpacking. `Header`, `AutolykosSolution`, `ByteReader`, `ByteWriter`, `ReaderError`, VLQ functions, `verifyAutolykosV2`, and `decodeCompactBits` are re-exported from `@ergots/scorex` — see [`facts/scorex.md`](./scorex.md) for their canonical shapes and wire formats.
2. Stateless verification: structural checks (heights, connections) + optional Autolykos v2 PoW.
3. Pairwise comparison (KMZ17 §4.3 "is A better than B"). The proof-of-work hit it computes uses `@ergots/scorex`'s `autolykosHitForMessage`.
4. P2P envelope codec for message codes 90 (`GetNipopowProof`) and 91 (`NipopowProof`), exposed via the `/envelope` subpath.
5. Browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`. ESM only.
6. Proof construction, via the `/prover` subpath: `prove` (sync, in-memory chain) and `proveWithReader` (async, demand-loaded through a caller-implemented `PopowHeaderReader`), plus the building blocks (`updateInterlinks`, `packInterlinks`, `unpackInterlinks`, `proofForInterlinkVector`, `makePopowHeader`, `maxLevelOf`, `MerkleTree`, `buildExtensionTree`). Canonical reference: the JVM Ergo node (`NipopowAlgos.scala`, `NipopowProverWithDbAlgs.scala`); sigma-rust is secondary.
7. Continuous-mode proof support, added in 0.4.0: `prove`/`proveWithReader` inject the difficulty-recalculation headers a continuous proof must carry (JVM `NipopowProverWithDbAlgs.scala:93-105`); `verifyProof`/`verifyParsedProof` check their membership (JVM `NipopowProof.scala:82-105`); `compareProofs` folds the same membership check into its validity gate (JVM `NipopowProof.scala:75`). The epoch math (`nextRecalculationHeight`, `previousHeightsRequiredForRecalculation`, `heightsForNextRecalculation`) is a clean-room port of `DifficultyAdjustment.scala:27-55`. See "Difficulty functions" below.

**Does NOT ship:**

- **Consensus header validation.** `verifyProof` validates each header's Autolykos v2 solution against that header's **self-declared** `nBits`, but does NOT validate `nBits` against consensus chain parameters (difficulty-adjustment rule, hard-fork schedule for header.version, trusted anchor / checkpoint policy). An attacker who controls proof construction can choose the work target. Consumers MUST combine `verifyProof` with an external consensus verifier for any security-critical use. Full consensus header validation is a planned future phase. See "Limitations" below.
- Multi-peer best-arg orchestration (collecting/voting on multiple proofs from multiple peers). The pairwise `compareProofs` is in; the orchestration is not.
- Transport, storage, sync. All caller-provided.
- Signature verification on the miner public key. `AutolykosSolution.minerPk` is consumed as raw bytes only.

## Public surface

### Primary export: `@ergots/nipopow`

```ts
parseProof(bytes: Uint8Array): NipopowProof
serializeProof(proof: NipopowProof): Uint8Array
verifyProof(bytes: Uint8Array, opts?: VerifyOptions): VerificationResult
verifyParsedProof(proof: NipopowProof, opts?: VerifyOptions): VerificationResult
compareProofs(a: Uint8Array, b: Uint8Array, opts?: DifficultyParams): boolean

// Difficulty / continuous-mode (0.4.0) — see "Difficulty functions" below
nextRecalculationHeight(height: number, epochLength: number): number
previousHeightsRequiredForRecalculation(height: number, epochLength: number, useLastEpochs: number): number[]
heightsForNextRecalculation(height: number, epochLength: number, useLastEpochs: number): number[]
hasValidDifficultyHeaders(proof: NipopowProof, epochLength: number, useLastEpochs: number): boolean
type DifficultyParams = { epochLength?: number; useLastEpochs?: number }
const EPOCH_LENGTH_MAINNET = 128
const USE_LAST_EPOCHS_MAINNET = 8
```

#### `parseProof(bytes)`

- **Precondition:** `bytes.length >= 1` and `bytes.length <= 2_000_000`. (The 2 MB cap mirrors JVM `SizeLimit`; envelope-level cap already enforced this if the caller went through the envelope codec.)
- **Postcondition (success):** Returns a `NipopowProof` whose serialization is byte-identical to the input. See `Round-trip invariant` below. The wire format now ends with a **required trailing `continuous` byte** (JVM dialect — NIP-12, Task 7b): `parseProof` always reads exactly one more byte after the suffix_tail entries, strictly `0x00` → `continuous: false` or `0x01` → `continuous: true`. This is a deliberate strictness delta vs the JVM reference (`NipopowProof.scala`), which maps *any* byte `!= 1` to `false` (silently accepts `2..255`, and would not round-trip such a byte on its own re-serialization); ergots instead rejects `2..255` outright with `'invalid-continuous-byte'`, preserving the byte-exact round-trip invariant for every proof this parser accepts — the same precedent as the NIP-03/NIP-04 `m=0`/`k=0` hardening.
- **Postcondition (failure):** Throws `ProofParseError` with a structural reason (`empty-proof`, `truncated`, `vlq-overflow`, `oversized`, `unexpected-tag`, `trailing-bytes`, `invalid-m`, `invalid-k`, `invalid-interlinks-empty`, `invalid-side` — a `BatchMerkleProof` node-side byte that is neither Left nor Right — `invalid-continuous-byte` — the trailing continuous byte is present but not `0x00`/`0x01`, NIP-12). The function does NOT silently produce a partial proof, rejects any trailing bytes after the encoded suffix_tail + continuous byte (including inside the bounded PoPowHeader header/proof subreaders), and enforces shape invariants `m > 0` (NIP-03), `k > 0` (NIP-04 — matches sigma-rust's `NipopowProof::new` constructor's `k >= 1` requirement), `interlinks.length > 0` per PoPowHeader (NIP-05 — empty interlinks make `check_interlinks_proof` vacuously true; sigma-rust permissively accepts but we surface as a typed parse failure), and a well-formed trailing continuous byte (NIP-12 — a missing byte surfaces as `'truncated'`, an out-of-range byte as `'invalid-continuous-byte'`).

#### `serializeProof(proof)`

- **Precondition:** `proof` was either returned from `parseProof` or constructed satisfying the type invariants below.
- **Postcondition:** Returns `Uint8Array` of length ≤ 2_000_000, always ending with the trailing `continuous` byte (`proof.continuous ? 1 : 0` — NIP-12). For any `proof` returned by `parseProof(b)`, `serializeProof(parseProof(b))` equals `b` byte-for-byte — this now holds for JVM-emitted canonical proof bytes too, not only sigma-rust-dialect ones (see "Limitations" below).

#### `verifyProof(bytes, opts)`

`VerifyOptions = { checkPoW?: boolean; epochLength?: number; useLastEpochs?: number }` — `checkPoW` defaults `true`. `epochLength`/`useLastEpochs` resolve through `resolveDifficultyParams` (see "Difficulty functions" below) to `EPOCH_LENGTH_MAINNET`/`USE_LAST_EPOCHS_MAINNET` when omitted; invalid values throw `RangeError`, resolved as `verifyParsedProof`'s first step — BEFORE the `invalid-m`/`invalid-k` shape gates and all other proof inspection (connections/heights/PoW/difficulty logic); a `RangeError` from invalid difficulty options therefore precedes even `invalid-m`/`invalid-k` for hand-built proofs (for the bytes entry point this is still after `parseProof` succeeds, since `verifyProof` parses first and only then delegates to `verifyParsedProof`).

- **Precondition:** Same as `parseProof`.
- **Postcondition (success):** Returns `VerificationResult` where:
  - `headers.length === totalHeaders`
  - `headers` heights are strictly increasing
  - `headers[headers.length - 1].height === suffixTipHeight`
  - `continuous` echoes `proof.continuous` (0.4.0 — was always `false` in 0.3.0; a `continuous === true` proof can now reach success, subject to the difficulty-headers bullet below)
  - If `checkPoW === true`, every version >= 2 `header` has a valid Autolykos v2 solution under that header's **self-declared** `nBits` target (NOT validated against the network's difficulty-adjustment rule — see "Limitations" below); version 1 headers at height < `opts.v2ActivationHeight` (default mainnet `V2_ACTIVATION_HEIGHT_MAINNET = 417792`) are accepted structurally without PoW verification (Autolykos v1 is not implemented in this package); version 1 headers at height >= the threshold are rejected with `'v1-header-after-v2-activation'` per audit finding NIP-02
  - Parent-linkage connections (`has_valid_connections` in the Rust) hold across the proof
  - Interlink Merkle proof per PoPowHeader (`check_interlinks_proof` in the Rust) holds: the proof's stored leaf hashes walk up to the Merkle root computed from `packInterlinks(interlinks)` (interlinks-only extension tree). See "Known limitations" below.
  - When `continuous === true`, every needed difficulty-recalculation height is present in the header chain — `hasValidDifficultyHeaders` holds (0.4.0; see "Difficulty functions" below). Vacuously satisfied when `continuous === false`.
- **Postcondition (failure):** Throws `ProofVerificationError` with one of: `invalid-connections`, `non-increasing-heights`, `pow-failed`, `v1-header-after-v2-activation` (NIP-02), `empty-proof`, `parse-failed` (when bytes don't parse — wraps `ProofParseError`), `invalid-interlinks-proof`, `missing-difficulty-headers` (0.4.0 — thrown after connections, interlinks, heights, and PoW all pass, when `proof.continuous === true` and some needed height in `(0, suffixHead.height)` is absent from the header chain; see `hasValidDifficultyHeaders` under "Difficulty functions" below). Non-continuous proofs (`continuous === false`) have exactly 0.3.0's accept-set — this gate is vacuous for them. Separately, an invalid `opts.epochLength`/`opts.useLastEpochs` throws `RangeError`, not `ProofVerificationError` — see the `VerifyOptions` line above.
- **Invariant:** Stateless. No filesystem, network, or `globalThis` access. Same inputs → same result, every call.

#### `verifyParsedProof(proof, opts)`

- The parsed-proof entry point that `verifyProof` delegates to after parsing. Takes an already-parsed `NipopowProof` (no wire decode); exported chiefly to unit-test the logical invariants (heights, connections, interlinks Merkle proof, difficulty headers) without round-trip serialization.
- **Postcondition (success):** Same `VerificationResult` as `verifyProof` — `continuous` echoes `proof.continuous` (0.4.0; both `true` and `false` inputs can now reach success).
- **Postcondition (failure):** Throws `ProofVerificationError` — `'invalid-m'` / `'invalid-k'` (the `m > 0` / `k > 0` shape gates, NIP-09, checked first) plus the same logical-verification codes `verifyProof` raises, in the same order: `invalid-connections`, `invalid-interlinks-proof`, `non-increasing-heights`/`pow-failed`/`v1-header-after-v2-activation` (interleaved in the per-header walk), and — new in 0.4.0, checked last, only after all of the preceding pass — `'missing-difficulty-headers'` when `proof.continuous === true` and a needed height is absent (see `hasValidDifficultyHeaders` under "Difficulty functions"). It does not parse, so it never raises `'parse-failed'`. The `epochLength`/`useLastEpochs` `RangeError` gate (see `verifyProof` above) is resolved here too, as this function's first step — BEFORE the `invalid-m`/`invalid-k` shape gates and before any connections/heights/PoW/difficulty logic runs. The `'invalid-m'` / `'invalid-k'` codes are reachable here only with a hand-built `NipopowProof`; on the wire path an out-of-range `m`/`k` is rejected earlier by `parseProof` as `ProofParseError('invalid-m'/'invalid-k')`, which `verifyProof` wraps to `'parse-failed'`. Likewise a `continuous` byte outside `{0,1}` is rejected at parse time as `'invalid-continuous-byte'` and never reaches `verifyParsedProof` on the wire path.
- **Invariant:** Stateless, same as `verifyProof`.

#### `compareProofs(a, b, opts?)`

- **Precondition:** Both `a` and `b` are valid proof byte sequences. (Parse failures throw; do NOT silently return `false`.) `opts?: { epochLength?: number; useLastEpochs?: number }` (0.4.0) resolves through the same `resolveDifficultyParams` gate as `VerifyOptions` (see "Difficulty functions" below) — invalid values throw `RangeError`, resolved before either proof is parsed (the opposite order from `verifyProof`'s bytes entry point, which parses first and resolves options second) — so a `RangeError` here can preempt what would otherwise be a `ProofParseError` on malformed `a`/`b` bytes.
- **Postcondition:** Returns `true` iff `a` is strictly better than `b` per KMZ17 §4.3 (`is_better_than` in the Rust). Internally validates each proof via `isValid` = connections ∧ heights ∧ interlinks Merkle proof per PoPowHeader ∧ difficulty-headers membership (0.4.0 addition — the JVM `NipopowProof.isValid` conjunction and its exact order, `NipopowProof.scala:75`) — still NOT PoW; that remains caller responsibility, same as sigma-rust. A continuous proof (`proof.continuous === true`) missing a needed difficulty header is simply invalid for comparison, the same boolean-domain outcome as any other invalid proof — it loses to any valid proof, and two such proofs compare `false` in both directions; no new throw. If both are invalid, returns `false`; if only `b` is invalid, returns `a.isValid()`; both valid → best-arg comparison per KMZ17.
- **Invariant:** `compareProofs(a, b, opts)` and `compareProofs(b, a, opts)` are not both `true`. Equivalent proofs return `false` in both directions. The same resolved `epochLength`/`useLastEpochs` apply symmetrically to both `a` and `b`.

#### Difficulty functions

New in 0.4.0 — epoch math and the continuous-mode difficulty-header membership check, exported from the primary `@ergots/nipopow` entry point alongside `parseProof` etc. Clean-room port of `DifficultyAdjustment.scala:27-55` (epoch math) and `NipopowProof.scala:82-105` (membership check), local checkout `~/projects/ergo-jvm-pr`. All pure; no I/O.

- `nextRecalculationHeight(height, epochLength)` — the height at which difficulty next recalculates after `height`. `height % epochLength === 0` → `height + 1`; else `(Math.floor(height / epochLength) + 1) * epochLength + 1`.
- `previousHeightsRequiredForRecalculation(height, epochLength, useLastEpochs)` — the prior epoch-boundary heights needed to compute the difficulty that applies starting at `height`, ascending. Three branches, ported including the two exotic ones the JVM itself only reaches under unusual configs:
  1. `(height-1) % epochLength === 0 && epochLength > 1` → `(height-1) - i*epochLength` for `i` in `0..useLastEpochs`, filtered `>= 0`.
  2. else `(height-1) % epochLength === 0 && height > epochLength * useLastEpochs` → same list, unfiltered (reachable only when `epochLength === 1` — that's what makes branch 1's `epochLength > 1` guard false; ported anyway, per this project's faithful-adversarial-path rule).
  3. else → `[height - 1]`.
- `heightsForNextRecalculation(height, epochLength, useLastEpochs)` = `previousHeightsRequiredForRecalculation(nextRecalculationHeight(height, epochLength), epochLength, useLastEpochs)`. For every `epochLength > 1` (both public networks) this always resolves through branch 1 above — `nextRecalculationHeight`'s result is always `≡ 1 (mod epochLength)` — producing up to `useLastEpochs + 1` ascending multiples of `epochLength`.
- `hasValidDifficultyHeaders(proof, epochLength, useLastEpochs)` — `true` vacuously when `proof.continuous === false` (JVM else-branch). Otherwise, for every height `h` in `heightsForNextRecalculation(proof.suffixHead.header.height, epochLength, useLastEpochs)` with `0 < h < suffixHead.height` (heights outside that range are ignored — the JVM's `height > 0 && height < suffixHead.height` guard), the flat header chain (`prefix` PoPowHeaders' `.header` + `suffixHead.header` + `suffixTail`) must contain a header at height `h`. **Precondition:** the chain's heights are already strictly increasing before this runs. The membership scan is an ordered, non-resetting cursor — JVM `indexWhere(_, lastIndex)`: `lastIndex` starts at 0 and only ever advances — which coincides with plain set membership only because the needle list is ascending *and* the haystack is strictly monotone. Both in-package call sites (`verifyParsedProof`, `compareProofs`'s internal `isValid`) run the heights check first, mirroring the JVM `isValid`'s left-to-right `&&` short-circuit order (`hasValidConnections && hasValidHeights && hasValidProofs && hasValidDifficultyHeaders`, `NipopowProof.scala:75`). Calling this function directly against an out-of-order chain is a caller error the function has no independent way to detect.
- `EPOCH_LENGTH_MAINNET = 128`, `USE_LAST_EPOCHS_MAINNET = 8` — the `resolveDifficultyParams` defaults (below). `128` is the JVM's *composed* value: mainnet's raw `chainSettings.epochLength` is still 1024 (pre-EIP-37), but `chainSettings.eip37EpochLength = 128` overrides it at every call site this unit touches, unconditionally — no height-gated cutover to EIP-37 behavior. Testnet carries no `eip37EpochLength` override and sets `epochLength = 128` directly, landing on the same composed value via a different path. `useLastEpochs = 8` on both networks. **Not shipped:** the arithmetic that turns these heights' headers into an actual required-difficulty value (`bitcoinCalculate` / `eip37Calculate` / `interpolate`) is not ported — `hasValidDifficultyHeaders` checks header *membership* only, matching the JVM proof-verifier itself, which never runs that arithmetic either.

`type DifficultyParams = { epochLength?: number; useLastEpochs?: number }` — **exported from `@ergots/nipopow`** (see the Public surface code block above). This names the optional-params shape `VerifyOptions`, `PoPowParams`, and `compareProofs`'s third argument all share; callers may import it directly rather than re-declaring the two fields themselves.

`resolveDifficultyParams(opts?: DifficultyParams): { epochLength: number; useLastEpochs: number }` — the shared resolver `difficulty.ts` uses internally to process a `DifficultyParams` value. **Not** re-exported from `@ergots/nipopow` — of the pair, only the `DifficultyParams` type is public; the resolver function is package-internal plumbing, documented here (with a real name and signature) purely so its behavior is pinned for the call sites that depend on it: `VerifyOptions`, `PoPowParams`, and `compareProofs`'s third argument all resolve their `epochLength`/`useLastEpochs` fields through it identically. Applies the defaults above when a field is omitted, then gates: both values must be integers (`Number.isInteger`), `epochLength >= 1`, `useLastEpochs >= 2`, `epochLength * useLastEpochs <= 2**31` (an APPROXIMATION of the JVM `DifficultyAdjustment` constructor's guard — `useLastEpochs > 1`, `epochLength > 0`, plus `epochLength < Int.MaxValue / useLastEpochs` using strict Scala integer division, not this multiply-and-compare form; boundary configs can pass one gate and fail the other). Violations throw `RangeError` — not `ProofVerificationError` / `ProofBuildError` — deliberately outside those taxonomies, because a bad `epochLength`/`useLastEpochs` is a caller-configuration defect, not a defect in a proof or in prover input.

**Coupling with `hasValidConnections`.** The prefix-connections lookback window (`connections.ts` — internal, not re-exported) is derived from the same setting: `hasValidConnections(proof, useLastEpochs = USE_LAST_EPOCHS_MAINNET)` widens its window to `useLastEpochs + 3` predecessors (JVM `NipopowProof.scala:129` `maxDiffHeaders = useLastEpochs + 1`, `:135` the range construction that widens it by 2 more — together `useLastEpochs + 3`). `verifyParsedProof` and `compareProofs`'s internal `isValid` both thread their resolved `useLastEpochs` through to it. At the shared default (8) the window is 11 predecessors — identical to 0.3.0's hardcoded lookback span, so behavior for callers who don't override `useLastEpochs` is bit-for-bit unchanged.

### Subpath export: `@ergots/nipopow/envelope`

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
- **Postcondition (failure):** Throws `EnvelopeParseError` for any: oversized body, `m <= 0`, `k <= 0`, `m + k > 1000`, truncation, malformed VLQ / structure (`'malformed'`), invalid `headerId` length, or undeclared trailing bytes after the payload (`'trailing-bytes'`, NIP-10).

#### `serializeGetNipopowProof(req)`

- **Precondition:** `req.m > 0`, `req.k > 0`, `req.m + req.k <= 1000` — the same bounds `parseGetNipopowProof` enforces. Throws `EnvelopeParseError('invalid-mk')` otherwise (NIP-11), so a caller cannot emit a code-90 message its own parser would refuse.

#### `parseNipopowProofEnvelope(body)`

- **Precondition:** `body.length <= NIPOPOW_PROOF_MAX_SIZE` (2_000_000).
- **Postcondition (success):** Returns the inner proof bytes (a `Uint8Array`), suitable for passing to `parseProof` or `verifyProof`. Length is `> 0` and `< 2_000_000`.
- **Postcondition (failure):** Throws `EnvelopeParseError` on oversized body, an out-of-range declared proof length (zero or ≥ 2 MB — `'invalid-length'`), truncation, or undeclared trailing bytes after the declared payload + future-padding (`'trailing-bytes'`, NIP-10).

#### Round-trip invariant

For code-90 (`GetNipopowProof`), the round-trip is byte-exact — including any future-padding:

```
serializeGetNipopowProof(parseGetNipopowProof(body)) === body  (byte-equal)
```

For code-91 (`NipopowProof`), the round-trip preserves the *inner proof bytes* only.
`parseNipopowProofEnvelope` strips future-padding (it is wire noise; verifiers do not need it),
so `serializeNipopowProofEnvelope(parseNipopowProofEnvelope(body))` produces a normalized
envelope (`pad_length=0`) rather than a byte-identical copy. This is intentional —
code-91 is a framing codec, and its output is always passed to `parseProof`, never
re-emitted verbatim.

### Subpath export: `@ergots/nipopow/prover`

```ts
prove(chain: PoPowHeader[], params: PoPowParams): NipopowProof
proveWithReader(reader: PopowHeaderReader, params: PoPowParams, headerId?: Uint8Array): Promise<NipopowProof>

type PoPowParams = {
  m: number
  k: number
  continuous?: boolean       // default false (0.4.0)
  epochLength?: number       // 0.4.0
  useLastEpochs?: number     // 0.4.0
}
interface PopowHeaderReader {
  headersHeight(): Promise<number>
  popowHeaderById(id: Uint8Array): Promise<PoPowHeader | null>
  popowHeaderAtHeight(height: number): Promise<PoPowHeader | null>
  lastHeaders(n: number): Promise<Header[]>
  bestHeadersAfter(header: Header, n: number): Promise<Header[]>
}

updateInterlinks(prevHeader: Header, prevInterlinks: Uint8Array[]): Uint8Array[]
packInterlinks(interlinks: Uint8Array[]): ExtensionKV[]
unpackInterlinks(fields: ExtensionKV[]): Uint8Array[]
proofForInterlinkVector(fields: ExtensionKV[]): BatchMerkleProof
makePopowHeader(header: Header, interlinks: Uint8Array[]): PoPowHeader
maxLevelOf(header: Header): number

class MerkleTree {
  constructor(leafHashes: Uint8Array[])
  readonly leafCount: number
  rootHash(): Uint8Array
  proofByIndices(indices: number[]): BatchMerkleProof | null
}
buildExtensionTree(fields: ExtensionKV[]): MerkleTree
```

`continuous` defaults to `false` (0.3.0 behavior preserved when omitted). `epochLength`/`useLastEpochs` resolve through the same gate `VerifyOptions` uses (`resolveDifficultyParams`, see "Difficulty functions" above) — and the resulting `RangeError` gate fires in **both** `prove` and `proveWithReader` *unconditionally*, regardless of `params.continuous`'s value. This mirrors the JVM: `NipopowProverWithDbAlgs.prove` constructs its `DifficultyAdjustment` — running the same `require`s `resolveDifficultyParams` ports — before its code ever branches on `params.continuous` (`NipopowProverWithDbAlgs.scala:25`, outside the function's `Try` block). `NipopowAlgos.prove` has no `DifficultyAdjustment` at all; ergots applies the unconditional gate to both TS provers anyway, for cross-prover consistency.

#### `prove(chain, params)`

- **Precondition (throws `ProofBuildError`):** `params.m` and `params.k` must
  be integers `>= 1` (`Number.isInteger` gate — non-integer or out-of-range
  values both throw `'invalid-m'`/`'invalid-k'`), `chain.length >= m + k`
  (`'chain-too-short'`), `chain[0].header.height === 1`
  (`'non-anchored-chain'`). The chain is trusted: contiguous from genesis,
  interlinks already correct; `prove` re-derives nothing.
- **Postcondition:** Returns a `NipopowProof` that (a) passes
  `verifyParsedProof` structural checks (PoW validity is a property of the
  input chain, not the prover), (b) round-trips byte-identically through
  `serializeProof`/`parseProof`, (c) when `params.continuous` is `false` or
  omitted, is byte-identical to the JVM `NipopowAlgos.prove` output on the
  same chain (KMZ17 provePrefix walk, dedupe by header id, prefix sorted
  ascending by height) — see the `continuous` note below for `true`, which
  deliberately diverges from `NipopowAlgos.prove`.
- **Invariant:** Pure, synchronous, deterministic.

  **`continuous` (0.4.0) — deliberate divergence from the reference.** The
  JVM's own in-memory prover, `NipopowAlgos.prove`, stamps `params.continuous`
  into the returned proof *without* injecting any difficulty headers
  (`NipopowAlgos.scala:158`) — its doc comment self-labels it "Paper-like
  code used in tests only, so maybe better to replace it in tests with
  prove (histReader)" (`NipopowAlgos.scala:127`). Porting that wart
  faithfully would make `prove({ ..., continuous: true })` emit proofs this
  package's own `verifyParsedProof` rejects. ergots instead makes `prove`
  inject the identical needed-heights set `proveWithReader` injects (see
  below) — looked up by height over `preSuffix` (the chain argument minus
  the suffix slice) rather than via a reader, skipped if absent, added to
  the prefix unless a same-id entry is already selected, and the prefix
  re-sorted by height afterward. Consequence: continuous `prove()` output
  is self-valid, and equals continuous `proveWithReader()` output on any
  chain where the two provers' non-continuous walks already coincide — the
  level-0-free equivalence predicate documented below for `proveWithReader`
  is **unchanged** by this unit, because injection adds the identical
  header set to both sides of that comparison. This is a documented delta
  from the JVM `NipopowAlgos.prove` (cited above), not a bug. **Validation
  consequence:** the 8 committed SANTA `nipopow_prove` fixtures (see
  "What the committed SANTA vectors are" below) are all `continuous: false`
  by construction (verified against their trailing wire byte) and remain
  ground truth for `continuous: false` output only; there is no JVM
  `NipopowAlgos.prove(continuous: true)` vector to compare against, by
  construction — the JVM function does not produce a self-valid one.
  Continuous-prover ground truth is `NipopowProverWithDbAlgs` semantics —
  what `proveWithReader` ports and what a live node actually runs.

#### `proveWithReader(reader, params, headerId?)`

- **Precondition (throws `ProofBuildError`):** same `'invalid-m'` /
  `'invalid-k'`; `await reader.headersHeight() >= m + k`
  (`'chain-too-short'`). A required header the reader answers `null` for →
  `'missing-popow-header'`; no silent partial proofs.
- **Postcondition:** Byte-identical to `prove` **only** on chains satisfying a
  specific predicate — **no header in the half-open range `[final anchor,
  suffixHead)` has `maxLevelOf === 0`, and genesis's free per-level credit
  never flips a narrowing decision** (both defined below). This predicate is
  **satisfied by `DefaultFakePowScheme`-generated synthetic chains** — every
  committed `prover-santa.test.ts` SANTA vector (`jvm-chain-32`/`jvm-chain-64`)
  has **zero** non-genesis headers at level 0 anywhere in the chain (verified
  directly: level sequence is monotonically non-decreasing, `3,3,3,3,4,4,…`
  for chain-32, `3,3,3,3,4,…,5,…,6,…` for chain-64 — an artifact of the fake
  PoW scheme, not representative of real mining), and the JVM's own
  `PoPowAlgosWithDBSpec.scala` `genChain(3000)` equivalence test is generated
  under the **same** fake-PoW config (`src/test/resources/application.conf`:
  `powType = "fake"`) — so it is *not* independent evidence that this holds
  on realistic chains; it's another data point in the same "satisfies"
  bucket as the SANTA fixtures, not a counter-example to what follows.
  **This predicate is VIOLATED by real chains** — KMZ17 expects level μ with
  probability `2^-μ`, so roughly half of all real blocks are level 0, and a
  captured 21-header mainnet sample (`test/fixtures/mainnet_consecutive.json`,
  heights 1,100,000–1,100,020) confirms it empirically: **15 of the 20
  parent headers are level 0**. On any real chain, the two algorithms'
  prefixes diverge **systematically**, not as an edge case: `NipopowAlgos.prove`'s
  explicit level-0 pass sweeps in every header from the anchor onward
  regardless of interlink connectivity, while `NipopowProverWithDbAlgs`/
  `proveWithReader`'s walk has no interlink position representing "level 0"
  at all (`linksWithIndexes` only ever yields positions for levels ≥1) and
  so can never discover a run of consecutive level-0 blocks whose id was
  never recorded by a later block's interlinks — a divergence a real chain
  hits constantly, not rarely. (Second, narrower mechanism: `prove`'s
  filter-based level pass also gives genesis unconditional credit at every
  not-yet-narrowed level — `maxLevelOf === Int.MaxValue`, height 1 always
  qualifies — with no walk-side counterpart, since genesis is never present
  in any header's interlinks tail; when the *true* non-genesis count at a
  level equals exactly `m`, this alone can flip the narrowing decision even
  on a level-0-free chain.) `prover-reader.test.ts`'s comment block has the
  full derivation with worked per-level traces.

  **Which algorithm is "production."** `proveWithReader` is a port of
  `NipopowProverWithDbAlgs.prove`, which is what the JVM node actually serves
  — `PopowProcessor.scala:109-111`'s `popowProof` calls it directly, and
  that is what backs the live REST endpoint `GET /nipopow/proof/{m}/{k}`
  (`NipopowApiRoute.scala`). `NipopowAlgos.prove` (what `prove()` ports)
  carries the JVM's own admission that it is the non-production variant —
  `NipopowAlgos.scala:127`: `"todo: Paper-like code used in tests only, so
  maybe better to replace it in tests with prove (histReader)"`. So
  `proveWithReader` mirrors the **production** prover; `prove()` is the
  **paper/test** variant. Do not read "`prove()` is the reference
  implementation" into any comment here or in source — on a real chain it is
  `proveWithReader` whose output a real node would actually produce.

  **Continuous-mode injection (0.4.0).** When `params.continuous`, after
  seeding genesis and before merging the interlink-walk selection,
  `proveWithReader` fetches each height in `heightsForNextRecalculation(
  suffixHead.height, epochLength, useLastEpochs).filter(h => h <
  suffixHead.height)` via `reader.popowHeaderAtHeight(h)` (no new reader
  method — this one already exists) and inserts it into the prefix. A
  `null` reader response for a needed height is **silently skipped** —
  mirrors the JVM's `Option.foreach` (`NipopowProverWithDbAlgs.scala:99`),
  NOT the `'missing-popow-header'` error the by-id suffix/genesis fetches
  raise elsewhere in this function. A reader that cannot serve a needed
  height therefore does not fail proof *construction*; it produces a proof
  `verifyParsedProof` will reject downstream with
  `'missing-difficulty-headers'` — matching the JVM, which has the
  identical gap. Injected headers are added to the by-height dedupe map
  **before** the walk-collected headers, and take precedence: the walk
  only adds a height not already claimed (JVM `storedHeights` insertion
  order — genesis, then injected, then walk;
  `NipopowProverWithDbAlgs.scala:90-112`). Exotic-config note: under
  `epochLength === 1`, the injected-heights loop can hit height 1 a second
  time (genesis is already stored, but the JVM's injection loop appends
  unconditionally without checking `storedHeights` first) — the JVM
  produces a proof with two height-1 entries, which its own
  `hasValidHeights` then rejects (strict-increasing violated); ergots's
  by-height `Map` naturally dedupes instead, so this specific self-invalid
  JVM artifact cannot occur here. Unreachable under every real chain
  setting (mainnet, testnet: `epochLength = 128`), where injected heights
  are multiples of `epochLength > 1` and so never collide with genesis
  (height 1) or each other.

  **Live-endpoint byte-identity — the 0.4.0 acceptance gate (RESOLVED).**
  `PopowProcessor.popowProof` (`PopowProcessor.scala:109-111`, cited above)
  hardcodes `continuous = true` on every call — there is no route parameter
  on `GET /nipopow/proof/{m}/{k}` to request `continuous = false`. Task 9
  ran the live-mainnet acceptance walk
  (`tools/nipopow-capture/live-walk.mjs --expect-full-identity`) on
  2026-08-19 against `213.239.193.208:9053` (`ergo-mainnet-6.0.4`) at tip
  height 1854246, for both of Task 9's parameter sets: `m=6,k=6` (our/JVM
  prefix 131/131, `totalHeaders` 137) and `m=2,k=10` (our/JVM prefix 49/49,
  `totalHeaders` 59). Both achieved raw byte-identity against the live
  node's own response — no filtering, no flag normalization — and
  `verifyProof(rawLiveBytes, { checkPoW: true })` succeeded directly on the
  unmodified live response, with `continuous: true` on both. The default
  (`--expect-full-identity` omitted) composite mode still passes unchanged
  too: a 123-header subset of the live prefix, with the 8-height surplus
  fully attributed to continuous-mode difficulty-recalculation heights.
  `tools/nipopow-capture/live-walk.mjs --expect-full-identity` remains the
  reproduction path for this claim against any live node; the permanent
  run logs live in the arc's ledger workspace
  (`.superpowers/sdd/2026-08-19-nipopow-continuous-mode/`), not in this
  file.

  **What the committed SANTA vectors are (and are not) ground truth for.**
  All 8 `nipopow_prove` vectors — the 6 tip-mode cases *and* the 2 anchored
  cases — were generated by calling `NipopowAlgos.prove` (`source:
  "NipopowAlgos.prove"` / `"truncated-prove"` in the fixture; the generator's
  own Scala calls `nipopow.prove(chain)(...)` and `nipopow.prove(truncated)
  (...)`, both on the `NipopowAlgos` instance, never on
  `NipopowProverWithDbAlgs`). **No committed vector is
  `NipopowProverWithDbAlgs` ground truth** — the 8/8 byte-identical match in
  `prover-santa.test.ts` demonstrates `proveWithReader` agrees with
  `NipopowAlgos.prove` *on these specific fake-PoW, level-0-free chains*,
  which is expected given the predicate above, not evidence the two
  algorithms agree in general. The actual `NipopowProverWithDbAlgs`
  ground-truth anchor is a **live node's own served proof** — Task 9's
  REST-backed reader should validate `proveWithReader`'s output directly
  against a running node's `/nipopow/proof/{m}/{k}` response bytes (same
  algorithm on both sides — byte-identity there is the correct expectation,
  unlike byte-identity against `prove()`).

  Suffix: `headerId` given → that header is `suffixHead` and
  `bestHeadersAfter(suffixHead.header, k-1)` is the tail; omitted →
  `lastHeaders(k)` from the tip. Genesis (height 1) is always seeded into
  the prefix. Header loads are O(m + k + m·log N) — the backward interlink
  walk (JVM `NipopowProverWithDbAlgs`), not a full scan. Both provers'
  outputs remain individually valid (`verifyParsedProof` accepts them) even
  where their prefixes diverge — this is prefix-*selection* divergence
  between two different-but-both-correct provers, never a validity defect.
- **Reader contract:** `popowHeaderAtHeight(1)` / `popowHeaderById(genesis
  id)` MUST synthesize `interlinks = [genesisId]` (e.g. via
  `makePopowHeader`) — real on-chain genesis extensions are empty and
  unpacking them yields wrong (empty) interlinks. Readers are not trusted
  to be consistent; inconsistency surfaces as `'missing-popow-header'` or
  a connection-invalid proof, never silent corruption. Async is the ONLY
  async surface in the package; everything else remains synchronous.

#### Building blocks

- `updateInterlinks(prevHeader, prevInterlinks)` — interlinks for the
  block AFTER `prevHeader`. Genesis: `[prevHeader.id]`. Non-genesis with
  empty `prevInterlinks` throws `'empty-interlinks'`. With
  `L = maxLevelOf(prevHeader)`: `L <= 0` → input returned unchanged
  (same array contents, fresh array); `L > 0` →
  `[genesis, ...tail.slice(0, max(0, tail.length - L)), ...L copies of prevHeader.id]`.
- `unpackInterlinks(fields)` — inverse of `packInterlinks`: filters keys
  with `key[0] === 0x01`, requires each value be exactly 33 bytes
  (`[qty, blockId32]`) else throws `'malformed-interlinks'`; expands qty
  duplicates in field order. `unpackInterlinks(packInterlinks(x))` ≡ x.
- `proofForInterlinkVector(fields)` — batch proof over the
  interlinks-only tree for all interlink-prefixed keys; zero interlink
  fields → `{ indices: [], proofs: [] }`.
- `makePopowHeader(header, interlinks)` — packs interlinks, builds the
  proof, returns `{ header, interlinks, interlinksProof }`.
- `maxLevelOf(header)` — superblock level; genesis →
  `Number.MAX_SAFE_INTEGER`; level float is truncated toward zero
  (`Math.trunc`, JVM `Double.toInt` semantics — NOT floor). JS `Math.trunc`
  yields `-0` at epsilon-negative levels; normalized to `+0`, JVM int
  semantics — `level.ts` documents the mechanism.
- `MerkleTree` / `buildExtensionTree` — construction counterpart of the
  verify-side codec: same padded-power-of-two layout `merkleRootFromLeaves`
  pins; `proofByIndices` emits explicit empty-sibling nodes
  (`hash: null`, serialized all-zero) for padding positions, `null` for
  empty/out-of-range/duplicate index lists.

#### Error taxonomy addition

```ts
class ProofBuildError extends Error   // recoverable; construction input rejected
```

codes: `'invalid-m' | 'invalid-k' | 'chain-too-short' |
'non-anchored-chain' | 'missing-popow-header' | 'empty-interlinks' |
'malformed-interlinks'` (conditions above).

## Type invariants

These hold on every `NipopowProof` returned by the public API. Callers may rely on them without re-checking.

```ts
type BlockId = Uint8Array      // length 32
type Digest32 = Uint8Array     // length 32

// Header and AutolykosSolution are defined in facts/scorex.md.
// The canonical field list, wire format, and type invariants live there.
// Summary for reference:
//   Header.id             -- 32 bytes, derived via blake2b256; not present on wire
//   Header.parentId       -- 32 bytes
//   Header.adProofsRoot   -- 32 bytes
//   Header.stateRoot      -- 33 bytes (ADDigest)
//   Header.transactionRoot -- 32 bytes
//   Header.votes          -- 3 bytes
//   Header.nBits          -- u32, 4 bytes big-endian on wire (NOT VLQ)
//   Header.unparsedBytes  -- forward-compat; preserved on round-trip
// See facts/scorex.md for the full interface and AutolykosSolution layout.

interface PoPowHeader {
  header: Header
  interlinks: BlockId[]        // length >= 1; interlinks[0] is genesis_id
  interlinksProof: BatchMerkleProof
}

interface NipopowProof {
  m: number                    // build parameter, > 0 (parser enforced — NIP-03)
  k: number                    // build parameter, > 0 (parser enforced — NIP-04)
  prefix: PoPowHeader[]        // heights strictly increasing; sigma-rust does NOT
                               // enforce a lower bound at parse, so empty prefix
                               // is accepted byte-for-byte to match upstream
                               // (legitimate provers always produce non-empty)
  suffixHead: PoPowHeader      // suffixHead.header.height > prefix[last].header.height
                               // (when prefix is non-empty)
  suffixTail: Header[]         // wire-explicit length, heights strictly increasing
                               // from suffixHead.height + 1; can be 0 ("anchor"
                               // proofs) or k-1 ("tip" proofs). sigma-rust does
                               // NOT enforce `length == k - 1`; the legitimate
                               // anchor-mode proof in fixture chain-64-m2-k2-anchor
                               // has k=2 with empty tail.
  continuous: boolean          // JVM dialect trailing byte (NIP-12, Task 7b);
                               // parser enforces strict 0|1 ('invalid-continuous-byte'
                               // otherwise — stricter than the JVM's lenient `!= 1 → false`).
                               // Since 0.4.0, `verifyParsedProof`/`verifyProof` accept
                               // `continuous === true` proofs too, subject to
                               // `hasValidDifficultyHeaders` ('missing-difficulty-headers'
                               // on failure) — see "Difficulty functions". A successfully-
                               // verified proof's `continuous` can now be either value.
}
```

- `BlockId` is always 32 bytes. The codec rejects shorter/longer inputs at parse time.
- `interlinks[0]` for *any* `PoPowHeader` in *any* valid proof is the canonical genesis id of the chain the proof is for. Verifiers do not check this themselves — proofs from one network won't link properly when compared against another, and `compareProofs` will return `false` in both directions.
- `unparsedBytes` on `Header` is reserved for forward-compatibility. The wire format may have appended fields in a future version; the codec captures them as-is to keep round-trip integrity.

## Determinism and purity

- All functions are pure: no I/O, no clock, no PRNG, no `globalThis` access; same inputs always produce the same output. All verifier-surface functions are synchronous; the `/prover` subpath's `proveWithReader` + `PopowHeaderReader` are the package's single async surface (demand-loading is their purpose).
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
class ProofBuildError extends Error          // recoverable; construction input rejected
```

Each error's `.message` is human-readable; each carries a `code: string` matching the postcondition reason strings above (`'truncated'`, `'pow-failed'`, etc.) for programmatic dispatch.

Four error classes are exported from this package in total, no others. `ProofParseError` and `ProofVerificationError` are exported from the primary `@ergots/nipopow` entry point; `EnvelopeParseError` is exported from the `/envelope` subpath; `ProofBuildError` is exported from the `/prover` subpath — each error class is exported from the subpath that raises it. Internal panics (e.g. blake2b implementation bugs) bubble up as plain `Error` — those represent contract violations *inside* the package and are bugs, not input-shape issues.

## Limitations

- **`verifyProof` is a structural + Autolykos-v2 verifier, NOT a consensus verifier.** It validates parse-shape, linkage, strictly-increasing heights, and each version ≥ 2 header's Autolykos v2 solution under that header's self-declared `nBits`. It does NOT validate `nBits` against the network's difficulty-adjustment rule, does NOT validate `header.version` against the network's hard-fork schedule, and does NOT anchor the proof to a trusted checkpoint or known chain tip. Version 1 headers are accepted structurally with no PoW check at any height. An attacker who controls proof construction can freely choose `nBits` and `version` to bypass cryptographic difficulty. **Combine `verifyProof` with an external consensus verifier for any security-critical use.** Full consensus header validation is a planned future phase.
- **Interlink Merkle proof anchors to interlinks-only-root, NOT `header.extensionRoot`.** The NiPoPoW proof commits to an interlinks-only ExtensionCandidate's Merkle root, mirroring sigma-rust's `PoPowHeader::check_interlinks_proof`. For mainnet blocks whose actual on-chain extension contains only interlinks (no votes/params at this height), `header.extensionRoot` coincidentally equals the interlinks-only-root; for blocks with richer extensions, the two diverge, and verification anchors to interlinks-only-root, not the on-chain commitment. Future work: add an explicit `header.extensionRoot` anchoring mode for callers that need full-extension-root assurance.

- **`packInterlinks` uses JVM Ergo's position-based key encoding** (`[0x01, position_of_first_occurrence_in_interlinks_array]`). Sigma-rust's `NipopowAlgos::pack_interlinks` (ergo-nipopow/src/nipopow_algos.rs:326-357) previously used sequential `distinct_ix` which round-tripped internally but didn't match JVM-generated mainnet proofs; **fixed upstream as [ergoplatform/sigma-rust#866](https://github.com/ergoplatform/sigma-rust/pull/866) (landed 2026-05-19, cherry-picked to `integration/ergots`).** This TS port and fixture-gen now agree with patched sigma-rust byte-for-byte.

- **This codec speaks the JVM `NipopowProof` wire dialect, not sigma-rust's.** (Task 7b, 2026-08-18/19, prompted by the first real JVM SANTA prover vectors this package compared against.) The JVM's `NipopowProofSerializer` always writes and always reads one trailing `continuous` byte (`NipopowProof.scala`, serialize ~line 208 / parse ~line 226 — unconditional `getByte()`, not gated on any length/presence field). Sigma-rust's `ergo-nipopow` crate (`nipopow_proof.rs:138-157`) **omits this byte entirely** — its `scorex_serialize`/`scorex_parse` end at `suffix_tail`. This means sigma-rust's own `NipopowProof` codec **cannot correctly parse a real JVM-emitted proof** (it would either read one byte too few if it tried, or — as observed — simply never emits/expects the byte at all): an upstream-bug candidate, the same species as the `pack_interlinks` divergence fixed in #866 above, not yet reported/fixed upstream as of this writing. Every ergots proof fixture predating Task 7b was generated through `fixture-gen`, which calls into sigma-rust — hence the omission was invisible until real JVM vectors arrived. **ergots now speaks the JVM dialect** (required trailing `continuous` byte, strict `0|1` — see `parseProof`/`serializeProof` above); all committed fixtures were surgically updated in place (`packages/nipopow/test/fixtures/append-continuous-byte.mjs`, `fixture-gen` itself is frozen and was not re-run) rather than regenerated.

## Test plan summary

(Detail in `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` § Validation strategy.)

1. **Round-trip fixtures**: every fixture parses and re-serializes byte-identically.
2. **Verification fixtures**: every layer-1 + layer-2 fixture passes `verifyProof`; the returned `VerificationResult` matches the JSON captured by `fixture-gen`.
3. **Mutation fixtures**: every single-byte flip rejected by `verifyProof`.
4. **Envelope fixtures**: P2P codes 90/91 round-trip; JVM-captured request bytes parse and re-serialize byte-identically.
5. **Cross-runtime**: vitest runs each test under both `node` and `jsdom` environments.

## Cross-references

- `facts/scorex.md` — foundational codec contract; defines `Header`, `AutolykosSolution`, `ByteReader`, `ByteWriter`, `ReaderError`, VLQ functions consumed by this package
- `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` — design rationale, validation strategy, risks
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/ergo-node-rust/facts/nipopow.md` — wire format canonical source
- `~/projects/ergo-node-rust/chain/src/nipopow_proof.rs` — verification semantics canonical source
- sigma-rust `ergo-nipopow` crate — `NipopowAlgos`, `NipopowProof`, `NipopowProofSerializer`
