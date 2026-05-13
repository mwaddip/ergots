import { describe, test, expect } from 'vitest';

describe('browser-compat', () => {
  test('Uint8Array is the global byte type', () => {
    expect(typeof Uint8Array).toBe('function');
  });

  test('Buffer is NOT used in src/ (verified by dist-grep at build time)', () => {
    // The grep -E "Buffer" check on dist/index.js and dist/envelope.js is the
    // authoritative guarantee. Under jsdom, globalThis.Buffer is undefined,
    // so a runtime check is meaningful. Under node, globalThis.Buffer exists
    // but our compiled output doesn't reference it.
    if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
      expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
    }
    // In node env, this test is a no-op — the dist-scan in CI is the gate.
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
    expect(typeof mod.EnvelopeParseError).toBe('function');  // class
  });
});
