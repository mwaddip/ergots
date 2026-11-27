// The activated script version an evaluation runs under: the JVM's `ErgoLikeContext.activatedScriptVersion`, a signed
// byte (ergo-core nodeView/ErgoContext.scala:28 `(stateContext.blockVersion - 1).toByte`;
// sigma/VersionContext.scala:17 `activatedVersion`). A context carries it as `activatedScriptVersion`; without it,
// a context derives it from `preHeader.version` wrapped as a signed byte.
import { describe, it, expect } from 'vitest'
import {
  activatedScriptVersion,
  activatedVersionOfBlock,
  knownActivatedVersion,
} from '../../src/eval/_activated-version'
import { activatedVersionOfBlock as exported } from '../../src/index'
import { makeContext } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { parseSType } from '../../src/wire/parse-stype'
import { parseSValue } from '../../src/wire/parse-svalue'
import { ByteReader } from '@ergots/scorex'
import { reduceWith } from '../../src/eval/evaluate'
import { serializeSigmaBoolean } from '../../src/wire/sigma-boolean'
import { ByteWriter } from '@ergots/scorex'
import { spendContext } from './_substitution-spends'
import { captureEvalError, hexToBytes, synthesizeStubBox } from '../_helpers'
import type { ErgoBox, PreHeader, SValue } from '../../src/mir/types'

const preHeader = (version: number): PreHeader => ({
  version,
  parentId: new Uint8Array(32),
  timestamp: 0n,
  nBits: 0,
  height: 0,
  minerPk: new Uint8Array(33),
  votes: new Uint8Array(3),
})

describe('activatedVersionOfBlock wraps block version minus 1 as a signed byte', () => {
  it.each([
    [0, -1],
    [1, 0],
    [4, 3],
    [5, 4],
    [128, 127],
    [129, -128],
    [200, -57],
    [255, -2],
    [256, -1],
  ])('block version %i gives activated %i', (blockVersion, activated) => {
    expect(activatedVersionOfBlock(blockVersion)).toBe(activated)
  })

  it('the package exports the function', () => {
    expect(exported).toBe(activatedVersionOfBlock)
  })

  it('a block version that is no integer is a TypeError', () => {
    for (const bad of [NaN, 1.5, Infinity, '4', null, undefined]) {
      expect(() => activatedVersionOfBlock(bad as unknown as number)).toThrow(TypeError)
    }
  })
})

describe('activatedScriptVersion prefers the context field over the pre-header', () => {
  it('a context with the field 2 and a pre-header of version 5 answers 2', () => {
    const ctx = makeContext({ preHeader: preHeader(5), activatedScriptVersion: 2 })
    expect(knownActivatedVersion(ctx)).toBe(2)
    expect(activatedScriptVersion(ctx, 'test')).toBe(2)
  })

  it('a context without a field: a pre-header of version 4 gives activated 3', () => {
    const ctx = makeContext({ preHeader: preHeader(4) })
    expect(knownActivatedVersion(ctx)).toBe(3)
    expect(activatedScriptVersion(ctx, 'test')).toBe(3)
  })

  it('a context without a field: a pre-header of version 129 gives activated -128', () => {
    const ctx = makeContext({ preHeader: preHeader(129) })
    expect(knownActivatedVersion(ctx)).toBe(-128)
    expect(activatedScriptVersion(ctx, 'test')).toBe(-128)
  })

  it.each([-128, -57, -1, 0, 1, 2, 3, 4, 127])(
    'the field %i stands on its own',
    (activated) => {
      const ctx = makeContext({ activatedScriptVersion: activated })
      expect(knownActivatedVersion(ctx)).toBe(activated)
      expect(activatedScriptVersion(ctx, 'test')).toBe(activated)
    },
  )

  it('a context with neither field nor pre-header has no known activated version', () => {
    expect(knownActivatedVersion(makeContext({}))).toBeUndefined()
  })

  it("and 'context-field-missing' names the caller in the error", () => {
    const err = captureEvalError(() => activatedScriptVersion(makeContext({}), 'reduceWith'))
    expect(err.code).toBe('context-field-missing')
    expect(err.message).toBe(
      'reduceWith: the context has neither activatedScriptVersion nor a preHeader',
    )
  })
})

describe('makeContext validates activatedScriptVersion as a signed byte', () => {
  it.each([NaN, 1.5, 128, -129, 200, '3', null])(
    'a field %p is a TypeError',
    (bad) => {
      expect(() =>
        makeContext({ activatedScriptVersion: bad as unknown as number }),
      ).toThrow(TypeError)
    },
  )

  it('every signed byte is accepted', () => {
    for (const activated of [-128, -1, 0, 1, 127]) {
      const ctx = makeContext({ activatedScriptVersion: activated })
      expect(ctx.activatedScriptVersion).toBe(activated)
    }
  })
})

function stubBoxFor(treeBytes: Uint8Array): ErgoBox {
  return { ...synthesizeStubBox(), ergoTreeBytes: treeBytes }
}

/** reduce `treeHex` with SELF at inputs[0] and the chosen (activated, preHeaderVersion). */
function reduce(
  treeHex: string,
  opts: { activated?: number; preHeaderVersion?: number },
): { value: SValue; cost: number } {
  const bytes = hexToBytes(treeHex)
  const parsed = parseTree(bytes, { checkType: true })
  if (!('constants' in parsed)) throw new Error(`tree ${treeHex} degraded`)
  const selfBox = stubBoxFor(bytes)
  const ctx = makeContext({
    constants: parsed.constants,
    selfBox,
    inputs: [selfBox],
    preHeader: opts.preHeaderVersion === undefined ? undefined : preHeader(opts.preHeaderVersion),
    activatedScriptVersion: opts.activated,
  })
  const value = reduceWith(parsed, ctx)
  return { value, cost: ctx.jitCost }
}

const SELF_BOX_INDEX_EQ_ZERO = '00d193db6508fe0400'
const SIGMA_PROP_OF_SIGMA_PROP_V0 = '00d108d3'
const SIGMA_PROP_OF_SIGMA_PROP_V2 = '0a03d108d3'

describe('SContext.selfBoxIndex reads the activated version off the context', () => {
  // Pre-header set apart so the field wins. activated < 2 yields index -1 (-1==0 is false);
  // activated >= 2 yields the real index 0 (0==0 is true).
  it.each([
    [3, true],
    [1, false],
    [127, true],
    [-1, false],
    [-128, false],
  ])(
    'sigmaProp(selfBoxIndex == 0) with SELF at inputs[0] at activated %i reduces to %s',
    (activated, expected) => {
      const { value, cost } = reduce(SELF_BOX_INDEX_EQ_ZERO, {
        activated,
        preHeaderVersion: 5, // pre-header says activated 4; the field wins
      })
      expect(value.kind).toBe('SigmaProp')
      if (value.kind !== 'SigmaProp') throw new Error('unreachable')
      expect(value.value.tag).toBe('TrivialProp')
      if (value.value.tag !== 'TrivialProp') throw new Error('unreachable')
      expect(value.value.value).toBe(expected)
      void cost
    },
  )
})

describe('BoolToSigmaProp on a SigmaProp constant reads the activated version off the context', () => {
  // At activated >= 2 the arm refuses a SigmaProp operand; at activated < 2 it passes through.
  for (const [treeHex, treeName] of [
    [SIGMA_PROP_OF_SIGMA_PROP_V0, 'v0 sigmaProp(SigmaProp const)'],
    [SIGMA_PROP_OF_SIGMA_PROP_V2, 'v2 sigmaProp(SigmaProp const)'],
  ] as const) {
    it.each([3, 2])(
      `${treeName} is refused at activated %i`,
      (activated) => {
        const err = captureEvalError(() =>
          reduce(treeHex, { activated, preHeaderVersion: 0 }),
        )
        expect(err.code).toBe('bin-op-not-boolean')
      },
    )

    it.each([1, 0])(
      `${treeName} passes a SigmaProp constant through at activated %i`,
      (activated) => {
        const { value, cost } = reduce(treeHex, { activated, preHeaderVersion: 5 })
        expect(value.kind).toBe('SigmaProp')
        if (value.kind !== 'SigmaProp') throw new Error('unreachable')
        expect(value.value.tag).toBe('TrivialProp')
        expect(cost).toBe(20)
      },
    )
  }
})

describe('the tree charge of a substituted tree is charged from activated 3', () => {
  // A tree with a Deserialize node triggers chargeTreeBytes: 20 JitCost per tree byte at activated >= 3,
  // dropped below. The DR tree '00d5040800' (sigmaProp(DR(R4, SigmaProp))) has hasDeserialize=true, body
  // reduces to its SigmaProp constant via a decoded register. We observe the charge by comparing final
  // ctx.jitCost at activated 3 vs 2; the delta is 20 * tree byte length.
  const DR_TREE_HEX = '00d5040800'
  const DR_TREE_BYTES = hexToBytes(DR_TREE_HEX)
  const BODY = '0e0208d3' // R4 = Coll[Byte] holding 08 d3 (TrueProp SigmaProp constant)

  function reduceDr(opts: { activated?: number; preHeaderVersion?: number }): number {
    const parsed = parseTree(DR_TREE_BYTES, { checkType: true })
    if (!('constants' in parsed)) throw new Error('tree degraded')
    const bodyBytes = hexToBytes(BODY)
    const r = new ByteReader(bodyBytes)
    const tpe = parseSType(r, 0)
    const value = parseSValue(tpe, 0, r)
    const selfBox: ErgoBox = {
      ...synthesizeStubBox(),
      ergoTreeBytes: DR_TREE_BYTES,
      registers: { 4: { tpe, value } },
    }
    const ctx = makeContext({
      constants: parsed.constants,
      selfBox,
      inputs: [selfBox],
      preHeader: opts.preHeaderVersion === undefined ? undefined : preHeader(opts.preHeaderVersion),
      activatedScriptVersion: opts.activated,
    })
    reduceWith(parsed, ctx)
    return ctx.jitCost
  }

  // DR_TREE_BYTES.length == 5 ⇒ chargeTreeBytes adds 20 * 5 = 100 at activated >= 3.
  it('activated 3 charges 20 JitCost per tree byte on top of the body', () => {
    const at3 = reduceDr({ activated: 3, preHeaderVersion: 0 })
    const at2 = reduceDr({ activated: 2, preHeaderVersion: 0 })
    expect(at3 - at2).toBe(20 * DR_TREE_BYTES.length)
  })

  it('activated 2 adds no tree charge', () => {
    const at2 = reduceDr({ activated: 2, preHeaderVersion: 0 })
    const atUnset = reduceDr({ activated: 1, preHeaderVersion: 0 })
    expect(at2).toBe(atUnset)
  })

  it('a pre-header of version 129 is activated -128 and adds no tree charge', () => {
    const at129 = reduceDr({ preHeaderVersion: 129 })
    const at2 = reduceDr({ preHeaderVersion: 3 })
    expect(at129).toBe(at2)
  })
})


/** The proposition a spend of `tree` reduces to at `activated`, serialized, and its block cost. */
function spendOutcome(tree: string, activated: number): { sigma: string; cost: number } {
  const spent = spendContext({ tree, var1: '0e030008d3' }, activated)
  const value = reduceWith(spent.tree, spent.ctx)
  if (value.kind !== 'SigmaProp') throw new Error(`expected a SigmaProp, got ${value.kind}`)
  const w = new ByteWriter()
  serializeSigmaBoolean(value.value, w)
  const sigma = Array.from(w.toBytes(), (b) => b.toString(16).padStart(2, '0')).join('')
  return { sigma, cost: Math.floor(spent.ctx.jitCost / 10) }
}

const TRUE_PROP = 'd3'
const FALSE_PROP = 'd2'

// Tree `sigmaProp(substConstants(var1, Coll(5), Coll(SELF)).size == 3)`, tree version 0: the template `0008d3`
// holds no constant and position 5 names nothing.
const BOX_NEW_VALUE_SIZE_3 = '00d193b174e4e3010e830104040a830163a70406'
// The same with `size == 4`.
const BOX_NEW_VALUE_SIZE_4 = '00d193b174e4e3010e830104040a830163a70408'
// `sigmaProp(substConstants(var1, Coll(), Coll()).size == n)`: no new value to lift.
const NO_NEW_VALUE_SIZE_3 = '00d193b174e4e3010e8300048300630406'
const NO_NEW_VALUE_SIZE_4 = '00d193b174e4e3010e8300048300630408'
// Tree `sigmaProp(substConstants(<template 0008d3>, Coll(), Coll()).size == n)`, segregated, tree version 0.
const EMPTY_SUBST_SIZE_3 = '10010406d193b174e4e3010e8300048300047300'
const EMPTY_SUBST_SIZE_4 = '10010408d193b174e4e3010e8300048300047300'

describe('SubstConstants of a Box agrees with the JVM at activated 2 and 3', () => {
  it.each([2, 3])('activated %i: a Box new value is lifted, size 3, TrueProp at block cost 21', (activated) => {
    expect(spendOutcome(BOX_NEW_VALUE_SIZE_3, activated)).toEqual({ sigma: TRUE_PROP, cost: 21 })
  })

  it('activated 2: no new value, size 3, TrueProp at block cost 20', () => {
    expect(spendOutcome(NO_NEW_VALUE_SIZE_3, 2)).toEqual({ sigma: TRUE_PROP, cost: 20 })
  })
})

describe('the size of a substituted template at activated 2 and 3', () => {
  it.each([2, 3])('activated %i: an empty substitution into a segregated template is size 3', (activated) => {
    expect(spendOutcome(EMPTY_SUBST_SIZE_3, activated)).toEqual({ sigma: TRUE_PROP, cost: 19 })
    expect(spendOutcome(EMPTY_SUBST_SIZE_4, activated)).toEqual({ sigma: FALSE_PROP, cost: 19 })
  })
})

describe('below activated 2 ergots lifts a Box where the JVM refuses it', () => {
  // The JVM rejects a Box among the new values below activated 2 (`Cannot liftToConstant(Box(...))`); ergots lifts
  // it at every activated version and writes the template at size 3.
  it.each([0, 1])('activated %i: the Box new value is lifted, size 3 is TrueProp and size 4 FalseProp', (activated) => {
    expect(spendOutcome(BOX_NEW_VALUE_SIZE_3, activated).sigma).toBe(TRUE_PROP)
    expect(spendOutcome(BOX_NEW_VALUE_SIZE_4, activated).sigma).toBe(FALSE_PROP)
  })
})

describe('below activated 2 ergots writes a substituted template at size 3 where the JVM writes size 4', () => {
  // The JVM's answers below activated 2: size 3 is FalseProp and size 4 TrueProp, at block cost 19 (an empty
  // substitution into a segregated template) and 20 (no new value into an unsegregated one).
  it.each([0, 1])('activated %i: an empty substitution into a segregated template', (activated) => {
    expect(spendOutcome(EMPTY_SUBST_SIZE_3, activated)).toEqual({ sigma: TRUE_PROP, cost: 19 })
    expect(spendOutcome(EMPTY_SUBST_SIZE_4, activated)).toEqual({ sigma: FALSE_PROP, cost: 19 })
  })

  it('activated 1: no new value into an unsegregated template', () => {
    expect(spendOutcome(NO_NEW_VALUE_SIZE_3, 1)).toEqual({ sigma: TRUE_PROP, cost: 20 })
    expect(spendOutcome(NO_NEW_VALUE_SIZE_4, 1)).toEqual({ sigma: FALSE_PROP, cost: 20 })
  })
})
