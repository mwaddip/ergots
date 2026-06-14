/**
 * DeserializeRegister — parse + serialize.
 *
 * Wire format (sigma-rust `mir/deserialize_register.rs:48-64`):
 *
 *   [OP_DESERIALIZE_REGISTER opcode = 0xd5]
 *   [reg: u8]                  -- register number 0..=9 (sigma-rust:
 *                                 `RegisterId::try_from(u8)`; values > 9
 *                                 are rejected)
 *   [tpe: SType]               -- result type of the deserialized script
 *   [default: Option<Box<Expr>>]
 *      tag byte:
 *        0x00 → None
 *        nonzero → Some (Expr follows; canonical emit 0x01)
 *
 * `DeserializeRegister` reads `SELF.R{reg}` as a `Coll[Byte]`, deserializes
 * the bytes into an `Expr` and inlines it; if the register is empty, the
 * `default` Expr is executed. The Option<Box<Expr>> uses the same wire
 * shape as `impl<T: SigmaSerializable> SigmaSerializable for Option<Box<T>>`
 * in sigma-rust's `serialization/serializable.rs`. JVM-confirmed for THIS
 * node: `DeserializeRegisterSerializer.scala` parses
 * `r.getOption(r.getValue())` — a presence tag IS the JVM shape here.
 * (CreateAvlTree.valueLength, previously cited as the same encoding, turned
 * out to be a sigma-rust wire FORK — the JVM serializes it as a 4th expr
 * operand; fixed in the F4 epilogue. Do not generalize the presence-tag
 * shape across nodes without a per-node JVM serializer read.)
 *
 * Sigma-rust's `sigma_parse` reads `reg` first then `tpe` then `default`,
 * and sets the reader's `set_deserialize(true)` flag (relevant only to its
 * inline-expansion pass — irrelevant to a pure wire round-trip).
 *
 * Reg-id bounds: sigma-rust accepts u8 values 0..=9 (the RegisterId enum
 * spans R0..R9). We reject reg > 9 at parse time with code
 * `deserialize-register-id-out-of-range`, mirroring sigma-rust's
 * `InvalidArgumentError("DeserializeRegister: register id out of bounds")`.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/deserialize_register.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/ergo_box/register/id.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/serializable.rs (Option<Box<T>>)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::DESERIALIZE_REGISTER)
 */

import type { DeserializeRegister, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprParseError, ExprSerializeError } from '../errors'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `DeserializeRegister` payload (the OP_DESERIALIZE_REGISTER opcode
 * byte was consumed by the dispatcher). Reads the register id, the SType,
 * then the Option<Box<Expr>> default.
 *
 * Mirrors `DeserializeRegister::sigma_parse`
 * (`mir/deserialize_register.rs:57-64`).
 */
export function parseDeserializeRegister(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): DeserializeRegister {
  const reg = r.readU8()
  if (reg > 9) {
    throw new ExprParseError(
      `DeserializeRegister: register id ${reg} out of bounds (0..9)`,
      'deserialize-register-id-out-of-range'
    )
  }
  const tpe = parseSType(r)
  const tag = r.readU8()
  let defaultExpr = null
  if (tag !== 0) {
    // JVM DeserializeRegisterSerializer.scala:30 `r.getOption(r.getValue())` —
    // scorex-util getOption: ANY nonzero tag → Some(parse Expr). The previous
    // tag∈{0,1}-else-throw ('invalid-option-tag', now retired) was an
    // over-reject fork. Serialize emits canonical 0x01/0x00 (writeOption), so
    // a noncanonical tag does not byte-round-trip — same on the JVM.
    defaultExpr = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  }
  return { tag: 'DeserializeRegister', reg, tpe, default: defaultExpr }
}

/**
 * Serialize a `DeserializeRegister` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_DESERIALIZE_REGISTER opcode byte).
 * Writes the register id, the SType, then the Option<Box<Expr>> default.
 *
 * Mirrors `DeserializeRegister::sigma_serialize`
 * (`mir/deserialize_register.rs:51-55`).
 */
export function serializeDeserializeRegister(
  e: DeserializeRegister,
  w: ByteWriter,
  treeVersion: number
): void {
  if (!Number.isInteger(e.reg) || e.reg < 0 || e.reg > 9) {
    throw new ExprSerializeError(
      `DeserializeRegister.reg ${e.reg} out of bounds (0..9)`,
      'deserialize-register-id-out-of-range'
    )
  }
  w.writeU8(e.reg)
  serializeSType(e.tpe, w)
  w.writeOption(e.default, (w, inner) => serializeExpr(inner, w, treeVersion))
}
