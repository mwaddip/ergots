/**
 * FuncValue — parse + serialize.
 *
 * Wire format (sigma-rust `mir/func_value.rs`):
 *
 *   [OP_FUNC_VALUE opcode = 0xd9]
 *   [args: Vec<FuncArg>] = [VLQ-u32 count] [each FuncArg]*
 *   [body: Expr]
 *
 *   where FuncArg = [VLQ-u32 id] [SType tpe]
 *
 * The `Vec<FuncArg>` encoding follows the generic `Vec<T>::sigma_serialize`
 * (`serialization/serializable.rs:172`): `put_u32(len)` followed by each
 * element. `put_u32` is plain VLQ (`sigma-ser/src/vlq_encode.rs:78`).
 *
 * Each `FuncArg` writes the arg's `id` as a VLQ-u32 (via `ValId::sigma_serialize`
 * → `put_u32`, same as ValDef) followed by the `tpe` encoded as a normal
 * SType byte sequence.
 *
 * Critical val-def-type-store side effect at parse time
 * ----------------------------------------------------
 * After parsing the args vector, sigma-rust inserts EACH `(arg.id, arg.tpe)`
 * pair into the shared `r.val_def_type_store()` BEFORE parsing the body
 * (`func_value.rs:110-112`):
 *
 *     let args = Vec::<FuncArg>::sigma_parse(r)?;
 *     args.iter()
 *         .for_each(|a| r.val_def_type_store().insert(a.idx, a.tpe.clone()));
 *     let body = Expr::sigma_parse(r)?;
 *
 * The body parser uses these bindings to recover the `tpe` of any nested
 * `ValUse(id)` whose id matches an arg (since `ValUse.tpe` is not on the
 * wire — see `wire/mir/val-use.ts`).
 *
 * Sigma-rust does NOT unwind these insertions after parsing the body.
 * The `val_def_type_store` is a shared HashMap that grows monotonically
 * during a single tree parse. If two FuncValues at sibling positions
 * reuse the same arg id with different types, the later parse will
 * silently overwrite the earlier binding — exactly the same semantic as
 * sigma-rust's `HashMap::insert`. We mirror that: no push/pop scoping,
 * no clone-and-restore. Well-formed ErgoTrees emitted by sigma-rust's
 * own compiler use distinct ValIds across a single tree.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/func_value.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/serializable.rs:172-186
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:159,275
 */

import type { FuncArg, FuncValue, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter, readVlqU32 } from '@ergots/scorex'
import { ExprSerializeError } from '../errors'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
// Forward import for recursive descent — see comment in val-def.ts.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { readArrayCount } from './_jvm-counts'

/**
 * Parse a `FuncValue` payload (the OP_FUNC_VALUE opcode byte was consumed
 * by the dispatcher). Reads the args count, then each `(id, tpe)`, then
 * inserts each arg into the shared `valDefTypes` map BEFORE parsing the
 * body (so nested `ValUse` nodes can resolve their types from the args).
 *
 * Mirrors sigma-rust's `FuncValue::sigma_parse`.
 */
export function parseFuncValue(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): FuncValue {
  // JVM FuncValueSerializer.scala:30-34: getUIntExact, then safeNewArray.
  const count = readArrayCount(r, 'FuncValue args count', 'func-value-too-many-args')
  const args: FuncArg[] = []
  for (let i = 0; i < count; i++) {
    // JVM FuncValueSerializer.scala:36: getUInt().toInt — a u32, wrapped to an Int.
    const id = readVlqU32(r, 'FuncValue arg id') | 0
    const tpe = parseSType(r, treeVersion)
    args.push({ id, tpe })
  }
  // Side effect (matches sigma-rust func_value.rs:110-112): register each
  // arg in the shared store before parsing the body, so a nested ValUse
  // referencing the arg id resolves its tpe correctly. No scoping/unwind
  // — sigma-rust uses HashMap::insert and never removes.
  for (const a of args) {
    valDefTypes.set(a.id, a.tpe)
  }
  const body = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'FuncValue', args, body }
}

/**
 * Serialize a `FuncValue` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_FUNC_VALUE opcode byte). Writes the args count as VLQ-u32,
 * then each arg as `(VLQ-u32 id, SType tpe)`, then the body Expr.
 */
export function serializeFuncValue(f: FuncValue, w: ByteWriter, treeVersion: number): void {
  // JVM FuncValueSerializer.scala:23 writes each id, an Int, with putUInt, which rejects a negative
  // Int (scorex-util 0.2.1 VLQWriter.scala:64-67): so only [0, 2^31) is writable. A parsed id wraps
  // negative from 2^31 up; an id at or above 2^31, or a non-integer, is hand-built MIR (as
  // serializeValDef's bound, val-def.ts).
  for (const a of f.args) {
    if (!Number.isInteger(a.id) || a.id < 0 || a.id > 0x7fffffff) {
      throw new ExprSerializeError(
        `FuncValue arg id ${a.id} is outside [0, 2^31) (JVM Int written with putUInt)`,
        'func-value-arg-id-out-of-range'
      )
    }
  }
  w.writeVlqU(f.args.length)
  for (const a of f.args) {
    w.writeVlqU(a.id)
    serializeSType(a.tpe, w)
  }
  serializeExpr(f.body, w, treeVersion)
}
