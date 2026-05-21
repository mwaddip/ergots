import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

describe('evalExpr (central dispatch — chassis only)', () => {
  it('throws not-implemented-yet for any unwired variant', () => {
    // Use DeserializeContext as a representative — `SubstConstants` was wired
    // in Task T9 (final pure-bytes predef of phase 2i-a), so we pick the next
    // still-unported variant. DeserializeContext is a strong candidate for
    // phase 2i-c (it extracts a serialized script from the context extension
    // and inlines it). The expr shape is irrelevant to the dispatch path; only
    // the `tag` matters before the default arm fires.
    const e: Expr = {
      tag: 'DeserializeContext',
      tpe: { tag: 'SBoolean' },
      id: 0,
    }
    const err = captureEvalError(() => evalExpr(e, Env.empty(), makeContext()))
    expect(err.code).toBe('not-implemented-yet')
    expect(err.message).toContain("'DeserializeContext'")
  })
})
