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
 *   - MaxTreeDepth(110) is DATA-DRIVEN, not type-structural. `CoreByteReader.level_=`
 *     throws when the recursion level exceeds 110, and `CoreDataSerializer.deserialize`
 *     increments the level once per ACTUAL recursive call — so the JVM only descends
 *     into elements that are PRESENT. A value of a deeply-nested TYPE whose DATA is
 *     empty/shallow (e.g. `deserializeTo[Coll[Coll[…]]]` of an empty outer coll) is
 *     ACCEPTED. We mirror this with the shared reader-level depth counter
 *     (`ByteReader.enterDepth`/`exitDepth`, default cap 110): a FRESH `ByteReader`
 *     defaults to `maxTreeDepth = 110` exactly like the JVM's fresh reader, and
 *     `parseSValue` (and, for an SSigmaProp value, `parseSigmaBoolean`) bumps that
 *     one counter per recursive call rather than pre-checking the type's depth.
 */

import { ByteReader } from '@ergots/scorex'
import { parseSValue } from '../wire/parse-svalue'
import { collByteToUint8Array } from './_byte-coll'
import { EvalError, type EvalContext } from './eval-context'
import type { SType, SValue } from '../mir/types'

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

  try {
    // Trailing bytes are intentionally NOT checked — the JVM ignores them
    // (CSigmaDslBuilder.scala:277-282 reads exactly what the type needs).
    //
    // A FRESH ByteReader defaults to maxTreeDepth = 110, exactly mirroring the
    // JVM's fresh `SigmaByteReader` in `CSigmaDslBuilder.deserializeTo`
    // (`CSigmaDslBuilder.scala:279`, default `SigmaSerializer.MaxTreeDepth`).
    // The reader's shared `level` counter (bumped by parseSValue, and by
    // parseSigmaBoolean for an SSigmaProp value) enforces MaxTreeDepth
    // data-driven; an over-deep value raises ReaderError 'max-tree-depth-exceeded'
    // which is caught below and surfaced as 'global-deserialize-failed'.
    return parseSValue(T, ctx.treeVersion ?? 0, new ByteReader(bytes))
  } catch (e) {
    throw new EvalError(
      `Global.deserializeTo failed: ${(e as Error).message}`,
      'global-deserialize-failed',
    )
  }
}
