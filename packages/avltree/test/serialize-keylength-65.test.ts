import { describe, expect, it } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { label, newLeaf, type AvlNode } from '../src/node.js'
import { deserializeNode, serializeNode } from '../src/serialize.js'
import { randomKey, randomValue, rng } from './helpers/tree-harness.js'

describe('storage codec at keyLength 65', () => {
  for (const vlo of [null, 8]) {
    it(`round-trips every node of a 65-byte-key tree (valueLengthOpt ${vlo})`, () => {
      const r = rng(6565 + (vlo ?? 0))
      const prover = new BatchAVLProver(65, vlo)
      for (let i = 0; i < 60; i++) {
        prover.performOneOperation({ tag: 'InsertOrUpdate', key: randomKey(r, 65), value: randomValue(r, vlo) })
      }
      const config = { keyLength: 65, valueLengthOpt: vlo }
      const stack: AvlNode[] = [prover.root]
      let leaves = 0
      let internals = 0
      while (stack.length > 0) {
        const node = stack.pop()!
        const back = deserializeNode(serializeNode(node, config), config)
        expect(label(back)).toEqual(label(node))
        if (node.kind === 'leaf' && back.kind === 'leaf') {
          leaves++
          expect(back.key).toEqual(node.key)
          expect(back.value).toEqual(node.value)
          expect(back.nextLeafKey).toEqual(node.nextLeafKey)
        } else if (node.kind === 'internal' && back.kind === 'internal') {
          internals++
          expect(back.key).toEqual(node.key)
          expect(back.balance).toBe(node.balance)
          stack.push(node.left, node.right)
        } else {
          throw new Error(`kind changed across the codec: ${node.kind} → ${back.kind}`)
        }
      }
      expect(leaves).toBeGreaterThan(1)
      expect(internals).toBe(leaves - 1)
    })
  }

  it('keeps its length checks at 65', () => {
    const config = { keyLength: 65, valueLengthOpt: null }
    const shortKeyLeaf = newLeaf(new Uint8Array(64).fill(1), new Uint8Array([1]), new Uint8Array(65).fill(2))
    expect(() => serializeNode(shortKeyLeaf, config)).toThrow(RangeError)
    expect(() => deserializeNode(new Uint8Array(1 + 65), config)).toThrow(RangeError)
  })
})
