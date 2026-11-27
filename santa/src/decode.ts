import type { SType, SValue } from '@ergots/ergoscript'
import { parseSValue, tupleColl } from '@ergots/ergoscript'
import { ByteReader } from '@ergots/scorex'
import { hexToBytes } from './hex'
import { stypeFromSanta } from './stype'
import type { Json } from './json'

/** A SANTA canonical-JSON object node (an SValue or SType). */
type JsonObj = { [k: string]: Json }

export interface Decoded { value: SValue; tpe: SType }

/** SANTA canonical JSON → ergots SValue + its SType (the tpe needed for the
 *  ctx var-1 binding). Inverse of encodeSValue. The kind set is total over the corpus
 *  (UnsignedBigInt bridged since ergots shipped UBI); an unknown kind throws → the
 *  runner's panic-net (runner-contract §3). The `activated` argument is set on the reader
 *  for the `Box`/`Header` arms, so a nested Box constant's tree is gated as a node reads
 *  it (ergo `EvalCore.scala:618-623`: a JSON Box binding is parsed under (activated,
 *  activated)); other arms do not read a tree. `activated` defaults to the tree version
 *  for callers outside the extension/register bindings, where the two match. */
export function decodeSValue(j: JsonObj, treeVersion: number, activated: number = treeVersion): Decoded {
  const kind = j['kind'] as string
  switch (kind) {
    case 'Boolean': return { value: { kind: 'Boolean', value: j['value'] as boolean }, tpe: { tag: 'SBoolean' } }
    case 'Byte': return { value: { kind: 'Byte', value: j['value'] as number }, tpe: { tag: 'SByte' } }
    case 'Short': return { value: { kind: 'Short', value: j['value'] as number }, tpe: { tag: 'SShort' } }
    case 'Int': return { value: { kind: 'Int', value: j['value'] as number }, tpe: { tag: 'SInt' } }
    case 'Long': return { value: { kind: 'Long', value: BigInt(j['value'] as string) }, tpe: { tag: 'SLong' } }
    case 'BigInt': return { value: { kind: 'BigInt', value: BigInt(j['value'] as string) }, tpe: { tag: 'SBigInt' } }
    case 'UnsignedBigInt':
      return { value: { kind: 'UnsignedBigInt', value: BigInt(j['value'] as string) }, tpe: { tag: 'SUnsignedBigInt' } }
    case 'GroupElement':
      return { value: { kind: 'GroupElement', value: hexToBytes(j['bytes_hex'] as string) }, tpe: { tag: 'SGroupElement' } }
    case 'Box': return parseBytesKind({ tag: 'SBox' }, j['bytes_hex'] as string, treeVersion, activated)
    case 'Header': return parseBytesKind({ tag: 'SHeader' }, j['bytes_hex'] as string, treeVersion, activated)
    case 'AvlTree': return parseBytesKind({ tag: 'SAvlTree' }, j['bytes_hex'] as string, treeVersion, activated)
    case 'SigmaProp': return parseBytesKind({ tag: 'SSigmaProp' }, j['raw_hex'] as string, treeVersion, activated)
    case 'Coll': {
      const elem = stypeFromSanta(j['elem'] as JsonObj)
      const items = (j['items'] as JsonObj[]).map((i) => decodeSValue(i, treeVersion, activated).value)
      return { value: { kind: 'Coll', elem, items }, tpe: { tag: 'SColl', elem } }
    }
    case 'Coll[Byte]': {
      // compact byte-collection form (runner contract §2): value_hex, semantically
      // identical to Coll/SByte per-item — exists for large byte payloads (the SBox
      // token-window family carries >4KB box bytes as context input)
      const bytes = hexToBytes(j['value_hex'] as string)
      const items = Array.from(bytes, (b) => ({ kind: 'Byte', value: b > 127 ? b - 256 : b }) as SValue)
      return {
        value: { kind: 'Coll', elem: { tag: 'SByte' }, items },
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
      }
    }
    case 'Tuple': {
      // A pair is a pair; a tuple of any other arity is a Coll[Any] (runner contract §4), built with ergots'
      // `tupleColl`: its readers tell such a collection by the IDENTITY of its elem object, so an equal literal
      // `{ kind: 'Coll', elem: { tag: 'SAny' } }` would not be one. The binding type stays the STuple.
      const decoded = (j['items'] as JsonObj[]).map((i) => decodeSValue(i, treeVersion, activated))
      const items = decoded.map((d) => d.value)
      return {
        value: items.length === 2 ? { kind: 'Tuple', items } : tupleColl(items),
        tpe: { tag: 'STuple', items: decoded.map((d) => d.tpe) },
      }
    }
    case 'Option': {
      if (j['value'] === null) {
        // None carries no inner value, so its element type is unrecoverable from
        // JSON alone. The covered corpus has no None-typed Option INPUT (Options
        // appear as results, where decode is not invoked); a future surface needs
        // the elem recovered from the parsed tree's arg type.
        throw new Error('decode: None-Option input has no recoverable elem (unexpected in corpus)')
      }
      const inner = decodeSValue(j['value'] as JsonObj, treeVersion, activated)
      return { value: { kind: 'Option', elem: inner.tpe, value: inner.value }, tpe: { tag: 'SOption', elem: inner.tpe } }
    }
    default:
      throw new Error(`decode: unknown SANTA SValue kind '${kind}'`)
  }
}

function parseBytesKind(tpe: SType, hex: string, treeVersion: number, activated: number): Decoded {
  const r = new ByteReader(hexToBytes(hex))
  r.activatedVersion = activated
  const value = parseSValue(tpe, treeVersion, r)
  return { value, tpe }
}
