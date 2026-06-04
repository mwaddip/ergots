/**
 * validateMethodCallArity — the V3+ empty-args MethodCall reject pass (P4 Task 5).
 *
 * The JVM `MethodCallSerializer.parse` asserts, for ErgoTree version >= 3,
 * `assert(args.nonEmpty)` on a MethodCall-opcode node
 * (data/shared/.../serialization/MethodCallSerializer.scala:53-55). Honest trees
 * never violate this — zero-arg calls serialize under the PropertyCall opcode.
 * ergots' parser accepts an empty-args MethodCall at every version, so any
 * zero-arg method reached via the MethodCall opcode (the new `none` 106:10 AND
 * the pre-existing `groupGenerator` 106:1) would otherwise evaluate where the
 * JVM rejects = a latent consensus fork. This pre-eval whole-tree pass closes it.
 *
 * The exact rule: for treeVersion >= 3, reject any `tag === 'MethodCall'` node
 * whose `args.length === 0`. Method-agnostic (the JVM asserts before method
 * lookup). Pre-V3 is grandfathered (the JVM does not assert there). PropertyCall
 * nodes are exempt (the legit zero-arg form). Mirrors validate-bin-op-types.ts /
 * validate-v6-types.ts (a zero-cost reject at the dispatchTreeBody chokepoint).
 *
 * Spec: docs/specs (P4) — closes the none/groupGenerator over-accept.
 */
import { describe, it, expect } from 'vitest'
import { validateMethodCallArity } from '../../src/eval/validate-method-call-arity'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { EvalError } from '../../src/eval/eval-context'
import { GROUP_GENERATOR_BYTES } from '../../src/eval/_group-generator'
import { captureEvalError } from '../_helpers'
import type { ErgoTree, Expr, TreeHeader } from '../../src/mir/types'

/** Header for a non-segregated tree at the given language version. */
function header(version: TreeHeader['version']): TreeHeader {
  return { version, hasSize: false, constantSegregation: false, rawHeader: version }
}

/**
 * A `groupGenerator`-via-MethodCall-with-empty-args body (typeId 106, methodId 1,
 * MethodCall opcode, args []). The honest form is a PropertyCall; this is the
 * adversarial MethodCall-opcode encoding of the zero-arg `groupGenerator`.
 */
const groupGenEmptyArgsMC: Expr = {
  tag: 'MethodCall',
  obj: { tag: 'Global' },
  typeId: 106,
  methodId: 1,
  args: [],
  explicitTypeArgs: {},
}

const emptyArgsMC: Expr = {
  tag: 'MethodCall',
  obj: { tag: 'Global' },
  typeId: 106,
  methodId: 10,
  args: [],
  explicitTypeArgs: { T: { tag: 'SByte' } },
}
const propCall: Expr = {
  tag: 'PropertyCall',
  obj: { tag: 'Global' },
  typeId: 106,
  methodId: 1,
  explicitTypeArgs: {},
}
const okMC: Expr = {
  tag: 'MethodCall',
  obj: { tag: 'Global' },
  typeId: 106,
  methodId: 9,
  args: [{ tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 0 } }],
  explicitTypeArgs: { T: { tag: 'SByte' } },
}

describe('validateMethodCallArity (V3+ empty-args MethodCall reject)', () => {
  it('rejects an empty-args MethodCall at treeVersion 3', () => {
    expect(() => validateMethodCallArity(emptyArgsMC, 3)).toThrow(EvalError)
    const err = captureEvalError(() => validateMethodCallArity(emptyArgsMC, 3))
    expect(err.code).toBe('method-call-empty-args')
  })

  it('does NOT reject the same node pre-V3 (grandfathered)', () => {
    expect(() => validateMethodCallArity(emptyArgsMC, 2)).not.toThrow()
  })

  it('does NOT reject a PropertyCall (the legit empty-args form) at V3', () => {
    expect(() => validateMethodCallArity(propCall, 3)).not.toThrow()
  })

  it('does NOT reject a MethodCall with args at V3', () => {
    expect(() => validateMethodCallArity(okMC, 3)).not.toThrow()
  })

  it('rejects an empty-args MethodCall nested in a child position at V3', () => {
    const nested: Expr = { tag: 'BlockValue', items: [], result: emptyArgsMC }
    expect(() => validateMethodCallArity(nested, 3)).toThrow(/empty.?args/i)
  })
})

// ── end-to-end through dispatchTreeBody (the evaluate() entry) ──────────────────
//
// These build a minimal ErgoTree whose body is the adversarial
// `groupGenerator`-via-MethodCall-with-empty-args encoding and drive it through
// the package's evaluate()/evaluateWith() entry. The V3 case must reject with
// 'method-call-empty-args' and charge ZERO JIT cost (the pass runs before any
// cost in dispatchTreeBody). The V2 case must evaluate SUCCESSFULLY to the
// generator GroupElement — proving the reject is V3-only (grandfathered), and
// that `groupGenerator` 106:1 (no minVersion gate) still runs at V2.

describe('validateMethodCallArity — end-to-end (groupGenerator empty-args MethodCall)', () => {
  it('V3 tree: rejects with method-call-empty-args AND charges zero JIT cost', () => {
    const tree: ErgoTree = {
      header: header(3),
      constantTypes: [],
      constants: [],
      body: groupGenEmptyArgsMC,
    }
    const ctx = makeContext({ treeVersion: 3 })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('method-call-empty-args')
    // Zero-cost reject: the pre-eval pass must not touch the cost counter, and the
    // 106:1 handler's addCost(10) must never run (the reject precedes dispatch).
    expect(ctx.jitCost).toBe(0)
  })

  it('V3 tree: rejects via the high-level evaluate() entry (version derived from header)', () => {
    const tree: ErgoTree = {
      header: header(3),
      constantTypes: [],
      constants: [],
      body: groupGenEmptyArgsMC,
    }
    const err = captureEvalError(() => evaluate(tree))
    expect(err.code).toBe('method-call-empty-args')
  })

  it('V2 tree: the SAME body evaluates SUCCESSFULLY to the generator (grandfathered)', () => {
    // Pre-V3 the JVM does not assert args.nonEmpty, so ergots must NOT reject:
    // the empty-args MethodCall reaches the 106:1 handler and returns the
    // secp256k1 base point. This pins that the reject is V3-only.
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: groupGenEmptyArgsMC,
    }
    const ctx = makeContext({ treeVersion: 2 })
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES })
  })
})
