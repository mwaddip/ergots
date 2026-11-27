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

// The tx arm's parse context comes from the voted block version: `blockVersionContext(
// e.parameters.blockVersion ?? e.preHeader.version)` (ergo BlockTransactions.scala:184-202).
// From block version 4 it is (blockVersion - 1, blockVersion - 1); below that (1, 1). Hand-written
// entries below pin that mapping and the pre-header fallback; a captured entry carries both halves
// in agreement, so this covers the branch SANTA's captured vectors cannot.
describe('runTransactionVector — the transaction arm reads the voted block version for the parse context', () => {
  // A transaction with one input (box id 0x11 * 32, empty proof, empty extension), no data inputs,
  // no tokens, and one output: value 1000000, a size-flagged v4 tree `0c 02 08 d3`
  // (SigmaProp(true)), creation height 1, no tokens, no registers. The output tree's version is
  // what the parse gates on under its context.
  const V4_OUTPUT_TX =
    '01' + '11'.repeat(32) + '0000' + '00' + '00' +
    '01' + 'c0843d' + '0c0208d3' + '01' + '00' + '00'
  // Its v3 twin: `0b 02 08 d3`. Parses under (3, 3).
  const V3_OUTPUT_TX =
    '01' + '11'.repeat(32) + '0000' + '00' + '00' +
    '01' + 'c0843d' + '0b0208d3' + '01' + '00' + '00'
  // A minimal input box: value 1000000, a v0 tree 00 08 d3 (SigmaProp(true)), creation height 1,
  // no tokens, no registers, tx id 0x00 * 32, index 00. Its id is not 0x11 * 32, so validateStateful
  // throws `input-box-id-mismatch` — the result is {valid: false, error: null, reason} when the
  // transaction's parse itself succeeds.
  // Layout: value(c0843d=3) | tree(0008d3=3) | height(01=1) | tokens(00=1) | registers(00=1) |
  // txId(00*32=32) | index(00=1) = 42 bytes = 84 hex chars.
  const INPUT_BOX_HEX =
    'c0843d' + '0008d3' + '01' + '00' + '00' + '00'.repeat(32) + '00'

  const baseEntry = (opts: { txBytesHex: string; blockVersion?: number; preHeaderVersion: number }) => ({
    name: `block-version=${opts.blockVersion ?? 'unset'}, preHeader=${opts.preHeaderVersion}`,
    tx_bytes_hex: opts.txBytesHex,
    input_boxes_hex: [INPUT_BOX_HEX],
    data_input_boxes_hex: [],
    headers_hex: [],
    preHeader: {
      version: opts.preHeaderVersion,
      parentId: '00'.repeat(32),
      timestamp: '0',
      nBits: 0,
      height: 1,
      minerPk: '00'.repeat(33),
      votes: '000000',
    },
    parameters: {
      maxBlockCost: 1_000_000, storageFeeFactor: 1_250_000, minValuePerByte: 360,
      inputCost: 2000, dataInputCost: 100, outputCost: 100, tokenAccessCost: 100,
      ...(opts.blockVersion !== undefined ? { blockVersion: opts.blockVersion } : {}),
    },
    version: { activated: 3, ergoTree: 3 },
  })

  const run = (e: ReturnType<typeof baseEntry>) =>
    runTransactionVector({ schema: 'santa-transaction/v1',
      entries: [e as unknown as Parameters<typeof runTransactionVector>[0]['entries'][number]] })[e.name]

  it('parameters.blockVersion 3 gives parse context (1, 1): a v4 output tree parses, validateStateful rejects it on the mismatched input id', () => {
    // Under (3, 3) the v4 tree would reject at the parse; the fallback to (1, 1) at block version 3
    // lets it parse. The runner then calls validateStateful, which throws on the mismatched input
    // box id — so a parsed transaction shows as {valid: false, error: null} rather than `errored`.
    const r = run(baseEntry({ txBytesHex: V4_OUTPUT_TX, blockVersion: 3, preHeaderVersion: 4 }))
    expect(r.error).toBeNull()
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('input-box-id-mismatch')
  })

  it('parameters.blockVersion 4 gives parse context (3, 3): the v4 output tree is refused at parseTransaction', () => {
    // The same transaction at block version 4: the context is (3, 3), and a v4 output tree is
    // above the activated version — the parse throws, the arm reports `errored`.
    const r = run(baseEntry({ txBytesHex: V4_OUTPUT_TX, blockVersion: 4, preHeaderVersion: 4 }))
    expect(r.error).toBe('errored')
    expect(r.reason).toMatch(/tree-version-above-activated|tree version 4/)
  })

  it('without parameters.blockVersion the arm falls back to the pre-header version', () => {
    // No `blockVersion` in parameters, pre-header version 5: the fallback gives (4, 4), under which
    // the v4 output tree parses. validateStateful then rejects on the input id mismatch.
    const parsed = run(baseEntry({ txBytesHex: V4_OUTPUT_TX, preHeaderVersion: 5 }))
    expect(parsed.error).toBeNull()
    expect(parsed.reason).toBe('input-box-id-mismatch')
    // Pre-header version 4: the fallback gives (3, 3), and the v4 tree is refused at parse.
    const refused = run(baseEntry({ txBytesHex: V4_OUTPUT_TX, preHeaderVersion: 4 }))
    expect(refused.error).toBe('errored')
    expect(refused.reason).toMatch(/tree-version-above-activated|tree version 4/)
    // Pre-header version 3: the fallback gives (1, 1), the v4 tree parses.
    const belowFour = run(baseEntry({ txBytesHex: V4_OUTPUT_TX, preHeaderVersion: 3 }))
    expect(belowFour.error).toBeNull()
    expect(belowFour.reason).toBe('input-box-id-mismatch')
  })

  it('a v3 output tree parses at every pair the arm can build', () => {
    for (const opts of [
      { blockVersion: 3, preHeaderVersion: 4 },   // (1, 1)
      { blockVersion: 4, preHeaderVersion: 4 },   // (3, 3)
      { blockVersion: 5, preHeaderVersion: 4 },   // (4, 4)
    ] as const) {
      const r = run(baseEntry({ txBytesHex: V3_OUTPUT_TX, ...opts }))
      expect(r.error, `${opts.blockVersion}`).toBeNull()
      expect(r.reason).toBe('input-box-id-mismatch')
    }
  })

  it('a v4 input box is read (not refused) by the arm at block version 5: the arm reads input boxes outside any version context', () => {
    // A minimal input box whose tree is v4 (size-flagged SigmaProp(true), `0c 02 08 d3`), at
    // block version 5, where the arm's transaction context is (4, 4). An input box is read
    // outside any version context (ergo UtxoStateReader.scala:122-130), so the v4 tree parses
    // under the box path even though its tree version equals the arm's activated version. If the
    // arm instead read the input box under the transaction's own context, a mutation that fed
    // the transaction's context to parseBox would leave that path unchanged at (4, 4) and
    // nothing would tell the two apart. At block version 4 or 5 the two differ: the
    // transaction's context is (3, 3) or (4, 4), where a v4 input box's tree parses in both and
    // the transaction's v3 output tree also parses, so validateStateful reaches the input-id
    // check first — which is why the test runs at block version 5: the v4 input box is read by
    // the arm's parseBox regardless of the transaction's context, and validateStateful then
    // throws `input-box-id-mismatch` as its first verdict because the input box's id differs
    // from the transaction's declared input.
    // Layout: value(c0843d) | tree(0c0208d3) | height(01) | tokens(00) | registers(00) |
    // txId(00*32) | index(00).
    const V4_INPUT_BOX_HEX =
      'c0843d' + '0c0208d3' + '01' + '00' + '00' + '00'.repeat(32) + '00'
    const entry = {
      ...baseEntry({ txBytesHex: V3_OUTPUT_TX, blockVersion: 5, preHeaderVersion: 5 }),
      input_boxes_hex: [V4_INPUT_BOX_HEX],
    }
    const r = run(entry)
    expect(r.error).toBeNull()
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('input-box-id-mismatch')
  })
})
