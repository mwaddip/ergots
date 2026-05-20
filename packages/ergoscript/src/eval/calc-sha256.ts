/**
 * CalcSha256 arm — Coll[Byte] → Coll[Byte] of 32-byte sha-256 digest.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/calc_sha256.rs:14-34
 *   let input_v = self.input.eval(env, ctx)?;          // eval-child FIRST
 *   match input_v { Coll[Byte](coll_byte) => {
 *       ctx.add_per_item_jit_cost(80, 8, 64, n)?;      // Pattern B: AFTER eval-child
 *       Ok(sha256_hash(coll_byte).to_vec().into())
 *   }, _ => Err(UnexpectedValue(...)) }
 *
 * Cost-charging order: Pattern B (envelope AFTER eval-child). Composite
 * per-item cost: base=80, perChunk=8, chunkSize=64, n=input bytes length.
 *
 * Non-Coll[Byte] input: sigma-rust returns `EvalError::UnexpectedValue`. We
 * surface this as `'predef-input-not-byte-array'`. Wire-format invariants
 * (`CalcSha256::try_build` enforces `check_post_eval_tpe(SColl(SByte))`
 * at parse time) make this unreachable for parser-produced trees; defensive
 * against `ConstantPlaceholder` injection or hand-crafted MIR.
 *
 * Uses `@noble/hashes/sha2.js` `sha256` (project convention — see
 * `src/crypto/hashes.ts`). sha256 always emits 32 bytes; no dkLen needed.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import type { CalcSha256, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue, collByteToUint8Array } from './_byte-coll'

export function evalCalcSha256(
  e: CalcSha256,
  env: Env,
  ctx: EvalContext
): SValue {
  const input = evalExpr(e.input, env, ctx)
  const bytes = collByteToUint8Array(input, 'CalcSha256')
  // Pattern B: charge AFTER eval-child + AFTER type guard.
  ctx.addPerItemCost(80, 8, 64, bytes.length)
  const digest = sha256(bytes)
  return bytesToCollByteSValue(digest)
}
