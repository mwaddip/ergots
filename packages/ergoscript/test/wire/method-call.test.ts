import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'

/**
 * Task 20 tests: `MethodCall` and `PropertyCall` round-trips. Drives the
 * parsers end-to-end via the `parseTree` / `serializeTree` envelope so the
 * per-variant code runs in its real call context.
 *
 * Wire format reminders (verified against sigma-rust source):
 *   - `MethodCall` (opcode 0xdc):
 *       [typeId: u8]          -- TypeCode for the receiver type companion.
 *       [methodId: u8]        -- MethodId within that type companion.
 *       [obj: Expr]           -- the receiver.
 *       [args_count: VLQ-u32] -- Vec<Expr> length prefix.
 *       [arg_i: Expr]*
 *       [explicit_type_arg_i: SType]*
 *           Zero or more inline SType encodings, one per STypeVar declared
 *           by the SMethod's `explicit_type_args` list. Currently only
 *           Box.getReg (99,19), Context.getVarFromInput (101,12), and
 *           Global.{deserialize, fromBigEndianBytes, none} (106,{4,5,10})
 *           use this; all declare exactly one `STypeVar::t()` (= "T").
 *           Note: id 7 (getRegV5) is registered at ALL versions but carries
 *           NO explicit type args on the wire (JVM shape; sigma-rust diverges).
 *   - `PropertyCall` (opcode 0xdb):
 *       [typeId: u8]
 *       [methodId: u8]
 *       [obj: Expr]
 *       (No args, no type args — PropertyCall is the zero-arg cousin of
 *       MethodCall.)
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/method_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/property_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/method_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/property_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sbox.rs
 *     (GET_REG_METHOD_DESC has explicit_type_args = vec![STypeVar::t()])
 */

describe('PropertyCall variant', () => {
  it('round-trips SELF.value (Box.value, typeId=99, methodId=1)', () => {
    // AST: PropertyCall(obj=GlobalVars(SelfBox), typeId=99, methodId=1)
    //
    // bytes:
    //   0x00       header (v0, no size, no segregation)
    //   0xdb       OP_PROPERTY_CALL
    //   0x63       typeId = 99 (SBOX)
    //   0x01       methodId = 1 (Box.value)
    //   0xa7       obj = OP_SELF_BOX (the SELF receiver as a GlobalVars Expr)
    const bytes = new Uint8Array([0x00, 0xdb, 0x63, 0x01, 0xa7])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('PropertyCall')
    if (tree.body.tag !== 'PropertyCall') throw new Error('unreachable')
    expect(tree.body.typeId).toBe(99)
    expect(tree.body.methodId).toBe(1)
    expect(tree.body.obj.tag).toBe('GlobalVars')
    if (tree.body.obj.tag !== 'GlobalVars') throw new Error('unreachable')
    expect(tree.body.obj.kind).toBe('SelfBox')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips CONTEXT.dataInputs (Context.dataInputs, typeId=101, methodId=1)', () => {
    // AST: PropertyCall(obj=Context, typeId=101, methodId=1)
    //
    // bytes:
    //   0x00       header
    //   0xdb       OP_PROPERTY_CALL
    //   0x65       typeId = 101 (SCONTEXT)
    //   0x01       methodId = 1 (Context.dataInputs)
    //   0xfe       obj = OP_CONTEXT (the CONTEXT receiver as an Expr)
    const bytes = new Uint8Array([0x00, 0xdb, 0x65, 0x01, 0xfe])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'PropertyCall') throw new Error('unreachable')
    expect(tree.body.typeId).toBe(101)
    expect(tree.body.methodId).toBe(1)
    expect(tree.body.obj.tag).toBe('Context')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('MethodCall variant', () => {
  it('round-trips SELF.getReg[Int](4) (Box.getReg, typeId=99, methodId=19, T=SInt) — JVM getRegMethodV6', () => {
    // v6 P7a: the JVM's script-callable getReg is methodId 19 (getRegMethodV6,
    // methods.scala:1338-1347) and carries ONE explicit type arg. The old id-7
    // form (getRegV5) declares NO explicit type args — see the test below.
    //
    // bytes:
    //   0x00       header
    //   0xdc       OP_METHOD_CALL
    //   0x63       typeId = 99 (SBOX)
    //   0x13       methodId = 19 (Box.getReg, v6)
    //   0xa7       obj = OP_SELF_BOX
    //   0x01       args_count = 1 (VLQ-u32)
    //   0x04 0x08  arg_0 = Const(SInt, ZigZag(4)=8)
    //   0x04       explicit_type_arg T = SInt (TypeCode 4)
    const bytes = new Uint8Array([0x00, 0xdc, 0x63, 0x13, 0xa7, 0x01, 0x04, 0x08, 0x04])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('MethodCall')
    if (tree.body.tag !== 'MethodCall') throw new Error('unreachable')
    expect(tree.body.typeId).toBe(99)
    expect(tree.body.methodId).toBe(19)
    expect(tree.body.explicitTypeArgs).toEqual({ T: { tag: 'SInt' } })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('parses MethodCall(99, 7) with ZERO explicit type args (JVM getRegV5 shape) and round-trips', () => {
    // v6 P7a spec §2.3: JVM id 7 (getRegV5) has NO explicit type args — the
    // previous ergots entry (99:7 → ['T'], sigma-rust-shaped) mis-consumed one
    // SType here. Parse must consume nothing after the args.
    const bytes = new Uint8Array([0x00, 0xdc, 0x63, 0x07, 0xa7, 0x01, 0x04, 0x08])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('MethodCall')
    if (tree.body.tag !== 'MethodCall') throw new Error('unreachable')
    expect(tree.body.typeId).toBe(99)
    expect(tree.body.methodId).toBe(7)
    expect(tree.body.explicitTypeArgs).toEqual({})

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips a zero-arg method without explicit type args (typeId=99, methodId=8 / Box.tokens)', () => {
    // AST: MethodCall(
    //        obj=GlobalVars(SelfBox),
    //        typeId=99, methodId=8,
    //        args=[],
    //        explicitTypeArgs={}
    //      )
    //
    // Box.tokens (methodId=8) has NO explicit_type_args in sigma-rust
    // (`types/sbox.rs::TOKENS_METHOD_DESC`), so no SType bytes follow the
    // args vector. Useful to confirm the registry returns an empty list
    // for unknown-to-the-registry methods.
    //
    // bytes:
    //   0x00       header
    //   0xdc       OP_METHOD_CALL
    //   0x63       typeId = 99 (SBOX)
    //   0x08       methodId = 8 (Box.tokens)
    //   0xa7       obj = OP_SELF_BOX
    //   0x00       args_count = 0 (VLQ-u32)
    const bytes = new Uint8Array([0x00, 0xdc, 0x63, 0x08, 0xa7, 0x00])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'MethodCall') throw new Error('unreachable')
    expect(tree.body.typeId).toBe(99)
    expect(tree.body.methodId).toBe(8)
    expect(tree.body.args).toHaveLength(0)
    expect(tree.body.explicitTypeArgs).toEqual({})

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})
