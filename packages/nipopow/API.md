# API — `@ergots/nipopow`

Public surface for the verifier and prover package. The verifier's wire format and verification semantics come from `ergo-nipopow` (sigma-rust); the `/prover` subpath (0.3.0) is a port of the JVM Ergo node instead — see [Prover subpath](#prover-subpath) below. `facts/nipopow.md` in the repo root is the load-bearing interface contract for both.

## Entry points

| Import path | Purpose |
|---|---|
| `@ergots/nipopow` | Parse, serialize, verify, and compare NiPoPoW proofs; epoch math + continuous-mode difficulty-header check (0.4.0) |
| `@ergots/nipopow/envelope` | P2P wire envelope for message codes 90 / 91 |
| `@ergots/nipopow/prover` | Proof construction: `prove`, `proveWithReader`, and the interlink/Merkle-tree building blocks (0.3.0) |

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
  nextRecalculationHeight, previousHeightsRequiredForRecalculation,
  heightsForNextRecalculation, hasValidDifficultyHeaders,
  EPOCH_LENGTH_MAINNET, USE_LAST_EPOCHS_MAINNET,
  type NipopowProof, type Header, type PoPowHeader, type AutolykosSolution,
  type VerifyOptions, type VerificationResult, type DifficultyParams,
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
- **Throws:** `ProofParseError` with `.code` in `'empty-proof' | 'truncated' | 'trailing-bytes' | 'vlq-overflow' | 'oversized' | 'unexpected-tag' | 'invalid-m' | 'invalid-k' | 'invalid-interlinks-empty' | 'invalid-side' | 'invalid-continuous-byte'`. The function never silently produces a partial proof.

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

Structural + Autolykos-v2 verification pipeline: parse → connections → interlinks proof → strictly-increasing heights → optional per-header PoW against each header's self-declared `nBits` → continuous-mode difficulty-header membership (0.4.0; vacuous for `continuous: false` proofs). **Not a consensus verifier** — see [Scope and consensus caveat](#scope-and-consensus-caveat) above before relying on the result.

- **Default `opts.checkPoW`:** `true`.
- **`opts.epochLength` / `opts.useLastEpochs`** (0.4.0): resolved through the same defaulting/validation as `compareProofs`'s third argument and `PoPowParams` — see [Difficulty functions](#difficulty-functions-040) below, and `type DifficultyParams`. Resolved *before* any proof inspection; an invalid value throws `RangeError`, not `ProofVerificationError`.
- **Returns:** `VerificationResult` (see types below).
- **Throws:** `ProofVerificationError` with `.code` in `'parse-failed' | 'invalid-connections' | 'non-increasing-heights' | 'pow-failed' | 'v1-header-after-v2-activation' | 'invalid-interlinks-proof' | 'missing-difficulty-headers' | 'empty-proof'`. Parse failures wrap the underlying `ProofParseError` via `.cause`. Throws plain `RangeError` instead if `opts.epochLength`/`opts.useLastEpochs` is invalid.

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

Runs the same connection / interlinks-proof / height / optional-PoW / continuous-mode difficulty-header checks as `verifyProof` on an already-parsed `NipopowProof`, skipping the parse step. Intended for proofs **produced by `parseProof`** (held in memory, or re-verified after a previous parse).

- **`opts`:** Same shape as `verifyProof`'s (`checkPoW`, `epochLength`, `useLastEpochs`), resolved identically and first.
- **Throws:** `ProofVerificationError` with the same codes as `verifyProof` (minus `'parse-failed'`, which doesn't apply here; includes `'missing-difficulty-headers'`, 0.4.0). Throws plain `RangeError` instead if `opts.epochLength`/`opts.useLastEpochs` is invalid.

> **Caveat (audit RED-NIP-01).** `verifyParsedProof` does NOT re-run the wire
> parser's structural rejections. In particular, `parseProof` rejects a
> `PoPowHeader` with empty `interlinks` (`'invalid-interlinks-empty'`), but
> `verifyParsedProof` treats an empty-`interlinks` / empty-proof header as
> vacuously valid — deliberately mirroring sigma-rust's
> `check_interlinks_proof` short-circuit. If you hand-build `NipopowProof`
> objects instead of obtaining them from `parseProof`, you are responsible for
> enforcing the parser's invariants yourself (non-empty per-header
> `interlinks`, 32-byte interlink entries, counts within parser bounds).

### `compareProofs(a, b, opts?)`

```ts
function compareProofs(a: Uint8Array, b: Uint8Array, opts?: DifficultyParams): boolean;
```

Pairwise "is A better than B" per KMZ17 §4.3 best-arg comparison. Used to choose a proof when multiple peers offer alternatives.

- **`opts`** (0.4.0): `{ epochLength?: number; useLastEpochs?: number }`, resolved through the same gate `VerifyOptions` uses (see [Difficulty functions](#difficulty-functions-040) below) — applied symmetrically to both `a` and `b`. Resolved *before* either proof is parsed; an invalid value throws `RangeError`.
- **Returns:** `true` iff `a` is strictly better than `b`. Internally, a proof counts as valid only if it also passes the continuous-mode difficulty-header membership check (0.4.0) — a continuous proof missing a needed difficulty header is simply invalid for comparison, same as any other structurally-invalid proof (loses to any valid proof; two such proofs compare `false` both ways).
- **Throws:** `ProofParseError` if either argument is malformed (parse failures throw; the function does not silently return `false`). `RangeError` if `opts` is invalid (checked first, before parsing).
- **Invariant:** `compareProofs(a, b, opts)` and `compareProofs(b, a, opts)` are never both `true`. Equivalent proofs return `false` in both directions.

### Difficulty functions (0.4.0)

```ts
function nextRecalculationHeight(height: number, epochLength: number): number;
function previousHeightsRequiredForRecalculation(
  height: number, epochLength: number, useLastEpochs: number,
): number[];
function heightsForNextRecalculation(
  height: number, epochLength: number, useLastEpochs: number,
): number[];
function hasValidDifficultyHeaders(
  proof: NipopowProof, epochLength: number, useLastEpochs: number,
): boolean;

type DifficultyParams = { epochLength?: number; useLastEpochs?: number };
const EPOCH_LENGTH_MAINNET = 128;
const USE_LAST_EPOCHS_MAINNET = 8;
```

Epoch math and the continuous-mode difficulty-header membership check —
clean-room port of the JVM's `DifficultyAdjustment.scala:27-55` (epoch math)
and `NipopowProof.scala:82-105` (membership check). Pure; no I/O. Shared by
`verifyProof`/`verifyParsedProof`/`compareProofs` (each resolves its own
`epochLength`/`useLastEpochs` through the same internal gate, exposed here
only via the `DifficultyParams` type) and by the [Prover subpath](#prover-subpath)'s `PoPowParams`.

- **`nextRecalculationHeight(height, epochLength)`** — the height at which difficulty next recalculates after `height`.
- **`previousHeightsRequiredForRecalculation(height, epochLength, useLastEpochs)`** — the prior epoch-boundary heights needed to compute the difficulty that applies starting at `height`, ascending.
- **`heightsForNextRecalculation(height, epochLength, useLastEpochs)`** — `previousHeightsRequiredForRecalculation(nextRecalculationHeight(height, epochLength), epochLength, useLastEpochs)`. This is the set `proveWithReader`/`prove` inject into the prefix under continuous mode, and that `hasValidDifficultyHeaders` checks membership of.
- **`hasValidDifficultyHeaders(proof, epochLength, useLastEpochs)`** — `true` vacuously when `proof.continuous === false`. Otherwise, `true` iff every height in `heightsForNextRecalculation(proof.suffixHead.header.height, epochLength, useLastEpochs)` within `(0, suffixHead.height)` is present in the proof's flat header chain. **Precondition:** the chain's heights must already be strictly increasing (an ordered, non-resetting membership scan — not general set membership) — both in-package callers run this after the heights check.
- **`EPOCH_LENGTH_MAINNET` / `USE_LAST_EPOCHS_MAINNET`** — `128` / `8`, the mainnet and testnet defaults `DifficultyParams` resolves to when a field is omitted. An invalid override (non-integer, `epochLength < 1`, `useLastEpochs < 2`, or `epochLength * useLastEpochs > 2**31`) throws `RangeError` wherever `DifficultyParams` is accepted.
- **Not exported:** the internal resolver these three call sites share (`resolveDifficultyParams`) is package-internal; only its input type `DifficultyParams` is public.
- **Coupling with connections:** the prefix-connections lookback window (internal, not itself exported) widens to `useLastEpochs + 3` predecessors — see [Verification scope](./README.md#verification-scope) in the README. At the shared default (`useLastEpochs = 8`) this is 11 predecessors, identical to pre-0.4.0 behavior.

Full derivation, exact branch conditions, and JVM line citations: `facts/nipopow.md` "Difficulty functions".

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

## Prover subpath

```ts
import {
  prove, proveWithReader,
  updateInterlinks, packInterlinks, unpackInterlinks,
  proofForInterlinkVector, makePopowHeader, maxLevelOf,
  MerkleTree, buildExtensionTree,
  type PoPowParams, type PopowHeaderReader,
  type ExtensionKV, type BatchMerkleProof, type PoPowHeader, type NipopowProof,
  ProofBuildError,
} from '@ergots/nipopow/prover';
```

New in 0.3.0. Adds proof *construction* to the package: `prove` and
`proveWithReader` build a `NipopowProof` from a header chain; everything
else is a building block both are made from (interlink maintenance, Merkle
tree construction). **The JVM Ergo node is the canonical reference for this
entire subpath** — `NipopowAlgos.scala` and `NipopowProverWithDbAlgs.scala`
— not sigma-rust, which has no prover of its own. None of these functions
validate PoW or consensus rules; they assume a trusted, already-valid input
chain (see [Scope and consensus caveat](#scope-and-consensus-caveat) above,
which applies here too).

```ts
interface PoPowParams {
  m: number; // >= 1, integer — min superchain-length parameter
  k: number; // >= 1, integer — suffix-length parameter
  continuous?: boolean;   // build a continuous-mode proof; default false (0.4.0)
  epochLength?: number;   // difficulty epoch length; default EPOCH_LENGTH_MAINNET = 128 (0.4.0)
  useLastEpochs?: number; // default USE_LAST_EPOCHS_MAINNET = 8 (0.4.0)
}
```

`epochLength`/`useLastEpochs` (0.4.0) resolve through the same gate
[Difficulty functions](#difficulty-functions-040) describes — an invalid
value throws `RangeError`. Both `prove` and `proveWithReader` resolve them
**unconditionally**, regardless of `params.continuous`'s value (mirrors the
JVM, whose `NipopowProverWithDbAlgs.prove` constructs its
`DifficultyAdjustment` — running the same validation — before branching on
`continuous` at all).

### `prove(chain, params)`

```ts
function prove(chain: PoPowHeader[], params: PoPowParams): NipopowProof;
```

Synchronous, in-memory KMZ17 prover — a clean-room port of the JVM's
`NipopowAlgos.prove`, which the JVM's own source marks `"Paper-like code
used in tests only"` (`NipopowAlgos.scala:127`). Requires the entire header
chain, with correct interlinks already attached, in memory.

- **Precondition:** `params.m` and `params.k` are integers `>= 1`;
  `chain.length >= m + k`; `chain[0].header.height === 1` (anchored at
  genesis). The chain is trusted — `prove` re-derives nothing (no interlink
  recomputation, no PoW check).
- **Returns:** A `NipopowProof` with `continuous: params.continuous ?? false`.
  Passes `verifyParsedProof`'s structural checks and round-trips
  byte-identically through `serializeProof`/`parseProof`. When `continuous`
  is `false` or omitted, byte-identical to the JVM's own `NipopowAlgos.prove`
  output on the same chain. When `continuous: true` (0.4.0), `prove` injects
  the same difficulty-recalculation headers `proveWithReader` injects (see
  below) — a **deliberate divergence** from the JVM's own
  `NipopowAlgos.prove`, which stamps `continuous` without injecting
  anything and so emits proofs its own verifier would reject. See
  `facts/nipopow.md`'s `prove` entry for the full reasoning.
- **Throws:** `ProofBuildError` with `.code` in `'invalid-m' | 'invalid-k' |
  'chain-too-short' | 'non-anchored-chain'`. `RangeError` if
  `params.epochLength`/`params.useLastEpochs` is invalid (checked
  unconditionally, before the `continuous` branch).
- **Invariant:** Pure, synchronous, deterministic.

```ts
const proof = prove(chain, { m: 6, k: 6 });
```

### `proveWithReader(reader, params, headerId?)`

```ts
function proveWithReader(
  reader: PopowHeaderReader,
  params: PoPowParams,
  headerId?: Uint8Array,
): Promise<NipopowProof>;
```

Async, demand-loaded prover — a clean-room port of
`NipopowProverWithDbAlgs.prove`, the algorithm a live JVM node's
`GET /nipopow/proof/{m}/{k}` REST endpoint actually calls
(`PopowProcessor.scala:109-111`). This is the **production** prover;
`prove` above is the JVM's own "paper/test" variant.

- **Precondition:** Same `m`/`k` bounds as `prove`.
  `await reader.headersHeight() >= m + k`, else `ProofBuildError`
  (`'chain-too-short'`). Any header the reader answers `null` for →
  `ProofBuildError('missing-popow-header')` — no silent partial proofs.
- **Returns:** `Promise<NipopowProof>` with `continuous:
  params.continuous ?? false`. When `headerId` is given, that header becomes
  `suffixHead` and `bestHeadersAfter(suffixHead.header, k - 1)` supplies the
  suffix tail; when omitted, `lastHeaders(k)` from the reader's current tip
  is used instead. Genesis (height 1) is always seeded into the prefix.
  Header loads are O(m + k + m·log N) — a backward interlink walk, not a
  full chain scan. When `continuous: true` (0.4.0), fetches each needed
  difficulty-recalculation height via `reader.popowHeaderAtHeight` and
  inserts it into the prefix before the walk-collected headers (taking
  precedence on a height collision); a `null` reader response for a needed
  height is silently skipped (mirrors the JVM's `Option.foreach`) — the
  resulting proof is one `verifyParsedProof` will reject downstream with
  `'missing-difficulty-headers'`, matching the JVM's identical gap. This is
  the **production** path a live node's `GET /nipopow/proof/{m}/{k}`
  actually runs (`PopowProcessor.scala:109-111` hardcodes
  `continuous = true` on every call).
- **Throws:** `ProofBuildError` with `.code` in `'invalid-m' | 'invalid-k' |
  'chain-too-short' | 'missing-popow-header'`. `RangeError` if
  `params.epochLength`/`params.useLastEpochs` is invalid (checked
  unconditionally, before the `continuous` branch).
- **Byte-identity vs `prove`:** the two provers are **not** interchangeable
  on real chains — `proveWithReader`'s output equals `prove`'s only when no
  non-genesis header between the final anchor and the suffix head is at
  level 0, and genesis's free per-level credit never flips a narrowing
  decision. Every committed SANTA fixture (fake-PoW, level-0-free by
  construction) satisfies this; real chains violate it systematically
  (roughly half of all blocks are level 0 per KMZ17 — a 21-header mainnet
  sample has 15/20 parents at level 0). **`proveWithReader` is the one
  whose output a real node actually produces**; do not treat `prove`'s
  output as the reference on a real chain. Full derivation:
  `facts/nipopow.md`'s `proveWithReader` entry.
- **Reader contract:** `popowHeaderAtHeight(1)` / `popowHeaderById(genesisId)`
  MUST synthesize `interlinks = [genesisId]` (e.g. via `makePopowHeader`) —
  real on-chain genesis extensions are empty, and unpacking them yields
  wrong (empty) interlinks. A reader is not trusted to be internally
  consistent; inconsistency surfaces as `'missing-popow-header'` or an
  invalid (never silently-corrupt) proof.
- **Invariant:** The only async function in the package.

```ts
const tipProof = await proveWithReader(reader, { m: 6, k: 6 });
const anchored = await proveWithReader(reader, { m: 6, k: 6 }, someHeaderId);
```

### `PopowHeaderReader`

```ts
interface PopowHeaderReader {
  headersHeight(): Promise<number>;
  popowHeaderById(id: Uint8Array): Promise<PoPowHeader | null>;
  popowHeaderAtHeight(height: number): Promise<PoPowHeader | null>;
  lastHeaders(n: number): Promise<Header[]>;
  bestHeadersAfter(header: Header, n: number): Promise<Header[]>;
}
```

Caller-implemented demand-loading interface consumed by `proveWithReader` —
the only place in the package that performs I/O, and only through methods
the caller supplies (no built-in transport). A typical implementation wraps
a local IndexedDB/SQLite header store or a node's REST API. (`Header` here
is the same type re-exported from the primary `@ergots/nipopow` entry —
it is not itself re-exported from `/prover`.)

### `updateInterlinks(prevHeader, prevInterlinks)`

```ts
function updateInterlinks(prevHeader: Header, prevInterlinks: Uint8Array[]): Uint8Array[];
```

Computes the interlinks vector for the block immediately **after**
`prevHeader`, given `prevHeader`'s own interlinks.

- **Precondition:** If `prevHeader.height !== 1` (not genesis),
  `prevInterlinks.length > 0`.
- **Returns:** `[prevHeader.id]` when `prevHeader.height === 1` (genesis
  case — every chain's second block starts its interlinks here). Otherwise,
  with `L = maxLevelOf(prevHeader)`: `L <= 0` → `prevInterlinks` unchanged
  (fresh array, same contents); `L > 0` →
  `[genesis, ...tail.slice(0, max(0, tail.length - L)), ...L copies of prevHeader.id]`
  where `genesis = prevInterlinks[0]` and `tail = prevInterlinks.slice(1)`.
- **Throws:** `ProofBuildError('empty-interlinks')` if `prevHeader.height !== 1`
  and `prevInterlinks.length === 0`.

### `packInterlinks(interlinks)` / `unpackInterlinks(fields)`

```ts
interface ExtensionKV {
  key: Uint8Array;   // 2 bytes
  value: Uint8Array; // variable length
}

function packInterlinks(interlinks: Uint8Array[]): ExtensionKV[];
function unpackInterlinks(fields: ExtensionKV[]): Uint8Array[];
```

Inverses of each other — the construction-side counterpart of the
verifier's extension-field codec. `packInterlinks` groups consecutive
duplicate block ids into `{ key: [0x01, firstOccurrencePosition], value:
[count, ...32-byte id] }` entries (JVM Ergo's position-based key encoding —
see `facts/nipopow.md` "Limitations" for the sigma-rust divergence this
fixed, `ergoplatform/sigma-rust#866`). `unpackInterlinks` expands them back
out in field order.

- **Precondition (`packInterlinks`):** every entry in `interlinks` is
  exactly 32 bytes, else plain `Error`.
- **Precondition (`unpackInterlinks`):** every interlink-prefixed
  (`key[0] === 0x01`) field's `value` is exactly 33 bytes, else
  `ProofBuildError('malformed-interlinks')`. Non-interlink keys are ignored.
- **Returns:** `packInterlinks([])` → `[]`.
  `unpackInterlinks(packInterlinks(x))` ≡ `x` for any valid `x`.

### `proofForInterlinkVector(fields)`

```ts
function proofForInterlinkVector(fields: ExtensionKV[]): BatchMerkleProof;
```

Batch Merkle proof over the interlinks-only tree, covering every
interlink-prefixed key in `fields`, in field order — the construction-side
counterpart of `verifyProof`'s interlinks-proof check.

- **Returns:** `{ indices: [], proofs: [] }` when `fields` has no
  interlink-prefixed entries.

### `makePopowHeader(header, interlinks)`

```ts
function makePopowHeader(header: Header, interlinks: Uint8Array[]): PoPowHeader;
```

Convenience composition: `packInterlinks(interlinks)` →
`proofForInterlinkVector(...)` → `{ header, interlinks, interlinksProof }`.
This is how a caller turns a `Header` plus its interlinks vector into a
`PoPowHeader` ready for a chain array or a `PopowHeaderReader` response.

### `maxLevelOf(header)`

```ts
function maxLevelOf(header: Header): number;
```

Superblock μ-level — how many superchains (per KMZ17) a header qualifies
for. Shared by the prover (level-based prefix selection) and
`compareProofs` (best-arg comparison); both consume the exact same
function.

- **Returns:** `Number.MAX_SAFE_INTEGER` for genesis (`height === 1`,
  representing the JVM's `Int.MaxValue`). Otherwise
  `trunc(ln(requiredTarget / realHit) / ln(2))` — **truncated toward zero**
  (JVM `Double.toInt` / Rust `as i32` semantics, NOT `Math.floor`), using
  the JVM's own natural-log-ratio log2 formulation rather than a native
  `log2` (the two diverge by design at exact power-of-two hit ratios —
  boundary-exact match to `NipopowAlgos.scala:166` is the point). May be
  negative if the hit exceeds the required target; `-0` is normalized to
  `0`.

### `MerkleTree` / `buildExtensionTree(fields)`

```ts
class MerkleTree {
  constructor(leafHashes: Uint8Array[]);
  readonly leafCount: number;
  rootHash(): Uint8Array;
  proofByIndices(indices: number[]): BatchMerkleProof | null;
}
function buildExtensionTree(fields: ExtensionKV[]): MerkleTree;
```

The construction counterpart of the verify-side `BatchMerkleProof`
validation codec — same padded-power-of-two layout, so a tree built here
and one reconstructed by a verifier from the same leaves always agree.

- **`rootHash()`:** 32-byte root; `leafCount === 0` → 32 zero bytes
  (`Digest32::zero()` parity).
- **`proofByIndices(indices)`:** Returns `null` for an empty index list, a
  duplicate index, or any index outside `[0, leafCount)`. Otherwise a
  `BatchMerkleProof` covering exactly those leaf positions, with explicit
  empty-sibling nodes (`hash: null`, serialized as 32 zero bytes) standing
  in for padding positions.
- **`buildExtensionTree(fields)`:** the tree over a list of extension
  key-value pairs, hashed the same way the wire-format leaves are.

### Continuous mode (0.4.0)

Both `prove` and `proveWithReader` can produce a continuous-mode proof via
`{ ..., continuous: true }` — see [Difficulty functions](#difficulty-functions-040)
above and each function's `Returns` bullet for the injection mechanics.
Validated directly against a live mainnet node: `proveWithReader(reader, {
m, k, continuous: true })`'s output is raw byte-identical to the same
node's own `GET /nipopow/proof/{m}/{k}` response, and that unmodified
response passes `verifyProof(bytes, { checkPoW: true })` directly —
`tools/nipopow-capture/live-walk.mjs --expect-full-identity` reproduces
this check against any live node; `facts/nipopow.md`'s "Live-endpoint
byte-identity" entry has the full acceptance record.

## Types

### `NipopowProof`

```ts
interface NipopowProof {
  m: number;              // > 0; min superchain length parameter
  k: number;              // > 0; suffix length parameter
  prefix: PoPowHeader[];  // may be empty (sigma-rust sets no lower bound); heights strictly increasing
  suffixHead: PoPowHeader; // always present; height > prefix[last].height when prefix is non-empty
  suffixTail: Header[];   // explicit wire length, NOT enforced == k-1 ("anchor"-mode proofs carry 0); strictly increasing from suffixHead.height + 1
  continuous: boolean;    // JVM wire dialect trailing byte (0.3.0); parser enforces strict 0|1
                          // ('invalid-continuous-byte' otherwise). Since 0.4.0, verifyProof/
                          // verifyParsedProof accept continuous === true too, subject to
                          // hasValidDifficultyHeaders ('missing-difficulty-headers' on failure) —
                          // a successfully-verified proof's continuous can be either value.
                          // prove()/proveWithReader() emit params.continuous ?? false.
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

`BatchMerkleProof` is not re-exported as a named type from the primary `@ergots/nipopow` entry point — most callers don't need to inspect it directly, since `verifyProof` handles validation. It **is** exported (as `type BatchMerkleProof`, alongside `type ExtensionKV`) from `@ergots/nipopow/prover`, where `MerkleTree`/`buildExtensionTree`/`proofForInterlinkVector` produce and consume it directly — see [Prover subpath](#prover-subpath).

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
  epochLength?: number;          // 0.4.0; default EPOCH_LENGTH_MAINNET (128); RangeError if invalid
  useLastEpochs?: number;        // 0.4.0; default USE_LAST_EPOCHS_MAINNET (8); RangeError if invalid
}

interface VerificationResult {
  suffixTipHeight: number;  // highest header.height in the proof
  totalHeaders: number;     // prefix.length + 1 + suffixTail.length
  continuous: boolean;      // 0.4.0; echoes proof.continuous (was always false in 0.3.0's type)
  headers: Header[];        // every header in the proof, in strictly-increasing height order
}
```

`epochLength`/`useLastEpochs` also govern the continuous-mode difficulty-header
membership check (0.4.0) — see [Difficulty functions](#difficulty-functions-040)
and, via `hasValidConnections`, widen the prefix-connections lookback window
(`useLastEpochs + 3` predecessors). Both are resolved once, before any proof
inspection; an invalid value throws `RangeError`, not `ProofVerificationError`.

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

All four classes extend `Error` and carry a `.code: string` for programmatic dispatch.

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

class ProofBuildError extends Error {
  readonly code: string;
}
```

### `ProofBuildError` codes

Thrown by the [Prover subpath](#prover-subpath)'s construction functions
(`prove`, `proveWithReader`, `updateInterlinks`, `unpackInterlinks`) when
given input they refuse to build a proof from — recoverable, same dispatch
pattern as the other three.

| Code | Meaning |
|---|---|
| `'invalid-m'` | `params.m` is not an integer `>= 1` |
| `'invalid-k'` | `params.k` is not an integer `>= 1` |
| `'chain-too-short'` | `chain.length < m + k` (`prove`) or the reader reports/returns fewer than `m + k` headers (`proveWithReader`) |
| `'non-anchored-chain'` | `chain[0].header.height !== 1` (`prove` only — `proveWithReader` has no in-memory chain to check; genesis is fetched via the reader instead) |
| `'missing-popow-header'` | `proveWithReader` only: the reader returned `null` for a header the walk required (by id or by height) — no silent partial proofs |
| `'empty-interlinks'` | `updateInterlinks` only: `prevHeader.height !== 1` and `prevInterlinks.length === 0` |
| `'malformed-interlinks'` | `unpackInterlinks` only: an interlink-prefixed field's `value` is not exactly 33 bytes |

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
| `'invalid-side'` | A `BatchMerkleProof` node-side byte (inside a PoPowHeader's interlinks proof) is neither the Left nor the Right discriminant. |
| `'invalid-continuous-byte'` | The wire-format-mandated trailing `continuous` byte (0.3.0, NIP-12) is present but neither `0x00` nor `0x01`. Stricter than the JVM reference, which maps any byte `!= 1` to `false`; ergots rejects `2..255` outright to preserve the byte-exact round-trip invariant for every proof it accepts. |

### `ProofVerificationError` codes

Thrown by `verifyProof` and `verifyParsedProof`.

| Code | Meaning |
|---|---|
| `'parse-failed'` | Parsing failed (wraps the underlying `ProofParseError` via `.cause`); thrown by `verifyProof` only |
| `'invalid-connections'` | A header pair in the prefix or at the prefix/suffix-head boundary fails parent-linkage check (interlink or parent-id match within the `useLastEpochs + 3`-entry lookback window — 11 entries at the default) |
| `'non-increasing-heights'` | Two adjacent headers in the proof have non-strictly-increasing heights |
| `'pow-failed'` | A version ≥ 2 header's Autolykos v2 solution doesn't satisfy that header's **self-declared** `nBits` target. (The target itself is not validated against consensus chain parameters — see [Scope and consensus caveat](#scope-and-consensus-caveat).) |
| `'v1-header-after-v2-activation'` | A version 1 header appears at a height at or above `opts.v2ActivationHeight` (default mainnet 417792). Audit finding NIP-02: prevents an attacker from bypassing PoW by marking forged high-height headers as V1. Only thrown when `checkPoW: true`. |
| `'invalid-interlinks-proof'` | A PoPowHeader's interlinks Merkle proof does not verify against the interlinks-only Merkle root (see [`facts/nipopow.md`](../../facts/nipopow.md) "Limitations" — anchoring is interlinks-only-root, not `header.extensionRoot`). |
| `'missing-difficulty-headers'` | 0.4.0. `proof.continuous === true` and some needed difficulty-recalculation height in `(0, suffixHead.height)` is absent from the header chain (`hasValidDifficultyHeaders` — see [Difficulty functions](#difficulty-functions-040)). Checked last, only after connections/interlinks/heights/PoW all pass. Vacuous — never thrown — when `proof.continuous === false`; that case has exactly 0.3.0's accept-set. |
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
- **No async surface, except `proveWithReader`.** Every verifier-surface function is synchronous (hashing is a tight loop; the async boundary would only add overhead). The one exception is the `/prover` subpath's `proveWithReader`, whose entire purpose is demand-loading headers through a caller-supplied `PopowHeaderReader` — see [Prover subpath](#prover-subpath).
- **No I/O, no globals.** Pure functions: same inputs always produce the same output.
- **Throws on input rejection.** Parse and verify errors throw typed exceptions with `.code` for programmatic dispatch. Programmer-error invariants (out-of-range writes, contract violations) throw plain `Error`.

## See also

- `facts/nipopow.md` (repo root) — load-bearing interface contract referenced by downstream packages
- `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` — design rationale, validation strategy, risks (verifier)
- `docs/superpowers/specs/2026-08-18-nipopow-prover-design.md` — design rationale for the `/prover` subpath (0.3.0)
- `docs/superpowers/specs/2026-08-19-nipopow-continuous-mode-design.md` — design rationale for continuous-mode support (0.4.0)
- [KMZ17 paper](https://eprint.iacr.org/2017/963) — original NiPoPoW spec
- [sigma-rust `ergo-nipopow`](https://github.com/ergoplatform/sigma-rust/tree/develop/ergo-nipopow) — reference Rust implementation
