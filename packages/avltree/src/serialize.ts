/**
 * Storage-format serialization for AVL+ tree nodes.
 *
 * Consensus-agnostic — these serialize the node *data* (keys, values, child
 * references as labels), not the proof-encoding used by the verifier.
 * Consumers (e.g. DAGsocial VersionedAVLStorage backends) use these to
 * persist and restore trees.
 *
 * Binary format:
 *   Leaf:     0x01 || keyLen(2B BE) || key || valueLen(4B BE) || value
 *                 || nextLeafKeyLen(2B BE) || nextLeafKey
 *   Internal: 0x02 || keyLen(2B BE) || key || balance(1B, i8→u8)
 *                 || leftLabel(32B) || rightLabel(32B)
 *   Label:    0x03 || label(32B)
 *
 * For Leaf, keyLen=0 means key is empty (chain-optimized — caller fills from
 * previous leaf's nextLeafKey, same as the proof format).
 *
 * For Internal, keyLen=0 means key is absent (verifier-only reconstructed nodes).
 *
 * Balance byte: `node.balance & 0xff` (-1 → 0xff, 0 → 0x00, 1 → 0x01).
 *
 * Children of Internal nodes are stored by label (32-byte blake2b-256 digest).
 * On deserialization, children are reconstructed as LabelNodes.
 */

import {
  type AvlNode,
  newLeaf,
  newInternal,
  newLabel,
  label,
} from './node.js'

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Serialize an AVL+ node to binary storage format.
 *
 * Leaf:     0x01 || keyLen(2B BE) || key || valueLen(4B BE) || value
 *                || nextLeafKeyLen(2B BE) || nextLeafKey
 * Internal: 0x02 || keyLen(2B BE) || key || balance(1B, i8→u8)
 *                || leftLabel(32B) || rightLabel(32B)
 * Label:    0x03 || label(32B)
 *
 * For Internal nodes, children are stored as their blake2b-256 labels
 * (so the serialized form is independent of subtree depth).
 */
export function serializeNode(node: AvlNode): Uint8Array {
  switch (node.kind) {
    case 'leaf':
      return serializeLeaf(node)
    case 'internal':
      return serializeInternal(node)
    case 'label':
      return serializeLabel(node)
    default:
      throw new Error(`Unknown node kind: ${(node as AvlNode).kind}`)
  }
}

function serializeLeaf(node: import('./node.js').LeafNode): Uint8Array {
  const keyLen = u16BE(node.key.length)
  const valueLen = u32BE(node.value.length)
  const nxtLen = u16BE(node.nextLeafKey.length)

  return concat([
    new Uint8Array([0x01]),
    keyLen,
    node.key,
    valueLen,
    node.value,
    nxtLen,
    node.nextLeafKey,
  ])
}

function serializeInternal(node: import('./node.js').InternalNode): Uint8Array {
  const key = node.key
  const keyLen = u16BE(key ? key.length : 0)
  const balanceByte = new Uint8Array([node.balance & 0xff])
  const leftLabel = label(node.left)
  const rightLabel = label(node.right)

  const parts: Uint8Array[] = [
    new Uint8Array([0x02]),
    keyLen,
  ]
  if (key) {
    parts.push(key)
  }
  parts.push(balanceByte, leftLabel, rightLabel)
  return concat(parts)
}

function serializeLabel(node: import('./node.js').LabelNode): Uint8Array {
  return concat([new Uint8Array([0x03]), node.label])
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

/**
 * Deserialize a node from binary storage format.
 *
 * Reverse of {@link serializeNode}. Reconstructs the appropriate node variant.
 * Internal node children are reconstructed as LabelNodes (labelCache: null)
 * — the caller is responsible for re-labeling after tree assembly.
 *
 * @throws RangeError if the input is truncated or contains an unknown kind byte.
 */
export function deserializeNode(bytes: Uint8Array): AvlNode {
  if (bytes.length < 1) {
    throw new RangeError('deserializeNode: empty input')
  }

  // bytes.length >= 1 already checked above, but TS with
  // noUncheckedIndexedAccess sees bytes[0] as number | undefined.
  const kind: number = bytes[0]!
  switch (kind) {
    case 0x01:
      return deserializeLeaf(bytes)
    case 0x02:
      return deserializeInternal(bytes)
    case 0x03:
      return deserializeLabel(bytes)
    default:
      throw new RangeError(
        `deserializeNode: unknown kind byte 0x${kind.toString(16).padStart(2, '0')}`,
      )
  }
}

function deserializeLeaf(bytes: Uint8Array): import('./node.js').LeafNode {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 1

  // keyLen (2 bytes BE)
  if (offset + 2 > bytes.length) throw truncated('keyLen')
  const keyLen = view.getUint16(offset, false)
  offset += 2

  // key
  if (offset + keyLen > bytes.length) throw truncated('key')
  const key = bytes.slice(offset, offset + keyLen)
  offset += keyLen

  // valueLen (4 bytes BE)
  if (offset + 4 > bytes.length) throw truncated('valueLen')
  const valueLen = view.getUint32(offset, false)
  offset += 4

  // value
  if (offset + valueLen > bytes.length) throw truncated('value')
  const value = bytes.slice(offset, offset + valueLen)
  offset += valueLen

  // nextLeafKeyLen (2 bytes BE)
  if (offset + 2 > bytes.length) throw truncated('nextLeafKeyLen')
  const nxtLen = view.getUint16(offset, false)
  offset += 2

  // nextLeafKey
  if (offset + nxtLen > bytes.length) throw truncated('nextLeafKey')
  const nextLeafKey = bytes.slice(offset, offset + nxtLen)

  return newLeaf(key, value, nextLeafKey)
}

function deserializeInternal(bytes: Uint8Array): import('./node.js').InternalNode {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 1

  // keyLen (2 bytes BE)
  if (offset + 2 > bytes.length) throw truncated('keyLen')
  const keyLen = view.getUint16(offset, false)
  offset += 2

  // key (only present if keyLen > 0)
  let key: Uint8Array | undefined
  if (keyLen > 0) {
    if (offset + keyLen > bytes.length) throw truncated('key')
    key = bytes.slice(offset, offset + keyLen)
    offset += keyLen
  }

  // balance (1 byte)
  if (offset + 1 > bytes.length) throw truncated('balance')
  const balanceRaw = view.getInt8(offset)
  offset += 1

  // Validate balance
  if (balanceRaw < -1 || balanceRaw > 1) {
    throw new RangeError(
      `deserializeNode: invalid balance ${balanceRaw} (expected -1, 0, or 1)`,
    )
  }
  const balance = balanceRaw as -1 | 0 | 1

  // left label (32 bytes)
  if (offset + 32 > bytes.length) throw truncated('leftLabel')
  const leftLabelBytes = bytes.slice(offset, offset + 32)
  offset += 32

  // right label (32 bytes)
  if (offset + 32 > bytes.length) throw truncated('rightLabel')
  const rightLabelBytes = bytes.slice(offset, offset + 32)

  const left = newLabel(leftLabelBytes)
  const right = newLabel(rightLabelBytes)

  return newInternal(left, right, balance, key)
}

function deserializeLabel(bytes: Uint8Array): import('./node.js').LabelNode {
  // kind byte + 32-byte label
  if (bytes.length < 1 + 32) {
    throw truncated('label (need 32 bytes)')
  }
  const labelBytes = bytes.slice(1, 33)
  return newLabel(labelBytes)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a 16-bit unsigned integer as 2 bytes big-endian. */
function u16BE(n: number): Uint8Array {
  const out = new Uint8Array(2)
  out[0] = (n >> 8) & 0xff
  out[1] = n & 0xff
  return out
}

/** Encode a 32-bit unsigned integer as 4 bytes big-endian. */
function u32BE(n: number): Uint8Array {
  const out = new Uint8Array(4)
  out[0] = (n >>> 24) & 0xff
  out[1] = (n >>> 16) & 0xff
  out[2] = (n >>> 8) & 0xff
  out[3] = n & 0xff
  return out
}

/** Concatenate multiple Uint8Arrays into a single contiguous buffer. */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function truncated(field: string): RangeError {
  return new RangeError(`deserializeNode: truncated input while reading ${field}`)
}
