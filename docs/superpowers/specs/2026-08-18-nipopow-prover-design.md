# NiPoPoW Prover — Design Spec

**Date:** 2026-08-18
**Package:** `@ergots/nipopow` 0.2.1 → 0.3.0 (new surface, nothing breaking)
**Status:** approved design, pre-implementation

## Goal

Add proof *construction* to `@ergots/nipopow`, complementing the shipped
verifier the same way `@ergots/avltree`'s `BatchAVLProver` complements its
verifier. Two consumers drive the shape:

1. **Standalone utility** — the package becomes a complete NiPoPoW
   implementation (parse / serialize / verify / compare / **prove**).
2. **Parts bin for the TS node** — a separate TypeScript Ergo node project
   will salvage individual building blocks (interlink maintenance, Merkle
   tree construction, the reader-based prover) for its chain-ingest and
   serve paths. Longer-term: a TS light client (libp2p or similar) extends
   from the same pieces.

The building blocks are therefore *individually* public API, not internals
of `prove()`.

## Reference authority

**The JVM Ergo node is canonical** (user decision, this phase): sigma-rust's
`ergo-nipopow` is itself a port of it and has diverged before
(`pack_interlinks`, fixed upstream as sigma-rust#866). Where the two
disagree, the JVM wins. sigma-rust remains useful as a second reading.

| Concern | Canonical source (local checkout `~/projects/ergo-jvm-pr`) |
|---|---|
| In-memory prove, interlinks algebra | `ergo-core/src/main/scala/org/ergoplatform/modifiers/history/popow/NipopowAlgos.scala` |
| Reader-based prove (backward interlink walk) | `src/main/scala/org/ergoplatform/modifiers/history/popow/NipopowProverWithDbAlgs.scala` |
| Extension Merkle tree, batch proof extraction | `ergo-core/src/main/scala/org/ergoplatform/modifiers/history/extension/{Extension,ExtensionCandidate}.scala` (delegating to scrypto `MerkleTree`) |
| Proof structure / wire | `ergo-core/.../popow/NipopowProof.scala` (already ported — verifier phase) |

Clean-room rule unchanged: the Scala is the reference for *behavior*; no
line-by-line translation.

## Non-goals

- **Continuous-mode proofs** — deferred to the **next unit** (user
  decision). It is a self-contained follow-up: port
  `heightsForNextRecalculation` (difficulty-adjustment epochs), stuff
  difficulty headers into the prefix at build time, add
  `hasValidDifficultyHeaders` to the verifier. Prover and verifier ship it
  together; until then `prove()` emits non-continuous proofs only, matching
  what the verifier can check.
- P2P transport, peer orchestration, storage implementations. The reader
  interface is the boundary; consumers own the backend.
- Consensus validation of the chain being proven. `prove()` trusts its
  input chain exactly as the JVM prover trusts its `ErgoHistoryReader`.
- Unfreezing `fixture-gen/`. It stays frozen; no new Rust-generated
  fixtures (see Validation).

## Design

Bottom-up in four layers. Each layer is public, individually validated, and
consumed by the next.

### Layer 1 — Merkle tree builder (`merkle.ts`)

The one genuinely new primitive. `merkle.ts` already parses, serializes,
and **verifies** `BatchMerkleProof`s; it cannot build a tree or extract a
proof. The builder adds:

```ts
class MerkleTree {
  rootHash(): Uint8Array                                   // 32 bytes
  proofByIndices(indices: number[]): BatchMerkleProof | null
}
buildExtensionTree(fields: ExtensionKV[]): MerkleTree      // kvToLeaf + build
```

- Leaf encoding for extension KVs: `[key_length (1 byte, always 2), key
  (2 bytes), value]` — JVM `Extension.kvToLeaf`.
- Hashing: blake2b-256 with the **existing** leaf / internal-node domain-
  separation prefixes already defined and fixture-validated in `merkle.ts`
  (verify side). The builder introduces **no new crypto constants**.
- Tree layout: exactly the one `merkle.ts` already pins in
  `merkleRootFromLeaves` (fixture-validated): pad leaves to the next power
  of two (minimum 2) with empty sentinels; internal node = `prefixedHash2`
  when both children present, `prefixedHash` of the single child when one
  is empty, empty when both are. The builder retains the levels this
  produces; `proofByIndices` reads siblings (including empty ones —
  `LevelNode.hash: null`) off those levels. Fixtures decide (Validation,
  Layer 1).
- `proofByIndices` extracts the compact multi-proof (sorted leaf indices +
  minimal sibling set with side flags) in the shape `BatchMerkleProof`
  already models. `null` when indices are empty/out of range, mirroring the
  JVM's `Option`.
- The tree keeps a leaf-hash → index map (JVM `elementsHashIndex`) so
  callers can locate leaves by content; `buildExtensionTree` uses it
  internally for key-based proof extraction.

### Layer 2 — Interlink maintenance (prover module)

Thin, direct ports from `NipopowAlgos`:

```ts
updateInterlinks(prevHeader: Header, prevInterlinks: Uint8Array[]): Uint8Array[]
packInterlinks(interlinks: Uint8Array[]): ExtensionKV[]    // exists; promoted to export
unpackInterlinks(fields: ExtensionKV[]): Uint8Array[]      // new
proofForInterlinkVector(fields: ExtensionKV[]): BatchMerkleProof
makePopowHeader(header: Header, interlinks: Uint8Array[]): PoPowHeader
maxLevelOf(header: Header): number                         // extracted from compare.ts
```

- `updateInterlinks` — interlinks for the block *after* `prevHeader`.
  Genesis (`height === 1`): `[prevHeader.id]`. Else with
  `prevLevel = maxLevelOf(prevHeader)`: if `prevLevel > 0`, keep
  `interlinks[0]` (genesis), drop the last `prevLevel` entries of the tail,
  append `prevHeader.id` × `prevLevel` (growing the vector when
  `prevLevel ≥ tail.length`); if `prevLevel === 0`, return input unchanged.
  Empty `prevInterlinks` on a non-genesis header throws
  (`'empty-interlinks'`), mirroring the JVM `require`.
- `unpackInterlinks` — inverse of `packInterlinks`: filter fields to
  interlink-prefixed keys (`key[0] === 0x01`), each value must be exactly
  33 bytes (`[qty, blockId]`) else throw `'malformed-interlinks'`; expand
  `qty` duplicates in field order.
- `proofForInterlinkVector` — filter to interlink-prefixed fields, build
  the interlinks-only tree (Layer 1), extract the batch proof for all
  interlink keys in order. Zero interlink fields → empty proof
  (`{ indices: [], proofs: [] }`), matching the JVM's
  `BatchMerkleProof(Seq.empty, Seq.empty)`.
- `makePopowHeader` — convenience gluing the above:
  `packInterlinks` → `proofForInterlinkVector` → `PoPowHeader`. This is
  ergo-node-rust's `build_popow_header` shape and what every reader
  implementation and the TS node's ingest path will call.
- `maxLevelOf` — moves from `compare.ts` (private) to a shared internal
  module; re-exported publicly from the prover subpath. Genesis →
  `Number.MAX_SAFE_INTEGER` (existing constant, stands in for the JVM's
  `Int.MaxValue`; any value `≥` every real level works). Non-genesis:
  `log2(required_target) − log2(pow_hit)` **truncated toward zero via
  `Math.trunc`** — matching JVM `Double.toInt` / Rust `as i32`. The current
  `compare.ts` copy uses `Math.floor`; identical for positive levels (so
  comparison behavior is unchanged by the extraction) but NOT at the zero
  boundary: an epsilon-negative float level (PoW-valid header whose hit
  sits at the target boundary) gives JVM `0` but floor `−1`, and
  `provePrefix`'s level-0 filter (`maxLevelOf ≥ 0`) would then exclude a
  header the JVM includes — byte divergence. The shared version therefore
  uses trunc; see Risks.

### Layer 3 — In-memory `prove()` (sync)

```ts
type PoPowParams = { m: number, k: number }
prove(chain: PoPowHeader[], params: PoPowParams): NipopowProof
```

Direct port of `NipopowAlgos.prove`:

1. Gates (throw `ProofBuildError`): `m ≥ 1` (`'invalid-m'`), `k ≥ 1`
   (`'invalid-k'`), `chain.length ≥ m + k` (`'chain-too-short'`),
   `chain[0].header.height === 1` (`'non-anchored-chain'`). The m/k gates
   exceed the JVM (which only checks k) deliberately: our own `parseProof`
   enforces `m > 0` (NIP-03), and the prover must never emit bytes its own
   parser rejects — same principle as the envelope's NIP-11.
2. Suffix: last `k` entries. `suffixHead` = first of those;
   `suffixTail` = remaining `k − 1` headers (header only, no interlinks).
3. Starting level: `interlinks.length − 1` of the **last pre-suffix**
   PoPowHeader.
4. Level walk, `level` from starting level down to `0`: collect the
   sub-chain of pre-suffix headers with `maxLevelOf(header) ≥ level` and
   `height ≥ anchoringPoint.height`; if the sub-chain has **more than** `m`
   entries, the anchoring point advances to `subChain[len − m]` for the
   next (lower) level; accumulate the sub-chain either way.
5. Prefix = accumulated headers, deduped by header id, sorted ascending by
   height. Assemble `NipopowProof { m, k, prefix, suffixHead, suffixTail }`
   — the existing type, serializable by the existing `serializeProof`.

The input chain is trusted contiguous-from-genesis with correct interlinks;
`prove` does not re-derive or re-check interlinks (JVM behavior).

### Layer 4 — Reader-based `proveWithReader()` (async)

```ts
interface PopowHeaderReader {
  headersHeight(): Promise<number>
  popowHeaderById(id: Uint8Array): Promise<PoPowHeader | null>
  popowHeaderAtHeight(height: number): Promise<PoPowHeader | null>
  lastHeaders(n: number): Promise<Header[]>
  bestHeadersAfter(header: Header, n: number): Promise<Header[]>
}

proveWithReader(
  reader: PopowHeaderReader,
  params: PoPowParams,
  headerId?: Uint8Array,
): Promise<NipopowProof>
```

Port of `NipopowProverWithDbAlgs.prove` — the **backward interlink walk**,
not sigma-rust's forward scan:

1. Gates: `m ≥ 1`, `k ≥ 1`, `headersHeight() ≥ m + k`.
2. Suffix: `headerId` given → `popowHeaderById(headerId)` is `suffixHead`,
   `bestHeadersAfter(suffixHead.header, k − 1)` is the tail; omitted →
   `lastHeaders(k)`, first becomes `suffixHead` (re-fetched as PoPowHeader
   by id), rest is the tail.
3. Genesis (height 1) is always seeded into the prefix set first.
4. Walk: from `suffixHead`'s interlinks take `interlinks.slice(1)`
   **reversed**, zipped with indices — the level-indexed back-pointers.
   Fold from the highest level down (JVM `foldRight` order, ported
   verbatim): at each `(pointerId, levelIdx)` follow same-level
   back-pointers backward (`collectLevel`): load the pointed-to
   PoPowHeader, stop when its height drops below the anchoring height or
   it has no pointer at `levelIdx`; collect visited headers (keyed by id).
   When a level collects **more than** `m` headers, the anchoring height
   for lower levels rises to `levelHeaders[len − m].height`.
5. Prefix = collected map values + genesis, deduped by height (JVM
   `storedHeights`), sorted ascending. Same assembly as Layer 3.
6. A required header the reader answers `null` for →
   `ProofBuildError('missing-popow-header')`. No silent partial proofs
   (mirrors the JVM's `.get`-inside-`Try`).

**Reader contract notes** (into `facts/`):

- `popowHeaderAtHeight(1)` / `popowHeaderById(genesisId)` MUST synthesize
  `interlinks = [genesisId]` (+ matching proof via `makePopowHeader`) —
  real on-chain genesis extensions are empty; unpacking them yields wrong
  (empty) interlinks. Same rule ergo-node-rust enforces, same gotcha
  already documented in CLAUDE.md.
- The reader is not trusted to be consistent: mismatched header/extension
  pairings surface as `missing-popow-header` or as connection-invalid
  proofs downstream, never as silent corruption.
- Complexity target: `O(m + k + m·log N)` header loads. The test suite
  asserts a load-count bound (Validation).

**Async is scoped, not viral:** the package contract's "no async surface"
invariant narrows to the verifier surface. Rationale: the reader variant
exists *for* demand-loading, and every real backend (IndexedDB, LevelDB,
REST) is async; a sync reader would force preloading, which is exactly
`prove()`. `prove()` stays sync.

**Equivalence guarantee:** `prove(chain, p)` and `proveWithReader(reader
over the same chain, p)` produce **byte-identical** proofs. Divergence is a
bug in one of them. This is a stated postcondition and a tested property.

## API surface & packaging

New subpath **`@ergots/nipopow/prover`** (pattern: existing `/envelope`).
Verifier-only consumers never load prover code. Exports: everything in
Layers 1–4 above, plus `ProofBuildError`.

New source modules: `src/prover.ts` (subpath entry: prove, proveWithReader,
reader interface), `src/interlinks.ts` (Layer 2), builder added to
`src/merkle.ts`, `maxLevelOf` to a shared internal `src/level.ts`
(imported by `compare.ts` and the prover; single definition). `ExtensionKV`
type (already in `merkle.ts`) is exported from the subpath.

### Error taxonomy addition

```ts
class ProofBuildError extends Error   // recoverable; construction input rejected
```

| code | thrown by | condition |
|---|---|---|
| `'invalid-m'` | prove, proveWithReader | `m < 1` |
| `'invalid-k'` | prove, proveWithReader | `k < 1` |
| `'chain-too-short'` | prove, proveWithReader | chain/height `< m + k` |
| `'non-anchored-chain'` | prove | `chain[0]` not height 1 |
| `'missing-popow-header'` | proveWithReader | reader returned `null` for a required header |
| `'empty-interlinks'` | updateInterlinks | non-genesis header with empty interlinks |
| `'malformed-interlinks'` | unpackInterlinks | interlink field value length ≠ 33 |

Same class conventions as the existing three: human-readable `.message`,
programmatic `.code`, exported from the subpath that raises it.

### `facts/nipopow.md` amendments (contract-first: Task 1 of the plan)

- Scope: "Proof construction — out of scope" flips to shipped; continuous
  mode explicitly listed as not-shipped (next unit).
- New "Prover surface" section: signatures, preconditions, `ProofBuildError`
  table, reader contract (genesis synthesis rule, null semantics,
  complexity), the equivalence + verifier-acceptance postconditions:
  every proof `prove`/`proveWithReader` returns passes `verifyParsedProof`
  (structural checks; PoW validity is a property of the input chain, not
  the prover) and round-trips byte-identically through
  `serializeProof`/`parseProof`.
- "Determinism and purity": sync/purity invariant scoped to the verifier
  surface; prover subpath documented async-capable (`proveWithReader`),
  still no clock/PRNG/`globalThis`.
- Version note 0.3.0.

## Validation strategy

`fixture-gen/` is frozen — anchors come from existing fixtures, JVM
vectors via the SANTA session, and live mainnet.

**Layer 1 (builder):** existing fixtures already carry the full leaf sets.
Every PoPowHeader across all 5 proof fixtures
(`nipopow_proof.json`: `packed_leaves_per_popow_header`,
`interlinks_roots_per_popow_header`, embedded `interlinksProof` bytes —
including the 39 real-mainnet headers) becomes a builder vector: rebuild
the tree from leaves → root byte-equals the stored root; extract the batch
proof for the interlink keys → byte-equals the stored proof bytes.
`batch_merkle.json` adds vectors where it carries full leaf sets.
Negatives: tamper a leaf → root mismatch; out-of-range indices → `null`.

**Layer 2 (interlinks):** pack/unpack round-trip properties + fixture
packed-leaves. For `updateInterlinks` + `maxLevelOf` (the float-log2 risk):
a **new committed fixture of consecutive mainnet headers + extensions**,
captured once by a one-shot script in `tools/` against a node REST API
(NOT fixture-gen), spanning at least one superblock (`prevLevel > 0`) so
the drop/fill path exercises. Test: unpack height h's real interlinks,
`updateInterlinks(h)`, byte-compare against height h+1's real unpacked
interlinks. Mainnet is ground truth for the level computation.
`proofForInterlinkVector`: recompute from fixture packed leaves →
byte-equals stored `interlinksProof`.

**Layer 3 (`prove`):** selection-level ground truth via **JVM vectors from
SANTA** (schema below): synthetic chains with JVM-computed interlinks +
expected proof bytes from `NipopowAlgos.prove` across (m, k) combos —
byte-compare our proof. The chain JSONs double as extra `updateInterlinks`
vectors (chain[i+1].interlinks vs ours). Self-consistency: TS-built chains
(our `updateInterlinks`) → `prove` → passes `verifyParsedProof`
(`checkPoW: false` — synthetic headers carry no real PoW) and round-trips
byte-identically. Existing fixtures' `prefix_heights` stay as-is (their
underlying chains are unrecoverable — frozen fixture-gen); JVM vectors
replace that role.

**Layer 4 (`proveWithReader`):** byte-equivalence with `prove()` on
identical chains across shapes and (m, k), via a trivial in-memory async
reader. Load-count assertion: reader calls `≪ N` (loose bound
`≤ c·(m + k + m·log₂ N)`) so an accidental full scan fails.
**Phase acceptance walk:** REST-backed `PopowHeaderReader` in `tools/`
(not shipped) against a live node; `proveWithReader` with pinned suffix
tip (`headerId`) byte-compared against the same node's
`/nipopow/proof/{m}/{k}/{headerId}` response — end-to-end against the
canonical JVM implementation on the real chain.

Cross-runtime as ever: vitest under node + jsdom.

### SANTA vector schema (request to the SANTA/JVM session)

One JSON file per chain:

```jsonc
{
  "label": "jvm-chain-32",
  "chain": [            // heights 1..N contiguous
    {
      "height": 1,
      "headerHex": "…",          // Scorex-serialized Header bytes
      "interlinks": ["…32-byte hex…", "…"]   // JVM updateInterlinks output
    }
  ],
  "cases": [
    { "m": 2, "k": 2, "headerId": null, "proofHex": "…" },   // tip proof
    { "m": 6, "k": 5, "headerId": null, "proofHex": "…" },
    { "m": 2, "k": 2, "headerId": "…hex…", "proofHex": "…" } // anchored (DbAlgs path)
  ]
}
```

`proofHex` = `NipopowProofSerializer` bytes, non-continuous. Tip cases from
`NipopowAlgos.prove`; anchored cases from `NipopowProverWithDbAlgs.prove`
(exercising the backward walk). Chain lengths ≥ 30 with enough superblock
variety that prefixes are non-trivial at m=2..6. Headers need not carry
valid PoW; both sides compute `powHit` over whatever bytes are there.

## Risks & confidence escalation

- **`maxLevelOf` float determinism.** Level = truncated difference of two
  float `log2`s (JVM `Math.log` semantics vs JS engine `Math.log`; both
  IEEE-754 doubles, sub-ulp implementation differences possible). A flip
  requires a pow-hit ulp-adjacent to an exact power-of-2 boundary —
  astronomically unlikely per header, but nonzero across a chain. The
  trunc-vs-floor zero-boundary case is handled by design (Layer 2:
  `Math.trunc`); what remains is pure sub-ulp `log2` divergence between
  engines. Existing `compare.ts` took the same risk (validated against all
  comparison fixtures, matching Rust f64); the mainnet consecutive-header
  fixture + JVM chain vectors extend that coverage to the construction
  path. Residual risk documented in facts; per-CLAUDE.md escalation fires
  if any vector disagrees.
- **scrypto tree layout** (odd-node promotion, empty/singleton trees).
  Fixture-decided (Layer 1 vectors span 1..39-leaf real trees). Escalate if
  any shape disagrees rather than patching to fit.
- **JVM walk indexing** (`interlinks.tail.reverse` level indexing in
  DbAlgs). Ported verbatim; the equivalence property with `prove()` plus
  anchored-case JVM vectors gate it. Escalate on divergence.

## Plan handoff

Implementation via writing-plans, TDD throughout. Task shape (per
docs-pass-every-phase: facts first, close-out last):

1. `facts/nipopow.md` prover-surface amendment (contract-first).
2. Layer 1: Merkle builder (fixture vectors red → green).
3. Layer 2: interlink layer + `tools/` mainnet-capture script + fixture.
4. Layer 3: `prove()` (SANTA vectors + self-consistency).
5. Layer 4: `proveWithReader` (equivalence + load-count) and the live-node
   acceptance walk.
6. Close-out: README/API docs, SESSION_CONTEXT/HANDOFF, version bump.

SANTA vector request goes out at spec approval so generation overlaps
implementation of Layers 1–2.
