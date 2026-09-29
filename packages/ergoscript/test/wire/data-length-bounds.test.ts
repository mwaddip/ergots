// JVM CoreDataSerializer (sigma-state 6.0.6): SString length getUIntExact (:105; ArithmeticException
// above 2^31-1, before getBytes); SBigInt / SUnsignedBigInt length getUShort().toShort (:112-124):
// 33..0x7FFF throw at once, 0 and 0x8000..0xFFFF reach getBytes (the window check) first.
// TypeSerializer.deserialize (:133-135): type code 0's error message runs r.getBytes(r.remaining),
// a checked read.
import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { parseSType } from '../../src/wire/parse-stype'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import type { SValue } from '../../src/mir/types'

const vlq = (n: number) => { const o: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b) } while (n); return o }
const codeOf = (f: () => unknown) => { try { f(); return 'no-throw' } catch (e) { return (e as { code?: string }).code } }
const reader = (bytes: number[], limit?: number) => { const r = new ByteReader(Uint8Array.from(bytes)); if (limit !== undefined) r.positionLimit = limit; return r }

describe('SString', () => {
  it('a length above 2^31-1 rejects right after the length', () => {
    expect(codeOf(() => parseSValue({ tag: 'SString' }, 0, reader(vlq(2 ** 31))))).toBe('string-too-long')
  })
})

describe('SBigInt length (toShort)', () => {
  it('33 rejects at once, even past the window', () => {
    expect(codeOf(() => parseSValue({ tag: 'SBigInt' }, 0, reader(vlq(33), 0)))).toBe('bigint-too-large')
  })
  it('0x8000 checks the window first', () => {
    expect(codeOf(() => parseSValue({ tag: 'SBigInt' }, 0, reader(vlq(0x8000), 1)))).toBe('position-limit-exceeded')
    expect(codeOf(() => parseSValue({ tag: 'SBigInt' }, 0, reader(vlq(0x8000))))).toBe('bigint-too-large')
  })
  it('0 checks the window first', () => {
    expect(codeOf(() => parseSValue({ tag: 'SBigInt' }, 0, reader([0x00], 0)))).toBe('position-limit-exceeded')
    expect(codeOf(() => parseSValue({ tag: 'SBigInt' }, 0, reader([0x00])))).toBe('bigint-empty')
  })
})

describe('SUnsignedBigInt length (toShort)', () => {
  it('0x8000 checks the window first', () => {
    expect(codeOf(() => parseSValue({ tag: 'SUnsignedBigInt' }, 3, reader(vlq(0x8000), 1)))).toBe('position-limit-exceeded')
  })
  it('0 is the value 0 (the JVM accepts)', () => {
    expect(codeOf(() => parseSValue({ tag: 'SUnsignedBigInt' }, 3, reader([0x00])))).toBe('no-throw')
  })
})

describe('type code 0', () => {
  it('past the window, the checked read in the JVM error message wins', () => {
    expect(codeOf(() => parseSType(reader([0x00, 0x01], 0)))).toBe('position-limit-exceeded')
  })
  it('inside the window it is invalid-type-code', () => {
    expect(codeOf(() => parseSType(reader([0x00, 0x01])))).toBe('invalid-type-code')
  })
})

// ---------------------------------------------------------------------------
// Controller ruling (2026-09-28): the AvlTree data serializer bounds
// `keyLength` and `valueLengthOpt` at [0, 2^31), not [0, 2^32). The JVM holds
// both as Ints (AvlTreeData.scala:84-85 `getUInt().toInt`) and its writer's
// `putUInt` rejects a negative Int (AvlTreeData.scala:73-75; the IAE pinned
// at DeserializationResilience.scala:386-395) — so the JVM cannot re-encode a
// tree whose AvlTree constant carries a length that parsed from [2^31, 2^32).
// Parse is unchanged (still a plain u32 read, matching the JVM's getUInt()).
// See facts/ergoscript-wire.md Round-trip Carve-out 6.
// ---------------------------------------------------------------------------

describe('SAvlTree data-length bound — controller ruling (2026-09-28)', () => {
  const digest33 = new Uint8Array(33)

  it('keyLength 0x7fffffff serializes and round-trips byte for byte', () => {
    const v: SValue = {
      kind: 'AvlTree',
      value: { digest: digest33, treeFlags: 0x07, keyLength: 0x7fffffff, valueLengthOpt: null },
    }
    const w = new ByteWriter()
    serializeSValue({ tag: 'SAvlTree' }, v, 0, w)
    const bytes = w.toBytes()

    const parsedBack = parseSValue({ tag: 'SAvlTree' }, 0, new ByteReader(bytes))
    expect(parsedBack).toEqual(v)

    const w2 = new ByteWriter()
    serializeSValue({ tag: 'SAvlTree' }, parsedBack, 0, w2)
    expect(w2.toBytes()).toEqual(bytes)
  })

  it('keyLength 0x80000000 is rejected with savltree-key-length-out-of-range', () => {
    const v: SValue = {
      kind: 'AvlTree',
      value: { digest: digest33, treeFlags: 0, keyLength: 0x80000000, valueLengthOpt: null },
    }
    expect(codeOf(() => serializeSValue({ tag: 'SAvlTree' }, v, 0, new ByteWriter()))).toBe(
      'savltree-key-length-out-of-range',
    )
  })

  it('valueLengthOpt 0x80000000 is rejected with savltree-value-length-out-of-range', () => {
    const v: SValue = {
      kind: 'AvlTree',
      value: { digest: digest33, treeFlags: 0, keyLength: 32, valueLengthOpt: 0x80000000 },
    }
    expect(codeOf(() => serializeSValue({ tag: 'SAvlTree' }, v, 0, new ByteWriter()))).toBe(
      'savltree-value-length-out-of-range',
    )
  })

  it('parsing keyLength VLQ 0x80000000 (80 80 80 80 08) still succeeds — the JVM accepts it too, it wraps', () => {
    const bytes = [...Array(33).fill(0), 0x07, 0x80, 0x80, 0x80, 0x80, 0x08, 0x00]
    const v = parseSValue({ tag: 'SAvlTree' }, 0, reader(bytes))
    expect(v.kind).toBe('AvlTree')
    expect((v as Extract<SValue, { kind: 'AvlTree' }>).value.keyLength).toBe(0x80000000)
  })

  it('a tree carrying such an AvlTree constant parses, but serializeTree throws the key-length code', () => {
    const digest = new Array(33).fill(0x11)
    const treeBytes = Uint8Array.from([
      0x10, // constant segregation, no size flag, version 0
      0x01, // 1 segregated constant
      0x64, // SAvlTree type code (100)
      ...digest, // 33-byte digest
      0x07, // treeFlags
      0x80, 0x80, 0x80, 0x80, 0x08, // keyLength VLQ = 0x80000000
      0x00, // valueLengthOpt = None
      0x73, 0x00, // body: ConstantPlaceholder(0)
    ])
    const tree = parseTree(treeBytes)
    expect(tree).toBeDefined()
    expect(codeOf(() => serializeTree(tree))).toBe('savltree-key-length-out-of-range')
  })
})
