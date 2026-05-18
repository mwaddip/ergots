import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseTree } from '../../src/index'
import { hexToBytes } from '../../scripts/_hex'
import { analyzeBox, emptyResult, type CorpusBox } from '../../scripts/_walker'
import { KNOWN_METHODS } from '../../scripts/_known-methods'

describe('analyzer backward-compat: 173-box corpus reproduces 2g.5 measurement', () => {
  it('produces SBox.tokens=43, SContext.dataInputs=15, SColl.indexOf=6 (18 evaluable entries)', () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'mainnet_boxes.json')
    const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
      entries: Array<{
        box_id: string
        ergo_tree_hex: string
        block_height?: number
        sigma_rust_eval: { ok: boolean }
      }>
    }

    // The 2g.5 brainstorm walked only the 18 evaluable entries (sigma_rust_eval.ok === true).
    // Filtering to that subset reproduces the measured counts 43 / 15 / 6.
    const evaluable = raw.entries.filter(e => e.sigma_rust_eval?.ok === true)

    const result = emptyResult()
    const unimplementedTags = new Set<string>()

    for (const entry of evaluable) {
      const corpusBox: CorpusBox = {
        boxId: entry.box_id,
        ergoTreeBytes: entry.ergo_tree_hex,
        blockHeight: entry.block_height ?? 0,
        txId: '',
        outputIndex: 0,
        source: 'random',
      }
      try {
        const tree = parseTree(hexToBytes(corpusBox.ergoTreeBytes))
        analyzeBox(tree.body, corpusBox, result, KNOWN_METHODS, unimplementedTags)
      } catch {
        // tolerate parse failures
      }
    }

    expect(result.methodPairs.get('99:8')?.totalAppearances).toBe(43)
    expect(result.methodPairs.get('101:1')?.totalAppearances).toBe(15)
    expect(result.methodPairs.get('12:26')?.totalAppearances).toBe(6)
  })
})
