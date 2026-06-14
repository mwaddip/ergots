/**
 * ExtractBytes arm — Box → Coll[Byte] of the JVM `.bytes` basis: the
 * parse-RETAINED slice (a garbage register encoding SURVIVES), canonical
 * re-serialization only for constructed boxes.
 *
 * JVM (canonical): CBox.scala:25 `bytes = Colls.fromArray(ebox.bytes)` →
 * ErgoBox.scala:87-92 — `_bytes` provided by the deserializer (the consumed
 * span, captured at :214-225) when the box was parsed; full
 * `ErgoBox.sigmaSerializer.toBytes(this)` otherwise. `boxBytesOf`
 * (eval/_box-id.ts) is that ONE basis function, shared with `boxIdOf` so
 * `Box.id == blake2b256(Box.bytes)` can never drift (F5 batch 4 addendum,
 * blessed pins: conformance/v5/Box.bytes_byte_basis.json).
 *
 * Sigma-rust ref (cost only): ergotree-interpreter/src/eval/extract_bytes.rs:9-25
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *
 * Constructed-box fallback layout (serializeBoxBytes, wire/ergo-box-bytes.ts):
 *   value + ergoTree + creation_height + tokens + registers + tx_id + index
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]] memory). JVM costKind:
 * FixedCost(JitCost(12)) (transformers.scala:440).
 */

import type { ExtractBytes, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { boxBytesOf } from './_box-id'

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
  // No aliasing: bytesToCollByteSValue materializes per-item Byte SValues,
  // so the box's retainedBytes array is never exposed to the script.
  return bytesToCollByteSValue(boxBytesOf(input.value))
}
