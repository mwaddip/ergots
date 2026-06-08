# `@ergots/ergoscript` — Interface Contract (Meta)

This is the **meta hub** for the `@ergots/ergoscript` boundary contract. Cross-cutting guarantees (browser-compat, determinism, package shape, error-model overview, test-corpus layout) live here. For surface-specific contracts (public API, types, error codes, per-handler semantics) see the slice files below.

## Scope

Pure-TypeScript port of sigma-rust's `ergotree-ir` and `ergotree-interpreter` crates, validated byte-for-byte and value-for-value against the `integration/ergots` branch. Ships in three layered surfaces — wire format (parse + serialize), evaluator (`evaluate` + `EvalContext`), and sigma-protocol verifier (`verifySignature`) — with future layers planned for AVL+ membership-proof verification (phase 2h) and cost validation (phase 2j). The package is browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`, no WASM. ESM only. The package has not been `npm publish`-ed; downstream consumers in the monorepo currently import it through the workspace alias. Anything not in this document or its slice files is implementation detail and may change without notice.

Authoritative source-of-truth for wire-format byte layout and evaluator semantics: sigma-rust at `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`). Where this file or a slice file is silent, sigma-rust is canonical.

## Where to find what

| Concern | File |
|---|---|
| Wire format (`parseTree`, `serializeTree`, address helpers, `ErgoTree` / `TreeHeader` types, wire-layer error classes incl. `ErgoTreeParseError`/`SerializeError` and `SigmaBooleanParseError`) | [`facts/ergoscript-wire.md`](./ergoscript-wire.md) |
| Evaluator surface (`evaluate`, `evaluateWith`, `makeContext`, `EvalError` 80 codes, `SValue` / `SType` / `Expr` discriminated unions [canonical], eval arm coverage 67/67 implementable + 19 reserved + 4 routed-elsewhere, 128-entry method-handler registry, `EvalOpts` chain-state fields, substitute-pre-pass for Deserialize* arms, `validateV6Types` pre-eval pass for v6 type gating) | [`facts/ergoscript-eval.md`](./ergoscript-eval.md) |
| Sigma-protocol verifier (`verifySignature`, `SigmaBoolean` 6-variant union, `VerifyError` 8 codes, internal-helper modules — GF(2^192), secp256k1 adapter, Fiat-Shamir) | [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) |
| AVL+ membership proofs (`verifyMembershipProof`, `lookupInTree`) | (future, phase 2h) |
| Cost-equivalence (read `ctx.jitCost` after `evaluateWith(tree, ctx)`) | infrastructure landed in phase 2j-a via the mainnet-validate harness; per-arm calibration ongoing in 2j-b/c/... per [`tools/mainnet-validate/findings/`](../tools/mainnet-validate/findings/) |

## Cross-cutting guarantees

### Determinism and purity

- All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output.
- No async surface. Every function is synchronous. (Rationale: the parser hits VLQ loops and blake2b in tight inner sections; the evaluator runs cost-charging in hot paths; the async boundary would only add overhead.)
- No throwing on success paths. Throws indicate contract violations or input rejection — they're the typed failure surface.

### Browser-compat

Runtime support: Node ≥ 20, evergreen browsers with native ESM. Specifically:

- All Uint8Arrays. Never `Buffer`. (`Buffer.from(...)` does not exist in browsers.)
- `globalThis.crypto` is not used. Hashing comes from `@noble/hashes` only; secp256k1 curve operations come from `@noble/curves` (phase 2g-medium+). Both are browser-clean ESM packages.
- `bigint` is used for `SLong`, `SBigInt`, cost values, and 64-bit-safe VLQ reads. Browsers support `bigint` natively since 2020; no polyfill ships.
- No top-level `await`.
- No WASM. No `.wasm` blobs anywhere in the package, no direct or transitive WASM dependencies. CI scans `dist/` for `.wasm` files, `WebAssembly.instantiate`, Buffer/process/node:* references, and Scala.js identifier patterns.
- Bundle is ESM-only. The package's `exports` map deliberately omits CJS entry points.

### Package shape

One published npm package, `@ergots/ergoscript` (**published to npm as `@ergots/ergoscript@0.2.0`**, 2026-06-02). **Subpath exports — none initially.** If a downstream consumer eventually needs finer tree-shaking (e.g., just the wire layer for a wallet PoC, or just the sigma verifier for a light-client signature-validation utility), introduce a `/wire`, `/eval`, or `/sigma` subpath at that point — the slice contract files above are pre-marked seams. The package itself stays unified until real consumer demand justifies a split.

### Runtime dependencies

- `@noble/hashes@2.2.0` (blake2b, sha-256, sha-512). Same pin as the proof package.
- `@noble/curves@2.2.0` (secp256k1 point ops + Schnorr-style verification). Added in phase 2g-medium. Version-locked pair with `@noble/hashes`.

No `Buffer`, no `node:*` outside test files, no WASM.

## Error model overview

The package exports multiple typed error classes, one per surface, each carrying a structural `code: string` for programmatic dispatch:

- **Wire layer** (see [`ergoscript-wire.md`](./ergoscript-wire.md) for full taxonomy): `ErgoTreeParseError`, `ErgoTreeSerializeError`, `ExprParseError`, `ExprSerializeError`, `STypeParseError`, `STypeSerializeError`, `SValueParseError`, `SValueSerializeError`, `SigmaBooleanParseError`, `ExprTpeError`, `ReaderError`, `AddressDecodeError`.
- **Evaluator layer** (see [`ergoscript-eval.md`](./ergoscript-eval.md) for full taxonomy of 80 codes): `EvalError`.
- **Sigma-protocol verifier** (see [`ergoscript-sigma.md`](./ergoscript-sigma.md) for full taxonomy of 8 codes): `VerifyError`.

Common discipline: `.message` is human-readable; `.code` matches a fixed enum of structural reason strings for programmatic handling. No other error classes are exported. Internal panics (e.g., a bug in `@noble/hashes` or `@noble/curves`) bubble up as plain `Error` — those represent contract violations *inside* the package and are bugs, not input-shape issues.

## Test-corpus layout

The package validates implementation via three layers per the project's TDD discipline:

- **Layer 1 — parse + round-trip** (`test/corpus.test.ts`): loads the full fixture corpus (sigma-rust unit tests, ergoscript-compiler tests, real mainnet boxes, synthetic VLQ/SType edge cases) and asserts both structural parse correctness AND byte-identical round-trip.
- **Layer 2 — evaluation correctness** (`test/eval/*.test.ts` per-arm + `test/corpus-eval.test.ts`): each evaluator arm has fixture(s) asserting both value and cost against sigma-rust's `try_eval_out` oracle. Layer C2 cross-checks the TS evaluator against the sigma-rust eval oracle on every mainnet fixture whose body is fully covered.
- **Layer 3 — mutation tests** (`test/parse-mutation.test.ts`): single-byte flips at varied offsets across every fixture; each mutation either throws one of the typed error classes above OR is byte-identical (a flip in a tolerated padding region).
- **Layer C3.a — operator-driven mutation testing** (Coll HOFs): scoped mutation tests at ≥ 90% kill rate per HOF arm. Method handlers deferred per 2g.5/2g.6 posture.
- **Cross-runtime**: vitest runs every test under both `node` and `jsdom` environments.

See `docs/specs/` for per-phase test-strategy detail.

## Coverage summary

| Slice | Status |
|---|---|
| Wire format | 100% of MIR variants parse + serialize byte-identically (255 + 1 + 6 fixtures; 6,221 mutations; 100% taxonomy coverage) |
| Evaluator | 67 of 67 implementable `Expr` arms wired (post-2i-d reframe; 19 wire opcodes are reserved-but-never-dispatched in sigma-rust and parse-reject via `'opcode-reserved'`; 4 more route through other dispatch paths and parse-reject via `'not-implemented-yet'` pending separate review); 128 method-handler registry entries (F5 batch 2 +3: `SPreHeader.version`/`nBits`/`votes`); 80 `EvalError` codes (v6 P2a added `'v6-type-in-pre-v3-tree'` + `'unsigned-bigint-op-unsupported'`; v6 P2b added `'unsigned-bigint-out-of-range'` + extended `'unsigned-bigint-op-unsupported'` to cast arm rejects; v6 P2c added 0 new codes — UBI BinOps + bridge methods reuse existing codes; post-P2c: P2d-2 +1, P4 +1, P5a +2, P5b-1 +1, P5b-2 +2, P5c +1, P6 +1 → 81; **F1 removed 2: `'atleast-bound-out-of-range'` + `'deserialize-context-key-not-found'` → 79**; F5 batch 1 +1 `'tuple-invalid-arity'` → 80; F5 batch 2 +0); substitute-pre-pass architecture (`_substitute-deserialize.ts`) for DeserializeContext / DeserializeRegister arms; `validateV6Types` pre-eval pass for `SUnsignedBigInt`/`SFunc`-112 type gating; mainnet C2 corpus `success` ≥ 18 (uplift TBD on next corpus run; 2i-a/b/c arms ride along under shape-uniform handlers) |
| Sigma verifier | Full `SigmaBoolean` 6-variant surface (leaf + Cand/Cor/Cthreshold conjecture walk); 8 `VerifyError` codes (3 reserved for ABI stability) |
| AVL+ | Integrated via `@ergots/avltree` v0.2.0: full 16 of 16 `SAvlTree.*` method handlers wired (phase 2h-b: 7 Tier-1 accessors + 6 Tier-2 verification ops; phase 2h-d: `updateOperations`/`updateDigest` Tier-1 + V3-gated `insertOrUpdate` Tier-2) |
| Cost-equivalence | Infrastructure landed in phase 2j-a (mainnet-validate harness wiring: shim emits sigma-rust per-input cost via `reduce_to_crypto` + `ctx.jit_cost_value()`; harness compares vs our `ctx.jitCost`; halt-on-first-divergence with structured `error-report.json`). Layer-5 smoke clean to h=1000; first cost-drift surfaced at h=3850 (delta 24, ours undercharged). Per-arm calibration ongoing in 2j-b/c/... |

Cross-runtime: 3580 ergoscript + 156 avltree + 247 nipopow + 177 scorex = 4160 tests, passing under both `node` and `jsdom` (v6 P2a complete).

**Convention:** when a slice file's coverage changes, this summary table is updated in the same commit.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (phase plan; risks; validation strategy)
- `docs/specs/2026-05-18-facts-ergoscript-split-design.md` — this file's split design
- `facts/nipopow.md` — sister contract for `@ergots/nipopow`
- `CLAUDE.md` — project conventions (read-first files include this meta + relevant slices)
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — byte-format and implementation oracle
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical language specification for opcode semantics
