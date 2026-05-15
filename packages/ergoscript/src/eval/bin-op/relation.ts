/**
 * Relation family of BinOp. Phase 2c tasks 6 + 7 implement this.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Relation arm).
 */
import type { BinOp, SValue } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'

export function evalRelationOp(_e: BinOp, _env: Env, _ctx: EvalContext): SValue {
  throw new EvalError(
    'BinOp.Relation: not yet implemented in this slice',
    'not-implemented-yet'
  )
}
