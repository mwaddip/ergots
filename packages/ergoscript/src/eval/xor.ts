/**
 * Xor arm — pairwise byte XOR via truncating-zip.
 *
 * JVM `Xor.eval` (`data/shared/src/main/scala/sigma/ast/trees.scala:
 * 1001-1012` at 6.0.7):
 *   val lV = left.evalTo[Coll[Byte]](env)
 *   val rV = right.evalTo[Coll[Byte]](env)
 *   Xor.xorWithCosting(lV, rV)
 * `evalTo[Coll[Byte]]` is an unchecked JVM cast — any `Coll[_]` whose
 * runtime class is a Coll passes. `xorWithCosting(ls, rs)` (`:1021-1025`)
 * charges `addSeqCost(Xor.costKind, math.min(ls.length, rs.length))` with
 * `costKind = PerItemCost(10, 2, 128)` (`:1015-1016`) and runs
 * `Colls.xor(ls, rs)` (`core/shared/src/main/scala/sigma/data/
 * CollsOverArrays.scala:261-262`): `left.zip(right).map{(l, r) => (l^r).
 * toByte}`. `zip` on two array-shape colls builds a `PairOfCols` whose
 * length is the shorter of the two (`:183-203`); `map` iterates min(len)
 * pairs, so items past that length are never read. The result is
 * `PairOfCols.map[@specialized V: RType](f)` at V=Byte, which writes
 * `new CollOverArray(res, builder)` on an `Array[Byte]` (`:317-324`), the
 * Byte-specialised subclass of `CollOverArray` (`:11`).
 *
 * Costs are charged BEFORE the body runs: `CErgoTreeEvaluator.addSeqCost`
 * (`interpreter/shared/src/main/scala/sigmastate/interpreter/
 * CErgoTreeEvaluator.scala:370-391`) calls `coster.add(cost)` and THEN the
 * block, so a refusal inside the zip-map leaves the cost paid.
 *
 * Invariants (consensus-load-bearing):
 *   - Output length = min(left.length, right.length). NO length-mismatch
 *     error. Tail bytes of the longer operand are silently dropped.
 *   - Cost sized by `min(left.length, right.length)`.
 *   - An operand that is a `Coll` of another item type passes when its
 *     length brings the min to 0: the zip-map never reads items of that
 *     side (SANTA `Coll.zip_unequal_sides_v6`
 *     `arr-Xor-right-lie-empty-CollInt-v0-a3#227`:
 *     `Xor(Coll[Byte](1,2), <empty Coll[Boolean]>)` answers `Coll[Byte]()`).
 *     Only a non-empty operand of another item type runs the per-item unbox
 *     that fails (`coll-class-cast`).
 *
 * A non-Coll input (a `Boolean`, a bare `Int` constant hand-planted in MIR)
 * is rejected at the arm's guard with `'predef-input-not-byte-array'`.
 */
import type { SValue, Xor } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { byteColl } from './_coll'

export function evalXor(e: Xor, env: Env, ctx: EvalContext): SValue {
  // Eval both operands, then guard, then charge the per-pair cost on the
  // shorter length, then iterate min(l,r) pairs with per-byte unbox.
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  if (leftV.kind !== 'Coll') {
    throw new EvalError(
      `Xor: expected Coll[Byte] left, got kind='${leftV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  if (rightV.kind !== 'Coll') {
    throw new EvalError(
      `Xor: expected Coll[Byte] right, got kind='${rightV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  // `addSeqCost(Xor.costKind, math.min(ls.length, rs.length))` in the JVM
  // (trees.scala:1021-1022); `costKind = PerItemCost(10, 2, 128)`.
  const outLen = Math.min(leftV.items.length, rightV.items.length)
  ctx.addPerItemCost(10, 2, 128, outLen)
  const out = new Uint8Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const lb = leftV.items[i]
    const rb = rightV.items[i]
    if (lb === undefined || rb === undefined || lb.kind !== 'Byte' || rb.kind !== 'Byte') {
      throw new EvalError(
        `Xor: zip-map iterates min(len) items which must be Byte; got left='${lb?.kind}' right='${rb?.kind}' at ${i}`,
        'coll-class-cast',
      )
    }
    out[i] = lb.value ^ rb.value
  }
  return byteColl(out, true)
}
