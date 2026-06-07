/**
 * ExtractRegisterAs arm — Box → Option[T], with type-assertion against
 * the expected element type. R0..R3 are mandatory registers synthesized
 * from box fields; R4..R9 are non-mandatory registers from the
 * additional_registers map.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_reg_as.rs:15-48
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]] memory).
 *
 * R0..R3 synthesis (sigma-rust `chain/ergo_box.rs:155-168`):
 *   R0: SLong(box.value) (signed-i64 view, F3.5)
 *   R1: SColl[SByte] of box.ergoTreeBytes
 *   R2: SColl[STuple[SColl[SByte], SLong]] of tokens (id × amount; amounts signed-i64 view, F3.5)
 *   R3: STuple[SInt, SColl[SByte]] of (creationHeight, txId ++ BE_u16(index))
 *
 * R4..R9: read box.registers[id]; if undefined, return Option None.
 *
 * Type-assertion: when entry exists and tpe ≠ elemTpe, sigma-rust THROWS
 * EvalError::UnexpectedValue (NOT returns None). Surfaced as typed code
 * 'register-type-mismatch' for programmatic dispatch (extract_reg_as.rs:41-44).
 *
 * New error codes introduced here:
 *   'register-id-out-of-range'  — registerId outside 0..=9
 *   'register-type-mismatch'    — register's stored tpe ≠ elemTpe
 */

import type { ErgoBox, ExtractRegisterAs, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { sTypeEquals } from '../mir/stype-helpers'
import { bytesToCollByteSValue } from './_byte-coll'
import { creationInfoTupleSValue, SINT, SCOLL_BYTE } from './_box-synthesis'

// Cost source: sigma-rust eval/extract_reg_as.rs:21 — ctx.add_jit_cost(50)
// Pattern A (envelope BEFORE eval-child).
const EXTRACT_REGISTER_AS_COST = 50

// Cached SType singletons for the mandatory register synthesis.
// Matches sigma-rust's `get_register` match arms.
// SINT and SCOLL_BYTE are imported from _box-synthesis (shared with ExtractCreationInfo).
const SLONG: SType = { tag: 'SLong' }
// R2: SColl[STuple[SColl[SByte], SLong]]
const STUPLE_COLLBYTE_LONG: SType = {
  tag: 'STuple',
  items: [SCOLL_BYTE, SLONG],
}
const SCOLL_TOKEN: SType = { tag: 'SColl', elem: STUPLE_COLLBYTE_LONG }
// R3: STuple[SInt, SColl[SByte]] — SINT and SCOLL_BYTE imported from _box-synthesis
const STUPLE_INT_COLLBYTE: SType = {
  tag: 'STuple',
  items: [SINT, SCOLL_BYTE],
}

/**
 * Build an SValue for R2: SColl[STuple[SColl[SByte], SLong]] from box.tokens.
 *
 * Mirrors sigma-rust `ergo_box.rs:171-176` `tokens_raw()` which returns
 * `Vec<(Vec<i8>, i64)>` — each element is (32-byte tokenId as signed bytes,
 * amount as i64). The token id is stored as a Uint8Array in TS.
 * Amounts surface as the signed-i64 view (F3.5).
 */
function tokensToCollTupleSValue(
  tokens: { id: Uint8Array; amount: bigint }[]
): SValue {
  const items: SValue[] = tokens.map((t) => ({
    kind: 'Tuple' as const,
    items: [
      bytesToCollByteSValue(t.id),
      { kind: 'Long' as const, value: BigInt.asIntN(64, t.amount) },
    ],
  }))
  return { kind: 'Coll', elem: STUPLE_COLLBYTE_LONG, items }
}

/**
 * Synthesize or look up a register entry for the given box and register id.
 *
 * R0..R3 are always present (synthesized from box fields).
 * R4..R9 are looked up in box.registers; returns undefined if absent.
 *
 * Mirrors sigma-rust `ErgoBox::get_register` (chain/ergo_box.rs:155-168).
 *
 * Exported since v6 P7a: shared with the SBox.getReg (99:19) MethodCall handler.
 */
export function getRegisterEntry(
  box: ErgoBox,
  id: number
): { tpe: SType; value: SValue } | undefined {
  switch (id) {
    case 0:
      // R0 → SLong(box.value) — signed-i64 view (JVM `as Long`; F3.5)
      return { tpe: SLONG, value: { kind: 'Long', value: BigInt.asIntN(64, box.value) } }
    case 1:
      // R1 → SColl[SByte] of box.ergoTreeBytes (script_bytes in sigma-rust)
      return {
        tpe: SCOLL_BYTE,
        value: bytesToCollByteSValue(box.ergoTreeBytes),
      }
    case 2:
      // R2 → SColl[STuple[SColl[SByte], SLong]] of tokens_raw
      return { tpe: SCOLL_TOKEN, value: tokensToCollTupleSValue(box.tokens) }
    case 3:
      // R3 → STuple[SInt, SColl[SByte]] of creation_info
      return {
        tpe: STUPLE_INT_COLLBYTE,
        value: creationInfoTupleSValue(box),
      }
    default:
      // R4..R9 → non-mandatory registers
      return box.registers[id]
  }
}

export function evalExtractRegisterAs(
  e: ExtractRegisterAs,
  env: Env,
  ctx: EvalContext
): SValue {
  // Pattern A: cost BEFORE eval-child.
  ctx.addCost(EXTRACT_REGISTER_AS_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractRegisterAs: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  // Validate register id: sigma-rust's RegisterId::try_from(i8) rejects < 0 or > 9.
  // Matches extract_reg_as.rs:27-33 (RegisterIdOutOfBounds).
  if (e.registerId < 0 || e.registerId > 9) {
    throw new EvalError(
      `ExtractRegisterAs: registerId ${e.registerId} is out of range (0..=9)`,
      'register-id-out-of-range'
    )
  }
  const entry = getRegisterEntry(input.value, e.registerId)
  if (entry === undefined) {
    // Absent non-mandatory register → Option(None).
    // Matches sigma-rust: None => Ok(Value::Opt(None)).
    return { kind: 'Option', elem: e.elemTpe, value: null }
  }
  // Type-assertion: if entry.tpe ≠ elemTpe, sigma-rust THROWS (not returns None).
  // Matches extract_reg_as.rs:39-44 (EvalError::UnexpectedValue).
  if (!sTypeEquals(entry.tpe, e.elemTpe)) {
    throw new EvalError(
      `ExtractRegisterAs: register R${e.registerId} type mismatch ` +
        `(expected ${e.elemTpe.tag}, got ${entry.tpe.tag})`,
      'register-type-mismatch'
    )
  }
  return { kind: 'Option', elem: e.elemTpe, value: entry.value }
}
