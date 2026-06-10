import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { hexToBytes } from '../_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 23 tests: round-trips for Sigma proposition construction variants.
 *
 * Six MIR nodes that build (or unpack) Sigma propositions:
 *
 *   - CreateProveDlog       0xcd (205) — SGroupElement       -> SSigmaProp
 *   - CreateProveDhTuple    0xce (206) — 4×SGroupElement     -> SSigmaProp
 *   - SigmaPropIsProven     0xcf (207) — SSigmaProp          -> SBoolean
 *   - SigmaPropBytes        0xd0 (208) — SSigmaProp          -> Coll[SByte]
 *   - SigmaAnd              0xea (234) — Coll[SSigmaProp]    -> SSigmaProp
 *   - SigmaOr               0xeb (235) — Coll[SSigmaProp]    -> SSigmaProp
 *
 * Wire convention:
 *   - The four `OneArgOp` variants (Dlog, IsProven, PropBytes) and the four-
 *     argument DhTuple just emit their inner Expr(s) back-to-back after the
 *     opcode byte (sigma-rust `mir/unary_op.rs`,
 *     `mir/create_prove_dh_tuple.rs`).
 *   - SigmaAnd / SigmaOr serialize the items as `Vec<Expr>` — VLQ-u32 length
 *     followed by each Expr (`serialization/serializable.rs:172-186` plus
 *     `sigma-ser/src/vlq_encode.rs::put_u32`).
 *
 * Sigma-rust constructors enforce per-input types (SGroupElement / SSigmaProp)
 * but the wire-layer parser/serializer is permissive — type-shape checks
 * belong to a later pass (phase 2g). Well-formed corpora from sigma-rust always
 * satisfy the constraints; the AST is sigma-rust-equivalent regardless.
 *
 * Const-encoding cheat-sheet for the byte vectors:
 *   - SGroupElement (0x07): 33 bytes, curve-validated + normalized at parse
 *     (F5 batch 4 GE canonical-bytes invariant: 0x00-lead ⇒ canonical
 *     identity; else must SEC1-decode — see facts/ergoscript-eval.md).
 *   - SBoolean      (0x01): SType code + one byte (0x00=false / 0x01=true).
 *     So `Const SBoolean true` is the two bytes `0x01 0x01`. The
 *     standalone OP_TRUE / OP_FALSE single-byte opcodes (0x7f / 0x80) are
 *     deferred in this build, so the test uses the long-form inline Const.
 *
 * The SigmaProp-typed inputs to SigmaPropBytes / SigmaPropIsProven / SigmaAnd
 * / SigmaOr cannot be inlined as Const(SSigmaProp) in phase 2a (deferred —
 * see `wire/serialize-svalue.ts:203-215`). Instead we build them with
 * BoolToSigmaProp(true) (opcode 0xd1) or CreateProveDlog(gE) (opcode 0xcd),
 * both of which yield an SSigmaProp-typed Expr without a deferred Const.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_provedlog.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_prove_dh_tuple.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/sigma_prop_bytes.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/sigma_prop_is_proven.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/sigma_and.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/sigma_or.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 */

/**
 * 33-byte GroupElement test payloads. F5 batch 4 recalibration: the parse arm
 * now curve-validates non-0x00-lead payloads (JVM GroupElementSerializer.parse
 * :35-42 — GE canonical-bytes invariant, facts/ergoscript-eval.md), so the
 * former `0x02/0x03 + ascending-bytes` placeholders would parse-reject with
 * 'group-element-invalid-point'. Specifically: old gB (0x02 + 0x01..0x20) and
 * old gD (0x02 + 0x81..0xA0) were off-curve and required replacement. Old gC
 * (0x03 + 0x41..0x60) happened to be a coincidentally valid curve point but
 * was swapped anyway for uniformity with real named points. These tests
 * exercise the sigma-construction op wire shapes, not GE validation, so we use
 * real curve points with distinct content — keeping both 02/03 parity prefixes,
 * as before: identity, G, 6G (odd y → 03-lead), 2G.
 */
const gA = new Uint8Array(33) // canonical identity
const gB = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798') // G
const gC = hexToBytes('03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556') // 6G
const gD = hexToBytes('02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5') // 2G

describe('CreateProveDlog variant', () => {
  it('round-trips CreateProveDlog(Const SGroupElement gA)', () => {
    // AST: proveDlog(gA)
    //
    // bytes:
    //   0x00              header (v0, no size, no segregation)
    //   0xcd              OP_PROVE_DLOG
    //   0x07              Const SType-code = SGroupElement
    //     <33 bytes gA>
    const bytes = new Uint8Array([0x00, 0xcd, 0x07, ...gA])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('CreateProveDlog')
    if (tree.body.tag !== 'CreateProveDlog') throw new Error('unreachable')
    expect(tree.body.input.tag).toBe('Const')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SGroupElement' })
    expect(tree.body.input.value.kind).toBe('GroupElement')
    if (tree.body.input.value.kind !== 'GroupElement') throw new Error('unreachable')
    expect(Array.from(tree.body.input.value.value)).toEqual(Array.from(gA))

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes CreateProveDlog programmatically', () => {
    const tree: ErgoTree = {
      header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'CreateProveDlog',
        input: {
          tag: 'Const',
          tpe: { tag: 'SGroupElement' },
          value: { kind: 'GroupElement', value: gB },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0xcd, 0x07, ...gB])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'CreateProveDlog') throw new Error('unreachable')
  })
})

describe('CreateProveDhTuple variant', () => {
  it('round-trips CreateProveDhTuple(gA, gB, gC, gD)', () => {
    // AST: proveDHTuple(gA, gB, gC, gD)
    //
    // bytes:
    //   0x00              header
    //   0xce              OP_PROVE_DIFFIE_HELLMAN_TUPLE
    //   0x07 <gA>
    //   0x07 <gB>
    //   0x07 <gC>
    //   0x07 <gD>
    const bytes = new Uint8Array([
      0x00, 0xce,
      0x07, ...gA,
      0x07, ...gB,
      0x07, ...gC,
      0x07, ...gD,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('CreateProveDhTuple')
    if (tree.body.tag !== 'CreateProveDhTuple') throw new Error('unreachable')

    for (const [field, expected] of [
      ['g', gA],
      ['h', gB],
      ['u', gC],
      ['v', gD],
    ] as const) {
      const child = tree.body[field]
      expect(child.tag).toBe('Const')
      if (child.tag !== 'Const') throw new Error('unreachable')
      expect(child.tpe).toEqual({ tag: 'SGroupElement' })
      if (child.value.kind !== 'GroupElement') throw new Error('unreachable')
      expect(Array.from(child.value.value)).toEqual(Array.from(expected))
    }

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes CreateProveDhTuple programmatically', () => {
    const mkConst = (value: Uint8Array) => ({
      tag: 'Const' as const,
      tpe: { tag: 'SGroupElement' as const },
      value: { kind: 'GroupElement' as const, value },
    })
    const tree: ErgoTree = {
      header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'CreateProveDhTuple',
        g: mkConst(gD),
        h: mkConst(gC),
        u: mkConst(gB),
        v: mkConst(gA),
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([
      0x00, 0xce,
      0x07, ...gD,
      0x07, ...gC,
      0x07, ...gB,
      0x07, ...gA,
    ])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'CreateProveDhTuple') throw new Error('unreachable')
  })
})

describe('SigmaPropBytes variant', () => {
  it('round-trips SigmaPropBytes(BoolToSigmaProp(Const SBoolean true))', () => {
    // AST: sigmaPropBytes(sigmaProp(true))
    //
    // The inner SSigmaProp expression is BoolToSigmaProp(true). We cannot
    // emit a `Const(SSigmaProp, ...)` in phase 2a (deferred shape) — using
    // BoolToSigmaProp keeps the byte sequence representable purely through
    // the existing wire variants.
    //
    // bytes:
    //   0x00          header
    //   0xd0          OP_SIGMA_PROP_BYTES
    //   0xd1          OP_BOOL_TO_SIGMA_PROP
    //     0x01 0x01     Const SBoolean true (SType code + value byte)
    const bytes = new Uint8Array([0x00, 0xd0, 0xd1, 0x01, 0x01])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('SigmaPropBytes')
    if (tree.body.tag !== 'SigmaPropBytes') throw new Error('unreachable')
    expect(tree.body.input.tag).toBe('BoolToSigmaProp')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips SigmaPropBytes(CreateProveDlog(Const SGroupElement gA))', () => {
    // AST: sigmaPropBytes(proveDlog(gA))
    //
    // bytes:
    //   0x00       header
    //   0xd0       OP_SIGMA_PROP_BYTES
    //   0xcd       OP_PROVE_DLOG
    //     0x07     SGroupElement
    //     <gA>
    const bytes = new Uint8Array([0x00, 0xd0, 0xcd, 0x07, ...gA])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'SigmaPropBytes') throw new Error('unreachable')
    if (tree.body.input.tag !== 'CreateProveDlog') throw new Error('unreachable')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('SigmaPropIsProven variant', () => {
  it('round-trips SigmaPropIsProven(BoolToSigmaProp(Const SBoolean true))', () => {
    // AST: sigmaPropIsProven(sigmaProp(true))
    //
    // bytes:
    //   0x00          header
    //   0xcf          OP_SIGMA_PROP_IS_PROVEN
    //   0xd1          OP_BOOL_TO_SIGMA_PROP
    //     0x01 0x01     Const SBoolean true
    const bytes = new Uint8Array([0x00, 0xcf, 0xd1, 0x01, 0x01])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('SigmaPropIsProven')
    if (tree.body.tag !== 'SigmaPropIsProven') throw new Error('unreachable')
    expect(tree.body.input.tag).toBe('BoolToSigmaProp')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips SigmaPropIsProven(CreateProveDlog(gA))', () => {
    const bytes = new Uint8Array([0x00, 0xcf, 0xcd, 0x07, ...gA])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'SigmaPropIsProven') throw new Error('unreachable')
    if (tree.body.input.tag !== 'CreateProveDlog') throw new Error('unreachable')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('SigmaAnd variant', () => {
  it('round-trips SigmaAnd over two CreateProveDlog items', () => {
    // AST: sigmaAnd([proveDlog(gA), proveDlog(gB)])
    //
    // bytes:
    //   0x00              header
    //   0xea              OP_SIGMA_AND
    //   0x02              items_count = 2 (VLQ-u32)
    //   item 0: proveDlog(gA)
    //     0xcd 0x07 <gA>
    //   item 1: proveDlog(gB)
    //     0xcd 0x07 <gB>
    const bytes = new Uint8Array([
      0x00,
      0xea,
      0x02,
      0xcd, 0x07, ...gA,
      0xcd, 0x07, ...gB,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('SigmaAnd')
    if (tree.body.tag !== 'SigmaAnd') throw new Error('unreachable')
    expect(tree.body.items.length).toBe(2)
    expect(tree.body.items[0]!.tag).toBe('CreateProveDlog')
    expect(tree.body.items[1]!.tag).toBe('CreateProveDlog')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips SigmaAnd over three mixed SigmaProp expressions', () => {
    // AST: sigmaAnd([proveDlog(gA), sigmaProp(true), proveDlog(gB)])
    //
    // bytes:
    //   0x00 0xea 0x03
    //   item 0: 0xcd 0x07 <gA>
    //   item 1: 0xd1 0x01 0x01              (BoolToSigmaProp(true))
    //   item 2: 0xcd 0x07 <gB>
    const bytes = new Uint8Array([
      0x00, 0xea, 0x03,
      0xcd, 0x07, ...gA,
      0xd1, 0x01, 0x01,
      0xcd, 0x07, ...gB,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'SigmaAnd') throw new Error('unreachable')
    expect(tree.body.items.length).toBe(3)
    expect(tree.body.items[0]!.tag).toBe('CreateProveDlog')
    expect(tree.body.items[1]!.tag).toBe('BoolToSigmaProp')
    expect(tree.body.items[2]!.tag).toBe('CreateProveDlog')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes SigmaAnd programmatically with a single item', () => {
    // sigma-rust's `SigmaConjectureItems` lower bound is 1; a single-item
    // conjunction is well-formed on the wire.
    const tree: ErgoTree = {
      header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'SigmaAnd',
        items: [
          {
            tag: 'CreateProveDlog',
            input: {
              tag: 'Const',
              tpe: { tag: 'SGroupElement' },
              value: { kind: 'GroupElement', value: gC },
            },
          },
        ],
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0xea, 0x01, 0xcd, 0x07, ...gC])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'SigmaAnd') throw new Error('unreachable')
    expect(reparsed.body.items.length).toBe(1)
  })
})

describe('SigmaOr variant', () => {
  it('round-trips SigmaOr over two CreateProveDlog items', () => {
    // AST: sigmaOr([proveDlog(gA), proveDlog(gB)])
    //
    // bytes:
    //   0x00 0xeb 0x02
    //   item 0: 0xcd 0x07 <gA>
    //   item 1: 0xcd 0x07 <gB>
    const bytes = new Uint8Array([
      0x00,
      0xeb,
      0x02,
      0xcd, 0x07, ...gA,
      0xcd, 0x07, ...gB,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('SigmaOr')
    if (tree.body.tag !== 'SigmaOr') throw new Error('unreachable')
    expect(tree.body.items.length).toBe(2)
    expect(tree.body.items[0]!.tag).toBe('CreateProveDlog')
    expect(tree.body.items[1]!.tag).toBe('CreateProveDlog')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes SigmaOr programmatically over four items', () => {
    const mkProveDlog = (value: Uint8Array) => ({
      tag: 'CreateProveDlog' as const,
      input: {
        tag: 'Const' as const,
        tpe: { tag: 'SGroupElement' as const },
        value: { kind: 'GroupElement' as const, value },
      },
    })
    const tree: ErgoTree = {
      header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'SigmaOr',
        items: [
          mkProveDlog(gA),
          mkProveDlog(gB),
          mkProveDlog(gC),
          mkProveDlog(gD),
        ],
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([
      0x00, 0xeb, 0x04,
      0xcd, 0x07, ...gA,
      0xcd, 0x07, ...gB,
      0xcd, 0x07, ...gC,
      0xcd, 0x07, ...gD,
    ])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'SigmaOr') throw new Error('unreachable')
    expect(reparsed.body.items.length).toBe(4)
  })
})

describe('Nesting: SigmaAnd of SigmaOr of CreateProveDhTuple', () => {
  it('round-trips a 3-level nested sigma proposition', () => {
    // AST: sigmaAnd([
    //        sigmaOr([
    //          proveDHTuple(gA, gB, gC, gD),
    //          proveDlog(gA),
    //        ]),
    //        proveDlog(gB),
    //      ])
    //
    // bytes:
    //   0x00                                       header
    //   0xea 0x02                                  SigmaAnd, 2 items
    //     0xeb 0x02                                  SigmaOr, 2 items
    //       0xce <four 0x07 + 33-byte GE>              CreateProveDhTuple
    //       0xcd 0x07 <gA>                             CreateProveDlog
    //     0xcd 0x07 <gB>                              CreateProveDlog
    const bytes = new Uint8Array([
      0x00,
      0xea, 0x02,
      0xeb, 0x02,
      0xce,
      0x07, ...gA,
      0x07, ...gB,
      0x07, ...gC,
      0x07, ...gD,
      0xcd, 0x07, ...gA,
      0xcd, 0x07, ...gB,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'SigmaAnd') throw new Error('unreachable')
    expect(tree.body.items.length).toBe(2)
    const inner = tree.body.items[0]!
    if (inner.tag !== 'SigmaOr') throw new Error('unreachable')
    expect(inner.items.length).toBe(2)
    if (inner.items[0]!.tag !== 'CreateProveDhTuple') throw new Error('unreachable')
    if (inner.items[1]!.tag !== 'CreateProveDlog') throw new Error('unreachable')
    if (tree.body.items[1]!.tag !== 'CreateProveDlog') throw new Error('unreachable')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})
