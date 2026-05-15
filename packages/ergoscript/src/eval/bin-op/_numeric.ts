/**
 * Shared numeric helpers for BinOp family arms (Bit, Relation, Arith) and
 * top-level numeric-poly arms (Negation, BitInversion, Upcast, Downcast).
 *
 * Defines the closed set of numeric SValue kinds (Byte/Short/Int/Long/BigInt),
 * a type-guard for narrowing, bidirectional conversion to/from bigint for
 * kind-uniform arithmetic, signed-range bounds + a kind-aware range check,
 * and a two's-complement mask-to-signed-range helper.
 *
 * `checkRange` was previously private to `bin-op/arith.ts` and `maskToKind`
 * (formerly `maskSigned`) was previously private to `bin-op/bit.ts`. Both
 * were promoted here in phase 2d slice A so top-level numeric-poly arms
 * (Negation/BitInversion/Downcast) can re-use them without reaching across
 * into sub-arm modules. `checkRange` gained a third parameter (error code
 * string) so 2c callers continue passing `'arith-overflow'` while the new
 * Downcast arm passes `'downcast-overflow'`.
 */
import type { SValue } from '../../mir/types'
import { EvalError } from '../eval-context'

export const NUMERIC_KINDS = ['Byte', 'Short', 'Int', 'Long', 'BigInt'] as const
export type NumericKind = (typeof NUMERIC_KINDS)[number]

export function isNumeric(kind: SValue['kind']): kind is NumericKind {
  return (NUMERIC_KINDS as readonly string[]).includes(kind)
}

export function valueToBigInt(v: SValue): bigint {
  switch (v.kind) {
    case 'Byte':
    case 'Short':
    case 'Int':
      return BigInt(v.value)
    case 'Long':
    case 'BigInt':
      return v.value
    default:
      // Defensive — should be unreachable when caller has applied isNumeric.
      throw new EvalError(
        `valueToBigInt: non-numeric operand kind ${v.kind}`,
        'bin-op-not-numeric'
      )
  }
}

export function bigIntToValue(kind: NumericKind, n: bigint): SValue {
  switch (kind) {
    case 'Byte':   return { kind: 'Byte',   value: Number(n) }
    case 'Short':  return { kind: 'Short',  value: Number(n) }
    case 'Int':    return { kind: 'Int',    value: Number(n) }
    case 'Long':   return { kind: 'Long',   value: n }
    case 'BigInt': return { kind: 'BigInt', value: n }
  }
}

// ---------------------------------------------------------------------------
// Signed range bounds per numeric kind.
//   Byte:   [-2^7,   2^7  - 1]
//   Short:  [-2^15,  2^15 - 1]
//   Int:    [-2^31,  2^31 - 1]
//   Long:   [-2^63,  2^63 - 1]
//   BigInt: [-2^255, 2^255 - 1]
// is_bigint matches only SValue kind 'BigInt'; there is no separate
// UnsignedBigInt SValue kind (v5 scope; SUnsignedBigInt is v6-only).
// ---------------------------------------------------------------------------

const SIGNED_MIN: Record<NumericKind, bigint> = {
  Byte:   -(1n << 7n),
  Short:  -(1n << 15n),
  Int:    -(1n << 31n),
  Long:   -(1n << 63n),
  BigInt: -(1n << 255n),
}

const SIGNED_MAX: Record<NumericKind, bigint> = {
  Byte:   (1n << 7n) - 1n,
  Short:  (1n << 15n) - 1n,
  Int:    (1n << 31n) - 1n,
  Long:   (1n << 63n) - 1n,
  BigInt: (1n << 255n) - 1n,
}

/** Bit-width per numeric kind. Used by `maskToKind`. */
const BIT_WIDTH: Record<NumericKind, bigint> = {
  Byte: 8n,
  Short: 16n,
  Int: 32n,
  Long: 64n,
  BigInt: 256n,
}

// ---------------------------------------------------------------------------
// Range check (throws `EvalError(errorCode)` on out-of-range).
// ---------------------------------------------------------------------------

/**
 * Throw `EvalError(errorCode)` if `value` lies outside `kind`'s signed range.
 * Callers control the error code so the same range-check serves both
 * arith overflow (`'arith-overflow'`) and downcast narrowing
 * (`'downcast-overflow'`).
 *
 * Sigma-rust refs:
 *   ergotree-interpreter/src/eval/bin_op.rs (Arith family — checked_add/sub/mul/div/rem)
 *   ergotree-interpreter/src/eval/downcast.rs (Downcast — ArithmeticException)
 */
export function checkRange(value: bigint, kind: NumericKind, errorCode: string): void {
  if (value < SIGNED_MIN[kind] || value > SIGNED_MAX[kind]) {
    throw new EvalError(
      `checkRange: value ${value} overflows ${kind} (range [${SIGNED_MIN[kind]}, ${SIGNED_MAX[kind]}])`,
      errorCode,
    )
  }
}

// ---------------------------------------------------------------------------
// Mask to signed two's-complement range for the given numeric kind.
// ---------------------------------------------------------------------------

/**
 * Mask `value` to `kind`'s signed range via two's-complement narrow.
 * - Mask to `BIT_WIDTH[kind]` bits (drop anything above).
 * - If the high bit is set, interpret as negative (subtract 2^width).
 *
 * Used by BinOp.Bit (BitAnd/Or/Xor) and the BitInversion arm.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Bit family) and
 *                 ergotree-interpreter/src/eval/bit_inversion.rs.
 */
export function maskToKind(value: bigint, kind: NumericKind): bigint {
  const width = BIT_WIDTH[kind]
  const mask = (1n << width) - 1n
  const masked = ((value % (1n << width)) + (1n << width)) % (1n << width)
  const high = 1n << (width - 1n)
  return (masked & mask) >= high ? (masked & mask) - (1n << width) : masked & mask
}
