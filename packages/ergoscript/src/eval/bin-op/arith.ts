/**
 * Arith family of BinOp. Phase 2c task 8 implements this.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Arith arm).
 */
import type { BinOp, SValue } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'

export function evalArithOp(_e: BinOp, _env: Env, _ctx: EvalContext): SValue {
  throw new EvalError(
    'BinOp.Arith: not yet implemented in this slice',
    'not-implemented-yet'
  )
}
