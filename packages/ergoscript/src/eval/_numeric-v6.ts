/**
 * v6 numeric methods (toBytes/toBits/bitwise/shift) on Byte/Short/Int/Long/BigInt.
 * All gate on ergoTreeVersion >= 3 (minVersion: 3, applied at registration in method-call.ts).
 * Canonical: JVM ExactIntegral.scala / ExactNumeric.scala (toBits) / BigIntegerOps.scala.
 * Spec: docs/specs/2026-06-02-ergoscript-v6-p1-numeric-methods-design.md
 */
import type { SValue, SType } from '../mir/types'
import { bytesToCollByteSValue, I256_MIN, I256_MAX } from './_byte-coll'
import type { HandlerFn } from './method-call'
import { EvalError } from './eval-context'
import { encodeBigIntBE, encodeUnsignedBigIntBE } from '../wire/serialize-svalue'

// EvalError code for BigInt op results exceeding signed-256 range.
// Distinct from 'byte-array-to-bigint-out-of-range' (that's the ByteArrayToBigInt
// predef rejecting an over-width input; this is an arithmetic result overflow).
const OUT_OF_256_CODE = 'bigint-result-out-of-range'

// EvalError code for wrong-kind receiver or argument. Mirrors JVM asInstanceOf /
// sigma-rust try_extract_into rejection at eval. Wire-format invariants make this
// unreachable for parser-produced trees; defensive against hand-crafted MIR.
// The guard runs after addCost (Pattern A, same ordering as SBox.tokens).
const BAD_OPERAND_CODE = 'numeric-method-bad-operand'

/**
 * Assert that `v.kind === kind`; throw a typed EvalError otherwise.
 * Called AFTER ctx.addCost (Pattern A) and BEFORE reading `.value`.
 * `ctx` is the method name used in the error message (e.g. 'Byte.toBytes').
 */
function requireKind(v: SValue, kind: string, method: string): void {
  if (v.kind !== kind) {
    throw new EvalError(
      `${method}: expected ${kind} operand, got '${v.kind}'`,
      BAD_OPERAND_CODE,
    )
  }
}

const SBOOLEAN: SType = { tag: 'SBoolean' }

interface NumV6 {
  typeId: number
  kind: 'Byte' | 'Short' | 'Int' | 'Long' | 'BigInt' | 'UnsignedBigInt'
  shiftBound: number
  toBE(value: number | bigint): Uint8Array
  inv(x: number | bigint): number | bigint
  or(a: number | bigint, b: number | bigint): number | bigint
  and(a: number | bigint, b: number | bigint): number | bigint
  xor(a: number | bigint, b: number | bigint): number | bigint
  shl(x: number | bigint, bits: number): number | bigint
  shr(x: number | bigint, bits: number): number | bigint
}

// Fixed-width truncators — JS bitwise ops work on i32 but Byte/Short need narrowing.
const trByte = (n: number): number => (n << 24) >> 24
const trShort = (n: number): number => (n << 16) >> 16
const trInt = (n: number): number => n | 0
const wrap64 = (v: bigint): bigint => BigInt.asIntN(64, v)

const byteDesc: NumV6 = {
  typeId: 2, kind: 'Byte', shiftBound: 8,
  toBE: (x) => Uint8Array.of((x as number) & 0xff),
  inv: (x) => trByte(~(x as number)),
  or: (a, b) => trByte((a as number) | (b as number)),
  and: (a, b) => trByte((a as number) & (b as number)),
  xor: (a, b) => trByte((a as number) ^ (b as number)),
  shl: (x, bits) => trByte((x as number) << bits),
  shr: (x, bits) => trByte((x as number) >> bits),
}
const shortDesc: NumV6 = {
  typeId: 3, kind: 'Short', shiftBound: 16,
  toBE: (x) => Uint8Array.of(((x as number) >> 8) & 0xff, (x as number) & 0xff),
  inv: (x) => trShort(~(x as number)),
  or: (a, b) => trShort((a as number) | (b as number)),
  and: (a, b) => trShort((a as number) & (b as number)),
  xor: (a, b) => trShort((a as number) ^ (b as number)),
  shl: (x, bits) => trShort((x as number) << bits),
  shr: (x, bits) => trShort((x as number) >> bits),
}
const intDesc: NumV6 = {
  typeId: 4, kind: 'Int', shiftBound: 32,
  toBE: (x) => {
    const n = x as number
    return Uint8Array.of((n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
  },
  inv: (x) => trInt(~(x as number)),
  or: (a, b) => trInt((a as number) | (b as number)),
  and: (a, b) => trInt((a as number) & (b as number)),
  xor: (a, b) => trInt((a as number) ^ (b as number)),
  shl: (x, bits) => trInt((x as number) << bits),
  shr: (x, bits) => trInt((x as number) >> bits),
}
const longDesc: NumV6 = {
  typeId: 5, kind: 'Long', shiftBound: 64,
  toBE: (x) => {
    const b = new Uint8Array(8)
    let v = BigInt.asUintN(64, x as bigint)
    for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n }
    return b
  },
  inv: (x) => wrap64(~(x as bigint)),
  or: (a, b) => wrap64((a as bigint) | (b as bigint)),
  and: (a, b) => wrap64((a as bigint) & (b as bigint)),
  xor: (a, b) => wrap64((a as bigint) ^ (b as bigint)),
  shl: (x, bits) => wrap64((x as bigint) << BigInt(bits)),
  shr: (x, bits) => (x as bigint) >> BigInt(bits),
}

/**
 * Range-check a BigInt result to signed-256. Mirrors JVM CBigInt.shiftLeft/shiftRight
 * calling `.toSignedBigIntValueExact` (Extensions.scala:219-223), which throws
 * ArithmeticException when bitLength() > 255 (i.e. value outside [-2^255, 2^255-1]).
 * Bitwise inv/or/and/xor on in-range inputs stay in-range — the JVM bounds all six
 * BigInt ops via the CBigInt constructor check on INPUTS (CBigInt.scala:57-63), so
 * in-range inputs produce in-range results for bitwise ops and the result check is
 * provably unreachable there. checkBigInt256 is applied only to shift results.
 */
function checkBigInt256(r: bigint): bigint {
  if (r < I256_MIN || r > I256_MAX) {
    throw new EvalError(`BigInt result out of signed-256 range`, OUT_OF_256_CODE)
  }
  return r
}

const bigIntDesc: NumV6 = {
  typeId: 6, kind: 'BigInt', shiftBound: 256,
  // toBytes: Java BigInteger.toByteArray() = minimal two's-complement (encodeBigIntBE mirrors this).
  // In-range input; no overflow check needed.
  toBE: (x) => encodeBigIntBE(x as bigint),
  // bitwiseInverse: ~x = -x - 1 in two's complement. In-range BigInt stays in-range;
  // result check omitted (provably unreachable — see checkBigInt256 doc above).
  inv: (x) => ~(x as bigint),
  or: (a, b) => (a as bigint) | (b as bigint),
  and: (a, b) => (a as bigint) & (b as bigint),
  xor: (a, b) => (a as bigint) ^ (b as bigint),
  // shiftLeft: result may overflow signed-256 (JVM calls toSignedBigIntValueExact on result).
  // shiftRight (arithmetic): right-shift on an in-range value always stays in-range — the
  // guard mirrors the JVM call but can never fire for shr. It is kept for structural symmetry.
  shl: (x, bits) => checkBigInt256((x as bigint) << BigInt(bits)),
  shr: (x, bits) => checkBigInt256((x as bigint) >> BigInt(bits)),
}

// Maximum value of an unsigned 256-bit integer (2^256 - 1).
const UBI_MAX = (1n << 256n) - 1n

// EvalError code for a UnsignedBigInt result outside [0, 2^256). Reused by the
// cast arms (Task 4) for a negative value cast to UBI. Distinct from P1's
// signed 'bigint-result-out-of-range'.
const UBI_OUT_OF_RANGE = 'unsigned-bigint-out-of-range'

const ubiDesc: NumV6 = {
  typeId: 9, kind: 'UnsignedBigInt', shiftBound: 256,
  // toBytes/toBits use minimal unsigned magnitude (CUnsignedBigInt.toBytes =
  // asUnsignedByteArray); 0n -> [] (NOT [0x00] like signed BigInt).
  toBE: (x) => encodeUnsignedBigIntBE(x as bigint),
  // bitwiseInverse: JVM flips all 256 bits (asUnsignedByteArray(32,·) then ~b),
  // i.e. (2^256-1) - x. NOT JS ~x (which goes negative).
  inv: (x) => UBI_MAX - (x as bigint),
  or: (a, b) => (a as bigint) | (b as bigint),
  and: (a, b) => (a as bigint) & (b as bigint),
  xor: (a, b) => (a as bigint) ^ (b as bigint),
  // shiftLeft can push past 2^256-1; CUnsignedBigInt constructor rejects
  // bitLength > 256. (bits-range guard runs first, in makeShift.)
  shl: (x, bits) => {
    const r = (x as bigint) << BigInt(bits)
    if (r > UBI_MAX) {
      throw new EvalError(`UnsignedBigInt.shiftLeft: result exceeds 2^256-1`, UBI_OUT_OF_RANGE)
    }
    return r
  },
  // shiftRight on a non-negative magnitude always stays in range.
  shr: (x, bits) => (x as bigint) >> BigInt(bits),
}

const NUMERIC_V6_TYPES: NumV6[] = [byteDesc, shortDesc, intDesc, longDesc, bigIntDesc, ubiDesc]

function makeToBytes(t: NumV6): HandlerFn {
  return (obj, _args, ctx) => {
    ctx.addCost(5)
    requireKind(obj, t.kind, `${t.kind}.toBytes`)
    return bytesToCollByteSValue(t.toBE((obj as { value: number | bigint }).value))
  }
}
function makeToBits(t: NumV6): HandlerFn {
  return (obj, _args, ctx) => {
    ctx.addCost(5)
    requireKind(obj, t.kind, `${t.kind}.toBits`)
    const bytes = t.toBE((obj as { value: number | bigint }).value)
    const items: SValue[] = new Array(bytes.length * 8)
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!
      for (let bit = 0; bit < 8; bit++) {
        items[i * 8 + (7 - bit)] = { kind: 'Boolean', value: ((byte >> bit) & 1) === 1 }
      }
    }
    return { kind: 'Coll', elem: SBOOLEAN, items }
  }
}

function makeInverse(t: NumV6): HandlerFn {
  return (obj, _args, ctx) => {
    ctx.addCost(5)
    requireKind(obj, t.kind, `${t.kind}.bitwiseInverse`)
    return { kind: t.kind, value: t.inv((obj as { value: number | bigint }).value) } as SValue
  }
}
function makeBinaryBitwise(t: NumV6, op: 'or' | 'and' | 'xor'): HandlerFn {
  const mName = op === 'or' ? 'bitwiseOr' : op === 'and' ? 'bitwiseAnd' : 'bitwiseXor'
  return (obj, args, ctx) => {
    ctx.addCost(5)
    requireKind(obj, t.kind, `${t.kind}.${mName}`)
    requireKind(args[0]!, t.kind, `${t.kind}.${mName} arg`)
    const v = t[op]((obj as { value: number | bigint }).value, (args[0] as { value: number | bigint }).value)
    return { kind: t.kind, value: v } as SValue
  }
}
function makeShift(t: NumV6, dir: 'shl' | 'shr'): HandlerFn {
  const mName = dir === 'shl' ? 'shiftLeft' : 'shiftRight'
  return (obj, args, ctx) => {
    ctx.addCost(5) // Pattern A: cost charged before guards (mirrors JVM ExactIntegral)
    requireKind(obj, t.kind, `${t.kind}.${mName}`)
    requireKind(args[0]!, 'Int', `${t.kind}.${mName} bits`)
    const bits = (args[0] as { kind: 'Int'; value: number }).value
    if (bits < 0 || bits >= t.shiftBound) {
      throw new EvalError(
        `${t.kind}.${mName}: bits out of range [0, ${t.shiftBound}) (got ${bits})`,
        'numeric-shift-out-of-range',
      )
    }
    return { kind: t.kind, value: t[dir]((obj as { value: number | bigint }).value, bits) } as SValue
  }
}

export function numericV6Handlers(): Array<{ typeId: number; methodId: number; handler: HandlerFn }> {
  const out: Array<{ typeId: number; methodId: number; handler: HandlerFn }> = []
  for (const t of NUMERIC_V6_TYPES) {
    out.push({ typeId: t.typeId, methodId: 6, handler: makeToBytes(t) })
    out.push({ typeId: t.typeId, methodId: 7, handler: makeToBits(t) })
    out.push({ typeId: t.typeId, methodId: 8, handler: makeInverse(t) })
    out.push({ typeId: t.typeId, methodId: 9, handler: makeBinaryBitwise(t, 'or') })
    out.push({ typeId: t.typeId, methodId: 10, handler: makeBinaryBitwise(t, 'and') })
    out.push({ typeId: t.typeId, methodId: 11, handler: makeBinaryBitwise(t, 'xor') })
    out.push({ typeId: t.typeId, methodId: 12, handler: makeShift(t, 'shl') })
    out.push({ typeId: t.typeId, methodId: 13, handler: makeShift(t, 'shr') })
  }
  return out
}
