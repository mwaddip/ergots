/**
 * SGlobal.serialize (MethodCall, 106:3) — v6 P5a eval handler.
 *
 * JVM source: sigma/ast/methods.scala:1957-1984 — DynamicCost:
 *   StartWriterCost(10) + per-write costs charged via cost-instrumented writer
 *   as DataSerializer walks the value. V3-gated (isV3OrLaterErgoTreeVersion).
 *
 * Cost model: an analytical walk — serializeCost(T, v, ctx) charges each
 * JVM primitive before the byte write, then serializeSValue produces the bytes.
 * This decouples cost from the byte-validated serializer (see spec §Cost).
 *
 * Type resolution: T is derived from the RUNTIME value via sValueType(args[0]),
 * NOT from exprTpe — the static type is incomplete (SAny for unresolved
 * MethodCall/PropertyCall returns) which would throw where the JVM succeeds.
 * Runtime values carry their own concrete types (Coll.elem, Option.elem, etc.).
 * See spec §"Type resolution" for the faithfulness argument.
 *
 * Output: Coll[Byte] containing the raw data bytes (no type prefix), matching
 * the JVM DataSerializer.serialize output — confirmed by verifyCases:
 *   serialize[Byte](-128) → [0x80] (1 byte, no type tag).
 *
 * Errors: any failure in serializeSValue (type mismatch, bounds violation,
 * unsupported type) is wrapped in EvalError 'global-serialize-failed'.
 */

import { ByteWriter } from '@ergots/scorex'
import { serializeSValue } from '../wire/serialize-svalue'
import { bytesToCollByteSValue } from './_byte-coll'
import { sValueType } from './svalue-type'
import { serializeCost } from './serialize-cost'
import { EvalError, type EvalContext } from './eval-context'
import type { SType, SValue } from '../mir/types'

export function evalGlobalSerialize(
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  _explicitTypeArgs: Record<string, SType>,
): SValue {
  if (obj.kind !== 'Global') {
    throw new EvalError(
      `SGlobal.serialize expects a Global obj; got '${obj.kind}'`,
      'global-serialize-failed',
    )
  }
  if (args.length !== 1) {
    throw new EvalError(
      `SGlobal.serialize expects 1 arg; got ${args.length}`,
      'global-serialize-failed',
    )
  }

  const value = args[0]!

  // T derived from runtime value — NOT exprTpe (see module doc for rationale).
  const T = sValueType(value)

  // StartWriterCost(10) — charged once, before the walk (matches JVM ordering:
  // startWriterCostCounter is installed before DataSerializer.serialize runs).
  ctx.addCost(10)

  // DynamicCost walk — charges per JVM SigmaByteWriter primitive write.
  // Throws EvalError 'global-serialize-failed' for unsupported/non-serializable T.
  serializeCost(T, value, ctx)

  // Byte emission — separate from cost to avoid touching the byte-validated serializer.
  const w = new ByteWriter()
  try {
    serializeSValue(T, value, ctx.treeVersion ?? 0, w)
  } catch (e) {
    throw new EvalError(
      `Global.serialize failed: ${(e as Error).message}`,
      'global-serialize-failed',
    )
  }

  return bytesToCollByteSValue(w.toBytes())
}
