/**
 * A `Tuple` expression in a register (the wire lead byte 0x86) gives on access
 * the `Coll[Any]` of `Tuple.value` at every arity, two included
 * (`data/shared/src/main/scala/sigma/ast/values.scala:807-828` at 6.0.7:
 * `Tuple.value` is `Colls.fromArray(xs.toArray)` under `sigma.AnyType`, with no
 * branching through `toDslTuple` — a two-item `Tuple` expression is not a
 * pair). The register's wire bytes are kept in `opaqueBytes`; the box's bytes,
 * its id, its serialize cost and the storage-rent register equality read those
 * bytes.
 *
 * The register reader (`TupleSerializer.scala:27-36` at 6.0.7) reads the arm's
 * count with a signed `getByte` and runs `safeNewArray`: 0..127 parses, 128 and
 * above are refused as a negative array size.
 */
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseAdditionalRegisters, parseSValue, SValueParseError } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { tupleColl } from '../../src/coll'
import { serializeCost } from '../../src/eval/serialize-cost'
import { makeContext } from '../../src/eval/eval-context'
import { boxBytesOf, boxIdOf } from '../../src/eval/_box-id'
import { blake2b256 } from '../../src/crypto/hashes'
import { hexToBytes } from '../_helpers'
import type { SType, SValue, Expr } from '../../src/mir/types'
import { ByteWriter } from '@ergots/scorex'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'

const SINT: SType = { tag: 'SInt' }
const int = (v: number): SValue => ({ kind: 'Int', value: v })

/**
 * Read one register value whose wire bytes are `hex`. The bytes are framed as a
 * one-register additional-registers section (`01` + bytes), consumed whole by
 * `parseAdditionalRegisters` — the entry point on a real box
 * (`org/ergoplatform/ErgoBoxCandidate.scala:226-234` at 6.0.7).
 */
function readRegister(hex: string, treeVersion = 3): { tpe: SType; value: SValue; opaqueBytes?: Uint8Array } {
  const bytes = hexToBytes(hex)
  const framed = new Uint8Array(bytes.length + 1)
  framed[0] = 1
  framed.set(bytes, 1)
  const r = new ByteReader(framed)
  const regs = parseAdditionalRegisters(r, treeVersion)
  expect(r.isExhausted).toBe(true)
  const entry = regs[4]
  expect(entry).toBeDefined()
  return entry!
}

describe('the register reader gives a Tuple expression the Coll[Any] of Tuple.value', () => {
  it('Tuple(1, 2, 3): value is tupleColl of three Ints; tpe is STuple of three SInts', () => {
    const r4 = readRegister('8603040204040406')
    expect(r4.value).toEqual(tupleColl([int(1), int(2), int(3)]))
    expect(r4.tpe).toEqual({ tag: 'STuple', items: [SINT, SINT, SINT] })
  })

  it('Tuple(1, 2): value is tupleColl of two Ints (not a pair)', () => {
    const r4 = readRegister('860204020404')
    expect(r4.value).toEqual(tupleColl([int(1), int(2)]))
    expect(r4.tpe).toEqual({ tag: 'STuple', items: [SINT, SINT] })
  })

  it('Tuple(Tuple(1), 1): inner one-item Tuple expression gives tupleColl of one Int', () => {
    const r4 = readRegister('8602860104020402')
    expect(r4.value).toEqual(tupleColl([tupleColl([int(1)]), int(1)]))
    expect(r4.tpe).toEqual({
      tag: 'STuple',
      items: [{ tag: 'STuple', items: [SINT] }, SINT],
    })
  })

  it('Tuple(): value is the empty tupleColl; tpe is STuple of no items', () => {
    const r4 = readRegister('8600')
    expect(r4.value).toEqual(tupleColl([]))
    expect(r4.tpe).toEqual({ tag: 'STuple', items: [] })
  })

  it('a count byte 0x80 (signed -128) is refused by safeNewArray', () => {
    expect(() => readRegister('8680')).toThrow(SValueParseError)
  })

  it('the register keeps its wire bytes in opaqueBytes', () => {
    // The register's node stays the expression, not the value: the box's bytes,
    // its id, its serialize cost and the storage-rent register equality read
    // these bytes (`facts/transaction.md`, §3a "Storage-rent register equality").
    const r4 = readRegister('860204020404')
    expect(r4.opaqueBytes).toEqual(hexToBytes('860204020404'))
  })
})

/**
 * A box whose R4 holds the `Tuple(1, 2)` EXPRESSION keeps its bytes and its id
 * across a parse, and its serialize cost reads the register's wire bytes
 * (`eval/serialize-cost.ts`: the register walk over `opaqueBytes`). None of
 * these depend on the value the register's read gives.
 *
 * The full box bytes:
 *   64                                                           value VLQ u64 = 100
 *   0008d3                                                       ergoTree: header 0x00, body 08 d3 (SSigmaProp constant)
 *   00                                                           creation_height VLQ = 0
 *   00                                                           tokens_count raw u8 = 0
 *   01                                                           additional_regs count raw u8 = 1
 *   860204020404                                                 R4: Tuple expression (1, 2)
 *   00...00 (32 bytes)                                           transaction_id
 *   00                                                           index VLQ u16 = 0
 */
const TUPLE_EXPR_BOX_HEX =
  '64' +
  '0008d3' +
  '00' +
  '00' +
  '01' +
  '860204020404' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '00'

describe('a box whose R4 is the Tuple(1, 2) EXPRESSION keeps its bytes and its id', () => {
  const rawBytes = hexToBytes(TUPLE_EXPR_BOX_HEX)

  it('parses R4 as tupleColl([1, 2]) with opaqueBytes retained', () => {
    const sv = parseSValue({ tag: 'SBox' }, 3, new ByteReader(rawBytes))
    if (sv.kind !== 'Box') throw new Error(`unreachable: ${sv.kind}`)
    const r4 = sv.value.registers[4]
    expect(r4).toBeDefined()
    expect(r4!.value).toEqual(tupleColl([int(1), int(2)]))
    expect(r4!.opaqueBytes).toEqual(hexToBytes('860204020404'))
  })

  it('boxBytesOf(parsed) equals the input bytes', () => {
    const sv = parseSValue({ tag: 'SBox' }, 3, new ByteReader(rawBytes))
    if (sv.kind !== 'Box') throw new Error(`unreachable: ${sv.kind}`)
    const bytes = boxBytesOf(sv.value)
    expect(bytes).toEqual(rawBytes)
  })

  it('boxIdOf(parsed) equals blake2b256(rawBytes)', () => {
    const sv = parseSValue({ tag: 'SBox' }, 3, new ByteReader(rawBytes))
    if (sv.kind !== 'Box') throw new Error(`unreachable: ${sv.kind}`)
    const id = boxIdOf(sv.value)
    expect(id).toEqual(blake2b256(rawBytes))
  })

  it('after a SizeOf on the R4 value the box bytes and the box id are unchanged', () => {
    // The register's node stays the expression: a read of R4 reads its value,
    // but does not rewrite the register. The box's bytes and its id are
    // derived from the retained wire slice, not the value.
    const sv = parseSValue({ tag: 'SBox' }, 3, new ByteReader(rawBytes))
    if (sv.kind !== 'Box') throw new Error(`unreachable: ${sv.kind}`)
    const bytesBefore = boxBytesOf(sv.value)
    const idBefore = boxIdOf(sv.value)
    // `SizeOf(ExtractRegisterAs[(Int, Int)](SELF, R4).get)` — a read of R4's
    // value: `getReg[(Int, Int)].get` hands the `Coll[Any]`; `SizeOf` answers 2.
    const pairTpe: SType = { tag: 'STuple', items: [SINT, SINT] }
    const sizeExpr: Expr = {
      tag: 'SizeOf',
      input: {
        tag: 'OptionGet',
        input: {
          tag: 'ExtractRegisterAs',
          input: { tag: 'Const', tpe: { tag: 'SBox' }, value: sv },
          registerId: 4,
          elemTpe: pairTpe,
        },
      },
    }
    const result = evalExpr(sizeExpr, Env.empty(), makeContext({ treeVersion: 3 }))
    expect(result).toEqual(int(2))
    expect(boxBytesOf(sv.value)).toEqual(bytesBefore)
    expect(boxIdOf(sv.value)).toEqual(idBefore)
  })

  it('serialize cost of the parsed box reads the register wire bytes', () => {
    // The register walk in `addBoxCost` reads `opaqueBytes`
    // (`eval/serialize-cost.ts:497-512`), not the value. The expression box
    // and a twin whose R4 is the equal constant `(1, 2)` pair differ by their
    // register walks only, and they are pinned at distinct figures: a
    // `value`-reading regression collapses the pin because both branches would
    // cost the same.
    //
    // Hand derivation (walker rules in `eval/serialize-cost.ts`, JVM
    // `ErgoBoxCandidate.scala:138-181` + `SigmaByteWriter.scala:45-185`):
    //
    //   shared box walk (`addBoxCost` outside the register loop):
    //     putULong(value=100)                   = 3     (PUT_NUM3)
    //     putBytes(serializeErgoTree(0008d3))   = 3+3   (3-byte reencoded tree)
    //     putUInt(creationHeight=0)             = 0     (no-DataInfo overload)
    //     putUByte(nTokens=0)                   = 1
    //     putUByte(nRegs=1)                     = 1
    //     putBytes(txId, 32)                    = 35
    //     putUShort(index=0)                    = 3     (PUT_NUM3)
    //     shared subtotal                       = 46
    //
    //   expression register `86 02 04 02 04 04` (`addRegisterExprCost`,
    //   OP_TUPLE branch):
    //     w.put(TupleCode)                      = 1
    //     putUByte(count=2)                     = 1
    //     per item (Constant, SInt lead 0x04):
    //       putType(SInt)                       = 1
    //       DataSerializer(Int)                 = 3     (PUT_NUM3)
    //     2 items × 4                           = 8
    //     register walk                         = 10
    //     total                                 = 46 + 10 + 3 (tree hdr) = 59
    //
    //   constant register `58 02 04` (the `58` is the symmetric-pair-of-SInt
    //   type code, `PAIR_SYMMETRIC (84) + SInt_prim (4)`):
    //     putType(STuple[SInt, SInt])           = 1     (one byte, pair-sym)
    //     DataSerializer(STuple pair):
    //       per item SInt                       = 3     (PUT_NUM3)
    //     register walk                         = 1 + 3 + 3 = 7
    //     total                                 = 46 + 7 + 3 (tree hdr)  = 56
    //
    // The addBoxCost framework charges `3 + treeLen` where treeLen for the
    // reencoded `00 08 d3` is 3, so each total is shared + register + 3.
    const sv = parseSValue({ tag: 'SBox' }, 3, new ByteReader(rawBytes))
    if (sv.kind !== 'Box') throw new Error(`unreachable: ${sv.kind}`)
    const ctx = makeContext({ treeVersion: 3 })
    serializeCost({ tag: 'SBox' }, sv, ctx)
    expect(ctx.jitCost).toBe(59)
    // The constant-pair twin: R4 = `(1, 2)` as a `(SInt, SInt)` Constant, wire
    // `58 02 04`. Everything else is the same box.
    const CONST_TWIN_HEX =
      '64' +
      '0008d3' +
      '00' +
      '00' +
      '01' +
      '580204' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '00'
    const twin = parseSValue({ tag: 'SBox' }, 3, new ByteReader(hexToBytes(CONST_TWIN_HEX)))
    if (twin.kind !== 'Box') throw new Error(`unreachable: ${twin.kind}`)
    const twinCtx = makeContext({ treeVersion: 3 })
    serializeCost({ tag: 'SBox' }, twin, twinCtx)
    expect(twinCtx.jitCost).toBe(56)
    // The two figures differ: the register walk reads a different path for
    // each register. A walker that reads `entry.value` under `entry.tpe` for
    // the expression register would collapse the two figures.
    expect(ctx.jitCost).not.toBe(twinCtx.jitCost)
    // Round-trip through the writer: the same bytes come back.
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, sv, 3, w)
    expect(w.toBytes()).toEqual(rawBytes)
    // Reparse of the written bytes gives the same cost.
    const sv2 = parseSValue({ tag: 'SBox' }, 3, new ByteReader(w.toBytes()))
    const ctx2 = makeContext({ treeVersion: 3 })
    serializeCost({ tag: 'SBox' }, sv2, ctx2)
    expect(ctx2.jitCost).toBe(ctx.jitCost)
  })
})
