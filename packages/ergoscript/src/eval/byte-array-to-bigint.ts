/**
 * ByteArrayToBigInt arm — Coll[Byte] → BigInt (i256-range-checked).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34
 *   ctx.add_jit_cost(30)?;                              // Pattern A: BEFORE eval-child
 *   let input = self.input.eval(env, ctx)?.try_extract_into::<Vec<u8>>()?;
 *   if input.is_empty() { return Err(UnexpectedValue("byte array is empty")); }
 *   match BigInt256::from_be_slice(&input[..]) {
 *       Some(n) => Ok(Value::BigInt(n)),
 *       None    => Err(UnexpectedValue("input array out of bounds")),
 *   }
 *
 * `BigInt256::from_be_slice` (`ergotree-ir/src/bigint256.rs:55-62`) rejects
 * empty input then delegates to `bnum::I256::from_be_slice`. The slice length
 * is NOT capped at 32 — slices > 32 bytes succeed when their value still fits
 * in `[I256::MIN, I256::MAX]` = `[-2^255, 2^255 - 1]` (typically because the
 * leading bytes are redundant sign-extension bytes). See sigma-rust's
 * `eval_above_max_bound` test (byte_array_to_bigint.rs:107-118) for the 33-byte
 * just-above-max case.
 *
 * Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(30).
 *
 * Non-Coll[Byte] input: sigma-rust returns `EvalError::UnexpectedValue` (via
 * `try_extract_into::<Vec<u8>>()`). We surface this as
 * `'predef-input-not-byte-array'`. Wire-format invariants
 * (`ByteArrayToBigInt::try_build` enforces `check_post_eval_tpe(SColl(SByte))`
 * at parse time) make this unreachable for parser-produced trees; defensive
 * against `ConstantPlaceholder` injection or hand-crafted MIR.
 */

import type { ByteArrayToBigInt, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import {
  collByteToUint8Array,
  signedBeBytesToBigInt,
  I256_MIN,
  I256_MAX,
} from './_byte-coll'

export function evalByteArrayToBigInt(
  e: ByteArrayToBigInt,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(30) // Pattern A: charge BEFORE eval-child
  const inputV = evalExpr(e.input, env, ctx)
  const bytes = collByteToUint8Array(inputV, 'ByteArrayToBigInt')
  // Empty-input check runs BEFORE the range check (mirrors sigma-rust order:
  // explicit is_empty() at byte_array_to_bigint.rs:20-22).
  if (bytes.length === 0) {
    throw new EvalError(
      'ByteArrayToBigInt: byte array is empty',
      'byte-array-to-bigint-empty'
    )
  }
  const value = signedBeBytesToBigInt(bytes)
  // Strict inequality: I256_MIN and I256_MAX themselves are in range.
  if (value < I256_MIN || value > I256_MAX) {
    throw new EvalError(
      'ByteArrayToBigInt: decoded value out of i256 range',
      'byte-array-to-bigint-out-of-range'
    )
  }
  return { kind: 'BigInt', value }
}
