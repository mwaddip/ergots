/**
 * Byte reader with VLQ + ZigZag-VLQ decoding for ErgoTree wire format.
 *
 * Mirrors the conventions of `@mwaddip/ergots-proof`'s `ByteReader`
 * (constructor signature, getters for position/remaining/isExhausted,
 * `ReaderError(message, code)` shape with string code, throw semantics on
 * truncated reads). Reimplemented here rather than imported because
 * cross-package use must go through published package names and the proof
 * package does not export its reader publicly.
 *
 * Deliberate divergence from the proof package: VLQ decoding is exposed as
 * methods on the reader (rather than free functions taking a reader),
 * because for ErgoTree the wire format and the cursor are tightly coupled
 * — every parser primitive reads through the same stateful cursor. Default
 * VLQ return type is `number` (since the vast majority of ErgoTree reads
 * are u32-bounded indices, sizes, and tags); a 64-bit-safe `BigInt` pair
 * is provided for SLong values.
 */

export class ReaderError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ReaderError';
  }
}

const MAX_VLQ_BYTES = 10; // ceil(64 / 7) = 10

export class ByteReader {
  private _position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this._position;
  }

  get remaining(): number {
    return this.bytes.length - this._position;
  }

  get isExhausted(): boolean {
    return this._position >= this.bytes.length;
  }

  readU8(): number {
    if (this._position >= this.bytes.length) {
      throw new ReaderError(`readU8: EOF at ${this._position}`, 'truncated');
    }
    return this.bytes[this._position++]!;
  }

  readBytes(n: number): Uint8Array {
    if (this.remaining < n) {
      throw new ReaderError(`readBytes(${n}): only ${this.remaining} available`, 'truncated');
    }
    // subarray (not slice) returns a view, no copy. Callers that need to
    // retain bytes past the reader's lifetime are responsible for copying.
    const out = this.bytes.subarray(this._position, this._position + n);
    this._position += n;
    return out;
  }

  /**
   * Read a VLQ-encoded unsigned integer as a JS number.
   *
   * Caller is responsible for ensuring the encoded value fits in a safe
   * integer (≤ 2^53 - 1). For 64-bit-safe paths (SLong values), use
   * `readVlqBigInt`.
   *
   * Uses BigInt internally for the shift accumulation to avoid the 32-bit
   * coercion of JS bitwise operators on `number`, then narrows the result
   * to `number` via `Number()`. This keeps the API surface ergonomic
   * (number) while making the high-7-bit reads correct.
   */
  readVlqU(): number {
    return Number(this.readVlqBigInt());
  }

  /**
   * Read a ZigZag-VLQ-encoded signed integer as a JS number.
   *
   * ZigZag decode: (u >> 1) ^ -(u & 1).
   * Sign extension via BigInt arithmetic, then narrow to `number`.
   */
  readVlqS(): number {
    return Number(this.readVlqBigIntSigned());
  }

  /**
   * Read a VLQ-encoded unsigned integer as a BigInt. Up to 64 bits.
   * Throws `ReaderError` with code `vlq-overflow` after 10 continuation bytes.
   */
  readVlqBigInt(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < MAX_VLQ_BYTES; i++) {
      const byte = this.readU8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new ReaderError(`readVlqBigInt: VLQ exceeds ${MAX_VLQ_BYTES} bytes at ${this._position}`, 'vlq-overflow');
  }

  /**
   * Read a ZigZag-VLQ-encoded signed integer as a BigInt.
   *
   * BigInt XOR with `-(zz & 1n)` performs sign extension natively when the
   * LSB of zz is set: `-(1n) = -1n` in arbitrary precision, and XOR with
   * -1n flips every bit yielding the negative value directly.
   */
  readVlqBigIntSigned(): bigint {
    const zz = this.readVlqBigInt();
    return (zz >> 1n) ^ -(zz & 1n);
  }
}
