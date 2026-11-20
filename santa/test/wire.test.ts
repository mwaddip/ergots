import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runWireEntry, runWireVector } from '../src/runner'

const here = path.dirname(fileURLToPath(import.meta.url))
const loadVector = (
  rel: string,
): { schema: string; entries: { name: string; kind: string; bytes_hex: string; expected_bytes_hex?: string; error?: string; version: { activated: number; ergoTree: number } }[] } =>
  JSON.parse(readFileSync(path.resolve(here, '../../vectors/wire', rel), 'utf8'))

describe('runWireVector — wire round-trip (santa-wire/v1)', () => {
  it('Box: every entry round-trips to its own canonical bytes (public parseSValue/serializeSValue(SBox))', async () => {
    const vec = loadVector('v5/vendored/Box.json')
    const actuals = await runWireVector(vec)
    // totality: one outcome per entry, keyed by name, none omitted
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: e.bytes_hex, error: null })
    }
  })

  it('SigmaBoolean: every entry round-trips to its own canonical bytes (public parseSigmaBoolean/serializeSigmaBoolean)', async () => {
    const vec = loadVector('v5/vendored/SigmaBoolean.json')
    const actuals = await runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: e.bytes_hex, error: null })
    }
  })

  it('Constant: every entry round-trips to its own canonical bytes (public parseSType+parseSValue / serializeSType+serializeSValue)', async () => {
    const vec = loadVector('v5/vendored/Constant.json')
    const actuals = await runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: e.bytes_hex, error: null })
    }
  })

  it('Transaction: every entry round-trips to its own canonical bytes (public @ergots/transaction parseTransaction/serializeTransaction)', async () => {
    // Was not-implemented until ergots shipped @ergots/transaction; dasher now threads the
    // lazily-loaded tx codec into the wire path and round-trips the Transaction kind.
    const vec = loadVector('v5/vendored/Transaction.json')
    const actuals = await runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: e.bytes_hex, error: null })
    }
  })

  it('ErgoTree (STypeVar names): round-trips to the JVM-canonical lossy bytes — ergots master adopted the U+FFFD collapse', async () => {
    const vec = loadVector('v6/authored/STypeVar.name_utf8_roundtrip.json')
    const actuals = await runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    // ergots master now lossy-decodes the ill-formed type-var names (the JVM's U+FFFD collapse) and
    // re-serializes the structural tree, so each entry round-trips to its blessed JVM-canonical output
    // (expected_bytes_hex, non-identity) — converged, no longer the panicked classification gap.
    for (const e of vec.entries) {
      expect(actuals[e.name].error).toBeNull()
      expect(actuals[e.name].bytes_hex).toBe(e.expected_bytes_hex ?? e.bytes_hex)
    }
  })

  it('Box (degrade gate): every reject is a typed codec rejection, errored — none panics', async () => {
    // ergots refuses these trees with typed errors (ExprParseError, STypeParseError, SigmaBooleanParseError,
    // SValueParseError), the same ones the Transaction arm already maps to `errored`. The Box arm used to map only
    // the SValue errors, so 7 of the 11 rejects landed in the panic net.
    const vec = loadVector('v6/authored/Box.tree_degrade_gate.json')
    const actuals = await runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name].error, e.name).not.toBe('panicked')
      if (e.error === 'errored') expect(actuals[e.name], e.name).toEqual({ bytes_hex: null, error: 'errored' })
    }
  })

  it('Constant and SigmaBoolean: a typed codec rejection grades errored, not panicked', () => {
    const v6 = { activated: 3, ergoTree: 3 }
    // type code 0: STypeParseError; ProveDlog (cd) with no group element: the reader runs out
    expect(runWireEntry({ name: 'c', kind: 'Constant', bytes_hex: '00', version: v6 }))
      .toEqual({ bytes_hex: null, error: 'errored' })
    expect(runWireEntry({ name: 's', kind: 'SigmaBoolean', bytes_hex: 'cd', version: v6 }))
      .toEqual({ bytes_hex: null, error: 'errored' })
  })

  it('Constant: the type is read under the entry\'s tree version (rule 1017: UnsignedBigInt, code 9, only from v3)', () => {
    // The JVM reads a bare Constant under withVersions(activated, ergoTree) (WireCanonicalize), and
    // TypeSerializer gates code 9 on isV3OrLaterErgoTreeVersion. A read with no version took every
    // v3 gate as closed, so a v6-only type was refused for the runner's reason.
    expect(runWireEntry({ name: 'v3', kind: 'Constant', bytes_hex: '090105', version: { activated: 3, ergoTree: 3 } }))
      .toEqual({ bytes_hex: '090105', error: null })
    expect(runWireEntry({ name: 'v2', kind: 'Constant', bytes_hex: '090105', version: { activated: 3, ergoTree: 2 } }))
      .toEqual({ bytes_hex: null, error: 'errored' })
  })

  it('an ExprTpeError is a typed rejection, matched by name (ergots master does not export the class)', () => {
    // ergots' sized-tree work lets ExprTpeError propagate as a hard reject (a node the JVM refuses to build). A stub tx
    // codec throws one, so the classification is tested without depending on which ergots paths raise it.
    const err = Object.assign(new Error('Apply.func has tpe SInt, expected SFunc'), { name: 'ExprTpeError' })
    const tx = { parseTransaction: () => { throw err }, serializeTransaction: () => new Uint8Array() }
    expect(runWireEntry({ name: 'x', kind: 'Transaction', bytes_hex: '00', version: { activated: 3, ergoTree: 3 } }, tx))
      .toEqual({ bytes_hex: null, error: 'errored' })
  })

  it('ErgoTree (SHeader-constant reject): a typed codec rejection grades errored, not panicked', async () => {
    // The (b) reject vector: a size-flagged tree with a segregated SHeader constant the JVM rejects.
    // ergots throws a typed SValueParseError parsing the constant; isWireCodecError maps it to `errored`
    // (a faithful reject), NOT the panic-net. Guards the typed-codec-error classification.
    const vec = loadVector('v6/authored/ErgoTree.unparsed_soft_fork_header_constant.json')
    const actuals = await runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: null, error: 'errored' })
    }
  })
})

describe('runWireVector — a type-variable name past 255 bytes of text (writer count range)', () => {
  // ergots refuses to write such a name with its typed STypeSerializeError (root-exported, like the SValue and
  // ErgoTree serialize errors already in isWireCodecError): a faithful reject, `errored`, never the panic net.
  for (const rel of ['v5/authored/ErgoTree.type_var_name_write_range.json',
    'v6/authored/ErgoTree.type_var_name_write_range.json',
    'v6/authored/Transaction.type_var_name_write_range.json']) {
    it(`${rel}: refusals errored, controls written back, none panics`, async () => {
      const vec = loadVector(rel)
      const actuals = await runWireVector(vec)
      expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
      for (const e of vec.entries) {
        if (e.error === 'errored') expect(actuals[e.name], e.name).toEqual({ bytes_hex: null, error: 'errored' })
        else expect(actuals[e.name], e.name).toEqual({ bytes_hex: e.expected_bytes_hex ?? e.bytes_hex, error: null })
      }
    })
  }
})
