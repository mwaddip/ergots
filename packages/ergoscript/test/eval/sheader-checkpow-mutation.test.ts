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
 *   exprBytes = "00dc6810b2db6502fe04000000" (13 bytes)
 *   Byte map:
 *     [0]     0x00 = ErgoTree header (V0, no size, no constant-segregation)
 *     [1]     0xdc = MethodCall opcode (220)
 *     [2]     0x68 = typeId 104 (SHeader)
 *     [3]     0x10 = methodId 16 (checkPow)
 *     [4]     0xb2 = receiver node opcode (ByIndex outer)
 *     [5]     0xdb = inner opcode
 *     [6]     0x65 = MethodCall opcode for .headers accessor
 *     [7]     0x02 = typeId/methodId for .headers (Context.headers)
 *     [8]     0xfe = typeId/methodId for .headers method
 *     [9]     0x04 = index argument (VLQ 2 → headers[0])
 *     [10-12] 0x00 0x00 0x00 = padding / VLQ-zero arguments
 *
 * Known tolerated offsets (benign for the byte-flip reason documented below):
 *   None expected — all 13 bytes are load-bearing for at least one XOR pattern.
 *   If tolerance occurs on [10-12] padding zeros, those are the most likely
 *   candidates (VLQ-zero-length args fields or similar). Document them here if found.
 *
 * Implementation: single `it()` with internal loop — safe under vitest's default
 * sequential-within-describe order AND under any parallel-test config.
 *
 * Source mapping:
 *   ergotree-interpreter/src/eval/sheader.ts (CHECK_POW_METHOD)
 *   packages/ergoscript/src/eval/sheader.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes } from '../_helpers'
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

// XOR patterns that cover the three important bit-flip classes:
//   0xff — invert all bits (strongest; catches opcode changes)
//   0x01 — flip LSB (catches off-by-one in VLQ / small integer fields)
//   0x80 — flip sign bit (catches ZigZag / two's-complement boundary bugs)
const XOR_PATTERNS = [0xff, 0x01, 0x80]
const THRESHOLD = 0.9

type EvalOutcome =
  | { ok: true; value: unknown }
  | { ok: false; errorCode: string | undefined; errorMessage: string }

function evalSafely(treeBytes: Uint8Array, header: ReturnType<typeof parseHeader>): EvalOutcome {
  try {
    const tree = parseTree(treeBytes)
    const ctx = makeContext({ treeVersion: 3, headers: [header] })
    const value = evaluateWith(tree, ctx)
    return { ok: true, value }
  } catch (e) {
    if (e instanceof EvalError) {
      return { ok: false, errorCode: e.code, errorMessage: e.message }
    }
    if (e instanceof Error) {
      return { ok: false, errorCode: undefined, errorMessage: e.message }
    }
    return { ok: false, errorCode: undefined, errorMessage: String(e) }
  }
}

function isKill(baseline: EvalOutcome, mutated: EvalOutcome): boolean {
  // Both threw — check if the error identity changed (same error = survived).
  if (!baseline.ok && !mutated.ok) {
    return baseline.errorCode !== mutated.errorCode
  }
  // One threw, the other didn't — always a kill.
  if (!baseline.ok || !mutated.ok) return true
  // Both succeeded — kill if the value changed.
  // The baseline returns { kind: 'Boolean', value: true }; any change (false or
  // a different kind) is a kill.
  return JSON.stringify(baseline.value) !== JSON.stringify(mutated.value)
}

describe('SHeader.checkPow mutation testing (phase 2h-c.2)', () => {
  it(`≥${(THRESHOLD * 100).toFixed(0)}% kill rate across all byte offsets`, () => {
    const originalBytes = hexToBytes(fixture.exprBytes)
    const headerBytes = hexToBytes(fixture.headerHexBytes)
    const header = parseHeader(new ByteReader(headerBytes))

    // Baseline — must succeed and return true.
    const baseline = evalSafely(originalBytes, header)
    expect(baseline.ok).toBe(true)
    expect((baseline as { ok: true; value: unknown }).value).toEqual({ kind: 'Boolean', value: true })

    let killed = 0
    let survived = 0
    const survivedDetails: Array<{ offset: number; xor: number; outcome: EvalOutcome }> = []

    for (let offset = 0; offset < originalBytes.length; offset++) {
      for (const xor of XOR_PATTERNS) {
        const mutated = new Uint8Array(originalBytes)
        mutated[offset] = (mutated[offset]! ^ xor) & 0xff

        const outcome = evalSafely(mutated, header)
        if (isKill(baseline, outcome)) {
          killed++
        } else {
          survived++
          survivedDetails.push({ offset, xor, outcome })
        }
      }
    }

    const total = killed + survived
    const rate = total === 0 ? 1 : killed / total

    // Log for visibility in CI/local output.
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] SHeader.checkPow: killed=${killed} survived=${survived} total=${total}` +
        ` rate=${(rate * 100).toFixed(1)}%`
    )

    // Log survived mutations for root-cause documentation (per OVERRIDES rule #5).
    if (survivedDetails.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[mutation] Survived mutations (tolerated):`)
      for (const s of survivedDetails) {
        const origByte = originalBytes[s.offset]!
        const mutByte = (origByte ^ s.xor) & 0xff
        // eslint-disable-next-line no-console
        console.log(
          `  offset=${s.offset} orig=0x${origByte.toString(16).padStart(2, '0')} ` +
            `xor=0x${s.xor.toString(16).padStart(2, '0')} ` +
            `mut=0x${mutByte.toString(16).padStart(2, '0')} ` +
            `outcome=${s.outcome.ok ? `ok(${JSON.stringify(s.outcome.value)})` : `err(${s.outcome.errorCode})`}`
        )
      }
    }

    expect(rate).toBeGreaterThanOrEqual(THRESHOLD)
  })
})
