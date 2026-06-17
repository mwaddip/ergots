import { describe, it, expect } from 'vitest'
import { serializeTree } from '../../src/wire/ergo-tree'
import { hexToBytes, parseParsedTree as parseTree } from '../_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 22 tests: round-trips for GroupElement arithmetic ops.
 *
 * Both ops share the same binary `[opcode][left Expr][right Expr]` shape
 * (sigma-rust `mir/exponentiate.rs` and `mir/multiply_group.rs`):
 *
 *   - Exponentiate   0x9f (159) — SGroupElement, SBigInt -> SGroupElement
 *   - MultiplyGroup  0xa0 (160) — SGroupElement, SGroupElement -> SGroupElement
 *
 * Sigma-rust's `Exponentiate::new` / `MultiplyGroup::new` enforce per-operand
 * post-eval types; we do NOT enforce that at the wire layer (same convention
 * as Xor, BoolToSigmaProp, etc.). Well-formed corpora produced by sigma-rust
 * always satisfy the constraints; the AST is sigma-rust-equivalent regardless.
 *
 * Const encoding cheat-sheet for the byte vectors below
 * (see `wire/serialize-stype.ts:82-188`, `wire/serialize-svalue.ts:60-105`):
 *   - SBigInt (6):        VLQ length + raw big-endian two's-complement bytes
 *   - SGroupElement (7):  33 bytes, curve-validated + normalized at parse
 *                         (F5 batch 4 GE canonical-bytes invariant:
 *                         0x00-lead ⇒ canonical identity; else must
 *                         SEC1-decode — see facts/ergoscript-eval.md)
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/exponentiate.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/multiply_group.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::EXPONENTIATE = new_op_code(47) → 30 + 47 = 77 (decimal) but the
 *     constant block-base offset is 0x30 = 48 (decimal). Read by sigma-rust
 *     as: code = 48 + position. EXPONENTIATE position 47 → 0x9f hex = 159.
 *     MULTIPLY_GROUP position 48 → 0xa0 hex = 160. Confirmed against
 *     `packages/ergoscript/src/mir/opcodes.ts:142-143`.)
 */

/**
 * 33-byte GroupElement test payloads. F5 batch 4 recalibration: the parse arm
 * now curve-validates non-0x00-lead payloads (JVM GroupElementSerializer.parse
 * :35-42 — GE canonical-bytes invariant, facts/ergoscript-eval.md), so the
 * former `0x02 + ascending-bytes` placeholder (x not on the curve) would
 * parse-reject with 'group-element-invalid-point'. These tests exercise the
 * Exponentiate/MultiplyGroup wire shapes, not GE validation, so we use real
 * curve points: `gA` = the canonical identity (33 zeros — normalizes to
 * itself, so round-trips byte-identically) and `gB` = the secp256k1 generator
 * G. Distinct content keeps the two operands distinguishable.
 */
const gA = new Uint8Array(33) // canonical identity
const gB = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798') // G

describe('Exponentiate variant', () => {
  it('round-trips Exponentiate(Const SGroupElement, Const SBigInt)', () => {
    // AST: Exponentiate(Const(SGroupElement = gA), Const(SBigInt = 42))
    //
    // bytes:
    //   0x00                                 header (v0, no size, no segregation)
    //   0x9f                                 OP_EXPONENTIATE
    //   0x07                                 Const SType-code = SGroupElement
    //     <33 bytes of gA>
    //   0x06                                 Const SType-code = SBigInt
    //     0x01 0x2a                          VLQ len=1, big-endian byte 0x2a (42)
    const bytes = new Uint8Array([
      0x00,
      0x9f,
      0x07, ...gA,
      0x06, 0x01, 0x2a,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Exponentiate')
    if (tree.body.tag !== 'Exponentiate') throw new Error('unreachable')

    expect(tree.body.left.tag).toBe('Const')
    if (tree.body.left.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.left.tpe).toEqual({ tag: 'SGroupElement' })
    expect(tree.body.left.value.kind).toBe('GroupElement')
    if (tree.body.left.value.kind !== 'GroupElement') throw new Error('unreachable')
    expect(Array.from(tree.body.left.value.value)).toEqual(Array.from(gA))

    expect(tree.body.right.tag).toBe('Const')
    if (tree.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.right.tpe).toEqual({ tag: 'SBigInt' })
    expect(tree.body.right.value).toEqual({ kind: 'BigInt', value: 42n })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes Exponentiate programmatically', () => {
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
        tag: 'Exponentiate',
        left: {
          tag: 'Const',
          tpe: { tag: 'SGroupElement' },
          value: { kind: 'GroupElement', value: gB },
        },
        right: {
          tag: 'Const',
          tpe: { tag: 'SBigInt' },
          value: { kind: 'BigInt', value: 1n },
        },
      },
    }
    const out = serializeTree(tree)
    // header + OP_EXPONENTIATE + SGroupElement(0x07) + gB + SBigInt(0x06) + len(1) + [1]
    expect(Array.from(out)).toEqual([0x00, 0x9f, 0x07, ...gB, 0x06, 0x01, 0x01])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'Exponentiate') throw new Error('unreachable')
  })
})

describe('MultiplyGroup variant', () => {
  it('round-trips MultiplyGroup(Const SGroupElement, Const SGroupElement)', () => {
    // AST: MultiplyGroup(Const(SGroupElement = gA), Const(SGroupElement = gB))
    //
    // bytes:
    //   0x00              header (v0, no size, no segregation)
    //   0xa0              OP_MULTIPLY_GROUP
    //   0x07              Const SType-code = SGroupElement
    //     <33 bytes gA>
    //   0x07              Const SType-code = SGroupElement
    //     <33 bytes gB>
    const bytes = new Uint8Array([
      0x00,
      0xa0,
      0x07, ...gA,
      0x07, ...gB,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('MultiplyGroup')
    if (tree.body.tag !== 'MultiplyGroup') throw new Error('unreachable')

    expect(tree.body.left.tag).toBe('Const')
    if (tree.body.left.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.left.tpe).toEqual({ tag: 'SGroupElement' })
    expect(tree.body.left.value.kind).toBe('GroupElement')
    if (tree.body.left.value.kind !== 'GroupElement') throw new Error('unreachable')
    expect(Array.from(tree.body.left.value.value)).toEqual(Array.from(gA))

    expect(tree.body.right.tag).toBe('Const')
    if (tree.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.right.tpe).toEqual({ tag: 'SGroupElement' })
    expect(tree.body.right.value.kind).toBe('GroupElement')
    if (tree.body.right.value.kind !== 'GroupElement') throw new Error('unreachable')
    expect(Array.from(tree.body.right.value.value)).toEqual(Array.from(gB))

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes MultiplyGroup programmatically', () => {
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
        tag: 'MultiplyGroup',
        left: {
          tag: 'Const',
          tpe: { tag: 'SGroupElement' },
          value: { kind: 'GroupElement', value: gB },
        },
        right: {
          tag: 'Const',
          tpe: { tag: 'SGroupElement' },
          value: { kind: 'GroupElement', value: gA },
        },
      },
    }
    const out = serializeTree(tree)
    // header + OP_MULTIPLY_GROUP + SGroupElement(0x07) + gB + SGroupElement(0x07) + gA
    expect(Array.from(out)).toEqual([0x00, 0xa0, 0x07, ...gB, 0x07, ...gA])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'MultiplyGroup') throw new Error('unreachable')
  })
})

describe('Nesting: Exponentiate wrapping MultiplyGroup', () => {
  it('round-trips Exponentiate(MultiplyGroup(gA, gB), Const SBigInt 2)', () => {
    // AST: (gA * gB) ^ 2
    //
    // bytes:
    //   0x00                          header
    //   0x9f                          OP_EXPONENTIATE (outer)
    //     0xa0                        OP_MULTIPLY_GROUP (inner)
    //       0x07 <gA>                 Const SGroupElement = gA
    //       0x07 <gB>                 Const SGroupElement = gB
    //     0x06 0x01 0x02              Const SBigInt = 1 (ZigZag(1)? no — SBigInt
    //                                   is VLQ-len + raw BE bytes; 1 fits in
    //                                   one byte = 0x01, but here we use 2 =
    //                                   0x02 to keep the bytes distinct.)
    const bytes = new Uint8Array([
      0x00,
      0x9f,
      0xa0,
      0x07, ...gA,
      0x07, ...gB,
      0x06, 0x01, 0x02,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Exponentiate') throw new Error('unreachable')
    if (tree.body.left.tag !== 'MultiplyGroup') throw new Error('unreachable')
    if (tree.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.right.value).toEqual({ kind: 'BigInt', value: 2n })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})
