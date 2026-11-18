/**
 * Xor arm — pairwise byte XOR via truncating-zip.
 *
 * JVM `Xor.eval` (`data/shared/src/main/scala/sigma/ast/trees.scala:1001-1012`)
 * at 6.0.7:
 *   val lV = left.evalTo[Coll[Byte]](env)
 *   val rV = right.evalTo[Coll[Byte]](env)
 *   Xor.xorWithCosting(lV, rV)
 * `evalTo[Coll[Byte]]` is an unchecked JVM cast — any `Coll[_]` whose runtime
 * class is a Coll passes. `xorWithCosting(ls, rs)` (`:1021-1025`) runs
 * `Colls.xor(ls, rs)` (`core/shared/src/main/scala/sigma/data/
 * CollsOverArrays.scala:261-262`): `left.zip(right).map{(l, r) => (l^r).toByte}`.
 * `zip` on two array-shape colls builds a `PairOfCols` whose length is the
 * shorter of the two (`:183-203`); `map` iterates min(len) pairs, so items
 * past that length are never read. For the result, `PairOfCols.map[@specialized
 * V: RType](f)` at V=Byte returns `new CollOverArray(res, builder)` on an
 * `Array[Byte]` (`:317-324`), the Byte-specialised subclass of `CollOverArray`
 * (`:11`).
 *
 * The cost `xorWithCosting` charges is `addSeqCost(Xor.costKind,
 * math.min(ls.length, rs.length))` — the JVM uses the MIN; the sigma-rust
 * port uses the LEFT length, which ergots mirrors as its consensus oracle.
 *
 * Invariants (consensus-load-bearing):
 *   - Output length = min(left.length, right.length). NO length-mismatch
 *     error. Tail bytes of the longer operand are silently dropped.
 *   - Cost sized by LEFT operand's length, NOT min(left, right).
 *   - An operand that is a `Coll` of another item type passes when its length
 *     brings the min to 0: the zip-map never reads items of that side (SANTA
 *     `Coll.zip_unequal_sides_v6` `arr-Xor-right-lie-empty-CollInt-v0-a3#227`:
 *     `Xor(Coll[Byte](1,2), <empty Coll[Boolean]>)` answers `Coll[Byte]()`).
 *     Only a non-empty operand of another item type runs the per-item unbox
 *     that fails (`CollClassCast`).
 *
 * Non-Coll input: rejected at MIR-build time by `Xor::new`; the TS-side guard
 * stays defensive against `ConstantPlaceholder` injection or hand-crafted MIR.
 */
import type { SValue, Xor } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { byteColl } from './_coll'

export function evalXor(e: Xor, env: Env, ctx: EvalContext): SValue {
  // Pattern B: eval children FIRST, then guard, then charge.
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
  // Pattern B: charge cost AFTER eval-children + AFTER type-guard. Cost sized
  // by LEFT length — the consensus oracle.
  ctx.addPerItemCost(10, 2, 128, leftV.items.length)
  // `Colls.xor` is `left.zip(right).map{(l, r) => (l^r).toByte}`. `zip`
  // truncates to the shorter side, and `map` iterates min(len) pairs; items
  // past that length are never read, so an operand of another item type is
  // tolerated iff its length brings the min to 0.
  const outLen = Math.min(leftV.items.length, rightV.items.length)
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
