// A box's bytes under a tree version. The JVM writes a box's registers as values under the version context in
// force: a function type is written from tree version 3 (sigma-state TypeSerializer.scala:112), and below it
// the type writer has no case for one (a scala.MatchError). ergo-core validates an output through its bytes, written
// outside any version context, where the tree version is 1 (ErgoTransaction.scala:171, :175; ErgoBox.scala:87-92;
// VersionContext.scala:58-61).
//
// Each row is a sigma-state 6.0.6 answer: ErgoBox.sigmaSerializer.parse under the first pair, then
// ErgoBox.sigmaSerializer.toBytes under the second, or outside any context (tree version 1). F is the empty
// Coll[Int => Int] constant, `0c 70 01 04 04 00 00`.
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeBoxAtTreeVersion } from '../../src/wire/ergo-box-bytes'
import { isTypeWrittenAt, STypeSerializeError } from '../../src/wire/serialize-stype'
import type { ErgoBox, SType } from '../../src/mir/types'
import * as pkg from '../../src'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

type Row = [name: string, activated: number, ergoTree: number, writeTreeVersion: number, where: string,
  jvm: 'written' | 'no-encoding', boxHex: string]

function readBox(boxHex: string, activated: number, ergoTree: number): ErgoBox {
  const r = new ByteReader(hex(boxHex))
  r.activatedVersion = activated
  const v = parseSValue({ tag: 'SBox' }, ergoTree, r)
  expect(r.isExhausted).toBe(true)
  return (v as { kind: 'Box'; value: ErgoBox }).value
}

const ROWS: Row[] = [
  ['R4 = F', 3, 3, 1, 'outside any context', 'no-encoding',
    'c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = F', 3, 3, 1, '(1, 1)', 'no-encoding',
    'c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = F: the control', 3, 3, 3, '(3, 3)', 'written',
    'c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = F', 3, 3, 0, '(3, 0)', 'no-encoding',
    'c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = F', 3, 3, 2, '(3, 2)', 'no-encoding',
    'c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = F', 4, 4, 1, 'outside any context', 'no-encoding',
    'c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = an Int: the control', 3, 3, 1, 'outside any context', 'written',
    'c0843d0008d301000104021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Box whose own R4 is F', 3, 3, 3, '(3, 3)', 'written',
    'c0843d0008d301000163c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d664001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Box whose own R4 is F', 3, 3, 1, 'outside any context', 'no-encoding',
    'c0843d0008d301000163c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d664001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Coll[Box] of that box', 3, 3, 1, 'outside any context', 'no-encoding',
    'c0843d0008d30100010c6301c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d664001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = F in a box whose own tree is a sized v3 tree', 3, 3, 1, 'outside any context', 'no-encoding',
    'c0843d0b0208d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = F in a box whose own tree is a sized v3 tree', 3, 3, 3, '(3, 3)', 'written',
    'c0843d0b0208d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Tuple node (F, Int 1)', 3, 3, 1, 'outside any context', 'no-encoding',
    'c0843d0008d301000186020c70010404000004021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Tuple node (F, Int 1)', 3, 3, 3, '(3, 3)', 'written',
    'c0843d0008d301000186020c70010404000004021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Tuple node (Int 1, Int 2): the control', 3, 3, 1, 'outside any context', 'written',
    'c0843d0008d30100018602040204041d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = Int 1 and R5 = F', 3, 3, 1, 'outside any context', 'no-encoding',
    'c0843d0008d301000204020c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Coll[Coll[Int => Int]] of one empty collection', 3, 3, 1, 'outside any context', 'no-encoding',
    'c0843d0008d30100010c0c700104040001001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Coll[Coll[Int => Int]] of one empty collection', 3, 3, 3, '(3, 3)', 'written',
    'c0843d0008d30100010c0c700104040001001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Tuple node (a Box whose R4 is F, Int 1)', 3, 3, 1, 'outside any context', 'no-encoding',
    'c0843d0008d3010001860263c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d6640004021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = a Tuple node (a Box whose R4 is F, Int 1)', 3, 3, 3, '(3, 3)', 'written',
    'c0843d0008d3010001860263c0843d0008d30100010c7001040400001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d6640004021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
]

describe("a box's bytes under a tree version", () => {
  it.each(ROWS)('%s: parsed under (%i, %i), written at tree version %i, %s: %s', (_name, activated, ergoTree, writeTreeVersion, _where, jvm, boxHex) => {
    const box = readBox(boxHex, activated, ergoTree)
    if (jvm === 'written') {
      expect(toHex(serializeBoxAtTreeVersion(box, writeTreeVersion))).toBe(boxHex)   // the JVM's round trip is the identity
      return
    }
    let err: unknown
    try { serializeBoxAtTreeVersion(box, writeTreeVersion) } catch (e) { err = e }
    expect(err).toBeInstanceOf(STypeSerializeError)
    expect((err as STypeSerializeError).code).toBe('sfunc-tree-version-too-low')
  })

  it('serializeBoxAtTreeVersion is exported from the package', () => {
    expect((pkg as Record<string, unknown>).serializeBoxAtTreeVersion).toBeTypeOf('function')
    expect((pkg as Record<string, unknown>).serializeBoxAtTreeVersion).toBe(serializeBoxAtTreeVersion)
  })

  it('a register entry that carries no type is a TypeError that names the register', () => {
    // A box built by hand can hold a register entry without its type.
    const box = readBox(ROWS.find(([name]) => name.startsWith('R4 = an Int'))![6], 3, 3)
    const untyped: ErgoBox = { ...box, registers: { ...box.registers, 5: { opaqueBytes: hex('0402') } as never } }
    for (const treeVersion of [1, 3]) {
      expect(() => serializeBoxAtTreeVersion(untyped, treeVersion)).toThrow(TypeError)
      expect(() => serializeBoxAtTreeVersion(untyped, treeVersion)).toThrow(/^R5: /)
    }
  })
})

describe('isTypeWrittenAt: a function type is written from tree version 3', () => {
  const INT: SType = { tag: 'SInt' }
  const FUNC: SType = { tag: 'SFunc', args: [INT], result: INT, tpeParams: [] }
  const coll = (elem: SType): SType => ({ tag: 'SColl', elem })
  const TYPES: [string, SType, boolean][] = [
    ['Int', INT, true],
    ['Box', { tag: 'SBox' }, true],
    ['Coll[Byte]', coll({ tag: 'SByte' }), true],
    ['(Int, Coll[Box])', { tag: 'STuple', items: [INT, coll({ tag: 'SBox' })] }, true],
    ['Int => Int', FUNC, false],
    ['Coll[Int => Int]', coll(FUNC), false],
    ['Coll[Coll[Int => Int]]', coll(coll(FUNC)), false],
    ['Option[Int => Int]', { tag: 'SOption', elem: FUNC }, false],
    ['(Int, Coll[Int => Int])', { tag: 'STuple', items: [INT, coll(FUNC)] }, false],
  ]
  it.each(TYPES)('%s', (_name, tpe, belowV3) => {
    for (const v of [0, 1, 2]) expect(isTypeWrittenAt(tpe, v)).toBe(belowV3)
    for (const v of [3, 4, 7]) expect(isTypeWrittenAt(tpe, v)).toBe(true)
  })
})
