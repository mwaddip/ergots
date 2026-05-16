/**
 * ExtractBytesWithNoRef arm — Box → Coll[Byte] of canonical box bytes
 * WITHOUT the transaction reference (no tx_id, no index).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_bytes_with_no_ref.rs:9-25
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.bytes_without_ref()?.into(), ... }
 *
 * The serializer matches sigma-rust's `ErgoBoxCandidate` serialization —
 * Task 6's `serializeBoxBytesWithoutRef` is the shared helper
 * (wire/ergo-box-bytes.ts).
 *
 * Bytes without ref:
 *   value + ergoTree + creation_height + tokens + registers   (NO tx_id, NO index)
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]] memory).
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
