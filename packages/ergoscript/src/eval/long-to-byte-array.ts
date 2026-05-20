/**
 * LongToByteArray arm — SLong → Coll[Byte] (8 bytes, big-endian i64).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/long_to_byte_array.rs:11-25
 *   ctx.add_jit_cost(17)?;                            // Pattern A: BEFORE eval-child
 *   let mut val = self.input.eval(env, ctx)?.try_extract_into::<i64>()?;
 *   let mut buf = vec![42_i8; 8];
 *   for i in (0..8).rev() {
 *       buf[i] = (val & 0xFF) as i8;
 *       val >>= 8;
 *   }
 *   Ok(buf.into())
 *
 * Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(17).
 * Inverse of ByteArrayToLong (T4): the loop emits the most-significant byte
 * first; equivalent to a single `DataView.setBigInt64(0, val, false)`.
 *
 * Non-SLong input: sigma-rust returns `EvalError::UnexpectedValue` (via
 * `try_extract_into::<i64>()`). We surface this as `'predef-input-not-long'`.
 * Wire-format invariants (`LongToByteArray::try_build` enforces
 * `check_post_eval_tpe(SLong)` at parse time) make this unreachable for
 * parser-produced trees; defensive against `ConstantPlaceholder` injection
 * or hand-crafted MIR (byte_array_to_long.ts precedent).
 */

import type { LongToByteArray, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'

export function evalLongToByteArray(
  e: LongToByteArray,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(17) // Pattern A: charge BEFORE eval-child
  const inputV = evalExpr(e.input, env, ctx)
  if (inputV.kind !== 'Long') {
    throw new EvalError(
      `LongToByteArray: expected Long input, got kind='${inputV.kind}'`,
      'predef-input-not-long'
    )
  }
  // Pack i64 to 8 bytes big-endian. `DataView.setBigInt64(byteOffset, value,
  // littleEndian=false)` writes the high byte first, exactly matching the
  // sigma-rust loop `for i in (0..8).rev() { buf[i] = (val & 0xFF) as i8; val >>= 8 }`.
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, inputV.value, false)
  return bytesToCollByteSValue(out)
}
