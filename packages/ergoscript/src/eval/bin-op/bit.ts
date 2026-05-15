/**
 * BinOp.Bit family — three bitwise ops on numeric operands:
 * BitAnd, BitOr, BitXor.
 *
 * BitShiftLeft, BitShiftRight, BitShiftRightZeroed are NOT implemented via
 * BinOp eval in sigma-rust — they return EvalError::Misc("no interpreter eval
 * — use SNumericTypeMethods.shiftLeft/Right instead"). We mirror that by
 * throwing 'not-implemented-yet'. Those ops are available via the method-call
 * path, which lands in a later phase.
 *
 * Sigma-rust refs:
 *   bin_op.rs:215-217  BinOpKind::Bit(_) => { ctx.add_jit_cost(1)?; }
 *   bin_op.rs:342-391  BitAnd/BitOr/BitXor eval via eval_bit_op;
 *                      BitShift* => EvalError::Misc("no interpreter eval").
 *
 * Cost: Fixed(1) for the Bit envelope (bin_op.rs:216; inline literal, no
 * named constant in costs.rs), charged AFTER left-eval and BEFORE right-eval
 * (matches sigma-rust bin_op.rs:187-220: lv = self.left.eval; add_jit_cost(1);
 * rv = || self.right.eval).
 *
 * Operand semantics:
 * - Both operands must share the same numeric kind (Byte/Short/Int/Long/BigInt).
 *   Kind mismatch → 'bin-op-kind-mismatch'.
 * - Non-numeric left operand → 'bin-op-not-numeric'.
 * - Compute as bigint, mask to operand bit-width, re-sign for signed kinds.
 * - Byte: 8-bit, Short: 16-bit, Int: 32-bit, Long: 64-bit, BigInt: 256-bit.
 */
import type { BinOp, SValue, BitOp } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'
import { evalExpr } from '../eval'
import {
  type NumericKind,
  isNumeric,
  valueToBigInt,
  bigIntToValue,
  maskToKind,
} from './_numeric'

/** Cost for any Bit op envelope. sigma-rust bin_op.rs:216. */
const BIT_OP_COST = 1

export function evalBitOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  // op.kind === 'Bit' guaranteed by the dispatch in bin-op.ts
  if (e.op.kind !== 'Bit') throw new Error('evalBitOp: wrong kind')
  const bitOp: BitOp = e.op.op

  // Shift ops are not implemented in sigma-rust's BinOp evaluator path.
  // Mirror EvalError::Misc("no interpreter eval").
  if (
    bitOp === 'BitShiftLeft' ||
    bitOp === 'BitShiftRight' ||
    bitOp === 'BitShiftRightZeroed'
  ) {
    throw new EvalError(
      `BinOp.Bit: ${bitOp} has no interpreter eval (use SNumericTypeMethods.shiftLeft/Right)`,
      'not-implemented-yet'
    )
  }

  // Step 1: eval left operand first (sigma-rust bin_op.rs:187).
  const lv = evalExpr(e.left, env, ctx)

  // Step 2: charge envelope cost AFTER left-eval (sigma-rust bin_op.rs:215-217).
  ctx.addCost(BIT_OP_COST)

  // Step 3: eval right operand.
  const rv = evalExpr(e.right, env, ctx)

  // Left operand must be numeric.
  if (!isNumeric(lv.kind)) {
    throw new EvalError(
      `BinOp.Bit: left operand kind must be numeric (Byte/Short/Int/Long/BigInt), got '${lv.kind}'`,
      'bin-op-not-numeric'
    )
  }

  // Both operands must share kind.
  if (lv.kind !== rv.kind) {
    throw new EvalError(
      `BinOp.Bit: operand kind mismatch — left is '${lv.kind}', right is '${rv.kind}'`,
      'bin-op-kind-mismatch'
    )
  }

  // lv.kind is narrowed to NumericKind by isNumeric guard above.
  const kind: NumericKind = lv.kind
  const l = valueToBigInt(lv)
  const r = valueToBigInt(rv)

  let raw: bigint
  // After the shift-op filter above, bitOp is narrowed to BitAnd | BitOr | BitXor.
  switch (bitOp) {
    case 'BitAnd': raw = l & r; break
    case 'BitOr':  raw = l | r; break
    case 'BitXor': raw = l ^ r; break
    default: {
      const _exhaust: never = bitOp
      throw new Error(`evalBitOp: unreachable BitOp ${JSON.stringify(_exhaust)}`)
    }
  }

  // Mask back to the kind's signed range.
  return bigIntToValue(kind, maskToKind(raw, kind))
}
