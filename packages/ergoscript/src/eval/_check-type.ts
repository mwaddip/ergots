/**
 * checkType class (F5 batch 3) — `assertValueTypeSupported`.
 *
 * JVM `Value.checkType(node, evalResult)` (values.scala:251-254) runs
 * `SType.isValueOfType(evalResult, node.tpe)` at the value-flow seams after
 * evaluating children. For a DECLARED type that is a non-pair `STuple` or a
 * non-unary `SFunc`, `isValueOfType` (SType.scala:200-205) `sys.error`s:
 *
 *     case t: STuple =>
 *       if (t.items.length == 2) x.isInstanceOf[Tuple2[_,_]]
 *       else sys.error(s"Unsupported tuple type $t")
 *     case tF: SFunc =>
 *       if (tF.tDom.length == 1) x.isInstanceOf[Function1[_,_]]
 *       else sys.error(s"Unsupported function type $tF")
 *
 * The JVM cannot represent values of these declared types (its runtime has
 * only Tuple2 and Function1), so it errors regardless of the runtime value.
 * Such declared types ARE wire-constructible — an arity-N tuple constant type
 * parses fine, and a multi-arg SFunc type annotation is representable — but a
 * value of that type is unrepresentable on the JVM, so it rejects at the seam.
 *
 * `assertValueTypeSupported(tpe)` is the ergots mirror. It is called from each
 * eval arm at a value-flow seam (Tuple items, ConstantPlaceholder,
 * ConcreteCollection items, BlockValue valdef-rhs + result, ValUse) — hooking
 * inside the arms (not a whole-tree pre-eval pass) gives JVM-faithful laziness
 * for free: a non-pair-tuple-typed const in a DEAD branch is never evaluated,
 * so its seam never runs.
 *
 * TOP-LEVEL ONLY — this mirrors the JVM's single `isValueOfType` call per seam
 * (it does NOT recurse into STuple items / SColl elem / SOption elem). Nesting
 * is covered because every value-flow seam that surfaces a sub-value runs its
 * own checkType call (e.g. a pair Tuple's items each get a Tuple-item seam
 * call). A non-pair tuple NESTED inside a pair tuple's item type is therefore
 * still caught — by the item seam, not by recursion here.
 *
 * Residual: the FuncValue/Apply param+body SFunc arms (the P6 closure path) are
 * deliberately NOT hooked — there is no JVM-blessed SFunc witness, and the
 * closure path is its own tracked F5 item. The helper still rejects a
 * non-unary SFunc VALUE that flows through any of the hooked DATA seams.
 *
 * Source: JVM SType.scala:200-205, values.scala:251-254.
 */

import type { SType } from '../mir/types'
import { EvalError } from './eval-context'

/**
 * Throw `EvalError('unsupported-value-type', …)` iff `tpe` is a declared type
 * the JVM cannot represent a value of:
 *   - a non-pair `STuple` (`items.length !== 2`), OR
 *   - a non-unary `SFunc` (`args.length !== 1`).
 *
 * Otherwise a no-op. Non-recursive (top-level check only); see module doc.
 */
export function assertValueTypeSupported(tpe: SType): void {
  if (tpe.tag === 'STuple' && tpe.items.length !== 2) {
    throw new EvalError(
      `Unsupported tuple type: arity ${tpe.items.length} (the JVM represents only pairs; SType.scala:200-202)`,
      'unsupported-value-type'
    )
  }
  if (tpe.tag === 'SFunc' && tpe.args.length !== 1) {
    throw new EvalError(
      `Unsupported function type: arity ${tpe.args.length} (the JVM represents only Function1; SType.scala:203-205)`,
      'unsupported-value-type'
    )
  }
}
