import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BatchAVLProver } from '../src/batch-prover.js'
import { label } from '../src/node.js'
import type { Operation } from '../src/index.js'

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

interface VectorOp { tag: string; keyHex: string; valueHex?: string; delta?: number }
interface Vector {
  name: string
  config: { keyLength: number; valueLengthOpt: number | null }
  cycles: Array<{
    ops: VectorOp[]
    expectFailIdx: number[]
    rollbackToCycleStart: boolean
    removedLabelsHex: string[]
    digestHex: string
  }>
}

const toOperation = (op: VectorOp): Operation => {
  const key = hexToBytes(op.keyHex)
  switch (op.tag) {
    case 'Insert': return { tag: 'Insert', key, value: hexToBytes(op.valueHex!) }
    case 'Update': return { tag: 'Update', key, value: hexToBytes(op.valueHex!) }
    case 'UpdateLongBy': return { tag: 'UpdateLongBy', key, delta: BigInt(op.delta!) }
    case 'Remove': return { tag: 'Remove', key }
    case 'Lookup': return { tag: 'Lookup', key }
    default: throw new Error(`vector op tag not handled: ${op.tag}`)
  }
}

const removedLabelsSorted = (p: BatchAVLProver): string[] =>
  p.removedNodes().map((n) => bytesToHex(label(n))).sort()

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'removed-nodes')

describe('removedNodes() conformance vectors', () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))
  it('has all 7 vectors', () => {
    expect(files.length).toBe(7)
  })
  for (const file of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
    it(`matches Rust: ${file}`, () => {
      const vec: Vector = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'))
      const prover = new BatchAVLProver(vec.config.keyLength, vec.config.valueLengthOpt)
      for (const cycle of vec.cycles) {
        const savedRoot = prover.root
        const savedHeight = prover.height
        cycle.ops.forEach((vop, i) => {
          const result = prover.performOneOperation(toOperation(vop))
          expect(result.success).toBe(!cycle.expectFailIdx.includes(i))
        })
        if (cycle.rollbackToCycleStart) prover.restoreRoot(savedRoot, savedHeight)
        expect(removedLabelsSorted(prover)).toEqual([...cycle.removedLabelsHex].sort())
        expect(bytesToHex(prover.digest())).toBe(cycle.digestHex)
        prover.generateProof()
      }
    })
  }
})

describe('removedNodes() unit behavior', () => {
  const k = (n: number) => { const a = new Uint8Array(32); a[0] = 1; a[31] = n; return a }
  const v = (n: number) => { const a = new Uint8Array(8); a[7] = n; return a }
  const ins = (n: number): Operation => ({ tag: 'Insert', key: k(n), value: v(n) })

  it('[] before any operation', () => {
    expect(new BatchAVLProver(32, 8).removedNodes()).toEqual([])
  })

  it('first mutating cycle reports exactly the sentinel leaf (reference parity)', () => {
    const p = new BatchAVLProver(32, 8)
    const sentinelLabel = bytesToHex(label(p.root))
    expect(p.performOneOperation(ins(1)).success).toBe(true)
    expect(removedLabelsSorted(p)).toEqual([sentinelLabel])
  })

  it('[] after generateProof(), [] after restoreRoot()', () => {
    const p = new BatchAVLProver(32, 8)
    expect(p.performOneOperation(ins(1)).success).toBe(true)
    p.generateProof()
    expect(p.removedNodes()).toEqual([])
    expect(p.performOneOperation(ins(2)).success).toBe(true)
    p.restoreRoot(p.root, p.height)
    expect(p.removedNodes()).toEqual([])
  })

  it('idempotent: two consecutive calls return the same set', () => {
    const p = new BatchAVLProver(32, 8)
    expect(p.performOneOperation(ins(1)).success).toBe(true)
    expect(p.performOneOperation(ins(2)).success).toBe(true)
    expect(removedLabelsSorted(p)).toEqual(removedLabelsSorted(p))
  })

  it('mid-batch calls are pure: probed and unprobed provers agree', () => {
    const probed = new BatchAVLProver(32, 8)
    const clean = new BatchAVLProver(32, 8)
    for (const p of [probed, clean]) expect(p.performOneOperation(ins(1)).success).toBe(true)
    probed.removedNodes() // mid-batch probe
    for (const p of [probed, clean]) expect(p.performOneOperation(ins(2)).success).toBe(true)
    expect(removedLabelsSorted(probed)).toEqual(removedLabelsSorted(clean))
  })

  it('divergence row 2 pin: remove-then-reinsert of an identical leaf is NOT reported', () => {
    const p = new BatchAVLProver(32, 8)
    expect(p.performOneOperation(ins(1)).success).toBe(true)
    expect(p.performOneOperation(ins(2)).success).toBe(true)
    p.generateProof() // cycle boundary: persisted baseline
    // Cycle 2: remove then reinsert the max leaf — every label is restored,
    // so the exact set difference (and therefore removedNodes) is EMPTY.
    // The reference's definite buffer reports the old objects here (its
    // consumer needed a written-labels overlap guard; see spec div. row 2).
    expect(p.performOneOperation({ tag: 'Remove', key: k(2) }).success).toBe(true)
    expect(p.performOneOperation(ins(2)).success).toBe(true)
    expect(p.removedNodes()).toEqual([])
  })

  it('lookup-only cycle reports []', () => {
    const p = new BatchAVLProver(32, 8)
    expect(p.performOneOperation(ins(1)).success).toBe(true)
    p.generateProof()
    expect(p.performOneOperation({ tag: 'Lookup', key: k(1) }).success).toBe(true)
    expect(p.removedNodes()).toEqual([])
  })

  it('failed op contributes nothing (precondition failure leaves the diff unchanged)', () => {
    const p = new BatchAVLProver(32, 8)
    expect(p.performOneOperation(ins(1)).success).toBe(true)
    p.generateProof()
    const before = removedLabelsSorted(p)
    expect(p.performOneOperation(ins(1)).success).toBe(false) // Insert on existing key
    expect(removedLabelsSorted(p)).toEqual(before)
  })
})
