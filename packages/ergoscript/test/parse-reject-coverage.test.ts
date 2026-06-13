import { describe, it, expect } from 'vitest'
import { parseTree } from '../src/wire/ergo-tree'
import { ExprParseError } from '../src/wire/parse'

/**
 * Phase 2i-d completeness test — asserts each of the 21 reserved wire
 * opcodes (in sigma-rust's OpCode enum but never dispatched at the wire-Expr
 * layer or implemented in `ergotree-interpreter/src/eval/`; the JVM rejects
 * each identically via `CheckValidOpCode`, rule 1002, since `getSerializer`
 * returns null) hits the parse-reject path with code 'opcode-reserved' and a
 * message containing the human-readable opcode name.
 *
 * Was 18 — FlatMap (0xb8), TrivialPropFalse (0xd2), TrivialPropTrue (0xd3)
 * were reclassified into this group: they had thrown 'not-implemented-yet',
 * but the JVM rejects all three via the SAME reserved-opcode path as the
 * other 18 (no registered serializer → CheckValidOpCode). FlatMap's `flatMap`
 * METHOD dispatches as a MethodCall/PropertyCall (handled elsewhere); the
 * TrivialProp pair ALSO exists at the SigmaBoolean-LEAF layer (`SigmaPropCodes`,
 * read by parseSigmaBoolean inside a SigmaPropConstant — a wholly separate,
 * legitimate path in wire/sigma-boolean.ts). Only the bare Expr opcode is
 * rejected here. Before that it was 19 — `FunDef` (0xd7) was removed in v6 P6:
 * it is now PARSED as a polymorphic ValDef carrying `tpeArgs` (see
 * test/wire/fun-def.test.ts and facts/ergoscript-wire.md's P6 wire section).
 *
 * Defensive regression test — proves against silent regression if anyone
 * later wires a stray dispatch arm for these opcodes.
 *
 * Envelope form: `[0x00, opcode]` — header byte 0x00 (V0, no hasSize, no
 * constant segregation) followed by the bare opcode byte. All 21 opcode
 * values are ≥ 127, well above LAST_CONSTANT_CODE (112), so the inline-
 * constant early-return in parseExpr does not intercept; dispatch fires
 * on the bare opcode. Matches the convention used by ergo-tree.test.ts:180.
 *
 * NOT in scope: LastBlockUtxoRootHash (0xa6) left this group in F5 batch 4 —
 * the JVM dispatches it as its own case object, so ergots now parses it; see
 * wire/mir/last-block-utxo-root-hash.ts.
 */

interface OpEntry {
  name: string
  opcode: number
}

const opcodes: OpEntry[] = [
  { name: 'OpTrue', opcode: 0x7f },
  { name: 'OpFalse', opcode: 0x80 },
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
  { name: 'ModQ', opcode: 0xe7 },
  { name: 'PlusModQ', opcode: 0xe8 },
  { name: 'MinusModQ', opcode: 0xe9 },
  { name: 'CollShiftRight', opcode: 0xf9 },
  { name: 'CollShiftLeft', opcode: 0xfa },
  { name: 'CollShiftRightZeroed', opcode: 0xfb },
  { name: 'CollRotateLeft', opcode: 0xfc },
  { name: 'CollRotateRight', opcode: 0xfd },
]

describe("parse-reject completeness — 21 'opcode-reserved' wire sites", () => {
  it('the fixture set has exactly 21 entries (guard against silent regression)', () => {
    expect(opcodes.length).toBe(21)
  })

  describe.each(opcodes)(
    '$name (0x$opcode)',
    ({ name, opcode }) => {
      it("throws ExprParseError with code 'opcode-reserved'", () => {
        const bytes = new Uint8Array([0x00, opcode])
        try {
          parseTree(bytes)
          throw new Error(`parseTree(${name}) should have thrown`)
        } catch (e) {
          expect(e).toBeInstanceOf(ExprParseError)
          expect((e as ExprParseError).code).toBe('opcode-reserved')
          expect((e as Error).message).toContain(name)
        }
      })
    },
  )
})
