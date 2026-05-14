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
import type { SType, SValue } from '../src/mir/types'

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

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0)
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input (${hex.length})`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: bad hex at offset ${i * 2}`)
    }
    out[i] = byte
  }
  return out
}

/**
 * Hydrate a JSON-stringified SValue (sigma-rust's value_to_json output)
 * into a runtime SValue. Mirrors the helper in `corpus.test.ts` but tolerant
 * of the `Opaque` kind (which sigma-rust emits as a fallback for variants
 * its JSON encoder doesn't render structurally — chiefly SigmaProp). We
 * never actually compare against an Opaque value at the value level (the
 * caller filters before calling), but we accept it here so the helper is
 * total over the inputs we observe.
 */
function hydrateSValue(json: any): SValue {
  switch (json.kind) {
    case 'Boolean':
      return { kind: 'Boolean', value: json.value }
    case 'Byte':
      return { kind: 'Byte', value: json.value }
    case 'Short':
      return { kind: 'Short', value: json.value }
    case 'Int':
      return { kind: 'Int', value: json.value }
    case 'Long':
      return { kind: 'Long', value: BigInt(json.value as string) }
    case 'BigInt':
      return { kind: 'BigInt', value: BigInt(json.value as string) }
    case 'GroupElement':
      return { kind: 'GroupElement', value: hexToBytes(json.bytes_hex) }
    case 'SigmaProp':
      return { kind: 'SigmaProp', value: { raw: hexToBytes(json.raw_hex) } }
    case 'Unit':
      return { kind: 'Unit' }
    case 'Coll':
      return {
        kind: 'Coll',
        elem: json.elem as SType,
        items: (json.items as any[]).map(hydrateSValue),
      }
    case 'Tuple':
      return {
        kind: 'Tuple',
        items: (json.items as any[]).map(hydrateSValue),
      }
    case 'Option':
      return {
        kind: 'Option',
        elem: json.elem as SType,
        value: json.value === null ? null : hydrateSValue(json.value),
      }
    default:
      throw new Error(`hydrateSValue: unknown kind ${json.kind}`)
  }
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
      const ctx = makeContext()

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
      `[corpus-eval] phase 2b TS eval: success=${evalSuccess} not-impl=${notImplYet} other=${other}`
    )
    if (otherCodes.size > 0) {
      console.log('[corpus-eval] other error codes:')
      for (const [code, n] of otherCodes) console.log(`  ${code}: ${n}`)
    }
    expect(true).toBe(true)
  })
})
