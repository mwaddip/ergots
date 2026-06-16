# `@ergots/transaction` — transaction-validation tier design

**Date:** 2026-06-15
**Status:** Design (pre-implementation)
**Package:** `@ergots/transaction` (new)

## Motivation

The evaluator (`@ergots/ergoscript`) validates a single `ErgoTree` against a
context and has been walked genesis→tip with zero divergences. The layer that
makes it *usable* for the project's stated end goal — a browser that bootstraps
from a verified NiPoPoW proof and **locally verifies a user-constructed
transaction** before broadcasting — is the transaction tier: parse a full Ergo
transaction, build the per-input contexts, drive the evaluator + sigma verifier,
and apply the transaction-level consensus rules.

This package is **validation only**. Transaction *building* and *signing* need a
sigma-protocol **prover** (Schnorr / DH-tuple proving, Fiat-Shamir on the prove
side); ergots only ever built the *verifier*. Building is a separate, later
deliverable (see Out of Scope).

## Where it sits

```
@ergots/scorex      codec primitives (ByteReader/Writer, VLQ, blake2b, Header)
   └── @ergots/ergoscript   ErgoTree parse/serialize, evaluator, sigma verifier,
                            SBox/SValue/SType codecs, EvalContext
          └── @ergots/transaction   THIS PACKAGE: tx wire codec + validation
                 └── (future) wallet / broadcaster   fetches boxes, builds+signs, broadcasts
```

The package is pure, synchronous, offline, and browser-clean. It **never fetches
data** — the caller (a wallet) supplies the spent input boxes and chain state.

## Scope

**In:**
- Parse / serialize `ErgoLikeTransaction` (byte-for-byte).
- Derive the **signing message** (bytes-to-sign) and the **transaction id**.
- **Stateless validation** — checkable from the transaction alone.
- **Stateful validation** — needs the spent input boxes + chain state: value &
  token conservation, output well-formedness, per-input script verification
  (via the evaluator + sigma verifier), storage-rent (expired-box) spends, and
  per-transaction cost aggregation.

**Out (explicit):**
- Transaction building, signing/proving (needs a sigma **prover**).
- Fee estimation, coin selection, address/wallet management.
- Any networking / HTTP / node REST — that is the caller's job.
- Mempool, block assembly, full-block validation.

## Current-state map (what we extract vs. what is new)

A read of `tools/mainnet-validate/harness/src/validate-tx.ts` +
`bundle-types.ts` + the package sources established three buckets.

**Bucket 1 — extract + harden (proven genesis→tip).** The per-input *script*
verification pipeline already exists in `validate-tx.ts` and has been walked to
the chain tip with zero divergences:
- box / context-extension decode (reuses ergoscript's `SBox` + `SType`/`SValue`
  codecs),
- `EvalContext` construction — the 10-deep headers array with the
  oldest-header padding convention, `PreHeader` projection,
  `lastBlockUtxoRootHash`, per-input `treeVersion`, `jitCostLimit`
  (= `maxBlockCost` × 10),
- `evaluateWith` → result must be `SigmaProp` → `verifySignature`,
- the **storage-rent / expired-box** spend rule (`checkStorageRent`, fully
  implemented).

It is currently welded to two things we strip: the WASM-oracle cost *comparison*
(dev-tooling — gone; the library just computes cost), and the decomposed
`TxBundle` shape (re-home onto a real parsed transaction).

**Bucket 2 — genuinely new: the transaction wire layer.** Nothing parses a
transaction today — the harness leans on the node to hand it pre-decomposed box
bytes + a pre-computed `signingMessage` (confirmed: `bundle-assembler.ts` reads
`signingMessage` straight from a REST fragment). New work:
- `ErgoLikeTransaction` parse + serialize (inputs with spending proofs +
  context extensions, data-inputs, output candidates),
- the **signing-message** serialization (inputs without proofs) — the linchpin
  that makes the validator node-independent,
- `transactionId` = blake2b256 over the signing-message bytes.

**Bucket 3 — genuinely new: structural / accounting checks.** The harness
skipped these entirely (the node had already accepted the txs, so it only needed
script verification). The transaction-level rules — value/token conservation,
output well-formedness, stateless pre-checks, cost aggregation — are new.

**Stays in the caller:** REST clients, bundle assembly, fetching spent boxes by
id, the WASM oracle.

The headline: the riskiest, most error-prone part — consensus-correct script
eval + cost + storage rent — is behind us and proven; the new surface is
mechanical-but-careful wire bytes + arithmetic, both with clean sigma-rust / JVM
references and the repo's existing fixture discipline.

## Architecture — modules

Small, single-purpose units, mirroring ergoscript's `wire/` + per-concern split:

| Module | Responsibility |
|---|---|
| `src/types.ts` | Data model: `ErgoLikeTransaction`, `Input`, `SpendingProof`, `DataInput`, `ErgoBoxCandidate`. Reuses ergoscript's `ErgoBox` / `SValue` / `SType` (no redefinition). |
| `src/wire/transaction.ts` | `parseTransaction` / `serializeTransaction` — the top-level envelope. |
| `src/wire/box-candidate.ts` | `ErgoBoxCandidate` codec, **in-transaction** indexed-token-digest variant (see Wire format). |
| `src/wire/input.ts` | `Input` / `SpendingProof` / `DataInput` codecs (boxId, proof bytes, context extension). |
| `src/wire/signing-message.ts` | `signingMessage(tx)` (bytes-to-sign) + `transactionId(tx)`. |
| `src/context.ts` | Build the per-input `EvalContext` from `(tx, inputBoxes, stateContext)` — headers array + padding, `PreHeader`, `lastBlockUtxoRoot`, treeVersion, cost limit. Lifted from the harness. |
| `src/validate/stateless.ts` | `validateStateless(tx)`. |
| `src/validate/stateful.ts` | `validateStateful(tx, deps)` — conservation + per-input verify + storage rent + cost sum. |
| `src/validate/storage-rent.ts` | `checkStorageRent` (extracted from the harness). |
| `src/errors.ts` | `TxParseError` + `TxValidationError` typed-code unions. |
| `src/index.ts` | Public exports. |

## Data model (`types.ts`)

```ts
interface ErgoLikeTransaction {
  inputs: Input[];                 // ≥ 1
  dataInputs: DataInput[];         // ≥ 0
  outputCandidates: ErgoBoxCandidate[];  // ≥ 1
}
interface Input {
  boxId: Uint8Array;               // 32 bytes
  spendingProof: SpendingProof;
}
interface SpendingProof {
  proofBytes: Uint8Array;          // the serialized sigma proof (may be empty)
  contextExtension: ContextExtension;  // varId → Constant (reuse ergoscript's type)
}
interface DataInput { boxId: Uint8Array; }   // 32 bytes
interface ErgoBoxCandidate {                 // an ErgoBox WITHOUT txId/index
  value: bigint;                   // nanoErg, u64
  ergoTreeBytes: Uint8Array;       // canonical ErgoTree bytes
  creationHeight: number;          // u32 (≤ Int.MaxValue, see rules)
  tokens: { id: Uint8Array; amount: bigint }[];
  registers: Record<number, { tpe: SType; value: SValue }>;  // R4..R9
}
```

`ErgoBox` (the *spent* box, with txId + index) is reused verbatim from
ergoscript. An `ErgoBoxCandidate` is the output shape: identical body minus the
transaction reference (txId/index are assigned when the tx is included).

## Wire format

The byte layout is mirrored from the canonical reference **byte-for-byte** and
validated by fixtures — not invented here. References:
- sigma-rust `ergo-lib/src/chain/transaction.rs` (`Transaction`,
  `TransactionSerializer`), `transaction/input.rs`, `transaction/data_input.rs`,
  `ergo-lib/src/chain/ergo_box/box_serialization` (candidate body).
- JVM `org.ergoplatform.ErgoLikeTransactionSerializer`,
  `ErgoBoxCandidate.serializer`.

Structural facts that drive the design (confident; exact bytes deferred to the
reference during TDD):

- **Envelope order:** `inputs` (VLQ count + each), `dataInputs` (VLQ count +
  each 32-byte boxId), `outputCandidates` (VLQ count + each candidate body).
- **Input:** 32-byte `boxId` + `SpendingProof` { VLQ-length-prefixed
  `proofBytes` + `ContextExtension` (count + each `varId` byte + `Constant`
  = `SType‖SValue`) }.
- **`ErgoBoxCandidate` inside a transaction uses an indexed token-digest
  table.** The serializer collects the distinct token ids across *all* outputs
  into a transaction-wide table; each candidate then references its tokens by
  table index rather than inlining the 32-byte id. This is the `tokensInTx`
  path and is **distinct** from ergoscript's existing standalone-box
  `serializeBoxBytesWithoutRef` (which is `tokensInTx = None`). The standalone
  codec is reusable groundwork; the in-transaction indexed variant is new and
  is the trickiest part of the codec.
- **Signing message (`bytes-to-sign`):** the transaction serialized with each
  input reduced to `(boxId, contextExtension)` — i.e. **without `proofBytes`** —
  plus data-inputs and output candidates. This is what each input's signature
  signs. (sigma-rust `Transaction::bytes_to_sign`.)
- **`transactionId` = `blake2b256(signingMessage)`** — over the bytes-to-sign,
  so the id is independent of the proofs. (Verify the hash basis against the
  reference at implementation; the `signingMessage`-basis is the expected one.)

## Validation rules

Rule sets mirror sigma-rust `Transaction::validate_stateless` /
`validate_stateful` and JVM `ErgoTransaction`. Monetary/size constants
(`MinValuePerByte`, `MaxTransactionSize`, `MaxBlockCost`, `StorageFeeFactor`)
are chain `Parameters` supplied via `deps` (with the sigma-rust defaults as the
fallback, matching the harness's posture).

**Stateless** (`validateStateless(tx)` — transaction alone):
- inputs non-empty; output candidates non-empty.
- input / output counts within range (Short-bounded).
- no duplicate input box ids.
- every output value > 0; the sum of output values does not overflow i64.
- serialized transaction size ≤ `MaxTransactionSize`.
- every output `creationHeight` ≥ 0 and ≤ `Int.MaxValue`.

**Stateful** (`validateStateful(tx, deps)` — needs spent boxes + chain state):
- every input box is provided and its id matches `tx.inputs[i].boxId`.
- **value conservation:** Σ(input box values) == Σ(output values). (Ergo has no
  separate fee field — the fee is an ordinary output to the fee address.)
- **token conservation:** for each existing token, Σ output amount ≤ Σ input
  amount; at most one *newly minted* token is allowed and its id must equal the
  **first input box id** (Ergo's new-token rule). Burning (out < in) is allowed.
- **output well-formedness:** each output value ≥ its minimal value
  (`MinValuePerByte` × serialized box size); `creationHeight` ≤ current block
  height.
- **per-input verification** (the extracted Bucket-1 pipeline): for each input,
  either it is a valid **storage-rent** spend (empty proof + expired box +
  recreation/fee rules — cost 0, no eval) OR build the `EvalContext`, run
  `evaluateWith`, require a `SigmaProp` result, and `verifySignature(prop,
  signingMessage, proofBytes)`.
- **cost aggregation:** the summed per-input JIT cost stays within the
  cost limit (`maxBlockCost` × 10, raw-JIT scale).

Failures throw `TxValidationError` with a structural `code` + the offending
location (input/output index, box id).

## Public API (`index.ts`)

```ts
parseTransaction(bytes: Uint8Array): ErgoLikeTransaction      // throws TxParseError
serializeTransaction(tx: ErgoLikeTransaction): Uint8Array
signingMessage(tx: ErgoLikeTransaction): Uint8Array
transactionId(tx: ErgoLikeTransaction): Uint8Array

validateStateless(tx: ErgoLikeTransaction): void              // throws TxValidationError
validateStateful(tx: ErgoLikeTransaction, deps: StatefulDeps): void
```

```ts
interface StatefulDeps {
  // Spent boxes, ORDERED to match tx.inputs by position; the library asserts
  // each box's id == tx.inputs[i].boxId. (Chosen over a resolver/map for v1:
  // explicit, and the wallet already holds the inputs in order. A
  // (boxId)=>ErgoBox resolver is the flexible future shape if needed.)
  inputBoxes: ErgoBox[];
  dataInputBoxes: ErgoBox[];     // ordered to match tx.dataInputs
  stateContext: {
    height: number;
    headers: Header[];           // preceding headers, newest-first; lib pads to 10
    preHeader?: PreHeader;       // optional; derived from headers[0] if omitted
    lastBlockUtxoRoot: AvlTreeData;
    parameters?: Partial<ChainParameters>;  // sigma-rust defaults fill gaps
  };
}
```

Stateless and stateful stay **separate functions** (matches JVM/sigma-rust; lets
a caller run the cheap checks before fetching boxes). The error classes are the
package's only exported error surface, each carrying `code: string`.

## Error model

Two typed error classes, following the per-package pattern
(`feedback_rust_port_style`, the ergoscript wire/eval split):
- `TxParseError` — wire-layer parse/serialize failures (truncation,
  out-of-range counts, malformed candidate, bad token-table index, …).
- `TxValidationError` — rule failures (conservation, well-formedness,
  script-verify false, cost-exceeded, …), with a `code` union and a
  `location` payload.

Errors raised by the underlying layers (`ergoscript`'s `EvalError` /
`VerifyError`, `scorex`'s `ReaderError`) surface unwrapped where a validation
step calls into them, exactly as `evaluate` does today.

## Dependencies & constraints

- Runtime deps: `@ergots/ergoscript`, `@ergots/scorex`. `@noble/*` only
  transitively (no direct curve/hash use beyond what those expose).
- Browser-clean and enforced as elsewhere: `Uint8Array` only (no `Buffer`), no
  `node:*` / `process` / `fs`, no WASM, ESM-only, no top-level await. Tests run
  under both `node` and `jsdom`.
- Pure & synchronous. No I/O, clock, or PRNG.

## Testing / validation strategy

- **Wire round-trip:** byte-identity `parseTransaction` ↔ `serializeTransaction`
  over a committed corpus of **real mainnet transaction bytes** (`.bin`
  fixtures, fetched once from a node and committed) — same discipline as
  ergoscript's wire layer. Includes multi-token txs (to exercise the indexed
  token table), data-input txs, and storage-rent (empty-proof) txs.
- **Signing message + txId:** validated end-to-end — verifying a real on-chain
  signature only passes if `signingMessage` is byte-correct; `transactionId` is
  cross-checked against the node-reported id.
- **Rules:** per-rule unit tests plus adversarial mutations (a tx mutated to
  break each invariant must fail that specific check), seeded from sigma-rust's
  transaction test vectors where they port cleanly.
- **Integration / regression net:** once the codec exists, re-point
  `tools/mainnet-validate` at it — the harness parses raw tx bytes itself
  (instead of node-decomposed bundles) and re-walks genesis→tip. The existing
  dev-tooling proof becomes this package's regression coverage.
- **Mutation tests** for the wire codec (single-byte flips → typed throw or
  byte-identical), mirroring the other packages.

## Build order (→ implementation-plan phases)

1. **Wire codec** — `types.ts`, the parse/serialize codecs incl. the in-tx
   indexed token table, `signingMessage` + `transactionId`; fixture-validated
   byte-identity. (Wire-format-first, per `feedback_wire_format_first_scoping`.)
2. **Context + script verification** — `context.ts`, `validate/storage-rent.ts`,
   the per-input verify path; lift from the harness, decouple from the oracle,
   re-home onto the parsed tx.
3. **Structural / accounting checks** — `validate/stateless.ts`,
   `validate/stateful.ts` (conservation, well-formedness, cost aggregation).
4. **Integration** — harness re-point + genesis→tip re-walk; `facts/` contract +
   `API.md` + README; package publish prep.

Stateless-then-stateful falls out of phases 1→3 naturally.

## Out of scope / future

- **Transaction building + signing** — needs a sigma **prover** (Schnorr /
  DH-tuple proving, Fiat-Shamir prove side). A separate future package
  (`@ergots/transaction-builder` or a prover package); the present package's
  types + wire codec are its foundation.
- Fee estimation, coin selection, address/wallet management, mempool — the
  wallet tier.
- Networking — always the caller's responsibility.

## Risks & open items

- **Wire byte-exactness** (indexed token table, candidate body field order,
  proof-length prefix) — the highest-fidelity-required part; mitigated by the
  byte-identity fixture corpus from real mainnet txs.
- **txId hash basis** (over `signingMessage` vs. full serialization) — stated as
  `signingMessage` here; confirm against the reference + node-reported ids in
  phase 1.
- **Constant/formula fidelity** (min box value, cost limit, max tx size) —
  mirror the reference; pin with tests + the genesis→tip re-walk.
- The harness re-point (phase 4) is a strong regression net but not a blocker
  for shipping the package; it can follow.
