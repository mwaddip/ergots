/**
 * Decode a Bitcoin-compact nBits value to a BigInt target.
 *
 * The compact format encodes a target as:
 *   target = mantissa * 256^(size - 3)
 *
 * where:
 *   - size   = upper byte of nBits (bits 24-31)
 *   - mantissa = lower 23 bits of nBits (bits 0-22)
 *   - sign bit = bit 23 (0x00800000); if set, the target is negative
 *
 * For size <= 3 the value is right-shifted instead (equivalent to only
 * keeping the top `size` bytes of the 3-byte mantissa field).
 *
 * This replicates `decode_compact_bits` from sigma-rust
 * (ergo-chain-types/src/autolykos_pow_scheme.rs).
 */
export function decodeCompactBits(nBits: number): bigint {
  const size = (nBits >>> 24) & 0xff;
  const mantissa = BigInt(nBits & 0x007fffff);
  const negative = (nBits & 0x00800000) !== 0;
  let target: bigint;
  if (size <= 3) {
    target = mantissa >> BigInt(8 * (3 - size));
  } else {
    target = mantissa << BigInt(8 * (size - 3));
  }
  return negative ? -target : target;
}
