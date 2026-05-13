import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../src/mir/types'
import { parseSValue, SValueParseError } from '../src/wire/parse-svalue'
import { serializeSValue, SValueSerializeError } from '../src/wire/serialize-svalue'
import { ByteReader } from '../src/wire/reader'
import { ByteWriter } from '../src/wire/writer'

describe('SValue (variant smoke tests)', () => {
  it('Boolean variant', () => {
    const v: SValue = { kind: 'Boolean', value: true }
    expect(v.kind).toBe('Boolean')
    expect(v.value).toBe(true)
  })
  it('Long variant uses bigint', () => {
    const v: SValue = { kind: 'Long', value: 1234567890123456789n }
    expect(v.value).toBe(1234567890123456789n)
  })
  it('Coll variant carries element type', () => {
    const v: SValue = {
      kind: 'Coll',
      elem: { tag: 'SInt' },
      items: [
        { kind: 'Int', value: 1 },
        { kind: 'Int', value: 2 },
      ],
    }
    expect(v.items.length).toBe(2)
    expect(v.elem.tag).toBe('SInt')
  })
})

/**
 * Round-trip cases: each entry is (name, SType, SValue, expected bytes).
 *
 * Encoding rules verified against sigma-rust's
 * `ergotree-ir/src/serialization/data.rs::DataSerializer::sigma_serialize`
 * and `sigma-ser/src/vlq_encode.rs`:
 *
 *  - SBoolean        → 1 byte (0 or 1)
 *  - SByte           → 1 raw byte (i8, two's complement)
 *  - SShort, SInt    → ZigZag VLQ (put_i16 / put_i32 share the i32 zigzag path)
 *  - SLong           → ZigZag VLQ i64
 *  - SBigInt         → VLQ-u16 length + big-endian signed two's-complement bytes (minimal)
 *  - SGroupElement   → 33 raw bytes (SEC1 compressed; identity = all zeros)
 *  - SUnit           → 0 bytes
 *  - SColl[SByte]    → VLQ-u16 length + raw bytes (NativeColl special case)
 *  - SColl[SBoolean] → VLQ-u16 length + LSB-first bit-packed bytes
 *  - SColl[T] other  → VLQ-u16 length + each item serialized as T
 *  - SOption[T]      → 1-byte tag (0 None, 1 Some) + (if Some) inner
 *  - STuple[T..]     → items in order, NO length prefix
 */
interface RoundTripCase {
  name: string
  t: SType
  v: SValue
  bytes: number[]
}

const cases: RoundTripCase[] = [
  // -- SBoolean --
  { name: 'SBoolean true',  t: { tag: 'SBoolean' }, v: { kind: 'Boolean', value: true  }, bytes: [0x01] },
  { name: 'SBoolean false', t: { tag: 'SBoolean' }, v: { kind: 'Boolean', value: false }, bytes: [0x00] },

  // -- SByte (raw i8, two's complement) --
  { name: 'SByte 0',    t: { tag: 'SByte' }, v: { kind: 'Byte', value: 0    }, bytes: [0x00] },
  { name: 'SByte 1',    t: { tag: 'SByte' }, v: { kind: 'Byte', value: 1    }, bytes: [0x01] },
  { name: 'SByte -1',   t: { tag: 'SByte' }, v: { kind: 'Byte', value: -1   }, bytes: [0xff] },
  { name: 'SByte 127',  t: { tag: 'SByte' }, v: { kind: 'Byte', value: 127  }, bytes: [0x7f] },
  { name: 'SByte -128', t: { tag: 'SByte' }, v: { kind: 'Byte', value: -128 }, bytes: [0x80] },

  // -- SShort (ZigZag VLQ via i32 path) --
  { name: 'SShort 0',  t: { tag: 'SShort' }, v: { kind: 'Short', value: 0  }, bytes: [0x00] },
  { name: 'SShort 1',  t: { tag: 'SShort' }, v: { kind: 'Short', value: 1  }, bytes: [0x02] },
  { name: 'SShort -1', t: { tag: 'SShort' }, v: { kind: 'Short', value: -1 }, bytes: [0x01] },
  { name: 'SShort 64', t: { tag: 'SShort' }, v: { kind: 'Short', value: 64 }, bytes: [0x80, 0x01] },

  // -- SInt (ZigZag VLQ) --
  { name: 'SInt 0',  t: { tag: 'SInt' }, v: { kind: 'Int', value: 0  }, bytes: [0x00] },
  { name: 'SInt 42', t: { tag: 'SInt' }, v: { kind: 'Int', value: 42 }, bytes: [0x54] }, // ZigZag(42) = 84 = 0x54
  { name: 'SInt -1', t: { tag: 'SInt' }, v: { kind: 'Int', value: -1 }, bytes: [0x01] }, // ZigZag(-1) = 1

  // -- SLong (ZigZag VLQ i64) --
  { name: 'SLong 0',  t: { tag: 'SLong' }, v: { kind: 'Long', value: 0n  }, bytes: [0x00] },
  { name: 'SLong 1',  t: { tag: 'SLong' }, v: { kind: 'Long', value: 1n  }, bytes: [0x02] },
  { name: 'SLong -1', t: { tag: 'SLong' }, v: { kind: 'Long', value: -1n }, bytes: [0x01] },
  // i64::MAX = 0x7fffffffffffffff. ZigZag = 0xfffffffffffffffe. As 10 VLQ bytes.
  { name: 'SLong i64::MAX',
    t: { tag: 'SLong' },
    v: { kind: 'Long', value: 0x7fffffffffffffffn },
    bytes: [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01] },
  // i64::MIN. ZigZag(i64::MIN) = (u64::MAX) = all-1s. As 10 VLQ bytes.
  { name: 'SLong i64::MIN',
    t: { tag: 'SLong' },
    v: { kind: 'Long', value: -(1n << 63n) },
    bytes: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01] },

  // -- SBigInt (VLQ-u16 length + big-endian two's-complement bytes, minimal) --
  // sigma-rust BigInt256::to_be_vec returns:
  //   - For 0n: [0x00]
  //   - For positive with MSB of first byte set: prepend 0x00 (disambiguate from negative)
  //   - For negative: drain leading 0xff bytes such that exactly one negative-encoding byte remains
  //     where MSB is still set (i.e. the value sign-extends correctly).
  { name: 'SBigInt 0',    t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: 0n    }, bytes: [0x01, 0x00] },
  { name: 'SBigInt 1',    t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: 1n    }, bytes: [0x01, 0x01] },
  { name: 'SBigInt 127',  t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: 127n  }, bytes: [0x01, 0x7f] },
  { name: 'SBigInt 128',  t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: 128n  }, bytes: [0x02, 0x00, 0x80] },
  { name: 'SBigInt 255',  t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: 255n  }, bytes: [0x02, 0x00, 0xff] },
  { name: 'SBigInt 256',  t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: 256n  }, bytes: [0x02, 0x01, 0x00] },
  { name: 'SBigInt -1',   t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: -1n   }, bytes: [0x01, 0xff] },
  { name: 'SBigInt -128', t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: -128n }, bytes: [0x01, 0x80] },
  { name: 'SBigInt -129', t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: -129n }, bytes: [0x02, 0xff, 0x7f] },
  { name: 'SBigInt -256', t: { tag: 'SBigInt' }, v: { kind: 'BigInt', value: -256n }, bytes: [0x02, 0xff, 0x00] },

  // -- SGroupElement (33 raw bytes, no length prefix) --
  // Compressed point with even Y (prefix 0x02), x-coordinate filled with 0xab.
  {
    name: 'SGroupElement compressed',
    t: { tag: 'SGroupElement' },
    v: { kind: 'GroupElement', value: new Uint8Array([
      0x02,
      0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
      0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
      0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
      0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
    ])},
    bytes: [
      0x02,
      0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
      0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
      0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
      0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab,
    ],
  },
  // Infinity (identity) is 33 zero bytes per sigma-rust ec_point::scorex_serialize.
  {
    name: 'SGroupElement infinity',
    t: { tag: 'SGroupElement' },
    v: { kind: 'GroupElement', value: new Uint8Array(33) },
    bytes: Array.from(new Uint8Array(33)),
  },

  // -- SUnit (0 bytes) --
  { name: 'SUnit', t: { tag: 'SUnit' }, v: { kind: 'Unit' }, bytes: [] },

  // -- SColl --
  // Empty: VLQ-u16(0) = [0x00], no items.
  {
    name: 'SColl[SInt] []',
    t: { tag: 'SColl', elem: { tag: 'SInt' } },
    v: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
    bytes: [0x00],
  },
  // Three SInts: VLQ-u16(3) + ZigZag(1,2,3) = [0x03, 0x02, 0x04, 0x06]
  {
    name: 'SColl[SInt] [1,2,3]',
    t: { tag: 'SColl', elem: { tag: 'SInt' } },
    v: { kind: 'Coll', elem: { tag: 'SInt' }, items: [
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
      { kind: 'Int', value: 3 },
    ]},
    bytes: [0x03, 0x02, 0x04, 0x06],
  },
  // SColl[SByte]: special-cased to NativeColl. Length is VLQ-u16, then raw bytes (no per-element wrapping).
  {
    name: 'SColl[SByte] [0x00, 0xff, 0x7f, 0x80]',
    t: { tag: 'SColl', elem: { tag: 'SByte' } },
    v: { kind: 'Coll', elem: { tag: 'SByte' }, items: [
      { kind: 'Byte', value: 0 },
      { kind: 'Byte', value: -1 },
      { kind: 'Byte', value: 127 },
      { kind: 'Byte', value: -128 },
    ]},
    bytes: [0x04, 0x00, 0xff, 0x7f, 0x80],
  },
  {
    name: 'SColl[SByte] empty',
    t: { tag: 'SColl', elem: { tag: 'SByte' } },
    v: { kind: 'Coll', elem: { tag: 'SByte' }, items: [] },
    bytes: [0x00],
  },
  // SColl[SBoolean]: bit-packed LSB-first. 5 bools = ceil(5/8) = 1 byte.
  // [true,false,true,true,false] → bit positions 0,2,3 set → 0b00001101 = 0x0d.
  {
    name: 'SColl[SBoolean] [T,F,T,T,F]',
    t: { tag: 'SColl', elem: { tag: 'SBoolean' } },
    v: { kind: 'Coll', elem: { tag: 'SBoolean' }, items: [
      { kind: 'Boolean', value: true },
      { kind: 'Boolean', value: false },
      { kind: 'Boolean', value: true },
      { kind: 'Boolean', value: true },
      { kind: 'Boolean', value: false },
    ]},
    bytes: [0x05, 0x0d],
  },
  // 9 bools = ceil(9/8) = 2 bytes.
  // [F,F,F,F,F,F,F,F,T] → bit 8 of byte 1 = bit 0 of byte 1 → 0x00, 0x01
  {
    name: 'SColl[SBoolean] 9 elems',
    t: { tag: 'SColl', elem: { tag: 'SBoolean' } },
    v: { kind: 'Coll', elem: { tag: 'SBoolean' }, items: [
      { kind: 'Boolean', value: false }, { kind: 'Boolean', value: false },
      { kind: 'Boolean', value: false }, { kind: 'Boolean', value: false },
      { kind: 'Boolean', value: false }, { kind: 'Boolean', value: false },
      { kind: 'Boolean', value: false }, { kind: 'Boolean', value: false },
      { kind: 'Boolean', value: true },
    ]},
    bytes: [0x09, 0x00, 0x01],
  },
  // Nested SColl: SColl[SColl[SInt]] = [[1], [], [2,3]]
  // Outer VLQ-u16(3) + each inner Coll
  // inner [1]   → VLQ-u16(1) + ZigZag(1) = [0x01, 0x02]
  // inner []    → [0x00]
  // inner [2,3] → VLQ-u16(2) + ZigZag(2,3) = [0x02, 0x04, 0x06]
  // total: [0x03, 0x01, 0x02, 0x00, 0x02, 0x04, 0x06]
  {
    name: 'SColl[SColl[SInt]] [[1],[],[2,3]]',
    t: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SInt' } } },
    v: { kind: 'Coll', elem: { tag: 'SColl', elem: { tag: 'SInt' } }, items: [
      { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }] },
      { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
      { kind: 'Coll', elem: { tag: 'SInt' }, items: [
        { kind: 'Int', value: 2 },
        { kind: 'Int', value: 3 },
      ] },
    ]},
    bytes: [0x03, 0x01, 0x02, 0x00, 0x02, 0x04, 0x06],
  },

  // -- SOption (v6/V3+ encoding: 1-byte tag + optional inner) --
  {
    name: 'SOption[SInt] None',
    t: { tag: 'SOption', elem: { tag: 'SInt' } },
    v: { kind: 'Option', elem: { tag: 'SInt' }, value: null },
    bytes: [0x00],
  },
  {
    name: 'SOption[SInt] Some(42)',
    t: { tag: 'SOption', elem: { tag: 'SInt' } },
    v: { kind: 'Option', elem: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
    bytes: [0x01, 0x54],
  },

  // -- STuple (no length prefix; arity comes from the SType) --
  {
    name: 'STuple[SInt, SBoolean] (1, true)',
    t: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] },
    v: { kind: 'Tuple', items: [
      { kind: 'Int', value: 1 },
      { kind: 'Boolean', value: true },
    ]},
    bytes: [0x02, 0x01],
  },
  {
    name: 'STuple[SInt, SInt, SInt] (1, 2, 3)',
    t: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }, { tag: 'SInt' }] },
    v: { kind: 'Tuple', items: [
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
      { kind: 'Int', value: 3 },
    ]},
    bytes: [0x02, 0x04, 0x06],
  },
  // 4-element tuple
  {
    name: 'STuple[SByte x4] (1, 2, 3, 4)',
    t: { tag: 'STuple', items: [
      { tag: 'SByte' }, { tag: 'SByte' }, { tag: 'SByte' }, { tag: 'SByte' },
    ]},
    v: { kind: 'Tuple', items: [
      { kind: 'Byte', value: 1 },
      { kind: 'Byte', value: 2 },
      { kind: 'Byte', value: 3 },
      { kind: 'Byte', value: 4 },
    ]},
    bytes: [0x01, 0x02, 0x03, 0x04],
  },
  // 5-element tuple (still no length prefix — caller knows arity from SType.items)
  {
    name: 'STuple[SBoolean x5] (T,F,T,F,T)',
    t: { tag: 'STuple', items: [
      { tag: 'SBoolean' }, { tag: 'SBoolean' }, { tag: 'SBoolean' },
      { tag: 'SBoolean' }, { tag: 'SBoolean' },
    ]},
    v: { kind: 'Tuple', items: [
      { kind: 'Boolean', value: true },
      { kind: 'Boolean', value: false },
      { kind: 'Boolean', value: true },
      { kind: 'Boolean', value: false },
      { kind: 'Boolean', value: true },
    ]},
    bytes: [0x01, 0x00, 0x01, 0x00, 0x01],
  },
]

describe('SValue wire round-trip', () => {
  for (const { name, t, v, bytes } of cases) {
    it(`parses ${name}`, () => {
      const r = new ByteReader(new Uint8Array(bytes))
      expect(parseSValue(t, r)).toEqual(v)
      // After parsing the value, the reader must be exhausted (no trailing bytes).
      expect(r.isExhausted).toBe(true)
    })
    it(`serializes ${name}`, () => {
      const w = new ByteWriter()
      serializeSValue(t, v, w)
      expect(Array.from(w.toBytes())).toEqual(bytes)
    })
  }
})

describe('SValue deferred-kind errors', () => {
  // Kinds that have no inline Const(SValue) wire form in phase 2a.
  // parseSValue must throw `SValueParseError` with code `not-implemented-phase-2a`.
  const deferred: SType[] = [
    { tag: 'SBox' },
    { tag: 'SAvlTree' },
    { tag: 'SSigmaProp' },
    { tag: 'SHeader' },
    { tag: 'SPreHeader' },
    { tag: 'SContext' },
    { tag: 'SGlobal' },
    { tag: 'SAny' },
    { tag: 'SString' },
    { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SInt' }, tpeParams: [] },
    { tag: 'STypeVar', name: 'T' },
  ]
  for (const t of deferred) {
    it(`parseSValue ${t.tag} throws not-implemented-phase-2a`, () => {
      const r = new ByteReader(new Uint8Array([0x00]))
      try {
        parseSValue(t, r)
        expect.fail(`expected throw for ${t.tag}`)
      } catch (e) {
        expect(e).toBeInstanceOf(SValueParseError)
        expect((e as SValueParseError).code).toBe('not-implemented-phase-2a')
      }
    })
  }
})

describe('SValue serialize: type-mismatch detection', () => {
  it('throws SValueSerializeError when SValue.kind does not match SType.tag', () => {
    const w = new ByteWriter()
    expect(() =>
      serializeSValue({ tag: 'SBoolean' }, { kind: 'Int', value: 1 }, w)
    ).toThrow(SValueSerializeError)
  })

  it('throws SValueSerializeError on GroupElement with wrong byte length', () => {
    const w = new ByteWriter()
    expect(() =>
      serializeSValue(
        { tag: 'SGroupElement' },
        { kind: 'GroupElement', value: new Uint8Array(32) /* wrong length */ },
        w
      )
    ).toThrow(SValueSerializeError)
  })

  it('throws SValueSerializeError on STuple arity mismatch', () => {
    const w = new ByteWriter()
    expect(() =>
      serializeSValue(
        { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }] },
        { kind: 'Tuple', items: [{ kind: 'Int', value: 1 }] /* wrong arity */ },
        w
      )
    ).toThrow(SValueSerializeError)
  })
})
