import { describe, expect, it } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { label, newInternal, newLabel, newLeaf, type AvlNode } from '../src/node.js'
import { deserializeNode, serializeNode } from '../src/serialize.js'
import { randomKey, randomValue, rng } from './helpers/tree-harness.js'

describe('storage codec at keyLength 65', () => {
  for (const vlo of [null, 8]) {
    it(`round-trips every node of a 65-byte-key tree (valueLengthOpt ${vlo})`, () => {
      const r = rng(6565 + (vlo ?? 0))
      const prover = new BatchAVLProver(65, vlo)
      for (let i = 0; i < 60; i++) {
        expect(
          prover.performOneOperation({ tag: 'InsertOrUpdate', key: randomKey(r, 65), value: randomValue(r, vlo) }).success,
        ).toBe(true)
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
      expect(leaves).toBe(61)
      expect(internals).toBe(leaves - 1)
    })
  }

  describe('length checks at 65', () => {
    const config = { keyLength: 65, valueLengthOpt: null as number | null }
    const k64 = new Uint8Array(64).fill(1)
    const k65 = new Uint8Array(65).fill(2)
    const v = new Uint8Array([1, 2, 3])

    it('encode: a key, or a nextLeafKey, one byte short is refused', () => {
      expect(() => serializeNode(newLeaf(k64, v, k65), config)).toThrow(/key length 64/)
      expect(() => serializeNode(newLeaf(k65, v, k64), config)).toThrow(/nextLeafKey length 64/)
      const internal = newInternal(newLabel(new Uint8Array(32)), newLabel(new Uint8Array(32)), 0, k64)
      expect(() => serializeNode(internal, config)).toThrow(/key length 64/)
    })

    it('decode: a leaf record one byte short of its last field is refused as truncated', () => {
      const leaf = serializeNode(newLeaf(k65, v, k65), config)
      expect(leaf.length).toBe(1 + 65 + 4 + 3 + 65)
      expect(() => deserializeNode(leaf.subarray(0, leaf.length - 1), config)).toThrow(/truncated .* nextLeafKey/)
      expect(() => deserializeNode(leaf.subarray(0, 1 + 64), config)).toThrow(/truncated .* key/)
    })

    it('decode: an internal record one byte short of its last field is refused as truncated', () => {
      const internal = serializeNode(newInternal(newLabel(new Uint8Array(32)), newLabel(new Uint8Array(32)), 0, k65), config)
      expect(internal.length).toBe(1 + 1 + 65 + 64)
      expect(() => deserializeNode(internal.subarray(0, internal.length - 1), config)).toThrow(/truncated .* rightLabel/)
      expect(() => deserializeNode(internal.subarray(0, 1 + 1 + 64), config)).toThrow(/truncated .* key/)
    })

    it('a record shaped for 32-byte keys is not a record at 65', () => {
      const asInternal32 = new Uint8Array(1 + 1 + 32 + 64) // tag 0
      expect(() => deserializeNode(asInternal32, config)).toThrow(/truncated/)
      const asLeaf32 = new Uint8Array(1 + 32 + 4 + 0 + 32) // tag 1, variable values
      asLeaf32[0] = 0x01
      expect(() => deserializeNode(asLeaf32, config)).toThrow(/truncated/)
    })
  })
})
