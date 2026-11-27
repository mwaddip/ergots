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
  parseContextExtension,
  blockVersionContext,
  unconfirmedVersionContext,
  parseBlockTransactions,
  serializeBlockTransactions,
  TxParseError,
  type TxParseErrorCode,
  type ErgoLikeTransaction,
  type Input,
  type SpendingProof,
  type DataInput,
  type ErgoBoxCandidate,
  type VersionContext,
  type BlockTransactions,
  type ArrayClass,
  type CollClass,
  type CollValue,
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
| `parseTransaction` | function | Parse wire bytes → `ErgoLikeTransaction` under the JVM's `VersionContext`, a pair the caller names; ignores bytes after the transaction, as the JVM's `parseBytes` does |
| `serializeTransaction` | function | `ErgoLikeTransaction` → wire bytes |
| `signingMessage` | function | Full envelope with proofs zeroed; pre-image of transaction id |
| `transactionId` | function | `blake2b256(signingMessage(tx))`; 32-byte id |
| `parseContextExtension` | function | Read one `ContextExtension` from a `ByteReader` at a given tree version, as the JVM's `ContextExtension.serializer.parse` does (sigma-state 6.0.7 `ContextExtension.scala:52-66`) |
| `blockVersionContext` | function | The `VersionContext` a node parses a block's transactions under (ergo 6.0.8 `BlockTransactions.scala:184-202`) |
| `unconfirmedVersionContext` | function | The `VersionContext` a node parses a peer's or mempool transaction under (ergo 6.0.8 `ErgoNodeViewSynchronizer.scala:830`) |
| `parseBlockTransactions` | function | Parse a block's transactions section → `BlockTransactions` (header id, block version, transactions) |
| `serializeBlockTransactions` | function | `BlockTransactions` → section wire bytes |
| `validateStateless` | function | Stateless checks (non-empty, no dup inputs, output sum no overflow) |
| `validateStateful` | function | Full structural + per-input verify; requires `StatefulDeps` with `stateContext.parameters.blockVersion`; returns the transaction's block cost |
| `TxParseError` | class | Typed parse / serialize error; `.code: TxParseErrorCode` |
| `TxParseErrorCode` | type | `'token-table-index-out-of-range' \| 'count-out-of-range' \| 'extension-id-out-of-range' \| 'extension-v6-type' \| 'output-tree-not-reencodable'` |
| `TxValidationError` | class | Typed validation error; `.code: TxValidationErrorCode`; `.location?: TxValidationLocation` |
| `TxValidationErrorCode` | type | 22-variant union (see Error handling section) |
| `TxValidationLocation` | type | `{ inputIndex?, outputIndex?, boxId?, cause? }` |
| `StatefulDeps` | interface | Input boxes + data-input boxes + state context |
| `StateContext` | interface | Headers (newest-first, ≥1) + preHeader + required `parameters` (whose `blockVersion` is required; every other `ChainParameters` field stays optional) |
| `ChainParameters` | interface | The voted `blockVersion` and the cost/size constants (the latter default in `DEFAULT_PARAMETERS`) |
| `DEFAULT_PARAMETERS` | const | `Omit<ChainParameters, 'blockVersion'>` — the seven economic defaults; a caller always names `blockVersion` |
| `ErgoLikeTransaction` | interface | Root transaction type |
| `Input` | interface | Spending input (boxId + proof) |
| `SpendingProof` | interface | Sigma proof bytes + context extension |
| `DataInput` | interface | Read-only input (boxId only) |
| `ErgoBoxCandidate` | interface | Output box before assignment of txId/index |
| `VersionContext` | interface | `{ activated, ergoTree }`, each an integer from −128 to 127 — the JVM's version context (sigma-state 6.0.7 `VersionContext.scala:17`) |
| `BlockTransactions` | interface | `{ headerId, blockVersion, transactions }` — a block's transactions section |
| `ArrayClass` / `CollClass` / `CollValue` | types | The class the JVM's `Coll[A]` object carries beyond its items (`ArrayClass` / `CollClass`) and the narrowed `SValue` of `kind: 'Coll'` (`CollValue`), re-exported from `@ergots/ergoscript`. `cls?` on `CollValue` is read by the evaluator wherever the JVM reads the class. See `@ergots/ergoscript`'s API.md |

---

## Functions

### `parseTransaction(bytes, versions)`

```ts
function parseTransaction(bytes: Uint8Array, versions: VersionContext): ErgoLikeTransaction
```

Parse a complete `ErgoLikeTransaction` from sigma-serialized wire bytes under the JVM's `VersionContext` (sigma-state 6.0.7 `VersionContext.scala:17`), a pair of signed bytes the caller names:
- `versions.activated` is set on the transaction's reader (`@ergots/scorex`, `ByteReader.activatedVersion`), so every output tree, and every tree nested in a register, an extension value or a Box constant, meets the parse's tree-version check — a tree whose version is above `versions.activated` from 2 onwards rejects as `ErgoTreeParseError('tree-version-above-activated')`.
- `versions.ergoTree` is the version the codec reads output-box registers and context-extension values at (`parseAdditionalRegisters(r, versions.ergoTree)` and `parseContextExtension(r, versions.ergoTree)`), as the JVM reads them under the context's tree-version half.

For a block section the pair is `blockVersionContext(blockVersion, headerId)`; for a peer's or a mempool transaction it is `unconfirmedVersionContext(blockVersion)`. A hand-written pair the JVM cannot build (`ergoTree > activated >= 2`, `VersionContext.scala:20`), or a missing pair, is a `RangeError`.

Bytes after the transaction are ignored, as the JVM's `parseBytes` ignores them (ergo-core `avldb/.../ErgoSerializer.scala:27-30`; sigma-state `SigmaSerializer.fromBytes:81-83`): in a block section the JVM parses the transactions back to back on one reader, so the bytes after one transaction are the next one, and a hand-written call with one trailing byte parses too. A transaction's verdict can depend on the bytes that follow it (`facts/ergoscript-wire.md`, residual 7): a tree whose last read peeks at the very end of its bytes rejects as `'truncated'`, where the same tree in a block section sees the next transaction's first byte and degrades on the window check.

Each output's ergoTree is parsed under the box rules (`parseErgoTreeBytes` from `@ergots/ergoscript`), on the transaction's reader, as the JVM parses a box's tree: its declared size is used only if it degrades, and rule 1001 applies. Once every output is parsed, `parseTransaction` re-encodes each output tree, as the JVM's eager transaction id does, and rejects the transaction if one cannot be written.

**Returns:** `ErgoLikeTransaction` satisfying all type invariants. `serializeTransaction(parseTransaction(b, v))` is byte-equal to `b`'s transaction prefix for every accepted input that is canonically encoded and whose register and context-extension values can all be written. Non-canonical encodings re-serialize canonically, as the JVM's do, and an output tree whose declared size differs from its body re-serializes with its true size. Two encodings keep their received bytes where the JVM would normalize them: a Tuple-expression register and an AvlTree flags byte (`facts/transaction.md`, "Round-trip invariant" and Known residual 3). Each output's `ergoTreeBytes` keeps the tree's bytes as received.

**Throws:**
- `RangeError` — `versions` is missing, or holds non-signed-byte halves, or is a pair the JVM cannot build (`ergoTree > activated >= 2`).
- `ErgoTreeParseError('tree-version-above-activated')` — an output tree, or a tree nested in a register, an extension value or a Box constant, carries a version above `versions.activated` from 2 onwards. Not in the degrade set, so no enclosing tree degrades on it (`@ergots/ergoscript`'s API.md, `parseTree` and `ErgoTreeParseError`).
- `TxParseError('token-table-index-out-of-range')` — an output candidate references a token-table index beyond the transaction's distinct-token table.
- `TxParseError('count-out-of-range')` — an io count violates the `TxIoVec` / `get_u32` bounds (inputs `[1,32767]`, outputs `[1,32767]`, dataInputs `{0}∪[1,32767]`), an input's proof is longer than `0xFFFF` bytes (the JVM's `getUShort`), or an input's context-extension entry-count byte is ≥ `0x80`.
- `TxParseError('extension-id-out-of-range')` — an input's context-extension variable-id byte is ≥ `0x80` (see `SpendingProof`).
- `TxParseError('extension-v6-type')` — an input's context-extension value has a type containing `Option`, `Header` or `UnsignedBigInt` (see `SpendingProof`).
- `TxParseError('output-tree-not-reencodable')` — an output tree parses but cannot be written back, for example one holding a 1-item tuple type or a FuncValue argument id of 2^31 or more; the write error is the `cause`. The JVM rejects such a transaction at parse. This check runs once every output is parsed.
- `ReaderError` (from `@ergots/scorex`) for truncated / malformed VLQ bytes, or `'max-tree-depth-exceeded'` for a context-extension value nested deeper than the JVM allows.
- Inner ergoscript errors if a candidate's ergoTree or register bytes are malformed or fail the box rules, unwrapped: for example `ErgoTreeParseError('soft-fork-without-size-bit')` for an unsized output tree whose root is not SigmaProp, or `ExprTpeError` for a root type the JVM cannot build. Every node of an output tree passes the JVM's construction checks as it is parsed, so an `ExprParseError` construction code or an `ExprTpeError` can come from any node, a hard reject in a size-flagged tree too (`@ergots/ergoscript`'s API.md, "`ExprParseError` codes").

---

### `serializeTransaction(tx)`

```ts
function serializeTransaction(tx: ErgoLikeTransaction): Uint8Array
```

Serialize an `ErgoLikeTransaction` to sigma wire bytes. Enforces all io-count bounds — it is safe to call on a programmatically-constructed transaction and rely on it to reject invalid counts.

**Returns:** `Uint8Array` byte-equal to the JVM sigma-state serializer's output for the same transaction. Each output's tree is written re-encoded (`reencodeTreeBytes` from `@ergots/ergoscript`), as the JVM's candidate serializer writes it: a parsed tree from its structure, with its true size, and an unparsed one as received.

**Throws:** `TxParseError('count-out-of-range')` when io counts or the distinct-token table exceed their bounds, an input's proof is longer than `0xFFFF` bytes, or an input's context extension holds more than 127 entries. The write errors of a value or tree that cannot be written propagate unwrapped. For an output tree that happens only for a constructed candidate, whose tree is parsed under the box rules on first use; a transaction from `parseTransaction` has re-encodable output trees. A register or context-extension value that cannot be written (for example of a 1-item tuple type) throws whether the transaction was parsed or constructed.

---

### `signingMessage(tx)`

```ts
function signingMessage(tx: ErgoLikeTransaction): Uint8Array
```

Produce the Fiat–Shamir signing message: the full transaction envelope with every input's proof replaced by an empty proof. The empty proof serializes as `VLQ(0)` (one zero byte for the length, then no proof bytes) — the field is NOT omitted; the explicit zero-length VLQ is load-bearing for the blake2b256 txId hash.

This is the exact value sigma-rust's `bytes_to_sign` produces for canonical trees. Output trees are written re-encoded, as in `serializeTransaction` and as the JVM's `bytesToSign` writes them, so an output tree whose declared size differs from its body gives the same signing message, and the same transaction id, as its canonical twin.

**Throws:** Same shape as `serializeTransaction`.

---

### `transactionId(tx)`

```ts
function transactionId(tx: ErgoLikeTransaction): Uint8Array
```

Compute the transaction id: `blake2b256(signingMessage(tx))`, returning exactly 32 bytes. The node-reported transaction id is the lowercase base16 encoding of these bytes.

Confirmed byte-correct: `transactionId(parseTransaction(b, v))` equals the node-reported id for every fixture in the test corpus.

**Throws:** Same as `signingMessage`.

---

### `parseContextExtension(r, treeVersion)`

```ts
function parseContextExtension(r: ByteReader, treeVersion: number): ContextExtension
```

Read one `ContextExtension` from a shared `@ergots/scorex` `ByteReader` as the JVM's `ContextExtension.serializer.parse` does (sigma-state 6.0.7 `ContextExtension.scala:52-66`): a one-byte count below `0x80`, then each entry a one-byte id below `0x80`, its `SType` and its value, with rule-1019 `CheckV6Type` applied to the declared type. `treeVersion` is the version the declared type and the value's data are read at (as `facts/ergoscript-wire.md`, "Type reads", reads them): the context's tree-version half, which `parseTransaction` passes from its `versions.ergoTree`. The reader's own `activatedVersion` field carries the activated version of a Box constant's tree. Exposed for consumers that rebuild a transaction's context from raw bytes outside the `Input` envelope.

**Throws:**
- `TxParseError('count-out-of-range')` — the entry count byte is ≥ `0x80`.
- `TxParseError('extension-id-out-of-range')` — a variable id byte is ≥ `0x80`.
- `TxParseError('extension-v6-type')` — a value's declared type contains `Option`, `Header` or `UnsignedBigInt` (rule-1019 `CheckV6Type`).
- Inner codec errors unwrapped: `STypeParseError`, `SValueParseError`, `ReaderError` and the ergoscript parse classes for a malformed type or value.

---

### `blockVersionContext(blockVersion, headerId?)`

```ts
function blockVersionContext(blockVersion: number, headerId?: Uint8Array): VersionContext
```

The `VersionContext` a node parses a block's transactions section under (ergo 6.0.8 `BlockTransactions.scala:184-202`, `Header.scala:154-155`): `(blockVersion − 1, blockVersion − 1)` from block version 4 compared as a signed byte, and `(1, 1)` below it and for the testnet block of `BlockTransactions.scala:189-193` (header id `3f5a4acb…6e9398`), which `headerId` selects. `blockVersion` is an integer the JVM reads as `Byte` (`(x << 24) >> 24`), so 128 to 255 wrap below 4. `parseBlockTransactions` passes the pair it builds this way to each transaction's parse.

**Throws:** `TypeError` when `blockVersion` is not an integer.

---

### `unconfirmedVersionContext(blockVersion)`

```ts
function unconfirmedVersionContext(blockVersion: number): VersionContext
```

The `VersionContext` a node parses a peer's transaction, or a transaction entering its mempool, under (ergo 6.0.8 `ErgoNodeViewSynchronizer.scala:830`, `ErgoMemPool.scala:319-325`): `(blockVersion − 1, blockVersion − 1)` of its state's voted block version, at every block version. At block version 3 it is `(2, 2)`, where a block's own is `(1, 1)`.

**Throws:** `TypeError` when `blockVersion` is not an integer.

---

### `parseBlockTransactions(bytes)`

```ts
function parseBlockTransactions(bytes: Uint8Array): BlockTransactions
```

Parse a block's transactions section (ergo 6.0.8 `BlockTransactions.scala:138-206`): the 32-byte header id, a VLQ `verOrCount` (`r.getUInt().toIntExact`) — above 10,000,000 it is a marker, the block version is `(verOrCount − 10,000,000)` as a signed byte, and the count follows; exactly 10,000,000 is the count itself, with block version 1 — and then that many transactions. Each transaction is parsed on a fresh reader over the rest of the section, under `blockVersionContext(blockVersion, headerId)`, as the JVM wraps each in a fresh `SigmaByteReader` (`ErgoTransaction.scala:538-544`): no nesting level and no `ValDef` type carries from one transaction to the next. A count of 0 rejects. Nothing is allocated by the count: a count beyond what the bytes hold fails at the transaction that runs out. Bytes after the last transaction are ignored.

A JVM node also compares the marker with its header's version (`Header.isCorrespondingModifier`, `Header.scala:104-108`, applied as `bsCorrespondsToHeader` from ergo 6.0.8); that comparison is a caller's, and no API of this package does it. `parseBlockTransactions` returns the marker's version, and a caller that holds the header compares the two.

**Returns:** `BlockTransactions` with `headerId`, `blockVersion` (signed byte) and `transactions` (at least one).

**Throws:**
- `TxParseError('count-out-of-range')` — `verOrCount` or the count does not fit an `Int`, or the count is 0.
- Everything `parseTransaction` throws on the section's transactions.

---

### `serializeBlockTransactions(section)`

```ts
function serializeBlockTransactions(section: BlockTransactions): Uint8Array
```

Serialize to section wire bytes (ergo 6.0.8 `BlockTransactions.scala:142-161`): the 32 header-id bytes, then `putUInt(10,000,000 + blockVersion)` when the block version is above 1 as a signed byte (so a section of version 1 or below writes without a marker and reads back as version 1), then the count, then each transaction through `serializeTransaction`.

**Throws:** `RangeError` for an empty transaction list, a block version outside −128 to 127, or a header id that is not 32 bytes. The write errors `serializeTransaction` raises propagate unwrapped.

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
function validateStateful(tx: ErgoLikeTransaction, deps: StatefulDeps): number
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
  parameters: Partial<ChainParameters> & { blockVersion: number };  // REQUIRED; blockVersion REQUIRED
}
interface ChainParameters {   // sigma-rust parameters.rs:157-168, plus the voted blockVersion
                              // (ergo ErgoStateContext.scala:114, settings/Parameters.scala:80, parameter 123).
  maxBlockCost: number;       // 1_000_000
  storageFeeFactor: number;   // 1_250_000
  minValuePerByte: number;    // 360
  inputCost: number;          // 2_000
  dataInputCost: number;      // 100
  outputCost: number;         // 100
  tokenAccessCost: number;    // 100
  blockVersion: number;       // the voted block version, the JVM's signed byte. REQUIRED
}
const DEFAULT_PARAMETERS: Omit<ChainParameters, 'blockVersion'>;  // the seven economic defaults;
                                                                  // a caller always names blockVersion
```

**Rule set (in order):**
1. `stateContext.parameters.blockVersion`: read as the JVM's `Byte`, an integer wrapped as `.toByte` wraps it. A non-integer throws a `TypeError` before anything is validated. `activatedVersionOfBlock(blockVersion)` (from `@ergots/ergoscript`) is the activated script version for the spend check and each input's `activatedScriptVersion`, and the signed byte decides the height rules.
2. Input/data-input box provisioning: the count, and each box's id, `boxIdOf(box)` from `@ergots/ergoscript`, which hashes a parsed box's bytes as received, as the JVM's `ErgoBox.id` does.
3. Input value sum no-overflow.
4. Value conservation (`Σ inputs === Σ outputs`).
5. Per-output well-formedness: dust, future height, monotonic height (post-v3), negative height (post-v1), box/script size ≤ 4096, and the output's bytes written at tree version 1 (`output-not-serializable`, see "Error handling"). The box size (for the dust minimum and the size cap) is the output box's serialization, with its tree re-encoded; the script size is the tree's bytes as received.
6. Token conservation: amount overflow, not-conserved, invalid minted token.
7. Init/structural cost (block units) seeds the cumulative block-cost accumulator (`runningBlock`); reject if it alone exceeds `maxBlockCost`.
8. Per-input (block-cost, JVM-faithful), either:
   - **Storage rent** (the rent branch of the JVM's `ErgoInterpreter.verify`, ergo v6.0.6). It applies when the box is at least 1,051,200 blocks old, the proof is empty, and the extension holds var 127. If var 127 is not a `Short` or does not index an output, the input falls back to the spend check. Otherwise `checkExpiredBox`'s verdict is final: false throws `script-reduced-false` without consulting the script; true costs 50 block units (then `runningBlock > maxBlockCost` rejects). The recreation's registers are compared as the JVM compares stored register nodes: a Box-valued register by the nested box's id over its original bytes, and a `Tuple` expression never equal to a Constant. The storage fee is `storageFeeFactor × box bytes` as a 32-bit `Int` product, so it wraps for boxes of 1718 bytes and more at the default factor, as in the JVM. The box bytes are `boxBytesOf(box)`: a parsed box's bytes as received, as the JVM's `ErgoBox.bytes`.
   - **Spend check**, after the rent branch and `boxTreeOf(selfBox.ergoTreeBytes)`: `checkSoftForkCondition(tree, activatedVersionOfBlock(blockVersion))` from `@ergots/ergoscript`. On `'accept-unverified'` the input adds 0 to `runningBlock` (the JVM returns `(true, context.initCost)` and ergo-core starts each input at `initCost = 0`), runs no reduction, verifies no proof, and the loop continues. On `'proceed'` the input takes the **script path**: the box's tree under the box rules → reduce (`reduceWith` from `@ergots/ergoscript`, the JVM's `Interpreter.fullReduction`; for a tree with a Deserialize node its cost includes the interpreter's charges for the tree's bytes and for each decoded script; the context's `activatedScriptVersion` is set to the same activated version so the reduction-time readers follow the voted version) → `SigmaProp` check → accumulate `floor(reductionJit/10) + floor(estimateCryptoCost(result.value)/10)` (reject if `runningBlock > maxBlockCost`) → `verifySignature`. A tree whose version is above the activated version at or below 3 raises `EvalError('tree-version-above-activated')` from `checkSoftForkCondition`; a tree that degraded cannot be evaluated: the spend rejects with `EvalError('unparsed-ergotree')`, as in the JVM.

**Errors surface unwrapped:** Only the validator's own structural verdicts are `TxValidationError`. `EvalError` (incl. `'cost-limit-exceeded'` fired during eval, and `'tree-version-above-activated'` from the spend check), `VerifyError`, and wire-parse errors propagate as-is. See the "Error handling" section.

**Returns:** the transaction's block cost: the init cost plus every input's cost, the figure the JVM's `ErgoTransaction.validateStateful` returns for an accumulated cost of 0. To validate a block as the JVM does, give each transaction the budget the block has left (`maxBlockCost` less the block's cost so far, as `parameters.maxBlockCost`) and add the returned cost to the block's. The JVM bounds every input by that remainder, so summing costs that were each checked against the full limit accepts blocks the JVM rejects.

**Throws:** `TypeError` when `stateContext.parameters.blockVersion` is not an integer; `TxValidationError` (structural, including `'output-not-serializable'`); `EvalError` (script eval / cost overrun, `'unparsed-ergotree'`, or `'tree-version-above-activated'` from the spend check); `ExprTpeError` (a type read at an eval-time `checkType` site); `VerifyError` (crypto layer); `ReaderError` / ergoscript parse and serialize errors (malformed ergoTree bytes, or a value that cannot be written; see "Unwrapped errors").

---

## Worked example: parse, derive id, re-serialize

```ts
import {
  parseTransaction,
  transactionId,
  serializeTransaction,
  blockVersionContext,
} from '@ergots/transaction';

// Raw transaction bytes from a node or fixture.
const txBytes: Uint8Array = /* … */;
const blockVersion = 4;                             // from /blocks/{id}
const headerId: Uint8Array = /* … 32 bytes … */;

// Parse under the block's version context (as the JVM parses a block section).
const tx = parseTransaction(txBytes, blockVersionContext(blockVersion, headerId));

// Derive the transaction id (32 bytes; base16-encode to get the string form).
const idBytes = transactionId(tx);
const idHex = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
console.log('txId:', idHex);

// Inspect inputs and outputs.
console.log('inputs:', tx.inputs.length, 'outputs:', tx.outputCandidates.length);
for (const out of tx.outputCandidates) {
  console.log('  value:', out.value, 'nanoErg, tokens:', out.tokens.length);
}

// Re-serialize — byte-identical to txBytes when they are canonically encoded
// (an output tree whose declared size is wrong is written with its true size).
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
  blockVersionContext,
  DEFAULT_PARAMETERS,
  TxValidationError,
  type StatefulDeps,
  type StateContext,
} from '@ergots/transaction';
import { EvalError, VerifyError, type ErgoBox, type PreHeader } from '@ergots/ergoscript';
import type { Header } from '@ergots/scorex';

// 1. Parse the raw bytes under the block's version context.
const txBytes: Uint8Array = /* … from node or wallet */;
const blockVersion = 4;                             // the chain's voted block version
const headerId: Uint8Array = /* … 32 bytes … */;
const tx = parseTransaction(txBytes, blockVersionContext(blockVersion, headerId));

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
  // blockVersion is required; the economic fields default from DEFAULT_PARAMETERS.
  parameters: { ...DEFAULT_PARAMETERS, blockVersion },
};

const deps: StatefulDeps = { inputBoxes, dataInputBoxes, stateContext };

// 4. Full stateful validation.
try {
  const cost = validateStateful(tx, deps);
  console.log(`transaction valid, block cost ${cost}: safe to submit`);
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
    // ReaderError / parse error from malformed ergoTree bytes, or an eval-time
    // ExprTpeError (a type read at a JVM checkType site; see "Unwrapped errors").
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

The entry count and each variable id are single bytes that the JVM reads as
signed (`ContextExtension.scala:52-66`, sigma-state v6.0.6). `parseTransaction`
rejects a count byte ≥ `0x80` (`count-out-of-range`) and an id byte ≥ `0x80`
(`extension-id-out-of-range`, before the value is read), so a parsed extension
holds at most 127 entries with ids in `[0, 127]`. `serializeTransaction`
rejects an extension with more than 127 entries; it writes ids unchecked, as
the JVM serializer does.

Each value is read as the JVM's `r.getValue()` reads it: one reader depth level
for the value itself, so a value nested past the JVM's cap throws
`ReaderError('max-tree-depth-exceeded')`, and rule-1019 `CheckV6Type` on its
type, so a type containing `Option`, `Header` or `UnsignedBigInt` throws
`extension-v6-type` even when the value holds no data of that type (an empty
`Coll[Option[Int]]`). A repeated id keeps its first position and its last
value, as the JVM's map does, so such an extension re-serializes without the
repeat. Two known differences from the JVM remain: an extension with 5 or more
distinct ids keeps its received order where the JVM re-orders it by hash, and
values written in opcode form (e.g. a `Tuple` expression) are rejected. See
`facts/transaction.md` § "Context-extension bounds".

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
  ergoTreeBytes: Uint8Array;    // the tree's bytes as received (R1, propositionBytes), declared size
                                // included; serialization writes the tree re-encoded
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
  // cause?: unknown — the standard Error.cause; set for 'output-tree-not-reencodable'
}
type TxParseErrorCode =
  | 'token-table-index-out-of-range'
  | 'count-out-of-range'
  | 'extension-id-out-of-range'
  | 'extension-v6-type'
  | 'output-tree-not-reencodable';
```

`parseTransaction` ignores bytes after a structurally complete transaction, as the JVM's `parseBytes` does (ergo-core `avldb/.../ErgoSerializer.scala:27-30`), so the union carries no `'trailing-bytes'` code.

| Code | When |
|---|---|
| `'token-table-index-out-of-range'` | An output candidate references a token-table index beyond the transaction's distinct-token table. Parse only. |
| `'count-out-of-range'` | inputs/outputCandidates outside `[1, 32767]`; dataInputs outside `{0}∪[1, 32767]`; distinct-token count > 65535×255; an input's proof longer than `0xFFFF` bytes; a context-extension entry count ≥ 128 (count byte ≥ `0x80` on parse, more than 127 entries on serialize); a section's `verOrCount` or transaction count does not fit an `Int`, or the count is 0. Parse and serialize. |
| `'extension-id-out-of-range'` | A context-extension variable-id byte is ≥ `0x80`. Parse only. |
| `'extension-v6-type'` | A context-extension value's type contains `Option`, `Header` or `UnsignedBigInt` (rule-1019 `CheckV6Type`). Parse only. |
| `'output-tree-not-reencodable'` | An output tree parsed but cannot be written back; `cause` is the write error. The JVM rejects such a transaction at parse, since its transaction id writes every output tree. Parse only. |

A tree whose version is above the context's `activated` from 2 onwards rejects as `ErgoTreeParseError('tree-version-above-activated')` from `@ergots/ergoscript`, propagated unwrapped — see `parseTransaction`.

```ts
try {
  const tx = parseTransaction(bytes, blockVersionContext(blockVersion, headerId));
} catch (e) {
  if (e instanceof TxParseError) {
    switch (e.code) {
      case 'token-table-index-out-of-range':
        console.error('output candidate referenced a missing token');
        break;
      case 'count-out-of-range':
        console.error('io or context-extension count out of range');
        break;
      case 'extension-id-out-of-range':
        console.error('context-extension variable id >= 0x80');
        break;
      case 'extension-v6-type':
        console.error('context-extension value of a v6-only type');
        break;
      case 'output-tree-not-reencodable':
        console.error('an output tree cannot be written back:', e.cause);
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
  cause?: unknown;       // the underlying error, for 'output-not-serializable'; also the standard Error.cause
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
  | 'output-not-serializable'
  | 'token-not-conserved'
  | 'invalid-minted-token'
  | 'token-amount-invalid'
  // per-input / cost
  | 'non-sigmaprop-result'
  | 'script-reduced-false'   // also a false storage-rent verdict (the JVM fails the same rule)
  | 'cost-limit-exceeded';   // init-cost overrun OR per-input block-cost (eval+crypto, or 50 for rent) overrun; see note
```

**The voted `blockVersion`.** `validateStateful` reads `stateContext.parameters.blockVersion` as the JVM's `Byte` (settings/Parameters.scala:80), an integer wrapped as `.toByte` wraps it. A call whose `blockVersion` is not an integer throws a `TypeError` before anything is validated: a caller compiled without the types meets the missing field there. The byte decides the height rules (`creation-height-in-future`, `creation-height-below-max-input`, `creation-height-negative`), and `activatedVersionOfBlock(blockVersion)` from `@ergots/ergoscript` arms the spend check and each input's `activatedScriptVersion`.

**The spend check** runs after the storage-rent branch and `boxTreeOf(selfBox.ergoTreeBytes)`: `validateStateful` calls `checkSoftForkCondition(tree, activatedVersionOfBlock(blockVersion))` (`@ergots/ergoscript`'s exported helper). On `'accept-unverified'` that input is done (no cost added, no reduction run, no proof verified), and the loop continues; on `'proceed'` the input takes the script path with the context's `activatedScriptVersion` set to the same activated version. A tree whose version is above the activated version at or below 3 raises `EvalError('tree-version-above-activated')` from `checkSoftForkCondition`, which propagates unwrapped.

**`'output-not-serializable'`.** An output's bytes must be writable at tree version 1 (the JVM's default write of an output's bytes, outside any version context): `validateStateful` calls `serializeBoxAtTreeVersion(box, 1)` from `@ergots/ergoscript` on every output. Any failure wraps as this code with `location.outputIndex` and `location.cause` set. It covers a register whose declared type contains an `SFunc` (the JVM's writer has no case for an `SFunc` below tree version 3, `STypeSerializeError('sfunc-tree-version-too-low')`), a creation height whose bit 31 is set (`SValueSerializeError('sbox-creation-height-out-of-range')`), and the write-side carve-outs ergots refuses on hand-built values. Checked before the dust rule, so a sized output whose register carries a function type rejects here before it would be dusted.

**Note on `cost-limit-exceeded`:** This code appears in `TxValidationError` when the per-tx init/structural cost alone exceeds `maxBlockCost`, OR when the per-input block-cost accumulator (eval + sigma-verification cost, each `floor(jit/10)`; 50 for a storage-rent input) exceeds `maxBlockCost` after an input. A mid-reduction overrun instead propagates `EvalError('cost-limit-exceeded')` unwrapped (from inside `reduceWith`). Callers must catch both.

### Unwrapped errors

`validateStateful` lets these propagate as-is (not caught or re-typed):

| Error class | Source | When |
|---|---|---|
| `EvalError` | `@ergots/ergoscript` | Script evaluation failure; includes `'cost-limit-exceeded'` for per-input cost overrun, `'unparsed-ergotree'` for an input box whose tree degraded, and `'tree-version-above-activated'` from the spend check when a tree's version is above `activatedVersionOfBlock(blockVersion)` at or below 3 |
| `ExprTpeError` (at evaluation) | `@ergots/ergoscript` | A node's type read at one of the JVM's eval-time `checkType` sites throws, as the JVM's `ClassCastException` does there (a class-cast register default that the Deserialize substitution put in untyped is the case). A deliberate reject of a well-formed spend, not malformed bytes |
| `VerifyError` | `@ergots/ergoscript` | Sigma proof structure error (distinct from `script-reduced-false`) |
| `ReaderError` | `@ergots/scorex` | Truncated / malformed VLQ in ergoTree bytes |
| `ErgoTreeParseError` / `ExprParseError` / `SValueParseError` / `ExprTpeError` | `@ergots/ergoscript` | Malformed ergoTree or register bytes in a box whose tree `boxTreeOf` parses on a cache miss (a box not parsed by `@ergots/ergoscript`), including `ErgoTreeParseError('box-context-required')` and `'trailing-bytes'` |
| `ErgoTreeSerializeError` / `ExprSerializeError` / `STypeSerializeError` / `SValueSerializeError` / `SigmaBooleanSerializeError` | `@ergots/ergoscript` | A tree or value that cannot be written: a constructed output's tree (the size checks, the signing message), a register or context-extension value of a parsed or constructed transaction, or the tree of an input box that carries no bytes as received |

---

## Conventions

- **All byte sequences are `Uint8Array`.** Never `Buffer`.
- **`bigint` for `value` and token `amount`.** Both are u64 on the wire; JS `Number` cannot hold the full u64 range.
- **No async surface.** Every function is synchronous.
- **No I/O, no globals.** Pure functions: same inputs always produce the same output.
- **Round-trip invariant.** `serializeTransaction(parseTransaction(b, v)) === b` (byte-equal) for every accepted input that is canonically encoded, has no trailing bytes under the chosen version context `v`, and whose register and context-extension values can all be written (see `parseTransaction`).

---

## See also

- `facts/transaction.md` (repo root) — load-bearing interface contract; count bounds, wire-format layout, full error taxonomy (phase 1 + phase 2 validation)
- `docs/specs/2026-06-15-ergots-transaction-validation-design.md` — umbrella design spec (phases 1–4)
- `facts/ergoscript-wire.md` — `parseErgoTreeBytes` / `parseAdditionalRegisters`; box-body grammar shared with `@ergots/ergoscript`'s SBox data parser
- `facts/scorex.md` — `ByteReader` / `ByteWriter` / `blake2b256`; shared codec layer
- `facts/ergoscript-eval.md` — `EvalError` codes; `SValue` / `SType` discriminated unions
- `facts/ergoscript-sigma.md` — `VerifyError` codes; sigma-proof verifier surface
