import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runTransactionVector } from '../src/runner'

const here = path.dirname(fileURLToPath(import.meta.url))
// Typed as runTransactionVector's own parameter (TxVector) so the bytes-anchored TxEntry shape
// (tx_bytes_hex + box/header hex) is enforced — the test loads a real captured vector.
const loadVector = (rel: string): Parameters<typeof runTransactionVector>[0] =>
  JSON.parse(readFileSync(path.resolve(here, 'fixtures/transaction', rel), 'utf8'))

describe('runTransactionVector — santa-transaction/v1 (bytes-anchored tx arm)', () => {
  it('keystone seed bigint-downcast-2666: the tx arm accepts it at the JVM-blessed cost (a JVM-accepted captured tx)', () => {
    // The tx arm runs @ergots/transaction's validateStateful and returns a verdict per entry.
    const vec = loadVector('v6/captured/bigint-downcast-2666.json')
    const actuals = runTransactionVector(vec)
    // totality: one outcome per entry, keyed by name, none omitted
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    // dasher claims the cost dimension (runner.json cost:true): an accepted spend reports
    // validateStateful's block cost, which a cost:true runner may not leave null (contract §4).
    const expected = vec.entries as unknown as { expected: { cost: number } }[]
    vec.entries.forEach((e, i) => {
      expect(actuals[e.name]).toEqual({ valid: true, cost: expected[i].expected.cost, error: null })
    })
  })
})
