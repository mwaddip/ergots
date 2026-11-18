/**
 * ModQ (opcode 0xe7), PlusModQ (0xe8), MinusModQ (0xe9) — parse + serialize.
 *
 * Wire format (JVM `ModQSerializer.scala`, `ModQArithOpSerializer.scala`):
 *
 *   ModQ:        [0xe7] [input: Expr]
 *   PlusModQ:    [0xe8] [left: Expr] [right: Expr]
 *   MinusModQ:   [0xe9] [left: Expr] [right: Expr]
 *
 * The JVM casts each operand to `BigIntValue` via the erased `asBigInt`
 * (`ast/syntax.scala:144`, `v.asInstanceOf[Value[SBigInt.type]]`), so an
 * operand of any type parses. No constructor check runs (`ast/trees.scala:954-970`).
 * The static type is `SBigInt` (`ast/trees.scala:957, 968`).
 *
 * `ModQSerializer` and `ModQArithOpSerializer` are kept in the JVM's dispatch
 * table for consensus-level deserialization though no evaluator arm runs
 * (`ValueSerializer.scala:141-147`). Removing them would break the parse of
 * transactions whose outputs carry one of these nodes, where the script is
 * not executed during validation but the deserializer is.
 */

import type { ByteReader, ByteWriter } from '@ergots/scorex'
import type { ModQ, ModQArith, SType, SValue } from '../../mir/types'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `ModQ` payload (the opcode byte was consumed by the dispatcher).
 * Reads one Expr — the operand. Mirrors `ModQSerializer.parse`
 * (`ModQSerializer.scala`).
 */
export function parseModQ(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number,
): ModQ {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'ModQ', input }
}

/**
 * Serialize a `ModQ` payload (the dispatcher writes the opcode byte).
 * Writes the operand Expr.
 */
export function serializeModQ(e: ModQ, w: ByteWriter, treeVersion: number): void {
  serializeExpr(e.input, w, treeVersion)
}

/**
 * Parse a `ModQArith` payload (the opcode byte was consumed by the dispatcher).
 * `op` is picked by the dispatcher from the opcode byte: `'PlusModQ'` for 0xe8,
 * `'MinusModQ'` for 0xe9. Reads two Exprs — the left and right operands.
 * Mirrors `ModQArithOpSerializer.parse` (`ModQArithOpSerializer.scala`).
 */
export function parseModQArith(
  op: ModQArith['op'],
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number,
): ModQArith {
  const left = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const right = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'ModQArith', op, left, right }
}

/**
 * Serialize a `ModQArith` payload (the dispatcher writes the opcode byte,
 * picked from `e.op`). Writes the left operand then the right.
 */
export function serializeModQArith(e: ModQArith, w: ByteWriter, treeVersion: number): void {
  serializeExpr(e.left, w, treeVersion)
  serializeExpr(e.right, w, treeVersion)
}
