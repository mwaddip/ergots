# CLAUDE.md — ergots

Per-project instructions for Claude. Read these alongside the user's global `~/projects/OVERRIDES.md` (mechanical override rules) and `~/.claude/CLAUDE.md`.

## Read-first files (in this order, every session)

1. **`facts/`** — per-package interface contracts. These define what other packages may rely on (preconditions, postconditions, invariants, error taxonomy). The `facts/` files are the *boundary*; everything else is implementation. Current:
   - `facts/scorex.md` — `@ergots/scorex` interface (codec layer: `ByteReader`/`ByteWriter`/`ReaderError`/VLQ + block-`Header`/`AutolykosSolution` types; shared by `@ergots/nipopow` and `@ergots/ergoscript`)
   - `facts/nipopow.md` — `@ergots/nipopow` interface
   - `facts/ergoscript.md` — `@ergots/ergoscript` meta hub (cross-cutting guarantees + lookup table forwarding to per-slice files)
   - `facts/ergoscript-wire.md` — wire format slice (`parseTree`, `serializeTree`, address helpers, `ErgoTree` types, wire-layer error classes)
   - `facts/ergoscript-eval.md` — evaluator slice (`evaluate`, `evaluateWith`, `makeContext`, `EvalError` 43 codes, `SValue`/`SType`/`Expr` discriminated unions, method-handler registry, eval arm coverage 52/~70)
   - `facts/ergoscript-sigma.md` — sigma-protocol verifier slice (`verifySignature`, `SigmaBoolean` 6-variant union, `VerifyError` 8 codes)
   - `facts/avltree.md` — `@ergots/avltree` interface (verifier surface + Operation variants + Source Mapping table to ergo_avltree_rust)
2. **`docs/specs/`** — design specs (the *why* and *how-we-chose*; rationale, validation strategy, risks). Current:
   - `2026-05-12-nipopow-proof-verifier-design.md` — `@ergots/nipopow` v1 design
   - `2026-05-13-no-gossip-decision.md` — why phase 2 is not a gossip layer; new phase plan
   - `2026-05-13-ergoscript-interpreter-design.md` — `@ergots/ergoscript` phased design (2a wire-format → 2j cost)
3. **`PLAN.md`** (when it exists) — implementation plan for the package currently being built. Source of truth for "what comes next."
4. **`SESSION_CONTEXT.md`** (when it exists) — current state and last session's progress.

If `SESSION_CONTEXT.md` and `PLAN.md` disagree, `SESSION_CONTEXT.md` is more current. If a `facts/` contract and the design spec disagree on the interface, `facts/` wins — it's the load-bearing artifact other packages depend on.

## Project facts

- Repo name `ergots` is intentional. Pattern follows the user's `frots` repo (pure-TS port of an audited Rust crate, validated byte-for-byte).
- Goal: a pure-TypeScript, browser-compatible implementation of Ergo NiPoPoW (Non-Interactive Proofs of Proof-of-Work).
- Structure: multi-package monorepo under npm workspaces. Naming convention `@ergots/*`.
- Packages planned (updated 2026-05-13 after gossip-rejection brainstorm; phase 2a complete 2026-05-14):
  - `@ergots/nipopow` — NiPoPoW proof parser + verifier + P2P envelope codec. ✅ v0.1.0 published to npm (305 tests).
  - `@ergots/ergoscript` — TS ErgoTree parser + serializer, validated byte-for-byte against `sigma-rust`'s `ergotree-ir` crate (branch `integration/ergots`). Standalone-useful (tooling, simulators, DApp frontends) as well as a dependency of the next package. ✅ **Phase 2a complete (1074 tests, full ~63 MIR variant wire-format surface, mutation testing; not yet `npm publish`-ed).** See `facts/ergoscript.md` for the boundary contract meta + lookup table (with per-slice files `facts/ergoscript-{wire,eval,sigma}.md`). Next phase 2b adds the type system + constant evaluation; phase 2g adds sigma protocol (then `@noble/curves` becomes a runtime dep — not in 2a).
  - Wallet / transaction-broadcaster (naming TBD) — future. Browser bootstraps state from a verified proof, locally verifies a user-constructed transaction using `@ergots/ergoscript`, broadcasts via any conformant Ergo node. HTTP-client / data-fetching layer is internal, not a separate package.
  - **Considered and rejected:** `@ergots/gossip` (WebSocket "gossip" layer for browser/Node peer discovery). See `docs/specs/2026-05-13-no-gossip-decision.md`. Browsers cannot peer (no inbound, no raw TCP); existing node REST endpoints cover what's needed; any future TS full-node would speak JVM-P2P directly.
- Reference implementations:
  - `~/projects/ergo-node-rust/chain/src/nipopow_proof.rs` — `build_nipopow_proof`, `verify_nipopow_proof_bytes`, `compare_nipopow_proof_bytes`
  - `~/projects/ergo-node-rust/src/nipopow_serve.rs` — P2P envelope (codes 90/91) parsing
  - `~/projects/ergo-node-rust/facts/nipopow.md` — wire format contract
  - `ergo-nipopow` crate in sigma-rust (consumed by `ergo-node-rust`) — `NipopowAlgos`, `NipopowProof`, `PoPowHeader`, `NipopowProofSerializer`
- Runtime dependency baseline: `@noble/hashes` 2.x. No `@noble/curves` in the verifier package (the miner public key is consumed as raw bytes feeding Autolykos v2 hashes, not curve-multiplied on the verify path).
- Validation strategy: a Rust `fixture-gen/` crate at repo root regenerates JSON+binary fixtures from `ergo-nipopow` directly. TS tests assert byte-for-byte equality at every layer.

## Verification commands (per OVERRIDES rule #6, always run before claiming done)

These will exist once scaffolding lands. Treat them as a contract — if a command is added, it must pass before claiming any task done.

```bash
# TypeScript side (run from repo root)
npm test                # vitest run across all packages — must pass
npx tsc --noEmit        # must be clean across all packages
npm run typecheck       # per-package typecheck if a workspace alias exists

# Rust fixture-gen side
cd fixture-gen
cargo build             # must be clean
cargo test              # must pass
cargo run               # regenerates fixtures; diff against committed must be empty (determinism check)
```

If `cargo run` produces a diff against committed fixtures, **stop and investigate** — that's a determinism regression and the entire byte-equality testing strategy depends on stability.

## Browser-first, hard rules

The verifier MUST run unchanged in a browser. These rules are enforced by the test environment (vitest under both `node` and `jsdom`) and by the bundle target (ESM, ES2022):

- **No `Buffer`** anywhere in `packages/*/src/`. Use `Uint8Array`. `Buffer` is fine in `test/` setup if needed but never in source.
- **No `process`, `fs`, `path`, `os`, `node:*`** imports outside test files.
- **No `node:crypto` / `globalThis.crypto.subtle`**. Hashing is `@noble/hashes` only — consistent behavior across runtimes, no async surface.
- **No WASM.** No `.wasm` blobs anywhere in `packages/*/`, no direct or transitive WASM dependencies (`ergo-lib-wasm-*`, `sigma-rust-wasm`, or anything wrapping them). The all-TS approach is the project identity — substituting WASM defeats the reason these projects exist. Audit any new dependency for transitive WASM before adding. See memory `feedback-pure-typescript-no-wasm`.
- **ESM only.** No CJS exports.
- **No top-level await** in published code (breaks older bundlers).

## What to absolutely never do here

- **Never claim a parse/serialize/verify primitive is done without a byte-equality test** against a committed fixture from `fixture-gen/`.
- **Never widen the verifier's scope** beyond the current spec (no proof construction, no transport, no storage). Those live in separate packages.
- **Never depend on `@noble/curves`** in `@ergots/nipopow` unless implementation reveals an actual need — the design says no, and adding it without re-spec is scope creep.
- **Never copy-port code from `sigma-rust` or `ergo-node-rust` verbatim**. This is a clean-room TypeScript implementation guided by the wire spec and validated by fixtures. The Rust code is the reference for *behavior*, not the source for line-by-line translation.
- **Never reach across package boundaries inside the monorepo** with relative imports (`../../proof/src/...`). Cross-package use goes through published package names so the dependency graph stays explicit.
- **Never use `--no-verify`, `--no-gpg-sign`, or any hook-bypassing flag** on git operations.
- **Never refactor `packages/nipopow/src/` for "future flexibility"** to accommodate ergoscript or wallet needs that haven't been spec'd yet. Wait until those packages exist.

## Confidence escalation (extra-strict on the crypto path)

Per OVERRIDES rule #2, halt and declare when crypto confidence drops below 95%. In this project that means every byte of:

- Scorex VLQ / ZigZag VLQ serialization (a single wrong sign-extension breaks every fixture)
- blake2b-256 inputs (header id derivation, merkle node hashing, Autolykos v2 seed) — exact byte ordering matters
- Merkle proof verification for interlinks — JVM's batch-merkle layout is specific
- Autolykos v2 seed construction and index derivation
- `n_bits` → target unpacking (Bitcoin-compact format, sign-bit handling)
- `compareProofs` / `is_better_than` — KMZ17 §4.3 best-arg comparison

Format:
> ⚠️ **ESCALATION REQUIRED**
> My confidence on [specific aspect] is ~[X]%. I recommend verifying [what specifically] before proceeding. Suggested approach: [Deep Think / manual review / reference implementation check].

When uncertain, **read the Rust source in `~/projects/ergo-node-rust/` or the sigma-rust `ergo-nipopow` crate directly.** Notes drift; source is authoritative.

## TDD is the working discipline

All TypeScript implementation in `packages/*/src/` follows the `superpowers:test-driven-development` skill. Invoke it at the start of any implementation session. The Iron Law applies: **no production code without a failing test first.**

The fixture-driven validation strategy turns the TDD cycle into a clean three-step rhythm:

1. **Generate the fixture.** Add the case to `fixture-gen/` (Rust), run `cargo run -p fixture-gen`, commit the resulting `packages/<pkg>/test/fixtures/<name>.{bin,json}`. The Rust side calls into `ergo-nipopow` and is reference code — it doesn't itself need TDD.
2. **RED.** Write the TS test that loads the fixture and asserts the parsed/computed/serialized result matches. Run vitest, watch it fail with the expected message ("module not found," "function undefined," "assertion failed at field X").
3. **GREEN.** Write the minimal TS implementation that passes. Run vitest, watch it pass. Then **REFACTOR** — clean up while staying green.

Rules that follow from the Iron Law in this project:

- **No "I'll port the Rust file first and add tests after."** That's tests-after, and it fails the discipline. Delete and start from the test.
- **One fixture, one behavior, one test.** Don't bundle "parse header AND verify PoW AND check connections" into one test. Each primitive gets its own red-green cycle.
- **If a fixture doesn't exist yet, generate it first.** Don't write a TS test against a fixture path that doesn't exist on disk — you'll trip the test runner on file-not-found instead of on the assertion that matters.
- **Mutation tests count as their own red.** For each mutation fixture (single-byte flips that must cause verification failure), the failing test is "verifier rejects mutated proof X" — implement until each one specifically fails verification.

## Workflow expectations

- **One package at a time.** v1 (`@ergots/nipopow`) is shipped; the next focus is `@ergots/ergoscript`. Don't scaffold the wallet package until ergoscript is stable and tested.
- **Spec before code.** Every new package gets its own design spec in `docs/specs/` before implementation starts. Brainstorm → spec → plan → red-green-refactor → implementation.
- **Drive forward through a phase** once started. Don't ask permission for small reversible decisions mid-phase.
- **Stop at natural milestones** (a PLAN.md step done, a non-trivial decision needed). Present status + options + recommendation; let the user pick.
- **Use TaskCreate / TaskUpdate** for multi-step work. Create one task per PLAN.md sub-step. Within a sub-step, each red-green cycle is fine-grained progress that doesn't need its own task.
- **Commit at major checkpoints** when the user says so, not autonomously.

## Common gotchas (will grow as implementation reveals them)

- **VLQ for integers, ZigZag for signed.** JVM Scorex `putInt` is ZigZag VLQ; `putUInt` / `putUShort` is plain VLQ. Easy to confuse. `facts/nipopow.md` line 76 documents this with the "lesson from snapshot sync" — applies everywhere we touch the wire format.
- **Genesis interlinks are synthesized in-process.** The extension at height 1 on testnet/mainnet is empty; the canonical `interlinks = [genesis_id]` is never read from extension bytes. Mirrors the Rust `popow_header_at_height` h==1 path (`chain/src/nipopow_proof.rs:108-113`).
- **Extension bytes can carry a mismatched `header_id`.** A pre-fix bug in the Rust reader accepted any well-formed extension payload at a queried height. The fix compares the embedded `header_id` against the queried header's id and rejects on mismatch (`chain/src/nipopow_proof.rs:118-134`). Same check needed in our reader code if/when we build a prover.
- **`m` and `k` bounds:** both must be `≥ 1` and the Rust caps them at `MAX_M_K = 256`. The wire envelope also bounds `m + k` at ~1000 (per `facts/nipopow.md`). Reject early, before allocating.
- **2 MB cap on inbound proofs.** Enforce before parse. Matches JVM `SizeLimit`.
