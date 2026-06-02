/**
 * v6 numeric methods (toBytes/toBits/bitwise/shift) on Byte/Short/Int/Long/BigInt.
 * All gate on ergoTreeVersion >= 3 (minVersion: 3, applied at registration in method-call.ts).
 * Canonical: JVM ExactIntegral.scala / ExactNumeric.scala (toBits) / BigIntegerOps.scala.
 * Spec: docs/specs/2026-06-02-ergoscript-v6-p1-numeric-methods-design.md
 */
import type { SValue, SType } from '../mir/types'
import { bytesToCollByteSValue } from './_byte-coll'
import type { HandlerFn } from './method-call'

const SBOOLEAN: SType = { tag: 'SBoolean' }

interface NumV6 {
  typeId: number
  kind: 'Byte' | 'Short' | 'Int' | 'Long' | 'BigInt'
  shiftBound: number
  toBE(value: number | bigint): Uint8Array
  inv(x: number | bigint): number | bigint
  or(a: number | bigint, b: number | bigint): number | bigint
  and(a: number | bigint, b: number | bigint): number | bigint
  xor(a: number | bigint, b: number | bigint): number | bigint
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
}
const shortDesc: NumV6 = {
  typeId: 3, kind: 'Short', shiftBound: 16,
  toBE: (x) => Uint8Array.of(((x as number) >> 8) & 0xff, (x as number) & 0xff),
  inv: (x) => trShort(~(x as number)),
  or: (a, b) => trShort((a as number) | (b as number)),
  and: (a, b) => trShort((a as number) & (b as number)),
  xor: (a, b) => trShort((a as number) ^ (b as number)),
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
}

const NUMERIC_V6_TYPES: NumV6[] = [byteDesc, shortDesc, intDesc, longDesc]

function makeToBytes(t: NumV6): HandlerFn {
  return (obj, _args, ctx) => {
    ctx.addCost(5)
    return bytesToCollByteSValue(t.toBE((obj as { value: number | bigint }).value))
  }
}
function makeToBits(t: NumV6): HandlerFn {
  return (obj, _args, ctx) => {
    ctx.addCost(5)
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
    return { kind: t.kind, value: t.inv((obj as { value: number | bigint }).value) } as SValue
  }
}
function makeBinaryBitwise(t: NumV6, op: 'or' | 'and' | 'xor'): HandlerFn {
  return (obj, args, ctx) => {
    ctx.addCost(5)
    const v = t[op]((obj as { value: number | bigint }).value, (args[0] as { value: number | bigint }).value)
    return { kind: t.kind, value: v } as SValue
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
  }
  return out
}
