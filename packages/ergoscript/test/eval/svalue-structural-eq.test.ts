import { describe, expect, it } from 'vitest'
import { sValueEquals, sValueStructuralEq } from '../../src/eval/bin-op/relation'
import { makeContext } from '../../src/eval/eval-context'
import type { SValue, SType } from '../../src/mir/types'

const SLONG: SType = { tag: 'SLong' }
const L = (v: number): SValue => ({ kind: 'Long', value: BigInt(v) })
const coll = (items: SValue[], elem: SType = SLONG): SValue => ({ kind: 'Coll', elem, items })

describe('sValueStructuralEq — cost-free structural equality', () => {
  it('matches sValueEquals booleans across kinds (corpus agreement)', () => {
    const pairs: [SValue, SValue][] = [
      [L(1), L(1)], [L(1), L(2)],
      [{ kind: 'Int', value: 5 }, { kind: 'Int', value: 5 }],
      [{ kind: 'Boolean', value: true }, { kind: 'Boolean', value: false }],
      [{ kind: 'BigInt', value: 7n }, { kind: 'BigInt', value: 7n }],
      [coll([L(1), L(2)]), coll([L(1), L(2)])],
      [coll([L(1), L(2)]), coll([L(1), L(3)])],
      [coll([L(1)]), coll([L(1), L(2)])], // length mismatch
      [{ kind: 'Tuple', items: [L(1), { kind: 'Int', value: 2 }] }, { kind: 'Tuple', items: [L(1), { kind: 'Int', value: 2 }] }],
      [{ kind: 'Option', elem: SLONG, value: L(1) }, { kind: 'Option', elem: SLONG, value: L(1) }],
      [{ kind: 'Option', elem: SLONG, value: null }, { kind: 'Option', elem: SLONG, value: null }],
      [L(1), { kind: 'Int', value: 1 }], // cross-kind → false
      [coll([coll([L(1)])], { tag: 'SColl', elem: SLONG }), coll([coll([L(1)])], { tag: 'SColl', elem: SLONG })], // nested
      // coa-path (recurseElems=false): Coll[SByte] — the common startsWith/endsWith element type.
      [coll([{ kind: 'Byte', value: 1 }, { kind: 'Byte', value: 2 }], { tag: 'SByte' }), coll([{ kind: 'Byte', value: 1 }, { kind: 'Byte', value: 2 }], { tag: 'SByte' })],
      [coll([{ kind: 'Byte', value: 1 }], { tag: 'SByte' }), coll([{ kind: 'Byte', value: 9 }], { tag: 'SByte' })], // coa differ → false
    ]
    for (const [a, b] of pairs) {
      expect(sValueStructuralEq(a, b)).toBe(sValueEquals(a, b, makeContext({})))
    }
  })
  it('charges no cost (it takes no ctx) — used by startsWith/endsWith', () => {
    expect(sValueStructuralEq(coll([L(1), L(2)]), coll([L(1), L(2)]))).toBe(true)
  })
})
