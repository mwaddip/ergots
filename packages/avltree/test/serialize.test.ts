import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  serializeNode,
  deserializeNode,
  newLeaf,
  newInternal,
  newLabel,
  type AvlNode,
  type AvlTreeConfig,
  type Balance,
} from '../src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CASES = [
  'leaf-fixed-value',
  'leaf-variable-ordinary',
  'leaf-variable-empty',
  'leaf-variable-long',
  'leaf-sentinel-bounds',
  'internal-balance-zero',
  'internal-balance-plus-one',
  'internal-balance-minus-one',
  'internal-sentinel-key',
  'leaf-keylength-8',
  'internal-keylength-8',
] as const

interface LeafSpec {
  kind: 'leaf'
  keyHex: string
  valueHex: string
  nextLeafKeyHex: string
}
interface InternalSpec {
  kind: 'internal'
  keyHex: string
  balance: Balance
  leftLabelHex: string
  rightLabelHex: string
}
interface Fixture {
  name: string
  config: AvlTreeConfig
  node: LeafSpec | InternalSpec
  packedHex: string
}

function loadCase(name: string): Fixture {
  const p = resolve(__dirname, `fixtures/node-pack/${name}.json`)
  return JSON.parse(readFileSync(p, 'utf-8')) as Fixture
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function buildNode(spec: LeafSpec | InternalSpec): AvlNode {
  if (spec.kind === 'leaf') {
    return newLeaf(
      hexToBytes(spec.keyHex),
      hexToBytes(spec.valueHex),
      hexToBytes(spec.nextLeafKeyHex),
    )
  }
  return newInternal(
    newLabel(hexToBytes(spec.leftLabelHex)),
    newLabel(hexToBytes(spec.rightLabelHex)),
    spec.balance,
    hexToBytes(spec.keyHex),
  )
}

describe('serializeNode — byte equality with ergo_avltree_rust AVLTree::pack', () => {
  for (const name of CASES) {
    it(`encodes ${name} byte-for-byte`, () => {
      const f = loadCase(name)
      const encoded = serializeNode(buildNode(f.node), f.config)
      expect(bytesToHex(encoded)).toBe(f.packedHex)
    })
  }
})

describe('deserializeNode — round-trips every fixture', () => {
  for (const name of CASES) {
    it(`decodes ${name} back to the original node`, () => {
      const f = loadCase(name)
      const decoded = deserializeNode(hexToBytes(f.packedHex), f.config)

      expect(decoded.kind).toBe(f.node.kind)

      if (f.node.kind === 'leaf') {
        const leaf = decoded as Extract<AvlNode, { kind: 'leaf' }>
        expect(bytesToHex(leaf.key)).toBe(f.node.keyHex)
        expect(bytesToHex(leaf.value)).toBe(f.node.valueHex)
        expect(bytesToHex(leaf.nextLeafKey)).toBe(f.node.nextLeafKeyHex)
      } else {
        const internal = decoded as Extract<AvlNode, { kind: 'internal' }>
        expect(internal.key).toBeDefined()
        expect(bytesToHex(internal.key!)).toBe(f.node.keyHex)
        expect(internal.balance).toBe(f.node.balance)
        // Children come back as label stubs carrying the encoded digests.
        expect(internal.left.kind).toBe('label')
        expect(internal.right.kind).toBe('label')
        expect(
          bytesToHex((internal.left as Extract<AvlNode, { kind: 'label' }>).label),
        ).toBe(f.node.leftLabelHex)
        expect(
          bytesToHex((internal.right as Extract<AvlNode, { kind: 'label' }>).label),
        ).toBe(f.node.rightLabelHex)
      }
    })
  }
})

const K32: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null }
const K32_FIXED: AvlTreeConfig = { keyLength: 32, valueLengthOpt: 4 }

function leafBytes(config: AvlTreeConfig, valueLen: number): Uint8Array {
  const variable = config.valueLengthOpt === null
  const out = new Uint8Array(
    1 + config.keyLength + (variable ? 4 : 0) + valueLen + config.keyLength,
  )
  out[0] = 0x01
  if (variable) {
    const o = 1 + config.keyLength
    out[o] = (valueLen >>> 24) & 0xff
    out[o + 1] = (valueLen >>> 16) & 0xff
    out[o + 2] = (valueLen >>> 8) & 0xff
    out[o + 3] = valueLen & 0xff
  }
  return out
}

describe('deserializeNode — rejection paths', () => {
  it('rejects empty input', () => {
    expect(() => deserializeNode(new Uint8Array(0), K32)).toThrow(RangeError)
  })

  // 0x02 and 0x03 were the retired format's internal and label tags.
  for (const tag of [0x02, 0x03, 0x7f, 0xff]) {
    it(`rejects unknown node prefix 0x${tag.toString(16)}`, () => {
      const bytes = new Uint8Array(80)
      bytes[0] = tag
      expect(() => deserializeNode(bytes, K32)).toThrow(/unknown node prefix/)
    })
  }

  it('rejects a leaf truncated inside the key', () => {
    const bytes = new Uint8Array(20)
    bytes[0] = 0x01
    expect(() => deserializeNode(bytes, K32)).toThrow(/truncated .* key/)
  })

  it('rejects a leaf truncated before the value length', () => {
    const bytes = new Uint8Array(1 + 32 + 2)
    bytes[0] = 0x01
    expect(() => deserializeNode(bytes, K32)).toThrow(/truncated .* valueLength/)
  })

  it('rejects a leaf whose declared value length exceeds the input', () => {
    // Header only: tag + key + a u32 claiming 1,000,000 value bytes, then 10
    // actual bytes. Built directly so the test never allocates the claimed size —
    // deserializeNode must bounds-check before slicing.
    const bytes = new Uint8Array(1 + 32 + 4 + 10)
    bytes[0] = 0x01
    const o = 1 + 32
    bytes[o] = 0x00
    bytes[o + 1] = 0x0f
    bytes[o + 2] = 0x42
    bytes[o + 3] = 0x40 // 1,000,000
    expect(() => deserializeNode(bytes, K32)).toThrow(/truncated .* value/)
  })

  it('rejects a leaf truncated inside nextLeafKey', () => {
    const full = leafBytes(K32, 3)
    expect(() => deserializeNode(full.slice(0, full.length - 5), K32)).toThrow(
      /truncated .* nextLeafKey/,
    )
  })

  it('rejects an internal node truncated before the balance byte', () => {
    expect(() => deserializeNode(new Uint8Array([0x00]), K32)).toThrow(
      /truncated .* balance/,
    )
  })

  it('rejects an internal node with an out-of-range balance', () => {
    const bytes = new Uint8Array(1 + 1 + 32 + 64)
    bytes[0] = 0x00
    bytes[1] = 0x05 // decodes to +5
    expect(() => deserializeNode(bytes, K32)).toThrow(/invalid balance/)
  })

  it('rejects an internal node truncated inside the right label', () => {
    const bytes = new Uint8Array(1 + 1 + 32 + 32 + 16)
    bytes[0] = 0x00
    bytes[1] = 0x00
    expect(() => deserializeNode(bytes, K32)).toThrow(/truncated .* rightLabel/)
  })

  it('honours a fixed valueLengthOpt when decoding', () => {
    // No u32 prefix in fixed mode: total is 1 + 32 + 4 + 32.
    const bytes = new Uint8Array(1 + 32 + 4 + 32)
    bytes[0] = 0x01
    const node = deserializeNode(bytes, K32_FIXED)
    expect(node.kind).toBe('leaf')
    expect((node as Extract<AvlNode, { kind: 'leaf' }>).value.length).toBe(4)
  })
})

describe('serializeNode — rejection paths', () => {
  it('refuses to serialize a LabelNode', () => {
    expect(() => serializeNode(newLabel(new Uint8Array(32)), K32)).toThrow(
      /not serializable/,
    )
  })

  it('refuses an InternalNode with no key', () => {
    const node = newInternal(
      newLabel(new Uint8Array(32).fill(0x01)),
      newLabel(new Uint8Array(32).fill(0x02)),
      0,
    )
    expect(() => serializeNode(node, K32)).toThrow(/has no key/)
  })

  it('rejects a key whose length disagrees with config', () => {
    const node = newLeaf(new Uint8Array(8), new Uint8Array(2), new Uint8Array(32))
    expect(() => serializeNode(node, K32)).toThrow(/key length 8/)
  })

  it('rejects a fixed-length value of the wrong size', () => {
    const node = newLeaf(
      new Uint8Array(32),
      new Uint8Array(7), // config says 4
      new Uint8Array(32),
    )
    expect(() => serializeNode(node, K32_FIXED)).toThrow(/valueLengthOpt/)
  })
})

describe('codec round-trip property', () => {
  it('is stable across randomised leaves in both config modes', () => {
    let seed = 0x9e3779b9
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    const randBytes = (n: number): Uint8Array => {
      const out = new Uint8Array(n)
      for (let i = 0; i < n; i++) out[i] = next() & 0xff
      return out
    }

    for (const config of [K32, K32_FIXED]) {
      for (let i = 0; i < 50; i++) {
        const valueLen = config.valueLengthOpt ?? next() % 64
        const node = newLeaf(randBytes(32), randBytes(valueLen), randBytes(32))
        const once = serializeNode(node, config)
        const twice = serializeNode(deserializeNode(once, config), config)
        expect(bytesToHex(twice)).toBe(bytesToHex(once))
      }
    }
  })

  it('is stable across randomised internals', () => {
    const balances: Balance[] = [-1, 0, 1]
    for (let i = 0; i < 30; i++) {
      const node = newInternal(
        newLabel(new Uint8Array(32).fill(i & 0xff)),
        newLabel(new Uint8Array(32).fill((i * 7) & 0xff)),
        balances[i % 3]!,
        new Uint8Array(32).fill((i * 13) & 0xff),
      )
      const once = serializeNode(node, K32)
      const twice = serializeNode(deserializeNode(once, K32), K32)
      expect(bytesToHex(twice)).toBe(bytesToHex(once))
    }
  })
})
