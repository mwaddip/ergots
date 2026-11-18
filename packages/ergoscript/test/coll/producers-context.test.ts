/**
 * Every context-reading, box, header, numeric, AvlTree and byte-producing
 * producer sets the JVM's class on the collection it builds. One row per
 * producer in the "A collection's class" "Producers" table of
 * `facts/ergoscript-eval.md`, plus the four sites outside that table whose
 * class was read in the 6.0.7 source:
 *   - `Global.serialize` (`sigma/ast/methods.scala:1975-1982` → `Colls.fromArray(Array[Byte])` is the specialised class);
 *   - `substConstants` (`sigma/ast/trees.scala:641-647` → `Colls.fromArray(Array[Byte])` is the specialised class);
 *   - `INPUTS`, `OUTPUTS`, `CONTEXT.dataInputs`, `CONTEXT.headers`
 *     (`ErgoLikeContext.scala:137-172` → `dataBoxes.toArray.map(_.toTestBox).toColl`,
 *     and `Extensions.scala:16-19` → `Colls.fromArray(arr)` under an erased type — the plain class
 *     over the item type's reference array).
 *
 * Every assertion checks `cls` is PRESENT (the producer SET it), and asserts
 * the whole class object. A producer whose class equals the data reader's
 * for the same item type (specialised byte, specialised Coll[Boolean]) is
 * still pinned here through the `cls` presence check; a producer whose
 * class differs (plain byte, plain `Tuple2` vs `PairOfCols`, the plain
 * outer of `getMany`) is pinned through the whole-class comparison.
 *
 * JVM references at 6.0.7:
 *   core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:11, 274, 226-233
 *   data/shared/src/main/scala/sigma/ast/methods.scala:1965-1982 (Global.serialize)
 *   data/shared/src/main/scala/sigma/ast/trees.scala:633-647    (SubstConstants.eval)
 *   core/shared/src/main/scala/sigma/data/CGroupElement.scala:16 (GroupElement.getEncoded → specialised)
 *   interpreter/shared/src/main/scala/org/ergoplatform/ErgoLikeContext.scala:137-172 (toSigmaContext → plain over ref)
 */

import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { classOf, type CollClass, type CollValue } from '../../src/coll'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, type EvalOpts } from '../../src/eval/eval-context'
import type { ErgoBox, Expr, SType, SValue } from '../../src/mir/types'
import type { Header } from '@ergots/scorex'
import {
  bool,
  bytes,
  int,
  long,
  bigInt,
  Coll as CollE,
  Ctx,
  MC,
  PC,
  SigmaPropBytes,
  sp,
  SelectField,
} from '../_helpers/mir-build'
import { hexToBytes, synthesizeStubBox } from '../_helpers'

// ─── common classes ────────────────────────────────────────────────────────

const SBYTE: SType = { tag: 'SByte' }
const SLONG: SType = { tag: 'SLong' }
const SCOLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }
const STUPLE_COLLBYTE_LONG: SType = { tag: 'STuple', items: [SCOLL_BYTE, SLONG] }

const SPEC_BYTE: CollClass = { shape: 'array', specialised: true, array: 'byte' }
const PLAIN_BYTE: CollClass = { shape: 'array', specialised: false, array: 'byte' }
const SPEC_BOOL: CollClass = { shape: 'array', specialised: true, array: 'boolean' }
const PLAIN_BOX: CollClass = { shape: 'array', specialised: false, array: 'Box' }
const PLAIN_HEADER: CollClass = { shape: 'array', specialised: false, array: 'Header' }
const PLAIN_TUPLE2: CollClass = { shape: 'array', specialised: false, array: 'Tuple2' }
const PLAIN_OPTION: CollClass = { shape: 'array', specialised: false, array: 'Option' }

// ─── small helpers ─────────────────────────────────────────────────────────

function asColl(v: SValue): CollValue {
  if (v.kind !== 'Coll') throw new Error(`asColl: ${v.kind}`)
  return v
}

function runAt(e: Expr, treeVersion: number, opts: EvalOpts = {}): SValue {
  const ctx = makeContext({ treeVersion, ...opts })
  return evalExpr(e, Env.empty(), ctx)
}

/** Assert that a collection's class is present and equal to the given one. */
function expectClass(v: SValue, expected: CollClass): CollValue {
  const c = asColl(v)
  expect(c.cls, 'cls must be set by the producer').not.toBeUndefined()
  expect(classOf(c)).toEqual(expected)
  return c
}

// A minimal Header value used by the header-fields block. The byte fields
// carry distinct lengths so the tests fail loudly on a mix-up.
function stubHeader(): Header {
  return {
    version: 2,
    id: new Uint8Array(32).fill(1),
    parentId: new Uint8Array(32).fill(2),
    adProofsRoot: new Uint8Array(32).fill(3),
    stateRoot: new Uint8Array(33).fill(4),
    transactionRoot: new Uint8Array(32).fill(5),
    timestamp: 100n,
    nBits: 123,
    height: 10,
    extensionRoot: new Uint8Array(32).fill(6),
    autolykosSolution: {
      minerPk: new Uint8Array(33).fill(7),
      powOnetimePk: null,
      nonce: new Uint8Array(8).fill(8),
      powDistance: null,
    },
    votes: new Uint8Array(3).fill(9),
    unparsedBytes: new Uint8Array(0),
  }
}

// A minimal PreHeader value used by the pre-header-fields block. 33-byte
// minerPk follows the SEC1-compressed prefix convention (02/03) so it parses
// as a valid group element where the MinerPubKey sites decode it.
const GENERATOR_33 = hexToBytes(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
)

function preHeaderOpts(): EvalOpts {
  return {
    preHeader: {
      version: 2,
      parentId: new Uint8Array(32).fill(0x11),
      timestamp: 1_700_000_000n,
      nBits: 123,
      height: 42,
      minerPk: GENERATOR_33,
      votes: new Uint8Array(3).fill(0x22),
    },
  }
}

// A single-token stub box (shared between the tokens test and the R2
// register synthesis test). The token id is 32 bytes.
function stubBoxWithOneToken(): ErgoBox {
  return synthesizeStubBox({
    tokens: [{ id: new Uint8Array(32).fill(0x33), amount: 7n }],
  })
}

// ─── byte producers ────────────────────────────────────────────────────────

describe('hashes, Xor, LongToByteArray, SigmaPropBytes — specialised Coll[Byte]', () => {
  it('CalcBlake2b256 result is specialised', () => {
    const e: Expr = { tag: 'CalcBlake2b256', input: bytes([1, 2, 3]) }
    expectClass(runAt(e, 0), SPEC_BYTE)
  })
  it('CalcSha256 result is specialised', () => {
    const e: Expr = { tag: 'CalcSha256', input: bytes([1, 2, 3]) }
    expectClass(runAt(e, 0), SPEC_BYTE)
  })
  it('Xor result is specialised', () => {
    const e: Expr = { tag: 'Xor', left: bytes([1, 2, 3]), right: bytes([4, 5, 6]) }
    expectClass(runAt(e, 0), SPEC_BYTE)
  })
  it('LongToByteArray result is specialised', () => {
    const e: Expr = { tag: 'LongToByteArray', input: long(1) }
    expectClass(runAt(e, 0), SPEC_BYTE)
  })
  it('SigmaPropBytes result is specialised', () => {
    const e: Expr = SigmaPropBytes(sp(bool(true)))
    expectClass(runAt(e, 0), SPEC_BYTE)
  })
})

// ─── box extracts and box property method-forms ────────────────────────────

describe('box extracts and 99:2..5 method-forms — specialised Coll[Byte]', () => {
  const box = synthesizeStubBox()
  const boxC: Expr = { tag: 'Const', tpe: { tag: 'SBox' }, value: { kind: 'Box', value: box } }

  it('ExtractScriptBytes is specialised', () => {
    expectClass(runAt({ tag: 'ExtractScriptBytes', input: boxC }, 0), SPEC_BYTE)
  })
  it('ExtractBytes is specialised', () => {
    expectClass(runAt({ tag: 'ExtractBytes', input: boxC }, 0), SPEC_BYTE)
  })
  it('ExtractBytesWithNoRef is specialised', () => {
    expectClass(runAt({ tag: 'ExtractBytesWithNoRef', input: boxC }, 0), SPEC_BYTE)
  })
  it('ExtractId is specialised', () => {
    expectClass(runAt({ tag: 'ExtractId', input: boxC }, 0), SPEC_BYTE)
  })

  it('SBox.propositionBytes (99:2) is specialised', () => {
    expectClass(runAt(PC(99, 2, boxC), 3), SPEC_BYTE)
  })
  it('SBox.bytes (99:3) is specialised', () => {
    expectClass(runAt(PC(99, 3, boxC), 3), SPEC_BYTE)
  })
  it('SBox.bytesWithoutRef (99:4) is specialised', () => {
    expectClass(runAt(PC(99, 4, boxC), 3), SPEC_BYTE)
  })
  it('SBox.id (99:5) is specialised', () => {
    expectClass(runAt(PC(99, 5, boxC), 3), SPEC_BYTE)
  })
})

describe('SELF.creationInfo._2 and R3 bytes — plain Coll[Byte]', () => {
  const box = synthesizeStubBox()
  const boxC: Expr = { tag: 'Const', tpe: { tag: 'SBox' }, value: { kind: 'Box', value: box } }

  it('ExtractCreationInfo._2 (bytes) is PLAIN', () => {
    const ci: Expr = { tag: 'ExtractCreationInfo', input: boxC }
    expectClass(runAt(SelectField(ci, 2), 0), PLAIN_BYTE)
  })
  it('R3 bytes, read as a register, is PLAIN', () => {
    const r3: Expr = { tag: 'ExtractRegisterAs', input: boxC, registerId: 3, elemTpe: { tag: 'STuple', items: [{ tag: 'SInt' }, SCOLL_BYTE] } }
    const some = runAt({ tag: 'OptionGet', input: r3 }, 0)
    if (some.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(some.items[1]!, PLAIN_BYTE)
  })
  it('R1 (SELF\'s tree bytes) is PLAIN', () => {
    const r1: Expr = { tag: 'ExtractRegisterAs', input: boxC, registerId: 1, elemTpe: SCOLL_BYTE }
    const some = runAt({ tag: 'OptionGet', input: r1 }, 0)
    expectClass(some, PLAIN_BYTE)
  })
})

// ─── header and pre-header ─────────────────────────────────────────────────

describe('header byte fields — specialised Coll[Byte]', () => {
  const header = stubHeader()
  const headerC: Expr = { tag: 'Const', tpe: { tag: 'SHeader' }, value: { kind: 'Header', value: header } }

  it('SHeader.id (104:1) is specialised', () => {
    expectClass(runAt(PC(104, 1, headerC), 0), SPEC_BYTE)
  })
  it('SHeader.parentId (104:3) is specialised', () => {
    expectClass(runAt(PC(104, 3, headerC), 0), SPEC_BYTE)
  })
  it('SHeader.ADProofsRoot (104:4) is specialised', () => {
    expectClass(runAt(PC(104, 4, headerC), 0), SPEC_BYTE)
  })
  it('SHeader.transactionsRoot (104:6) is specialised', () => {
    expectClass(runAt(PC(104, 6, headerC), 0), SPEC_BYTE)
  })
  it('SHeader.extensionRoot (104:10) is specialised', () => {
    expectClass(runAt(PC(104, 10, headerC), 0), SPEC_BYTE)
  })
  it('SHeader.powNonce (104:13) is specialised', () => {
    expectClass(runAt(PC(104, 13, headerC), 0), SPEC_BYTE)
  })
  it('SHeader.votes (104:15) is specialised', () => {
    expectClass(runAt(PC(104, 15, headerC), 0), SPEC_BYTE)
  })
})

describe('pre-header parentId/votes — PLAIN Coll[Byte] (105:2, 105:7)', () => {
  it('SPreHeader.parentId (105:2) is PLAIN', () => {
    expectClass(runAt(PC(105, 2, PC(101, 3, Ctx)), 3, preHeaderOpts()), PLAIN_BYTE)
  })
  it('SPreHeader.votes (105:7) is PLAIN', () => {
    expectClass(runAt(PC(105, 7, PC(101, 3, Ctx)), 3, preHeaderOpts()), PLAIN_BYTE)
  })
})

// ─── context collections ───────────────────────────────────────────────────

describe('INPUTS / OUTPUTS / dataInputs / headers — plain over reference item class', () => {
  const box = synthesizeStubBox()
  const opts: EvalOpts = { inputs: [box], outputs: [box, box], dataInputs: [box], headers: [stubHeader()] }

  it('GlobalVars.Inputs is plain over Box', () => {
    const e: Expr = { tag: 'GlobalVars', kind: 'Inputs' }
    expectClass(runAt(e, 0, opts), PLAIN_BOX)
  })
  it('GlobalVars.Outputs is plain over Box', () => {
    const e: Expr = { tag: 'GlobalVars', kind: 'Outputs' }
    expectClass(runAt(e, 0, opts), PLAIN_BOX)
  })
  it('SContext.dataInputs (101:1) is plain over Box', () => {
    expectClass(runAt(PC(101, 1, Ctx), 0, opts), PLAIN_BOX)
  })
  it('SContext.headers (101:2) is plain over Header', () => {
    expectClass(runAt(PC(101, 2, Ctx), 0, opts), PLAIN_HEADER)
  })
})

describe('MinerPubKey — specialised Coll[Byte]', () => {
  it('GlobalVars.MinerPubKey is specialised', () => {
    const e: Expr = { tag: 'GlobalVars', kind: 'MinerPubKey' }
    expectClass(runAt(e, 0, preHeaderOpts()), SPEC_BYTE)
  })
  it('SContext.minerPubKey (101:10) is specialised', () => {
    expectClass(runAt(PC(101, 10, Ctx), 0, preHeaderOpts()), SPEC_BYTE)
  })
})

// ─── GroupElement.getEncoded ───────────────────────────────────────────────

describe('GroupElement.getEncoded (7:2) — specialised Coll[Byte]', () => {
  it('result is specialised', () => {
    const ge: Expr = { tag: 'Const', tpe: { tag: 'SGroupElement' }, value: { kind: 'GroupElement', value: GENERATOR_33 } }
    expectClass(runAt(MC(7, 2, ge, []), 0), SPEC_BYTE)
  })
})

// ─── Box.tokens and R2 ─────────────────────────────────────────────────────

describe('Box.tokens (99:8) and R2 — plain Coll over Tuple2, token id specialised', () => {
  const box = stubBoxWithOneToken()
  const boxC: Expr = { tag: 'Const', tpe: { tag: 'SBox' }, value: { kind: 'Box', value: box } }

  it('Box.tokens outer is plain over Tuple2 (NOT pairs)', () => {
    const v = runAt(PC(99, 8, boxC), 0)
    expectClass(v, PLAIN_TUPLE2)
  })
  it('each token id in Box.tokens is specialised', () => {
    const v = runAt(PC(99, 8, boxC), 0)
    const outer = asColl(v)
    const first = outer.items[0]!
    if (first.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(first.items[0]!, SPEC_BYTE)
  })

  it('R2 register outer is plain over Tuple2 (NOT pairs)', () => {
    const r2: Expr = {
      tag: 'ExtractRegisterAs',
      input: boxC,
      registerId: 2,
      elemTpe: { tag: 'SColl', elem: STUPLE_COLLBYTE_LONG },
    }
    const some = runAt({ tag: 'OptionGet', input: r2 }, 0)
    expectClass(some, PLAIN_TUPLE2)
  })
  it('R2 token id is specialised', () => {
    const r2: Expr = {
      tag: 'ExtractRegisterAs',
      input: boxC,
      registerId: 2,
      elemTpe: { tag: 'SColl', elem: STUPLE_COLLBYTE_LONG },
    }
    const some = runAt({ tag: 'OptionGet', input: r2 }, 0)
    const first = asColl(some).items[0]!
    if (first.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(first.items[0]!, SPEC_BYTE)
  })
})

// ─── numeric .toBytes / .toBits (v6 P1) ────────────────────────────────────

describe('numeric .toBytes — plain for Byte/Short/Int/Long, specialised for BigInt/UBI', () => {
  const byteC: Expr = { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 1 } }
  const shortC: Expr = { tag: 'Const', tpe: { tag: 'SShort' }, value: { kind: 'Short', value: 1 } }
  const bigIntC = bigInt(1)
  const ubiC: Expr = { tag: 'Const', tpe: { tag: 'SUnsignedBigInt' }, value: { kind: 'UnsignedBigInt', value: 1n } }

  it('Byte.toBytes (2:6) is PLAIN', () => {
    expectClass(runAt(MC(2, 6, byteC, []), 3), PLAIN_BYTE)
  })
  it('Short.toBytes (3:6) is PLAIN', () => {
    expectClass(runAt(MC(3, 6, shortC, []), 3), PLAIN_BYTE)
  })
  it('Int.toBytes (4:6) is PLAIN', () => {
    expectClass(runAt(MC(4, 6, int(1), []), 3), PLAIN_BYTE)
  })
  it('Long.toBytes (5:6) is PLAIN', () => {
    expectClass(runAt(MC(5, 6, long(1), []), 3), PLAIN_BYTE)
  })
  it('BigInt.toBytes (6:6) is specialised', () => {
    expectClass(runAt(MC(6, 6, bigIntC, []), 3), SPEC_BYTE)
  })
  it('UnsignedBigInt.toBytes (9:6) is specialised', () => {
    expectClass(runAt(MC(9, 6, ubiC, []), 3), SPEC_BYTE)
  })
})

describe('numeric .toBits — specialised Coll[Boolean]', () => {
  const byteC: Expr = { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 1 } }
  it('Byte.toBits (2:7) is specialised Coll[Boolean]', () => {
    expectClass(runAt(MC(2, 7, byteC, []), 3), SPEC_BOOL)
  })
  it('Int.toBits (4:7) is specialised Coll[Boolean]', () => {
    expectClass(runAt(MC(4, 7, int(1), []), 3), SPEC_BOOL)
  })
})

// ─── AvlTree.digest / get / getMany ────────────────────────────────────────

describe('AvlTree.digest / get / getMany — specialised inner, plain outer', () => {
  // The blessed vector's tree/key/proof (measure-1.md, measurement B).
  const DIGEST = hexToBytes('15cc1ba1054bf74431a2ccfc57e6051b9d0e7561f70586e5512c0ae3f3bac4fd02')
  const KEY = hexToBytes('01')
  const PROOF = hexToBytes(
    '0385ab460a6564d1e5ded17716cd5866650d7fbb9cada7fecabd5fe21e2f80e43a02010200000008000000000000000a03fc29fc93353c639f7cf275ea69851dfa41d720ed53bcc9c10bda17166966d5ed00010402'
  )
  const treeC: Expr = {
    tag: 'Const',
    tpe: { tag: 'SAvlTree' },
    value: {
      kind: 'AvlTree',
      value: { digest: DIGEST, treeFlags: 7, keyLength: 1, valueLengthOpt: null },
    },
  }
  const keyC: Expr = { tag: 'Const', tpe: SCOLL_BYTE, value: { kind: 'Coll', elem: SBYTE, items: Array.from(KEY, (b) => ({ kind: 'Byte' as const, value: (b << 24) >> 24 })) } }
  const proofC: Expr = { tag: 'Const', tpe: SCOLL_BYTE, value: { kind: 'Coll', elem: SBYTE, items: Array.from(PROOF, (b) => ({ kind: 'Byte' as const, value: (b << 24) >> 24 })) } }

  it('AvlTree.digest (100:1) is specialised', () => {
    expectClass(runAt(PC(100, 1, treeC), 0), SPEC_BYTE)
  })

  it('AvlTree.get (100:10) inner Coll[Byte] is specialised', () => {
    const get: Expr = MC(100, 10, treeC, [keyC, proofC])
    const some = runAt({ tag: 'OptionGet', input: get }, 0)
    expectClass(some, SPEC_BYTE)
  })

  it('AvlTree.getMany (100:11) outer is plain over Option', () => {
    const keys: Expr = CollE(SCOLL_BYTE, [keyC])
    const getMany: Expr = MC(100, 11, treeC, [keys, proofC])
    const outer = runAt(getMany, 0)
    expectClass(outer, PLAIN_OPTION)
  })

  it('AvlTree.getMany inner Coll[Byte] of each Some is specialised', () => {
    const keys: Expr = CollE(SCOLL_BYTE, [keyC])
    const getMany: Expr = MC(100, 11, treeC, [keys, proofC])
    const outer = asColl(runAt(getMany, 0))
    const first = outer.items[0]!
    if (first.kind !== 'Option' || first.value === null) throw new Error('expected Some')
    expectClass(first.value, SPEC_BYTE)
  })
})

// ─── Global.serialize / substConstants ─────────────────────────────────────

describe('Global.serialize / substConstants — specialised Coll[Byte]', () => {
  it('Global.serialize (106:3) result is specialised', () => {
    // Serialize a Byte value (one wire byte; smallest non-empty input).
    const byteC: Expr = { tag: 'Const', tpe: SBYTE, value: { kind: 'Byte', value: 1 } }
    const ser: Expr = MC(106, 3, { tag: 'Global' }, [byteC])
    expectClass(runAt(ser, 3), SPEC_BYTE)
  })

  it('SubstConstants result is specialised', () => {
    // Parse a SigmaProp-returning v0 template with ONE Boolean constant that is
    // then substituted — the result is the template bytes with the constant
    // byte-rewritten. The script re-serializes as (header 0x10, numConstants
    // 1, constantType 0x01, constantValue 0x01, body 0xd1 0x04 0x00).
    const templateBytes = hexToBytes('100101019504') // template with one constant
    // Replace position 0 with Boolean false.
    const scriptBytes: Expr = { tag: 'Const', tpe: SCOLL_BYTE, value: { kind: 'Coll', elem: SBYTE, items: Array.from(templateBytes, (b) => ({ kind: 'Byte' as const, value: (b << 24) >> 24 })) } }
    const positions: Expr = CollE({ tag: 'SInt' }, [int(0)])
    const newValues: Expr = CollE({ tag: 'SBoolean' }, [bool(false)])
    const e: Expr = { tag: 'SubstConstants', scriptBytes, positions, newValues }
    expectClass(runAt(e, 0), SPEC_BYTE)
  })
})

// ─── Review focus 5: a box built from fields (no bytes behind it) ─────────

describe('review focus 5 — a box built from fields carries the same classes', () => {
  // `synthesizeStubBox` returns a box whose `ergoTreeBytes` is a fixed hex
  // literal, no `retainedBytes` slice — so R1 and R3 bytes do not come from a
  // parsed input span.
  const box = stubBoxWithOneToken()
  const boxC: Expr = { tag: 'Const', tpe: { tag: 'SBox' }, value: { kind: 'Box', value: box } }

  it('R1 bytes are PLAIN', () => {
    const r1: Expr = { tag: 'ExtractRegisterAs', input: boxC, registerId: 1, elemTpe: SCOLL_BYTE }
    expectClass(runAt({ tag: 'OptionGet', input: r1 }, 0), PLAIN_BYTE)
  })

  it('R2 outer is plain over Tuple2', () => {
    const r2: Expr = {
      tag: 'ExtractRegisterAs',
      input: boxC,
      registerId: 2,
      elemTpe: { tag: 'SColl', elem: STUPLE_COLLBYTE_LONG },
    }
    expectClass(runAt({ tag: 'OptionGet', input: r2 }, 0), PLAIN_TUPLE2)
  })

  it('R2 token id is specialised', () => {
    const r2: Expr = {
      tag: 'ExtractRegisterAs',
      input: boxC,
      registerId: 2,
      elemTpe: { tag: 'SColl', elem: STUPLE_COLLBYTE_LONG },
    }
    const outer = asColl(runAt({ tag: 'OptionGet', input: r2 }, 0))
    const first = outer.items[0]!
    if (first.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(first.items[0]!, SPEC_BYTE)
  })

  it('R3 bytes are PLAIN', () => {
    const r3: Expr = { tag: 'ExtractRegisterAs', input: boxC, registerId: 3, elemTpe: { tag: 'STuple', items: [{ tag: 'SInt' }, SCOLL_BYTE] } }
    const some = runAt({ tag: 'OptionGet', input: r3 }, 0)
    if (some.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(some.items[1]!, PLAIN_BYTE)
  })

  it('Box.tokens outer is plain over Tuple2 (constructed box)', () => {
    expectClass(runAt(PC(99, 8, boxC), 0), PLAIN_TUPLE2)
  })

  it('Box.tokens token id is specialised (constructed box)', () => {
    const outer = asColl(runAt(PC(99, 8, boxC), 0))
    const first = outer.items[0]!
    if (first.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(first.items[0]!, SPEC_BYTE)
  })
})

describe('review focus 5 twin — a box PARSED from its own serialised bytes', () => {
  // Round-trip the same single-token stub through the package's own box
  // serializer and parser, so R1/R2/R3 and the tokens come out of the parsed
  // span rather than from the fields-only construction above. The classes
  // the handlers set do not come from byte provenance, so each row holds
  // the same class as its fields-only twin.
  const built = stubBoxWithOneToken()
  const w = new ByteWriter()
  serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: built }, 0, w)
  const r = new ByteReader(w.toBytes())
  const parsed = parseSValue({ tag: 'SBox' }, 0, r)
  if (parsed.kind !== 'Box') throw new Error(`parseSValue(SBox): got ${parsed.kind}`)
  const boxC: Expr = { tag: 'Const', tpe: { tag: 'SBox' }, value: parsed }

  it('R1 bytes are PLAIN', () => {
    const r1: Expr = { tag: 'ExtractRegisterAs', input: boxC, registerId: 1, elemTpe: SCOLL_BYTE }
    expectClass(runAt({ tag: 'OptionGet', input: r1 }, 0), PLAIN_BYTE)
  })

  it('R2 outer is plain over Tuple2', () => {
    const r2: Expr = {
      tag: 'ExtractRegisterAs',
      input: boxC,
      registerId: 2,
      elemTpe: { tag: 'SColl', elem: STUPLE_COLLBYTE_LONG },
    }
    expectClass(runAt({ tag: 'OptionGet', input: r2 }, 0), PLAIN_TUPLE2)
  })

  it('R2 token id is specialised', () => {
    const r2: Expr = {
      tag: 'ExtractRegisterAs',
      input: boxC,
      registerId: 2,
      elemTpe: { tag: 'SColl', elem: STUPLE_COLLBYTE_LONG },
    }
    const outer = asColl(runAt({ tag: 'OptionGet', input: r2 }, 0))
    const first = outer.items[0]!
    if (first.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(first.items[0]!, SPEC_BYTE)
  })

  it('R3 bytes are PLAIN', () => {
    const r3: Expr = { tag: 'ExtractRegisterAs', input: boxC, registerId: 3, elemTpe: { tag: 'STuple', items: [{ tag: 'SInt' }, SCOLL_BYTE] } }
    const some = runAt({ tag: 'OptionGet', input: r3 }, 0)
    if (some.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(some.items[1]!, PLAIN_BYTE)
  })

  it('Box.tokens outer is plain over Tuple2 (parsed box)', () => {
    expectClass(runAt(PC(99, 8, boxC), 0), PLAIN_TUPLE2)
  })

  it('Box.tokens token id is specialised (parsed box)', () => {
    const outer = asColl(runAt(PC(99, 8, boxC), 0))
    const first = outer.items[0]!
    if (first.kind !== 'Tuple') throw new Error('expected Tuple')
    expectClass(first.items[0]!, SPEC_BYTE)
  })
})

// ─── a data-reader parsed constant is the DATA READER's class ──────────────

describe('a parsed Coll[Byte] constant is the data reader\'s SPECIALISED class', () => {
  it('reads an unparsed byte-collection through the data reader', () => {
    // Tag 0x02 (SByte), length 3, bytes 01 02 03. The data reader specialises
    // SByte (:174); `producers-structural` holds the full data-reader rows,
    // and this one row anchors the data-reader anchor at the head of the
    // producers' table — the class the facade falls back to when a value
    // comes in without `cls`.
    const r = new ByteReader(hexToBytes('02030102fd'))
    const v = parseSValue({ tag: 'SColl', elem: SBYTE }, 0, r)
    expectClass(v, SPEC_BYTE)
  })
})
