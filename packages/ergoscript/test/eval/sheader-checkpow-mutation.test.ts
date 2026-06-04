/**
 * Mutation testing for SHeader.checkPow oracle fixture — phase 2h-c.2.
 *
 * Target: ≥ 90% kill rate. Each single-byte flip (three XOR patterns per
 * offset: 0xff, 0x01, 0x80) either:
 *   - Causes a wire-layer throw (killed)
 *   - Causes an eval-layer throw (killed)
 *   - Flips the Boolean result to false (killed)
 *   - Leaves behaviour identical (tolerated — documented inline)
 *
 * Fixture: packages/ergoscript/test/fixtures/eval/sheader-checkpow.json
 *   exprBytes = "00db6810b2db6502fe040000" (12 bytes)
 *
 *   JVM-faithful encoding (v6 P4): checkPow is a ZERO-ARG method, so it is
 *   serialized under the PropertyCall opcode (0xdb), NOT the MethodCall opcode
 *   (0xdc). The JVM `MethodCall` AST node routes every zero-arg call through
 *   PropertyCall (values.scala:1322), and `MethodCallSerializer.parse` rejects a
 *   0xdc empty-args node at ErgoTree version >= 3. The PropertyCall form drops
 *   the MethodCall args-count byte, so this encoding is 1 byte shorter (12 vs 13)
 *   than the prior sigma-rust-shaped 0xdc fixture. See
 *   src/eval/validate-method-call-arity.ts (the pre-eval pass that rejects the
 *   0xdc empty-args form).
 *
 *   Byte map:
 *     [0]     0x00 = ErgoTree header (V0, no size, no constant-segregation)
 *     [1]     0xdb = PropertyCall opcode (219) — checkPow envelope
 *     [2]     0x68 = typeId 104 (SHeader)
 *     [3]     0x10 = methodId 16 (checkPow)
 *     [4]     0xb2 = ByIndex opcode (178) — the receiver headers(0)
 *     [5]     0xdb = PropertyCall opcode (219) — inner Context.headers
 *     [6]     0x65 = typeId 101 (SContext)
 *     [7]     0x02 = methodId 2 (.headers)
 *     [8]     0xfe = Context node opcode (the .headers receiver)
 *     [9]     0x04 = ByIndex.index Const SInt typecode
 *     [10]    0x00 = ByIndex.index value (ZigZag-VLQ 0 → headers[0])
 *     [11]    0x00 = ByIndex.default (None marker)
 *
 * Known tolerated offsets (benign for the byte-flip reason documented below):
 *   offset=0 (the ErgoTree header byte) survives XOR 0x01 and XOR 0x80: those
 *   flip header bits that, for this V0 / no-size / no-constant-segregation tree,
 *   neither change how the body parses nor how it evaluates — checkPow still
 *   returns Boolean(true). 2 survivors out of 36 mutations = 94.4% kill rate
 *   (>= the 90% threshold). All 11 body/envelope bytes ([1]-[11]) are
 *   load-bearing for at least one XOR pattern.
 *
 * Implementation: single `it()` with internal loop — safe under vitest's default
 * sequential-within-describe order AND under any parallel-test config.
 *
 * Source mapping:
 *   ergotree-interpreter/src/eval/sheader.ts (CHECK_POW_METHOD)
 *   packages/ergoscript/src/eval/sheader.ts
 *
 * Harness extracted to test/_helpers/mutation-harness.ts in Phase 2h-e.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hexToBytes } from '../_helpers'
import {
  runMutationLoop,
  evalSafely,
  isKillStrict,
  DEFAULT_KILL_THRESHOLD,
} from '../_helpers/mutation-harness'
import { makeContext } from '../../src/eval/eval-context'
import { ByteReader, parseHeader } from '@ergots/scorex'

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

describe('SHeader.checkPow mutation testing (phase 2h-c.2)', () => {
  it(`≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate across all byte offsets`, () => {
    const originalBytes = hexToBytes(fixture.exprBytes)
    const headerBytes = hexToBytes(fixture.headerHexBytes)
    const header = parseHeader(new ByteReader(headerBytes))

    // Precondition: the unmutated baseline must succeed and return Boolean(true).
    // The harness will use the same baseline internally for kill/survive
    // comparisons; this explicit check provides a cleaner failure message
    // when SHeader.checkPow itself regresses.
    const baseline = evalSafely(originalBytes, undefined, () =>
      makeContext({ treeVersion: 3, headers: [header] }),
    )
    expect(baseline.ok).toBe(true)
    if (baseline.ok) {
      expect(baseline.value).toEqual({ kind: 'Boolean', value: true })
    }

    const result = runMutationLoop({
      treeBytes: originalBytes,
      region: { start: 0, end: originalBytes.length },
      isKill: isKillStrict,
      makeCtx: () => makeContext({ treeVersion: 3, headers: [header] }),
    })

    // Log for visibility in CI/local output.
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] SHeader.checkPow: killed=${result.killed} survived=${result.total - result.killed} total=${result.total}` +
        ` rate=${(result.rate * 100).toFixed(1)}%`,
    )

    // Log survived mutations for root-cause documentation (per OVERRIDES rule #5).
    if (result.survived.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[mutation] Survived mutations (tolerated):`)
      for (const s of result.survived) {
        const origByte = originalBytes[s.offset]!
        const mutByte = (origByte ^ s.xor) & 0xff
        // eslint-disable-next-line no-console
        console.log(
          `  offset=${s.offset} orig=0x${origByte.toString(16).padStart(2, '0')} ` +
            `xor=0x${s.xor.toString(16).padStart(2, '0')} ` +
            `mut=0x${mutByte.toString(16).padStart(2, '0')} ` +
            `outcome=${s.outcome.ok ? `ok(${JSON.stringify(s.outcome.value)})` : `err(${s.outcome.errorCode})`}`,
        )
      }
    }

    expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
