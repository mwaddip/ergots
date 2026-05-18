import { describe, expect, it } from 'vitest'
import { doubleLeftRotate, doubleRightRotate } from '../src/rotation.js'
import { newInternal, newLeaf, label } from '../src/node.js'
import type { InternalNode } from '../src/node.js'

describe('doubleLeftRotate', () => {
  it('rotates a known unbalanced sub-tree', () => {
    // Construct an unbalanced tree shape that requires a double-left rotation.
    // Specific shape: see Rust source, double_left_rotate lines 135-170 —
    // precondition: node.right is Internal, AND node.right.left is Internal
    // (the promoted `new_root` per Rust line 142).
    //
    //         root (0)
    //        /        \
    //     leaf1       r (0)            ← r = node.right
    //                /     \
    //              rl (0)  leaf4       ← rl = node.right.left (must be Internal)
    //              /   \
    //            leaf2 leaf3
    const leaf1 = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([2]))
    const leaf2 = newLeaf(new Uint8Array([2]), new Uint8Array([20]), new Uint8Array([3]))
    const leaf3 = newLeaf(new Uint8Array([3]), new Uint8Array([30]), new Uint8Array([4]))
    const leaf4 = newLeaf(new Uint8Array([4]), new Uint8Array([40]), new Uint8Array([255]))
    const rl = newInternal(leaf2, leaf3, 1)
    const r = newInternal(rl, leaf4, 0)
    const root = newInternal(leaf1, r, 0)
    const rotated = doubleLeftRotate(root)
    expect(rotated.kind).toBe('internal')
    expect(label(rotated).length).toBe(32)
  })

  it('handles all three rl.balance cases (0, -1, +1)', () => {
    // Exercise each match arm so the test reaches all balance reassignment paths.
    const leafA = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([2]))
    const leafB = newLeaf(new Uint8Array([2]), new Uint8Array([20]), new Uint8Array([3]))
    const leafC = newLeaf(new Uint8Array([3]), new Uint8Array([30]), new Uint8Array([4]))
    const leafD = newLeaf(new Uint8Array([4]), new Uint8Array([40]), new Uint8Array([255]))

    for (const rlBal of [0, -1, 1] as const) {
      // Build subtree: root = (leafA, (rl=(leafB, leafC, rlBal), leafD, 0))
      // Where rl is the inner node whose balance we control.
      const rl = newInternal(leafB, leafC, rlBal)
      const r = newInternal(rl, leafD, 0)
      const root = newInternal(leafA, r, 0)
      const rotated = doubleLeftRotate(root)

      expect(rotated.kind).toBe('internal')
      // New sub-root's balance is always 0.
      expect(rotated.balance).toBe(0)
      // Sub-root's children are both internal.
      expect(rotated.left.kind).toBe('internal')
      expect(rotated.right.kind).toBe('internal')
      // Balance of the children depends on rlBal:
      //   0 → (0, 0); -1 → (0, +1); +1 → (-1, 0)
      const newLeft = rotated.left as InternalNode
      const newRight = rotated.right as InternalNode
      const expected =
        rlBal === 0
          ? [0, 0]
          : rlBal === -1
            ? [0, 1]
            : [-1, 0]
      expect(newLeft.balance).toBe(expected[0])
      expect(newRight.balance).toBe(expected[1])

      // Pointer reassignment per Rust:
      //   new_left.left = original root.left (leafA)
      //   new_left.right = rl.left (leafB)
      //   new_right.left = rl.right (leafC)
      //   new_right.right = r.right (leafD)
      expect(newLeft.left).toBe(leafA)
      expect(newLeft.right).toBe(leafB)
      expect(newRight.left).toBe(leafC)
      expect(newRight.right).toBe(leafD)

      // Label is well-formed (32 bytes).
      expect(label(rotated).length).toBe(32)
    }
  })
})

describe('doubleRightRotate', () => {
  it('rotates a known unbalanced sub-tree (mirror of left)', () => {
    // Mirror of doubleLeftRotate test —
    // precondition: node.left is Internal, AND node.left.right is Internal
    // (the promoted `new_root` per Rust line 178).
    //
    //         root (0)
    //        /        \
    //      l (0)      leaf4           ← l = node.left
    //     /     \
    //   leaf1   lr (-1)               ← lr = node.left.right (must be Internal)
    //           /   \
    //         leaf2 leaf3
    const leaf1 = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([2]))
    const leaf2 = newLeaf(new Uint8Array([2]), new Uint8Array([20]), new Uint8Array([3]))
    const leaf3 = newLeaf(new Uint8Array([3]), new Uint8Array([30]), new Uint8Array([4]))
    const leaf4 = newLeaf(new Uint8Array([4]), new Uint8Array([40]), new Uint8Array([255]))
    const lr = newInternal(leaf2, leaf3, -1)
    const l = newInternal(leaf1, lr, 0)
    const root = newInternal(l, leaf4, 0)
    const rotated = doubleRightRotate(root)
    expect(rotated.kind).toBe('internal')
    expect(label(rotated).length).toBe(32)
  })

  it('handles all three lr.balance cases (0, -1, +1)', () => {
    // Mirror of double-left: lr = leftChild.right, balance match same as Rust.
    const leafA = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([2]))
    const leafB = newLeaf(new Uint8Array([2]), new Uint8Array([20]), new Uint8Array([3]))
    const leafC = newLeaf(new Uint8Array([3]), new Uint8Array([30]), new Uint8Array([4]))
    const leafD = newLeaf(new Uint8Array([4]), new Uint8Array([40]), new Uint8Array([255]))

    for (const lrBal of [0, -1, 1] as const) {
      // Build subtree: root = ((leafA, lr=(leafB, leafC, lrBal), 0), leafD)
      const lr = newInternal(leafB, leafC, lrBal)
      const l = newInternal(leafA, lr, 0)
      const root = newInternal(l, leafD, 0)
      const rotated = doubleRightRotate(root)

      expect(rotated.kind).toBe('internal')
      // New sub-root's balance is always 0.
      expect(rotated.balance).toBe(0)
      expect(rotated.left.kind).toBe('internal')
      expect(rotated.right.kind).toBe('internal')

      // Same match cases as double_left_rotate per Rust source lines 179-184:
      //   0 → (new_left_balance=0, new_right_balance=0)
      //  -1 → (0, +1)
      //  +1 → (-1, 0)
      const newLeft = rotated.left as InternalNode
      const newRight = rotated.right as InternalNode
      const expected =
        lrBal === 0
          ? [0, 0]
          : lrBal === -1
            ? [0, 1]
            : [-1, 0]
      expect(newLeft.balance).toBe(expected[0])
      expect(newRight.balance).toBe(expected[1])

      // Pointer reassignment per Rust:
      //   new_left.left = l.left (leafA)
      //   new_left.right = lr.left (leafB)
      //   new_right.left = lr.right (leafC)
      //   new_right.right = original root.right (leafD)
      expect(newLeft.left).toBe(leafA)
      expect(newLeft.right).toBe(leafB)
      expect(newRight.left).toBe(leafC)
      expect(newRight.right).toBe(leafD)

      expect(label(rotated).length).toBe(32)
    }
  })
})
