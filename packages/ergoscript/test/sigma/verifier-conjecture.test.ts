/**
 * `verifySignature` conjecture-tree fixture tests (phase 2g-combinators Task 9).
 *
 * Nine fixture files cover Cand / Cor / Cthreshold (positive + reject +
 * mutation) for the full extended verifier. Suite shape mirrors
 * `verifier.test.ts` (2g-medium leaf-only) but parameterized over the
 * conjecture type.
 *
 * Critical invariant for mutation suites (OVERRIDES rule #2): a verifier
 * that returns `true` on any single-byte-flipped fixture is a critical
 * vulnerability. Each mutation entry must EITHER throw VerifyError OR
 * return `false`. Returning `true` is unconditionally a test failure.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySignature } from '../../src/sigma/verifier'
import { VerifyError } from '../../src/sigma/errors'
import { hexToBytes } from '../_helpers'
import type { SigmaBoolean } from '../../src/mir/types'

interface PositiveEntry {
  name: string
  sigma_boolean_json: any
  message_hex: string
  signature_hex: string
  expected_result: boolean
}

interface RejectEntry {
  name: string
  sigma_boolean_json: any
  message_hex: string
  signature_hex: string
  expected_outcome: string
}

interface MutationEntry {
  name: string
  sigma_boolean_json: any
  message_hex: string
  mutated_signature_hex: string
  flip_offset: number
  expected_outcome: string
}

/**
 * Rehydrate a fixture's JSON SigmaBoolean into the runtime tagged-union
 * shape. Identical to the hydrator in `verifier.test.ts` (2g-medium) plus
 * the recursive Cand/Cor/Cthreshold cases that this suite exercises.
 */
function hydrateSigmaBoolean(json: any): SigmaBoolean {
  switch (json.tag) {
    case 'TrivialProp':
      return { tag: 'TrivialProp', value: json.value as boolean }
    case 'ProveDlog':
      return { tag: 'ProveDlog', h: hexToBytes(json.h as string) }
    case 'ProveDhTuple':
      return {
        tag: 'ProveDhTuple',
        g: hexToBytes(json.g as string),
        h: hexToBytes(json.h as string),
        u: hexToBytes(json.u as string),
        v: hexToBytes(json.v as string),
      }
    case 'Cand':
      return { tag: 'Cand', items: (json.items as any[]).map(hydrateSigmaBoolean) }
    case 'Cor':
      return { tag: 'Cor', items: (json.items as any[]).map(hydrateSigmaBoolean) }
    case 'Cthreshold':
      return {
        tag: 'Cthreshold',
        k: json.k as number,
        items: (json.items as any[]).map(hydrateSigmaBoolean),
      }
    default:
      throw new Error(`hydrateSigmaBoolean: unknown tag ${json.tag}`)
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, `../fixtures/verify/${name}`), 'utf-8')) as T
}

/**
 * Positive suite — every entry must verify true. These are cross-validated
 * against sigma-rust's `verify_signature` at fixture-gen time, so any
 * failure here is a TS-side discrepancy.
 */
function positiveSuite(label: string, fixtureName: string): void {
  const fixture = loadFixture<{ description: string; entries: PositiveEntry[] }>(fixtureName)
  describe(`verifySignature — ${label} positive`, () => {
    for (const entry of fixture.entries) {
      it(`${entry.name} — verifies`, () => {
        const sb = hydrateSigmaBoolean(entry.sigma_boolean_json)
        const msg = hexToBytes(entry.message_hex)
        const sig = hexToBytes(entry.signature_hex)
        expect(verifySignature(sb, msg, sig)).toBe(true)
      })
    }
  })
}

/**
 * Reject suite — each entry has an `expected_outcome` of either a
 * VerifyError code (e.g. 'empty-signature', 'truncated-signature'),
 * 'returns-false', or 'returns-true'.
 */
function rejectSuite(label: string, fixtureName: string): void {
  const fixture = loadFixture<{ description: string; entries: RejectEntry[] }>(fixtureName)
  describe(`verifySignature — ${label} reject + malformed`, () => {
    for (const entry of fixture.entries) {
      it(`${entry.name} — ${entry.expected_outcome}`, () => {
        const sb = hydrateSigmaBoolean(entry.sigma_boolean_json)
        const msg = hexToBytes(entry.message_hex)
        const sig = hexToBytes(entry.signature_hex)
        switch (entry.expected_outcome) {
          case 'returns-true':
            expect(verifySignature(sb, msg, sig)).toBe(true)
            break
          case 'returns-false':
            expect(verifySignature(sb, msg, sig)).toBe(false)
            break
          default: {
            // expected_outcome is a VerifyError code
            let captured: unknown = null
            try {
              verifySignature(sb, msg, sig)
            } catch (e) {
              captured = e
            }
            expect(captured).toBeInstanceOf(VerifyError)
            expect((captured as VerifyError).code).toBe(entry.expected_outcome)
          }
        }
      })
    }
  })
}

/**
 * Mutation suite — single-byte-flipped baselines. The verifier must
 * either return false or throw VerifyError; returning true is a
 * vulnerability. Per OVERRIDES rule #2 we surface the failing entry
 * with the explicit flip offset for triage.
 */
function mutationSuite(label: string, fixtureName: string): void {
  const fixture = loadFixture<{
    description: string
    baseline_signature_hex: string
    entries: MutationEntry[]
  }>(fixtureName)
  describe(`verifySignature — ${label} mutation`, () => {
    for (const entry of fixture.entries) {
      it(`${entry.name} (offset ${entry.flip_offset}) — rejects`, () => {
        const sb = hydrateSigmaBoolean(entry.sigma_boolean_json)
        const msg = hexToBytes(entry.message_hex)
        const sig = hexToBytes(entry.mutated_signature_hex)
        try {
          const result = verifySignature(sb, msg, sig)
          // If we reach here, the verifier returned a boolean — must be false.
          if (result === true) {
            throw new Error(
              `mutation at offset ${entry.flip_offset} passed verification — verifier vulnerability!`,
            )
          }
          expect(result).toBe(false)
        } catch (e) {
          if (e instanceof VerifyError) {
            // Acceptable — typed error during parse / scalar bounds / etc.
            return
          }
          throw e
        }
      })
    }
  })
}

// Cand
positiveSuite('Cand', 'verifier-cand.json')
rejectSuite('Cand', 'verifier-cand-reject.json')
mutationSuite('Cand', 'verifier-cand-mutation.json')

// Cor
positiveSuite('Cor', 'verifier-cor.json')
rejectSuite('Cor', 'verifier-cor-reject.json')
mutationSuite('Cor', 'verifier-cor-mutation.json')

// Cthreshold
positiveSuite('Cthreshold', 'verifier-cthreshold.json')
rejectSuite('Cthreshold', 'verifier-cthreshold-reject.json')
mutationSuite('Cthreshold', 'verifier-cthreshold-mutation.json')
