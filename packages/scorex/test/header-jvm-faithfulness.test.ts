// JVM-faithfulness pins for scorex header parsing (adversarial-only edges).
// Reference: ~/projects/sigmastate-interpreter HeaderWithoutPow.scala / ErgoHeader.scala.
import { describe, test, expect } from 'vitest'
import { parseHeader, serializeHeader } from '../src/header.ts'
import { ByteReader } from '../src/reader.ts'
import { encodeVlqU } from '../src/vlq.ts'
import { bytesToHex } from './helpers.ts'

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
  if (p.version > 1) {
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
