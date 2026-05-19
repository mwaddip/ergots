/**
 * Pure-helper tests for `_avltree-adapter.ts` (phase 2h-b, Phase E).
 *
 * 10 helper functions that bridge `AvlTreeData` runtime values to the
 * `@ergots/avltree` package's `Operation` / `AvlTreeConfig` API. These have
 * NO `EvalContext` dependency — they're stateless utilities consumed by
 * Phase F's Tier-2 verification op handlers.
 *
 * Defensive shape checks throw EvalError 'method-not-implemented' per the
 * compact-taxonomy decision (Decision #1 from 2g.5).
 */
import { describe, expect, test } from 'vitest'
import {
  avlTreeDataToConfig,
  buildSingleLookupOp,
  buildLookupOps,
  buildInsertOps,
  buildUpdateOps,
  buildRemoveOps,
  withUpdatedDigest,
  extractBytes,
  extractByteArrayList,
  extractEntries,
} from '../../src/eval/_avltree-adapter'
import { EvalError } from '../../src/eval/eval-context'
import type { SValue, AvlTreeData } from '../../src/mir/types'

const sampleTree: AvlTreeData = {
  digest: new Uint8Array(33),
  treeFlags: 0x07,
  keyLength: 32,
  valueLengthOpt: 64,
}

const collOfBytes = (bytes: number[]): SValue => ({
  kind: 'Coll',
  elem: { tag: 'SByte' },
  items: bytes.map(b => ({ kind: 'Byte', value: b >= 128 ? b - 256 : b })),  // i8 form
})

describe('avlTreeDataToConfig', () => {
  test('projects keyLength + valueLengthOpt; ignores other fields', () => {
    expect(avlTreeDataToConfig(sampleTree)).toEqual({ keyLength: 32, valueLengthOpt: 64 })
  })

  test('preserves null valueLengthOpt', () => {
    expect(avlTreeDataToConfig({ ...sampleTree, valueLengthOpt: null }))
      .toEqual({ keyLength: 32, valueLengthOpt: null })
  })
})

describe('buildSingleLookupOp', () => {
  test('1-element Lookup array', () => {
    const key = new Uint8Array([0xAA, 0xBB])
    expect(buildSingleLookupOp(key)).toEqual([{ tag: 'Lookup', key }])
  })
})

describe('buildLookupOps', () => {
  test('maps each key to a Lookup', () => {
    const k1 = new Uint8Array([1])
    const k2 = new Uint8Array([2])
    expect(buildLookupOps([k1, k2])).toEqual([
      { tag: 'Lookup', key: k1 },
      { tag: 'Lookup', key: k2 },
    ])
  })

  test('empty keys → empty ops', () => {
    expect(buildLookupOps([])).toEqual([])
  })
})

describe('buildInsertOps', () => {
  test('extracts key+value tuples from a Coll[Tuple] SValue', () => {
    const entries: SValue = {
      kind: 'Coll',
      elem: { tag: 'STuple', items: [{ tag: 'SColl', elem: { tag: 'SByte' } }, { tag: 'SColl', elem: { tag: 'SByte' } }] },
      items: [
        { kind: 'Tuple', items: [collOfBytes([1, 2]), collOfBytes([10, 20])] },
        { kind: 'Tuple', items: [collOfBytes([3, 4]), collOfBytes([30, 40])] },
      ],
    }
    expect(buildInsertOps(entries)).toEqual([
      { tag: 'Insert', key: new Uint8Array([1, 2]), value: new Uint8Array([10, 20]) },
      { tag: 'Insert', key: new Uint8Array([3, 4]), value: new Uint8Array([30, 40]) },
    ])
  })

  test('throws on non-Coll input', () => {
    const bad: SValue = { kind: 'Boolean', value: true }
    expect(() => buildInsertOps(bad)).toThrow(EvalError)
    try {
      buildInsertOps(bad)
    } catch (e) {
      expect((e as EvalError).code).toBe('method-not-implemented')
    }
  })

  test('throws on Tuple of wrong arity', () => {
    const bad: SValue = {
      kind: 'Coll',
      elem: { tag: 'SAny' },
      items: [
        { kind: 'Tuple', items: [collOfBytes([1])] },  // arity 1, expected 2
      ],
    }
    expect(() => buildInsertOps(bad)).toThrow(EvalError)
  })

  test('throws on non-Tuple item inside Coll', () => {
    const bad: SValue = {
      kind: 'Coll',
      elem: { tag: 'SAny' },
      items: [{ kind: 'Boolean', value: true }],
    }
    expect(() => buildInsertOps(bad)).toThrow(EvalError)
  })
})

describe('buildUpdateOps', () => {
  test('emits Update ops (mirror of buildInsertOps)', () => {
    const entries: SValue = {
      kind: 'Coll',
      elem: { tag: 'STuple', items: [{ tag: 'SColl', elem: { tag: 'SByte' } }, { tag: 'SColl', elem: { tag: 'SByte' } }] },
      items: [{ kind: 'Tuple', items: [collOfBytes([7]), collOfBytes([70])] }],
    }
    expect(buildUpdateOps(entries)).toEqual([
      { tag: 'Update', key: new Uint8Array([7]), value: new Uint8Array([70]) },
    ])
  })

  test('throws on non-Coll input', () => {
    expect(() => buildUpdateOps({ kind: 'Int', value: 1 })).toThrow(EvalError)
  })
})

describe('buildRemoveOps', () => {
  test('maps each key to a Remove', () => {
    const k = new Uint8Array([0xFF])
    expect(buildRemoveOps([k])).toEqual([{ tag: 'Remove', key: k }])
  })

  test('empty keys → empty ops', () => {
    expect(buildRemoveOps([])).toEqual([])
  })
})

describe('withUpdatedDigest', () => {
  test('returns new tree with new digest; other fields unchanged', () => {
    const newDigest = Uint8Array.from({ length: 33 }, (_, i) => i + 1)
    const result = withUpdatedDigest(sampleTree, newDigest)
    expect(result.digest).toEqual(newDigest)
    expect(result.treeFlags).toBe(sampleTree.treeFlags)
    expect(result.keyLength).toBe(sampleTree.keyLength)
    expect(result.valueLengthOpt).toBe(sampleTree.valueLengthOpt)
    expect(result).not.toBe(sampleTree)  // new object, not mutated
  })

  test('preserves null valueLengthOpt', () => {
    const newDigest = new Uint8Array(33)
    const tree: AvlTreeData = { ...sampleTree, valueLengthOpt: null }
    const result = withUpdatedDigest(tree, newDigest)
    expect(result.valueLengthOpt).toBeNull()
  })
})

describe('extractBytes', () => {
  test('extracts bytes from Coll[Byte]', () => {
    expect(extractBytes(collOfBytes([0, 127, 255]))).toEqual(new Uint8Array([0, 127, 255]))
  })

  test('handles negative i8 values (sign-extended)', () => {
    const v: SValue = { kind: 'Coll', elem: { tag: 'SByte' }, items: [{ kind: 'Byte', value: -1 }] }
    expect(extractBytes(v)).toEqual(new Uint8Array([255]))
  })

  test('throws on non-Coll input', () => {
    expect(() => extractBytes({ kind: 'Int', value: 42 })).toThrow(EvalError)
  })

  test('throws on non-Byte item kind', () => {
    const bad: SValue = { kind: 'Coll', elem: { tag: 'SByte' }, items: [{ kind: 'Int', value: 42 }] }
    expect(() => extractBytes(bad)).toThrow(EvalError)
  })

  test('empty Coll → empty Uint8Array', () => {
    expect(extractBytes({ kind: 'Coll', elem: { tag: 'SByte' }, items: [] })).toEqual(new Uint8Array(0))
  })
})

describe('extractByteArrayList', () => {
  test('extracts list of byte arrays', () => {
    const v: SValue = {
      kind: 'Coll',
      elem: { tag: 'SColl', elem: { tag: 'SByte' } },
      items: [collOfBytes([1, 2]), collOfBytes([3, 4])],
    }
    expect(extractByteArrayList(v)).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])])
  })

  test('throws on non-Coll input', () => {
    expect(() => extractByteArrayList({ kind: 'Boolean', value: false })).toThrow(EvalError)
  })

  test('empty Coll → empty list', () => {
    const v: SValue = {
      kind: 'Coll',
      elem: { tag: 'SColl', elem: { tag: 'SByte' } },
      items: [],
    }
    expect(extractByteArrayList(v)).toEqual([])
  })
})

describe('extractEntries', () => {
  test('extracts key-value pairs', () => {
    const v: SValue = {
      kind: 'Coll',
      elem: { tag: 'STuple', items: [{ tag: 'SColl', elem: { tag: 'SByte' } }, { tag: 'SColl', elem: { tag: 'SByte' } }] },
      items: [
        { kind: 'Tuple', items: [collOfBytes([1]), collOfBytes([10])] },
      ],
    }
    expect(extractEntries(v)).toEqual([{ key: new Uint8Array([1]), value: new Uint8Array([10]) }])
  })

  test('throws on non-Tuple item', () => {
    const bad: SValue = {
      kind: 'Coll',
      elem: { tag: 'SAny' },
      items: [{ kind: 'Boolean', value: true }],
    }
    expect(() => extractEntries(bad)).toThrow(EvalError)
  })

  test('throws on non-Coll input', () => {
    expect(() => extractEntries({ kind: 'Int', value: 1 })).toThrow(EvalError)
  })

  test('throws on Tuple of wrong arity', () => {
    const bad: SValue = {
      kind: 'Coll',
      elem: { tag: 'SAny' },
      items: [{ kind: 'Tuple', items: [collOfBytes([1])] }],  // arity 1, expected 2
    }
    expect(() => extractEntries(bad)).toThrow(EvalError)
  })

  test('empty Coll → empty list', () => {
    const v: SValue = {
      kind: 'Coll',
      elem: { tag: 'STuple', items: [{ tag: 'SColl', elem: { tag: 'SByte' } }, { tag: 'SColl', elem: { tag: 'SByte' } }] },
      items: [],
    }
    expect(extractEntries(v)).toEqual([])
  })
})
