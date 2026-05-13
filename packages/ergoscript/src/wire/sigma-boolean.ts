/**
 * SigmaBoolean wire-format reader/writer.
 *
 * SigmaBoolean is the recursive proposition tree used inside `SSigmaProp`
 * constants. On the wire (sigma-rust `serialization/sigmaboolean.rs:17-65`):
 *
 *   sigma_boolean = op_code:u8
 *     + match op_code {
 *         PROVE_DLOG       (0xcd) → ec_point[33]
 *         PROVE_DH_TUPLE   (0xce) → ec_point[33] × 4 (g, h, u, v)
 *         AND              (0x96) → u16(VLQ) items_count + items_count × sigma_boolean
 *         OR               (0x97) → u16(VLQ) items_count + items_count × sigma_boolean
 *         ATLEAST          (0x98) → u32(VLQ) k + u16(VLQ) items_count + items × sigma_boolean
 *         TRIVIAL_PROP_F   (0xd2) → ε
 *         TRIVIAL_PROP_T   (0xd3) → ε
 *       }
 *
 * Phase 2a stores the parsed tree as opaque `raw: Uint8Array` (a slice of
 * the input covering exactly the consumed bytes); the structural decode
 * is used only to determine the length. This is enough for the address
 * round-trip path (the canonical P2PK ErgoTree body is
 * `Const(SSigmaProp, ProveDlog(EcPoint))` — a fixed 34-byte payload).
 *
 * AND/OR/ATLEAST conjectures and ProveDhTuple are parsed structurally to
 * the same opaque-bytes representation; the serializer just emits the
 * stored slice. Round-trip correctness reduces to "read the right number
 * of bytes." If we ever need structural access to the tree (e.g. for
 * sigma-protocol evaluation in a later phase), the `raw` byte slice can
 * be re-parsed at that point.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/sigmaboolean.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cand.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cor.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cthreshold.rs
 */

import type { SigmaBoolean } from '../mir/types'
import { ByteReader, ReaderError } from './reader'

// Sigma-protocol opcodes (single byte). Same value space as the top-level
// MIR opcode table — these are part of a unified opcode namespace.
const OP_AND = 0x96
const OP_OR = 0x97
const OP_ATLEAST = 0x98
const OP_PROVE_DLOG = 0xcd
const OP_PROVE_DH_TUPLE = 0xce
const OP_TRIVIAL_PROP_FALSE = 0xd2
const OP_TRIVIAL_PROP_TRUE = 0xd3

export class SigmaBooleanParseError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'SigmaBooleanParseError'
  }
}

/**
 * Parse a single SigmaBoolean from `r` and return its raw byte slice.
 *
 * The returned `raw` is a defensive copy of the consumed range —
 * callers can stash it past the reader's lifetime without worrying
 * about underlying-buffer reuse.
 *
 * The cursor is advanced past the SigmaBoolean. Any structural malformation
 * (truncation, unknown opcode, oversized arity) throws
 * `SigmaBooleanParseError` or `ReaderError` from the underlying reader.
 */
export function parseSigmaBoolean(r: ByteReader): SigmaBoolean {
  const start = r.position
  consumeSigmaBoolean(r)
  const end = r.position
  // Defensive copy via `.slice()` — `r.slice(start, end)` returns a view
  // into the reader's underlying buffer and we don't want callers to
  // observe mutations of that buffer (or to retain a reference that
  // pins more memory than needed).
  return { raw: r.slice(start, end).slice() }
}

/**
 * Advance the reader past one SigmaBoolean, validating that the bytes
 * are well-formed enough to know the length. Used by `parseSigmaBoolean`
 * (which then rewinds and captures the consumed range).
 */
function consumeSigmaBoolean(r: ByteReader): void {
  const op = r.readU8()
  switch (op) {
    case OP_PROVE_DLOG:
      // 33-byte EcPoint (compressed SEC1 or identity-zeros).
      r.readBytes(33)
      return
    case OP_PROVE_DH_TUPLE:
      // 4 × 33-byte EcPoint = 132 bytes.
      r.readBytes(132)
      return
    case OP_TRIVIAL_PROP_FALSE:
    case OP_TRIVIAL_PROP_TRUE:
      // 0-byte payload.
      return
    case OP_AND:
    case OP_OR: {
      // VLQ items_count, then `items_count` × sigma_boolean.
      const count = r.readVlqU()
      if (count > 0xffff) {
        throw new SigmaBooleanParseError(
          `SigmaConjecture items_count ${count} exceeds u16 bound`,
          'arity-out-of-range'
        )
      }
      for (let i = 0; i < count; i++) consumeSigmaBoolean(r)
      return
    }
    case OP_ATLEAST: {
      // VLQ-u32 k, then VLQ-u16 items_count, then items.
      // (sigma-rust's Cthreshold uses `r.get_u32()` for k and `r.get_u16()`
      // for items_count; both VLQ-encoded under put_u32/put_u16.)
      r.readVlqU() // k
      const count = r.readVlqU()
      if (count > 0xffff) {
        throw new SigmaBooleanParseError(
          `Cthreshold items_count ${count} exceeds u16 bound`,
          'arity-out-of-range'
        )
      }
      for (let i = 0; i < count; i++) consumeSigmaBoolean(r)
      return
    }
    default:
      throw new SigmaBooleanParseError(
        `unknown SigmaBoolean opcode 0x${op.toString(16).padStart(2, '0')}`,
        'unknown-opcode'
      )
  }
}

/**
 * Read the opcode byte from a SigmaBoolean's raw payload without
 * advancing any reader state. Useful for shape checks (e.g. "is this
 * a P2PK ProveDlog?") without re-parsing.
 *
 * Returns `null` if `raw` is empty.
 */
export function sigmaBooleanOpCode(sb: SigmaBoolean): number | null {
  if (sb.raw.length === 0) return null
  return sb.raw[0]!
}

/**
 * If `sb` is a `ProveDlog`, return the 33-byte compressed public key.
 * Otherwise return `null`. Does not copy — callers should `.slice()` if
 * mutation safety matters.
 */
export function proveDlogPublicKey(sb: SigmaBoolean): Uint8Array | null {
  if (sb.raw.length !== 34) return null
  if (sb.raw[0] !== OP_PROVE_DLOG) return null
  return sb.raw.subarray(1, 34)
}

export {
  OP_PROVE_DLOG as SIGMA_OP_PROVE_DLOG,
  OP_PROVE_DH_TUPLE as SIGMA_OP_PROVE_DH_TUPLE,
  OP_TRIVIAL_PROP_FALSE as SIGMA_OP_TRIVIAL_PROP_FALSE,
  OP_TRIVIAL_PROP_TRUE as SIGMA_OP_TRIVIAL_PROP_TRUE,
  OP_AND as SIGMA_OP_AND,
  OP_OR as SIGMA_OP_OR,
  OP_ATLEAST as SIGMA_OP_ATLEAST
}

// Re-export ReaderError so callers that need to discriminate errors can.
export { ReaderError }
