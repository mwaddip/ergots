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

import { evaluateWith } from '../src/eval/evaluate'
import { makeContext, EvalError } from '../src/eval/eval-context'
import { hexToBytes, hydrateSValue, synthesizeStubBox, parseParsedTree as parseTree } from './_helpers'

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

      // Deterministic context matching corpus_context() in
      // fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs (the authoritative
      // source). If that function's shape changes, update this stub to match.
      //
      //   inputs:      [box(1 token), box(1 token)]  (self = inputs[0])
      //   outputs:     [box(2 tokens), box(0 tokens)]
      //   data_inputs: Some([box(0 tokens)])
      //   height:      0
      //
      // Sizes must match for ByIndex access to succeed and for per-item costs
      // to match the sigma-rust oracle. Token counts matter for SBox.tokens cost.
      const dummyTokenId = new Uint8Array(32) // 32-byte all-zeros token id
      const stubBoxWith1Token = synthesizeStubBox({
        tokens: [{ id: dummyTokenId, amount: 1n }],
      })
      const stubBoxWith2Tokens = synthesizeStubBox({
        tokens: [
          { id: dummyTokenId, amount: 1n },
          { id: dummyTokenId, amount: 1n },
        ],
      })
      const stubBoxWith0Tokens = synthesizeStubBox({})
      const ctx = makeContext({
        constants: tree.constants,
        selfBox: stubBoxWith1Token,
        inputs: [stubBoxWith1Token, stubBoxWith1Token],
        outputs: [stubBoxWith2Tokens, stubBoxWith0Tokens],
        dataInputs: [stubBoxWith0Tokens],
        height: 0,
      })

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
          // Safety-net fallback for corpus entries that become evaluable in
          // future phases but whose trees reference context fields not supplied
          // by the current stub (e.g. GetVar, or a GlobalVars arm that needs
          // a real chain state). None of the 18 currently-evaluable trees hit
          // this branch — they all succeed or throw 'not-implemented-yet'.
          // The branch exists so that the 155 non-evaluable entries don't
          // silently land in `other` if a future phase makes them evaluable
          // before the context stub is enriched.
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
      `[corpus-eval] TS eval: success=${evalSuccess} not-impl=${notImplYet} other=${other}`
    )
    if (otherCodes.size > 0) {
      console.log('[corpus-eval] other error codes:')
      for (const [code, n] of otherCodes) console.log(`  ${code}: ${n}`)
    }
    // Fail loudly if any corpus entry hit an undocumented error code.
    // `evalSuccess + notImplYet` cover the two expected outcomes; anything
    // in `other` is a regression we want to investigate, not silently log.
    expect(other).toBe(0)
    // Phase 2g.5 unlock assertion: all 18 sigma-rust-evaluable mainnet trees
    // must succeed in TS eval. If this drops below 18, a regression occurred.
    expect(evalSuccess).toBe(18)
  })
})
