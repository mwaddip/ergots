/**
 * UnsignedBigInt (UBI) BinOp value-math — phase v6 P2c.
 *
 * The arithmetic compute + the [0, 2^256) bound, and the ordering compare, for
 * UBI operands. Routed locally from arith.ts / relation.ts (the shared
 * `isNumeric` predicate stays UNWIDENED — P2b Critical 1 — so Negation/etc. keep
 * rejecting). Cost is charged by the caller (the non-BigInt tier; spec §3).
 *
 * Canonical: JVM UnsignedBigIntIsExactIntegral (add/subtract/multiply →
 * toUnsignedBigIntValueExact; quot=divide; divisionRemainder=mod) and
 * UnsignedBigIntIsExactOrdering. CUnsignedBigInt constructor rejects <0 and
 * bitLength>256 ⇒ result bound [0, 2^256). Spec §2/§4.
 */
import type { ArithOp, RelationOp } from '../../mir/types'
import { EvalError } from '../eval-context'
import { UBI_MAX, UBI_OUT_OF_RANGE } from '../_numeric-v6'

/** Throw unless `r` is in [0, 2^256). Mirrors toUnsignedBigIntValueExact. */
function checkUBIRange(r: bigint): bigint {
  if (r < 0n || r > UBI_MAX) {
    throw new EvalError(`UnsignedBigInt arithmetic result outside [0, 2^256)`, UBI_OUT_OF_RANGE)
  }
  return r
}

/**
 * Evaluate an arithmetic ArithOp on two UBI magnitudes, returning the result
 * magnitude (bigint). Throws on over/underflow ([0,2^256)) and on divide/modulo
 * by zero. Min/Max never overflow.
 */
export function evalUBIArith(op: ArithOp, x: bigint, y: bigint): bigint {
  switch (op) {
    case 'Plus':     return checkUBIRange(x + y)
    case 'Minus':    return checkUBIRange(x - y)
    case 'Multiply': return checkUBIRange(x * y)
    case 'Divide':
      if (y === 0n) throw new EvalError(`BinOp.Arith.Divide: divide by zero`, 'arith-divide-by-zero')
      return x / y // non-negative / positive — in range, can't overflow
    case 'Modulo':
      if (y === 0n) throw new EvalError(`BinOp.Arith.Modulo: modulo by zero`, 'arith-divide-by-zero')
      return x % y // non-negative % positive — in range (same as BigInteger.remainder for non-negative inputs)
    case 'Max': return x > y ? x : y
    case 'Min': return x < y ? x : y
    default: {
      const _exhaust: never = op
      throw new Error(`evalUBIArith: unreachable ArithOp ${JSON.stringify(_exhaust)}`)
    }
  }
}

/** Compare two UBI magnitudes for an ordering RelationOp (Lt/Le/Gt/Ge). */
export function compareUBI(op: RelationOp, x: bigint, y: bigint): boolean {
  switch (op) {
    case 'Lt': return x < y
    case 'Le': return x <= y
    case 'Gt': return x > y
    case 'Ge': return x >= y
    default:
      throw new Error(`compareUBI: non-ordering RelationOp ${JSON.stringify(op)}`)
  }
}
