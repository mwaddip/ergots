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
 * Type resolution: the JVM `serialize_eval` writes by the argument's STATIC
 * type, `mc.args(0).tpe` (`sigma/ast/methods.scala:1982`). ergots is handed
 * that static type whenever it carries the information the writer reads; the
 * value-derived type (through `sValueType`) is the fallback only where the
 * static type holds ergots' own `SAny` at any depth — a fresh
 * `{ tag: 'SAny' }` object the method typing builds for a method the signature
 * catalog does not resolve (residual 1 of `facts/ergoscript-wire.md`); there
 * the concrete runtime value carries the elem / value information. The JVM's
 * `SAny` (`SANY_JVM`, told from ergots' own by object identity) is kept on the
 * static path: the writer's catch-all refuses it
 * (`CoreDataSerializer.scala:89-91`, `CheckSerializableTypeCode`). A tuple
 * type at any arity on the static path writes through `fromDslTuple`
 * (`Evaluation.scala:91-96`): the pair case takes a `Coll[Any]` whose
 * `tItem == AnyType`, so a two-item `tupleColl` under a pair-typed read
 * writes the pair's bytes.
 *
 * Output: Coll[Byte] containing the raw data bytes (no type prefix), matching
 * the JVM DataSerializer.serialize output — confirmed by verifyCases:
 *   serialize[Byte](-128) → [0x80] (1 byte, no type tag).
 *
 * Errors: any failure in serializeCost or serializeSValue (type mismatch, bounds
 * violation, unsupported type, a Box tree that cannot be re-encoded) is wrapped in
 * EvalError 'global-serialize-failed', with the failure as its `cause`; an EvalError
 * from the cost walk passes through.
 */

import { ByteWriter } from '@ergots/scorex'
import { serializeSValue } from '../wire/serialize-svalue'
import { byteColl } from './_coll'
import { sValueType } from './svalue-type'
import { serializeCost } from './serialize-cost'
import { EvalError, type EvalContext } from './eval-context'
import { exprTpe } from '../mir/expr-tpe'
import type { Env } from './env'
import type { MethodCall, SType, SValue } from '../mir/types'
import { SANY_JVM } from '../mir/types'

/**
 * The static type the writer is handed, following the JVM's `serialize_eval`
 * (`sigma/ast/methods.scala:1982`): `mc.args(0).tpe` unless that type holds
 * ergots' own `SAny` at any depth (a `{ tag: 'SAny' }` object that is not
 * `SANY_JVM`; the fresh object the method typing builds for a method the
 * signature catalog does not resolve, residual 1 of
 * `facts/ergoscript-wire.md`), in which case the value-derived type is used:
 * the concrete runtime value carries the information behind ergots' own
 * `SAny`.
 */
function serializeType(value: SValue, mc: MethodCall, treeVersion: number): SType {
  const argExpr = mc.args[0]!
  const staticTpe = exprTpe(argExpr, treeVersion)
  if (holdsOwnSAny(staticTpe)) return sValueType(value)
  return staticTpe
}

/**
 * `tpe` contains an `SAny` leaf that is NOT `SANY_JVM`, at any depth (through
 * collections, options, tuples and function types). ergots' own `SAny` is
 * told from the JVM's by object identity (`SANY_JVM`, `mir/types.ts`).
 */
function holdsOwnSAny(tpe: SType): boolean {
  if (tpe.tag === 'SAny') return tpe !== SANY_JVM
  if (tpe.tag === 'SColl') return holdsOwnSAny(tpe.elem)
  if (tpe.tag === 'SOption') return holdsOwnSAny(tpe.elem)
  if (tpe.tag === 'STuple') return tpe.items.some(holdsOwnSAny)
  if (tpe.tag === 'SFunc') return tpe.args.some(holdsOwnSAny) || holdsOwnSAny(tpe.result)
  return false
}

export function evalGlobalSerialize(
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  _explicitTypeArgs: Record<string, SType>,
  extra?: { mc: MethodCall; env: Env },
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

  // The writer is handed the argument's static type where that type is the
  // JVM's SAny or holds a non-pair tuple at any depth (see module comment),
  // the value-derived type otherwise. `extra` is supplied by `evalMethodCall`
  // (`eval/method-call.ts:147-152`): `serialize` is registered at (106, 3), a
  // MethodCall opcode, and the PropertyCall path (zero args, no `extra`) is
  // rejected by the length check above before any read of `extra`.
  let T: SType
  try {
    T = serializeType(value, extra!.mc, ctx.treeVersion ?? 0)
  } catch (e) {
    if (e instanceof EvalError) throw e
    throw new EvalError(
      `Global.serialize failed: ${(e as Error).message}`,
      'global-serialize-failed',
      { cause: e },
    )
  }

  // StartWriterCost(10) — charged once, before the walk (matches JVM ordering:
  // startWriterCostCounter is installed before DataSerializer.serialize runs).
  ctx.addCost(10)

  // DynamicCost walk — charges per JVM SigmaByteWriter primitive write.
  // Throws EvalError 'global-serialize-failed' for unsupported/non-serializable T.
  // A value the JVM's DataSerializer.serialize (methods.scala:1982) fails on can fail
  // the walk too, e.g. a Box whose tree cannot be re-encoded (ErgoBoxCandidate.scala:142):
  // wrapped like the byte emission below. An EvalError (the cost limit) passes through.
  try {
    serializeCost(T, value, ctx)
  } catch (e) {
    if (e instanceof EvalError) throw e
    throw new EvalError(
      `Global.serialize failed: ${(e as Error).message}`,
      'global-serialize-failed',
      { cause: e },
    )
  }

  // Byte emission — separate from cost to avoid touching the byte-validated serializer.
  const w = new ByteWriter()
  try {
    serializeSValue(T, value, ctx.treeVersion ?? 0, w)
  } catch (e) {
    throw new EvalError(
      `Global.serialize failed: ${(e as Error).message}`,
      'global-serialize-failed',
      { cause: e },
    )
  }

  // JVM `Global.serialize_eval` ends `Colls.fromArray(w.toBytes)`
  // (`data/shared/src/main/scala/sigma/ast/methods.scala:1983`) on an
  // `Array[Byte]` — the specialised `fromArray` branch
  // (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:226-233`).
  return byteColl(w.toBytes(), true)
}
