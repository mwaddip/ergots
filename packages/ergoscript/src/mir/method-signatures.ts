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
 * `resolveReturnTpe` returns a CLOSED `t_range` verbatim; a `t_range`
 * referencing type vars is resolved via the unification + substitution engine
 * (`mir/type-unify.ts`), with `SAny` as the cascade fallback when operands
 * cannot bind a var (see memory `reference_sany_type_checks_skip_not_fail`).
 *
 * Layering: this module lives in `mir/` (the IR layer) and imports only
 * `mir/types` + `mir/stype-helpers`. It does NOT depend on `eval/`, mirroring
 * sigma-rust's split (signatures in `ergotree-ir/types/*`, eval fns in
 * `ergotree-interpreter/eval/*`). The eval handler registry
 * (`eval/method-call.ts`) shares the `(typeId, methodId)` namespace; a signature
 * here must agree with its handler's runtime element type (the sync invariant —
 * see `facts/ergoscript-eval.md`).
 *
 * Source mapping (v5 entries: sigma-rust `external/sigma-rust` @ integration/ergots;
 * v6 entries: JVM `sigma-state`, the sole v6-canonical source):
 *   - `7:2`  SGroupElement.getEncoded    — sigma-rust `ergotree-ir/src/types/sgroup_elem.rs:41-50`
 *   - `7:6`  SGroupElement.expUnsigned   — JVM `sigma/ast/methods.scala:656-660`
 *   - `12:14` SColl.indices              — sigma-rust `ergotree-ir/src/types/scoll.rs:123-136`
 *   - `12:19` SColl.patch               — JVM `sigma/ast/methods.scala:1013-1015`
 *   - `99:19` SBox.getReg               — JVM `sigma/ast/methods.scala:1338-1347` (getRegMethodV6)
 *   - `101:12` SContext.getVarFromInput  — JVM `sigma/ast/methods.scala:1755-1765`
 *
 * Spec: docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md
 */

import type { SType, STypeVar } from './types'
import { hasTypeVar } from './stype-helpers'
import { applySubst, unifyTypeLists } from './type-unify'
import type { STypeSubst } from './type-unify'

/**
 * A method's static signature, mirroring sigma-rust `SMethodDesc.tpe` (an
 * `SFunc`). `tDom = [receiverType, ...argTypes]`; `tRange` is the return type,
 * which MAY reference type vars bound by `tDom` / `explicitTypeArgs`
 * (resolved by `resolveReturnTpe` via the substitution engine). `tpeParams`
 * lists the method's declared type params (sigma-rust `SFunc.tpe_params`);
 * omitted for monomorphic methods.
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
const SCOLL_IV: SType = { tag: 'SColl', elem: { tag: 'STypeVar', name: 'IV' } }
const SCOLL_BOOL: SType = { tag: 'SColl', elem: { tag: 'SBoolean' } }
const NUMERIC_STYPE: Record<number, SType> = {
  2: { tag: 'SByte' }, 3: { tag: 'SShort' }, 4: { tag: 'SInt' }, 5: { tag: 'SLong' },
  6: { tag: 'SBigInt' },
  9: { tag: 'SUnsignedBigInt' }, // v6 P2b — UBI inherits the numeric method signatures (tNum→UBI)
}
// TNUM_VAR: the STypeVar descriptor used in tpeParams (STypeVar = { name: string }).
// TNUM_TPE: the SType position form used in tDom/tRange (discriminated-union member).
const TNUM_VAR: STypeVar = { name: 'TNum' }
const TNUM_TPE: SType = { tag: 'STypeVar', name: 'TNum' }
function numericV6Signatures(): Array<[string, MethodSignature]> {
  const e: Array<[string, MethodSignature]> = []
  for (const id of Object.keys(NUMERIC_STYPE).map(Number)) {
    const recv = NUMERIC_STYPE[id]!
    e.push([key(id, 6), { tDom: [recv], tRange: SCOLL_BYTE }])
    e.push([key(id, 7), { tDom: [recv], tRange: SCOLL_BOOL }])
    e.push([key(id, 8), { tDom: [TNUM_TPE], tRange: TNUM_TPE, tpeParams: [TNUM_VAR] }])
    e.push([key(id, 9), { tDom: [TNUM_TPE, TNUM_TPE], tRange: TNUM_TPE, tpeParams: [TNUM_VAR] }])
    e.push([key(id, 10), { tDom: [TNUM_TPE, TNUM_TPE], tRange: TNUM_TPE, tpeParams: [TNUM_VAR] }])
    e.push([key(id, 11), { tDom: [TNUM_TPE, TNUM_TPE], tRange: TNUM_TPE, tpeParams: [TNUM_VAR] }])
    e.push([key(id, 12), { tDom: [TNUM_TPE, { tag: 'SInt' }], tRange: TNUM_TPE, tpeParams: [TNUM_VAR] }])
    e.push([key(id, 13), { tDom: [TNUM_TPE, { tag: 'SInt' }], tRange: TNUM_TPE, tpeParams: [TNUM_VAR] }])
  }
  return e
}

/**
 * Declarative catalog. Each entry transcribes sigma-rust's `SMethodDesc.tpe`
 * verbatim. Closed-`tRange` entries take `resolveReturnTpe`'s early-return; generic-output
 * entries (type-var `tRange`, e.g. `patch` 12:19) are resolved by the
 * substitution engine (`mir/type-unify.ts`). Grows by descriptor-addition.
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
  // SColl.patch — JVM methods.scala:1013-1015 — SFunc([Coll[IV], Int, Coll[IV], Int] → Coll[IV]).
  // First generic-OUTPUT method (type-var tRange): exercises the substitution
  // engine end-to-end. Handler at eval/method-call.ts (12:19) returns
  // { elem: obj.elem }, so the static Coll[IV→receiver.elem] matches runtime
  // (the dual-table sync invariant — see facts/ergoscript-eval.md).
  [
    key(12, 19),
    {
      tDom: [SCOLL_IV, { tag: 'SInt' }, SCOLL_IV, { tag: 'SInt' }],
      tRange: SCOLL_IV,
      tpeParams: [{ name: 'IV' }],
    },
  ],
  // SBigInt.toUnsigned — JVM methods.scala:546 — SFunc([SBigInt] → SUnsignedBigInt). v6 P2c bridge; closed tRange.
  [key(6, 14), { tDom: [{ tag: 'SBigInt' }], tRange: { tag: 'SUnsignedBigInt' } }],
  // SUnsignedBigInt.toSigned — JVM methods.scala:609 — SFunc([SUnsignedBigInt] → SBigInt). v6 P2c bridge; closed tRange.
  [key(9, 19), { tDom: [{ tag: 'SUnsignedBigInt' }], tRange: { tag: 'SBigInt' } }],
  // SUnsignedBigInt.mod — JVM methods.scala:603 — SFunc([UBI, UBI] → UBI). v6 P2d-1; closed tRange.
  [key(9, 18), { tDom: [{ tag: 'SUnsignedBigInt' }, { tag: 'SUnsignedBigInt' }], tRange: { tag: 'SUnsignedBigInt' } }],
  // SUnsignedBigInt.plusMod — JVM methods.scala:585 — SFunc([UBI, UBI, UBI] → UBI). v6 P2d-1; closed tRange.
  [key(9, 15), { tDom: [{ tag: 'SUnsignedBigInt' }, { tag: 'SUnsignedBigInt' }, { tag: 'SUnsignedBigInt' }], tRange: { tag: 'SUnsignedBigInt' } }],
  // SUnsignedBigInt.subtractMod — JVM methods.scala:591 — SFunc([UBI, UBI, UBI] → UBI). v6 P2d-1; closed tRange.
  [key(9, 16), { tDom: [{ tag: 'SUnsignedBigInt' }, { tag: 'SUnsignedBigInt' }, { tag: 'SUnsignedBigInt' }], tRange: { tag: 'SUnsignedBigInt' } }],
  // SUnsignedBigInt.multiplyMod — JVM methods.scala:597 — SFunc([UBI, UBI, UBI] → UBI). v6 P2d-1; closed tRange.
  [key(9, 17), { tDom: [{ tag: 'SUnsignedBigInt' }, { tag: 'SUnsignedBigInt' }, { tag: 'SUnsignedBigInt' }], tRange: { tag: 'SUnsignedBigInt' } }],
  // SUnsignedBigInt.modInverse — JVM methods.scala:576 — SFunc([UBI, UBI] → UBI). v6 P2d-2; closed tRange.
  [key(9, 14), { tDom: [{ tag: 'SUnsignedBigInt' }, { tag: 'SUnsignedBigInt' }], tRange: { tag: 'SUnsignedBigInt' } }],
  // SBigInt.toUnsignedMod — JVM methods.scala:553 — SFunc([SBigInt, UBI] → UBI). v6 P2d-1; closed tRange.
  [key(6, 15), { tDom: [{ tag: 'SBigInt' }, { tag: 'SUnsignedBigInt' }], tRange: { tag: 'SUnsignedBigInt' } }],
  // SColl.reverse — JVM methods.scala:1126 — SFunc([Coll[IV]] → Coll[IV]). v6 P3; generic tRange.
  [key(12, 30), { tDom: [SCOLL_IV], tRange: SCOLL_IV, tpeParams: [{ name: 'IV' }] }],
  // SColl.startsWith — JVM methods.scala:1145 — SFunc([Coll[IV], Coll[IV]] → Boolean). v6 P3; closed tRange.
  [key(12, 31), { tDom: [SCOLL_IV, SCOLL_IV], tRange: { tag: 'SBoolean' }, tpeParams: [{ name: 'IV' }] }],
  // SColl.endsWith — JVM methods.scala:1165 — SFunc([Coll[IV], Coll[IV]] → Boolean). v6 P3; closed tRange.
  [key(12, 32), { tDom: [SCOLL_IV, SCOLL_IV], tRange: { tag: 'SBoolean' }, tpeParams: [{ name: 'IV' }] }],
  // SColl.get — JVM methods.scala:1183 — SFunc([Coll[IV], Int] → Option[IV]). v6 P3; generic tRange.
  [key(12, 33), { tDom: [SCOLL_IV, { tag: 'SInt' }], tRange: { tag: 'SOption', elem: { tag: 'STypeVar', name: 'IV' } }, tpeParams: [{ name: 'IV' }] }],
  // SGlobal.some — JVM methods.scala:1986-1992 — SFunc([SGlobal, T] → Option[T]); T resolved from
  // call-site arg type OR explicit type arg. v6 P4.
  [key(106, 9), {
    tDom: [{ tag: 'SGlobal' }, { tag: 'STypeVar', name: 'T' }],
    tRange: { tag: 'SOption', elem: { tag: 'STypeVar', name: 'T' } },
    tpeParams: [{ name: 'T' }],
  }],
  // SGlobal.none — JVM methods.scala:1994-1999 — SFunc([SGlobal] → Option[T]); T only from
  // explicit type arg (no arg to unify against). v6 P4.
  [key(106, 10), {
    tDom: [{ tag: 'SGlobal' }],
    tRange: { tag: 'SOption', elem: { tag: 'STypeVar', name: 'T' } },
    tpeParams: [{ name: 'T' }],
  }],
  // SGlobal.serialize — SFunc([SGlobal, T] → Coll[Byte]). JVM methods.scala:1957.
  // tRange is CLOSED (always Coll[Byte] regardless of T) — the resolver returns it verbatim.
  [key(106, 3), {
    tDom: [{ tag: 'SGlobal' }, { tag: 'STypeVar', name: 'T' }],
    tRange: { tag: 'SColl', elem: { tag: 'SByte' } },
    tpeParams: [{ name: 'T' }],
  }],
  // SGlobal.deserializeTo — SFunc([SGlobal, Coll[Byte]] → T). JVM methods.scala:1906.
  // tRange is generic — resolved from the explicit type arg T at the call site.
  [key(106, 4), {
    tDom: [{ tag: 'SGlobal' }, { tag: 'SColl', elem: { tag: 'SByte' } }],
    tRange: { tag: 'STypeVar', name: 'T' },
    tpeParams: [{ name: 'T' }],
  }],
  // SGlobal.fromBigEndianBytes — SFunc([SGlobal, Coll[Byte]] → T). JVM methods.scala:1925.
  // tRange generic — resolved from the explicit type arg T at the call site (same shape as 106:4).
  [key(106, 5), {
    tDom: [{ tag: 'SGlobal' }, { tag: 'SColl', elem: { tag: 'SByte' } }],
    tRange: { tag: 'STypeVar', name: 'T' },
    tpeParams: [{ name: 'T' }],
  }],
  // SGlobal.encodeNbits — SFunc([SGlobal, SBigInt] → SLong). JVM methods.scala:1939.
  // Non-generic; closed tRange (SLong). v6 P5b-2.
  [key(106, 6), {
    tDom: [{ tag: 'SGlobal' }, { tag: 'SBigInt' }],
    tRange: { tag: 'SLong' },
  }],
  // SGlobal.decodeNbits — SFunc([SGlobal, SLong] → SBigInt). JVM methods.scala:1944.
  // Non-generic; closed tRange (SBigInt). v6 P5b-2.
  [key(106, 7), {
    tDom: [{ tag: 'SGlobal' }, { tag: 'SLong' }],
    tRange: { tag: 'SBigInt' },
  }],
  // SGlobal.powHit — JVM methods.scala:1884 — SFunc([SGlobal, SInt, Coll[Byte],
  // Coll[Byte], Coll[Byte], SInt] → SUnsignedBigInt). Non-generic; closed tRange.
  // v6 P5c. Load-bearing for exprTpe: map(powHit) must type as Coll[UnsignedBigInt]
  // (sigma-rust #877 mis-typed it SBoolean). Handler at eval/method-call.ts (106:8).
  [key(106, 8), {
    tDom: [{ tag: 'SGlobal' }, { tag: 'SInt' }, SCOLL_BYTE, SCOLL_BYTE, SCOLL_BYTE, { tag: 'SInt' }],
    tRange: { tag: 'SUnsignedBigInt' },
  }],
  // SBox.getReg — v6 P7a — JVM methods.scala:1338-1347 (getRegMethodV6):
  // SFunc([SBox, SInt] → SOption(tT)), tpeParams [T]; T arrives as a wire
  // explicit type arg (the id-7 sibling getRegV5 has NO explicit args and
  // stays unregistered — it always eval-throws; spec §2).
  [
    key(99, 19),
    {
      tDom: [{ tag: 'SBox' }, { tag: 'SInt' }],
      tRange: { tag: 'SOption', elem: { tag: 'STypeVar', name: 'T' } },
      tpeParams: [{ name: 'T' }],
    },
  ],
  // SContext.getVarFromInput — v6 P7a — JVM methods.scala:1755-1765:
  // SFunc([SContext, SShort, SByte] → SOption(tT)), tpeParams [T].
  [
    key(101, 12),
    {
      tDom: [{ tag: 'SContext' }, { tag: 'SShort' }, { tag: 'SByte' }],
      tRange: { tag: 'SOption', elem: { tag: 'STypeVar', name: 'T' } },
      tpeParams: [{ name: 'T' }],
    },
  ],
  // SGroupElement.expUnsigned — v6 P7a — JVM methods.scala:656-660:
  // SFunc([SGroupElement, SUnsignedBigInt] → SGroupElement) — closed tRange.
  [
    key(7, 6),
    {
      tDom: [{ tag: 'SGroupElement' }, { tag: 'SUnsignedBigInt' }],
      tRange: { tag: 'SGroupElement' },
    },
  ],
  // SAvlTree.insertOrUpdate — v6, audit V6-SIGNATURE-01 — JVM methods.scala
  // (SAvlTreeMethods.insertOrUpdate): SFunc([SAvlTree, Coll[(Coll[Byte],
  // Coll[Byte])], Coll[Byte]] → Option[AvlTree]) — closed tRange. Handler
  // eval/savltree.ts (100:16) returns Option[AvlTree] (some/noneAvlTree, elem
  // SAvlTree) — the dual-table sync invariant (facts/ergoscript-eval.md).
  [
    key(100, 16),
    {
      tDom: [
        { tag: 'SAvlTree' },
        { tag: 'SColl', elem: { tag: 'STuple', items: [SCOLL_BYTE, SCOLL_BYTE] } },
        SCOLL_BYTE,
      ],
      tRange: { tag: 'SOption', elem: { tag: 'SAvlTree' } },
    },
  ],
  // SHeader.checkPow — v6, audit V6-SIGNATURE-01 — JVM methods.scala
  // (SHeaderMethods.checkPow): SFunc([SHeader] → SBoolean) — closed tRange.
  // Handler eval/sheader.ts (104:16) returns Boolean. checkPow serializes as a
  // PropertyCall (0xdb) on the wire; both exprTpe arms consult this catalog.
  [
    key(104, 16),
    {
      tDom: [{ tag: 'SHeader' }],
      tRange: { tag: 'SBoolean' },
    },
  ],
  ...numericV6Signatures(),
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
 * the call-site types. `receiver` / `argTpes` / `explicitTypeArgs` are the
 * substitution inputs (`receiver` unifies `tDom[0]`, `argTpes` unify `tDom[1..]`,
 * `explicitTypeArgs` supply method type params) — ≡ JVM `getSpecializedMethodFor`.
 *
 * Closed `tRange` (no type var) is returned verbatim. A type-var `tRange` is
 * resolved by applying `explicitTypeArgs` then unifying the signature's `tDom`
 * against `[receiver, ...argTpes]` (≡ JVM `MethodCall.tpe()`); an operand that
 * cannot bind a var leaves a residual, which falls back to `{ tag: 'SAny' }`
 * (the cascade). See `mir/type-unify.ts` + the v6 P0 spec.
 */
export function resolveReturnTpe(
  sig: MethodSignature,
  receiver: SType,
  argTpes: readonly SType[],
  explicitTypeArgs: Record<string, SType>
): SType {
  // Closed tRange: substitution is identity — return verbatim (the A3 path,
  // preserved EXACTLY for getEncoded 7:2, indices 12:14, and any future
  // closed-tRange method). Skipping unification makes the invariance structural.
  if (!hasTypeVar(sig.tRange)) return sig.tRange

  // Generic tRange. Mirror JVM getSpecializedMethodFor (MethodCallSerializer.scala:84,96):
  //   (1) apply explicit type args to tDom + tRange (withConcreteTypes), THEN
  //   (2) unify the substituted tDom against [receiver, ...argTpes] (specializeFor).
  const explicitSubst: STypeSubst = new Map(Object.entries(explicitTypeArgs))
  const tDom = sig.tDom.map((t) => applySubst(t, explicitSubst))
  const tRange = applySubst(sig.tRange, explicitSubst)

  const unified = unifyTypeLists(tDom, [receiver, ...argTpes])
  const resolved = unified === null ? tRange : applySubst(tRange, unified)

  // Safety net (no JVM analog — JVM never sees unresolved types): any residual
  // type var means the operands couldn't bind it (e.g. an SAny-cascade receiver)
  // → fall back to SAny (the load-bearing cascade placeholder).
  return hasTypeVar(resolved) ? { tag: 'SAny' } : resolved
}
