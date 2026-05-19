/**
 * @ergots/scorex -- wire-codec error class.
 *
 * Thrown by ByteReader on malformed bytes (truncation, VLQ overflow, etc.).
 * Carries a structural `code: string` matching a fixed enum of reasons for
 * programmatic dispatch (instanceof + .code).
 *
 * Error codes:
 *   'truncated'          -- readU8 / readBytes / readFixed beyond end of buffer.
 *                           Also thrown by readBool/readOption for an out-of-range
 *                           tag byte (a future minor revision may add 'malformed-value'
 *                           for those cases; see facts/scorex.md known limitations).
 *   'vlq-overflow'       -- VLQ continuation bit set on byte 10 (>64-bit integer), or
 *                           decoded value exceeds the declared range (e.g. readVlqU32).
 *   'slice-out-of-bounds' -- slice(start, end) arguments violate [0, buf.length] bounds.
 *   'array-too-large'    -- readArray decoded length exceeds MAX_ARRAY_LENGTH (1 << 24).
 */
export class ReaderError extends Error {
  constructor(message: string, public readonly code: 'truncated' | 'vlq-overflow' | 'slice-out-of-bounds' | 'array-too-large') {
    super(message);
    this.name = 'ReaderError';
  }
}
