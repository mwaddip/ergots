/**
 * A box's tree under the box rules, and its re-encoding: what the JVM's candidate serializer
 * writes (ErgoBoxCandidate.scala:142, serializeErgoTree at ErgoTreeSerializer.scala:105-127).
 */
import { ByteReader, ReaderError } from '@ergots/scorex'
import type { ErgoTree, TreeHeader } from '../mir/types'
import { isUnparsedTree } from '../mir/types'
import { parseTreeFromReader, serializeTree, ErgoTreeParseError } from './ergo-tree'
import { boxTreeCache, seedBoxTree } from './box-tree-cache'

export { seedBoxTree }

/**
 * The box's tree under the box rules (`checkType`, ErgoBoxCandidate.scala:194): the tree box ingest
 * parsed for these bytes, or, on a miss, one standalone parse of them (spec 2026-09-28 §8).
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
    const rawHeader = bytes[0] ?? 0
    if ((rawHeader & 0x08) !== 0 && err instanceof ReaderError && err.code === 'truncated') {
      // The tree's own reads ran past its declared span: in its box it degraded (ErgoTreeSerializer
      // .scala:196-203), so these bytes are its declared span.
      const header: TreeHeader = {
        version: (rawHeader & 0x07) as TreeHeader['version'],
        hasSize: true,
        constantSegregation: (rawHeader & 0x10) !== 0,
        rawHeader,
      }
      return { header, unparsedBytes: bytes.slice(), error: err }
    }
    if (err instanceof ErgoTreeParseError && err.code === 'nested-tree-truncated') {
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
