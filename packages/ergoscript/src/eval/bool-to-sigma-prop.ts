/**
 * BoolToSigmaProp arm — wraps a Boolean as TrivialProp(b) SigmaBoolean leaf,
 * with pre-v2 ErgoTree JVM v4.x compatibility for SigmaProp pass-through.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bool_to_sigma.rs:13-38
 *   ctx.add_jit_cost(15)?;  // BoolToSigmaProp = Fixed(15)
 *   let input_v = self.input.eval(env, ctx)?;
 *   if ctx.tree_version() < ErgoTreeVersion::V2 {
 *       if let Value::SigmaProp(sp) = input_v { return Ok(Value::SigmaProp(sp)); }
 *   }
 *   let input_v_bool = input_v.try_extract_into::<bool>()?;
 *   Ok((SigmaProp::new(SigmaBoolean::TrivialProp(input_v_bool))).into())
 *
 * Cost: Fixed(15). Charge happens BEFORE eval-child + compat check (Pattern A).
 *
 * Pre-v2 ErgoTree compat (iter-13 closure, mainnet h=680,692 tx 5fe235558...):
 * JVM v4.x accepted a SigmaProp input and passed it through unchanged. Mainnet
 * contains historical `sigmaProp(sigmaProp(...))` scripts (tree `10010101d1d17300`
 * at the cited tx). The gate is the SCRIPT's ErgoTree header version, NOT the
 * block's activated version: a v0 tree spent in a v3+ block still gets the
 * lenient path. Sigma-rust pins this with two tests (`eval_v0_tree_passes_sigmaprop_through`
 * and `eval_v2_tree_rejects_sigmaprop`) at bool_to_sigma.rs.
 *
 * Phase 2g-medium made SigmaProp structural: the phase 2a/2c approach stored an
 * opaque single-byte encoding (TRIVIAL_PROP_FALSE 0xd2 or TRIVIAL_PROP_TRUE 0xd3)
 * as `{ raw: Uint8Array }`. Now `TrivialProp` wraps the boolean directly as
 * `{ tag: 'TrivialProp', value: boolean }` in the `SigmaBoolean` discriminated
 * union, matching sigma-rust's `SigmaBoolean::TrivialProp(bool)` leaf.
 */

import type { BoolToSigmaProp, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

const BOOL_TO_SIGMA_PROP_COST = 15

export function evalBoolToSigmaProp(
  e: BoolToSigmaProp,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(BOOL_TO_SIGMA_PROP_COST)
  const input = evalExpr(e.input, env, ctx)
  // Pre-v2 ErgoTree compat: pass SigmaProp through unchanged (JVM v4.x parity).
  // bool_to_sigma.rs:32-36. Triggers on the SCRIPT'S tree-version (ctx.treeVersion
  // is set per-input from the spent box's ergoTreeBytes[0] & 0x07).
  if ((ctx.treeVersion ?? 0) < 2 && input.kind === 'SigmaProp') {
    return input
  }
  if (input.kind !== 'Boolean') {
    throw new EvalError(
      `BoolToSigmaProp: operand kind must be Boolean, got '${input.kind}'`,
      'bin-op-not-boolean'
    )
  }
  // Phase 2g-medium: structural SigmaBoolean — TrivialProp wraps the boolean.
  // Sigma-rust: SigmaProp::new(SigmaBoolean::TrivialProp(input_v_bool))
  return { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: input.value } }
}
