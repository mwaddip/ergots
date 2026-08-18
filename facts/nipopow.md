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

**Does NOT ship:**

- **Consensus header validation.** `verifyProof` validates each header's Autolykos v2 solution against that header's **self-declared** `nBits`, but does NOT validate `nBits` against consensus chain parameters (difficulty-adjustment rule, hard-fork schedule for header.version, trusted anchor / checkpoint policy). An attacker who controls proof construction can choose the work target. Consumers MUST combine `verifyProof` with an external consensus verifier for any security-critical use. Full consensus header validation is a planned future phase. See "Limitations" below.
- Continuous-mode proofs (prover side as well as verifier side). `prove` / `proveWithReader` emit non-continuous proofs only; the difficulty-header machinery (`heightsForNextRecalculation`, `hasValidDifficultyHeaders`) is a planned follow-up unit that ships prover + verifier together.
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
compareProofs(a: Uint8Array, b: Uint8Array): boolean
```

#### `parseProof(bytes)`

- **Precondition:** `bytes.length >= 1` and `bytes.length <= 2_000_000`. (The 2 MB cap mirrors JVM `SizeLimit`; envelope-level cap already enforced this if the caller went through the envelope codec.)
- **Postcondition (success):** Returns a `NipopowProof` whose serialization is byte-identical to the input. See `Round-trip invariant` below. The wire format now ends with a **required trailing `continuous` byte** (JVM dialect — NIP-12, Task 7b): `parseProof` always reads exactly one more byte after the suffix_tail entries, strictly `0x00` → `continuous: false` or `0x01` → `continuous: true`. This is a deliberate strictness delta vs the JVM reference (`NipopowProof.scala`), which maps *any* byte `!= 1` to `false` (silently accepts `2..255`, and would not round-trip such a byte on its own re-serialization); ergots instead rejects `2..255` outright with `'invalid-continuous-byte'`, preserving the byte-exact round-trip invariant for every proof this parser accepts — the same precedent as the NIP-03/NIP-04 `m=0`/`k=0` hardening.
- **Postcondition (failure):** Throws `ProofParseError` with a structural reason (`empty-proof`, `truncated`, `vlq-overflow`, `oversized`, `unexpected-tag`, `trailing-bytes`, `invalid-m`, `invalid-k`, `invalid-interlinks-empty`, `invalid-side` — a `BatchMerkleProof` node-side byte that is neither Left nor Right — `invalid-continuous-byte` — the trailing continuous byte is present but not `0x00`/`0x01`, NIP-12). The function does NOT silently produce a partial proof, rejects any trailing bytes after the encoded suffix_tail + continuous byte (including inside the bounded PoPowHeader header/proof subreaders), and enforces shape invariants `m > 0` (NIP-03), `k > 0` (NIP-04 — matches sigma-rust's `NipopowProof::new` constructor's `k >= 1` requirement), `interlinks.length > 0` per PoPowHeader (NIP-05 — empty interlinks make `check_interlinks_proof` vacuously true; sigma-rust permissively accepts but we surface as a typed parse failure), and a well-formed trailing continuous byte (NIP-12 — a missing byte surfaces as `'truncated'`, an out-of-range byte as `'invalid-continuous-byte'`).

#### `serializeProof(proof)`

- **Precondition:** `proof` was either returned from `parseProof` or constructed satisfying the type invariants below.
- **Postcondition:** Returns `Uint8Array` of length ≤ 2_000_000, always ending with the trailing `continuous` byte (`proof.continuous ? 1 : 0` — NIP-12). For any `proof` returned by `parseProof(b)`, `serializeProof(parseProof(b))` equals `b` byte-for-byte — this now holds for JVM-emitted canonical proof bytes too, not only sigma-rust-dialect ones (see "Limitations" below).

#### `verifyProof(bytes, opts)`

`VerifyOptions = { checkPoW?: boolean }` — default `{ checkPoW: true }`.

- **Precondition:** Same as `parseProof`.
- **Postcondition (success):** Returns `VerificationResult` where:
  - `headers.length === totalHeaders`
  - `headers` heights are strictly increasing
  - `headers[headers.length - 1].height === suffixTipHeight`
  - `continuous === false`
  - If `checkPoW === true`, every version >= 2 `header` has a valid Autolykos v2 solution under that header's **self-declared** `nBits` target (NOT validated against the network's difficulty-adjustment rule — see "Limitations" below); version 1 headers at height < `opts.v2ActivationHeight` (default mainnet `V2_ACTIVATION_HEIGHT_MAINNET = 417792`) are accepted structurally without PoW verification (Autolykos v1 is not implemented in this package); version 1 headers at height >= the threshold are rejected with `'v1-header-after-v2-activation'` per audit finding NIP-02
  - Parent-linkage connections (`has_valid_connections` in the Rust) hold across the proof
  - Interlink Merkle proof per PoPowHeader (`check_interlinks_proof` in the Rust) holds: the proof's stored leaf hashes walk up to the Merkle root computed from `packInterlinks(interlinks)` (interlinks-only extension tree). See "Known limitations" below.
- **Postcondition (failure):** Throws `ProofVerificationError` with one of: `invalid-connections`, `non-increasing-heights`, `pow-failed`, `v1-header-after-v2-activation` (NIP-02), `empty-proof`, `parse-failed` (when bytes don't parse — wraps `ProofParseError`), `invalid-interlinks-proof`, `continuous-unsupported` (NIP-12, Task 7b — `proof.continuous === true`; the JVM's `hasValidDifficultyHeaders` continuous-mode check isn't implemented yet, so a continuous proof is rejected rather than accepted-and-under-verified).
- **Invariant:** Stateless. No filesystem, network, or `globalThis` access. Same inputs → same result, every call.

#### `verifyParsedProof(proof, opts)`

- The parsed-proof entry point that `verifyProof` delegates to after parsing. Takes an already-parsed `NipopowProof` (no wire decode); exported chiefly to unit-test the logical invariants (heights, connections, interlinks Merkle proof) without round-trip serialization.
- **Postcondition (success):** Same `VerificationResult` as `verifyProof` — always has `continuous === false` (a `continuous === true` input never reaches success; see `'continuous-unsupported'` below).
- **Postcondition (failure):** Throws `ProofVerificationError` — `'invalid-m'` / `'invalid-k'` (the `m > 0` / `k > 0` shape gates, NIP-09), `'continuous-unsupported'` (NIP-12, Task 7b — checked alongside the `invalid-m`/`invalid-k` early shape gates, before connections/heights/PoW) plus the same logical-verification codes `verifyProof` raises (connections, heights, PoW, v1-after-activation, interlinks). It does not parse, so it never raises `'parse-failed'`. The `'invalid-m'` / `'invalid-k'` codes are reachable here only with a hand-built `NipopowProof`; on the wire path an out-of-range `m`/`k` is rejected earlier by `parseProof` as `ProofParseError('invalid-m'/'invalid-k')`, which `verifyProof` wraps to `'parse-failed'`. Likewise a `continuous` byte outside `{0,1}` is rejected at parse time as `'invalid-continuous-byte'` and never reaches `verifyParsedProof` on the wire path.
- **Invariant:** Stateless, same as `verifyProof`.

#### `compareProofs(a, b)`

- **Precondition:** Both `a` and `b` are valid proof byte sequences. (Parse failures throw; do NOT silently return `false`.)
- **Postcondition:** Returns `true` iff `a` is strictly better than `b` per KMZ17 §4.3 (`is_better_than` in the Rust). Internally validates each proof via `isValid` (connections + heights + interlinks Merkle proof per PoPowHeader — but NOT PoW; that's caller responsibility, same as sigma-rust). If both are invalid, returns `false`; if only `b` is invalid, returns `a.isValid()`; both valid → best-arg comparison per KMZ17.
- **Invariant:** `compareProofs(a, b)` and `compareProofs(b, a)` are not both `true`. Equivalent proofs return `false` in both directions.

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

type PoPowParams = { m: number; k: number }
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

#### `prove(chain, params)`

- **Precondition (throws `ProofBuildError`):** `params.m >= 1`
  (`'invalid-m'`), `params.k >= 1` (`'invalid-k'`),
  `chain.length >= m + k` (`'chain-too-short'`),
  `chain[0].header.height === 1` (`'non-anchored-chain'`). The chain is
  trusted: contiguous from genesis, interlinks already correct; `prove`
  re-derives nothing.
- **Postcondition:** Returns a `NipopowProof` that (a) passes
  `verifyParsedProof` structural checks (PoW validity is a property of the
  input chain, not the prover), (b) round-trips byte-identically through
  `serializeProof`/`parseProof`, (c) is byte-identical to the JVM
  `NipopowAlgos.prove` output on the same chain (KMZ17 provePrefix walk,
  dedupe by header id, prefix sorted ascending by height).
- **Invariant:** Pure, synchronous, deterministic.

#### `proveWithReader(reader, params, headerId?)`

- **Precondition (throws `ProofBuildError`):** same `'invalid-m'` /
  `'invalid-k'`; `await reader.headersHeight() >= m + k`
  (`'chain-too-short'`). A required header the reader answers `null` for →
  `'missing-popow-header'`; no silent partial proofs.
- **Postcondition:** Byte-identical to `prove` on the same underlying
  chain (tested property). Suffix: `headerId` given → that header is
  `suffixHead` and `bestHeadersAfter(suffixHead.header, k-1)` is the tail;
  omitted → `lastHeaders(k)` from the tip. Genesis (height 1) is always
  seeded into the prefix. Header loads are O(m + k + m·log N) — the
  backward interlink walk (JVM `NipopowProverWithDbAlgs`), not a full scan.
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
  (`Math.trunc`, JVM `Double.toInt` semantics — NOT floor).
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
                               // `verifyParsedProof`/`verifyProof` reject `continuous === true`
                               // with 'continuous-unsupported'; every publicly-returned,
                               // successfully-verified proof therefore has continuous === false.
}
```

- `BlockId` is always 32 bytes. The codec rejects shorter/longer inputs at parse time.
- `interlinks[0]` for *any* `PoPowHeader` in *any* valid proof is the canonical genesis id of the chain the proof is for. Verifiers do not check this themselves — proofs from one network won't link properly when compared against another, and `compareProofs` will return `false` in both directions.
- `unparsedBytes` on `Header` is reserved for forward-compatibility. The wire format may have appended fields in a future version; the codec captures them as-is to keep round-trip integrity.

## Determinism and purity

- All functions are pure… **All verifier-surface functions are synchronous**; the single async surface is the `/prover` subpath's `proveWithReader` + `PopowHeaderReader` (demand-loading is its purpose). No function touches clock, PRNG, or `globalThis`.
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
