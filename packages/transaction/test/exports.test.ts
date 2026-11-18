import { describe, it, expect } from 'vitest';
import * as pkg from '../src';

/**
 * Public export surface for `@ergots/transaction`.
 *
 * `parseContextExtension` reads one `ContextExtension` from a shared
 * `ByteReader` (facts/transaction.md, "Public surface"). Downstream
 * callers that reconstruct an on-chain context from raw bytes — a
 * harness that feeds the extension to the evaluator by the reader
 * it would travel through on-chain — reach for it by the package
 * root; a path import across the package boundary is not allowed
 * (CLAUDE.md, "Never reach across package boundaries"). The two
 * runtime-class types of a collection (`CollClass`, `ArrayClass`)
 * ride the same root beside the other data types the package
 * already re-exports from `@ergots/ergoscript`.
 */
describe('@ergots/transaction public export surface', () => {
  it('root-exports parseContextExtension as a function', () => {
    expect((pkg as Record<string, unknown>)['parseContextExtension']).toBeTypeOf('function');
  });
});
