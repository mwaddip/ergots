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

import { type SantaVector } from './_santa'
import { loadRedTable, RED_REASONS, redReason, rowMismatch } from './_red-table'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vectorDir = path.join(__dirname, '../fixtures/conformance/v5')

const vectorFiles = (['spec', 'authored'] as const).flatMap((tier) => {
  const files = fs
    .readdirSync(path.join(vectorDir, tier))
    .filter((f) => f.endsWith('.json'))
    .sort()
  // Tripwire: the corpus is append-only (ledger Decision #3) — an empty or
  // shrunken tier means a wipe or a partial sync, not a legitimate state.
  if (files.length === 0) {
    throw new Error(`conformance ${tier}/ tier is empty — wiped or partial sync?`)
  }
  return files.map((f) => path.join(tier, f))
})
if (vectorFiles.length < 100) {
  throw new Error(`conformance v5 corpus shrank to ${vectorFiles.length} files (floor 100; 131 @ 2026-06-10) — partial sync?`)
}

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

// Self-test for the red table: every path it names exists under
// test/fixtures/conformance/<v5|v6>/, every entry it names exists in that
// file, every reason id it uses is in RED_REASONS, and no entry is listed
// twice (within a file OR across reason ids).
describe('red-table self-check', () => {
  const fixturesRoot = path.join(__dirname, '../fixtures/conformance')
  const table = loadRedTable()

  it('every reason id used is in RED_REASONS', () => {
    for (const byReason of Object.values(table)) {
      for (const reason of Object.keys(byReason)) {
        expect(RED_REASONS[reason], `unknown reason id '${reason}'`).toBeDefined()
      }
    }
  })

  it('every file and entry exists; no duplicate entries per file', () => {
    for (const [filePath, byReason] of Object.entries(table)) {
      const diskPath = path.join(fixturesRoot, filePath)
      expect(fs.existsSync(diskPath), `missing fixture ${filePath}`).toBe(true)
      const doc = JSON.parse(fs.readFileSync(diskPath, 'utf8')) as SantaVector
      const entryNames = new Set(doc.entries.map((e) => e.name))
      const seen = new Set<string>()
      for (const [reason, entries] of Object.entries(byReason)) {
        for (const entry of entries) {
          expect(entryNames.has(entry), `${filePath} has no entry '${entry}'`).toBe(true)
          expect(seen.has(entry), `${filePath}: entry '${entry}' listed twice (duplicate in '${reason}' or across reasons)`).toBe(false)
          seen.add(entry)
        }
      }
    }
  })
})

for (const file of vectorFiles) {
  const doc = JSON.parse(fs.readFileSync(path.join(vectorDir, file), 'utf8')) as SantaVector
  describe(`SANTA v5 conformance — ${file} — ${doc.op} (${doc.blessed_by})`, () => {
    for (const e of doc.entries) {
      const known = KNOWN_DIVERGENCES[file]?.[e.name]
      const run = known ? it.skip : it
      run(`${e.name}${known ? ` [known divergence: ${known}]` : ''}`, () => {
        // Single row check: null on match, a short failure description otherwise.
        // A row NOT in the red table must match; a row IN the red table must NOT
        // match (a listed row that passes fails with the sentinel text below).
        const listed = redReason(`v5/${file}`, e.name)
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
