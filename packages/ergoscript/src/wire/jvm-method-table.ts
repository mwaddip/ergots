/**
 * The JVM's method lookup at parse, `SMethod.fromIds` (sigma-state 6.0.6,
 * data/shared/src/main/scala/sigma/ast/SMethod.scala:344-349), which `MethodCallSerializer.parse`
 * (:56) and `PropertyCallSerializer.parse` (:34) make on a call's (typeId, methodId) pair, in two steps:
 * 1. `CheckTypeWithMethods(typeId, MethodsContainer.contains(typeId))`: rule 1010 when the typeId has no
 *    methods container (core/shared/src/main/scala/sigma/validation/ValidationRules.scala:149-163);
 * 2. `MethodsContainer(typeId).methodById(methodId)`: rule 1016 (1011 before 6.0's activation, the same
 *    check) when the container has no method of that id (data/shared/src/main/scala/sigma/ast/
 *    methods.scala:128-136; org/ergoplatform/validation/ValidationRules.scala:105-136).
 *
 * Both steps read the table of the tree's version class, `isV3OrLaterErgoTreeVersion` (tree version 3 or
 * later, core/.../sigma/VersionContext.scala:29): the containers (methods.scala:175-189) and each
 * container's methods (methods.scala:79-111). Both failures are `ValidationException`s, so a sized tree
 * degrades on them (wire/ergo-tree.ts, the degrade set).
 *
 * The two tables below are the JVM's own: a local sigma-state 6.0.6 probe called `fromIds` for every
 * (typeId, methodId) under `withVersions(3, v)`. The dump is test/fixtures/conformance/jvm-method-table.json,
 * and a test asserts that these tables equal it. Tree versions 0, 1 and 2 have one table. Two facts in the
 * dump are easy to miss in the source:
 * - below v3 the numeric containers (typeIds 2-6) find no method by id, since their v5 method copies keep
 *   the generic numeric container as `objType` (methods.scala:237-241) and the lookup map groups methods by
 *   `objType` (:95-99), so every id there is rule 1016, as for typeIds 1, 96, 97, 98 and 102 at every
 *   version;
 * - typeId 9 (UnsignedBigInt) has a container only from v3, so below v3 it is rule 1010.
 *
 * Ids are ergots' MIR ids, the unsigned bytes the parser read. The JVM reads signed bytes and knows no
 * negative id, so an id of 128 or more is never known.
 */

import { ExprParseError } from './errors'

/** A lookup's outcome: found, or the code of the JVM rule that fails it. */
export type MethodLookup = 'ok' | 'method-type-no-methods' | 'method-unknown'

/** typeId → the method ids `fromIds` accepts, for tree versions 0-2. */
const PRE_V3: ReadonlyMap<number, readonly number[]> = new Map<number, readonly number[]>([
  [1, []], // SBoolean
  [2, []], // SByte: the v5 numeric methods are not found by id
  [3, []], // SShort
  [4, []], // SInt
  [5, []], // SLong
  [6, []], // SBigInt
  [7, [2, 3, 4, 5]], // SGroupElement: getEncoded, exp, multiply, negate
  [8, [1, 2]], // SSigmaProp: propBytes, isProven
  [12, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 19, 20, 21, 26, 29]], // SCollection
  [36, [2, 3, 4, 7, 8]], // SOption: isDefined, get, getOrElse, map, filter
  [96, []], // STuple
  [97, []], // SAny
  [98, []], // SUnit
  [99, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]], // SBox: value .. R9
  [100, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]], // SAvlTree: digest .. updateDigest
  [101, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]], // SContext: dataInputs .. getVar
  [102, []], // SString
  [104, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]], // SHeader: id .. votes
  [105, [1, 2, 3, 4, 5, 6, 7]], // SPreHeader: version .. votes
  [106, [1, 2]], // SGlobal: groupGenerator, xor
])

/** typeId → the method ids `fromIds` accepts, for tree version 3 and later. */
const V3: ReadonlyMap<number, readonly number[]> = new Map<number, readonly number[]>([
  [1, []], // SBoolean
  [2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]], // SByte: toByte .. shiftRight
  [3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]], // SShort
  [4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]], // SInt
  [5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]], // SLong
  [6, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]], // SBigInt: .. toUnsigned, toUnsignedMod
  [7, [2, 3, 4, 5, 6]], // SGroupElement: .. expUnsigned
  [8, [1, 2]], // SSigmaProp
  [9, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]], // SUnsignedBigInt: toByte .. toSigned
  [12, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 19, 20, 21, 26, 29, 30, 31, 32, 33]], // SCollection: .. reverse, startsWith, endsWith, get
  [36, [2, 3, 4, 7, 8]], // SOption
  [96, []], // STuple
  [97, []], // SAny
  [98, []], // SUnit
  [99, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]], // SBox: .. getReg
  [100, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]], // SAvlTree: .. insertOrUpdate
  [101, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]], // SContext: .. getVarFromInput
  [102, []], // SString
  [104, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]], // SHeader: .. checkPow
  [105, [1, 2, 3, 4, 5, 6, 7]], // SPreHeader
  [106, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], // SGlobal: .. serialize, deserializeTo, fromBigEndianBytes, encodeNbits, decodeNbits, powHit, some, none
])

/** The table `fromIds` reads at `treeVersion`: typeId → the method ids it accepts. */
export function jvmMethodTable(treeVersion: number): ReadonlyMap<number, readonly number[]> {
  return treeVersion >= 3 ? V3 : PRE_V3
}

/**
 * `SMethod.fromIds(typeId, methodId)` at `treeVersion`: `'method-type-no-methods'` (rule 1010) when the
 * typeId has no methods container, else `'method-unknown'` (rule 1016) when the container lacks the id,
 * else `'ok'`. The container is checked first, as `fromIds` does (SMethod.scala:345-347).
 */
export function jvmMethodLookup(typeId: number, methodId: number, treeVersion: number): MethodLookup {
  const ids = jvmMethodTable(treeVersion).get(typeId)
  if (ids === undefined) return 'method-type-no-methods'
  return ids.includes(methodId) ? 'ok' : 'method-unknown'
}

/**
 * The lookup as a parse arm makes it: throws `ExprParseError` with the failing rule's code,
 * `'method-type-no-methods'` (rule 1010) or `'method-unknown'` (rule 1016). Both codes are in the degrade
 * set, as the JVM's `ValidationException`s are.
 */
export function checkJvmMethod(node: 'MethodCall' | 'PropertyCall', typeId: number, methodId: number, treeVersion: number): void {
  const lookup = jvmMethodLookup(typeId, methodId, treeVersion)
  if (lookup === 'ok') return
  const why = lookup === 'method-type-no-methods'
    ? `type ${typeId} has no methods (rule 1010, CheckTypeWithMethods)`
    : `type ${typeId} has no method ${methodId} (rule 1016, CheckAndGetMethodV6)`
  throw new ExprParseError(`${node} (typeId=${typeId}, methodId=${methodId}): ${why} at tree version ${treeVersion}`, lookup)
}
