import type { ErgoLikeTransaction } from '../types';
import { TxValidationError } from '../errors';
import { hex, I64_MAX } from './_bytes';

/**
 * Stateless (transaction-alone) checks. CONFIRMED minimal vs sigma-rust
 * `ErgoTransaction::validate_stateless` (ergo_transaction.rs:99-116): output value
 * sum no-overflow + no duplicate input box ids. Non-emptiness is structural (the wire
 * BoundedVec[1,32767]); re-checked here so an in-memory-constructed tx is covered.
 * NOT stateless: output value > 0 (BoxValue newtype + stateful dust), creationHeight
 * range (stateful verify_output), tx size (no such rule in sigma-rust at all).
 */
export function validateStateless(tx: ErgoLikeTransaction): void {
  if (tx.inputs.length === 0) throw new TxValidationError('transaction has no inputs', 'inputs-empty');
  if (tx.outputCandidates.length === 0) throw new TxValidationError('transaction has no outputs', 'outputs-empty');

  // Output value sum must not overflow i64 (sigma-rust checked-add fold).
  let sum = 0n;
  for (let i = 0; i < tx.outputCandidates.length; i++) {
    sum += tx.outputCandidates[i]!.value;
    if (sum > I64_MAX) throw new TxValidationError('output value sum overflows i64', 'output-sum-overflow', { outputIndex: i });
  }

  // No duplicate input box ids.
  const seen = new Set<string>();
  for (let i = 0; i < tx.inputs.length; i++) {
    const k = hex(tx.inputs[i]!.boxId);
    if (seen.has(k)) throw new TxValidationError(`duplicate input box id at ${i}`, 'duplicate-input', { inputIndex: i });
    seen.add(k);
  }
}
