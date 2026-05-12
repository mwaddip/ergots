/**
 * Autolykos v2 Proof-of-Work verification.
 *
 * Reference: sigma-rust ergo-chain-types/src/autolykos_pow_scheme.rs
 *            sigma-rust ergo-chain-types/src/header.rs (check_pow, serialize_without_pow)
 *
 * Algorithm (version >= 2):
 *  1. msg  = blake2b256(serialize_without_pow(header))          // 32 bytes
 *  2. nonce = header.autolykosSolution.nonce                    // 8 bytes
 *  3. N    = calcBigN(version, height)                          // u32
 *  4. seed = buildAutolykosSeed(msg, nonce, height, N)          // 32 bytes
 *  5. indices = genIndexes(seed, N)                             // 32 × u32
 *  6. elems   = indices.map(i => hashElement(i, height))        // 32 × 31-byte slice
 *  7. f2   = sum(elems as BigInts)                              // BigInt
 *  8. array = asUnsignedByteArray32(f2)                         // 32 bytes
 *  9. hit  = blake2b256(array)                                  // 32 bytes (BigUint)
 * 10. target = ORDER / decodeCompactBits(nBits)                 // BigInt
 * 11. valid  = bigintFromBE(hit) < target
 */

import { blake2b256 } from './crypto/blake2b256';
import { decodeCompactBits } from './nbits';
import type { Header } from './header';
import { ByteWriter } from './scorex/writer';
import { encodeVlqU } from './scorex/vlq';

// ---------------------------------------------------------------------------
// secp256k1 curve order (constant)
// ---------------------------------------------------------------------------
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ---------------------------------------------------------------------------
// calc_big_m: (0u64..1024).flat_map(|x| x.to_be_bytes()).collect()
// = 1024 × 8-byte big-endian u64 = 8192 bytes
// This is a constant; we compute it once lazily.
// ---------------------------------------------------------------------------
let _bigM: Uint8Array | undefined;
function calcBigM(): Uint8Array {
  if (_bigM !== undefined) return _bigM;
  const buf = new Uint8Array(1024 * 8);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < 1024; i++) {
    view.setBigUint64(i * 8, BigInt(i), false); // big-endian
  }
  _bigM = buf;
  return buf;
}

// ---------------------------------------------------------------------------
// calcBigN: replicates AutolykosPowScheme::calc_big_n
//
// n_base = 2^26 = 67108864
// For version == 1: always n_base
// For version >= 2:
//   increase_start = 600 * 1024 = 614400
//   if height < 614400: n_base
//   else: n_base * 1.05 ^ iters, where iters = floor((height - 614400) / 51200) + 1
//         computed as: acc = n_base; for i in 1..=iters: acc = acc / 100 * 105
// ---------------------------------------------------------------------------
const N_BASE = 67108864; // 2^26
const N_INCREASE_START = 600 * 1024; // 614400
const N_INCREASE_PERIOD = 50 * 1024; // 51200
const N_INCREASE_HEIGHT_MAX = 4198400;

export function calcBigN(version: number, height: number): number {
  if (version === 1) return N_BASE;
  const h = Math.min(N_INCREASE_HEIGHT_MAX, height);
  if (h < N_INCREASE_START) return N_BASE;
  const iters = Math.floor((h - N_INCREASE_START) / N_INCREASE_PERIOD) + 1;
  let n = N_BASE;
  for (let i = 0; i < iters; i++) {
    n = Math.floor(n / 100) * 105;
  }
  return n;
}

// ---------------------------------------------------------------------------
// serializeWithoutPow: replicates Header::serialize_without_pow
//
// version (u8) || parentId (32) || adProofsRoot (32) || transactionRoot (32)
// || stateRoot (33) || timestamp (VLQ u64) || extensionRoot (32)
// || n_bits (4 bytes BE) || height (VLQ u32) || votes (3)
// || [if version > 1: unparsed_len (u8) || unparsed_bytes]
// ---------------------------------------------------------------------------
function serializeWithoutPow(header: Header): Uint8Array {
  const w = new ByteWriter();

  w.writeU8(header.version);
  w.writeBytes(header.parentId);
  w.writeBytes(header.adProofsRoot);
  w.writeBytes(header.transactionRoot);
  w.writeBytes(header.stateRoot);
  w.writeBytes(encodeVlqU(BigInt(header.timestamp)));
  w.writeBytes(header.extensionRoot);

  // n_bits: 4 bytes big-endian
  const nBitsBytes = new Uint8Array(4);
  nBitsBytes[0] = (header.nBits >>> 24) & 0xff;
  nBitsBytes[1] = (header.nBits >>> 16) & 0xff;
  nBitsBytes[2] = (header.nBits >>> 8) & 0xff;
  nBitsBytes[3] = header.nBits & 0xff;
  w.writeBytes(nBitsBytes);

  w.writeBytes(encodeVlqU(BigInt(header.height)));
  w.writeBytes(header.votes);

  if (header.version > 1) {
    w.writeU8(header.unparsedBytes.length);
    if (header.unparsedBytes.length > 0) {
      w.writeBytes(header.unparsedBytes);
    }
  }

  return w.toBytes();
}

// ---------------------------------------------------------------------------
// autolykosMessage: msg = blake2b256(serialize_without_pow(header))
// ---------------------------------------------------------------------------
export function autolykosMessage(header: Header): Uint8Array {
  return blake2b256(serializeWithoutPow(header));
}

// ---------------------------------------------------------------------------
// Port of BouncyCastle's BigIntegers::asUnsignedByteArray(length, bigint).
// Produces exactly `length` bytes (big-endian, zero-padded, no leading 0x00
// sign byte).
//
// bigint must be >= 0.
// ---------------------------------------------------------------------------
function asUnsignedByteArray(length: number, value: bigint): Uint8Array {
  if (value < 0n) throw new RangeError('asUnsignedByteArray: negative value');
  // Convert to hex, zero-pad to at least `length` bytes
  const hex = value.toString(16);
  // Each byte = 2 hex chars
  const paddedHex = hex.padStart(length * 2, '0');
  if (paddedHex.length > length * 2) {
    // Value doesn't fit in `length` bytes
    // Take only the last `length` bytes (truncate — shouldn't happen for valid inputs)
    // The Rust impl returns an error; we throw
    throw new RangeError(`asUnsignedByteArray: value too large for ${length} bytes`);
  }
  const result = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    result[i] = parseInt(paddedHex.substring(i * 2, i * 2 + 2), 16);
  }
  return result;
}

// ---------------------------------------------------------------------------
// buildAutolykosSeed: replicates AutolykosPowScheme::calc_seed_v2
//
// Inputs:
//   msg:    32-byte blake2b256 of serialize_without_pow
//   nonce:  8-byte nonce from autolykos solution
//   height: u32 header height
//   bigN:   u32 table size from calcBigN
//
// Steps:
//   concat1 = msg ++ nonce
//   hash1   = blake2b256(concat1)
//   pre_i8  = BigInt::from_bytes_be(hash1[24..32])   // last 8 bytes
//   i       = asUnsignedByteArray(4, pre_i8 mod bigN) // 4 bytes
//   height_bytes = height.to_be_bytes()               // 4 bytes
//   big_m   = calcBigM()
//   f       = blake2b256(i ++ height_bytes ++ big_m)
//   seed    = blake2b256(f[1..] ++ msg ++ nonce)
// ---------------------------------------------------------------------------
export function buildAutolykosSeed(
  msg: Uint8Array,
  nonce: Uint8Array,
  height: number,
  bigN: number,
): Uint8Array {
  // Step 1: concat1 = msg ++ nonce
  const concat1 = new Uint8Array(msg.length + nonce.length);
  concat1.set(msg, 0);
  concat1.set(nonce, msg.length);
  const hash1 = blake2b256(concat1);

  // Step 2: pre_i8 = last 8 bytes of hash1 as unsigned BigInt
  let pre_i8 = 0n;
  for (let i = 24; i < 32; i++) {
    pre_i8 = (pre_i8 << 8n) | BigInt(hash1[i]!);
  }

  // Step 3: i = asUnsignedByteArray(4, pre_i8 mod bigN)
  const remainder = pre_i8 % BigInt(bigN);
  const iBytes = asUnsignedByteArray(4, remainder);

  // Step 4: height_bytes = height as 4-byte big-endian
  const heightBytes = new Uint8Array(4);
  heightBytes[0] = (height >>> 24) & 0xff;
  heightBytes[1] = (height >>> 16) & 0xff;
  heightBytes[2] = (height >>> 8) & 0xff;
  heightBytes[3] = height & 0xff;

  const bigM = calcBigM();

  // Step 5: concat2 = i ++ height_bytes ++ big_m
  const concat2 = new Uint8Array(4 + 4 + bigM.length);
  concat2.set(iBytes, 0);
  concat2.set(heightBytes, 4);
  concat2.set(bigM, 8);
  const f = blake2b256(concat2);

  // Step 6: concat3 = f[1..] ++ msg ++ nonce
  const fSlice = f.subarray(1); // 31 bytes
  const concat3 = new Uint8Array(fSlice.length + msg.length + nonce.length);
  concat3.set(fSlice, 0);
  concat3.set(msg, fSlice.length);
  concat3.set(nonce, fSlice.length + msg.length);

  return blake2b256(concat3);
}

// ---------------------------------------------------------------------------
// genIndexes: replicates AutolykosPowScheme::gen_indexes
//
// Produces 32 indices (u32) in [0, bigN).
//
// Algorithm:
//   extended_hash = seed ++ seed[0..3]   (35 bytes)
//   for i in 0..32:
//     window = extended_hash[i..i+4]     (4 bytes)
//     index  = BigInt::from_bytes_be(window) mod bigN
//
// Zero-modulo fix: if window mod bigN == 0, the Rust code
// `.to_u32_digits().1[0]` would panic (digits empty for 0).
// Correct answer is 0 — handled naturally in TypeScript with BigInt mod.
// ---------------------------------------------------------------------------
export function genIndexes(seed: Uint8Array, bigN: number): number[] {
  const extended = new Uint8Array(35);
  extended.set(seed, 0);
  extended.set(seed.subarray(0, 3), 32);

  const bigNBig = BigInt(bigN);
  const result: number[] = new Array(32);
  for (let i = 0; i < 32; i++) {
    // 4-byte window as unsigned big-endian BigInt
    let window = 0n;
    for (let j = 0; j < 4; j++) {
      window = (window << 8n) | BigInt(extended[i + j]!);
    }
    // mod bigN — handles zero correctly (0 mod N = 0)
    result[i] = Number(window % bigNBig);
  }
  return result;
}

// ---------------------------------------------------------------------------
// hashElement: for index i at height h, compute
//   blake2b256(i.to_be_bytes() ++ height.to_be_bytes() ++ big_m)[1..]
//
// Returns 31 bytes (the hash slice used as a BigInt in the sum).
// ---------------------------------------------------------------------------
export function hashElement(index: number, height: number): Uint8Array {
  const bigM = calcBigM();

  // index as 4-byte big-endian
  const idxBytes = new Uint8Array(4);
  idxBytes[0] = (index >>> 24) & 0xff;
  idxBytes[1] = (index >>> 16) & 0xff;
  idxBytes[2] = (index >>> 8) & 0xff;
  idxBytes[3] = index & 0xff;

  // height as 4-byte big-endian
  const heightBytes = new Uint8Array(4);
  heightBytes[0] = (height >>> 24) & 0xff;
  heightBytes[1] = (height >>> 16) & 0xff;
  heightBytes[2] = (height >>> 8) & 0xff;
  heightBytes[3] = height & 0xff;

  // concat = idx_be4 ++ height_be4 ++ big_m
  const concat = new Uint8Array(4 + 4 + bigM.length);
  concat.set(idxBytes, 0);
  concat.set(heightBytes, 4);
  concat.set(bigM, 8);

  const hash = blake2b256(concat);
  // Return bytes [1..32] = 31 bytes
  return hash.subarray(1);
}

// ---------------------------------------------------------------------------
// verifyAutolykosV2: full PoW check for Autolykos v2 headers.
//
// Returns true iff hit < target, where:
//   hit    = blake2b256(asUnsignedByteArray32(sum(hashElement(i) for i in indices)))
//   target = ORDER / decodeCompactBits(header.nBits)
// ---------------------------------------------------------------------------
export function verifyAutolykosV2(header: Header): boolean {
  // v1 headers are not supported here; per sigma-rust check_pow returns an error
  if (header.version === 1) {
    throw new Error('verifyAutolykosV2: Autolykos v1 is not supported');
  }

  const msg = autolykosMessage(header);
  const nonce = header.autolykosSolution.nonce;
  const height = header.height;
  const bigN = calcBigN(header.version, height);

  const seed = buildAutolykosSeed(msg, nonce, height, bigN);
  const indices = genIndexes(seed, bigN);

  // Compute f2 = sum of element BigInts
  let f2 = 0n;
  for (const idx of indices) {
    const elemHash = hashElement(idx, height);
    // 31-byte big-endian unsigned
    let v = 0n;
    for (let i = 0; i < elemHash.length; i++) {
      v = (v << 8n) | BigInt(elemHash[i]!);
    }
    f2 += v;
  }

  // array = asUnsignedByteArray(32, f2)
  const array = asUnsignedByteArray(32, f2);

  // hit = BigUint from blake2b256(array)
  const hitBytes = blake2b256(array);
  let hit = 0n;
  for (let i = 0; i < hitBytes.length; i++) {
    hit = (hit << 8n) | BigInt(hitBytes[i]!);
  }

  // target = ORDER / decodeCompactBits(nBits)
  const decoded = decodeCompactBits(header.nBits);
  if (decoded === 0n) return false; // prevent div by zero
  const target = ORDER / decoded;

  return hit < target;
}
