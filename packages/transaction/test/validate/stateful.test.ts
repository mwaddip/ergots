import { describe, it, expect } from 'vitest';
import { validateStateful } from '../../src/validate/stateful';
import { listStatefulFixtures, loadStatefulFixtureAsDeps } from './_load';

describe('validateStateful vs real (tx + boxes + state) fixtures', () => {
  for (const name of listStatefulFixtures()) {
    it(`accepts the on-chain-valid tx ${name}`, () => {
      const { tx, deps } = loadStatefulFixtureAsDeps(name);
      expect(() => validateStateful(tx, deps)).not.toThrow();
    });
  }
});
