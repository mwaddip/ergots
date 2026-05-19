/**
 * SHeader.checkPow oracle fixture test — phase 2h-c.2.
 *
 * Loads the fixture emitted by fixture-gen/src/ergoscript/sheader_checkpow.rs
 * and asserts that the TS evaluator produces the same value + jit_cost as
 * sigma-rust's try_eval_out oracle.
 */
import { describe, it, expect } from 'vitest'
import { makeContext, EvalError } from '../../src/eval/eval-context'
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

describe('SHeader.checkPow V<3 reject (parallel-pair cost correctness)', () => {
  // One parsed tree reused across all 4 runs — dispatcher reads ctx.treeVersion,
  // NOT tree.header.version, so a single tree object is sufficient.
  const tree = parseTree(hexToBytes(fixture.exprBytes))
  const headerBytes = hexToBytes(fixture.headerHexBytes)
  const header = parseHeader(new ByteReader(headerBytes))

  function evaluateCapture(treeVersion: 0 | 1 | 2 | 3): { cost: number; threw: Error | null } {
    const ctx = makeContext({ treeVersion, headers: [header] })
    try {
      evaluateWith(tree, ctx)
      return { cost: ctx.jitCost, threw: null }
    } catch (e) {
      return { cost: ctx.jitCost, threw: e as Error }
    }
  }

  // Baseline: V3 success — establishes the pivot cost for the parallel-pair delta.
  const v3Run = evaluateCapture(3)

  for (const v of [0, 1, 2] as const) {
    it(`treeVersion=${v}: throws 'tree-version-too-low' and skips the 700 handler cost`, () => {
      const rejectRun = evaluateCapture(v)

      expect(rejectRun.threw).toBeInstanceOf(EvalError)
      expect((rejectRun.threw as EvalError).code).toBe('tree-version-too-low')

      // The load-bearing assertion: V<3 reject cost is EXACTLY 700 less than V3 success cost.
      // Receiver-eval cost and envelope cost are charged in both; handler cost (700) is the diff.
      expect(v3Run.cost - rejectRun.cost).toBe(700)
    })
  }

  it('baseline V3 success establishes the parallel-pair pivot', () => {
    expect(v3Run.threw).toBeNull()
    expect(v3Run.cost).toBe(fixture.expectedJitCost)
  })
})

describe('SHeader.checkPow V1 header rejection', () => {
  it("V3 tree with V1 header receiver throws 'autolykos-v1-not-supported'", () => {
    // V1 mainnet header — fixture-gen emits its hex bytes as v1HeaderHexBytes
    // alongside the V2 oracle data (see fixture-gen/src/ergoscript/sheader_checkpow.rs).
    const v1HeaderBytes = hexToBytes(fixture.v1HeaderHexBytes)
    const v1Header = parseHeader(new ByteReader(v1HeaderBytes))
    expect(v1Header.version).toBe(1)

    // fixture.exprBytes is the sigma-serialized full ErgoTree, reused from the oracle test.
    const tree = parseTree(hexToBytes(fixture.exprBytes))

    // Supply the V1 header via context; treeVersion: 3 gates the dispatcher to allow CHECK_POW_METHOD.
    const ctx = makeContext({
      treeVersion: 3,
      headers: [v1Header],
    })

    try {
      evaluateWith(tree, ctx)
      throw new Error('expected EvalError throw but evaluate succeeded')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('autolykos-v1-not-supported')
    }
  })
})

describe('SHeader.checkPow edge cases', () => {
  const headerBytes = hexToBytes(fixture.headerHexBytes)
  const header = parseHeader(new ByteReader(headerBytes))

  it("non-Header receiver throws 'header-obj-not-header'", () => {
    // Direct AST construction bypasses the wire parser (which would catch
    // this earlier). The receiver is a LongConst(42); the MethodCall targets
    // SHeader.checkPow (104:16). The dispatcher's V3 gate passes (treeVersion=3);
    // the cost-700 charge runs; then assertHeaderObj throws because
    // obj.kind === 'Long' !== 'Header'.
    //
    // MethodCall shape from packages/ergoscript/src/mir/types.ts:391-401:
    //   { tag, obj, typeId, methodId, args, explicitTypeArgs }
    const tree = {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'MethodCall',
        typeId: 104,
        methodId: 16,
        obj: {
          tag: 'Const',
          tpe: { tag: 'SLong' },
          value: { kind: 'Long', value: 42n },
        },
        args: [],
        explicitTypeArgs: {},
      },
    }
    const ctx = makeContext({ treeVersion: 3, headers: [header] })

    try {
      evaluateWith(tree as any, ctx)
      throw new Error('expected EvalError throw but evaluate succeeded')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('header-obj-not-header')
    }
  })

  it('V2 header with mutated nonce returns Boolean(false), no throw', () => {
    // Mutate the nonce to a value that overwhelmingly fails the PoW target.
    const mutatedHeader = {
      ...header,
      autolykosSolution: {
        ...header.autolykosSolution,
        nonce: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
      },
    }

    // Use parseTree (not parseExpr — parseExpr is not exported from ergo-tree.ts).
    const tree = parseTree(hexToBytes(fixture.exprBytes))
    const ctx = makeContext({ treeVersion: 3, headers: [mutatedHeader] })

    const result = evaluateWith(tree as any, ctx)
    expect(result).toEqual({ kind: 'Boolean', value: false })
    // Cost should match the valid-header case — handler runs to completion.
    expect(ctx.jitCost).toBe(fixture.expectedJitCost)
  })

  it('valid V2 header at chain tip returns Boolean(true) — fixture redundancy check', () => {
    // Mirror of the oracle test, here for organizational coherence with the
    // throw-path siblings.
    const tree = parseTree(hexToBytes(fixture.exprBytes))
    const ctx = makeContext({ treeVersion: 3, headers: [header] })

    const result = evaluateWith(tree as any, ctx)
    expect(result).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(fixture.expectedJitCost)
  })
})
