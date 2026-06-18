# `@ergots/transaction` — Interface Contract

The boundary contract for the Ergo transaction wire codec package. This package provides parse + serialize for `ErgoLikeTransaction` (the canonical Ergo transaction type), a signing-message derivation, and a transaction-id computation. It is the first layer of the transaction-validation stack described in `docs/specs/2026-06-15-ergots-transaction-validation-design.md`; phases 2–4 of that stack (stateless + stateful validation, per-input script verification, cost) are NOT part of this contract.

Authoritative wire-format reference: sigma-rust `ergo-lib/src/chain/transaction.rs` and `ergotree-ir/src/chain/ergo_box.rs` (branch `ergo-node-integration`). Where this file is silent, those are canonical. Where ergots and sigma-rust diverge in behavior, the JVM `sigma-state` is canonical — this is documented in place.

## Scope

**Ships in this contract (v0.1.0, phase 1 — wire codec):**

1. `parseTransaction(bytes)` — parse a complete `ErgoLikeTransaction` from a byte array; rejects trailing bytes.
2. `serializeTransaction(tx)` — serialize an `ErgoLikeTransaction` to wire bytes; rejects out-of-bound io-counts.
3. `signingMessage(tx)` — the Fiat–Shamir pre-image: the transaction envelope with every input's proof replaced by an empty proof (VLQ-length-0; extension and all other fields unchanged).
4. `transactionId(tx)` — `blake2b256(signingMessage(tx))`, the 32-byte transaction identifier.
5. `TxParseError` — the only error class; 3-variant `code` union documenting each rejection cause.
6. Data model types: `ErgoLikeTransaction`, `Input`, `SpendingProof`, `DataInput`, `ErgoBoxCandidate`.
7. Browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`. ESM only.

**Does NOT ship in phase 1 (planned phases 2–4):**

- Transaction validation (stateless well-formedness checks, conservation rule, per-input script execution, storage rent eligibility, fee constraints, JIT cost accounting).
- Transaction building / signing. Producing `SpendingProof.proofBytes` requires a sigma prover — out of scope.
- Node communication / submission.

## Public surface (v0.1.0)

### Primary export: `@ergots/transaction`

```ts
parseTransaction(bytes: Uint8Array): ErgoLikeTransaction
serializeTransaction(tx: ErgoLikeTransaction): Uint8Array

signingMessage(tx: ErgoLikeTransaction): Uint8Array
transactionId(tx: ErgoLikeTransaction): Uint8Array    // 32 bytes

class TxParseError extends Error {
  readonly code: TxParseErrorCode;
}
type TxParseErrorCode =
  | 'trailing-bytes'
  | 'token-table-index-out-of-range'
  | 'count-out-of-range'
```

### `parseTransaction(bytes)`

- **Precondition:** `bytes` is a `Uint8Array` containing exactly one complete `ErgoLikeTransaction` in sigma-serialized wire form. The function calls `ByteReader.isExhausted` after parsing and rejects any trailing bytes.
- **Postcondition (success):** Returns an `ErgoLikeTransaction` satisfying all type invariants below. `serializeTransaction(parseTransaction(b))` is byte-equal to `b` for all accepted inputs.
- **Postcondition (failure — `TxParseError`):** Thrown for:
  - `'trailing-bytes'` — bytes remain after a structurally complete transaction was parsed. This is STRICTER than sigma-rust's `sigma_parse_bytes` (which tolerates trailing bytes) and matches the JVM modifier-parse path and ergots' own `parseTree` zero-trailing precedent.
  - `'count-out-of-range'` — an io count violates the `TxIoVec` / `get_u32` bounds (see "Count bounds" below).
  - `'token-table-index-out-of-range'` — an output candidate references a token-table index that does not exist in the transaction's distinct-token-id table.
- **Postcondition (failure — other):** `ReaderError` (from `@ergots/scorex`) for truncated / malformed VLQ or fixed-width fields; inner `ErgoTreeParseError` / `ExprParseError` / `SValueParseError` from `@ergots/ergoscript` if a candidate's ergoTree or register bytes are malformed.

### `serializeTransaction(tx)`

- **Precondition:** `tx` satisfies the `ErgoLikeTransaction` type invariants below and the io-count bounds (see "Count bounds").
- **Postcondition (success):** Returns `Uint8Array` byte-equal to what a JVM sigma-state serializer would produce for the same transaction. The serialize path ALSO enforces all count bounds — it is safe to call `serializeTransaction` on a programmatically-constructed `tx` and rely on it to reject out-of-range counts.
- **Postcondition (failure — `TxParseError 'count-out-of-range'`):** inputs or outputCandidates is empty or > 32767; dataInputs is > 32767; the computed distinct-token table exceeds 65535 × 255 entries.

### `signingMessage(tx)`

- **Precondition:** Same as `serializeTransaction`.
- **Postcondition:** Returns `Uint8Array` — the full transaction envelope (`serializeTransaction` layout) with each input's `proofBytes` replaced by an empty proof. The empty proof serializes as a VLQ-length-0 (one zero byte for the length field), NOT an omitted field — the extension and all other per-input fields are present unchanged. This is the exact value sigma-rust's `bytes_to_sign` (`transaction.rs:184-190`) produces; `transactionId(parseTransaction(b))` is byte-equal to the node-reported transaction id for every fixture in the test corpus.
- **Throws:** Same shape as `serializeTransaction` (the count / token-table bounds go through the same shared `writeEnvelope` path).

### `transactionId(tx)`

- **Postcondition:** Returns `Uint8Array` of exactly 32 bytes — `blake2b256(signingMessage(tx))`. Matches the node-reported transaction id (lowercase base16 of these bytes, `TxId` derives `Display` from `Digest32`). Confirmed byte-correct: parsed-fixture ids equal the node-reported ids for the full test-fixture corpus.
- **Throws:** Same as `signingMessage`.

## Count bounds

These mirror the sigma-rust / JVM bounds exactly and are enforced on both parse AND serialize.

| Field | Range | Reference |
|---|---|---|
| `inputs.length` | `[1, 32767]` | `TxIoVec = BoundedVec<1, i16::MAX>` (`ergotree-ir/src/chain/context.rs:23`) |
| `outputCandidates.length` | `[1, 32767]` | same `TxIoVec` bound |
| `dataInputs.length` | `{0} ∪ [1, 32767]` | `opt_empty_vec`: 0 = None (allowed); otherwise `TxIoVec` |
| distinct token table | `≤ 65535 × 255 = 16,711,425` | `MAX_OUTPUTS_COUNT × ErgoBox.MAX_TOKENS_COUNT` (`transaction.rs:~308-312`) |
| token count wire field | `≤ u32::MAX` | `get_u32` (`vlq_encode.rs:267`) narrows the VLQ-u64 read |

All violations throw `TxParseError('count-out-of-range')`.

## Wire format

The envelope layout is (`Transaction::sigma_serialize`):

```
inputs_count        VLQ (put_usize_as_u16_unwrapped → put_u64, i.e. VLQ not fixed)
inputs[]            each Input::sigma_serialize
data_inputs_count   VLQ (or VLQ(0) when None)
data_inputs[]       each DataInput::sigma_serialize
tokens_count        VLQ (put_u32 → put_u64)
token_ids[]         32 raw bytes per id, first-seen order
outputs_count       VLQ (put_usize_as_u16_unwrapped)
output_candidates[] each ErgoBoxCandidate::serialize_body_with_indexed_digests
```

Key wire-format facts:
- **VLQ not fixed-width.** `put_u16` / `put_u32` in sigma-rust route through `put_u64` (`vlq_encode.rs:56,78`). Every count field is VLQ; the "u16" / "u32" names describe the narrowing cast applied to the decoded value, not a fixed byte width.
- **Distinct token-id table.** Built as `IndexSet` (insertion-order de-duplicated) across all output candidates' tokens in output order. Each output candidate's per-token entry writes a VLQ index into this table rather than the raw 32-byte id. The envelope owns table construction (serialize) and resolution (parse). An out-of-range index throws `TxParseError('token-table-index-out-of-range')`.
- **Input wire layout.** `boxId (32 bytes) + VLQ(proofLen) + proofBytes + contextExtension (VLQ count + per-entry varId u8 + SType + SValue)`.
- **Data-input wire layout.** `boxId (32 bytes)` only.
- **Box-candidate wire layout.** `value (VLQ u64) + ergoTree (self-delimiting) + creation_height (VLQ u32) + tokens_count (raw u8) + per-token (VLQ index + VLQ u64 amount) + additional_regs (raw u8 count + per-register SType + SValue)`. The token section uses a RAW `u8` for the per-candidate token count (not VLQ), while the envelope token-table count is VLQ.
- **Signing message.** Identical to the full serialization except each input's `proofBytes` is replaced by `VLQ(0)` (length 0, then 0 proof bytes). The explicit zero-length VLQ is load-bearing for the `blake2b256` txId hash — omitting it would shift all subsequent bytes and produce an incorrect id.
- **Tree version.** The entire envelope is wrapped in `with_tree_version(ErgoTreeVersion::V0)` — registers and context-extension constants are serialized in V0 wire form. This is passed as `treeVersion = 0` to `parseSValue` / `serializeSValue`.

## Data model types

```ts
export interface ErgoLikeTransaction {
  inputs: Input[];
  dataInputs: DataInput[];
  outputCandidates: ErgoBoxCandidate[];
}

export interface Input {
  boxId: Uint8Array;          // 32 bytes — the id of the UTXO being spent
  spendingProof: SpendingProof;
}

export interface SpendingProof {
  proofBytes: Uint8Array;     // serialized sigma proof; empty (length 0) for
                              // storage-rent / TrivialProp spends
  contextExtension: ContextExtension;
}

// ContextExtension is re-exported from @ergots/ergoscript.
// type ContextExtension = { values: Record<number, { tpe: SType; value: SValue }> }

export interface DataInput {
  boxId: Uint8Array;          // 32 bytes
}

export interface ErgoBoxCandidate {
  value: bigint;              // nanoErg; u64 on wire
  ergoTreeBytes: Uint8Array;  // raw verbatim wire span (header + optional size + body)
  creationHeight: number;     // u32 on wire; ≤ 2^31-1 (enforcement deferred to phase 2)
  tokens: { id: Uint8Array; amount: bigint }[];  // id 32 bytes; amount u64
  registers: Record<number, { tpe: SType; value: SValue; opaqueBytes?: Uint8Array }>;
}
```

### Type invariants

- `Input.boxId` is exactly 32 bytes.
- `DataInput.boxId` is exactly 32 bytes.
- `SpendingProof.proofBytes` is a `Uint8Array` of length ≥ 0. Empty (`length === 0`) for storage-rent and `TrivialProp` spends.
- `SpendingProof.contextExtension.values` is a `Record<number, { tpe: SType; value: SValue }>` keyed by `varId` (u8, 0..=255). Parse order from the wire is NOT preserved; serialization is sorted ascending by `varId` (matching the canonical on-chain encoding).
- `ErgoBoxCandidate.ergoTreeBytes` is a verbatim wire span: the ergoTree grammar is self-delimiting, consumed via `parseErgoTreeBytes(r)` from `@ergots/ergoscript`. A `hasSize=true` body whose struct parse fails is captured verbatim as an "unparsed" span (sigma-rust `ErgoTree::Unparsed` equivalent — "burn" boxes).
- `ErgoBoxCandidate.tokens[i].id` is 32 bytes (resolved from the transaction-wide token table).
- `ErgoBoxCandidate.registers` keys are `number` in `[4, 9]` (R4..R9). Each value carries the pair `{ tpe: SType; value: SValue }`. For the rare `Tuple`-Expr form (lead byte `0x86 = 134`), `opaqueBytes` carries the verbatim wire bytes for byte-roundtrip identity, mirroring the SBox path in `@ergots/ergoscript`.

## Error taxonomy

```ts
export class TxParseError extends Error {
  readonly code: TxParseErrorCode;
}
export type TxParseErrorCode =
  | 'trailing-bytes'
  | 'token-table-index-out-of-range'
  | 'count-out-of-range';
```

All three codes are emitted by this package directly.

| Code | When thrown | Layer |
|---|---|---|
| `'trailing-bytes'` | Bytes remain after a structurally complete transaction was parsed (`!r.isExhausted` after all sections). Stricter than sigma-rust's `sigma_parse_bytes` — matches the JVM and ergots' `parseTree` zero-trailing precedent. Parse only. | `wire/transaction.ts:parseTransaction` |
| `'token-table-index-out-of-range'` | An output candidate's per-token VLQ index is ≥ the number of ids in the transaction-wide token table. | `wire/box-candidate.ts:parseBoxCandidate` |
| `'count-out-of-range'` | Any io count (inputs, dataInputs, outputCandidates) or the distinct-token count violates the declared bounds (see "Count bounds"). Thrown on parse and serialize. | `wire/transaction.ts`, `wire/_envelope.ts` |

**Other errors that may propagate:**

- `ReaderError` (from `@ergots/scorex`) — `'truncated'` / `'vlq-overflow'` / `'position-limit-exceeded'` from the `ByteReader` if wire bytes are malformed or cut short.
- `ErgoTreeParseError` / `ExprParseError` / `SValueParseError` etc. from `@ergots/ergoscript` — if a box candidate's ergoTree or register bytes are malformed. These bubble up unwrapped; `parseTransaction` does not catch and re-wrap them.

## Round-trip invariant

For any byte sequence `b` accepted by `parseTransaction`:

```
serializeTransaction(parseTransaction(b)) === b   (byte-equal)
```

This holds for the full test-fixture corpus (real testnet and mainnet transactions, covering simple transfers, token minting, token burning, multi-input, multi-output, and context-extension inputs).

## Cross-cutting guarantees

- **Determinism.** All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output.
- **Synchronous.** No async surface.
- **Browser-compat.** No `Buffer`, no `node:crypto`, no `process` / `fs` / `path` / `os` / `node:*` imports in `packages/transaction/src/`. ESM only. No WASM direct or transitive.
- **No top-level await** in published code.
- **No throws on the happy path.** `parseTransaction` and `serializeTransaction` return values or throw typed errors; they never return `null` / `undefined` on success.

## Source mapping

| sigma-rust function (file) | TS function(s) (file) |
|---|---|
| `Transaction::sigma_parse` (`transaction.rs:~287-330`) | `parseTransaction` (`wire/transaction.ts`) |
| `Transaction::sigma_serialize` (`transaction.rs:~248-285`) | `serializeTransaction` → `writeEnvelope(…, true)` (`wire/transaction.ts`, `wire/_envelope.ts`) |
| `Transaction::bytes_to_sign` (`transaction.rs:184-190`) | `signingMessage` → `writeEnvelope(…, false)` (`wire/signing-message.ts`, `wire/_envelope.ts`) |
| `Transaction::calc_tx_id` (`transaction.rs:178-181`) | `transactionId` (`wire/signing-message.ts`) — `blake2b256(signingMessage(tx))` |
| `Transaction::distinct_token_ids` (`transaction.rs:~227-237`) | `writeEnvelope` token-table build (inline in `wire/_envelope.ts`) — `IndexSet` first-seen insertion across output candidates |
| `Input::sigma_parse` / `sigma_serialize` (`input.rs`) | `parseInput` / `serializeInput` (`wire/input.ts`) |
| `Input::input_to_sign` (`input.rs:112-120`) | signing-message per-input path in `writeEnvelope` (`wire/_envelope.ts:84-93`) — boxId + VLQ(0) + extension |
| `ContextExtension::sigma_parse` / `sigma_serialize` (`context_extension.rs`) | `parseContextExtension` / `serializeContextExtension` (`wire/input.ts`) |
| `DataInput::sigma_parse` / `sigma_serialize` (`data_input.rs`) | `parseDataInput` / `serializeDataInput` (`wire/data-input.ts`) |
| `ErgoBoxCandidate::parse_body_with_indexed_digests` / `serialize_body_with_indexed_digests` (`ergo_box.rs:415-470 / 357-411`) | `parseBoxCandidate` / `serializeBoxCandidate` (`wire/box-candidate.ts`) |

## Cross-references

- `docs/specs/2026-06-15-ergots-transaction-validation-design.md` — umbrella design spec; phases 2–4 scope
- `facts/scorex.md` — `ByteReader` / `ByteWriter` / `blake2b256`; shared codec layer
- `facts/ergoscript-wire.md` — `parseErgoTreeBytes` / `parseAdditionalRegisters`; box-body sub-structure grammar shared with `SBox` data parser
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list

---

# Phase 2 additions — Transaction validation

Ships `validateStateless` + `validateStateful`. Building / signing (requires a prover) remains out of scope.

## Public surface (phase 2)

```ts
validateStateless(tx: ErgoLikeTransaction): void
validateStateful(tx: ErgoLikeTransaction, deps: StatefulDeps): void

class TxValidationError extends Error {
  readonly code: TxValidationErrorCode;
  readonly location?: TxValidationLocation;
}
type TxValidationErrorCode = /* see error taxonomy below */

interface TxValidationLocation {
  inputIndex?: number;
  outputIndex?: number;
  boxId?: Uint8Array;
}

// Dependency bundle for stateful validation
interface StatefulDeps {
  inputBoxes: ErgoBox[];      // ordered to match tx.inputs; library asserts each boxId
  dataInputBoxes: ErgoBox[];  // ordered to match tx.dataInputs
  stateContext: StateContext;
}
interface StateContext {
  headers: Header[];          // newest-first, length >= 1; library takes up to 10, pads to 10
  preHeader: PreHeader;       // the block being built (REQUIRED)
  parameters?: Partial<ChainParameters>;  // overrides DEFAULT_PARAMETERS fields
}
interface ChainParameters {   // sigma-rust parameters.rs:157-168 (CONFIRMED)
  maxBlockCost: number;       // 1_000_000
  storageFeeFactor: number;   // 1_250_000
  minValuePerByte: number;    // 360
  inputCost: number;          // 2_000
  dataInputCost: number;      // 100
  outputCost: number;         // 100
  tokenAccessCost: number;    // 100
}

const DEFAULT_PARAMETERS: ChainParameters;  // all values above
```

`ErgoBox`, `PreHeader`, `Header`, `SType`, `SValue`, `ContextExtension` are re-exported from `@ergots/ergoscript` / `@ergots/scorex` and surfaced via `@ergots/transaction`.

## `validateStateless(tx)`

**Precondition:** `tx` is an `ErgoLikeTransaction` (may be in-memory-constructed, not necessarily parse-round-tripped).

**Postcondition (success):** Returns `undefined`. The transaction passes the stateless rule set.

**Confirmed rule set** (mirrors sigma-rust `ErgoTransaction::validate_stateless`, `ergo_transaction.rs:99-116`):

1. **`inputs-empty`** — `tx.inputs.length === 0`.
2. **`outputs-empty`** — `tx.outputCandidates.length === 0`.
3. **`output-sum-overflow`** — cumulative output value sum exceeds `i64::MAX` (`2^63 − 1`). Checked during summation; `location.outputIndex` is the index where the sum first overflowed.
4. **`duplicate-input`** — two or more inputs share the same `boxId` (checked as hex string in insertion order). `location.inputIndex` is the second occurrence.

**NOT stateless** (counter-intuitive inclusions left out deliberately):
- `output value > 0` — the BoxValue newtype + dust rule are stateful (require `minValuePerByte` × boxSize).
- `creationHeight` range — stateful (`verify_output`).
- Transaction byte-size — sigma-rust has no such rule at the stateless layer.

**Throws:** `TxValidationError` with one of the codes above.

## `validateStateful(tx, deps)`

**Precondition:** `tx` is an `ErgoLikeTransaction`. `deps.inputBoxes` is ordered to match `tx.inputs` (same length, same order). `deps.dataInputBoxes` is ordered to match `tx.dataInputs`. `deps.stateContext.headers` contains at least one `Header` (newest-first). `deps.stateContext.preHeader` is the block being validated against.

**Postcondition (success):** Returns `undefined`. The transaction passes the full structural + per-input validation.

**Rule set in order** (mirrors sigma-rust `TransactionContext::validate`, `tx_context.rs:148-268`):

### 1 — Structural checks (`checkStructural`)

1. **`input-box-count-mismatch`** — `deps.inputBoxes.length ≠ tx.inputs.length`.
2. **`input-box-id-mismatch`** — computed box id (`blake2b256(serializeBox(box))`) does not match `tx.inputs[i].boxId`. `location.inputIndex` + `location.boxId` present.
3. **`data-input-box-mismatch`** — count or id mismatch for data-input boxes.
4. **`input-sum-overflow`** — cumulative input value sum exceeds `i64::MAX`.
5. **`value-not-conserved`** — `Σ input values ≠ Σ output values` (strict; Ergo has no fee field — fee is a convention in the output values).
6. Per-output well-formedness (`verify_output` in sigma-rust), checked in output-index order:
   - **`output-below-min-value`** — `output.value < boxSize × minValuePerByte`. `location.outputIndex` present.
   - **`creation-height-in-future`** — `(creationHeight | 0) > (blockHeight | 0)` (signed i32 compare, matching sigma-rust). `location.outputIndex` present.
   - **`creation-height-below-max-input`** (post-v3 blocks only) — `output.creationHeight < max(inputBox.creationHeight)`. `location.outputIndex` present.
   - **`creation-height-negative`** (post-v1 blocks only) — the i32 sign bit of `creationHeight` is set. `location.outputIndex` present.
   - **`box-size-exceeded`** — serialized box size > 4096 bytes. `location.outputIndex` present.
   - **`script-size-exceeded`** — `ergoTreeBytes.length > 4096`. `location.outputIndex` present.
7. Token conservation (sigma-rust `extract_assets` + `verify_assets`, `tx_context.rs:341-372`):
   - **`token-amount-invalid`** — any token's cumulative amount (input side or output side) overflows `i64::MAX`.
   - **`token-not-conserved`** — an output token amount exceeds the matching input token amount.
   - **`invalid-minted-token`** — an output token id absent from input tokens is not equal to `tx.inputs[0].boxId` (the canonical minting rule: exactly one new token may be minted per transaction, and its id must equal the first input's box id).

### 2 — Init cost (charged before any per-input loop)

`INTERPRETER_INIT_COST` (10,000 block units) + per-input/data-input/output cost + token-access cost (all block units) = the init cost (`computeInitCost`), which seeds the cumulative block-cost accumulator `runningBlock`. If the init cost alone exceeds `maxBlockCost`, throws `TxValidationError('cost-limit-exceeded')`.

### 3 — Per-input verify loop (in input-index order)

For each input `i`:

a. **Storage-rent fast path** (empty proof only): if `proofBytes.length === 0` and the box is rent-eligible (`blockHeight − creationHeight ≥ 1,051,200`), apply the storage-rent conditions (extension var 127 holds the output index; recreation checks if box value > fee). If rent conditions pass, skip this input at cost 0 (no eval, no verify).

b. **Script path**: `parseTree(ergoTreeBytes)` (parse errors surface unwrapped) → `buildInputContext(…, jitCostLimit: remaining headroom)` → `evaluateWith(tree, ctx)` → check result is `SigmaProp` (else `non-sigmaprop-result`) → `verifySignature(result.value, signingMessage(tx), proofBytes)` (else `script-reduced-false`). After eval, `floor(ctx.jitCost / 10) + floor(estimateCryptoCost(result.value) / 10)` (the reduction cost and the sigma-verification cost, each truncated to block cost) is added to `runningBlock`; if it then exceeds `maxBlockCost`, throws `TxValidationError('cost-limit-exceeded')`. A mid-reduction overrun surfaces `EvalError('cost-limit-exceeded')` unwrapped.

**`cost-limit-exceeded`** (as `TxValidationError`) — when the init cost alone exceeds `maxBlockCost`, OR when the per-input block accumulator (eval + crypto) exceeds `maxBlockCost` after an input. A mid-reduction overrun instead surfaces `EvalError('cost-limit-exceeded')` unwrapped (from inside `evaluateWith`). All forms mean the transaction is rejected.

## Box id computation

`computeBoxId(box: ErgoBox): Uint8Array` — internal only, not exported.

`blake2b256(serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, treeVersion, writer))`. The serialization includes the box's assigned `txId` (32 bytes) and `index` (varies by tree version); the box-id is thus a commitment to the full transaction context. Mirrors `ergo_box.rs:141,182-185`.

## Error taxonomy — `TxValidationError`

```ts
class TxValidationError extends Error {
  readonly code: TxValidationErrorCode;
  readonly location?: TxValidationLocation;  // always present when noted below
}
interface TxValidationLocation {
  inputIndex?: number;
  outputIndex?: number;
  boxId?: Uint8Array;     // the input's tx.inputs[i].boxId when present
}
type TxValidationErrorCode =
  // stateless
  | 'inputs-empty'
  | 'outputs-empty'
  | 'duplicate-input'          // location.inputIndex = second occurrence
  | 'output-sum-overflow'      // location.outputIndex = index where sum first overflowed
  // stateful structural
  | 'input-box-count-mismatch'
  | 'input-box-id-mismatch'    // location.inputIndex + location.boxId
  | 'data-input-box-mismatch'  // location.inputIndex when id mismatch
  | 'input-sum-overflow'
  | 'value-not-conserved'
  | 'output-below-min-value'   // location.outputIndex
  | 'creation-height-in-future'      // location.outputIndex
  | 'creation-height-below-max-input' // location.outputIndex (post-v3 only)
  | 'creation-height-negative'        // location.outputIndex (post-v1 only)
  | 'box-size-exceeded'        // location.outputIndex
  | 'script-size-exceeded'     // location.outputIndex
  | 'token-not-conserved'
  | 'invalid-minted-token'
  | 'token-amount-invalid'
  // per-input verify (TxValidationError only for init cost overrun; see Unwrapped errors)
  | 'non-sigmaprop-result'     // location.inputIndex + location.boxId
  | 'script-reduced-false'     // location.inputIndex + location.boxId
  | 'cost-limit-exceeded';     // TxValidationError only for init overrun (see below)
```

**Total: 21 codes** (3 `TxParseErrorCode` + 21 `TxValidationErrorCode` = 24 total in the package's error surface; `TxValidationErrorCode` is a distinct union).

## Unwrapped errors contract

The validator's own structural verdicts are `TxValidationError`. Errors from the layers below propagate **unwrapped** (not wrapped or re-typed):

- `EvalError` (from `@ergots/ergoscript`) — includes `EvalError('cost-limit-exceeded')` fired during per-input script evaluation when the running accumulator exceeds the JIT budget. This is NOT a `TxValidationError`; callers must catch both.
- `VerifyError` (from `@ergots/ergoscript`) — sigma-proof verification failure at the cryptographic layer (malformed proof structure, group element decoding failure, etc.). Distinct from `script-reduced-false` (which is the logical `false` verdict from a well-formed proof).
- `ReaderError` / `ErgoTreeParseError` / `ExprParseError` / `SValueParseError` (from `@ergots/scorex` and `@ergots/ergoscript`) — malformed wire bytes when `parseTree` is called on the input's `ergoTreeBytes`.

**Summary of what to catch:**

```ts
try {
  validateStateful(tx, deps);
} catch (e) {
  if (e instanceof TxValidationError) { /* our structural verdict */ }
  else if (e instanceof EvalError)    { /* ergoscript eval failure, incl. cost-limit-exceeded */ }
  else if (e instanceof VerifyError)  { /* sigma proof structure error */ }
  else                                { /* ReaderError / parse error from wire bytes */ }
}
```

## Cost model

**Init/structural cost** (block-cost units):

```
initCost = INTERPRETER_INIT_COST          // 10,000 block units
         + inputs.length × inputCost      // × 2,000
         + dataInputs.length × dataInputCost // × 100
         + outputs.length × outputCost    // × 100
         + (totalTokenEntries_in + totalTokenEntries_out
            + distinctTokenCount_in + distinctTokenCount_out) × tokenAccessCost  // × 100
```

`initCost` seeds the cumulative block-cost accumulator `runningBlock`. If `initCost > maxBlockCost`, throws `TxValidationError('cost-limit-exceeded')`.

**Per-input accumulation (block-cost, JVM-faithful).** A single cumulative `runningBlock` is shared across all inputs (never reset). For each non-storage-rent input, after `evaluateWith`:

```
runningBlock += floor(ctx.jitCost / 10) + floor(estimateCryptoCost(result.value) / 10)
if (runningBlock > maxBlockCost) throw TxValidationError('cost-limit-exceeded')
```

The eval (reduction) cost and the sigma-verification (crypto) cost are each truncated to block cost **independently** (JVM `Interpreter.scala:280-286`; `JitCost.toBlockCost = value / 10`). The mid-reduction JIT ceiling handed to `evaluateWith` is `(maxBlockCost − runningBlock) × 10`; a reduction exceeding it surfaces `EvalError('cost-limit-exceeded')` unwrapped. Storage-rent inputs add 0.

**Crypto cost (closed).** The sigma-verification cost is `estimateCryptoCost` (`@ergots/ergoscript`), ported from the JVM `Interpreter.estimateCryptoVerifyCost` (per-leaf ProveDlog 3980 / ProveDhTuple 7140; conjecture node 15; threshold polynomial). The earlier deferral (phase 2 under-counted by this term) is CLOSED. Verdict equivalence with the JVM is pinned by the SANTA `cost-limit-boundary` vector (`test/fixtures/conformance/`). Because the JVM truncates each input's cost to block independently, ergots only needs eval cost correct to within a block (10 JIT) — robust to sub-10-JIT eval differences.

## Provenance and validation

- Validate path lifted from the mainnet-proven harness `tools/mainnet-validate/validate-tx.ts` (oracle machinery removed; block-validation accounting mirrors sigma-rust `TransactionContext::validate()`).
- Gated by 2 real testnet fixtures (`multi-input-10`, `multi-input-3`) loaded from `test/fixtures/stateful/` — both are real multi-input transfers (testnet, heights 402900 and 402800) that exercise the full multi-input eval+verify loop. No storage-rent fixture: testnet is younger than the 1,051,200-block storage period. Also gated by the adversarial mutation suite (Task 8): per-field byte flips and structural mutations that must all be rejected.
- Re-walk against full mainnet history is a future capstone (outside phase-2 scope).

## Known residuals

### 1 — `script-size-exceeded` subsumed by `box-size-exceeded`

A box always contains its script (`ergoTreeBytes`), so a `>4096`-byte ergoTree trips `box-size-exceeded` (box serialization length > 4096) before `script-size-exceeded` (raw ergoTreeBytes length > 4096) is reached. The `script-size-exceeded` check is defensive / redundant in both ergots and sigma-rust, which apply the same check order. Consensus is correct; the named `script-size-exceeded` code will never be observed in practice unless future box structure changes make a large script fit inside a ≤4096-byte box.

### 2 — `creation-height-negative` pre-empted by ergoscript serializer

The SBox serializer (`@ergots/ergoscript`) rejects `creationHeight ≥ 2³¹` (JVM-faithfully — the field is `i32` on the wire) by throwing an unwrapped `SValueSerializeError` before the `creation-height-negative` named check is reached. The transaction is still rejected (consensus-correct). Exact error-class parity with the JVM for this input shape is a future SANTA / capstone item.

## Source mapping (phase 2)

| sigma-rust function | TS function (file) |
|---|---|
| `ErgoTransaction::validate_stateless` (`ergo_transaction.rs:99-116`) | `validateStateless` (`validate/stateless.ts`) |
| `TransactionContext::validate` (`tx_context.rs:148-268`) | `validateStateful` (`validate/stateful.ts`) |
| `TransactionContext::check_structural` (verify_output inline) | `checkStructural` (`validate/stateful.ts`) — internal |
| `check_storage_rent_conditions` (`storage_rent.rs`) | `checkStorageRent` (`validate/storage-rent.ts`) — internal |
| `ErgoBox::sigma_serialize` / box-id (`ergo_box.rs:141,182-185`) | `computeBoxId` / `serializeBox` (`validate/stateful.ts`) — internal |
| `TransactionContext::compute_tx_init_cost` (`tx_context.rs:126-145`) | `computeInitCost` (`validate/stateful.ts`) — internal |
| `Parameters::default()` (`parameters.rs:157-168`) | `DEFAULT_PARAMETERS` (`params.ts`) |
