/**
 * Pre-eval whole-tree validation — comparison/equality operand-type strictness
 * (JVM-align #2).
 *
 * The JVM deserializer rejects mismatched comparison/equality at deserialize via
 * `check2`: `equalityOp` runs `check2(SameType)`; `comparisonOp` runs
 * `check2(OnlyNumeric)` then `check2(SameType)` (SigmaBuilder.scala:679/689,
 * `ConstraintFailed` at :287). That kills the WHOLE tree before evaluation —
 * including never-evaluated branches. ergots' parser is deliberately permissive
 * (byte-roundtrip is load-bearing), so this pass enforces the same rejection at
 * the `dispatchTreeBody` chokepoint, run before any eval or cost charge, so a
 * rejected tree yields no value and zero JIT cost (matching the JVM's pre-eval
 * rejection). Without it ergots over-accepts spends the JVM rejects — an
 * adversary-reachable consensus-split vector (a box's proposition bytes are
 * attacker-controlled, and ergots parses + evaluates them when validating a spend).
 *
 * Scope: only `Relation` BinOps. Arith has no JVM `check2` (`arithOp:700` =
 * `applyUpcast` only); Bit/Logical are not in the constrained class. Pre-V3
 * numeric-mismatch is ALLOWED here — #1's eval-time coercion
 * (`eval/bin-op/{arith,relation}.ts`) handles it.
 *
 * Faithfulness is bounded by `exprTpe`: an operand whose static type is `SAny`
 * (unresolved MethodCall/PropertyCall returns — the load-bearing cascade) is NOT
 * rejected, to avoid false positives on valid trees
 * (`reference_sany_type_checks_skip_not_fail`). The #1 eval arms remain the
 * runtime fallback for such nodes when they are actually evaluated.
 *
 * Spec: docs/specs/2026-06-02-ergoscript-binop-sametype-strictness-design.md
 */
import type { Expr, SType, RelationOp } from '../mir/types'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEqualsModuloSAny } from '../mir/stype-helpers'
import { EvalError } from './eval-context'
import { childrenOf } from './_substitute-deserialize'

function isNumericTpe(t: SType): boolean {
  switch (t.tag) {
    case 'SByte':
    case 'SShort':
    case 'SInt':
    case 'SLong':
    case 'SBigInt':
    case 'SUnsignedBigInt': // v6 P2c — UBI is an SNumericType (JVM), so OnlyNumeric admits it
      return true
    default:
      return false
  }
}

/**
 * Walk `body` and throw on the first mismatched comparison/equality node.
 * `treeVersion` gates the pre-V3 numeric-mismatch allowance (#1 coerces those at
 * eval). Throws `EvalError` (`'bin-op-kind-mismatch'` for a SameType violation,
 * `'bin-op-not-numeric'` for an OnlyNumeric violation) without charging cost.
 */
export function validateBinOpTypes(body: Expr, treeVersion: number): void {
  walk(body, treeVersion)
}

function walk(e: Expr, treeVersion: number): void {
  if (e.tag === 'BinOp' && e.op.kind === 'Relation') {
    checkRelation(e.op.op, exprTpe(e.left), exprTpe(e.right), treeVersion)
  }
  for (const child of childrenOf(e)) {
    walk(child, treeVersion)
  }
}

function checkRelation(op: RelationOp, lt: SType, rt: SType, treeVersion: number): void {
  if (op === 'Eq' || op === 'NEq') {
    // equalityOp: check2(SameType) after the (version-gated) upcast.
    // sTypeEqualsModuloSAny treats an SAny operand as a wildcard → skip.
    if (sTypeEqualsModuloSAny(lt, rt)) return
    // Differing concrete types: allowed only when both numeric AND pre-V3,
    // where #1's eval-time coercion legitimately reconciles them.
    if (isNumericTpe(lt) && isNumericTpe(rt) && treeVersion < 3) return
    throw new EvalError(
      `BinOp.Relation.${op}: operands must have the same type — left '${lt.tag}', right '${rt.tag}'`,
      'bin-op-kind-mismatch',
    )
  }

  // Ordering Lt/Le/Gt/Ge — comparisonOp: check2(OnlyNumeric) then check2(SameType).
  // OnlyNumeric: a concretely-typed non-numeric operand fails regardless of the
  // other (an SAny operand's type is unknown → not rejected on this ground).
  if ((lt.tag !== 'SAny' && !isNumericTpe(lt)) || (rt.tag !== 'SAny' && !isNumericTpe(rt))) {
    throw new EvalError(
      `BinOp.Relation.${op}: ordering requires numeric operands — left '${lt.tag}', right '${rt.tag}'`,
      'bin-op-not-numeric',
    )
  }
  // SameType (each operand now numeric-or-SAny): same/SAny → ok; both concrete
  // numeric and differing → allowed only pre-V3 (#1 coerces), else reject.
  if (sTypeEqualsModuloSAny(lt, rt)) return
  if (treeVersion < 3) return
  throw new EvalError(
    `BinOp.Relation.${op}: operands must have the same type — left '${lt.tag}', right '${rt.tag}'`,
    'bin-op-kind-mismatch',
  )
}
