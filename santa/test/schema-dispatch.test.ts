import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runDocument, runVector, runEntry } from '../src/runner'

const here = path.dirname(fileURLToPath(import.meta.url))

// The tier-neutral actual (runner-integration §3): every tier's actuals schema admits it, and it carries no other key.
const NOT_IMPLEMENTED = { error: 'not-implemented' }

// decodePoint over the generator: the santa-eval/v1 arm answers a GroupElement at cost 305.
const GENERATOR = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const evalEntry = (name: string) =>
  ({ name, tree_bytes_hex: `00ee0e21${GENERATOR}`, version: { activated: 3, ergoTree: 0 } })
// An UnsignedBigInt constant: the santa-wire/v1 arm writes the same bytes back.
const wireEntry = { name: 'c', kind: 'Constant', bytes_hex: '090105', version: { activated: 3, ergoTree: 3 } }

describe('a vector whose schema the runner does not know: every entry is not-implemented', () => {
  it('a later version of the eval schema, with entries the santa-eval/v1 arm evaluates', () => {
    const actuals = runDocument({ schema: 'santa-eval/v99', entries: [evalEntry('g'), evalEntry('h')] })
    expect(actuals).toStrictEqual({ g: NOT_IMPLEMENTED, h: NOT_IMPLEMENTED })
  })

  it('a later version of the wire schema, with an entry the santa-wire/v1 arm writes back', () => {
    const actuals = runDocument({ schema: 'santa-wire/v2', entries: [wireEntry] })
    expect(actuals).toStrictEqual({ c: NOT_IMPLEMENTED })
  })

  it('a tier the runner does not mount, with an entry the eval arm evaluates', () => {
    const actuals = runDocument({ schema: 'santa-block/v1', entries: [evalEntry('g')] })
    expect(actuals).toStrictEqual({ g: NOT_IMPLEMENTED })
  })

  it('a tier the runner does not mount, with an entry that holds no tree', () => {
    const actuals = runDocument({ schema: 'santa-block/v1', entries: [{ name: 'b', block: {} }] })
    expect(actuals).toStrictEqual({ b: NOT_IMPLEMENTED })
  })

  it('no schema', () => {
    const actuals = runDocument({ entries: [evalEntry('g')] })
    expect(actuals).toStrictEqual({ g: NOT_IMPLEMENTED })
  })

  it('runVector: no schema', () => {
    const doc = { entries: [evalEntry('g')] } as unknown as Parameters<typeof runVector>[0]
    expect(runVector(doc)).toStrictEqual({ g: NOT_IMPLEMENTED })
  })

  it('runVector: a schema of another tier', () => {
    expect(runVector({ schema: 'santa-wire/v1', entries: [evalEntry('g')] })).toStrictEqual({ g: NOT_IMPLEMENTED })
  })

  it('runEntry: a schema other than the six eval schemas', () => {
    expect(runEntry('santa-eval/v99', evalEntry('g'))).toStrictEqual(NOT_IMPLEMENTED)
  })
})

describe('a vector whose schema the runner knows runs on that schema\'s arm', () => {
  it('santa-eval/v1', () => {
    const actuals = runDocument({ schema: 'santa-eval/v1', entries: [evalEntry('g')] })
    expect(actuals).toStrictEqual({ g: { value: { kind: 'GroupElement', bytes_hex: GENERATOR }, cost: 305, error: null } })
  })

  it('santa-eval/v2 through santa-eval/v5 and santa-eval/v6-fullctx reach the eval arm', () => {
    // Each of these schemas requires a context field the entry lacks: the eval arm's answer is `panicked`,
    // its note naming the field.
    for (const schema of ['santa-eval/v2', 'santa-eval/v3', 'santa-eval/v4', 'santa-eval/v5', 'santa-eval/v6-fullctx']) {
      const actuals = runDocument({ schema, entries: [evalEntry('g')] }) as Record<string, { error: string; note: string }>
      expect(actuals.g.error, schema).toBe('panicked')
      expect(actuals.g.note, schema).toMatch(/^Error: missing /)
    }
  })

  it('santa-wire/v1', () => {
    const actuals = runDocument({ schema: 'santa-wire/v1', entries: [wireEntry] })
    expect(actuals).toStrictEqual({ c: { bytes_hex: '090105', error: null } })
  })

  it('santa-transaction/v1', () => {
    const doc = JSON.parse(readFileSync(
      path.resolve(here, 'fixtures/transaction/v6/captured/bigint-downcast-2666.json'), 'utf8'))
    const entries = doc.entries as { name: string; expected: { cost: number } }[]
    const actuals = runDocument(doc)
    expect(actuals).toStrictEqual(
      Object.fromEntries(entries.map((e) => [e.name, { valid: true, cost: e.expected.cost, error: null }])))
  })

  it('santa-nipopow/v1', () => {
    const doc = JSON.parse(readFileSync(
      path.resolve(here, 'fixtures/nipopow/any/authored/NipopowProve.jvm-chain-32.json'), 'utf8'))
    const chain = doc.chain as { interlinks: string[] }[]
    const actuals = runDocument(doc) as Record<string, unknown>
    expect(actuals.interlinks).toStrictEqual({ interlinks: chain.map((c) => c.interlinks), error: null })
  })

  it('santa-authds/v1', () => {
    const entry = {
      name: 'p',
      kind: 'avl_prove',
      settings: { key_length: 32, value_length: null },
      payload: { operations: [{ tag: 'Lookup', key_hex: '04'.repeat(32) }], gen_proof_after: [] },
    }
    const actuals = runDocument({ schema: 'santa-authds/v1', entries: [entry] })
    expect(actuals).toStrictEqual({ p: { proofs: [], digests: [], error: null } })
  })
})
