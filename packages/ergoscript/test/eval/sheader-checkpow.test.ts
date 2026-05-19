/**
 * SHeader.checkPow oracle fixture test — phase 2h-c.2.
 *
 * Loads the fixture emitted by fixture-gen/src/ergoscript/sheader_checkpow.rs
 * and asserts that the TS evaluator produces the same value + jit_cost as
 * sigma-rust's try_eval_out oracle.
 */
import { describe, it, expect } from 'vitest'
import { makeContext } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes } from '../_helpers'
import { ByteReader, parseHeader } from '@ergots/scorex'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sheader-checkpow.json')

interface CheckPowFixture {
  name: string
  exprBytes: string
  headerHexBytes: string
  headerVersion: number
  headerHeight: number
  expectedValue: boolean
  expectedJitCost: number
  v1HeaderHexBytes: string
  v1HeaderVersion: number
  v1HeaderHeight: number
}

const fixture: CheckPowFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SHeader.checkPow oracle (Phase 2h-c.2)', () => {
  it('returns true on a real V3 mainnet header with sigma-rust-equal jitCost', () => {
    // fixture.exprBytes is the sigma-serialized full ErgoTree (V0 header byte +
    // expression body) — see fixture-gen/src/cmds/ergoscript/eval/sheader_checkpow.rs
    // which calls ErgoTree::new(...) then sigma_serialize_bytes().
    //
    // The header is provided as raw scorex-serialized bytes in headerHexBytes;
    // parseHeader decodes it into the runtime Header shape for makeContext().
    //
    // We pass treeVersion: 3 explicitly so the dispatcher's minVersion gate (Task
    // 7) allows CHECK_POW_METHOD (minVersion=3) to be dispatched. The tree itself
    // was serialized with a V0 envelope by fixture-gen; treeVersion in makeContext
    // overrides the envelope's version for evaluation purposes.

    const tree = parseTree(hexToBytes(fixture.exprBytes))
    const headerBytes = hexToBytes(fixture.headerHexBytes)
    const header = parseHeader(new ByteReader(headerBytes))

    const ctx = makeContext({
      treeVersion: 3,
      headers: [header],
    })

    const result = evaluateWith(tree, ctx)

    expect(result).toEqual({ kind: 'Boolean', value: fixture.expectedValue })
    expect(ctx.jitCost).toBe(fixture.expectedJitCost)
  })
})
