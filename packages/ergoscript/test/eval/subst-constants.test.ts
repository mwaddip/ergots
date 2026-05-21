/**
 * SubstConstants arm — fixture-driven evaluation tests (CONSENSUS-CRITICAL).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/subst_const.rs:18-89
 *   eval-children → length-match → parseTree → Pattern B cost (template-sized)
 *   → substitute (bounds + type-equality) → serializeTree → wrap as Coll[Byte].
 *
 * CONSENSUS NOTE: SubstConstants returns ErgoTree BYTES that downstream code
 * re-broadcasts on-chain. A 1-byte divergence from sigma-rust is a consensus
 * failure. Byte-equality is preserved by reusing our parseTree/serializeTree
 * round-trip (validated by 255 corpus fixtures + 6,221 parse-mutation tests);
 * the explicit byte-equality canary at the bottom of this file asserts the
 * property end-to-end against a sigma-rust-evaluated reference.
 *
 * Cost-charging order: Pattern B — addPerItemCost(100, 100, 1,
 * template.constants.length) AFTER parseTree, BEFORE the substitution loop.
 * The template-sized cost is the bug-3 regression invariant (sigma-rust
 * subst_const.rs:221-283): substituting 1 vs 3 positions on a 3-const template
 * must produce identical SubstConstants cost.
 *
 * Defensive guards (non-Coll[Byte] script_bytes / non-Coll[Int] positions /
 * non-Coll[_] new_values) are tested inline because sigma-rust's build-time
 * `SubstConstants::new` rejects malformed types at construction (so fixtures
 * cannot serialize them via the standard path).
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
import type { SubstConstants as SubstConstantsExpr } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/subst-constants.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; [key: string]: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('SubstConstants arm — fixture-driven', () => {
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

describe('SubstConstants — bug-3 regression (cost is template-sized, not positions-sized)', () => {
  // The fixture pair subst_3_int_in_order (positions=[0,1,2]) and
  // subst_cost_uses_template_count (positions=[0]) share the SAME 3-constant
  // template. SubstConstants-component cost must therefore be identical.
  //
  // Pure equality holds because the rest of the program (Const arms feeding
  // script_bytes/positions/new_values) is internally also Pattern B
  // (perItem-style) but the additional Const cost differences cancel: both
  // entries use Coll[Int] for positions and Coll[Int] for new_values, both
  // arrive at the same Const arm cost-classes — so the TOTAL jitCost coincides
  // when the SubstConstants component coincides.
  it('3-const template costs are equal across positions.length variations', () => {
    const a = fixture.entries.find((e) => e.name === 'subst_3_int_in_order')!
    const b = fixture.entries.find((e) => e.name === 'subst_cost_uses_template_count')!
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a.expected_cost).toBe(b.expected_cost)
  })
})

describe('SubstConstants — byte-equality canary (CONSENSUS-CRITICAL)', () => {
  it('output Coll[Byte] is bit-identical to sigma-rust reference', () => {
    const entry = fixture.entries.find((e) => e.name === 'subst_byte_equality_check')!
    expect(entry).toBeDefined()
    expect(entry.expected_error_code).toBeNull()

    const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
    const ctx = makeContext({ ...entry.opts_json })
    const value = evaluateWith(tree, ctx)

    if (value.kind !== 'Coll') throw new Error('byte-equality canary expects Coll output')
    expect(value.elem).toEqual({ tag: 'SByte' })
    const actualBytes = new Uint8Array(value.items.length)
    for (let i = 0; i < value.items.length; i++) {
      const item = value.items[i]!
      if (item.kind !== 'Byte') throw new Error(`byte-equality canary: item[${i}].kind=${item.kind}`)
      actualBytes[i] = item.value & 0xff
    }

    // Reconstruct expected bytes from the fixture's expected_value_json.
    const expectedItems = (entry.expected_value_json!.items as Array<{ kind: string; value: number }>) ?? []
    const expectedBytes = new Uint8Array(expectedItems.length)
    for (let i = 0; i < expectedItems.length; i++) {
      expectedBytes[i] = expectedItems[i]!.value & 0xff
    }

    expect(Array.from(actualBytes)).toEqual(Array.from(expectedBytes))
    expect(ctx.jitCost).toBe(entry.expected_cost)
  })
})

describe('SubstConstants arm — defensive shape guards (non-parser MIR paths)', () => {
  // SubstConstants::new in sigma-rust enforces Coll[Byte] / Coll[Int] / Coll[_]
  // on script_bytes / positions / new_values at construction; these tests
  // bypass that build-time guard by hand-crafting MIR nodes (mirrors the
  // calc_blake2b256 / byte_array_to_long defensive-guard precedent).

  it('throws subst-constants-error when script_bytes is SInt', () => {
    const expr: SubstConstantsExpr = {
      tag: 'SubstConstants',
      scriptBytes: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 42 },
      },
      positions: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
      },
      newValues: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('subst-constants-error')
  })

  it('throws subst-constants-error when positions is Coll[Byte] (not Coll[Int])', () => {
    // Use an actual 1-const template so the script_bytes guard passes; the
    // failure must come from the positions Coll[Int] guard, not the script_bytes
    // guard.
    // template `00740e061001045473001001001001ce0f` corresponds to a 1-const
    // i32 template; here we hard-code minimal bytes and rely on the positions
    // guard firing before parseTree is called.
    const expr: SubstConstantsExpr = {
      tag: 'SubstConstants',
      scriptBytes: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [{ kind: 'Byte', value: 0 }],
        },
      },
      positions: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [{ kind: 'Byte', value: 0 }],
        },
      },
      newValues: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('subst-constants-error')
  })

  it('throws subst-constants-error when new_values is SInt (not Coll[_])', () => {
    const expr: SubstConstantsExpr = {
      tag: 'SubstConstants',
      scriptBytes: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [{ kind: 'Byte', value: 0 }],
        },
      },
      positions: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
      },
      newValues: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 99 },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('subst-constants-error')
  })
})
