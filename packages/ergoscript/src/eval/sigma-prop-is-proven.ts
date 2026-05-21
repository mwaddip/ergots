/**
 * SigmaPropIsProven eval arm — structural throw (no eval, no cost).
 *
 * Source: ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25
 *
 * Op-code 95 (`SIGMA_PROP_IS_PROVEN`) is reserved in the IR for byte-match
 * parity with Scala sigmastate, whose typer rewrites `prop.isProven` to a
 * `SigmaPropIsProven` node. The AOT graph-IR rewrite removes the node before
 * evaluation; the bytecode interpreter therefore receives a node that always
 * throws.
 *
 * Sigma-rust's eval is `(_env, _ctx) → Err(Misc(...))` — both args
 * underscored, no read of `self.input`, no cost charged. We mirror: this
 * function takes underscored params and throws unconditionally.
 */
import type { SigmaPropIsProven } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalSigmaPropIsProven(
  _e: SigmaPropIsProven,
  _env: Env,
  _ctx: EvalContext,
): never {
  throw new EvalError(
    'SigmaPropIsProven has no interpreter eval (frontend-only — Scala graph-IR rewrites elide it; sigma-rust mirrors as a structural throw)',
    'sigma-prop-is-proven-no-eval',
  )
}
