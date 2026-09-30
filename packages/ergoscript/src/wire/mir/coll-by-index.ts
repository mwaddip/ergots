/**
 * CollByIndex — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_by_index.rs`):
 *
 *   [OP_BY_INDEX opcode = 0xb2]
 *   [input: Expr]               -- the collection (SColl)
 *   [index: Expr]               -- the index (SInt)
 *   [default: Option<Box<Expr>>] -- present iff `Coll.getOrElse` (else `null`)
 *
 * ByIndex indexes a collection: strict `Coll.apply(i)` when `default == null`,
 * or `Coll.getOrElse(i, default)` when present.
 *
 * The `Option<Box<Expr>>` encoding follows sigma-rust's generic impl in
 * `serialization/serializable.rs:212-231`:
 *
 *   - tag byte 0x01 → Some, immediately followed by the inner Expr
 *   - tag byte 0x00 → None, no further bytes
 *
 * Any non-zero tag byte is treated as Some in sigma-rust (`tag != 0`), but
 * sigma-rust's own writer always emits exactly 0x00 or 0x01. We mirror both
 * directions: the parser accepts any non-zero tag as Some; the serializer
 * always writes 0x01 / 0x00.
 *
 * Sigma-rust's `ByIndex::new` enforces post-eval typing: input must be
 * `SColl(_)`, index must be `SInt`, and if `default` is present its
 * post-eval tpe must match the collection's element type
 * (`mir/coll_by_index.rs:33-66`). ergots makes the JVM's checks instead:
 * before tree v3, the index is upcast to Int as it is read
 * (ByIndexSerializer.scala:27-36), so a Long, BigInt or UnsignedBigInt index,
 * or one that is not numeric, rejects (`'by-index-index-not-int'`); and the
 * constructor casts the input's type to a collection, which the parse hook
 * checks (facts/ergoscript-wire.md, "Node construction"). The default's type
 * is not checked at parse, as in the JVM.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_by_index.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/serializable.rs:212-231
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::BY_INDEX)
 */

import type { ByIndex, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { exprTpe } from '../../mir/expr-tpe'
import { isJvmNumeric, isOwnSAny, numericTypeIndex } from '../../mir/jvm-types'
import { ExprParseError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `ByIndex` payload (the OP_BY_INDEX opcode byte was consumed by
 * the dispatcher). Reads the input Expr, the index Expr, then the optional
 * default tagged by a single byte (0 = None, non-zero = Some).
 *
 * Mirrors sigma-rust's `<ByIndex as SigmaSerializable>::sigma_parse`
 * (`mir/coll_by_index.rs:86-91`) and the generic `Option<Box<T>>`
 * decoding from `serialization/serializable.rs:223-230` (`tag != 0`).
 */
export function parseCollByIndex(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): ByIndex {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const index = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  // ByIndexSerializer.scala:29-33: before v3, index.upcastTo(SInt): assert numeric, and
  // assert SInt.max(t) == SInt (syntax.scala:168-177). Right after the index, before the default flag: an
  // AssertionError, which no sized tree degrades on. The JVM wraps a Byte or Short index in an Upcast,
  // which ergots does not insert (residual 11). An index typed as ergots' own SAny passes (residual 1).
  // From v3 the index is taken as it is (:29-30).
  if (treeVersion < 3) {
    const t = exprTpe(index, treeVersion)
    if (!isOwnSAny(t) && (!isJvmNumeric(t) || numericTypeIndex(t) > 2)) {
      throw new ExprParseError(`ByIndex index type ${t.tag} does not upcast to Int`, 'by-index-index-not-int')
    }
  }
  const tag = r.readU8()
  const def =
    tag !== 0
      ? parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
      : null
  return { tag: 'ByIndex', input, index, default: def }
}

/**
 * Serialize a `ByIndex` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_BY_INDEX opcode byte). Writes the input Expr, the index
 * Expr, then the optional default as a tagged Option: 0x01 + inner when
 * present, single 0x00 when absent.
 */
export function serializeCollByIndex(e: ByIndex, w: ByteWriter, treeVersion: number): void {
  serializeExpr(e.input, w, treeVersion)
  serializeExpr(e.index, w, treeVersion)
  w.writeOption(e.default, (w, inner) => serializeExpr(inner, w, treeVersion))
}
