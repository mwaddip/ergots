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
 * named constant in costs.rs), charged before eval of operands.
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

/** Cost for any Bit op envelope. sigma-rust bin_op.rs:216. */
const BIT_OP_COST = 1

/** The numeric SValue kinds that support bitwise operations. */
const NUMERIC_KINDS = ['Byte', 'Short', 'Int', 'Long', 'BigInt'] as const
type NumericKind = (typeof NUMERIC_KINDS)[number]

/** Bit-width per numeric kind. */
const BIT_WIDTH: Record<NumericKind, bigint> = {
  Byte: 8n,
  Short: 16n,
  Int: 32n,
  Long: 64n,
  BigInt: 256n,
}

/** Type-guard: narrows SValue['kind'] to NumericKind. */
function isNumeric(kind: SValue['kind']): kind is NumericKind {
  return (NUMERIC_KINDS as readonly string[]).includes(kind)
}

/** Promote an SValue (numeric kind) to bigint. */
function toBI(v: SValue): bigint {
  if (v.kind === 'Byte' || v.kind === 'Short' || v.kind === 'Int') {
    return BigInt(v.value as number)
  }
  if (v.kind === 'Long' || v.kind === 'BigInt') {
    return v.value as bigint
  }
  // Should not happen — callers check kind first.
  throw new EvalError(`Bit op: cannot promote kind '${v.kind}' to bigint`, 'bin-op-not-numeric')
}

/**
 * Mask a bigint result to the given bit-width (signed two's-complement).
 * - Mask to `width` bits (drop anything above).
 * - If the high bit is set, interpret as negative (subtract 2^width).
 */
function maskSigned(v: bigint, width: bigint): bigint {
  const mask = (1n << width) - 1n
  const masked = ((v % (1n << width)) + (1n << width)) % (1n << width)
  const high = 1n << (width - 1n)
  return (masked & mask) >= high ? (masked & mask) - (1n << width) : masked & mask
}

/**
 * Narrow a bigint (already signed-ranged) back to the SValue kind.
 * Byte/Short/Int: number. Long/BigInt: bigint.
 */
function fromBI(
  v: bigint,
  kind: 'Byte' | 'Short' | 'Int' | 'Long' | 'BigInt'
): SValue {
  if (kind === 'Byte' || kind === 'Short' || kind === 'Int') {
    return { kind, value: Number(v) }
  }
  return { kind, value: v }
}

export function evalBitOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  // Cost is charged for ALL Bit ops before evaluating operands.
  // sigma-rust bin_op.rs:215-217: add_jit_cost(1) before the dispatch.
  ctx.addCost(BIT_OP_COST)

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

  // Evaluate operands.
  const lv = evalExpr(e.left, env, ctx)
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
  const width = BIT_WIDTH[kind]
  const l = toBI(lv)
  const r = toBI(rv)

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
  return fromBI(maskSigned(raw, width), kind)
}
