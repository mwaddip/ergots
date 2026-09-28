/**
 * Shared test utilities for the wire-layer test suite.
 *
 * Filename uses no `.test.ts` suffix so vitest (configured with
 * `include: ['test/**\/*.test.ts']`) does not treat it as a test file.
 * The leading underscore is a visual cue that the module is a helper.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { ByteWriter } from '@ergots/scorex'
import { ExprParseError } from '../../src/wire/errors'
import { parseTree } from '../../src/wire/ergo-tree'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import type { ParsedErgoTree } from '../../src/mir/types'

/**
 * A valid SHeader value's bytes, taken as `svalue-sheader-roundtrip.test.ts` takes them:
 * the SHeader constant of the v3 fixture `sheader-constants-v3-single-header.bin` (a v2
 * mainnet header), re-serialized.
 */
export function validHeaderData(): Uint8Array {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/wire/sheader-constants-v3-single-header.bin')
  const tree = parseTree(new Uint8Array(readFileSync(fixture))) as ParsedErgoTree
  const w = new ByteWriter()
  serializeSValue({ tag: 'SHeader' }, tree.constants[0]!, 3, w)
  return w.toBytes()
}

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
