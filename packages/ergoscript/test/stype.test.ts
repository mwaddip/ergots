import { describe, it, expect } from 'vitest'
import { sTypeEquals, isPrimitive } from '../src/mir/stype-helpers'
import { parseSType, STypeParseError } from '../src/wire/parse-stype'
import { serializeSType, STypeSerializeError } from '../src/wire/serialize-stype'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import type { SType } from '../src/mir/types'

describe('SType helpers', () => {
  it('detects primitive types', () => {
    const cases: [SType, boolean][] = [
      [{ tag: 'SBoolean' }, true],
      [{ tag: 'SInt' }, true],
      [{ tag: 'SLong' }, true],
      [{ tag: 'SBigInt' }, true],
      [{ tag: 'SGroupElement' }, true],
      [{ tag: 'SColl', elem: { tag: 'SInt' } }, false],
      [{ tag: 'SOption', elem: { tag: 'SInt' } }, false],
      [{ tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SLong' }] }, false]
    ]
    for (const [t, expected] of cases) {
      expect(isPrimitive(t)).toBe(expected)
    }
  })

  it('equates structurally identical types', () => {
    const a: SType = { tag: 'SColl', elem: { tag: 'SInt' } }
    const b: SType = { tag: 'SColl', elem: { tag: 'SInt' } }
    expect(sTypeEquals(a, b)).toBe(true)

    const c: SType = { tag: 'SColl', elem: { tag: 'SLong' } }
    expect(sTypeEquals(a, c)).toBe(false)
  })

  it('equates nested types', () => {
    const a: SType = { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }
    const b: SType = { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }
    expect(sTypeEquals(a, b)).toBe(true)
  })

  it('equates tuples by item order + types', () => {
    const a: SType = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] }
    const b: SType = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] }
    const c: SType = { tag: 'STuple', items: [{ tag: 'SBoolean' }, { tag: 'SInt' }] }
    expect(sTypeEquals(a, b)).toBe(true)
    expect(sTypeEquals(a, c)).toBe(false)
  })

  it('equates SFunc by args + result + tpeParams', () => {
    const a: SType = { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SBoolean' }, tpeParams: [] }
    const b: SType = { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SBoolean' }, tpeParams: [] }
    expect(sTypeEquals(a, b)).toBe(true)

    // Different args
    const c: SType = { tag: 'SFunc', args: [{ tag: 'SLong' }], result: { tag: 'SBoolean' }, tpeParams: [] }
    expect(sTypeEquals(a, c)).toBe(false)

    // Different result
    const d: SType = { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SLong' }, tpeParams: [] }
    expect(sTypeEquals(a, d)).toBe(false)

    // Different arg arity
    const e: SType = { tag: 'SFunc', args: [{ tag: 'SInt' }, { tag: 'SInt' }], result: { tag: 'SBoolean' }, tpeParams: [] }
    expect(sTypeEquals(a, e)).toBe(false)
  })

  it('equates SFunc by tpeParams names', () => {
    const a: SType = {
      tag: 'SFunc',
      args: [{ tag: 'STypeVar', name: 'T' }],
      result: { tag: 'STypeVar', name: 'T' },
      tpeParams: [{ name: 'T' }]
    }
    const b: SType = {
      tag: 'SFunc',
      args: [{ tag: 'STypeVar', name: 'T' }],
      result: { tag: 'STypeVar', name: 'T' },
      tpeParams: [{ name: 'T' }]
    }
    expect(sTypeEquals(a, b)).toBe(true)

    // Different tpeParams names
    const c: SType = {
      tag: 'SFunc',
      args: [{ tag: 'STypeVar', name: 'T' }],
      result: { tag: 'STypeVar', name: 'T' },
      tpeParams: [{ name: 'U' }]
    }
    expect(sTypeEquals(a, c)).toBe(false)
  })

  it('equates STypeVar by name', () => {
    expect(sTypeEquals({ tag: 'STypeVar', name: 'T' }, { tag: 'STypeVar', name: 'T' })).toBe(true)
    expect(sTypeEquals({ tag: 'STypeVar', name: 'T' }, { tag: 'STypeVar', name: 'U' })).toBe(false)
  })
})

/**
 * Wire-format byte values below are extracted from sigma-rust's
 * `ergotree-ir/src/serialization/types.rs` (`TypeCode` enum) and from
 * sigmastate-interpreter's `TypeSerializerSpecification.scala`. Constants:
 *
 *   PrimRange = 12 (MaxPrimTypeCode 11 + 1)
 *   COLL = 12, NESTED_COLL = 24, OPTION = 36, OPTION_COLL = 48,
 *   TUPLE_PAIR1 = 60, TUPLE_PAIR2 = 72, TUPLE_PAIR_SYMMETRIC = 84,
 *   TUPLE = 96 (Tuple with explicit length)
 *
 * Embeddable primitive codes (1..8 modelled; 9 = SUnsignedBigInt is v6-only
 * and not in our discriminated union):
 *   SBoolean=1, SByte=2, SShort=3, SInt=4, SLong=5, SBigInt=6,
 *   SGroupElement=7, SSigmaProp=8.
 *
 * Non-embeddable primitives:
 *   SAny=97, SUnit=98, SBox=99, SAvlTree=100, SContext=101, SString=102,
 *   STypeVar=103, SHeader=104, SPreHeader=105, SGlobal=106, SFunc=112.
 */
describe('SType wire format', () => {
  const cases: { name: string; t: SType; bytes: number[] }[] = [
    // --- Embeddable primitives (1..8) ---
    { name: 'SBoolean', t: { tag: 'SBoolean' }, bytes: [1] },
    { name: 'SByte', t: { tag: 'SByte' }, bytes: [2] },
    { name: 'SShort', t: { tag: 'SShort' }, bytes: [3] },
    { name: 'SInt', t: { tag: 'SInt' }, bytes: [4] },
    { name: 'SLong', t: { tag: 'SLong' }, bytes: [5] },
    { name: 'SBigInt', t: { tag: 'SBigInt' }, bytes: [6] },
    { name: 'SGroupElement', t: { tag: 'SGroupElement' }, bytes: [7] },
    { name: 'SSigmaProp', t: { tag: 'SSigmaProp' }, bytes: [8] },

    // --- Non-embeddable primitives ---
    { name: 'SAny', t: { tag: 'SAny' }, bytes: [97] },
    { name: 'SUnit', t: { tag: 'SUnit' }, bytes: [98] },
    { name: 'SBox', t: { tag: 'SBox' }, bytes: [99] },
    { name: 'SAvlTree', t: { tag: 'SAvlTree' }, bytes: [100] },
    { name: 'SContext', t: { tag: 'SContext' }, bytes: [101] },
    { name: 'SString', t: { tag: 'SString' }, bytes: [102] },
    { name: 'SHeader', t: { tag: 'SHeader' }, bytes: [104] },
    { name: 'SPreHeader', t: { tag: 'SPreHeader' }, bytes: [105] },
    { name: 'SGlobal', t: { tag: 'SGlobal' }, bytes: [106] },

    // --- SColl[primitive] short-form: COLL(12) + primId ---
    { name: 'SColl[SBoolean]', t: { tag: 'SColl', elem: { tag: 'SBoolean' } }, bytes: [13] },
    { name: 'SColl[SByte]', t: { tag: 'SColl', elem: { tag: 'SByte' } }, bytes: [14] },
    { name: 'SColl[SShort]', t: { tag: 'SColl', elem: { tag: 'SShort' } }, bytes: [15] },
    { name: 'SColl[SInt]', t: { tag: 'SColl', elem: { tag: 'SInt' } }, bytes: [16] },
    { name: 'SColl[SLong]', t: { tag: 'SColl', elem: { tag: 'SLong' } }, bytes: [17] },
    { name: 'SColl[SBigInt]', t: { tag: 'SColl', elem: { tag: 'SBigInt' } }, bytes: [18] },
    { name: 'SColl[SGroupElement]', t: { tag: 'SColl', elem: { tag: 'SGroupElement' } }, bytes: [19] },
    { name: 'SColl[SSigmaProp]', t: { tag: 'SColl', elem: { tag: 'SSigmaProp' } }, bytes: [20] },

    // --- SColl[SColl[primitive]] nested short-form: NESTED_COLL(24) + primId ---
    { name: 'SColl[SColl[SByte]]', t: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }, bytes: [26] },
    { name: 'SColl[SColl[SInt]]', t: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SInt' } } }, bytes: [28] },
    { name: 'SColl[SColl[SLong]]', t: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SLong' } } }, bytes: [29] },

    // --- SColl[non-embeddable]: COLL(12) byte + serialize(inner) ---
    { name: 'SColl[SBox]', t: { tag: 'SColl', elem: { tag: 'SBox' } }, bytes: [12, 99] },
    { name: 'SColl[SUnit]', t: { tag: 'SColl', elem: { tag: 'SUnit' } }, bytes: [12, 98] },

    // --- SColl[SColl[non-embeddable]]: COLL(12) + COLL(12) + non-embeddable byte ---
    { name: 'SColl[SColl[SBox]]', t: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SBox' } } }, bytes: [12, 12, 99] },

    // --- SColl[SColl[SColl[primitive]]]: COLL(12) + NESTED_COLL(24+primId) ---
    {
      name: 'SColl[SColl[SColl[SByte]]]',
      t: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SByte' } } } },
      bytes: [12, 26]
    },

    // --- SOption[primitive] short-form: OPTION(36) + primId ---
    { name: 'SOption[SBoolean]', t: { tag: 'SOption', elem: { tag: 'SBoolean' } }, bytes: [37] },
    { name: 'SOption[SInt]', t: { tag: 'SOption', elem: { tag: 'SInt' } }, bytes: [40] },
    { name: 'SOption[SLong]', t: { tag: 'SOption', elem: { tag: 'SLong' } }, bytes: [41] },
    { name: 'SOption[SGroupElement]', t: { tag: 'SOption', elem: { tag: 'SGroupElement' } }, bytes: [43] },

    // --- SOption[SColl[primitive]] short-form: OPTION_COLL(48) + primId ---
    { name: 'SOption[SColl[SByte]]', t: { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }, bytes: [50] },
    { name: 'SOption[SColl[SInt]]', t: { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SInt' } } }, bytes: [52] },

    // --- SOption[non-embeddable]: OPTION(36) + serialize(inner) ---
    { name: 'SOption[SBox]', t: { tag: 'SOption', elem: { tag: 'SBox' } }, bytes: [36, 99] },
    { name: 'SOption[SAvlTree]', t: { tag: 'SOption', elem: { tag: 'SAvlTree' } }, bytes: [36, 100] },

    // --- SOption[SColl[non-embeddable]]: OPTION(36) + COLL(12) + non-embeddable byte ---
    { name: 'SOption[SColl[SBox]]', t: { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SBox' } } }, bytes: [36, 12, 99] },

    // --- SOption[STuple]: OPTION(36) + serialize(tuple) ---
    {
      name: 'SOption[STuple[SInt,SInt]]',
      t: { tag: 'SOption', elem: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }] } },
      // SYMMETRIC(84) + SInt(4) = 88
      bytes: [36, 88]
    },

    // --- STuple pair symmetric primitive: SYMMETRIC(84) + primId ---
    {
      name: 'STuple[SInt,SInt] (symmetric)',
      t: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }] },
      bytes: [88]
    },
    {
      name: 'STuple[SLong,SLong] (symmetric)',
      t: { tag: 'STuple', items: [{ tag: 'SLong' }, { tag: 'SLong' }] },
      bytes: [89]
    },
    {
      name: 'STuple[SBoolean,SBoolean] (symmetric)',
      t: { tag: 'STuple', items: [{ tag: 'SBoolean' }, { tag: 'SBoolean' }] },
      bytes: [85]
    },

    // --- STuple pair1: first item is embeddable primitive ---
    {
      name: 'STuple[SInt,SBox] (pair1: prim,non-prim)',
      t: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBox' }] },
      // PAIR1(60) + SInt(4) = 64, then SBox(99)
      bytes: [64, 99]
    },
    {
      name: 'STuple[SByte,SLong] (pair1: prim,prim diff)',
      t: { tag: 'STuple', items: [{ tag: 'SByte' }, { tag: 'SLong' }] },
      // PAIR1(60) + SByte(2) = 62, then SLong(5)
      bytes: [62, 5]
    },

    // --- STuple pair2: only second item is embeddable primitive ---
    {
      name: 'STuple[SBox,SInt] (pair2: non-prim,prim)',
      t: { tag: 'STuple', items: [{ tag: 'SBox' }, { tag: 'SInt' }] },
      // PAIR2(72) + SInt(4) = 76, then SBox(99)
      bytes: [76, 99]
    },

    // --- STuple pair of non-primitives: PAIR1(60) base + serialize(t1) + serialize(t2) ---
    {
      name: 'STuple[SBox,SAvlTree] (both non-prim)',
      t: { tag: 'STuple', items: [{ tag: 'SBox' }, { tag: 'SAvlTree' }] },
      bytes: [60, 99, 100]
    },
    {
      name: 'STuple[SColl[SLong],SColl[SLong]] (both non-prim, both colls; not symmetric)',
      t: { tag: 'STuple', items: [{ tag: 'SColl', elem: { tag: 'SLong' } }, { tag: 'SColl', elem: { tag: 'SLong' } }] },
      // PAIR1(60), then SColl[SLong] (17), then SColl[SLong] (17)
      bytes: [60, 17, 17]
    },

    // --- STuple triple (3 items): PAIR2(72) base + serialize each ---
    {
      name: 'STuple[SLong,SLong,SByte]',
      t: {
        tag: 'STuple',
        items: [{ tag: 'SLong' }, { tag: 'SLong' }, { tag: 'SByte' }]
      },
      bytes: [72, 5, 5, 2]
    },

    // --- STuple quadruple (4 items): SYMMETRIC(84) base + serialize each ---
    {
      name: 'STuple[SLong,SLong,SByte,SBoolean]',
      t: {
        tag: 'STuple',
        items: [{ tag: 'SLong' }, { tag: 'SLong' }, { tag: 'SByte' }, { tag: 'SBoolean' }]
      },
      bytes: [84, 5, 5, 2, 1]
    },

    // --- STuple of 5+ items: TUPLE(96) + u8 length + each ---
    {
      name: 'STuple of 5 items (Long,Long,Byte,Boolean,Int)',
      t: {
        tag: 'STuple',
        items: [
          { tag: 'SLong' },
          { tag: 'SLong' },
          { tag: 'SByte' },
          { tag: 'SBoolean' },
          { tag: 'SInt' }
        ]
      },
      bytes: [96, 5, 5, 5, 2, 1, 4]
    },

    // --- STypeVar: TYPE_VAR(103) + u8 len + utf8 bytes ---
    {
      name: 'STypeVar "T"',
      t: { tag: 'STypeVar', name: 'T' },
      bytes: [103, 1, 0x54]
    },
    {
      name: 'STypeVar "IV"',
      t: { tag: 'STypeVar', name: 'IV' },
      bytes: [103, 2, 0x49, 0x56]
    },

    // --- SFunc: SFUNC(112) + u8 t_dom_len + each t_dom + t_range +
    //              u8 tpe_params_len + each tpe_param (as STypeVar) ---
    {
      name: 'SFunc (Int) => Boolean, no tpeParams',
      t: { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SBoolean' }, tpeParams: [] },
      // SFUNC(112), t_dom_len(1), SInt(4), SBoolean(1), tpe_params_len(0)
      bytes: [112, 1, 4, 1, 0]
    },
    {
      name: 'SFunc () => Unit, no tpeParams',
      t: { tag: 'SFunc', args: [], result: { tag: 'SUnit' }, tpeParams: [] },
      bytes: [112, 0, 98, 0]
    },
    {
      name: 'SFunc (Int, Long) => Boolean',
      t: {
        tag: 'SFunc',
        args: [{ tag: 'SInt' }, { tag: 'SLong' }],
        result: { tag: 'SBoolean' },
        tpeParams: []
      },
      bytes: [112, 2, 4, 5, 1, 0]
    },
    {
      name: 'SFunc (T) => T with tpeParams [T]',
      t: {
        tag: 'SFunc',
        args: [{ tag: 'STypeVar', name: 'T' }],
        result: { tag: 'STypeVar', name: 'T' },
        tpeParams: [{ name: 'T' }]
      },
      // SFUNC(112), t_dom_len(1), STypeVar 'T' (103,1,0x54), STypeVar 'T' result (103,1,0x54), tpe_params_len(1), STypeVar 'T' (103,1,0x54)
      bytes: [112, 1, 103, 1, 0x54, 103, 1, 0x54, 1, 103, 1, 0x54]
    }
  ]

  for (const { name, t, bytes } of cases) {
    it(`parses ${name}`, () => {
      const r = new ByteReader(new Uint8Array(bytes))
      const parsed = parseSType(r)
      expect(parsed).toEqual(t)
      expect(r.remaining).toBe(0)
    })
    it(`serializes ${name}`, () => {
      const w = new ByteWriter()
      serializeSType(t, w)
      expect(Array.from(w.toBytes())).toEqual(bytes)
    })
  }

  it('rejects unknown type code 0', () => {
    const r = new ByteReader(new Uint8Array([0]))
    expect(() => parseSType(r)).toThrow(STypeParseError)
  })

  it('rejects SUnsignedBigInt primitive type code (9)', () => {
    const r = new ByteReader(new Uint8Array([9]))
    expect(() => parseSType(r)).toThrow(STypeParseError)
  })

  it('rejects SColl[SUnsignedBigInt] short-form (12 + 9 = 21)', () => {
    const r = new ByteReader(new Uint8Array([21]))
    expect(() => parseSType(r)).toThrow(STypeParseError)
  })

  it('rejects unknown high type code (110)', () => {
    // 110 is between SGlobal (106) and SFUNC (112), not in our table.
    const r = new ByteReader(new Uint8Array([110]))
    expect(() => parseSType(r)).toThrow(STypeParseError)
  })

  it('rejects truncated STypeVar (empty name bytes)', () => {
    // STypeVar with name_bytes length 0 violates BoundedVec 1..254
    const r = new ByteReader(new Uint8Array([103, 0]))
    expect(() => parseSType(r)).toThrow(STypeParseError)
  })

  it('rejects SFunc tpe_params containing non-STypeVar', () => {
    // SFunc (Int) => Boolean, tpe_params_len(1), then SInt(4) as a tpe_param — illegal
    const r = new ByteReader(new Uint8Array([112, 1, 4, 1, 1, 4]))
    expect(() => parseSType(r)).toThrow(STypeParseError)
  })

  it('parser rejects STypeVar with invalid UTF-8', () => {
    // [tag=103, len=1, byte=0xff] — 0xff is an invalid UTF-8 lead byte
    // (it's never valid as either a single-byte ASCII or a multi-byte lead).
    const bytes = new Uint8Array([103, 1, 0xff])
    expect(() => parseSType(new ByteReader(bytes))).toThrow(STypeParseError)
  })

  it('serializer rejects STypeVar with empty name', () => {
    const w = new ByteWriter()
    expect(() => serializeSType({ tag: 'STypeVar', name: '' }, w)).toThrow(STypeSerializeError)
  })

  it('serializer rejects STypeVar with name > 254 bytes', () => {
    const w = new ByteWriter()
    const longName = 'A'.repeat(255)
    expect(() => serializeSType({ tag: 'STypeVar', name: longName }, w)).toThrow(STypeSerializeError)
  })

  it('serializer rejects STuple with fewer than 2 items', () => {
    const w = new ByteWriter()
    expect(() => serializeSType({ tag: 'STuple', items: [{ tag: 'SInt' }] }, w)).toThrow(STypeSerializeError)
  })

  it('serializer rejects STuple with > 255 items', () => {
    const w = new ByteWriter()
    const items: SType[] = Array.from({ length: 256 }, () => ({ tag: 'SInt' }))
    expect(() => serializeSType({ tag: 'STuple', items }, w)).toThrow(STypeSerializeError)
  })

  it('serializer rejects SFunc with t_dom > 255', () => {
    const w = new ByteWriter()
    const args: SType[] = Array.from({ length: 256 }, () => ({ tag: 'SByte' }))
    expect(() => serializeSType({ tag: 'SFunc', args, result: { tag: 'SByte' }, tpeParams: [] }, w)).toThrow(STypeSerializeError)
  })

  it('serializer rejects SFunc with tpeParams > 255', () => {
    const w = new ByteWriter()
    const tpeParams = Array.from({ length: 256 }, () => ({ name: 'T' }))
    expect(() => serializeSType({ tag: 'SFunc', args: [], result: { tag: 'SUnit' }, tpeParams }, w)).toThrow(STypeSerializeError)
  })
})
