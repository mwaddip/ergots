/**
 * sValueType — runtime SValue → SType derivation (v6 P5a Task 3).
 *
 * This helper is the complete version of the partial `inferSType` in coll-map.ts,
 * extended with Header and String arms needed by Global.serialize. Non-serializable
 * runtime kinds (Lambda/PreHeader/Context/Global) return SAny so serializeSValue throws.
 */

import { describe, expect, it } from 'vitest'
import { sValueType } from '../../src/eval/svalue-type'
import type { SType, SValue } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }

describe('sValueType — runtime value → SType', () => {
  it('scalars', () => {
    expect(sValueType({ kind: 'Int', value: 1 })).toEqual({ tag: 'SInt' })
    expect(sValueType({ kind: 'Long', value: 1n })).toEqual({ tag: 'SLong' })
    expect(sValueType({ kind: 'BigInt', value: 1n })).toEqual({ tag: 'SBigInt' })
    expect(sValueType({ kind: 'Boolean', value: true })).toEqual({ tag: 'SBoolean' })
    expect(sValueType({ kind: 'Byte', value: 0 })).toEqual({ tag: 'SByte' })
    expect(sValueType({ kind: 'Short', value: 0 })).toEqual({ tag: 'SShort' })
    expect(sValueType({ kind: 'UnsignedBigInt', value: 0n })).toEqual({ tag: 'SUnsignedBigInt' })
    expect(sValueType({ kind: 'Unit' })).toEqual({ tag: 'SUnit' })
    expect(sValueType({ kind: 'GroupElement', value: new Uint8Array(33) })).toEqual({ tag: 'SGroupElement' })
    expect(sValueType({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } })).toEqual({ tag: 'SSigmaProp' })
    expect(sValueType({ kind: 'Box', value: {} as never })).toEqual({ tag: 'SBox' })
    expect(sValueType({ kind: 'AvlTree', value: {} as never })).toEqual({ tag: 'SAvlTree' })
  })

  it('empty Coll keeps its carried elem type', () => {
    expect(sValueType({ kind: 'Coll', elem: SBYTE, items: [] })).toEqual({ tag: 'SColl', elem: SBYTE })
  })

  it('non-empty Coll keeps its carried elem type', () => {
    const sInt: SType = { tag: 'SInt' }
    expect(sValueType({ kind: 'Coll', elem: sInt, items: [{ kind: 'Int', value: 1 }] })).toEqual({ tag: 'SColl', elem: sInt })
  })

  it('Option keeps its carried elem type', () => {
    expect(sValueType({ kind: 'Option', elem: SBYTE, value: null })).toEqual({ tag: 'SOption', elem: SBYTE })
    expect(sValueType({ kind: 'Option', elem: SBYTE, value: { kind: 'Byte', value: 3 } })).toEqual({ tag: 'SOption', elem: SBYTE })
  })

  it('Tuple recurses per item', () => {
    expect(
      sValueType({ kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Long', value: 2n }] })
    ).toEqual({ tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SLong' }] })
  })

  it('Header → SHeader (needed by serialize; inferSType lacked this arm)', () => {
    const header: SValue = {
      kind: 'Header',
      value: {
        version: 2,
        id: new Uint8Array(32),
        parentId: new Uint8Array(32),
        adProofsRoot: new Uint8Array(32),
        stateRoot: new Uint8Array(33),
        transactionRoot: new Uint8Array(32),
        timestamp: 0,
        nBits: 0,
        height: 0,
        extensionRoot: new Uint8Array(32),
        autolykosSolution: {
          minerPk: new Uint8Array(33),
          powOnetimePk: null,
          nonce: new Uint8Array(8),
          powDistance: null,
        },
        votes: new Uint8Array(3),
        unparsedBytes: new Uint8Array(0),
      },
    }
    expect(sValueType(header)).toEqual({ tag: 'SHeader' })
  })

  it('String → SString (needed by serialize)', () => {
    expect(sValueType({ kind: 'String', value: 'hello' })).toEqual({ tag: 'SString' })
    expect(sValueType({ kind: 'String', value: '' })).toEqual({ tag: 'SString' })
  })

  it('non-serializable kinds return SAny (PreHeader/Context/Global/Lambda)', () => {
    expect(sValueType({ kind: 'PreHeader', value: {} as never })).toEqual({ tag: 'SAny' })
    expect(sValueType({ kind: 'Context' })).toEqual({ tag: 'SAny' })
    expect(sValueType({ kind: 'Global' })).toEqual({ tag: 'SAny' })
    expect(sValueType({ kind: 'Lambda', closure: {} as never })).toEqual({ tag: 'SAny' })
  })
})
