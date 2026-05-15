/**
 * BinOp.Arith family — Plus, Minus, Multiply, Divide, Max, Min, Modulo.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Arith arm at lines
 * 184-218 in the Evaluable impl for BinOp).
 *
 * All ops compute in bigint internally for uniform overflow checking.
 * Max/Min cannot overflow (no range check needed).
 * Divide/Modulo throw 'arith-divide-by-zero' when the right operand is zero,
 * checked BEFORE performing the operation.
 *
 * Cost is per-op AND per-type (is_bigint derived from left operand).
 * Charged AFTER left-eval, BEFORE right-eval, matching sigma-rust ordering
 * (bin_op.rs:190: lv = self.left.eval; lines 194-203: add_jit_cost; line 220:
 * rv = || self.right.eval).
 *
 * Per sigma-rust bin_op.rs:194-203:
 *   Plus/Minus:              15 (non-bigint) / 20 (bigint)
 *   Multiply/Divide/Modulo:  15 (non-bigint) / 25 (bigint)
 *   Max/Min:                  5 (non-bigint) / 10 (bigint)
 *
 * Signed ranges (is_bigint matches only SValue kind 'BigInt'; there is no
 * separate UnsignedBigInt in this TS implementation, matching our v5/v6
 * support scope):
 *   Byte:   [-2^7,   2^7  - 1]
 *   Short:  [-2^15,  2^15 - 1]
 *   Int:    [-2^31,  2^31 - 1]
 *   Long:   [-2^63,  2^63 - 1]
 *   BigInt: [-2^255, 2^255 - 1]
 *
 * Arithmetic is computed in bigint and then range-checked; throws
 * 'arith-overflow' on violation. Narrow back to number for Byte/Short/Int
 * before constructing the return SValue (via bigIntToValue from _numeric.ts).
 *
 * Mirrors sigma-rust's checked_add/sub/mul/div/rem on the per-type native
 * integers; bigint-everywhere is the clean TS equivalent of that per-type
 * dispatch. JS BigInt `/` truncates toward zero, matching Rust's signed integer
 * checked_div behavior.
 */
import type { BinOp, SValue, ArithOp } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'
import { evalExpr } from '../eval'
import {
  isNumeric,
  valueToBigInt,
  bigIntToValue,
  checkRange,
} from './_numeric'

// ---------------------------------------------------------------------------
// Cost table — mirrors sigma-rust bin_op.rs:194-203.
// ---------------------------------------------------------------------------

function arithCost(op: ArithOp, isBigInt: boolean): number {
  switch (op) {
    case 'Plus':
    case 'Minus':
      return isBigInt ? 20 : 15
    case 'Multiply':
    case 'Divide':
    case 'Modulo':
      return isBigInt ? 25 : 15
    case 'Max':
    case 'Min':
      return isBigInt ? 10 : 5
  }
}

// ---------------------------------------------------------------------------
// Main evaluator.
// ---------------------------------------------------------------------------

export function evalArithOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  // Guard: dispatch in bin-op.ts ensures this, but be explicit for debuggability.
  if (e.op.kind !== 'Arith') throw new Error('evalArithOp: wrong kind')
  const op: ArithOp = e.op.op

  // Step 1: eval left operand (sigma-rust bin_op.rs:190).
  const lv = evalExpr(e.left, env, ctx)

  // Validate left is numeric before charging cost (mirrors sigma-rust which
  // dispatches on lv.kind below — a non-numeric left would hit the `_ => Err`
  // arm, but we check here for a typed error code, same posture as bit.ts).
  if (!isNumeric(lv.kind)) {
    throw new EvalError(
      `BinOp.Arith.${op}: non-numeric left operand kind '${lv.kind}'`,
      'bin-op-not-numeric',
    )
  }

  // Step 2: derive is_bigint from lv, charge cost (sigma-rust bin_op.rs:192-203).
  // We have no UnsignedBigInt SValue kind (v5 scope; SUnsignedBigInt is v6-only).
  const isBI = lv.kind === 'BigInt'
  ctx.addCost(arithCost(op, isBI))

  // Step 3: eval right operand (sigma-rust bin_op.rs:220 lazy closure rv()).
  const rv = evalExpr(e.right, env, ctx)

  if (!isNumeric(rv.kind)) {
    throw new EvalError(
      `BinOp.Arith.${op}: non-numeric right operand kind '${rv.kind}'`,
      'bin-op-not-numeric',
    )
  }

  // Both operands must share kind (sigma-rust's try_extract_into would fail
  // with InvalidType; we surface as the typed 'bin-op-kind-mismatch').
  if (lv.kind !== rv.kind) {
    throw new EvalError(
      `BinOp.Arith.${op}: operand kind mismatch — left is '${lv.kind}', right is '${rv.kind}'`,
      'bin-op-kind-mismatch',
    )
  }

  const kind = lv.kind
  const a = valueToBigInt(lv)
  const b = valueToBigInt(rv)

  let result: bigint
  switch (op) {
    case 'Plus':
      result = a + b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Minus':
      result = a - b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Multiply':
      result = a * b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Divide':
      // Checked before compute — sigma-rust checked_div returns None for b==0.
      if (b === 0n) {
        throw new EvalError(
          `BinOp.Arith.Divide: divide by zero`,
          'arith-divide-by-zero',
        )
      }
      // JS BigInt `/` truncates toward zero — same as Rust i8/i16/i32/i64
      // signed checked_div. BigInt256 MIN / -1 overflows (result would be
      // 2^255, outside the [-2^255, 2^255-1] range); checkRange catches it.
      result = a / b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Modulo':
      // Checked before compute — sigma-rust checked_rem returns None for b==0.
      if (b === 0n) {
        throw new EvalError(
          `BinOp.Arith.Modulo: modulo by zero`,
          'arith-divide-by-zero',
        )
      }
      // JS BigInt `%` matches Rust's signed checked_rem semantics for the
      // cases in our fixture corpus (positive/negative dividends with
      // non-zero divisors). Max/Min cannot overflow; Modulo cannot overflow
      // for non-BigInt256 types (result is always in [-(|b|-1), |b|-1]).
      // For BigInt, the fixture oracle drives correctness.
      result = a % b
      checkRange(result, kind, 'arith-overflow')
      break

    case 'Max':
      // sigma-rust: lv_raw.max(rv_raw) — no overflow possible.
      result = a > b ? a : b
      break

    case 'Min':
      // sigma-rust: lv_raw.min(rv_raw) — no overflow possible.
      result = a < b ? a : b
      break

    default: {
      const _exhaust: never = op
      throw new Error(`evalArithOp: unreachable ArithOp ${JSON.stringify(_exhaust)}`)
    }
  }

  return bigIntToValue(kind, result)
}
