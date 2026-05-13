/**
 * GlobalVars — parse + serialize.
 *
 * Wire format (sigma-rust `mir/global_vars.rs`):
 *
 *   [opcode byte]      -- one of six distinct opcode bytes (no payload)
 *
 * `GlobalVars` is sigma-rust's nullary "predefined global variable" enum.
 * Each of its six variants is dispatched by its own opcode at the Expr
 * parse layer (`serialization/expr.rs:110-115`):
 *
 *   OpCode::HEIGHT          (0xa3) => GlobalVars::Height
 *   OpCode::INPUTS          (0xa4) => GlobalVars::Inputs
 *   OpCode::OUTPUTS         (0xa5) => GlobalVars::Outputs
 *   OpCode::SELF_BOX        (0xa7) => GlobalVars::SelfBox
 *   OpCode::MINER_PUBKEY    (0xac) => GlobalVars::MinerPubKey
 *   OpCode::GROUP_GENERATOR (0x82) => GlobalVars::GroupGenerator
 *
 * Note: `OpCode::LAST_BLOCK_UTXO_ROOT_HASH` (0xa6) is intentionally NOT a
 * GlobalVars.kind. In sigma-rust it is reached via a `PropertyCall` on a
 * `Context` value (method id 9 — see `types/scontext.rs:136` and
 * `ergotree-interpreter/src/eval/scontext.rs:83`). Treating it as a
 * GlobalVars variant would diverge from the reference dispatch path; the
 * top-level opcode dispatcher continues to reject this byte as
 * `not-implemented-yet` until property/method calls land.
 *
 * Both directions are pure opcode-byte work — the dispatcher in
 * `wire/parse.ts` emits the opcode; the per-kind serializer simply maps
 * `kind` back to the byte. No payload is read or written here.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/global_vars.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs
 */

import type { GlobalVars } from '../../mir/types'
import { ByteWriter } from '../writer'
import { ExprSerializeError } from '../errors'
import * as OP from '../../mir/opcodes'

/**
 * Build a `GlobalVars` AST node for the kind matching the given dispatch
 * opcode byte. The dispatcher consumed the opcode byte already; this
 * function reads no further bytes because every kind has an empty payload.
 *
 * Mirrors the six `OpCode::* => Ok(Expr::GlobalVars(...))` arms in
 * sigma-rust `serialization/expr.rs`.
 */
export function buildGlobalVarsFromOpcode(opcode: number): GlobalVars {
  switch (opcode) {
    case OP.OP_HEIGHT:
      return { tag: 'GlobalVars', kind: 'Height' }
    case OP.OP_INPUTS:
      return { tag: 'GlobalVars', kind: 'Inputs' }
    case OP.OP_OUTPUTS:
      return { tag: 'GlobalVars', kind: 'Outputs' }
    case OP.OP_SELF_BOX:
      return { tag: 'GlobalVars', kind: 'SelfBox' }
    case OP.OP_MINER_PUBKEY:
      return { tag: 'GlobalVars', kind: 'MinerPubKey' }
    case OP.OP_GROUP_GENERATOR:
      return { tag: 'GlobalVars', kind: 'GroupGenerator' }
    default:
      throw new ExprSerializeError(
        `buildGlobalVarsFromOpcode called with non-GlobalVars opcode 0x${opcode
          .toString(16)
          .padStart(2, '0')}`,
        'unknown-variant'
      )
  }
}

/**
 * Map a `GlobalVars.kind` discriminator to its opcode byte. Mirrors the
 * sigma-rust `impl HasOpCode for GlobalVars` match
 * (`mir/global_vars.rs:46-55`).
 */
export function globalVarsOpcode(kind: GlobalVars['kind']): number {
  switch (kind) {
    case 'Height':
      return OP.OP_HEIGHT
    case 'Inputs':
      return OP.OP_INPUTS
    case 'Outputs':
      return OP.OP_OUTPUTS
    case 'SelfBox':
      return OP.OP_SELF_BOX
    case 'MinerPubKey':
      return OP.OP_MINER_PUBKEY
    case 'GroupGenerator':
      return OP.OP_GROUP_GENERATOR
    default: {
      // Exhaustiveness: a new kind in `mir/types.ts` surfaces as a
      // compile-time error on this line.
      const _exhaust: never = kind
      throw new ExprSerializeError(
        `Unknown GlobalVars.kind: ${(_exhaust as { kind: string }).kind ?? String(_exhaust)}`,
        'unknown-variant'
      )
    }
  }
}

/**
 * Serialize a `GlobalVars` node. Writes only the opcode byte; the variant
 * has no payload. Centralized here so the `serializeExpr` dispatcher does
 * not need to know the kind→opcode mapping.
 */
export function serializeGlobalVars(e: GlobalVars, w: ByteWriter): void {
  w.writeU8(globalVarsOpcode(e.kind))
}
