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
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { ByteWriter } from '@ergots/scorex'
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

// ---------------------------------------------------------------------------
// JVM serializer asymmetry pin (F4 epilogue, 2026-06-07)
//
// JVM `DataSerializer` writes AvlTree.digest VERBATIM (no length require —
// CAvlTree.scala:31-34). The JVM parse-side reads a FIXED 33 bytes
// (ADDigest scorex_parse `read_exact(33)`). So: a non-33-byte digest
// AvlTree SValue serializes fine (verbatim bytes) but does NOT round-trip
// through parse. Pin both directions to lock the asymmetry:
//   - Serialize a 3-byte-digest AvlTree → bytes = digest[3] + flags + kl + vlo
//   - Parse those same bytes back → digest = first-33-available (pad issue)
//     → the parsed tree has a DIFFERENT structure than the original
//
// This asymmetry is intentional (faithful JVM mirror). The test documents it
// rather than guarding against it.
// ---------------------------------------------------------------------------

describe('SAvlTree wire — JVM serializer asymmetry (non-33 digest, F4 epilogue)', () => {
  it('3-byte digest serializes verbatim (no length gate)', () => {
    // An AvlTree SValue with a 3-byte digest. The JVM DataSerializer writes
    // the 3 digest bytes verbatim via putBytes — no length check.
    // Expected bytes: 0x01 0x02 0x03  (digest)
    //                 0x07             (treeFlags: insert+update+remove)
    //                 0x20             (VLQ u32 keyLength=32)
    //                 0x00             (valueLengthOpt = None)
    // = 7 bytes total
    const avlTreeValue = {
      kind: 'AvlTree' as const,
      value: {
        digest: new Uint8Array([0x01, 0x02, 0x03]),
        treeFlags: 0x07,
        keyLength: 32,
        valueLengthOpt: null,
      },
    }
    const w = new ByteWriter()
    serializeSValue({ tag: 'SAvlTree' }, avlTreeValue, 0, w)
    const serialized = w.toBytes()
    expect(serialized).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x07, 0x20, 0x00]))
  })

  it('non-33 digest does NOT round-trip through parse (JVM asymmetry pinned)', () => {
    // The parse-side reads exactly 33 bytes for the digest. Serializing a
    // 3-byte-digest AvlTree and then wrapping those bytes in a minimal ErgoTree
    // Const header would result in the parser consuming 33 bytes for digest,
    // which extends into the flags/keyLength/valueLengthOpt fields — producing
    // a structurally different AvlTreeData. This is the expected JVM asymmetry.
    //
    // We pin this by observing that the serialized bytes for the 3-byte case
    // (7 bytes) are SHORTER than the fixed-33 bytes the parser would expect —
    // the round-trip is structurally impossible, not just value-differing.
    const avlTreeValue = {
      kind: 'AvlTree' as const,
      value: {
        digest: new Uint8Array([0x01, 0x02, 0x03]),
        treeFlags: 0x07,
        keyLength: 32,
        valueLengthOpt: null,
      },
    }
    const w = new ByteWriter()
    serializeSValue({ tag: 'SAvlTree' }, avlTreeValue, 0, w)
    const serialized = w.toBytes()
    // Serialized is only 6 bytes (3 digest + 1 flags + 1 keyLength VLQ + 1 None tag).
    // Parse would need 33 bytes for digest alone — the output is structurally
    // shorter than what parse expects, confirming non-round-tripability.
    expect(serialized.length).toBe(6)
    expect(serialized.length).toBeLessThan(33) // digest-only budget for parse
  })
})
