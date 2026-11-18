/**
 * Xor's cost counts the shorter of the two operands.
 *
 * JVM `Xor.xorWithCosting` (`data/shared/src/main/scala/sigma/ast/trees.scala:
 * 1021-1025` at 6.0.7):
 *   E.addSeqCost(Xor.costKind, math.min(ls.length, rs.length), Xor.opDesc)
 *     { () => Colls.xor(ls, rs) }
 * with `Xor.costKind = PerItemCost(10, 2, 128)` (`:1015-1016`). The chunks
 * arithmetic is
 *   chunks(n) = (n - 1) / 128 + 1          at n >= 1 and at n == 0
 * (`core/shared/src/main/scala/sigma/ast/CostKind.scala:24-26`; toward-zero
 * division makes `trunc((0 - 1) / 128) + 1 == 1`), and the composite is
 * `cost(n) = base + chunks(n) * perChunk`. Xor's `chunkSize = 128`, so an
 * empty-operand call (min = 0) charges `base + perChunk = 12`; `addPerItemCost`
 * in `packages/ergoscript/src/eval/eval-context.ts:190-198` matches.
 *
 * Three probe trees (same shape, `BoolToSigmaProp(SizeOf(Xor(l, r)) == N)`
 * at the arg's `N = min(|l|, |r|)` so the tree reduces to TrueProp):
 *   T1 — left 129 bytes, right 1 byte: min = 1, chunks = 1, Xor cost 12.
 *   T2 — left 1 byte, right 129 bytes: min = 1, chunks = 1, Xor cost 12.
 *   T3 — left 129 bytes, right 129 bytes: min = 129, chunks = 2, Xor cost 14.
 *
 * The non-byte, non-empty-operand cell: an item of another class fails the
 * per-pair unbox in `Colls.xor = left.zip(right).map{(l,r) => (l^r).toByte}`
 * on the first pair (`CollsOverArrays.scala:261-262`). ergots raises
 * `EvalError('coll-class-cast')` at that point. The per-item cost is charged
 * BEFORE the zip-map block runs: `CErgoTreeEvaluator.addSeqCost` does
 * `coster.add(cost)` and THEN runs the block (`interpreter/shared/src/main/
 * scala/sigmastate/interpreter/CErgoTreeEvaluator.scala:388-391`), so the
 * refusal does not undo the cost; a caller inspecting `ctx.jitCost` after
 * the throw sees the cost for the min length.
 *
 * The empty-operand cell (zip's min = 0): the block runs over zero pairs
 * and returns an empty `Coll[Byte]` without reading the other side's items.
 *
 * The pairs operand cell: a pairs `Coll` is still kind `'Coll'`, so the
 * arm's guard lets it through; its items are pairs, so the per-pair unbox
 * to Byte fails at the first pair (`coll-class-cast`).
 */

import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { makeContext } from '../../src/eval/eval-context'
import { Env } from '../../src/eval/env'
import type { Xor as XorExpr } from '../../src/mir/types'
import { hexToBytes, captureEvalError } from '../_helpers'

/** `BoolToSigmaProp(EQ(SizeOf(Xor(Coll[Byte] 129 zeros, Coll[Byte] 1 zero)), Int(1)))` */
const T1_HEX = '00d193b19b0e81010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e01000402'
/** `BoolToSigmaProp(EQ(SizeOf(Xor(Coll[Byte] 1 zero, Coll[Byte] 129 zeros)), Int(1)))` */
const T2_HEX = '00d193b19b0e01000e81010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000402'
/** `BoolToSigmaProp(EQ(SizeOf(Xor(Coll[Byte] 129 zeros, Coll[Byte] 129 zeros)), Int(129)))` */
const T3_HEX = '00d193b19b0e81010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e8101000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000048202'

describe('Xor cost is sized by the shorter operand (JVM trees.scala:1022)', () => {
  it('T1 left=129 right=1 → cost 59 (Xor chunk count = chunks(1) = 1; base 10 + perChunk 2 = 12)', () => {
    const tree = parseTree(hexToBytes(T1_HEX))
    const ctx = makeContext({})
    const v = evaluateWith(tree, ctx)
    expect(v.kind).toBe('SigmaProp')
    expect(ctx.jitCost).toBe(59)
  })

  it('T2 left=1 right=129 → cost 59 (symmetric with T1; min = 1)', () => {
    const tree = parseTree(hexToBytes(T2_HEX))
    const ctx = makeContext({})
    const v = evaluateWith(tree, ctx)
    expect(v.kind).toBe('SigmaProp')
    expect(ctx.jitCost).toBe(59)
  })

  it('T3 left=129 right=129 → cost 61 (Xor chunk count = chunks(129) = (129-1)/128 + 1 = 2; base 10 + 2 * perChunk 2 = 14)', () => {
    const tree = parseTree(hexToBytes(T3_HEX))
    const ctx = makeContext({})
    const v = evaluateWith(tree, ctx)
    expect(v.kind).toBe('SigmaProp')
    expect(ctx.jitCost).toBe(61)
  })
})

describe('Xor refuses a non-byte, non-empty operand at the per-pair unbox', () => {
  it('LEFT is a non-empty Coll[Int] (length matches right) → coll-class-cast', () => {
    const expr: XorExpr = {
      tag: 'Xor',
      left: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SInt' },
          items: [{ kind: 'Int', value: 1 }],
        },
      },
      right: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [{ kind: 'Byte', value: 1 }],
        },
      },
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-class-cast')
    // Per-item cost is charged BEFORE the zip-map block runs (JVM
    // CErgoTreeEvaluator.scala:388-391: coster.add(cost) THEN block()); ergots'
    // addPerItemCost on min = 1 ran before the refusal.
    expect(ctx.jitCost).toBe(22)
  })

  it('RIGHT is a non-empty Coll[Int] (length matches left) → coll-class-cast', () => {
    const expr: XorExpr = {
      tag: 'Xor',
      left: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [{ kind: 'Byte', value: 1 }],
        },
      },
      right: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SInt' },
          items: [{ kind: 'Int', value: 2 }],
        },
      },
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-class-cast')
  })
})

describe('Xor accepts an empty operand of another item class (zip min = 0)', () => {
  it('EMPTY Coll[Int] on the right of a non-empty byte left → Coll[Byte]()', () => {
    const expr: XorExpr = {
      tag: 'Xor',
      left: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [
            { kind: 'Byte', value: 1 },
            { kind: 'Byte', value: 2 },
          ],
        },
      },
      right: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
      },
    }
    const ctx = makeContext({})
    const v = evalExpr(expr, Env.empty(), ctx)
    expect(v.kind).toBe('Coll')
    if (v.kind !== 'Coll') return
    expect(v.elem).toEqual({ tag: 'SByte' })
    expect(v.items).toEqual([])
  })

  it('EMPTY Coll[Boolean] on the left of a non-empty byte right → Coll[Byte]()', () => {
    const expr: XorExpr = {
      tag: 'Xor',
      left: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SBoolean' } },
        value: { kind: 'Coll', elem: { tag: 'SBoolean' }, items: [] },
      },
      right: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [{ kind: 'Byte', value: 0 }],
        },
      },
    }
    const ctx = makeContext({})
    const v = evalExpr(expr, Env.empty(), ctx)
    expect(v.kind).toBe('Coll')
    if (v.kind !== 'Coll') return
    expect(v.items).toEqual([])
  })
})

describe('Xor refuses a pairs-shape operand at the per-pair unbox (its items are Tuples, not Bytes)', () => {
  it('RIGHT is a pairs collection of length 1 vs a non-empty byte LEFT → coll-class-cast', () => {
    const expr: XorExpr = {
      tag: 'Xor',
      left: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [{ kind: 'Byte', value: 1 }],
        },
      },
      right: {
        tag: 'Const',
        tpe: {
          tag: 'SColl',
          elem: { tag: 'STuple', items: [{ tag: 'SByte' }, { tag: 'SByte' }] },
        },
        value: {
          kind: 'Coll',
          elem: { tag: 'STuple', items: [{ tag: 'SByte' }, { tag: 'SByte' }] },
          items: [
            {
              kind: 'Tuple',
              items: [
                { kind: 'Byte', value: 1 },
                { kind: 'Byte', value: 2 },
              ],
            },
          ],
        },
      },
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-class-cast')
  })
})
