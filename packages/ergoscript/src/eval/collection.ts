/**
 * Collection arm — handles both `kind: 'Exprs'` and `kind: 'BoolConstants'`.
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/collection.rs:22`
 *
 *     ctx.add_jit_cost(20)?;          // ConcreteCollection = Fixed(20)
 *     match self {
 *         Collection::BoolConstants(bools) => bools.clone().into(),
 *         Collection::Exprs { elem_tpe, items } => {
 *             let items_v = items.iter().map(|i| i.eval(env, ctx)).collect();
 *             // ... wrap in Value::Coll(CollKind::WrappedColl { ... }) or
 *             // Value::Coll(CollKind::NativeColl(NativeColl::CollByte(_)))
 *         }
 *     }
 *
 * Cost: ConcreteCollection = Fixed(20) (envelope) + sum of recursive item
 * costs. The envelope is charged BEFORE evaluating items (mirrors
 * sigma-rust); if a child item throws, the envelope cost has already been
 * added — same as the reference behavior.
 *
 * BoolConstants charges only the envelope: bools live inline in the variant
 * payload, no per-item recursion happens.
 *
 * Element-kind validation: for `Exprs`, every evaluated item is checked
 * against `elemTpe`. A mismatch is a static-type bug that the parser should
 * have caught — we surface it via `EvalError 'collection-elem-kind-mismatch'`
 * rather than silently building a malformed `Coll` SValue. sigma-rust
 * doesn't perform this check at eval time (it relies on the type checker
 * upstream), but we add it as a fail-fast guard for the verifier path.
 */

import type { Collection, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { exprTpe } from '../mir/expr-tpe'
import { assertValueTypeSupported } from './_check-type'

export function evalCollection(e: Collection, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(20)
  if (e.kind === 'BoolConstants') {
    // Each boolean constant is a BooleanConstant = FixedCost(5) on the JVM
    // (Constant.costKind, sigma `values.scala`). The `Exprs` arm below already
    // pays this via each Const eval; the packed BoolConstants form converts bits
    // directly without per-element eval, so charge 5*n here to match the JVM and
    // the Exprs arm (total = 20 + 5n). sigma-rust collection.rs, commit ee4c3c3f.
    ctx.addCost(5 * e.items.length)
    return {
      kind: 'Coll',
      elem: { tag: 'SBoolean' },
      items: e.items.map((b) => ({ kind: 'Boolean', value: b }) as SValue),
    }
  }
  // kind === 'Exprs'
  // ConcreteCollection.eval runs Value.checkType on each item (values.scala);
  // checkType is against the item's STATIC declared type, so a non-pair STuple
  // / non-unary SFunc declared type rejects (the JVM cannot represent such a
  // value). See eval/_check-type.ts.
  const items = e.items.map((item) => {
    const v = evalExpr(item, env, ctx)
    assertValueTypeSupported(exprTpe(item))
    return v
  })
  for (let i = 0; i < items.length; i++) {
    if (!kindMatchesType(items[i]!, e.elemTpe)) {
      throw new EvalError(
        `Collection.items[${i}] kind '${items[i]!.kind}' inconsistent with elemTpe '${e.elemTpe.tag}'`,
        'collection-elem-kind-mismatch'
      )
    }
  }
  return { kind: 'Coll', elem: e.elemTpe, items }
}

/**
 * Check that an evaluated item's value-kind matches the declared element
 * type. Only primitives are validated — composite types (`SColl`, `STuple`,
 * `SOption`, `SFunc`, etc.) and chain-state types (`SBox`, `SAvlTree`,
 * `SSigmaProp`, `SGroupElement`) are deferred to the future arm tasks
 * that introduce them. Returning `true` for unsupported tags is a
 * permissive default — it lets us land the primitive-coverage now without
 * blocking on phases 2c-2g.
 */
function kindMatchesType(v: SValue, t: SType): boolean {
  switch (t.tag) {
    case 'SBoolean':
      return v.kind === 'Boolean'
    case 'SByte':
      return v.kind === 'Byte'
    case 'SShort':
      return v.kind === 'Short'
    case 'SInt':
      return v.kind === 'Int'
    case 'SLong':
      return v.kind === 'Long'
    case 'SBigInt':
      return v.kind === 'BigInt'
    case 'SUnit':
      return v.kind === 'Unit'
    default:
      // Composite or chain-state types — defer to later phases.
      return true
  }
}
