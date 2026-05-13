/**
 * Apply — parse + serialize.
 *
 * Wire format (sigma-rust `mir/apply.rs`):
 *
 *   [OP_APPLY opcode = 0xda]
 *   [func: Expr]
 *   [args: Vec<Expr>] = [VLQ-u32 count] [each arg Expr]*
 *
 * The function expression is serialized first as a normal Expr (typically
 * but not exclusively a `FuncValue`); then the args vector follows the
 * standard `Vec<T>::sigma_serialize` encoding: `put_u32(len)` (plain VLQ)
 * + each element. `put_u32` is plain VLQ
 * (`sigma-ser/src/vlq_encode.rs:78`).
 *
 * Args are parsed recursively via the central dispatcher, threading
 * `valDefTypes` unchanged so any ValUse in an arg resolves against the
 * enclosing scope's bindings (e.g. an outer FuncValue's args or sibling
 * ValDef bindings).
 *
 * `Apply::new` in sigma-rust performs arity/type validation (checks the
 * func's SFunc domain matches the args' types). The serializer does NOT
 * re-check this on parse — `Apply::sigma_parse` calls `Apply::new` which
 * returns `Err(InvalidArgumentError)` if the well-typed-ness fails, BUT
 * that error path is wrapped in the parse result. We skip the arity
 * check at the wire layer: the AST is sigma-rust-equivalent regardless,
 * and type-checking is a higher-layer concern (the interpreter, when
 * implemented, will validate types). Well-formed corpora produced by
 * sigma-rust's serializer always satisfy the check.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/apply.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/serializable.rs:172-186
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:160,276
 */

import type { Apply, Expr, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprParseError } from '../errors'
// Forward import for recursive descent — see comment in val-def.ts.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

// Defensive cap on the args array length. Real Apply nodes invoke
// functions with at most a handful of arguments (matching the callee's
// FuncValue arg count). A count beyond this is almost certainly a
// malicious/corrupt encoding aimed at allocating a huge array before the
// reader hits truncation. Sigma-rust caps Vec deserialization indirectly
// via the surrounding ErgoTree size limit; we add an explicit bound here
// because each arg Expr is non-trivial to allocate.
const MAX_APPLY_ARGS = 1 << 16 // 65536, well above any plausible call

/**
 * Parse an `Apply` payload (the OP_APPLY opcode byte was consumed by the
 * dispatcher). Reads the function Expr, then the args count, then each
 * arg Expr.
 *
 * Mirrors sigma-rust's `Apply::sigma_parse`. Unlike sigma-rust we do not
 * re-validate the call's arity at this layer — see the module header for
 * the rationale.
 */
export function parseApply(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Apply {
  const func = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const count = r.readVlqU()
  if (count > MAX_APPLY_ARGS) {
    throw new ExprParseError(
      `Apply args count ${count} exceeds ${MAX_APPLY_ARGS}`,
      'apply-too-many-args'
    )
  }
  const args: Expr[] = []
  for (let i = 0; i < count; i++) {
    args.push(parseExpr(r, constantTypes, constantValues, valDefTypes))
  }
  return { tag: 'Apply', func, args }
}

/**
 * Serialize an `Apply` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_APPLY opcode byte). Writes the function Expr, then the
 * args count as VLQ-u32, then each arg Expr.
 */
export function serializeApply(a: Apply, w: ByteWriter): void {
  serializeExpr(a.func, w)
  w.writeVlqU(a.args.length)
  for (const arg of a.args) {
    serializeExpr(arg, w)
  }
}
