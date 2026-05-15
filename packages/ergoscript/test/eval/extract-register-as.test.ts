/**
 * ExtractRegisterAs arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_reg_as.rs:15-48
 *   ctx.add_jit_cost(50)?;                            // BEFORE eval-child (Pattern A)
 *   let ir_box = self.input.eval(env, ctx)?
 *       .try_extract_into::<Ref<ErgoBox>>()?;
 *   let id: RegisterId = self.register_id.try_into()?;
 *   let reg = ir_box.get_register(id)?;
 *   match reg {
 *     Some(c) if c.tpe == *self.elem_tpe => Ok(Value::Opt(Some(c.v.into()))),
 *     Some(c) => Err(EvalError::UnexpectedValue(...)),  // type-mismatch THROWS
 *     None => Ok(Value::Opt(None)),
 *   }
 *
 * Fixed(50) cost charged BEFORE eval-child (Pattern A — envelope-first).
 * Const(SBox) arm charges Fixed(5); total fixture cost = 55.
 *
 * R0..R3 are mandatory registers synthesized from box fields:
 *   R0 → SLong(box.value)
 *   R1 → SColl[SByte] of box.ergoTreeBytes
 *   R2 → SColl[STuple[SColl[SByte], SLong]] of tokens
 *   R3 → STuple[SInt, SColl[SByte]] of creation_info (height, txId ++ BE_u16(index))
 * R4..R9 → non-mandatory registers from box.registers.
 *
 * Coverage (12 fixture entries):
 *   - R0..R3 happy paths (4 entries)
 *   - R0 type-mismatch (elem=SInt for SLong register) → 'register-type-mismatch'
 *   - R4..R6 happy paths with stored values (3 entries)
 *   - R4 absent (not set in box) → Option(None)
 *   - registerId=-1 → 'register-id-out-of-range'
 *   - registerId=10 → 'register-id-out-of-range'
 *   - cost-limit: jitCostLimit=1 < Fixed(50) → 'cost-limit-exceeded'
 *
 * Error paths tested inline:
 *   - 'extract-input-not-box' inline guard: Const(SInt, 5) input.
 *   - 'extract-input-not-box' inline guard: Const(SBoolean, true) input.
 *
 * Note: 'register-type-mismatch' and 'register-id-out-of-range' ARE triggered via
 * fixtures because sigma-rust's ExtractRegisterAs::new accepts any i8 at construction
 * time — validation only fires during eval (try_into::<RegisterId>() and tpe check).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import type { ExtractRegisterAs } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(
  __dirname,
  '../fixtures/eval/extract-register-as.json'
)

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('ExtractRegisterAs arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })

      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})

describe('ExtractRegisterAs arm — extract-input-not-box guard', () => {
  it('throws extract-input-not-box when input is not a Box', () => {
    // Hand-built MIR node bypassing sigma-rust's try_build SBox-type check.
    // sigma-rust ExtractRegisterAs::new rejects non-SBox at construction time;
    // the TS wire parser doesn't type-check, so this tests the eval guard.
    const expr: ExtractRegisterAs = {
      tag: 'ExtractRegisterAs',
      input: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 5 },
      },
      registerId: 0,
      elemTpe: { tag: 'SLong' },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('extract-input-not-box')
  })

  it('throws extract-input-not-box when input is a Boolean', () => {
    const expr: ExtractRegisterAs = {
      tag: 'ExtractRegisterAs',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
      registerId: 0,
      elemTpe: { tag: 'SLong' },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('extract-input-not-box')
  })
})
