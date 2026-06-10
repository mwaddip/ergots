/**
 * LastBlockUtxoRootHash arm — the bare dedicated-opcode form (0xa6) of the
 * CONTEXT.LastBlockUtxoRootHash property (F5 batch 4, Ask-13).
 *
 * JVM ref (canonical — sigma-rust has no arm for this node):
 *   values.scala:1490-1501 — `case object LastBlockUtxoRootHash extends
 *   NotReadyValueAvlTree with ValueCompanion`:
 *     costKind = FixedCost(JitCost(15))            // values.scala:1495
 *     eval     = addCost(this.costKind); E.context.LastBlockUtxoRootHash
 *
 * Cost-charging order: BEFORE the field check (Pattern A; leaf arm — no
 * child eval), mirroring the JVM's `addCost` first and the sibling
 * GlobalVars leaf arms.
 *
 * Value path: identical to the PropertyCall form's 101:9 handler
 * (method-call.ts) — reads the INDEPENDENT `ctx.lastBlockUtxoRootHash`
 * field (the F5 batch 2 EvalOpts field; JVM models the last-block UTXO
 * root as its own ErgoLikeContext field, decoupled from headers). Absent ⇒
 * 'context-field-missing'. Only the COST differs between the two wire
 * shapes: this op-form charges the op's own 15; the PropertyCall form
 * observably totals 20 (4 dispatcher + 1 Context obj arm + 15 handler).
 */

import type { LastBlockUtxoRootHash, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

// JVM LastBlockUtxoRootHash.costKind — FixedCost(JitCost(15)), values.scala:1495.
const LAST_BLOCK_UTXO_ROOT_HASH_COST = 15

export function evalLastBlockUtxoRootHash(
  _e: LastBlockUtxoRootHash,
  _env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(LAST_BLOCK_UTXO_ROOT_HASH_COST)
  if (ctx.lastBlockUtxoRootHash === undefined) {
    throw new EvalError(
      'LastBlockUtxoRootHash: ctx.lastBlockUtxoRootHash is undefined',
      'context-field-missing'
    )
  }
  return { kind: 'AvlTree', value: ctx.lastBlockUtxoRootHash }
}
