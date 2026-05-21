/**
 * MultiplyGroup eval arm — Pattern A, Fixed(40).
 *
 * Source: ergotree-interpreter/src/eval/multiply_group.rs:9-29
 *         ergo-chain-types/src/ec_point.rs:74-80 (Mul<&EcPoint> = ProjectivePoint::add)
 *
 * Group operation under multiplicative notation: `left * right` on EcPoint
 * dispatches to point ADDITION via the Mul<&EcPoint> impl. We use the
 * existing `pointAdd` adapter (thin wrap of @noble/curves Point.add).
 *
 * Cost ordering (Pattern A): cost charged BEFORE eval-children, so shape-
 * mismatch throws have the full Fixed(40) already deducted (mirrors sigma-rust).
 *
 * Build-time type guard: `MultiplyGroup::new` (sigma-rust
 * `ergotree-ir/src/mir/multiply_group.rs:27-37`) enforces
 * `(SGroupElement, SGroupElement)` operands at construction, so non-
 * GroupElement inputs cannot be serialized via the standard path. The TS-side
 * `'group-op-input-not-group-element'` assertions are defensive against
 * `ConstantPlaceholder` injection or hand-crafted MIR (decode_point /
 * byte_array_to_long precedent).
 *
 * Identity convention: both `decodePoint` and `encodePoint` (in
 * crypto/secp256k1.ts) honor the Ergo 33-zero-byte identity encoding. Point
 * addition over the secp256k1 curve naturally handles identity inputs
 * (`P + O = P`, `O + O = O`, `P + (-P) = O`), and re-encoding identity →
 * 33 zero bytes (matches sigma-rust's `EcPoint::scorex_serialize` at
 * `ec_point.rs:127-137`).
 */

import type { MultiplyGroup, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { decodePoint, encodePoint, pointAdd } from '../crypto/secp256k1'

export function evalMultiplyGroup(
  e: MultiplyGroup,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(40) // Pattern A: charge BEFORE eval-children
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  if (leftV.kind !== 'GroupElement') {
    throw new EvalError(
      `MultiplyGroup: expected GroupElement left input, got '${leftV.kind}'`,
      'group-op-input-not-group-element',
    )
  }
  if (rightV.kind !== 'GroupElement') {
    throw new EvalError(
      `MultiplyGroup: expected GroupElement right input, got '${rightV.kind}'`,
      'group-op-input-not-group-element',
    )
  }
  const left = decodePoint(leftV.value)
  const right = decodePoint(rightV.value)
  const result = pointAdd(left, right)
  return { kind: 'GroupElement', value: encodePoint(result) }
}
