# ergots

Pure-TypeScript port of `sigma-rust` (Ergo's reference implementation), targeting **consensus-critical correctness** — the long-term goal is a verification kernel capable of supporting an Ergo node. Browser-runnable, no WASM, no `Buffer`.

Modeled after [`frots`](https://github.com/mwaddip/frots): every primitive is validated byte-for-byte against Rust reference implementations (`ergo-nipopow`, `ergotree-ir`, `ergotree-interpreter`, `ergo_avltree_rust`) via captured fixtures. Where TypeScript output diverges from sigma-rust by even one byte, the corresponding fixture trips and the build fails.

## Packages

| Package | Status | What |
|---|---|---|
| `@ergots/scorex` | **v0.2.0** (npm: v0.1.0; republish at v6 delivery) | Shared Scorex wire codec: `ByteReader` / `ByteWriter` / VLQ + ZigZag VLQ / `ReaderError` (4 codes) + block-Header types (`Header`, `AutolykosSolution`, digest helpers) + Autolykos v2 PoW verifier (`verifyAutolykosV2`, `decodeCompactBits`, `AutolykosV1NotSupportedError`) + Autolykos-2 hit core (`autolykosHitForMessage`, `autolykosHitForMessageWithChecks`, `int32BE`, `PowHitInvalidParamsError`) added in v6 P5c. 187 tests. Workspace dep of nipopow + ergoscript. |
| `@ergots/nipopow` | **published v0.2.0** (supersedes the pre-rename `@mwaddip/ergots-proof@0.1.0`) | NiPoPoW proof parse / serialize / verify / compare, P2P envelope codec. 247 tests. Workspace dep on `@ergots/scorex` (Autolykos v2 verifier consumed from there since the scorex extraction). |
| `@ergots/avltree` | **published v0.2.0** | Batch AVL+ authenticated-tree verifier (`verifyAvlBatch`, `verifyAvlBatchPartial`, `verifyAvlLookup`). 156 tests, 50 corpus fixtures, ≥ 90% mutation kill rate per `Operation` variant. |
| `@ergots/ergoscript` | **published v0.3.0** (active development; v6 + conformance work on branch `ergoscript-v6`, one PR to `master` at v6 delivery) | ErgoTree parser + serializer + partial evaluator + sigma-protocol verifier. **4284 tests.** 67 of 67 implementable `Expr` arms wired (19 wire opcodes — ModQ family, OpTrue/False, UnitConstant, Select1-5, CollShift/Rotate families, FunDef, SomeValue, NoneValue — are reserved-but-never-dispatched in sigma-rust and parse-reject via `'opcode-reserved'`; 4 more route through other dispatch paths and parse-reject via `'not-implemented-yet'`); **128-entry method-handler registry**; **82 `EvalError` codes**. Wire format complete (incl. V3-gated SHeader literals); sigma-protocol verifier shipped (full `SigmaBoolean` surface incl. Cand/Cor/Cthreshold); AVL+ integration shipped via `@ergots/avltree` with the `SAvlTree.*` method surface now 16/16 complete; SHeader/Header method-call surface complete (incl. `checkPow`); `SColl.flatMap` + `SGroupElement.getEncoded` shipped (phase 2h-f Tier-3). Pure-bytes predefs shipped (phase 2i-a): `DecodePoint`, `SubstConstants`, `CalcBlake2b256`, `CalcSha256`, `ByteArrayToLong`, `ByteArrayToBigInt`, `LongToByteArray`, `Xor`. Curve + AVL + sigma-trivial predefs shipped (phase 2i-b): `MultiplyGroup`, `Exponentiate`, `CreateAvlTree`, `TreeLookup`, `SigmaPropIsProven`. Deserialize family shipped (phase 2i-c) via substitute-pre-pass architecture: `DeserializeContext`, `DeserializeRegister`. Phase 2i-d (arm-count reframe + DecodePoint divergence centralized) closed the open denominator question. **Phase 2j cost validation is complete** — the `tools/mainnet-validate/` harness walked h=2 → tip (h=1,797,470) with every tx-input's JIT cost matched byte-for-byte against the sigma-rust oracle, zero unhandled halts (31 divergences found + fixed, plus a JVM-alignment lockstep). v5 language methods `GroupElement.negate` / `Coll.updated` / `Coll.updateMany` shipped (v0.3.0), and the evaluator passes a JVM-blessed conformance suite (`sigma-state` 6.0.3, v5 semantics) with **zero divergences**. **ErgoTree V3 (v6) method surface P0–P7a landed:** type-var substitution engine (P0); numeric V3 methods — bitwise/shifts/toBits/toBytes on all 5 numeric types (P1); `SUnsignedBigInt` type, methods, casts, arithmetic, ordering/equality, modular ops incl. `modInverse`, and `BigInt.toUnsigned`/`UnsignedBigInt.toSigned` bridges (P2a–P2d); Coll V3 methods — `reverse`/`startsWith`/`endsWith`/`get` (P3); `Global.some`/`none` + empty-args MethodCall V3 reject (P4); `Global.serialize`/`deserializeTo`/`fromBigEndianBytes`/`encodeNbits`/`decodeNbits`/`powHit` (P5); HOF lambdas + lexical closures (P6); per-type methods `Box.getReg`/`Context.getVarFromInput`/`GroupElement.expUnsigned` (P7a). All V3-gated (`treeVersion >= 3`). **Adversarial-conformance run F1–F5 (validated against JVM-blessed SANTA vectors) then closed every eval-tier divergence vs the JVM `sigma-state` reference** — Header/Context accessor faithfulness (`stateRoot`→AvlTree, `powOnetimePk`→generator, independent `lastBlockUtxoRootHash`, the SPreHeader accessors) and a family of adversarial over-accept gates (checkType non-pair-tuple/non-unary-func value types, SelectField non-pair, rule-1012 header size-bit across all 3 ErgoTree ingresses, rule-1019 v6-typed box registers); ergots leads sigma-rust toward the JVM on several. Remaining v6: P7b (behavior-change methods) + P8 (validation). The 4 routed-elsewhere opcodes' top-level direct-dispatch status remains under separate review. |

Total tests across packages: **4455**, passing under both `node` and `jsdom` (cross-runtime).

A WebSocket gossip layer (`@ergots/gossip`) was considered and rejected — browsers cannot peer (no inbound, no raw TCP) and existing node REST endpoints cover what's needed. See [`docs/specs/2026-05-13-no-gossip-decision.md`](docs/specs/2026-05-13-no-gossip-decision.md).

## Scope and consensus caveats

These packages are **not yet a consensus-complete kernel**. They are an in-progress port with load-bearing TODOs called out below. Until each gap closes, combine with sigma-rust or a JVM node for any binding consensus decision.

- **`@ergots/nipopow`'s `verifyProof` is a structural + Autolykos-v2 verifier.** It validates proof framing, parent linkage, strictly-increasing heights, and each version ≥ 2 header's Autolykos v2 solution under that header's **self-declared** `nBits`. It does NOT validate `nBits` against the network's difficulty-adjustment rule, does NOT validate `header.version` against the network's hard-fork schedule, and does NOT anchor the proof to a trusted checkpoint. Full consensus header validation is a planned future phase.

- **`@ergots/ergoscript`'s `evaluate` is a partial interpreter** (67 of 67 implementable `Expr` arms wired today, post-2i-d reframe; 19 reserved-but-never-dispatched opcodes parse-reject via `'opcode-reserved'`; 4 routed-elsewhere opcodes parse-reject via `'not-implemented-yet'`; **128-entry method-handler registry** covering the full v5 surface plus the V3-gated v6 P0–P7a methods). Treat each evaluator success as "the inputs are structurally valid and the implemented arms passed."

- **`@ergots/ergoscript`'s `verifySignature` is the sigma-protocol verifier** — full `SigmaBoolean` surface (leaf + Cand/Cor/Cthreshold conjecture walks) shipped via `@noble/curves@2.2.0` and an internal GF(2^192) module. 8 `VerifyError` codes (3 currently reserved for ABI stability).

- **Cost validation has been run against the full mainnet chain.** Per-arm costs are sigma-rust-accurate (every commit asserts cost-integer-equal to `try_eval_out` oracle outputs), and the `tools/mainnet-validate/` harness has since walked **h=2 → tip (h=1,797,470)** comparing every tx-input's JIT cost byte-for-byte against the sigma-rust WASM oracle with **zero unhandled divergences** — 31 cost/semantics issues were surfaced and fixed en route, plus a JVM-alignment lockstep. Separately, the evaluator passes a JVM-blessed conformance suite (`sigma-state` 6.0.3, v5 language semantics) with **zero divergences** — i.e. full v5 conformance against the JVM reference. Blocks mined after that walk are not yet re-validated (a continuous-tracking mode is a possible follow-up).

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
npm run build               # build all workspaces in dep order (cross-workspace types resolve to dist)
npm test                    # vitest across all packages (node + jsdom)
npm run typecheck           # per-package tsc --noEmit; must be clean

# Regenerate fixtures (requires Rust toolchain + sigma-rust branch integration/ergots):
cd fixture-gen && cargo run --release
```

## License

MIT
