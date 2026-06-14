/**
 * ExtractId arm — Box → Coll[Byte] of the 32-byte blake2b-256 box id,
 * hashed over the JVM `.bytes` basis (retained parse slice, canonical
 * re-serialization only for constructed boxes).
 *
 * JVM (canonical): CBox.scala:24 `id = Colls.fromArray(ebox.id)` →
 * ErgoBox.scala:73 `id = Blake2b256.hash(bytes)` over the :87-92 retained-
 * or-reserialize basis. Shared with the ExtractBytes arm and box-EQ via
 * Task 4's `boxIdOf`/`boxBytesOf` (eval/_box-id.ts, WeakMap-memoized like
 * the JVM lazy val) — `Box.id == blake2b256(Box.bytes)` by construction
 * (F5 batch 4 addendum, blessed pins: conformance/v5/Box.bytes_byte_basis.json).
 *
 * Sigma-rust ref (cost only): ergotree-interpreter/src/eval/extract_id.rs:10-28
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A). JVM costKind:
 * FixedCost(JitCost(12)) (transformers.scala:479).
 */

import type { ExtractId, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { boxIdOf } from './_box-id'

// Cost source: sigma-rust eval/extract_id.rs:16 — ctx.add_jit_cost(12)?
// Pattern A (envelope BEFORE eval-child).
const EXTRACT_ID_COST = 12

export function evalExtractId(e: ExtractId, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(EXTRACT_ID_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractId: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  // No aliasing: bytesToCollByteSValue materializes per-item Byte SValues,
  // so boxIdOf's memoized array is never exposed to the script.
  return bytesToCollByteSValue(boxIdOf(input.value))
}
