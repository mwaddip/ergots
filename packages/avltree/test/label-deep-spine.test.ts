/**
 * Deep-spine stack-mechanics regression for `label()`.
 *
 * Ports the reference's `b785d0d` fix verification: `Node::label`'s Internal
 * arm must label its children iteratively (via `Node::label_subtree`,
 * `batch_node.rs:130-157 @568e7c3`, called at `:108-109`), not by recursing
 * into them directly — a verifier's tree comes from proof bytes, so a
 * crafted deep spine must cost heap, not stack.
 *
 * PRE-fix, `label(root)` on a 200,000-level left-deep spine threw
 * `RangeError: Maximum call stack size exceeded` before producing any hash
 * (captured RED evidence: see task-report.md for this task). POST-fix it
 * completes in both the `node` and `jsdom` runtimes.
 *
 * @see packages/avltree/src/node.ts — `label`, `labelSubtree`, `cachedLabel`
 * @see docs/superpowers/specs/2026-08-04-avltree-label-iterative-design.md
 */
import { describe, expect, it } from 'vitest'
import { label, newInternal, newLeaf } from '../src/node.js'
import type { AvlNode } from '../src/node.js'

/**
 * Depth of the hand-built left-deep spine below. 200,000 levels is well
 * within both runtimes' heap budget (tens of MB + ~200k blake2b hashes of
 * <=67-byte inputs) yet far beyond either runtime's default native call
 * stack (measured overflow between depth 1e3 and 1e4 under plain Node —
 * see verifier-adversarial-recursion.test.ts).
 */
const DEPTH = 200_000

/**
 * Hand-builds a left-deep chain of `depth` internal nodes over a base leaf:
 * each level's LEFT child is the chain built so far, and RIGHT child is a
 * fresh leaf — `newInternal(chain, rightLeaf_i, 0, key)` in a loop, per the
 * design spec. Balance is fixed at 0 and keys/values are arbitrary content:
 * `label()` reads balance and child labels only; it does not validate AVL
 * shape, key ordering, or leaf chaining, so this degenerate (non-AVL-shaped)
 * tree is a valid input to it.
 */
function buildDeepSpine(depth: number): AvlNode {
  let chain: AvlNode = newLeaf(
    new Uint8Array([0x00]),
    new Uint8Array([0x00]),
    new Uint8Array([0xff]),
  )
  for (let i = 0; i < depth; i += 1) {
    const rightLeaf = newLeaf(
      new Uint8Array([0x01]),
      new Uint8Array([0x02]),
      new Uint8Array([0xff]),
    )
    chain = newInternal(chain, rightLeaf, 0, new Uint8Array([0x01]))
  }
  return chain
}

describe('label — deep-spine stack mechanics', () => {
  it('labels a 200,000-level left-deep spine without overflowing the call stack', () => {
    const root = buildDeepSpine(DEPTH)

    const lbl1 = label(root)
    expect(lbl1.length).toBe(32)

    // Second call: cache hit at the root. Confirms idempotent byte content
    // (fresh defensive slice each call, same underlying bytes) — mirrors
    // node-label.test.ts's existing caching assertions.
    const lbl2 = label(root)
    expect(lbl2.length).toBe(32)
    expect(Array.from(lbl2)).toEqual(Array.from(lbl1))
  })
})
