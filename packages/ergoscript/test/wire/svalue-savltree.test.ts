/**
 * Phase 2h-b: `SAvlTree` wire format — parse + serialize round-trip.
 *
 * `Const(SAvlTree, AvlTreeData)` is the inline-constant form of an AVL-tree
 * value on the ErgoScript wire. Phase 2a deferred SAvlTree alongside
 * SHeader/SPreHeader/SContext/SGlobal/SAny/SString/SFunc/STypeVar — every
 * such case threw `SValueParseError`/`SValueSerializeError` with code
 * `not-implemented-phase-2a`. Phase 2h-b's Tier 1 and Tier 2 method
 * handlers (savltree-digest, savltree-contains, …) require SAvlTree to
 * parse + serialize cleanly because the fixture-driven tests inline the
 * tree value as a `Const(SAvlTree, _)` inside the body.
 *
 * Wire layout (sigma-rust `ergotree-ir/src/mir/avl_tree_data.rs:71-90`):
 *
 *   digest          — ADDigest scorex_serialize: 33 RAW bytes
 *                     (Digest<N> is `write_all(self.0)` —
 *                     ergo-chain-types/src/digest32.rs:149-153).
 *                     The 33rd byte is the tree-height byte.
 *   treeFlags       — single u8 (`put_u8`):
 *                     bit 0 = insertAllowed, bit 1 = updateAllowed,
 *                     bit 2 = removeAllowed; bits 3-7 reserved.
 *   keyLength       — VLQ u32 (`put_u32` → `put_u64(v as u64)` —
 *                     sigma-ser/src/vlq_encode.rs:78).
 *   valueLengthOpt  — Option<Box<u32>> SigmaSerializable
 *                     (serialization/serializable.rs:212-231):
 *                       Some(v) → 0x01 + sigma_serialize(v) = 0x01 + VLQ-u32
 *                       None    → 0x00
 *                     Parse path: any non-zero tag means Some.
 *
 * Coverage: every SAvlTree fixture under `test/fixtures/eval/savltree-*.json`
 * exercises a `Const(SAvlTree, _)` somewhere in its body. Asserting
 * byte-for-byte `serializeTree(parseTree(b)) === b` for every entry in
 * every file is the corpus-wide round-trip guarantee for the SAvlTree
 * wire surface.
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { hexToBytes } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'eval')

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i]! < 0x10 ? '0' : '') + bytes[i]!.toString(16)
  }
  return out
}

const SAVLTREE_FIXTURES = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.startsWith('savltree-') && f.endsWith('.json'))
  .sort()

describe('SAvlTree wire format — Const(SAvlTree, AvlTreeData) round-trip', () => {
  // Guard: fixture-gen must have produced at least one fixture file —
  // otherwise an empty test silently passes and hides a missing fixture.
  it('fixture set is non-empty', () => {
    expect(SAVLTREE_FIXTURES.length).toBeGreaterThan(0)
  })

  for (const filename of SAVLTREE_FIXTURES) {
    const fixturePath = path.join(FIXTURE_DIR, filename)
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as FixtureFile

    describe(`${filename}`, () => {
      for (const entry of fixture.entries) {
        it(`round-trip: ${entry.name}`, () => {
          const bytes = hexToBytes(entry.tree_bytes_hex)

          // Parse — must not throw 'not-implemented-phase-2a'.
          const tree = parseTree(bytes)
          expect(tree).toBeDefined()
          expect(tree.body).toBeDefined()

          // Serialize — byte-identical to the input.
          const reserialized = serializeTree(tree)
          expect(
            bytesEqual(reserialized, bytes),
            `${entry.name}: reserialized=${bytesToHex(reserialized)} ` +
              `fixture=${entry.tree_bytes_hex}`
          ).toBe(true)
        })
      }
    })
  }
})
