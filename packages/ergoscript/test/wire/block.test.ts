import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { expectParseError } from './_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 11 tests: `BlockValue`, `ValDef`, and `ValUse` round-trips. Drives
 * the parsers end-to-end via the `parseTree` / `serializeTree` envelope so
 * the per-variant code runs in its real call context.
 *
 * Wire format reminders (verified against sigma-rust source):
 *   - `BlockValue` (opcode 0xd8): VLQ-u32 items count, each item Expr, then
 *     a result Expr. Mirrors `mir/block.rs::BlockValue::sigma_serialize`.
 *   - `ValDef` (opcode 0xd6): VLQ-u32 id, then rhs Expr. Side-effect at
 *     parse time: registers `(id, rhs.tpe)` in a scope-wide map. Mirrors
 *     `mir/val_def.rs::ValDef::sigma_parse`.
 *   - `ValUse` (opcode 0x72): VLQ-u32 val_id ONLY. The `tpe` is NOT on the
 *     wire — it is recovered from the val-def-type-store populated by the
 *     enclosing scope's ValDef bindings. Mirrors `mir/val_use.rs::ValUse`.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/block.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/val_def.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/val_use.rs
 */

describe('BlockValue + ValDef + ValUse', () => {
  it('round-trips a simple block with one ValDef and a ValUse result', () => {
    // AST: let x:SInt = 42 in x
    //
    // bytes layout:
    //   0x00       header (v0, no size, no segregation)
    //   0xd8       OP_BLOCK_VALUE
    //   0x01       items.length VLQ-u32 = 1
    //   0xd6       OP_VAL_DEF (item 0)
    //   0x00         id VLQ-u32 = 0
    //   0x04         SInt type code (= inline-Const opcode)
    //   0x54         ZigZag(42) = 84 = 0x54
    //   0x72       OP_VAL_USE (result)
    //   0x00         valId VLQ-u32 = 0
    const bytes = new Uint8Array([
      0x00, 0xd8, 0x01, 0xd6, 0x00, 0x04, 0x54, 0x72, 0x00
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('BlockValue')
    if (tree.body.tag !== 'BlockValue') throw new Error('unreachable')
    expect(tree.body.items.length).toBe(1)

    const item0 = tree.body.items[0]!
    expect(item0.tag).toBe('ValDef')
    if (item0.tag !== 'ValDef') throw new Error('unreachable')
    expect(item0.id).toBe(0)
    expect(item0.rhs.tag).toBe('Const')
    if (item0.rhs.tag !== 'Const') throw new Error('unreachable')
    expect(item0.rhs.tpe).toEqual({ tag: 'SInt' })
    expect(item0.rhs.value).toEqual({ kind: 'Int', value: 42 })

    expect(tree.body.result.tag).toBe('ValUse')
    if (tree.body.result.tag !== 'ValUse') throw new Error('unreachable')
    expect(tree.body.result.valId).toBe(0)
    // tpe was recovered from the val-def-type-store, NOT from the wire.
    expect(tree.body.result.tpe).toEqual({ tag: 'SInt' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips a block with multiple ValDefs', () => {
    // AST: let a:SInt = 42; let b:SBoolean = true in a
    //
    // bytes:
    //   0x00       header
    //   0xd8       OP_BLOCK_VALUE
    //   0x02       items.length = 2
    //   0xd6 0x00 0x04 0x54   ValDef(0, Const(SInt 42))
    //   0xd6 0x01 0x01 0x01   ValDef(1, Const(SBoolean true))
    //   0x72 0x00             ValUse(0)  -> tpe restored as SInt
    const bytes = new Uint8Array([
      0x00, 0xd8, 0x02,
      0xd6, 0x00, 0x04, 0x54,
      0xd6, 0x01, 0x01, 0x01,
      0x72, 0x00
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('BlockValue')
    if (tree.body.tag !== 'BlockValue') throw new Error('unreachable')
    expect(tree.body.items.length).toBe(2)
    expect(tree.body.result.tag).toBe('ValUse')
    if (tree.body.result.tag !== 'ValUse') throw new Error('unreachable')
    expect(tree.body.result.tpe).toEqual({ tag: 'SInt' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips a block referencing the second ValDef (id=1)', () => {
    // Same as above but result is ValUse(1) — confirms the type-store maps
    // multiple bindings correctly and the right tpe is reattached.
    const bytes = new Uint8Array([
      0x00, 0xd8, 0x02,
      0xd6, 0x00, 0x04, 0x54,
      0xd6, 0x01, 0x01, 0x01,
      0x72, 0x01
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BlockValue') throw new Error('unreachable')
    if (tree.body.result.tag !== 'ValUse') throw new Error('unreachable')
    expect(tree.body.result.valId).toBe(1)
    expect(tree.body.result.tpe).toEqual({ tag: 'SBoolean' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips a block with an empty items list', () => {
    // Sigma-rust accepts empty items: `Vec::sigma_parse` reads count=0 and
    // returns an empty Vec. The result Expr is parsed unconditionally. We
    // mirror that — rejecting would diverge from sigma-rust.
    //
    // bytes:
    //   0x00       header
    //   0xd8       OP_BLOCK_VALUE
    //   0x00       items.length = 0
    //   0x04 0x54  result = Const(SInt 42)
    const bytes = new Uint8Array([0x00, 0xd8, 0x00, 0x04, 0x54])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BlockValue') throw new Error('unreachable')
    expect(tree.body.items.length).toBe(0)
    expect(tree.body.result.tag).toBe('Const')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('rejects a top-level ValUse with no preceding ValDef', () => {
    // A bare ValUse at the body root (no enclosing BlockValue → no ValDef
    // populated the type-store) must fail with `val-use-unknown-id`.
    //
    // bytes: 0x00 (header) 0x72 (OP_VAL_USE) 0x05 (valId=5)
    const bytes = new Uint8Array([0x00, 0x72, 0x05])
    expectParseError(() => parseTree(bytes), 'val-use-unknown-id')
  })

  it('builds and serializes BlockValue programmatically', () => {
    // Programmatic construction: hand-build a BlockValue AST, serialize, and
    // re-parse to confirm round-trip from the AST side (not just the bytes
    // side). Equivalent to the third Task 10 test for Const.
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
        tag: 'BlockValue',
        items: [
          {
            tag: 'ValDef',
            id: 0,
            rhs: {
              tag: 'Const',
              tpe: { tag: 'SLong' },
              value: { kind: 'Long', value: 1n }
            }
          }
        ],
        result: {
          tag: 'ValUse',
          valId: 0,
          tpe: { tag: 'SLong' }
        }
      }
    }
    const out = serializeTree(tree)
    // header + OP_BLOCK_VALUE + count=1 + OP_VAL_DEF + id=0 + SLong code (0x05)
    //   + ZigZag(1)=2 (0x02) + OP_VAL_USE + valId=0
    expect(Array.from(out)).toEqual([
      0x00, 0xd8, 0x01, 0xd6, 0x00, 0x05, 0x02, 0x72, 0x00
    ])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'BlockValue') throw new Error('unreachable')
    expect(reparsed.body.items.length).toBe(1)
    if (reparsed.body.result.tag !== 'ValUse') throw new Error('unreachable')
    expect(reparsed.body.result.tpe).toEqual({ tag: 'SLong' })
  })
})
