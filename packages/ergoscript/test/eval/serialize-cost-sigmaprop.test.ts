/**
 * serializeCost SSigmaProp arm (F3 root cause #6) — unit pins.
 *
 * JVM: CoreDataSerializer.scala:45-47 → SigmaBoolean.serializer.serialize
 * (SigmaBoolean.scala:40-68), cost-accrued through SigmaByteWriter:
 *   opcode put(Byte) = 1/node; ProveDlog → putBytes(33) = 36;
 *   ProveDHTuple → 4×36 = 144; TrivialProp → opcode only;
 *   CAND/COR → putUShort(nChildren) = 3 + recurse;
 *   CTHRESHOLD → putUShort(k) + putUShort(n) = 6 + recurse.
 * putUShort = PutUnsignedNumericCost(3) (SigmaByteWriter.scala:83-86,:248) —
 * source-verified (NOT the putUByte(1) class).
 * Conformance twin: v6/Global.serialize_SigmaProp.json (dlog, cost 126 =
 * envelope 79 + StartWriter 10 + walk 37; the green serialize_GroupElement
 * twin at 125 pins the same envelope with walk 36).
 */
import { describe, it, expect } from 'vitest'
import { serializeCost } from '../../src/eval/serialize-cost'
import { makeContext } from '../../src/eval/eval-context'
import type { SigmaBoolean, SValue } from '../../src/mir/types'

const P = new Uint8Array([0x02, ...Array.from({ length: 32 }, (_, i) => i + 1)])
const dlog: SigmaBoolean = { tag: 'ProveDlog', h: P }
const dht: SigmaBoolean = { tag: 'ProveDhTuple', g: P, h: P, u: P, v: P }
const trivialTrue: SigmaBoolean = { tag: 'TrivialProp', value: true }

function costOf(sb: SigmaBoolean): number {
  const ctx = makeContext()
  const v: SValue = { kind: 'SigmaProp', value: sb }
  serializeCost({ tag: 'SSigmaProp' }, v, ctx)
  return ctx.jitCost
}

describe('serializeCost — SSigmaProp arm (SigmaBoolean.scala:40-68)', () => {
  it('ProveDlog: opcode(1) + putBytes(33)(36) = 37', () => {
    expect(costOf(dlog)).toBe(37)
  })
  it('ProveDHTuple: opcode(1) + 4×36 = 145', () => {
    expect(costOf(dht)).toBe(145)
  })
  it('TrivialProp: opcode only = 1', () => {
    expect(costOf(trivialTrue)).toBe(1)
  })
  it('CAND of 2 dlogs: 1 + putUShort(3) + 2×37 = 78', () => {
    expect(costOf({ tag: 'Cand', items: [dlog, dlog] })).toBe(78)
  })
  it('COR of 1 dlog: 1 + 3 + 37 = 41', () => {
    expect(costOf({ tag: 'Cor', items: [dlog] })).toBe(41)
  })
  it('CTHRESHOLD(k=2, [dlog, dlog, dht]): 1 + 6 + 37 + 37 + 145 = 226', () => {
    expect(costOf({ tag: 'Cthreshold', k: 2, items: [dlog, dlog, dht] })).toBe(226)
  })
  it('nested: CAND([COR([dlog]), TrivialProp]) = 1+3 + 41 + 1 = 46', () => {
    expect(costOf({ tag: 'Cand', items: [{ tag: 'Cor', items: [dlog] }, trivialTrue] })).toBe(46)
  })
})
