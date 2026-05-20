# ergots

Pure-TypeScript port of `sigma-rust` (Ergo's reference implementation), targeting **consensus-critical correctness** — the long-term goal is a verification kernel capable of supporting an Ergo node. Browser-runnable, no WASM, no `Buffer`.

Modeled after [`frots`](https://github.com/mwaddip/frots): every primitive is validated byte-for-byte against Rust reference implementations (`ergo-nipopow`, `ergotree-ir`, `ergotree-interpreter`, `ergo_avltree_rust`) via captured fixtures. Where TypeScript output diverges from sigma-rust by even one byte, the corresponding fixture trips and the build fails.

## Packages

| Package | Status | What |
|---|---|---|
| `@ergots/scorex` | **local v0.2.0** (never published) | Shared Scorex wire codec: `ByteReader` / `ByteWriter` / VLQ + ZigZag VLQ / `ReaderError` (4 codes) + block-Header types (`Header`, `AutolykosSolution`, digest helpers) + Autolykos v2 PoW verifier (`verifyAutolykosV2`, `decodeCompactBits`, `AutolykosV1NotSupportedError`). 177 tests. Workspace dep of nipopow + ergoscript. |
| `@ergots/nipopow` | **local v0.2.1** (was published as `@mwaddip/ergots-proof@0.1.0` pre-rename) | NiPoPoW proof parse / serialize / verify / compare, P2P envelope codec. 245 tests. Workspace dep on `@ergots/scorex` (Autolykos v2 verifier consumed from there since v0.2.1). |
| `@ergots/avltree` | **local v0.2.0** (ready to publish) | Batch AVL+ authenticated-tree verifier (`verifyAvlBatch`, `verifyAvlBatchPartial`, `verifyAvlLookup`). 156 tests, 50 corpus fixtures, ≥ 90% mutation kill rate per `Operation` variant. |
| `@ergots/ergoscript` | **in active development** (local v0.3.x, pre-publish) | ErgoTree parser + serializer + partial evaluator + sigma-protocol verifier. **2922 tests.** 52 of ~70 `Expr` arms wired; **44-entry method-handler registry**; 48 `EvalError` codes. Wire format complete (incl. V3-gated SHeader literals); sigma-protocol verifier shipped (full `SigmaBoolean` surface incl. Cand/Cor/Cthreshold); AVL+ integration shipped via `@ergots/avltree` with the `SAvlTree.*` method surface now 16/16 complete; SHeader/Header method-call surface complete (incl. `checkPow`); `SColl.flatMap` + `SGroupElement.getEncoded` shipped (phase 2h-f Tier-3). Cost validation and remaining Expr arms (predefs, `Xor`, `ModQ` family, `Coll` shift/rotate) planned. |

Total tests across packages: **3500**, passing under both `node` and `jsdom` (cross-runtime).

A WebSocket gossip layer (`@ergots/gossip`) was considered and rejected — browsers cannot peer (no inbound, no raw TCP) and existing node REST endpoints cover what's needed. See [`docs/specs/2026-05-13-no-gossip-decision.md`](docs/specs/2026-05-13-no-gossip-decision.md).

## Scope and consensus caveats

These packages are **not yet a consensus-complete kernel**. They are an in-progress port with load-bearing TODOs called out below. Until each gap closes, combine with sigma-rust or a JVM node for any binding consensus decision.

- **`@ergots/nipopow`'s `verifyProof` is a structural + Autolykos-v2 verifier.** It validates proof framing, parent linkage, strictly-increasing heights, and each version ≥ 2 header's Autolykos v2 solution under that header's **self-declared** `nBits`. It does NOT validate `nBits` against the network's difficulty-adjustment rule, does NOT validate `header.version` against the network's hard-fork schedule, and does NOT anchor the proof to a trusted checkpoint. Full consensus header validation is a planned future phase.

- **`@ergots/ergoscript`'s `evaluate` is a partial interpreter** (52 of ~70 `Expr` arms wired today; 44-entry method-handler registry covering `SHeader.*` ×16 (incl. `checkPow`), `SContext.*` ×4, `SAvlTree.*` ×16 (full surface), `SColl.*` ×4 (incl. `flatMap`), `SGlobal.*` ×1, `SGroupElement.getEncoded`, `SBox.tokens`, `SPreHeader.timestamp`). Treat each evaluator success as "the inputs are structurally valid and the implemented arms passed."

- **`@ergots/ergoscript`'s `verifySignature` is the sigma-protocol verifier** — full `SigmaBoolean` surface (leaf + Cand/Cor/Cthreshold conjecture walks) shipped via `@noble/curves@2.2.0` and an internal GF(2^192) module. 8 `VerifyError` codes (3 currently reserved for ABI stability).

- **Cost validation is not yet calibrated against mainnet workloads.** Per-arm costs are sigma-rust-accurate (every commit asserts cost-integer-equal to `try_eval_out` oracle outputs), but Layer-C3 real-context calibration is deferred to phase 2j.

See each package's `API.md` and the `facts/*.md` files for load-bearing scope details before relying on a result.

## Layout

```
ergots/
├── packages/
│   ├── scorex/               @ergots/scorex
│   ├── nipopow/              @ergots/nipopow
│   ├── avltree/              @ergots/avltree
│   └── ergoscript/           @ergots/ergoscript
├── fixture-gen/              Rust crate — generates byte-for-byte test fixtures
├── facts/                    Interface contracts (load-bearing across packages)
│   ├── scorex.md
│   ├── nipopow.md
│   ├── avltree.md
│   ├── ergoscript.md         (meta hub)
│   ├── ergoscript-wire.md
│   ├── ergoscript-eval.md
│   └── ergoscript-sigma.md
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

A Rust `fixture-gen` crate at the repo root regenerates JSON + binary fixtures from `ergo-nipopow`, `ergotree-interpreter`'s `try_eval_out` oracle, and `ergo_avltree_rust` directly. TS tests assert byte-equality (or value-equality + cost-integer-equality for evaluator fixtures) at every layer. Determinism is a load-bearing invariant — `cargo run -p fixture-gen` twice in a row must produce byte-identical output.

Mutation testing (single-byte flips at every offset) targets ≥ 90% kill rate per fixture for the wire-format and AVL+ surfaces. The evaluator's per-arm cost charges and SValue returns are tested against sigma-rust oracle outputs for each arm.

## Quick start

```bash
npm install
npm test                    # vitest across all packages (node + jsdom)
npx tsc --noEmit            # per-package; must be clean

# Regenerate fixtures (requires Rust toolchain + sigma-rust branch integration/ergots):
cd fixture-gen && cargo run --release
```

## License

MIT
