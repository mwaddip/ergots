/**
 * SANTA v6 conformance — ergots vs JVM (`jvm:sigma-state-6.0.3`).
 * Vectors imported verbatim from SANTA (`vectors/eval/v6/`) into
 * `test/fixtures/conformance/v6/`. Asserting whole-tree value+cost against the
 * JVM-blessed oracle. VECTOR_FILES grows as SANTA blesses more v6 vectors (the
 * powHit k≠32 follow-up below; the P6 adversarial A/B/C/FunDef HOF vectors next).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalSantaEntry, type SantaVector, type SantaEntry } from './_santa'
import { hydrateSValue } from '../_helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vectorDir = path.join(__dirname, '../fixtures/conformance/v6')

const VECTOR_FILES = [
  'higher_order_lambdas.json',
  // P6 Task 7 — JVM-blessed adversarial HOF (SANTA a66af91): FunDef (0xd7,
  // concrete body) → 7/58, currying (Apply-of-Apply) → 4/119, function-in-
  // Coll[SFunc] → 6/130. The adversarial-closure gate for first-class functions.
  'HOF_FunDef_polymorphic_identity.json',
  'HOF_currying_Apply_of_Apply.json',
  'HOF_function_in_Coll_of_SFunc.json',
  'HOF_FunDef_type_var_body.json', // type-var-body FunDef — reject at apply (SANTA), bind-only accepts
  // P5c follow-up (SANTA fc3c1f4): JVM-blessed Global.powHit k≠32 value+cost
  // (k=2/16/31) + require-boundary rejects (k=1/33, N=15). Independently pins
  // the (0 until k) index generalization the k=32 verify-path fixtures never
  // exercised, plus the (k+1)·7 cost coefficient.
  'Global.powHit_varying_k.json',
  'Global.powHit_require_boundary.json',
]

for (const file of VECTOR_FILES) {
  const doc = JSON.parse(fs.readFileSync(path.join(vectorDir, file), 'utf8')) as SantaVector
  describe(`SANTA v6 conformance — ${doc.op} (${doc.blessed_by})`, () => {
    for (const e of doc.entries) {
      it(e.name, () => {
        const actual = evalSantaEntry(e)
        if (e.expected.error !== null) {
          expect(actual.error).toBe('errored')
        } else {
          expect(actual.value).toEqual(hydrateSValue(e.expected.value))
          expect(actual.cost).toBe(e.expected.cost)
        }
      })
    }
  })
}

// The composite-function HOF tree must reject below v3 (the SFunc-in-SPair type
// code is V3-gated; ergots reproduces this in validateV6Types). We derive the
// v2 case from the blessed v3 entry rather than ship a separate fixture.
describe('v6 HOF gate — composite-function tree rejects below v3', () => {
  it('higher order lambdas tree at ergoTree v2 → errored', () => {
    const doc = JSON.parse(
      fs.readFileSync(path.join(vectorDir, 'higher_order_lambdas.json'), 'utf8'),
    ) as SantaVector
    const e = doc.entries[0]!
    const v2: SantaEntry = { ...e, name: `${e.name}@v2`, version: { activated: 2, ergoTree: 2 } }
    expect(evalSantaEntry(v2).error).toBe('errored')
  })
})
