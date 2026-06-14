/**
 * Tuple — parse + serialize.
 *
 * JVM canonical source: TupleSerializer.scala (sigma-state / sigmastate-interpreter).
 *
 * PARSE (TupleSerializer.scala:27-36):
 *   item count read via SIGNED `getByte()`; values 0x80..0xFF sign-extend to
 *   negative, which then propagates into `safeNewArray(count)` →
 *   `NegativeArraySizeException` at the JVM level — observable as a parse
 *   failure on the wire-reject side. There is NO lower arity gate: `mkTuple`
 *   is bare construction (`SigmaBuilder.scala:481-482`) and `Tuple.tpe` is lazy
 *   (`values.scala:783`), so arity 0 and 1 parse cleanly and are rejected only
 *   at EVAL time (`values.scala:797 → syntax.error("Invalid tuple …")`).
 *
 *   Wire window: parse accepts 0..127; rejects ≥ 128 with
 *   'tuple-arity-out-of-range'.
 *
 * SERIALIZE (TupleSerializer.scala:18-25):
 *   `putUByte(length)` + items — NO arity gate. Arity 0/1 serializes on the
 *   JVM and re-parses; 128..255 serializes but the JVM cannot re-parse its own
 *   output (signed-byte asymmetry, mirrored here). Only > 255 is rejected (u8
 *   count cannot represent it).
 *
 * DIVERGENCE NOTE — sigma-rust `BoundedVec` semantics (vendored
 * `external/sigma-rust`, which is STALE and NOT canonical):
 *   sigma-rust enforces 2..=255 via `TupleItems<T>::try_from` at both parse
 *   and construction time. This over-rejects arity 0/1 at parse (JVM accepts)
 *   and over-accepts arity 128..255 at parse (JVM rejects). ergots previously
 *   mirrored that behaviour; this module now mirrors the JVM.
 *
 * Cross-reference (JVM canonical):
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/serialization/
 *     TupleSerializer.scala:18-36
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/ast/
 *     SigmaBuilder.scala:481-482   (mkTuple — bare construction, no arity require)
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/ast/
 *     values.scala:783-797          (Tuple.tpe lazy; arity≠2 eval error)
 *   ~/projects/sigmastate-interpreter/core/shared/src/main/scala/sigma/serialization/
 *     TypeSerializer.scala:93-94,188-194
 */

import type { Tuple, SType, SValue, Expr } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprParseError, ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

const MAX_TUPLE_ITEMS = 255

/**
 * Parse a `Tuple` payload (the OP_TUPLE opcode byte was consumed by the
 * dispatcher). Reads a one-byte item count and then that many Exprs.
 *
 * Mirrors JVM `TupleSerializer.parse` (TupleSerializer.scala:27-36): count
 * read via signed getByte(); 0x80..0xFF sign-extend to negative →
 * NegativeArraySizeException. No lower arity gate (mkTuple bare,
 * SigmaBuilder.scala:481-482; Tuple.tpe lazy, values.scala:783).
 *
 * Parse window: 0..127. Arity 0/1 parses cleanly and is rejected at EVAL
 * by the 'tuple-invalid-arity' gate (values.scala:797).
 */
export function parseTuple(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): Tuple {
  const count = r.readU8()
  if (count > 127) {
    // JVM TupleSerializer.parse (TupleSerializer.scala:27-36) reads the count
    // via SIGNED getByte(): 0x80..0xFF sign-extend negative → safeNewArray →
    // NegativeArraySizeException at parse. Mirror: reject ≥ 128.
    // NO lower gate: mkTuple is bare construction (SigmaBuilder.scala:481-482)
    // and Tuple.tpe is lazy — arity 0/1 parses on the JVM and rejects at EVAL
    // (values.scala:797, 'tuple-invalid-arity' our side). The old [2,255]
    // window was sigma-rust BoundedVec semantics — a JVM fork in BOTH
    // directions (over-reject 0/1, over-accept 128..255).
    throw new ExprParseError(
      `Tuple item count ${count} exceeds 127 (JVM signed-byte size read)`,
      'tuple-arity-out-of-range'
    )
  }
  const items: Expr[] = []
  for (let i = 0; i < count; i++) {
    items.push(parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion))
  }
  return { tag: 'Tuple', items }
}

/**
 * Serialize a `Tuple` payload (the dispatcher in {@link serializeExpr} emits
 * the OP_TUPLE opcode byte). Writes the one-byte item count then each item
 * as a full Expr.
 *
 * Mirrors JVM `TupleSerializer.serialize` (TupleSerializer.scala:18-25):
 * `putUByte(length)` + items — NO arity gate. Arity 0/1 serializes on the
 * JVM (and re-parses); 128..255 serializes but the JVM cannot re-parse its
 * own output (the signed-byte asymmetry, mirrored here). Only > 255 is
 * rejected because a u8 count cannot represent it.
 */
export function serializeTuple(t: Tuple, w: ByteWriter, treeVersion: number): void {
  const n = t.items.length
  if (n > MAX_TUPLE_ITEMS) {
    // JVM TupleSerializer.serialize = putUByte(length) + items — NO arity
    // gate; > 255 is unrepresentable in the u8 count. Arity 0/1 serializes on
    // the JVM (and re-parses); 128..255 serializes but the JVM cannot
    // re-parse its own output — the signed-byte asymmetry, mirrored here.
    throw new ExprSerializeError(
      `Tuple item count ${n} exceeds ${MAX_TUPLE_ITEMS} (u8 wire count)`,
      'tuple-arity-out-of-range'
    )
  }
  w.writeU8(n)
  for (const item of t.items) {
    serializeExpr(item, w, treeVersion)
  }
}
