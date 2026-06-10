/**
 * LastBlockUtxoRootHash — parse + serialize (F5 batch 4, Ask-13).
 *
 * Wire format (JVM `sigma.ast.LastBlockUtxoRootHash`, a payload-less case
 * object; opcode LAST_BLOCK_UTXO_ROOT_HASH = newOpCode(54) = 0xa6,
 * OpCodes.scala:95):
 *
 *   [OP_LAST_BLOCK_UTXO_ROOT_HASH opcode = 0xa6]
 *
 * Nullary: the opcode byte carries the entire encoding. The JVM registers
 * it through `CaseObjectSerialization(LastBlockUtxoRootHash,
 * LastBlockUtxoRootHash)` (ValueSerializer.scala:87) whose `serialize`
 * writes nothing and whose `parse` returns the case object.
 *
 * sigma-rust divergence (verified against the `ergo-node-integration`
 * branch): sigma-rust has NO MIR variant and NO `serialization/expr.rs`
 * dispatch arm for this opcode — it errors on these bytes, and its
 * serializer never emits them (the property is only reachable there via
 * PropertyCall on SContext, method id 9). The JVM ACCEPTS the bare
 * op-form, so the consensus-faithful behavior is to parse + evaluate it.
 * The op-form charges the op's own FixedCost(JitCost(15))
 * (values.scala:1495) vs the PropertyCall form's observable 20 — cost
 * differs by wire shape.
 *
 * Cross-reference (JVM canonical):
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/ast/values.scala:1490-1501
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/serialization/OpCodes.scala:95
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/serialization/CaseObjectSerialization.scala
 */

import type { LastBlockUtxoRootHash } from '../../mir/types'

/**
 * Build a `LastBlockUtxoRootHash` AST node. The dispatcher consumed the
 * OP_LAST_BLOCK_UTXO_ROOT_HASH byte already; the variant has no payload,
 * so this is a pure constructor.
 */
export function parseLastBlockUtxoRootHash(): LastBlockUtxoRootHash {
  return { tag: 'LastBlockUtxoRootHash' }
}
