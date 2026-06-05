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
import { serializeHeaderWithoutPow } from './header';
import type { Header } from './header';
import { AutolykosV1NotSupportedError, PowHitInvalidParamsError } from './errors';

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
// autolykosMessage: msg = blake2b256(serialize_without_pow(header))
// ---------------------------------------------------------------------------
export function autolykosMessage(header: Header): Uint8Array {
  return blake2b256(serializeHeaderWithoutPow(header));
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
// int32BE: 4-byte big-endian u32 (JVM scorex.utils.Ints.toByteArray).
// ---------------------------------------------------------------------------
export function int32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

// ---------------------------------------------------------------------------
// buildAutolykosSeed: replicates AutolykosPowScheme::calc_seed_v2
//
// Inputs:
//   msg:   32-byte blake2b256 of serialize_without_pow
//   nonce: 8-byte nonce from autolykos solution
//   h:     raw height bytes (e.g. int32BE(height)) — passed through to f concat
//   bigN:  u32 table size from calcBigN
//
// Steps:
//   concat1 = msg ++ nonce
//   hash1   = blake2b256(concat1)
//   pre_i8  = BigInt::from_bytes_be(hash1[24..32])   // last 8 bytes
//   i       = asUnsignedByteArray(4, pre_i8 mod bigN) // 4 bytes
//   big_m   = calcBigM()
//   f       = blake2b256(i ++ h ++ big_m)
//   seed    = blake2b256(f[1..] ++ msg ++ nonce)
// ---------------------------------------------------------------------------
export function buildAutolykosSeed(
  msg: Uint8Array,
  nonce: Uint8Array,
  h: Uint8Array,
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

  const bigM = calcBigM();

  // Step 4: concat2 = i ++ h ++ big_m  (h passed raw — JVM hitForVersion2ForMessage)
  const concat2 = new Uint8Array(4 + h.length + bigM.length);
  concat2.set(iBytes, 0);
  concat2.set(h, 4);
  concat2.set(bigM, 4 + h.length);
  const f = blake2b256(concat2);

  // Step 5: concat3 = f[1..] ++ msg ++ nonce
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
// Produces k indices (u32) in [0, bigN).
//
// Algorithm:
//   extended_hash = seed ++ seed[0..3]   (35 bytes, supports k up to 32)
//   for i in 0..k:
//     window = extended_hash[i..i+4]     (4 bytes)
//     index  = BigInt::from_bytes_be(window) mod bigN
//
// Zero-modulo fix: if window mod bigN == 0, the Rust code
// `.to_u32_digits().1[0]` would panic (digits empty for 0).
// Correct answer is 0 — handled naturally in TypeScript with BigInt mod.
// ---------------------------------------------------------------------------
export function genIndexes(seed: Uint8Array, bigN: number, k: number): number[] {
  // JVM genIndexes(k, seed, N): (0 until k).map { BigInt(1, extendedHash.slice(i,i+4)).mod(N) }.
  // `seed` is the already-hashed seed (scorex factoring) -> no internal re-hash.
  const extended = new Uint8Array(35);
  extended.set(seed, 0);
  extended.set(seed.subarray(0, 3), 32);

  const bigNBig = BigInt(bigN);
  const result: number[] = new Array(k);
  for (let i = 0; i < k; i++) {
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
// hashElement: for index i at h (raw bytes), compute
//   blake2b256(int32BE(i) ++ h ++ big_m)[1..]
//
// Returns 31 bytes (the hash slice used as a BigInt in the sum).
// JVM: genElementV2(int32BE(index), h): Blake2b256(idx ++ h ++ M).drop(1).
// ---------------------------------------------------------------------------
export function hashElement(index: number, h: Uint8Array): Uint8Array {
  const bigM = calcBigM();
  const idxBytes = int32BE(index);

  // concat = idx_be4 ++ h ++ big_m  (h passed raw)
  const concat = new Uint8Array(4 + h.length + bigM.length);
  concat.set(idxBytes, 0);
  concat.set(h, 4);
  concat.set(bigM, 4 + h.length);

  const hash = blake2b256(concat);
  // Return bytes [1..32] = 31 bytes
  return hash.subarray(1);
}

// ---------------------------------------------------------------------------
// autolykosHitForMessage: Autolykos-2 PoW hit (JVM hitForVersion2ForMessage).
// Un-checked; caller must validate k/N or use autolykosHitForMessageWithChecks.
// ---------------------------------------------------------------------------
export function autolykosHitForMessage(
  k: number, msg: Uint8Array, nonce: Uint8Array, h: Uint8Array, N: number,
): bigint {
  const seed = buildAutolykosSeed(msg, nonce, h, N);
  const indexes = genIndexes(seed, N, k);
  let f2 = 0n;
  for (const idx of indexes) {
    const elemHash = hashElement(idx, h);
    let v = 0n;
    for (let i = 0; i < elemHash.length; i++) v = (v << 8n) | BigInt(elemHash[i]!);
    f2 += v;
  }
  const array = asUnsignedByteArray(32, f2);
  const hitBytes = blake2b256(array);
  let hit = 0n;
  for (let i = 0; i < hitBytes.length; i++) hit = (hit << 8n) | BigInt(hitBytes[i]!);
  return hit;
}

// ---------------------------------------------------------------------------
// autolykosHitForMessageWithChecks: public checked entry for Global.powHit.
// JVM hitForVersion2ForMessageWithChecks: require(k>=2, k<=32, N>=16).
// ---------------------------------------------------------------------------
export function autolykosHitForMessageWithChecks(
  k: number, msg: Uint8Array, nonce: Uint8Array, h: Uint8Array, N: number,
): bigint {
  if (k < 2) throw new PowHitInvalidParamsError(`powHit requires k >= 2, got ${k}`);
  if (k > 32) throw new PowHitInvalidParamsError(`powHit requires k <= 32, got ${k}`);
  if (N < 16) throw new PowHitInvalidParamsError(`powHit requires N >= 16, got ${N}`);
  return autolykosHitForMessage(k, msg, nonce, h, N);
}

// ---------------------------------------------------------------------------
// verifyAutolykosV2: full PoW check for Autolykos v2 headers.
//
// Returns true iff hit < target, where:
//   hit    = autolykosHitForMessage(32, msg, nonce, int32BE(height), bigN)
//   target = ORDER / decodeCompactBits(header.nBits)
// ---------------------------------------------------------------------------
export function verifyAutolykosV2(header: Header): boolean {
  // v1 headers are not supported here; per sigma-rust check_pow returns an error
  if (header.version === 1) {
    throw new AutolykosV1NotSupportedError(
      'verifyAutolykosV2: Autolykos v1 is not supported',
    );
  }

  const msg = autolykosMessage(header);
  const nonce = header.autolykosSolution.nonce;
  const height = header.height;
  const bigN = calcBigN(header.version, height);

  // JVM hitForVersion2(header): hitForVersion2ForMessage(32, msg, nonce, int32BE(height), N).
  const hit = autolykosHitForMessage(32, msg, nonce, int32BE(height), bigN);

  // target = ORDER / decodeCompactBits(nBits)
  const decoded = decodeCompactBits(header.nBits);
  if (decoded === 0n) return false; // prevent div by zero
  const target = ORDER / decoded;

  return hit < target;
}
