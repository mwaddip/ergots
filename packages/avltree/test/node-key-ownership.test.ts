import { describe, expect, it } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { newInternal, newLeaf } from '../src/node.js'
import type { Operation } from '../src/operation.js'
import { deserializeNode, serializeNode } from '../src/serialize.js'
import type { AvlTreeConfig } from '../src/types.js'
import { verifyAvlBatch } from '../src/verify.js'
import { ViewSlicingBytes } from './helpers/buffer-like.js'

const KL = 32
const CONFIG: AvlTreeConfig = { keyLength: KL, valueLengthOpt: null }

function key(b: number): Uint8Array {
  const k = new Uint8Array(KL)
  k[0] = b
  k[KL - 1] = b
  return k
}

describe('P1 — newInternal owns its key (0.5.0)', () => {
  it('copies the key argument', () => {
    const left = newLeaf(key(1), new Uint8Array([1]), key(2))
    const right = newLeaf(key(2), new Uint8Array([2]), key(3))
    const k = key(2)
    const node = newInternal(left, right, 0, k)
    k.fill(0x77)
    expect(node.key).toEqual(key(2))
  })

  it('leaves a key-less node key-less', () => {
    const left = newLeaf(key(1), new Uint8Array([1]), key(2))
    const right = newLeaf(key(2), new Uint8Array([2]), key(3))
    expect(newInternal(left, right, 0).key).toBeUndefined()
  })

  it("a prover tree does not retain the caller's Insert key buffer", () => {
    const prover = new BatchAVLProver(KL, null)
    const before = prover.digest()
    const scratch = key(0x20)
    const value = new Uint8Array([0xaa])
    expect(prover.performOneOperation({ tag: 'Insert', key: scratch, value }).success).toBe(true)
    scratch.fill(0x25) // the caller reuses its key buffer
    expect(prover.unauthenticatedLookup(key(0x20))).toEqual(value)
    // The recorded path navigates by the same internal key, and its proof must verify.
    expect(prover.performOneOperation({ tag: 'Lookup', key: key(0x20) })).toEqual({ success: true, value })
    const ops: Operation[] = [
      { tag: 'Insert', key: key(0x20), value },
      { tag: 'Lookup', key: key(0x20) },
    ]
    expect(verifyAvlBatch(before, prover.generateProof(), CONFIG, ops)?.newDigest).toEqual(prover.digest())
    const root = prover.root
    if (root.kind !== 'internal') throw new Error('expected an internal root')
    // internal record: 0x00 || balance || key(KL) || leftLabel || rightLabel
    expect(serializeNode(root, CONFIG).subarray(2, 2 + KL)).toEqual(key(0x20))
  })

  it('a decoded internal node does not alias a Buffer-like record', () => {
    const prover = new BatchAVLProver(KL, null)
    prover.performOneOperation({ tag: 'Insert', key: key(0x20), value: new Uint8Array([1]) })
    const root = prover.root
    if (root.kind !== 'internal') throw new Error('expected an internal root')
    const record = new ViewSlicingBytes(serializeNode(root, CONFIG))
    const decoded = deserializeNode(record, CONFIG)
    record.fill(0x55) // the storage layer reuses its read buffer
    if (decoded.kind !== 'internal') throw new Error('expected an internal node')
    expect(decoded.key).toEqual(key(0x20))
  })
})
