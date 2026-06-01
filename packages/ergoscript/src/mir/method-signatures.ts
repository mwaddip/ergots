/**
 * Static method/property-call return-type resolver — phase A3 (2026-06-01).
 *
 * A declarative catalog of method SIGNATURES keyed by `(typeId, methodId)`,
 * mirroring sigma-rust's `SMethodDesc.tpe` (an `SFunc` with `t_dom`/`t_range`,
 * type vars allowed). Consulted by `mir/expr-tpe.ts` for `MethodCall` /
 * `PropertyCall` nodes to recover their static return type — the value the
 * `SColl.flatMap` / `SOption.map` handlers need to type an empty/None result,
 * and that the val-def type store records at parse time.
 *
 * THIS PHASE populates only methods whose `t_range` is CLOSED (no type var):
 * `resolveReturnTpe` returns such a `t_range` verbatim. A `t_range` that
 * references a type var falls back to `SAny` (the load-bearing cascade
 * placeholder — see memory `reference_sany_type_checks_skip_not_fail`); the
 * type-variable substitution engine is deferred until the first generic-OUTPUT
 * method is registered, so we don't ship unexercised substitution machinery.
 *
 * Layering: this module lives in `mir/` (the IR layer) and imports only
 * `mir/types` + `mir/stype-helpers`. It does NOT depend on `eval/`, mirroring
 * sigma-rust's split (signatures in `ergotree-ir/types/*`, eval fns in
 * `ergotree-interpreter/eval/*`). The eval handler registry
 * (`eval/method-call.ts`) shares the `(typeId, methodId)` namespace; a signature
 * here must agree with its handler's runtime element type (the sync invariant —
 * see `facts/ergoscript-eval.md`).
 *
 * Source mapping (pinned `external/sigma-rust`, branch integration/ergots):
 *   - `7:2`  SGroupElement.getEncoded — `ergotree-ir/src/types/sgroup_elem.rs:41-50`
 *   - `12:14` SColl.indices          — `ergotree-ir/src/types/scoll.rs:123-136`
 *
 * Spec: docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md
 */

import type { SType, STypeVar } from './types'
import { hasTypeVar } from './stype-helpers'

/**
 * A method's static signature, mirroring sigma-rust `SMethodDesc.tpe` (an
 * `SFunc`). `tDom = [receiverType, ...argTypes]`; `tRange` is the return type,
 * which MAY reference type vars bound by `tDom` / `explicitTypeArgs`
 * (substitution is deferred this phase — see module doc). `tpeParams` lists the
 * method's declared type params (sigma-rust `SFunc.tpe_params`); omitted for
 * monomorphic methods.
 */
export interface MethodSignature {
  readonly tDom: readonly SType[]
  readonly tRange: SType
  readonly tpeParams?: readonly STypeVar[]
}

function key(typeId: number, methodId: number): string {
  return `${typeId}:${methodId}`
}

const SCOLL_BYTE: SType = { tag: 'SColl', elem: { tag: 'SByte' } }
const SCOLL_INT: SType = { tag: 'SColl', elem: { tag: 'SInt' } }

/**
 * Declarative catalog. Each entry transcribes sigma-rust's `SMethodDesc.tpe`
 * verbatim. Both current entries have a CLOSED `tRange` (no type var), so
 * `resolveReturnTpe` returns `tRange` as-is. Grows by descriptor-addition.
 */
const METHOD_SIGNATURES: ReadonlyMap<string, MethodSignature> = new Map<string, MethodSignature>([
  // SGroupElement.getEncoded — sgroup_elem.rs:41-50 — SFunc([SGroupElement] → Coll[Byte]).
  [key(7, 2), { tDom: [{ tag: 'SGroupElement' }], tRange: SCOLL_BYTE }],
  // SColl.indices — scoll.rs:123-136 — SFunc([Coll[T]] → Coll[Int]); tRange closed (no T).
  [
    key(12, 14),
    {
      tDom: [{ tag: 'SColl', elem: { tag: 'STypeVar', name: 't' } }],
      tRange: SCOLL_INT,
      tpeParams: [{ name: 't' }],
    },
  ],
])

/** Look up a method's declared signature, or `undefined` if unregistered. */
export function methodSignature(
  typeId: number,
  methodId: number
): MethodSignature | undefined {
  return METHOD_SIGNATURES.get(key(typeId, methodId))
}

/**
 * Resolve a registered method's concrete return type from its signature plus
 * the call-site types. `receiver` / `argTpes` / `explicitTypeArgs` are exactly
 * sigma-rust's substitution inputs (`receiver` unifies `tDom[0]`, `argTpes`
 * unify `tDom[1..]`, `explicitTypeArgs` supply method type params).
 *
 * THIS PHASE: returns `tRange` verbatim when it is CLOSED (no type var); a
 * `tRange` referencing a type var returns `{ tag: 'SAny' }` (substitution
 * deferred — same cascade fallback as an unregistered method). The args are
 * accepted now so the signature is stable when the substitution branch lands.
 */
export function resolveReturnTpe(
  sig: MethodSignature,
  _receiver: SType,
  _argTpes: readonly SType[],
  _explicitTypeArgs: Record<string, SType>
): SType {
  return hasTypeVar(sig.tRange) ? { tag: 'SAny' } : sig.tRange
}
