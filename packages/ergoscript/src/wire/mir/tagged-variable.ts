/**
 * TaggedVariable (opcode 0x71) — parse + serialize.
 *
 * Wire format (JVM `TaggedVariableSerializer.scala`):
 *
 *   [0x71] [varId: Byte] [tpe: SType]
 *
 * The JVM reads a signed Byte (`r.getByte()`) and a type under the tree's
 * version (`r.getType()`), then builds `TaggedVariableNode(varId, tpe)`
 * (`values.scala:455-460`). Its own apply is `@deprecated("Use ValUse /
 * GetVar; TaggedVariable is scheduled for retirement in v7.0", since =
 * "7.0.0")` — the kind has an announced end but parses today. The static
 * type of the node is the `tpe` read.
 *
 * ergots keeps the id as an unsigned byte in [0, 255], as `serializeGetVar`
 * does for its id: a hand-built MIR id outside that range throws
 * `ExprSerializeError('tagged-variable-id-out-of-range')` at the write.
 * The JVM's dispatch table keeps `TaggedVariableSerializer` for consensus
 * deserialization (`ValueSerializer.scala:97`); no evaluator arm runs.
 */

import type { ByteReader, ByteWriter } from '@ergots/scorex'
import type { TaggedVariable } from '../../mir/types'
import { ExprSerializeError } from '../errors'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'

/**
 * Parse a `TaggedVariable` payload (the opcode byte was consumed by the
 * dispatcher). Reads the one-byte id, then the SType, under the tree's
 * version (JVM `TaggedVariableSerializer.parse`).
 */
export function parseTaggedVariable(r: ByteReader, treeVersion: number): TaggedVariable {
  const varId = r.readU8()
  const tpe = parseSType(r, treeVersion)
  return { tag: 'TaggedVariable', varId, tpe }
}

/**
 * Serialize a `TaggedVariable` payload (the dispatcher writes the 0x71 opcode
 * byte). Writes the one-byte id, then the SType.
 */
export function serializeTaggedVariable(e: TaggedVariable, w: ByteWriter): void {
  if (!Number.isInteger(e.varId) || e.varId < 0 || e.varId > 255) {
    throw new ExprSerializeError(
      `TaggedVariable.varId ${e.varId} out of u8 range [0, 255]`,
      'tagged-variable-id-out-of-range',
    )
  }
  w.writeU8(e.varId)
  serializeSType(e.tpe, w)
}
