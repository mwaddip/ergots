/**
 * ExtractBytesWithNoRef arm — Box → Coll[Byte] of CANONICAL candidate bytes
 * WITHOUT the transaction reference (no tx_id, no index).
 *
 * DELIBERATELY ASYMMETRIC vs the ExtractBytes/ExtractId retained basis
 * (F5 batch 4 addendum): the JVM ALWAYS re-serializes the candidate here —
 * CBox.scala:26 `bytesWithoutRef = Colls.fromArray(ebox.bytesWithNoRef)` →
 * ErgoBoxCandidate.scala:54 `bytesWithNoRef =
 * ErgoBoxCandidate.serializer.toBytes(this)`. No retained candidate slice
 * exists JVM-side, so a garbage register encoding is NORMALIZED AWAY (the
 * garbage/canonical twins converge byte-identical) and the result is NOT a
 * retained-minus-tail slice. Blessed pins:
 * conformance/v5/Box.bytes_byte_basis.json (bytesnoref-* entries).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_bytes_with_no_ref.rs:9-25
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.bytes_without_ref()?.into(), ... }
 *
 * The serializer matches the JVM `serializeBodyWithIndexedDigests`
 * (ErgoBoxCandidate.scala:138-181, tokensInTx=None) field-by-field —
 * Task 6's `serializeBoxBytesWithoutRef` is the shared helper
 * (wire/ergo-box-bytes.ts → writeBoxBodyWithoutRef):
 *   value (VLQ u64) + ergoTree bytes + creation_height (VLQ u32)
 *   + tokens (raw u8 count; 32-byte id + VLQ u64 amount each)
 *   + registers (raw u8 count; Constant-or-Expr wire each — opaque-verbatim for parsed non-Const registers)   (NO tx_id, NO index)
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]] memory). JVM costKind:
 * FixedCost(JitCost(12)) (transformers.scala:460).
 */

import type { ExtractBytesWithNoRef, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { serializeBoxBytesWithoutRef } from '../wire/ergo-box-bytes'

// Cost source: sigma-rust eval/extract_bytes_with_no_ref.rs:15 — ctx.add_jit_cost(12)?
// Pattern A (envelope BEFORE eval-child).
const EXTRACT_BYTES_WITH_NO_REF_COST = 12

export function evalExtractBytesWithNoRef(
  e: ExtractBytesWithNoRef,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_BYTES_WITH_NO_REF_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractBytesWithNoRef: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  return bytesToCollByteSValue(serializeBoxBytesWithoutRef(input.value))
}
