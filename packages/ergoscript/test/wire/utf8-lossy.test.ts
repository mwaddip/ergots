import { describe, it, expect } from 'vitest'
import { decodeUtf8Lossy } from '../../src/wire/_utf8'

const b = (...xs: number[]) => new Uint8Array(xs)
const reHex = (s: string) => {
  let h = ''
  for (const x of new TextEncoder().encode(s)) h += x.toString(16).padStart(2, '0')
  return h
}

describe('decodeUtf8Lossy — JVM-faithful new String(bytes, UTF_8)', () => {
  // SANTA-blessed STypeVar name byte sequences (jvm:sigma-state-6.0.3,
  // wire/v6/authored/STypeVar.name_utf8_roundtrip.json). Java's decoder
  // collapses each ill-formed unit to a SINGLE U+FFFD per its malformed-length
  // rule; notably `ed a0 80` (an ill-formed UTF-16 surrogate) is ONE U+FFFD on
  // the JVM where Rust `from_utf8_lossy` / WHATWG give three — the fork this pins.
  it('ff (invalid lead byte) -> 1 U+FFFD', () => {
    expect(decodeUtf8Lossy(b(0xff))).toBe('�')
    expect(reHex(decodeUtf8Lossy(b(0xff)))).toBe('efbfbd')
  })
  it('e2 82 (truncated 3-byte) -> 1 U+FFFD', () => {
    expect(decodeUtf8Lossy(b(0xe2, 0x82))).toBe('�')
  })
  it('c0 80 (overlong NUL) -> 2 U+FFFD', () => {
    expect(reHex(decodeUtf8Lossy(b(0xc0, 0x80)))).toBe('efbfbdefbfbd')
  })
  it('ed a0 80 (UTF-16 surrogate — the JVM-vs-Rust fork) -> 1 U+FFFD', () => {
    expect(decodeUtf8Lossy(b(0xed, 0xa0, 0x80))).toBe('�')
    expect(reHex(decodeUtf8Lossy(b(0xed, 0xa0, 0x80)))).toBe('efbfbd')
  })
  it('61 ff 62 (valid / invalid / valid) -> a U+FFFD b', () => {
    expect(reHex(decodeUtf8Lossy(b(0x61, 0xff, 0x62)))).toBe('61efbfbd62')
  })

  it('valid ASCII / 2-byte / 3-byte / 4-byte pass through unchanged', () => {
    expect(decodeUtf8Lossy(b(0x54))).toBe('T')
    expect(decodeUtf8Lossy(b(0xc3, 0xa9))).toBe(String.fromCharCode(0xe9)) // é U+00E9
    expect(decodeUtf8Lossy(b(0xe2, 0x82, 0xac))).toBe(String.fromCharCode(0x20ac)) // € U+20AC
    expect(decodeUtf8Lossy(b(0xf0, 0x9f, 0x98, 0x80))).toBe(String.fromCodePoint(0x1f600)) // 😀 U+1F600
    expect(decodeUtf8Lossy(b())).toBe('')
  })

  it('truncated multibyte at end -> 1 U+FFFD', () => {
    expect(decodeUtf8Lossy(b(0xf0, 0x9f))).toBe('�') // 4-byte cut short
    expect(decodeUtf8Lossy(b(0xe2))).toBe('�') // 3-byte lead alone
  })
  it('lone continuation bytes -> 1 U+FFFD each', () => {
    expect(reHex(decodeUtf8Lossy(b(0x80, 0xbf)))).toBe('efbfbdefbfbd')
  })
  it('F5..FF (invalid 4+ byte leads) -> 1 U+FFFD each', () => {
    expect(decodeUtf8Lossy(b(0xf5))).toBe('�')
    expect(decodeUtf8Lossy(b(0xff, 0xfe))).toBe('��')
  })
})
