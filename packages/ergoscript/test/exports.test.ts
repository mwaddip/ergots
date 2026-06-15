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
 * NOTE: the mir-layer type-inference error `ExprTpeError` and scorex's
 * `ReaderError` are deliberately NOT part of this guarantee — different layers.
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

  it('a body-parse reject from parseTree is catchable as the root-exported ExprParseError', () => {
    // [0x00, 0x7f] = ErgoTree header V0 (no hasSize, no segregation) + the bare
    // reserved opcode OpTrue (0x7f). parseTree's body parser rejects it with
    // ExprParseError('opcode-reserved') — the same typed surface as the FunDef
    // nTpeArgs-128 reject SANTA's runner must classify as `errored`, not panicked.
    let caught: unknown
    try {
      parseTree(new Uint8Array([0x00, 0x7f]))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ExprParseError)
  })
})
