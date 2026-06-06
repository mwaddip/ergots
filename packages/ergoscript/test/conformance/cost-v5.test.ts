/**
 * SANTA v5 cost-divergence conformance — ergots vs JVM (`sigma-state-6.0.3`).
 *
 * These vectors are imported verbatim from SANTA (`vectors/eval/v5/`), the
 * JVM-blessed oracle, into `test/fixtures/conformance/v5/`. Each is a cost
 * family the SANTA run flagged as an ergots-vs-JVM cost divergence (inherited
 * from sigma-rust); see `~/projects/santa/prompts/ergots-v5-divergences.md`
 * (B1–B4) and the per-arm eval source for the JVM-aligned fix.
 *
 * Asserting the whole-tree cost against JVM surfaces every divergence in an
 * entry's tree, so a clean pass means the entry's tree matches JVM end-to-end.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evalSantaEntry, type SantaVector } from './_santa'
import { hydrateSValue } from '../_helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vectorDir = path.join(__dirname, '../fixtures/conformance/v5')

// Imported SANTA cost-arm vectors. Add the other three (indexOf, propBytes,
// NEQ-nested) as each arm is brought into conformance.
const VECTOR_FILES = [
  'Coll_flatMap_method_equivalence.json',
  'Coll_indexOf_method_equivalence.json',
  'Coll_updated_method_equivalence.json',
  'Coll_updateMany_method_equivalence.json',
  'GroupElement.negate_equivalence.json',
  'NEQ_of_nested_collections_and_tuples.json',
  'SigmaProp.propBytes_equivalence.json',
  'substConstants_equivalence.json',
  'atLeast_with_a_degenerate_bound.json',
]

// Entries that still diverge from JVM for a SEPARATE, tracked reason (not the
// cost arm under test). Skipped here with the reason so the suite stays green
// on what is actually fixed; each is a tracked task.
const KNOWN_DIVERGENCES: Record<string, Record<string, string>> = {
  // A3 (empty flatMap output elem type) closed by the method-signature resolver
  // (mir/method-signatures.ts): getEncoded (7:2) now resolves to Coll[SByte], so
  // empty-input flatMap returns Coll[SByte] like JVM. The Coll()#0 entry is no
  // longer divergent — un-skipped. See docs/specs/2026-06-01-ergoscript-a3-*.
}

for (const file of VECTOR_FILES) {
  const doc = JSON.parse(fs.readFileSync(path.join(vectorDir, file), 'utf8')) as SantaVector
  describe(`SANTA v5 conformance — ${doc.op} (${doc.blessed_by})`, () => {
    for (const e of doc.entries) {
      const known = KNOWN_DIVERGENCES[file]?.[e.name]
      const run = known ? it.skip : it
      run(`${e.name}${known ? ` [known divergence: ${known}]` : ''}`, () => {
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
