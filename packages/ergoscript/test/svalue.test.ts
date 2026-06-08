import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../src/mir/types'
import { parseSValue, SValueParseError } from '../src/wire/parse-svalue'
import { serializeSValue, SValueSerializeError } from '../src/wire/serialize-svalue'
import { ByteReader, ByteWriter } from '@ergots/scorex'

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
 *  - SOption[T]      → 1-byte tag (1 Some, anything else None) + (if Some) inner
 *  - STuple[T..]     → items in order, NO length prefix
 */
interface RoundTripCase {
  name: string
  t: SType
  v: SValue
  bytes: number[]
  /** treeVersion passed to parse/serialize; defaults to 0. SOption requires 3. */
  treeVersion?: number
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

  // -- SShort (ZigZag VLQ via i32 path; final wire bytes go through `as u32`) --
  { name: 'SShort 0',  t: { tag: 'SShort' }, v: { kind: 'Short', value: 0  }, bytes: [0x00] },
  { name: 'SShort 1',  t: { tag: 'SShort' }, v: { kind: 'Short', value: 1  }, bytes: [0x02] },
  { name: 'SShort -1', t: { tag: 'SShort' }, v: { kind: 'Short', value: -1 }, bytes: [0x01] },
  { name: 'SShort 64', t: { tag: 'SShort' }, v: { kind: 'Short', value: 64 }, bytes: [0x80, 0x01] },
  // Boundary cases — i16::MAX / i16::MIN. sigma-rust `put_i16` does
  // `put_u32(encode_i32(v as i32) as u32)`, so the wire stays within 5 bytes
  // (no sign-extension past i32). Verified against fixture-gen output.
  { name: 'SShort i16::MAX',
    t: { tag: 'SShort' }, v: { kind: 'Short', value: 32767 },
    bytes: [0xfe, 0xff, 0x03] }, // ZigZag(32767) = 65534 = 0xfffe → VLQ
  { name: 'SShort i16::MIN',
    t: { tag: 'SShort' }, v: { kind: 'Short', value: -32768 },
    bytes: [0xff, 0xff, 0x03] }, // ZigZag(-32768) = 65535 = 0xffff → VLQ

  // -- SInt (ZigZag VLQ via i32 path; final wire bytes go through `as u64`) --
  { name: 'SInt 0',  t: { tag: 'SInt' }, v: { kind: 'Int', value: 0  }, bytes: [0x00] },
  { name: 'SInt 42', t: { tag: 'SInt' }, v: { kind: 'Int', value: 42 }, bytes: [0x54] }, // ZigZag(42) = 84 = 0x54
  { name: 'SInt -1', t: { tag: 'SInt' }, v: { kind: 'Int', value: -1 }, bytes: [0x01] }, // ZigZag(-1) = 1
  // Boundary cases — i32::MAX / i32::MIN. sigma-rust `put_i32` does
  // `put_u64(encode_i32(v))` where `encode_i32` casts the i32 ZigZag result
  // to u64 (i32 → u64 sign-extends in Rust). So `i32::MAX` ZigZags to
  // `0xFFFFFFFE` as i32 which becomes `0xFFFFFFFFFFFFFFFE` as u64, encoded
  // as 10 VLQ bytes. A naive i64-zigzag decoder would mis-narrow this to
  // `i64::MAX = 9223372036854775807`; the correct decoder u32-truncates
  // before ZigZag-decoding in i32 space.
  { name: 'SInt i32::MAX',
    t: { tag: 'SInt' }, v: { kind: 'Int', value: 2147483647 },
    bytes: [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01] },
  { name: 'SInt i32::MIN',
    t: { tag: 'SInt' }, v: { kind: 'Int', value: -2147483648 },
    bytes: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01] },

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

  // -- SOption (V3+ gate: CoreDataSerializer.scala:140-143 + :78-82) --
  {
    name: 'SOption[SInt] None',
    t: { tag: 'SOption', elem: { tag: 'SInt' } },
    v: { kind: 'Option', elem: { tag: 'SInt' }, value: null },
    bytes: [0x00],
    treeVersion: 3, // Option DATA requires tree-version >= 3
  },
  {
    name: 'SOption[SInt] Some(42)',
    t: { tag: 'SOption', elem: { tag: 'SInt' } },
    v: { kind: 'Option', elem: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
    bytes: [0x01, 0x54],
    treeVersion: 3, // Option DATA requires tree-version >= 3
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
  for (const { name, t, v, bytes, treeVersion: tv = 0 } of cases) {
    it(`parses ${name}`, () => {
      const r = new ByteReader(new Uint8Array(bytes))
      expect(parseSValue(t, tv, r)).toEqual(v)
      // After parsing the value, the reader must be exhausted (no trailing bytes).
      expect(r.isExhausted).toBe(true)
    })
    it(`serializes ${name}`, () => {
      const w = new ByteWriter()
      serializeSValue(t, v, tv, w)
      expect(Array.from(w.toBytes())).toEqual(bytes)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ERG-06 regression — serialize-side numeric range checks. Pre-fix the
// serializer silently masked or truncated out-of-range values; post-fix it
// throws SValueSerializeError('numeric-out-of-range') so callers can't build
// constants that round-trip to a DIFFERENT value.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ERG-03 regression — parseSValue must reject zero-length SBigInt. sigma-rust's
// BigInt256::from_be_slice returns None for empty input (bigint256.rs:38).
// Pre-fix we accepted length 0 and decoded as `0n`, then the serializer rewrote
// as length 1 — breaking byte-identical round-trip.
// ─────────────────────────────────────────────────────────────────────────────
describe('SValue ERG-03 zero-length SBigInt', () => {
  it('parseSValue(SBigInt, [length=0]) throws bigint-empty', () => {
    // VLQ encoding of length 0 is single byte 0x00.
    const bytes = new Uint8Array([0x00])
    const r = new ByteReader(bytes)
    try {
      parseSValue({ tag: 'SBigInt' }, 0, r)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SValueParseError)
      expect((e as SValueParseError).code).toBe('bigint-empty')
    }
  })
})

describe('SValue ERG-06 numeric range checks', () => {
  it.each([
    [256, 'SByte'],
    [-129, 'SByte'],
    [128, 'SByte'],
  ])('serializeSValue(SByte, %s) → numeric-out-of-range', (value, _name) => {
    const w = new ByteWriter()
    try {
      serializeSValue({ tag: 'SByte' }, { kind: 'Byte', value: value as number }, 0, w)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SValueSerializeError)
      expect((e as SValueSerializeError).code).toBe('numeric-out-of-range')
    }
  })

  it.each([
    [65535, 'SShort'],
    [-32769, 'SShort'],
    [32768, 'SShort'],
  ])('serializeSValue(SShort, %s) → numeric-out-of-range', (value, _name) => {
    const w = new ByteWriter()
    try {
      serializeSValue({ tag: 'SShort' }, { kind: 'Short', value: value as number }, 0, w)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SValueSerializeError)
      expect((e as SValueSerializeError).code).toBe('numeric-out-of-range')
    }
  })

  it('serializeSValue(SInt, 4294967296) → numeric-out-of-range', () => {
    const w = new ByteWriter()
    try {
      serializeSValue({ tag: 'SInt' }, { kind: 'Int', value: 4294967296 }, 0, w)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SValueSerializeError)
      expect((e as SValueSerializeError).code).toBe('numeric-out-of-range')
    }
  })

  it('serializeSValue(SLong, 2^63) → numeric-out-of-range', () => {
    const w = new ByteWriter()
    try {
      serializeSValue({ tag: 'SLong' }, { kind: 'Long', value: 9223372036854775808n }, 0, w)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SValueSerializeError)
      expect((e as SValueSerializeError).code).toBe('numeric-out-of-range')
    }
  })
})

describe('SValue deferred-kind errors', () => {
  // Kinds that have no inline Const(SValue) wire form in phase 2a.
  // parseSValue must throw `SValueParseError` with code `not-implemented-phase-2a`.
  //
  // SSigmaProp is supported (added in Task 27 for address derivation); it
  // does not appear in this deferred list. Its parse/serialize behavior
  // is covered by `describe('SValue SSigmaProp …')` below.
  const deferred: SType[] = [
    // SBox is implemented in phase 2f (see test/wire/sbox-roundtrip.test.ts)
    // SAvlTree is implemented in phase 2h-b (see test/wire/svalue-savltree.test.ts)
    // SHeader is implemented in phase 2h-c.1 (V3-gated; see test/wire/svalue-sheader-v3-parse.test.ts)
    // SString implemented in iter-17 (h=766,915 tx 15 output 1); see SString roundtrip test below
    { tag: 'SPreHeader' },
    { tag: 'SContext' },
    { tag: 'SGlobal' },
    { tag: 'SAny' },
    { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SInt' }, tpeParams: [] },
    { tag: 'STypeVar', name: 'T' },
  ]
  for (const t of deferred) {
    it(`parseSValue ${t.tag} throws not-implemented-phase-2a`, () => {
      const r = new ByteReader(new Uint8Array([0x00]))
      try {
        parseSValue(t, 0, r)
        expect.fail(`expected throw for ${t.tag}`)
      } catch (e) {
        expect(e).toBeInstanceOf(SValueParseError)
        expect((e as SValueParseError).code).toBe('not-implemented-phase-2a')
      }
    })
  }

  // Iter-17: SString parse + serialize (VLQ length + UTF-8 bytes). Roundtrip
  // covers ASCII, empty, multi-byte UTF-8, and longer strings. Mainnet first
  // surfaced this at h=766,915 tx 15 output 1.
  for (const sample of ['', 'hello', 'Ergo', '🦀 hello 中文', 'x'.repeat(300)]) {
    it(`SString roundtrip: '${sample.slice(0, 20)}'`, () => {
      const w = new ByteWriter()
      serializeSValue({ tag: 'SString' }, { kind: 'String', value: sample }, 0, w)
      const bytes = w.toBytes()
      const r = new ByteReader(bytes)
      const parsed = parseSValue({ tag: 'SString' }, 0, r)
      expect(parsed).toEqual({ kind: 'String', value: sample })
      expect(r.isExhausted).toBe(true)
    })
  }

  // SHeader at tree-version < 3 throws 'sheader-tree-version-too-low' (not
  // 'not-implemented-phase-2a'). This is distinct from the other deferred kinds.
  it('parseSValue SHeader treeVersion=0 throws sheader-tree-version-too-low', () => {
    const r = new ByteReader(new Uint8Array([0x00]))
    try {
      parseSValue({ tag: 'SHeader' }, 0, r)
      expect.fail('expected throw for SHeader at treeVersion=0')
    } catch (e) {
      expect(e).toBeInstanceOf(SValueParseError)
      expect((e as SValueParseError).code).toBe('sheader-tree-version-too-low')
    }
  })
})

describe('SValue SSigmaProp parse + serialize', () => {
  // A minimal ProveDlog SigmaBoolean payload: opcode 0xcd + 33-byte
  // compressed pubkey. Phase 2g-medium: parser returns structural SigmaBoolean;
  // serializer emits byte-identical output.
  const proveDlog33Pk = new Uint8Array([
    0x02, 0x76, 0x4e, 0xa2, 0xb0, 0xb9, 0xb0, 0x6b, 0x57, 0x30, 0xa4, 0x25, 0x7b, 0xba, 0x71,
    0xfd, 0x77, 0x97, 0xeb, 0x1e, 0xc1, 0x2b, 0xc3, 0xae, 0x60, 0x25, 0xa0, 0x1d, 0x7f, 0xba,
    0x53, 0x83, 0x0e
  ])
  const rawProveDlog = new Uint8Array(34)
  rawProveDlog[0] = 0xcd
  rawProveDlog.set(proveDlog33Pk, 1)

  it('parses an SSigmaProp value containing a ProveDlog', () => {
    const r = new ByteReader(rawProveDlog)
    const v = parseSValue({ tag: 'SSigmaProp' }, 0, r)
    expect(v.kind).toBe('SigmaProp')
    if (v.kind === 'SigmaProp') {
      // Phase 2g-medium: structural shape — check tag and public key bytes.
      expect(v.value.tag).toBe('ProveDlog')
      if (v.value.tag === 'ProveDlog') {
        expect(Array.from(v.value.h)).toEqual(Array.from(proveDlog33Pk))
      }
    }
    expect(r.isExhausted).toBe(true)
  })

  it('round-trips an SSigmaProp value byte-exactly', () => {
    const r = new ByteReader(rawProveDlog)
    const v = parseSValue({ tag: 'SSigmaProp' }, 0, r)
    const w = new ByteWriter()
    serializeSValue({ tag: 'SSigmaProp' }, v, 0, w)
    expect(Array.from(w.toBytes())).toEqual(Array.from(rawProveDlog))
  })

  it('rejects unknown SigmaBoolean opcode', () => {
    const garbage = new Uint8Array([0xff, 0x00])
    const r = new ByteReader(garbage)
    expect(() => parseSValue({ tag: 'SSigmaProp' }, 0, r)).toThrow()
  })
})

describe('SValue serialize: type-mismatch detection', () => {
  it('throws SValueSerializeError when SValue.kind does not match SType.tag', () => {
    const w = new ByteWriter()
    expect(() =>
      serializeSValue({ tag: 'SBoolean' }, { kind: 'Int', value: 1 }, 0, w)
    ).toThrow(SValueSerializeError)
  })

  it('throws SValueSerializeError on GroupElement with wrong byte length', () => {
    const w = new ByteWriter()
    expect(() =>
      serializeSValue(
        { tag: 'SGroupElement' },
        { kind: 'GroupElement', value: new Uint8Array(32) /* wrong length */ },
        0,
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
        0,
        w
      )
    ).toThrow(SValueSerializeError)
  })
})

describe('SValue SOption tag semantics', () => {
  it('SOption: tag byte 0x02 is Some (JVM getOption: any nonzero = Some)', () => {
    // [0x02, 0x42] — noncanonical Some tag, followed by ZigZag VLQ payload.
    // scorex-util VLQReader.getOption: ANY nonzero tag → Some, payload follows.
    // The previous sigma-rust-mirroring behavior (only exact 1 = Some) was a
    // fork retired in F5 batch 1 (2026-06-08). Option DATA requires v3 gate.
    //
    // 0x42 = ZigZag(33) in SInt VLQ: decode_zigzag(0x42) = (0x42 >>> 1) ^ 0 = 33.
    // Both bytes are consumed (tag + payload).
    const r = new ByteReader(new Uint8Array([0x02, 0x42]))
    const result = parseSValue({ tag: 'SOption', elem: { tag: 'SInt' } }, 3, r)
    expect(result).toEqual({ kind: 'Option', elem: { tag: 'SInt' }, value: { kind: 'Int', value: 33 } })
    // Both bytes consumed — cursor is at end.
    expect(r.remaining).toBe(0)
  })

  it('SOption: tag byte 0x00 is None (zero = None in both JVM and sigma-rust)', () => {
    // Zero tag always means None in both implementations.
    const r = new ByteReader(new Uint8Array([0x00, 0x42]))
    const result = parseSValue({ tag: 'SOption', elem: { tag: 'SInt' } }, 3, r)
    expect(result).toEqual({ kind: 'Option', elem: { tag: 'SInt' }, value: null })
    // Only the tag byte consumed; 0x42 remains.
    expect(r.remaining).toBe(1)
  })
})
