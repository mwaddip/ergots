/**
 * Shared lambda-invocation helper: the v6 P6 type-var-apply reject.
 *
 * The JVM (sigma-state 6.0.3, canonical for v6) rejects at eval when a lambda
 * whose argument type is — or structurally contains — an unresolved `STypeVar`
 * is APPLIED. Binding the arg requires the arg's runtime RType, and
 * `stypeToRType(STypeVar)` throws `RuntimeException: Unknown type T`. ergots is
 * dynamically typed, so without this guard it would silently evaluate such an
 * application (an over-accept fork).
 *
 * The reject is keyed on the ARG TYPE being a type var — NOT on the body
 * reading the arg, NOT on the enclosing FunDef merely having `tpeArgs`:
 *   - `{val id[T]={(x:T)=>x};   id(7)}` → rejects (arg typed T, applied).
 *   - `{val id[T]={(x:T)=>5};   id(7)}` → rejects too (body ignores the arg).
 *   - `{val id[T]={(x:T)=>x+x}; id(7)}` → rejects too.
 *   - `{val id[T]={(x:T)=>x};   5     }` → ACCEPTS (bound, never applied → 5).
 *   - `{val id[T]={(x:Int)=>x}; id(7)}` → ACCEPTS (arg typed Int, not a var → 7).
 *
 * So the guard fires ONLY at apply/invocation (every lambda call site:
 * `apply.ts` + the 7 lambda HOF arms), BEFORE binding the arg — never at
 * FuncValue construction or at the FunDef/ValDef bind. SANTA-pinned vs
 * sigma-state 6.0.3; `HOF_FunDef_type_var_body.json`.
 */

import type { SType } from '../mir/types'
import { hasTypeVar } from '../mir/stype-helpers'
import { EvalError } from './eval-context'

/** Compact human render of an SType, surfacing the type-var name(s). */
function renderType(t: SType): string {
  switch (t.tag) {
    case 'STypeVar':
      return t.name
    case 'SColl':
      return `Coll[${renderType(t.elem)}]`
    case 'SOption':
      return `Option[${renderType(t.elem)}]`
    case 'STuple':
      return `(${t.items.map(renderType).join(', ')})`
    case 'SFunc':
      return `(${t.args.map(renderType).join(', ')}) => ${renderType(t.result)}`
    default:
      return t.tag
  }
}

/**
 * Assert that a lambda argument type is fully resolved (no `STypeVar`) before
 * binding the arg. Throws `'apply-unresolved-type-var'` if it is — or
 * structurally contains — an unresolved type variable.
 *
 * Call at EVERY lambda-invocation site immediately before binding arg `i`
 * (`closure.argTpes[i]`). No-op for the common case (concrete arg types), so
 * normal / inline lambdas are unaffected.
 *
 * @throws EvalError `'apply-unresolved-type-var'`
 */
export function assertArgTypeResolved(argTpe: SType): void {
  if (hasTypeVar(argTpe)) {
    throw new EvalError(
      `cannot apply lambda: argument type ${renderType(argTpe)} is an unresolved type variable`,
      'apply-unresolved-type-var',
    )
  }
}
