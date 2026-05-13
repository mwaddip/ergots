/**
 * OptionGetOrElse — parse + serialize.
 *
 * Wire format (sigma-rust `mir/option_get_or_else.rs`):
 *
 *   [OP_OPTION_GET_OR_ELSE opcode = 0xe5]
 *   [input: Expr]      -- the option-typed expression (post-eval: SOption[T])
 *   [default: Expr]    -- value returned when `input` is None
 *
 * Unlike `OptionGet` / `OptionIsDefined`, `OptionGetOrElse` has its own
 * explicit `SigmaSerializable` impl (`mir/option_get_or_else.rs:56-67`),
 * not the `OneArgOp` blanket — it writes two back-to-back Exprs.
 *
 * Sigma-rust's `OptionGetOrElse::new` constructor (`mir/option_get_or_else.rs:29-44`)
 * enforces that the input's post-eval type is `SOption(elem)` and that the
 * default's post-eval type matches `elem`. We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/option_get_or_else.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:124,314
 */

import type { OptionGetOrElse, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `OptionGetOrElse` payload (the OP_OPTION_GET_OR_ELSE opcode byte
 * was consumed by the dispatcher). Reads the input Expr, then the default
 * Expr.
 *
 * Mirrors sigma-rust's `<OptionGetOrElse as SigmaSerializable>::sigma_parse`
 * (`mir/option_get_or_else.rs:62-66`).
 */
export function parseOptionGetOrElse(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): OptionGetOrElse {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const def = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'OptionGetOrElse', input, default: def }
}

/**
 * Serialize an `OptionGetOrElse` payload (the dispatcher writes the
 * OP_OPTION_GET_OR_ELSE opcode byte). Writes the input Expr then the
 * default Expr.
 *
 * Mirrors sigma-rust's `<OptionGetOrElse as SigmaSerializable>::sigma_serialize`
 * (`mir/option_get_or_else.rs:57-60`).
 */
export function serializeOptionGetOrElse(
  e: OptionGetOrElse,
  w: ByteWriter
): void {
  serializeExpr(e.input, w)
  serializeExpr(e.default, w)
}
