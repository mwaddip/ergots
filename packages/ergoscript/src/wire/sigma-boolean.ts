/**
 * SigmaBoolean wire-format reader/writer (phase 2g-medium structural refactor).
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
 *         ATLEAST          (0x98) → u16(VLQ) k + u16(VLQ) items_count + items × sigma_boolean
 *         TRIVIAL_PROP_F   (0xd2) → ε
 *         TRIVIAL_PROP_T   (0xd3) → ε
 *       }
 *
 * Phase 2g-medium replaces the opaque `{ raw: Uint8Array }` shape from 2a with
 * a full recursive parser/serializer. Round-trip invariant unchanged:
 * `serializeSigmaBoolean(parseSigmaBoolean(r)) === original bytes`.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/sigmaboolean.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cand.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cor.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cthreshold.rs
 */

import type { SigmaBoolean } from '../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { canonicalGePayload } from './_ge-canonical'

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
 * Thrown by `serializeSigmaBoolean` for malformed structural inputs.
 *
 * Error codes:
 *  - 'ec-point-length'            — ProveDlog.h or ProveDhTuple.{g,h,u,v} length ≠ 33 bytes
 *  - 'arity-out-of-range'         — Cand/Cor/Cthreshold items.length out of [1, 0xffff]
 *  - 'cthreshold-k-out-of-range'  — Cthreshold k out of [1, items.length] or > 0xff
 *  - 'unreachable'                — exhaustiveness guard fired (should never happen in practice)
 */
export class SigmaBooleanSerializeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'SigmaBooleanSerializeError'
  }
}

/**
 * Parse a SigmaBoolean from `r`, returning a structural discriminated union.
 * Recursive on conjectures.
 *
 * Error codes:
 *  - 'unknown-opcode'                — opcode byte not in the sigma table
 *  - 'arity-out-of-range'            — items_count > u16 max
 *  - 'cthreshold-k-out-of-range'     — k outside [1, items.length]
 *  - 'sigma-conjecture-empty-items'  — items.length < 1 (BoundedVec lower bound)
 *  - 'ec-point-invalid'              — ProveDlog.h or ProveDhTuple.{g,h,u,v} is not a
 *                                      valid curve point (F5 batch 4: leaves get the
 *                                      same validate+normalize as the SValue GE arm;
 *                                      sibling of the serialize-side 'ec-point-length')
 *
 * Source: ergotree-ir/src/serialization/sigmaboolean.rs
 */
export function parseSigmaBoolean(r: ByteReader): SigmaBoolean {
  // MaxTreeDepth bound (consensus) — this is the SigmaBoolean increment point of
  // the JVM's single shared `r.level` counter (`SigmaBoolean.serializer.parse`,
  // `SigmaBoolean.scala:71-104`: `r.level = depth + 1` on entry, `- 1` on exit).
  // It shares the same reader-level counter as the expr-node parser (`parseExpr`)
  // and data parser (`parseSValue`), so a conjecture tree reached via
  // `parseSValue(SSigmaProp)` continues the whole-tree depth budget. The level is
  // lowered only on a normal return, as the JVM's `r.level = r.level - 1` is (no
  // finally, SigmaBoolean.scala:103): a throw that a soft-fork degrade catches leaves
  // it raised (facts/ergoscript-wire.md, "Reader depth after a degrade").
  r.enterDepth()
  const sb = parseSigmaBooleanBody(r)
  r.exitDepth()
  return sb
}

/**
 * Body of {@link parseSigmaBoolean}, run inside the reader-level depth guard.
 * Separated so the single enter/exit pair wraps every dispatch arm.
 */
function parseSigmaBooleanBody(r: ByteReader): SigmaBoolean {
  const op = r.readU8()
  switch (op) {
    case OP_TRIVIAL_PROP_FALSE: return { tag: 'TrivialProp', value: false }
    case OP_TRIVIAL_PROP_TRUE:  return { tag: 'TrivialProp', value: true }
    case OP_PROVE_DLOG: {
      // 33-byte EcPoint, validated + normalized per the GE canonical-bytes
      // invariant (F5 batch 4): the JVM parses these leaves through the same
      // GroupElementSerializer as GE data values — SigmaBoolean.scala:36-44
      // (serializer wiring) and :71-80 (parse dispatch),
      // core/shared/src/main/scala/sigma/data/SigmaBoolean.scala. So 0x00-lead
      // → canonical 33-zero identity (tail discarded); invalid non-0x00-lead
      // → throw.
      const h = canonicalGePayload(r.readBytes(33).slice(), (cause) =>
        new SigmaBooleanParseError(
          `ProveDlog.h is not a valid curve point: ${cause}`,
          'ec-point-invalid',
        ))
      return { tag: 'ProveDlog', h }
    }
    case OP_PROVE_DH_TUPLE: {
      // 4 × 33-byte EcPoint = g, h, u, v — each through the same
      // GroupElementSerializer-equivalent validate+normalize as ProveDlog.h
      // (JVM SigmaBoolean.scala:36-44,71-80 via ProveDHTupleSerializer).
      const readLeg = (name: string): Uint8Array =>
        canonicalGePayload(r.readBytes(33).slice(), (cause) =>
          new SigmaBooleanParseError(
            `ProveDhTuple.${name} is not a valid curve point: ${cause}`,
            'ec-point-invalid',
          ))
      const g = readLeg('g')
      const h = readLeg('h')
      const u = readLeg('u')
      const v = readLeg('v')
      return { tag: 'ProveDhTuple', g, h, u, v }
    }
    case OP_AND:
    case OP_OR: {
      // sigma-rust cand.rs:67-69 / cor.rs:67-69: put_u16(items_count as u16), VLQ on wire.
      const count = r.readVlqU()
      if (count > 0xffff) {
        throw new SigmaBooleanParseError(
          `SigmaConjecture items_count ${count} exceeds u16 bound`,
          'arity-out-of-range'
        )
      }
      if (count < 1) {
        throw new SigmaBooleanParseError(
          `SigmaConjecture must have at least 1 item, got ${count}`,
          'sigma-conjecture-empty-items'
        )
      }
      const items: SigmaBoolean[] = []
      for (let i = 0; i < count; i++) items.push(parseSigmaBoolean(r))
      return { tag: op === OP_AND ? 'Cand' : 'Cor', items }
    }
    case OP_ATLEAST: {
      // JVM SigmaBoolean.serializer.parse (core/.../sigma/data/SigmaBoolean.scala:94-100): k, then
      // n, each a getUShort (hard above 0xFFFF, as it is read) — sigma-rust cthreshold.rs:108-111
      // writes the same pair as put_u16, VLQ on wire. Only then does the JVM read the n children;
      // only after that does CTHRESHOLD(k, children)'s constructor run its require (:223),
      // `k >= 0 && k <= children.length && children.length <= 255`.
      const k = r.readVlqU()
      if (k > 0xffff) {
        throw new SigmaBooleanParseError(`Cthreshold k=${k} exceeds u16 bound`, 'cthreshold-k-out-of-range')
      }
      const count = r.readVlqU()
      if (count > 0xffff) {
        throw new SigmaBooleanParseError(
          `Cthreshold items_count ${count} exceeds u16 bound`,
          'arity-out-of-range'
        )
      }
      // Stricter than the JVM (which accepts n = 0): items.length < 1 has no JVM analogue in the
      // require — it's ergots' own BoundedVec-style lower bound. It stays here, before the children,
      // because with n = 0 there are no children to read, so its position makes no difference.
      if (count < 1) {
        throw new SigmaBooleanParseError(
          `Cthreshold must have at least 1 item, got ${count}`,
          'sigma-conjecture-empty-items'
        )
      }
      const items: SigmaBoolean[] = []
      for (let i = 0; i < count; i++) items.push(parseSigmaBoolean(r))
      // Stricter than the JVM (which accepts k = 0, `require(k >= 0 …)`); a tracked follow-up
      // (verifier semantics for empty/trivial conjectures). Checked AFTER the children, not before:
      // an early ergots-only reject here would pre-empt a window error a child read would otherwise
      // hit first, widening this divergence into a sized tree's window cases too — the JVM's own
      // require runs only after the children (the CTHRESHOLD constructor is called with the
      // already-read children array), so this ordering meets the same reader state the JVM does.
      if (k < 1) {
        throw new SigmaBooleanParseError(`Cthreshold k=${k} below 1`, 'cthreshold-k-out-of-range')
      }
      if (k > count) {
        throw new SigmaBooleanParseError(`Cthreshold k=${k} exceeds n=${count}`, 'cthreshold-k-out-of-range')
      }
      if (count > 255) {
        throw new SigmaBooleanParseError(`Cthreshold has ${count} children, more than 255`, 'arity-out-of-range')
      }
      return { tag: 'Cthreshold', k, items }
    }
    default:
      throw new SigmaBooleanParseError(
        `unknown SigmaBoolean opcode 0x${op.toString(16).padStart(2, '0')}`,
        'unknown-opcode'
      )
  }
}

/**
 * Serialize a SigmaBoolean to `w`. Dual of `parseSigmaBoolean`.
 * Round-trip invariant: `serializeSigmaBoolean(parseSigmaBoolean(bytes)) === bytes` (byte-equal).
 *
 * Source: ergotree-ir/src/serialization/sigmaboolean.rs
 */
export function serializeSigmaBoolean(sb: SigmaBoolean, w: ByteWriter): void {
  switch (sb.tag) {
    case 'TrivialProp':
      w.writeU8(sb.value ? OP_TRIVIAL_PROP_TRUE : OP_TRIVIAL_PROP_FALSE)
      return
    case 'ProveDlog':
      if (sb.h.length !== 33) {
        throw new SigmaBooleanSerializeError(
          `ProveDlog.h length=${sb.h.length}, expected 33`,
          'ec-point-length'
        )
      }
      w.writeU8(OP_PROVE_DLOG)
      w.writeBytes(sb.h)
      return
    case 'ProveDhTuple':
      for (const [name, p] of [['g', sb.g], ['h', sb.h], ['u', sb.u], ['v', sb.v]] as const) {
        if (p.length !== 33) {
          throw new SigmaBooleanSerializeError(
            `ProveDhTuple.${name} length=${p.length}, expected 33`,
            'ec-point-length'
          )
        }
      }
      w.writeU8(OP_PROVE_DH_TUPLE)
      w.writeBytes(sb.g)
      w.writeBytes(sb.h)
      w.writeBytes(sb.u)
      w.writeBytes(sb.v)
      return
    case 'Cand':
    case 'Cor':
      if (sb.items.length < 1 || sb.items.length > 0xffff) {
        throw new SigmaBooleanSerializeError(
          `SigmaConjecture items.length=${sb.items.length} out of range`,
          'arity-out-of-range'
        )
      }
      w.writeU8(sb.tag === 'Cand' ? OP_AND : OP_OR)
      w.writeVlqU(sb.items.length)
      for (const item of sb.items) serializeSigmaBoolean(item, w)
      return
    case 'Cthreshold':
      if (sb.items.length < 1 || sb.items.length > 0xffff) {
        throw new SigmaBooleanSerializeError(
          `Cthreshold items.length=${sb.items.length} out of range`,
          'arity-out-of-range'
        )
      }
      if (sb.k < 1 || sb.k > sb.items.length || sb.k > 0xff) {
        throw new SigmaBooleanSerializeError(
          `Cthreshold k=${sb.k} out of range`,
          'cthreshold-k-out-of-range'
        )
      }
      w.writeU8(OP_ATLEAST)
      w.writeVlqU(sb.k)
      w.writeVlqU(sb.items.length)
      for (const item of sb.items) serializeSigmaBoolean(item, w)
      return
    default: {
      const _exhaust: never = sb
      throw new SigmaBooleanSerializeError(
        `unreachable: ${JSON.stringify(_exhaust)}`,
        'unreachable'
      )
    }
  }
}

/**
 * Convenience: returns the 33-byte public key if `sb` is a ProveDlog leaf, else null.
 * Defensive copy.
 */
export function proveDlogPublicKey(sb: SigmaBoolean): Uint8Array | null {
  return sb.tag === 'ProveDlog' ? sb.h.slice() : null
}
