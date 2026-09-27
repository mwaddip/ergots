// SANTA storage-rent vectors (vectors/transaction/v6/authored/storage-rent-*.json: santa@7b1d1df,
// storage-rent-recreation.json updated at santa@74985f2; blessed by ergo-core 6.0.6
// validateStateful). JVM source: ergo v6.0.6 ErgoInterpreter.verify (:66-87) / checkExpiredBox
// (:42-55). Every box is sigmaProp(true), so a reject can only come from the rent verdict, and the
// script path accepts every one of these txs.
//
// Verdicts are asserted at each entry's own parameters. Costs are pinned with maxBlockCost
// boundary pairs (as in cost-limit-boundary.test.ts): every accept must reject at cost - 1, which
// needs the 50-unit StorageContractCost on each rent input. An accept whose inputs all take the
// rent path runs no reduction, so the JVM also accepts it at maxBlockCost = cost exactly; for a tx
// with a scripted input that boundary depends on the script's JIT-to-block rounding and is not
// JVM-blessed, so only the rent-only accepts get the upper pin.
import { describe, it, expect } from 'vitest';

import { validateStateful } from '../../src/validate/stateful';
import { TxValidationError } from '../../src/errors';
import { loadSantaTxEntries, santaTxInputs } from './_santa-tx';

const FILES: [string, string[]][] = [
  ['storage-rent-dust.json', ['rent-dust-value-equals-fee-accept', 'rent-dust-value-above-fee-reject']],
  ['storage-rent-fallback.json',
    ['rent-fallback-var127-int-accept', 'rent-fallback-index-out-of-range-accept', 'rent-fallback-index-negative-accept']],
  ['storage-rent-fee-wrap.json', [
    'rent-fee-wrap-1718-true-fee-reject', 'rent-fee-wrap-1718-wrapped-fee-accept',
    'rent-fee-wrap-1718-wrapped-fee-minus-one-reject', 'rent-fee-wrap-3436-accept', 'rent-fee-wrap-3436-reject']],
  ['storage-rent-gate.json', ['rent-gate-age-below-period-accept', 'rent-gate-nonempty-proof-accept']],
  ['storage-rent-mixed-inputs.json', ['rent-mixed-rent-then-script-accept', 'rent-mixed-script-then-rent-accept']],
  ['storage-rent-recreation.json', [
    'rent-recreation-accept', 'rent-recreation-tokens-accept', 'rent-recreation-height-reject',
    'rent-recreation-value-reject', 'rent-recreation-script-reject', 'rent-recreation-tokens-reject',
    'rent-recreation-register-reject', 'rent-recreation-tuple-register-accept', 'rent-recreation-tuple-register-reject',
    'rent-recreation-segregated-script-accept', 'rent-recreation-noncanonical-script-reject']],
];

const RENT_ONLY_ACCEPTS = [
  'rent-recreation-accept',
  'rent-recreation-tokens-accept',
  'rent-recreation-tuple-register-accept',
  'rent-recreation-segregated-script-accept',
  'rent-dust-value-equals-fee-accept',
  'rent-fee-wrap-3436-accept',
];

function thrown(fn: () => void): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

describe.each(FILES)('SANTA %s (jvm-blessed)', (file, names) => {
  it('holds exactly the expected entries', () => {
    expect(loadSantaTxEntries(file).map((e) => e.name)).toEqual(names);
  });
  for (const e of loadSantaTxEntries(file)) {
    const { valid, cost, reason } = e.expected;
    if (valid) {
      it(`${e.name}: accepts`, () => {
        const { tx, deps } = santaTxInputs(e);
        expect(() => validateStateful(tx, deps)).not.toThrow();
      });
      it(`${e.name}: rejects at maxBlockCost ${cost! - 1} (the JVM cost is ${cost})`, () => {
        const { tx, deps } = santaTxInputs(e, { ...e.parameters, maxBlockCost: cost! - 1 });
        expect((thrown(() => validateStateful(tx, deps)) as { code?: unknown } | undefined)?.code)
          .toBe('cost-limit-exceeded');
      });
      if (RENT_ONLY_ACCEPTS.includes(e.name)) {
        it(`${e.name}: accepts at maxBlockCost ${cost} (rent inputs only)`, () => {
          const { tx, deps } = santaTxInputs(e, { ...e.parameters, maxBlockCost: cost! });
          expect(() => validateStateful(tx, deps)).not.toThrow();
        });
      }
    } else {
      // The JVM's reason names the input whose rent verdict failed: `#i => Success((false,50))`.
      const input = Number(/#(\d+) => Success\(\(false,50\)\)$/.exec(reason!)![1]);
      it(`${e.name}: rejects on input #${input}'s final storage-rent verdict`, () => {
        const { tx, deps } = santaTxInputs(e);
        const err = thrown(() => validateStateful(tx, deps));
        expect(err).toBeInstanceOf(TxValidationError);
        expect((err as TxValidationError).code).toBe('script-reduced-false');
        expect((err as TxValidationError).location?.inputIndex).toBe(input);
      });
    }
  }
});

it('every rent-only accept named above is an accept entry in the corpus', () => {
  const accepts = FILES.flatMap(([file]) => loadSantaTxEntries(file)).filter((e) => e.expected.valid).map((e) => e.name);
  expect(accepts).toEqual(expect.arrayContaining(RENT_ONLY_ACCEPTS));
});

it('a failed rent verdict on input #1 rejects at input #1 (derived from rent-mixed-script-then-rent-accept)', () => {
  // Not JVM-blessed: a mutation of a blessed accept. Input #0 is a scripted sigmaProp(true) box and
  // input #1 the rent box, recreated by output 0. Giving output 0 an R4 the box lacks breaks the
  // recreation (ErgoInterpreter.scala:50-52: box.get(R4) is None, output.get(R4) is not); value,
  // heights and tokens are untouched, so only input #1's rent verdict can reject.
  const e = loadSantaTxEntries('storage-rent-mixed-inputs.json').find((x) => x.name === 'rent-mixed-script-then-rent-accept')!;
  const { tx, deps } = santaTxInputs(e);
  tx.outputCandidates[0]!.registers[4] = { tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } };
  const err = thrown(() => validateStateful(tx, deps));
  expect(err).toBeInstanceOf(TxValidationError);
  expect((err as TxValidationError).code).toBe('script-reduced-false');
  expect((err as TxValidationError).location?.inputIndex).toBe(1);
});
