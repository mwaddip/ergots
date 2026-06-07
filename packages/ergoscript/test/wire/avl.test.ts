import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'

/**
 * `CreateAvlTree` and `TreeLookup` round-trips. Drives the parsers
 * end-to-end via the `parseTree` / `serializeTree` envelope so the
 * per-variant code runs in its real call context.
 *
 * Wire format (verified against the JVM, which is canonical):
 *   - `CreateAvlTree` (opcode 0xb6) — FOUR expr operands, all written via
 *     the expr channel (`CreateAvlTreeSerializer.scala:24-37` — four
 *     `w.putValue(...)` / four `r.getValue()` calls):
 *       [flags: Expr]                  -- type SByte
 *       [digest: Expr]                 -- type SColl(SByte)
 *       [keyLength: Expr]              -- type SInt
 *       [valueLengthOpt: Expr]         -- type SOption(SInt) — an EXPR whose
 *                                         *type* is Option; "no value length"
 *                                         is `Const(SOption[SInt], None)`,
 *                                         NOT an absent operand
 *     (No length prefix on the run — fixed 4 elements.)
 *
 *     ⚠ sigma-rust forks here (ergo-node-integration
 *     `ergotree-ir/src/mir/create_avl_tree.rs` `sigma_parse`/`sigma_serialize`):
 *     it writes the 4th operand as `Option<Box<Expr>>` — a one-byte presence
 *     tag (0x00/0x01) followed by the expr when Some. JVM-emitted bytes
 *     (4th operand = an Option-typed expr, e.g. ConstantPlaceholder 0x73)
 *     are unparseable under that shape and vice-versa. ergots originally
 *     ported the sigma-rust shape; the F4-epilogue blessed vector
 *     `AvlTree.unsupported_eval_nodes_v6.json#create_avl_tree-errored#1`
 *     exposed the fork (parse crash on `0x73` where the tag byte was
 *     expected). The JVM layout below is the consensus shape.
 *
 *   - `TreeLookup` (opcode 0xb7) — three expr operands (identical in JVM
 *     and sigma-rust):
 *       [tree: Expr]                   -- type SAvlTree
 *       [key: Expr]                    -- type SColl(SByte)
 *       [proof: Expr]                  -- type SColl(SByte)
 *
 * Cross-reference:
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/
 *     serialization/CreateAvlTreeSerializer.scala (canonical)
 *   external/sigma-rust @ ergo-node-integration:
 *     ergotree-ir/src/mir/create_avl_tree.rs (forked presence-tag shape,
 *     routed to sigma-rust via SANTA)
 */

describe('CreateAvlTree variant', () => {
  it('round-trips the JVM-blessed vector bytes (segregated v3 tree, valueLengthOpt = placeholder → Const(SOption[SInt], None))', () => {
    // AvlTree.unsupported_eval_nodes_v6.json #create_avl_tree-errored#1
    // (blessed_by jvm:sigma-state-6.0.3) — script `CreateAvlTree(flags,
    // digest, 32, None)`. Layout:
    //   0x1b              header (v3 | hasSize | constant segregation)
    //   0x33              size = 51 bytes
    //   0x04              4 segregated constants:
    //     0x02 0x07                 SByte 7            (flags)
    //     0x0e 0x21 <33 bytes>      SColl(SByte) len33 (digest)
    //     0x04 0x40                 SInt 32            (keyLength)
    //     0x28 0x00                 SOption(SInt) None (valueLengthOpt)
    //   body:
    //     0xb6              OP_AVL_TREE
    //     0x73 0x00..0x03   FOUR ConstantPlaceholders — the 4th IS the
    //                       valueLengthOpt operand (expr channel, no
    //                       presence tag)
    const hex =
      '1b330402070e21fb2b77372d81da43ce2d72714aec79ae5fcac20a9aff426fe6afb476a6fb' +
      'c02c0404402800b67300730173027303'
    const bytes = Uint8Array.from(
      hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    )

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('CreateAvlTree')
    if (tree.body.tag !== 'CreateAvlTree') throw new Error('unreachable')

    // 4th operand parsed through the expr channel.
    expect(tree.body.valueLength.tag).toBe('ConstPlaceholder')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips inline CreateAvlTree with valueLengthOpt = Const(SOption[SInt], None)', () => {
    // AST: CreateAvlTree(
    //        flags       = Const(SByte 0x06),
    //        digest      = Const(SColl(SByte) [0xde,0xad,0xbe,0xef]),
    //        keyLength   = Const(SInt 32),
    //        valueLength = Const(SOption[SInt], None)
    //      )
    //
    // bytes (v3 header + size, non-segregated, matching the blessed
    // vector's tree version):
    //   0x0b                header (v3 | hasSize)
    //   0x0d                size = 13 bytes
    //   0xb6                OP_AVL_TREE
    //   0x02 0x06           flags = Const(SByte 0x06)
    //   0x0e 0x04           digest = Const(SColl(SByte), len=4) ...
    //     0xde 0xad 0xbe 0xef    ... 4 raw bytes (NativeColl byte path)
    //   0x04 0x40           keyLength = Const(SInt, ZigZag(32)=64)
    //   0x28 0x00           valueLength = Const(SOption[SInt], None)
    //                       (type code 0x28 = 36+4; data tag 0x00 = None)
    const bytes = new Uint8Array([
      0x0b, 0x0d,
      0xb6,
      0x02, 0x06,
      0x0e, 0x04, 0xde, 0xad, 0xbe, 0xef,
      0x04, 0x40,
      0x28, 0x00,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('CreateAvlTree')
    if (tree.body.tag !== 'CreateAvlTree') throw new Error('unreachable')

    if (tree.body.flags.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.flags.value).toEqual({ kind: 'Byte', value: 6 })

    if (tree.body.digest.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.digest.value.kind).toBe('Coll')
    if (tree.body.digest.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.digest.value.elem).toEqual({ tag: 'SByte' })
    expect(tree.body.digest.value.items).toHaveLength(4)

    if (tree.body.keyLength.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.keyLength.value).toEqual({ kind: 'Int', value: 32 })

    if (tree.body.valueLength.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.valueLength.tpe).toEqual({
      tag: 'SOption',
      elem: { tag: 'SInt' },
    })
    expect(tree.body.valueLength.value).toEqual({
      kind: 'Option',
      elem: { tag: 'SInt' },
      value: null,
    })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips inline CreateAvlTree with valueLengthOpt = Const(SOption[SInt], Some(32))', () => {
    // Same as above but valueLength = Const(SOption[SInt], Some(32)):
    //   0x28 0x01 0x40      type SOption(SInt); data tag 0x01 = Some;
    //                       payload ZigZag(32)=64
    const bytes = new Uint8Array([
      0x0b, 0x0e,
      0xb6,
      0x02, 0x06,
      0x0e, 0x04, 0xde, 0xad, 0xbe, 0xef,
      0x04, 0x40,
      0x28, 0x01, 0x40,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'CreateAvlTree') throw new Error('unreachable')
    if (tree.body.valueLength.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.valueLength.value).toEqual({
      kind: 'Option',
      elem: { tag: 'SInt' },
      value: { kind: 'Int', value: 32 },
    })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('TreeLookup variant', () => {
  it('round-trips TreeLookup(GETVAR placeholder, key=ColByte[..], proof=ColByte[..])', () => {
    // AST: TreeLookup(
    //        tree  = GetVar(SAvlTree, varId=1),
    //        key   = Const(SColl(SByte) [0x01, 0x02]),
    //        proof = Const(SColl(SByte) [0xaa]),
    //      )
    //
    // We use GetVar instead of a Const(SAvlTree) for the tree slot because
    // Const(SAvlTree) values are not yet serialized in this package (Phase 2a
    // does not implement Const SValue for SAvlTree — see parse-svalue.ts).
    // GetVar produces an Option<SAvlTree>; post-eval-type checks would be a
    // mismatch but those checks live in the constructor, not the wire layer.
    // Here we only validate byte round-trip.
    //
    // bytes:
    //   0x00              header
    //   0xb7              OP_AVL_TREE_GET
    //   0xe3 0x01 0x64    tree  = OP_GET_VAR + varId=1 (u8) + SType byte (SAvlTree=100=0x64)
    //   0x0e 0x02 0x01 0x02    key   = Const(SColl(SByte) [0x01, 0x02])
    //   0x0e 0x01 0xaa         proof = Const(SColl(SByte) [0xaa])
    const bytes = new Uint8Array([
      0x00,
      0xb7,
      0xe3, 0x01, 0x64,
      0x0e, 0x02, 0x01, 0x02,
      0x0e, 0x01, 0xaa,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('TreeLookup')
    if (tree.body.tag !== 'TreeLookup') throw new Error('unreachable')

    expect(tree.body.tree.tag).toBe('GetVar')

    if (tree.body.key.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.key.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.key.value.items).toHaveLength(2)

    if (tree.body.proof.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.proof.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.proof.value.items).toHaveLength(1)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})
