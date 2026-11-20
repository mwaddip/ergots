import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runNipopowEntry, runNipopowVector } from '../src/runner'

const here = path.dirname(fileURLToPath(import.meta.url))

// A 32-header chain the JVM mined under its fake proof-of-work scheme, with each header's blessed interlinks and
// four blessed proofs (runner-contract-nipopow §5).
type ChainItem = { height: number; headerHex: string; interlinks: string[] }
type ProveEntry = { name: string; kind: string; payload: { m: number; k: number; headerId: string | null }; expected: { proofHex: string } }
const doc = JSON.parse(readFileSync(
  path.resolve(here, 'fixtures/nipopow/any/authored/NipopowProve.jvm-chain-32.json'), 'utf8')) as
  { schema: string; chain: ChainItem[]; entries: ProveEntry[] }
const proveEntries = doc.entries.filter((e) => e.kind === 'nipopow_prove')

describe('santa-nipopow/v1 adapter', () => {
  it('runNipopowVector answers every entry, keyed by name', () => {
    expect(Object.keys(runNipopowVector(doc))).toEqual(doc.entries.map((e) => e.name))
  })

  it('nipopow_interlinks: one interlinks vector per chain header, each the blessed one', () => {
    const actual = runNipopowEntry({ name: 'interlinks', kind: 'nipopow_interlinks' }, doc.chain)
    expect(actual).toStrictEqual({ interlinks: doc.chain.map((c) => c.interlinks), error: null })
  })

  it('nipopow_interlinks: the first header\'s vector is its own id', () => {
    const actual = runNipopowEntry({ name: 'interlinks', kind: 'nipopow_interlinks' }, doc.chain.slice(0, 1))
    expect(actual).toStrictEqual({ interlinks: [doc.chain[0].interlinks], error: null })
  })

  for (const e of proveEntries.filter((p) => p.payload.headerId === null)) {
    it(`nipopow_prove ${e.name}: the proof over the whole chain is the blessed bytes`, () => {
      expect(runNipopowEntry(e, doc.chain)).toStrictEqual({ proofHex: e.expected.proofHex, error: null })
    })
  }

  for (const e of proveEntries.filter((p) => p.payload.headerId !== null)) {
    it(`nipopow_prove ${e.name}: the proof over the chain cut k headers past the anchor is the blessed bytes`, () => {
      expect(runNipopowEntry(e, doc.chain)).toStrictEqual({ proofHex: e.expected.proofHex, error: null })
    })
  }
})

describe('santa-nipopow/v1 adapter: outcome classification', () => {
  it('a chain shorter than m + k is `errored` (the prover\'s typed refusal)', () => {
    const entry = { name: 'short', kind: 'nipopow_prove', payload: { m: 20, k: 20, headerId: null } }
    expect(runNipopowEntry(entry, doc.chain)).toStrictEqual({ proofHex: null, error: 'errored' })
  })

  it('header bytes the header reader refuses are `errored`', () => {
    const cut = [{ ...doc.chain[0], headerHex: doc.chain[0].headerHex.slice(0, 40) }]
    expect(runNipopowEntry({ name: 'i', kind: 'nipopow_interlinks' }, cut))
      .toStrictEqual({ interlinks: null, error: 'errored' })
  })

  it('an anchor id the chain does not hold is `panicked`, with a note', () => {
    const entry = { name: 'lost', kind: 'nipopow_prove', payload: { m: 2, k: 2, headerId: 'ab'.repeat(32) } }
    const actual = runNipopowEntry(entry, doc.chain)
    expect(actual.error).toBe('panicked')
    expect(actual.note).toMatch(/abababab/)
  })

  it('an unknown kind is `not-implemented`', () => {
    expect(runNipopowEntry({ name: 'v', kind: 'nipopow_verify' }, doc.chain)).toStrictEqual({ error: 'not-implemented' })
  })
})
