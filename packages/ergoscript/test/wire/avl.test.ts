import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { expectParseError } from './_helpers'

/**
 * Task 20 tests: `CreateAvlTree` and `TreeLookup` round-trips. Drives the
 * parsers end-to-end via the `parseTree` / `serializeTree` envelope so the
 * per-variant code runs in its real call context.
 *
 * Wire format reminders (verified against sigma-rust source):
 *   - `CreateAvlTree` (opcode 0xb6):
 *       [flags: Expr]                  -- post-eval type SByte
 *       [digest: Expr]                 -- post-eval type SColl(SByte)
 *       [keyLength: Expr]              -- post-eval type SInt
 *       [valueLength: Option<Box<Expr>>]
 *         tag byte: 0x00 = None, 0x01 = Some (Expr follows)
 *     (No length prefix on the run — fixed 4 elements.)
 *
 *   - `TreeLookup` (opcode 0xb7, sigma-rust constant: AVT_TREE_GET):
 *       [tree: Expr]                   -- post-eval type SAvlTree
 *       [key: Expr]                    -- post-eval type SColl(SByte)
 *       [proof: Expr]                  -- post-eval type SColl(SByte)
 *
 * The Option<Box<Expr>> tag uses the same shape as sigma-rust's
 * `impl<T: SigmaSerializable> SigmaSerializable for Option<Box<T>>`
 * (`serialization/serializable.rs`).
 *
 * Full AVL+ membership-proof verification is deferred to phase 2h. This
 * codec only handles the wire shape; the `proof` Expr at runtime carries
 * the merkle-path bytes that the future verifier will consume.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_avl_tree.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/tree_lookup.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/serializable.rs
 */

describe('CreateAvlTree variant', () => {
  it('round-trips CreateAvlTree(flags=Byte 6, digest=ColByte[..], keyLen=Int 32, valueLen=None)', () => {
    // AST: CreateAvlTree(
    //        flags     = Const(SByte 0x06),
    //        digest    = Const(SColl(SByte) [0xde,0xad,0xbe,0xef]),
    //        keyLength = Const(SInt 32),
    //        valueLength = None
    //      )
    //
    // bytes:
    //   0x00                header (v0, no size, no segregation)
    //   0xb6                OP_AVL_TREE
    //   0x02 0x06           flags = Const(SByte 0x06)
    //   0x0e 0x04           digest = Const(SColl(SByte), len=4) ...
    //     0xde 0xad 0xbe 0xef    ... 4 raw bytes (NativeColl byte path)
    //   0x04 0x40           keyLength = Const(SInt, ZigZag(32)=64)
    //   0x00                valueLength Option tag = 0 (None)
    const bytes = new Uint8Array([
      0x00,
      0xb6,
      0x02, 0x06,
      0x0e, 0x04, 0xde, 0xad, 0xbe, 0xef,
      0x04, 0x40,
      0x00,
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

    expect(tree.body.valueLength).toBeNull()

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips CreateAvlTree with valueLength=Some(Int 32)', () => {
    // Same as above but valueLength = Some(Const(SInt 32)).
    //
    // bytes:
    //   0x00              header
    //   0xb6              OP_AVL_TREE
    //   0x02 0x06         flags = Const(SByte 0x06)
    //   0x0e 0x04 ...     digest = Const(SColl(SByte) 4 bytes)
    //     0xde 0xad 0xbe 0xef
    //   0x04 0x40         keyLength = Const(SInt 32)
    //   0x01              valueLength Option tag = 1 (Some)
    //   0x04 0x40         inner = Const(SInt 32)
    const bytes = new Uint8Array([
      0x00,
      0xb6,
      0x02, 0x06,
      0x0e, 0x04, 0xde, 0xad, 0xbe, 0xef,
      0x04, 0x40,
      0x01,
      0x04, 0x40,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'CreateAvlTree') throw new Error('unreachable')
    expect(tree.body.valueLength).not.toBeNull()
    if (tree.body.valueLength === null) throw new Error('unreachable')
    if (tree.body.valueLength.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.valueLength.value).toEqual({ kind: 'Int', value: 32 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('rejects CreateAvlTree with invalid Option tag (>= 2)', () => {
    // Same prefix as the first test but the Option tag is 0x02 (invalid;
    // sigma-rust accepts only 0 or 1).
    const bytes = new Uint8Array([
      0x00,
      0xb6,
      0x02, 0x06,
      0x0e, 0x04, 0xde, 0xad, 0xbe, 0xef,
      0x04, 0x40,
      0x02, // INVALID Option tag
    ])
    expectParseError(() => parseTree(bytes), 'invalid-option-tag')
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
