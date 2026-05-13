/**
 * Type-system MIR nodes for ErgoScript / ErgoTree.
 *
 * `SType` is a discriminated union over the closed set of ErgoScript types.
 * Every {@link Expr} node carries one; every {@link SValue} (added in Task 6)
 * is typed by one (recoverable from `kind` for primitives, explicit for
 * composites such as `Coll` and `Option`).
 *
 * Variant set mirrors sigma-rust's `ergotree-ir/src/types/stype.rs` (less
 * `SUnsignedBigInt`, which is a v6-only type that the reference verifier
 * rejects via `check_v6_type`). See
 * `docs/specs/2026-05-13-ergoscript-interpreter-design.md` for the
 * discriminated-union rationale.
 */

/** Type variable for generic signatures (e.g. `"T"`, `"IV"`, `"OV"`). */
export interface STypeVar {
  name: string
}

/**
 * Closed set of ErgoScript types. Primitive variants carry only `tag`;
 * composite variants (`SColl`, `STuple`, `SOption`, `SFunc`, `STypeVar`)
 * carry recursive payload.
 *
 * Acyclic by construction: no variant can transitively contain a reference
 * back to itself (the union is built from below).
 */
export type SType =
  | { tag: 'SBoolean' }
  | { tag: 'SByte' }
  | { tag: 'SShort' }
  | { tag: 'SInt' }
  | { tag: 'SLong' }
  | { tag: 'SBigInt' }
  | { tag: 'SGroupElement' }
  | { tag: 'SSigmaProp' }
  | { tag: 'SBox' }
  | { tag: 'SAvlTree' }
  | { tag: 'SUnit' }
  | { tag: 'SAny' }
  | { tag: 'SHeader' }
  | { tag: 'SPreHeader' }
  | { tag: 'SContext' }
  | { tag: 'SGlobal' }
  | { tag: 'SString' }
  | { tag: 'SColl'; elem: SType }
  | { tag: 'STuple'; items: SType[] }
  | { tag: 'SOption'; elem: SType }
  | { tag: 'SFunc'; args: SType[]; result: SType; tpeParams: STypeVar[] }
  | { tag: 'STypeVar'; name: string }
