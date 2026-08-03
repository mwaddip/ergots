/**
 * Adversarial rejection tests for the four double-rotation call sites.
 *
 * All four rotations dereference a PROMOTED GRANDCHILD (`node.right.left` for
 * `doubleLeftRotate`, `node.left.right` for `doubleRightRotate`). The callers
 * guard the CHILD's kind but historically not the grandchild's, so a proof that
 * places a non-Internal node in that slot escaped as an uncaught `TypeError`
 * from `rotation.ts`'s precondition — violating `facts/avltree.md`'s no-throw
 * contract ("`verifyAvlBatch` / `verifyAvlLookup` return `null` on verification
 * failure. Throws indicate programmer errors only.").
 *
 * Deliberate divergence from the reference: ergo_avltree_rust @191052c PANICS on
 * these inputs — `double_left_rotate` / `double_right_rotate`
 * (`authenticated_tree_ops.rs:150-181` / `:187-217`) call `tree.left(...)` /
 * `tree.right(...)` and then `tree.balance(&new_root)`, and those accessors do
 * `panic!("Not internal node")` / `panic!("not internal node")`
 * (`batch_node.rs:366-384` tree-level, `:114-135` node-level). We reject with
 * `proof-malformed`, matching scrypto/JVM `BatchAVLVerifier`, which wraps replay
 * in a `Try` and poisons the tree on any exception.
 *
 * Each test asserts BOTH that nothing throws AND that the result is `null`.
 *
 * @see .superpowers/sdd/2026-08-02-avltree-phase-b-prover-engine/task-6c-brief.md
 */
import { describe, expect, it } from 'vitest'
import { verifyAvlBatch } from '../src/verify.js'
import type { Operation } from '../src/operation.js'
import type { AvlTreeConfig } from '../src/types.js'

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 32-byte key with `b` in the first and last position — matches prover.test.ts. */
function keyByte(b: number): Uint8Array {
  const k = new Uint8Array(32)
  k[0] = b
  k[31] = b
  return k
}

/**
 * Assert that `verifyAvlBatch` REJECTS (returns null) without throwing.
 * The two assertions are separate on purpose: a thrown `TypeError` is a
 * contract violation even though the caller would also "not get a result".
 */
function expectRejectedWithoutThrowing(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
  what: string,
): void {
  let result: ReturnType<typeof verifyAvlBatch> | undefined
  expect(
    () => {
      result = verifyAvlBatch(startingDigest, proof, config, operations)
    },
    `${what}: verifyAvlBatch threw instead of returning null`,
  ).not.toThrow()
  expect(result, `${what}: verifyAvlBatch accepted a malformed proof`).toBeNull()
}

// ---------------------------------------------------------------------------
// Sites 1 + 2 — delete.ts, promoted grandchild packed as a LABEL
//
// Derivation (not hand-assembled): these are the exact bytes a PRE-6b prover
// emitted. `delete.ts`'s two rotation `onNodeVisit` calls were temporarily
// reverted to their pre-6b targets (`rootRight.left` -> `rotateNode` and
// `rootLeft.right` -> `node`), the two deterministic 4-key shapes from
// `prover.test.ts` ("delete-triggered double-LEFT / double-RIGHT rotation")
// were built and the single `Remove` proof captured, then `delete.ts` was
// restored (md5 995c8ecf76854d1592ae6eda14e232cb). Because the mis-targeted
// visit never put the promoted sub-root into `modifiedNodes`, `generateProof`
// packed it as a bare LABEL token — which is precisely the crafted input an
// attacker supplies. See task-6b-report.md § Fix round 1 item D for the same
// bytes surfacing as an uncaught TypeError.
// ---------------------------------------------------------------------------

const DELETE_PATH_CONFIG: AvlTreeConfig = {
  keyLength: 32,
  valueLengthOpt: null,
  maxNumOperations: 1,
  maxDeletes: 1,
}

describe('verifier rejects labels in the promoted-grandchild slot (delete path)', () => {
  /**
   * Site 1 — `delete.ts` `rebalanceShrinkLeft`, double-LEFT branch.
   * Unguarded operand: `rootRight.left` (read as `node.right.left` inside
   * `doubleLeftRotate`, rotation.ts:58-63).
   *
   * Shape: insertion order 2,4,1,3 then `Remove(0x01)`.
   *   I[0x02](bal +1)
   *   |- I[0x01](0) -- L(-inf), L(0x01)
   *   \- I[0x04](-1)
   *      |- I[0x03](0) -- L(0x02), L(0x03)
   *      \- L(0x04)
   * The left subtree shrinks under a right-heavy root, the right child is
   * left-heavy (-1), so the DOUBLE-left branch fires and the promoted sub-root
   * is `rootRight.left` = `I[0x03]` — packed here as a bare label.
   *
   * Pre-fix failure (uncaught, out of `verifyAvlBatch`):
   *   TypeError: doubleLeftRotate precondition: node.right.left must be
   *   Internal, got label
   */
  it('rejects a Remove proof whose double-LEFT promoted sub-root is a label', () => {
    const startingDigest = hexToBytes(
      '8200dc987d3a29bf34d43305c53cd5ce3582c58966753a1c468c5ba349804ea503',
    )
    // One line on purpose: a wrapped hex literal is one silent typo away from
    // testing a different tree.
    const proof = hexToBytes('02000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000010000000002020000000000000000000000000000000000000000000000000000000000000200000001010003e447f71b494b687a4b47541e9282d0906bcbd9b61dda41e3ec3964f0776d1cb103dca3ace8ebca185a103f2aecd620e54416864c730b223da2577d7c75b0d417fbff010401')
    const op: Operation = { tag: 'Remove', key: keyByte(0x01) }
    expectRejectedWithoutThrowing(
      startingDigest,
      proof,
      DELETE_PATH_CONFIG,
      [op],
      'double-LEFT promoted sub-root as label',
    )
  })

  /**
   * Site 2 — `delete.ts` `rebalanceShrinkRight`, double-RIGHT branch.
   * Unguarded operand: `rootLeft.right` (read as `node.left.right` inside
   * `doubleRightRotate`, rotation.ts:117-122).
   *
   * Shape: insertion order 3,1,4,2 (the key-mirror k -> 5-k of site 1) then
   * `Remove(0x04)`.
   *   I[0x03](bal -1)
   *   |- I[0x01](+1)
   *   |  |- L(-inf)
   *   |  \- I[0x02](0) -- L(0x01), L(0x02)
   *   \- I[0x04](0) -- L(0x03), L(0x04)
   * Promoted sub-root is `rootLeft.right` = `I[0x02]` — packed as a bare label.
   *
   * Pre-fix failure (uncaught, out of `verifyAvlBatch`):
   *   TypeError: doubleRightRotate precondition: node.left.right must be
   *   Internal, got label
   */
  it('rejects a Remove proof whose double-RIGHT promoted sub-root is a label', () => {
    const startingDigest = hexToBytes(
      '5e6c913f4a1f763792e34bf758b7d45687c0b77ba0671398ad304ece53e382f803',
    )
    // One line on purpose — see the sibling test.
    const proof = hexToBytes('03c28daac8506f3840d68bf6b10a1ef14642b4fdae5997157209bbb13d6c7c0d500377c07458e3d9b764ef2e6c8db3294f5bf5298e71aadc0888fad8046b38b19a51010203000000000000000000000000000000000000000000000000000000000000030400000000000000000000000000000000000000000000000000000000000004000000010302ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000010400ff0400')
    const op: Operation = { tag: 'Remove', key: keyByte(0x04) }
    expectRejectedWithoutThrowing(
      startingDigest,
      proof,
      DELETE_PATH_CONFIG,
      [op],
      'double-RIGHT promoted sub-root as label',
    )
  })
})

// ---------------------------------------------------------------------------
// Sites 3 + 4 — modify.ts (insert path), promoted grandchild is a LEAF
//
// On the insert path the only subtree that reports `heightDelta === 1` with a
// balance that selects a DOUBLE rotation is `addNode`'s freshly-built split
// node, whose two children are both LEAVES. A well-formed AVL tree can never
// reach the rotation branch from there (it needs the parent to be already
// heavy on the side of a LEAF child, i.e. a sibling subtree of height -1), but
// the verifier's tree is materialised from attacker-chosen proof bytes and the
// balance byte is one of them. Both proofs below are three tokens long.
// ---------------------------------------------------------------------------

const INSERT_PATH_CONFIG: AvlTreeConfig = { keyLength: 1, valueLengthOpt: 1 }

describe('verifier rejects leaves in the promoted-grandchild slot (insert path)', () => {
  /**
   * Site 3 — `modify.ts` `rotateLeftDescent`, double-RIGHT branch.
   * Unguarded operand: `newLeftm.right` (read as `node.left.right` inside
   * `doubleRightRotate`, rotation.ts:117-122).
   *
   * Crafted tree — `I(balance = -1, left = Leaf, right = Label)`:
   *   02 10 20 aa                LEAF   key=0x10 nextLeafKey=0x20 value=0xaa
   *   03 11*32                   LABEL  (32 arbitrary digest bytes)
   *   ff                         INTERNAL, balance byte 0xff = -1
   *   04                         END_OF_TREE
   *   01                         directions bit 0 set -> descend LEFT
   * `startingDigest` is `label(root) || 0x02`, computed over exactly that tree,
   * so proof decoding and the digest check both pass.
   *
   * `Insert(key=0x18, value=0xbb)` lands in the leaf's gap
   * (0x10 < 0x18 < 0x20), so `addNode` splits it into `I(0, Leaf, Leaf)` with
   * `heightDelta = 1`. The root's crafted balance -1 selects the rotation
   * branch, the split node's balance 0 selects the DOUBLE-right rotation, and
   * the promoted sub-root `newLeftm.right` is a freshly-built LEAF.
   *
   * Pre-fix failure (uncaught, out of `verifyAvlBatch`):
   *   TypeError: doubleRightRotate precondition: node.left.right must be
   *   Internal, got leaf
   */
  it('rejects an Insert proof whose double-RIGHT promoted sub-root is a leaf', () => {
    const startingDigest = hexToBytes(
      '96ccb020196496f331ad999eb9e07c65f31c4c8b2b9722266492a6b3614a9a1602',
    )
    const proof = hexToBytes(
      '021020aa' +
        '03' + '11'.repeat(32) +
        'ff' +
        '04' +
        '01',
    )
    const op: Operation = {
      tag: 'Insert',
      key: new Uint8Array([0x18]),
      value: new Uint8Array([0xbb]),
    }
    expectRejectedWithoutThrowing(
      startingDigest,
      proof,
      INSERT_PATH_CONFIG,
      [op],
      'double-RIGHT promoted sub-root as leaf',
    )
  })

  /**
   * Site 4 — `modify.ts` `rotateRightDescent`, double-LEFT branch. Mirror of
   * site 3. Unguarded operand: `newRightm.left` (read as `node.right.left`
   * inside `doubleLeftRotate`, rotation.ts:58-63).
   *
   * Crafted tree — `I(balance = +1, left = Label, right = Leaf)`:
   *   03 22*32                   LABEL  (32 arbitrary digest bytes)
   *   02 10 20 aa                LEAF   key=0x10 nextLeafKey=0x20 value=0xaa
   *   01                         INTERNAL, balance byte 0x01 = +1
   *   04                         END_OF_TREE
   *   00                         directions bit 0 clear -> descend RIGHT
   *
   * Pre-fix failure (uncaught, out of `verifyAvlBatch`):
   *   TypeError: doubleLeftRotate precondition: node.right.left must be
   *   Internal, got leaf
   */
  it('rejects an Insert proof whose double-LEFT promoted sub-root is a leaf', () => {
    const startingDigest = hexToBytes(
      'f0422bf0225488ef15b0c098fd6725d9cdb3b9ee0491c1ec6279f162ae549a2a02',
    )
    const proof = hexToBytes(
      '03' + '22'.repeat(32) +
        '021020aa' +
        '01' +
        '04' +
        '00',
    )
    const op: Operation = {
      tag: 'Insert',
      key: new Uint8Array([0x18]),
      value: new Uint8Array([0xbb]),
    }
    expectRejectedWithoutThrowing(
      startingDigest,
      proof,
      INSERT_PATH_CONFIG,
      [op],
      'double-LEFT promoted sub-root as leaf',
    )
  })
})
