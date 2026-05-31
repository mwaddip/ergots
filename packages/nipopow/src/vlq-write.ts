import { ByteWriter, encodeVlqU } from '@ergots/scorex';

/**
 * Write a VLQ-encoded u32 size/count field. Throws on out-of-u32-range input.
 *
 * Shared by proof.ts and popow-header.ts (previously two near-identical
 * module-private copies). The scorex codec exposes the read counterpart
 * `readVlqU32` but no write helper, and adding one to scorex's public API is
 * out of scope here.
 */
export function writeVlqU32(w: ByteWriter, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new Error(`writeVlqU32: value out of u32 range: ${v}`);
  }
  w.writeBytes(encodeVlqU(BigInt(v)));
}
