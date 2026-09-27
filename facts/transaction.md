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
  | 'extension-id-out-of-range'
  | 'extension-v6-type'
```

### `parseTransaction(bytes)`

- **Precondition:** `bytes` is a `Uint8Array` containing exactly one complete `ErgoLikeTransaction` in sigma-serialized wire form. The function calls `ByteReader.isExhausted` after parsing and rejects any trailing bytes.
- **Postcondition (success):** Returns an `ErgoLikeTransaction` satisfying all type invariants below. `serializeTransaction(parseTransaction(b))` is byte-equal to `b` for every accepted input whose context extensions have no repeated variable id. A repeated id collapses to one entry on parse, as in the JVM (see "Context-extension bounds"), so such an extension re-serializes shorter.
- **Postcondition (failure — `TxParseError`):** Thrown for:
  - `'trailing-bytes'` — bytes remain after a structurally complete transaction was parsed. This is STRICTER than sigma-rust's `sigma_parse_bytes` (which tolerates trailing bytes) and matches the JVM modifier-parse path and ergots' own `parseTree` zero-trailing precedent.
  - `'count-out-of-range'` — an io count violates the `TxIoVec` / `get_u32` bounds, or an input's context-extension entry-count byte is ≥ `0x80` (see "Count bounds" below).
  - `'extension-id-out-of-range'` — an input's context-extension variable-id byte is ≥ `0x80`. Rejected before the entry's value is read (see "Context-extension bounds" below).
  - `'extension-v6-type'` — an input's context-extension value has a declared type containing `SOption`, `SHeader` or `SUnsignedBigInt` (rule-1019 `CheckV6Type`; see "Context-extension bounds" below).
  - `'token-table-index-out-of-range'` — an output candidate references a token-table index that does not exist in the transaction's distinct-token-id table.
- **Postcondition (failure — other):** `ReaderError` (from `@ergots/scorex`) for truncated / malformed VLQ or fixed-width fields, and `'max-tree-depth-exceeded'` for a context-extension value nested deeper than the JVM reader allows; inner `ErgoTreeParseError` / `ExprParseError` / `SValueParseError` from `@ergots/ergoscript` if a candidate's ergoTree or register bytes are malformed.

### `serializeTransaction(tx)`

- **Precondition:** `tx` satisfies the `ErgoLikeTransaction` type invariants below and the io-count bounds (see "Count bounds").
- **Postcondition (success):** Returns `Uint8Array` byte-equal to what a JVM sigma-state serializer would produce for the same transaction. The serialize path ALSO enforces all count bounds — it is safe to call `serializeTransaction` on a programmatically-constructed `tx` and rely on it to reject out-of-range counts.
- **Postcondition (failure — `TxParseError 'count-out-of-range'`):** inputs or outputCandidates is empty or > 32767; dataInputs is > 32767; the computed distinct-token table exceeds 65535 × 255 entries; an input's context extension holds more than 127 entries.

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
| context-extension entries (per input) | `[0, 127]` | JVM `ContextExtension.scala:53-55` (parse) / `:46-47` (serialize), sigma-state v6.0.6 |

All violations throw `TxParseError('count-out-of-range')`.

## Context-extension bounds

JVM reference: sigma-state v6.0.6 `data/shared/src/main/scala/sigma/interpreter/ContextExtension.scala`, `serializer.parse` (`:52-66`) and `serializer.serialize` (`:44-50`). `parseContextExtension` / `serializeContextExtension` (`wire/input.ts`) port them for Constant-form values. The residuals at the end of this section are the known differences.

- **Entry count** — one byte, read as a signed byte. A count byte ≥ `0x80` is negative in the JVM and is rejected before any entry is read: `TxParseError('count-out-of-range')` (`:53-55`; since sigma-state v4.0, before which a negative count read as zero entries). It is not a VLQ: `0x80 0x00` is a rejected count, not an over-long zero. On serialize, more than 127 entries throws the same error (`:46-47`). A count of at most 127 is written as one byte.
- **Variable id** — one byte, read as a signed byte. An id byte ≥ `0x80` is rejected before its value is read: `TxParseError('extension-id-out-of-range')` (`:58-60`; new in sigma-state 6.0.5, commit `e4ef1b203`, not version-gated). A parsed extension therefore only has ids in `[0, 127]`, including a storage-rent spend's var 127. The serializer writes the id byte without a bound check, as the JVM serializer does (`:49`). A programmatically built extension with an id of 128–255 serializes to bytes `parseTransaction` rejects.
- **Value** — read as the JVM's `r.getValue()` reads it (`:61`). The value node takes one reader depth level (`ValueSerializer.scala:396-398`) on top of its data's own levels, so a value nested past the reader's cap of 110 throws `ReaderError('max-tree-depth-exceeded')`, exactly as a box register does. The value's declared type must then pass rule-1019 `CheckV6Type` (`:62`, `ValidationRules.scala:165-205`): a type containing `SOption`, `SHeader` or `SUnsignedBigInt`, recursing through tuple items and collection element types, throws `TxParseError('extension-v6-type')`, whether or not the value holds data of that type (an empty `Coll[Option[Int]]` rejects). The predicate is `@ergots/ergoscript`'s `violatesCheckV6Type`, the one the box-register leg applies. The rule is not version-gated.
- **Repeated ids** — the JVM collects the entries with `toMap` (`:65`), so a repeated id keeps its first position and its last value, and the entry count shrinks. ergots' insertion-ordered `Map` does the same, so for up to 4 distinct ids the re-serialized extension, and with it the signing message, matches the JVM's.
- **Residual — entry order for 5 or more distinct ids.** Scala 2.12's `toMap` gives an insertion-ordered map for up to 4 entries and a hash map from 5, and the JVM re-serializes the extension from that map when it computes the signing message and the transaction id. ergots keeps the received order, as sigma-rust does, so an extension listing 5 or more distinct ids in any order other than the JVM's hash order gets a different signing message and transaction id. This is the parked extension-ordering question (upstream sigma-rust #843 / #921); it is not changed here. SANTA's `ext-count-127-accept` vector lists its ids in the JVM's own order, which is why it round-trips.
- **Residual — opcode-form values.** `r.getValue()` also accepts evaluated values written as opcodes: `TrueLeaf` / `FalseLeaf` (`0x7F` / `0x80`), `GroupGenerator` (`0x82`), `ConcreteCollection` (`0x83`, or `0x85` for booleans) and `Tuple` (`0x86`). ergots rejects them, because `parseSType` sees an invalid type code. Accepting them faithfully needs a representation that re-serializes the way the JVM does (it normalizes some of these forms into the signing message), so it needs its own spec. The JVM's acceptance is established from source only; no JVM-blessed vector pins it yet.

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
- **VLQ not fixed-width.** `put_u16` / `put_u32` in sigma-rust route through `put_u64` (`vlq_encode.rs:56,78`). Every envelope count field is VLQ; the "u16" / "u32" names describe the narrowing cast applied to the decoded value, not a fixed byte width. The context-extension entry count and the box-candidate token and register counts are single bytes, not VLQ.
- **Distinct token-id table.** Built as `IndexSet` (insertion-order de-duplicated) across all output candidates' tokens in output order. Each output candidate's per-token entry writes a VLQ index into this table rather than the raw 32-byte id. The envelope owns table construction (serialize) and resolution (parse). An out-of-range index throws `TxParseError('token-table-index-out-of-range')`.
- **Input wire layout.** `boxId (32 bytes) + VLQ(proofLen) + proofBytes + contextExtension (count: 1 byte < 0x80, then per entry: varId 1 byte < 0x80 + SType + SValue)`. See "Context-extension bounds".
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
// type ContextExtension = { values: Map<number, { tpe: SType; value: SValue }> }

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
- `SpendingProof.contextExtension.values` is an insertion-ordered `Map<number, { tpe: SType; value: SValue }>` keyed by `varId`. A parsed extension's ids are in `[0, 127]` (see "Context-extension bounds"). The received wire order is preserved, and serialization iterates insertion order with no re-sort: the order is part of the signing message (`docs/specs/2026-06-16-context-extension-order-preservation.md`). For 5 or more distinct ids the JVM re-orders instead; see the ordering residual under "Context-extension bounds".
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
  | 'count-out-of-range'
  | 'extension-id-out-of-range'
  | 'extension-v6-type';
```

All five codes are emitted by this package directly.

| Code | When thrown | Layer |
|---|---|---|
| `'trailing-bytes'` | Bytes remain after a structurally complete transaction was parsed (`!r.isExhausted` after all sections). Stricter than sigma-rust's `sigma_parse_bytes` — matches the JVM and ergots' `parseTree` zero-trailing precedent. Parse only. | `wire/transaction.ts:parseTransaction` |
| `'token-table-index-out-of-range'` | An output candidate's per-token VLQ index is ≥ the number of ids in the transaction-wide token table. | `wire/box-candidate.ts:parseBoxCandidate` |
| `'count-out-of-range'` | Any io count (inputs, dataInputs, outputCandidates), the distinct-token count, or a context-extension entry count violates the declared bounds (see "Count bounds"). Thrown on parse and serialize. | `wire/transaction.ts`, `wire/_envelope.ts`, `wire/input.ts` |
| `'extension-id-out-of-range'` | A context-extension variable-id byte is ≥ `0x80` (a negative JVM `Byte`). Thrown before the entry's value is read. Parse only. | `wire/input.ts:parseContextExtension` |
| `'extension-v6-type'` | A context-extension value's declared type contains `SOption`, `SHeader` or `SUnsignedBigInt` (rule-1019 `CheckV6Type`, `ContextExtension.scala:62`). Parse only. | `wire/input.ts:parseContextExtension` |

**Other errors that may propagate:**

- `ReaderError` (from `@ergots/scorex`) — `'truncated'` / `'vlq-overflow'` / `'position-limit-exceeded'` from the `ByteReader` if wire bytes are malformed or cut short; `'max-tree-depth-exceeded'` for a context-extension value (or register) nested past the reader's depth cap.
- `ErgoTreeParseError` / `ExprParseError` / `SValueParseError` etc. from `@ergots/ergoscript` — if a box candidate's ergoTree or register bytes are malformed. These bubble up unwrapped; `parseTransaction` does not catch and re-wrap them.

## Round-trip invariant

For any byte sequence `b` accepted by `parseTransaction` whose context extensions repeat no variable id:

```
serializeTransaction(parseTransaction(b)) === b   (byte-equal)
```

A repeated id collapses on parse, as in the JVM, so that extension re-serializes without the repeat (see "Context-extension bounds"). The invariant holds for the full test-fixture corpus (real testnet and mainnet transactions, covering simple transfers, token minting, token burning, multi-input, multi-output, and context-extension inputs).

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
| `ContextExtension::sigma_parse` / `sigma_serialize` (`context_extension.rs`); count and id bounds, value depth and rule-1019 `CheckV6Type` from JVM `ContextExtension.serializer` (sigma-state v6.0.6 `ContextExtension.scala:44-66`) | `parseContextExtension` / `serializeContextExtension` (`wire/input.ts`) |
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

a. **Storage-rent branch.** A port of the rent branch of the JVM's `ErgoInterpreter.verify` and of `checkExpiredBox` (ergo v6.0.6, `ergo-wallet/src/main/scala/org/ergoplatform/wallet/interpreter/ErgoInterpreter.scala:66-87` and `:42-55`; constants from `wallet/protocol/Constants.scala:19-23`), in `storageRentVerdict` (`validate/storage-rent.ts`).
   - **Gate** (`:73`, `:77`). The branch applies when all three hold: the box's age `preHeader.height − box.creationHeight` is at least `StoragePeriod = 1,051,200`, computed in signed 32-bit `Int` arithmetic; the spending proof is empty; the extension holds var 127 (`StorageIndexVarId`). Otherwise the input takes the script path (b).
   - **Fallbacks** (`:78-84`, `Try { .. }.recoverWith { super.verify }`). If var 127 is not an `SShort`, or its value does not index an output (negative, or ≥ the output count), the input takes the script path (b).
   - **Verdict — final.** Otherwise `checkExpiredBox` decides, and the script is never parsed or evaluated:
     - `storageFee = storageFeeFactor × boxBytes.length` is `Int × Int` and wraps at 32 bits (`:43`). At factor 1,250,000 it is negative for 1718–3435-byte boxes and a small positive number for 3436–4096-byte boxes (32,704 at 3436). `boxBytes` is the box's full serialization, with txId and index (`ErgoBox.bytes`): the bytes whose blake2b256 matched `tx.inputs[i].boxId` in step 1.
     - If `box.value − storageFee ≤ 0` (`Long` arithmetic, `:45`), the verdict is true whatever the output.
     - Otherwise it is true iff the output at the index has `creationHeight == preHeader.height` (`:46`) and `value ≥ box.value − storageFee` (`:47`), and every register except R0 and R3 equals the box's (`:50-52`). Equality is the JVM's `ErgoBox.get` node equality (sigma-state v6.0.6 `ErgoBoxCandidate.scala:69-83`):
       - R1 compares the retained ergoTree bytes, so a different encoding of the same tree (e.g. an overlong VLQ) is unequal.
       - R2 compares the tokens pairwise, in order.
       - R4–R9: two absent registers are equal. A Tuple expression never equals a Constant (`ConstantNode.equals`, `values.scala:356-357`). Two Constants are equal when their types are equal and `sValueStructuralEq` (`@ergots/ergoscript`, the JVM's data equality) holds; this compares a Box by its id over the box's retained bytes (`CBox.equals`), not by a re-serialization. Two Tuple expressions compare by their bytes (see Known residual 3).
     - A false verdict throws `TxValidationError('script-reduced-false')`. The JVM fails the same rule as for a script that reduces to false (`txScriptValidation`); its reason reads `#i => Success((false,50))`.
     - A true verdict costs `StorageContractCost = 50` block units (`:81`). `ErgoTransaction.verifyInput` adds it to the running cost like any script cost, and the cost-limit check below applies.

b. **Script path**: `parseTree(ergoTreeBytes)` (parse errors surface unwrapped) → `buildInputContext(…, jitCostLimit: remaining headroom)` → `evaluateWith(tree, ctx)` → check result is `SigmaProp` (else `non-sigmaprop-result`) → `verifySignature(result.value, signingMessage(tx), proofBytes)` (else `script-reduced-false`). After eval, `floor(ctx.jitCost / 10) + floor(estimateCryptoCost(result.value) / 10)` (the reduction cost and the sigma-verification cost, each truncated to block cost) is added to `runningBlock`; if it then exceeds `maxBlockCost`, throws `TxValidationError('cost-limit-exceeded')`. A mid-reduction overrun surfaces `EvalError('cost-limit-exceeded')` unwrapped.

**`cost-limit-exceeded`** (as `TxValidationError`) — when the init cost alone exceeds `maxBlockCost`, OR when the per-input block accumulator (eval + crypto, or 50 for a storage-rent input) exceeds `maxBlockCost` after an input. A mid-reduction overrun instead surfaces `EvalError('cost-limit-exceeded')` unwrapped (from inside `evaluateWith`). All forms mean the transaction is rejected.

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
  | 'script-reduced-false'     // location.inputIndex + location.boxId; also a false storage-rent verdict
  | 'cost-limit-exceeded';     // TxValidationError only for init overrun (see below)
```

**Total: 21 codes** (4 `TxParseErrorCode` + 21 `TxValidationErrorCode` = 25 total in the package's error surface; `TxValidationErrorCode` is a distinct union).

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

The eval (reduction) cost and the sigma-verification (crypto) cost are each truncated to block cost **independently** (JVM `Interpreter.scala:280-286`; `JitCost.toBlockCost = value / 10`). The mid-reduction JIT ceiling handed to `evaluateWith` is `(maxBlockCost − runningBlock) × 10`; a reduction exceeding it surfaces `EvalError('cost-limit-exceeded')` unwrapped. A storage-rent input whose verdict is true adds `StorageContractCost = 50` instead (JVM `ErgoInterpreter.scala:81`), followed by the same `runningBlock > maxBlockCost` check.

**Crypto cost (closed).** The sigma-verification cost is `estimateCryptoCost` (`@ergots/ergoscript`), ported from the JVM `Interpreter.estimateCryptoVerifyCost` (per-leaf ProveDlog 3980 / ProveDhTuple 7140; conjecture node 15; threshold polynomial). The earlier deferral (phase 2 under-counted by this term) is CLOSED. Verdict equivalence with the JVM is pinned by the SANTA `cost-limit-boundary` vector (`test/fixtures/conformance/`). Because the JVM truncates each input's cost to block independently, ergots only needs eval cost correct to within a block (10 JIT) — robust to sub-10-JIT eval differences.

## Provenance and validation

- Validate path lifted from the mainnet-proven harness `tools/mainnet-validate/validate-tx.ts` (oracle machinery removed; block-validation accounting mirrors sigma-rust `TransactionContext::validate()`).
- Gated by 2 real testnet fixtures (`multi-input-10`, `multi-input-3`) loaded from `test/fixtures/stateful/` — both are real multi-input transfers (testnet, heights 402900 and 402800) that exercise the full multi-input eval+verify loop. Storage rent is gated by SANTA's JVM-blessed `storage-rent-*` vectors (`test/fixtures/conformance/`; ergo-core 6.0.6 `validateStateful`, synthetic context at height 1,051,200, since testnet is younger than the storage period). They cover the gate's age boundary and its non-empty-proof arm, both fallbacks, the final verdict (creation height, value, R1 including a non-canonical tree encoding, R2, R4 including a Tuple expression against a Constant), dust, and the `Int × Int` fee wrap. ergots pins each accept's blessed cost with its own `maxBlockCost` boundary pairs over those vectors. Unit tests cover what the vectors do not: the gate's missing-var-127 arm and, within register equality, a Box compared by its retained bytes, R5–R9, and token content. Also gated by the adversarial mutation suite (Task 8): per-field byte flips and structural mutations that must all be rejected.
- Re-walk against full mainnet history is a future capstone (outside phase-2 scope).

## Known residuals

### 1 — `script-size-exceeded` subsumed by `box-size-exceeded`

A box always contains its script (`ergoTreeBytes`), so a `>4096`-byte ergoTree trips `box-size-exceeded` (box serialization length > 4096) before `script-size-exceeded` (raw ergoTreeBytes length > 4096) is reached. The `script-size-exceeded` check is defensive / redundant in both ergots and sigma-rust, which apply the same check order. Consensus is correct; the named `script-size-exceeded` code will never be observed in practice unless future box structure changes make a large script fit inside a ≤4096-byte box.

### 2 — `creation-height-negative` pre-empted by ergoscript serializer

The SBox serializer (`@ergots/ergoscript`) rejects `creationHeight ≥ 2³¹` (JVM-faithfully — the field is `i32` on the wire) by throwing an unwrapped `SValueSerializeError` before the `creation-height-negative` named check is reached. The transaction is still rejected (consensus-correct). Exact error-class parity with the JVM for this input shape is a future SANTA / capstone item.

### 3 — Storage-rent register equality: Tuple expressions and AvlTree flags

Two cases where the rent check's register comparison finds registers unequal that the JVM finds equal. The verdict is then false where the JVM's is true: a valid spend is rejected. Both are adversarial-only and established from source, not from a JVM-blessed vector.

- **Tuple expressions compare by bytes.** The JVM compares a Tuple expression item by item as nodes, so two different encodings of equal items are equal. An example is an identity `GroupElement` written with a non-zero tail after its `0x00` lead. ergots keeps a Tuple-expression register as its wire bytes (`opaqueBytes`) and compares those. Equal bytes imply JVM-equal, so this can only reject.
- **AvlTree flags are compared unmasked.** The JVM builds `AvlTreeFlags` from the low 3 bits of the flags byte (`AvlTreeData.scala:21-25`). ergots' AvlTree value keeps the raw byte, so flags `0x01` and `0x09` compare unequal. This lives in `@ergots/ergoscript`'s value model and affects its script `==` and re-serialized box bytes as well, so it is not fixed here.

## Source mapping (phase 2)

| sigma-rust function | TS function (file) |
|---|---|
| `ErgoTransaction::validate_stateless` (`ergo_transaction.rs:99-116`) | `validateStateless` (`validate/stateless.ts`) |
| `TransactionContext::validate` (`tx_context.rs:148-268`) | `validateStateful` (`validate/stateful.ts`) |
| `TransactionContext::check_structural` (verify_output inline) | `checkStructural` (`validate/stateful.ts`) — internal |
| JVM `ErgoInterpreter.verify` rent branch + `checkExpiredBox` (ergo v6.0.6 `ErgoInterpreter.scala:66-87`, `:42-55`) | `storageRentVerdict` + `checkExpiredBox` (`validate/storage-rent.ts`) — internal |
| `ErgoBox::sigma_serialize` / box-id (`ergo_box.rs:141,182-185`) | `computeBoxId` / `serializeBox` (`validate/stateful.ts`) — internal |
| `TransactionContext::compute_tx_init_cost` (`tx_context.rs:126-145`) | `computeInitCost` (`validate/stateful.ts`) — internal |
| `Parameters::default()` (`parameters.rs:157-168`) | `DEFAULT_PARAMETERS` (`params.ts`) |
