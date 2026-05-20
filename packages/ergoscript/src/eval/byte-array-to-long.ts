/**
 * ByteArrayToLong arm — Coll[Byte] → SLong. First 8 bytes BE; trailing IGNORED.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_long.rs:18-34
 *   ctx.add_jit_cost(16)?;                              // Pattern A: BEFORE eval-child
 *   let input = self.input.eval(env, ctx)?.try_extract_into::<Vec<u8>>()?;
 *   if input.len() < 8 { return Err(UnexpectedValue("byteArrayToLong: array must contain at least 8 elements")); }
 *   Ok((((input[0] as i64) << 56) | ... | (input[7] as i64)).into())
 *
 * `eval_skip_tail` test at byte_array_to_long.rs:62-65 asserts trailing bytes
 * after the first 8 are IGNORED. The length check is `< 8`, NOT `!= 8`.
 *
 * Cost-charging order: Pattern A (envelope BEFORE eval-child). Fixed(16).
 *
 * Non-Coll[Byte] input: sigma-rust returns `EvalError::UnexpectedValue`. We
 * surface this as `'predef-input-not-byte-array'`. Wire-format invariants
 * (`ByteArrayToLong::try_build` enforces `check_post_eval_tpe(SColl(SByte))`
 * at parse time) make this unreachable for parser-produced trees; defensive
 * against `ConstantPlaceholder` injection or hand-crafted MIR.
 *
 * Reads the first 8 bytes as a big-endian signed i64 via `DataView.getBigInt64`.
 * `DataView` bounds reads to the constructed byteLength (8), so any trailing
 * bytes in `bytes.length > 8` are naturally ignored.
 */

import type { ByteArrayToLong, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

export function evalByteArrayToLong(
  e: ByteArrayToLong,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(16) // Pattern A: charge BEFORE eval-child
  const inputV = evalExpr(e.input, env, ctx)
  if (inputV.kind !== 'Coll' || inputV.elem.tag !== 'SByte') {
    throw new EvalError(
      `ByteArrayToLong: expected Coll[Byte] input, got kind='${inputV.kind}'`,
      'predef-input-not-byte-array'
    )
  }
  // Pack i8 items back to u8 bytes. Inline (no `extractCollByte` helper yet
  // — extraction deferred to T7 Xor's 3rd-caller threshold).
  const bytes = new Uint8Array(inputV.items.length)
  for (let i = 0; i < inputV.items.length; i++) {
    const item = inputV.items[i]!
    // Defensive: parser produces Byte items, but ConstantPlaceholder may inject
    // non-Byte items past the elem-tag guard above.
    if (item.kind !== 'Byte') {
      throw new EvalError(
        `ByteArrayToLong: expected Byte item at index ${i}, got '${item.kind}'`,
        'predef-input-not-byte-array'
      )
    }
    bytes[i] = item.value & 0xff
  }
  if (bytes.length < 8) {
    throw new EvalError(
      `ByteArrayToLong: array must contain at least 8 elements, got ${bytes.length}`,
      'byte-array-to-long-too-short'
    )
  }
  // Read first 8 bytes as BE i64. DataView byteLength = 8 bounds the read;
  // any trailing bytes in `bytes.length > 8` are ignored.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 8)
  return { kind: 'Long', value: dv.getBigInt64(0, false) }
}
