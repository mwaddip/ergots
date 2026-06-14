/**
 * Pre-eval whole-tree rejection of v3+-only type constructs (SUnsignedBigInt,
 * SFunc) in pre-V3 trees — the version gate for v6 types. Mirrors
 * validate-bin-op-types.ts: a zero-cost reject before any eval, keyed on the
 * authoritative ctx.treeVersion. Walks BOTH tree.constantTypes[] (segregated
 * constants the JVM deserializes eagerly — incl. dead/empty ones) AND the body
 * (every wire-serialized type annotation, NOT computed exprTpe). See P2a spec
 * §4.1/§4.2.
 *
 * The JVM gates type code 9 (`SUnsignedBigInt`) and 112 (`SFunc`) at *type
 * deserialization* under `isV3OrLaterErgoTreeVersion` (TypeSerializer.scala);
 * a pre-V3 tree carrying either is rejected before the body ever evaluates.
 * ergots' parser is permissive (accepts code 9 at any version — byte-roundtrip
 * is load-bearing, and `treeVersion` is not threaded through the parse
 * recursion so a parse-time gate would mis-gate nested types). This pass
 * reproduces the JVM's *accept/reject* outcome at the `dispatchTreeBody`
 * chokepoint, where the authoritative `ctx.treeVersion` is known.
 *
 * Two surfaces, because the JVM deserializes both eagerly:
 *  1. `tree.constantTypes[]` — every segregated constant's declared SType,
 *     deep-checked. Mandatory: a dead UBI-typed segregated constant (no
 *     ConstPlaceholder references it), or an empty `Coll[UBI]` (no UBI *value*
 *     is decoded), never appears as a body annotation yet is still rejected by
 *     the JVM. `childrenOf` only walks Expr children, so this is a distinct
 *     walk over the constants block.
 *  2. The body — every node's wire-serialized SType annotation (the `.tpe` /
 *     `elemTpe` / `varTpe` / `args[].tpe` / `explicitTypeArgs` fields that came
 *     from `parseSType`). NOT computed `exprTpe`: a valid v5 `map`/`fold`
 *     lambda's *computed* type is `SFunc`, but it serializes no SFunc type code
 *     — checking computed types would false-reject every valid v5 tree with a
 *     lambda (a fork the wrong way). `ValUse.tpe` is therefore *excluded* from
 *     the enumerator: it is recovered from the enclosing ValDef's *computed*
 *     RHS type (`wire/mir/val-use.ts`), not serialized — a higher-order
 *     `val f = <lambda>; … f …` would give `ValUse.tpe = SFunc` on a valid v5
 *     tree, and checking it would false-reject. (`ConstPlaceholder.tpe` is
 *     kept: it mirrors `constantTypes[id]` exactly, which can never be UBI/
 *     SFunc on a valid v5 tree, so it cannot false-reject; redundant with the
 *     constantTypes[] walk, but harmless and defensive.)
 *
 * Spec: docs/specs/2026-06-03-ergoscript-v6-p2a-sunsignedbigint-type-core-design.md §4.1/§4.2
 */
import type { ErgoTree, Expr, SType } from '../mir/types'
import { EvalError } from './eval-context'
import { childrenOf } from './_substitute-deserialize'

/** True if `t` is, or structurally contains, a v3+-only type construct. */
function containsV6Type(t: SType): boolean {
  switch (t.tag) {
    case 'SUnsignedBigInt':
    case 'SFunc':
      return true
    case 'SColl':
    case 'SOption':
      return containsV6Type(t.elem)
    case 'STuple':
      return t.items.some(containsV6Type)
    default:
      // SFunc is matched above; its args/result never need a deeper walk here
      // (a serialized `SFunc` already trips the gate at its own node). All
      // remaining tags are primitive / leaf and carry no nested SType.
      return false
  }
}

/**
 * Every wire-serialized SType annotation carried by a single Expr node — the
 * `.tpe` / `elemTpe` / `varTpe` / `args[].tpe` / `explicitTypeArgs` fields
 * that `parseSType` populated. Verified against the mir handlers under
 * `wire/mir/` that call `parseSType`/`parseSTypeWithFirstByte`:
 *   const, get-var, collection (Exprs only), upcast, downcast,
 *   extract-register-as, deserialize-context, deserialize-register,
 *   func-value, method-call, property-call. Plus `ConstPlaceholder.tpe` (mirrors
 *   constantTypes[id]; defensive). `ValUse.tpe` is deliberately omitted (see
 *   module doc — computed, not serialized).
 */
function annotationsOf(e: Expr): SType[] {
  switch (e.tag) {
    case 'Const':
      return [e.tpe]
    case 'ConstPlaceholder':
      return [e.tpe]
    case 'Collection':
      // Only the `Exprs` arm carries a serialized elemTpe; `BoolConstants` has none.
      return e.kind === 'Exprs' ? [e.elemTpe] : []
    case 'Upcast':
      return [e.tpe]
    case 'Downcast':
      return [e.tpe]
    case 'GetVar':
      return [e.varTpe]
    case 'ExtractRegisterAs':
      return [e.elemTpe]
    case 'DeserializeContext':
      return [e.tpe]
    case 'DeserializeRegister':
      return [e.tpe]
    case 'FuncValue':
      return e.args.map((a) => a.tpe)
    case 'MethodCall':
      return Object.values(e.explicitTypeArgs)
    case 'PropertyCall':
      // Global.none[T] (106:10) is the first PropertyCall with a wire type tail;
      // it carries explicitTypeArgs exactly like MethodCall. childrenOf walks
      // only the receiver `obj`, so without this case the explicit type tail is
      // invisible to the pre-V3 gate (V6-PROPERTY-TYPEARG-GATE-01).
      return Object.values(e.explicitTypeArgs)
    default:
      return []
  }
}

/**
 * Reject (under `treeVersion < 3`) any v3+-only type construct in the
 * segregated constant block or the body. No-op for `treeVersion >= 3`.
 * Charges no cost: a violating tree throws `EvalError 'v6-type-in-pre-v3-tree'`
 * before any eval, matching the JVM's deserialize-time rejection (zero cost).
 *
 * `body` is the Expr to walk — `dispatchTreeBody` passes the post-substitution
 * `rewrittenBody` on the deserialize branch (so attacker-controlled
 * Deserialize* sub-trees parsed into it are covered) and the raw `tree.body`
 * otherwise.
 */
export function validateV6Types(tree: ErgoTree, body: Expr, treeVersion: number): void {
  if (treeVersion >= 3) return

  // 1. Segregated constants: the JVM deserializes all of them eagerly, before
  //    the body. A dead / empty-Coll UBI constant lives only here.
  for (const ct of tree.constantTypes) {
    if (containsV6Type(ct)) throw v6Reject('segregated constant')
  }

  // 2. The body: every wire-serialized type annotation, whole-tree.
  walk(body)

  function walk(e: Expr): void {
    for (const t of annotationsOf(e)) {
      if (containsV6Type(t)) throw v6Reject(`${e.tag} annotation`)
    }
    for (const child of childrenOf(e)) walk(child)
  }
}

function v6Reject(where: string): EvalError {
  return new EvalError(
    `v6-only type construct (SUnsignedBigInt/SFunc) in a pre-V3 tree at ${where}`,
    'v6-type-in-pre-v3-tree',
  )
}
