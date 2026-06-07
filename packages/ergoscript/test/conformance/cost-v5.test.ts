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
  'AvlTree.remove.json',
  'AvlTree.updateOperations_updateDigest.json',
  // F4 Epilogue — acceptance-corpus round (2026-06-07). SANTA reply:
  // ~/projects/santa/prompts/f4-santa-asks.md §SANTA REPLY. 16 files (9 v5 + 7 v6)
  // across 4 fix families; Tasks 2-4 close the 9 reds.
  //
  // bad_proof_bytes (5 entries): bad-proof-bytes routing — contains→false, get/insert→errored.
  // Validates construct-fail routing for the three one-op methods (T7.5 class).
  'AvlTree.bad_proof_bytes.json',
  // degenerate_edges (4 entries): mismatched-op-type remove→None, empty-keys/entries batches.
  // Pins zero-op-loop and op-type-mismatch routing per method.
  'AvlTree.degenerate_edges.json',
  // empty_ops_valid_proof (3 entries): insert/update/remove with 0-op valid proof → Some(AvlTree).
  // Pins that a zero-ops valid proof charges updateDigest(40) and returns Some(starting digest).
  'AvlTree.empty_ops_valid_proof.json',
  // per_op_failure (20 entries): wrong-length key / ±inf key / wrong-val-len, all methods.
  // Pins the per-op-fail routing per method (contains→false, get/getMany→errored, modify→None/v-split).
  'AvlTree.per_op_failure.json',
  // wrong_tree_proof (6 entries): proof for a different tree (bad-proof class, all 6 methods).
  // Pins the full bad-proof routing matrix.
  'AvlTree.wrong_tree_proof.json',
  // negative_keylength_tree (5 entries): construct-shape keyLength<0 routing. 4 entries GREEN
  // via T7.5 (contains→false, get→errored, insert→errored, remove→None). 1 RED (Task 4):
  // keyLength-negative#4 — accessor returns Int(-2147483648) not u32(2147483648).
  'AvlTree.negative_keylength_tree.json',
  // keyLength_wrapped_negative (1 entry): wire 0x80000001 → keyLength accessor Int(-2147483647).
  // RED until Task 4 (i32 view on accessor). SANTA reply §C.
  'AvlTree.keyLength_wrapped_negative.json',
  // updateDigest_any_length (4 entries): 3-byte/empty/40-byte digest → Some(AvlTree) cost 46;
  // readback → Coll[1,2,3] cost 65. RED ×4 until Task 3 (JVM accepts ANY digest length).
  'AvlTree.updateDigest_any_length.json',
  // unsupported_eval_nodes (1 entry): tree_lookup-errored#0 @v2. GREEN since the
  // F4-epilogue unconditional eval-reject ('unsupported-eval-node' — JVM has no
  // eval override, trees.scala:1322-1338, costKind=notSupportedError).
  'AvlTree.unsupported_eval_nodes.json',
  // F5 batch 1 — f4-divergences green pins (2026-06-07, SANTA re-grade off santa a1e0876;
  // prompt ~/projects/santa/prompts/ergots-f4-divergences.md):
  // ArithOp Int+Long @v0 → Long 3 @ 35 (2026-06-01 mismatched-numeric coercion class);
  // Box.value on a sub-min-value box → Long 1 @ 33 (min-box-value is tx-layer, eval surfaces it);
  // AvlTree valueLengthOpt wire 0x80000001 → Some(-2147483647) cost 20 (epilogue Task-4 `| 0`
  // i32 view, now SANTA-blessed — closes the vector-unblessed leg).
  'ArithOp.numeric_kind_mismatch.json',
  'Box.sub_min_value.json',
  'AvlTree.valueLengthOpt_wrapped_negative.json',
  // Tuple non-pair = eval-layer reject (values.scala:795-798 "Invalid tuple": arity≠2 throws
  // BEFORE items + cost; constants exempt). The walker-era flat-tuple JVM-alignment follow-up,
  // now JVM-pinned. Tree 0086030101020703a413 = v0 Tuple(true, 7.toByte, 1234.toShort).
  'Tuple.non_pair_arity3.json',
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
