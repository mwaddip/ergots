import { describe, it, expect } from 'vitest'
import {
  serializeNode,
  deserializeNode,
  newLeaf,
  newInternal,
  newLabel,
  label,
  type AvlNode,
} from '../src/index.js'

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

/** Concatenate Uint8Arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Compare two nodes structurally (ignore labelCache). */
function nodesEqual(a: AvlNode, b: AvlNode): boolean {
  if (a.kind !== b.kind) return false

  switch (a.kind) {
    case 'leaf': {
      const lb = b as typeof a
      return (
        bytesEqual(a.key, lb.key) &&
        bytesEqual(a.value, lb.value) &&
        bytesEqual(a.nextLeafKey, lb.nextLeafKey)
      )
    }
    case 'internal': {
      const ib = b as typeof a
      return (
        // key: both undefined, or both defined + equal
        (a.key === undefined && ib.key === undefined) ||
        (a.key !== undefined && ib.key !== undefined && bytesEqual(a.key, ib.key))
      ) &&
        a.balance === ib.balance &&
        // skip labelCache — reconstructed nodes have null
        nodesEqual(a.left, ib.left) &&
        nodesEqual(a.right, ib.right)
    }
    case 'label': {
      const llb = b as typeof a
      return bytesEqual(a.label, llb.label)
    }
    default:
      return false
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Roundtrip tests
// ---------------------------------------------------------------------------

describe('serializeNode / deserializeNode roundtrip', () => {
  it('roundtrips a LeafNode with key, value, and nextLeafKey', () => {
    const leaf = newLeaf(
      new Uint8Array([0x01, 0x02, 0x03]),
      new Uint8Array([0xaa, 0xbb]),
      new Uint8Array([0x10, 0x20]),
    )
    const bytes = serializeNode(leaf)
    const restored = deserializeNode(bytes)
    expect(nodesEqual(leaf, restored)).toBe(true)
  })

  it('roundtrips a LeafNode with zero-length key (key omission)', () => {
    const leaf = newLeaf(
      new Uint8Array([]),
      new Uint8Array([0xcc]),
      new Uint8Array([0xff]),
    )
    const bytes = serializeNode(leaf)
    // Verify wire format: keyLen=0, no key bytes
    expect(bytes[0]).toBe(0x01) // kind
    expect(bytes[1]).toBe(0x00) // keyLen hi
    expect(bytes[2]).toBe(0x00) // keyLen lo
    // valueLen immediately follows keyLen (2 bytes for keyLen + 0 key bytes)
    expect(bytes[3]).toBe(0x00) // valueLen byte 0
    expect(bytes[4]).toBe(0x00) // valueLen byte 1
    expect(bytes[5]).toBe(0x00) // valueLen byte 2
    expect(bytes[6]).toBe(0x01) // valueLen byte 3 (1 byte)
    expect(bytes[7]).toBe(0xcc) // value

    const restored = deserializeNode(bytes)
    expect(nodesEqual(leaf, restored)).toBe(true)
  })

  it('roundtrips a LeafNode with zero-length value', () => {
    const leaf = newLeaf(
      new Uint8Array([0x01]),
      new Uint8Array([]),
      new Uint8Array([0x02]),
    )
    const bytes = serializeNode(leaf)
    const restored = deserializeNode(bytes)
    expect(nodesEqual(leaf, restored)).toBe(true)
  })

  it('roundtrips an InternalNode with key', () => {
    const left = newLeaf(
      new Uint8Array([0x01]),
      new Uint8Array([0xaa]),
      new Uint8Array([0x02]),
    )
    const right = newLeaf(
      new Uint8Array([0x03]),
      new Uint8Array([0xbb]),
      new Uint8Array([0x04]),
    )
    const internal = newInternal(left, right, 1, new Uint8Array([0x02]))
    // Pre-compute labels so the reconstructed node can be compared
    label(internal)

    const bytes = serializeNode(internal)
    const restored = deserializeNode(bytes)

    // Internal: reconstructed children are LabelNodes (label-only stubs).
    // We verify:
    //   1. key, balance roundtrip
    //   2. left/right are LabelNodes with correct labels
    expect(restored.kind).toBe('internal')
    const ri = restored as typeof internal
    expect(ri.balance).toBe(1)
    expect(ri.key).toBeDefined()
    expect(bytesEqual(ri.key!, new Uint8Array([0x02]))).toBe(true)
    expect(ri.left.kind).toBe('label')
    expect(ri.right.kind).toBe('label')
    expect(bytesEqual((ri.left as { label: Uint8Array }).label, label(left))).toBe(true)
    expect(bytesEqual((ri.right as { label: Uint8Array }).label, label(right))).toBe(true)
  })

  it('roundtrips an InternalNode without key', () => {
    const left = newLabel(new Uint8Array(32).fill(0x11))
    const right = newLabel(new Uint8Array(32).fill(0x22))
    const internal = newInternal(left, right, -1) // key undefined

    const bytes = serializeNode(internal)
    const restored = deserializeNode(bytes)

    expect(restored.kind).toBe('internal')
    const ri = restored as typeof internal
    expect(ri.balance).toBe(-1)
    expect(ri.key).toBeUndefined()
    // left/right are label stubs with correct labels
    expect(ri.left.kind).toBe('label')
    expect(ri.right.kind).toBe('label')
    expect(bytesEqual((ri.left as { label: Uint8Array }).label, left.label)).toBe(true)
    expect(bytesEqual((ri.right as { label: Uint8Array }).label, right.label)).toBe(true)
  })

  it('roundtrips a LabelNode', () => {
    const lbl = newLabel(new Uint8Array(32).fill(0xab))
    const bytes = serializeNode(lbl)
    const restored = deserializeNode(bytes)
    expect(nodesEqual(lbl, restored)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Balance byte roundtrip
// ---------------------------------------------------------------------------

describe('balance byte roundtrip', () => {
  for (const balance of [-1, 0, 1] as const) {
    it(`roundtrips balance=${balance}`, () => {
      const left = newLabel(new Uint8Array(32).fill(0xaa))
      const right = newLabel(new Uint8Array(32).fill(0xbb))
      const internal = newInternal(left, right, balance)

      const bytes = serializeNode(internal)
      // balance is at offset: 1 (kind) + 2 (keyLen=0) + 0 (no key) = 3
      expect(bytes[3]).toBe(balance & 0xff)

      const restored = deserializeNode(bytes)
      expect(restored.kind).toBe('internal')
      expect((restored as typeof internal).balance).toBe(balance)
    })
  }
})

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe('deserializeNode malformed input', () => {
  it('throws on empty input', () => {
    expect(() => deserializeNode(new Uint8Array([]))).toThrow()
  })

  it('throws on unknown kind byte', () => {
    // kind=0xFF doesn't exist
    expect(() => deserializeNode(new Uint8Array([0xff, 0x00, 0x00, 0x00]))).toThrow()
  })

  it('throws on truncated leaf (missing fields after kind)', () => {
    // valid kind, but not enough bytes for the header
    expect(() => deserializeNode(new Uint8Array([0x01, 0x00]))).toThrow()
  })

  it('throws on truncated leaf (keyLen says 5 bytes but only 2 present)', () => {
    const bytes = concat(
      new Uint8Array([0x01]), // kind
      u16BE(5), // keyLen = 5
      new Uint8Array([0xaa, 0xbb]), // only 2 key bytes
    )
    expect(() => deserializeNode(bytes)).toThrow()
  })

  it('throws on truncated leaf (valueLen says 10 bytes but only 2 present)', () => {
    const key = new Uint8Array([0x01, 0x02])
    const bytes = concat(
      new Uint8Array([0x01]), // kind
      u16BE(key.length), // keyLen
      key,
      u32BE(10), // valueLen = 10
      new Uint8Array([0xaa, 0xbb]), // only 2 value bytes
    )
    expect(() => deserializeNode(bytes)).toThrow()
  })

  it('throws on truncated leaf (nextLeafKeyLen says 3 bytes but only 1 present)', () => {
    const key = new Uint8Array([0x01])
    const value = new Uint8Array([0x02])
    const bytes = concat(
      new Uint8Array([0x01]),
      u16BE(key.length),
      key,
      u32BE(value.length),
      value,
      u16BE(3), // nextLeafKeyLen = 3
      new Uint8Array([0xaa]), // only 1 byte
    )
    expect(() => deserializeNode(bytes)).toThrow()
  })

  it('throws on truncated internal (missing balance after keyLen)', () => {
    expect(() =>
      deserializeNode(new Uint8Array([0x02, 0x00, 0x00])),
    ).toThrow()
  })

  it('throws on truncated internal (balance present but missing child labels)', () => {
    const bytes = concat(
      new Uint8Array([0x02]), // kind
      u16BE(0), // keyLen = 0
      new Uint8Array([0x00]), // balance
      // missing left label (32 bytes)
    )
    expect(() => deserializeNode(bytes)).toThrow()
  })

  it('throws on truncated internal (only one child label)', () => {
    const bytes = concat(
      new Uint8Array([0x02]), // kind
      u16BE(0), // keyLen = 0
      new Uint8Array([0x01]), // balance
      new Uint8Array(32).fill(0xaa), // left label (full)
      new Uint8Array(16).fill(0xbb), // right label (half)
    )
    expect(() => deserializeNode(bytes)).toThrow()
  })

  it('throws on truncated label (not enough bytes for 32-byte label)', () => {
    const bytes = concat(
      new Uint8Array([0x03]), // kind
      new Uint8Array(16).fill(0xab), // only 16 bytes
    )
    expect(() => deserializeNode(bytes)).toThrow()
  })

  it('accepts exact-length input (no trailing bytes required)', () => {
    const lbl = newLabel(new Uint8Array(32).fill(0xcc))
    const bytes = serializeNode(lbl)
    // Should parse fine
    const restored = deserializeNode(bytes)
    expect(nodesEqual(lbl, restored)).toBe(true)
  })

  it('ignores trailing bytes after valid node', () => {
    const leaf = newLeaf(
      new Uint8Array([0x01]),
      new Uint8Array([0x02]),
      new Uint8Array([0x03]),
    )
    const bytes = serializeNode(leaf)
    const withTrailing = concat(bytes, new Uint8Array([0xff, 0xee, 0xdd]))

    // Should parse fine (trailing bytes ignored — consumer owns framing)
    const restored = deserializeNode(withTrailing)
    expect(nodesEqual(leaf, restored)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Variable-length values
// ---------------------------------------------------------------------------

describe('variable-length values', () => {
  it('roundtrips a leaf with long variable-length value', () => {
    const longValue = new Uint8Array(256)
    for (let i = 0; i < 256; i++) longValue[i] = i & 0xff

    const leaf = newLeaf(
      new Uint8Array([0x42]),
      longValue,
      new Uint8Array([0x99]),
    )
    const bytes = serializeNode(leaf)
    const restored = deserializeNode(bytes)
    expect(nodesEqual(leaf, restored)).toBe(true)
    expect(restored.kind).toBe('leaf')
    const rl = restored as typeof leaf
    expect(rl.value.length).toBe(256)
  })

  it('roundtrips a leaf with empty nextLeafKey', () => {
    const leaf = newLeaf(
      new Uint8Array([0x01]),
      new Uint8Array([0x02]),
      new Uint8Array([]),
    )
    const bytes = serializeNode(leaf)
    const restored = deserializeNode(bytes)
    expect(nodesEqual(leaf, restored)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Deep tree roundtrip (Internal with nested Internal children)
// ---------------------------------------------------------------------------

describe('deep tree roundtrip', () => {
  it('roundtrips a tree where Internal children become LabelNodes', () => {
    // Build a small tree:
    //        Internal(key=5, bal=0)
    //       /                    \
    //   Leaf(1,v=a,nxt=2)   Leaf(5,v=b,nxt=9)
    const leaf1 = newLeaf(
      new Uint8Array([0x01]),
      new Uint8Array([0x0a]),
      new Uint8Array([0x02]),
    )
    const leaf2 = newLeaf(
      new Uint8Array([0x05]),
      new Uint8Array([0x0b]),
      new Uint8Array([0x09]),
    )
    const root = newInternal(leaf1, leaf2, 0, new Uint8Array([0x05]))
    // Pre-compute labels so we can verify
    const rootLabel = label(root)

    const bytes = serializeNode(root)
    const restored = deserializeNode(bytes)

    // Root is internal
    expect(restored.kind).toBe('internal')
    const rr = restored as typeof root
    expect(rr.balance).toBe(0)
    expect(rr.key).toBeDefined()
    expect(bytesEqual(rr.key!, new Uint8Array([0x05]))).toBe(true)

    // Children are LabelNodes
    expect(rr.left.kind).toBe('label')
    expect(rr.right.kind).toBe('label')

    // The label of the restored root should match
    // (since children are label stubs with the same digests,
    // re-computing the root label should give the same result)
    const restoredRootLabel = label(restored)
    expect(bytesEqual(rootLabel, restoredRootLabel)).toBe(true)
  })
})
