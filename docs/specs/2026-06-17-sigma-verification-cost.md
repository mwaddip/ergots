# Sigma-verification cost — `estimate_crypto_cost` + JVM block-cost accumulation

**Date:** 2026-06-17
**Status:** design approved (brainstorm), pre-implementation
**Package(s):** `@ergots/ergoscript` (new `estimateCryptoCost`), `@ergots/transaction` (`validateStateful` cost loop)
**Closes:** the last ergots-side SANTA coal — `transaction/v6/authored · cost-limit-reject` (`santa/vectors/transaction/v6/authored/cost-limit-boundary.json`).

## 1. Problem

SANTA's JVM-blessed `cost-limit-boundary` vector is a pair over the captured testnet tx `multi-input-3` (h402800, JVM validation cost **18415** block), moving only `parameters.maxBlockCost`:

| entry | maxBlockCost | JVM (rudolph) | sigma-rust (blitzen-eni) | ergots (dasher) |
|---|---|---|---|---|
| `cost-limit-accept` | 18415 | accept (cost 18415) | accept (cost 18415) | accept ✓ |
| `cost-limit-reject` | 18414 | **reject** | **reject** | **accept ✗** |

ergots over-accepts the reject case. The JVM and the SANTA sigma-rust runner (`blitzen-eni`) both produce the correct verdicts — only ergots is wrong, so ergots can faithfully follow the established model (no point-fix-vs-workstream tension).

> **Note on the sigma-rust column** — it records `blitzen-eni`'s empirical SANTA output (accept@18415 / reject@18414 with `CostLimitExceeded(4090)`; `4090 = 409 remaining-block × 10`, i.e. per-input block truncation, matching the JVM). The *vendored* `external/sigma-rust @ ergo-node-integration` **source** reads instead as a *cumulative raw-JIT* accumulator (`tx_context.rs` adds eval+crypto to one `jit_cost` limited at `maxBlockCost·10`), which would **reject@18415** — a runner-vs-source truncation-model discrepancy. ergots follows the JVM (canonical), so this does not bear on ergots' correctness; it is flagged for the SANTA reply as a possible sigma-rust consensus item (alongside the `crypto_cost.rs` threshold `+15`).

### Verified diagnosis (the handoff's framing was incomplete)

`validateStateful` **already** threads and enforces `maxBlockCost` (`stateful.ts:146,160,189`). The over-accept has **two** root causes, both confirmed by live measurement of the exact tx plus the JVM source:

1. **Deferred crypto cost.** `runningJit` excludes the sigma-verification cost (`stateful.ts:195-196`, explicit `DEFERRED` comment). For this tx that under-counts by 3 × ProveDlog = 11940 JIT (1194 block).
2. **Wrong cost units — ergots accumulates raw JIT and compares in JIT, but the JVM accumulates *block* cost with per-input truncation.** Even after adding crypto, comparing in JIT yields 184170 JIT and would **false-reject the accept case** at `maxBlockCost=18415` (184170 > 184150). The 20-JIT excess is the sum of per-input eval-cost truncation remainders the JVM discards.

A naive "just add `estimate_crypto_cost`" (the handoff's plan) therefore produces a *false-reject* of an honest tx — the worse failure direction. Both causes must be fixed together.

## 2. The JVM cost model (source-pinned)

From `sigmastate-interpreter` (canonical for v6):

- `JitCost.toBlockCost: Int = value / 10` — integer division / truncation (`data/.../ast/JitCost.scala:29`).
- `addCryptoCost(reductionRes, baseCost, costLimit)` (`interpreter/.../Interpreter.scala:280-286`):
  `cryptoCost = estimateCryptoVerifyCost(reductionRes).toBlockCost`; `fullCost = baseCost + cryptoCost` checked vs `costLimit`. Comment line 283: *"baseCost should be already scaled"* — i.e. the eval/reduction cost is `.toBlockCost`'d **separately** before the crypto cost is added.
- `estimateCryptoVerifyCost(sb): JitCost` (`Interpreter.scala:554-591`) — a recursive walk of the reduced `SigmaBoolean`.

**Net model:** per input the cost is `floor(evalJit/10) + floor(cryptoJit/10)` (each truncated independently), accumulated in **block** units onto a per-tx init cost, rejected when the running block total exceeds `maxBlockCost`.

### Boundary arithmetic (this tx — 3 inputs, each reduces to a single ProveDlog)

| term | JIT | → block (`floor/10`) |
|---|---|---|
| init | 170000 | 17000 |
| input 0 | 1974 eval + 3980 crypto | 197 + 398 = 595 |
| input 1 | 128 eval + 3980 crypto | 12 + 398 = 410 |
| input 2 | 128 eval + 3980 crypto | 12 + 398 = 410 |

`17000 + 595 + 410 + 410 = 18415` → accept at `mbc=18415`; at `mbc=18414` input 2 overflows (running 18415 > 18414) → reject on input 2, matching the JVM `CostLimitException: Estimated execution cost 410 exceeds the limit 409` and sigma-rust `CostLimitExceeded(4090)` (= 409 remaining-block × 10) verbatim.

These numbers were obtained by instrumenting the real `validateStateful` against the fixture (live evidence), then reconciled against the JVM source — not assumed.

## 3. Design

### 3.1 `estimateCryptoCost(sb: SigmaBoolean): number` — new module

- **Location:** `packages/ergoscript/src/sigma/crypto-cost.ts`, exported from `@ergots/ergoscript`. Co-located with `verifySignature` and the `SigmaBoolean` type; it is the cost-companion of the verifier ergoscript already owns, mirroring sigma-rust's placement of `crypto_cost.rs` in the interpreter crate.
- **Returns JIT units** (the caller applies `floor(·/10)`).
- **Constants — taken from the JVM `Interpreter.scala` / `SigSerializer.scala` / `UnprovenTree.scala`, NOT the vendored `crypto_cost.rs`** (see §5):

  | variant | cost (JIT) | source |
  |---|---|---|
  | `TrivialProp` | 0 | `Interpreter.scala:589` |
  | `ProveDlog` | 10 + 3400 + 570 = **3980** | `ParseChallenge_ProveDlog`(10) + `ComputeCommitments_Schnorr`(3400) + `ToBytes_Schnorr`(570) |
  | `ProveDhTuple` | 10 + 6450 + 680 = **7140** | `ParseChallenge_ProveDHT`(10) + `ComputeCommitments_DHT`(6450) + `ToBytes_DHT`(680) |
  | `Cand` | `15 + Σ children` | `ToBytes_ProofTreeConjecture`(15) |
  | `Cor` | `15 + Σ children` | `ToBytes_ProofTreeConjecture`(15) |
  | `Cthreshold` (n children, k) | `parse(nCoefs) + eval(nCoefs)·n + 15 + Σ children`, `nCoefs = n − k`, `parse(c) = 10 + 10c`, `eval(c) = 3 + 3c` | `ParsePolynomial`, `EvaluatePolynomial`, `ToBytes_ProofTreeConjecture`(15) — `Interpreter.scala:580-587` |

  Note the **threshold `+ 15`**: the JVM adds `ToBytes_ProofTreeConjecture` for `Cthreshold`; the vendored sigma-rust `crypto_cost.rs` omits it (its test asserts `11978` for 2-of-3-dlog where the JVM gives `11993`). ergots follows the JVM.

### 3.2 `validateStateful` → block-cost accumulator (Option A)

Convert the per-input cost loop from a JIT accumulator to the JVM's block-cost model:

```
runningBlock = computeInitCost(tx, deps, params)          // block units, no ×10
if (runningBlock > maxBlockCost) throw cost-limit-exceeded // init alone overflows
for each input i:
    (storage-rent inputs: add 0, continue)
    headroom = (maxBlockCost - runningBlock) * 10          // JIT ceiling for reduction (spam guard)
    result = evaluateWith(tree, ctx{ jitCostLimit: headroom, ... })   // mid-reduction limit fires in JIT, unchanged mechanism
    cryptoJit = estimateCryptoCost(result.value)
    runningBlock += Math.floor(ctx.jitCost / 10) + Math.floor(cryptoJit / 10)
    if (runningBlock > maxBlockCost)
        throw TxValidationError('cost-limit-exceeded', { inputIndex: i })   // NEW explicit per-input block check
    verifySignature(...)
```

Key points:
- `runningBlock` is **block** units (init is already block; the `JIT_COST_PER_BLOCK_COST` ×10 on init is dropped).
- The mid-reduction JIT headroom keeps ergots' existing, capstone-walk-validated mechanism — only its derivation changes (`(maxBlockCost − runningBlock) × 10`). It is a ceiling that fires only for a single pathologically expensive input; the boundary verdict is gated by the new block check.
- **The new explicit `runningBlock > maxBlockCost` check after each input is load-bearing** — today the only cost-limit throw after init is *inside* `evaluateWith` via the headroom, so without this check the last input's crypto cost would never trigger a reject (exactly the boundary case).
- Error class is ergots' choice (`TxValidationError('cost-limit-exceeded')`, consistent with the existing init check at `stateful.ts:161`); only the accept/reject verdict is consensus-relevant. The mid-reduction `EvalError('cost-limit-exceeded')` continues to surface unwrapped.

### 3.3 Why Option A (block) over a minimal JIT-rounding patch

Both produce identical verdicts. Block units match the JVM structurally — anyone diffing ergots against `Interpreter.scala` sees the same model, and the JVM/sigma-rust exceptions speak block cost. Working in block also makes ergots robust to sub-10-JIT eval-cost differences (truncated away), which the block-cost capstone walks could not have detected anyway.

## 4. Validation strategy

1. **Unit tests for `estimateCryptoCost`** against the JVM test values: `TrivialProp` 0, `ProveDlog` 3980, `ProveDhTuple` 7140, `Cand`/`Cor` two-dlog `15 + 3980 + 3980 = 7975`, `Cthreshold` 2-of-3-dlog **11993** (`20 + 18 + 15 + 11940` — note `+15`, diverging from the vendored sigma-rust test's 11978). Nested cases for recursion.
2. **Vendor the SANTA `cost-limit-boundary` vector** into transaction's conformance corpus (`test/fixtures/conformance/transaction/`), driving both entries through `validateStateful`: accept@18415, reject@18414 with `cost-limit-exceeded` on input 2. This is the cross-impl pin (JVM + sigma-rust agree).
3. **Capstone re-walk (regression gate).** Re-run the testnet genesis→tip `--mode lib` walk; the cost now includes crypto + block truncation. Honest txs sit far below the ceiling, and truncation only lowers ergots' effective cost, so no new false-rejects are expected — but the walk is the empirical proof. (Mainnet `:9052` deferred per current node status.)

## 5. Consensus risks & residuals

- **Over-count = false-reject (worse than the current over-accept).** The constants and the threshold `+15` must be byte-exact to the JVM. Mitigated by §4.1 unit values + the boundary fixture + the walk.
- **Vendored sigma-rust `crypto_cost.rs` threshold divergence.** It omits the `+15 ToBytes_ProofTreeConjecture` for `Cthreshold` — a latent under-count (≤1 block after `toBlockCost`, never hit on mainnet since txs don't sit at the exact ceiling). Unexercised by the all-ProveDlog boundary vector. ergots takes the JVM value; flagged to SANTA for sigma-rust to fix (§6).
- **Mid-reduction headroom for pathological multi-input near-ceiling txs (residual, adversarial-only).** The exact JVM reduction-limit derivation lives in the ergo-core per-input loop (`ErgoTransaction.validateStateful`), which is not locally available; ergots keeps its existing walk-validated headroom mechanism, re-derived in block. The boundary fixture + capstone walk are the gates; any divergence here would be a sub-block, exact-ceiling, multi-input adversarial edge — tracked, not blocking.

## 6. Docs & follow-ups

- **Contract-first:** `facts/ergoscript-sigma.md` gains an `estimateCryptoCost` entry (signature, JIT units, constants table, threshold-`+15` note); `facts/transaction.md` updates the cost model from "JIT accumulator, crypto deferred" to "block-cost accumulator incl. crypto."
- `packages/ergoscript/API.md` + `packages/transaction/API.md`; READMEs as needed.
- **Public API:** `estimateCryptoCost` is an additive export on the published `@ergots/ergoscript` → minor version bump (0.4.0 → 0.5.0) at the next republish; transaction consumes it via the built `dist/`.
- **SANTA reply** (user-routed): correct the cost-ceiling diagnosis (ergots already enforces `maxBlockCost`; the gap was deferred crypto + missing per-input block truncation, now fixed) and flag the `crypto_cost.rs` threshold `+15` for sigma-rust.

## 7. Out of scope

- No change to the verifier (`verifySignature`) or the evaluator's per-op cost model — both are already capstone-validated.
- No mainnet walk (node down); testnet is the regression gate.
- The ergo-core reduction-limit exact derivation (residual §5) — not pursued unless a future adversarial fixture demands it.
