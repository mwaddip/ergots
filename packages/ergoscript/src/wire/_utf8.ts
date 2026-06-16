/**
 * JVM-faithful lossy UTF-8 decode — matches Java's
 * `new String(bytes, StandardCharsets.UTF_8)` with its default REPLACE
 * coding-error action. The JVM `TypeSerializer.deserialize` reads an `STypeVar`
 * name this way (`new String(r.getBytes(nameLength), UTF_8)`,
 * sigma-state-6.0.3 `core/.../serialization/TypeSerializer.scala:204`).
 *
 * Why a hand-written decoder rather than `TextDecoder('utf-8', { fatal: false })`:
 * JS's decoder follows the WHATWG / Unicode "maximal subparts" rule, which
 * differs from Java's malformed-length rule on an ill-formed sequence that
 * encodes a UTF-16 surrogate. For `ed a0 80` (an attempted encoding of U+D800)
 * the JVM consumes all three bytes as ONE malformed unit → a single U+FFFD,
 * whereas WHATWG (and Rust `from_utf8_lossy`) emit THREE. That single-vs-triple
 * count changes the re-encoded name bytes → a different ErgoTree template → a
 * wire round-trip fork. The other ill-formed shapes (`ff`, `e2 82`, `c0 80`,
 * `61 ff 62`) already agree between the two rules; only the surrogate case forks.
 * Pinned by SANTA finding `wire-stypevar-utf8-byte-exactness` + the 5-entry
 * vector `STypeVar.name_utf8_roundtrip` (`jvm:sigma-state-6.0.3`).
 *
 * Direct port of OpenJDK `sun.nio.cs.UTF_8.Decoder`'s malformed-length logic:
 * read the lead byte, derive the sequence length, validate the continuation
 * bytes, compute the code point, and reject an overlong / surrogate /
 * out-of-range result as a single malformed unit of the appropriate length.
 * Every malformed unit yields exactly one U+FFFD; a partial sequence at
 * end-of-input is one malformed unit (Java flushes the pending underflow as a
 * single replacement). Never throws — a lossy decode always succeeds.
 */
const FFFD = '�'

/** A UTF-8 continuation byte is `10xxxxxx`. */
function isCont(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

export function decodeUtf8Lossy(bytes: Uint8Array): string {
  let out = ''
  const n = bytes.length
  let i = 0
  while (i < n) {
    const b1 = bytes[i]!
    // 1-byte: ASCII 0x00..0x7F.
    if (b1 < 0x80) {
      out += String.fromCharCode(b1)
      i += 1
      continue
    }
    // Invalid lead: a bare continuation (0x80..0xBF) or an overlong 2-byte
    // lead (0xC0/0xC1). Java consumes 1 byte → 1 U+FFFD.
    if (b1 < 0xc2) {
      out += FFFD
      i += 1
      continue
    }
    // 2-byte: 0xC2..0xDF.
    if (b1 < 0xe0) {
      if (i + 1 < n && isCont(bytes[i + 1]!)) {
        out += String.fromCharCode(((b1 & 0x1f) << 6) | (bytes[i + 1]! & 0x3f))
        i += 2
      } else {
        // missing / bad continuation → 1 U+FFFD, advance 1 (the next byte is
        // re-examined as a fresh lead; truncation at end flushes as 1 unit).
        out += FFFD
        i += 1
      }
      continue
    }
    // 3-byte: 0xE0..0xEF.
    if (b1 < 0xf0) {
      if (i + 1 >= n) {
        out += FFFD // truncated at end → 1 unit
        break
      }
      const b2 = bytes[i + 1]!
      // length-1 malformed: bad b2, or 0xE0 overlong (b2 < 0xA0).
      if (!isCont(b2) || (b1 === 0xe0 && b2 < 0xa0)) {
        out += FFFD
        i += 1
        continue
      }
      if (i + 2 >= n) {
        out += FFFD // b2 ok, b3 truncated → 1 unit
        break
      }
      const b3 = bytes[i + 2]!
      if (!isCont(b3)) {
        out += FFFD // length-2 malformed
        i += 2
        continue
      }
      const cp = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)
      // surrogate (U+D800..U+DFFF): Java rejects the whole 3-byte unit → 1 U+FFFD.
      if (cp >= 0xd800 && cp <= 0xdfff) {
        out += FFFD
        i += 3
        continue
      }
      out += String.fromCharCode(cp)
      i += 3
      continue
    }
    // 4-byte: 0xF0..0xF4.
    if (b1 < 0xf5) {
      if (i + 1 >= n) {
        out += FFFD
        break
      }
      const b2 = bytes[i + 1]!
      // length-1 malformed: bad b2, 0xF0 overlong (b2 < 0x90), or 0xF4 over-max (b2 > 0x8F).
      if (!isCont(b2) || (b1 === 0xf0 && b2 < 0x90) || (b1 === 0xf4 && b2 > 0x8f)) {
        out += FFFD
        i += 1
        continue
      }
      if (i + 2 >= n) {
        out += FFFD
        break
      }
      const b3 = bytes[i + 2]!
      if (!isCont(b3)) {
        out += FFFD
        i += 2
        continue
      }
      if (i + 3 >= n) {
        out += FFFD
        break
      }
      const b4 = bytes[i + 3]!
      if (!isCont(b4)) {
        out += FFFD
        i += 3
        continue
      }
      const cp =
        ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f)
      out += String.fromCodePoint(cp)
      i += 4
      continue
    }
    // 0xF5..0xFF: invalid lead (would exceed U+10FFFF) → 1 U+FFFD.
    out += FFFD
    i += 1
  }
  return out
}
