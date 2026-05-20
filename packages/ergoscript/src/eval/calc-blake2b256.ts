/**
 * CalcBlake2b256 arm — Coll[Byte] → Coll[Byte] of 32-byte blake2b-256 digest.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34
 *   let input_v = self.input.eval(env, ctx)?;          // eval-child FIRST
 *   match input_v { Coll[Byte](coll_byte) => {
 *       ctx.add_per_item_jit_cost(20, 7, 128, n)?;     // Pattern B: AFTER eval-child
 *       Ok(blake2b256_hash(coll_byte).to_vec().into())
 *   }, _ => Err(UnexpectedValue(...)) }
 *
 * Cost-charging order: Pattern B (envelope AFTER eval-child). Composite
 * per-item cost: base=20, perChunk=7, chunkSize=128, n=input bytes length.
 *
 * Non-Coll[Byte] input: sigma-rust returns `EvalError::UnexpectedValue`. We
 * surface this as `'predef-input-not-byte-array'`. Wire-format invariants
 * (`CalcBlake2b256::try_build` enforces `check_post_eval_tpe(SColl(SByte))`
 * at parse time) make this unreachable for parser-produced trees; defensive
 * against `ConstantPlaceholder` injection or hand-crafted MIR.
 *
 * Uses `@noble/hashes/blake2.js` `blake2b` with `{ dkLen: 32 }` (same pattern
 * as `extract-id.ts` — first eval-time blake2b call lived there).
 */

import { blake2b } from '@noble/hashes/blake2.js'
import type { CalcBlake2b256, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'

export function evalCalcBlake2b256(
  e: CalcBlake2b256,
  env: Env,
  ctx: EvalContext
): SValue {
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Coll' || input.elem.tag !== 'SByte') {
    throw new EvalError(
      `CalcBlake2b256: expected Coll[Byte] input, got kind='${input.kind}'`,
      'predef-input-not-byte-array'
    )
  }
  // Pack i8 items back to u8 bytes (matches `extractBytes` convention).
  const bytes = new Uint8Array(input.items.length)
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i]!
    // Defensive: parser produces Byte items, but ConstantPlaceholder may inject
    // non-Byte items past the elem-tag guard above. Same code per Decision in
    // the 2i-a design (single predef error code).
    if (item.kind !== 'Byte') {
      throw new EvalError(
        `CalcBlake2b256: expected Byte item at index ${i}, got '${item.kind}'`,
        'predef-input-not-byte-array'
      )
    }
    bytes[i] = item.value & 0xff
  }
  // Pattern B: charge AFTER eval-child + AFTER type guard.
  ctx.addPerItemCost(20, 7, 128, bytes.length)
  const digest = blake2b(bytes, { dkLen: 32 })
  return bytesToCollByteSValue(digest)
}
