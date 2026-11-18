import { describe, it, expect } from 'vitest'
import { parseTree, ErgoTreeParseError } from '../src/wire/ergo-tree'
import { ExprParseError } from '../src/wire/parse'

/**
 * Completeness test — asserts each of the 16 reserved wire opcodes (in sigma-rust's OpCode enum but
 * never dispatched at the wire-Expr layer or implemented in `ergotree-interpreter/src/eval/`; the
 * JVM rejects them via `CheckValidOpCode`, rule 1002, since `getSerializer` returns null) hits the
 * parse-reject path with code 'opcode-reserved' and a message containing the human-readable opcode
 * name.
 *
 * The three ModQ opcodes (0xe7, 0xe8, 0xe9) left this group when ergots learned to read them, as
 * the JVM does (see test/wire/six-opcodes.test.ts and facts/ergoscript-wire.md's "The six opcodes
 * the JVM parses"). TrueLeaf (0x7f) and FalseLeaf (0x80) left it earlier for the Boolean-constant
 * arms. FlatMap (0xb8), TrivialPropFalse (0xd2) and TrivialPropTrue (0xd3) had thrown
 * 'not-implemented-yet' but were reclassified here: the JVM rejects all three via the same
 * reserved-opcode path. FlatMap's `flatMap` METHOD dispatches as a MethodCall/PropertyCall
 * (handled elsewhere); the TrivialProp pair ALSO exists at the SigmaBoolean-LEAF layer
 * (`SigmaPropCodes`, read by parseSigmaBoolean inside a SigmaPropConstant — a wholly separate,
 * legitimate path in wire/sigma-boolean.ts). Only the bare Expr opcode is rejected here. `FunDef`
 * (0xd7) left in v6 P6: it is now PARSED as a polymorphic ValDef carrying `tpeArgs`
 * (see test/wire/fun-def.test.ts).
 *
 * Defensive regression test — proves against silent regression if anyone later wires a stray
 * dispatch arm for these opcodes.
 *
 * Envelope form: `[0x00, opcode]` — header byte 0x00 (V0, no hasSize, no constant segregation)
 * followed by the bare opcode byte. All 16 opcode values are ≥ 129, well above LAST_CONSTANT_CODE
 * (112), so the inline-constant early-return in parseExpr does not intercept; dispatch fires on the
 * bare opcode. Matches the convention used by ergo-tree.test.ts:180. Without the size bit, the
 * tree parse wraps the soft-forkable reject as `ErgoTreeParseError('soft-fork-without-size-bit')`
 * with the `ExprParseError` as its `cause` (the JVM's SerializerException,
 * ErgoTreeSerializer.scala:204-207).
 *
 * NOT in scope: LastBlockUtxoRootHash (0xa6) left this group in F5 batch 4 — the JVM dispatches it
 * as its own case object, so ergots now parses it; see wire/mir/last-block-utxo-root-hash.ts.
 */

interface OpEntry {
  name: string
  opcode: number
}

const opcodes: OpEntry[] = [
  { name: 'UnitConstant', opcode: 0x81 },
  { name: 'Select1', opcode: 0x87 },
  { name: 'Select2', opcode: 0x88 },
  { name: 'Select3', opcode: 0x89 },
  { name: 'Select4', opcode: 0x8a },
  { name: 'Select5', opcode: 0x8b },
  // FlatMap (0xb8): bare opcode has no Expr-layer serializer (the `flatMap`
  // METHOD dispatches as a MethodCall/PropertyCall elsewhere).
  { name: 'FlatMap', opcode: 0xb8 },
  // TrivialPropFalse/True (0xd2/0xd3): bare Expr opcode rejected here; the
  // SigmaBoolean-LEAF form (inside a SigmaProp constant) is a separate path.
  { name: 'TrivialPropFalse', opcode: 0xd2 },
  { name: 'TrivialPropTrue', opcode: 0xd3 },
  // FunDef (0xd7) removed in v6 P6 — now parsed as a tpeArgs-carrying ValDef.
  { name: 'SomeValue', opcode: 0xde },
  { name: 'NoneValue', opcode: 0xdf },
  { name: 'CollShiftRight', opcode: 0xf9 },
  { name: 'CollShiftLeft', opcode: 0xfa },
  { name: 'CollShiftRightZeroed', opcode: 0xfb },
  { name: 'CollRotateLeft', opcode: 0xfc },
  { name: 'CollRotateRight', opcode: 0xfd },
]

describe("parse-reject completeness — 16 'opcode-reserved' wire sites", () => {
  it('the fixture set has exactly 16 entries (guard against silent regression)', () => {
    expect(opcodes.length).toBe(16)
  })

  describe.each(opcodes)(
    '$name (0x$opcode)',
    ({ name, opcode }) => {
      it("rejects with ExprParseError 'opcode-reserved' (the cause of the unsized wrap)", () => {
        const bytes = new Uint8Array([0x00, opcode])
        try {
          parseTree(bytes)
          throw new Error(`parseTree(${name}) should have thrown`)
        } catch (e) {
          // The tree has no size bit, so the soft-forkable reject is wrapped, as the JVM
          // wraps its ValidationException in a SerializerException
          // (ErgoTreeSerializer.scala:204-207); the body's reject is the cause.
          expect(e).toBeInstanceOf(ErgoTreeParseError)
          expect((e as ErgoTreeParseError).code).toBe('soft-fork-without-size-bit')
          const cause = (e as Error).cause
          expect(cause).toBeInstanceOf(ExprParseError)
          expect((cause as ExprParseError).code).toBe('opcode-reserved')
          expect((cause as Error).message).toContain(name)
        }
      })
    },
  )
})
