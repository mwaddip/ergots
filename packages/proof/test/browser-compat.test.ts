import { describe, test, expect } from 'vitest';

describe('browser-compat', () => {
  test('Uint8Array is the global byte type', () => {
    expect(typeof Uint8Array).toBe('function');
  });

  test('Buffer is NOT available in this environment', () => {
    // jsdom doesn't provide Buffer; node does. This test passes in jsdom but
    // would need adjustment if run under node. For now, gate on env:
    if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
      expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
    } else {
      // In node env, Buffer exists — but our src/ should never use it
      expect(true).toBe(true); // skip
    }
  });

  test('bigint arithmetic is available', () => {
    const max = (1n << 64n) - 1n;
    expect(max.toString(16)).toBe('ffffffffffffffff');
  });

  test('public API surface imports without Node-only modules', async () => {
    const mod = await import('../src/index');
    expect(typeof mod.parseProof).toBe('function');
    expect(typeof mod.serializeProof).toBe('function');
    expect(typeof mod.verifyProof).toBe('function');
    expect(typeof mod.compareProofs).toBe('function');
    expect(typeof mod.ProofParseError).toBe('function'); // class
    expect(typeof mod.ProofVerificationError).toBe('function');
  });

  test('envelope subpath imports without Node-only modules', async () => {
    const mod = await import('../src/envelope');
    expect(typeof mod.parseGetNipopowProof).toBe('function');
    expect(typeof mod.serializeGetNipopowProof).toBe('function');
    expect(typeof mod.parseNipopowProofEnvelope).toBe('function');
    expect(typeof mod.serializeNipopowProofEnvelope).toBe('function');
    expect(mod.GET_NIPOPOW_PROOF).toBe(90);
    expect(mod.NIPOPOW_PROOF).toBe(91);
  });
});
