/** JVM count readers for the Expr grammar (sigma-state 6.0.6). All errors here are hard (not in the
 *  soft-fork degrade set): above the bound the JVM throws before reading on. */
import { ByteReader, readVlqU32 } from '@ergots/scorex'
import { ExprParseError } from '../errors'

/** safeNewArray's bound (core/.../sigma/util/package.scala:7-18). */
export const SAFE_NEW_ARRAY_MAX = 100000

/** getUIntExact (CoreByteReader.scala:73: getUInt, IAE above u32 → 'vlq-overflow'; toIntExact) then
 *  safeNewArray: above 100000 → `code`. */
export function readArrayCount(r: ByteReader, field: string, code: string): number {
  const n = readVlqU32(r, field)
  if (n > SAFE_NEW_ARRAY_MAX) {
    throw new ExprParseError(`${field} ${n} exceeds ${SAFE_NEW_ARRAY_MAX} (JVM safeNewArray)`, code)
  }
  return n
}

/** getUShort (scorex-util 0.2.1 VLQReader.scala:30-34): above 0xFFFF → `code`. The
 *  getULong().toInt-before-the-check quirk is a tracked follow-up. */
export function readUShortCount(r: ByteReader, field: string, code: string): number {
  const n = r.readVlqU()
  if (n > 0xffff) {
    throw new ExprParseError(`${field} ${n} exceeds 0xFFFF (JVM getUShort)`, code)
  }
  return n
}
