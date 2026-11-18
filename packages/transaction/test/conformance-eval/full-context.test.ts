/**
 * SANTA `santa-eval/v6-fullctx` conformance (ergots vs JVM, `jvm:sigma-state-6.0.7`).
 *
 * Every row of every vendored file under
 * `test/fixtures/conformance/eval-fullctx/{v5,v6}/` runs. A row absent from
 * the red table (`red-table.json`) must pass; a row listed in the red
 * table must NOT pass (the "row is green" sentinel otherwise).
 *
 * Why this harness is in `@ergots/transaction`: the SANTA full-context
 * schema binds an extension value's bytes through the node's own reader
 * (runner contract §4), which lives in this package (`parseContextExtension`).
 * The row check, the SANTA JSON conversion and the red-table shape mirror
 * the collection-conformance tests of `@ergots/ergoscript` — the same
 * contract, a second implementation tied to the full-context envelope.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evalFullContextEntry,
  svalueToSantaJson,
  rowMismatch,
  redReason,
  type SantaFullCtxEntry,
  type SantaFullCtxVector,
} from './_full-context'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX_DIR = path.join(__dirname, '../fixtures/conformance/eval-fullctx')

const groups = [
  { tier: 'v5' as const, files: ['Coll.patch_array_class_context.json', 'Coll.generic_producers.json'] },
  { tier: 'v6' as const, files: ['Coll.patch_array_class_context_v6.json', 'Coll.generic_producers_v6.json'] },
]

// The control row: a `ctl0` over `B.header.id` in the v6 patch file passes
// with value AND cost under the harness. This test stands apart from the
// red-table-driven loop so a harness defect shows as this test failing,
// not as every row of the file failing. The exact entry name is named
// here so a regression in the harness reports with a deterministic row.
describe('@ergots/transaction full-context conformance — control', () => {
  it('a header.id-ctl0 row of the v6 patch file passes with value and cost', () => {
    const doc = JSON.parse(
      fs.readFileSync(path.join(FIX_DIR, 'v6', 'Coll.patch_array_class_context_v6.json'), 'utf8'),
    ) as SantaFullCtxVector
    const control = doc.entries.find(e => /B\.header\.id-ctl0/.test(e.name))
    if (!control) throw new Error('no B.header.id-ctl0 row found in the v6 patch file')
    const actual = evalFullContextEntry(control)
    expect(actual.error).toBeNull()
    expect(actual.value, `entry ${control.name}: expected a value`).not.toBeNull()
    expect(
      JSON.stringify(svalueToSantaJson(actual.value!)),
      `entry ${control.name}: value`,
    ).toBe(JSON.stringify(control.expected.value))
    expect(actual.cost, `entry ${control.name}: cost`).toBe(control.expected.cost)
  })
})

for (const g of groups) {
  for (const file of g.files) {
    const absPath = path.join(FIX_DIR, g.tier, file)
    const doc = JSON.parse(fs.readFileSync(absPath, 'utf8')) as SantaFullCtxVector
    const key = `${g.tier}/${file}`
    describe(`SANTA ${g.tier}-fullctx conformance — ${key} — ${doc.op} (${doc.blessed_by})`, () => {
      for (const e of doc.entries as SantaFullCtxEntry[]) {
        it(e.name, () => {
          const listed = redReason(key, e.name)
          const mismatch = rowMismatch(e)
          if (listed === null) {
            expect(mismatch, `entry ${e.name}: ${mismatch}`).toBeNull()
          } else {
            expect(
              mismatch,
              `entry ${e.name}: row is green; remove it from the red table (listed under '${listed}')`,
            ).not.toBeNull()
          }
        })
      }
    })
  }
}
