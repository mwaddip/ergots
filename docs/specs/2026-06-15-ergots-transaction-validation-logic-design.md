# `@ergots/transaction` — validation logic (stateless + stateful) design

**Date:** 2026-06-15
**Status:** Design (pre-implementation) — **rule set corrected 2026-06-15 against authoritative source**
(`TransactionContext::validate()` at `ergo-lib/src/wallet/tx_context.rs:151-269` + the
`ErgoTransaction::validate_stateless` trait method at `ergo_transaction.rs:99-116`, read via
`git show ergo-node-integration:<path>` from `external/sigma-rust`). The validation-rules / error-model /
parameters / cost sections below SUPERSEDE the umbrella spec's earlier *expected* lists.
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
interface ChainParameters {           // CONFIRMED — parameters.rs:157-168 (Parameters::default())
  maxBlockCost: number;         // 1_000_000   (JIT limit = maxBlockCost * 10)
  storageFeeFactor: number;     // 1_250_000
  minValuePerByte: number;      // 360   (== 30 * 12; also BoxValue::MIN_VALUE_PER_BOX_BYTE)
  inputCost: number;            // 2_000 (per-input structural cost)
  dataInputCost: number;        // 100   (per-data-input)
  outputCost: number;           // 100   (per-output)
  tokenAccessCost: number;      // 100   (per token entry + per distinct token, inputs + outputs)
}
// There is NO maxTransactionSize parameter in sigma-rust (confirmed): parameters.rs has MaxBlockSize =
// 524288 at BLOCK level only, and no per-tx size check exists anywhere. The per-OUTPUT box/script size
// caps are CONSTANTS, not parameters: MAX_BOX_SIZE = MAX_SCRIPT_SIZE = 4096 (ergo_box.rs:108-110).
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

The authoritative reference is sigma-rust's `TransactionContext::validate()`
(`ergo-lib/src/wallet/tx_context.rs:151-269`, the port of Scala `ErgoTransaction.validateStateful`) plus
the `ErgoTransaction::validate_stateless` trait method (`ergo_transaction.rs:99-116`). Source-read +
CONFIRMED 2026-06-15; the rule sets below replace the umbrella spec's earlier guesses.

### `validateStateless(tx)` — transaction alone
Confirmed MINIMAL (`validate_stateless`, `ergo_transaction.rs:99-116`):
- `Σ` output values does not overflow i64 (checked-add fold). → `output-sum-overflow`.
- no duplicate input box ids (unique count == input count). → `duplicate-input`.
- (Defensive: inputs / output candidates non-empty. The wire `BoundedVec[1, 32767]` already enforces this
  at parse; re-checked so an in-memory-constructed tx is covered too. → `inputs-empty` / `outputs-empty`.)

NOT stateless (the earlier list was wrong): output value `> 0` is structural (the `BoxValue` newtype
rejects `< MIN_RAW` at construction and the stateful **dust** check subsumes it); creationHeight range is
a STATEFUL rule (`creation-height-in-future` / `creation-height-negative` in `verify_output`); and there
is **no tx-size check** in sigma-rust at all.

### `validateStateful(tx, deps)` — needs spent boxes + state
Order mirrors `validate()` (first failure halts). The **box id** throughout = `blake2b256(box's
sigma_serialize bytes, incl. txId + index)` (`ergo_box.rs:141, 182-185, 234-250`) — the library COMPUTES
it (the `ErgoBox` runtime shape has no id field; re-serialize + hash, matching the proven harness).
1. **Input-box provisioning:** every `tx.inputs[i].boxId` resolves to a provided spent box (ordered:
   computed id of `deps.inputBoxes[i]` == `tx.inputs[i].boxId`); same for data-inputs vs
   `deps.dataInputBoxes`. → `input-box-count-mismatch` / `input-box-id-mismatch` / `data-input-box-mismatch`.
2. **Input-sum no overflow:** `Σ(input box values)` ≤ `i64::MAX`. → `input-sum-overflow`.
3. **Value conservation:** `Σ(input box values) === Σ(output values)` (strict equality; Ergo has no fee
   field — the fee is an ordinary output). → `value-not-conserved` (ErgPreservationError).
4. **Output well-formedness** — per output, `verify_output` (`tx_context.rs:272-312`):
   - **dust:** `value < serializedBoxSize × minValuePerByte` (default 360). → `output-below-min-value`.
   - **future height:** `(creationHeight as i32) > (preHeader.height as i32)` — SIGNED compare.
     → `creation-height-in-future`.
   - **monotonic height (post-v3):** when `preHeader.version ≥ 3`, require `creationHeight ≥ max(input box
     creationHeights)`. → `creation-height-below-max-input` (MonotonicHeightError, EIP-39). [NEW vs plan]
   - **negative height (post-v1):** when `preHeader.version != 1`, reject `creationHeight & (1<<31)`.
     → `creation-height-negative` (NegativeHeight). [NEW vs plan]
   - **box size:** `serializedBoxSize ≤ MAX_BOX_SIZE` (4096). → `box-size-exceeded`. [NEW vs plan]
   - **script size:** `ergoTreeBytes.length ≤ MAX_SCRIPT_SIZE` (4096). → `script-size-exceeded`. [NEW vs plan]
5. **Token conservation** (`extract_assets` + `verify_assets`, `tx_context.rs:341-372`): build in/out
   token→amount maps (per-map sum overflow → `token-amount-invalid`); `newTokenId` = first input box id;
   for each output token: if present in inputs require `inAmount ≥ outAmount` else `token-not-conserved`;
   if ABSENT from inputs require its id == `newTokenId` else `invalid-minted-token`. (Burning out<in is
   allowed; ≥1 token amounts are enforced by the newtype.)
6. **Per-input verification + cost** (lifted pipeline + the real cost model — see Cost below; per input,
   first failure halts):
   - spending proof empty AND `checkStorageRent(...)` holds → input valid, **cost 0, no eval / verify**
     (`continue`);
   - else `parseTree(spentBox.ergoTreeBytes)` → build the `EvalContext` (above) → `evaluateWith` → require
     a `SigmaProp` result (`non-sigmaprop-result`) → `verifySignature(prop, signingMessage, proofBytes)`
     (`false` → `script-reduced-false`).

### Cost model (`validate()` lines 196-268) — faithful-reachable, one named deferral
`validate()` charges everything into ONE accumulator (block→JIT scale ×10; limit `maxBlockCost × 10`,
enforced **cumulatively** across inputs so work can't be split to dodge `MaxBlockCost`):
- **init / structural cost** (up front): `INTERPRETER_INIT_COST(10_000) + nInputs×inputCost +
  nDataInputs×dataInputCost + nOutputs×outputCost + (tokenEntries + distinctTokens, inputs + outputs)
  ×tokenAccessCost`; if init alone exceeds the budget → `cost-limit-exceeded` (InitCostExceeded).
  **Implemented (reachable now — pure arithmetic).**
- **per-input eval cost** — accrues on the shared accumulator; thread the running cost into each input
  context's headroom (`jitCostLimit = limit − runningCost`) so the limit fires mid-tx (an `evaluateWith`
  `EvalError 'cost-limit-exceeded'` surfaces unwrapped). **Implemented (reachable now).**
- **sigma-verification cost** (`estimate_crypto_cost`) — **DEFERRED.** ergots' verifier exposes no cost
  surface (confirmed: nothing in `packages/ergoscript/src/sigma/` touches cost; `verifySignature` returns
  a bare boolean). Implementing it is a new crypto-path deliverable (its own phase). Phase-2 cost therefore
  UNDER-counts by the per-input crypto cost — a documented residual on the adversarial path, closed by that
  future deliverable + the **capstone genesis→tip JVM-oracle re-walk** (already the designated
  cost-faithfulness gate). CLAUDE.md-sanctioned residual (closing it needs genuinely broad work), not a
  shortcut — do NOT approximate the crypto cost.

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
{ inputIndex?: number; outputIndex?: number; boxId?: Uint8Array }`. Code union (CONFIRMED against the
sigma-rust `TxValidationError` variants, `ergo_transaction.rs:20-86`):
- **stateless:** `'inputs-empty'`, `'outputs-empty'`, `'duplicate-input'`, `'output-sum-overflow'`.
- **stateful structural:** `'input-box-count-mismatch'`, `'input-box-id-mismatch'`,
  `'data-input-box-mismatch'`, `'input-sum-overflow'`, `'value-not-conserved'`,
  `'output-below-min-value'` (dust), `'creation-height-in-future'`, `'creation-height-below-max-input'`
  (monotonic, post-v3), `'creation-height-negative'` (post-v1), `'box-size-exceeded'`,
  `'script-size-exceeded'`, `'token-not-conserved'`, `'invalid-minted-token'`, `'token-amount-invalid'`.
- **per-input verify:** `'non-sigmaprop-result'`, `'script-reduced-false'` (verifier returned `false`),
  `'cost-limit-exceeded'` (init cost OR the cumulative per-tx limit; an `evaluateWith` cost overrun
  surfaces as the ergoscript `EvalError 'cost-limit-exceeded'`, unwrapped — see below).

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

- **Cost-model residual (the one deferral):** phase-2 cost charges the init/structural cost + the
  cumulative per-input eval cost faithfully but DEFERS the sigma-verification cost (ergots' verifier
  exposes none). Phase-2 cost under-counts by the per-input crypto cost — documented, closed by a future
  verifier-cost deliverable + the capstone JVM-oracle re-walk. Do NOT approximate the crypto cost; leave
  it a named gap.
- **Faithfulness of the conservation / token / height / size rules** — all source-confirmed above; mirror
  `validate()`'s order. The adversarial path carries equal weight (a check that wrongly *accepts* an
  invalid tx is a latent consensus gap the on-chain fixtures can't catch — only the mutation tests can).
  Tests MUST cover the four rules the umbrella spec had missed: monotonic height, negative height, box
  size, script size.
- **The output-candidate → `ErgoBox` promotion** (txId + index → box id) must match how sigma-rust derives
  output box ids — verify against a fixture whose script reads `OUTPUTS(i).id`.
- **Chain `parameters` defaults** — CONFIRMED (`parameters.rs:157-168`): storageFeeFactor 1_250_000,
  minValuePerByte 360, maxBlockCost 1_000_000, inputCost 2_000, dataInputCost 100, outputCost 100,
  tokenAccessCost 100. There is NO maxTransactionSize.
- The deferred capstone re-walk is the definitive faithfulness proof; until it runs, the fixtures +
  adversarial tests are the bar.
