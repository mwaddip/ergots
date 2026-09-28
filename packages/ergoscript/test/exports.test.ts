import { describe, it, expect } from 'vitest'
import * as pkg from '../src'
import { parseTree, ExprParseError } from '../src'

/**
 * Public error-class surface for @ergots/ergoscript.
 *
 * facts/ergoscript-wire.md documents the wire parse/serialize error classes as
 * a uniform surface — each `extends Error` with a `code` — and they escape the
 * package boundary UNWRAPPED: a body-parse reject surfaces `ExprParseError`, an
 * SType reject surfaces `STypeParseError`, etc. (the envelope does not re-wrap
 * them; callers see the typed failure from the innermost rejecting layer).
 *
 * So any consumer that classifies ergots failures by type — e.g. SANTA's
 * conformance ts-runner mapping a typed parse refusal to `errored` rather than
 * the panic-net — must be able to `import` and `instanceof` them from the
 * package root. Four had drifted out of `index.ts`: `ExprParseError` /
 * `ExprSerializeError` (the leaf `wire/errors.ts`) and `STypeParseError` /
 * `STypeSerializeError` (the `parseSType`/`serializeSType` peers — the functions
 * were exported but their error types weren't). A body-parse `ExprParseError`
 * was therefore uncatchable by type downstream. This pins the full wire
 * parse/serialize error surface to the facts taxonomy.
 *
 * The mir-layer type-inference error `ExprTpeError` is root-exported too, since
 * 2026-09-28: rule 1001 lets it escape a box-rules parse as a hard reject
 * (facts/ergoscript-wire.md, "Rule 1001 on the box paths"). scorex's
 * `ReaderError` is deliberately NOT part of this guarantee — a different package.
 */
describe('@ergots/ergoscript public error-class surface', () => {
  it('root-exports every wire parse/serialize error class in the facts taxonomy', () => {
    for (const name of [
      'ErgoTreeParseError',
      'ErgoTreeSerializeError',
      'ExprParseError',
      'ExprSerializeError',
      'STypeParseError',
      'STypeSerializeError',
      'SValueParseError',
      'SValueSerializeError',
      'SigmaBooleanParseError',
      'SigmaBooleanSerializeError',
    ]) {
      expect(
        (pkg as Record<string, unknown>)[name],
        `${name} must be root-exported`,
      ).toBeTypeOf('function')
    }
  })

  it('root-exports ExprTpeError, which rule 1001 lets escape a box-rules parse', () => {
    expect((pkg as Record<string, unknown>).ExprTpeError).toBeTypeOf('function')
  })

  it('root-exports the box-tree and box-bytes surface (facts/ergoscript-wire.md, "Box trees")', () => {
    for (const name of ['boxTreeOf', 'reencodeTreeBytes', 'seedBoxTree', 'boxIdOf', 'boxBytesOf']) {
      expect((pkg as Record<string, unknown>)[name], `${name} must be root-exported`).toBeTypeOf('function')
    }
  })

  it('root-exports the JVM rules @ergots/transaction applies from here', () => {
    // facts/ergoscript-wire.md "Shared rules for @ergots/transaction": the context-extension leg
    // of rule-1019 CheckV6Type, and storage-rent register equality.
    const { violatesCheckV6Type, sValueStructuralEq } = pkg as Record<string, unknown>
    expect(violatesCheckV6Type).toBeTypeOf('function')
    expect(sValueStructuralEq).toBeTypeOf('function')
  })

  it('a body-parse reject from parseTree is catchable as the root-exported ExprParseError', () => {
    // [0x00, 0xd7, 0x01, 0x80] = ErgoTree header V0 (no hasSize, no segregation) +
    // FunDef (0xd7), id 1, type-arg count 0x80: the FunDef nTpeArgs-128 reject SANTA's
    // runner must classify as `errored`, not panicked. parseTree's body parser rejects
    // it with ExprParseError('fun-def-tpe-args-out-of-range'), a hard reject (the JVM's
    // signed getByte into safeNewArray, ValDefSerializer.scala:38-39), so it surfaces
    // unwrapped. (A soft-forkable reject in a tree without the size bit, e.g. the bare
    // opcode 0xfd, CollRotateRight, which fails the JVM's CheckValidOpCode (rule 1002), surfaces
    // as ErgoTreeParseError('soft-fork-without-size-bit') with the ExprParseError as its cause,
    // as the JVM wraps it; ErgoTreeSerializer.scala:204-207.)
    let caught: unknown
    try {
      parseTree(new Uint8Array([0x00, 0xd7, 0x01, 0x80]))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ExprParseError)
    expect((caught as ExprParseError).code).toBe('fun-def-tpe-args-out-of-range')
  })
})
