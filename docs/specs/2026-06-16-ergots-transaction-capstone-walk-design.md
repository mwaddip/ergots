# `@ergots/transaction` capstone — testnet false-reject walk design

**Date:** 2026-06-16
**Status:** Design (pre-implementation)
**Package / phase:** `@ergots/transaction` — phase 3 (the capstone integration walk)
**Builds on:** phase-2 validation logic (`validateStateless` / `validateStateful` / `TxValidationError`, branch
`transaction-tier`, HEAD `ba76c3c`) + phase-1 wire codec (`parseTransaction`); reuses the mainnet-validate
harness walker (`tools/mainnet-validate/harness/`).

## Scope

Prove that the library's `parseTransaction` + `validateStateful` **accept every real on-chain testnet
transaction**, genesis→tip, as the definitive regression net for the transaction tier.

**In:**
- A `--mode lib` walk in the existing harness that, per transaction, parses it with the library and runs
  `validateStateful` against deps assembled from the node, asserting it accepts.
- The genesis→testnet-tip walk itself (the regression artifact).

**Out (this phase):**
- **Cost equivalence / a JVM or WASM oracle.** The library is oracle-free and `validateStateful` returns
  `void`; this walk validates accept/reject only. (Closing the deferred `estimate_crypto_cost` is separate
  work — implement a verifier cost surface + an oracle comparison — not part of the capstone.)
- **Storage-rent coverage.** Testnet (~403k blocks) is younger than the 1,051,200-block storage period, so
  it has no storage-rent spends; that branch stays covered by the phase-2 unit tests and a future **mainnet**
  walk (a `--node-url` swap to `:9052` when that node is up) — the explicit follow-up.
- **False-accepts.** Only network-valid txs live in blocks, so a walk can only catch false-*rejects*. False-
  accepts are the adversarial mutation suite's job (phase 2).

## Key decisions (from the brainstorm)

1. **Focused false-reject sweep, chain-as-oracle.** Every transaction in a block was accepted by the network,
   so the chain is the oracle: `validateStateful` must accept it. A throw is a finding to fix. No JVM/WASM
   oracle, no cost comparison — much simpler than the walker-JVM-oracle workstream.
2. **New coverage = the library on top of eval.** The walker-JVM-oracle run already walked testnet v6
   (h=2→400,159, ~608k inputs, 0 not-impl, 0 crash) through the same ergoscript evaluator + sigma verifier
   the library calls. The capstone's genuinely-new coverage is the **accounting** (`checkStructural`), the
   **cost model** (init + cumulative), the **context-build helpers**, the **`validateStateful` integration**,
   and the **wire codec** (`parseTransaction`) — at scale over real txs.
3. **`--mode lib` reuses the proven walker.** `main.ts` / `validate-block.ts` keep the block loop, checkpoint/
   resume, rolling-headers, bundle assembly, and halt-on-divergence + `error-report`. A new `validate-tx-lib.ts`
   replaces the per-tx step in lib-mode; the existing oracle `validate-tx.ts` is untouched (the cost walk
   stays available). The WASM **cost** oracle (`wasm-oracle.ts` `computeTxOracleCosts`) is not invoked in
   lib-mode — ergo-lib-wasm is still used only to *serialize* each tx for step 1 (the established
   `gen-tx-fixtures` dev-tooling path; not a new WASM surface).
4. **Serialize → parse, to exercise the wire codec too.** The harness `TxBundle` carries no raw serialized
   tx bytes, so per tx the lib path serializes the node's tx JSON to bytes via the existing `gen-tx-fixtures`
   ergo-lib-wasm path (or fetches node binary if available), then runs the library's `parseTransaction`. This
   walks the wire codec end-to-end (phase 1 only fixture-tested it on 5 txs) and yields the parsed
   `ErgoLikeTransaction` `validateStateful` consumes.
5. **Testnet-first; mainnet is a node-url swap.** The wire-in is node-agnostic, so the future mainnet walk
   (storage-rent + 4.4× scale) needs no new code — just `--node-url http://localhost:9052`.

## Architecture — modules

| Module | Responsibility |
|---|---|
| `tools/mainnet-validate/harness/src/validate-tx-lib.ts` (create) | The lib-mode per-tx step: serialize→`parseTransaction`, build `StatefulDeps` from the bundle, `validateStateful`, map any throw to a `HarnessError`-style halt. |
| `main.ts` / `validate-block.ts` (modify) | Add a `--mode lib` flag that routes the per-tx step to `validate-tx-lib` instead of `validate-tx`; everything else (loop, checkpoint, rolling-headers, bundle assembly, error-report) unchanged. |
| `harness/package.json` (modify) | Add `@ergots/transaction` (`file:../../../packages/transaction`) to deps; rebuild the package's `dist/` before the walk. |
| `validate-tx-lib.test.ts` (create) | Unit test: the deps builder produces the correct `inputBoxes`/`dataInputBoxes`/`headers`/`preHeader`/`parameters` shape from a sample bundle (no live node). |

## Per-transaction flow (`validate-tx-lib.ts`), for a tx in block H

1. **Tx bytes → library tx.** Serialize the node's tx JSON to bytes (reuse the `gen-tx-fixtures` ergo-lib-wasm
   serialization; or node binary if the REST exposes it), then `tx = parseTransaction(bytes)`.
2. **Build `StatefulDeps`:**
   - `inputBoxes` = each input's `spentBoxBytes` parsed to `ErgoBox` (ergoscript `parseSValue({tag:'SBox'},0).value`).
   - `dataInputBoxes` = the bundle's data-input box bytes parsed the same way (ordered to match `tx.dataInputs`).
   - `stateContext.headers` = the 10 headers **preceding** H (H-1…H-10, newest-first) from the walker's
     rolling-headers (`rollingHeaders.slice(1)`); `stateContext.preHeader` = **block H's own header**
     (`preHeaderFromHeader`-equivalent); `stateContext.parameters` = `{ maxBlockCost }` from the bundle, the
     rest left to `DEFAULT_PARAMETERS` via `resolveParameters`.
   - Height 1 (no preceding header) is **skipped**, mirroring `validate-tx`; the effective walk is height 2→tip.
3. **`validateStateful(tx, deps)`.** No throw → the tx passed. Any throw → halt (step 4).

## Divergence handling

Because every on-chain tx is network-valid, **any** throw is a finding:
- a `TxValidationError` → the accounting wrongly rejected a valid tx (a structural-rule false-reject);
- an unwrapped `EvalError` / `VerifyError` / scorex `ReaderError` / ergoscript `SValueSerializeError` → a
  context-build, wire-codec, or cost gap surfacing through the library.

On a throw the walk writes an `error-report` sidecar (reuse `error-report.ts`) carrying height, txId, input
index (if applicable), the error code/class, and the message, then halts — the **halt-fix-resume** cadence
from the T7 walker (auto-resume on a clean chunk-cap when the user is away; halt for investigation on a
divergence). Resume uses the existing checkpoint.

## Operation

- **Scope:** height 2 → testnet tip (currently ~403k). Resumable via `checkpoint.ts`.
- **Launch:** `node dist/main.js --mode lib --node-url http://localhost:9053 --indexer-url
  http://localhost:9054 --start-height 2` (exact flags to match `main.ts`'s CLI during implementation).
- **Done state:** a clean genesis→tip lib-mode walk (zero halts). That is the phase-3 completion bar for
  testnet. Mainnet (storage-rent + scale) is the documented follow-up, not a phase-3 blocker.

## Testing strategy

- **The walk is the regression test** — thousands of real txs through `parseTransaction` + `validateStateful`,
  far beyond phase-2's 2 fixtures + adversarial suite.
- **One unit test** (`validate-tx-lib.test.ts`): the deps builder yields the correct `StatefulDeps` shape from
  a hand-built sample bundle (inputBoxes/dataInputBoxes parsed, headers = preceding-10, preHeader = block H,
  params defaulted), so the wiring is covered without a live node.
- The existing harness tests stay green; the package gate (transaction 58 + monorepo) is unchanged (the walk
  is dev tooling, not a `packages/*/src/` change).

## Risks / open items

- **Params default.** Only `maxBlockCost` comes from the bundle; the rest (esp. `minValuePerByte` for the dust
  threshold, the per-element cost params) default to sigma-rust's. Accurate on testnet (it runs the defaults);
  a dust/cost false-reject would mean checking whether testnet's *active* params diverge from defaults. Low
  risk; flagged so a false-reject there is triaged correctly.
- **Data-input ordering.** The bundle's `dataInputBoxes` must be in the same order as the parsed tx's
  `dataInputs` for the box-id provisioning check; verify against the first tx that carries data-inputs.
- **Serialize→parse path.** Phase 1 proved the library's `parseTransaction` round-trips ergo-lib-wasm-serialized
  testnet v6 txs byte-identically, so the serialize-then-parse step is sound; if a tx fails to serialize via
  ergo-lib-wasm, fall back as `gen-tx-fixtures` does (or fetch node binary).
- **Cost under-count is safe.** The deferred crypto-cost only ever under-counts the accumulator, so it can
  never cause a false-reject on this walk.
- **Storage-rent gap.** Uncovered on testnet (noted in Scope); the mainnet walk closes it.

## After phase 3

Once the testnet walk is clean: the mainnet walk (node-url swap) closes storage-rent + adds scale; the
deferred `estimate_crypto_cost` cost surface + an oracle cost comparison is its own separate effort; then
`@ergots/transaction` publish prep.
