import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import type { ErgoTree } from '../../src/mir/types'
import { expectParseError } from './_helpers'

/**
 * Task 25 tests: `DeserializeContext` and `DeserializeRegister` round-trips.
 * Drives the parsers end-to-end via the `parseTree` / `serializeTree`
 * envelope so the per-variant code runs in its real call context.
 *
 * Wire format reminders (verified against sigma-rust source):
 *   - `DeserializeContext` (opcode 0xd4):
 *       [tpe: SType]               -- result type of the deserialized script
 *       [id: u8]                   -- context-variable id
 *
 *   - `DeserializeRegister` (opcode 0xd5):
 *       [reg: u8]                  -- register number 0..=9 (R0..R9)
 *       [tpe: SType]               -- result type of the deserialized script
 *       [default: Option<Box<Expr>>]
 *         tag byte: 0x00 = None, 0x01 = Some (Expr follows)
 *
 * The Option<Box<Expr>> tag uses the same shape as sigma-rust's
 * `impl<T: SigmaSerializable> SigmaSerializable for Option<Box<T>>`
 * (`serialization/serializable.rs`) — JVM-confirmed for DeserializeRegister
 * (`DeserializeRegisterSerializer.scala` `r.getOption(r.getValue())`).
 * (No longer citing CreateAvlTree.valueLength — that was a sigma-rust wire
 * fork vs the JVM 4-expr layout, fixed in the F4 epilogue.)
 *
 * SType byte codes used below (see `wire/serialize-stype.ts`):
 *   - SBoolean = 0x01
 *   - SByte    = 0x02
 *   - SInt     = 0x04
 *   - SLong    = 0x05
 *   - SColl(SByte) = 12 + 2 = 0x0e
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/deserialize_context.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/deserialize_register.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box/register/id.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::DESERIALIZE_CONTEXT = 0xd4, OpCode::DESERIALIZE_REGISTER = 0xd5)
 */

describe('DeserializeContext variant', () => {
  it('round-trips DeserializeContext(tpe=SBoolean, id=7)', () => {
    // AST: DeserializeContext { tpe = SBoolean, id = 7 }
    //
    // bytes:
    //   0x00      header (v0, no size, no segregation)
    //   0xd4      OP_DESERIALIZE_CONTEXT
    //   0x01      tpe = SBoolean (primitive code 1)
    //   0x07      id = 7
    const bytes = new Uint8Array([0x00, 0xd4, 0x01, 0x07])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('DeserializeContext')
    if (tree.body.tag !== 'DeserializeContext') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SBoolean' })
    expect(tree.body.id).toBe(7)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips DeserializeContext(tpe=SColl(SByte), id=0)', () => {
    // AST: DeserializeContext { tpe = SColl(SByte), id = 0 }
    //
    // bytes:
    //   0x00      header
    //   0xd4      OP_DESERIALIZE_CONTEXT
    //   0x0e      tpe = SColl(SByte)  (PRIM_RANGE*1 + SByte=2 = 14)
    //   0x00      id = 0
    const bytes = new Uint8Array([0x00, 0xd4, 0x0e, 0x00])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'DeserializeContext') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
    expect(tree.body.id).toBe(0)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips DeserializeContext(tpe=SInt, id=255)', () => {
    // Boundary: id at the u8 max.
    //
    // bytes:
    //   0x00      header
    //   0xd4      OP_DESERIALIZE_CONTEXT
    //   0x04      tpe = SInt (primitive code 4)
    //   0xff      id = 255
    const bytes = new Uint8Array([0x00, 0xd4, 0x04, 0xff])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'DeserializeContext') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SInt' })
    expect(tree.body.id).toBe(255)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes DeserializeContext programmatically', () => {
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
        tag: 'DeserializeContext',
        tpe: { tag: 'SLong' },
        id: 42,
      },
    }

    const out = serializeTree(tree)
    // header + OP_DESERIALIZE_CONTEXT + SLong(0x05) + id(0x2a)
    expect(Array.from(out)).toEqual([0x00, 0xd4, 0x05, 0x2a])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'DeserializeContext') throw new Error('unreachable')
    expect(reparsed.body.tpe).toEqual({ tag: 'SLong' })
    expect(reparsed.body.id).toBe(42)
  })

  it('rejects DeserializeContext.id out of u8 range on serialize', () => {
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
        tag: 'DeserializeContext',
        tpe: { tag: 'SBoolean' },
        id: 256,
      },
    }
    expect(() => serializeTree(tree)).toThrowError(
      /DeserializeContext\.id 256 out of u8 range/
    )
  })
})

describe('DeserializeRegister variant', () => {
  it('round-trips DeserializeRegister(reg=4, tpe=SBoolean, default=None)', () => {
    // AST: DeserializeRegister { reg = 4 (R4), tpe = SBoolean, default = None }
    //
    // bytes:
    //   0x00      header
    //   0xd5      OP_DESERIALIZE_REGISTER
    //   0x04      reg = 4
    //   0x01      tpe = SBoolean
    //   0x00      Option tag = 0 (None)
    const bytes = new Uint8Array([0x00, 0xd5, 0x04, 0x01, 0x00])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('DeserializeRegister')
    if (tree.body.tag !== 'DeserializeRegister') throw new Error('unreachable')
    expect(tree.body.reg).toBe(4)
    expect(tree.body.tpe).toEqual({ tag: 'SBoolean' })
    expect(tree.body.default).toBeNull()

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips DeserializeRegister(reg=5, tpe=SInt, default=Some(Const(SInt 1)))', () => {
    // AST: DeserializeRegister {
    //        reg = 5 (R5),
    //        tpe = SInt,
    //        default = Some(Const(SInt 1))
    //      }
    //
    // bytes:
    //   0x00      header
    //   0xd5      OP_DESERIALIZE_REGISTER
    //   0x05      reg = 5
    //   0x04      tpe = SInt
    //   0x01      Option tag = 1 (Some)
    //   0x04 0x02 inner = Const(SInt, ZigZag(1)=2)
    const bytes = new Uint8Array([0x00, 0xd5, 0x05, 0x04, 0x01, 0x04, 0x02])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'DeserializeRegister') throw new Error('unreachable')
    expect(tree.body.reg).toBe(5)
    expect(tree.body.tpe).toEqual({ tag: 'SInt' })
    expect(tree.body.default).not.toBeNull()
    if (tree.body.default === null) throw new Error('unreachable')
    if (tree.body.default.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.default.tpe).toEqual({ tag: 'SInt' })
    expect(tree.body.default.value).toEqual({ kind: 'Int', value: 1 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips DeserializeRegister(reg=0, tpe=SColl(SByte), default=None)', () => {
    // Boundary: reg at the minimum value (R0 / SELF.R0).
    //
    // bytes:
    //   0x00      header
    //   0xd5      OP_DESERIALIZE_REGISTER
    //   0x00      reg = 0
    //   0x0e      tpe = SColl(SByte)
    //   0x00      Option tag = 0 (None)
    const bytes = new Uint8Array([0x00, 0xd5, 0x00, 0x0e, 0x00])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'DeserializeRegister') throw new Error('unreachable')
    expect(tree.body.reg).toBe(0)
    expect(tree.body.tpe).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
    expect(tree.body.default).toBeNull()

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips DeserializeRegister(reg=9, tpe=SLong, default=None)', () => {
    // Boundary: reg at the maximum allowed value (R9 — sigma-rust accepts 0..=9).
    //
    // bytes:
    //   0x00      header
    //   0xd5      OP_DESERIALIZE_REGISTER
    //   0x09      reg = 9
    //   0x05      tpe = SLong
    //   0x00      Option tag = 0 (None)
    const bytes = new Uint8Array([0x00, 0xd5, 0x09, 0x05, 0x00])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'DeserializeRegister') throw new Error('unreachable')
    expect(tree.body.reg).toBe(9)
    expect(tree.body.tpe).toEqual({ tag: 'SLong' })
    expect(tree.body.default).toBeNull()

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes DeserializeRegister programmatically (with Some default)', () => {
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
        tag: 'DeserializeRegister',
        reg: 6,
        tpe: { tag: 'SBoolean' },
        default: {
          tag: 'Const',
          tpe: { tag: 'SBoolean' },
          value: { kind: 'Boolean', value: true },
        },
      },
    }

    const out = serializeTree(tree)
    // header + OP_DESERIALIZE_REGISTER + reg(6) + SBoolean(0x01) + Some(0x01)
    //   + inner Const: Const wire is "tpe-then-payload" => SBoolean(0x01) + 0x01 (true)
    expect(Array.from(out)).toEqual([0x00, 0xd5, 0x06, 0x01, 0x01, 0x01, 0x01])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'DeserializeRegister') throw new Error('unreachable')
    expect(reparsed.body.reg).toBe(6)
    expect(reparsed.body.tpe).toEqual({ tag: 'SBoolean' })
    if (reparsed.body.default === null) throw new Error('unreachable')
    if (reparsed.body.default.tag !== 'Const') throw new Error('unreachable')
    expect(reparsed.body.default.value).toEqual({ kind: 'Boolean', value: true })
  })

  it('rejects DeserializeRegister with reg > 9 on parse', () => {
    // bytes:
    //   0x00      header
    //   0xd5      OP_DESERIALIZE_REGISTER
    //   0x0a      reg = 10 (INVALID — sigma-rust accepts only 0..=9)
    //   0x01      tpe = SBoolean
    //   0x00      Option tag = 0 (None)
    const bytes = new Uint8Array([0x00, 0xd5, 0x0a, 0x01, 0x00])
    expectParseError(
      () => parseTree(bytes),
      'deserialize-register-id-out-of-range'
    )
  })

  it('rejects DeserializeRegister with invalid Option tag (>= 2)', () => {
    // bytes:
    //   0x00      header
    //   0xd5      OP_DESERIALIZE_REGISTER
    //   0x04      reg = 4
    //   0x01      tpe = SBoolean
    //   0x02      Option tag = 2 (INVALID — sigma-rust accepts only 0 or 1)
    const bytes = new Uint8Array([0x00, 0xd5, 0x04, 0x01, 0x02])
    expectParseError(() => parseTree(bytes), 'invalid-option-tag')
  })

  it('rejects DeserializeRegister.reg out of range on serialize', () => {
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
        tag: 'DeserializeRegister',
        reg: 10,
        tpe: { tag: 'SBoolean' },
        default: null,
      },
    }
    expect(() => serializeTree(tree)).toThrowError(
      /DeserializeRegister\.reg 10 out of bounds/
    )
  })
})
