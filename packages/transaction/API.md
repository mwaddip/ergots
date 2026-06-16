# API — `@ergots/transaction`

Pure-TypeScript Ergo transaction wire codec and validator. Phase 1: parse, serialize, signing message, transaction id. Phase 2: stateless + stateful transaction validation. See `facts/transaction.md` in the repo root for the load-bearing interface contract.

All exports are ESM. The package targets Node ≥ 20 and evergreen browsers; no `Buffer`, `node:crypto`, WASM, or other Node built-ins.

---

## Primary export

```ts
import {
  // Phase 1 — wire codec
  parseTransaction,
  serializeTransaction,
  signingMessage,
  transactionId,
  TxParseError,
  type TxParseErrorCode,
  type ErgoLikeTransaction,
  type Input,
  type SpendingProof,
  type DataInput,
  type ErgoBoxCandidate,
  // Phase 2 — validation
  validateStateless,
  validateStateful,
  TxValidationError,
  type TxValidationErrorCode,
  type TxValidationLocation,
  type StatefulDeps,
  type StateContext,
  type ChainParameters,
  DEFAULT_PARAMETERS,
} from '@ergots/transaction';
```

---

## Entry points

| Export | Kind | Description |
|---|---|---|
| `parseTransaction` | function | Parse wire bytes → `ErgoLikeTransaction`; rejects trailing bytes |
| `serializeTransaction` | function | `ErgoLikeTransaction` → wire bytes |
| `signingMessage` | function | Full envelope with proofs zeroed; pre-image of transaction id |
| `transactionId` | function | `blake2b256(signingMessage(tx))`; 32-byte id |
| `validateStateless` | function | Stateless checks (non-empty, no dup inputs, output sum no overflow) |
| `validateStateful` | function | Full structural + per-input verify; requires `StatefulDeps` |
| `TxParseError` | class | Typed parse / serialize error; `.code: TxParseErrorCode` |
| `TxParseErrorCode` | type | `'trailing-bytes' \| 'token-table-index-out-of-range' \| 'count-out-of-range'` |
| `TxValidationError` | class | Typed validation error; `.code: TxValidationErrorCode`; `.location?: TxValidationLocation` |
| `TxValidationErrorCode` | type | 21-variant union (see Error handling section) |
| `TxValidationLocation` | type | `{ inputIndex?, outputIndex?, boxId? }` |
| `StatefulDeps` | interface | Input boxes + data-input boxes + state context |
| `StateContext` | interface | Headers (newest-first, ≥1) + preHeader + optional parameter overrides |
| `ChainParameters` | interface | Cost/size constants (all fields have defaults in `DEFAULT_PARAMETERS`) |
| `DEFAULT_PARAMETERS` | const | `ChainParameters` mirroring sigma-rust `Parameters::default()` |
| `ErgoLikeTransaction` | interface | Root transaction type |
| `Input` | interface | Spending input (boxId + proof) |
| `SpendingProof` | interface | Sigma proof bytes + context extension |
| `DataInput` | interface | Read-only input (boxId only) |
| `ErgoBoxCandidate` | interface | Output box before assignment of txId/index |

---

## Functions

### `parseTransaction(bytes)`

```ts
function parseTransaction(bytes: Uint8Array): ErgoLikeTransaction
```

Parse a complete `ErgoLikeTransaction` from sigma-serialized wire bytes.

The bytes must contain exactly one transaction — trailing bytes throw `TxParseError('trailing-bytes')`. This is intentionally stricter than sigma-rust's `sigma_parse_bytes` (which tolerates trailing bytes), matching the JVM modifier-parse path and ergots' `parseTree` zero-trailing precedent.

**Returns:** `ErgoLikeTransaction` satisfying all type invariants. `serializeTransaction(parseTransaction(b))` is byte-equal to `b` for all accepted inputs.

**Throws:**
- `TxParseError('trailing-bytes')` — bytes remain after a complete transaction was parsed.
- `TxParseError('token-table-index-out-of-range')` — an output candidate references a token-table index beyond the transaction's distinct-token table.
- `TxParseError('count-out-of-range')` — an io count violates the `TxIoVec` / `get_u32` bounds (inputs `[1,32767]`, outputs `[1,32767]`, dataInputs `{0}∪[1,32767]`).
- `ReaderError` (from `@ergots/scorex`) for truncated / malformed VLQ bytes.
- Inner ergoscript parse errors if a candidate's ergoTree or register bytes are malformed.

---

### `serializeTransaction(tx)`

```ts
function serializeTransaction(tx: ErgoLikeTransaction): Uint8Array
```

Serialize an `ErgoLikeTransaction` to sigma wire bytes. Enforces all io-count bounds — it is safe to call on a programmatically-constructed transaction and rely on it to reject invalid counts.

**Returns:** `Uint8Array` byte-equal to the JVM sigma-state serializer's output for the same transaction.

**Throws:** `TxParseError('count-out-of-range')` when io counts or the distinct-token table exceed their bounds.

---

### `signingMessage(tx)`

```ts
function signingMessage(tx: ErgoLikeTransaction): Uint8Array
```

Produce the Fiat–Shamir signing message: the full transaction envelope with every input's proof replaced by an empty proof. The empty proof serializes as `VLQ(0)` (one zero byte for the length, then no proof bytes) — the field is NOT omitted; the explicit zero-length VLQ is load-bearing for the blake2b256 txId hash.

This is the exact value sigma-rust's `bytes_to_sign` produces.

**Throws:** Same shape as `serializeTransaction`.

---

### `transactionId(tx)`

```ts
function transactionId(tx: ErgoLikeTransaction): Uint8Array
```

Compute the transaction id: `blake2b256(signingMessage(tx))`, returning exactly 32 bytes. The node-reported transaction id is the lowercase base16 encoding of these bytes.

Confirmed byte-correct: `transactionId(parseTransaction(b))` equals the node-reported id for every fixture in the test corpus.

**Throws:** Same as `signingMessage`.

---

### `validateStateless(tx)`

```ts
function validateStateless(tx: ErgoLikeTransaction): void
```

Stateless (transaction-alone) checks. Mirrors sigma-rust `ErgoTransaction::validate_stateless` (`ergo_transaction.rs:99-116`).

**Rule set (in order):**
1. `inputs-empty` — no inputs.
2. `outputs-empty` — no outputs.
3. `output-sum-overflow` — cumulative output value sum > `i64::MAX` (2⁶³ − 1).
4. `duplicate-input` — two inputs share the same `boxId`.

**Returns:** `undefined` on success.

**Throws:** `TxValidationError` with one of the codes above. `location.outputIndex` / `location.inputIndex` present as noted.

---

### `validateStateful(tx, deps)`

```ts
function validateStateful(tx: ErgoLikeTransaction, deps: StatefulDeps): void
```

Full stateful validation: structural/accounting checks followed by the per-input verify loop. Mirrors sigma-rust `TransactionContext::validate()` (`tx_context.rs:148-268`).

**`deps` shape:**

```ts
interface StatefulDeps {
  inputBoxes: ErgoBox[];       // ordered to match tx.inputs (same length)
  dataInputBoxes: ErgoBox[];   // ordered to match tx.dataInputs (same length)
  stateContext: StateContext;
}
interface StateContext {
  headers: Header[];           // newest-first; at least 1; library pads to 10
  preHeader: PreHeader;        // the block being built
  parameters?: Partial<ChainParameters>;  // missing fields filled from DEFAULT_PARAMETERS
}
```

**Rule set (in order):**
1. Input/data-input box provisioning (count + computed box id).
2. Input value sum no-overflow.
3. Value conservation (`Σ inputs === Σ outputs`).
4. Per-output well-formedness: dust, future height, monotonic height (post-v3), negative height (post-v1), box/script size ≤ 4096.
5. Token conservation: amount overflow, not-conserved, invalid minted token.
6. Init/structural cost against block limit.
7. Per-input: storage-rent fast path (empty proof + rent-eligible) OR parse → evaluate → `SigmaProp` check → `verifySignature`.

**Errors surface unwrapped:** Only the validator's own structural verdicts are `TxValidationError`. `EvalError` (incl. `'cost-limit-exceeded'` fired during eval), `VerifyError`, and wire-parse errors propagate as-is. See the "Error handling" section.

**Returns:** `undefined` on success.

**Throws:** `TxValidationError` (structural); `EvalError` (script eval / cost overrun); `VerifyError` (crypto layer); `ReaderError` / ergoscript parse errors (malformed ergoTree bytes).

---

## Worked example: parse, derive id, re-serialize

```ts
import { parseTransaction, transactionId, serializeTransaction } from '@ergots/transaction';

// Raw transaction bytes from a node or fixture.
const txBytes: Uint8Array = /* … */;

// Parse.
const tx = parseTransaction(txBytes);

// Derive the transaction id (32 bytes; base16-encode to get the string form).
const idBytes = transactionId(tx);
const idHex = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
console.log('txId:', idHex);

// Inspect inputs and outputs.
console.log('inputs:', tx.inputs.length, 'outputs:', tx.outputCandidates.length);
for (const out of tx.outputCandidates) {
  console.log('  value:', out.value, 'nanoErg, tokens:', out.tokens.length);
}

// Re-serialize — byte-identical to txBytes.
const reBytes = serializeTransaction(tx);
console.log('round-trip ok:', reBytes.every((b, i) => b === txBytes[i]));
```

---

## Worked example: parse → validate → submit

```ts
import {
  parseTransaction,
  validateStateless,
  validateStateful,
  DEFAULT_PARAMETERS,
  TxValidationError,
  type StatefulDeps,
  type StateContext,
} from '@ergots/transaction';
import { EvalError, VerifyError, type ErgoBox, type PreHeader } from '@ergots/ergoscript';
import type { Header } from '@ergots/scorex';

// 1. Parse the raw bytes.
const txBytes: Uint8Array = /* … from node or wallet */;
const tx = parseTransaction(txBytes);

// 2. Stateless checks — requires nothing but the transaction itself.
validateStateless(tx);   // throws TxValidationError on failure

// 3. Build StatefulDeps — supply the UTXO set + chain context.
const inputBoxes: ErgoBox[] = /* … fetch from node by tx.inputs[i].boxId … */;
const dataInputBoxes: ErgoBox[] = /* … */;
const headers: Header[] = /* … node /blocks/lastHeaders?count=10, newest-first … */;
const preHeader: PreHeader = /* … from the block being validated … */;

const stateContext: StateContext = {
  headers,
  preHeader,
  parameters: DEFAULT_PARAMETERS,  // or omit to use defaults
};

const deps: StatefulDeps = { inputBoxes, dataInputBoxes, stateContext };

// 4. Full stateful validation.
try {
  validateStateful(tx, deps);
  console.log('transaction valid — safe to submit');
} catch (e) {
  if (e instanceof TxValidationError) {
    // Structural verdict from the validator.
    console.error('validation failed:', e.code, e.location);
  } else if (e instanceof EvalError) {
    // Script evaluation failure (incl. cost-limit-exceeded).
    console.error('eval error:', e.code);
  } else if (e instanceof VerifyError) {
    // Sigma proof structure error (distinct from script-reduced-false).
    console.error('sigma verify error:', e.code);
  } else {
    // ReaderError / parse error from malformed ergoTree bytes.
    throw e;
  }
}
```

---

## Types

### `ErgoLikeTransaction`

```ts
export interface ErgoLikeTransaction {
  inputs: Input[];
  dataInputs: DataInput[];
  outputCandidates: ErgoBoxCandidate[];
}
```

### `Input`

```ts
export interface Input {
  boxId: Uint8Array;          // 32 bytes — the UTXO being spent
  spendingProof: SpendingProof;
}
```

### `SpendingProof`

```ts
export interface SpendingProof {
  proofBytes: Uint8Array;       // serialized sigma proof; empty (length 0) for
                                // storage-rent / TrivialProp spends
  contextExtension: ContextExtension;
  // ContextExtension from @ergots/ergoscript:
  // { values: Map<number, { tpe: SType; value: SValue }> }
}
```

`contextExtension.values` is an **insertion-ordered `Map`**, and serialization
emits entries in that order with **no re-sort**. The order is
consensus-observable: the extension is re-serialized into `bytes_to_sign` (the
signing message), and the reference (sigma-rust `ContextExtension.values:
IndexMap`) preserves the received wire order. `parseTransaction` therefore
preserves the on-chain entry order so a non-ascending extension round-trips
byte-identically (see `docs/specs/2026-06-16-context-extension-order-preservation.md`).

### `DataInput`

```ts
export interface DataInput {
  boxId: Uint8Array;            // 32 bytes — read-only reference, no proof
}
```

### `ErgoBoxCandidate`

```ts
export interface ErgoBoxCandidate {
  value: bigint;                // nanoErg; u64 on wire
  ergoTreeBytes: Uint8Array;    // verbatim self-delimiting wire span
  creationHeight: number;       // u32 on wire
  tokens: { id: Uint8Array; amount: bigint }[];  // id 32 bytes; amount u64
  registers: Record<number, { tpe: SType; value: SValue; opaqueBytes?: Uint8Array }>;
}
```

`registers` keys are R4..R9 (`4`..`9`). `opaqueBytes` is present for the rare `Tuple`-Expr register form (lead byte `0x86 = 134`) and carries the verbatim wire bytes for byte-roundtrip identity. The `SType` and `SValue` types are from `@ergots/ergoscript`.

---

## Error handling

### `TxParseError`

Typed parse / serialize error (phase 1).

```ts
class TxParseError extends Error {
  readonly code: TxParseErrorCode;
}
type TxParseErrorCode =
  | 'trailing-bytes'
  | 'token-table-index-out-of-range'
  | 'count-out-of-range';
```

| Code | When |
|---|---|
| `'trailing-bytes'` | Bytes remain after a structurally complete transaction was parsed. Parse only. |
| `'token-table-index-out-of-range'` | An output candidate references a token-table index beyond the transaction's distinct-token table. Parse only. |
| `'count-out-of-range'` | inputs/outputCandidates outside `[1, 32767]`; dataInputs outside `{0}∪[1, 32767]`; distinct-token count > 65535×255. Parse and serialize. |

```ts
try {
  const tx = parseTransaction(bytes);
} catch (e) {
  if (e instanceof TxParseError) {
    switch (e.code) {
      case 'trailing-bytes':
        console.error('bytes had trailing data after the transaction');
        break;
      case 'token-table-index-out-of-range':
        console.error('output candidate referenced a missing token');
        break;
      case 'count-out-of-range':
        console.error('io count out of TxIoVec range');
        break;
    }
  }
}
```

---

### `TxValidationError`

Typed validation error (phase 2). Only the validator's own structural verdicts are wrapped here; errors from the layers below propagate **unwrapped** (see "Unwrapped errors" below).

```ts
class TxValidationError extends Error {
  readonly code: TxValidationErrorCode;
  readonly location?: TxValidationLocation;
}
interface TxValidationLocation {
  inputIndex?: number;   // present when the error is localized to an input
  outputIndex?: number;  // present when the error is localized to an output
  boxId?: Uint8Array;    // the input's tx.inputs[i].boxId when inputIndex is present
}
type TxValidationErrorCode =
  // stateless
  | 'inputs-empty'
  | 'outputs-empty'
  | 'duplicate-input'
  | 'output-sum-overflow'
  // stateful structural
  | 'input-box-count-mismatch'
  | 'input-box-id-mismatch'
  | 'data-input-box-mismatch'
  | 'input-sum-overflow'
  | 'value-not-conserved'
  | 'output-below-min-value'
  | 'creation-height-in-future'
  | 'creation-height-below-max-input'
  | 'creation-height-negative'
  | 'box-size-exceeded'
  | 'script-size-exceeded'
  | 'token-not-conserved'
  | 'invalid-minted-token'
  | 'token-amount-invalid'
  // per-input / cost
  | 'non-sigmaprop-result'
  | 'script-reduced-false'
  | 'cost-limit-exceeded';   // only for init-cost overrun; see Unwrapped errors
```

**Note on `cost-limit-exceeded`:** This code appears in `TxValidationError` only when the per-tx init/structural cost alone exceeds the block budget. When the per-input eval accumulator fires during script evaluation, `EvalError('cost-limit-exceeded')` propagates unwrapped (NOT a `TxValidationError`). Callers must catch both.

### Unwrapped errors

`validateStateful` lets these propagate as-is (not caught or re-typed):

| Error class | Source | When |
|---|---|---|
| `EvalError` | `@ergots/ergoscript` | Script evaluation failure; includes `'cost-limit-exceeded'` for per-input cost overrun |
| `VerifyError` | `@ergots/ergoscript` | Sigma proof structure error (distinct from `script-reduced-false`) |
| `ReaderError` | `@ergots/scorex` | Truncated / malformed VLQ in ergoTree bytes |
| `ErgoTreeParseError` / `ExprParseError` / `SValueParseError` | `@ergots/ergoscript` | Malformed ergoTree or register bytes in an input box |

---

## Conventions

- **All byte sequences are `Uint8Array`.** Never `Buffer`.
- **`bigint` for `value` and token `amount`.** Both are u64 on the wire; JS `Number` cannot hold the full u64 range.
- **No async surface.** Every function is synchronous.
- **No I/O, no globals.** Pure functions: same inputs always produce the same output.
- **Round-trip invariant.** `serializeTransaction(parseTransaction(b)) === b` (byte-equal) for all accepted inputs.

---

## See also

- `facts/transaction.md` (repo root) — load-bearing interface contract; count bounds, wire-format layout, full error taxonomy (phase 1 + phase 2 validation)
- `docs/specs/2026-06-15-ergots-transaction-validation-design.md` — umbrella design spec (phases 1–4)
- `facts/ergoscript-wire.md` — `parseErgoTreeBytes` / `parseAdditionalRegisters`; box-body grammar shared with `@ergots/ergoscript`'s SBox data parser
- `facts/scorex.md` — `ByteReader` / `ByteWriter` / `blake2b256`; shared codec layer
- `facts/ergoscript-eval.md` — `EvalError` codes; `SValue` / `SType` discriminated unions
- `facts/ergoscript-sigma.md` — `VerifyError` codes; sigma-proof verifier surface
