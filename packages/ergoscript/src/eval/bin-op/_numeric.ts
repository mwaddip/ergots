/**
 * Shared numeric helpers for BinOp family arms (Bit, Relation, Arith).
 *
 * Defines the closed set of numeric SValue kinds (Byte/Short/Int/Long/BigInt),
 * a type-guard for narrowing, and bidirectional conversion to/from bigint
 * for kind-uniform arithmetic. Bit-specific helpers (bit-widths, sign
 * masking) live in `bit.ts`. Arith-specific helpers (signed-range bounds,
 * overflow checking) live in `arith.ts`.
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
