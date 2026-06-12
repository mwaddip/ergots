import { ByteReader } from './reader.ts';
import { ReaderError } from './errors.ts';

export function encodeVlqU(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error('encodeVlqU: negative value');
  }
  if (value > 0xffffffffffffffffn) {
    // The wire carries u64 only (references encode from u64/Long); a wider
    // value would decode WRAPPED on their side — reject at the source.
    throw new Error('encodeVlqU: value exceeds u64');
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

/**
 * Decode a VLQ-encoded unsigned integer (up to 64 bits; wraps mod 2^64 like
 * the references). Delegates to `ByteReader.readVlqBigInt` — ONE positionLimit
 * check per logical read, so a VLQ straddling an armed window decodes like the
 * JVM getULong instead of per-byte-rejecting. Throws ReaderError with
 * 'vlq-overflow' after 10 continuation bytes.
 */
export function decodeVlqU(reader: ByteReader): bigint {
  return reader.readVlqBigInt();
}

export function encodeVlqZigZag(value: bigint): Uint8Array {
  // Two's-complement i64 zigzag: (v << 1) ^ (v >> 63), with sign-aware shift.
  const masked = value & 0xffffffffffffffffn; // emulate i64
  const sign = value < 0n ? 0xffffffffffffffffn : 0n;
  const zz = ((masked << 1n) & 0xffffffffffffffffn) ^ sign;
  return encodeVlqU(zz);
}

/**
 * Decode a ZigZag-VLQ-encoded signed integer. Delegates to
 * `ByteReader.readVlqBigIntSigned` — one positionLimit check per logical read
 * (see decodeVlqU).
 */
export function decodeVlqZigZag(reader: ByteReader): bigint {
  return reader.readVlqBigIntSigned();
}

/**
 * Read a VLQ-encoded u32 (plain unsigned, not zigzag). Reads via
 * `ByteReader.readVlqBigInt` — one positionLimit check per logical read.
 * Throws ReaderError with 'vlq-overflow' if the decoded value exceeds u32 range.
 */
export function readVlqU32(reader: ByteReader, fieldName: string): number {
  const v = reader.readVlqBigInt();
  if (v > 0xffffffffn) {
    throw new ReaderError(`${fieldName}: VLQ value exceeds u32 range`, 'vlq-overflow');
  }
  return Number(v);
}
