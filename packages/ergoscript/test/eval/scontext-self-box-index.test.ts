/**
 * SContext.selfBoxIndex handler (typeId 101, methodId 8).
 *
 * Pattern A cost 20 (charged before obj check). Returns SInt with the
 * 0-based index of `ctx.selfBox` within `ctx.inputs`. Mirrors sigma-rust
 * `ergotree-interpreter/src/eval/scontext.rs:33-57` (`SELF_BOX_INDEX_EVAL_FN`).
 *
 * **Activated-script-version gate (JVM bug #603 compat):**
 * The JVM's pre-v5 implementation used reference equality (`eq`) instead
 * of value equality (`==`) in `CostingDataContext.scala`, causing
 * `selfBoxIndex` to always return -1 for pre-V5 blocks. The bug was fixed
 * globally in v5.x — ALL scripts in v5+ blocks get the correct value.
 * Therefore the gate is on `activated_script_version` (block-level,
 * derived from `preHeader.version - 1` saturating), NOT `tree_version`.
 *
 * Mainnet history first exercised this arm at block 342,964 — same block
 * where sigma-rust originally diverged from JVM (fixed in their v0.2.0).
 * Pre-JIT-activation blocks (preHeader.version=1, activated=0; or
 * preHeader.version=2, activated=1) return -1 unconditionally; v3+
 * blocks (activated=2 or higher) return the real index.
 *
 * Source: ergo-node-rust memory `feedback_tree_version_gate.md` documents
 * the activated-vs-tree-version distinction explicitly (session 22b
 * regression broke block 942,664 by gating on tree_version).
 *
 * Total eval cost (success): 4 (dispatcher) + 1 (Context arm) + 20 (handler) = 25.
 */

import { describe, expect, it } from 'vitest'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader, ErgoBox } from '../../src/mir/types'

function syntheticPreHeader(version: number = 3): PreHeader {
  return {
    version,
    parentId: new Uint8Array(32),
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height: 1000000,
    minerPk: new Uint8Array(33),
    votes: new Uint8Array(3),
  }
}

function syntheticBox(value: bigint = 1n): ErgoBox {
  return {
    value,
    ergoTreeBytes: new Uint8Array(),
    registers: {},
    tokens: [],
    creationHeight: 0,
    txId: new Uint8Array(32),
    index: 0,
  }
}

const selfBoxIndexExpr: PropertyCallExpr = {
  tag: 'PropertyCall',
  explicitTypeArgs: {},
  obj: { tag: 'Context' },
  typeId: 101,
  methodId: 8,
}

describe('SContext.selfBoxIndex handler', () => {
  it('returns the real index when activated_script_version >= V2 (preHeader.version=3+)', () => {
    const inputs = [syntheticBox(1n), syntheticBox(2n), syntheticBox(3n)]
    const selfBox = inputs[1]!  // same reference, so indexOf finds index 1
    const ctx = makeContext({
      preHeader: syntheticPreHeader(3),  // activated = 3-1 = 2 → V2 → real index
      selfBox,
      inputs,
    })
    const result = evalPropertyCall(selfBoxIndexExpr, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Int', value: 1 })
    expect(ctx.jitCost).toBe(25)
  })

  it('returns -1 when activated_script_version < V2 (preHeader.version=1, pre-v5 block)', () => {
    const inputs = [syntheticBox(1n), syntheticBox(2n)]
    const selfBox = inputs[1]!  // would index to 1 if not gated
    const ctx = makeContext({
      preHeader: syntheticPreHeader(1),  // activated = 1-1 = 0 → < V2 → JVM bug parity → -1
      selfBox,
      inputs,
    })
    const result = evalPropertyCall(selfBoxIndexExpr, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Int', value: -1 })
    expect(ctx.jitCost).toBe(25)
  })

  it('returns -1 when activated_script_version < V2 (preHeader.version=2, still pre-v5)', () => {
    const inputs = [syntheticBox(1n)]
    const selfBox = inputs[0]!
    const ctx = makeContext({
      preHeader: syntheticPreHeader(2),  // activated = 2-1 = 1 → < V2 → still -1
      selfBox,
      inputs,
    })
    const result = evalPropertyCall(selfBoxIndexExpr, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Int', value: -1 })
  })

  it('saturates the version subtraction (preHeader.version=0 → activated=0, returns -1)', () => {
    const inputs = [syntheticBox(1n)]
    const selfBox = inputs[0]!
    const ctx = makeContext({
      preHeader: syntheticPreHeader(0),  // saturating: max(0, 0-1) = 0
      selfBox,
      inputs,
    })
    const result = evalPropertyCall(selfBoxIndexExpr, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Int', value: -1 })
  })

  it('charges +20 BEFORE the obj-kind check (Pattern A) on non-Context receiver', () => {
    const nonContextExpr: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Global' },
      typeId: 101,
      methodId: 8,
    }
    const ctx = makeContext({ preHeader: syntheticPreHeader() })
    const err = captureEvalError(() => evalPropertyCall(nonContextExpr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-obj-not-context')
    // 4 (PropertyCall dispatcher) + 5 (Global arm) + 20 (handler before throw) = 29
    expect(ctx.jitCost).toBe(29)
  })

  it('throws context-field-missing when ctx.preHeader is undefined', () => {
    const ctx = makeContext({})
    const err = captureEvalError(() => evalPropertyCall(selfBoxIndexExpr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })

  it('throws context-field-missing on V2+ block when ctx.selfBox or ctx.inputs is missing', () => {
    // V2+ activated → handler reaches the inputs walk; missing inputs/selfBox surfaces.
    const ctx = makeContext({ preHeader: syntheticPreHeader(3) })
    const err = captureEvalError(() => evalPropertyCall(selfBoxIndexExpr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })

  it('throws context-field-missing when selfBox is not found in inputs (V2+ block)', () => {
    const inputs = [syntheticBox(1n), syntheticBox(2n)]
    const orphanBox = syntheticBox(99n)  // distinct reference, not in inputs
    const ctx = makeContext({
      preHeader: syntheticPreHeader(3),
      selfBox: orphanBox,
      inputs,
    })
    const err = captureEvalError(() => evalPropertyCall(selfBoxIndexExpr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })
})
