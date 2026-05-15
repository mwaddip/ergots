/**
 * BinOp central dispatcher. Switches on `e.op.kind` and delegates to
 * one of four per-family sub-arms under `bin-op/`.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs
 */
import type { BinOp, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalArithOp } from './bin-op/arith'
import { evalRelationOp } from './bin-op/relation'
import { evalLogicalOp } from './bin-op/logical'
import { evalBitOp } from './bin-op/bit'

export function evalBinOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  switch (e.op.kind) {
    case 'Arith':    return evalArithOp(e, env, ctx)
    case 'Relation': return evalRelationOp(e, env, ctx)
    case 'Logical':  return evalLogicalOp(e, env, ctx)
    case 'Bit':      return evalBitOp(e, env, ctx)
    default: {
      // Exhaustiveness gate: BinOpKind is a closed 4-member union.
      // Compile-time unreachable; plain Error matches the sub-arms' wrong-kind guards.
      const _exhaust: never = e.op
      throw new Error(`evalBinOp: unreachable kind ${JSON.stringify(_exhaust)}`)
    }
  }
}
