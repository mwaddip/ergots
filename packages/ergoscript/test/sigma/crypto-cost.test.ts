import { describe, it, expect } from 'vitest';
import { estimateCryptoCost } from '../../src/sigma/crypto-cost';
import type { SigmaBoolean } from '../../src/mir/types';

const dlog = (): SigmaBoolean => ({ tag: 'ProveDlog', h: new Uint8Array(33) });
const dht = (): SigmaBoolean => ({
  tag: 'ProveDhTuple',
  g: new Uint8Array(33), h: new Uint8Array(33), u: new Uint8Array(33), v: new Uint8Array(33),
});

describe('estimateCryptoCost (JVM Interpreter.estimateCryptoVerifyCost)', () => {
  it('TrivialProp → 0', () => {
    expect(estimateCryptoCost({ tag: 'TrivialProp', value: true })).toBe(0);
    expect(estimateCryptoCost({ tag: 'TrivialProp', value: false })).toBe(0);
  });
  it('ProveDlog → 3980', () => { expect(estimateCryptoCost(dlog())).toBe(3980); });
  it('ProveDhTuple → 7140', () => { expect(estimateCryptoCost(dht())).toBe(7140); });
  it('Cand of two dlogs → 15 + 3980 + 3980 = 7975', () => {
    expect(estimateCryptoCost({ tag: 'Cand', items: [dlog(), dlog()] })).toBe(7975);
  });
  it('Cor of two dlogs → 7975', () => {
    expect(estimateCryptoCost({ tag: 'Cor', items: [dlog(), dlog()] })).toBe(7975);
  });
  it('Cthreshold 2-of-3 dlogs → 20 + 18 + 15 + 11940 = 11993 (JVM incl +15; sigma-rust omits → 11978)', () => {
    expect(estimateCryptoCost({ tag: 'Cthreshold', k: 2, items: [dlog(), dlog(), dlog()] })).toBe(11993);
  });
  it('nested Cand[dlog, Cor[dlog, dht]]', () => {
    const sb: SigmaBoolean = { tag: 'Cand', items: [dlog(), { tag: 'Cor', items: [dlog(), dht()] }] };
    expect(estimateCryptoCost(sb)).toBe(15 + 3980 + (15 + 3980 + 7140)); // 15130
  });
});
