import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runWireEntry, runWireVector } from '../src/runner'

const here = path.dirname(fileURLToPath(import.meta.url))
const loadVector = (
  rel: string,
): { schema: string; entries: { name: string; kind: string; bytes_hex: string; expected_bytes_hex?: string; error?: string; version: { activated: number; ergoTree: number } }[] } =>
  JSON.parse(readFileSync(path.resolve(here, 'fixtures/wire', rel), 'utf8'))

describe('runWireVector — wire round-trip (santa-wire/v1)', () => {
  it('Box: every entry round-trips to its own canonical bytes (public parseSValue/serializeSValue(SBox))', () => {
    const vec = loadVector('v5/vendored/Box.json')
    const actuals = runWireVector(vec)
    // totality: one outcome per entry, keyed by name, none omitted
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: e.bytes_hex, error: null })
    }
  })

  it('SigmaBoolean: every entry round-trips to its own canonical bytes (public parseSigmaBoolean/serializeSigmaBoolean)', () => {
    const vec = loadVector('v5/vendored/SigmaBoolean.json')
    const actuals = runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: e.bytes_hex, error: null })
    }
  })

  it('Constant: every entry round-trips to its own canonical bytes (public parseSType+parseSValue / serializeSType+serializeSValue)', () => {
    const vec = loadVector('v5/vendored/Constant.json')
    const actuals = runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: e.bytes_hex, error: null })
    }
  })

  it('Transaction: every entry round-trips to its own canonical bytes (public @ergots/transaction parseTransaction/serializeTransaction)', () => {
    // The Transaction kind round-trips through @ergots/transaction's codec.
    const vec = loadVector('v5/vendored/Transaction.json')
    const actuals = runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: e.bytes_hex, error: null })
    }
  })

  it('ErgoTree (STypeVar names): round-trips to the JVM-canonical lossy bytes — ergots master adopted the U+FFFD collapse', () => {
    const vec = loadVector('v6/authored/STypeVar.name_utf8_roundtrip.json')
    const actuals = runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    // ergots master now lossy-decodes the ill-formed type-var names (the JVM's U+FFFD collapse) and
    // re-serializes the structural tree, so each entry round-trips to its blessed JVM-canonical output
    // (expected_bytes_hex, non-identity) — converged, no longer the panicked classification gap.
    for (const e of vec.entries) {
      expect(actuals[e.name].error).toBeNull()
      expect(actuals[e.name].bytes_hex).toBe(e.expected_bytes_hex ?? e.bytes_hex)
    }
  })

  it('Box (degrade gate): every reject is a typed codec rejection, errored — none panics', () => {
    // ergots refuses these trees with typed errors (ExprParseError, STypeParseError, SigmaBooleanParseError,
    // SValueParseError), the same ones the Transaction arm already maps to `errored`. The Box arm used to map only
    // the SValue errors, so 7 of the 11 rejects landed in the panic net.
    const vec = loadVector('v6/authored/Box.tree_degrade_gate.json')
    const actuals = runWireVector(vec)
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

  it('Box, Constant, ErgoTree: the entry\'s activated version reaches the reader (a v4 tree above activated 3 errors, under 4 round-trips)', () => {
    // A bare box whose size-flagged tree is v4, SigmaProp(true) (0c 02 08 d3). Under activated 3,
    // the JVM compares a tree's version with the activated version (ErgoTreeSerializer.scala:150-154,
    // VersionContext.scala:20), and rejects. Under activated 4, the pair holds and the box round-trips.
    const boxHex = 'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'
    expect(runWireEntry({ name: 'box-v4-at-3', kind: 'Box', bytes_hex: boxHex, version: { activated: 3, ergoTree: 3 } }))
      .toEqual({ bytes_hex: null, error: 'errored' })
    expect(runWireEntry({ name: 'box-v4-at-4', kind: 'Box', bytes_hex: boxHex, version: { activated: 4, ergoTree: 4 } }))
      .toEqual({ bytes_hex: boxHex, error: null })

    // A Constant whose value is a Box with a v4 tree (type 63 = SBox, then the Box's own bytes:
    // value c0843d, tree 0c0208d3, creation_height 01, tokens 00, registers 00, tx_id 32×00, index 00).
    const constHex = '63c0843d0c0208d3010000000000000000000000000000000000000000000000000000000000000000000000'
    expect(runWireEntry({ name: 'const-box-v4-at-3', kind: 'Constant', bytes_hex: constHex, version: { activated: 3, ergoTree: 3 } }))
      .toEqual({ bytes_hex: null, error: 'errored' })
    expect(runWireEntry({ name: 'const-box-v4-at-4', kind: 'Constant', bytes_hex: constHex, version: { activated: 4, ergoTree: 4 } }))
      .toEqual({ bytes_hex: constHex, error: null })

    // A size-flagged v4 ErgoTree, SigmaProp(true).
    const treeHex = '0c0208d3'
    expect(runWireEntry({ name: 'tree-v4-at-3', kind: 'ErgoTree', bytes_hex: treeHex, version: { activated: 3, ergoTree: 3 } }))
      .toEqual({ bytes_hex: null, error: 'errored' })
    expect(runWireEntry({ name: 'tree-v4-at-4', kind: 'ErgoTree', bytes_hex: treeHex, version: { activated: 4, ergoTree: 4 } }))
      .toEqual({ bytes_hex: treeHex, error: null })

    // A one-input, one-output Transaction whose output's size-flagged tree is v4, SigmaProp(true)
    // (SANTA v6 Transaction.tree_version_above_activated entry #0 bytes, inlined). Under (3, 3) the
    // output tree's version is above the activated version: parseTransaction rejects, the arm maps it
    // to `errored`. Under (4, 4) the pair holds. A v3 tree under (2, 2) rejects as the v5 file's
    // entry #0 does (`transaction-tree-v3-reject#0`, SANTA 8885632).
    const v4TxHex = '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0c0208d3010000'
    expect(runWireEntry({ name: 'tx-v4-tree-at-3', kind: 'Transaction', bytes_hex: v4TxHex, version: { activated: 3, ergoTree: 3 } }))
      .toEqual({ bytes_hex: null, error: 'errored' })
    expect(runWireEntry({ name: 'tx-v4-tree-at-4', kind: 'Transaction', bytes_hex: v4TxHex, version: { activated: 4, ergoTree: 4 } }))
      .toEqual({ bytes_hex: v4TxHex, error: null })
    const v3TxHex = '0100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0b0208d3010000'
    expect(runWireEntry({ name: 'tx-v3-tree-at-2', kind: 'Transaction', bytes_hex: v3TxHex, version: { activated: 2, ergoTree: 2 } }))
      .toEqual({ bytes_hex: null, error: 'errored' })
    expect(runWireEntry({ name: 'tx-v3-tree-at-3', kind: 'Transaction', bytes_hex: v3TxHex, version: { activated: 3, ergoTree: 3 } }))
      .toEqual({ bytes_hex: v3TxHex, error: null })
  })

  it('ErgoTree (SHeader-constant reject): a typed codec rejection grades errored, not panicked', () => {
    // The (b) reject vector: a size-flagged tree with a segregated SHeader constant the JVM rejects.
    // ergots throws a typed SValueParseError parsing the constant; isWireCodecError maps it to `errored`
    // (a faithful reject), NOT the panic-net. Guards the typed-codec-error classification.
    const vec = loadVector('v6/authored/ErgoTree.unparsed_soft_fork_header_constant.json')
    const actuals = runWireVector(vec)
    expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
    for (const e of vec.entries) {
      expect(actuals[e.name]).toEqual({ bytes_hex: null, error: 'errored' })
    }
  })
})

describe('runWireEntry — BlockTransactions kind: a block section round-trips through parseBlockTransactions/serializeBlockTransactions', () => {
  // A block's transactions section as the JVM frames it: 32-byte header id, VLQ(10,000,000 + blockVersion)
  // (block version > 1), VLQ tx count, then the transactions. The section's version context comes from
  // its own block version, not the entry's `version` pair (runner-contract-wire §5). The entry's pair is
  // nominal here, matching ergots' parseBlockTransactions, which reads the marker and builds the context.
  const v6 = { activated: 3, ergoTree: 3 }

  it('an accept: a block section (version 4) holding one transaction whose output tree is v3 round-trips', () => {
    // SANTA 8885632, wire/v6/authored/BlockTransactions.tree_version_above_activated.json #2.
    const hex = '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847984ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0b0208d3010000'
    expect(runWireEntry({ name: 'block-v4-v3-tree-accept', kind: 'BlockTransactions', bytes_hex: hex, version: v6 }))
      .toEqual({ bytes_hex: hex, error: null })
  })

  it('a reject: a v4 block whose output tree is v4 refuses at parseTree under (3, 3), errored (faithful reject)', () => {
    // SANTA 8885632, wire/v6/authored/BlockTransactions.tree_version_above_activated.json #0.
    const hex = '584c27d285d6adf99452ebc3c59555749ab01cce2137bc152bc81cb21e32847984ade204010100a19de1b5fa998df5a48630a611180690abad5270c33f23a79baba2f8840d710000000001c0843d0c0208d3010000'
    expect(runWireEntry({ name: 'block-v4-v4-tree-reject', kind: 'BlockTransactions', bytes_hex: hex, version: v6 }))
      .toEqual({ bytes_hex: null, error: 'errored' })
  })

  it('a count of 0 (TxParseError) grades errored, never the panic net', () => {
    // Header id + VLQ(10,000,004) + VLQ(0): a section the JVM rejects before any transaction is read.
    const hex = '11'.repeat(32) + '84ade204' + '00'
    expect(runWireEntry({ name: 'count-zero', kind: 'BlockTransactions', bytes_hex: hex, version: v6 }))
      .toEqual({ bytes_hex: null, error: 'errored' })
  })
})

describe('runWireVector — a type-variable name past 255 bytes of text (writer count range)', () => {
  // ergots refuses to write such a name with its typed STypeSerializeError (root-exported, like the SValue and
  // ErgoTree serialize errors already in isWireCodecError): a faithful reject, `errored`, never the panic net.
  for (const rel of ['v5/authored/ErgoTree.type_var_name_write_range.json',
    'v6/authored/ErgoTree.type_var_name_write_range.json',
    'v6/authored/Transaction.type_var_name_write_range.json']) {
    it(`${rel}: refusals errored, controls written back, none panics`, () => {
      const vec = loadVector(rel)
      const actuals = runWireVector(vec)
      expect(Object.keys(actuals)).toEqual(vec.entries.map((e) => e.name))
      for (const e of vec.entries) {
        if (e.error === 'errored') expect(actuals[e.name], e.name).toEqual({ bytes_hex: null, error: 'errored' })
        else expect(actuals[e.name], e.name).toEqual({ bytes_hex: e.expected_bytes_hex ?? e.bytes_hex, error: null })
      }
    })
  }
})
