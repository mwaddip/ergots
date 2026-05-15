/**
 * BoolToSigmaProp arm — wraps a Boolean as TrivialProp(b) SigmaBoolean leaf.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bool_to_sigma.rs:19
 *   ctx.add_jit_cost(15)?;  // BoolToSigmaProp = Fixed(15)
 *   let input_v = self.input.eval(env, ctx)?;
 *   let input_v_bool = input_v.try_extract_into::<bool>()?;
 *   Ok((SigmaProp::new(SigmaBoolean::TrivialProp(input_v_bool))).into())
 *
 * Cost: Fixed(15) per bool_to_sigma.rs:19 (inline literal; no named constant in costs.rs).
 *
 * SigmaProp stays opaque in 2c — we construct the canonical single-byte
 * encoding: TRIVIAL_PROP_FALSE (0xd2) or TRIVIAL_PROP_TRUE (0xd3). The
 * opcode itself discriminates the boolean; payload is empty.
 * Structural decode is 2g territory.
 *
 * Note: sigma-rust has a pre-v2 ErgoTree compat path that passes a SigmaProp
 * operand through unchanged (`sigmaProp(sigmaProp(...))`). In phase 2c we
 * implement the v2+ strict path only — all fixture trees use v0 header but
 * their input is Boolean, so the compat path doesn't trigger. The compat
 * path requires tree-version context (phase 2e) and is deferred.
 */

import type { BoolToSigmaProp, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import {
  SIGMA_OP_TRIVIAL_PROP_FALSE,
  SIGMA_OP_TRIVIAL_PROP_TRUE,
} from '../wire/sigma-boolean'

const BOOL_TO_SIGMA_PROP_COST = 15

export function evalBoolToSigmaProp(
  e: BoolToSigmaProp,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(BOOL_TO_SIGMA_PROP_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Boolean') {
    throw new EvalError(
      `BoolToSigmaProp: operand kind must be Boolean, got '${input.kind}'`,
      'bin-op-not-boolean'
    )
  }
  const raw = new Uint8Array([
    input.value ? SIGMA_OP_TRIVIAL_PROP_TRUE : SIGMA_OP_TRIVIAL_PROP_FALSE,
  ])
  return { kind: 'SigmaProp', value: { raw } }
}
