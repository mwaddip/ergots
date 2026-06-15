// JVM-faithfulness pins for scorex header parsing (adversarial-only edges).
// Reference: ~/projects/sigmastate-interpreter HeaderWithoutPow.scala / ErgoHeader.scala.
import { describe, test, expect } from 'vitest'
import { parseHeader, serializeHeader, deriveHeaderId } from '../src/header.ts'
import { ByteReader } from '../src/reader.ts'
import { encodeVlqU } from '../src/vlq.ts'
import { bytesToHex } from './helpers.ts'
import { ReaderError } from '../src/errors.ts'
import { blake2b256 } from '../src/crypto/blake2b256.ts'

// ---- shared header byte assembler (used by every finding below) ----
function zeros(n: number): Uint8Array {
  return new Uint8Array(n)
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
interface HeaderParts {
  version: number
  timestamp?: bigint
  height?: bigint
  unparsedLenByte?: number // version>1 only: the u8 length prefix
  unparsedPayload?: Uint8Array // bytes after the length prefix
  minerPk?: Uint8Array // 33 bytes
  nonce?: Uint8Array // 8 bytes
  powOnetimePk?: Uint8Array // v1 only: 33 bytes
  dBytes?: Uint8Array // v1 only: d_bytes (d_len = dBytes.length)
}
// JVM reads the header version as a SIGNED Byte (HeaderWithoutPow.scala:68); the
// unparsedBytes gates `version > 1` / `> 4` are therefore signed. Mirror it so the
// assembler lays out faithful wire bytes for any version (incl. >= 0x80).
function signedVersion(v: number): number {
  return v >= 128 ? v - 256 : v
}
function buildHeader(p: HeaderParts): Uint8Array {
  const parts: Uint8Array[] = [
    new Uint8Array([p.version]),
    zeros(32), // parentId
    zeros(32), // adProofsRoot
    zeros(32), // transactionRoot
    zeros(33), // stateRoot
    encodeVlqU(p.timestamp ?? 1n),
    zeros(32), // extensionRoot
    zeros(4), // nBits
    encodeVlqU(p.height ?? 1n),
    zeros(3), // votes
  ]
  if (signedVersion(p.version) > 1) {
    parts.push(new Uint8Array([p.unparsedLenByte ?? 0]))
    if (p.unparsedPayload) parts.push(p.unparsedPayload)
  }
  const minerPk = p.minerPk ?? concat(new Uint8Array([0x02]), zeros(32))
  const nonce = p.nonce ?? zeros(8)
  if (p.version === 1) {
    const w = p.powOnetimePk ?? concat(new Uint8Array([0x02]), zeros(32))
    const d = p.dBytes ?? new Uint8Array([0x00])
    parts.push(minerPk, w, nonce, new Uint8Array([d.length]), d)
  } else {
    parts.push(minerPk, nonce)
  }
  return concat(...parts)
}

describe('header (a) — unparsedBytes consume gate (version>4)', () => {
  // RED: a v2/3/4 header with a NONZERO length byte must NOT consume the payload
  // (JVM leaves it for the solution parse). Current code consumes -> wrong solution
  // -> truncated.
  for (const version of [2, 3, 4]) {
    test(`v${version}: nonzero length byte is read but payload NOT consumed`, () => {
      const minerPk = concat(new Uint8Array([0x03]), zeros(32))
      const bytes = buildHeader({ version, unparsedLenByte: 2, minerPk })
      const h = parseHeader(new ByteReader(bytes))
      expect(h.unparsedBytes.length).toBe(0)
      // payload not consumed -> solution still starts right after the length byte:
      expect(bytesToHex(h.autolykosSolution.minerPk)).toBe(bytesToHex(minerPk))
    })
  }

  // GUARD: version>=5 DOES consume (the gate must not break the forward path).
  test('v5: nonzero length byte consumes the payload into unparsedBytes', () => {
    const payload = new Uint8Array([0xaa, 0xbb])
    const bytes = buildHeader({ version: 5, unparsedLenByte: 2, unparsedPayload: payload })
    const h = parseHeader(new ByteReader(bytes))
    expect(bytesToHex(h.unparsedBytes)).toBe('aabb')
    expect(bytesToHex(serializeHeader(h))).toBe(bytesToHex(bytes)) // v5 round-trips
  })

  // SERIALIZE decision pinned: JVM-mirror — version>1 writes length+payload.
  test('serialize mirrors JVM: version>1 emits unparsedBytes length+payload', () => {
    const h = parseHeader(new ByteReader(buildHeader({ version: 2 })))
    h.unparsedBytes = new Uint8Array([0xaa, 0xbb])
    const re = serializeHeader(h)
    const solutionStart = re.length - 41 // v2 solution = minerPk(33)+nonce(8)
    expect(re[solutionStart - 3]).toBe(0x02) // length prefix
    expect(re[solutionStart - 2]).toBe(0xaa)
    expect(re[solutionStart - 1]).toBe(0xbb)
  })
})

describe('header (b) — height upper bound (i32, JVM toIntExact)', () => {
  test('height = 2^31 - 1 (Int.MaxValue) is accepted', () => {
    const h = parseHeader(new ByteReader(buildHeader({ version: 2, height: 0x7fffffffn })))
    expect(h.height).toBe(0x7fffffff)
  })

  test('height = 2^31 rejects with value-out-of-range', () => {
    const bytes = buildHeader({ version: 2, height: 0x80000000n })
    try {
      parseHeader(new ByteReader(bytes))
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ReaderError)
      expect((e as ReaderError).code).toBe('value-out-of-range')
    }
  })
})

describe('header (c) — v1 powDistance 256-bit bound (fitsIn256Bits)', () => {
  // 2^255 - 1 = 0x7f followed by 31 * 0xff -> bitLength 255 -> fits.
  test('powDistance = 2^255 - 1 is accepted', () => {
    const dBytes = new Uint8Array([0x7f, ...Array(31).fill(0xff)])
    const h = parseHeader(new ByteReader(buildHeader({ version: 1, dBytes })))
    expect(h.autolykosSolution.powDistance).toBe((1n << 255n) - 1n)
  })

  // 2^255 = 0x80 followed by 31 * 0x00 -> bitLength 256 -> rejects.
  test('powDistance = 2^255 rejects with value-out-of-range', () => {
    const dBytes = new Uint8Array([0x80, ...Array(31).fill(0x00)])
    const bytes = buildHeader({ version: 1, dBytes })
    try {
      parseHeader(new ByteReader(bytes))
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ReaderError)
      expect((e as ReaderError).code).toBe('value-out-of-range')
    }
  })

  // > 32 bytes is unambiguously over-range.
  test('powDistance from 33 * 0xff bytes rejects with value-out-of-range', () => {
    const dBytes = new Uint8Array(Array(33).fill(0xff))
    const bytes = buildHeader({ version: 1, dBytes })
    expect(() => parseHeader(new ByteReader(bytes))).toThrowError(ReaderError)
  })
})

describe('header (d) — id basis is the consumed input slice', () => {
  // RED: a v1 header with NON-MINIMAL d-bytes [0x00, 0x05] (value 5; minimal is
  // [0x05]). The consumed-slice id hashes the input verbatim; a re-serialization
  // id (current behavior) hashes the minimal form and differs.
  test('non-minimal encoding: id hashes the input slice, not a re-serialization', () => {
    const bytes = buildHeader({ version: 1, dBytes: new Uint8Array([0x00, 0x05]) })
    const h = parseHeader(new ByteReader(bytes))
    expect(h.autolykosSolution.powDistance).toBe(5n)
    expect(bytesToHex(h.id)).toBe(bytesToHex(blake2b256(bytes))) // consumed slice
    expect(bytesToHex(h.id)).not.toBe(bytesToHex(deriveHeaderId(h))) // != re-serialization
  })

  // GUARD: for a canonical (minimal) header the two bases coincide.
  test('canonical header: slice id equals re-serialization id', () => {
    const bytes = buildHeader({ version: 2 })
    const h = parseHeader(new ByteReader(bytes))
    expect(bytesToHex(h.id)).toBe(bytesToHex(deriveHeaderId(h)))
    expect(bytesToHex(h.id)).toBe(bytesToHex(blake2b256(bytes)))
  })

  // GUARD: parsing mid-stream (header preceded by other bytes) hashes only the
  // header's own consumed span, not the prefix.
  test('mid-stream parse hashes only the header span', () => {
    const bytes = buildHeader({ version: 2 })
    const prefixed = concat(new Uint8Array([0xde, 0xad]), bytes)
    const r = new ByteReader(prefixed)
    r.readBytes(2) // advance past the prefix
    const h = parseHeader(r)
    expect(bytesToHex(h.id)).toBe(bytesToHex(blake2b256(bytes)))
  })
})

describe('header (e) — version byte signedness (JVM getByte)', () => {
  // The JVM reads `version = r.getByte()` (signed Byte; HeaderWithoutPow.scala:68)
  // and gates the unparsedBytes block on the SIGNED value: `version > 1` (:81) and
  // `version > 4` (:83). A version byte >= 0x80 is negative, so the JVM SKIPS the
  // whole block; the bytes after `votes` flow straight into the AutolykosSolution.
  // ergots read `version` as unsigned u8 -> 128 > 1 -> wrongly consumed a prefix.

  // RED: v=0x80 (signed -128) skips the prefix -> the solution starts right after
  // votes. Trailing pad so the buggy unsigned path mis-offsets to a WRONG minerPk
  // (clean assertion failure) instead of truncating.
  test('v=0x80: signed version skips the unparsedBytes prefix', () => {
    const minerPk = concat(new Uint8Array([0x03]), zeros(32))
    const bytes = concat(buildHeader({ version: 0x80, minerPk }), zeros(8))
    const h = parseHeader(new ByteReader(bytes))
    expect(h.unparsedBytes.length).toBe(0)
    expect(bytesToHex(h.autolykosSolution.minerPk)).toBe(bytesToHex(minerPk))
  })

  // RED: serialize mirrors the signed gate -> v=0x80 emits NO unparsedBytes block,
  // so the field is ignored (setting it does not change the output).
  test('v=0x80: serialize skips the block (unparsedBytes field ignored)', () => {
    const h = parseHeader(new ByteReader(buildHeader({ version: 2 })))
    h.version = 0x80
    const withoutField = serializeHeader(h) // unparsedBytes empty from the v2 parse
    h.unparsedBytes = new Uint8Array([0xaa, 0xbb])
    const withField = serializeHeader(h)
    expect(bytesToHex(withField)).toBe(bytesToHex(withoutField))
  })

  // GUARD: v=0x7f (signed 127 > 4) still READS and consumes the prefix, exactly
  // like a high version — the boundary must not overshoot into 0..127.
  test('v=0x7f: signed 127 still reads+consumes the unparsedBytes prefix', () => {
    const minerPk = concat(new Uint8Array([0x03]), zeros(32))
    const payload = new Uint8Array([0xaa, 0xbb])
    const bytes = buildHeader({ version: 0x7f, unparsedLenByte: 2, unparsedPayload: payload, minerPk })
    const h = parseHeader(new ByteReader(bytes))
    expect(bytesToHex(h.unparsedBytes)).toBe('aabb')
    expect(bytesToHex(h.autolykosSolution.minerPk)).toBe(bytesToHex(minerPk))
  })
})
