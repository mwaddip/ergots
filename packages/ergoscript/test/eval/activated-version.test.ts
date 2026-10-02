// activatedScriptVersion: one below the block version the pre-header carries, as the JVM node sets it (ergo-core
// nodeView/ErgoContext.scala:28), floored at 0. Block version 4 is activated version 3, the V6 soft fork.
import { describe, it, expect } from 'vitest'
import { activatedScriptVersion } from '../../src/eval/_activated-version'
import { makeContext } from '../../src/eval/eval-context'
import type { PreHeader } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

const preHeader = (version: number): PreHeader => ({
  version,
  parentId: new Uint8Array(32),
  timestamp: 0n,
  nBits: 0,
  height: 0,
  minerPk: new Uint8Array(33),
  votes: new Uint8Array(3),
})

describe('activatedScriptVersion', () => {
  it.each([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
    [5, 4],
  ])('block version %i is activated version %i', (blockVersion, activated) => {
    expect(activatedScriptVersion(makeContext({ preHeader: preHeader(blockVersion) }), 'test')).toBe(activated)
  })

  it('block version 0 floors at activated version 0', () => {
    expect(activatedScriptVersion(makeContext({ preHeader: preHeader(0) }), 'test')).toBe(0)
  })

  it('an unset pre-header is context-field-missing, and the message names the caller', () => {
    const err = captureEvalError(() => activatedScriptVersion(makeContext({}), 'reduceWith'))
    expect(err.code).toBe('context-field-missing')
    expect(err.message).toBe('reduceWith: ctx.preHeader is undefined')
  })
})
