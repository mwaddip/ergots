import { ByteReader, ByteWriter } from '@ergots/scorex'
import {
  parseAdditionalRegisters, parseSType, parseSValue, serializeSType, serializeSValue, type SType, type SValue,
} from '@ergots/ergoscript'
import { isWireCodecError } from './codec-errors'
import { decodeSValue } from './decode'
import { hexToBytes } from './hex'
import type { Json } from './json'

/** A SANTA binding node: an SValue, or `{kind:"Value", bytes_hex}` (runner contract §4). */
type JsonObj = { [k: string]: Json }

/** A context binding as ergots holds it. For a register read off the wire this is the reader's own
 *  entry, which keeps a Tuple-expression register's bytes in `opaqueBytes`. */
export interface Binding { tpe: SType; value: SValue; opaqueBytes?: Uint8Array }

/** ergots' context-extension reader (`parseContextExtension` in `@ergots/transaction`), when the pinned
 *  impl exports it from the package root; null when it does not. */
export type ExtensionReader = ((r: ByteReader) => { values: Map<number, { tpe: SType; value: SValue }> }) | null

/** ergots' own reader refused a `Value` binding's bytes: the entry is `errored`, because a node would
 *  reject the transaction (runner contract §4). */
export class BindingRefused extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BindingRefused'
  }
}

/** A `Value` at an extension position, and the pinned ergots exports no extension reader: the entry is
 *  `not-implemented`. It is never rebuilt from an SValue instead — the reader decides the value's shape. */
export class NoExtensionReader extends Error {
  constructor() {
    super('the pinned ergots exports no context-extension reader (parseContextExtension)')
    this.name = 'NoExtensionReader'
  }
}

/** `bytes` behind a `prefix` — the frame a reader for that position takes. */
function framed(prefix: number[], bytes: Uint8Array): Uint8Array {
  const f = new Uint8Array(prefix.length + bytes.length)
  f.set(prefix, 0)
  f.set(bytes, prefix.length)
  return f
}

/** Read `frame` whole with `read`. A typed codec refusal, or bytes left after the value, is the
 *  reader refusing the binding; any other throw is a runner defect and propagates to the panic-net. */
function readWhole<T>(frame: Uint8Array, read: (r: ByteReader) => T): T {
  const r = new ByteReader(frame)
  let out: T
  try {
    out = read(r)
  } catch (err) {
    if (isWireCodecError(err)) {
      throw new BindingRefused(`the reader refused the Value: ${(err as Error).message}`, { cause: err })
    }
    throw err
  }
  if (r.position !== frame.length) {
    throw new BindingRefused(`${frame.length - r.position} byte(s) left after the value`)
  }
  return out
}

/** A JSON binding (any SValue form), bound as ergots' OWN reader builds the value: decoded, written as a constant
 *  (its type, then its data) by ergots' writer and read back whole by its reader, at the entry's activated version
 *  for both script and tree. That is how the oracle binds it (`EvalCore.offTheWire`: `putValue` then `getValue` at
 *  `(activated, activated)`; runner contract §4), because a JSON-built value can differ from a node's (a
 *  collection's class, a collection of non-pair tuples' item type) and a script can see the difference. The data
 *  reader is used, not a register or extension reader, so rule 1019 does not apply: the corpus binds Option, Header
 *  and UnsignedBigInt values this way.
 *
 *  A failure here is NOT a refusal. A JSON form is the harness handing a function its input, and the oracle
 *  round-trips every committed one, so ergots' writer or reader failing on it propagates to runEntry's panic-net
 *  (`panicked`), as any JSON decode failure does. An `errored` would grade a reject row green for the wrong reason. */
export function jsonBinding(j: JsonObj, treeVersion: number, activated: number): Binding {
  const built = decodeSValue(j, treeVersion)
  const w = new ByteWriter()
  serializeSType(built.tpe, w)
  serializeSValue(built.tpe, built.value, activated, w)
  const bytes = w.toBytes()
  const r = new ByteReader(bytes)
  const tpe = parseSType(r, activated)
  const value = parseSValue(tpe, activated, r)
  if (r.position !== bytes.length) {
    throw new Error(`ergots read ${r.position} of the ${bytes.length} bytes it wrote for a JSON binding`)
  }
  return { tpe, value }
}

/** A binding at an extension position: var 1 (v2/v4 `input`), a v3 / v5 / full-context extension
 *  value. A `Value` is read by ergots' OWN extension reader, framed as the one-variable extension
 *  `01 01 <bytes>` — the count, then a dummy id: the binding's key is the vector's and the caller
 *  applies it, so a v5 key >= 0x80 still reaches the context the way the key-domain vectors need. */
export function extensionBinding(j: JsonObj, treeVersion: number, activated: number, readExt: ExtensionReader): Binding {
  if (j['kind'] !== 'Value') return jsonBinding(j, treeVersion, activated)
  if (!readExt) throw new NoExtensionReader()
  const ext = readWhole(framed([0x01, 0x01], hexToBytes(j['bytes_hex'] as string)), readExt)
  const v = ext.values.get(1)
  if (!v) throw new BindingRefused('the extension reader returned no variable')
  return v
}

/** A binding at a register position (`selfRegisters`). A `Value` is read by ergots' OWN register
 *  reader, `parseAdditionalRegisters`, framed as the one-register map `01 <bytes>` and read at the
 *  entry's activated version — as a node reads a box from block version 4 (runner contract §4). */
export function registerBinding(j: JsonObj, treeVersion: number, activated: number): Binding {
  if (j['kind'] !== 'Value') return jsonBinding(j, treeVersion, activated)
  const regs = readWhole(framed([0x01], hexToBytes(j['bytes_hex'] as string)),
    (r) => parseAdditionalRegisters(r, activated))
  const reg = regs[4]
  if (!reg) throw new BindingRefused('the register reader returned no R4')
  return reg
}
