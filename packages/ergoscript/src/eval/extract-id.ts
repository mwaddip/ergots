/**
 * ExtractId arm — Box → Coll[Byte] of 32-byte blake2b-256 hash of the
 * box's canonical bytes.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_id.rs:10-28
 *   ctx.add_jit_cost(12)?;                          // BEFORE eval-child
 *   match input { Value::CBox(b) => b.box_id().into(), ... }
 *
 * Sigma-rust caches `box_id` at construction via `calc_box_id()`
 * (`chain/ergo_box.rs:149-153`). We compute lazily — no observable
 * divergence in output bytes; just doesn't pre-pay the hash on every
 * box parse. See phase 2f spec Decision #4.
 *
 * `calc_box_id` (sigma-rust):
 *   bytes = box.sigma_serialize_bytes()
 *   hash = blake2b256(bytes)
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 *
 * First eval-time blake2b call in the package — uses existing
 * `@noble/hashes/blake2.js` dep from phase 2a per the
 * [[reference-noble-hashes-blake2]] memory.
 */

import type { ExtractId, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { serializeBoxBytes } from '../wire/ergo-box-bytes'
import { blake2b } from '@noble/hashes/blake2.js'

// Cost source: sigma-rust eval/extract_id.rs:16 — ctx.add_jit_cost(12)?
// Pattern A (envelope BEFORE eval-child).
const EXTRACT_ID_COST = 12

export function evalExtractId(e: ExtractId, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(EXTRACT_ID_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractId: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  const boxBytes = serializeBoxBytes(input.value)
  const hash = blake2b(boxBytes, { dkLen: 32 })
  return bytesToCollByteSValue(hash)
}
