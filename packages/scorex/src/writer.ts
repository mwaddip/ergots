/**
 * Byte writer with VLQ + ZigZag-VLQ encoding for Scorex wire format.
 *
 * Defensive byte-range check on `writeU8`, defensive copy on `writeBytes`,
 * `Uint8Array[]` chunk accumulator with O(1) appends and a `length` getter,
 * single concatenation in `toBytes`.
 *
 * VLQ encoding is exposed as methods on the writer (rather than free
 * functions returning a Uint8Array that gets passed to writeBytes), matching
 * the corresponding choice on `ByteReader`. The wire format and the cursor
 * are tightly coupled -- every serializer primitive emits through the same
 * stateful builder.
 *
 * Default VLQ argument type is `number` (since the vast majority of ErgoTree
 * writes are u32-bounded indices, sizes, and tags); a 64-bit-safe `bigint`
 * pair is provided for SLong values. All four VLQ paths accumulate via
 * BigInt internally to avoid 32-bit truncation when encoding values
 * `> 2^32` (e.g. `writeVlqU(0xffffffff)` must round-trip correctly through
 * `readVlqU`).
 *
 * Error semantics: plain `Error` is thrown for programming-error inputs
 * (out-of-range byte, negative VLQ value). The asymmetry with `ReaderError`
 * is intentional -- readers operate on untrusted bytes and need a typed error
 * taxonomy; writers operate on serializer-controlled inputs and any failure
 * is a contract violation.
 */

export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  writeU8(byte: number): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new Error(`writeU8: out of range: ${byte}`);
    }
    this.chunks.push(new Uint8Array([byte]));
    this._length += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    // Defensive copy: avoid aliasing the caller's buffer so a later mutation
    // of `bytes` doesn't silently corrupt our accumulated output.
    this.chunks.push(bytes.slice());
    this._length += bytes.length;
  }

  /**
   * Write a VLQ-encoded unsigned integer from a JS number.
   *
   * Caller is responsible for ensuring the value fits in a safe integer
   * (`<= 2^53 - 1`). For 64-bit-safe paths (SLong values), use
   * `writeVlqBigInt`.
   *
   * Accumulates via BigInt internally so values in `[2^32, 2^53)` encode
   * correctly -- a `number` shift via `>>> 7` would silently truncate to
   * 32 bits.
   */
  writeVlqU(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`writeVlqU: invalid value: ${value}`);
    }
    this.writeVlqBigInt(BigInt(value));
  }

  /**
   * Write a ZigZag-VLQ-encoded signed integer from a JS number.
   *
   * Caller is responsible for ensuring the value fits in a safe integer
   * (`|value| <= 2^53 - 1`). For 64-bit-safe paths, use
   * `writeVlqBigIntSigned`.
   *
   * Delegates ZigZag bit-twiddling to the BigInt path to keep one canonical
   * implementation of the sign-extension XOR.
   */
  writeVlqS(value: number): void {
    if (!Number.isInteger(value)) {
      throw new Error(`writeVlqS: not an integer: ${value}`);
    }
    this.writeVlqBigIntSigned(BigInt(value));
  }

  /**
   * Write a VLQ-encoded unsigned integer from a BigInt. Up to 64 bits.
   */
  writeVlqBigInt(value: bigint): void {
    if (value < 0n) {
      throw new Error(`writeVlqBigInt: negative value: ${value}`);
    }
    let v = value;
    while (v >= 0x80n) {
      this.writeU8(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.writeU8(Number(v));
  }

  /**
   * Write a ZigZag-VLQ-encoded signed integer from a BigInt.
   *
   * Two's-complement i64 zigzag: `(v << 1) ^ (v >> 63)`, with sign-aware
   * shift. Emulates i64 via masking so values from `-2^63` through `2^63 - 1`
   * encode to the same bytes the JVM/sigma-rust produces.
   */
  writeVlqBigIntSigned(value: bigint): void {
    const masked = value & 0xffffffffffffffffn; // emulate i64
    const sign = value < 0n ? 0xffffffffffffffffn : 0n;
    const zz = ((masked << 1n) & 0xffffffffffffffffn) ^ sign;
    this.writeVlqBigInt(zz);
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }

  writeOption<T>(value: T | null, serializer: (w: ByteWriter, v: T) => void): void {
    if (value === null) {
      this.writeU8(0);
      return;
    }
    this.writeU8(1);
    serializer(this, value);
  }

  writeArray<T>(items: T[], serializer: (w: ByteWriter, item: T) => void): void {
    this.writeVlqU(items.length);
    for (const item of items) serializer(this, item);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this._length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
