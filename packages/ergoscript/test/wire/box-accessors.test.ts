import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import type { ErgoTree } from '../../src/mir/types'
import { expectParseError } from './_helpers'

/**
 * Task 16 tests: round-trips for the Box accessor variants
 * `ExtractAmount`, `ExtractBytes`, `ExtractBytesWithNoRef`,
 * `ExtractCreationInfo`, `ExtractId`, `ExtractRegisterAs`,
 * `ExtractScriptBytes`, plus the tuple-accessor `SelectField`. Drives the
 * parsers end-to-end via the `parseTree` / `serializeTree` envelope so the
 * per-variant code runs in its real call context.
 *
 * Wire formats (verified against sigma-rust source):
 *   - `ExtractAmount`           (0xc1): [input Expr]
 *   - `ExtractBytes`            (0xc3): [input Expr]
 *   - `ExtractBytesWithNoRef`   (0xc4): [input Expr]
 *   - `ExtractCreationInfo`     (0xc7): [input Expr]
 *   - `ExtractId`               (0xc5): [input Expr]
 *   - `ExtractRegisterAs`       (0xc6): [input Expr] [register_id u8] [elem_tpe SType]
 *   - `ExtractScriptBytes`      (0xc2): [input Expr]
 *   - `SelectField`             (0x8c): [input Expr] [field_index u8 >= 1]
 *
 * The box-accessor operands must have post-eval type SBox; SelectField's
 * operand must be an STuple. GlobalVars (`SELF` / `Inputs(i)` / etc.) — the
 * usual source of SBox values — is not implemented until Task 17, so we
 * synthesize SBox-typed operands via `FuncValue(arg: SBox) => ExtractX(arg)`,
 * referencing the arg with a `ValUse`. Same trick used in the Task 12
 * `control-flow` tests (which validated FuncValue+ValUse end-to-end).
 *
 * The wire layer is intentionally permissive of semantic-validity:
 * sigma-rust's `try_build` rejects non-SBox / non-STuple inputs, but the
 * parser does not (the failure path is a higher-level validation in
 * sigma-rust as well — `sigma_parse` calls `try_build` but only as a final
 * construction step). We never trigger those failures from on-wire bytes
 * here; tests use SBox-typed / STuple-typed operands.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_amount.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_bytes.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_bytes_with_no_ref.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_creation_info.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_id.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_reg_as.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_script_bytes.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/select_field.rs
 *
 * Opcode-byte references (see sigma-rust `serialization/op_code.rs:64-69`):
 *   SBox SType = 99 = 0x63
 *   FuncValue   = 0xd9
 *   ValUse      = 0x72
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wire bytes for `(arg: SBox) => body`, where `body` is itself a Box
 * accessor that references the SBox arg via ValUse. The arg id is 0.
 *
 * Layout (header byte is added by the caller):
 *   0xd9         OP_FUNC_VALUE
 *   0x01         args count = 1
 *   0x00 0x63    args[0] = (id=0, tpe=SBox)
 *   <body...>    typically `<opcode> 0x72 0x00` (OP_VAL_USE, valId=0)
 */
const SBOX_FUNC_PROLOGUE = [0xd9, 0x01, 0x00, 0x63]

/** Wire bytes for `ValUse(0)`: opcode then the VLQ-u32 id. */
const VALUSE_0 = [0x72, 0x00]

/**
 * Assert that `tree` parses, has its body be a `FuncValue` whose body is
 * the named accessor variant referencing arg 0 (an SBox-typed ValUse),
 * then serialize-and-match the original bytes.
 */
function expectBoxAccessorRoundTrip(
  bytes: Uint8Array,
  expectedTag:
    | 'ExtractAmount'
    | 'ExtractBytes'
    | 'ExtractBytesWithNoRef'
    | 'ExtractCreationInfo'
    | 'ExtractId'
    | 'ExtractScriptBytes'
): void {
  const tree = parseTree(bytes)
  expect(tree.body.tag).toBe('FuncValue')
  if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
  expect(tree.body.args).toEqual([{ id: 0, tpe: { tag: 'SBox' } }])
  expect(tree.body.body.tag).toBe(expectedTag)
  if (tree.body.body.tag !== expectedTag) throw new Error('unreachable')
  // The accessor's input is a ValUse referencing the SBox arg.
  // TypeScript narrows by `expectedTag`, but the structural shape is uniform.
  const accessor = tree.body.body as { tag: typeof expectedTag; input: unknown }
  expect((accessor.input as { tag: string }).tag).toBe('ValUse')
  expect(accessor.input).toEqual({ tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } })
  expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
}

// ---------------------------------------------------------------------------
// ExtractAmount
// ---------------------------------------------------------------------------

describe('ExtractAmount variant', () => {
  it('round-trips (arg: SBox) => arg.value', () => {
    // bytes: header + FuncValue prologue + OP_EXTRACT_AMOUNT + ValUse(0)
    const bytes = new Uint8Array([0x00, ...SBOX_FUNC_PROLOGUE, 0xc1, ...VALUSE_0])
    expectBoxAccessorRoundTrip(bytes, 'ExtractAmount')
  })

  it('builds and serializes ExtractAmount(arg) programmatically', () => {
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
          tag: 'ExtractAmount',
          input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, ...SBOX_FUNC_PROLOGUE, 0xc1, ...VALUSE_0])
  })
})

// ---------------------------------------------------------------------------
// ExtractBytes
// ---------------------------------------------------------------------------

describe('ExtractBytes variant', () => {
  it('round-trips (arg: SBox) => arg.bytes', () => {
    const bytes = new Uint8Array([0x00, ...SBOX_FUNC_PROLOGUE, 0xc3, ...VALUSE_0])
    expectBoxAccessorRoundTrip(bytes, 'ExtractBytes')
  })

  it('builds and serializes ExtractBytes(arg) programmatically', () => {
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
          tag: 'ExtractBytes',
          input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, ...SBOX_FUNC_PROLOGUE, 0xc3, ...VALUSE_0])
  })
})

// ---------------------------------------------------------------------------
// ExtractBytesWithNoRef
// ---------------------------------------------------------------------------

describe('ExtractBytesWithNoRef variant', () => {
  it('round-trips (arg: SBox) => arg.bytesWithoutRef', () => {
    const bytes = new Uint8Array([0x00, ...SBOX_FUNC_PROLOGUE, 0xc4, ...VALUSE_0])
    expectBoxAccessorRoundTrip(bytes, 'ExtractBytesWithNoRef')
  })

  it('builds and serializes ExtractBytesWithNoRef(arg) programmatically', () => {
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
          tag: 'ExtractBytesWithNoRef',
          input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, ...SBOX_FUNC_PROLOGUE, 0xc4, ...VALUSE_0])
  })
})

// ---------------------------------------------------------------------------
// ExtractCreationInfo
// ---------------------------------------------------------------------------

describe('ExtractCreationInfo variant', () => {
  it('round-trips (arg: SBox) => arg.creationInfo', () => {
    const bytes = new Uint8Array([0x00, ...SBOX_FUNC_PROLOGUE, 0xc7, ...VALUSE_0])
    expectBoxAccessorRoundTrip(bytes, 'ExtractCreationInfo')
  })

  it('builds and serializes ExtractCreationInfo(arg) programmatically', () => {
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
          tag: 'ExtractCreationInfo',
          input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, ...SBOX_FUNC_PROLOGUE, 0xc7, ...VALUSE_0])
  })
})

// ---------------------------------------------------------------------------
// ExtractId
// ---------------------------------------------------------------------------

describe('ExtractId variant', () => {
  it('round-trips (arg: SBox) => arg.id', () => {
    const bytes = new Uint8Array([0x00, ...SBOX_FUNC_PROLOGUE, 0xc5, ...VALUSE_0])
    expectBoxAccessorRoundTrip(bytes, 'ExtractId')
  })

  it('builds and serializes ExtractId(arg) programmatically', () => {
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
          tag: 'ExtractId',
          input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, ...SBOX_FUNC_PROLOGUE, 0xc5, ...VALUSE_0])
  })
})

// ---------------------------------------------------------------------------
// ExtractScriptBytes
// ---------------------------------------------------------------------------

describe('ExtractScriptBytes variant', () => {
  it('round-trips (arg: SBox) => arg.propositionBytes', () => {
    const bytes = new Uint8Array([0x00, ...SBOX_FUNC_PROLOGUE, 0xc2, ...VALUSE_0])
    expectBoxAccessorRoundTrip(bytes, 'ExtractScriptBytes')
  })

  it('builds and serializes ExtractScriptBytes(arg) programmatically', () => {
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
          tag: 'ExtractScriptBytes',
          input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, ...SBOX_FUNC_PROLOGUE, 0xc2, ...VALUSE_0])
  })
})

// ---------------------------------------------------------------------------
// ExtractRegisterAs
// ---------------------------------------------------------------------------

describe('ExtractRegisterAs variant', () => {
  it('round-trips (arg: SBox) => arg.R4[SLong]', () => {
    // bytes:
    //   0x00                       header
    //   0xd9 0x01 0x00 0x63        FuncValue prologue: 1 arg, (id=0, SBox)
    //   0xc6                       OP_EXTRACT_REGISTER_AS
    //   0x72 0x00                  input = ValUse(0)
    //   0x04                       register_id (i8) = 4  (R4)
    //   0x05                       elem_tpe = SLong
    const bytes = new Uint8Array([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xc6,
      ...VALUSE_0,
      0x04,
      0x05,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'ExtractRegisterAs') throw new Error('unreachable')
    expect(tree.body.body.registerId).toBe(4)
    expect(tree.body.body.elemTpe).toEqual({ tag: 'SLong' })
    expect(tree.body.body.input).toEqual({
      tag: 'ValUse',
      valId: 0,
      tpe: { tag: 'SBox' },
    })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips (arg: SBox) => arg.R9[SColl[SByte]]', () => {
    // SColl[SByte] compact encoding: COLL_TYPECODE(12) + SByte primId(2) = 14 (0x0e)
    // bytes:
    //   0x00                       header
    //   0xd9 0x01 0x00 0x63        FuncValue prologue: 1 arg, (id=0, SBox)
    //   0xc6                       OP_EXTRACT_REGISTER_AS
    //   0x72 0x00                  input = ValUse(0)
    //   0x09                       register_id (i8) = 9  (R9)
    //   0x0e                       elem_tpe = SColl[SByte] (compact form)
    const bytes = new Uint8Array([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xc6,
      ...VALUSE_0,
      0x09,
      0x0e,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'ExtractRegisterAs') throw new Error('unreachable')
    expect(tree.body.body.registerId).toBe(9)
    expect(tree.body.body.elemTpe).toEqual({
      tag: 'SColl',
      elem: { tag: 'SByte' },
    })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips a negative register_id (i8 two\'s-complement)', () => {
    // Sigma-rust uses i8 for register_id (raw u8 cast). A "-1" round-trips
    // through 0xff via two's-complement.
    //
    // bytes:
    //   0x00                       header
    //   0xd9 0x01 0x00 0x63        FuncValue prologue
    //   0xc6                       OP_EXTRACT_REGISTER_AS
    //   0x72 0x00                  input = ValUse(0)
    //   0xff                       register_id (i8) = -1
    //   0x04                       elem_tpe = SInt
    const bytes = new Uint8Array([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xc6,
      ...VALUSE_0,
      0xff,
      0x04,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'ExtractRegisterAs') throw new Error('unreachable')
    expect(tree.body.body.registerId).toBe(-1)
    expect(tree.body.body.elemTpe).toEqual({ tag: 'SInt' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes ExtractRegisterAs programmatically', () => {
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
          tag: 'ExtractRegisterAs',
          input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
          registerId: 4,
          elemTpe: { tag: 'SLong' },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0xc6,
      ...VALUSE_0,
      0x04,
      0x05,
    ])
  })
})

// ---------------------------------------------------------------------------
// SelectField
// ---------------------------------------------------------------------------

describe('SelectField variant', () => {
  it('round-trips (t: (SInt, SLong)) => t._1', () => {
    // STuple(SInt, SLong) pair1 encoding: PAIR1_TYPECODE(60) + SInt primId(4) = 64 (0x40)
    //   then serialize(SLong) = 0x05
    // FuncValue arg.tpe = STuple(SInt, SLong) → bytes: 0x40 0x05
    //
    // bytes:
    //   0x00         header
    //   0xd9         OP_FUNC_VALUE
    //   0x01         args count = 1
    //   0x00         args[0].id = 0
    //   0x40 0x05    args[0].tpe = STuple(SInt, SLong)
    //   0x8c         OP_SELECT_FIELD
    //   0x72 0x00    input = ValUse(0)
    //   0x01         field_index = 1
    const bytes = new Uint8Array([
      0x00,
      0xd9,
      0x01,
      0x00,
      0x40,
      0x05,
      0x8c,
      ...VALUSE_0,
      0x01,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    expect(tree.body.args).toEqual([
      { id: 0, tpe: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SLong' }] } },
    ])
    if (tree.body.body.tag !== 'SelectField') throw new Error('unreachable')
    expect(tree.body.body.fieldIndex).toBe(1)
    expect(tree.body.body.input).toEqual({
      tag: 'ValUse',
      valId: 0,
      tpe: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SLong' }] },
    })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips field_index = 2 (t._2)', () => {
    const bytes = new Uint8Array([
      0x00,
      0xd9,
      0x01,
      0x00,
      0x40,
      0x05,
      0x8c,
      ...VALUSE_0,
      0x02,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'SelectField') throw new Error('unreachable')
    expect(tree.body.body.fieldIndex).toBe(2)
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('rejects field_index = 0 at parse time', () => {
    // Sigma-rust's TupleFieldIndex::try_from rejects 0
    // (`mir/select_field.rs:31-37`). The wire-layer parser must do the
    // same; otherwise serialization of a programmatic AST with fieldIndex=0
    // would round-trip silently and mismatch sigma-rust's taxonomy.
    const bytes = new Uint8Array([
      0x00,
      0xd9,
      0x01,
      0x00,
      0x40,
      0x05,
      0x8c,
      ...VALUSE_0,
      0x00, // field_index = 0 (invalid)
    ])

    expectParseError(() => parseTree(bytes), 'select-field-index-out-of-range')
  })

  it('builds and serializes SelectField programmatically', () => {
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
        args: [
          {
            id: 0,
            tpe: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SLong' }] },
          },
        ],
        body: {
          tag: 'SelectField',
          input: {
            tag: 'ValUse',
            valId: 0,
            tpe: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SLong' }] },
          },
          fieldIndex: 2,
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([
      0x00,
      0xd9,
      0x01,
      0x00,
      0x40,
      0x05,
      0x8c,
      ...VALUSE_0,
      0x02,
    ])
  })
})

// ---------------------------------------------------------------------------
// Nesting: composed Box accessors
// ---------------------------------------------------------------------------

describe('Nesting: composed Box accessors', () => {
  it('round-trips ExtractId(ExtractBytes is forbidden by types — use direct ExtractId on the box)', () => {
    // Confirms recursive descent: nest two box-accessors by feeding both
    // off the same SBox arg. (Semantically meaningless but byte-valid.)
    //
    //   (arg: SBox) => ExtractAmount(arg) // first accessor
    //
    // For a more interesting nest, build SelectField over an STuple-typed
    // arg whose inner field, when extracted, produces an SLong (the field
    // type) — exercising the dispatch chain through SelectField + ValUse.
    //
    // Test below: simple FuncValue with body being ExtractAmount of ValUse.
    // (Identity nesting was already covered by the direct tests; this
    // exercises arg-binding flow through the parser.)
    const bytes = new Uint8Array([0x00, ...SBOX_FUNC_PROLOGUE, 0xc1, ...VALUSE_0])
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'ExtractAmount') throw new Error('unreachable')
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Upcast(ExtractAmount(arg), SBigInt) — chained through Upcast (Task 15)', () => {
    // Cross-task composition: feed an ExtractAmount through an Upcast.
    // ExtractAmount's post-eval tpe is SLong, so Upcast(_, SBigInt) is a
    // valid widening conversion in the type system. The wire layer
    // doesn't check this, but the byte layout we emit/parse is exactly
    // what sigma-rust would produce.
    //
    // bytes:
    //   0x00                       header
    //   0xd9 0x01 0x00 0x63        FuncValue prologue (arg: SBox)
    //   0x7e                       OP_UPCAST
    //   0xc1                       OP_EXTRACT_AMOUNT
    //   0x72 0x00                  input = ValUse(0)
    //   0x06                       Upcast tpe = SBigInt
    const bytes = new Uint8Array([
      0x00,
      ...SBOX_FUNC_PROLOGUE,
      0x7e, // OP_UPCAST
      0xc1, // OP_EXTRACT_AMOUNT
      ...VALUSE_0,
      0x06, // SBigInt
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'FuncValue') throw new Error('unreachable')
    if (tree.body.body.tag !== 'Upcast') throw new Error('unreachable')
    expect(tree.body.body.tpe).toEqual({ tag: 'SBigInt' })
    if (tree.body.body.input.tag !== 'ExtractAmount') throw new Error('unreachable')
    expect(tree.body.body.input.input).toEqual({
      tag: 'ValUse',
      valId: 0,
      tpe: { tag: 'SBox' },
    })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})
