/**
 * Per-node storage codec for AVL+ trees.
 *
 * Byte-identical to `ergo_avltree_rust`'s `AVLTree::pack` (`batch_node.rs:595-618`)
 * and `AVLTree::unpack` (`batch_node.rs:622-654`), branch `main` @ 2941396.
 * Storage-layer only — the consensus-critical proof encoding lives in
 * `proof-decode.ts`.
 *
 * Format (big-endian):
 *   internal: 0x00 || balance(i8) || key(keyLength) || leftLabel(32) || rightLabel(32)
 *   leaf:     0x01 || key(keyLength) || [valueLen(u32) iff valueLengthOpt === null]
 *                  || value || nextLeafKey(keyLength)
 *
 * Label-only nodes are NOT serializable — Rust panics on that case. Storage
 * holds leaves and internals; label stubs exist only as transient child
 * references produced by `deserializeNode`.
 *
 * The format is not self-describing: key and value lengths come from
 * `AvlTreeConfig`, so a writer/reader config mismatch is not generally
 * detectable. Rust has the same property.
 *
 * Encoding an internal node memoises child labels into `labelCache` as a side
 * effect, matching Rust's `borrow_mut().label()`.
 */

import {
  type AvlNode,
  type LeafNode,
  type InternalNode,
  type Balance,
  newLeaf,
  newInternal,
  newLabel,
  label,
} from './node.js'
import type { AvlTreeConfig } from './types.js'

/** batch_node.rs:54 */
const INTERNAL_NODE_PREFIX = 0x00
/** batch_node.rs:55 */
const LEAF_NODE_PREFIX = 0x01
const LABEL_LENGTH = 32

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export function serializeNode(node: AvlNode, config: AvlTreeConfig): Uint8Array {
  switch (node.kind) {
    case 'leaf':
      return serializeLeaf(node, config)
    case 'internal':
      return serializeInternal(node, config)
    case 'label':
      throw new RangeError(
        'serializeNode: LabelNode is not serializable — storage holds only leaf and internal nodes',
      )
    default:
      // Unreachable from typed callers (AvlNode is exhaustively handled
      // above) but reachable from plain JS passing a malformed object. The
      // signature promises Uint8Array; falling through to `undefined` would
      // be the same silent-corruption shape as findings 1/2, and this
      // codec's whole job is refusing to corrupt storage.
      throw new RangeError(
        `serializeNode: unexpected node kind ${String((node as AvlNode).kind)}`,
      )
  }
}

function serializeLeaf(node: LeafNode, config: AvlTreeConfig): Uint8Array {
  assertFieldLength(node.key, config.keyLength, 'key')
  assertFieldLength(node.nextLeafKey, config.keyLength, 'nextLeafKey')

  const variable = config.valueLengthOpt === null
  if (!variable && node.value.length !== config.valueLengthOpt) {
    throw new RangeError(
      `serializeNode: leaf value length ${node.value.length} does not match configured valueLengthOpt ${config.valueLengthOpt}`,
    )
  }

  const out = new Uint8Array(
    1 + config.keyLength + (variable ? 4 : 0) + node.value.length + config.keyLength,
  )
  let o = 0
  out[o++] = LEAF_NODE_PREFIX
  out.set(node.key, o)
  o += config.keyLength
  if (variable) {
    writeU32BE(out, o, node.value.length)
    o += 4
  }
  out.set(node.value, o)
  o += node.value.length
  out.set(node.nextLeafKey, o)
  return out
}

function serializeInternal(node: InternalNode, config: AvlTreeConfig): Uint8Array {
  if (node.key === undefined) {
    throw new RangeError(
      'serializeNode: InternalNode has no key — verifier-reconstructed nodes are not storable',
    )
  }
  assertFieldLength(node.key, config.keyLength, 'key')

  const leftLabel = label(node.left)
  const rightLabel = label(node.right)

  const out = new Uint8Array(1 + 1 + config.keyLength + LABEL_LENGTH * 2)
  let o = 0
  out[o++] = INTERNAL_NODE_PREFIX
  // i8 -> u8: -1 becomes 0xff
  out[o++] = node.balance & 0xff
  out.set(node.key, o)
  o += config.keyLength
  out.set(leftLabel, o)
  o += LABEL_LENGTH
  out.set(rightLabel, o)
  return out
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function deserializeNode(bytes: Uint8Array, config: AvlTreeConfig): AvlNode {
  if (bytes.length < 1) {
    throw new RangeError('deserializeNode: empty input')
  }
  const tag = bytes[0]!
  if (tag === LEAF_NODE_PREFIX) return deserializeLeaf(bytes, config)
  if (tag === INTERNAL_NODE_PREFIX) return deserializeInternal(bytes, config)
  throw new RangeError(
    `deserializeNode: unknown node prefix 0x${tag.toString(16).padStart(2, '0')}`,
  )
}

function deserializeLeaf(bytes: Uint8Array, config: AvlTreeConfig): LeafNode {
  let o = 1
  const key = takeBytes(bytes, o, config.keyLength, 'key')
  o += config.keyLength

  let valueLength: number
  if (config.valueLengthOpt === null) {
    if (o + 4 > bytes.length) throw truncated('valueLength')
    valueLength = readU32BE(bytes, o)
    o += 4
  } else {
    valueLength = config.valueLengthOpt
  }

  const value = takeBytes(bytes, o, valueLength, 'value')
  o += valueLength
  const nextLeafKey = takeBytes(bytes, o, config.keyLength, 'nextLeafKey')
  return newLeaf(key, value, nextLeafKey)
}

function deserializeInternal(bytes: Uint8Array, config: AvlTreeConfig): InternalNode {
  let o = 1
  if (o >= bytes.length) throw truncated('balance')
  // u8 -> i8 reinterpret: 0xff becomes -1
  const balance = ((bytes[o]! << 24) >> 24) as Balance
  o += 1
  if (balance < -1 || balance > 1) {
    throw new RangeError(
      `deserializeNode: invalid balance ${balance} (expected -1, 0, or 1)`,
    )
  }

  const key = takeBytes(bytes, o, config.keyLength, 'key')
  o += config.keyLength
  const leftLabel = takeBytes(bytes, o, LABEL_LENGTH, 'leftLabel')
  o += LABEL_LENGTH
  const rightLabel = takeBytes(bytes, o, LABEL_LENGTH, 'rightLabel')

  return newInternal(newLabel(leftLabel), newLabel(rightLabel), balance, key)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function takeBytes(
  b: Uint8Array,
  offset: number,
  n: number,
  field: string,
): Uint8Array {
  // A declared length is only ever config.valueLengthOpt (caller-supplied,
  // not shape-checked upstream) or readU32BE's output (always a non-negative
  // safe integer when the >>> 0 coercion is intact). Validate it explicitly
  // before the bounds check below: a negative or non-finite n would make
  // `offset + n` UNDERSHOOT b.length, so the bounds check alone would not
  // catch it, and slicing with a negative end silently returns a truncated
  // (not throwing) result instead of the declared field.
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`deserializeNode: invalid length ${n} for ${field}`)
  }
  // Bounds-check BEFORE slicing so a bogus declared length cannot allocate.
  if (offset + n > b.length) throw truncated(field)
  return b.slice(offset, offset + n)
}

function truncated(field: string): RangeError {
  return new RangeError(`deserializeNode: truncated input while reading ${field}`)
}

function readU32BE(b: Uint8Array, o: number): number {
  return (
    ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
  )
}

function writeU32BE(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff
  b[o + 1] = (v >>> 16) & 0xff
  b[o + 2] = (v >>> 8) & 0xff
  b[o + 3] = v & 0xff
}

function assertFieldLength(
  value: Uint8Array,
  expected: number,
  field: string,
): void {
  if (value.length !== expected) {
    throw new RangeError(
      `serializeNode: ${field} length ${value.length} does not match configured keyLength ${expected}`,
    )
  }
}
