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
 * The file also carries later JVM-blessed authored families (e.g. F1 atLeast
 * degenerate bounds) that are not cost-divergence vectors.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evalSantaEntry, svalueToSantaJson, type SantaVector } from './_santa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vectorDir = path.join(__dirname, '../fixtures/conformance/v5')

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
  'EQ_of_SigmaProp.json',
  'EQ_of_SigmaProp_unequal.json',
  'EQ_of_SigmaProp_conjecture_mismatch.json',
  'Box.signed_view_u64.json',
  'Option.map.json',
  // F4 — AvlTree Tier-2 cost faithfulness (JVM-blessed, santa:authored-avl-tier2).
  // Spec: docs/specs/2026-06-07-ergoscript-f4-avltree-tier2-cost-design.md.
  'AvlTree.get.json',
  'AvlTree.contains.json',
  'AvlTree.getMany.json',
  'AvlTree.get_proof_ladder.json',
  'AvlTree.proof_adversarial.json',
  'AvlTree.insert.json',
  'AvlTree.update.json',
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
          // Compare at SANTA canonical JSON level to avoid false mismatches on
          // ergots' internal fields (e.g. Option.elem, which SANTA omits).
          // svalueToSantaJson normalises the actual before comparison; the
          // expected is already in SANTA canonical JSON form in the vector.
          expect(svalueToSantaJson(actual.value!)).toEqual(e.expected.value)
          expect(actual.cost).toBe(e.expected.cost)
        }
      })
    }
  })
}
