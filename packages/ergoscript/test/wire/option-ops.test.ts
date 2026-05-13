import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 26 tests: round-trips for the SOption combinators
 * `OptionGet`, `OptionGetOrElse`, `OptionIsDefined`. Drives the parsers
 * end-to-end via the `parseTree` / `serializeTree` envelope so the
 * per-variant code runs in its real call context.
 *
 * Wire formats (verified against sigma-rust source):
 *   - `OptionGet`        (0xe4): [input Expr]                    -- OneArgOp
 *   - `OptionGetOrElse`  (0xe5): [input Expr] [default Expr]
 *   - `OptionIsDefined`  (0xe6): [input Expr]                    -- OneArgOp
 *
 * SOption-typed operands are synthesized with `ExtractRegisterAs[T]` whose
 * post-eval type is `SOption[T]`. That itself requires an SBox-typed input,
 * which we produce via `FuncValue(arg: SBox) => …` and `ValUse(0)` (same
 * trick used in the Task 16 box-accessor tests).
 *
 * The wire layer is intentionally permissive of semantic-validity:
 * sigma-rust's `try_build` rejects non-SOption inputs (and for GetOrElse,
 * type-mismatched defaults), but the parser does not. The bytes round-
 * trip through `parseExpr` / `serializeExpr` without invoking those checks.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/option_get.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/option_get_or_else.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/option_is_defined.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs (OneArgOp blanket impl)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:122-124,266,314-315
 *
 * Opcode-byte references (see sigma-rust `serialization/op_code.rs:148-151`):
 *   SBox SType  = 99 = 0x63
 *   FuncValue   = 0xd9
 *   ValUse      = 0x72
 *   ExtractRegisterAs = 0xc6
 *   OptionGet         = 0xe4
 *   OptionGetOrElse   = 0xe5
 *   OptionIsDefined   = 0xe6
 */

// ---------------------------------------------------------------------------
// Helpers — mirror the SBox-FuncValue scaffold from box-accessors.test.ts.
// ---------------------------------------------------------------------------

/**
 * Wire bytes for `(arg: SBox) => body`, where `body` is itself an Expr
 * that references the SBox arg via ValUse. The arg id is 0.
 */
const SBOX_FUNC_PROLOGUE = [0xd9, 0x01, 0x00, 0x63]

/** Wire bytes for `ValUse(0)`: opcode + VLQ-u32 id. */
const VALUSE_0 = [0x72, 0x00]

/**
 * Wire bytes for `ExtractRegisterAs(ValUse(0): SBox).R4[SLong]` — an
 * SOption[SLong]-typed sub-expression.
 *   0xc6        OP_EXTRACT_REGISTER_AS
 *   0x72 0x00   input = ValUse(0)
 *   0x04        register_id (i8) = 4 (R4)
 *   0x05        elem_tpe = SLong
 */
const EXTRACT_R4_SLONG = [0xc6, ...VALUSE_0, 0x04, 0x05]

// ---------------------------------------------------------------------------
// OptionGet
// ---------------------------------------------------------------------------

describe('OptionGet variant', () => {
  it('round-trips (arg: SBox) => arg.R4[SLong].get', () => {
    // bytes:
    //   0x00                       header
    //   0xd9 0x01 0x00 0x63        FuncValue prologue: 1 arg, (id=0, SBox)
    //   0xe4                       OP_OPTION_GET
    //   <ExtractRegisterAs(R4, SLong)>
    const bytes = new Uint8Array([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xe4,
      ...EXTRACT_R4_SLONG,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'OptionGet') throw new Error('unreachable')
    expect(tree.body.body.input.tag).toBe('ExtractRegisterAs')
    if (tree.body.body.input.tag !== 'ExtractRegisterAs')
      throw new Error('unreachable')
    expect(tree.body.body.input.registerId).toBe(4)
    expect(tree.body.body.input.elemTpe).toEqual({ tag: 'SLong' })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes OptionGet programmatically', () => {
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
        tag: 'FuncValue',
        args: [{ id: 0, tpe: { tag: 'SBox' } }],
        body: {
          tag: 'OptionGet',
          input: {
            tag: 'ExtractRegisterAs',
            input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
            registerId: 4,
            elemTpe: { tag: 'SLong' },
          },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xe4,
      ...EXTRACT_R4_SLONG,
    ])
  })
})

// ---------------------------------------------------------------------------
// OptionGetOrElse
// ---------------------------------------------------------------------------

describe('OptionGetOrElse variant', () => {
  it('round-trips (arg: SBox) => arg.R4[SLong].getOrElse(1L)', () => {
    // bytes:
    //   0x00                       header
    //   0xd9 0x01 0x00 0x63        FuncValue prologue
    //   0xe5                       OP_OPTION_GET_OR_ELSE
    //   <ExtractRegisterAs(R4, SLong)>   input (SOption[SLong])
    //   0x05 0x02                  default = Const(SLong, ZigZag(1)=2)
    const bytes = new Uint8Array([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xe5,
      ...EXTRACT_R4_SLONG,
      0x05,
      0x02,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'OptionGetOrElse') throw new Error('unreachable')
    expect(tree.body.body.input.tag).toBe('ExtractRegisterAs')
    expect(tree.body.body.default.tag).toBe('Const')
    if (tree.body.body.default.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.body.default.tpe).toEqual({ tag: 'SLong' })
    expect(tree.body.body.default.value).toEqual({ kind: 'Long', value: 1n })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes OptionGetOrElse programmatically', () => {
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
        tag: 'FuncValue',
        args: [{ id: 0, tpe: { tag: 'SBox' } }],
        body: {
          tag: 'OptionGetOrElse',
          input: {
            tag: 'ExtractRegisterAs',
            input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
            registerId: 4,
            elemTpe: { tag: 'SLong' },
          },
          default: {
            tag: 'Const',
            tpe: { tag: 'SLong' },
            value: { kind: 'Long', value: 1n },
          },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xe5,
      ...EXTRACT_R4_SLONG,
      0x05,
      0x02,
    ])
  })
})

// ---------------------------------------------------------------------------
// OptionIsDefined
// ---------------------------------------------------------------------------

describe('OptionIsDefined variant', () => {
  it('round-trips (arg: SBox) => arg.R4[SLong].isDefined', () => {
    // bytes:
    //   0x00                       header
    //   0xd9 0x01 0x00 0x63        FuncValue prologue
    //   0xe6                       OP_OPTION_IS_DEFINED
    //   <ExtractRegisterAs(R4, SLong)>
    const bytes = new Uint8Array([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xe6,
      ...EXTRACT_R4_SLONG,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'OptionIsDefined') throw new Error('unreachable')
    expect(tree.body.body.input.tag).toBe('ExtractRegisterAs')

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes OptionIsDefined programmatically', () => {
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
        tag: 'FuncValue',
        args: [{ id: 0, tpe: { tag: 'SBox' } }],
        body: {
          tag: 'OptionIsDefined',
          input: {
            tag: 'ExtractRegisterAs',
            input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
            registerId: 4,
            elemTpe: { tag: 'SLong' },
          },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xe6,
      ...EXTRACT_R4_SLONG,
    ])
  })
})
