/**
 * Layer C2 — mainnet_boxes corpus eval-filter.
 *
 * Walks the existing 173-tree mainnet_boxes corpus from phase 2a. For each
 * tree where sigma-rust's synthetic-context eval succeeded, asserts our
 * `evaluateWith` produces the same value AND cost. For trees that hit phase
 * 2b's not-implemented arms, asserts the failure code is in the documented
 * EvalError taxonomy. Tally is logged so we can track the evaluable subset
 * growing across 2c/2d/2e/2f.
 *
 * Special case: sigma-rust's value_to_json fallback emits
 * `{ kind: 'Opaque', debug: '...' }` for SigmaProp results (which is what
 * almost every successful mainnet eval produces in synthetic-empty
 * context — most reduce to `SigmaProp(SigmaProp(TrivialProp(true|false)))`).
 * Phase 2b's TS arms never emit `Opaque` directly: a `Const(SSigmaProp)`
 * body returns `{ kind: 'SigmaProp', value: SigmaBoolean }`. So for Opaque
 * sigma-rust values we assert cost-only and defer value-equality to the
 * phase that lands richer SigmaProp value comparison (2g).
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../src/wire/ergo-tree'
import { evaluateWith } from '../src/eval/evaluate'
import { makeContext, EvalError } from '../src/eval/eval-context'
import { hexToBytes, hydrateSValue } from './_helpers'

// In ESM, __dirname is not defined; derive it from import.meta.url. node:url
// is a node-only import, allowed in test files per the browser-first rule.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, 'fixtures/mainnet_boxes.json')

interface SigmaRustEval {
  context_kind: 'synthetic-empty'
  ok: boolean
  value_json?: unknown
  jit_cost?: number
  error_kind?: string
}

interface CorpusEntry {
  box_id: string
  ergo_tree_hex: string
  byte_length: number
  block_height?: number
  round_trip_ok: boolean
  sigma_rust_eval?: SigmaRustEval
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: CorpusEntry[]
}

describe('Corpus eval — mainnet_boxes (Layer C2)', () => {
  let evalSuccess = 0
  let notImplYet = 0
  let other = 0
  const otherCodes = new Map<string, number>()

  const evaluable = fixture.entries.filter(
    (e): e is CorpusEntry & { sigma_rust_eval: SigmaRustEval } =>
      e.sigma_rust_eval !== undefined && e.sigma_rust_eval.ok === true
  )

  for (const entry of evaluable) {
    it(`box ${entry.box_id}: TS eval matches sigma-rust (or hits documented not-impl)`, () => {
      const tree = parseTree(hexToBytes(entry.ergo_tree_hex))
      // Default ctx.constants to tree.constants — mirrors evaluate()'s
      // auto-default. Without it, any tree whose body reaches a
      // ConstPlaceholder throws 'const-placeholder-no-constants' instead
      // of 'not-implemented-yet', which would silently classify as `other`
      // once phase 2c+ lands more arms.
      const ctx = makeContext({ constants: tree.constants })

      // Skip value-equality when sigma-rust returned an Opaque value
      // (chiefly SigmaProp results — see file header). Cost is still
      // asserted because Const arm's cost is deterministic and matches
      // sigma-rust's `Constant = Fixed(5)` charge.
      const expectedValue = entry.sigma_rust_eval.value_json as { kind?: string } | null
      const isOpaqueExpected = expectedValue?.kind === 'Opaque'

      try {
        const value = evaluateWith(tree, ctx)
        if (!isOpaqueExpected) {
          expect(value).toEqual(hydrateSValue(entry.sigma_rust_eval.value_json))
        }
        expect(ctx.jitCost).toBe(entry.sigma_rust_eval.jit_cost)
        evalSuccess++
      } catch (e) {
        // Did not eval — must be a documented EvalError.
        expect(e).toBeInstanceOf(EvalError)
        const code = (e as EvalError).code
        if (code === 'not-implemented-yet') {
          notImplYet++
        } else if (code === 'context-field-missing') {
          // 'context-field-missing' is expected once phase 2f medium lands:
          // corpus eval runs with a synthetic empty context (no chain state),
          // so any tree that reaches a GlobalVars arm (Height, SelfBox, etc.)
          // or GetVar arm now throws 'context-field-missing' instead of
          // 'not-implemented-yet'. This is correct behaviour — the arm is
          // implemented but the corpus run doesn't provide context data.
          notImplYet++
        } else {
          other++
          otherCodes.set(code, (otherCodes.get(code) ?? 0) + 1)
        }
      }
    })
  }

  it('aggregate (informational)', () => {
    console.log(
      `[corpus-eval] sigma-rust-evaluable: ${evaluable.length} / ${fixture.entries.length}`
    )
    console.log(
      `[corpus-eval] phase 2c TS eval: success=${evalSuccess} not-impl=${notImplYet} other=${other}`
    )
    if (otherCodes.size > 0) {
      console.log('[corpus-eval] other error codes:')
      for (const [code, n] of otherCodes) console.log(`  ${code}: ${n}`)
    }
    // Fail loudly if any corpus entry hit an undocumented error code.
    // `evalSuccess + notImplYet` cover the two expected outcomes; anything
    // in `other` is a regression we want to investigate, not silently log.
    expect(other).toBe(0)
  })
})
