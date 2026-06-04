/**
 * SGlobal.deserializeTo (MethodCall, 106:4) — v6 P5a eval handler.
 *
 * JVM source: sigma/ast/methods.scala:1906-1955 — `PerItemCost(100, 32, 32)`
 * on input byte-count (`deserializeCostKind`); V3-gated; delegates to
 * `DataSerializer.deserialize(tpe, reader)` (data-value path, NOT ErgoTree body).
 *
 * Cost is charged BEFORE parsing, even on parse failure (matches JVM
 * `addSeqCost` call at line 1951 preceding `deserializeTo(ctx)` at 1953).
 *
 * Faithfulness pins:
 *   - Trailing bytes are intentionally NOT checked (JVM does not check
 *     `r.isExhausted()` after deserialize — `CSigmaDslBuilder.scala:277-282`).
 *   - Type nesting > MaxTreeDepth(110) rejects — mirrors JVM `r.level`
 *     check in `CoreDataSerializer.deserialize`. The JVM level is 0-based:
 *     level 110 is the deepest allowed call (= type depth 111 in our 1-based
 *     `typeNestingDepth`). Types with depth > 111 throw. Check:
 *     `typeNestingDepth(T) > MAX_DEPTH_ALLOWED` where `MAX_DEPTH_ALLOWED = 111`.
 */

import { ByteReader } from '@ergots/scorex'
import { parseSValue } from '../wire/parse-svalue'
import { collByteToUint8Array } from './_byte-coll'
import { EvalError, type EvalContext } from './eval-context'
import type { SType, SValue } from '../mir/types'

/**
 * JVM `SigmaConstants.MaxTreeDepth = 110`. This is the maximum 0-based
 * recursion `level` the JVM allows in `CoreDataSerializer.deserialize`.
 * The maximum 1-based type nesting depth that succeeds is `MAX_TREE_DEPTH + 1
 * = 111` (level 0..110 = 111 recursive calls allowed).
 *
 * `typeNestingDepth` is 1-based (scalar = 1, SColl[scalar] = 2, …).
 * Throw condition: depth > 111, i.e. the JVM would need level 111 (> 110).
 */
const MAX_TREE_DEPTH = 110
const MAX_DEPTH_ALLOWED = MAX_TREE_DEPTH + 1 // 111

/**
 * Nesting depth of a type — the number of `CoreDataSerializer.deserialize`
 * calls the JVM would make to deserialize a value of this type. Scalar types
 * cost 1 call (level 0). Each composite wrapper adds 1.
 *
 * Examples: SByte=1, SColl[SByte]=2, SColl[SColl[SByte]]=3.
 */
function typeNestingDepth(t: SType): number {
  switch (t.tag) {
    case 'SColl':
    case 'SOption':
      return 1 + typeNestingDepth(t.elem)
    case 'STuple':
      return 1 + (t.items.length > 0 ? Math.max(...t.items.map(typeNestingDepth)) : 0)
    default:
      return 1
  }
}

export function evalGlobalDeserializeTo(
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>,
): SValue {
  // Defensive guards: check arity before attempting bytes extraction.
  if (obj.kind !== 'Global') {
    throw new EvalError(
      `SGlobal.deserializeTo expects a Global obj; got '${obj.kind}'`,
      'global-deserialize-failed',
    )
  }
  if (args.length !== 1) {
    throw new EvalError(
      `SGlobal.deserializeTo expects 1 arg; got ${args.length}`,
      'global-deserialize-failed',
    )
  }

  const bytes = collByteToUint8Array(args[0]!, 'Global.deserializeTo')

  // Cost charged before parse — matches JVM addSeqCost ordering.
  // Charged even if the subsequent parse throws.
  ctx.addPerItemCost(100, 32, 32, bytes.length)

  const T = explicitTypeArgs['T']!

  // MaxTreeDepth bound: the JVM's r.level is 0-based, throws at level > 110.
  // Our typeNestingDepth is 1-based. Allowed up to depth 111 (= level 110).
  if (typeNestingDepth(T) > MAX_DEPTH_ALLOWED) {
    throw new EvalError(
      `Global.deserializeTo: type nesting depth exceeds MaxTreeDepth (${MAX_TREE_DEPTH})`,
      'global-deserialize-failed',
    )
  }

  try {
    // Trailing bytes are intentionally NOT checked — the JVM ignores them
    // (CSigmaDslBuilder.scala:277-282 reads exactly what the type needs).
    return parseSValue(T, ctx.treeVersion ?? 0, new ByteReader(bytes))
  } catch (e) {
    throw new EvalError(
      `Global.deserializeTo failed: ${(e as Error).message}`,
      'global-deserialize-failed',
    )
  }
}
