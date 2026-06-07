/**
 * Tuple wire-arity window — JVM TupleSerializer.scala parse/serialize asymmetry.
 *
 * PARSE (TupleSerializer.scala:27-36): count via SIGNED getByte(); 0x80..0xFF
 * sign-extend negative → safeNewArray → NegativeArraySizeException at parse.
 * NO lower gate (mkTuple bare, SigmaBuilder.scala:481-482; Tuple.tpe lazy) —
 * arity 0/1 PARSES and then eval-rejects ('tuple-invalid-arity',
 * values.scala:797).
 *   → ergots window: parse accepts 0..127, rejects ≥128 ('tuple-arity-out-of-range').
 *
 * SERIALIZE (TupleSerializer.scala:18-25): putUByte(length) + items — no arity
 * gate. 128..255 serializes but cannot re-parse (mirrored asymmetry).
 *
 * TYPE layer (TypeSerializer.scala:188-194 vs :93-94): generic-tuple TYPE
 * parse = getUByte + bare STuple(items) — arity-0/1 TYPES parse; TYPE
 * serialize rejects <2 ('tuple-too-short' / JVM sys.error).
 */
import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { serializeTree } from '../../src/wire/ergo-tree'
import { serializeTuple } from '../../src/wire/mir/tuple'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, captureEvalError } from '../_helpers'
import { expectParseError } from './_helpers'
import { ByteWriter } from '@ergots/scorex'
import type { Expr, Tuple } from '../../src/mir/types'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

describe('Tuple EXPR wire window (TupleSerializer.scala)', () => {
  it('arity-0 Tuple parses, round-trips, and eval-rejects', () => {
    const hex = '008600'
    const tree = parseTree(hexToBytes(hex))
    expect(bytesToHex(serializeTree(tree))).toBe(hex)
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    expect(captureEvalError(() => evaluateWith(tree, ctx)).code).toBe('tuple-invalid-arity')
  })

  it('arity-1 Tuple parses, round-trips, and eval-rejects', () => {
    const hex = '0086010101'
    const tree = parseTree(hexToBytes(hex))
    expect(bytesToHex(serializeTree(tree))).toBe(hex)
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    expect(captureEvalError(() => evaluateWith(tree, ctx)).code).toBe('tuple-invalid-arity')
  })

  it('arity-127 Tuple parses and round-trips (window boundary)', () => {
    const hex = '00867f' + '0101'.repeat(127)
    const tree = parseTree(hexToBytes(hex))
    expect(bytesToHex(serializeTree(tree))).toBe(hex)
  })

  it('arity-128 Tuple parse-rejects (JVM signed-byte read)', () => {
    const hex = '008680' + '0101'.repeat(128)
    expectParseError(() => parseTree(hexToBytes(hex)), 'tuple-arity-out-of-range')
  })

  it('EXPR serialize: arity-200 serializes (JVM putUByte, no arity gate); arity-256 rejects', () => {
    // TupleSerializer.scala:18-25 — serialize has NO arity gate up to the u8
    // range; 128..255 output is the one-way half of the signed-byte asymmetry
    // (ergots/JVM parse both reject it). >255 is unrepresentable → reject.
    const item: Expr = {
      tag: 'Const',
      tpe: { tag: 'SBoolean' },
      value: { kind: 'Boolean', value: true },
    }
    const t200: Tuple = {
      tag: 'Tuple',
      items: Array.from({ length: 200 }, () => ({ ...item })) as Expr[],
    }
    expect(() => serializeTuple(t200, new ByteWriter())).not.toThrow()
    const t256: Tuple = {
      tag: 'Tuple',
      items: Array.from({ length: 256 }, () => ({ ...item })) as Expr[],
    }
    expect(() => serializeTuple(t256, new ByteWriter())).toThrow(/exceeds 255/)
  })
})

describe('generic-tuple TYPE window (TypeSerializer.scala:188-194 vs :93-94)', () => {
  it('arity-1 generic-tuple constant TYPE parses and the constant evaluates', () => {
    // v0 unsegregated tree; body = inline constant: lead byte 0x60
    // (TUPLE_TYPECODE=96) → parseConstFromByte → parseSTypeWithFirstByte →
    // TUPLE_TYPECODE arm → reads len 1 + 0x04 (SInt); DATA = one Int
    // (zigzag 0x0a = 5). No STuple arity require in TypeSerializer:188-194.
    const tree = parseTree(hexToBytes('006001040a'))
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'Tuple', items: [{ kind: 'Int', value: 5 }] })
  })

  it('arity-1 STuple TYPE cannot re-serialize (TypeSerializer:93-94 asymmetry)', () => {
    // Mirrors JVM: TypeSerializer.scala:93-94 sys.error("<2 items"); our
    // serialize-stype rejects with code 'tuple-too-short'. The JVM itself is
    // parse/serialize asymmetric here — faithful mirror.
    const tree = parseTree(hexToBytes('006001040a'))
    expect(() => serializeTree(tree)).toThrow(/STuple must have/)
  })
})
