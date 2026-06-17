import { describe, it, expect } from 'vitest'
import { serializeTree } from '../../src/wire/ergo-tree'
import { parseParsedTree as parseTree } from '../_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 24 tests: `SubstConstants` round-trips. Drives the parser end-to-end
 * via the `parseTree` / `serializeTree` envelope so the per-variant code runs
 * in its real call context.
 *
 * Wire format (sigma-rust `mir/subst_const.rs:64-78`):
 *   [OP_SUBST_CONSTANTS opcode = 0x74]
 *   [scriptBytes: Expr]   -- post-eval type SColl(SByte)
 *   [positions: Expr]     -- post-eval type SColl(SInt)
 *   [newValues: Expr]     -- post-eval type SColl(T) for some T
 *
 * Three Expr nodes in order, no length prefix. Returns `Coll[Byte]`.
 *
 * Sigma-rust's `SubstConstants::new` enforces per-operand post-eval types;
 * we do NOT enforce that at the wire layer (same convention as Xor,
 * BoolToSigmaProp, etc.).
 *
 * Const encoding cheat-sheet for the byte vectors below
 * (see `wire/serialize-stype.ts` and `wire/serialize-svalue.ts`):
 *   - SColl(SByte) typecode = 12 + 2 = 14 = 0x0e
 *       payload: VLQ-u16 length, then raw bytes (NativeColl optimization).
 *   - SColl(SInt) typecode  = 12 + 4 = 16 = 0x10
 *       payload: VLQ-u16 length, then each item ZigZag-VLQ (ZigZag(n) = 2n
 *       for n>=0, so 0 -> 0x00, 1 -> 0x02, 2 -> 0x04, ...).
 *   - SColl(SLong) typecode = 12 + 5 = 17 = 0x11
 *       payload: VLQ-u16 length, then each item ZigZag-VLQ (as BigInt).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/subst_const.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::SUBST_CONSTANTS = 0x74)
 */

describe('SubstConstants variant', () => {
  it('round-trips SubstConstants(scriptBytes=Coll[Byte], positions=Coll[Int], newValues=Coll[Long])', () => {
    // AST: SubstConstants(
    //        scriptBytes = Const(SColl(SByte) [0xde, 0xad, 0xbe, 0xef]),
    //        positions   = Const(SColl(SInt)  [0, 1]),
    //        newValues   = Const(SColl(SLong) [7, 8]),
    //      )
    //
    // bytes:
    //   0x00                           header (v0, no size, no segregation)
    //   0x74                           OP_SUBST_CONSTANTS
    //   0x0e                           Const SType-code = SColl(SByte)
    //     0x04                         VLQ-u16 len = 4
    //     0xde 0xad 0xbe 0xef          raw 4 bytes
    //   0x10                           Const SType-code = SColl(SInt)
    //     0x02                         VLQ-u16 len = 2
    //     0x00 0x02                    items ZigZag VLQ: ZZ(0)=0, ZZ(1)=2
    //   0x11                           Const SType-code = SColl(SLong)
    //     0x02                         VLQ-u16 len = 2
    //     0x0e 0x10                    items ZigZag VLQ: ZZ(7)=14, ZZ(8)=16
    const bytes = new Uint8Array([
      0x00,
      0x74,
      0x0e, 0x04, 0xde, 0xad, 0xbe, 0xef,
      0x10, 0x02, 0x00, 0x02,
      0x11, 0x02, 0x0e, 0x10,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('SubstConstants')
    if (tree.body.tag !== 'SubstConstants') throw new Error('unreachable')

    // scriptBytes
    if (tree.body.scriptBytes.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.scriptBytes.tpe).toEqual({
      tag: 'SColl',
      elem: { tag: 'SByte' },
    })
    if (tree.body.scriptBytes.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.scriptBytes.value.items).toHaveLength(4)

    // positions
    if (tree.body.positions.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.positions.tpe).toEqual({
      tag: 'SColl',
      elem: { tag: 'SInt' },
    })
    if (tree.body.positions.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.positions.value.items).toHaveLength(2)
    expect(tree.body.positions.value.items[0]).toEqual({ kind: 'Int', value: 0 })
    expect(tree.body.positions.value.items[1]).toEqual({ kind: 'Int', value: 1 })

    // newValues
    if (tree.body.newValues.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.newValues.tpe).toEqual({
      tag: 'SColl',
      elem: { tag: 'SLong' },
    })
    if (tree.body.newValues.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.newValues.value.items).toHaveLength(2)
    expect(tree.body.newValues.value.items[0]).toEqual({ kind: 'Long', value: 7n })
    expect(tree.body.newValues.value.items[1]).toEqual({ kind: 'Long', value: 8n })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes SubstConstants programmatically', () => {
    // Programmatic build: pick byte-distinguishable contents so the
    // round-trip distinguishes positions and newValues by content.
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00,
      },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'SubstConstants',
        scriptBytes: {
          tag: 'Const',
          tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
          value: {
            kind: 'Coll',
            elem: { tag: 'SByte' },
            items: [
              { kind: 'Byte', value: 0x10 },
              { kind: 'Byte', value: 0x20 },
            ],
          },
        },
        positions: {
          tag: 'Const',
          tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
          value: {
            kind: 'Coll',
            elem: { tag: 'SInt' },
            items: [{ kind: 'Int', value: 2 }],
          },
        },
        newValues: {
          tag: 'Const',
          tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
          value: {
            kind: 'Coll',
            elem: { tag: 'SInt' },
            items: [{ kind: 'Int', value: 3 }],
          },
        },
      },
    }
    const out = serializeTree(tree)
    // header + OP_SUBST_CONSTANTS
    //   + SColl(SByte)(0x0e) + len(2) + [0x10, 0x20]
    //   + SColl(SInt)(0x10)  + len(1) + ZZ(2)=4 (0x04)
    //   + SColl(SInt)(0x10)  + len(1) + ZZ(3)=6 (0x06)
    expect(Array.from(out)).toEqual([
      0x00,
      0x74,
      0x0e, 0x02, 0x10, 0x20,
      0x10, 0x01, 0x04,
      0x10, 0x01, 0x06,
    ])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'SubstConstants') throw new Error('unreachable')

    if (reparsed.body.scriptBytes.tag !== 'Const') throw new Error('unreachable')
    if (reparsed.body.scriptBytes.value.kind !== 'Coll') throw new Error('unreachable')
    expect(reparsed.body.scriptBytes.value.items).toHaveLength(2)

    if (reparsed.body.positions.tag !== 'Const') throw new Error('unreachable')
    if (reparsed.body.positions.value.kind !== 'Coll') throw new Error('unreachable')
    expect(reparsed.body.positions.value.items[0]).toEqual({ kind: 'Int', value: 2 })

    if (reparsed.body.newValues.tag !== 'Const') throw new Error('unreachable')
    if (reparsed.body.newValues.value.kind !== 'Coll') throw new Error('unreachable')
    expect(reparsed.body.newValues.value.items[0]).toEqual({ kind: 'Int', value: 3 })
  })
})
