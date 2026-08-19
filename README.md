# ergots

Pure-TypeScript port of `sigma-rust` (Ergo's reference implementation), targeting **consensus-critical correctness** — the long-term goal is a verification kernel capable of supporting an Ergo node. Browser-runnable, no WASM, no `Buffer`.

Modeled after [`frots`](https://github.com/mwaddip/frots): every primitive is validated byte-for-byte against reference implementations via captured fixtures — the Rust crates (`ergo-nipopow`, `ergotree-ir`, `ergotree-interpreter`, `ergo_avltree_rust`) for the original corpus, and, for newer surfaces, vectors generated from the JVM references (`sigma-state`, the `ergo` node) plus live-mainnet acceptance runs. Where TypeScript output diverges from a reference by even one byte, the corresponding fixture trips and the build fails. Where the references disagree with each other, the JVM (the consensus authority) wins, and the divergence is documented in `facts/`.

## Packages

| Package | Version | What it does |
|---|---|---|
| `@ergots/scorex` | 0.3.0 | Shared Scorex wire codec — `ByteReader` / `ByteWriter`, VLQ and ZigZag-VLQ integers, block-header types (`Header`, `AutolykosSolution`, digest helpers), and the Autolykos v2 proof-of-work verifier (`verifyAutolykosV2`, `decodeCompactBits`). Consumed by `@ergots/nipopow` and `@ergots/ergoscript`. 216 tests. |
| `@ergots/nipopow` | 0.4.0 | NiPoPoW (Non-Interactive Proofs of Proof-of-Work) — proof parse / serialize / verify / compare, a prover (`prove` in-memory, `proveWithReader` demand-loaded — the production path live nodes run), and the peer-to-peer envelope codec. Speaks the JVM wire dialect and supports continuous-mode proofs (difficulty-recalculation header injection + verification) — verifies what live nodes actually serve, with a raw byte-identity acceptance gate against a real mainnet node. 359 tests. |
| `@ergots/avltree` | 0.4.0 | Batch AVL+ authenticated-tree verifier + prover. Verifier: `verifyAvlBatch` / `verifyAvlLookup`, mutation-tested fixture corpus against the Rust reference. Prover: `BatchAVLProver` (in-memory tree construction + proof generation), `PersistentBatchAVLProver` (versioned storage wrapper with rollback), `VersionedAVLStorage` interface. Prover proofs validated byte-for-byte against 10 Rust-generated fixtures. 374 tests. |
| `@ergots/ergoscript` | 0.5.0 | ErgoTree parser, serializer, evaluator, and sigma-protocol verifier. Parses and re-serializes the full ErgoTree wire format byte-for-byte; evaluates scripts — every implementable expression form, plus an extensive method surface covering both the v5 language and the v6 (ErgoTree V3) additions — with execution costs matched to the reference; verifies sigma-protocol propositions (Schnorr and Diffie-Hellman leaves, AND / OR / threshold conjectures) via `@noble/curves`; and checks authenticated AVL+ operations through `@ergots/avltree`. 6479 tests. |
| `@ergots/transaction` | 0.1.0 | Ergo transaction wire codec + validation logic. Parses and serializes Ergo transactions byte-for-byte against the reference; validates transaction structure, box state transitions, storage rent, and block-cost limits. Depends on `@ergots/ergoscript` for script evaluation. 64 tests. |

All five packages are published to npm under the `@ergots/*` scope.

Total tests across packages: **7492**, passing under both `node` and `jsdom` (cross-runtime).

A WebSocket gossip layer (`@ergots/gossip`) was considered and rejected — browsers cannot peer (no inbound, no raw TCP) and existing node REST endpoints cover what's needed. See [`docs/specs/2026-05-13-no-gossip-decision.md`](docs/specs/2026-05-13-no-gossip-decision.md).

## Scope and consensus caveats

These packages are **not yet a consensus-complete kernel**. They are an in-progress port with load-bearing TODOs called out below. Until each gap closes, combine with sigma-rust or a JVM node for any binding consensus decision.

- **`@ergots/nipopow`'s `verifyProof` is a structural + Autolykos-v2 verifier.** It validates proof framing, parent linkage, strictly-increasing heights, each version ≥ 2 header's Autolykos v2 solution under that header's **self-declared** `nBits`, and — since 0.4.0 — continuous-mode difficulty-header **membership** (the JVM's `hasValidDifficultyHeaders`: the headers needed to recompute post-suffix difficulty must be present in the proof). It does NOT recompute difficulty (`nBits` is not validated against the network's difficulty-adjustment rule — the included headers make that possible for a client, but the arithmetic is a future unit), does NOT validate `header.version` against the network's hard-fork schedule, and does NOT anchor the proof to a trusted checkpoint. Full consensus header validation is planned for a future release.

- **`@ergots/ergoscript`'s `evaluate` is a partial interpreter.** It covers every implementable expression form and an extensive method surface spanning both the v5 language and the v6 (ErgoTree V3) additions; the few opcodes the reference implementation reserves but never executes are rejected at parse. Treat each evaluator success as "the inputs are structurally valid and the implemented operations passed."

- **`@ergots/ergoscript`'s `verifySignature` is the sigma-protocol verifier** — the full `SigmaBoolean` surface (Schnorr and Diffie-Hellman leaves plus AND / OR / threshold conjectures), built on `@noble/curves` and an internal GF(2^192) module.

- **Execution costs are validated against the full mainnet chain.** The evaluator has been walked from genesis to the chain tip, comparing every transaction input's execution cost against the `sigma-rust` reference, with zero unresolved divergences. Separately, it passes a conformance suite blessed by the JVM `sigma-state` reference (v5 language semantics), also with zero divergences. Blocks mined after that walk have not been re-validated.

See each package's `API.md` and the `facts/*.md` files for load-bearing scope details before relying on a result.

## Layout

```
ergots/
├── packages/
│   ├── scorex/               @ergots/scorex
│   ├── nipopow/              @ergots/nipopow
│   ├── avltree/              @ergots/avltree
│   ├── ergoscript/           @ergots/ergoscript
│   └── transaction/          @ergots/transaction
├── fixture-gen/              Rust crate — generated the original fixture corpus (now frozen)
├── tools/                    Dev-only harnesses (not published, may use WASM as a cost oracle)
│   ├── mainnet-validate/     Full-chain walker: validates evaluator costs vs the reference
│   └── nipopow-capture/      Live-node proof capture + byte-identity acceptance walks
├── facts/                    Interface contracts (load-bearing across packages)
│   ├── scorex.md
│   ├── nipopow.md
│   ├── avltree.md
│   ├── ergoscript.md         (meta hub)
│   ├── ergoscript-wire.md
│   ├── ergoscript-eval.md
│   ├── ergoscript-sigma.md
│   └── transaction.md
└── docs/
    └── specs/                Design specs (the *why* and *how-we-chose*)
```

## Project identity / non-goals

The pure-TypeScript stance is the project identity, not a default. Substituting WASM bindings (`ergo-lib-wasm-*`, `sigma-rust-wasm`, or any transitive WASM dependency) defeats the reason these packages exist — a browser-first verification path that does not require a binary blob to anchor trust. Audit any new dependency for transitive WASM before adding.

- **No `Buffer`** anywhere in `packages/*/src/`. `Uint8Array` only.
- **No `process`, `fs`, `path`, `os`, `node:*`** outside test files.
- **No `node:crypto` / `globalThis.crypto.subtle`.** Hashing comes from `@noble/hashes@2.2.0` only; secp256k1 from `@noble/curves@2.2.0`.
- **ESM only.** No CJS exports.
- **No top-level await** in published code.
- **No WASM** direct or transitive.

## Validation strategy

The original fixture corpus was generated by the Rust `fixture-gen` crate at the repo root (from `ergo-nipopow`, `ergotree-interpreter`'s evaluator oracle, and `ergo_avltree_rust` directly); its committed fixtures remain canonical, but the crate itself is **frozen** (2026-06) — its pinned sigma-rust branch has drifted and it is not expected to build cleanly anymore. Newer surfaces are validated against JVM-generated vectors — the `sigma-state` conformance corpus under `packages/ergoscript/test/conformance/`, and the prover / epoch-math / continuous-mode vectors under `packages/nipopow/test/fixtures/jvm_*/` — and against live-mainnet acceptance runs (`tools/`). TS tests assert byte-equality (or value-equality + cost-integer-equality for evaluator fixtures) at every layer.

Mutation testing (single-byte flips at every offset) targets ≥ 90% kill rate per fixture for the wire-format and AVL+ surfaces. The evaluator's per-operation cost charges and return values are tested against reference oracle outputs.

## Quick start

```bash
npm install
npm run build               # build all workspaces in dep order (cross-workspace types resolve to dist)
npm test                    # vitest across all packages (node + jsdom)
npm run typecheck           # per-package tsc --noEmit; must be clean
```

(Fixtures are committed; there is nothing to regenerate for a normal build/test cycle. `fixture-gen/` is frozen — see Validation strategy.)

## License

MIT
