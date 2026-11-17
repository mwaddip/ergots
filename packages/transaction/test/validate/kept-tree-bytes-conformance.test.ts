// SANTA kept-tree-bytes-input (vectors/transaction/v6/authored/, santa@3a51062): 13 spends of a box whose
// tree carries bytes the writer would re-emit differently, blessed by ergo-core 6.0.6 validateStateful.
// Each entry's script reads `SELF.propositionBytes` and compares a byte or a prefix against the encoding AS
// RECEIVED: an overlong VLQ for the constants count (`81 00` for 1), a size-flagged tree whose declared size
// is one byte too large or too small, or a last byte that the writer would never emit (`7f` TrueLeaf, `80`
// FalseLeaf, each re-emitted as `0101` / `0100`). The spent box is PARSED from bytes, so its tree keeps this
// span (ErgoTreeSerializer.scala:178-185) and its id is over it; an implementation that re-writes the tree on
// parse would read the writer's form instead and answer the opposite way. Each accept pairs with a "rewritten"
// reject (the script expects the writer's bytes) and, for the first three accepts, a "canonical-control" reject
// (the same script spent over the canonical encoding of itself) — together they pin that the accept arm reads
// the tree's own encoding rather than a constant that happens to match.
//
// A verdict is asserted at each entry's own parameters. The JVM's reason for every reject here is "Scripts of
// all transaction inputs should pass verification" (Success((false,_))); ergots reports that as
// TxValidationError 'script-reduced-false' at input 0. The accepts are graded on their cost in santa-tx-cost.test.ts.
import { describe, it, expect } from 'vitest';

import { validateStateful } from '../../src/validate/stateful';
import { TxValidationError } from '../../src/errors';
import { loadSantaTxEntries, santaTxInputs } from './_santa-tx';

const FILE = 'kept-tree-bytes-input.json';
const NAMES = [
  'self-propbytes-overlong-constants-count-accept#0',
  'self-propbytes-overlong-constants-count-rewritten-reject#1',
  'self-propbytes-overlong-constants-count-canonical-control-reject#2',
  'self-propbytes-declared-size-over-accept#10',
  'self-propbytes-declared-size-over-rewritten-reject#11',
  'self-propbytes-declared-size-over-canonical-control-reject#12',
  'self-propbytes-declared-size-under-accept#20',
  'self-propbytes-declared-size-under-rewritten-reject#21',
  'self-propbytes-declared-size-under-canonical-control-reject#22',
  'self-propbytes-last-byte-trueleaf-accept#30',
  'self-propbytes-last-byte-trueleaf-rewritten-reject#31',
  'self-propbytes-last-byte-falseleaf-accept#40',
  'self-propbytes-last-byte-falseleaf-rewritten-reject#41',
];

function thrown(fn: () => void): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

describe(`SANTA ${FILE} (jvm-blessed)`, () => {
  const entries = loadSantaTxEntries(FILE);
  it('holds exactly the expected entries', () => {
    expect(entries.map((e) => e.name)).toEqual(NAMES);
  });
  for (const e of entries) {
    if (e.expected.valid) {
      it(`${e.name}: accepts`, () => {
        const { tx, deps } = santaTxInputs(e);
        expect(() => validateStateful(tx, deps)).not.toThrow();
      });
    } else {
      it(`${e.name}: rejects (script reduced to false, input 0)`, () => {
        expect(e.expected.reason, 'the JVM\'s reason').toMatch(/Success\(\(false,\d+\)\)/);
        const { tx, deps } = santaTxInputs(e);
        const err = thrown(() => validateStateful(tx, deps));
        expect(err, 'expected a reject').toBeInstanceOf(TxValidationError);
        expect((err as TxValidationError).code).toBe('script-reduced-false');
        expect((err as TxValidationError).location?.inputIndex).toBe(0);
      });
    }
  }
});
