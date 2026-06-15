import type { ErgoLikeTransaction, StatefulDeps, ChainParameters } from '../types';
import type { ErgoBox } from '@ergots/ergoscript';
import { ByteWriter, blake2b256 } from '@ergots/scorex';
import { serializeSValue } from '@ergots/ergoscript';
import { TxValidationError } from '../errors';
import { MAX_BOX_SIZE, MAX_SCRIPT_SIZE } from '../params';
import { hex, bytesEqual, I64_MAX } from './_bytes';

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
    const boxSize = serializeBox({ ...o, txId: new Uint8Array(32), index: i }).length; // txId/index fixed 34B → size is dummy-independent
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
