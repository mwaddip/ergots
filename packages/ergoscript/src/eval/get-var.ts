/**
 * GetVar arm — context-extension lookup by varId. Leaf arm (no
 * children); reads `ctx.extension.values[varId]`.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/get_var.rs:10-23
 *   ctx.add_jit_cost(10)?;                          // BEFORE (leaf)
 *   match ctx.extension.values.get(&self.var_id) {
 *     None => Ok(Value::Opt(None)),
 *     Some(v) if v.tpe == self.var_tpe => Ok((Some(v.v.clone())).into()),
 *     Some(v) => Err(TryExtractFromError(...)),     // type-mismatch THROWS
 *   }
 *
 * Cost-charging order: envelope BEFORE (Pattern A; leaf arm).
 *
 * Type-mismatch throws (matches sigma-rust; NOT None) — surfaced as
 * typed code 'get-var-type-mismatch'. Parallels phase 2f narrow's
 * 'register-type-mismatch' for ExtractRegisterAs.
 *
 * Defensive 'context-field-missing' guards against ctx.extension being
 * undefined (reused from Task 1 / GlobalVars pattern).
 */

import type { GetVar, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { sTypeEquals } from '../mir/stype-helpers'

// Cost source: sigma-rust eval/get_var.rs:12 — ctx.add_jit_cost(10)?
const GET_VAR_COST = 10

export function evalGetVar(e: GetVar, _env: Env, ctx: EvalContext): SValue {
  // Pattern A: cost BEFORE (leaf arm — no child eval).
  ctx.addCost(GET_VAR_COST)
  if (ctx.extension === undefined) {
    throw new EvalError(
      `GetVar: ctx.extension is missing`,
      'context-field-missing'
    )
  }
  const entry = ctx.extension.values.get(e.varId)
  if (entry === undefined) {
    // Absent → Option(None). Mirrors sigma-rust: None => Ok(Value::Opt(None)).
    return { kind: 'Option', elem: e.varTpe, value: null }
  }
  if (!sTypeEquals(entry.tpe, e.varTpe)) {
    // Type-mismatch THROWS (not None). Mirrors sigma-rust:
    //   Some(v) => Err(TryExtractFromError(...))
    // Parallels 'register-type-mismatch' in ExtractRegisterAs.
    throw new EvalError(
      `GetVar: varId ${e.varId} type mismatch (expected ${e.varTpe.tag}, got ${entry.tpe.tag})`,
      'get-var-type-mismatch'
    )
  }
  // Type matches → Option(Some(value)).
  // Mirrors sigma-rust: Some(v) if v.tpe == self.var_tpe => Ok((Some(v.v.clone())).into())
  return { kind: 'Option', elem: e.varTpe, value: entry.value }
}
