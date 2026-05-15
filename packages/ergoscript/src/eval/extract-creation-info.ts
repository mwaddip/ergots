/**
 * ExtractCreationInfo arm — Box → Tuple[Int, Coll[Byte]] where the
 * Coll[Byte] is a 34-byte concat: 32-byte txId + BE u16 of box index.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_creation_info.rs:9-25
 *   ctx.add_jit_cost(16)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.creation_info().into(), ... }
 *
 * `creation_info` (sigma-rust `chain/ergo_box.rs:185-192`):
 *   bytes = txId (32 bytes) ++ index.to_be_bytes()   (2 bytes; u16 BE)
 *   return (creation_height as i32, bytes)
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]] memory).
 *
 * The synthesis helper `creationInfoTupleSValue` is shared with
 * `ExtractRegisterAs` (R3 case) — promoted from Task 4's local function to
 * `eval/_box-synthesis.ts` to avoid duplication. See Task 5 notes.
 *
 * New error codes reused from Task 2:
 *   'extract-input-not-box'  — input is not a Box (defensive kind-check)
 */

import type { ExtractCreationInfo, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { creationInfoTupleSValue } from './_box-synthesis'

// Cost source: sigma-rust eval/extract_creation_info.rs:15 — ctx.add_jit_cost(16)
// Pattern A (envelope BEFORE eval-child).
const EXTRACT_CREATION_INFO_COST = 16

export function evalExtractCreationInfo(
  e: ExtractCreationInfo,
  env: Env,
  ctx: EvalContext
): SValue {
  // Pattern A: cost BEFORE eval-child.
  ctx.addCost(EXTRACT_CREATION_INFO_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractCreationInfo: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  return creationInfoTupleSValue(input.value)
}
