/**
 * Logical family of BinOp. Phase 2c task 5 implements this.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Logical arm).
 */
import type { BinOp, SValue } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'

export function evalLogicalOp(_e: BinOp, _env: Env, _ctx: EvalContext): SValue {
  throw new EvalError(
    'BinOp.Logical: not yet implemented in this slice',
    'not-implemented-yet'
  )
}
