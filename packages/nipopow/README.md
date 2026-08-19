# @ergots/nipopow

Pure-TypeScript Ergo NiPoPoW proof verifier and prover. Browser-compatible. The verifier is validated byte-for-byte against `ergo-nipopow` (sigma-rust); the prover (new in 0.3.0) is validated against the JVM Ergo node, the canonical reference for proof construction.

## Install

```bash
npm install @ergots/nipopow
```

## Usage

```ts
import { verifyProof, parseProof, compareProofs } from '@ergots/nipopow';

const proofBytesA: Uint8Array = /* first proof from peer A */;
const proofBytesB: Uint8Array = /* second proof from peer B */;

// Verify (default checks Autolykos v2 PoW per header):
const result = verifyProof(proofBytesA);
console.log(result.suffixTipHeight, 'headers in proof:', result.totalHeaders);

// Or parse without verification:
const proof = parseProof(proofBytesA);

// Compare two proofs from different peers to pick the better one.
// compareProofs ranks structure + linkage only — it does NOT verify PoW.
// Verify BOTH proofs before trusting the winner:
verifyProof(proofBytesA);
verifyProof(proofBytesB);
const aIsBetter = compareProofs(proofBytesA, proofBytesB);
```

See [API.md](./API.md) for the full reference (every export, its signature, error codes, and type definitions).

## P2P envelope codec

The wire envelope for Ergo's P2P message codes 90 (`GetNipopowProof`) and 91 (`NipopowProof`) ships under a subpath:

```ts
import {
  parseGetNipopowProof,
  serializeNipopowProofEnvelope,
  GET_NIPOPOW_PROOF,
  NIPOPOW_PROOF,
} from '@ergots/nipopow/envelope';
```

## Proof construction

The `/prover` subpath (new in 0.3.0) adds proof *construction* alongside the
verifier: `prove` (synchronous, in-memory — a port of the JVM's
`NipopowAlgos.prove`) and `proveWithReader` (async, demand-loaded through a
caller-implemented `PopowHeaderReader` — a port of
`NipopowProverWithDbAlgs.prove`, the algorithm a live JVM node actually runs
to serve `GET /nipopow/proof/{m}/{k}`), plus the building blocks both are
built from: interlink maintenance (`updateInterlinks`, `packInterlinks`,
`unpackInterlinks`, `proofForInterlinkVector`, `makePopowHeader`,
`maxLevelOf`) and Merkle tree construction (`MerkleTree`,
`buildExtensionTree`). **The JVM Ergo node is the canonical reference for
this surface** (sigma-rust has no prover of its own) — see
[API.md](./API.md) for the per-function reference and `facts/nipopow.md` in
the repo root for the full contract.

```ts
import { prove, proveWithReader, makePopowHeader, updateInterlinks } from '@ergots/nipopow/prover';

// In-memory, from a chain you already hold (PoPowHeader[] anchored at
// genesis; maintain it incrementally via updateInterlinks + makePopowHeader):
const proof = prove(chain, { m: 6, k: 6 });

// Demand-loaded over your own storage/RPC — this is the one that mirrors
// what a live node serves; see API.md for the PopowHeaderReader interface:
const proof2 = await proveWithReader(reader, { m: 6, k: 6 });
```

`prove` and `proveWithReader` are **not** byte-identical on real chains —
they select different, individually-valid prefixes (`proveWithReader` is the
one a real node's output matches; see `facts/nipopow.md`'s `proveWithReader`
entry for the exact predicate). Both support continuous-mode construction
(`{ ..., continuous: true }`) — see "Continuous mode" below for what that
means and how it's validated against a live node.

### Wire dialect note (0.3.0)

0.3.0 switches the wire codec from the sigma-rust proof dialect to the JVM's:
every proof now carries a required trailing `continuous` byte
(`NipopowProof.continuous: boolean`, strict `0`/`1`). Proof bytes produced by
`@ergots/nipopow@0.2.x` (or by sigma-rust's own codec, which omits this byte)
are one byte short of what 0.3.0's `parseProof` expects and will fail with
`'truncated'`; append a single `0x00` byte to upgrade them (they were always
implicitly non-continuous). See `facts/nipopow.md` "Limitations" for the full
finding — this is an upstream sigma-rust bug candidate, not an ergots defect.

## Continuous mode

NiPoPoW proofs can carry a `continuous: boolean` flag (NIP-12). A continuous
proof additionally commits to the difficulty-recalculation headers needed to
check the chain's difficulty adjustments across the proof's span (JVM
`NipopowProverWithDbAlgs.scala:93-105` / `NipopowProof.scala:82-105`); a
non-continuous proof carries none of that extra data. Every live JVM Ergo
node serves continuous-mode proofs unconditionally — `GET
/nipopow/proof/{m}/{k}` has no request parameter to ask for
`continuous = false` — so continuous-mode support is what lets this
package's verifier and prover interoperate with a real node's REST endpoint,
not only with proofs it constructs for itself.

As of 0.4.0, `verifyProof`/`verifyParsedProof` accept `continuous: true`
proofs (subject to the difficulty-header membership check below), and
`prove`/`proveWithReader` can build one via `{ ..., continuous: true }`.
This was validated directly against a live mainnet node
(`tools/nipopow-capture/live-walk.mjs --expect-full-identity`): raw
byte-identity against the node's own served proof for two parameter sets,
plus `verifyProof(rawLiveBytes, { checkPoW: true })` succeeding directly on
the unmodified live response — see `facts/nipopow.md`'s "Live-endpoint
byte-identity" entry for the full acceptance record.

`epochLength`/`useLastEpochs` govern which heights count as
difficulty-recalculation heights (JVM `DifficultyAdjustment.scala:27-55`).
`VerifyOptions`, `PoPowParams`, and `compareProofs`'s third argument all
accept them as optional overrides; when omitted they default to
`EPOCH_LENGTH_MAINNET` (128) and `USE_LAST_EPOCHS_MAINNET` (8) — the
mainnet/testnet values. An invalid override (non-integer, or outside the
range the JVM's own `DifficultyAdjustment` constructor accepts) throws
`RangeError`, resolved before any proof or parameter is otherwise inspected.

`prove()`'s continuous-mode support is a **deliberate divergence** from its
own JVM reference: the JVM's `NipopowAlgos.prove` stamps `continuous` into
the proof it returns without injecting any difficulty headers, producing a
proof its own verifier would reject — the JVM source labels this function
"paper-like code used in tests only." `prove({ ..., continuous: true })`
instead injects the same needed-heights set `proveWithReader` injects, so
its output is always self-valid. See `facts/nipopow.md`'s `prove` entry for
the full reasoning.

### Migrating from 0.3.x

- `'continuous-unsupported'` no longer exists. A continuous proof now either
  verifies successfully or fails with `'missing-difficulty-headers'`
  (thrown after connections/interlinks/heights/PoW all pass, when a needed
  difficulty-recalculation height is absent from the header chain).
- `VerificationResult.continuous` is now `boolean` (0.3.0's type said
  `false` unconditionally). It echoes `proof.continuous` — a
  successfully-verified proof's `continuous` can now be either value.
- `PoPowParams` (the `/prover` subpath) gained three optional fields:
  `continuous?: boolean` (default `false`), `epochLength?: number`,
  `useLastEpochs?: number`. Omitting all three reproduces 0.3.0's behavior
  exactly.

## Browser compatibility

Runs unchanged in evergreen browsers and Node >= 20. No `Buffer`, no `node:crypto`, no dynamic Node built-ins. ESM-only.

The verifier is stateless: bytes in, structured result out. It does not fetch proofs, persist headers, or follow the chain tip — those concerns live in the future wallet / transaction-broadcaster package.

## What this package does NOT do

- **Difficulty-value arithmetic.** `hasValidDifficultyHeaders` checks that the needed difficulty-recalculation headers are *present* in a continuous proof; it does not compute the actual required-difficulty value from them (`bitcoinCalculate`/`eip37Calculate`/`interpolate` are not ported — the JVM proof-verifier itself never runs that arithmetic either).
- **Transport.** Callers fetch proofs over their own channel.
- **Storage.** No header chain, no IndexedDB.
- **Light-client sync.** Bootstrapping from a verified proof + following the tip lives in the future wallet / transaction-broadcaster package (phase 3).

## Verification scope

- NiPoPoW proof structure (parse + serialize + round-trip)
- Parent-linkage connections (`hasValidConnections` semantics, a `useLastEpochs + 3`-entry lookback window — 11 entries at the mainnet/testnet default)
- Strict-increasing heights across the proof
- Per-header Autolykos v2 PoW (version 1 headers are structurally accepted; v1 PoW is not verified, mirroring sigma-rust's `Unsupported` behavior)
- Continuous-mode difficulty-recalculation header membership (vacuous for non-continuous proofs — see "Continuous mode" above)
- Pairwise comparison (KMZ17 §4.3 `is_better_than`)

## Reference implementation

This package is a clean-room TypeScript port of `ergo-nipopow` from [sigma-rust](https://github.com/ergoplatform/sigma-rust). Every primitive is validated byte-for-byte against fixtures generated by the Rust reference, including 5 real mainnet headers and 1 real mainnet NiPoPoW proof from `ergo-node-rust`.

The `/prover` subpath is different: it's a clean-room port of the **JVM Ergo node** (`NipopowAlgos.scala`, `NipopowProverWithDbAlgs.scala`) — sigma-rust has no prover of its own. Validated against 90 fixture trees across 5 header-chain fixtures (50 from synthetic chains, 40 from a real-mainnet capture), plus the 21-height real-mainnet consecutive fixture, 8 JVM-generated ("SANTA") proof vectors, and two live-mainnet acceptance walks against a running Ergo node's own `/nipopow/proof/{m}/{k}` REST endpoint.

Continuous-mode support (0.4.0) is validated the same way: the epoch-math
functions against a 49-row JVM `DifficultyAdjustment` truth table
(`test/fixtures/jvm_difficulty/epoch-math-truth-table.json`), and
`hasValidDifficultyHeaders`/`compareProofs`/wire round-trip against 6
JVM-computed continuous-mode vectors
(`test/fixtures/jvm_continuous/vectors.json`), plus the live-mainnet
`--expect-full-identity` acceptance walk described above. Like
`jvm_prover/`, both `jvm_difficulty/` and `jvm_continuous/` are SANTA JVM
deliveries — hand-computed from the JVM reference, not output from the
(frozen) `fixture-gen` Rust crate.

## License

MIT
