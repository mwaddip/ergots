/**
 * The JVM's node construction (sigma-state 6.0.6; spec
 * docs/specs/2026-09-30-jvm-node-construction-design.md §3; facts/ergoscript-wire.md, "Node
 * construction"). Building a node reads the types of some of its children, casts them and checks
 * them, and a failure throws right then.
 *
 * Two sites:
 * - `'parse'`: the builder's and the serializer's checks that the JVM makes once all of a node's
 *   bytes are read (`DeserializationSigmaBuilder`, SigmaBuilder.scala:750-765; the node serializers),
 *   then the constructor's. `parseExpr` runs it when an opcode's arm returns (wire/parse.ts).
 * - `'rebuild'`: Kiama's `dup`, which rebuilds a changed node through its first constructor by
 *   reflection and bypasses the builder (core/.../sigma/kiama/rewriting/Rewriter.scala:236-320,
 *   446-471): the constructor's checks only.
 *
 * Every child type read goes through `exprTpe`, so a throwing read (a `Filter` over a non-collection,
 * say) propagates its own `ExprTpeError`, the JVM's `ClassCastException` from that read. Reads and
 * checks run in the JVM's order. None of these throws is a `ValidationException`, so none degrades a
 * sized tree.
 *
 * ergots' own `SAny` (residual 1) passes every numeric test and every type equality here.
 */

import type { Expr, SType } from '../mir/types'
import { NOTYPE_JVM } from '../mir/types'
import { exprTpe, recordCallType } from '../mir/expr-tpe'
import { isJvmNumeric, isOwnSAny, jvmTypeEquals } from '../mir/jvm-types'
import { methodSignature } from '../mir/method-signatures'
import { ExprParseError } from './errors'

export type BuildSite = 'parse' | 'rebuild'

/**
 * `SNumericType`, as the `Upcast`/`Downcast` require (`isInstanceOf[SNumericType]`) and check2's
 * `OnlyNumeric2` test it (SigmaBuilder.scala:775-783). `NOTYPE_JVM` fails; ergots' own SAny passes
 * (residual 1).
 */
function numeric(t: SType): boolean {
  return isJvmNumeric(t) || isOwnSAny(t)
}

/** `isNumTypeOrNoType` (core/.../sigma/ast/package.scala:139): numeric, or the JVM's NoType. */
function numOrNoType(t: SType): boolean {
  return numeric(t) || t === NOTYPE_JVM
}

/**
 * The JVM's checks for building `e` at `site`, in a tree of version `v`. Throws `ExprParseError` for a
 * failed check, or the `ExprTpeError` of a child type read that throws. A node the JVM builds with no
 * type read passes untouched. A `MethodCall` or `PropertyCall` built at parse records its type
 * (`recordCallType`).
 */
export function checkBuild(e: Expr, site: BuildSite, v: number): void {
  switch (e.tag) {
    case 'Upcast':
    case 'Downcast': {
      // NumericCastSerializer.scala:20-24: the input, then the target type and its asNumType, a real
      // cast (core/.../sigma/ast/package.scala:141), before the constructor.
      if (site === 'parse' && !isJvmNumeric(e.tpe)) {
        throw new ExprParseError(
          `${e.tag}: target type ${e.tpe.tag} is not numeric (asNumType, a ClassCastException)`,
          'numeric-cast-target-not-numeric'
        )
      }
      // trees.scala:398, 431: require(input.tpe.isInstanceOf[SNumericType]); NoType fails it.
      const it = exprTpe(e.input, v)
      if (!numeric(it)) {
        throw new ExprParseError(`${e.tag}: input type ${it.tag} is not numeric`, 'numeric-cast-input-not-numeric')
      }
      return
    }
    case 'Negation':
    case 'BitInversion': {
      // trees.scala:882, 900: require(input.tpe.isNumTypeOrNoType).
      const it = exprTpe(e.input, v)
      if (!numOrNoType(it)) {
        throw new ExprParseError(
          `${e.tag}: input type ${it.tag} is neither numeric nor NoType`,
          e.tag === 'Negation' ? 'negation-input-not-numeric' : 'bit-inversion-input-not-numeric'
        )
      }
      return
    }
    case 'BinOp':
      switch (e.op.kind) {
        case 'Bit': {
          // trees.scala:913: require(left.tpe.isNumTypeOrNoType && right.tpe.isNumTypeOrNoType,
          // s"invalid types left:${left.tpe}, right:${right.tpe}"). The by-name message reads right.tpe
          // when the left fails, so the right is always read, and its class cast wins.
          const lt = exprTpe(e.left, v)
          const rt = exprTpe(e.right, v)
          if (!numOrNoType(lt) || !numOrNoType(rt)) {
            throw new ExprParseError(
              `${e.op.op}: operand types ${lt.tag}, ${rt.tag} are not both numeric or NoType`,
              'bit-op-operand-not-numeric'
            )
          }
          return
        }
        case 'Arith':
          // trees.scala:708: val opType = SFunc(Array(left.tpe, right.tpe), tpe) reads both operands.
          // Before v3 the builder's applyUpcast reads them first (SigmaBuilder.scala:674-683, 707-712).
          exprTpe(e.left, v)
          exprTpe(e.right, v)
          return
        case 'Relation': {
          // check2 is the builder's (SigmaBuilder.scala:286-295, 686-704), so Kiama's dup never runs it.
          // It reads left.tpe, then right.tpe, then applies its constraint.
          if (site !== 'parse') return
          const lt = exprTpe(e.left, v)
          const rt = exprTpe(e.right, v)
          const op = e.op.op
          // comparisonOp: check2(OnlyNumeric) on the operands as parsed, before applyUpcast (:696-704).
          if ((op === 'Lt' || op === 'Le' || op === 'Gt' || op === 'Ge') && (!numeric(lt) || !numeric(rt))) {
            throw new ExprParseError(
              `${op}: operand types ${lt.tag}, ${rt.tag} are not both numeric (check2 OnlyNumeric)`,
              'relation-operand-not-numeric'
            )
          }
          // Before v3, applyUpcast widens two different numeric types to one, so SameType passes
          // (:674-683; a no-op from v3, :757-763).
          if (v < 3 && isJvmNumeric(lt) && isJvmNumeric(rt)) return
          // check2(SameType): t1 == t2 (:786-788). An unknown ('unknown') passes (residual 1).
          if (jvmTypeEquals(lt, rt) === false) {
            throw new ExprParseError(
              `${op}: operand types ${lt.tag}, ${rt.tag} differ (check2 SameType)`,
              'relation-operand-type-mismatch'
            )
          }
          return
        }
        case 'Logical':
          // BinOr, BinAnd, BinXor: built with no type read (SigmaBuilder.scala:354-365).
          return
      }
      return
    case 'If':
      // Quadruple.opType = SFunc(Array(first.tpe, second.tpe, third.tpe), tpe), a val over all three
      // children (trees.scala:1313; If binds them at :1348-1354).
      exprTpe(e.condition, v)
      exprTpe(e.trueBranch, v)
      exprTpe(e.falseBranch, v)
      return
    case 'TreeLookup':
      // Quadruple.opType, as for If (trees.scala:1313; TreeLookup binds tree, key, proof at :1322-1329).
      exprTpe(e.tree, v)
      exprTpe(e.key, v)
      exprTpe(e.proof, v)
      return
    case 'Map':
    case 'Append':
    case 'Slice':
    case 'ByIndex':
    case 'SelectField':
    case 'OptionGet':
    case 'OptionGetOrElse':
      // Their val tpe or val opType casts the input's (for Map, the mapper's) type as the node is
      // built (transformers.scala:38, 62, 89, 254, 294-295, 600-601, 625-626): the node's own type.
      exprTpe(e, v)
      return
    case 'OptionIsDefined':
    case 'SigmaPropIsProven':
    case 'SigmaPropBytes':
      // val opType = SFunc(input.tpe, ...) (transformers.scala:656, 324, 336): a read, no cast.
      exprTpe(e.input, v)
      return
    case 'MethodCall':
    case 'PropertyCall': {
      // The serializer's reads (MethodCallSerializer.scala:77-97, PropertyCallSerializer.scala:30-52)
      // come after SMethod.fromIds accepts the pair. A pair the JVM does not know at the tree's version
      // never reaches this site: the parse arm's lookup throws its soft failure first (rule 1010 or
      // 1016, wire/jvm-method-table.ts). For a pair the JVM knows and ergots does not catalogue,
      // nothing is read (residual 1).
      if (site !== 'parse') return
      if (methodSignature(e.typeId, e.methodId) === undefined) {
        recordCallType(e, { tag: 'SAny' })
        return
      }
      if (e.tag === 'MethodCall') {
        // getSpecializedMethodFor: each argument's type, then the object's (in specializeFor).
        for (const a of e.args) exprTpe(a, v)
        exprTpe(e.obj, v)
      } else if (Object.keys(e.explicitTypeArgs).length === 0) {
        // specializeFor(obj.tpe, ...) without explicit type arguments; with them, obj is not read.
        exprTpe(e.obj, v)
      }
      // MethodCall.tpe is a val over the method specialized here (values.scala:1355), and Kiama's dup
      // passes that method to a rebuilt node, so the call's type is fixed now.
      recordCallType(e, exprTpe(e, v))
      return
    }
    default:
      return
  }
}
