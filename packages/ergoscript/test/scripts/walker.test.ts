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
    const useNode: Expr = { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } }
    const root: Expr = { tag: 'BlockValue', items: [valDef], result: useNode } as Expr
    walk(root, (e) => visited.push(e.tag))
    expect(visited.sort()).toEqual(['BlockValue', 'Const', 'ValDef', 'ValUse'])
  })

  it('descends into MethodCall obj + args', () => {
    const visited: string[] = []
    const obj: Expr = { tag: 'GlobalVars', kind: 'Inputs' }
    const arg: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } }
    const root: Expr = {
      tag: 'MethodCall',
      obj,
      args: [arg],
      typeId: 99,
      methodId: 8,
      explicitTypeArgs: {},
    }
    walk(root, (e) => visited.push(e.tag))
    expect(visited.sort()).toEqual(['Const', 'GlobalVars', 'MethodCall'])
  })

  it('does not visit SType objects nested in Expr fields', () => {
    const visited: string[] = []
    // Synthetic Expr with an SType-shaped field (mimicking ExtractRegisterAs.elemTpe)
    const root = {
      tag: 'ExtractRegisterAs',
      input: { tag: 'GlobalVars', kind: 'SelfBox' },
      registerId: 4,
      elemTpe: { tag: 'SLong' },  // <-- this should NOT be visited as Expr
    } as unknown as Expr
    walk(root, (e) => visited.push(e.tag))
    expect(visited).toContain('ExtractRegisterAs')
    expect(visited).toContain('GlobalVars')
    expect(visited).not.toContain('SLong')
  })

  it('handles 10,000-deep nested If without stack overflow', () => {
    // Build a linear chain: If wraps its condition only; trueBranch/falseBranch
    // are cheap leaf nodes so the structure is a 10,000-deep linked list, not
    // a DAG. This exercises the iterative worklist's depth handling without
    // exponential node expansion.
    const leaf: Expr = {
      tag: 'Const',
      tpe: { tag: 'SBoolean' },
      value: { kind: 'Boolean', value: true },
    }
    let node: Expr = leaf
    for (let i = 0; i < 10_000; i++) {
      node = { tag: 'If', condition: node, trueBranch: leaf, falseBranch: leaf } as Expr
    }
    let count = 0
    walk(node, () => count++)
    // 10,000 If nodes + the innermost Const (condition chain) + 2 leaf refs
    // per If (trueBranch+falseBranch share the same leaf object, but the
    // worklist pushes references — the same leaf is visited 10,001 times for
    // trueBranch/falseBranch alone). Any count > 10,000 confirms full traversal.
    expect(count).toBeGreaterThan(10_000)
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
      obj: { tag: 'GlobalVars', kind: 'SelfBox' },
      typeId: 99,
      methodId: 8,
    }

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
