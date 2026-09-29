import { describe, expect, it } from 'vitest'
import type { Operation } from '../src/operation.js'
import { KEY_LENGTHS, randomTree, rng, successfulBatch } from './helpers/tree-harness.js'
import { keyOf, sevenKeyProver } from './helpers/tree-surgery.js'

const SEEDS = 12

describe('a proof built step by step equals one built in one go', () => {
  const cases: { kl: number; vlo: number | null }[] = [
    ...KEY_LENGTHS.map((kl) => ({ kl, vlo: null })),
    { kl: 65, vlo: 8 },
  ]
  for (const { kl, vlo } of cases) {
    it(`keyLength ${kl}, valueLengthOpt ${vlo}`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = rng(seed * 31337 + kl + (vlo ?? 0))
        const { prover, model } = randomTree(r, kl, vlo)
        const batch = successfulBatch(r, model, 40, vlo)
        const oneGo = prover.generateProofForOperations(batch.ops)
        if (!oneGo.success) throw new Error(`seed ${seed}: the harness batch failed`)
        batch.ops.forEach((op, i) => {
          expect(prover.performOneOperation(op).success, `seed ${seed} op ${i} ${op.tag}`).toBe(true)
        })
        expect(prover.generateProof(), `seed ${seed}`).toEqual(oneGo.proof)
        expect(prover.digest(), `seed ${seed}`).toEqual(oneGo.digest)
      }
    })
  }

  it('with operations pending in the cycle, the two routes differ (documented precondition)', () => {
    const prover = sevenKeyProver()
    const pending: Operation = { tag: 'Lookup', key: keyOf(20) }
    const ops: Operation[] = [{ tag: 'Lookup', key: keyOf(60) }]
    expect(prover.performOneOperation(pending).success).toBe(true)
    const oneGo = prover.generateProofForOperations(ops)
    if (!oneGo.success) throw new Error('lookup failed')
    expect(prover.performOneOperation(ops[0]!).success).toBe(true)
    expect(prover.generateProof()).not.toEqual(oneGo.proof)
  })
})
