import { describe, expect, it } from 'vitest'
import {
  cthresholdReduce,
  candNormalized,
  corNormalized,
} from '../../src/mir/sigma-boolean-normalize'
import type { SigmaBoolean } from '../../src/mir/types'

const T: SigmaBoolean = { tag: 'TrivialProp', value: true }
const F: SigmaBoolean = { tag: 'TrivialProp', value: false }
const D = (n: number): SigmaBoolean => ({
  tag: 'ProveDlog',
  h: new Uint8Array(33).fill(n),
})

describe('candNormalized', () => {
  it('filters TrivialProp(true) (identity)', () => {
    expect(candNormalized([D(1), T, D(2)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2)],
    })
  })
  it('returns TrivialProp(false) on any TrivialProp(false) (absorbing)', () => {
    expect(candNormalized([D(1), F, D(2)])).toEqual(F)
  })
  it('returns TrivialProp(true) on empty after filter', () => {
    expect(candNormalized([T, T])).toEqual(T)
  })
  it('unwraps single child', () => {
    expect(candNormalized([D(1), T])).toEqual(D(1))
  })
  it('returns Cand for 2+ non-trivial', () => {
    expect(candNormalized([D(1), D(2)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2)],
    })
  })
})

describe('corNormalized', () => {
  it('filters TrivialProp(false) (identity)', () => {
    expect(corNormalized([D(1), F, D(2)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2)],
    })
  })
  it('returns TrivialProp(true) on any TrivialProp(true) (absorbing)', () => {
    expect(corNormalized([D(1), T, D(2)])).toEqual(T)
  })
  it('returns TrivialProp(false) on empty after filter', () => {
    expect(corNormalized([F, F])).toEqual(F)
  })
  it('unwraps single child', () => {
    expect(corNormalized([D(1), F])).toEqual(D(1))
  })
  it('returns Cor for 2+ non-trivial', () => {
    expect(corNormalized([D(1), D(2)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2)],
    })
  })
})

describe('cthresholdReduce', () => {
  it('k=0 → TrivialProp(true)', () => {
    expect(cthresholdReduce(0, [D(1), D(2), D(3)])).toEqual(T)
  })
  it('k>n → TrivialProp(false)', () => {
    expect(cthresholdReduce(4, [D(1), D(2), D(3)])).toEqual(F)
  })
  it('k=1 with no trivials → Cor', () => {
    expect(cthresholdReduce(1, [D(1), D(2), D(3)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2), D(3)],
    })
  })
  it('k=n with no trivials → Cand', () => {
    expect(cthresholdReduce(3, [D(1), D(2), D(3)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2), D(3)],
    })
  })
  it('k=2 of 3 → Cthreshold(k=2, items)', () => {
    expect(cthresholdReduce(2, [D(1), D(2), D(3)])).toEqual({
      tag: 'Cthreshold',
      k: 2,
      items: [D(1), D(2), D(3)],
    })
  })
  it('TrivialProp(true) child decrements both k and n', () => {
    expect(cthresholdReduce(2, [T, D(1), D(2)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2)],
    })
  })
  it('TrivialProp(false) child decrements only n', () => {
    expect(cthresholdReduce(2, [F, D(1), D(2)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2)],
    })
  })
  it('mid-loop curr_k==1 collapse appends remaining', () => {
    expect(cthresholdReduce(3, [T, T, D(1), D(2)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2)],
    })
  })
  it('mid-loop curr_k==children_left collapse appends remaining', () => {
    expect(cthresholdReduce(3, [F, D(1), D(2), D(3)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2), D(3)],
    })
  })
  it('k=0 with empty items → TrivialProp(true)', () => {
    expect(cthresholdReduce(0, [])).toEqual(T)
  })
  it('k=1 with empty items → TrivialProp(false) (k > n=0)', () => {
    expect(cthresholdReduce(1, [])).toEqual(F)
  })
})
