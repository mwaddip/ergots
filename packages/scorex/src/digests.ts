import { ByteReader } from './reader.ts';
import { ByteWriter } from './writer.ts';
import { ReaderError } from './errors.ts';

export const BLOCK_ID_LEN = 32;
export const DIGEST32_LEN = 32;
export const AD_DIGEST_LEN = 33;
export const EC_POINT_LEN = 33; // compressed secp256k1

export function readFixed(reader: ByteReader, len: number, name: string): Uint8Array {
  try {
    return reader.readBytes(len);
  } catch (e) {
    if (e instanceof ReaderError && e.code === 'position-limit-exceeded') {
      // The window entry check is a consensus gate (JVM CheckPositionLimit,
      // rule 1014) — its code must surface unmodified to windowed callers.
      throw e;
    }
    // Genuine truncation (and anything else) keeps the named-field re-code.
    throw new ReaderError(`${name}: truncated`, 'truncated');
  }
}

export function writeFixed(writer: ByteWriter, bytes: Uint8Array, expectedLen: number, name: string): void {
  if (bytes.length !== expectedLen) {
    throw new Error(`${name}: expected ${expectedLen} bytes, got ${bytes.length}`);
  }
  writer.writeBytes(bytes);
}
