# @ergots/transaction

Pure-TypeScript Ergo transaction wire codec and validator. Parses and serializes `ErgoLikeTransaction` wire bytes, produces the signing message, computes transaction ids, and validates transactions statelessly and against their input boxes and block context. Browser-clean. Validated byte-for-byte against fixtures derived from the Ergo reference implementation, and against JVM-blessed conformance vectors.

## Scope

- **Wire codec:** parse and serialize a transaction and a block's transactions section under the JVM's `VersionContext` (`parseTransaction(bytes, versions)`, `parseBlockTransactions`, `serializeBlockTransactions`, `blockVersionContext`, `unconfirmedVersionContext`), derive the signing message, compute the transaction id.
- **Validation:** `validateStateless` (well-formedness) and `validateStateful` (box provisioning, value and token conservation, output rules including the output's bytes writable at tree version 1, per-input script evaluation and signature verification, storage rent, and the JVM block-cost model). `validateStateful` takes the voted `stateContext.parameters.blockVersion` as a required input and runs the JVM's spend check (`checkSoftForkCondition`) before each input's reduction. It returns the transaction's block cost. The script evaluation is `@ergots/ergoscript`'s, whose Deserialize substitution and eval-time type reads follow the JVM's, so an `ExprTpeError` can propagate from a spend too. See [`API.md`](./API.md).

## Install

```bash
npm install @ergots/transaction
```

## Usage

```ts
import {
  parseTransaction,
  transactionId,
  serializeTransaction,
  blockVersionContext,
} from '@ergots/transaction';

const txBytes: Uint8Array = /* bytes from a node or fixture */;
const blockVersion = 4;                             // from /blocks/{id}
const headerId: Uint8Array = /* … 32 bytes … */;

// Parse under the block's version context (as the JVM parses a block section).
const tx = parseTransaction(txBytes, blockVersionContext(blockVersion, headerId));
console.log('inputs:', tx.inputs.length, 'outputs:', tx.outputCandidates.length);

// Derive the transaction id (32 bytes).
const idBytes = transactionId(tx);
const idHex = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
console.log('txId:', idHex);

// Re-serialize — byte-identical to txBytes when they are canonically encoded.
const reBytes = serializeTransaction(tx);
```

## API

The wire codec is the functions below plus one error class. The validators, `validateStateless` and `validateStateful`, and their `TxValidationError` are documented in [`API.md`](./API.md).

### `parseTransaction(bytes: Uint8Array, versions: VersionContext): ErgoLikeTransaction`

Parse a complete transaction from wire bytes under the JVM's `VersionContext` — a pair `{ activated, ergoTree }` of signed bytes the caller names (sigma-state 6.0.7 `VersionContext.scala:17`). `versions.activated` is set on the transaction's reader, so every output tree, and every tree nested in a register, an extension value or a Box constant, meets the parse's tree-version check: a tree above the activated version from 2 onwards rejects with `ErgoTreeParseError('tree-version-above-activated')`. `versions.ergoTree` is the version registers and context-extension values are read at (sigma-state 6.0.7 `ErgoBoxCandidate.scala:231`, `ContextExtension.scala:61`). Build the pair with `blockVersionContext(blockVersion, headerId)` for a block section (ergo 6.0.8 `BlockTransactions.scala:184-202`) or `unconfirmedVersionContext(blockVersion)` for a peer's or mempool transaction (`ErgoNodeViewSynchronizer.scala:830`); a pair the JVM cannot build (`ergoTree > activated >= 2`) or a missing pair is a `RangeError`.

Bytes after the transaction are ignored, as the JVM's `parseBytes` does: in a block section the JVM reads transactions back to back on one reader, and a hand-written call with trailing bytes parses too. Each output's tree is parsed as the JVM parses a box's tree (its declared size used only if it degrades; rule 1001 applies), and each output tree must re-encode, as the JVM's eager transaction id requires (`TxParseError('output-tree-not-reencodable')`). An output's `ergoTreeBytes` keeps the tree's bytes as received. Every node of an output tree passes the JVM's construction checks as it is parsed (an `ExprParseError` construction code or an `ExprTpeError`, propagated unwrapped, is a hard reject), and a method or a type the JVM does not know at the tree's version degrades a size-flagged tree (see `@ergots/ergoscript`'s API.md and [`facts/transaction.md`](../../facts/transaction.md)).

### `serializeTransaction(tx: ErgoLikeTransaction): Uint8Array`

Serialize to wire bytes. Enforces io-count bounds on serialize as well as parse. Writes each output's tree re-encoded, as the JVM does, so a tree whose declared size differs from its body is written with its true size.

### `signingMessage(tx: ErgoLikeTransaction): Uint8Array`

Full transaction envelope with each input's proof replaced by an empty proof (VLQ-length-0). This is the pre-image of the transaction id and the Fiat–Shamir message signed by each input's spending proof.

### `transactionId(tx: ErgoLikeTransaction): Uint8Array`

`blake2b256(signingMessage(tx))` — exactly 32 bytes. Equals the node-reported transaction id (lowercase base16 of these bytes). Confirmed byte-correct against the fixture corpus.

### `parseContextExtension(r: ByteReader, treeVersion: number): ContextExtension`

Read one `ContextExtension` from a shared `@ergots/scorex` `ByteReader` as the JVM's `ContextExtension.serializer.parse` does (sigma-state 6.0.7 `ContextExtension.scala:52-66`). `treeVersion` is the version the declared type and the value's data are read at — the context's tree-version half, which `parseTransaction` passes from its `versions.ergoTree`. The reader's own `activatedVersion` field carries the activated version of a Box constant's tree. Exposed for consumers that rebuild a transaction's context from raw bytes outside the `Input` envelope. Throws `TxParseError` with `'count-out-of-range'`, `'extension-id-out-of-range'` or `'extension-v6-type'`, and the inner codec errors unwrapped.

### `blockVersionContext(blockVersion: number, headerId?: Uint8Array): VersionContext`

The `VersionContext` a node parses a block's transactions section under (ergo 6.0.8 `BlockTransactions.scala:184-202`, `Header.scala:154-155`): `(blockVersion − 1, blockVersion − 1)` from block version 4, compared as a signed byte, and `(1, 1)` below it and for the testnet block whose header id is `3f5a4acb…6e9398` (`BlockTransactions.scala:189-193`), which `headerId` selects.

### `unconfirmedVersionContext(blockVersion: number): VersionContext`

The `VersionContext` a node parses a peer's transaction or a transaction entering its mempool under (`ErgoNodeViewSynchronizer.scala:830`, `ErgoMemPool.scala:319-325`): `(blockVersion − 1, blockVersion − 1)` of its state's voted block version, at every block version. At block version 3 it is `(2, 2)`, where a block's own is `(1, 1)`.

### `parseBlockTransactions(bytes: Uint8Array): BlockTransactions` / `serializeBlockTransactions(section: BlockTransactions): Uint8Array`

Parse and serialize a block's transactions section (ergo 6.0.8 `BlockTransactions.scala:138-206`): a 32-byte header id, a VLQ marker-or-count (above 10,000,000 it carries the block version, exactly 10,000,000 is the count itself, below it the count), then that many transactions on one reader under `blockVersionContext(blockVersion, headerId)`. Bytes after the last transaction are ignored; a count of 0 rejects. `serializeBlockTransactions` throws a `RangeError` for an empty list, a block version outside −128 to 127, or a header id that is not 32 bytes.

### `ArrayClass` / `CollClass` / `CollValue` (re-exported)

The class the JVM's `Coll[A]` object carries beyond its items (`ArrayClass`, `CollClass`) and the narrowed `SValue` of `kind: 'Coll'` (`CollValue`). `cls?` on `CollValue` is read by the evaluator wherever the JVM reads the class. Re-exported from `@ergots/ergoscript`; its API.md defines the three types and the rule for a value handed in without `cls`.

### `TxParseError`

```ts
class TxParseError extends Error {
  readonly code: 'token-table-index-out-of-range' | 'count-out-of-range' | 'extension-id-out-of-range' | 'extension-v6-type' | 'output-tree-not-reencodable';
}
```

Thrown by `parseTransaction`, `parseBlockTransactions` and `serializeTransaction`. `parseTransaction` ignores bytes after a structurally complete transaction, as the JVM's `parseBytes` does, so the union carries no `'trailing-bytes'` code. `count-out-of-range` covers inputs/outputs outside `[1, 32767]`, data-inputs outside `{0}∪[1, 32767]`, a proof longer than `0xFFFF` bytes, a context extension with more than 127 entries, and a section's marker-or-count or transaction count that does not fit an `Int` or is 0. `output-tree-not-reencodable` fires when an output tree parses but cannot be written back (the JVM rejects such a transaction at parse); its `cause` is the write error. `extension-id-out-of-range` fires when a context-extension variable id is ≥ `0x80`: the JVM reads the id as a signed byte and rejects a negative one. `extension-v6-type` fires when a context-extension value's type contains `Option`, `Header` or `UnsignedBigInt` (the JVM's rule 1019). `token-table-index-out-of-range` fires when an output candidate references a token id not in the transaction's distinct-token table.

A tree whose version is above the context's `activated` from 2 onwards is `ErgoTreeParseError('tree-version-above-activated')` from `@ergots/ergoscript`, propagated unwrapped. A `VersionContext` the JVM cannot build, or a missing one, is a `RangeError`.

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
