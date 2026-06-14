/**
 * SUnsignedBigInt constant end-to-end (P2a Task 4).
 *
 * Proves that a `Const(SUnsignedBigInt, value)` in a v6 ErgoTree
 * (header version 3) works through every generic path:
 *   - exprTpe  → SUnsignedBigInt
 *   - evaluate → UnsignedBigInt SValue
 *   - parse/serialize round-trip → byte-identical
 *
 * No fixture file needed: the wire bytes are short enough to compute by
 * hand and assert inline (§3 of the P2a spec gives the encoding rules;
 * the wire/sunsigned-bigint-codec.test.ts suite validates the codec
 * primitives in isolation).
 *
 * Wire format recap for an inline Const(SUnsignedBigInt) in a v6 tree:
 *   [header byte] [VLQ body size] [type-code 0x09] [VLQ length] [magnitude bytes, BE]
 *   - header 0x0b = version 3 WITH hasSize (bit 3) set, no segregation (bit 4).
 *     The size bit is REQUIRED on a version>0 header — a v3 / no-size header is
 *     JVM-invalid (rule-1012 CheckHeaderSizeBit, ValidationRules.scala:138-151,
 *     enforced at ErgoTreeSerializer.scala:219 before the body is parsed). The
 *     earlier 0x03 (no-size) header used here parsed only because ergots lacked
 *     that gate; it does not occur on any real v6 tree.
 *   - VLQ body size = byte length of (type-code + length + magnitude) = the body
 *   - type code 9 doubles as the Expr opcode (≤ LAST_CONSTANT_CODE=112)
 *   - length byte = number of magnitude bytes (0 for value 0)
 *
 * These tests must pass with ZERO production-code changes (Tasks 2–3
 * already wired the SType, SValue, codec, and parse/serialize arms).
 */

import { describe, it, expect } from 'vitest'
import { exprTpe } from '../../src/mir/expr-tpe'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { ErgoTree, Expr } from '../../src/mir/types'

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal v6 ErgoTree (version=3, hasSize) whose body is a single UBI
 * Const. The size bit is mandatory for version>0 (rule-1012); a v3/no-size
 * header is JVM-invalid and rejected at parse.
 */
function ubiConstTree(value: bigint): ErgoTree {
  return {
    header: {
      version: 3,
      hasSize: true,
      constantSegregation: false,
      rawHeader: 0x0b, // 0x08 (size) | 0x03 (version 3)
    },
    constantTypes: [],
    constants: [],
    body: {
      tag: 'Const',
      tpe: { tag: 'SUnsignedBigInt' },
      value: { kind: 'UnsignedBigInt', value },
    },
  }
}

// ── exprTpe ──────────────────────────────────────────────────────────────────

describe('SUnsignedBigInt constant — exprTpe', () => {
  it('returns SUnsignedBigInt for a UBI Const expr', () => {
    const c: Expr = {
      tag: 'Const',
      tpe: { tag: 'SUnsignedBigInt' },
      value: { kind: 'UnsignedBigInt', value: 5n },
    }
    expect(exprTpe(c)).toEqual({ tag: 'SUnsignedBigInt' })
  })

  it('returns SUnsignedBigInt for value 0n', () => {
    const c: Expr = {
      tag: 'Const',
      tpe: { tag: 'SUnsignedBigInt' },
      value: { kind: 'UnsignedBigInt', value: 0n },
    }
    expect(exprTpe(c)).toEqual({ tag: 'SUnsignedBigInt' })
  })
})

// ── evaluate ─────────────────────────────────────────────────────────────────

describe('SUnsignedBigInt constant — evaluate (v6 tree, version 3)', () => {
  it('evaluates to the UBI value 5n and charges cost 5', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const value = evaluateWith(ubiConstTree(5n), ctx)
    expect(value).toEqual({ kind: 'UnsignedBigInt', value: 5n })
    expect(ctx.jitCost).toBe(5)
  })

  it('evaluates to 0n (the zero case)', () => {
    const value = evaluate(ubiConstTree(0n), { treeVersion: 3 })
    expect(value).toEqual({ kind: 'UnsignedBigInt', value: 0n })
  })

  it('evaluates to 128n (high-bit value — differs from SBigInt wire encoding)', () => {
    const value = evaluate(ubiConstTree(128n), { treeVersion: 3 })
    expect(value).toEqual({ kind: 'UnsignedBigInt', value: 128n })
  })

  it('auto-derives treeVersion=3 from tree header (uses evaluate() without explicit opts.treeVersion)', () => {
    // evaluate() derives ctx.treeVersion from tree.header.version (2e contract).
    // The Const arm is version-agnostic, so this simply confirms the wiring.
    const value = evaluate(ubiConstTree(5n))
    expect(value).toEqual({ kind: 'UnsignedBigInt', value: 5n })
  })
})

// ── round-trip ───────────────────────────────────────────────────────────────

describe('SUnsignedBigInt constant — parse/serialize round-trip', () => {
  /**
   * Wire bytes for a v6 tree with a UBI Const body (size-bit header — required
   * for version>0 per rule-1012):
   *   0x0b              header (version=3, hasSize set, no segregation)
   *   <VLQ body size>   byte length of the body region that follows
   *   0x09              type code 9 (SUnsignedBigInt) = Expr opcode
   *   <VLQ len>         number of magnitude bytes
   *   <magnitude bytes> unsigned BE
   */

  it('round-trips value 5n: bytes [0x0b, 0x03, 0x09, 0x01, 0x05]', () => {
    // body = 09 01 05 (3 bytes) → size VLQ = 0x03
    const bytes = new Uint8Array([0x0b, 0x03, 0x09, 0x01, 0x05])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({
      tag: 'Const',
      tpe: { tag: 'SUnsignedBigInt' },
      value: { kind: 'UnsignedBigInt', value: 5n },
    })
    const reserialised = serializeTree(tree)
    expect(Array.from(reserialised)).toEqual(Array.from(bytes))
  })

  it('round-trips value 0n: bytes [0x0b, 0x02, 0x09, 0x00] (VLQ len 0, no value bytes)', () => {
    // 0 → empty magnitude → length byte 0, no value bytes. body = 09 00 (2 bytes)
    // → size VLQ = 0x02. This differs from SBigInt which emits [0x01, 0x00]
    // (len 1, byte 0x00) for the value-0 magnitude.
    const bytes = new Uint8Array([0x0b, 0x02, 0x09, 0x00])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({
      tag: 'Const',
      tpe: { tag: 'SUnsignedBigInt' },
      value: { kind: 'UnsignedBigInt', value: 0n },
    })
    const reserialised = serializeTree(tree)
    expect(Array.from(reserialised)).toEqual(Array.from(bytes))
  })

  it('round-trips value 128n: bytes [0x0b, 0x03, 0x09, 0x01, 0x80] (no sign-pad unlike SBigInt)', () => {
    // SBigInt would need [0x02, 0x00, 0x80] for 128. UBI emits no sign byte.
    // body = 09 01 80 (3 bytes) → size VLQ = 0x03.
    const bytes = new Uint8Array([0x0b, 0x03, 0x09, 0x01, 0x80])
    const tree = parseTree(bytes)
    expect(tree.body).toEqual({
      tag: 'Const',
      tpe: { tag: 'SUnsignedBigInt' },
      value: { kind: 'UnsignedBigInt', value: 128n },
    })
    const reserialised = serializeTree(tree)
    expect(Array.from(reserialised)).toEqual(Array.from(bytes))
  })

  it('programmatic build + serialize matches the expected bytes for 5n', () => {
    // Build the tree object by hand (not from bytes) and confirm serializeTree
    // produces the expected encoding — proves serializeSType + serializeSValue.
    const tree = ubiConstTree(5n)
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x0b, 0x03, 0x09, 0x01, 0x05])
  })

  it('programmatic build + serialize matches expected bytes for 0n', () => {
    const out = serializeTree(ubiConstTree(0n))
    expect(Array.from(out)).toEqual([0x0b, 0x02, 0x09, 0x00])
  })
})
