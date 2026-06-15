/**
 * FunDef tpeArgs count bound — JVM signed-getByte parity (version-signedness audit, 2026-06-15).
 *
 * The JVM `ValDefSerializer.parse` reads `nTpeArgs = r.getByte()` (SIGNED) then
 * `safeNewArray[STypeVar](nTpeArgs)`, which throws NegativeArraySizeException for a
 * count >= 128 (the signed byte is negative). So the JVM ACCEPTS only 0..127 type
 * args. ergots read the count via unsigned `readU8()` and looped 0..n with no bound,
 * over-accepting counts 128..255 — a parse fork on adversarial FunDef trees.
 *
 * Serialize: the JVM emits the count via `w.put(len.toByteExact)` (Byte-exact, throws
 * > 127), so the serialize cap is 127 too — unlike Tuple, whose serialize uses
 * `putUByte` and caps at 255 (parse 127 / serialize 255). Here it is 127 / 127.
 *
 * Reference: ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/
 *   serialization/ValDefSerializer.scala:20 (serialize), :38 (parse).
 */
import { describe, it, expect } from 'vitest'
import { parseExpr } from '../../src/wire/parse'
import { serializeExpr } from '../../src/wire/serialize'
import { serializeSType } from '../../src/wire/serialize-stype'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprParseError, ExprSerializeError } from '../../src/wire/errors'
import type { Expr, STypeVar } from '../../src/mir/types'

const OP_FUN_DEF = 0xd7

// Hand-assemble a FunDef wire blob: [0xd7][id VLQ = 1][nTpeArgs raw u8 = count]
// [count × STypeVar("T")][rhs]. Only the count byte is written raw (the field under
// test); the STypeVars and rhs go through ergots' own serializers so they are
// guaranteed valid regardless of count.
function funDefBytes(count: number): Uint8Array {
  const w = new ByteWriter()
  w.writeU8(OP_FUN_DEF)
  w.writeVlqU(1) // id
  w.writeU8(count) // nTpeArgs — raw u8 (JVM reads this via signed getByte)
  for (let i = 0; i < count; i++) serializeSType({ tag: 'STypeVar', name: 'T' }, w)
  serializeExpr({ tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } }, w, 0)
  return w.toBytes()
}

// A ValDef MIR carrying `count` type args (serializes as FunDef when non-empty).
function funDefMir(count: number): Expr {
  const tpeArgs: STypeVar[] = Array.from({ length: count }, () => ({ name: 'T' }))
  return {
    tag: 'ValDef',
    id: 1,
    tpeArgs,
    rhs: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
  }
}

describe('FunDef tpeArgs count bound (version-signedness audit)', () => {
  it('parse accepts nTpeArgs = 127 (the inclusive boundary)', () => {
    expect(() => parseExpr(new ByteReader(funDefBytes(127)), [], [], new Map(), 0)).not.toThrow()
  })

  it('parse rejects nTpeArgs = 128 with fun-def-tpe-args-out-of-range', () => {
    let err: unknown
    try {
      parseExpr(new ByteReader(funDefBytes(128)), [], [], new Map(), 0)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ExprParseError)
    expect((err as ExprParseError).code).toBe('fun-def-tpe-args-out-of-range')
  })

  it('serialize accepts a ValDef with 127 tpeArgs', () => {
    expect(() => serializeExpr(funDefMir(127), new ByteWriter(), 0)).not.toThrow()
  })

  it('serialize rejects a ValDef with 128 tpeArgs (JVM toByteExact)', () => {
    let err: unknown
    try {
      serializeExpr(funDefMir(128), new ByteWriter(), 0)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ExprSerializeError)
    expect((err as ExprSerializeError).code).toBe('fun-def-tpe-args-out-of-range')
  })
})
