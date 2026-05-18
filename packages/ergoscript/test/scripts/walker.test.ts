import { describe, it, expect } from 'vitest'
import { walk, analyzeBox, emptyResult, type Expr, type CorpusBox } from '../../scripts/_walker'

describe('walk', () => {
  it('visits a single Const node exactly once', () => {
    const visited: string[] = []
    const root: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
    walk(root, (e) => visited.push(e.tag))
    expect(visited).toEqual(['Const'])
  })

  it('visits all nodes in an If tree (depth 2)', () => {
    const visited: string[] = []
    const trueLeaf: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } }
    const falseLeaf: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } }
    const cond: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
    const root: Expr = { tag: 'If', condition: cond, trueBranch: trueLeaf, falseBranch: falseLeaf } as Expr
    walk(root, (e) => visited.push(e.tag))
    expect(visited.sort()).toEqual(['Const', 'Const', 'Const', 'If'])
  })

  it('descends into BlockValue items and result', () => {
    const visited: string[] = []
    const valDef: Expr = {
      tag: 'ValDef',
      id: 1,
      rhs: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
    } as Expr
    const useNode: Expr = { tag: 'ValUse', id: 1, tpe: { tag: 'SInt' } } as unknown as Expr
    const root: Expr = { tag: 'BlockValue', items: [valDef], result: useNode } as Expr
    walk(root, (e) => visited.push(e.tag))
    expect(visited.sort()).toEqual(['BlockValue', 'Const', 'ValDef', 'ValUse'])
  })

  it('descends into MethodCall obj + args', () => {
    const visited: string[] = []
    const obj: Expr = { tag: 'GlobalVars', varType: 'Inputs' } as unknown as Expr
    const arg: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } }
    const root: Expr = {
      tag: 'MethodCall',
      obj,
      args: [arg],
      typeId: 99,
      methodId: 8,
      explicitTypeArgs: {},
    } as Expr
    walk(root, (e) => visited.push(e.tag))
    expect(visited.sort()).toEqual(['Const', 'GlobalVars', 'MethodCall'])
  })
})

describe('analyzeBox', () => {
  it('tallies tag frequency and distinct-box counts correctly', () => {
    const box1: CorpusBox = {
      boxId: 'box1', ergoTreeBytes: '', blockHeight: 0,
      txId: '', outputIndex: 0, source: 'random',
    }
    const box2: CorpusBox = { ...box1, boxId: 'box2', source: 'must-include:test' }

    const result = emptyResult()
    const knownMethods = new Map()
    const unimplementedTags = new Set<string>()

    // box1: If with 3 Const nodes (Const appears 3× in 1 box)
    const tree1: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
      trueBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
      falseBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } },
    } as Expr
    // box2: just one Const
    const tree2: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: false } }

    analyzeBox(tree1, box1, result, knownMethods, unimplementedTags)
    analyzeBox(tree2, box2, result, knownMethods, unimplementedTags)

    const constTally = result.tagFrequencies.get('Const')!
    expect(constTally.totalAppearances).toBe(4)
    expect(constTally.distinctBoxes).toBe(2)
    expect(constTally.random).toBe(3)
    expect(constTally.mustInclude).toBe(1)

    const ifTally = result.tagFrequencies.get('If')!
    expect(ifTally.totalAppearances).toBe(1)
    expect(ifTally.distinctBoxes).toBe(1)
  })

  it('tallies method-call pairs from MethodCall and PropertyCall', () => {
    const box: CorpusBox = {
      boxId: 'box1', ergoTreeBytes: '', blockHeight: 0,
      txId: '', outputIndex: 0, source: 'random',
    }
    const result = emptyResult()
    const knownMethods = new Map([
      ['99:8', { name: 'SBox.tokens', implemented: true, implementedIn: '2g.5' }],
    ])
    const unimplementedTags = new Set<string>()

    const tree: Expr = {
      tag: 'PropertyCall',
      obj: { tag: 'GlobalVars', varType: 'SelfBox' } as unknown as Expr,
      typeId: 99,
      methodId: 8,
    } as Expr

    analyzeBox(tree, box, result, knownMethods, unimplementedTags)

    const pair = result.methodPairs.get('99:8')!
    expect(pair.typeId).toBe(99)
    expect(pair.methodId).toBe(8)
    expect(pair.methodName).toBe('SBox.tokens')
    expect(pair.totalAppearances).toBe(1)
    expect(pair.distinctBoxes).toBe(1)
    expect(pair.implemented).toBe(true)
  })

  it('records unimplemented-tag hits per box (one per box)', () => {
    const box: CorpusBox = {
      boxId: 'box-with-unimplemented', ergoTreeBytes: '', blockHeight: 0,
      txId: '', outputIndex: 0, source: 'random',
    }
    const result = emptyResult()
    const knownMethods = new Map()
    const unimplementedTags = new Set(['LastBlockUtxoRootHash'])

    const tree: Expr = { tag: 'LastBlockUtxoRootHash' } as unknown as Expr
    analyzeBox(tree, box, result, knownMethods, unimplementedTags)

    const hit = result.unimplementedHits.get('LastBlockUtxoRootHash')!
    expect(hit.distinctBoxes).toBe(1)
    expect(hit.exampleBoxIds).toContain('box-with-unimplemented')
  })
})
