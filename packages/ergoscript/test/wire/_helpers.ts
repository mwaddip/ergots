/**
 * Shared test utilities for the wire-layer test suite.
 *
 * Filename uses no `.test.ts` suffix so vitest (configured with
 * `include: ['test/**\/*.test.ts']`) does not treat it as a test file.
 * The leading underscore is a visual cue that the module is a helper.
 */

import { expect } from 'vitest'
import { ExprParseError } from '../../src/wire/errors'

/**
 * Asserts that `fn` throws an `ExprParseError` whose `code` matches
 * `expectedCode`. Use for negative tests of per-variant parsers, e.g.
 *
 *   expectParseError(() => parseTree(bytes), 'invalid-constant-placeholder-id')
 *
 * Equivalent to the verbose try/catch + instanceof + code-assert pattern
 * that would otherwise replicate across every Task 11-26 variant test.
 */
export function expectParseError(
  fn: () => unknown,
  expectedCode: string
): void {
  let thrown: unknown
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(ExprParseError)
  expect((thrown as ExprParseError).code).toBe(expectedCode)
}
