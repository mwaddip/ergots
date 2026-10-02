// The cost validateStateful returns, against the JVM's. ergo-core's ErgoTransaction.validateStateful returns the
// transaction's cost, and SANTA's transaction tier records it for every entry the JVM accepts
// (vectors/transaction/, blessed by ergo-core's validateStateful). Every file under test/fixtures/conformance/ with
// that tier's schema runs here, with no list to keep: a file vendored later is graded on its cost as well.
//
// The files and where their verdicts are tested:
//  - cost-limit-boundary.json (cost-limit-boundary.test.ts);
//  - storage-rent-*.json (storage-rent-conformance.test.ts);
//  - deserialize-substitution-spend.json (deserialize-substitution-conformance.test.ts): its costs carry the
//    interpreter's charges for a tree with a Deserialize node, the tree's bytes x 2 and each completed decode's
//    bytes x 2 (sigma-state 6.0.6 Interpreter.scala:99-107, 240-268);
//  - deserialize-context-111927.json (vectors/transaction/v6/captured/, santa@e9ad8da): a testnet transaction at
//    height 111,927 whose first input has a dead DeserializeContext in a 279-byte tree, so its cost carries 558 for
//    those bytes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EvalError } from '@ergots/ergoscript';

import { validateStateful } from '../../src/validate/stateful';
import { santaTxInputs } from './_santa-tx';
import type { SantaTxEntry } from './_santa-tx';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'conformance');

interface TxFile { file: string; entries: SantaTxEntry[] }

const TX_FILES: TxFile[] = fs.readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({ file, doc: JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as { schema: string; entries: SantaTxEntry[] } }))
  .filter(({ doc }) => doc.schema === 'santa-transaction/v1')
  .map(({ file, doc }) => ({ file, entries: doc.entries }));

// The entries the JVM accepts and ergots still rejects, each pinned in its own file's test.
const REJECTED_BY_ERGOTS: Record<string, string[]> = {
  // Residual 7 (facts/ergoscript-eval.md, "The Deserialize substitution"): the untyped default and the root wrap.
  'deserialize-substitution-spend.json': ['root-boolean-default-true-accept#20'],
};

const graded = TX_FILES.flatMap(({ file, entries }) =>
  entries
    .filter((e) => e.expected.valid && !(REJECTED_BY_ERGOTS[file] ?? []).includes(e.name))
    .map((e) => ({ file, e })));

describe('validateStateful returns the JVM\'s cost (SANTA transaction tier)', () => {
  it('finds the vendored files, and grades every entry the JVM accepts', () => {
    expect(TX_FILES.map((f) => f.file)).toEqual([
      'cost-limit-boundary.json',
      'deserialize-context-111927.json',
      'deserialize-substitution-spend.json',
      'storage-rent-dust.json',
      'storage-rent-fallback.json',
      'storage-rent-fee-wrap.json',
      'storage-rent-gate.json',
      'storage-rent-mixed-inputs.json',
      'storage-rent-recreation.json',
    ]);
    expect(graded.length).toBe(25);
    for (const [file, names] of Object.entries(REJECTED_BY_ERGOTS)) {
      const valid = TX_FILES.find((f) => f.file === file)!.entries.filter((e) => e.expected.valid).map((e) => e.name);
      expect(names.filter((n) => !valid.includes(n))).toEqual([]);
    }
  });

  for (const { file, e } of graded) {
    it(`${file} ${e.name}: ${e.expected.cost}`, () => {
      const { tx, deps } = santaTxInputs(e);
      expect(validateStateful(tx, deps)).toBe(e.expected.cost);
    });
  }
});

// SANTA has no substitution spend before V6 yet. Until it does, four of its entries run here with the pre-header's
// version set to 3, the block version of activated script version 2. The expected costs are derived, not blessed:
// the entry's init cost, 12100, plus the reduction cost a local sigma-state 6.0.6 probe gives the same spend at
// activated version 2 (its rows K2, D2, K4 and K6). Before V6 the interpreter still adds each completed decode's
// charge, and it checks the tree charge against the limit without adding it (Interpreter.scala:246-260).
describe('a substitution spend before V6 (derived from the probe)', () => {
  const spends = TX_FILES.find((f) => f.file === 'deserialize-substitution-spend.json')!.entries;
  const beforeV6 = (name: string, maxBlockCost?: number) => {
    const e = spends.find((x) => x.name === name);
    if (e === undefined) throw new Error(`no entry ${name}`);
    const at3: SantaTxEntry = { ...e, preHeader: { ...e.preHeader, version: 3 } };
    return santaTxInputs(at3, maxBlockCost === undefined ? at3.parameters : { ...at3.parameters, maxBlockCost });
  };

  it.each([
    ['s3j-decode-cast-swallowed-dead-accept#0', 12103], // no decode charge: the decode is a class cast
    ['s3-type-read-cast-swallowed-dead-accept#3', 12137], // 34 for the 17 decoded bytes, 3 for the evaluation
    ['s16-context-type-read-cast-swallowed-dead-accept#13', 12137],
    ['s16b-context-decode-cast-swallowed-dead-accept#14', 12103],
  ])('%s costs %i', (name, cost) => {
    const { tx, deps } = beforeV6(name);
    expect(validateStateful(tx, deps)).toBe(cost);
  });

  it('the tree charge is checked against the limit, although it is never added', () => {
    // #0's tree is 16 bytes: a charge of 32. With 31 left after the init cost the spend rejects; with 32 it costs 3.
    const name = 's3j-decode-cast-swallowed-dead-accept#0';
    const short = beforeV6(name, 12100 + 31);
    let err: unknown;
    try { validateStateful(short.tx, short.deps); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(EvalError);
    expect((err as EvalError).code).toBe('cost-limit-exceeded');
    const enough = beforeV6(name, 12100 + 32);
    expect(validateStateful(enough.tx, enough.deps)).toBe(12103);
  });
});
