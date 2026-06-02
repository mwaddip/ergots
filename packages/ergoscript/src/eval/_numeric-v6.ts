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
}

const byteDesc: NumV6 = {
  typeId: 2, kind: 'Byte', shiftBound: 8,
  toBE: (x) => Uint8Array.of((x as number) & 0xff),
}
const shortDesc: NumV6 = {
  typeId: 3, kind: 'Short', shiftBound: 16,
  toBE: (x) => Uint8Array.of(((x as number) >> 8) & 0xff, (x as number) & 0xff),
}
const intDesc: NumV6 = {
  typeId: 4, kind: 'Int', shiftBound: 32,
  toBE: (x) => {
    const n = x as number
    return Uint8Array.of((n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
  },
}
const longDesc: NumV6 = {
  typeId: 5, kind: 'Long', shiftBound: 64,
  toBE: (x) => {
    const b = new Uint8Array(8)
    let v = BigInt.asUintN(64, x as bigint)
    for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n }
    return b
  },
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

export function numericV6Handlers(): Array<{ typeId: number; methodId: number; handler: HandlerFn }> {
  const out: Array<{ typeId: number; methodId: number; handler: HandlerFn }> = []
  for (const t of NUMERIC_V6_TYPES) {
    out.push({ typeId: t.typeId, methodId: 6, handler: makeToBytes(t) })
    out.push({ typeId: t.typeId, methodId: 7, handler: makeToBits(t) })
  }
  return out
}
