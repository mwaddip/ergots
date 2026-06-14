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
 * Uses `@noble/hashes/blake2.js` `blake2b` with `{ dkLen: 32 }` — the shared
 * primitive lives in `crypto/hashes.ts` as `blake2b256`.
 */

import { blake2b } from '@noble/hashes/blake2.js'
import type { CalcBlake2b256, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue, collByteToUint8Array } from './_byte-coll'

export function evalCalcBlake2b256(
  e: CalcBlake2b256,
  env: Env,
  ctx: EvalContext
): SValue {
  const input = evalExpr(e.input, env, ctx)
  const bytes = collByteToUint8Array(input, 'CalcBlake2b256')
  // Pattern B: charge AFTER eval-child + AFTER type guard.
  ctx.addPerItemCost(20, 7, 128, bytes.length)
  const digest = blake2b(bytes, { dkLen: 32 })
  return bytesToCollByteSValue(digest)
}
