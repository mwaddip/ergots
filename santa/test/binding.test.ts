import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import {
  parseSType, parseSValue, serializeSType, serializeSValue, tupleColl, type SType, type SValue,
} from '@ergots/ergoscript'
import {
  extensionBinding, jsonBinding, registerBinding, BindingRefused, NoExtensionReader, type ExtensionReader,
} from '../src/binding'
import { decodeSValue } from '../src/decode'
import { bytesToHex } from '../src/hex'
import { runEntry } from '../src/runner'

/** A constant's bytes as a node would carry them: its type, then its data. */
function constHex(tpe: SType, value: SValue): string {
  const w = new ByteWriter()
  serializeSType(tpe, w)
  serializeSValue(tpe, value, 3, w)
  return bytesToHex(w.toBytes())
}
const valueJson = (hex: string) => ({ kind: 'Value', bytes_hex: hex })
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }

// A stand-in for ergots' extension reader: the same wire grammar (a count byte, then per variable an
// id byte, its type and its data). It checks the adapter's framing and its leftover-bytes rule, and
// reads type and data at the tree version the adapter passes.
const standInReader: ExtensionReader = (r: ByteReader, treeVersion: number) => {
  const n = r.readU8()
  const values = new Map<number, { tpe: SType; value: SValue }>()
  for (let i = 0; i < n; i++) {
    const id = r.readU8()
    const tpe = parseSType(r, treeVersion)
    values.set(id, { tpe, value: parseSValue(tpe, treeVersion, r) })
  }
  return { values }
}

describe('Value binding at an extension position (var 1, v3/v5/full-context extensions)', () => {
  it('is read by the extension reader and equals the JSON form of the same value', () => {
    const j0 = { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }] }
    const j = decodeSValue(j0, 3)
    expect(extensionBinding(valueJson(constHex(j.tpe, j.value)), 3, 3, standInReader)).toEqual(jsonBinding(j0, 3, 3))
  })
  it('an SValue still goes through the JSON decoder', () => {
    expect(extensionBinding({ kind: 'Int', value: 7 }, 3, 3, null)).toEqual(decodeSValue({ kind: 'Int', value: 7 }, 3))
  })
  it('bytes left after the value are refused', () => {
    expect(() => extensionBinding(valueJson(constHex(SINT, { kind: 'Int', value: 7 }) + '00'), 3, 3, standInReader))
      .toThrow(BindingRefused)
  })
  it('without an extension reader in the impl it is not-implemented, never rebuilt from an SValue', () => {
    expect(() => extensionBinding(valueJson(constHex(SINT, { kind: 'Int', value: 7 })), 3, 3, null))
      .toThrow(NoExtensionReader)
  })
})

describe('Value binding at a register position (selfRegisters)', () => {
  it("is read by ergots' parseAdditionalRegisters and equals the JSON form of the same value", () => {
    const j = decodeSValue({ kind: 'Long', value: '7' }, 3)
    expect(registerBinding(valueJson(constHex(j.tpe, j.value)), 3, 3)).toEqual(j)
  })
  it('rule 1019: an UnsignedBigInt is refused, as the JVM register reader refuses it', () => {
    const ubi = constHex({ tag: 'SUnsignedBigInt' }, { kind: 'UnsignedBigInt', value: 1n })
    expect(() => registerBinding(valueJson(ubi), 3, 3)).toThrow(BindingRefused)
  })
  it('bytes left after the value are refused', () => {
    expect(() => registerBinding(valueJson(constHex(SLONG, { kind: 'Long', value: 7n }) + '00'), 3, 3))
      .toThrow(BindingRefused)
  })
})

// A JSON binding is bound the way ergots' OWN reader builds the value, as the oracle binds it (EvalCore.offTheWire:
// written as a constant, read back by the value reader, at the entry's activated version): a JSON-built value can
// differ from a node's (a collection's class, a collection of non-pair tuples' item type), and a script can see it.
describe('a JSON binding goes through ergots\' own writer and reader', () => {
  const collInt = { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }] }
  const readerClass = { shape: 'array', specialised: false, array: 'int' }
  it('a Coll[Int] at an extension position carries the class the reader gives it (no extension reader needed)', () => {
    expect((extensionBinding(collInt, 3, 3, null).value as { cls?: unknown }).cls).toEqual(readerClass)
  })
  it('the same at a register position', () => {
    expect((registerBinding(collInt, 3, 3).value as { cls?: unknown }).cls).toEqual(readerClass)
  })
  it("a Coll of non-pair tuples gets the data reader's item type Coll[Any], each item a tuple collection", () => {
    const t3 = { kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }, { kind: 'Int', value: 3 }] }
    const tt = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }, { tag: 'SInt' }] }
    const b = jsonBinding({ kind: 'Coll', elem: tt, items: [t3] }, 3, 3)
    expect(b.tpe).toEqual({ tag: 'SColl', elem: tt })
    const v = b.value as { elem: unknown; items: { elem: unknown }[] }
    expect(v.elem).toEqual({ tag: 'SColl', elem: { tag: 'SAny' } })
    expect(v.items[0].elem).toBe(tupleColl([]).elem)
  })
  it('a pair stays a pair, and a scalar is unchanged', () => {
    const pair = { kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Long', value: '2' }] }
    expect(jsonBinding(pair, 3, 3)).toEqual(decodeSValue(pair, 3))
    expect(jsonBinding({ kind: 'Long', value: '7' }, 3, 3)).toEqual(decodeSValue({ kind: 'Long', value: '7' }, 3))
  })
  it('a value ergots cannot write or read back is NOT a refusal: it reaches the panic-net, as any JSON decode failure does', () => {
    // a JSON form is the harness handing a function its input; the oracle round-trips every committed one, so a
    // failure here is ergots' codec, and an `errored` would grade a reject row green for the wrong reason
    let err: unknown
    try { jsonBinding({ kind: 'Option', value: { kind: 'Int', value: 1 } }, 2, 2) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err).not.toBeInstanceOf(BindingRefused)
  })
})

// Box.getReg_dynamic_index accept-r4-long#0 (committed): SELF.getReg[Long](var 1) with R4 = Long 7.
const getRegEntry = {
  name: 'accept-r4-long#0',
  tree_bytes_hex: '1b0b00dc6313a701e4e3010405',
  input: { kind: 'Int', value: 4 } as Record<string, unknown>,
  selfRegisters: { '4': { kind: 'Long', value: '7' } } as Record<string, unknown>,
  version: { activated: 3, ergoTree: 3 },
}
const blessed = { value: { kind: 'Option', value: { kind: 'Long', value: '7' } }, cost: 89, error: null }

describe('runEntry with Value bindings', () => {
  it('a register Value gives the same verdict as its JSON form', () => {
    const e = { ...getRegEntry, selfRegisters: { '4': valueJson(constHex(SLONG, { kind: 'Long', value: 7n })) } }
    expect(runEntry('santa-eval/v4', e as never)).toEqual(blessed)
  })
  it('a register Value the reader refuses is errored', () => {
    const e = { ...getRegEntry, selfRegisters: { '4': valueJson(constHex(SLONG, { kind: 'Long', value: 7n }) + '00') } }
    expect(runEntry('santa-eval/v4', e as never).error).toBe('errored')
  })
  it('a var-1 Value is read by the extension reader when the impl provides one', () => {
    const e = { ...getRegEntry, input: valueJson(constHex(SINT, { kind: 'Int', value: 4 })) }
    expect(runEntry('santa-eval/v4', e as never, standInReader)).toEqual(blessed)
  })
  it('a var-1 Value is not-implemented when the impl has no extension reader', () => {
    const e = { ...getRegEntry, input: valueJson(constHex(SINT, { kind: 'Int', value: 4 })) }
    expect(runEntry('santa-eval/v4', e as never, null).error).toBe('not-implemented')
  })
})
