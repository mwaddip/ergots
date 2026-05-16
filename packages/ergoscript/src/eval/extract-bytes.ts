/**
 * ExtractBytes arm — Box → Coll[Byte] of canonical box bytes.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_bytes.rs:9-25
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.sigma_serialize_bytes()?.into(), ... }
 *
 * The serializer matches sigma-rust's `sigma_serialize for ErgoBox` exactly —
 * Task 6's `serializeBoxBytes` is the shared helper (wire/ergo-box-bytes.ts).
 *
 * Full canonical bytes:
 *   value + ergoTree + creation_height + tokens + registers + tx_id + index
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]] memory).
 */

import type { ExtractBytes, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { serializeBoxBytes } from '../wire/ergo-box-bytes'

// Cost source: sigma-rust eval/extract_bytes.rs:16 — ctx.add_jit_cost(12)?
// Pattern A (envelope BEFORE eval-child).
const EXTRACT_BYTES_COST = 12

export function evalExtractBytes(
  e: ExtractBytes,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_BYTES_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractBytes: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  return bytesToCollByteSValue(serializeBoxBytes(input.value))
}
