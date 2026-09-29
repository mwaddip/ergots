/**
 * A box's tree under the box rules, and its re-encoding: what the JVM's candidate serializer
 * writes (ErgoBoxCandidate.scala:142, serializeErgoTree at ErgoTreeSerializer.scala:105-127).
 */
import { ByteReader, ReaderError, readVlqU32 } from '@ergots/scorex'
import type { ErgoTree } from '../mir/types'
import { isUnparsedTree } from '../mir/types'
import { parseTreeFromReader, serializeTree, decodeTreeHeader, ErgoTreeParseError } from './ergo-tree'
import { boxTreeCache, seedBoxTree } from './box-tree-cache'

export { seedBoxTree }

/**
 * The box's tree under the box rules (`checkType`, ErgoBoxCandidate.scala:194): the tree box ingest
 * parsed for these bytes, or, on a miss, one standalone parse of them (spec 2026-09-28 §8). The
 * result is the cached tree object, shared by every caller: callers must not mutate it, nor the
 * bytes after first use (the key is the instance).
 */
export function boxTreeOf(ergoTreeBytes: Uint8Array): ErgoTree {
  const hit = boxTreeCache.get(ergoTreeBytes)
  if (hit) return hit.tree
  const tree = parseStandalone(ergoTreeBytes)
  boxTreeCache.set(ergoTreeBytes, { tree })
  return tree
}

/**
 * serializeErgoTree(box.ergoTree) (ErgoTreeSerializer.scala:105-127): a parsed tree re-encoded from
 * its structure, an unparsed one as its raw bytes (:112). Cached only once it succeeds. The result is
 * the cached array (for an unparsed tree, the tree's own bytes): callers must not mutate it.
 */
export function reencodeTreeBytes(ergoTreeBytes: Uint8Array): Uint8Array {
  const tree = boxTreeOf(ergoTreeBytes)
  const entry = boxTreeCache.get(ergoTreeBytes)!
  if (entry.reencoded === undefined) {
    entry.reencoded = isUnparsedTree(tree) ? tree.unparsedBytes : serializeTree(tree)
  }
  return entry.reencoded
}

/** A miss: the bytes did not come through box ingest. Spec §8 miss rule. */
function parseStandalone(bytes: Uint8Array): ErgoTree {
  const r = new ByteReader(bytes)
  let tree: ErgoTree
  try {
    tree = parseTreeFromReader(r, { checkType: true })
  } catch (err) {
    // An empty array has no header byte and reads as a tree without the size flag.
    const header = decodeTreeHeader(bytes[0] ?? 0)
    if (header.hasSize && err instanceof ReaderError && err.code === 'truncated') {
      // The tree's own reads ran out: in its box it degraded (ErgoTreeSerializer.scala:196-203),
      // and box ingest kept its declared span. Bytes that are not that span are no box span.
      if (isDeclaredSpan(bytes)) return { header, unparsedBytes: bytes.slice(), error: err }
      throw err
    }
    if (err instanceof ErgoTreeParseError && err.code === 'nested-tree-truncated') {
      // A nested tree ran out of input, or its degrade span did: in the box, the bytes after
      // this tree may have held it (spec 2026-09-28 §8).
      throw new ErgoTreeParseError(
        'a nested tree ran out of input: the result depends on the bytes after this tree in its box; ' +
          'parse the box (parseErgoTreeBytes) or seed the tree (seedBoxTree)',
        'box-context-required', { cause: err })
    }
    throw err
  }
  if (!r.isExhausted) {
    throw new ErgoTreeParseError(`${r.remaining} trailing bytes after the box tree`, 'trailing-bytes')
  }
  return tree
}

/**
 * Whether the bytes of a sized tree are the span its degrade reads: `[0, bodyPos + declared)`, in
 * the JVM's Int arithmetic (ErgoTreeSerializer.scala:200). A declared size that wraps negative can
 * end that span inside the size VLQ itself (`09 fe ff ff`, from a size of toInt -2), so a size read
 * that runs out also marks a span.
 */
function isDeclaredSpan(bytes: Uint8Array): boolean {
  const r = new ByteReader(bytes)
  r.readU8()
  let declared: number
  try {
    declared = readVlqU32(r, 'ErgoTree size') | 0
  } catch (err) {
    if (err instanceof ReaderError && err.code === 'truncated') return true
    throw err
  }
  return ((r.position + declared) | 0) === bytes.length
}
