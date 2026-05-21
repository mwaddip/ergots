/**
 * DecodePoint arm — 33-byte SEC1-compressed Coll[Byte] → GroupElement.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/decode_point.rs:14-30
 *   ctx.add_jit_cost(300)?;                              // Pattern A: BEFORE eval-child
 *   let point_bytes = self.input.eval(env, ctx)?
 *       .try_extract_into::<Vec<u8>>()?;
 *   let point: EcPoint = SigmaSerializable::sigma_parse_bytes(&point_bytes)
 *       .map_err(|_| Misc(format!("DecodePoint: Failed to parse EC point ...")))?;
 *   Ok(point.into())
 *
 * Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(300).
 *
 * Adapter delegation: `crypto/secp256k1.ts:decodePoint` mirrors sigma-rust's
 * `EcPoint::sigma_parse_bytes` — it (a) checks the 33-byte length, (b) short-
 * circuits the Ergo identity convention (33 zero bytes → `Point.ZERO`), and
 * (c) delegates to @noble/curves' SEC1-compressed point parser for non-
 * identity inputs (which throws on off-curve / invalid encodings).
 *
 * Output re-encoding: we re-encode the parsed Point to the canonical 33-byte
 * SEC1 form (identity → 33 zero bytes; compressed otherwise) before wrapping
 * as a `GroupElement` SValue. This mirrors sigma-rust's
 * `EcPoint::scorex_serialize` at `ec_point.rs:127-137`: identity is encoded as
 * all-zero, every other point as 0x02/0x03 + 32-byte x-coordinate. The
 * `point.is0()` guard is required because `@noble/curves@2.2.0` throws
 * "bad point: ZERO" from `Point.ZERO.toBytes()` (see crypto/secp256k1.ts:17-18
 * and encodePoint at :85-92 for the established precedent).
 *
 * PRE-EXISTING DIVERGENCE (not introduced by this arm): sigma-rust's
 * `EcPoint::scorex_parse` (`ec_point.rs:140-152`) dispatches on `buf[0] != 0` —
 * it treats ANY 33-byte payload whose first byte is 0x00 as the curve
 * identity, regardless of the remaining 32 bytes. Our TS adapter at
 * `crypto/secp256k1.ts:65-74` is STRICTER: it requires all 33 bytes to be
 * zero (via `isZero33`). A hand-crafted input like `[0x00, 0xAB, ...]` would
 * decode to identity under sigma-rust and would throw under our adapter.
 *
 * In practice this divergence is unreachable through the standard parse path
 * because sigma-rust's `scorex_serialize` always emits identity as exactly 33
 * zero bytes (it short-circuits when `caff.is_identity()` is true and writes
 * 33 zero bytes literally). Only hand-crafted MIR or hostile input bytes
 * could trigger it. The divergence is inherited from the sigma-protocol
 * verifier surface and is NOT introduced by this slice. See the design spec
 * §"Risk Hotspot 3" for the full discussion and out-of-scope follow-up.
 *
 * Build-time type guard: `DecodePoint::try_build` (sigma-rust
 * `ergotree-ir/src/mir/decode_point.rs:43-48`) calls
 * `input.check_post_eval_tpe(&SType::SColl(SByte))?`, so non-Coll[Byte]
 * inputs cannot be serialized via the standard path. The TS-side
 * `'predef-input-not-byte-array'` assertion is defensive against
 * `ConstantPlaceholder` injection or hand-crafted MIR (calc_blake2b256 /
 * byte_array_to_long precedent).
 */

import type { DecodePoint, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { collByteToUint8Array } from './_byte-coll'
import { decodePoint } from '../crypto/secp256k1'

export function evalDecodePoint(
  e: DecodePoint,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(300) // Pattern A: charge BEFORE eval-child
  const inputV = evalExpr(e.input, env, ctx)
  const bytes = collByteToUint8Array(inputV, 'DecodePoint')
  let point: ReturnType<typeof decodePoint>
  try {
    point = decodePoint(bytes)
  } catch (cause) {
    throw new EvalError(
      `DecodePoint: invalid point bytes — ${(cause as Error).message}`,
      'decode-point-invalid',
    )
  }
  // Re-encode to canonical 33-byte SEC1. Identity → 33 zero bytes; non-identity
  // → 0x02/0x03 + 32-byte x-coordinate. The is0() guard is required because
  // @noble/curves@2.2.0 throws on `Point.ZERO.toBytes()` (matches the
  // established `encodePoint` precedent at crypto/secp256k1.ts:85-92).
  const valueBytes = point.is0() ? new Uint8Array(33) : point.toBytes(true)
  return { kind: 'GroupElement', value: valueBytes }
}
