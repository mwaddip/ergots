/**
 * Layer C3.a — Byte-level mutation testing for the Exponentiate arm.
 *
 * For each success-path fixture, mutate:
 *   - the 33-byte SEC1 GroupElement payload of the inline `Const(SGroupElement, …)`
 *     base input;
 *   - the variable-length BigInt256 payload of the inline `Const(SBigInt, …)`
 *     exponent input.
 *
 * Per `isKillStandard`:
 *   - baseline ok + mutated throws  → kill (decodePoint rejected an off-curve
 *                                     flip; or BigInt parse failed)
 *   - baseline ok + mutated ok      → kill iff values differ
 *                                     (mutated scalar · base produces a
 *                                     different point byte sequence)
 *
 * Expected behaviour by entry:
 *   - exp_gen_1 / exp_gen_random / exp_gen_minus_1 / exp_gen_n_minus_1 /
 *     exp_gen_n / exp_gen_i256_max / exp_gen_i256_min :
 *     Mutating the 33-byte GroupElement either off-curves (decodePoint
 *     throws) or yields a different point — kill in either case. Mutating
 *     the BigInt bytes changes the scalar; mod n reduction yields a
 *     different result point.
 *
 *   - exp_gen_0 : EXCLUDED from per-entry threshold (counted in aggregate
 *     only). base = generator, exponent = 0. Mutating the single 0x00
 *     exponent byte kills (output differs from identity). But mutating the
 *     33 base bytes: ~half off-curve (kill via throw), ~half decode to
 *     valid points — yet output is STILL identity because 0·P = 0 for any
 *     P. These are inherently value-invisible mutations: the arm's
 *     mathematical zero-exponent semantic absorbs base-byte changes. This
 *     is a correctness feature, not a defect. Per-entry kill rate stays
 *     near ~55%; the aggregate across other entries swamps it.
 *
 *   - exp_identity_k : base = identity (33 zero bytes). The base.is0()
 *     guard short-circuits regardless of exponent — but the GUARD itself
 *     depends on the 33 zero bytes decoding to identity. Flipping any base
 *     byte forces decodePoint into the non-identity path; @noble/curves
 *     rejects most byte patterns as off-curve (kill via throw). Tag-only
 *     flips (0x02/0x03) at byte 0 to non-zero values get decoded as a
 *     valid point → no longer identity → result is k·P ≠ identity (kill).
 *     Mutating the exponent bytes is value-invisible while the base is
 *     still identity (both yield identity) — these mutations may survive,
 *     but the BigInt region is small relative to base region.
 *
 * Skipped fixtures:
 *   - error entries (no success-path baseline; explicitly filtered).
 *
 * Threshold: ≥ 0.90 per entry (aggregate fallback accepted) — mirrors T3
 * MultiplyGroup mutation test threshold.
 *
 * Source: ergotree-interpreter/src/eval/exponentiate.rs:13-33
 *         ergo-chain-types/src/ec_point.rs:111-119 (identity short-circuit)
 *         ergotree-ir/src/sigma_protocol/dlog_group.rs:60-64 (mod n)
 * Pattern: multiply-group-mutation.test.ts (shared harness in
 *          test/_helpers/mutation-harness.ts). Custom inline helpers for
 *          locating Const(SGroupElement) and Const(SBigInt) regions.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import type { Expr } from '../../src/mir/types'
import { hexToBytes } from '../_helpers'
import {
  runMutationLoop,
  DEFAULT_KILL_THRESHOLD,
} from '../_helpers/mutation-harness'

/**
 * Find the first occurrence of `needle` in `haystack` at or after `from`.
 * Returns the start offset, or -1 if not found. Multiple matches are
 * permitted; caller advances `from` past prior matches to walk the list.
 */
function findBytesFrom(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code?: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'exponentiate.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

/**
 * Walk `expr` depth-first and return the inline `Const(SGroupElement, …)`
 * 33-byte payload (the Exponentiate base). Returns null if absent.
 */
function findInlineGroupElementConst(expr: Expr): Uint8Array | null {
  let found: Uint8Array | null = null
  walk(expr)
  return found

  function walk(node: unknown): void {
    if (found !== null) return
    if (node === null || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (
      n['tag'] === 'Const' &&
      typeof n['tpe'] === 'object' &&
      n['tpe'] !== null &&
      (n['tpe'] as Record<string, unknown>)['tag'] === 'SGroupElement' &&
      typeof n['value'] === 'object' &&
      n['value'] !== null &&
      (n['value'] as Record<string, unknown>)['kind'] === 'GroupElement'
    ) {
      const v = (n['value'] as Record<string, unknown>)['value']
      if (v instanceof Uint8Array) {
        found = v
        return
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) {
        for (const item of v) walk(item)
      } else if (v !== null && typeof v === 'object') {
        walk(v)
      }
    }
  }
}

/**
 * Walk `expr` depth-first and return the inline `Const(SBigInt, …)`
 * BigInt as a TS bigint (the Exponentiate exponent). The wire format for
 * SBigInt is a u16 length followed by signed big-endian bytes; we encode
 * the equivalent bytes here to locate the payload in tree_bytes_hex.
 *
 * Returns the BE bytes (the same form sigma-rust writes), or null if absent.
 */
function findInlineBigIntBytes(expr: Expr): Uint8Array | null {
  let found: bigint | null = null
  walk(expr)
  return found === null ? null : bigintToSignedBE(found)

  function walk(node: unknown): void {
    if (found !== null) return
    if (node === null || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (
      n['tag'] === 'Const' &&
      typeof n['tpe'] === 'object' &&
      n['tpe'] !== null &&
      (n['tpe'] as Record<string, unknown>)['tag'] === 'SBigInt' &&
      typeof n['value'] === 'object' &&
      n['value'] !== null &&
      (n['value'] as Record<string, unknown>)['kind'] === 'BigInt'
    ) {
      const v = (n['value'] as Record<string, unknown>)['value']
      if (typeof v === 'bigint') {
        found = v
        return
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) {
        for (const item of v) walk(item)
      } else if (v !== null && typeof v === 'object') {
        walk(v)
      }
    }
  }
}

/**
 * Convert a TS bigint to its minimal signed big-endian byte representation,
 * mirroring sigma-rust `BigInt256::to_be_vec` (bigint256.rs:88-99). This is
 * what the wire format writes for SBigInt constants — we locate the payload
 * by searching for these bytes in `tree_bytes_hex`.
 *
 * Rules:
 *   - For non-negative n: minimal big-endian. If high bit of MSB is set,
 *     prepend 0x00 to disambiguate sign.
 *   - For negative n: two's complement of `abs(n)`, minimal length. If high
 *     bit of MSB is clear (i.e., redundant 0xFF padding would be needed for
 *     a positive interpretation), this is already disambiguated.
 *   - For n = 0: a single 0x00 byte.
 */
function bigintToSignedBE(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0x00])
  if (n > 0n) {
    const bytes: number[] = []
    let v = n
    while (v > 0n) {
      bytes.unshift(Number(v & 0xffn))
      v >>= 8n
    }
    // If MSB has high bit set, prepend 0x00 (disambiguate as positive)
    if ((bytes[0]! & 0x80) !== 0) {
      bytes.unshift(0x00)
    }
    return new Uint8Array(bytes)
  }
  // Negative: compute two's complement minimal form
  // Find byte-width such that -2^(8b-1) ≤ n < 0, then drain redundant leading 0xFFs
  let bitsNeeded = 1
  let v = -n - 1n
  while (v > 0n) {
    v >>= 1n
    bitsNeeded++
  }
  const bytesNeeded = Math.ceil(bitsNeeded / 8) || 1
  const totalBits = BigInt(bytesNeeded * 8)
  const twosComp = (1n << totalBits) + n
  const bytes: number[] = []
  let w = twosComp
  for (let i = 0; i < bytesNeeded; i++) {
    bytes.unshift(Number(w & 0xffn))
    w >>= 8n
  }
  return new Uint8Array(bytes)
}

describe('Exponentiate mutation testing (Layer C3.a)', () => {
  // Skip error entries (no success-path baseline).
  const entries = fixture.entries.filter(
    (e) => e.expected_error_code === null || e.expected_error_code === undefined,
  )
  let aggKilled = 0
  let aggTotal = 0

  // Fixtures whose mathematical structure makes per-entry threshold
  // unachievable; they still contribute to the aggregate (which is the real
  // safety net). See top-of-file note for `exp_gen_0`.
  const PER_ENTRY_EXEMPT = new Set<string>(['exp_gen_0'])

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on input-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)

      const grpBytes = findInlineGroupElementConst(tree.body)
      expect(grpBytes).not.toBeNull()
      const bigIntBytes = findInlineBigIntBytes(tree.body)
      expect(bigIntBytes).not.toBeNull()

      let entryKilled = 0
      let entryTotal = 0

      // Mutate the GroupElement base region.
      const grpStart = findBytesFrom(treeBytes, grpBytes!, 0)
      if (grpStart < 0) {
        throw new Error(
          `exponentiate-mutation: ${entry.name}: GroupElement payload not found`,
        )
      }
      const grpEnd = grpStart + grpBytes!.length
      const grpResult = runMutationLoop({
        treeBytes,
        region: { start: grpStart, end: grpEnd },
        optsJson: entry.opts_json,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] exponentiate.${entry.name}#base: killed=${grpResult.killed} ` +
          `total=${grpResult.total} rate=${grpResult.rate.toFixed(3)} ` +
          `inputLen=${grpBytes!.length} inputStart=${grpStart}`,
      )
      entryKilled += grpResult.killed
      entryTotal += grpResult.total

      // Mutate the BigInt exponent region. Search starts AFTER the
      // GroupElement payload to disambiguate when patterns coincide (e.g.
      // a single 0x00 byte appearing in both regions).
      const bigStart = findBytesFrom(treeBytes, bigIntBytes!, grpEnd)
      if (bigStart < 0) {
        throw new Error(
          `exponentiate-mutation: ${entry.name}: BigInt payload not found at/after offset ${grpEnd}`,
        )
      }
      const bigEnd = bigStart + bigIntBytes!.length
      const bigResult = runMutationLoop({
        treeBytes,
        region: { start: bigStart, end: bigEnd },
        optsJson: entry.opts_json,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] exponentiate.${entry.name}#exponent: killed=${bigResult.killed} ` +
          `total=${bigResult.total} rate=${bigResult.rate.toFixed(3)} ` +
          `inputLen=${bigIntBytes!.length} inputStart=${bigStart}`,
      )
      entryKilled += bigResult.killed
      entryTotal += bigResult.total

      aggKilled += entryKilled
      aggTotal += entryTotal
      const entryRate = entryTotal === 0 ? 1 : entryKilled / entryTotal
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] exponentiate.${entry.name} TOTAL: killed=${entryKilled} ` +
          `total=${entryTotal} rate=${entryRate.toFixed(3)}`,
      )
      if (!PER_ENTRY_EXEMPT.has(entry.name)) {
        expect(entryRate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
      }
    })
  }

  it(`Exponentiate: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG exponentiate: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
