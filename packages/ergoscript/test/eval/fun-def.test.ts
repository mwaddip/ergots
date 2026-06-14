/**
 * FunDef (opcode 0xd7) eval coverage — Task 4 of v6 P6.
 *
 * FunDef parses to a `ValDef` MIR node with `tpeArgs` populated.
 * The evaluator (`block-value.ts` / `evalBlockValue`) accepts any item
 * whose `tag === 'ValDef'` and ignores `tpeArgs`, exactly matching the
 * JVM `BlockValue.eval` which casts every item to `ValDef` regardless of
 * companion (ValDef vs FunDef). No src/ change is needed; this test proves
 * the existing path is correct.
 *
 * Test A — FunDef binds and applies:
 *   BlockValue {
 *     items: [ValDef { id:1, tpeArgs:[{name:'T'}], rhs: FuncValue([arg:SInt]→ValUse(1)) }]
 *     result: Apply(func=ValUse(1,SFunc([SInt]→SInt)), args=[Const SInt 7])
 *   }
 *   → SValue { kind:'Int', value:7 }
 *
 * Test B — top-level FunDef (ValDef with tpeArgs) rejects with
 *   'val-def-outside-block' — identical to a plain top-level ValDef.
 *
 * Harness mirrored from:
 *   test/eval/block-value.test.ts  (BlockValue + evalExpr entry point)
 *   test/eval/apply.test.ts        (Apply inline + evalExpr / makeContext)
 *   test/eval/func-value.test.ts   (FuncValue inline, SValue.kind==='Lambda')
 *   test/eval/val-def.test.ts      (top-level ValDef rejection style)
 */
import { describe, it, expect } from 'vitest'

import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { BlockValue, ValDef } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

describe('FunDef eval — bind and apply inside BlockValue', () => {
  it('Test A: FunDef-bound identity lambda evaluates to 7', () => {
    /**
     * Build:
     *   { block, items: [ValDef(id=1, tpeArgs=[T], rhs=FuncValue([SInt arg]→ValUse(1)))]
     *     result: Apply(ValUse(1, SFunc([SInt]→SInt)), [Const SInt 7]) }
     */
    const block: BlockValue = {
      tag: 'BlockValue',
      items: [
        {
          tag: 'ValDef',
          id: 1,
          tpeArgs: [{ name: 'T' }],
          rhs: {
            tag: 'FuncValue',
            args: [{ id: 1, tpe: { tag: 'SInt' } }],
            body: { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } },
          },
        } satisfies ValDef,
      ],
      result: {
        tag: 'Apply',
        func: {
          tag: 'ValUse',
          valId: 1,
          tpe: { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SInt' }, tpeParams: [] },
        },
        args: [
          { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 7 } },
        ],
      },
    }

    const ctx = makeContext()
    const value = evalExpr(block, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 7 })
  })
})

describe('FunDef eval — top-level rejection', () => {
  it('Test B: bare top-level FunDef (ValDef with tpeArgs) throws val-def-outside-block', () => {
    const funDef: ValDef = {
      tag: 'ValDef',
      id: 1,
      tpeArgs: [{ name: 'T' }],
      rhs: {
        tag: 'FuncValue',
        args: [{ id: 1, tpe: { tag: 'SInt' } }],
        body: { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } },
      },
    }

    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(funDef, Env.empty(), ctx))
    expect(err.code).toBe('val-def-outside-block')
  })
})
