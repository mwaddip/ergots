// SANTA JVM-blessed Box vectors for the JVM's node construction at parse (sigma-state 6.0.6), santa
// 7e2f5f4 (Box.tree_parse_acceptance #0-#24 unchanged from 3f75e14, #25-#47 appended;
// Box.tree_bool_pair_form unchanged), replayed as Dasher does: parseSValue(SBox) then
// serializeSValue(SBox); the expected bytes are expected_bytes_hex ?? bytes_hex. Each errored entry's
// reject is pinned below by class and code; the entries ergots still diverges on are pinned as
// divergences, so the test flips when one closes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { ErgoTreeParseError } from '../../src/wire/ergo-tree'
import { ExprParseError } from '../../src/wire/errors'
import { ExprTpeError } from '../../src/mir/expr-tpe'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

interface Entry {
  name: string
  bytes_hex: string
  expected_bytes_hex?: string
  error?: string
  version: { activated: number; ergoTree: number }
}
type ErrorClass = new (...args: never[]) => Error
interface Reject { cls: ErrorClass; code: string; cause?: string }

const FILES: [string, number][] = [['Box.tree_parse_acceptance.json', 48], ['Box.tree_bool_pair_form.json', 14]]

// Each errored entry's reject: the construction check that fails, as each entry's description gives it.
const BIT_OP: Reject = { cls: ExprParseError, code: 'bit-op-operand-not-numeric' }
const ERRORS: Record<string, Reject> = {
  // Append and Slice cast their input's type to SCollection as they are built (transformers.scala:62, 89).
  'box-e1-append-on-int-reject#6': { cls: ExprTpeError, code: 'append-input-not-scoll' },
  'box-e1-append-on-int-sized-reject#7': { cls: ExprTpeError, code: 'append-input-not-scoll' },
  'box-e2-slice-on-int-reject#8': { cls: ExprTpeError, code: 'slice-input-not-scoll' },
  'box-e2-slice-on-int-sized-reject#9': { cls: ExprTpeError, code: 'slice-input-not-scoll' },
  // check2(SameType) with no upcast from v3 (SigmaBuilder.scala:686-693, 757-758).
  'box-l1-eq-int-long-v3-reject#11': { cls: ExprParseError, code: 'relation-operand-type-mismatch' },
  // check2(OnlyNumeric) (SigmaBuilder.scala:696-704).
  'box-l2-gt-boolean-reject#14': { cls: ExprParseError, code: 'relation-operand-not-numeric' },
  'box-l2-gt-boolean-sized-reject#15': { cls: ExprParseError, code: 'relation-operand-not-numeric' },
  // BitOp's require (trees.scala:913).
  'box-l3-bitor-boolean-reject#17': BIT_OP,
  'box-l3-bitor-boolean-sized-reject#18': BIT_OP,
  'box-bitor-on-bool-collections-reject#8': BIT_OP,
  'box-bitand-on-bool-collections-reject#9': BIT_OP,
  'box-bitxor-on-bool-collections-reject#10': BIT_OP,
  'box-bitor-on-bool-collections-sized-reject#11': BIT_OP,
  'box-bitand-on-bool-collections-sized-reject#12': BIT_OP,
  'box-bitxor-on-bool-collections-sized-reject#13': BIT_OP,
  // The item assert, after each item and before the next (ConcreteCollectionSerializer.scala:35-39): an
  // AssertionError, which a sized tree does not degrade on (#21).
  'box-coll-item-wrong-type-reject#20': { cls: ExprParseError, code: 'collection-item-type-mismatch' },
  'box-coll-item-wrong-type-sized-reject#21': { cls: ExprParseError, code: 'collection-item-type-mismatch' },
  // Upcast's and Downcast's require of a numeric input (trees.scala:398, 431), at a sized root (#25-#28)
  // and before a later read past the window (#46): an IllegalArgumentException, never a degrade.
  'box-upcast-true-long-sized-root-reject#25': { cls: ExprParseError, code: 'numeric-cast-input-not-numeric' },
  'box-upcast-coll-int-long-sized-root-reject#26': { cls: ExprParseError, code: 'numeric-cast-input-not-numeric' },
  'box-downcast-true-byte-sized-root-reject#27': { cls: ExprParseError, code: 'numeric-cast-input-not-numeric' },
  'box-downcast-coll-int-byte-sized-root-reject#28': { cls: ExprParseError, code: 'numeric-cast-input-not-numeric' },
  'box-order-upcast-true-then-window-reject#46': { cls: ExprParseError, code: 'numeric-cast-input-not-numeric' },
  // NumericCastSerializer's asNumType of the target type (NumericCastSerializer.scala:22): a ClassCastException.
  'box-upcast-boolean-target-sized-root-reject#30': { cls: ExprParseError, code: 'numeric-cast-target-not-numeric' },
  // The item assert (ConcreteCollectionSerializer.scala:38): from v3 Plus(Int, Long) is an Int.
  'box-v3-coll-long-plus-int-long-reject#32': { cls: ExprParseError, code: 'collection-item-type-mismatch' },
  // Before v3 the index is upcast to Int as it is read (ByIndexSerializer.scala:29-33): a Long fails.
  'box-v0-byindex-long-index-reject#33': { cls: ExprParseError, code: 'by-index-index-not-int' },
  // Each BlockValue item is cast to BlockItem as it is read (BlockValueSerializer.scala:39).
  'box-blockvalue-int-item-reject#35': { cls: ExprParseError, code: 'block-value-item-not-val-def' },
  'box-blockvalue-int-item-sized-reject#36': { cls: ExprParseError, code: 'block-value-item-not-val-def' },
  // findRegisterByIndex(id).get right after the id byte (ExtractRegisterAsSerializer.scala:28,
  // DeserializeRegisterSerializer.scala:28): a NoSuchElementException outside 0..9.
  'box-extract-register-as-id-10-reject#38': { cls: ExprParseError, code: 'extract-register-as-id-out-of-range' },
  'box-extract-register-as-id-0x80-reject#39': { cls: ExprParseError, code: 'extract-register-as-id-out-of-range' },
  'box-deserialize-register-id-10-reject#41': { cls: ExprParseError, code: 'deserialize-register-id-out-of-range' },
  // From v3, assert(args.nonEmpty) (MethodCallSerializer.scala:53-55).
  'box-v3-methodcall-no-args-reject#43': { cls: ExprParseError, code: 'method-call-empty-args' },
}

// The entries ergots still diverges on, each with its residual, and what ergots does instead.
const KNOWN_RESIDUAL: Record<string, { residual: string; ergots: Reject | 'accepts' }> = {
  // The JVM parses TrueLeaf (7f) and FalseLeaf (80) as Boolean constants; ergots rejects the opcodes,
  // soft-forkably, so an unsized tree rejects.
  'box-c3-trueleaf-opcode-accept#2': {
    residual: 'residual 5 (facts/ergoscript-wire.md, the opcode-reserved entry)',
    ergots: { cls: ErgoTreeParseError, code: 'soft-fork-without-size-bit', cause: 'opcode-reserved' },
  },
  'box-c3-falseleaf-opcode-accept#3': {
    residual: 'residual 5 (facts/ergoscript-wire.md, the opcode-reserved entry)',
    ergots: { cls: ErgoTreeParseError, code: 'soft-fork-without-size-bit', cause: 'opcode-reserved' },
  },
}

function roundTrip(e: Entry): string {
  const v = parseSValue({ tag: 'SBox' }, e.version.ergoTree, new ByteReader(hex(e.bytes_hex)))
  const w = new ByteWriter()
  serializeSValue({ tag: 'SBox' }, v, e.version.ergoTree, w)
  return toHex(w.toBytes())
}

function expectReject(e: Entry, want: Reject): void {
  let err: unknown
  try {
    roundTrip(e)
  } catch (x) {
    err = x
  }
  expect(err, `${e.name}: expected a reject`).toBeInstanceOf(want.cls)
  expect((err as { code?: string }).code).toBe(want.code)
  if (want.cause !== undefined) expect(((err as Error).cause as { code?: string }).code).toBe(want.cause)
}

for (const [file, count] of FILES) {
  describe(`SANTA ${file} (jvm:sigma-state-6.0.6, santa 7e2f5f4)`, () => {
    const entries: Entry[] = JSON.parse(readFileSync(join(__dirname, '../fixtures/conformance/wire', file), 'utf8')).entries
    it(`holds ${count} entries`, () => expect(entries.length).toBe(count))
    for (const e of entries) {
      const known = KNOWN_RESIDUAL[e.name]
      if (known !== undefined) {
        it(`${e.name}: still diverges (${known.residual})`, () => {
          if (known.ergots === 'accepts') {
            expect(e.error).toBe('errored')
            expect(roundTrip(e)).toBe(e.bytes_hex)
          } else {
            expect(e.error).toBeUndefined()
            expectReject(e, known.ergots)
          }
        })
        continue
      }
      it(e.name, () => {
        if (e.error === 'errored') {
          const want = ERRORS[e.name]
          expect(want, `no reject pinned for ${e.name}`).toBeDefined()
          expectReject(e, want!)
        } else {
          expect(roundTrip(e)).toBe(e.expected_bytes_hex ?? e.bytes_hex)
        }
      })
    }
  })
}
