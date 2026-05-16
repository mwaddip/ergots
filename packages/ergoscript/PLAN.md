# Phase 2g-medium Implementation Plan — `@mwaddip/ergots-ergoscript`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship phase 2g-medium: sigma protocol primitives at leaf-only verifier scope. Structural `SigmaBoolean` (6-variant discriminated union replacing the opaque `{ raw }` shape from phase 2a) + `@noble/curves@2.2.0` adapter + `CreateProveDlog` / `CreateProveDhTuple` eval arms + `verifySignature(sigmaBoolean, message, signature) → boolean` public function (handles TrivialProp + ProveDlog + ProveDhTuple; throws `VerifyError 'conjecture-not-implemented'` on Cand/Cor/Cthreshold). Adds 50-JitCost P2PK short-circuit to the `Const` arm. Coverage 42 → 44 of ~70 arms; 1 new `EvalError` code; new `VerifyError` class with ~5 codes; 2 new `SigmaBooleanParseError` codes.

**Architecture:** 8 tasks in flat ordering with commits between each (no `STOP α/β/γ` markers — per `[[feedback-no-artificial-stops]]` memory). Task 1 = structural-SigmaBoolean wire refactor (foundation; all downstream depends). Task 2 = `@noble/curves` adapter. Tasks 3-4 = the two new eval arms (CreateProveDlog includes the P2PK short-circuit; CreateProveDhTuple is straightforward). Task 5 = verifier infrastructure (challenge / fiat-shamir / sig-serializer / errors modules). Task 6 = `verifySignature` orchestration + V1+V2 verifier fixtures invoking sigma-rust's prover. Tasks 7-8 = docs + finalize. Per OVERRIDES #2, Task 6 is the crypto-sensitive part — implementer + reviewer cite specific sigma-rust source lines for each correctness-sensitive equation.

**Tech Stack:** TypeScript 5.5 (ES2022, ESM only), Vitest 2 with jsdom, Rust fixture-gen calling into sigma-rust's `ergotree-interpreter` crate at `integration/ergots@ed5452cf`. **New runtime dep:** `@noble/curves@2.2.0` (secp256k1; version-locked pair with existing `@noble/hashes@2.2.0`). All 6 SigmaBoolean wire variants already parse opaquely via phase 2a — Task 1 reshapes that to structural; the existing 255-fixture roundtrip and 6221-flip mutation suite must continue to pass post-refactor.

**Source-first discipline:** Read sigma-rust per task before writing any TS. Authoritative sources for slice 2g-medium:

- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean.rs` — `SigmaBoolean` enum (3 top-level variants flattening to 6 concrete leaves), `ProveDlog`, `ProveDhTuple` (`sigma_boolean.rs:34-80`)
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cand.rs`, `cor.rs`, `cthreshold.rs` — conjecture struct shapes; `SigmaConjectureItems<T> = BoundedVec<T, 1, 255>` at `sigma_boolean.rs:31`
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/sigmaboolean.rs` — wire-format parse + serialize for SigmaBoolean
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_provedlog.rs` — `CreateProveDlog` MIR (`{ input: Box<Expr> }`)
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_prove_dh_tuple.rs` — `CreateProveDhTuple` MIR (`{ g, h, u, v: Box<Expr> }`)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/create_provedlog.rs` — eval arm; Pattern A `Fixed(10)`
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/create_prove_dh_tuple.rs` — eval arm; Pattern A `Fixed(20)`
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval.rs:138-158, 268-278` — P2PK short-circuit `EVAL_SIGMA_PROP_CONSTANT = 50`
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol.rs:104-110` — `SOUNDNESS_BITS = 192`, `SOUNDNESS_BYTES = 24`, `GROUP_SIZE = 32`
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/verifier.rs:60-125` — verify pipeline + `verify_signature` entry
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:118-255` — proof byte format (per-leaf, conjecture-walk patterns; Cand inherits parent challenge; Cor XORs)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs:70-200` — Fiat-Shamir tree-to-bytes; `prop_bytes` wraps SigmaProp in `ErgoTree v0 + constant-segregation=true` at lines 148-157
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/challenge.rs` — 24-byte challenge ops
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/wscalar.rs:60-76` — `scalar_from_bytes` (32 BE → mod n) + `scalar_from_challenge` (24 bytes → left-pad 8 zeros → mod n)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/dlog_protocol.rs:113-184` — Schnorr verify equation `a = (basePoint * z) + negate(h * scalarFromChallenge(challenge))`; deterministic-nonce signer
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/dht_protocol.rs:132-157` — DH-tuple two-commitment verify
- `~/projects/sigma-rust/sigma-rust/ergo-chain-types/src/ec_point.rs:74-152` — EcPoint impl (`Mul<&EcPoint>` is point-addition!); identity = 33 zero bytes (Ergo convention, NOT native SEC1)

Full design rationale: `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md`.

**TDD discipline:** Iron Law per `CLAUDE.md` — no production code without a failing test first. Each task follows red → green → cost-assert → corpus-check → commit. Per-task cadence with two-stage review (spec compliance + code quality).

**Confidence-escalation flag (per OVERRIDES #2):** Task 6 is the load-bearing crypto-verification path. Implementer + reviewer MUST explicitly cite source lines for each of these equations:

- 24-byte challenge → 32-byte scalar: **left-pad with 8 zero bytes** then reduce mod n (`wscalar.rs:69-76`).
- Fiat-Shamir `prop_bytes`: wrap SigmaProp in `ErgoTree v0 + constant-segregation=true` before serializing (`fiat_shamir.rs:148-157`). Byte-equivalence with sigma-rust is the only correctness signal.
- Schnorr commitment: `a = (basePoint * z) + negate(decodePoint(h) * scalarFromChallenge(challenge))` per `dlog_protocol.rs:173-184`. Note: sigma-rust's `Mul<&EcPoint>` impl is *point addition* (`ec_point.rs:74-79`); the spec equation uses multiplicative notation for an additive group operation.
- DhTuple two-commitment per `dht_protocol.rs:132-157`.
- Identity-point handling: 33 zero bytes ↔ point-at-infinity is **Ergo convention**, NOT native SEC1 (`ec_point.rs:130-152`).
- `put_u16` is VLQ in wire serialization (`cand.rs:67-69`) but `put_i16_be_bytes` (big-endian) in Fiat-Shamir (`fiat_shamir.rs:197`) — same conceptual field, different encodings.

---

## File Structure

**New files (TypeScript source):**

| Path | Responsibility | Task |
|---|---|---|
| `packages/ergoscript/src/crypto/secp256k1.ts` | `@noble/curves` adapter — 9 functions (decode/encode point, point ops, scalar conversions, constants) | 2 |
| `packages/ergoscript/src/sigma/errors.ts` | `VerifyError` class + code constants | 5 |
| `packages/ergoscript/src/sigma/challenge.ts` | 24-byte challenge ops (byte XOR for Cor); challenge↔scalar conversion | 5 |
| `packages/ergoscript/src/sigma/fiat-shamir.ts` | Serialize SigmaBoolean tree + commitments for blake2b-256 hash input | 5 |
| `packages/ergoscript/src/sigma/sig-serializer.ts` | Parse sigma-proof bytes structurally guided by SigmaBoolean tree | 5 |
| `packages/ergoscript/src/sigma/verifier.ts` | `verifySignature` orchestration | 6 |
| `packages/ergoscript/src/eval/create-prove-dlog.ts` | `evalCreateProveDlog` arm | 3 |
| `packages/ergoscript/src/eval/create-prove-dh-tuple.ts` | `evalCreateProveDhTuple` arm | 4 |

**New files (TypeScript tests):**

| Path | Responsibility | Task |
|---|---|---|
| `packages/ergoscript/test/wire/sigma-boolean-variants.test.ts` | Per-variant wire roundtrip (all 6) | 1 |
| `packages/ergoscript/test/crypto/secp256k1.test.ts` | Adapter unit tests (identity convention, scalar conversion edges) | 2 |
| `packages/ergoscript/test/eval/create-prove-dlog.test.ts` | C1 fixture tests for CreateProveDlog | 3 |
| `packages/ergoscript/test/eval/p2pk-short-circuit.test.ts` | Smoking-gun for 50-JitCost Const(SSigmaProp) charge | 3 |
| `packages/ergoscript/test/eval/create-prove-dh-tuple.test.ts` | C1 fixture tests for CreateProveDhTuple | 4 |
| `packages/ergoscript/test/sigma/challenge.test.ts` | Challenge primitives unit tests | 5 |
| `packages/ergoscript/test/sigma/fiat-shamir.test.ts` | Fiat-Shamir byte-format unit tests | 5 |
| `packages/ergoscript/test/sigma/sig-serializer.test.ts` | Sig-byte parsing unit tests | 5 |
| `packages/ergoscript/test/sigma/verifier.test.ts` | V1 (positive + reject + malformed) + V2 (mutation) | 6 |

**New files (Rust fixture-gen):**

| Path | Responsibility | Task |
|---|---|---|
| `fixture-gen/src/cmds/ergoscript/wire/sigma_boolean_variants.rs` | Per-variant wire fixtures (TrivialProp×2, ProveDlog, ProveDhTuple, Cand, Cor, Cthreshold with varied k/items) | 1 |
| `fixture-gen/src/cmds/ergoscript/eval/create_prove_dlog.rs` | CreateProveDlog entries | 3 |
| `fixture-gen/src/cmds/ergoscript/eval/p2pk_short_circuit.rs` | Bare-SSigmaProp Const smoking-gun | 3 |
| `fixture-gen/src/cmds/ergoscript/eval/create_prove_dh_tuple.rs` | CreateProveDhTuple entries | 4 |
| `fixture-gen/src/cmds/ergoscript/verify/mod.rs` | Module hub for verifier fixtures | 6 |
| `fixture-gen/src/cmds/ergoscript/verify/verifier_positive.rs` | V1 positive: invokes sigma-rust prover for valid (sb, msg, sig) triples | 6 |
| `fixture-gen/src/cmds/ergoscript/verify/verifier_reject.rs` | V1 conjecture-reject + malformed | 6 |
| `fixture-gen/src/cmds/ergoscript/verify/verifier_mutation.rs` | V2 byte-flip mutation fixtures | 6 |

**Generated fixture files** (`packages/ergoscript/test/fixtures/`): wire-variants × 6 + eval × 3 + verify × 3 ≈ 12 new fixtures.

**Modified files (TypeScript source):**

| Path | Modification | Task |
|---|---|---|
| `packages/ergoscript/src/mir/types.ts` | `SigmaBoolean` opaque `{ raw }` → 6-variant discriminated union | 1 |
| `packages/ergoscript/src/wire/sigma-boolean.ts` | Rewrite: structural parser; add `serializeSigmaBoolean`; refactor `sigmaBooleanOpCode` / `proveDlogPublicKey` to walk structural; add 2 new error codes | 1 |
| `packages/ergoscript/src/wire/serialize-svalue.ts` | SSigmaProp case: `w.writeBytes(v.value.raw)` → `serializeSigmaBoolean(v.value, w)` | 1 |
| `packages/ergoscript/src/address.ts` | `isP2PK` / `p2pkPublicKey` walk structural (pattern-match `sb.tag === 'ProveDlog'`) | 1 |
| `packages/ergoscript/package.json` | Add `@noble/curves: 2.2.0` runtime dep | 2 |
| `packages/ergoscript/src/eval/const.ts` | Add 45 additional JitCost charge when `value.kind === 'SigmaProp'` (total = 5 + 45 = 50) | 3 |
| `packages/ergoscript/src/eval/eval.ts` | Add 2 new case lines: `case 'CreateProveDlog'` (Task 3); `case 'CreateProveDhTuple'` (Task 4) | 3-4 |
| `packages/ergoscript/src/eval/errors.ts` | Add `'sigma-prop-input-not-group-element'` code; document `VerifyError` class | 3, 5 |
| `packages/ergoscript/src/index.ts` | Re-export `verifySignature`, `VerifyError`, and the structural `SigmaBoolean` type | 6 |

**Modified files (Rust fixture-gen):**

| Path | Modification | Task |
|---|---|---|
| `fixture-gen/src/cmds/ergoscript/wire/mod.rs` | Add `pub mod sigma_boolean_variants;` | 1 |
| `fixture-gen/src/cmds/ergoscript/eval/mod.rs` | Add 3 new `pub mod` lines: `create_prove_dlog`, `p2pk_short_circuit`, `create_prove_dh_tuple` | 3-4 |
| `fixture-gen/src/cmds/ergoscript/mod.rs` | Add `pub mod verify;` | 6 |
| `fixture-gen/src/main.rs` | Wire 9 new `generate_and_write` calls (1 wire-variants + 3 eval + 5 verify); some verify modules may produce multiple fixture files | 1, 3-4, 6 |
| `fixture-gen/Cargo.toml` | Ensure sigma-rust prover-enabling features are active (likely already via `arbitrary`; confirm at Task 6) | 6 |

**Modified files (docs / memory — Tasks 7-8 only):**

| Path | Modification | Task |
|---|---|---|
| `facts/ergoscript.md` | Add v0.3.0 (or v0.2.0-extended) phase 2g-medium block: coverage 42 → 44; new `verifySignature` public function with precondition/postcondition; new `VerifyError` class with code taxonomy; new `EvalError` code `'sigma-prop-input-not-group-element'`; 2 new `SigmaBooleanParseError` codes; structural `SigmaBoolean` shape; 50-JitCost P2PK short-circuit on Const arm; `@noble/curves@2.2.0` listed in dependencies | 7 |
| `docs/specs/2026-05-13-ergoscript-interpreter-design.md` | Annotate phase 2g row: "delivered as 2g-medium (leaf-only verifier) + 2g-combinators (eval arms for Atleast/SigmaAnd/SigmaOr + conjecture verifier extension)" | 7 |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` | Updated: phase 2g-medium shipped (44 arms); next is 2g-combinators (3 deferred sigma combinators + conjecture verifier extension; Cthreshold polynomial GF(2^192)), then 2g.5 method-call dispatch | 8 |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_sigma_combinators_deferred.md` | Extend scope of 2g-combinators: now includes conjecture verifier walk (Cand/Cor) + Cthreshold polynomial + Atleast/SigmaAnd/SigmaOr eval arms | 8 |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md` | Update hook lines | 8 |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/reference_sigma_verifier_internals.md` | NEW: Key crypto details locked in writing (challenge-to-scalar left-pad; prop_bytes ErgoTree v0 wrap; Mul<&EcPoint> is point-add; identity convention; put_u16 VLQ vs put_i16_be_bytes BE in Fiat-Shamir) | 8 |
| `packages/ergoscript/SESSION_CONTEXT.md` | Fresh snapshot for phase 2g-medium done state (gitignored, local-only) | 8 |

**Unchanged (deliberately):**
- `packages/ergoscript/src/eval/eval-context.ts` — `addPerItemCost` already shipped in phase 2f Coll HOFs; no new `EvalContext` fields.
- `packages/ergoscript/src/eval/evaluate.ts` / `evaluate-with.ts` — `evaluate(tree, opts)` already plays the role of sigma-rust's `reduce_to_crypto`; no signature change.
- `packages/ergoscript/src/mir/types.ts` for `CreateProveDlog` / `CreateProveDhTuple` MIR variants — already declared since phase 2a.
- `packages/ergoscript/src/wire/parse-svalue.ts` SSigmaProp case — already delegates to `parseSigmaBoolean` (line 233); the SValue case continues to work once `parseSigmaBoolean` returns structural.
- `packages/ergoscript/test/_helpers/index.ts` — existing helpers (`hexToBytes`, `hydrateSValue`, `captureEvalError`, `rehydrateEvalOpts`) cover all new test files. New helper `hydrateSigmaBoolean` for structural shape may be added at Task 1 if tests need it.

---

## Conventions and workflow

These apply to every task. Don't repeat them per-task.

**Per-task arc (modeled on phase 2f Coll HOFs):**
1. Read sigma-rust source for the task's subject (cited per task).
2. Write the fixture-gen Rust module(s) where the task ships fixtures (Tasks 1, 3-4, 6).
3. Wire fixture-gen: add `pub mod ...` to the relevant `mod.rs`; add `generate_and_write` call to `fixture-gen/src/main.rs`.
4. Run `cargo run --release -p fixture-gen` from `/home/mwaddip/projects/ergots`. Verify new fixture file(s) appear at the expected paths.
5. Verify determinism: regenerate (re-run cargo run), then `git diff packages/ergoscript/test/fixtures/` — must be empty.
6. Write the failing TS test(s) (red).
7. Run `npx vitest run <test-path>`; verify FAIL with the expected reason.
8. Write the minimal TS implementation (green).
9. Wire into central dispatch / module index where applicable.
10. Run the per-task test; verify PASS.
11. Run the full ergoscript suite: `npx vitest run packages/ergoscript/`; verify all previous tests still pass (especially the 255-fixture roundtrip + 6221-flip mutation suite from phase 2a, after Task 1).
12. Run `npx tsc --noEmit -p packages/ergoscript`; verify zero errors.
13. Two-stage review (spec compliance + code quality) — orchestrator's job.
14. Commit (one commit per task; orchestrator may request a fix commit after review).

**Fixture-gen execution:** Always `cargo run --release -p fixture-gen` from `/home/mwaddip/projects/ergots`. Determinism check per task that touches fixtures: regenerate, then `git diff packages/ergoscript/test/fixtures/` — must be empty.

**Browser compatibility checks:** Every new TS module follows the existing hard rules (no `Buffer`, no `node:*` outside test files, no `globalThis.crypto`, no WASM, ESM only, no top-level await). `@noble/curves@2.2.0` is browser-clean by design.

**Two-stage review (per task):** Orchestrator dispatches two parallel review subagents after each task's green-+-typecheck-passes state:
- **Spec-compliance reviewer** — reads `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md`, this PLAN's task section, and the diff. Verifies behavior matches the design.
- **Code-quality reviewer** — reads the diff. Verifies test style, idioms, no `any` leaks, comments cite sigma-rust source lines, browser-clean primitives only.

**Commit message style:** HEREDOC format per CLAUDE.md. Per-task subject pattern: `feat(ergoscript): <subject> (phase 2g-medium task N)` or `refactor(ergoscript): ...` for Task 1. Trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` mandatory.

**No STOP markers in this slice.** Per [[feedback-no-artificial-stops]] memory. Commits between every task are the granular checkpoints; resumable at any task boundary.

---

## Task 1: Foundation — structural SigmaBoolean wire refactor

**Files:**
- Modify: `packages/ergoscript/src/mir/types.ts` — `SigmaBoolean` interface
- Modify: `packages/ergoscript/src/wire/sigma-boolean.ts` — full rewrite (structural parser + new serializer + refactored helpers + 2 new error codes)
- Modify: `packages/ergoscript/src/wire/serialize-svalue.ts` — SSigmaProp case delegation
- Modify: `packages/ergoscript/src/address.ts` — `isP2PK` / `p2pkPublicKey` walk structural
- Create: `fixture-gen/src/cmds/ergoscript/wire/sigma_boolean_variants.rs` — per-variant wire fixtures
- Modify: `fixture-gen/src/cmds/ergoscript/wire/mod.rs` — add `pub mod sigma_boolean_variants;`
- Modify: `fixture-gen/src/main.rs` — wire `generate_and_write` call
- Create: `packages/ergoscript/test/wire/sigma-boolean-variants.test.ts` — roundtrip tests

**Sigma-rust sources:**
- `ergotree-ir/src/sigma_protocol/sigma_boolean.rs:34-80` — `ProveDlog`, `ProveDhTuple` struct shapes
- `ergotree-ir/src/sigma_protocol/sigma_boolean/cand.rs:16-20, 67-69` — Cand struct + wire write (VLQ items_count)
- `ergotree-ir/src/sigma_protocol/sigma_boolean/cor.rs:16-20, 67-69` — Cor struct + wire write
- `ergotree-ir/src/sigma_protocol/sigma_boolean/cthreshold.rs:23-30, 108-111` — Cthreshold struct + wire write (k as `put_u16` of u8)
- `ergotree-ir/src/serialization/sigmaboolean.rs` — full parse + serialize logic

**Key behavior:** Replace the opaque `{ raw: Uint8Array }` shape with a 6-variant discriminated union (`TrivialProp`, `ProveDlog`, `ProveDhTuple`, `Cand`, `Cor`, `Cthreshold`). Wire parser dispatches recursively on opcode. Wire serializer walks structural to emit identical bytes. Round-trip invariant unchanged: `serializeSigmaBoolean(parseSigmaBoolean(b)) === b` byte-equal.

**Acceptance gate:** Existing 255-fixture roundtrip suite (`test/wire/corpus.test.ts` or equivalent) and 6221-flip mutation suite must continue to pass post-refactor.

- [ ] **Step 1: Read sigma-rust SigmaBoolean source files**

```bash
sed -n '20,90p' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean.rs
sed -n '1,80p' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/sigmaboolean.rs
sed -n '100,120p' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cthreshold.rs
```

Confirm: `SigmaConjectureItems<T> = BoundedVec<T, 1, 255>`; Cthreshold's `k: u8`; Cand/Cor/Cthreshold child-count uses `put_u16` (VLQ on wire); Cthreshold writes `k` as `put_u16(k as u16)`.

- [ ] **Step 2: Read current TS state for refactor scope**

```bash
sed -n '110,125p' /home/mwaddip/projects/ergots/packages/ergoscript/src/mir/types.ts
cat /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/sigma-boolean.ts
sed -n '285,310p' /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/serialize-svalue.ts
sed -n '100,170p' /home/mwaddip/projects/ergots/packages/ergoscript/src/address.ts
```

- [ ] **Step 3: Update `SigmaBoolean` type in `mir/types.ts`**

Replace the existing opaque shape (around lines 117-120):

```ts
export interface SigmaBoolean {
  /** Serialized sigma-protocol tree; structure deferred to phase 2g. */
  raw: Uint8Array
}
```

with the structural discriminated union:

```ts
/**
 * Structural sigma-protocol proposition tree (phase 2g-medium).
 *
 * Flattens sigma-rust's 3-variant `SigmaBoolean` enum
 * (`TrivialProp` / `ProofOfKnowledge` / `SigmaConjecture`) to the 6
 * concrete leaves. Wire format (opcode dispatch) lives in
 * `wire/sigma-boolean.ts`; the runtime verifier (phase 2g-medium leaf-only,
 * 2g-combinators full) walks this tree.
 *
 * Source: ergotree-ir/src/sigma_protocol/sigma_boolean.rs:168-175
 */
export type SigmaBoolean =
  | { tag: 'TrivialProp'; value: boolean }
  | { tag: 'ProveDlog'; h: Uint8Array }                                         // 33-byte SEC1 compressed (or 33 zeros = identity, Ergo convention)
  | { tag: 'ProveDhTuple'; g: Uint8Array; h: Uint8Array; u: Uint8Array; v: Uint8Array }
  | { tag: 'Cand'; items: SigmaBoolean[] }                                      // items.length >= 1
  | { tag: 'Cor'; items: SigmaBoolean[] }                                       // items.length >= 1
  | { tag: 'Cthreshold'; k: number; items: SigmaBoolean[] }                     // k in [1, items.length]
```

If `SigmaBoolean` is currently declared as `interface`, change to `type` (discriminated unions need `type`). Update any `interface SigmaBoolean extends` declarations downstream (search via `grep -rn "interface SigmaBoolean" packages/ergoscript/`).

- [ ] **Step 4: Rewrite `wire/sigma-boolean.ts`**

Replace the entire file body with the structural implementation. Keep the file's top-of-file doc comment and opcode constants. Replace `parseSigmaBoolean`, `consumeSigmaBoolean`, `sigmaBooleanOpCode`, `proveDlogPublicKey`. Add `serializeSigmaBoolean`. Add 2 new error codes.

```ts
import type { SigmaBoolean } from '../mir/types'
import { ByteReader, ReaderError } from './reader'
import { ByteWriter } from './writer'

const OP_AND = 0x96
const OP_OR = 0x97
const OP_ATLEAST = 0x98
const OP_PROVE_DLOG = 0xcd
const OP_PROVE_DH_TUPLE = 0xce
const OP_TRIVIAL_PROP_FALSE = 0xd2
const OP_TRIVIAL_PROP_TRUE = 0xd3

export class SigmaBooleanParseError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message); this.name = 'SigmaBooleanParseError'
  }
}

export class SigmaBooleanSerializeError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message); this.name = 'SigmaBooleanSerializeError'
  }
}

/**
 * Parse a SigmaBoolean from `r`, returning a structural discriminated union.
 * Recursive on conjectures.
 *
 * Error codes:
 *  - 'unknown-opcode'                — opcode byte not in the sigma table
 *  - 'arity-out-of-range'            — items_count > u16 max
 *  - 'cthreshold-k-out-of-range'     — k outside [1, items.length]
 *  - 'sigma-conjecture-empty-items'  — items.length < 1 (BoundedVec lower bound)
 *
 * Source: ergotree-ir/src/serialization/sigmaboolean.rs
 */
export function parseSigmaBoolean(r: ByteReader): SigmaBoolean {
  const op = r.readU8()
  switch (op) {
    case OP_TRIVIAL_PROP_FALSE: return { tag: 'TrivialProp', value: false }
    case OP_TRIVIAL_PROP_TRUE:  return { tag: 'TrivialProp', value: true }
    case OP_PROVE_DLOG: {
      const h = r.readBytes(33).slice()
      return { tag: 'ProveDlog', h }
    }
    case OP_PROVE_DH_TUPLE: {
      const g = r.readBytes(33).slice()
      const h = r.readBytes(33).slice()
      const u = r.readBytes(33).slice()
      const v = r.readBytes(33).slice()
      return { tag: 'ProveDhTuple', g, h, u, v }
    }
    case OP_AND:
    case OP_OR: {
      const count = r.readVlqU()
      if (count > 0xffff) {
        throw new SigmaBooleanParseError(
          `SigmaConjecture items_count ${count} exceeds u16 bound`, 'arity-out-of-range')
      }
      if (count < 1) {
        throw new SigmaBooleanParseError(
          `SigmaConjecture must have at least 1 item, got ${count}`, 'sigma-conjecture-empty-items')
      }
      const items: SigmaBoolean[] = []
      for (let i = 0; i < count; i++) items.push(parseSigmaBoolean(r))
      return { tag: op === OP_AND ? 'Cand' : 'Cor', items }
    }
    case OP_ATLEAST: {
      // sigma-rust cthreshold.rs:108-111 writes k as put_u16(k as u16), VLQ on wire.
      const k = r.readVlqU()
      const count = r.readVlqU()
      if (count > 0xffff) {
        throw new SigmaBooleanParseError(
          `Cthreshold items_count ${count} exceeds u16 bound`, 'arity-out-of-range')
      }
      if (count < 1) {
        throw new SigmaBooleanParseError(
          `Cthreshold must have at least 1 item, got ${count}`, 'sigma-conjecture-empty-items')
      }
      if (k < 1 || k > count) {
        throw new SigmaBooleanParseError(
          `Cthreshold k=${k} out of range [1, ${count}]`, 'cthreshold-k-out-of-range')
      }
      if (k > 0xff) {
        throw new SigmaBooleanParseError(
          `Cthreshold k=${k} exceeds u8 bound`, 'cthreshold-k-out-of-range')
      }
      const items: SigmaBoolean[] = []
      for (let i = 0; i < count; i++) items.push(parseSigmaBoolean(r))
      return { tag: 'Cthreshold', k, items }
    }
    default:
      throw new SigmaBooleanParseError(
        `unknown SigmaBoolean opcode 0x${op.toString(16).padStart(2, '0')}`, 'unknown-opcode')
  }
}

/**
 * Serialize a SigmaBoolean to `w`. Dual of `parseSigmaBoolean`.
 *
 * Source: ergotree-ir/src/serialization/sigmaboolean.rs
 */
export function serializeSigmaBoolean(sb: SigmaBoolean, w: ByteWriter): void {
  switch (sb.tag) {
    case 'TrivialProp':
      w.writeU8(sb.value ? OP_TRIVIAL_PROP_TRUE : OP_TRIVIAL_PROP_FALSE)
      return
    case 'ProveDlog':
      if (sb.h.length !== 33) {
        throw new SigmaBooleanSerializeError(`ProveDlog.h length=${sb.h.length}, expected 33`, 'ec-point-length')
      }
      w.writeU8(OP_PROVE_DLOG); w.writeBytes(sb.h)
      return
    case 'ProveDhTuple':
      for (const [name, p] of [['g', sb.g], ['h', sb.h], ['u', sb.u], ['v', sb.v]] as const) {
        if (p.length !== 33) {
          throw new SigmaBooleanSerializeError(`ProveDhTuple.${name} length=${p.length}, expected 33`, 'ec-point-length')
        }
      }
      w.writeU8(OP_PROVE_DH_TUPLE); w.writeBytes(sb.g); w.writeBytes(sb.h); w.writeBytes(sb.u); w.writeBytes(sb.v)
      return
    case 'Cand':
    case 'Cor':
      if (sb.items.length < 1 || sb.items.length > 0xffff) {
        throw new SigmaBooleanSerializeError(`SigmaConjecture items.length=${sb.items.length} out of range`, 'arity-out-of-range')
      }
      w.writeU8(sb.tag === 'Cand' ? OP_AND : OP_OR)
      w.writeVlqU(sb.items.length)
      for (const item of sb.items) serializeSigmaBoolean(item, w)
      return
    case 'Cthreshold':
      if (sb.items.length < 1 || sb.items.length > 0xffff) {
        throw new SigmaBooleanSerializeError(`Cthreshold items.length=${sb.items.length} out of range`, 'arity-out-of-range')
      }
      if (sb.k < 1 || sb.k > sb.items.length || sb.k > 0xff) {
        throw new SigmaBooleanSerializeError(`Cthreshold k=${sb.k} out of range`, 'cthreshold-k-out-of-range')
      }
      w.writeU8(OP_ATLEAST); w.writeVlqU(sb.k); w.writeVlqU(sb.items.length)
      for (const item of sb.items) serializeSigmaBoolean(item, w)
      return
    default: {
      const _exhaust: never = sb
      throw new SigmaBooleanSerializeError(`unreachable: ${JSON.stringify(_exhaust)}`, 'unreachable')
    }
  }
}

/**
 * Convenience: returns the 33-byte public key if `sb` is a ProveDlog leaf, else null.
 * Defensive copy.
 */
export function proveDlogPublicKey(sb: SigmaBoolean): Uint8Array | null {
  return sb.tag === 'ProveDlog' ? sb.h.slice() : null
}

export {
  OP_PROVE_DLOG as SIGMA_OP_PROVE_DLOG,
  OP_PROVE_DH_TUPLE as SIGMA_OP_PROVE_DH_TUPLE,
  OP_TRIVIAL_PROP_FALSE as SIGMA_OP_TRIVIAL_PROP_FALSE,
  OP_TRIVIAL_PROP_TRUE as SIGMA_OP_TRIVIAL_PROP_TRUE,
  OP_AND as SIGMA_OP_AND,
  OP_OR as SIGMA_OP_OR,
  OP_ATLEAST as SIGMA_OP_ATLEAST,
}

export { ReaderError }
```

Note: `sigmaBooleanOpCode` is removed — callers can switch on `sb.tag` directly. Search for any remaining call sites and refactor.

- [ ] **Step 5: Update `wire/serialize-svalue.ts` SSigmaProp case**

Current (lines 292-305):

```ts
case 'SSigmaProp': {
  assertKind(t, v, 'SigmaProp')
  if (v.value.raw.length === 0) {
    throw new SValueSerializeError('SigmaBoolean.raw is empty', 'sigma-boolean-empty')
  }
  w.writeBytes(v.value.raw)
  return
}
```

Replace with:

```ts
case 'SSigmaProp': {
  assertKind(t, v, 'SigmaProp')
  // Phase 2g-medium: structural SigmaBoolean walked by serializeSigmaBoolean.
  serializeSigmaBoolean(v.value, w)
  return
}
```

Add `import { serializeSigmaBoolean } from './sigma-boolean'` at the top of the file (next to existing `parseSigmaBoolean` / sigma-boolean imports). Remove the `'sigma-boolean-empty'` error code from `SValueSerializeError` taxonomy (no longer reachable; or leave for backwards-compat — note in commit message).

- [ ] **Step 6: Refactor `address.ts` `isP2PK` / `p2pkPublicKey` / `resolveSigmaProp`**

Read current implementations (around lines 106-160 + 229+). Replace `sb.raw[0] === OP_PROVE_DLOG` checks with `sb.tag === 'ProveDlog'`. Replace `sb.raw.length === 34` with `sb.tag === 'ProveDlog'` (the structural form's `h.length === 33` is enforced by the parser).

Concrete change to `proveDlogPublicKey` callers in `address.ts`: now imports from `wire/sigma-boolean` (already exported, signature unchanged from caller perspective — returns 33 bytes or null). Update `p2pkPublicKey` internals:

```ts
export function p2pkPublicKey(tree: ErgoTree): Uint8Array | null {
  const sigmaValue = resolveSigmaProp(tree.body, tree)
  if (sigmaValue === null) return null
  return sigmaValue.value.tag === 'ProveDlog' ? sigmaValue.value.h.slice() : null
}
```

Remove the now-unused `proveDlogPublicKey` import if `p2pkPublicKey` inlines the check (or keep it and delegate; either works). Run `grep -n "proveDlogPublicKey\|sigmaBooleanOpCode\|sb\.raw" packages/ergoscript/src/` and update every remaining call site.

- [ ] **Step 7: Write the Rust fixture-gen for per-variant wire fixtures**

Create `fixture-gen/src/cmds/ergoscript/wire/sigma_boolean_variants.rs`:

```rust
//! Per-variant wire-format fixtures for structural SigmaBoolean (phase 2g-medium Task 1).
//!
//! Generates byte-encoded SigmaBoolean trees for each of the 6 variants
//! plus a few conjecture-nesting combinations. The TS test asserts
//! parse + structural-equal + serialize round-trip.

use crate::common::write_file;
use anyhow::Result;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDhTuple, ProveDlog, SigmaBoolean, SigmaConjectureItems,
};
use ergotree_ir::sigma_protocol::sigma_boolean::cand::Cand;
use ergotree_ir::sigma_protocol::sigma_boolean::cor::Cor;
use ergotree_ir::sigma_protocol::sigma_boolean::cthreshold::Cthreshold;
use ergo_chain_types::EcPoint;
use serde::Serialize;
use sigma_test_util::force_any_val;

#[derive(Serialize)]
struct SigmaBooleanVariantFixture {
    name: String,
    /// Hex of the serialized SigmaBoolean (NOT wrapped in ErgoTree).
    bytes_hex: String,
    /// Structural description (JSON tree of the SigmaBoolean for the TS test
    /// to assert equality against).
    structural_json: serde_json::Value,
}

#[derive(Serialize)]
struct SigmaBooleanVariantsFile {
    description: &'static str,
    entries: Vec<SigmaBooleanVariantFixture>,
}

fn entry(name: &str, sb: SigmaBoolean) -> Result<SigmaBooleanVariantFixture> {
    let bytes = sb.sigma_serialize_bytes()?;
    let structural = sigma_boolean_to_json(&sb);
    Ok(SigmaBooleanVariantFixture {
        name: name.to_string(),
        bytes_hex: hex::encode(&bytes),
        structural_json: structural,
    })
}

fn sigma_boolean_to_json(sb: &SigmaBoolean) -> serde_json::Value {
    // Match the TS discriminated-union shape: { tag: '...', ...fields }.
    match sb {
        SigmaBoolean::TrivialProp(b) => serde_json::json!({
            "tag": "TrivialProp", "value": b
        }),
        SigmaBoolean::ProofOfKnowledge(pk) => {
            use ergotree_ir::sigma_protocol::sigma_boolean::SigmaProofOfKnowledgeTree;
            match pk {
                SigmaProofOfKnowledgeTree::ProveDlog(d) => serde_json::json!({
                    "tag": "ProveDlog",
                    "h": hex::encode(d.h.sigma_serialize_bytes().unwrap())
                }),
                SigmaProofOfKnowledgeTree::ProveDhTuple(d) => serde_json::json!({
                    "tag": "ProveDhTuple",
                    "g": hex::encode(d.g.sigma_serialize_bytes().unwrap()),
                    "h": hex::encode(d.h.sigma_serialize_bytes().unwrap()),
                    "u": hex::encode(d.u.sigma_serialize_bytes().unwrap()),
                    "v": hex::encode(d.v.sigma_serialize_bytes().unwrap()),
                }),
            }
        }
        SigmaBoolean::SigmaConjecture(c) => {
            use ergotree_ir::sigma_protocol::sigma_boolean::SigmaConjecture;
            match c {
                SigmaConjecture::Cand(a) => serde_json::json!({
                    "tag": "Cand",
                    "items": a.items.iter().map(sigma_boolean_to_json).collect::<Vec<_>>()
                }),
                SigmaConjecture::Cor(o) => serde_json::json!({
                    "tag": "Cor",
                    "items": o.items.iter().map(sigma_boolean_to_json).collect::<Vec<_>>()
                }),
                SigmaConjecture::Cthreshold(t) => serde_json::json!({
                    "tag": "Cthreshold",
                    "k": t.k,
                    "items": t.children.iter().map(sigma_boolean_to_json).collect::<Vec<_>>()
                }),
            }
        }
    }
}

pub fn generate() -> Result<()> {
    let mut entries = Vec::new();

    entries.push(entry("trivial-true", SigmaBoolean::TrivialProp(true))?);
    entries.push(entry("trivial-false", SigmaBoolean::TrivialProp(false))?);

    // Use known-determinant EcPoints (force_any_val under TestRunner::deterministic()).
    let pk1: EcPoint = force_any_val::<EcPoint>();
    let pk2: EcPoint = force_any_val::<EcPoint>();
    let pk3: EcPoint = force_any_val::<EcPoint>();
    let pk4: EcPoint = force_any_val::<EcPoint>();

    let dlog1 = SigmaBoolean::ProofOfKnowledge(
        ergotree_ir::sigma_protocol::sigma_boolean::SigmaProofOfKnowledgeTree::ProveDlog(
            ProveDlog::new(pk1.clone())
        )
    );
    entries.push(entry("prove-dlog-basic", dlog1.clone())?);

    let dht1 = SigmaBoolean::ProofOfKnowledge(
        ergotree_ir::sigma_protocol::sigma_boolean::SigmaProofOfKnowledgeTree::ProveDhTuple(
            ProveDhTuple::new(pk1.clone(), pk2.clone(), pk3.clone(), pk4.clone())
        )
    );
    entries.push(entry("prove-dh-tuple-basic", dht1.clone())?);

    let dlog2 = SigmaBoolean::ProofOfKnowledge(
        ergotree_ir::sigma_protocol::sigma_boolean::SigmaProofOfKnowledgeTree::ProveDlog(
            ProveDlog::new(pk2.clone())
        )
    );

    let cand_2leaves = SigmaBoolean::SigmaConjecture(
        ergotree_ir::sigma_protocol::sigma_boolean::SigmaConjecture::Cand(
            Cand::normalized(SigmaConjectureItems::try_from(vec![dlog1.clone(), dlog2.clone()]).unwrap())
                .unwrap_or_else(|_| panic!("cand normalize failed"))
        )
    );
    // If normalize produces a non-Cand (e.g. single TrivialProp), we still emit it
    // because the wire-fixture is about round-trip, not semantic shape.
    entries.push(entry("cand-two-leaves", cand_2leaves)?);

    let cor_2leaves = SigmaBoolean::SigmaConjecture(
        ergotree_ir::sigma_protocol::sigma_boolean::SigmaConjecture::Cor(
            Cor::normalized(SigmaConjectureItems::try_from(vec![dlog1.clone(), dlog2.clone()]).unwrap())
                .unwrap_or_else(|_| panic!("cor normalize failed"))
        )
    );
    entries.push(entry("cor-two-leaves", cor_2leaves)?);

    // Cthreshold k=2 of 3.
    let dlog3 = SigmaBoolean::ProofOfKnowledge(
        ergotree_ir::sigma_protocol::sigma_boolean::SigmaProofOfKnowledgeTree::ProveDlog(
            ProveDlog::new(pk3.clone())
        )
    );
    let cthresh = SigmaBoolean::SigmaConjecture(
        ergotree_ir::sigma_protocol::sigma_boolean::SigmaConjecture::Cthreshold(
            Cthreshold::new(
                2,
                SigmaConjectureItems::try_from(vec![dlog1.clone(), dlog2.clone(), dlog3]).unwrap()
            ).unwrap()
        )
    );
    entries.push(entry("cthreshold-2-of-3", cthresh)?);

    let file = SigmaBooleanVariantsFile {
        description: "Per-variant wire-format fixtures for structural SigmaBoolean (phase 2g-medium Task 1).",
        entries,
    };
    write_file(
        "packages/ergoscript/test/fixtures/wire/sigma-boolean-variants.json",
        serde_json::to_string_pretty(&file)?,
    )
}
```

Add `pub mod sigma_boolean_variants;` to `fixture-gen/src/cmds/ergoscript/wire/mod.rs`. Add `cmds::ergoscript::wire::sigma_boolean_variants::generate()?;` to the appropriate location in `fixture-gen/src/main.rs` (mirror existing wire-fixture call sites).

- [ ] **Step 8: Run fixture-gen and verify determinism**

```bash
cd /home/mwaddip/projects/ergots
cargo build --release -p fixture-gen
cargo run --release -p fixture-gen
git diff packages/ergoscript/test/fixtures/wire/sigma-boolean-variants.json  # confirm file appears
cargo run --release -p fixture-gen  # rerun
git diff packages/ergoscript/test/fixtures/wire/sigma-boolean-variants.json  # must be empty
```

If the second run shows a diff, the fixture-gen has non-determinism; investigate (likely `force_any_val` not under `TestRunner::deterministic()`).

- [ ] **Step 9: Write the failing TS roundtrip test**

Create `packages/ergoscript/test/wire/sigma-boolean-variants.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSigmaBoolean, serializeSigmaBoolean } from '../../src/wire/sigma-boolean'
import { ByteReader } from '../../src/wire/reader'
import { ByteWriter } from '../../src/wire/writer'
import { hexToBytes } from '../_helpers'
import type { SigmaBoolean } from '../../src/mir/types'

interface VariantEntry {
  name: string
  bytes_hex: string
  structural_json: any
}

interface VariantFile {
  description: string
  entries: VariantEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/wire/sigma-boolean-variants.json')
const fixture: VariantFile = JSON.parse(readFileSync(fixturePath, 'utf-8'))

function hydrateSigmaBoolean(json: any): SigmaBoolean {
  switch (json.tag) {
    case 'TrivialProp': return { tag: 'TrivialProp', value: json.value }
    case 'ProveDlog':   return { tag: 'ProveDlog', h: hexToBytes(json.h) }
    case 'ProveDhTuple':
      return {
        tag: 'ProveDhTuple',
        g: hexToBytes(json.g), h: hexToBytes(json.h),
        u: hexToBytes(json.u), v: hexToBytes(json.v),
      }
    case 'Cand': return { tag: 'Cand', items: json.items.map(hydrateSigmaBoolean) }
    case 'Cor':  return { tag: 'Cor',  items: json.items.map(hydrateSigmaBoolean) }
    case 'Cthreshold':
      return { tag: 'Cthreshold', k: json.k, items: json.items.map(hydrateSigmaBoolean) }
    default: throw new Error(`unknown SigmaBoolean tag: ${json.tag}`)
  }
}

function sigmaBooleanEquals(a: SigmaBoolean, b: SigmaBoolean): boolean {
  if (a.tag !== b.tag) return false
  switch (a.tag) {
    case 'TrivialProp': return a.value === (b as any).value
    case 'ProveDlog':   return bytesEqual(a.h, (b as any).h)
    case 'ProveDhTuple': {
      const bb = b as any
      return bytesEqual(a.g, bb.g) && bytesEqual(a.h, bb.h)
          && bytesEqual(a.u, bb.u) && bytesEqual(a.v, bb.v)
    }
    case 'Cand':
    case 'Cor': {
      const bb = b as any
      return a.items.length === bb.items.length
          && a.items.every((it, i) => sigmaBooleanEquals(it, bb.items[i]))
    }
    case 'Cthreshold': {
      const bb = b as any
      return a.k === bb.k && a.items.length === bb.items.length
          && a.items.every((it, i) => sigmaBooleanEquals(it, bb.items[i]))
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('SigmaBoolean wire-format per-variant fixtures', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name} — parse + structural-equal + round-trip`, () => {
      const bytes = hexToBytes(entry.bytes_hex)
      const parsed = parseSigmaBoolean(new ByteReader(bytes))
      const expected = hydrateSigmaBoolean(entry.structural_json)
      expect(sigmaBooleanEquals(parsed, expected)).toBe(true)

      const w = new ByteWriter()
      serializeSigmaBoolean(parsed, w)
      const reserialized = w.toBytes()
      expect(bytesEqual(reserialized, bytes)).toBe(true)
    })
  }
})
```

- [ ] **Step 10: Run test, verify it fails (red)**

```bash
cd /home/mwaddip/projects/ergots
npx vitest run packages/ergoscript/test/wire/sigma-boolean-variants.test.ts
```

Expected: FAIL (likely `parseSigmaBoolean` returns old `{ raw }` shape if Step 4 hasn't been applied, or `serializeSigmaBoolean` not exported).

- [ ] **Step 11: Apply Steps 4-6 (TS edits) if not yet done**

(Steps 3-6 are the actual edits; Step 10's red was meant as a checkpoint that the test runs against intended shape.) Re-run:

```bash
npx vitest run packages/ergoscript/test/wire/sigma-boolean-variants.test.ts
```

Expected: PASS (all per-variant entries round-trip byte-identically).

- [ ] **Step 12: Run the full ergoscript suite — acceptance gate**

```bash
npx vitest run packages/ergoscript/
```

Expected: ALL prior 1894 tests + new variant tests PASS. Particular attention to:
- `test/wire/corpus.test.ts` (or wherever the 255-fixture roundtrip lives) — still PASS
- `test/parse-mutation.test.ts` (6221-flip suite) — still PASS
- `test/address.test.ts` — `isP2PK` / `p2pkPublicKey` still PASS

If any prior test fails, the refactor regressed something — bisect to the change that broke it (most likely `address.ts` Step 6 or `serialize-svalue.ts` Step 5).

- [ ] **Step 13: Typecheck**

```bash
npx tsc --noEmit -p packages/ergoscript
```

Expected: zero errors.

- [ ] **Step 14: Two-stage review (orchestrator)**

Dispatch two parallel review subagents:
- **Spec-compliance:** reads `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` § Architecture / Wire-format migration + this Task 1, plus the diff. Verifies all 6 variants supported; opcodes match sigma-rust; new error codes shape match spec.
- **Code-quality:** reads diff. Verifies TS idioms, exhaustive `_exhaust: never` in `serializeSigmaBoolean`, no `any` leaks, defensive copies on `.slice()` for Uint8Array fields, comments cite sigma-rust source lines.

Apply fix commits if review surfaces issues.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(ergoscript): structural SigmaBoolean wire-format (phase 2g-medium task 1)

Replaces the opaque {raw: Uint8Array} shape from phase 2a with a 6-variant
discriminated union (TrivialProp / ProveDlog / ProveDhTuple / Cand / Cor /
Cthreshold). Wire parser dispatches recursively on opcode; new
serializeSigmaBoolean walks structural to emit byte-identical output.
isP2PK / p2pkPublicKey refactored to walk structural via sb.tag.

Round-trip invariant unchanged. Existing 255-fixture roundtrip + 6221-flip
mutation suites pass post-refactor.

Adds: SigmaBooleanSerializeError class; 'cthreshold-k-out-of-range',
'sigma-conjecture-empty-items' parse codes.

Per-variant wire fixtures (TrivialProp×2, ProveDlog, ProveDhTuple, Cand,
Cor, Cthreshold) generated via fixture-gen.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `@noble/curves` adapter

**Files:**
- Modify: `packages/ergoscript/package.json` — add `@noble/curves: 2.2.0` to `dependencies`
- Create: `packages/ergoscript/src/crypto/secp256k1.ts` — thin adapter (~9 functions)
- Create: `packages/ergoscript/test/crypto/secp256k1.test.ts` — unit tests for adapter

**Sigma-rust sources:**
- `ergo-chain-types/src/ec_point.rs:21, 44, 74-152` — `EcPoint` wrapper; `GROUP_SIZE = 33` SEC1; identity = 33 zero bytes; `Mul<&EcPoint>` is point-addition
- `ergotree-interpreter/src/sigma_protocol/wscalar.rs:60-76` — `scalar_from_bytes` (32 BE → mod n) + challenge-to-scalar (24 bytes → left-pad 8 zeros → mod n)
- `ergotree-interpreter/src/sigma_protocol/dlog_group.rs:46-48` — secp256k1 group order n

**Key behavior:** Localize the `@noble/curves` dependency surface to one file. Expose only the 9 operations the leaf-only verifier (Task 6) uses. Handle the Ergo identity convention (33 zero bytes ↔ point-at-infinity); this is NOT native SEC1 — `@noble/curves` does not encode/decode identity by default.

- [ ] **Step 1: Confirm `@noble/curves@2.2.0` API surface**

```bash
# Check if @noble/hashes@2.2.0 is already a dep (version-locked pair)
node -e "console.log(require('/home/mwaddip/projects/ergots/packages/ergoscript/package.json').dependencies)"
```

Read the `@noble/curves` README/types for the `secp256k1` module. Expected API surface (v2.x):
- `import { secp256k1 } from '@noble/curves/secp256k1.js'` (or `.js` may be omitted depending on ESM resolution)
- `secp256k1.Point` — Point class with `BASE` static, `fromBytes(bytes)`, `fromHex(hex)`, `toBytes(compressed?)`, `add(other)`, `negate()`, `multiply(scalar)`, `equals(other)`
- `secp256k1.CURVE.n` — group order (BigInt)
- Identity (point-at-infinity) is `secp256k1.Point.ZERO` or `Point.IDENTITY` (check API)
- `Point.fromBytes(zeros33)` likely throws (off-curve) — handle in adapter

Verify by reading `node_modules/@noble/curves` source after adding the dep.

- [ ] **Step 2: Add `@noble/curves: 2.2.0` to package.json**

Read current `packages/ergoscript/package.json` (do not write blindly). Add to `dependencies`:

```json
"@noble/curves": "2.2.0"
```

Pin exact version (no caret) — version-locked pair with `@noble/hashes: 2.2.0`. Run `npm install` (or workspace-aware equivalent — check repo root for `npm-workspaces` setup):

```bash
cd /home/mwaddip/projects/ergots
npm install
```

Verify install:

```bash
ls -la node_modules/@noble/curves/
node -e "import('@noble/curves/secp256k1.js').then(m => console.log(Object.keys(m)))" 2>&1 | head -10
```

- [ ] **Step 3: Write the failing test for the adapter**

Create `packages/ergoscript/test/crypto/secp256k1.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  decodePoint, encodePoint, pointAdd, pointNegate, pointMul,
  basePoint, groupOrder, scalarFromBytes, scalarFromChallenge,
} from '../../src/crypto/secp256k1'

const ZERO_33 = new Uint8Array(33)  // Ergo identity

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('secp256k1 adapter', () => {
  describe('identity convention (33 zero bytes ↔ point-at-infinity)', () => {
    it('decodePoint(33 zeros) returns identity', () => {
      const identity = decodePoint(ZERO_33)
      // Add identity to basePoint, should equal basePoint
      const sum = pointAdd(basePoint, identity)
      expect(bytesEqual(encodePoint(sum), encodePoint(basePoint))).toBe(true)
    })

    it('encodePoint(identity) returns 33 zero bytes', () => {
      const identity = decodePoint(ZERO_33)
      const encoded = encodePoint(identity)
      expect(bytesEqual(encoded, ZERO_33)).toBe(true)
    })
  })

  describe('basePoint encoding', () => {
    it('encodePoint(basePoint) is 33 bytes starting with 0x02 or 0x03', () => {
      const bytes = encodePoint(basePoint)
      expect(bytes.length).toBe(33)
      expect([0x02, 0x03]).toContain(bytes[0])
    })

    it('encodePoint(basePoint) round-trips through decodePoint', () => {
      const bytes = encodePoint(basePoint)
      const decoded = decodePoint(bytes)
      const reEncoded = encodePoint(decoded)
      expect(bytesEqual(reEncoded, bytes)).toBe(true)
    })
  })

  describe('groupOrder', () => {
    it('matches secp256k1 n', () => {
      // n = FFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFE_BAAEDCE6_AF48A03B_BFD25E8C_D0364141
      expect(groupOrder).toBe(
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n
      )
    })
  })

  describe('scalarFromBytes (32 BE → mod n)', () => {
    it('decodes 32-byte big-endian scalar', () => {
      const bytes = new Uint8Array(32)
      bytes[31] = 5
      expect(scalarFromBytes(bytes)).toBe(5n)
    })

    it('reduces values ≥ n', () => {
      // n + 1 in big-endian
      const nPlus1Hex = (groupOrder + 1n).toString(16).padStart(64, '0')
      const bytes = new Uint8Array(32)
      for (let i = 0; i < 32; i++) bytes[i] = parseInt(nPlus1Hex.slice(i*2, i*2+2), 16)
      expect(scalarFromBytes(bytes)).toBe(1n)
    })
  })

  describe('scalarFromChallenge (24 bytes → left-pad 8 zeros → mod n)', () => {
    it('left-pads with 8 zero bytes before reduction', () => {
      const challenge = new Uint8Array(24)
      challenge[23] = 7
      // 24-byte value 7 → left-padded becomes 32-byte BE value 7
      expect(scalarFromChallenge(challenge)).toBe(7n)
    })

    it('all-zero challenge → scalar 0', () => {
      expect(scalarFromChallenge(new Uint8Array(24))).toBe(0n)
    })

    it('max 24-byte value fits comfortably in 32 bytes after left-pad', () => {
      const challenge = new Uint8Array(24).fill(0xff)
      const expected = (1n << 192n) - 1n
      expect(scalarFromChallenge(challenge)).toBe(expected)
    })
  })

  describe('point ops', () => {
    it('pointMul(basePoint, 1) === basePoint', () => {
      const result = pointMul(basePoint, 1n)
      expect(bytesEqual(encodePoint(result), encodePoint(basePoint))).toBe(true)
    })

    it('pointMul(basePoint, 0) === identity', () => {
      const result = pointMul(basePoint, 0n)
      expect(bytesEqual(encodePoint(result), ZERO_33)).toBe(true)
    })

    it('pointMul(basePoint, n) === identity', () => {
      const result = pointMul(basePoint, groupOrder)
      expect(bytesEqual(encodePoint(result), ZERO_33)).toBe(true)
    })

    it('pointAdd(p, negate(p)) === identity', () => {
      const p2 = pointMul(basePoint, 12345n)
      const negP2 = pointNegate(p2)
      const sum = pointAdd(p2, negP2)
      expect(bytesEqual(encodePoint(sum), ZERO_33)).toBe(true)
    })
  })

  describe('decodePoint rejects off-curve bytes', () => {
    it('throws on invalid SEC1 tag', () => {
      const bytes = new Uint8Array(33)
      bytes[0] = 0xff  // invalid tag (not 0x02, 0x03, or 0x00)
      expect(() => decodePoint(bytes)).toThrow()
    })

    it('throws on wrong length', () => {
      expect(() => decodePoint(new Uint8Array(32))).toThrow()
      expect(() => decodePoint(new Uint8Array(34))).toThrow()
    })
  })
})
```

- [ ] **Step 4: Run test, verify it fails (module not found)**

```bash
npx vitest run packages/ergoscript/test/crypto/secp256k1.test.ts
```

Expected: FAIL with `Cannot find module '../../src/crypto/secp256k1'`.

- [ ] **Step 5: Implement the adapter**

Create `packages/ergoscript/src/crypto/secp256k1.ts`:

```ts
/**
 * secp256k1 adapter — phase 2g-medium.
 *
 * Thin wrapper over `@noble/curves@2.2.0`'s secp256k1 module. Exposes only
 * the operations the leaf-only sigma-protocol verifier uses (Task 6).
 * Localizes the curves dependency surface so future @noble/curves upgrades
 * touch one file.
 *
 * **Ergo identity convention:** 33 zero bytes ↔ point-at-infinity. This is
 * NOT native SEC1 — sigma-rust's `ec_point.rs:130-152` introduces this
 * convention to make sigma-proof bytes round-trip cleanly. The adapter
 * handles the conversion; no caller needs to know.
 *
 * Source: ~/projects/sigma-rust/sigma-rust/ergo-chain-types/src/ec_point.rs
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'

const ZERO_33 = new Uint8Array(33)
const POINT_BYTES = 33  // SEC1 compressed

export type Point = ReturnType<typeof secp256k1.Point.BASE.multiply>

export const basePoint: Point = secp256k1.Point.BASE
export const groupOrder: bigint = secp256k1.CURVE.n

function isZero33(bytes: Uint8Array): boolean {
  if (bytes.length !== POINT_BYTES) return false
  for (let i = 0; i < POINT_BYTES; i++) if (bytes[i] !== 0) return false
  return true
}

/**
 * Decode a 33-byte SEC1 compressed point. The Ergo convention: 33 zero bytes
 * decodes to the identity (point-at-infinity).
 *
 * Throws on wrong length or invalid SEC1 encoding.
 */
export function decodePoint(bytes: Uint8Array): Point {
  if (bytes.length !== POINT_BYTES) {
    throw new Error(`decodePoint: expected ${POINT_BYTES} bytes, got ${bytes.length}`)
  }
  if (isZero33(bytes)) {
    // Ergo identity convention — return the curve identity (point-at-infinity).
    // @noble/curves exposes this as `Point.ZERO` in v2.x.
    return secp256k1.Point.ZERO
  }
  return secp256k1.Point.fromBytes(bytes)
}

/**
 * Encode a Point to 33-byte SEC1 compressed. Identity → 33 zero bytes (Ergo
 * convention).
 */
export function encodePoint(p: Point): Uint8Array {
  if (p.equals(secp256k1.Point.ZERO)) return new Uint8Array(POINT_BYTES)
  const bytes = p.toBytes(true)  // compressed
  if (bytes.length !== POINT_BYTES) {
    throw new Error(`encodePoint: produced ${bytes.length} bytes, expected ${POINT_BYTES}`)
  }
  return bytes
}

export function pointAdd(a: Point, b: Point): Point {
  return a.add(b)
}

export function pointNegate(p: Point): Point {
  return p.negate()
}

export function pointMul(p: Point, k: bigint): Point {
  // @noble/curves throws if k === 0n on Point.BASE.multiply in some versions;
  // handle by returning identity explicitly.
  if (k === 0n) return secp256k1.Point.ZERO
  // multiply accepts scalar in [0, n); reduce defensively.
  const kReduced = ((k % groupOrder) + groupOrder) % groupOrder
  if (kReduced === 0n) return secp256k1.Point.ZERO
  return p.multiply(kReduced)
}

/**
 * Decode a 32-byte big-endian scalar, reducing mod n.
 * Mirrors sigma-rust's `Scalar::reduce_bytes` (`wscalar.rs:60-67`).
 */
export function scalarFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error(`scalarFromBytes: expected 32 bytes, got ${bytes.length}`)
  }
  let n = 0n
  for (let i = 0; i < 32; i++) {
    n = (n << 8n) | BigInt(bytes[i]!)
  }
  return n % groupOrder
}

/**
 * Decode a 24-byte challenge by left-padding with 8 zero bytes (treating it
 * as the low-order 24 bytes of a 32-byte big-endian scalar), then reducing
 * mod n.
 *
 * Source: sigma-rust `wscalar.rs:69-76`.
 *
 * Critical: the left-pad direction matters. Right-pad gives the wrong scalar
 * and silently breaks every verification.
 */
export function scalarFromChallenge(challenge: Uint8Array): bigint {
  if (challenge.length !== 24) {
    throw new Error(`scalarFromChallenge: expected 24 bytes, got ${challenge.length}`)
  }
  const padded = new Uint8Array(32)
  padded.set(challenge, 8)  // left-pad: 8 zero bytes then the 24-byte challenge
  return scalarFromBytes(padded)
}
```

(If `@noble/curves@2.2.0`'s identity API differs — e.g., `Point.IDENTITY` instead of `Point.ZERO`, or `BASE.toAffine().isZero()` — adjust accordingly. The test in Step 3 catches API drift.)

- [ ] **Step 6: Run test, verify PASS**

```bash
npx vitest run packages/ergoscript/test/crypto/secp256k1.test.ts
```

Expected: all tests PASS. If `Point.ZERO` doesn't exist, check the actual API:

```bash
node -e "import('@noble/curves/secp256k1.js').then(m => console.log(Object.keys(m.secp256k1.Point)))"
```

Adjust the `Point.ZERO` references in `secp256k1.ts` accordingly.

- [ ] **Step 7: Run full ergoscript suite**

```bash
npx vitest run packages/ergoscript/
```

Expected: all prior tests + new adapter tests PASS. The adapter is standalone — no risk of regressing prior code.

- [ ] **Step 8: Typecheck**

```bash
npx tsc --noEmit -p packages/ergoscript
```

Expected: zero errors.

- [ ] **Step 9: Browser-compat scan**

```bash
grep -E "Buffer|process\.|require\(|node:" packages/ergoscript/src/crypto/secp256k1.ts
```

Expected: no output. The adapter is pure ESM, no Node built-ins.

- [ ] **Step 10: Two-stage review (orchestrator)**

- **Spec-compliance:** verifies adapter exposes exactly the 9 functions specified in the design spec (Section 2 of `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md`); identity convention handled; left-pad direction correct in `scalarFromChallenge`.
- **Code-quality:** verifies pin-exact `@noble/curves: 2.2.0` (no caret); browser-clean; no `any` leaks; comments cite sigma-rust source lines.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ergoscript): @noble/curves@2.2.0 adapter for secp256k1 (phase 2g-medium task 2)

Thin wrapper exposing 9 ops: decodePoint/encodePoint (SEC1 33-byte with
Ergo identity convention — 33 zero bytes ↔ point-at-infinity), pointAdd/
pointNegate/pointMul, basePoint, groupOrder, scalarFromBytes (32 BE → mod
n), scalarFromChallenge (24 bytes → left-pad 8 zeros → mod n).

Localizes the curves dep surface to one file (src/crypto/secp256k1.ts).
Version-locked pair with @noble/hashes@2.2.0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `CreateProveDlog` eval arm + P2PK short-circuit

**Files:**
- Create: `packages/ergoscript/src/eval/create-prove-dlog.ts` — arm
- Modify: `packages/ergoscript/src/eval/const.ts` — 45 additional JitCost when value.kind === 'SigmaProp'
- Modify: `packages/ergoscript/src/eval/eval.ts` — add `case 'CreateProveDlog'`
- Modify: `packages/ergoscript/src/eval/errors.ts` — document `'sigma-prop-input-not-group-element'`
- Create: `fixture-gen/src/cmds/ergoscript/eval/create_prove_dlog.rs` — C1 fixture
- Create: `fixture-gen/src/cmds/ergoscript/eval/p2pk_short_circuit.rs` — smoking-gun fixture
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` — add `pub mod`s
- Modify: `fixture-gen/src/main.rs` — wire `generate_and_write` calls
- Create: `packages/ergoscript/test/eval/create-prove-dlog.test.ts`
- Create: `packages/ergoscript/test/eval/p2pk-short-circuit.test.ts`

**Sigma-rust sources:**
- `ergotree-ir/src/mir/create_provedlog.rs:14-17, 39-46` — MIR shape `{ input: Box<Expr> }`; `OneArgOpTryBuild` requires `input.tpe == SGroupElement`
- `ergotree-interpreter/src/eval/create_provedlog.rs:10-29` — eval; `add_jit_cost(10)`; wrap `Value::GroupElement(*ecpoint)` as `ProveDlog::new(*ecpoint)`
- `ergotree-interpreter/src/eval.rs:138-158, 268-278` — `EVAL_SIGMA_PROP_CONSTANT = 50` short-circuit for `Const(SSigmaProp, _)` and `ConstPlaceholder` resolving to a SigmaProp

**Key behavior:**

`evalCreateProveDlog`: Pattern A cost `Fixed(10)` BEFORE eval-child; evaluate input; verify `kind === 'GroupElement'`; wrap as `{ kind: 'SigmaProp', value: { tag: 'ProveDlog', h: input.value } }`. Throws `'sigma-prop-input-not-group-element'` on type mismatch.

`evalConst` P2PK short-circuit: when the constant's value is a `SigmaProp`, charge an additional 45 JitCost (total 5 + 45 = 50, matching sigma-rust's `EVAL_SIGMA_PROP_CONSTANT`).

- [ ] **Step 1: Read sigma-rust source**

```bash
sed -n '1,50p' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_provedlog.rs
sed -n '1,40p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/create_provedlog.rs
sed -n '130,170p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval.rs
sed -n '260,290p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval.rs
```

Confirm: `add_jit_cost(10)` charged before input eval; `EVAL_SIGMA_PROP_CONSTANT = 50` applied as a flat charge on Const-resolved SigmaProps; both `Const` and `ConstPlaceholder` paths short-circuit.

- [ ] **Step 2: Read existing TS state**

```bash
cat /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/const.ts
grep -n "case 'Const'" /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/eval.ts | head -5
grep -n "CreateProveDlog" /home/mwaddip/projects/ergots/packages/ergoscript/src/mir/types.ts
```

Confirm: `CreateProveDlog` MIR variant already exists in `mir/types.ts` (phase 2a parsed it). Confirm the existing `Const` arm shape (lines ~20-23 from prior Explore findings).

- [ ] **Step 3: Write the failing test for CreateProveDlog**

Create `packages/ergoscript/test/eval/create-prove-dlog.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, captureEvalError, rehydrateEvalOpts } from '../_helpers'

interface CreateProveDlogEntry {
  name: string
  tree_bytes_hex: string
  opts_json: any
  expected_value_json: any | null
  expected_cost: number
  expected_error_code: string | null
}

interface CreateProveDlogFixture {
  description: string
  entries: CreateProveDlogEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/create-prove-dlog.json')
const fixture: CreateProveDlogFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('CreateProveDlog eval arm', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))

      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err?.code).toBe(entry.expected_error_code)
        return
      }

      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 4: Run test, verify it fails (fixture missing)**

```bash
npx vitest run packages/ergoscript/test/eval/create-prove-dlog.test.ts
```

Expected: FAIL — fixture file not yet generated.

- [ ] **Step 5: Write the Rust fixture-gen for CreateProveDlog**

Create `fixture-gen/src/cmds/ergoscript/eval/create_prove_dlog.rs`. Mirror the existing `coll_fold.rs` pattern (use `try_eval_out::<Value<'static>>` against a controlled or default Context). Entries:

```rust
//! CreateProveDlog C1 fixture (phase 2g-medium Task 3).
//!
//! Entries:
//!   - basic: ProveDlog from a known GroupElement constant; cost = 10 + envelope
//!   - identity-point: ProveDlog from the 33-zero-bytes identity (Ergo convention)
//!   - cost-limit: tight jitCostLimit triggers 'cost-limit-exceeded'

use crate::common::write_file;
use anyhow::Result;
use ergo_chain_types::EcPoint;
use ergotree_ir::ergo_tree::ErgoTreeHeaderFlags;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::create_provedlog::CreateProveDlog;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use ergotree_interpreter::eval::try_eval_out;
use ergotree_interpreter::eval::context::Context;
use ergotree_interpreter::eval::env::Env;
use ergotree_interpreter::sigma_protocol::dlog_protocol::INTERACTIVE_PROVER_CHALLENGE_SIZE;  // not used here, retained for reference
use sigma_test_util::force_any_val;
use serde::Serialize;

#[derive(Serialize)]
struct CreateProveDlogEntry {
    name: String,
    tree_bytes_hex: String,
    opts_json: serde_json::Value,
    expected_value_json: Option<serde_json::Value>,
    expected_cost: u32,
    expected_error_code: Option<String>,
}

#[derive(Serialize)]
struct CreateProveDlogFixture {
    description: &'static str,
    entries: Vec<CreateProveDlogEntry>,
}

fn build_tree(body: Expr) -> Result<(Vec<u8>, String)> {
    use ergotree_ir::ergo_tree::ErgoTree;
    let tree = ErgoTree::new(
        ErgoTree::header_v0_no_segregation(),  // adjust based on existing helper in fixture-gen
        &body
    )?;
    let bytes = tree.sigma_serialize_bytes()?;
    let hex = hex::encode(&bytes);
    Ok((bytes, hex))
}

fn run_value(body: &Expr) -> Result<(serde_json::Value, u32)> {
    let ctx = force_any_val::<Context>();
    let env = Env::empty();
    let (val, cost) = try_eval_out::<ergotree_ir::mir::value::Value>(body, &env, &ctx)?;
    // Cost = ctx.jit_cost after eval - cost before (here ctx is fresh, so just final).
    let value_json = value_to_json(&val);
    Ok((value_json, cost as u32))
}

fn value_to_json(v: &ergotree_ir::mir::value::Value) -> serde_json::Value {
    // For SigmaProp values, recursively serialize to match the TS hydrateSValue shape.
    // Use sigma_boolean_to_json from wire/sigma_boolean_variants.rs (Task 1) — share it.
    use ergotree_ir::mir::value::Value;
    match v {
        Value::SigmaProp(sp) => serde_json::json!({
            "kind": "SigmaProp",
            "value": crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json(sp.value())
        }),
        // Reuse existing value_to_json helpers in fixture-gen if available; otherwise
        // include only the kinds this fixture needs.
        _ => unimplemented!("value_to_json: only SigmaProp expected for CreateProveDlog"),
    }
}

pub fn generate() -> Result<()> {
    let mut entries = Vec::new();

    // Entry 1: basic — wrap a known GroupElement Constant
    let pk: EcPoint = force_any_val::<EcPoint>();
    let pk_const = Expr::Const(Constant {
        tpe: SType::SGroupElement,
        v: ergotree_ir::mir::value::Value::GroupElement(Box::new(pk.clone())),
    });
    let basic_expr = Expr::CreateProveDlog(CreateProveDlog::new(pk_const.clone())?);
    let (tree_bytes, tree_hex) = build_tree(basic_expr.clone())?;
    let (expected_value, expected_cost) = run_value(&basic_expr)?;
    entries.push(CreateProveDlogEntry {
        name: "basic".to_string(),
        tree_bytes_hex: tree_hex,
        opts_json: serde_json::json!({}),
        expected_value_json: Some(expected_value),
        expected_cost,
        expected_error_code: None,
    });

    // Entry 2: identity point (33 zeros)
    let identity_pt = EcPoint::from_sigma_bytes(&[0u8; 33])?;
    let identity_const = Expr::Const(Constant {
        tpe: SType::SGroupElement,
        v: ergotree_ir::mir::value::Value::GroupElement(Box::new(identity_pt)),
    });
    let identity_expr = Expr::CreateProveDlog(CreateProveDlog::new(identity_const.clone())?);
    let (tree_bytes2, tree_hex2) = build_tree(identity_expr.clone())?;
    let (expected_value2, expected_cost2) = run_value(&identity_expr)?;
    entries.push(CreateProveDlogEntry {
        name: "identity-point".to_string(),
        tree_bytes_hex: tree_hex2,
        opts_json: serde_json::json!({}),
        expected_value_json: Some(expected_value2),
        expected_cost: expected_cost2,
        expected_error_code: None,
    });

    // Entry 3: cost-limit-exceeded
    entries.push(CreateProveDlogEntry {
        name: "cost-limit-exceeded".to_string(),
        tree_bytes_hex: hex::encode(&tree_bytes),  // reuse basic tree bytes
        opts_json: serde_json::json!({ "jitCostLimit": 5 }),  // less than the arm's 10
        expected_value_json: None,
        expected_cost: 0,
        expected_error_code: Some("cost-limit-exceeded".to_string()),
    });

    let file = CreateProveDlogFixture {
        description: "CreateProveDlog C1 fixture — wraps a GroupElement input into a SigmaProp{ProveDlog, h}; Pattern A cost Fixed(10).",
        entries,
    };
    write_file(
        "packages/ergoscript/test/fixtures/eval/create-prove-dlog.json",
        serde_json::to_string_pretty(&file)?,
    )
}
```

(Adjust imports and helper function references to match the existing `fixture-gen` module structure. The `value_to_json` and `build_tree` helpers likely already exist in a `common.rs` or similar — reuse them.)

Add `pub mod create_prove_dlog;` to `fixture-gen/src/cmds/ergoscript/eval/mod.rs`. Add the call to `fixture-gen/src/main.rs`.

- [ ] **Step 6: Write Rust fixture-gen for P2PK short-circuit smoking-gun**

Create `fixture-gen/src/cmds/ergoscript/eval/p2pk_short_circuit.rs`. The fixture entry is a bare `Const(SSigmaProp, ProveDlog(pk))` tree:

```rust
//! P2PK short-circuit smoking-gun (phase 2g-medium Task 3).
//!
//! A bare Const(SSigmaProp, ProveDlog(pk)) tree evaluates with cost = 50
//! (sigma-rust's EVAL_SIGMA_PROP_CONSTANT), NOT 5 (standard Const charge).
//!
//! Source: ergotree-interpreter/src/eval.rs:138-158, 268-278
use crate::common::write_file;
use anyhow::Result;
use ergo_chain_types::EcPoint;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::sigma_protocol::sigma_boolean::{ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree};
use ergotree_ir::types::stype::SType;
use sigma_test_util::force_any_val;
use serde::Serialize;

// Reuse types from create_prove_dlog.rs or define inline
#[derive(Serialize)]
struct P2pkEntry {
    name: String,
    tree_bytes_hex: String,
    opts_json: serde_json::Value,
    expected_value_json: serde_json::Value,
    expected_cost: u32,
}

#[derive(Serialize)]
struct P2pkFixture {
    description: &'static str,
    entries: Vec<P2pkEntry>,
}

pub fn generate() -> Result<()> {
    let pk: EcPoint = force_any_val::<EcPoint>();
    let sb = SigmaBoolean::ProofOfKnowledge(
        SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(pk.clone()))
    );
    let body = Expr::Const(Constant {
        tpe: SType::SSigmaProp,
        v: Value::SigmaProp(Box::new(ergotree_ir::sigma_protocol::sigma_boolean::SigmaProp::new(sb.clone()))),
    });

    // Build tree + serialize + run eval, capture cost = 50.
    // ... (mirror Task 3 Step 5 pattern)

    let entries = vec![ /* ... */ ];
    let file = P2pkFixture {
        description: "P2PK short-circuit: Const(SSigmaProp, ProveDlog(pk)) charges 50 JitCost via EVAL_SIGMA_PROP_CONSTANT.",
        entries,
    };
    write_file(
        "packages/ergoscript/test/fixtures/eval/p2pk-short-circuit.json",
        serde_json::to_string_pretty(&file)?,
    )
}
```

Add the `pub mod` + `generate_and_write` wiring.

- [ ] **Step 7: Run fixture-gen and verify determinism**

```bash
cd /home/mwaddip/projects/ergots
cargo run --release -p fixture-gen
ls -la packages/ergoscript/test/fixtures/eval/create-prove-dlog.json packages/ergoscript/test/fixtures/eval/p2pk-short-circuit.json
cargo run --release -p fixture-gen
git diff packages/ergoscript/test/fixtures/  # must be empty
```

- [ ] **Step 8: Add the EvalError code to `eval/errors.ts`**

Read the current `eval/errors.ts` to find the right place to add the new code (likely a comment-grouped section). Add:

```ts
// --- phase 2g-medium: sigma-protocol primitives ---

/**
 * `CreateProveDlog` / `CreateProveDhTuple` input expression evaluated to a
 * non-GroupElement SValue. Wire-format invariants make this unreachable for
 * parser-produced trees (sigma-rust's `OneArgOpTryBuild`/`new` reject at
 * construction); defensive against `ConstantPlaceholder` injection and
 * future MIR shape changes.
 */
'sigma-prop-input-not-group-element',
```

(The exact format depends on whether `errors.ts` uses a string-literal union, a documented constant list, or runtime enum-like object. Match the existing pattern.)

- [ ] **Step 9: Write the P2PK short-circuit test**

Create `packages/ergoscript/test/eval/p2pk-short-circuit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue } from '../_helpers'

interface P2pkEntry {
  name: string
  tree_bytes_hex: string
  opts_json: any
  expected_value_json: any
  expected_cost: number
}

interface P2pkFixture {
  description: string
  entries: P2pkEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/p2pk-short-circuit.json')
const fixture: P2pkFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('P2PK short-circuit (Const(SSigmaProp, _) = 50 JitCost)', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({})
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
      expect(ctx.jitCost).toBe(50)  // sanity check: locks the EVAL_SIGMA_PROP_CONSTANT charge
    })
  }
})
```

- [ ] **Step 10: Run both tests, verify FAIL**

```bash
npx vitest run packages/ergoscript/test/eval/create-prove-dlog.test.ts packages/ergoscript/test/eval/p2pk-short-circuit.test.ts
```

Expected: FAIL — `CreateProveDlog` arm not implemented; P2PK charge is 5 not 50.

- [ ] **Step 11: Implement `evalCreateProveDlog`**

Create `packages/ergoscript/src/eval/create-prove-dlog.ts`:

```ts
/**
 * `CreateProveDlog` evaluator arm — wraps a GroupElement into a
 * SigmaProp{ProveDlog, h}.
 *
 * Pattern A: Fixed(10) cost BEFORE eval-child.
 * Source: ergotree-interpreter/src/eval/create_provedlog.rs:10-29
 */

import type { CreateProveDlog } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import type { SValue } from '../mir/types'
import { evalExpr } from './eval'

export function evalCreateProveDlog(e: CreateProveDlog, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(10)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'GroupElement') {
    throw new EvalError(
      `CreateProveDlog: expected GroupElement input, got ${input.kind}`,
      'sigma-prop-input-not-group-element'
    )
  }
  return { kind: 'SigmaProp', value: { tag: 'ProveDlog', h: input.value } }
}
```

(`CreateProveDlog`'s MIR shape — `{ tag: 'CreateProveDlog', input: Expr }` — is already declared in `mir/types.ts` from phase 2a. Confirm with `grep -n "CreateProveDlog" packages/ergoscript/src/mir/types.ts`.)

- [ ] **Step 12: Wire `CreateProveDlog` into `eval/eval.ts`**

Add the case line. Find the existing `switch (e.tag)` block and add:

```ts
case 'CreateProveDlog': return evalCreateProveDlog(e, env, ctx)
```

Plus the import at the top:

```ts
import { evalCreateProveDlog } from './create-prove-dlog'
```

- [ ] **Step 13: Modify `eval/const.ts` for P2PK short-circuit**

Current (lines 20-23):

```ts
export function evalConst(e: Const, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5)
  return e.value
}
```

Replace with:

```ts
export function evalConst(e: Const, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5)
  // P2PK short-circuit: a Const(SSigmaProp, _) charges an additional 45
  // JitCost (total = 50), matching sigma-rust's EVAL_SIGMA_PROP_CONSTANT.
  // Source: ergotree-interpreter/src/eval.rs:138-158, 268-278
  if (e.value.kind === 'SigmaProp') {
    ctx.addCost(45)
  }
  return e.value
}
```

Also check `eval/const-placeholder.ts` (or wherever ConstPlaceholder is handled). The same 45-additional charge applies when a ConstPlaceholder resolves to a SigmaProp:

```bash
grep -rn "ConstPlaceholder\|evalConstPlaceholder" /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/
```

Apply the same conditional `addCost(45)` after the placeholder resolves to its SValue.

- [ ] **Step 14: Run tests, verify PASS**

```bash
npx vitest run packages/ergoscript/test/eval/create-prove-dlog.test.ts packages/ergoscript/test/eval/p2pk-short-circuit.test.ts
```

Expected: all entries PASS.

- [ ] **Step 15: Run full ergoscript suite**

```bash
npx vitest run packages/ergoscript/
```

Expected: all prior 1894 tests + new tests PASS. The P2PK short-circuit modification to `evalConst` adds cost ONLY when `kind === 'SigmaProp'` — existing Const tests with Boolean/Long/Int/Coll values are unaffected. Confirm by checking `evaluate-const.test.ts` or equivalent passes.

- [ ] **Step 16: Typecheck**

```bash
npx tsc --noEmit -p packages/ergoscript
```

Expected: zero errors.

- [ ] **Step 17: Two-stage review (orchestrator)**

- **Spec-compliance:** `evalCreateProveDlog` matches `create_provedlog.rs:10-29` (cost 10, Pattern A, error code). P2PK short-circuit charges +45 (total 50). Smoking-gun fixture asserts exactly 50.
- **Code-quality:** EvalError code added to taxonomy in alphabetical or thematic location matching existing convention; comment cites source line; no `any` leaks.

- [ ] **Step 18: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ergoscript): CreateProveDlog eval arm + P2PK 50-JitCost short-circuit (phase 2g-medium task 3)

evalCreateProveDlog: Pattern A Fixed(10); throws 'sigma-prop-input-not-
group-element' on non-GroupElement input. Wraps SigmaProp{ProveDlog, h}.

evalConst: adds 45 additional JitCost when value.kind === 'SigmaProp'
(total = 50), matching sigma-rust's EVAL_SIGMA_PROP_CONSTANT. Smoking-gun
fixture (p2pk-short-circuit) locks this charge.

C1 fixture: create-prove-dlog (basic, identity-point, cost-limit-
exceeded). Coverage 42 → 43 of ~70 arms.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `CreateProveDhTuple` eval arm

**Files:**
- Create: `packages/ergoscript/src/eval/create-prove-dh-tuple.ts` — arm
- Modify: `packages/ergoscript/src/eval/eval.ts` — add `case 'CreateProveDhTuple'`
- Create: `fixture-gen/src/cmds/ergoscript/eval/create_prove_dh_tuple.rs` — C1 fixture
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` — add `pub mod`
- Modify: `fixture-gen/src/main.rs` — wire `generate_and_write`
- Create: `packages/ergoscript/test/eval/create-prove-dh-tuple.test.ts`

**Sigma-rust sources:**
- `ergotree-ir/src/mir/create_prove_dh_tuple.rs:18-42` — MIR `{ g, h, u, v: Box<Expr> }`; all four must be `SGroupElement`
- `ergotree-interpreter/src/eval/create_prove_dh_tuple.rs:12-25` — eval; `add_jit_cost(20)`; wrap

**Key behavior:** Pattern A cost `Fixed(20)` BEFORE eval-children; evaluate all four inputs; each must be `GroupElement`; wrap as `{ kind: 'SigmaProp', value: { tag: 'ProveDhTuple', g, h, u, v } }`. Reuses error code `'sigma-prop-input-not-group-element'` from Task 3 — no new code.

- [ ] **Step 1: Read sigma-rust source**

```bash
sed -n '1,45p' ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_prove_dh_tuple.rs
sed -n '1,35p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/create_prove_dh_tuple.rs
```

Confirm: `Fixed(20)` cost; four fields evaluated in `g, h, u, v` order; each checked for `Value::GroupElement`.

- [ ] **Step 2: Write the failing test**

Create `packages/ergoscript/test/eval/create-prove-dh-tuple.test.ts`. Mirror Task 3 Step 3 exactly with `CreateProveDhTuple` substituted for `CreateProveDlog` and `create-prove-dh-tuple.json` as the fixture path. (Copy-edit, then change identifier references.) Same imports + fixture-loading pattern.

- [ ] **Step 3: Write the Rust fixture-gen for CreateProveDhTuple**

Create `fixture-gen/src/cmds/ergoscript/eval/create_prove_dh_tuple.rs`. Mirror the Task 3 Step 5 pattern. Entries:

1. **`basic`** — four distinct GroupElement constants → SigmaProp{ProveDhTuple, g, h, u, v}; cost = 20 (+ Const charges for the 4 inputs).
2. **`identity-g`** — `g` is 33 zeros (identity); rest are non-identity. Same wrap, but `g` field is identity.
3. **`g-not-group-element`** — `g` is a `Const(SInt, 5)` (hand-built MIR — fixture-gen Rust will reject at `CreateProveDhTuple::new` so this MUST be hand-built in TS, not generated by Rust. Write this entry as a TS-only inline test rather than a Rust-generated fixture — same pattern as 2c LogicalNot's inline error tests). See Step 4.
4. **`cost-limit-exceeded`** — `jitCostLimit: 10` (less than 20), reuses basic tree bytes; expects error.

Add `pub mod create_prove_dh_tuple;` + main.rs wiring.

- [ ] **Step 4: Add inline TS-only error test for non-GroupElement input**

In `packages/ergoscript/test/eval/create-prove-dh-tuple.test.ts`, append an inline test that bypasses the parser (since sigma-rust's `try_build` rejects mismatched types at construction):

```ts
import type { CreateProveDhTuple, Expr } from '../../src/mir/types'

describe('CreateProveDhTuple inline error cases', () => {
  it("throws 'sigma-prop-input-not-group-element' when g is non-GroupElement", () => {
    const ge: Expr = { tag: 'Const', tpe: { tag: 'SGroupElement' },
      value: { kind: 'GroupElement', value: new Uint8Array(33) } }
    const badG: Expr = { tag: 'Const', tpe: { tag: 'SInt' },
      value: { kind: 'Int', value: 5 } }
    const expr: CreateProveDhTuple = { tag: 'CreateProveDhTuple', g: badG, h: ge, u: ge, v: ge }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalExpr(expr, emptyEnv(), ctx))
    expect(err?.code).toBe('sigma-prop-input-not-group-element')
  })
  // Symmetric tests for h, u, v
  // (Repeat the pattern 3 more times with badH/badU/badV in respective positions)
})
```

(Import `evalExpr` from `'../../src/eval/eval'`; import `emptyEnv` from `'../../src/eval/env'` or equivalent.)

- [ ] **Step 5: Run fixture-gen + determinism check**

```bash
cd /home/mwaddip/projects/ergots
cargo run --release -p fixture-gen
cargo run --release -p fixture-gen  # rerun
git diff packages/ergoscript/test/fixtures/  # must be empty
```

- [ ] **Step 6: Run test, verify FAIL**

```bash
npx vitest run packages/ergoscript/test/eval/create-prove-dh-tuple.test.ts
```

Expected: FAIL — arm not implemented.

- [ ] **Step 7: Implement `evalCreateProveDhTuple`**

Create `packages/ergoscript/src/eval/create-prove-dh-tuple.ts`:

```ts
/**
 * `CreateProveDhTuple` evaluator arm — wraps 4 GroupElements into a
 * SigmaProp{ProveDhTuple, g, h, u, v}.
 *
 * Pattern A: Fixed(20) cost BEFORE eval-children.
 * Source: ergotree-interpreter/src/eval/create_prove_dh_tuple.rs:12-25
 */

import type { CreateProveDhTuple, SValue, Expr } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

function expectGroupElement(v: SValue, fieldName: string): Uint8Array {
  if (v.kind !== 'GroupElement') {
    throw new EvalError(
      `CreateProveDhTuple: expected GroupElement for ${fieldName}, got ${v.kind}`,
      'sigma-prop-input-not-group-element'
    )
  }
  return v.value
}

export function evalCreateProveDhTuple(e: CreateProveDhTuple, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(20)
  const g = expectGroupElement(evalExpr(e.g, env, ctx), 'g')
  const h = expectGroupElement(evalExpr(e.h, env, ctx), 'h')
  const u = expectGroupElement(evalExpr(e.u, env, ctx), 'u')
  const v = expectGroupElement(evalExpr(e.v, env, ctx), 'v')
  return { kind: 'SigmaProp', value: { tag: 'ProveDhTuple', g, h, u, v } }
}
```

- [ ] **Step 8: Wire into `eval/eval.ts`**

Add the case + import:

```ts
import { evalCreateProveDhTuple } from './create-prove-dh-tuple'

// in the switch:
case 'CreateProveDhTuple': return evalCreateProveDhTuple(e, env, ctx)
```

- [ ] **Step 9: Run test, verify PASS**

```bash
npx vitest run packages/ergoscript/test/eval/create-prove-dh-tuple.test.ts
```

Expected: all entries PASS (including the 4 inline error tests).

- [ ] **Step 10: Run full suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all 1894+ prior tests + Task 3 tests + Task 4 tests PASS; zero typecheck errors.

- [ ] **Step 11: Two-stage review (orchestrator)**

- **Spec-compliance:** `evalCreateProveDhTuple` matches `create_prove_dh_tuple.rs:12-25` (cost 20, Pattern A, evaluation order g→h→u→v); error code reused, not duplicated.
- **Code-quality:** `expectGroupElement` is a local helper (not promoted — 4 callers within one file, per Decision #10); comment cites source.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ergoscript): CreateProveDhTuple eval arm (phase 2g-medium task 4)

evalCreateProveDhTuple: Pattern A Fixed(20); evaluates g/h/u/v in order;
each must be GroupElement. Wraps SigmaProp{ProveDhTuple, g, h, u, v}.

Reuses 'sigma-prop-input-not-group-element' code from Task 3.

C1 fixture: create-prove-dh-tuple (basic, identity-g, cost-limit-
exceeded) + 4 inline TS-only error tests for per-position non-GroupElement
inputs (hand-built MIR since sigma-rust try_build rejects at construction).
Coverage 43 → 44 of ~70 arms.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Verifier infrastructure modules

**Files:**
- Create: `packages/ergoscript/src/sigma/errors.ts` — `VerifyError` class + codes
- Create: `packages/ergoscript/src/sigma/challenge.ts` — 24-byte challenge ops + scalar conversion
- Create: `packages/ergoscript/src/sigma/sig-serializer.ts` — parse sigma-proof bytes guided by SigmaBoolean tree (leaf-only paths)
- Create: `packages/ergoscript/src/sigma/fiat-shamir.ts` — serialize SigmaBoolean + commitments for blake2b hash input
- Create: `packages/ergoscript/test/sigma/challenge.test.ts`
- Create: `packages/ergoscript/test/sigma/sig-serializer.test.ts`
- Create: `packages/ergoscript/test/sigma/fiat-shamir.test.ts`

**Sigma-rust sources:**
- `ergotree-interpreter/src/sigma_protocol.rs:104-110` — `SOUNDNESS_BITS = 192, SOUNDNESS_BYTES = 24, GROUP_SIZE = 32`
- `ergotree-interpreter/src/sigma_protocol/challenge.rs:28-49` — Challenge struct + XOR + 24-byte serialization
- `ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:118-255` — sigma-proof byte format
- `ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs:70-200` — tree-to-bytes serialization + 24-byte hash truncation
- `ergotree-interpreter/src/sigma_protocol/wscalar.rs:60-76` — scalar conversions (already adapted in Task 2)

**Key behavior:** Ship the primitives Task 6 will compose into the full verifier. Each module is unit-tested in isolation. No orchestration in this task — that's Task 6.

- [ ] **Step 1: Read sigma-rust source**

```bash
sed -n '100,120p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol.rs
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/challenge.rs
sed -n '60,80p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs
sed -n '140,200p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs
sed -n '110,170p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs
```

Confirm: challenges are 24 bytes; Fiat-Shamir takes `blake2b256(input)` then first 24 bytes; `prop_bytes` at lines 148-157 wraps SigmaProp in ErgoTree v0 + constant-segregation=true; child counts in Fiat-Shamir use `put_i16_be_bytes` (2-byte BE, not VLQ).

- [ ] **Step 2: Create `sigma/errors.ts`**

```ts
/**
 * `VerifyError` — typed failure surface for `verifySignature` and the
 * sigma-protocol verifier infrastructure (phase 2g-medium).
 *
 * Distinct from `EvalError` (which is for eval-time arm failures); the
 * verifier is a separate public function and surface area.
 *
 * Codes:
 *   - 'conjecture-not-implemented'  — Cand/Cor/Cthreshold input (deferred to 2g-combinators)
 *   - 'empty-signature'             — signature byte sequence is empty
 *   - 'truncated-signature'         — signature ran out of bytes before tree walk completed
 *   - 'point-not-on-curve'          — SEC1 decode rejected a leaf's pubkey/component
 *   - 'scalar-out-of-range'         — z scalar read from signature is >= group order n
 */

export class VerifyError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'VerifyError'
  }
}

export type VerifyErrorCode =
  | 'conjecture-not-implemented'
  | 'empty-signature'
  | 'truncated-signature'
  | 'point-not-on-curve'
  | 'scalar-out-of-range'
```

- [ ] **Step 3: Write test for `sigma/challenge.ts`**

Create `packages/ergoscript/test/sigma/challenge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { challengeXor, CHALLENGE_BYTES } from '../../src/sigma/challenge'

function makeChallenge(fillByte: number): Uint8Array {
  return new Uint8Array(CHALLENGE_BYTES).fill(fillByte)
}

describe('challenge primitives', () => {
  it('CHALLENGE_BYTES === 24', () => {
    expect(CHALLENGE_BYTES).toBe(24)
  })

  describe('challengeXor', () => {
    it('XOR of all-zeros and x = x', () => {
      const zeros = makeChallenge(0)
      const ones = makeChallenge(0xff)
      const result = challengeXor(zeros, ones)
      for (let i = 0; i < CHALLENGE_BYTES; i++) expect(result[i]).toBe(0xff)
    })

    it('XOR of x and x = zeros', () => {
      const x = makeChallenge(0xa5)
      const result = challengeXor(x, x)
      for (let i = 0; i < CHALLENGE_BYTES; i++) expect(result[i]).toBe(0)
    })

    it('is commutative', () => {
      const a = new Uint8Array(CHALLENGE_BYTES)
      const b = new Uint8Array(CHALLENGE_BYTES)
      for (let i = 0; i < CHALLENGE_BYTES; i++) { a[i] = i; b[i] = (i * 3 + 7) % 256 }
      const ab = challengeXor(a, b)
      const ba = challengeXor(b, a)
      for (let i = 0; i < CHALLENGE_BYTES; i++) expect(ab[i]).toBe(ba[i])
    })

    it('throws on length mismatch', () => {
      expect(() => challengeXor(new Uint8Array(24), new Uint8Array(23))).toThrow()
      expect(() => challengeXor(new Uint8Array(23), new Uint8Array(24))).toThrow()
    })
  })
})
```

- [ ] **Step 4: Implement `sigma/challenge.ts`**

```ts
/**
 * 24-byte sigma-protocol challenge operations.
 *
 * Challenges in Ergo's sigma protocols are 24 bytes (`SOUNDNESS_BITS = 192`).
 * The constant is hard-coded at the protocol level — Cthreshold polynomials
 * require GF(2^192). See sigma-rust `sigma_protocol.rs:104-107`.
 *
 * Scalar conversion (24-byte challenge → 32-byte scalar via left-pad) is
 * provided by `crypto/secp256k1.ts::scalarFromChallenge`; this module is
 * for byte-level operations on the 24-byte form.
 */

export const CHALLENGE_BYTES = 24

/**
 * Bytewise XOR of two challenges. Used to derive the last child's challenge
 * in a Cor (sig_serializer.rs:199-205) — defer to 2g-combinators verifier.
 */
export function challengeXor(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== CHALLENGE_BYTES || b.length !== CHALLENGE_BYTES) {
    throw new Error(`challengeXor: expected ${CHALLENGE_BYTES} bytes, got ${a.length}/${b.length}`)
  }
  const result = new Uint8Array(CHALLENGE_BYTES)
  for (let i = 0; i < CHALLENGE_BYTES; i++) result[i] = a[i]! ^ b[i]!
  return result
}
```

- [ ] **Step 5: Run challenge test, verify PASS**

```bash
npx vitest run packages/ergoscript/test/sigma/challenge.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write test for `sigma/sig-serializer.ts` (leaf-only paths)**

Create `packages/ergoscript/test/sigma/sig-serializer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readProofBytes, ProofBytesReader } from '../../src/sigma/sig-serializer'
import { CHALLENGE_BYTES } from '../../src/sigma/challenge'
import { VerifyError } from '../../src/sigma/errors'

describe('ProofBytesReader', () => {
  it('reads a 24-byte top-level challenge from a 56-byte ProveDlog proof', () => {
    const proof = new Uint8Array(56)
    for (let i = 0; i < 24; i++) proof[i] = 0xa0 + i
    for (let i = 0; i < 32; i++) proof[24 + i] = 0xb0 + i
    const reader = new ProofBytesReader(proof)
    const challenge = reader.readChallenge()
    expect(challenge.length).toBe(CHALLENGE_BYTES)
    expect(challenge[0]).toBe(0xa0)
    expect(challenge[23]).toBe(0xa0 + 23)
  })

  it('reads a 32-byte scalar following the challenge', () => {
    const proof = new Uint8Array(56)
    proof[24] = 0xff  // first byte of the 32-byte scalar
    proof[55] = 0x01  // last byte
    const reader = new ProofBytesReader(proof)
    reader.readChallenge()
    const scalar = reader.readScalarBytes()
    expect(scalar.length).toBe(32)
    expect(scalar[0]).toBe(0xff)
    expect(scalar[31]).toBe(0x01)
  })

  it('throws truncated-signature when challenge bytes missing', () => {
    const reader = new ProofBytesReader(new Uint8Array(10))
    expect(() => reader.readChallenge()).toThrow(VerifyError)
    try { new ProofBytesReader(new Uint8Array(10)).readChallenge() }
    catch (e: any) { expect(e.code).toBe('truncated-signature') }
  })

  it('throws truncated-signature when scalar bytes missing', () => {
    const reader = new ProofBytesReader(new Uint8Array(30))
    reader.readChallenge()  // succeeds (24 bytes)
    expect(() => reader.readScalarBytes()).toThrow(VerifyError)
  })

  it('throws empty-signature on zero-length input via readProofBytes guard', () => {
    expect(() => readProofBytes(new Uint8Array(0))).toThrow(VerifyError)
    try { readProofBytes(new Uint8Array(0)) }
    catch (e: any) { expect(e.code).toBe('empty-signature') }
  })
})
```

- [ ] **Step 7: Implement `sigma/sig-serializer.ts`**

```ts
/**
 * Sigma-proof byte reader — phase 2g-medium leaf-only.
 *
 * Provides primitives for reading proof bytes structurally guided by a
 * SigmaBoolean tree. The verifier (Task 6) composes these into the full
 * tree walk.
 *
 * Per-leaf format (sigma-rust `sig_serializer.rs:148-172`):
 *   ProveDlog:     [24-byte challenge if required] + [32-byte z scalar]
 *   ProveDhTuple:  [24-byte challenge if required] + [32-byte z scalar]
 *
 * Top-level always has the 24-byte challenge (`sig_serializer.rs:143`).
 *
 * Conjecture handling (Cand inherits parent; Cor XORs; Cthreshold
 * polynomial) is NOT in 2g-medium — deferred to 2g-combinators.
 */

import { CHALLENGE_BYTES } from './challenge'
import { VerifyError } from './errors'

export const SCALAR_BYTES = 32

export class ProofBytesReader {
  private pos: number = 0

  constructor(private readonly bytes: Uint8Array) {}

  remaining(): number {
    return this.bytes.length - this.pos
  }

  readChallenge(): Uint8Array {
    return this.readN(CHALLENGE_BYTES)
  }

  readScalarBytes(): Uint8Array {
    return this.readN(SCALAR_BYTES)
  }

  private readN(n: number): Uint8Array {
    if (this.remaining() < n) {
      throw new VerifyError(
        `truncated-signature: needed ${n} bytes, have ${this.remaining()}`,
        'truncated-signature'
      )
    }
    const slice = this.bytes.slice(this.pos, this.pos + n)
    this.pos += n
    return slice
  }

  /** Assert all bytes consumed (defense against trailing garbage; optional). */
  assertConsumed(): void {
    if (this.remaining() > 0) {
      throw new VerifyError(
        `truncated-signature: ${this.remaining()} trailing bytes`,
        'truncated-signature'
      )
    }
  }
}

/**
 * Construct a ProofBytesReader, rejecting empty input.
 *
 * Sigma-rust returns `Ok(false)` on empty proofs (`sig_serializer.rs:118-128`);
 * TS surfaces as a typed throw for caller telemetry per design Decision #5.
 */
export function readProofBytes(signature: Uint8Array): ProofBytesReader {
  if (signature.length === 0) {
    throw new VerifyError('empty-signature: proof bytes are empty', 'empty-signature')
  }
  return new ProofBytesReader(signature)
}
```

- [ ] **Step 8: Run sig-serializer test, verify PASS**

```bash
npx vitest run packages/ergoscript/test/sigma/sig-serializer.test.ts
```

Expected: PASS.

- [ ] **Step 9: Write test for `sigma/fiat-shamir.ts`**

Create `packages/ergoscript/test/sigma/fiat-shamir.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { propBytes, fiatShamirHash, FIAT_SHAMIR_HASH_BYTES } from '../../src/sigma/fiat-shamir'
import { hexToBytes } from '../_helpers'
import type { SigmaBoolean } from '../../src/mir/types'

describe('Fiat-Shamir primitives', () => {
  it('FIAT_SHAMIR_HASH_BYTES === 24', () => {
    expect(FIAT_SHAMIR_HASH_BYTES).toBe(24)
  })

  it('propBytes wraps SigmaProp in ErgoTree v0 + constant-segregation=true', () => {
    // A ProveDlog leaf with a known h. propBytes(sb) should produce the
    // byte-serialization of an ErgoTree whose body is
    // Const(SSigmaProp, sb) and whose header is v0 with constant-segregation.
    //
    // The exact bytes depend on the ErgoTree wire format. The most direct
    // way to lock this is a fixture from sigma-rust — defer the byte-equality
    // assertion to the Task 6 verifier-fixture stage. Here we just verify
    // propBytes returns non-empty, starts with a valid ErgoTree header byte.
    const h = new Uint8Array(33)
    h[0] = 0x02  // SEC1 compressed pubkey tag
    for (let i = 1; i < 33; i++) h[i] = i
    const sb: SigmaBoolean = { tag: 'ProveDlog', h }
    const bytes = propBytes(sb)
    expect(bytes.length).toBeGreaterThan(33)  // ErgoTree envelope adds bytes
    // ErgoTree v0 + constant-segregation: header byte should be 0x10 (bit 4 set).
    // (Confirm exact byte at Task 6 — depends on ErgoTree builder used.)
    expect((bytes[0]! & 0b00010000) !== 0).toBe(true)
  })

  it('fiatShamirHash truncates blake2b-256 output to 24 bytes', () => {
    const result = fiatShamirHash(new Uint8Array(10))
    expect(result.length).toBe(FIAT_SHAMIR_HASH_BYTES)
  })

  // More tests added at Task 6 (byte-equivalence with sigma-rust fixtures).
})
```

- [ ] **Step 10: Implement `sigma/fiat-shamir.ts`**

```ts
/**
 * Fiat-Shamir tree-to-bytes serialization for sigma-protocol verification.
 *
 * The verifier (Task 6) reconstructs the root challenge by:
 *   1. Walking the SigmaBoolean tree to build a byte-string (this module).
 *   2. Appending the message.
 *   3. Hashing with blake2b-256.
 *   4. Taking the first 24 bytes.
 *
 * **Critical byte-format details:**
 *
 *  - `prop_bytes` for a leaf: wrap the SigmaProp in an ErgoTree with
 *    `version=0, hasSize=false, constantSegregation=true` BEFORE serializing
 *    (sigma-rust `fiat_shamir.rs:148-157`, `sigma_boolean.rs:303-312`).
 *  - Leaf prefix byte: `1`; internal-node prefix: `0`
 *    (`fiat_shamir.rs::LEAF_PREFIX = 1`).
 *  - Conjecture child counts use `put_i16_be_bytes` — 2-byte BIG-ENDIAN,
 *    NOT VLQ (`fiat_shamir.rs:197`). This differs from the wire format.
 *  - `Cthreshold` k is `put_u8` in Fiat-Shamir (`fiat_shamir.rs:184`);
 *    Cand=0, Cor=1, Cthreshold=2 conjecture-type bytes (`proof_tree.rs:131-135`).
 *
 * NOTE: 2g-medium ships only the leaf path of `propBytes` + the hash
 * primitive. The full tree-walker for conjectures ships in 2g-combinators.
 */

import { blake2b } from '@noble/hashes/blake2.js'
import type { SigmaBoolean, ErgoTree } from '../mir/types'
import { serializeTree } from '../wire/ergo-tree'
// (Adjust import names if the existing serializer lives elsewhere.)

export const FIAT_SHAMIR_HASH_BYTES = 24

/**
 * Wrap a SigmaBoolean in an ErgoTree(v0, constant-segregation=true) and
 * serialize. Used at every leaf during Fiat-Shamir tree construction.
 *
 * Source: sigma-rust `fiat_shamir.rs:148-157`.
 */
export function propBytes(sb: SigmaBoolean): Uint8Array {
  // Construct: ErgoTree{ header: v0 + constant-segregation=true, body: Const(SSigmaProp, sb) }
  const tree: ErgoTree = {
    header: {
      version: 0,
      hasSize: false,
      constantSegregation: true,
      rawHeader: 0b00010000,  // version=0 (bits 0-2 = 0), hasSize=false (bit 3 = 0), constSeg=true (bit 4 = 1)
    },
    constantTypes: [{ tag: 'SSigmaProp' }],
    constants: [{ kind: 'SigmaProp', value: sb }],
    // Body is a ConstPlaceholder(0) referencing the segregated constant.
    body: { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SSigmaProp' } },
  }
  return serializeTree(tree)
}

/** Hash an arbitrary byte sequence with blake2b-256 and truncate to 24 bytes. */
export function fiatShamirHash(input: Uint8Array): Uint8Array {
  const digest = blake2b(input, { dkLen: 32 })
  return digest.slice(0, FIAT_SHAMIR_HASH_BYTES)
}
```

(Adjust the `ErgoTree` construction to match the existing project shape — `TreeHeader.rawHeader`, `constantTypes`, etc. Read `mir/types.ts` and `wire/ergo-tree.ts` to confirm the exact constructor pattern.)

- [ ] **Step 11: Run fiat-shamir test, verify PASS**

```bash
npx vitest run packages/ergoscript/test/sigma/fiat-shamir.test.ts
```

Expected: PASS. The byte-format assertion is approximate at this stage; Task 6's verifier-positive fixture provides the true byte-equivalence check.

- [ ] **Step 12: Run full suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all prior tests + Task 5 unit tests PASS; zero typecheck errors.

- [ ] **Step 13: Browser-compat scan**

```bash
grep -E "Buffer|process\.|require\(|node:" packages/ergoscript/src/sigma/
```

Expected: no output. The new `sigma/` modules are pure ESM.

- [ ] **Step 14: Two-stage review (orchestrator)**

- **Spec-compliance:** Cite source lines for each module's behavior (`challenge.rs` for 24-byte size; `sig_serializer.rs:118-128, 143, 148-172` for proof byte reader; `fiat_shamir.rs:70-76, 148-157, 197` for Fiat-Shamir primitives).
- **Code-quality:** all modules browser-clean; `VerifyError` exported correctly; no `any` leaks; defensive copies where Uint8Array slices are returned.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ergoscript): verifier infrastructure modules (phase 2g-medium task 5)

Four new modules under src/sigma/:
  - errors.ts:       VerifyError class + 5 codes
  - challenge.ts:    24-byte XOR primitives (CHALLENGE_BYTES = 24)
  - sig-serializer.ts: ProofBytesReader (readChallenge / readScalarBytes);
                     readProofBytes guard for empty signatures
  - fiat-shamir.ts:  propBytes (ErgoTree v0 + constant-segregation=true
                     wrap; sigma-rust fiat_shamir.rs:148-157);
                     fiatShamirHash (blake2b-256 truncated to 24 bytes)

Per-module unit tests. Conjecture walk paths (Cand/Cor/Cthreshold) deferred
to 2g-combinators; this task ships leaf-only primitives.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `verifySignature` impl + verifier fixtures (V1 + V2)

**⚠ Confidence-escalation flag (OVERRIDES #2):** This is the load-bearing crypto-verification task. Implementer + reviewer MUST cite specific sigma-rust source lines for each correctness-sensitive equation. See "Confidence-escalation flag" in the plan header.

**Files:**
- Create: `packages/ergoscript/src/sigma/verifier.ts` — `verifySignature` orchestration
- Modify: `packages/ergoscript/src/index.ts` — re-export `verifySignature`, `VerifyError`, `SigmaBoolean` type
- Create: `fixture-gen/src/cmds/ergoscript/verify/mod.rs` — module hub
- Create: `fixture-gen/src/cmds/ergoscript/verify/verifier_positive.rs` — V1 positive
- Create: `fixture-gen/src/cmds/ergoscript/verify/verifier_reject.rs` — V1 conjecture + malformed
- Create: `fixture-gen/src/cmds/ergoscript/verify/verifier_mutation.rs` — V2 byte-flip
- Modify: `fixture-gen/src/cmds/ergoscript/mod.rs` — add `pub mod verify;`
- Modify: `fixture-gen/src/main.rs` — wire calls
- Create: `packages/ergoscript/test/sigma/verifier.test.ts`

**Sigma-rust sources:**
- `ergotree-interpreter/src/sigma_protocol/verifier.rs:60-125` — verify pipeline (`verify_signature` entry at line 91; combined `Verifier::verify` at line 60)
- `ergotree-interpreter/src/sigma_protocol/dlog_protocol.rs:113-184` — Schnorr verify equation `a = g^z * (h^challenge)^-1`; deterministic-nonce signer (lines 113-149)
- `ergotree-interpreter/src/sigma_protocol/dht_protocol.rs:132-157` — DH-tuple two-commitment verify
- `ergotree-interpreter/src/sigma_protocol/prover/test_prover.rs` (or `prover/mod.rs`) — test-prover entry for fixture-gen
- `ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:118-255` — proof byte format full reference
- `ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs:140-200` — tree-to-bytes including leaf prefix + prop_bytes wrap

**Key behavior:** `verifySignature(sb, message, signature) → boolean`. Algorithm:

1. If `sb.tag === 'TrivialProp'`, return `sb.value`.
2. Initialize `ProofBytesReader(signature)` — guards empty proof.
3. Walk `sb` once; if any node is `Cand`/`Cor`/`Cthreshold`, throw `'conjecture-not-implemented'`.
4. Read top-level 24-byte challenge.
5. For the (single) leaf, read 32-byte scalar `z`.
6. Compute commitment(s) via Schnorr (ProveDlog) or DH-tuple (ProveDhTuple) math.
7. Build Fiat-Shamir input: `propBytes(sb)` ++ commitment bytes ++ message.
8. `recomputed_challenge = fiatShamirHash(input)`.
9. Return `bytewise_equal(recomputed_challenge, top_level_challenge)`.

The exact byte format of Fiat-Shamir tree-walking is replicated byte-by-byte from `fiat_shamir.rs:140-200`. Mismatch = silent verification failure. The V1 positive fixtures (real sigma-rust-signed proofs) are the only correctness signal.

- [ ] **Step 1: Locate sigma-rust's test-prover entry**

```bash
ls ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/prover/
grep -rn "pub fn prove\|impl.*Prover.*for" ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/prover/ | head -20
```

Identify the test-prover (likely `TestProver` in `prover/test_prover.rs`) and its `prove(ergo_tree, ctx, message)` signature. Confirm it uses deterministic-nonce signing.

- [ ] **Step 2: Read sigma-rust's verifier.rs pipeline**

```bash
sed -n '60,130p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/verifier.rs
sed -n '160,200p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/dlog_protocol.rs
sed -n '120,170p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/dht_protocol.rs
sed -n '140,205p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs
```

For each correctness-sensitive equation, note the exact source line:
- Schnorr commitment: `a = g^z * (h^challenge)^-1` — Rust `Mul<&EcPoint>` is point-addition (`ec_point.rs:74-79`), so TS equivalent is `pointAdd(pointMul(basePoint, z), pointNegate(pointMul(h, challenge)))`.
- DH-tuple: two such equations (one for `a` using `g, u`; one for `b` using `h, v`).
- Fiat-Shamir leaf: `LEAF_PREFIX (1 byte) | propBytes_length (put_i16_be_bytes) | propBytes | commitment_length (put_i16_be_bytes) | commitment_bytes`.

- [ ] **Step 3: Write Rust fixture-gen for V1 positive**

Create `fixture-gen/src/cmds/ergoscript/verify/verifier_positive.rs`:

```rust
//! V1 positive verifier fixtures (phase 2g-medium Task 6).
//!
//! Invokes sigma-rust's test-prover to generate real (sb, msg, sig) triples
//! for the leaf-only verifier scope: ProveDlog and ProveDhTuple.
//! Sigma-rust uses deterministic-nonce signing (dlog_protocol.rs:113-149),
//! so fixtures are reproducible.

use crate::common::write_file;
use anyhow::Result;
use ergo_chain_types::EcPoint;
use ergotree_interpreter::sigma_protocol::prover::{Prover, TestProver, PrivateInput};
use ergotree_interpreter::sigma_protocol::private_input::DlogProverInput;
use ergotree_ir::sigma_protocol::sigma_boolean::{ProveDlog, ProveDhTuple, SigmaBoolean, SigmaProofOfKnowledgeTree};
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use sigma_test_util::force_any_val;

#[derive(Serialize)]
struct PositiveEntry {
    name: String,
    sigma_boolean_json: serde_json::Value,
    message_hex: String,
    signature_hex: String,
    expected_result: bool,  // always true for positive entries
}

#[derive(Serialize)]
struct PositiveFixture {
    description: &'static str,
    entries: Vec<PositiveEntry>,
}

fn entry_prove_dlog(name: &str, secret: DlogProverInput, message: &[u8]) -> Result<PositiveEntry> {
    let prover = TestProver { secrets: vec![PrivateInput::DlogProverInput(secret.clone())] };
    let pk: ProveDlog = secret.public_image();
    let sb = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pk.clone()));
    // Build the ErgoTree wrapping Const(SSigmaProp, sb). The TestProver's
    // canonical entry is prove(&self, tree: &ErgoTree, ctx: &Context, message: &[u8]).
    let sigma_prop = ergotree_ir::sigma_protocol::sigma_boolean::SigmaProp::new(sb.clone());
    let body = ergotree_ir::mir::expr::Expr::Const(
        ergotree_ir::mir::constant::Constant {
            tpe: ergotree_ir::types::stype::SType::SSigmaProp,
            v: ergotree_ir::mir::value::Value::SigmaProp(Box::new(sigma_prop)),
        }
    );
    let tree: ergotree_ir::ergo_tree::ErgoTree = body.try_into()?;
    let ctx = force_any_val::<ergotree_interpreter::eval::context::Context>();
    let proof = prover.prove(&tree, &ctx, message)?;
    Ok(PositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json(&sb),
        message_hex: hex::encode(message),
        signature_hex: hex::encode(proof.proof.to_bytes()),
        expected_result: true,
    })
}

pub fn generate() -> Result<()> {
    let mut entries = Vec::new();

    // ≥ 5 ProveDlog entries with varied keys + message lengths
    for (i, msg) in [
        b"" as &[u8],
        b"a",
        b"abcdef",
        &[0u8; 32],
        &[0xff; 100],
    ].iter().enumerate() {
        let secret = force_any_val::<DlogProverInput>();
        entries.push(entry_prove_dlog(&format!("prove-dlog-{}", i), secret, msg)?);
    }

    // ≥ 5 ProveDhTuple entries (use TestProver's DhTupleProverInput equivalent)
    // ... (mirror the dlog loop; consult prover/test_prover.rs for the DH-tuple secret type)

    let file = PositiveFixture {
        description: "V1 positive verifier fixtures — real sigma-rust-signed (sb, msg, sig) triples.",
        entries,
    };
    write_file(
        "packages/ergoscript/test/fixtures/verify/verifier-positive.json",
        serde_json::to_string_pretty(&file)?,
    )
}
```

(The `Prover::prove` API may take an `ErgoTree` or a `SigmaBoolean` directly — adjust based on actual sigma-rust signature. The implementer reads `prover/mod.rs` at task time.)

- [ ] **Step 4: Write Rust fixture-gen for V1 reject + malformed**

Create `fixture-gen/src/cmds/ergoscript/verify/verifier_reject.rs`:

```rust
//! V1 reject + malformed verifier fixtures (phase 2g-medium Task 6).

use crate::common::write_file;
use anyhow::Result;
use serde::Serialize;

#[derive(Serialize)]
struct RejectEntry {
    name: String,
    sigma_boolean_json: serde_json::Value,
    message_hex: String,
    signature_hex: String,
    /// One of: 'returns-false', or a VerifyError code like 'conjecture-not-implemented'.
    expected_outcome: String,
}

// ... (entries for: Cand input (expects 'conjecture-not-implemented'); Cor input;
//      Cthreshold input; empty signature (expects 'empty-signature'); truncated sig;
//      z scalar = group order n exactly (expects 'scalar-out-of-range');
//      TrivialProp(false) + any sig (expects returns-false))
```

Generate one entry per VerifyError code + TrivialProp cases.

- [ ] **Step 5: Write Rust fixture-gen for V2 mutation**

Create `fixture-gen/src/cmds/ergoscript/verify/verifier_mutation.rs`. Take ONE positive entry (the simplest ProveDlog with empty message) and produce 56 mutation variants — each flips one byte of the signature. Each entry asserts the verifier returns `false` (most flips) or throws a typed `VerifyError` (when the flip lands on a structurally-invalid scalar bytes etc.).

```rust
//! V2 byte-flip mutation fixtures (phase 2g-medium Task 6).
//!
//! Takes one positive ProveDlog (sb, msg, sig) triple and produces 56
//! mutation variants — each flips one byte of the signature. Verifier
//! must return false or throw VerifyError on every mutation.

use anyhow::Result;
use crate::common::write_file;
use serde::Serialize;

#[derive(Serialize)]
struct MutationEntry {
    name: String,
    sigma_boolean_json: serde_json::Value,
    message_hex: String,
    /// Signature bytes after flipping the byte at `flip_offset`.
    mutated_signature_hex: String,
    flip_offset: usize,
    /// 'false' or a VerifyError code.
    expected_outcome: String,
}

pub fn generate() -> Result<()> {
    // Generate the baseline triple (mirror Task 6 Step 3 with the simplest ProveDlog).
    // ... let (sb, msg, sig) = build_baseline();
    let mut entries = Vec::new();
    let sig_len = 56;  // 24-byte challenge + 32-byte z for a single leaf
    for offset in 0..sig_len {
        let mut mutated = sig.clone();
        mutated[offset] ^= 0xff;  // flip all bits at this byte
        entries.push(MutationEntry {
            name: format!("flip-byte-{:02}", offset),
            // ... (sb, msg, mutated_signature_hex)
            flip_offset: offset,
            expected_outcome: "false-or-error".to_string(),
        });
    }
    let file = /* ... */;
    write_file("packages/ergoscript/test/fixtures/verify/verifier-mutation.json", serde_json::to_string_pretty(&file)?)
}
```

- [ ] **Step 6: Wire fixture-gen modules**

Add `pub mod verify;` to `fixture-gen/src/cmds/ergoscript/mod.rs`. Create `fixture-gen/src/cmds/ergoscript/verify/mod.rs`:

```rust
pub mod verifier_positive;
pub mod verifier_reject;
pub mod verifier_mutation;
```

Add 3 `generate_and_write` calls to `fixture-gen/src/main.rs`.

- [ ] **Step 7: Run fixture-gen + determinism check**

```bash
cd /home/mwaddip/projects/ergots
cargo run --release -p fixture-gen
ls -la packages/ergoscript/test/fixtures/verify/
cargo run --release -p fixture-gen  # rerun
git diff packages/ergoscript/test/fixtures/verify/  # must be empty (deterministic prover)
```

If non-empty, sigma-rust's prover is being invoked in non-deterministic mode — investigate. Likely cause: `force_any_val::<DlogProverInput>()` outside `TestRunner::deterministic()`.

- [ ] **Step 8: Write the failing verifier test**

Create `packages/ergoscript/test/sigma/verifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySignature } from '../../src/sigma/verifier'
import { VerifyError } from '../../src/sigma/errors'
import { hexToBytes } from '../_helpers'
import type { SigmaBoolean } from '../../src/mir/types'

// Reuse hydrateSigmaBoolean helper from sigma-boolean-variants.test.ts
// (consider promoting to test/_helpers/index.ts at Task 1 if not yet done)
function hydrateSigmaBoolean(json: any): SigmaBoolean {
  // ... (same as Task 1 Step 9)
}

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('verifySignature — V1 positive', () => {
  const fixture = JSON.parse(readFileSync(
    join(__dirname, '../fixtures/verify/verifier-positive.json'), 'utf-8'))
  for (const entry of fixture.entries) {
    it(`${entry.name} — verifies`, () => {
      const sb = hydrateSigmaBoolean(entry.sigma_boolean_json)
      const msg = hexToBytes(entry.message_hex)
      const sig = hexToBytes(entry.signature_hex)
      expect(verifySignature(sb, msg, sig)).toBe(true)
    })
  }
})

describe('verifySignature — V1 reject + malformed', () => {
  const fixture = JSON.parse(readFileSync(
    join(__dirname, '../fixtures/verify/verifier-reject.json'), 'utf-8'))
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const sb = hydrateSigmaBoolean(entry.sigma_boolean_json)
      const msg = hexToBytes(entry.message_hex)
      const sig = hexToBytes(entry.signature_hex)
      if (entry.expected_outcome === 'returns-false') {
        expect(verifySignature(sb, msg, sig)).toBe(false)
      } else {
        // expected_outcome is a VerifyError code
        try {
          verifySignature(sb, msg, sig)
          throw new Error('expected VerifyError throw')
        } catch (e: any) {
          expect(e).toBeInstanceOf(VerifyError)
          expect(e.code).toBe(entry.expected_outcome)
        }
      }
    })
  }
})

describe('verifySignature — V2 mutation', () => {
  const fixture = JSON.parse(readFileSync(
    join(__dirname, '../fixtures/verify/verifier-mutation.json'), 'utf-8'))
  for (const entry of fixture.entries) {
    it(`${entry.name} — rejects`, () => {
      const sb = hydrateSigmaBoolean(entry.sigma_boolean_json)
      const msg = hexToBytes(entry.message_hex)
      const sig = hexToBytes(entry.mutated_signature_hex)
      let outcome: 'false' | 'throw' = 'false'
      try {
        const result = verifySignature(sb, msg, sig)
        if (result === true) throw new Error(`mutation at offset ${entry.flip_offset} PASSED verify — verifier vulnerability!`)
      } catch (e: any) {
        if (!(e instanceof VerifyError)) throw e
        outcome = 'throw'
      }
      // Either outcome is acceptable; the only forbidden outcome is `true`.
    })
  }
})
```

- [ ] **Step 9: Run test, verify FAIL (verifier not implemented)**

```bash
npx vitest run packages/ergoscript/test/sigma/verifier.test.ts
```

Expected: FAIL — `verifySignature` not exported.

- [ ] **Step 10: Implement `sigma/verifier.ts`**

```ts
/**
 * `verifySignature` — leaf-only sigma-protocol verifier (phase 2g-medium).
 *
 * Algorithm:
 *   1. TrivialProp short-circuit (returns sb.value, ignores signature)
 *   2. Reject conjecture variants (Cand/Cor/Cthreshold) → 'conjecture-not-implemented'
 *   3. Parse top-level 24-byte challenge from signature
 *   4. Per-leaf read 32-byte z scalar
 *   5. Compute Schnorr (ProveDlog) or DH-tuple (ProveDhTuple) commitment(s)
 *   6. Build Fiat-Shamir input: propBytes(sb) ++ commitment_bytes ++ message
 *   7. fiatShamirHash → 24-byte recomputed challenge
 *   8. Return bytewise equal(recomputed, top_level_challenge)
 *
 * Source: ergotree-interpreter/src/sigma_protocol/verifier.rs:91-125
 */

import type { SigmaBoolean } from '../mir/types'
import { VerifyError } from './errors'
import { ProofBytesReader, readProofBytes } from './sig-serializer'
import { CHALLENGE_BYTES } from './challenge'
import { propBytes, fiatShamirHash } from './fiat-shamir'
import {
  decodePoint, encodePoint, pointAdd, pointMul, pointNegate,
  basePoint, scalarFromBytes, scalarFromChallenge,
} from '../crypto/secp256k1'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function assertNoConjecture(sb: SigmaBoolean): void {
  switch (sb.tag) {
    case 'TrivialProp':
    case 'ProveDlog':
    case 'ProveDhTuple':
      return
    case 'Cand':
    case 'Cor':
    case 'Cthreshold':
      throw new VerifyError(
        `verifySignature: ${sb.tag} not implemented in phase 2g-medium (leaf-only verifier; deferred to 2g-combinators)`,
        'conjecture-not-implemented'
      )
  }
}

/**
 * Schnorr commitment for ProveDlog leaf.
 *
 * Equation: a = (basePoint * z) + negate(decodePoint(h) * scalarFromChallenge(challenge))
 *
 * Source: sigma-rust dlog_protocol.rs:173-184. Note: sigma-rust's
 * `Mul<&EcPoint>` is point-addition (ec_point.rs:74-79); the spec
 * equation uses multiplicative notation for an additive group operation.
 */
function commitmentProveDlog(h: Uint8Array, challenge: Uint8Array, zBytes: Uint8Array): Uint8Array {
  const z = scalarFromBytes(zBytes)
  const e = scalarFromChallenge(challenge)
  const gz = pointMul(basePoint, z)
  const hPoint = decodePoint(h)
  const he = pointMul(hPoint, e)
  const negHe = pointNegate(he)
  const a = pointAdd(gz, negHe)
  return encodePoint(a)
}

/**
 * DH-tuple two commitments for ProveDhTuple leaf.
 *
 * Equations:
 *   a = (decodePoint(g) * z) + negate(decodePoint(u) * scalarFromChallenge(challenge))
 *   b = (decodePoint(h) * z) + negate(decodePoint(v) * scalarFromChallenge(challenge))
 *
 * Source: sigma-rust dht_protocol.rs:132-157.
 */
function commitmentProveDhTuple(
  g: Uint8Array, h: Uint8Array, u: Uint8Array, v: Uint8Array,
  challenge: Uint8Array, zBytes: Uint8Array
): { a: Uint8Array; b: Uint8Array } {
  const z = scalarFromBytes(zBytes)
  const e = scalarFromChallenge(challenge)
  const a = pointAdd(pointMul(decodePoint(g), z), pointNegate(pointMul(decodePoint(u), e)))
  const b = pointAdd(pointMul(decodePoint(h), z), pointNegate(pointMul(decodePoint(v), e)))
  return { a: encodePoint(a), b: encodePoint(b) }
}

export function verifySignature(
  sb: SigmaBoolean,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  // Step 1: TrivialProp short-circuit
  if (sb.tag === 'TrivialProp') return sb.value

  // Step 2: empty signature → 'empty-signature' typed throw (per Decision #5)
  const reader = readProofBytes(signature)

  // Step 3: reject conjecture variants
  assertNoConjecture(sb)

  // Step 4: parse top-level challenge
  const challenge = reader.readChallenge()

  // Step 5: per-leaf z scalar + commitment
  let commitmentBytes: Uint8Array
  switch (sb.tag) {
    case 'ProveDlog': {
      const zBytes = reader.readScalarBytes()
      commitmentBytes = commitmentProveDlog(sb.h, challenge, zBytes)
      break
    }
    case 'ProveDhTuple': {
      const zBytes = reader.readScalarBytes()
      const { a, b } = commitmentProveDhTuple(sb.g, sb.h, sb.u, sb.v, challenge, zBytes)
      // Concatenate a || b for the Fiat-Shamir input
      commitmentBytes = new Uint8Array(a.length + b.length)
      commitmentBytes.set(a, 0)
      commitmentBytes.set(b, a.length)
      break
    }
    // TrivialProp and conjectures already handled above
    default: {
      const _exhaust: never = sb
      throw new Error(`unreachable: ${JSON.stringify(_exhaust)}`)
    }
  }

  // Step 6: Fiat-Shamir input
  const prop = propBytes(sb)
  // Per fiat_shamir.rs:140-200, the leaf format is:
  //   LEAF_PREFIX (1) | put_i16_be(prop.length) | prop | put_i16_be(commitment.length) | commitment
  const LEAF_PREFIX = 1
  const fiatInput = buildFiatShamirLeaf(LEAF_PREFIX, prop, commitmentBytes, message)

  // Step 7: hash → 24-byte recomputed challenge
  const recomputed = fiatShamirHash(fiatInput)

  // Step 8: compare
  return bytesEqual(recomputed, challenge)
}

function buildFiatShamirLeaf(
  prefix: number, prop: Uint8Array, commitment: Uint8Array, message: Uint8Array
): Uint8Array {
  // 1 + 2 + prop.length + 2 + commitment.length + message.length
  const total = 1 + 2 + prop.length + 2 + commitment.length + message.length
  const out = new Uint8Array(total)
  let off = 0
  out[off++] = prefix
  // put_i16_be (big-endian, NOT VLQ)
  out[off++] = (prop.length >> 8) & 0xff
  out[off++] = prop.length & 0xff
  out.set(prop, off); off += prop.length
  out[off++] = (commitment.length >> 8) & 0xff
  out[off++] = commitment.length & 0xff
  out.set(commitment, off); off += commitment.length
  out.set(message, off)
  return out
}
```

- [ ] **Step 11: Re-export from `index.ts`**

Modify `packages/ergoscript/src/index.ts` to add:

```ts
export { verifySignature } from './sigma/verifier'
export { VerifyError } from './sigma/errors'
export type { SigmaBoolean } from './mir/types'  // structural type now public
```

- [ ] **Step 12: Run verifier test, verify PASS**

```bash
npx vitest run packages/ergoscript/test/sigma/verifier.test.ts
```

Expected: ALL positive entries PASS; all reject entries throw correctly; all 56 mutation entries return false or throw (none returns true).

If any V1 positive entry FAILS — the recomputed challenge doesn't byte-equal the captured one — the bug is in `verifier.ts` orchestration or one of the Task 5 primitives. Most likely:
- Wrong Fiat-Shamir leaf byte format (put_i16_be vs VLQ)
- `propBytes` not wrapping in ErgoTree v0 + constant-segregation=true correctly
- Schnorr commitment wrong direction (e.g., `pointAdd(gz, he)` instead of `pointAdd(gz, pointNegate(he))`)
- `scalarFromChallenge` right-padding instead of left-padding

Debug by adding per-byte trace logging against the first positive entry. Compare to sigma-rust's verifier byte-by-byte using `RUST_LOG=debug` if available.

- [ ] **Step 13: Run full ergoscript suite**

```bash
npx vitest run packages/ergoscript/
```

Expected: all 1894+ prior tests + Task 3-5 tests + Task 6 tests PASS.

- [ ] **Step 14: Typecheck**

```bash
npx tsc --noEmit -p packages/ergoscript
```

Expected: zero errors.

- [ ] **Step 15: Browser-compat scan + bundle audit**

```bash
grep -rE "Buffer|process\.|require\(|node:" packages/ergoscript/src/sigma/ packages/ergoscript/src/crypto/
```

Expected: no output.

- [ ] **Step 16: Two-stage review (orchestrator) — ⚠ crypto-sensitive**

Both reviewers MUST cite source lines for each crypto-correctness claim:

- **Spec-compliance:**
  - Schnorr commitment equation matches `dlog_protocol.rs:173-184`
  - DH-tuple commitment matches `dht_protocol.rs:132-157`
  - Fiat-Shamir leaf format matches `fiat_shamir.rs:140-200` (LEAF_PREFIX=1, put_i16_be for lengths)
  - propBytes wraps SigmaProp in ErgoTree v0 + constant-segregation=true (`fiat_shamir.rs:148-157`)
  - Challenge-to-scalar uses LEFT-pad (not right-pad) per `wscalar.rs:69-76`
  - TrivialProp short-circuit ignores signature
  - All V1 positive fixtures verify
  - All V2 mutations (56 byte-flips) reject
  
- **Code-quality:**
  - No `any` leaks in cryptographic paths
  - Defensive copies where needed
  - No untyped numeric coercion (BigInt arithmetic in adapter only)
  - `_exhaust: never` in the verifier switch
  - All Uint8Array slices are safe (no view leaks)

- [ ] **Step 17: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ergoscript): verifySignature impl + V1/V2 verifier fixtures (phase 2g-medium task 6)

verifySignature(sigmaBoolean, message, signature) → boolean.

Leaf-only verifier handles TrivialProp + ProveDlog + ProveDhTuple. Throws
VerifyError 'conjecture-not-implemented' on Cand/Cor/Cthreshold inputs
(deferred to 2g-combinators).

Composes Task 5 infrastructure: ProofBytesReader, propBytes (ErgoTree v0
constant-seg=true wrap), fiatShamirHash. Schnorr commitment equation from
dlog_protocol.rs:173-184; DH-tuple two-commitment from dht_protocol.rs:
132-157. Fiat-Shamir leaf format put_i16_be (BE) per fiat_shamir.rs:197.

Fixtures (generated via sigma-rust's deterministic-nonce TestProver):
  - verify/verifier-positive.json     V1 positive ≥ 5 ProveDlog + ≥ 5 ProveDhTuple
  - verify/verifier-reject.json       V1 reject (conjecture) + malformed
  - verify/verifier-mutation.json     V2 56 byte-flips on baseline proof

Public re-exports from index.ts: verifySignature, VerifyError, SigmaBoolean.

Coverage 44 of ~70 arms (eval-arm count unchanged from Task 4).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Docs update — `facts/ergoscript.md` + umbrella plan

**Files:**
- Modify: `facts/ergoscript.md` — extend with v0.2.0 → v0.3.0 (or extend in-place) phase 2g-medium block
- Modify: `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — annotate phase 2g row with "delivered as 2g-medium + 2g-combinators" split

**Key content to add to `facts/ergoscript.md`:**

1. **Phase 2g-medium "Ships additionally" block** (mirror prior phases' style; insert in chronological position after phase 2f Coll HOFs block):

   - 2 more per-variant arms wired: `CreateProveDlog` (Pattern A, `Fixed(10)`), `CreateProveDhTuple` (Pattern A, `Fixed(20)`). Coverage 42 → 44.
   - One new `EvalError` code: `'sigma-prop-input-not-group-element'`.
   - **Structural `SigmaBoolean`** — the opaque `{ raw: Uint8Array }` shape from phase 2a is replaced with a 6-variant discriminated union (TrivialProp / ProveDlog / ProveDhTuple / Cand / Cor / Cthreshold). All 6 variants parse + serialize via the wire codec; the runtime verifier (this slice) walks only the 3 leaf-style variants.
   - **New public function: `verifySignature(sigmaBoolean, message, signature) → boolean`** with precondition/postcondition/error taxonomy section.
   - **New error class: `VerifyError`** with code taxonomy (`'conjecture-not-implemented'`, `'empty-signature'`, `'truncated-signature'`, `'point-not-on-curve'`, `'scalar-out-of-range'`).
   - **2 new `SigmaBooleanParseError` codes:** `'cthreshold-k-out-of-range'`, `'sigma-conjecture-empty-items'`.
   - **`SigmaProp` SValue shape:** `value` is now structural `SigmaBoolean` (was opaque `{ raw }`).
   - **P2PK short-circuit:** `Const(SSigmaProp, _)` charges 50 JitCost (was 5) via `EVAL_SIGMA_PROP_CONSTANT` mirror.
   - **New runtime dep:** `@noble/curves@2.2.0` (secp256k1; version-locked pair with `@noble/hashes@2.2.0`).

2. **"Does NOT ship yet" updates** — move `Atleast`/`SigmaAnd`/`SigmaOr` from "phase 2g" to "phase 2g-combinators"; add conjecture-verifier-walk to the 2g-combinators bucket.

3. **Coverage line:** "**42 / ~70 `Expr` variants**" → "**44 / ~70 `Expr` variants**".

4. **EvalError taxonomy total:** "35 codes" → "36 codes".

5. **Public-surface section:** add the new `verifySignature` signature next to `evaluate` / `evaluateWith`. Document precondition (`sigmaBoolean` is a valid SigmaBoolean; `signature` is a `Uint8Array`) and postcondition (boolean if leaf-only verifier reached a result; throws `VerifyError` for malformed inputs or conjecture-not-implemented).

**Umbrella plan update:**

Edit `docs/specs/2026-05-13-ergoscript-interpreter-design.md`. Find the phase-plan table row for **2g — Sigma protocol**. Replace the "Done criterion" with:

> Sigma-protocol leaf primitives ship as **2g-medium** (this slice — leaf-only verifier; structural SigmaBoolean; `CreateProveDlog`/`CreateProveDhTuple` arms; `@noble/curves@2.2.0` adapter; `verifySignature` public). The 3 deferred sigma combinators (`Atleast`/`SigmaAnd`/`SigmaOr`) plus the conjecture verifier extension (`Cand`/`Cor` XOR walks + `Cthreshold` GF(2^192) polynomial Lagrange interpolation) ship as **2g-combinators** (follow-up slice). ✅ 2g-medium shipped 2026-05-16.

**Tasks:**

- [ ] **Step 1: Read current `facts/ergoscript.md` to plan insertion points**

```bash
grep -n "Ships additionally\|Does NOT ship yet\|Coverage after\|EvalError codes" /home/mwaddip/projects/ergots/facts/ergoscript.md | head -30
```

Identify the insertion location for the phase 2g-medium block (after phase 2f Coll HOFs block) and the update locations for coverage, taxonomy total, deferred-variants section.

- [ ] **Step 2: Insert phase 2g-medium "Ships additionally" block**

Mirror the structure of the phase 2f Coll HOFs block (search for "phase 2f Coll HOFs" headings). Cover items 1-5 from "Key content" above with numbered subsections analogous to prior phases (e.g., `49.`, `50.`, `51.` continuing the slice numbering).

- [ ] **Step 3: Update Coverage / EvalError-total / "Does NOT ship yet" sections**

- Change every occurrence of "42 of ~70" to "44 of ~70".
- Change "35 EvalError codes" to "36 EvalError codes".
- In the "Does NOT ship yet" section, move `Atleast`/`SigmaAnd`/`SigmaOr` from "phase 2g" to "phase 2g-combinators" bucket. Add conjecture-verifier-walk as a bullet under "phase 2g-combinators".

- [ ] **Step 4: Add `verifySignature` to the public-surface section**

In `facts/ergoscript.md`'s "Primary export" or "Public surface" section, add:

```ts
verifySignature(sigmaBoolean: SigmaBoolean, message: Uint8Array, signature: Uint8Array): boolean
class VerifyError extends Error { code: string }
```

With precondition / postcondition / error-taxonomy paragraphs mirroring the style of `evaluate`, `parseTree`, etc.

- [ ] **Step 5: Document `VerifyError` codes**

Add a `VerifyError` code-taxonomy subsection (mirror the `EvalError` taxonomy section style):

```markdown
### `VerifyError` taxonomy (v0.3.0 — phase 2g-medium)

- `'conjecture-not-implemented'` — Cand/Cor/Cthreshold input. Deferred to 2g-combinators.
- `'empty-signature'` — signature byte sequence is empty.
- `'truncated-signature'` — proof ran out of bytes during tree walk.
- `'point-not-on-curve'` — SEC1 decode rejected a leaf component.
- `'scalar-out-of-range'` — z scalar in signature is ≥ group order n.
```

- [ ] **Step 6: Document the structural `SigmaBoolean` type change**

In the "Type invariants" section, replace the old opaque `SigmaBoolean` description with:

```markdown
- `SigmaBoolean` (v0.3.0 — phase 2g-medium) is a 6-variant discriminated union (`TrivialProp` / `ProveDlog` / `ProveDhTuple` / `Cand` / `Cor` / `Cthreshold`). Wire parser produces all 6; the runtime verifier (phase 2g-medium leaf-only) walks only the 3 leaf-style variants. Cand/Cor/Cthreshold conjecture walks ship in 2g-combinators.
```

- [ ] **Step 7: Update dependencies section**

Add `@noble/curves@2.2.0` to the runtime dependency listing.

- [ ] **Step 8: Update umbrella plan**

```bash
grep -n "^| \*\*2g\|^| 2g " /home/mwaddip/projects/ergots/docs/specs/2026-05-13-ergoscript-interpreter-design.md
```

Find the phase 2g row in the phase-plan table. Replace with the "delivered as" annotation from "Umbrella plan update" above.

- [ ] **Step 9: Verify no broken references**

```bash
grep -rn "phase 2g\b\|sigma protocol" /home/mwaddip/projects/ergots/facts/ /home/mwaddip/projects/ergots/docs/specs/ | head -20
```

Spot-check that all references to phase 2g are consistent with the new "2g-medium + 2g-combinators" split.

- [ ] **Step 10: Two-stage review (orchestrator)**

- **Spec-compliance:** facts/ergoscript.md updates align with `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` § Validation against this spec at Task 8 finalize (checklist items 1-7).
- **Code-quality:** doc prose matches existing style; tables align; no broken cross-references.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs(ergoscript): bump facts to phase 2g-medium + annotate umbrella plan (phase 2g-medium task 7)

facts/ergoscript.md:
  - Coverage 42 → 44 arms
  - 36 EvalError codes (1 new: 'sigma-prop-input-not-group-element')
  - New public function verifySignature documented with pre/postcondition
  - New VerifyError class with 5-code taxonomy
  - Structural SigmaBoolean type (6 variants) replaces opaque {raw}
  - P2PK short-circuit (50 JitCost) on Const(SSigmaProp, _) documented
  - @noble/curves@2.2.0 added to dependency listing
  - 2 new SigmaBooleanParseError codes

docs/specs/2026-05-13-ergoscript-interpreter-design.md:
  - Phase 2g row annotated as "delivered as 2g-medium + 2g-combinators"

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Finalize — SESSION_CONTEXT + memory + push

**Files:**
- Modify: `packages/ergoscript/SESSION_CONTEXT.md` — phase 2g-medium done snapshot (gitignored, local-only)
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_sigma_combinators_deferred.md`
- Create: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/reference_sigma_verifier_internals.md`
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md` — hook lines

**Key memory updates:**

`project_ergots_direction.md`: phase 2g-medium shipped (44 arms; new `verifySignature` public; structural SigmaBoolean; @noble/curves dep added); next is **2g-combinators** (3 deferred sigma combinators + conjecture verifier extension including Cthreshold GF(2^192) polynomial), then 2g.5 method-call dispatch.

`project_sigma_combinators_deferred.md`: extend scope of next slice — 2g-combinators now bundles the 3 deferred eval arms (`Atleast`/`SigmaAnd`/`SigmaOr`) WITH the conjecture verifier walk (Cand XOR-inherit-parent / Cor XOR-derive-last / Cthreshold GF(2^192) polynomial Lagrange interpolation). Source line references preserved.

`reference_sigma_verifier_internals.md`: NEW. Lock the load-bearing crypto details for future reference (so future sessions don't need to re-derive them):

```markdown
---
name: reference-sigma-verifier-internals
description: Phase 2g-medium sigma-protocol verifier — key byte-format and crypto-equation details that must replicate sigma-rust exactly.
metadata:
  type: reference
---

Phase 2g-medium verifier internals — locked details that survive across sessions:

- **Challenge size:** 24 bytes (`SOUNDNESS_BITS = 192`). Hard-coded; not modernizable (Cthreshold polynomial requires GF(2^192)).
- **Challenge → scalar:** left-pad with 8 zero bytes to 32 bytes, then reduce mod n. Source: sigma-rust `wscalar.rs:69-76`. Right-pad would silently break every verify.
- **Schnorr verify equation (ProveDlog):** `a = (basePoint * z) + negate(decodePoint(h) * scalarFromChallenge(challenge))`. Source: `dlog_protocol.rs:173-184`. Sigma-rust's `Mul<&EcPoint>` is **point addition** (`ec_point.rs:74-79`) — the spec equation uses multiplicative notation for the additive group operation.
- **DH-tuple verify equations:** two commitments per leaf — `a` from `(g, u)`; `b` from `(h, v)`. Source: `dht_protocol.rs:132-157`.
- **Fiat-Shamir leaf format:** `LEAF_PREFIX (=1 byte) | put_i16_be(prop.length) | prop_bytes | put_i16_be(commitment.length) | commitment_bytes`. Source: `fiat_shamir.rs:140-200`. **`put_i16_be_bytes` is 2-byte big-endian, NOT VLQ** — same conceptual field as wire-format child-count but different encoding.
- **`prop_bytes`:** wrap SigmaProp in `ErgoTree{ version: 0, hasSize: false, constantSegregation: true }` BEFORE serializing. Source: `fiat_shamir.rs:148-157`, `sigma_boolean.rs:303-312`. Byte-equivalence with sigma-rust is the only correctness signal — V1 positive fixtures (sigma-rust-signed) are the test gate.
- **Fiat-Shamir hash:** `blake2b-256(input)` then take the **first 24 bytes**. Source: `fiat_shamir.rs:70-76`.
- **Identity point convention:** 33 zero bytes ↔ point-at-infinity is **Ergo convention**, NOT native SEC1. Source: `ec_point.rs:130-152`. The `crypto/secp256k1.ts` adapter handles the conversion in both directions; no caller needs to know.
- **Group order n:** secp256k1. Available as `groupOrder` from the adapter.
- **Verifier is NOT tree-version-gated.** Sigma proof bytes and verify math don't change between V0–V7 trees. ErgoTree v0 is hard-coded in the `prop_bytes` wrap (`fiat_shamir.rs:151`) regardless of the source tree's version.
- **`put_u16` is overloaded:** VLQ-encoded in wire format (`cand.rs:67-69`); 2-byte big-endian in Fiat-Shamir (`fiat_shamir.rs:197`). Same conceptual field, different encodings. A mismatch is a silent verify-failure cause.

Why this memory: phase 2g-medium's verifier touches non-obvious sigma-protocol details that, if drifted from sigma-rust, cause silent verification failures (the worst kind of bug for a verifier). Locking the cites makes future sessions cheap to context-restore.

How to apply: when modifying any code under `src/sigma/`, `src/crypto/secp256k1.ts`, or future `2g-combinators` slice, cross-check this memory against the proposed change. If a detail here contradicts the change, re-read the cited sigma-rust source before proceeding.

Related: [[project-sigma-combinators-deferred]], [[reference-source-first-discipline]].
```

`MEMORY.md` index: update the hook lines for `project_ergots_direction` and `project_sigma_combinators_deferred`; add a new line for `reference_sigma_verifier_internals`.

`SESSION_CONTEXT.md` (gitignored): fresh snapshot mirroring the phase 2f Coll HOFs format (state summary, coverage, test counts, new EvalError codes, new modules, new public surface, key design decisions, files changed, next steps).

**Tasks:**

- [ ] **Step 1: Read current memory files**

```bash
cat /home/mwaddip/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md
cat /home/mwaddip/.claude/projects/-home-mwaddip-projects-ergots/memory/project_sigma_combinators_deferred.md
cat /home/mwaddip/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md
```

- [ ] **Step 2: Update `project_ergots_direction.md`**

Update the body to reflect phase 2g-medium done. Bump the "Next" line to 2g-combinators (then 2g.5 method-call dispatch).

- [ ] **Step 3: Update `project_sigma_combinators_deferred.md`**

Extend scope of the next slice to include conjecture verifier extensions (Cand XOR walk, Cor XOR-derive-last, Cthreshold GF(2^192) polynomial) alongside the 3 eval arms.

- [ ] **Step 4: Write the new `reference_sigma_verifier_internals.md`**

Use the content draft from "Key memory updates" above. Save to `~/.claude/projects/-home-mwaddip-projects-ergots/memory/reference_sigma_verifier_internals.md`.

- [ ] **Step 5: Update `MEMORY.md` index**

Update hook lines:

```markdown
- [Ergots project direction](project_ergots_direction.md) — phase 2g-medium shipped (44 arms; verifySignature public); next is 2g-combinators, then 2g.5 method-call dispatch
- [Sigma combinators deferred](project_sigma_combinators_deferred.md) — Atleast/SigmaAnd/SigmaOr eval arms + conjecture verifier extension (Cand/Cor walks + Cthreshold GF(2^192) polynomial) all in 2g-combinators
- [Sigma verifier internals](reference_sigma_verifier_internals.md) — locked crypto details for the 2g-medium verifier (challenge/scalar conversion; Schnorr equation; Fiat-Shamir byte format; identity convention)
```

- [ ] **Step 6: Update `packages/ergoscript/SESSION_CONTEXT.md`**

Overwrite with the phase 2g-medium done snapshot. Mirror the phase 2f Coll HOFs `SESSION_CONTEXT.md` structure. Include:

- Phase completed: 2g-medium — structural SigmaBoolean + CreateProveDlog/CreateProveDhTuple + verifySignature + P2PK short-circuit
- Coverage 44 of ~70 arms
- Test counts (current ergoscript count + new C1/V1/V2/wire-variant tests)
- New EvalError code (1)
- New VerifyError class with 5 codes
- New SigmaBooleanParseError codes (2)
- New runtime dep: @noble/curves@2.2.0
- New modules: `src/crypto/secp256k1.ts`, `src/sigma/{errors,challenge,sig-serializer,fiat-shamir,verifier}.ts`
- Modified files summary
- Key design decisions (mirror Section 4 of the design spec)
- C2 corpus: still `success=0 not-impl=18 other=0` — phase 2g-medium does not unlock the corpus (2g.5 method-call dispatch is the unlocker)
- Behavior changes: structural SigmaBoolean shape (was opaque); P2PK Const charges 50 (was 5)
- Next steps: brainstorm 2g-combinators OR brainstorm 2g.5 method-call dispatch out of order OR npm publish v0.3.0

- [ ] **Step 7: Commit memory + SESSION_CONTEXT updates**

```bash
# Memory files live outside the repo (in ~/.claude/...); they're not git-tracked here.
# Commit only the in-repo files: SESSION_CONTEXT.md is gitignored, so no commit for it.
# The umbrella spec was committed in Task 7; this task may have no in-repo diff
# beyond SESSION_CONTEXT.md (which is gitignored). Verify:

cd /home/mwaddip/projects/ergots
git status
```

If `git status` shows no tracked changes (memory files outside repo; SESSION_CONTEXT.md gitignored), skip the commit. Otherwise commit:

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(ergots): finalize phase 2g-medium — memory + session context (phase 2g-medium task 8)

Memory updates (outside repo):
  - project_ergots_direction: phase 2g-medium shipped; next 2g-combinators
  - project_sigma_combinators_deferred: extended to include conjecture verifier
  - reference_sigma_verifier_internals: NEW — crypto details locked

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Run full ergoscript suite one final time**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all tests PASS; zero typecheck errors.

- [ ] **Step 9: Verify Layer C2 corpus regression gate**

```bash
npx vitest run packages/ergoscript/test/corpus-eval.test.ts
```

Expected: `success=0 not-impl=18 other=0`. The `expect(other).toBe(0)` regression gate stays green.

- [ ] **Step 10: Verify no `.wasm` bundle / Node built-ins in shipped code**

```bash
grep -rE "Buffer|process\.|require\(|node:|\.wasm" packages/ergoscript/src/ | grep -v -E "//|\.test\.|/test/" | head -20
```

Expected: no output (or only the existing test-file references documented in CLAUDE.md).

- [ ] **Step 11: Push to origin**

```bash
git push origin master
```

Verify the push succeeded and the branch is up-to-date with origin.

- [ ] **Step 12: Spec-compliance final check**

Re-read `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` § Validation against this spec at Task 8 finalize. For each of the 15 checklist items, confirm it's satisfied:

1. ✅ Coverage line in `facts/ergoscript.md` reflects 42 → 44 (Task 7)
2. ✅ EvalError taxonomy: `'sigma-prop-input-not-group-element'` documented (Task 7)
3. ✅ VerifyError class documented with 5 codes (Task 7)
4. ✅ SigmaBoolean shape change documented (Task 7)
5. ✅ `verifySignature` documented with pre/postcondition (Task 7)
6. ✅ `@noble/curves@2.2.0` in dependencies section (Task 7)
7. ✅ P2PK short-circuit (50 JitCost) documented on Const arm (Task 7)
8. ✅ Umbrella plan annotated for 2g-medium + 2g-combinators split (Task 7)
9. ✅ SESSION_CONTEXT.md snapshot matches end state (Task 8)
10. ✅ project_ergots_direction memory updated (Task 8)
11. ✅ project_sigma_combinators_deferred memory updated (Task 8)
12. ✅ MEMORY.md hook lines updated (Task 8)
13. ✅ Test counts: prior tests stay green + new tests pass; all in node + jsdom (Tasks 1-8 verification gates)
14. ✅ `expect(other).toBe(0)` regression gate stays green (Task 8 Step 9)
15. ✅ No new browser-incompatible primitives; bundle-scan passes (Task 8 Step 10)

Phase 2g-medium done. Next: user picks the follow-up (2g-combinators / 2g.5 method-call dispatch / npm publish v0.3.0 / something else).

---

*End of plan.*
