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
entry for the exact predicate). Neither produces a continuous-mode proof.
Because a live JVM node's REST endpoint *always* serves continuous-mode
proofs (no way to ask for otherwise) and this package doesn't implement
continuous mode yet, `verifyProof` currently rejects every proof fetched
from a live node with `'continuous-unsupported'` — closing that gap is the
next planned unit.

### Wire dialect note (0.3.0)

0.3.0 switches the wire codec from the sigma-rust proof dialect to the JVM's:
every proof now carries a required trailing `continuous` byte
(`NipopowProof.continuous: boolean`, strict `0`/`1`). Proof bytes produced by
`@ergots/nipopow@0.2.x` (or by sigma-rust's own codec, which omits this byte)
are one byte short of what 0.3.0's `parseProof` expects and will fail with
`'truncated'`; append a single `0x00` byte to upgrade them (they were always
implicitly non-continuous). See `facts/nipopow.md` "Limitations" for the full
finding — this is an upstream sigma-rust bug candidate, not an ergots defect.

## Browser compatibility

Runs unchanged in evergreen browsers and Node >= 20. No `Buffer`, no `node:crypto`, no dynamic Node built-ins. ESM-only.

The verifier is stateless: bytes in, structured result out. It does not fetch proofs, persist headers, or follow the chain tip — those concerns live in the future wallet / transaction-broadcaster package.

## What this package does NOT do

- **Continuous-mode proofs.** Neither the verifier nor the prover implements NIP-12's continuous mode yet — see "Proof construction" above. Planned follow-up unit.
- **Transport.** Callers fetch proofs over their own channel.
- **Storage.** No header chain, no IndexedDB.
- **Light-client sync.** Bootstrapping from a verified proof + following the tip lives in the future wallet / transaction-broadcaster package (phase 3).

## Verification scope

- NiPoPoW proof structure (parse + serialize + round-trip)
- Parent-linkage connections (sigma-rust's `has_valid_connections` semantics, 11-entry lookback window)
- Strict-increasing heights across the proof
- Per-header Autolykos v2 PoW (version 1 headers are structurally accepted; v1 PoW is not verified, mirroring sigma-rust's `Unsupported` behavior)
- Pairwise comparison (KMZ17 §4.3 `is_better_than`)

## Reference implementation

This package is a clean-room TypeScript port of `ergo-nipopow` from [sigma-rust](https://github.com/ergoplatform/sigma-rust). Every primitive is validated byte-for-byte against fixtures generated by the Rust reference, including 5 real mainnet headers and 1 real mainnet NiPoPoW proof from `ergo-node-rust`.

The `/prover` subpath is different: it's a clean-room port of the **JVM Ergo node** (`NipopowAlgos.scala`, `NipopowProverWithDbAlgs.scala`) — sigma-rust has no prover of its own. Validated against 90 synthetic test-chain fixtures, a 21-height real-mainnet fixture, 8 JVM-generated ("SANTA") proof vectors, and two live-mainnet acceptance walks against a running Ergo node's own `/nipopow/proof/{m}/{k}` REST endpoint.

## License

MIT
