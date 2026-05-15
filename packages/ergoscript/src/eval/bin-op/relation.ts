/**
 * BinOp.Relation family — Eq, NEq, Lt, Le, Gt, Ge.
 *
 * This file ships ordering ops (Lt/Le/Gt/Ge) in phase 2c task 6.
 * Eq/NEq are added in task 7 alongside the sValueEquals helper.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Relation arm,
 * ordering subset at lines ~205-211:
 *   BinOpKind::Relation(op) => match op {
 *       RelationOp::Eq | RelationOp::NEq => {}  // cost charged inside eq_with_cost
 *       _ => { ctx.add_jit_cost(20)?; }  // LT, LE, GT, GE = Fixed(20)
 *   }
 * Ordering helpers eval_lt/le/gt/ge at lines ~100-166: type-specific dispatch
 * via match on lv kind. We collapse to bigint internally; observably equivalent
 * for same-kind numeric pairs.
 *
 * Ordering matches sigma-rust: eval left → charge cost → eval right.
 * Cost: Fixed(20) per bin_op.rs:210 (inline literal; no named constant in costs.rs).
 */
import type { BinOp, SValue, RelationOp } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'
import { evalExpr } from '../eval'

/** Cost for ordering Relation ops. sigma-rust bin_op.rs:210. */
const RELATION_ORDERING_COST = 20

/** The numeric SValue kinds that support ordering operations. */
const NUMERIC_KINDS = ['Byte', 'Short', 'Int', 'Long', 'BigInt'] as const
type NumericKind = (typeof NUMERIC_KINDS)[number]

/** Type-guard: narrows SValue['kind'] to NumericKind. */
function isNumeric(kind: SValue['kind']): kind is NumericKind {
  return (NUMERIC_KINDS as readonly string[]).includes(kind)
}

/** Promote a numeric SValue to bigint for comparison. */
function valueToBigInt(v: SValue): bigint {
  switch (v.kind) {
    case 'Byte':
    case 'Short':
    case 'Int':
      return BigInt(v.value)
    case 'Long':
    case 'BigInt':
      return v.value
    default:
      // Defensive — caller has already verified isNumeric.
      throw new EvalError(
        `BinOp.Relation ordering: non-numeric operand kind ${v.kind}`,
        'bin-op-not-numeric'
      )
  }
}

export function evalRelationOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  if (e.op.kind !== 'Relation') throw new Error('evalRelationOp: wrong kind')
  const op: RelationOp = e.op.op

  // Eq/NEq are added in Task 7 alongside sValueEquals.
  if (op === 'Eq' || op === 'NEq') {
    throw new EvalError(
      `BinOp.Relation.${op}: not yet implemented in this slice (task 7 lands it)`,
      'not-implemented-yet'
    )
  }

  // Step 1: eval left operand first (sigma-rust bin_op.rs:190).
  const left = evalExpr(e.left, env, ctx)
  if (!isNumeric(left.kind)) {
    throw new EvalError(
      `BinOp.Relation.${op}: non-numeric left operand kind ${left.kind}`,
      'bin-op-not-numeric'
    )
  }

  // Step 2: charge envelope cost AFTER left-eval (sigma-rust bin_op.rs:205-211).
  ctx.addCost(RELATION_ORDERING_COST)

  // Step 3: eval right operand.
  const right = evalExpr(e.right, env, ctx)
  if (!isNumeric(right.kind)) {
    throw new EvalError(
      `BinOp.Relation.${op}: non-numeric right operand kind ${right.kind}`,
      'bin-op-not-numeric'
    )
  }
  if (left.kind !== right.kind) {
    throw new EvalError(
      `BinOp.Relation.${op}: kind mismatch ${left.kind} vs ${right.kind}`,
      'bin-op-kind-mismatch'
    )
  }

  const a = valueToBigInt(left)
  const b = valueToBigInt(right)

  // op is narrowed to 'Lt' | 'Le' | 'Gt' | 'Ge' here (Eq/NEq already handled above).
  // The _exhaust default provides compile-time exhaustiveness over the full RelationOp union
  // in case future variants are added.
  let result: boolean
  switch (op) {
    case 'Lt': result = a < b;  break
    case 'Le': result = a <= b; break
    case 'Gt': result = a > b;  break
    case 'Ge': result = a >= b; break
    default: {
      const _exhaust: never = op
      throw new Error(`evalRelationOp ordering: unreachable op ${JSON.stringify(_exhaust)}`)
    }
  }
  return { kind: 'Boolean', value: result }
}
