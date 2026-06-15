# @ergots/transaction

Pure-TypeScript Ergo transaction wire codec. Parses and serializes `ErgoLikeTransaction` wire bytes, produces the signing message, and computes transaction ids. Browser-clean. Validated byte-for-byte against fixtures derived from the Ergo reference implementation.

## Phase 1 — wire codec

This is a phase 1 release: parse, serialize, derive the signing message, compute the transaction id. Validation (stateless well-formedness, conservation rule, per-input script execution, storage rent, cost) is planned for phases 2–4.

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

// Re-serialize — byte-identical to txBytes.
const reBytes = serializeTransaction(tx);
```

## API

Four functions, one error class.

### `parseTransaction(bytes: Uint8Array): ErgoLikeTransaction`

Parse a complete transaction from wire bytes. Rejects trailing bytes (`TxParseError('trailing-bytes')`). This is intentionally stricter than sigma-rust's `sigma_parse_bytes`, matching the JVM modifier-parse path.

### `serializeTransaction(tx: ErgoLikeTransaction): Uint8Array`

Serialize to wire bytes. Enforces io-count bounds on serialize as well as parse.

### `signingMessage(tx: ErgoLikeTransaction): Uint8Array`

Full transaction envelope with each input's proof replaced by an empty proof (VLQ-length-0). This is the pre-image of the transaction id and the Fiat–Shamir message signed by each input's spending proof.

### `transactionId(tx: ErgoLikeTransaction): Uint8Array`

`blake2b256(signingMessage(tx))` — exactly 32 bytes. Equals the node-reported transaction id (lowercase base16 of these bytes). Confirmed byte-correct against the fixture corpus.

### `TxParseError`

```ts
class TxParseError extends Error {
  readonly code: 'trailing-bytes' | 'token-table-index-out-of-range' | 'count-out-of-range';
}
```

Thrown by `parseTransaction` and `serializeTransaction`. `count-out-of-range` covers inputs/outputs outside `[1, 32767]` and data-inputs outside `{0}∪[1, 32767]`. `token-table-index-out-of-range` fires when an output candidate references a token id not in the transaction's distinct-token table.

## Browser compatibility

Runs unchanged in evergreen browsers and Node ≥ 20. No `Buffer`, no `node:crypto`, no dynamic Node built-ins, no WASM. ESM-only.

## What is NOT here

- **Signing.** Producing `SpendingProof.proofBytes` requires a sigma prover — out of scope.
- **Transaction construction.** Box selection, fee calculation, token change.
- **Node communication.** Submit via any conformant Ergo node REST endpoint.
- **Validation.** Conservation rule, per-input script verification, cost — planned phases 2–4.

## See also

- [`facts/transaction.md`](../../facts/transaction.md) — load-bearing interface contract (wire format, count bounds, full error taxonomy)
- [`API.md`](./API.md) — function signatures, type shapes, worked examples
- [`docs/specs/2026-06-15-ergots-transaction-validation-design.md`](../../docs/specs/2026-06-15-ergots-transaction-validation-design.md) — validation design (phases 2–4)

## License

MIT
