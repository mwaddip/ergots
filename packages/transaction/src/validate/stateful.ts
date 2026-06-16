import type { ErgoLikeTransaction, StatefulDeps, ChainParameters } from '../types';
import type { ErgoBox } from '@ergots/ergoscript';
import { ByteWriter, blake2b256 } from '@ergots/scorex';
import { serializeSValue, parseTree, evaluateWith, verifySignature } from '@ergots/ergoscript';
import { TxValidationError } from '../errors';
import { MAX_BOX_SIZE, MAX_SCRIPT_SIZE, INTERPRETER_INIT_COST, resolveParameters } from '../params';
import { hex, bytesEqual, I64_MAX } from './_bytes';
import { transactionId, signingMessage } from '../wire/signing-message';
import { buildHeadersArray, promoteCandidate, buildInputContext, JIT_COST_PER_BLOCK_COST } from '../context';
import { checkStorageRent } from './storage-rent';

/** Canonical serialized bytes of a full box (incl. txId+index), at the box's own tree
 *  version — mirrors the proven harness `serializedBoxLen`. */
function serializeBox(box: ErgoBox): Uint8Array {
  const tv = box.ergoTreeBytes.length > 0 ? (box.ergoTreeBytes[0]! & 0x07) : 0;
  const w = new ByteWriter();
  serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, tv, w);
  return w.toBytes();
}
/** Box id = blake2b256(box's sigma_serialize bytes incl. txId+index). ergo_box.rs:141,182-185. */
export function computeBoxId(box: ErgoBox): Uint8Array { return blake2b256(serializeBox(box)); }

/** Structural / accounting checks (no script eval). Mirrors the non-eval portion of
 *  sigma-rust TransactionContext::validate() + verify_output. Exported for unit testing;
 *  validateStateful (Task 7) calls it, then runs the per-input verify loop. */
export function checkStructural(tx: ErgoLikeTransaction, deps: StatefulDeps, params: ChainParameters): void {
  // 1 — input-box provisioning (ordered): count + computed box id, inputs then data-inputs.
  if (deps.inputBoxes.length !== tx.inputs.length) {
    throw new TxValidationError(`inputBoxes ${deps.inputBoxes.length} != inputs ${tx.inputs.length}`, 'input-box-count-mismatch');
  }
  for (let i = 0; i < tx.inputs.length; i++) {
    if (!bytesEqual(computeBoxId(deps.inputBoxes[i]!), tx.inputs[i]!.boxId)) {
      throw new TxValidationError(`input box id mismatch at ${i}`, 'input-box-id-mismatch', { inputIndex: i, boxId: tx.inputs[i]!.boxId });
    }
  }
  if (deps.dataInputBoxes.length !== tx.dataInputs.length) {
    throw new TxValidationError(`dataInputBoxes ${deps.dataInputBoxes.length} != dataInputs ${tx.dataInputs.length}`, 'data-input-box-mismatch');
  }
  for (let i = 0; i < tx.dataInputs.length; i++) {
    if (!bytesEqual(computeBoxId(deps.dataInputBoxes[i]!), tx.dataInputs[i]!.boxId)) {
      throw new TxValidationError(`data-input box id mismatch at ${i}`, 'data-input-box-mismatch', { inputIndex: i, boxId: tx.dataInputs[i]!.boxId });
    }
  }

  // 2 — input value sum must not overflow i64 (sigma-rust BoxValue::new(Σ)).
  let inSum = 0n; for (const b of deps.inputBoxes) inSum += b.value;
  if (inSum > I64_MAX) throw new TxValidationError(`input value sum ${inSum} overflows i64`, 'input-sum-overflow');

  // 3 — value conservation: Σin === Σout (strict; Ergo has no fee field).
  let outSum = 0n; for (const o of tx.outputCandidates) outSum += o.value;
  if (inSum !== outSum) throw new TxValidationError(`value not conserved: in ${inSum} != out ${outSum}`, 'value-not-conserved');

  // 4 — output well-formedness (verify_output). Monotonic basis: max input height post-v3, else 0.
  const blockHeight = deps.stateContext.preHeader.height;
  const blockVersion = deps.stateContext.preHeader.version;
  let maxInputHeight = 0;
  if (blockVersion >= 3) for (const b of deps.inputBoxes) if (b.creationHeight > maxInputHeight) maxInputHeight = b.creationHeight;
  for (let i = 0; i < tx.outputCandidates.length; i++) {
    const o = tx.outputCandidates[i]!;
    const boxSize = serializeBox({ ...o, txId: new Uint8Array(32), index: i }).length; // real index i is used; only txId is dummied — a real txId is also exactly 32 bytes, so boxSize is exact
    const scriptSize = o.ergoTreeBytes.length;
    // dust
    const minValue = BigInt(boxSize) * BigInt(params.minValuePerByte);
    if (o.value < minValue) throw new TxValidationError(`output ${i} value ${o.value} < min ${minValue}`, 'output-below-min-value', { outputIndex: i });
    // future height — SIGNED i32 compare (sigma-rust `creation_height as i32 > height as i32`)
    if ((o.creationHeight | 0) > (blockHeight | 0)) throw new TxValidationError(`output ${i} creationHeight ${o.creationHeight} > block ${blockHeight}`, 'creation-height-in-future', { outputIndex: i });
    // monotonic (post-v3): output height >= max input height
    if (o.creationHeight < maxInputHeight) throw new TxValidationError(`output ${i} creationHeight ${o.creationHeight} < max input height ${maxInputHeight}`, 'creation-height-below-max-input', { outputIndex: i });
    // negative (post-v1): the i32 sign bit set
    if (blockVersion !== 1 && (o.creationHeight | 0) < 0) throw new TxValidationError(`output ${i} creationHeight negative`, 'creation-height-negative', { outputIndex: i });
    // box / script size caps (4096)
    if (boxSize > MAX_BOX_SIZE) throw new TxValidationError(`output ${i} box size ${boxSize} > ${MAX_BOX_SIZE}`, 'box-size-exceeded', { outputIndex: i });
    if (scriptSize > MAX_SCRIPT_SIZE) throw new TxValidationError(`output ${i} script size ${scriptSize} > ${MAX_SCRIPT_SIZE}`, 'script-size-exceeded', { outputIndex: i });
  }

  // 5 — token conservation (extract_assets + verify_assets, tx_context.rs:341-372).
  const inTok = new Map<string, bigint>();
  for (const b of deps.inputBoxes) for (const t of b.tokens) {
    const next = (inTok.get(hex(t.id)) ?? 0n) + t.amount;
    if (next > I64_MAX) throw new TxValidationError(`input token ${hex(t.id)} amount overflows i64`, 'token-amount-invalid');
    inTok.set(hex(t.id), next);
  }
  const outTok = new Map<string, bigint>();
  for (const o of tx.outputCandidates) for (const t of o.tokens) {
    const next = (outTok.get(hex(t.id)) ?? 0n) + t.amount;
    if (next > I64_MAX) throw new TxValidationError(`output token ${hex(t.id)} amount overflows i64`, 'token-amount-invalid');
    outTok.set(hex(t.id), next);
  }
  const newTokenId = hex(tx.inputs[0]!.boxId);   // a minted token's id must equal the first input box id
  for (const [id, outAmt] of outTok) {
    const inAmt = inTok.get(id);
    if (inAmt === undefined) {
      if (id !== newTokenId) throw new TxValidationError(`minted token ${id} id != first input box id`, 'invalid-minted-token');
    } else if (outAmt > inAmt) {
      throw new TxValidationError(`token ${id} out ${outAmt} > in ${inAmt}`, 'token-not-conserved');
    }
  }
}

/** (totalTokenEntries, distinctTokenCount) across boxes. tx_context.rs count_tokens (:112-123). */
function countTokens(boxes: { tokens: { id: Uint8Array }[] }[]): { entries: number; distinct: number } {
  let entries = 0;
  const ids = new Set<string>();
  for (const b of boxes) for (const t of b.tokens) { entries++; ids.add(hex(t.id)); }
  return { entries, distinct: ids.size };
}

/** Per-tx init/structural cost in BLOCK-cost units. compute_tx_init_cost (tx_context.rs:126-145). */
function computeInitCost(tx: ErgoLikeTransaction, deps: StatefulDeps, params: ChainParameters): number {
  const structural = INTERPRETER_INIT_COST
    + tx.inputs.length * params.inputCost
    + tx.dataInputs.length * params.dataInputCost
    + tx.outputCandidates.length * params.outputCost;
  const inTok = countTokens(deps.inputBoxes);
  const outTok = countTokens(tx.outputCandidates);
  const tokenCost = (inTok.entries + outTok.entries + inTok.distinct + outTok.distinct) * params.tokenAccessCost;
  return structural + tokenCost;
}

/**
 * Full stateful validation: structural/accounting checks, then the per-input
 * verify loop (parse tree → build context → evaluate → verifySignature) with
 * the real `validate()` cost model. Lift of the mainnet-proven harness
 * `validate-tx.ts:658-911` (oracle machinery removed) + sigma-rust
 * `TransactionContext::validate` (tx_context.rs:148-268).
 *
 * Cost model: a per-tx init/structural cost (block units → JIT ×10) is charged
 * up front into a SINGLE cumulative accumulator (`runningJit`); each input's
 * context receives the remaining headroom (`jitCostLimit − runningJit`) as its
 * own `jitCostLimit`, so the budget fires mid-tx (matching the shared,
 * never-reset `context.jit_cost_limit` of `validate()`). The sigma-verification
 * cost (`estimate_crypto_cost`) is DEFERRED — ergots' verifier exposes no cost
 * surface, so phase-2 cost under-counts by exactly that term (documented
 * residual; the capstone re-walk is the gate).
 *
 * Errors surface UNWRAPPED: eval (`EvalError`, incl. `'cost-limit-exceeded'`)
 * and verify (`VerifyError`) errors propagate as-is; only the validator's own
 * structural verdicts are `TxValidationError`.
 */
export function validateStateful(tx: ErgoLikeTransaction, deps: StatefulDeps): void {
  const params = resolveParameters(deps.stateContext.parameters);
  checkStructural(tx, deps, params);

  const headers = buildHeadersArray(deps.stateContext.headers);
  const preHeader = deps.stateContext.preHeader;
  const jitCostLimit = params.maxBlockCost * JIT_COST_PER_BLOCK_COST;
  const txId = transactionId(tx);
  const msg = signingMessage(tx);
  const outputs = tx.outputCandidates.map((c, i) => promoteCandidate(c, txId, i));

  // Per-tx init/structural cost (block units) → JIT (×10), charged up front into the cumulative
  // accumulator. If init alone exceeds the budget, reject (sigma-rust InitCostExceeded).
  const initJit = computeInitCost(tx, deps, params) * JIT_COST_PER_BLOCK_COST;
  if (initJit > jitCostLimit) {
    throw new TxValidationError(`init cost ${initJit} > limit ${jitCostLimit}`, 'cost-limit-exceeded');
  }
  let runningJit = initJit;   // ONE cumulative accumulator across all inputs

  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i]!;
    const selfBox = deps.inputBoxes[i]!;
    const ergoTreeBytes = selfBox.ergoTreeBytes;
    const treeVersion = ergoTreeBytes.length > 0 ? (ergoTreeBytes[0]! & 0x07) : 0;
    const extension = input.spendingProof.contextExtension;
    const location = { inputIndex: i, boxId: input.boxId };

    // storage-rent first (empty proof only) — cost 0, no eval/verify (sigma-rust try_spend_storage_rent).
    if (input.spendingProof.proofBytes.length === 0) {
      if (checkStorageRent(selfBox, preHeader.height, extension, outputs, treeVersion, params.storageFeeFactor)) {
        continue;
      }
    }

    const tree = parseTree(ergoTreeBytes);   // parse errors surface unwrapped
    // Cumulative limit: this input may consume only the remaining headroom; an overrun throws
    // EvalError 'cost-limit-exceeded' (unwrapped), matching validate()'s mid-tx limit firing.
    const ctx = buildInputContext({
      height: preHeader.height, selfBox, inputs: deps.inputBoxes, outputs, dataInputs: deps.dataInputBoxes,
      preHeader, headers, extension, jitCostLimit: jitCostLimit - runningJit, treeVersion, constants: tree.constants,
    });
    const result = evaluateWith(tree, ctx);  // EvalError surfaces unwrapped (incl. cost-limit-exceeded)
    runningJit += ctx.jitCost;
    // DEFERRED: sigma-verification cost (estimate_crypto_cost) — ergots' verifier exposes no cost surface;
    // phase-2 cost under-counts by it (documented residual; capstone re-walk is the gate).
    if (result.kind !== 'SigmaProp') {
      throw new TxValidationError(`input ${i} reduced to ${result.kind}, not SigmaProp`, 'non-sigmaprop-result', location);
    }
    const ok = verifySignature(result.value, msg, input.spendingProof.proofBytes);  // VerifyError surfaces unwrapped
    if (!ok) throw new TxValidationError(`input ${i} script reduced to false`, 'script-reduced-false', location);
  }
}
