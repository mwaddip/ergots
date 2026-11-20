// SANTA JVM-blessed ErgoTree-tier tuple vectors (jvm:sigma-state-6.0.7, santa bd264f2;
// vectors/wire/v6/authored/{ErgoTree.small_tuples,ErgoTree.non_pair_tuple_operand}.json): bytes
// a node reads at the tree layer, replayed as Dasher does for the Box tier: parseTree then
// serializeTree; the expected bytes are expected_bytes_hex ?? bytes_hex. Each errored entry's
// reject is pinned by class and code; a TypeWrite row (the JVM parses the bytes and refuses on
// the WRITE) is pinned in WRITE_REJECTS, which asserts the parse succeeds and the serialize
// throws — so a drift to a parse-side refusal inside a sized tree (which would degrade and
// over-accept) would flip the test. The Box runner (santa-box-construction.test.ts) pins the
// same families on the enclosing box; this file pins the tree envelope on its own.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { ExprParseError } from '../../src/wire/errors'
import { STypeSerializeError } from '../../src/wire/serialize-stype'

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
interface Reject { cls: ErrorClass; code: string }

const FILES: [string, number][] = [
  ['ErgoTree.small_tuples.json', 20],
  ['ErgoTree.non_pair_tuple_operand.json', 8],
]

// Parse-side rejects.
const ERRORS: Record<string, Reject> = {
  // ErgoTree.small_tuples.json. 128-item Tuple expression: TupleSerializer.scala:28 reads the count
  // via signed getByte, so 0x80 is -128 and `safeNewArray` throws NegativeArraySizeException
  // (sigma/util/package.scala:9-13 bounds only the upper end); not a ValidationException, no degrade.
  // ergots mirrors: its parse rejects 128 and above on the lead byte (`wire/mir/tuple.ts:70-83`).
  'small-tuple-tuple_expr_128_items-v0-tree#10': { cls: ExprParseError, code: 'tuple-arity-out-of-range' },
  'small-tuple-tuple_expr_128_items-v3-tree#11': { cls: ExprParseError, code: 'tuple-arity-out-of-range' },
  // ErgoTree.non_pair_tuple_operand.json. The deserialization builder's `check2(SameType)` refuses
  // an SAny operand against a concrete type (SigmaBuilder.scala:691, ConstraintFailed, not a
  // ValidationException, no degrade) — the unsized row #1 is the no-degrade pin.
  // `comparisonOp`'s `check2(OnlyNumeric)` refuses an SAny operand under a comparison (`:699`),
  // including an SAny vs SAny row (where SameType is satisfied).
  'non-pair-tuple-operand-eq-any-concrete-v3-tree#0': { cls: ExprParseError, code: 'relation-operand-type-mismatch' },
  'non-pair-tuple-operand-eq-any-concrete-v0-tree#1': { cls: ExprParseError, code: 'relation-operand-type-mismatch' },
  'non-pair-tuple-operand-gt-any-concrete-v3-tree#2': { cls: ExprParseError, code: 'relation-operand-not-numeric' },
  'non-pair-tuple-operand-gt-any-any-v3-tree#3': { cls: ExprParseError, code: 'relation-operand-not-numeric' },
  'non-pair-tuple-operand-gt-any-any-v0-tree#4': { cls: ExprParseError, code: 'relation-operand-not-numeric' },
}

// TypeWrite rows. The JVM PARSES a one-item or zero-item tuple TYPE (TypeSerializer.scala:188-194,
// `getUByte`, no arity require) and REFUSES on the WRITE (TypeSerializer.scala:93-95, `sys.error`).
// ergots mirrors: parseSType takes 0..255 (`wire/parse-stype.ts:212-217`), serializeSType throws
// `STypeSerializeError('tuple-too-short')` on < 2 (`wire/serialize-stype.ts:231-236`). At tree
// version 3 an implementation that refused at parse would DEGRADE the sized tree to an unparsed one
// and over-accept the carrier — the finding's separating row. The pin below asserts the parse
// succeeds and the SERIALIZE throws.
const WRITE_REJECTS: Record<string, Reject> = {
  'small-tuple-const_one_item_type-v0-tree#0': { cls: STypeSerializeError, code: 'tuple-too-short' },
  'small-tuple-const_one_item_type-v3-tree#1': { cls: STypeSerializeError, code: 'tuple-too-short' },
  'small-tuple-const_zero_item_type-v0-tree#2': { cls: STypeSerializeError, code: 'tuple-too-short' },
  'small-tuple-const_zero_item_type-v3-tree#3': { cls: STypeSerializeError, code: 'tuple-too-short' },
}

// The entries ergots still diverges on, each with its residual, and what ergots does instead.
const KNOWN_RESIDUAL: Record<string, { residual: string; ergots: Reject | 'accepts' }> = {}

function roundTripTree(e: Entry): string {
  const tree = parseTree(hex(e.bytes_hex))
  return toHex(serializeTree(tree))
}

function expectReject(e: Entry, want: Reject): void {
  let err: unknown
  try {
    roundTripTree(e)
  } catch (x) {
    err = x
  }
  expect(err, `${e.name}: expected a reject`).toBeInstanceOf(want.cls)
  expect((err as { code?: string }).code).toBe(want.code)
}

/**
 * Parse SUCCEEDS, the write refuses with the pinned class and code. Pins the stage of the refusal
 * for the TypeWrite rows: the JVM's `TypeSerializer` parses the one-item or zero-item tuple type
 * (TypeSerializer.scala:188-194) and dies on the write (:93-95); a parse-side refusal at tree
 * version 3 would degrade the sized tree and over-accept, so the stage matters.
 */
function expectWriteReject(e: Entry, want: Reject): void {
  const tree = parseTree(hex(e.bytes_hex))
  let err: unknown
  try {
    serializeTree(tree)
  } catch (x) {
    err = x
  }
  expect(err, `${e.name}: expected a write-side reject`).toBeInstanceOf(want.cls)
  expect((err as { code?: string }).code).toBe(want.code)
}

for (const [file, count] of FILES) {
  const data = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/conformance/wire', file), 'utf8'),
  ) as { blessed_by: string; entries: Entry[] }
  describe(`SANTA ${file} (${data.blessed_by})`, () => {
    const entries: Entry[] = data.entries
    it(`holds ${count} entries`, () => expect(entries.length).toBe(count))
    for (const e of entries) {
      const known = KNOWN_RESIDUAL[e.name]
      if (known !== undefined) {
        it(`${e.name}: still diverges (${known.residual})`, () => {
          if (known.ergots === 'accepts') {
            expect(e.error).toBe('errored')
            expect(roundTripTree(e)).toBe(e.bytes_hex)
          } else {
            expect(e.error).toBeUndefined()
            expectReject(e, known.ergots)
          }
        })
        continue
      }
      it(e.name, () => {
        if (e.error === 'errored') {
          const writeReject = WRITE_REJECTS[e.name]
          if (writeReject !== undefined) {
            expectWriteReject(e, writeReject)
            return
          }
          const want = ERRORS[e.name]
          expect(want, `no reject pinned for ${e.name}`).toBeDefined()
          expectReject(e, want!)
        } else {
          expect(roundTripTree(e)).toBe(e.expected_bytes_hex ?? e.bytes_hex)
        }
      })
    }
  })
}
