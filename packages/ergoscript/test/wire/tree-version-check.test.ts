// A tree above the activated script version, at the parse. The JVM enters
// VersionContext.withVersions(activated, treeVersion) after a tree's header and size and before its
// constants (sigma-state 6.0.6 ErgoTreeSerializer.scala:141-214); the context's constructor requires
// treeVersion <= activated from activated version 2 (sigma/VersionContext.scala:20), and its failure is a
// SerializerException, which no tree degrades on (:191-193). A reader outside any version context runs
// at the JVM's default, activated version 1, where nothing is compared (:58-61).
//
// Every verdict below is the JVM's. Rows P and N and H2 are from a local sigma-state 6.0.6 probe,
// ErgoBox.sigmaSerializer.parse under the pair given. The SANTA entries are quoted inline (bytes,
// versions, the JVM's answer), each with a comment naming its SANTA file, entry and SANTA commit.

import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { parseTree, ErgoTreeParseError } from '../../src/wire/ergo-tree'
import { boxTreeOf } from '../../src/wire/box-tree'
import { isUnparsedTree } from '../../src/mir/types'
import type { ErgoBox } from '../../src/mir/types'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

type Verdict = 'parsed' | 'unparsed' | 'reject'
type Row = [name: string, activated: number, ergoTree: number, jvm: Verdict, boxHex: string]

/** The box's own tree, as its ingest left it: parsed, or unparsed after a degrade. Also round-trips
 *  the box through serializeSValue for an accepted parse. */
function readBox(boxHex: string, activated: number | undefined, ergoTree: number): { tree: 'parsed' | 'unparsed'; written: string } {
  const r = new ByteReader(hex(boxHex))
  r.activatedVersion = activated
  const v = parseSValue({ tag: 'SBox' }, ergoTree, r)
  expect(r.isExhausted).toBe(true)
  const w = new ByteWriter()
  serializeSValue({ tag: 'SBox' }, v, ergoTree, w)
  const box = (v as { kind: 'Box'; value: ErgoBox }).value
  return { tree: isUnparsedTree(boxTreeOf(box.ergoTreeBytes)) ? 'unparsed' : 'parsed', written: toHex(w.toBytes()) }
}

function expectVersionReject(fn: () => unknown, treeVersion: number, activated: number): void {
  let err: unknown
  try { fn() } catch (x) { err = x }
  expect(err).toBeInstanceOf(ErgoTreeParseError)
  expect((err as ErgoTreeParseError).code).toBe('tree-version-above-activated')
  expect((err as Error).message).toBe(`tree version ${treeVersion} is above the activated script version ${activated}`)
}

function runRows(rows: Row[], aboveVersion: (name: string) => number): void {
  for (const [name, activated, ergoTree, jvm, boxHex] of rows) {
    it(`${name} (${activated}, ${ergoTree}): ${jvm}`, () => {
      if (jvm === 'reject') {
        expectVersionReject(() => readBox(boxHex, activated, ergoTree), aboveVersion(name), activated)
      } else {
        const got = readBox(boxHex, activated, ergoTree)
        expect(got.tree).toBe(jvm)
        expect(got.written).toBe(boxHex)   // the JVM's round-trip is the identity on each of these
      }
    })
  }
}

// Rows P from the parse-check probe. P1 to P8: the box's own tree. P9 to P11: a v3 tree holding a
// Box constant whose tree is v4.
const P: Row[] = [
  ['a v4 tree', 3, 3, 'reject',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v4 tree at 4', 4, 4, 'parsed',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v4 tree at 1', 1, 1, 'parsed',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v4 tree at 0', 0, 0, 'parsed',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v3 tree at 2', 2, 2, 'reject',
    'c0843d0b0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v3 tree at 1', 1, 1, 'parsed',
    'c0843d0b0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v2 tree at 1', 1, 1, 'parsed',
    'c0843d0a0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v2 tree at 2', 2, 2, 'parsed',
    'c0843d0a0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v3 tree holding a Box with a v4 tree', 3, 3, 'reject',
    'c0843d1b310263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v3 tree holding a Box with a v4 tree, at 1', 1, 1, 'parsed',
    'c0843d1b310263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v3 tree holding a Box with a v4 tree, at 4', 4, 4, 'parsed',
    'c0843d1b310263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
]

// Rows N from an adversarial parse-cases probe. A tree above the activated version, nested deeper
// or among soft failures on either side of it. The inner tree's version is 4 (unless the row names
// a different one).
const N: Row[] = [
  ['two levels deep, innermost tree v4', 3, 3, 'reject',
    'c0843d1b600263c0843d1b310263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d3730101000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['two levels deep, innermost tree v4, at 1', 1, 1, 'parsed',
    'c0843d1b600263c0843d1b310263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d3730101000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['two levels deep, innermost tree v4, at 4', 4, 4, 'parsed',
    'c0843d1b600263c0843d1b310263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d3730101000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['two levels deep, innermost tree v3', 3, 3, 'parsed',
    'c0843d1b600263c0843d1b310263c0843d0b0208d301000000000000000000000000000000000000000000000000000000000000000000000008d3730101000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['Coll[Box] constant, the box tree v4', 3, 3, 'reject',
    'c0843d1b33020c6301c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['Coll[Box] constant, the box tree v4, at 1', 1, 1, 'parsed',
    'c0843d1b33020c6301c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['Coll[Box] constant, the box tree v3', 3, 3, 'parsed',
    'c0843d1b33020c6301c0843d0b0208d301000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = Coll[Box], the box tree v4', 3, 3, 'reject',
    'c0843d0008d30100010c6301c0843d0c0208d30100000000000000000000000000000000000000000000000000000000000000000000001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = Coll[Box], the box tree v4, at 1', 1, 1, 'parsed',
    'c0843d0008d30100010c6301c0843d0c0208d30100000000000000000000000000000000000000000000000000000000000000000000001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = Tuple node (Box v4-tree, Int 1)', 3, 3, 'reject',
    'c0843d0008d3010001860263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000004021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['R4 = Tuple node (Box v3-tree, Int 1)', 3, 3, 'parsed',
    'c0843d0008d3010001860263c0843d0b0208d301000000000000000000000000000000000000000000000000000000000000000000000004021d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['tree constant Box whose R4 is a Box with a v4 tree', 3, 3, 'reject',
    'c0843d1b5c0263c0843d0008d301000163c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['sized v3 tree: constant 0 a Box with a v4 tree, constant 1 type 211 (version first)', 3, 3, 'reject',
    'c0843d1b300263c0843d0c0208d3010000000000000000000000000000000000000000000000000000000000000000000000d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['sized v3 tree: constant 0 type 211, then a Box with a v4 tree (degrade first)', 3, 3, 'unparsed',
    'c0843d1b3002d363c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000073010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
]

// Rows H2 from an adversarial parse-cases probe: a v4 tree under pairs whose halves differ. The
// activated half alone decides.
const H2: Row[] = [
  ['a v4 tree under (3, 0)', 3, 0, 'reject',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v4 tree under (3, 2)', 3, 2, 'reject',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v4 tree under (1, 3)', 1, 3, 'parsed',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v4 tree under (0, 7)', 0, 7, 'parsed',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v4 tree under (4, 0)', 4, 0, 'parsed',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
  ['a v4 tree under (127, 7)', 127, 7, 'parsed',
    'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'],
]

describe('a tree above the activated version: a box read under a version pair (rows P)', () => {
  // For each P row's reject, the tree version that is above activated is the one named by the row's
  // tree version: outer v4 for P1, outer v3 for P5, nested v4 for P9.
  runRows(P, (name) => (name.includes('v4 tree') ? 4 : 3))
})

describe('a tree above the activated version: nested trees (rows N)', () => {
  runRows(N, () => 4)

  it('N10: the soft failure is read first, the outer tree degrades, and the nested tree is never read', () => {
    const [, activated, ergoTree, jvm, boxHex] = N[N.length - 1]!
    expect(jvm).toBe('unparsed')
    expect(readBox(boxHex, activated, ergoTree).tree).toBe('unparsed')
  })
})

describe('a tree above the activated version: the activated half alone decides (rows H2)', () => {
  runRows(H2, () => 4)
})

describe('a reader with no activated version parses outside any version context', () => {
  for (const [name, , ergoTree, , boxHex] of [...P, ...N, ...H2]) {
    it(`${name}, read at tree version ${ergoTree} with nothing set: no version reject`, () => {
      expect(readBox(boxHex, undefined, ergoTree).written).toBe(boxHex)
    })
  }

  it('a reader set to 1, to 0 and to a negative version compares nothing either', () => {
    const boxHex = P[0]![4]
    for (const activated of [1, 0, -1, -128]) expect(readBox(boxHex, activated, 3).tree).toBe('parsed')
  })
})

describe("parseTree's activatedVersion option", () => {
  const v4 = hex('0c0208d3')   // sized v4, SigmaProp(true)
  const v3 = hex('0b0208d3')
  const v2 = hex('0a0208d3')

  it('a v4 tree rejects at activated 3 and at 2', () => {
    expectVersionReject(() => parseTree(v4, { activatedVersion: 3 }), 4, 3)
    expectVersionReject(() => parseTree(v4, { activatedVersion: 2 }), 4, 2)
  })

  it('a v4 tree parses at activated 4 and above, at 1, at 0 and at a negative version', () => {
    for (const activatedVersion of [4, 7, 127, 1, 0, -1, -128]) {
      const tree = parseTree(v4, { activatedVersion })
      expect(isUnparsedTree(tree)).toBe(false)
      expect(tree.header.version).toBe(4)
    }
  })

  it('a v4 tree parses with no option, and with the option unset', () => {
    expect(parseTree(v4).header.version).toBe(4)
    expect(parseTree(v4, {}).header.version).toBe(4)
    expect(parseTree(v4, { activatedVersion: undefined, checkType: true }).header.version).toBe(4)
  })

  it('a v3 tree rejects at activated 2 and parses at 3; a v2 tree parses at 2', () => {
    expectVersionReject(() => parseTree(v3, { activatedVersion: 2 }), 3, 2)
    expect(parseTree(v3, { activatedVersion: 3 }).header.version).toBe(3)
    expect(parseTree(v2, { activatedVersion: 2 }).header.version).toBe(2)
  })

  it('the check comes before the constants: a sized v4 tree with a soft failure in them rejects, and the v3 twin degrades', () => {
    // 8 constants declared, the first of type code 211, which is no type (rule 1018).
    expectVersionReject(() => parseTree(hex('1c0208d3'), { activatedVersion: 3 }), 4, 3)
    expect(isUnparsedTree(parseTree(hex('1b0208d3'), { activatedVersion: 3 }))).toBe(true)
  })

  it('the size-bit rule comes before the check: an unsized v4 header fails rule 1012', () => {
    let err: unknown
    try { parseTree(hex('0408d3'), { activatedVersion: 3 }) } catch (x) { err = x }
    expect(err).toBeInstanceOf(ErgoTreeParseError)
    expect((err as ErgoTreeParseError).code).toBe('header-version-requires-size')
  })

  // The JVM's activated version is a Byte. A value that is none would compare as nothing, and the
  // v4 tree would parse: the reader refuses it (ByteReader.activatedVersion's setter).
  it.each([
    ['NaN', NaN], ['a fraction', 3.5], ['300', 300], ['-129', -129], ['a string', '3'], ['null', null],
  ])('an activated version that is no signed byte is a TypeError: %s', (_name, activatedVersion) => {
    expect(() => parseTree(v4, { activatedVersion: activatedVersion as never })).toThrow(TypeError)
    expect(() => parseTree(v3, { activatedVersion: activatedVersion as never })).toThrow(TypeError)
  })

  it("the option reaches a nested tree: a v3 tree holding a Box constant whose tree is v4", () => {
    // From P's "a v3 tree holding a Box with a v4 tree": the box value's 3-byte VLQ prefix, then
    // the tree envelope (header + size 49 + 49 body bytes).
    const outer = hex(P[8]![4]).subarray(3, 3 + 51)
    expect(outer[0]).toBe(0x1b)
    expectVersionReject(() => parseTree(outer, { activatedVersion: 3 }), 4, 3)
    expect(parseTree(outer, { activatedVersion: 4 }).header.version).toBe(3)
    expect(parseTree(outer).header.version).toBe(3)
  })
})

// Inline SANTA entries, quoted from SANTA's
// vectors/wire/{v5,v6}/authored/Box.tree_version_above_activated.json at SANTA commit 8885632. The
// runner's wire arm reaches parseSValue(SBox) through the same call.
describe('SANTA Box.tree_version_above_activated entries (v6, SANTA 8885632)', () => {
  // vectors/wire/v6/authored/Box.tree_version_above_activated.json
  const v6Entries = [
    { name: 'box-tree-v4-reject#0', bytes: 'c0843d0c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400', tree: 4 },
    { name: 'box-tree-v5-reject#1', bytes: 'c0843d0d0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400', tree: 5 },
    { name: 'box-tree-v6-reject#2', bytes: 'c0843d0e0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400', tree: 6 },
    { name: 'box-tree-v7-reject#3', bytes: 'c0843d0f0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400', tree: 7 },
    { name: 'box-tree-v4-soft-constant-reject#5', bytes: 'c0843d1c0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400', tree: 4 },
    { name: 'box-tree-v4-high-bits-reject#8', bytes: 'c0843dec0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400', tree: 4 },
    { name: 'box-nested-tree-v4-reject#9', bytes: 'c0843d1b310263c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400', tree: 4 },
    { name: 'box-register-box-tree-v4-reject#12', bytes: 'c0843d0008d301000163c0843d0c0208d30100000000000000000000000000000000000000000000000000000000000000000000001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400', tree: 4 },
  ]

  for (const e of v6Entries) {
    it(`${e.name}: the version check rejects, not a degrade`, () => {
      expectVersionReject(() => readBox(e.bytes, 3, 3), e.tree, 3)
    })
  }

  it('box-tree-v4-unsized-reject#7: rule 1012 fires first (header-version-requires-size)', () => {
    // vectors/wire/v6/authored/Box.tree_version_above_activated.json entry
    // 'box-tree-v4-unsized-reject#7' (SANTA 8885632). A v4 header without the size bit: rule 1012
    // runs before the version check.
    const bytes = 'c0843d0408d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'
    let err: unknown
    try { readBox(bytes, 3, 3) } catch (x) { err = x }
    expect(err).toBeInstanceOf(ErgoTreeParseError)
    expect((err as ErgoTreeParseError).code).toBe('header-version-requires-size')
  })

  it('box-nested-tree-v4-unsized-degrade-accept#11: a nested unsized v4 degrades the outer, round-trips', () => {
    // vectors/wire/v6/authored/Box.tree_version_above_activated.json entry
    // 'box-nested-tree-v4-unsized-degrade-accept#11' (SANTA 8885632). Rule 1012 on the nested
    // tree's header is inside the enclosing tree's try, so the outer size-flagged tree degrades
    // on it, as the JVM's does. The box round-trips.
    const bytes = 'c0843d1b300263c0843d0408d301000000000000000000000000000000000000000000000000000000000000000000000008d373010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'
    const got = readBox(bytes, 3, 3)
    expect(got.tree).toBe('unparsed')
    expect(got.written).toBe(bytes)
  })
})

describe('SANTA Box.tree_version_above_activated entries (v5, SANTA 8885632)', () => {
  // vectors/wire/v5/authored/Box.tree_version_above_activated.json entry 'box-tree-v3-reject#0'
  // (SANTA 8885632): a v3 tree under (2, 2) is rejected on the version.
  it('box-tree-v3-reject#0: a v3 tree under (2, 2) rejects', () => {
    const bytes = 'c0843d0b0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'
    expectVersionReject(() => readBox(bytes, 2, 2), 3, 2)
  })

  // vectors/wire/v5/authored/Box.tree_version_above_activated.json entry 'box-tree-v2-accept#1'
  // (SANTA 8885632): the control at (2, 2), parses and round-trips.
  it('box-tree-v2-accept#1: a v2 tree under (2, 2) parses and round-trips', () => {
    const bytes = 'c0843d0a0208d30100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'
    const got = readBox(bytes, 2, 2)
    expect(got.tree).toBe('parsed')
    expect(got.written).toBe(bytes)
  })
})

// The JVM reads a TrueLeaf opcode and then the Box constant that follows. ergots reads the TrueLeaf
// too, so the parse reaches the nested tree, where the version check fires.
describe('a nested tree reached through a TrueLeaf opcode (row R1 of the adversarial probe)', () => {
  const R1 = 'c0843d0b33d1937f91c163c0843d0c0208d301000000000000000000000000000000000000000000000000000000000000000000000005000100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'

  it('R1: TrueLeaf, then a Box constant whose tree is v4, under (3, 3): the parse reaches the nested tree and rejects', () => {
    expectVersionReject(() => readBox(R1, 3, 3), 4, 3)
  })
})
