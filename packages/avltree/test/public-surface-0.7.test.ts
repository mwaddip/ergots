import { describe, expect, it } from 'vitest'
import * as avltree from '../src/index.js'
import {
  VerifierCore,
  compareBytes,
  negInfKey,
  posInfKey,
  validateConfig,
  validateOperationShape,
  validateStartingDigest,
  type AvlTreeOpsCallbacks,
  type LeafCallback,
  type KeyMatchesResult,
} from '../src/index.js'

describe('0.7.0 public surface', () => {
  it('exports exactly these runtime names (0.6.0 set plus the extension surface)', () => {
    expect(Object.keys(avltree).sort()).toEqual([
      'AvlVerifyError',
      'BatchAVLProver',
      'BatchAVLVerifier',
      'PersistentBatchAVLProver',
      'StrictBatchAVLVerifier',
      'VerifierCore',
      'compareBytes',
      'deserializeNode',
      'label',
      'negInfKey',
      'newInternal',
      'newLabel',
      'newLeaf',
      'posInfKey',
      'serializeNode',
      'validateConfig',
      'validateOperationShape',
      'validateStartingDigest',
      'verifyAvlBatch',
      'verifyAvlBatchPartial',
      'verifyAvlLookup',
    ])
  })

  it('the engine internals that stayed internal are still absent', () => {
    for (const name of [
      'RecordingVerifierCore',
      'matchesCanonicalProof',
      'neighborLookupOf',
      'modifyHelper',
      'deleteHelper',
    ]) {
      expect(name in avltree, name).toBe(false)
    }
  })

  it('VerifierCore is a class a subclass can extend', () => {
    expect(typeof VerifierCore).toBe('function')
    class Sub extends VerifierCore {
      canSubclass(): boolean {
        return true
      }
    }
    // The three-byte proof is deliberately invalid: construction must not throw
    // (it records a decode failure instead), and the subclass must be
    // instantiable through its parent's constructor.
    const sub = new Sub(new Uint8Array(33), new Uint8Array(3), { keyLength: 32, valueLengthOpt: null })
    expect(sub.canSubclass()).toBe(true)
    expect(sub.isValid).toBe(false)
  })

  it('the sentinel helpers return fresh buffers that match the engine\'s ±inf gate', () => {
    const n = negInfKey(32)
    const p = posInfKey(32)
    expect(compareBytes(n, p)).toBe(-1)
    expect(compareBytes(n, new Uint8Array(32))).toBe(0)
    expect(compareBytes(p, new Uint8Array(32).fill(0xff))).toBe(0)
    // Fresh buffers: a mutation of one does not corrupt the next call.
    n[0] = 0x7f
    p[0] = 0x7f
    expect(negInfKey(32)[0]).toBe(0x00)
    expect(posInfKey(32)[0]).toBe(0xff)
  })

  it('the three validators are reachable through the entry point', () => {
    expect(typeof validateConfig).toBe('function')
    expect(typeof validateOperationShape).toBe('function')
    expect(typeof validateStartingDigest).toBe('function')
    // A valid config does not throw.
    expect(() => validateConfig({ keyLength: 32, valueLengthOpt: null })).not.toThrow()
  })

  it('exports the extension-surface types', () => {
    // Compile-time probes: the annotations below are the assertions.
    const onLeaf: LeafCallback = (_leaf, _matches) => {}
    const callbacks: AvlTreeOpsCallbacks = {
      nextDirectionIsLeft: () => true,
      keyMatchesLeaf: () => ({ ok: true, matches: false }),
      replayComparison: () => 0,
      onNodeVisit: () => {},
      getFailedReason: () => null,
    }
    const ok: KeyMatchesResult = { ok: true, matches: true }
    expect([typeof onLeaf, typeof callbacks.nextDirectionIsLeft, ok.ok]).toEqual(['function', 'function', true])
  })
})
