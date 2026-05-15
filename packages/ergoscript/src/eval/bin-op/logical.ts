/**
 * BinOp.Logical family — Boolean binary And/Or/Xor.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Logical arm).
 *
 * And, Or short-circuit: if the left side determines the result, the
 * right is NOT evaluated and its cost is NOT charged. Xor is eager —
 * both sides always evaluate.
 *
 * Cost: Fixed(20) per sigma-rust bin_op.rs:213:
 *   BinOpKind::Logical(_) => { ctx.add_jit_cost(20)?; }
 *
 * Envelope cost is charged before evaluating either operand (matching
 * sigma-rust's ordering: add_jit_cost → eval left → conditional eval right).
 *
 * Non-Boolean operand on either side → 'bin-op-not-boolean'. This error code
 * is shared with LogicalNot and BoolToSigmaProp.
 */
import type { BinOp, SValue, LogicalOp } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'
import { evalExpr } from '../eval'

/** Cost for any Logical op envelope. sigma-rust bin_op.rs:213. */
const LOGICAL_OP_COST = 20

function asBoolean(v: SValue, side: 'left' | 'right'): boolean {
  if (v.kind !== 'Boolean') {
    throw new EvalError(
      `BinOp.Logical: ${side} operand kind must be Boolean, got '${v.kind}'`,
      'bin-op-not-boolean'
    )
  }
  return v.value
}

export function evalLogicalOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  // Guard: should only be called from the central evalBinOp dispatcher.
  if (e.op.kind !== 'Logical') throw new Error('evalLogicalOp: wrong kind')

  // Envelope cost charged before evaluating operands.
  // sigma-rust bin_op.rs:212-214: add_jit_cost(20) before the dispatch.
  ctx.addCost(LOGICAL_OP_COST)

  const left = asBoolean(evalExpr(e.left, env, ctx), 'left')
  const op: LogicalOp = e.op.op

  switch (op) {
    case 'And':
      // Short-circuit on false: right is NOT evaluated, cost NOT charged.
      // sigma-rust bin_op.rs:223-226: lazy rv() closure not called when left=false.
      if (!left) return { kind: 'Boolean', value: false }
      return { kind: 'Boolean', value: asBoolean(evalExpr(e.right, env, ctx), 'right') }

    case 'Or':
      // Short-circuit on true: right is NOT evaluated, cost NOT charged.
      // sigma-rust bin_op.rs:228-231: lazy rv() closure not called when left=true.
      if (left) return { kind: 'Boolean', value: true }
      return { kind: 'Boolean', value: asBoolean(evalExpr(e.right, env, ctx), 'right') }

    case 'Xor': {
      // Eager: both sides always evaluated.
      // sigma-rust bin_op.rs:233-235: rv() called unconditionally.
      const right = asBoolean(evalExpr(e.right, env, ctx), 'right')
      return { kind: 'Boolean', value: left !== right }
    }

    default: {
      const _exhaust: never = op
      throw new Error(`evalLogicalOp: unreachable op ${JSON.stringify(_exhaust)}`)
    }
  }
}
