/**
 * The JVM's `Value.checkType(node, evalResult)` (`values.scala:251-254`) runs
 * `SType.isValueOfType(evalResult, node.tpe)` after evaluating a child at each
 * `checkType` site, and `Value.typeError`s when it returns false. `isValueOfType`
 * (`SType.scala:187-213`) has two kinds of outcome whose refusal ergots mirrors:
 *
 *   - **The type throws, whatever the value is.** `sys.error` fires on the arm
 *     for a non-pair `STuple` (`items.length != 2`, `:200-202`,
 *     "Unsupported tuple type"), a non-unary `SFunc` (`tDom.length != 1`,
 *     `:203-205`, "Unsupported function type"), and the `case _` arm
 *     (`:212`, "Unknown type"), which catches the JVM's `SAny` and `NoType`.
 *     The JVM's runtime represents only `Tuple2` and `Function1` and has no
 *     wildcard class, so a value of such a declared type is unrepresentable;
 *     a tree whose `checkType` site reads one rejects without looking at the
 *     value. `assertCheckedType(tpe)` mirrors this: `'unsupported-value-type'`.
 *
 *   - **The value's class is not the type's.** `isValueOfType` returns false,
 *     and `Value.checkType` passes the operand and its value to
 *     `Value.typeError`. For a pair type (`STuple` of two items) the class
 *     check is `x.isInstanceOf[Tuple2[_,_]]` (`:200-201`): a value that is not
 *     a pair refuses. `assertCheckedValue(tpe, value)` makes this check for
 *     the pair type only, after `assertCheckedType(tpe)`: `'checked-value-class'`.
 *
 *   The other class comparisons `isValueOfType` makes (an `SInt` against an
 *   `Int`, an `SColl` against a `Coll`, a `SBoolean` against a `Boolean`, …)
 *   are refusals of a mistyped default the JVM makes later and ergots does
 *   not close here (residual 7 of "The Deserialize substitution", in
 *   `facts/ergoscript-eval.md`).
 *
 * `SANY_JVM` and `NOTYPE_JVM` (`mir/types.ts`) are told by object identity:
 * ergots' own `SAny` (the fresh `{ tag: 'SAny' }` object the method typing
 * builds for a method ergots cannot type, residual 1 of
 * `facts/ergoscript-wire.md`) is refused by no rule here — runtime values
 * behind such a type stay concrete and pass every static check (memory
 * `reference_sany_type_checks_skip_not_fail`).
 *
 * TOP-LEVEL ONLY — this mirrors the JVM's single `isValueOfType` call per
 * site (it does NOT recurse into `STuple` items / `SColl` elem / `SOption`
 * elem). Nesting is covered because every value-flow seam that surfaces a
 * sub-value runs its own `checkType` call, and those sites each call this
 * helper.
 *
 * `readCheckedType(node, ctx)` is the type read each JVM `checkType` site
 * makes first (`val tpe = node.tpe`), before `isValueOfType` reads the type's
 * tag. The read is `exprTpe(node, v)`, at the evaluation's version; its
 * `ExprTpeError` propagates — a class-cast default that a `Deserialize`
 * substitution put in untyped is the case where this throws, even where the
 * value is fine (`facts/ergoscript-eval.md`, "The Deserialize substitution",
 * item 5).
 *
 * Source: JVM `SType.scala:187-213`, `values.scala:251-254`.
 */

import type { Expr, SType, SValue } from '../mir/types'
import { SANY_JVM, NOTYPE_JVM } from '../mir/types'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { exprTpe } from '../mir/expr-tpe'

/**
 * Throw `EvalError('unsupported-value-type')` if `isValueOfType` throws for
 * `tpe` whatever the value is (`SType.scala:187-213`):
 *   - a non-pair `STuple` (`items.length !== 2`, `:200-202`),
 *   - a non-unary `SFunc` (`args.length !== 1`, `:203-205`),
 *   - the JVM's `SAny` (`SANY_JVM`) or `NoType` (`NOTYPE_JVM`), told by
 *     identity, which the `case _` arm catches (`:212`).
 *
 * Otherwise a no-op. Non-recursive (top-level check only).
 */
export function assertCheckedType(tpe: SType): void {
  if (tpe === SANY_JVM || tpe === NOTYPE_JVM) {
    throw new EvalError(
      `isValueOfType has no value for the JVM's ${tpe === NOTYPE_JVM ? 'NoType' : 'SAny'} (SType.scala:212)`,
      'unsupported-value-type'
    )
  }
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

/**
 * The type-driven throws `assertCheckedType` makes (`'unsupported-value-type'`),
 * then, for a pair type (`STuple` of two items), the JVM's
 * `x.isInstanceOf[Tuple2[_,_]]` (`SType.scala:200-201`): a value of kind other
 * than `Tuple` of two items refuses as `EvalError('checked-value-class')`
 * (`values.scala:251-255`, which calls `Value.typeError`).
 *
 * The comparison for every other type is not made here (an `SInt` against an
 * `Int`, an `SColl` against a `Coll`, …): residual 7 of "The Deserialize
 * substitution" in `facts/ergoscript-eval.md`.
 */
export function assertCheckedValue(tpe: SType, value: SValue): void {
  assertCheckedType(tpe)
  if (tpe.tag === 'STuple' && tpe.items.length === 2) {
    if (value.kind !== 'Tuple' || value.items.length !== 2) {
      throw new EvalError(
        `checkType: a value of kind '${value.kind}' is not a pair at an STuple of two items (SType.scala:200-201)`,
        'checked-value-class'
      )
    }
  }
}

/**
 * The type read of the JVM's `Value.checkType(node, value)` (values.scala:251-254): `node.tpe`, at the evaluation's
 * version. Its `ExprTpeError` propagates. Call it where the JVM's `checkType` runs, right after `node` is evaluated.
 */
export function readCheckedType(node: Expr, ctx: EvalContext): SType {
  return exprTpe(node, ctx.treeVersion ?? 0)
}

/**
 * The JVM's `Value.checkType(node, value)` (`values.scala:251-255`) wired to
 * the pair: `readCheckedType(node, ctx)` first (propagating any `ExprTpeError`
 * of the type read), then `assertCheckedValue(tpe, value)`. Every
 * `checkType` site calls this right after it evaluates `node`.
 */
export function assertCheckedNode(node: Expr, value: SValue, ctx: EvalContext): void {
  const tpe = readCheckedType(node, ctx)
  assertCheckedValue(tpe, value)
}
