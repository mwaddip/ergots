# `@ergots/transaction` — validation logic (stateless + stateful) design

**Date:** 2026-06-15
**Status:** Design (pre-implementation)
**Package:** `@ergots/transaction` — phase 2 (validation logic)
**Builds on:** the phase-1 wire codec (`parseTransaction` / `serializeTransaction` / `signingMessage` /
`transactionId` / `TxParseError`), shipped on branch `transaction-tier`.
**Refines:** the umbrella spec `docs/specs/2026-06-15-ergots-transaction-validation-design.md` — this
collapses its build-order items 2 ("context + script verification") and 3 ("structural / accounting
checks") into ONE phase.

## Scope

Add the **validation logic**: turn a parsed `ErgoLikeTransaction` (+ the spent input boxes + chain
state) into accept / reject.

**In:**
- `validateStateless(tx)` — checks from the transaction alone.
- `validateStateful(tx, deps)` — input-box provisioning, value + token conservation, output
  well-formedness, the per-input script verification (lifted from the mainnet-proven harness
  `validate-tx.ts`), storage-rent spends, and per-transaction cost aggregation.
- `context.ts` — build the per-input `EvalContext`.
- the `TxValidationError` taxonomy.

**Out (this phase):**
- **The harness re-point + genesis→tip re-walk** — deferred to a CAPSTONE integration step after all
  phases (user decision). This phase is gated on fixture + per-rule / adversarial tests.
- Transaction building / signing (needs a sigma **prover**) — out of scope for the whole package.
- Networking — always the caller's job.

## Key decisions (from the brainstorm)

1. **One phase, not two.** The umbrella spec's phase 2 (verify) + phase 3 (accounting) merge: both are
   stateful, share the spent boxes + context, and compose into `validateStateful`. `validateStateless`
   stays a separate public function (it can run before the caller fetches boxes).
2. **Lift the proven pipeline.** The per-input verify path (context build, storage-rent,
   `evaluateWith → SigmaProp → verifySignature`) is lifted ~verbatim from
   `tools/mainnet-validate/harness/src/validate-tx.ts`, which walked mainnet genesis→tip with zero
   divergences — decoupled from the WASM-oracle **cost comparison** (gone; the library just *computes*
   cost) and from the `TxBundle` / `HarnessError` shapes (re-homed onto `ErgoLikeTransaction` +
   `StatefulDeps` + `TxValidationError`). Clean-room: re-read `validate-tx.ts` + sigma-rust; the
   reference defines behaviour, the fixtures + adversarial tests prove correctness.
3. **`lastBlockUtxoRoot` is DERIVED from `headers[0].stateRoot`,** not a separate dep — matching the
   proven harness (`AvlTreeData`: digest = `headers[0].stateRoot`, treeFlags `0b00000111`, keyLength 32,
   valueLengthOpt null).
4. **`preHeader` is caller-supplied (REQUIRED).** The library validates *unconfirmed* txs (the wallet
   case): the caller knows the intended block (height = tip+1, timestamp, minerPk, nBits, votes); it is
   NOT derived from the preceding headers the way the harness does for an already-confirmed block.
5. **Re-walk deferred to the capstone** (after all phases). This phase's gate = fixtures + per-rule /
   adversarial tests.

## Architecture — modules

| Module | Responsibility |
|---|---|
| `src/context.ts` | Build the per-input `EvalContext` from `(tx, deps, inputIndex)`: `headers[10]` padding (repeat-oldest), PreHeader, `lastBlockUtxoRoot`-from-`headers[0]`, per-input `treeVersion`, `jitCostLimit` (= `maxBlockCost × 10`), the output-candidate → `ErgoBox` promotion for `CONTEXT.outputs`, and `constants` = `tree.constants`. |
| `src/validate/storage-rent.ts` | `checkStorageRent` — expired-box (empty-proof) spends. Lifted from the harness. |
| `src/validate/stateless.ts` | `validateStateless(tx)` — transaction-alone structural checks. |
| `src/validate/stateful.ts` | `validateStateful(tx, deps)` — input-box-id assertion, value + token conservation, output well-formedness, the per-input verify (storage-rent OR eval+verify), cost aggregation. |
| `src/errors.ts` | Add `TxValidationError` alongside the existing `TxParseError`. |
| `src/index.ts` | Export `validateStateless`, `validateStateful`, `TxValidationError`, `TxValidationErrorCode`, and the `StatefulDeps` / `StateContext` / `ChainParameters` types. |

## Data model additions (`types.ts`)

```ts
interface StatefulDeps {
  inputBoxes: ErgoBox[];        // ordered to match tx.inputs by position; lib asserts each boxId
  dataInputBoxes: ErgoBox[];    // ordered to match tx.dataInputs
  stateContext: StateContext;
}
interface StateContext {
  headers: Header[];            // preceding / most-recent confirmed headers, newest-first, length >= 1;
                                //   lib takes up to 10 and pads to 10 by repeating the oldest.
  preHeader: PreHeader;         // the block being built (REQUIRED) — height/timestamp/minerPk/nBits/votes
  parameters?: Partial<ChainParameters>;   // sigma-rust Parameters::default() fills any gap
}
interface ChainParameters {
  maxBlockCost: number;         // sigma-rust default 1_000_000
  storageFeeFactor: number;     // sigma-rust default 1_250_000
  minValuePerByte: number;      // sigma-rust Parameters::default() — source-read the exact value
  maxTransactionSize: number;   // sigma-rust default — source-read the exact value
}
```
`Header` / `PreHeader` come from `@ergots/scorex`; `ErgoBox` / `AvlTreeData` from `@ergots/ergoscript` —
no redefinition.

## Context construction (`context.ts`) — lifted from `validate-tx.ts`

Per input, the library builds an `EvalContext` (via ergoscript `makeContext`) carrying:
- `height` = `preHeader.height`.
- `selfBox` = `inputBoxes[inputIndex]`.
- `inputs` = `inputBoxes`; `dataInputs` = `dataInputBoxes`.
- `outputs` = `tx.outputCandidates` **promoted to `ErgoBox`** — assign `txId = transactionId(tx)` +
  `index = position` so a script reading `OUTPUTS(i).id` is faithful. **[the one genuinely-new bit]**
- `preHeader` = `deps.stateContext.preHeader`.
- `headers` = `buildHeadersArray(stateContext.headers)` — up to 10 newest-first, padded by repeating
  the oldest until length 10. `headers.length >= 1` is REQUIRED (an unconfirmed tx always has a tip;
  unlike the harness's height-1 skip).
- `lastBlockUtxoRootHash` = `{ digest: headers[0].stateRoot, treeFlags: 0b00000111, keyLength: 32,
  valueLengthOpt: null }`. **[derived, not a dep]**
- `extension` = `tx.inputs[inputIndex].spendingProof.contextExtension` — already parsed by the phase-1
  wire codec; no re-parse. **[simplification vs the harness, which parsed Constant blobs]**
- `jitCostLimit` = `maxBlockCost × 10` (sigma-rust JitCost is 10× block cost).
- `treeVersion` = the spent box's own ergoTree version (`ergoTreeBytes[0] & 0x07`).
- `constants` = `tree.constants` (set explicitly — `evaluateWith` does NOT auto-default from the tree).

References: `validate-tx.ts` (`buildHeadersArray`, `preHeaderFromHeader`, the `makeContext` call,
steps 0–5d); sigma-rust `ergo-lib/src/wallet/signing.rs` (Context build), `ergo-node-rust
validation/src/tx_validation.rs:35-60`.

## Validation rules

Mirror sigma-rust `Transaction::validate_stateless` / `validate_stateful` (read via
`git show ergo-node-integration:<path>` from `external/sigma-rust`) and JVM `ErgoTransaction`. The lists
below are the EXPECTED set (from the umbrella spec); the implementer confirms the exact set + each
rule's stateless-vs-stateful home against the source — the reference defines behaviour.

### `validateStateless(tx)` — transaction alone
- inputs non-empty; output candidates non-empty.
- no duplicate input box ids.
- every output value `> 0`; `Σ` output values does not overflow i64.
- every output `creationHeight ∈ [0, Int.MaxValue]`.
- serialized tx size (`serializeTransaction(tx).length`) ≤ `maxTransactionSize`. (No deps are passed to
  `validateStateless`; it uses the sigma-rust **default** `maxTransactionSize`. If the source places the
  size check in the stateful path instead, move it there — confirm against `validate_stateless`.)
- (The io-count bounds `[1, 32767]` are already enforced by the wire parser; `validateStateless`
  re-checks non-emptiness so an in-memory-constructed tx is also covered.)

### `validateStateful(tx, deps)` — needs spent boxes + state
1. **Input-box provisioning:** `deps.inputBoxes.length === tx.inputs.length` and each `inputBoxes[i]`
   id == `tx.inputs[i].boxId`; same for `dataInputBoxes` vs `tx.dataInputs`.
2. **Value conservation:** `Σ(input box values) === Σ(output values)`. (Ergo has no separate fee field —
   the fee is an ordinary output to the fee address.)
3. **Token conservation:** for each token present in the inputs, `Σ output amount ≤ Σ input amount`; at
   most one *newly-minted* token (a token id in outputs but not in any input), and its id MUST equal the
   first input box's id; burning (out < in) is allowed.
4. **Output well-formedness:** each output value ≥ its minimal value (`minValuePerByte ×` serialized box
   size); each output `creationHeight ≤ preHeader.height`.
5. **Per-input verification** (the lifted pipeline, per input, first failure halts):
   - if the spending proof is empty AND `checkStorageRent(...)` holds → input valid, **cost 0, no eval /
     verify** (`continue`);
   - else `parseTree(spentBox.ergoTreeBytes)` → build the `EvalContext` (above) → `evaluateWith` →
     require a `SigmaProp` result → `verifySignature(prop, tx.signingMessage, proofBytes)`.
6. **Cost aggregation:** `Σ` per-input `ctx.jitCost` ≤ `maxBlockCost × 10` (raw-JIT scale).

## Storage-rent (`storage-rent.ts`) — lifted

`checkStorageRent(selfBox, blockHeight, extension, outputBoxes, treeVersion, storageFeeFactor)` — lifted
~verbatim from the harness (which mirrors sigma-rust `storage_rent.rs::check_storage_rent_conditions`):
box older than `STORAGE_PERIOD` (1_051_200); extension var 127 (an `SShort` → i16) names a recreation
output; dust-vs-recreation rules (box value ≤ storage fee → spendable freely; else the named output must
recreate the box — same creationHeight = spending block, value ≥ value − fee, ergoTree + tokens + R4..R9
preserved). Tried FIRST for empty-proof inputs; on success the input is valid with cost 0 and no script
eval or signature verification. `storageFeeFactor` defaults to the sigma-rust `1_250_000`.

## Error model

`TxValidationError extends Error` with `readonly code: TxValidationErrorCode` and a `readonly location?:
{ inputIndex?: number; outputIndex?: number; boxId?: Uint8Array }`. Code union (refine against the source
during implementation):
- **stateless:** `'inputs-empty'`, `'outputs-empty'`, `'duplicate-input'`, `'output-value-not-positive'`,
  `'output-sum-overflow'`, `'tx-size-exceeded'`, `'creation-height-out-of-range'`.
- **stateful structural:** `'input-box-count-mismatch'`, `'input-box-id-mismatch'`,
  `'data-input-box-mismatch'`, `'value-not-conserved'`, `'token-not-conserved'`, `'invalid-minted-token'`,
  `'output-below-min-value'`, `'creation-height-in-future'`.
- **per-input verify:** `'non-sigmaprop-result'`, `'script-reduced-false'` (verifier returned `false`),
  `'cost-limit-exceeded'` (the AGGREGATE cost sum check).

**Errors raised by the underlying layers surface UNWRAPPED** where a verify step calls into them — the
ergoscript `EvalError` (incl. a single-input `'cost-limit-exceeded'`) and `VerifyError`, and scorex's
`ReaderError`, propagate as-is (exactly as `evaluate` does today, and as the harness's halt sites show).
`TxValidationError` is only for the validator's OWN structural verdicts (conservation, well-formedness,
verifier-`false`, non-SigmaProp, aggregate cost). This keeps the typed crypto-path errors intact for a
caller that wants to distinguish "the script said no" from "the accounting is wrong".

## Testing strategy

- **Fixtures:** a handful of real **(tx + spent input boxes + state-context)** tuples captured via the
  harness (it already fetches the boxes + headers + parameters), committed as test data; run through
  `validateStateful` — covering a normal multi-input verify path and a storage-rent (empty-proof) spend.
  The phase-1 tx fixtures also feed `validateStateless`.
- **Per-rule unit tests:** each stateless + stateful rule gets a passing case and a failing case.
- **Adversarial mutation:** mutate a valid `(tx + boxes + state)` tuple to break each invariant (drop a
  nanoErg from an output → `value-not-conserved`; inflate an output token amount → `token-not-conserved`;
  mint a token whose id ≠ first-input id → `invalid-minted-token`; flip a proof byte → `script-reduced-false`
  / `VerifyError`; …) and assert it fails *that specific* check.
- **NOT the genesis→tip re-walk** — that is the capstone integration step after all phases (user
  decision). It remains the strongest regression net and is recorded as the package's eventual gate.

## Risks / open items

- **Faithfulness of the conservation / token rules** to sigma-rust `validate_stateful` — mirror the
  source exactly; pin with the fixtures + adversarial tests. The adversarial path carries equal weight
  (a check that wrongly *accepts* an invalid tx is a latent consensus gap the on-chain fixtures can't
  catch — only the mutation tests can).
- **The output-candidate → `ErgoBox` promotion** (txId + index → box id) must match how the node /
  sigma-rust derives output box ids — verify against a fixture whose script reads `OUTPUTS(i).id`.
- **Chain `parameters` defaults** (`minValuePerByte`, `maxTransactionSize`) — source the exact sigma-rust
  `Parameters::default()` values; do not invent them.
- **The `validateStateless` size check** needs `maxTransactionSize` (a parameter) while `validateStateless`
  takes no deps — resolved by using the default; confirm sigma-rust puts the size check in the stateless
  (vs stateful) path.
- The deferred capstone re-walk is the definitive faithfulness proof; until it runs, the fixtures +
  adversarial tests are the bar.
