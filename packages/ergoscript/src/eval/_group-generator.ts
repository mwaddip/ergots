/**
 * `GROUP_GENERATOR_BYTES` — secp256k1 base point (G) in compressed
 * SEC1 form (33 bytes).
 *
 * Used by `GlobalVars.GroupGenerator` arm. The compressed encoding is
 * the canonical SEC1 representation: 0x02 prefix (even-y) followed by
 * the 32-byte x-coordinate of the generator point.
 *
 * Sigma-rust ref: ergo-chain-types/src/ec_point.rs::generator() uses
 * k256::ProjectivePoint::GENERATOR. The compressed encoding is a
 * standardized constant; hardcoding avoids a runtime dependency on
 * @noble/curves (introduced in phase 2g for actual EcPoint arithmetic).
 *
 * The bytes are the well-known secp256k1 base point in compressed form:
 *   02 79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
 */

export const GROUP_GENERATOR_BYTES: Uint8Array = new Uint8Array([
  0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb,
  0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b,
  0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28,
  0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17,
  0x98,
])
