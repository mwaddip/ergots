# @ergots/transaction

Pure-TypeScript Ergo transaction wire codec and validator. Parses and serializes `ErgoLikeTransaction` wire bytes, produces the signing message, computes transaction ids, and validates transactions statelessly and against their input boxes and block context. Browser-clean. Validated byte-for-byte against fixtures derived from the Ergo reference implementation, and against JVM-blessed conformance vectors.

## Scope

- **Wire codec:** parse, serialize, derive the signing message, compute the transaction id.
- **Validation:** `validateStateless` (well-formedness) and `validateStateful` (box provisioning, value and token conservation, output rules, per-input script evaluation and signature verification, storage rent, and the JVM block-cost model). See [`API.md`](./API.md).

## Install

```bash
npm install @ergots/transaction
```

## Usage

```ts
import { parseTransaction, transactionId, serializeTransaction } from '@ergots/transaction';

const txBytes: Uint8Array = /* bytes from a node or fixture */;

// Parse.
const tx = parseTransaction(txBytes);
console.log('inputs:', tx.inputs.length, 'outputs:', tx.outputCandidates.length);

// Derive the transaction id (32 bytes).
const idBytes = transactionId(tx);
const idHex = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
console.log('txId:', idHex);

// Re-serialize — byte-identical to txBytes when they are canonically encoded.
const reBytes = serializeTransaction(tx);
```

## API

The wire codec is four functions and one error class, below. The validators, `validateStateless` and `validateStateful`, and their `TxValidationError` are documented in [`API.md`](./API.md).

### `parseTransaction(bytes: Uint8Array): ErgoLikeTransaction`

Parse a complete transaction from wire bytes. Rejects trailing bytes (`TxParseError('trailing-bytes')`), an envelope check of ergots' own: sigma-rust's `sigma_parse_bytes` and the JVM's `parseBytes` both ignore them. Each output's tree is parsed as the JVM parses a box's tree (its declared size used only if it degrades; rule 1001 applies), and each output tree must re-encode, as the JVM's eager transaction id requires (`TxParseError('output-tree-not-reencodable')`). An output's `ergoTreeBytes` keeps the tree's bytes as received.

### `serializeTransaction(tx: ErgoLikeTransaction): Uint8Array`

Serialize to wire bytes. Enforces io-count bounds on serialize as well as parse. Writes each output's tree re-encoded, as the JVM does, so a tree whose declared size differs from its body is written with its true size.

### `signingMessage(tx: ErgoLikeTransaction): Uint8Array`

Full transaction envelope with each input's proof replaced by an empty proof (VLQ-length-0). This is the pre-image of the transaction id and the Fiat–Shamir message signed by each input's spending proof.

### `transactionId(tx: ErgoLikeTransaction): Uint8Array`

`blake2b256(signingMessage(tx))` — exactly 32 bytes. Equals the node-reported transaction id (lowercase base16 of these bytes). Confirmed byte-correct against the fixture corpus.

### `TxParseError`

```ts
class TxParseError extends Error {
  readonly code: 'trailing-bytes' | 'token-table-index-out-of-range' | 'count-out-of-range' | 'extension-id-out-of-range' | 'extension-v6-type' | 'output-tree-not-reencodable';
}
```

Thrown by `parseTransaction` and `serializeTransaction`. `count-out-of-range` covers inputs/outputs outside `[1, 32767]`, data-inputs outside `{0}∪[1, 32767]`, a proof longer than `0xFFFF` bytes, and a context extension with more than 127 entries. `output-tree-not-reencodable` fires when an output tree parses but cannot be written back (the JVM rejects such a transaction at parse); its `cause` is the write error. `extension-id-out-of-range` fires when a context-extension variable id is ≥ `0x80`: the JVM reads the id as a signed byte and rejects a negative one. `extension-v6-type` fires when a context-extension value's type contains `Option`, `Header` or `UnsignedBigInt` (the JVM's rule 1019). `token-table-index-out-of-range` fires when an output candidate references a token id not in the transaction's distinct-token table.

## Browser compatibility

Runs unchanged in evergreen browsers and Node ≥ 20. No `Buffer`, no `node:crypto`, no dynamic Node built-ins, no WASM. ESM-only.

## What is NOT here

- **Signing.** Producing `SpendingProof.proofBytes` requires a sigma prover — out of scope.
- **Transaction construction.** Box selection, fee calculation, token change.
- **Node communication.** Submit via any conformant Ergo node REST endpoint.

## See also

- [`facts/transaction.md`](../../facts/transaction.md) — load-bearing interface contract (wire format, count bounds, full error taxonomy)
- [`API.md`](./API.md) — function signatures, type shapes, worked examples
- [`docs/specs/2026-06-15-ergots-transaction-validation-design.md`](../../docs/specs/2026-06-15-ergots-transaction-validation-design.md) — validation design (phases 2–4)

## License

MIT
