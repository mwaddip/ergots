/**
 * SAvlTree.contains (100:9) — Tier-2 verification op handler.
 *
 * Fixture-driven success/absent/mutated suite + a TS-only throw-path test
 * that asserts construct-failure raises EvalError 'avl-tree-proof-failed'.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:339-381 — CONTAINS_EVAL_FN.
 *
 * Failure model summary (per source-read confirmation):
 *   - verifier construct failure (line 372 `.map_err(map_eval_err)?`) → throw
 *   - per-op Lookup failure (line 379 `Err(_) => Boolean(false)`) → false
 *   - per-op result None / Some → false / true
 *
 * So the fixture `contains_proof_mutated` (per-op fail, not construct fail)
 * lands as `false`; a construct-failure case (which fixture-gen can't capture
 * because sigma-rust would throw before producing JSON) is exercised here as
 * a hand-crafted throw test below.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface ContainsEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface ContainsFixture {
  corpus: string
  entries: ContainsEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-contains.json')
const fixture: ContainsFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.contains — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('SAvlTree.contains — throw paths', () => {
  it('throws avl-tree-proof-failed when verifier construct fails (truncated proof)', () => {
    // Take the success fixture, truncate the proof's directions byte to 0
    // bytes -> ByteReader will hit EOF inside reconstruct_tree.
    // The trick: we need a tree whose proof bytes inside the wire ErgoTree
    // are short enough to fail construction. We'll edit the existing fixture
    // entry by mutating the proof's first byte (the packed-tree's "tag" byte
    // for the root node) to an invalid encoding 0xff — sigma-rust's
    // reconstruct_tree rejects unknown tags.
    const present = fixture.entries.find((e) => e.name === 'contains_key_present')
    if (present === undefined) throw new Error('test setup: missing fixture entry')

    // Mutate a byte deep in the proof's packed-tree section (offset chosen so
    // it lands inside the proof, not the proof-length VLQ or constants).
    // The Const encoding for proof Coll[Byte] starts ~position varies by tree;
    // use a heuristic: replace a known-good byte at offset (length - 5)
    // with 0xff. If the verifier accepts it, this test would fail at the
    // assertion below — flagging that the throw path isn't exercised. In
    // practice, the packed-tree's leaf tags and node-header bytes pepper the
    // proof, so flipping a late byte breaks structural integrity.
    //
    // Hard-cast: this is a construct-time failure if we pick wisely. If the
    // mutation lands in the directions section, we get a per-op false. To
    // force a construct failure reliably, prepend an extra constant slot:
    // easier path -- just stuff bytes that make the proof shorter than the
    // packed-tree wants. We use length-VLQ tampering: rewriting the
    // proof-length-VLQ byte to claim more bytes than follow makes
    // reconstruct_tree underrun.
    //
    // Pragmatic alternative: synthesize the tree from scratch with a known-
    // bad proof. But that's complex. Skip a sub-optimal mutation and use a
    // dedicated synthesizer below.
    //
    // For this initial throw-test, use a HAND-CONSTRUCTED case: parse a
    // working tree, then mutate the proof's IN-MEMORY constants payload via
    // re-encoding. We do this by editing the hex string directly at a known
    // proof offset.
    //
    // Construct-failure recipe: in the contains fixture, the proof's first
    // byte after its length VLQ is the packed-tree's root node-tag (0x00 =
    // LabelOnly, 0x01 = LeafWithKey, 0x02 = InternalWithLabel, etc.).
    // Setting it to 0xff yields "Unknown node header" failure deep inside
    // reconstruct_tree — which surfaces as construct-fail in sigma-rust's
    // BatchAVLVerifier::new().
    //
    // Locate the proof: scan the tree-bytes for the constant prefix
    // "55 03 0d 3b a8" (5 bytes of a known proof) — fragile; better to
    // mutate the LAST byte of the proof which is the trailing directions
    // count. Setting that to a value > available bits also triggers
    // reconstruct_tree underrun.
    //
    // Easiest reliable mutation: append a length-0 proof. Build a custom
    // tree from scratch in test fixtures. For now, do the simple thing:
    // mutate the bytes inside the packed-tree section of contains_key_present.
    // We rely on the parsed tree's `proof` Const value being at a stable
    // offset within tree.constants[1] (second constant). We can simply
    // re-construct the ErgoTree bytes with a trashed proof Const.
    //
    // Concretely: the fixture's hex is the FULL ErgoTree wire bytes. The
    // proof Const lives inside the constants section. We find the proof
    // hex run ("0e55..." onwards) and zero out the FIRST byte of the
    // packed-tree (the byte right after the length VLQ). This is a
    // construct failure because the packed-tree expects the root header
    // byte first.
    const goodHex = present.tree_bytes_hex
    // Substitute the bytes after the proof Const header "0e55" with all-zeros
    // (preserving length). 0e = SColl Byte tag, 55 = VLQ length 85.
    // Wait — proof length here is 0x55 = 85, so the proof spans the next 85
    // bytes (170 hex chars) after the "0e55" tag+length pair. We replace
    // those 170 hex chars with all "00" -> a proof of all zeros, which
    // is INVALID (zero is LabelOnly which expects a label, but the digest
    // won't anchor the empty-label root).
    const proofTagIdx = goodHex.indexOf('0e55030d3b')
    if (proofTagIdx < 0) throw new Error('test setup: proof prefix not found')
    const proofBodyStart = proofTagIdx + 4 // skip "0e55"
    const proofBodyLen = 85 * 2 // 85 bytes * 2 hex chars
    const mutated =
      goodHex.slice(0, proofBodyStart) +
      '00'.repeat(85) +
      goodHex.slice(proofBodyStart + proofBodyLen)

    const tree = parseTree(hexToBytes(mutated))
    const ctx = makeContext({})
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('avl-tree-proof-failed')
  })
})
