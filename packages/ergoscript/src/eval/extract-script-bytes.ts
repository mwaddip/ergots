/**
 * ExtractScriptBytes arm — Box → Coll[Byte] of the box's serialized
 * guarding script (its ErgoTree canonical bytes).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_script_bytes.rs:9-25
 *   ctx.add_jit_cost(10)?;                           // BEFORE eval-child
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v { Value::CBox(b) => b.script_bytes()?.into(), ... }
 *
 * `box.script_bytes()` in sigma-rust serializes the inner ErgoTree via
 * `box.ergo_tree.sigma_serialize_bytes()`. In TS, the canonical bytes
 * are already captured on `ErgoBox.ergoTreeBytes` at parse time (Task 1).
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]] memory).
 *
 * Defensive eval-time kind-check (`'extract-input-not-box'`) reuses
 * the Task 2 code for all 7 Box-extract arms.
 */

import type { ExtractScriptBytes, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'

// Cost source: sigma-rust eval/extract_script_bytes.rs:15 — inline literal
//   ctx.add_jit_cost(10)?;
// Pattern A (envelope BEFORE eval-child).
const EXTRACT_SCRIPT_BYTES_COST = 10

export function evalExtractScriptBytes(
  e: ExtractScriptBytes,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_SCRIPT_BYTES_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractScriptBytes: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  return bytesToCollByteSValue(input.value.ergoTreeBytes)
}
