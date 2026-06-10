/**
 * SANTA v5 conformance — ergots vs JVM (`sigma-state-6.0.3`).
 *
 * Registration is manifest-free: every vector file under
 * `test/fixtures/conformance/v5/{spec,authored}/` runs (the FULL JVM-blessed
 * corpus, vendored verbatim from SANTA `vectors/eval/v5/` — conformance-ledger
 * Decision #3: SANTA is upstream, these are permanent regression pins;
 * re-sync at phase boundaries via `tools/sync-santa-corpus.sh`).
 *
 * Tiers (upstream layout): `spec/` = vectors derived from the sigma-state
 * LSV5 spec corpus; `authored/` = SANTA-authored adversarial/edge families.
 *
 * Asserting the whole-tree cost against JVM surfaces every divergence in an
 * entry's tree, so a clean pass means the entry's tree matches JVM end-to-end.
 *
 * Corpus provenance (condensed — per-family history lives in git: this file's
 * pre-readdir VECTOR_FILES comments, and the SANTA-side blessing prompts under
 * `~/projects/santa/prompts/`):
 *   - B1–B4 cost-divergence families (Coll HOFs, NEQ-nested, propBytes,
 *     substConstants) — the original ergots-vs-JVM divergence pins.
 *   - F4 AvlTree Tier-2 cost faithfulness + epilogue acceptance corpus
 *     (bad-proof routing, per-op failure, degenerate edges, updateDigest).
 *   - F5 batches 1–4: numeric-kind coercion, sub-min-value Box, Tuple/
 *     SelectField/checkType eval rejects, SOption pre-v3 gate, Context
 *     accessors + op-forms, atLeast caps, EQ-of-SigmaProp basis, box
 *     byte-accessor basis.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evalSantaEntry, svalueToSantaJson, type SantaVector } from './_santa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vectorDir = path.join(__dirname, '../fixtures/conformance/v5')

const vectorFiles = (['spec', 'authored'] as const).flatMap((tier) =>
  fs
    .readdirSync(path.join(vectorDir, tier))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(tier, f)),
)

// Entries that still diverge from JVM for a SEPARATE, tracked reason (not the
// cost arm under test). Skipped here with the reason so the suite stays green
// on what is actually fixed; each is a tracked task. Keys are tier-relative
// file paths (e.g. 'authored/Option.map.json') → entry name → reason.
const KNOWN_DIVERGENCES: Record<string, Record<string, string>> = {
  // A3 (empty flatMap output elem type) closed by the method-signature resolver
  // (mir/method-signatures.ts): getEncoded (7:2) now resolves to Coll[SByte], so
  // empty-input flatMap returns Coll[SByte] like JVM. The Coll()#0 entry is no
  // longer divergent — un-skipped. See docs/specs/2026-06-01-ergoscript-a3-*.
}

for (const file of vectorFiles) {
  const doc = JSON.parse(fs.readFileSync(path.join(vectorDir, file), 'utf8')) as SantaVector
  describe(`SANTA v5 conformance — ${file} — ${doc.op} (${doc.blessed_by})`, () => {
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
