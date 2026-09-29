/**
 * ValDef.id Int.MaxValue bound (audit REL-WIRE-ID-01).
 *
 * The JVM `ValDefSerializer` parses `id` with `getUIntExact` (`ValDefSerializer.scala:31`):
 * `getUInt`, which rejects a value above u32 (here `ReaderError('vlq-overflow')`), then
 * `toIntExact`, which rejects one above `Int.MaxValue` (0x7fffffff). ergots once read
 * it with `readVlqU()` and bound/evaluated an id such as 0x80000000 — an
 * over-acceptance of trees the JVM rejects.
 *
 * The fix is narrow: ONLY `ValDef.id` (parse + serialize). `ValUse.id` and
 * `FuncValue` argument ids use the JVM's wrapping `getUInt().toInt` and are not
 * bound to `Int.MaxValue` (per the SANTA disposition; see count-bounds.test.ts).
 *
 * Parse boundary uses the JVM-blessed bytes from SANTA
 * ValDef.id_int_max_bound.json (vendored into test/fixtures/conformance/v5/
 * authored): `{ val x = 7; x }` with id 0x7fffffff (accept) vs 0x80000000
 * (reject).
 */
import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { serializeExpr } from '../../src/wire/serialize'
import { ByteWriter, ReaderError } from '@ergots/scorex'
import { ExprParseError, ExprSerializeError } from '../../src/wire/errors'
import { hexToBytes } from '../_helpers'
import type { Expr } from '../../src/mir/types'

// SANTA-blessed boundary trees (same script, id differs).
const ACCEPT_HEX = '1001040ed801d6ffffffff07730072ffffffff07' // ValDef.id = 0x7fffffff
const OVERFLOW_HEX = '1001040ed801d680808080087300728080808008' // ValDef.id = 0x80000000

const block = (id: number): Expr => ({
  tag: 'BlockValue',
  items: [{ tag: 'ValDef', id, rhs: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 7 } } }],
  result: { tag: 'ValUse', valId: id, tpe: { tag: 'SInt' } },
})

describe('ValDef.id Int.MaxValue bound (REL-WIRE-ID-01)', () => {
  it('parseTree accepts ValDef.id = 0x7fffffff (the inclusive boundary)', () => {
    expect(() => parseTree(hexToBytes(ACCEPT_HEX))).not.toThrow()
  })

  it('parseTree rejects ValDef.id = 0x80000000 with val-def-id-out-of-range', () => {
    let err: unknown
    try {
      parseTree(hexToBytes(OVERFLOW_HEX))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ExprParseError)
    expect((err as ExprParseError).code).toBe('val-def-id-out-of-range')
  })

  // Same tree with the id re-encoded (ValDef and ValUse): 2^32-1 is a u32 that toIntExact
  // rejects; 2^32 is above u32, so getUInt rejects it before toIntExact runs.
  const withId = (vlqHex: string) => hexToBytes(`1001040ed801d6${vlqHex}730072${vlqHex}`)
  const errOf = (bytes: Uint8Array) => { try { parseTree(bytes); return undefined } catch (e) { return e } }

  it('parseTree rejects ValDef.id = 2^32-1 with val-def-id-out-of-range (toIntExact)', () => {
    const err = errOf(withId('ffffffff0f'))
    expect(err).toBeInstanceOf(ExprParseError)
    expect((err as ExprParseError).code).toBe('val-def-id-out-of-range')
  })

  it('parseTree rejects ValDef.id = 2^32 with vlq-overflow (getUInt, above u32)', () => {
    const err = errOf(withId('8080808010'))
    expect(err).toBeInstanceOf(ReaderError)
    expect((err as ReaderError).code).toBe('vlq-overflow')
  })

  it('serializeExpr rejects a locally-built ValDef.id = 0x80000000', () => {
    let err: unknown
    try {
      serializeExpr(block(0x80000000), new ByteWriter(), 0)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ExprSerializeError)
    expect((err as ExprSerializeError).code).toBe('val-def-id-out-of-range')
  })

  it('serializeExpr accepts a locally-built ValDef.id = 0x7fffffff', () => {
    expect(() => serializeExpr(block(0x7fffffff), new ByteWriter(), 0)).not.toThrow()
  })

  it('serializeExpr rejects a locally-built ValDef.id that is negative or no integer, as a JVM Int getUIntExact cannot give', () => {
    for (const id of [-1, 1.5]) {
      let err: unknown
      try {
        serializeExpr(block(id), new ByteWriter(), 0)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ExprSerializeError)
      expect((err as ExprSerializeError).code).toBe('val-def-id-out-of-range')
    }
  })
})
