import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { expectParseError } from './_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 12 tests: `If`, `FuncValue`, and `Apply` round-trips. Drives the
 * parsers end-to-end via the `parseTree` / `serializeTree` envelope so the
 * per-variant code runs in its real call context.
 *
 * Wire format reminders (verified against sigma-rust source):
 *   - `If` (opcode 0x95): condition Expr + true-branch Expr + false-branch
 *     Expr (no payload prefix; three Expr nodes in order). Mirrors
 *     `mir/if_op.rs::If::sigma_serialize`.
 *   - `FuncValue` (opcode 0xd9): VLQ-u32 args count, each arg as
 *     (VLQ-u32 id, SType), then a body Expr. Side-effect at parse time:
 *     each arg inserts `(id, tpe)` into the shared val-def-type-store WITHOUT
 *     scoping (mirrors sigma-rust's HashMap::insert semantics on the
 *     shared `r.val_def_type_store()`). Mirrors `mir/func_value.rs`.
 *   - `Apply` (opcode 0xda): function Expr + VLQ-u32 args count + each arg
 *     Expr. Mirrors `mir/apply.rs::Apply::sigma_serialize` (which delegates
 *     args to `Vec<Expr>::sigma_serialize`).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/if_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/func_value.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/apply.rs
 */

describe('If variant', () => {
  it('round-trips If(true, 1, 2)', () => {
    // AST: if (true) 1 else 2
    //
    // bytes layout:
    //   0x00   header (v0, no size, no segregation)
    //   0x95   OP_IF
    //   0x01 0x01   condition = Const(SBoolean true)
    //   0x04 0x02   true-branch = Const(SInt 1)  (ZigZag(1) = 2)
    //   0x04 0x04   false-branch = Const(SInt 2) (ZigZag(2) = 4)
    const bytes = new Uint8Array([
      0x00,
      0x95,
      0x01, 0x01,
      0x04, 0x02,
      0x04, 0x04
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('If')
    if (tree.body.tag !== 'If') throw new Error('unreachable')
    expect(tree.body.condition.tag).toBe('Const')
    expect(tree.body.trueBranch.tag).toBe('Const')
    expect(tree.body.falseBranch.tag).toBe('Const')
    if (
      tree.body.condition.tag !== 'Const' ||
      tree.body.trueBranch.tag !== 'Const' ||
      tree.body.falseBranch.tag !== 'Const'
    ) {
      throw new Error('unreachable')
    }
    expect(tree.body.condition.value).toEqual({ kind: 'Boolean', value: true })
    expect(tree.body.trueBranch.value).toEqual({ kind: 'Int', value: 1 })
    expect(tree.body.falseBranch.value).toEqual({ kind: 'Int', value: 2 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips If with nested If in true-branch', () => {
    // AST: if (true) (if (false) 1 else 2) else 3
    //
    // Confirms recursive Expr parsing through the If dispatcher.
    const bytes = new Uint8Array([
      0x00,
      0x95,
      0x01, 0x01,                // condition: true
      0x95, 0x01, 0x00,          // inner If
        0x04, 0x02,              //   inner true-branch: 1
        0x04, 0x04,              //   inner false-branch: 2
      0x04, 0x06                 // outer false-branch: 3 (ZigZag(3) = 6)
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'If') throw new Error('unreachable')
    expect(tree.body.trueBranch.tag).toBe('If')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes If programmatically', () => {
    // Programmatic construction — confirm that an AST built from scratch
    // round-trips through serialize + re-parse.
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
        tag: 'If',
        condition: {
          tag: 'Const',
          tpe: { tag: 'SBoolean' },
          value: { kind: 'Boolean', value: false }
        },
        trueBranch: {
          tag: 'Const',
          tpe: { tag: 'SLong' },
          value: { kind: 'Long', value: 10n }
        },
        falseBranch: {
          tag: 'Const',
          tpe: { tag: 'SLong' },
          value: { kind: 'Long', value: 20n }
        }
      }
    }
    const out = serializeTree(tree)
    // header + OP_IF + SBoolean code (0x01) + false (0x00)
    //   + SLong code (0x05) + ZigZag(10)=20 (0x14)
    //   + SLong code (0x05) + ZigZag(20)=40 (0x28)
    expect(Array.from(out)).toEqual([
      0x00, 0x95, 0x01, 0x00, 0x05, 0x14, 0x05, 0x28
    ])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'If') throw new Error('unreachable')
    if (reparsed.body.condition.tag !== 'Const') throw new Error('unreachable')
    expect(reparsed.body.condition.value).toEqual({
      kind: 'Boolean',
      value: false
    })
  })
})

describe('FuncValue variant', () => {
  it('round-trips a FuncValue with one SInt arg whose body returns the arg', () => {
    // AST: (v0: SInt) => v0
    //
    // bytes layout:
    //   0x00   header
    //   0xd9   OP_FUNC_VALUE
    //   0x01   args count VLQ-u32 = 1
    //   0x00   args[0].id VLQ-u32 = 0
    //   0x04   args[0].tpe = SInt (primId=4)
    //   0x72   OP_VAL_USE (body)
    //   0x00     valId = 0  (tpe recovered from valDefTypes store)
    const bytes = new Uint8Array([
      0x00,
      0xd9,
      0x01,
      0x00, 0x04,
      0x72, 0x00
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('FuncValue')
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    expect(tree.body.args.length).toBe(1)
    expect(tree.body.args[0]).toEqual({ id: 0, tpe: { tag: 'SInt' } })
    expect(tree.body.body.tag).toBe('ValUse')
    if (tree.body.body.tag !== 'ValUse') throw new Error('unreachable')
    expect(tree.body.body.valId).toBe(0)
    // tpe recovered from the val-def-type-store populated by FuncValue's
    // arg-registration side effect at parse time.
    expect(tree.body.body.tpe).toEqual({ tag: 'SInt' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips a FuncValue with two args', () => {
    // AST: (v0: SBoolean, v1: SInt) => v1
    //
    // Confirms multi-arg FuncValue parses each arg and the body's ValUse
    // (referring to arg id=1) recovers its tpe from the right binding.
    const bytes = new Uint8Array([
      0x00,
      0xd9,
      0x02,
      0x00, 0x01,         // arg(id=0, SBoolean)
      0x01, 0x04,         // arg(id=1, SInt)
      0x72, 0x01          // body: ValUse(1)
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    expect(tree.body.args.length).toBe(2)
    expect(tree.body.args[0]).toEqual({ id: 0, tpe: { tag: 'SBoolean' } })
    expect(tree.body.args[1]).toEqual({ id: 1, tpe: { tag: 'SInt' } })
    if (tree.body.body.tag !== 'ValUse') throw new Error('unreachable')
    expect(tree.body.body.tpe).toEqual({ tag: 'SInt' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips a FuncValue with no args', () => {
    // AST: () => 42
    //
    // Sigma-rust's `Vec::sigma_parse` accepts count=0 and returns an empty
    // Vec; the body is parsed unconditionally. We mirror that — a thunk-style
    // zero-arg FuncValue is wire-legal.
    const bytes = new Uint8Array([
      0x00,
      0xd9,
      0x00,           // args count = 0
      0x04, 0x54      // body: Const(SInt 42)  (ZigZag(42) = 84 = 0x54)
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    expect(tree.body.args.length).toBe(0)
    expect(tree.body.body.tag).toBe('Const')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('Apply variant', () => {
  it('round-trips Apply(FuncValue, args)', () => {
    // AST: ((v0: SInt) => v0)(7)
    //
    // bytes layout:
    //   0x00   header
    //   0xda   OP_APPLY
    //   0xd9   func = FuncValue
    //   0x01     args count = 1
    //   0x00 0x04   arg(id=0, SInt)
    //   0x72 0x00   body = ValUse(0)
    //   0x01   Apply.args count VLQ-u32 = 1
    //   0x04 0x0e   Apply.args[0] = Const(SInt 7)  (ZigZag(7) = 14 = 0x0e)
    const bytes = new Uint8Array([
      0x00,
      0xda,
      0xd9, 0x01, 0x00, 0x04, 0x72, 0x00,
      0x01,
      0x04, 0x0e
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Apply')
    if (tree.body.tag !== 'Apply') throw new Error('unreachable')
    expect(tree.body.func.tag).toBe('FuncValue')
    expect(tree.body.args.length).toBe(1)
    expect(tree.body.args[0]!.tag).toBe('Const')
    if (tree.body.args[0]!.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.args[0]!.value).toEqual({ kind: 'Int', value: 7 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips Apply with zero args', () => {
    // AST: f()  with f = (() => 42)
    //
    // sigma-rust's Apply uses `Vec<Expr>::sigma_parse` for args, which accepts
    // count=0. Mirrors that semantic — a zero-arg invocation is wire-legal.
    const bytes = new Uint8Array([
      0x00,
      0xda,
      0xd9, 0x00, 0x04, 0x54,    // func = FuncValue(args=[], body=Const(SInt 42))
      0x00                        // Apply.args count = 0
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Apply') throw new Error('unreachable')
    expect(tree.body.args.length).toBe(0)
    expect(tree.body.func.tag).toBe('FuncValue')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes Apply programmatically', () => {
    // Programmatic construction — confirm AST → bytes → AST round-trip.
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
        tag: 'Apply',
        func: {
          tag: 'FuncValue',
          args: [{ id: 0, tpe: { tag: 'SBoolean' } }],
          body: {
            tag: 'ValUse',
            valId: 0,
            tpe: { tag: 'SBoolean' }
          }
        },
        args: [
          {
            tag: 'Const',
            tpe: { tag: 'SBoolean' },
            value: { kind: 'Boolean', value: true }
          }
        ]
      }
    }
    const out = serializeTree(tree)
    // header + OP_APPLY + OP_FUNC_VALUE + count=1 + (id=0, SBoolean code 0x01)
    //   + OP_VAL_USE + valId=0 + Apply.args count=1 + Const(SBoolean true)
    expect(Array.from(out)).toEqual([
      0x00, 0xda, 0xd9, 0x01, 0x00, 0x01, 0x72, 0x00, 0x01, 0x01, 0x01
    ])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'Apply') throw new Error('unreachable')
    if (reparsed.body.func.tag !== 'FuncValue') throw new Error('unreachable')
    expect(reparsed.body.func.args).toEqual([{ id: 0, tpe: { tag: 'SBoolean' } }])
  })
})

describe('FuncValue + nested ValUse in BlockValue scope', () => {
  it('a FuncValue argument is visible to nested ValUse in body', () => {
    // AST: (v3: SLong) => let v4 = v3 in v4
    //
    // Confirms FuncValue's arg-registration in the shared valDefTypes map
    // is observable by a body that further binds (ValDef) and references
    // (ValUse) types — i.e. the map is not scoped/reset between FuncValue
    // and the BlockValue inside it.
    //
    // bytes:
    //   0x00   header
    //   0xd9   OP_FUNC_VALUE
    //   0x01     args count = 1
    //   0x03 0x05  arg(id=3, SLong)         (id=3 VLQ; SLong primId=5)
    //   0xd8   body = BlockValue
    //   0x01     items count = 1
    //   0xd6 0x04 0x72 0x03    ValDef(id=4, rhs=ValUse(3))
    //   0x72 0x04              result = ValUse(4)
    const bytes = new Uint8Array([
      0x00,
      0xd9,
      0x01,
      0x03, 0x05,
      0xd8,
      0x01,
      0xd6, 0x04, 0x72, 0x03,
      0x72, 0x04
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    expect(tree.body.args[0]).toEqual({ id: 3, tpe: { tag: 'SLong' } })
    if (tree.body.body.tag !== 'BlockValue') throw new Error('unreachable')
    const result = tree.body.body.result
    if (result.tag !== 'ValUse') throw new Error('unreachable')
    expect(result.valId).toBe(4)
    expect(result.tpe).toEqual({ tag: 'SLong' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('rejects a FuncValue body that references an unknown ValDef id', () => {
    // FuncValue with one arg id=0 (SInt), body ValUse(7). id=7 is neither a
    // FuncValue arg nor a sibling ValDef binding → val-use-unknown-id.
    const bytes = new Uint8Array([
      0x00, 0xd9, 0x01, 0x00, 0x04, 0x72, 0x07
    ])
    expectParseError(() => parseTree(bytes), 'val-use-unknown-id')
  })
})
