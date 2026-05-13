import { describe, it, expect } from 'vitest'
import * as OP from '../src/mir/opcodes'
import { parseExpr, ExprParseError } from '../src/wire/parse'
import { ByteReader } from '../src/wire/reader'

/**
 * Task 9: pin opcode constants and dispatch behavior.
 *
 * The opcode constants come verbatim from sigma-rust
 * `ergotree-ir/src/serialization/op_code.rs`. A handful of representative
 * values are pinned here so a regression that flips one byte fails loudly
 * rather than going undetected until a fixture test runs. The dispatch
 * tests check that:
 *   - inline-constant bytes (0..=LAST_CONSTANT_CODE) throw
 *     `not-implemented-yet`
 *   - known opcodes throw `not-implemented-yet`
 *   - unknown opcodes throw `unknown-opcode`
 */

describe('Opcode constants (verbatim from sigma-rust)', () => {
  // Constant-range markers.
  it('FIRST_DATA_TYPE = 1', () => {
    expect(OP.FIRST_DATA_TYPE).toBe(1)
  })
  it('LAST_DATA_TYPE = 111', () => {
    expect(OP.LAST_DATA_TYPE).toBe(111)
  })
  it('LAST_CONSTANT_CODE = 112', () => {
    expect(OP.LAST_CONSTANT_CODE).toBe(112)
  })

  // Pin a few representative opcodes against sigma-rust's table. These
  // were the bytes most easily fat-fingered when copying the constants:
  //   - VAL_USE = 0x72 (shift 2)
  //   - CONSTANT_PLACEHOLDER = 0x73 (shift 3)
  //   - IF = 0x95 (shift 37)
  //   - BLOCK_VALUE = 0xd8 (shift 104)
  //   - CONTEXT = 0xfe (shift 142)
  //   - XOR_OF = 0xff (shift 143, max u8)
  it('VAL_USE = 0x72', () => {
    expect(OP.OP_VAL_USE).toBe(0x72)
  })
  it('CONSTANT_PLACEHOLDER = 0x73', () => {
    expect(OP.OP_CONSTANT_PLACEHOLDER).toBe(0x73)
  })
  it('IF = 0x95', () => {
    expect(OP.OP_IF).toBe(0x95)
  })
  it('BLOCK_VALUE = 0xd8', () => {
    expect(OP.OP_BLOCK_VALUE).toBe(0xd8)
  })
  it('CONTEXT = 0xfe', () => {
    expect(OP.OP_CONTEXT).toBe(0xfe)
  })
  it('XOR_OF = 0xff', () => {
    expect(OP.OP_XOR_OF).toBe(0xff)
  })

  // BinOp sub-opcodes — sigma-rust's `bin_op_sigma_parse` dispatches on
  // these. A wrong byte here breaks every numeric/relational/logical
  // operator at once, so pin them.
  it('PLUS = 0x9a, MINUS = 0x99, MULTIPLY = 0x9c', () => {
    expect(OP.OP_PLUS).toBe(0x9a)
    expect(OP.OP_MINUS).toBe(0x99)
    expect(OP.OP_MULTIPLY).toBe(0x9c)
  })
  it('EQ = 0x93, NEQ = 0x94', () => {
    expect(OP.OP_EQ).toBe(0x93)
    expect(OP.OP_NEQ).toBe(0x94)
  })
  it('BIN_AND = 0xed, BIN_OR = 0xec, BIN_XOR = 0xf4', () => {
    expect(OP.OP_BIN_AND).toBe(0xed)
    expect(OP.OP_BIN_OR).toBe(0xec)
    expect(OP.OP_BIN_XOR).toBe(0xf4)
  })

  // SigmaAnd / SigmaOr are load-bearing for sigma-protocol verification
  // (every multi-signature script reaches one of these).
  it('SIGMA_AND = 0xea, SIGMA_OR = 0xeb', () => {
    expect(OP.OP_SIGMA_AND).toBe(0xea)
    expect(OP.OP_SIGMA_OR).toBe(0xeb)
  })
})

describe('parseExpr dispatch shell', () => {
  // Helper: invoke parseExpr on a single-byte input and capture the error
  // class + code surface in one shot.
  function parseOne(byte: number): ExprParseError {
    const r = new ByteReader(new Uint8Array([byte]))
    try {
      parseExpr(r, [], [])
      throw new Error('parseExpr should have thrown')
    } catch (e) {
      if (!(e instanceof ExprParseError)) {
        throw e
      }
      return e
    }
  }

  it('inline-constant byte (0x01 SBoolean) parses to a Const', () => {
    // Bytes in [0..=LAST_CONSTANT_CODE] are SType codes for inline Constant
    // values — Task 10 ported this branch. Provide enough bytes for an
    // SBoolean Const (type code + 1-byte boolean value) and assert the
    // produced Expr is a Const.
    const r = new ByteReader(new Uint8Array([0x01, 0x01]))
    const e = parseExpr(r, [], [])
    expect(e.tag).toBe('Const')
    if (e.tag !== 'Const') throw new Error('unreachable')
    expect(e.tpe).toEqual({ tag: 'SBoolean' })
    expect(e.value).toEqual({ kind: 'Boolean', value: true })
  })

  it('LAST_CONSTANT_CODE (0x70 = 112) is routed to the inline-constant branch', () => {
    // Right at the boundary: byte 112 (LAST_CONSTANT_CODE) is the last byte
    // handled by the inline-constant parser in sigma-rust. It's also the
    // SFunc type tag (TYPE_CODE_SFUNC = 112) on the SType side; routing it
    // to `parseConstFromByte` triggers SType-parsing for SFunc. With only
    // the boundary byte present, SType parsing reads further (for tDomLen)
    // and the underlying reader runs out — confirming we routed to the
    // inline-constant branch, not to the opcode-dispatch `unknown-opcode`
    // arm (which would have thrown `ExprParseError` with that code).
    const r = new ByteReader(new Uint8Array([OP.LAST_CONSTANT_CODE]))
    try {
      parseExpr(r, [], [])
      throw new Error('parseExpr should have thrown')
    } catch (e) {
      // The error MUST NOT be an `unknown-opcode` ExprParseError — that
      // would indicate the byte fell through to the opcode-dispatch
      // default arm. Any other error (ReaderError truncation, STypeParseError)
      // is acceptable for this boundary test.
      if (e instanceof ExprParseError) {
        expect(e.code).not.toBe('unknown-opcode')
      }
      // else: ReaderError or STypeParseError; either confirms we routed
      // through the inline-constant branch.
    }
  })

  it('VAL_USE (0x72) is a known opcode → not-implemented-yet', () => {
    const e = parseOne(OP.OP_VAL_USE)
    expect(e.code).toBe('not-implemented-yet')
    expect(e.message).toContain('ValUse')
  })

  it('IF (0x95) is a known opcode → not-implemented-yet', () => {
    const e = parseOne(OP.OP_IF)
    expect(e.code).toBe('not-implemented-yet')
    expect(e.message).toContain('If')
  })

  it('XOR_OF (0xff) is a known opcode → not-implemented-yet', () => {
    const e = parseOne(OP.OP_XOR_OF)
    expect(e.code).toBe('not-implemented-yet')
    expect(e.message).toContain('XorOf')
  })

  it('unknown opcode 0xab (shift 59, reserved) throws unknown-opcode', () => {
    // Byte 0xab is in the "real opcode" range (> LAST_CONSTANT_CODE) but
    // falls in a reserved-shift slot (56..59 reserved between SELF_BOX
    // and MINER_PUBKEY). sigma-rust returns NotImplementedOpCode here;
    // we surface that as `unknown-opcode`.
    const e = parseOne(0xab)
    expect(e.code).toBe('unknown-opcode')
    expect(e.message).toContain('0xab')
  })
})
