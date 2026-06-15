/**
 * Context extension key domain (self) — JVM toSigmaContext [0,127]. (v6 batch-6, Ask 20.)
 *
 * The JVM consumes the SELF context extension via `ErgoLikeContext.toSigmaContext`
 * → `contextVars` (ErgoLikeContext.scala:140-147): `res = new Array(maxKey+1);
 * res(key) = v` for each `Map[Byte]` key. A key whose wire byte is >= 0x80 parses to
 * a negative Scala Byte, so `res(negative)` (or `new Array(negative)`) crashes
 * (ArrayIndexOutOfBounds / NegativeArraySize) — the JVM rejects the context BEFORE
 * reduction, regardless of whether the script reads that var. ergots keys
 * `ctx.extension` by unsigned number, so we guard the [0,127] domain at the eval
 * entry (the toSigmaContext-equivalent point). Boundary 127 accept / 128 reject.
 * Adversarial-only (honest extension keys are small).
 *
 * NOTE per-input extensions (`ctx.inputExtensions`) are NOT guarded: getVarFromInput
 * reads `Map[Byte].get` directly (no array), so they are byte-identity 0..255 — see
 * context-get-var-from-input.test.ts (key 255 == Byte -1, valid).
 */
import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes } from '../_helpers'
import type { SType, SValue } from '../../src/mir/types'

// v0 tree, body = Const SInt(5): header 0x00 + SInt type code 0x04 + ZigZag VLQ 5 (0x0a).
// Reads neither the self extension nor inputExtensions, so eval succeeds whenever the
// context-key guard passes — isolating the guard from any var lookup.
const TRIVIAL = parseTree(hexToBytes('00040a'))
const ENTRY = { tpe: { tag: 'SInt' } as SType, value: { kind: 'Int', value: 7 } as SValue }

describe('context extension key domain (self) — JVM toSigmaContext [0,127]', () => {
  it('accepts self-extension key 127 (the inclusive boundary)', () => {
    expect(() => evaluate(TRIVIAL, { extension: { values: { 127: ENTRY } } })).not.toThrow()
  })

  it('rejects self-extension key 128 with context-extension-key-out-of-range', () => {
    let err: unknown
    try {
      evaluate(TRIVIAL, { extension: { values: { 128: ENTRY } } })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EvalError)
    expect((err as EvalError).code).toBe('context-extension-key-out-of-range')
  })

  it('rejects self-extension key 255 (JVM Byte -1 also crashes toSigmaContext)', () => {
    let err: unknown
    try {
      evaluate(TRIVIAL, { extension: { values: { 255: ENTRY } } })
    } catch (e) {
      err = e
    }
    expect((err as EvalError).code).toBe('context-extension-key-out-of-range')
  })

  it('does NOT guard inputExtensions (getVarFromInput byte-identity 0..255)', () => {
    expect(() =>
      evaluateWith(TRIVIAL, makeContext({ inputExtensions: [{ values: { 255: ENTRY } }] }))
    ).not.toThrow()
  })
})
