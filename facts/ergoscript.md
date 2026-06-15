# `@ergots/ergoscript` — Interface Contract (Meta)

This is the **meta hub** for the `@ergots/ergoscript` boundary contract. Cross-cutting guarantees (browser-compat, determinism, package shape, error-model overview, test-corpus layout) live here. For surface-specific contracts (public API, types, error codes, per-handler semantics) see the slice files below.

## Scope

Pure-TypeScript port of sigma-rust's `ergotree-ir` and `ergotree-interpreter` crates. Ships three layered surfaces over one package — wire format (parse + serialize), evaluator (`evaluate` + `EvalContext`), and sigma-protocol verifier (`verifySignature`) — plus authenticated AVL+ operation verification through `@ergots/avltree` and execution-cost equivalence exposed as `ctx.jitCost` after `evaluateWith`. The package is browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`, no WASM; ESM only. It is published to npm and consumed inside the monorepo through the workspace alias. Anything not in this document or its slice files is implementation detail and may change without notice.

The wire format and the v5 language semantics are validated byte-for-byte and value-for-value against sigma-rust (branch `integration/ergots`); the v6 (ErgoTree V3) evaluator, its execution costs, and adversarial-input gating are validated against a conformance corpus blessed by the JVM `sigma-state` reference. Where this file or a slice file is silent these references are canonical — sigma-rust at `~/projects/sigma-rust/sigma-rust/` for byte layout and v5 semantics, the JVM `sigma-state` reference for v6 semantics and cost.

## Where to find what

| Concern | File |
|---|---|
| Wire format (`parseTree`, `serializeTree`, address helpers, `ErgoTree` / `TreeHeader` types, wire-layer error classes incl. `ErgoTreeParseError`/`SerializeError` and `SigmaBooleanParseError`) | [`facts/ergoscript-wire.md`](./ergoscript-wire.md) |
| Evaluator surface (`evaluate`, `evaluateWith`, `makeContext`, `EvalError` 85 codes, `SValue` / `SType` / `Expr` discriminated unions [canonical], 68/68 implementable eval arms + 21 reserved opcodes, 134-entry method-handler registry, `EvalOpts` chain-state fields, substitute-pre-pass for Deserialize* arms, `validateV6Types` pre-eval pass for v6 type gating) | [`facts/ergoscript-eval.md`](./ergoscript-eval.md) |
| Sigma-protocol verifier (`verifySignature`, `SigmaBoolean` 6-variant union, `VerifyError` 9 codes, internal-helper modules — GF(2^192), secp256k1 adapter, Fiat-Shamir) | [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) |
| Authenticated AVL+ operations (`SAvlTree.*` method handlers in the evaluator, backed by `@ergots/avltree`'s `verifyAvlBatch` verifier) | [`facts/ergoscript-eval.md`](./ergoscript-eval.md) + [`facts/avltree.md`](./avltree.md) |
| Cost-equivalence (read `ctx.jitCost` after `evaluateWith(tree, ctx)`) | per-arm cost charges in [`facts/ergoscript-eval.md`](./ergoscript-eval.md); validation status in the Coverage summary below |

## Cross-cutting guarantees

### Determinism and purity

- All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output.
- No async surface. Every function is synchronous. (Rationale: the parser hits VLQ loops and blake2b in tight inner sections; the evaluator runs cost-charging in hot paths; the async boundary would only add overhead.)
- No throwing on success paths. Throws indicate contract violations or input rejection — they're the typed failure surface.

### Browser-compat

Runtime support: Node ≥ 20, evergreen browsers with native ESM. Specifically:

- All Uint8Arrays. Never `Buffer`. (`Buffer.from(...)` does not exist in browsers.)
- `globalThis.crypto` is not used. Hashing comes from `@noble/hashes` only; secp256k1 curve operations come from `@noble/curves`. Both are browser-clean ESM packages.
- `bigint` is used for `SLong`, `SBigInt`, cost values, and 64-bit-safe VLQ reads. Browsers support `bigint` natively since 2020; no polyfill ships.
- No top-level `await`.
- No WASM. No `.wasm` blobs anywhere in the package, no direct or transitive WASM dependencies. CI scans `dist/` for `.wasm` files, `WebAssembly.instantiate`, Buffer/process/node:* references, and Scala.js identifier patterns.
- Bundle is ESM-only. The package's `exports` map deliberately omits CJS entry points.

### Package shape

One published npm package, `@ergots/ergoscript`. **Subpath exports — none initially.** If a downstream consumer eventually needs finer tree-shaking (e.g., just the wire layer for a wallet PoC, or just the sigma verifier for a light-client signature-validation utility), introduce a `/wire`, `/eval`, or `/sigma` subpath at that point — the slice contract files above are pre-marked seams. The package itself stays unified until real consumer demand justifies a split.

### Runtime dependencies

- `@noble/hashes@2.2.0` (blake2b, sha-256, sha-512). Same pin as the proof package.
- `@noble/curves@2.2.0` (secp256k1 point ops + Schnorr-style verification). Version-locked pair with `@noble/hashes`.

No `Buffer`, no `node:*` outside test files, no WASM.

## Error model overview

The package exports multiple typed error classes, one per surface, each carrying a structural `code: string` for programmatic dispatch:

- **Wire layer** (see [`ergoscript-wire.md`](./ergoscript-wire.md) for full taxonomy): `ErgoTreeParseError`, `ErgoTreeSerializeError`, `ExprParseError`, `ExprSerializeError`, `STypeParseError`, `STypeSerializeError`, `SValueParseError`, `SValueSerializeError`, `SigmaBooleanParseError`, `ExprTpeError`, `ReaderError`, `AddressDecodeError`.
- **Evaluator layer** (see [`ergoscript-eval.md`](./ergoscript-eval.md) for full taxonomy of 85 codes): `EvalError`.
- **Sigma-protocol verifier** (see [`ergoscript-sigma.md`](./ergoscript-sigma.md) for full taxonomy of 9 codes): `VerifyError`.

Common discipline: `.message` is human-readable; `.code` matches a fixed enum of structural reason strings for programmatic handling. No other error classes are exported. Internal panics (e.g., a bug in `@noble/hashes` or `@noble/curves`) bubble up as plain `Error` — those represent contract violations *inside* the package and are bugs, not input-shape issues.

## Test-corpus layout

The package validates implementation via three layers per the project's TDD discipline:

- **Layer 1 — parse + round-trip** (`test/corpus.test.ts`): loads the full fixture corpus (sigma-rust unit tests, ergoscript-compiler tests, real mainnet boxes, synthetic VLQ/SType edge cases) and asserts both structural parse correctness AND byte-identical round-trip.
- **Layer 2 — evaluation correctness** (`test/eval/*.test.ts` per-arm + `test/corpus-eval.test.ts`): each evaluator arm has fixture(s) asserting both value and cost against sigma-rust's `try_eval_out` oracle. A cross-check layer runs the TS evaluator against the sigma-rust eval oracle on every mainnet fixture whose body is fully covered.
- **Layer 3 — mutation tests** (`test/parse-mutation.test.ts`): single-byte flips at varied offsets across every fixture; each mutation either throws one of the typed error classes above OR is byte-identical (a flip in a tolerated padding region).
- **Operator-driven mutation tests** (Coll HOFs): scoped mutation tests at ≥ 90% kill rate per HOF arm; method-handler arms are exercised by the per-arm value+cost fixtures rather than by operator mutation.
- **Cross-runtime**: vitest runs every test under both `node` and `jsdom` environments.

See `docs/specs/` for test-strategy detail.

## Coverage summary

| Slice | Status |
|---|---|
| Wire format | 100% of MIR variants parse + serialize byte-identically; full wire-error taxonomy coverage; single-byte mutation tests across the whole corpus |
| Evaluator | 68 of 68 implementable `Expr` arms wired; the 21 opcodes the reference reserves but never executes parse-reject via `'opcode-reserved'`; 134-entry method-handler registry spanning the v5 language and the v6 (ErgoTree V3) additions; 85 `EvalError` codes; a substitute-pre-pass (`_substitute-deserialize.ts`) for the `DeserializeContext`/`DeserializeRegister` arms and a `validateV6Types` pre-eval pass for `SUnsignedBigInt`/`SFunc` type gating |
| Sigma verifier | Full `SigmaBoolean` 6-variant surface (leaf + Cand/Cor/Cthreshold conjecture walk); 9 `VerifyError` codes (4 reserved for ABI stability) |
| AVL+ | Integrated via `@ergots/avltree`: all 16 `SAvlTree.*` method handlers wired (accessors, verification/update operations, and the V3-gated `insertOrUpdate`) |
| Cost-equivalence | Execution cost (`ctx.jitCost` after `evaluateWith`) is reference-equivalent: the evaluator has been walked from genesis to the chain tip, comparing every transaction input's cost against `sigma-rust`, with zero unresolved divergences. Per-arm cost charges are documented in the eval slice. |

Cross-runtime: the full suite runs under both `node` and `jsdom`.

**Convention:** when a slice file's coverage changes, this summary table is updated in the same commit.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (design rationale, risks, validation strategy)
- `docs/specs/2026-05-18-facts-ergoscript-split-design.md` — this file's split design
- `facts/nipopow.md` — sister contract for `@ergots/nipopow`
- `CLAUDE.md` — project conventions (read-first files include this meta + relevant slices)
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — byte-format and implementation oracle
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical language specification for opcode semantics
