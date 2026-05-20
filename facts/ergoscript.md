# `@ergots/ergoscript` — Interface Contract (Meta)

This is the **meta hub** for the `@ergots/ergoscript` boundary contract. Cross-cutting guarantees (browser-compat, determinism, package shape, error-model overview, test-corpus layout) live here. For surface-specific contracts (public API, types, error codes, per-handler semantics) see the slice files below.

## Scope

Pure-TypeScript port of sigma-rust's `ergotree-ir` and `ergotree-interpreter` crates, validated byte-for-byte and value-for-value against the `integration/ergots` branch. Ships in three layered surfaces — wire format (parse + serialize), evaluator (`evaluate` + `EvalContext`), and sigma-protocol verifier (`verifySignature`) — with future layers planned for AVL+ membership-proof verification (phase 2h) and cost validation (phase 2j). The package is browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`, no WASM. ESM only. The package has not been `npm publish`-ed; downstream consumers in the monorepo currently import it through the workspace alias. Anything not in this document or its slice files is implementation detail and may change without notice.

Authoritative source-of-truth for wire-format byte layout and evaluator semantics: sigma-rust at `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`). Where this file or a slice file is silent, sigma-rust is canonical.

## Where to find what

| Concern | File |
|---|---|
| Wire format (`parseTree`, `serializeTree`, address helpers, `ErgoTree` / `TreeHeader` types, wire-layer error classes incl. `ErgoTreeParseError`/`SerializeError` and `SigmaBooleanParseError`) | [`facts/ergoscript-wire.md`](./ergoscript-wire.md) |
| Evaluator surface (`evaluate`, `evaluateWith`, `makeContext`, `EvalError` 48 codes, `SValue` / `SType` / `Expr` discriminated unions [canonical], eval arm coverage 52/~70, 44-entry method-handler registry, `EvalOpts` chain-state fields) | [`facts/ergoscript-eval.md`](./ergoscript-eval.md) |
| Sigma-protocol verifier (`verifySignature`, `SigmaBoolean` 6-variant union, `VerifyError` 8 codes, internal-helper modules — GF(2^192), secp256k1 adapter, Fiat-Shamir) | [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) |
| AVL+ membership proofs (`verifyMembershipProof`, `lookupInTree`) | (future, phase 2h) |
| Cost validation (`evaluateWithCost`) | (future, phase 2j) |

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

One published npm package, `@ergots/ergoscript`. **Subpath exports — none initially.** If a downstream consumer eventually needs finer tree-shaking (e.g., just the wire layer for a wallet PoC, or just the sigma verifier for a light-client signature-validation utility), introduce a `/wire`, `/eval`, or `/sigma` subpath at that point — the slice contract files above are pre-marked seams. The package itself stays unified until real consumer demand justifies a split.

### Runtime dependencies

- `@noble/hashes@2.2.0` (blake2b, sha-256, sha-512). Same pin as the proof package.
- `@noble/curves@2.2.0` (secp256k1 point ops + Schnorr-style verification). Added in phase 2g-medium. Version-locked pair with `@noble/hashes`.

No `Buffer`, no `node:*` outside test files, no WASM.

## Error model overview

The package exports multiple typed error classes, one per surface, each carrying a structural `code: string` for programmatic dispatch:

- **Wire layer** (see [`ergoscript-wire.md`](./ergoscript-wire.md) for full taxonomy): `ErgoTreeParseError`, `ErgoTreeSerializeError`, `ExprParseError`, `ExprSerializeError`, `STypeParseError`, `STypeSerializeError`, `SValueParseError`, `SValueSerializeError`, `SigmaBooleanParseError`, `ExprTpeError`, `ReaderError`, `AddressDecodeError`.
- **Evaluator layer** (see [`ergoscript-eval.md`](./ergoscript-eval.md) for full taxonomy of 48 codes): `EvalError`.
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
| Evaluator | 52 of ~70 `Expr` arms wired; 44 method-handler registry entries; 48 `EvalError` codes; mainnet C2 corpus `success` ≥ 18 (post-2h-c.1 uplift TBD on next corpus run; 2h-f adds 1-3 mainnet boxes per the 2g.6 survey's 2-box flatMap + 1-box getEncoded demand counts) |
| Sigma verifier | Full `SigmaBoolean` 6-variant surface (leaf + Cand/Cor/Cthreshold conjecture walk); 8 `VerifyError` codes (3 reserved for ABI stability) |
| AVL+ | Integrated via `@ergots/avltree` v0.2.0: full 16 of 16 `SAvlTree.*` method handlers wired (phase 2h-b: 7 Tier-1 accessors + 6 Tier-2 verification ops; phase 2h-d: `updateOperations`/`updateDigest` Tier-1 + V3-gated `insertOrUpdate` Tier-2) |
| Cost validation | (not yet — phase 2j; consensus-critical per umbrella spec) |

Cross-runtime: 2922 ergoscript + 156 avltree + 245 nipopow + 177 scorex = 3500 tests, passing under both `node` and `jsdom`.

**Convention:** when a slice file's coverage changes, this summary table is updated in the same commit.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (phase plan; risks; validation strategy)
- `docs/specs/2026-05-18-facts-ergoscript-split-design.md` — this file's split design
- `facts/nipopow.md` — sister contract for `@ergots/nipopow`
- `CLAUDE.md` — project conventions (read-first files include this meta + relevant slices)
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — byte-format and implementation oracle
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical language specification for opcode semantics
