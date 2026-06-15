# API — `@ergots/transaction`

Pure-TypeScript Ergo transaction wire codec. Phase 1 scope: parse, serialize, derive signing message, compute transaction id. Validation (stateless/stateful, per-input script execution, cost) is phases 2–4. See `facts/transaction.md` in the repo root for the load-bearing interface contract.

All exports are ESM. The package targets Node ≥ 20 and evergreen browsers; no `Buffer`, `node:crypto`, WASM, or other Node built-ins.

---

## Primary export

```ts
import {
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
| `TxParseError` | class | Typed parse / serialize error; `.code: TxParseErrorCode` |
| `TxParseErrorCode` | type | `'trailing-bytes' \| 'token-table-index-out-of-range' \| 'count-out-of-range'` |
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
  // { values: Record<number, { tpe: SType; value: SValue }> }
}
```

Serialization of `contextExtension.values` is sorted ascending by `varId` — canonical on-chain ordering.

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

The only typed error class this package throws.

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

## Conventions

- **All byte sequences are `Uint8Array`.** Never `Buffer`.
- **`bigint` for `value` and token `amount`.** Both are u64 on the wire; JS `Number` cannot hold the full u64 range.
- **No async surface.** Every function is synchronous.
- **No I/O, no globals.** Pure functions: same inputs always produce the same output.
- **Round-trip invariant.** `serializeTransaction(parseTransaction(b)) === b` (byte-equal) for all accepted inputs.

---

## See also

- `facts/transaction.md` (repo root) — load-bearing interface contract; count bounds, wire-format layout, full error taxonomy
- `docs/specs/2026-06-15-ergots-transaction-validation-design.md` — umbrella spec; phases 2–4 scope (validation)
- `facts/ergoscript-wire.md` — `parseErgoTreeBytes` / `parseAdditionalRegisters`; box-body grammar shared with `@ergots/ergoscript`'s SBox data parser
- `facts/scorex.md` — `ByteReader` / `ByteWriter` / `blake2b256`; shared codec layer
