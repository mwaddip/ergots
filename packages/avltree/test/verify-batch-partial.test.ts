/**
 * verifyAvlBatchPartial — partial-success semantics tests.
 *
 * Mirrors sigma-rust's BatchAVLVerifier behavior under op failure: stop at the
 * first failed op, return state-after-last-successful-op (digest + per-op
 * oldValue results) plus the count of completed operations.
 *
 * verifyAvlBatch is verified here to remain byte-equivalent on all-pass and to
 * collapse partial-success to its v0.1.0 all-or-nothing null behavior.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { verifyAvlBatchPartial, verifyAvlBatch } from '../src/verify.js'
import type { Operation } from '../src/operation.js'
import type { AvlTreeConfig } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures')

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

function jsonToOp(o: any): Operation {
  switch (o.tag) {
    case 'Lookup':
    case 'UnknownModification':
    case 'Remove':
    case 'RemoveIfExists':
      return { tag: o.tag, key: hexToBytes(o.keyHex) }
    case 'Insert':
    case 'Update':
    case 'InsertOrUpdate':
      return { tag: o.tag, key: hexToBytes(o.keyHex), value: hexToBytes(o.valueHex) }
    case 'UpdateLongBy':
      return { tag: o.tag, key: hexToBytes(o.keyHex), delta: BigInt(o.delta) }
    default:
      throw new Error(`Unknown op tag: ${o.tag}`)
  }
}

describe('verifyAvlBatchPartial', () => {
  test('returns opsCompleted === operations.length when all ops succeed (batch-16ops-mixed)', () => {
    const fxt = JSON.parse(
      readFileSync(resolve(FIXTURES, 'avltree/batch-16ops-mixed.json'), 'utf8'),
    )
    const startingDigest = hexToBytes(fxt.startingDigestHex)
    const proof = hexToBytes(fxt.proofHex)
    const config: AvlTreeConfig = fxt.config
    const operations: Operation[] = fxt.operations.map(jsonToOp)

    const partial = verifyAvlBatchPartial(startingDigest, proof, config, operations)
    expect(partial).not.toBeNull()
    expect(partial!.opsCompleted).toBe(operations.length)

    // newDigest matches the all-pass fixture's expectedNewDigestHex.
    expect(Array.from(partial!.newDigest)).toEqual(
      Array.from(hexToBytes(fxt.expectedNewDigestHex)),
    )

    // Wrapper byte-equivalence: verifyAvlBatch must return the same payload.
    const batch = verifyAvlBatch(startingDigest, proof, config, operations)
    expect(batch).not.toBeNull()
    expect(Array.from(partial!.newDigest)).toEqual(Array.from(batch!.newDigest))
    expect(partial!.results.length).toBe(batch!.results.length)
    for (let i = 0; i < partial!.results.length; i++) {
      const a = partial!.results[i]
      const b = batch!.results[i]
      if (a === null) expect(b).toBeNull()
      else expect(Array.from(a!)).toEqual(Array.from(b!))
    }
  })

  test('returns partial result when op 3 of 5 fails (Insert key-already-exists)', () => {
    const fxt = JSON.parse(
      readFileSync(resolve(FIXTURES, 'partial/insert-fail-at-3-of-5.json'), 'utf8'),
    )
    const partial = verifyAvlBatchPartial(
      hexToBytes(fxt.starting_digest_hex),
      hexToBytes(fxt.proof_hex),
      fxt.config,
      fxt.operations.map(jsonToOp),
    )
    expect(partial).not.toBeNull()
    expect(partial!.opsCompleted).toBe(fxt.expected_ops_completed)
    expect(Array.from(partial!.newDigest)).toEqual(
      Array.from(hexToBytes(fxt.expected_digest_after_2_ops_hex)),
    )
    expect(partial!.results.length).toBe(fxt.expected_ops_completed)
  })

  test('verifyAvlBatch returns null on partial success (old all-or-nothing semantic)', () => {
    const fxt = JSON.parse(
      readFileSync(resolve(FIXTURES, 'partial/insert-fail-at-3-of-5.json'), 'utf8'),
    )
    const batch = verifyAvlBatch(
      hexToBytes(fxt.starting_digest_hex),
      hexToBytes(fxt.proof_hex),
      fxt.config,
      fxt.operations.map(jsonToOp),
    )
    expect(batch).toBeNull()
  })
})
