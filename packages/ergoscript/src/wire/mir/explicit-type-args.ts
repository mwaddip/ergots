/**
 * Shared registry of methods that carry explicit type arguments on the wire.
 *
 * Both the MethodCall opcode (0xdc, `wire/mir/method-call.ts`) and the
 * PropertyCall opcode (0xdb, `wire/mir/property-call.ts`) encode zero or more
 * inline `SType` values after the method body, one per `STypeVar` the resolved
 * SMethod declares in its `explicit_type_args` list. The count is implicit in
 * the resolved SMethod — there is NO length prefix on the wire — so the
 * reader/writer must know, for a given `(typeId, methodId)`, exactly which
 * type-var names (and thus how many `SType` bytes) follow.
 *
 * This registry is purely a wire-layer concern: it disambiguates how many
 * bytes to consume, not ErgoScript semantics. It previously lived as a private
 * const in `method-call.ts`; it was lifted here when `SGlobal.none` (106:10)
 * — invoked via the PropertyCall opcode (0 args) yet carrying an explicit `T`
 * — made the PropertyCall path need the same lookup. When the full SMethod
 * registry lands (with the interpreter's method dispatch table), this table
 * moves there.
 *
 * Methods currently known to declare explicit_type_args (all `vec![STypeVar::t()]`,
 * so always exactly one "T"):
 *   - SBox (typeId=99):      getReg             (methodId=19) -- v6 P7a; JVM getRegMethodV6.
 *     ⚠️ The JVM ALSO registers id 7 ("getRegV5", all versions) with NO explicit
 *     type args — sigma-rust's sbox.rs puts getReg-with-type-args at id 7, which
 *     DIVERGES from the JVM wire shape (same class as the checkPow 0xdc/0xdb
 *     divergence). The JVM is canonical: id 7 carries no SType tail.
 *   - SContext (typeId=101): getVarFromInput    (methodId=12)
 *   - SGlobal (typeId=106):  deserialize        (methodId=4)
 *   - SGlobal (typeId=106):  fromBigEndianBytes (methodId=5)
 *   - SGlobal (typeId=106):  some               (methodId=9)  -- v6 P4 (MethodCall opcode, 1 arg)
 *   - SGlobal (typeId=106):  none               (methodId=10) -- v6 P4 (PropertyCall opcode, 0 args)
 *
 * For any (typeId, methodId) not in the registry we assume zero explicit type
 * args (the conservative default — matches sigma-rust for well-typed corpora).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sbox.rs (GET_REG_METHOD_DESC) -- DIVERGENT source for SBox entry; see ⚠️ above
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scontext.rs (GET_VAR_FROM_INPUT_METHOD_DESC)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sglobal.rs (DESERIALIZE / FROM_BIGENDIAN_BYTES / SOME / NONE method descs)
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/serialization/PropertyCallSerializer.scala (the JVM oracle for the PropertyCall tail)
 */

// TypeCode constants for type companions that declare these methods. Mirrors
// the `TypeCode` values in sigma-rust `serialization/types.rs`.
const TYPE_CODE_SBOX = 99
const TYPE_CODE_SCONTEXT = 101
const TYPE_CODE_SGLOBAL = 106

// (typeId, methodId) → ordered list of STypeVar names declaring this method's
// explicit_type_args. Empty list (or absence) = no inline STypes follow the
// method body. See module header for the full provenance of each entry.
const EXPLICIT_TYPE_ARG_NAMES: Record<number, Record<number, readonly string[]>> = {
  [TYPE_CODE_SBOX]: {
    19: ['T'], // getReg[T] — v6 P7a; JVM getRegMethodV6 (methods.scala:1338-1347)
  },
  [TYPE_CODE_SCONTEXT]: {
    12: ['T'], // getVarFromInput[T]
  },
  [TYPE_CODE_SGLOBAL]: {
    4: ['T'],  // deserialize[T]
    5: ['T'],  // fromBigEndianBytes[T]
    9: ['T'],  // some[T]  (v6 P4)
    10: ['T'], // none[T]  (v6 P4)
  },
}

/**
 * Returns the ordered list of STypeVar names whose SType bytes follow the
 * method body on the wire for `(typeId, methodId)`. Empty for any pair not in
 * the registry (the conservative default — see module header).
 */
export function explicitTypeArgNames(typeId: number, methodId: number): readonly string[] {
  return EXPLICIT_TYPE_ARG_NAMES[typeId]?.[methodId] ?? []
}
