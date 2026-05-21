import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

describe('evalExpr (central dispatch — chassis only)', () => {
  it('throws not-implemented-yet for any unwired variant', () => {
    // Use `ZkProofBlock` as the representative — it's modeled in the Expr union
    // for AST parity but its serializer throws `NotSupported` (mirrors sigma-
    // rust's `OpCodes.Undefined`), and the evaluator never gets a parser-built
    // node of this shape on the happy path. Previously this test used
    // DeserializeContext, but that arm is now wired in phase 2i-c (defensive
    // throw via the substitute-pre-pass architecture). The expr shape below
    // is irrelevant to the dispatch path; only the `tag` matters before the
    // default arm fires.
    const e: Expr = {
      tag: 'ZkProofBlock',
      input: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
    }
    const err = captureEvalError(() => evalExpr(e, Env.empty(), makeContext()))
    expect(err.code).toBe('not-implemented-yet')
    expect(err.message).toContain("'ZkProofBlock'")
  })
})
