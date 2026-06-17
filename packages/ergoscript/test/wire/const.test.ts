import { describe, it, expect } from 'vitest'
import { serializeTree } from '../../src/wire/ergo-tree'
import { parseParsedTree as parseTree } from '../_helpers'
import { expectParseError } from './_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 10 tests: inline `Const` + `ConstantPlaceholder` round-trip and the
 * out-of-range-id rejection. The tests drive the parsers end-to-end via the
 * `parseTree` / `serializeTree` envelope so the per-variant code is exercised
 * in its real call context, not in isolation.
 *
 * Wire format reminders:
 *   - Inline `Const` uses the SType's first byte as the Expr-dispatch opcode
 *     (no separate opcode prefix). For SBoolean that's 0x01; for SInt 0x04.
 *     SValue bytes follow, driven by the SType.
 *   - `ConstantPlaceholder` is opcode 0x73 followed by a VLQ-u32 id into
 *     `tree.constantTypes`. Its `tpe` is recovered from the table on parse;
 *     the wire payload is just the id.
 */

describe('inline Const variant', () => {
  it('round-trips Const(SBoolean true)', () => {
    // header=0x00 (v0, no size, no segregation)
    // body=[0x01 (SBoolean type code = opcode for inline Const),
    //       0x01 (SBoolean true)]
    const bytes = new Uint8Array([0x00, 0x01, 0x01])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Const')
    if (tree.body.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SBoolean' })
    expect(tree.body.value).toEqual({ kind: 'Boolean', value: true })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips Const(SInt 42)', () => {
    // header=0x00
    // body=[0x04 (SInt type code = opcode), 0x54 (ZigZag VLQ of 42)]
    // ZigZag(42) = 42*2 = 84 = 0x54 (single byte; MSB clear → no continuation)
    const bytes = new Uint8Array([0x00, 0x04, 0x54])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Const')
    if (tree.body.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SInt' })
    expect(tree.body.value).toEqual({ kind: 'Int', value: 42 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('ConstantPlaceholder variant', () => {
  it('round-trips a segregated-constants tree with placeholder', () => {
    // header=0x10 (constantSegregation, no hasSize, v0)
    // count=0x01 (1 segregated constant)
    // constants: SBoolean (type 0x01) + value true (0x01)
    // body=[0x73 (OP_CONSTANT_PLACEHOLDER), 0x00 (VLQ id=0)]
    const bytes = new Uint8Array([0x10, 0x01, 0x01, 0x01, 0x73, 0x00])

    const tree = parseTree(bytes)
    expect(tree.constantTypes).toEqual([{ tag: 'SBoolean' }])
    expect(tree.constants).toEqual([{ kind: 'Boolean', value: true }])
    expect(tree.body.tag).toBe('ConstPlaceholder')
    if (tree.body.tag !== 'ConstPlaceholder') throw new Error('unreachable')
    expect(tree.body.id).toBe(0)
    expect(tree.body.tpe).toEqual({ tag: 'SBoolean' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('rejects placeholder with out-of-range id', () => {
    // header=0x10 (segregation, v0), count=0x00 (no segregated constants),
    // body OP_CONSTANT_PLACEHOLDER (0x73) + id=0x00. id=0 is out of range
    // when no constants exist.
    const bytes = new Uint8Array([0x10, 0x00, 0x73, 0x00])
    expectParseError(
      () => parseTree(bytes),
      'invalid-constant-placeholder-id'
    )
  })
})

describe('Const serialization (programmatic build)', () => {
  it('builds and serializes Const(SLong 1) from scratch', () => {
    // Programmatic construction — make sure a hand-built ErgoTree with a
    // Const body serializes correctly. SLong type code = 0x05, value 1
    // (ZigZag) = 2 = 0x02.
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00
      },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'Const',
        tpe: { tag: 'SLong' },
        value: { kind: 'Long', value: 1n }
      }
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0x05, 0x02])

    // And round-trip: re-parse the serialized bytes and confirm equality.
    const reparsed = parseTree(out)
    expect(reparsed.body.tag).toBe('Const')
    if (reparsed.body.tag !== 'Const') throw new Error('unreachable')
    expect(reparsed.body.tpe).toEqual({ tag: 'SLong' })
    expect(reparsed.body.value).toEqual({ kind: 'Long', value: 1n })
  })
})
