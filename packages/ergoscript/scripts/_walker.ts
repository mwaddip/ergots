import type { Expr } from '../src/mir/types'

export type { Expr }

export function walk(root: Expr, visit: (e: Expr) => void): void {
  const stack: Expr[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    visit(node)
    for (const child of childrenOf(node)) {
      stack.push(child)
    }
  }
}

function childrenOf(node: Expr): Expr[] {
  switch (node.tag) {
    case 'Const':
    case 'ConstPlaceholder':
    case 'ValUse':
    case 'GlobalVars':
    case 'Context':
      return []
    case 'If':
      return [
        (node as { condition: Expr }).condition,
        (node as { trueBranch: Expr }).trueBranch,
        (node as { falseBranch: Expr }).falseBranch,
      ]
    case 'BlockValue':
      return [
        ...((node as { items: Expr[] }).items ?? []),
        (node as { result: Expr }).result,
      ]
    case 'ValDef':
      return [(node as { rhs: Expr }).rhs]
    case 'FuncValue':
      return [(node as { body: Expr }).body]
    case 'Apply':
      return [
        (node as { func: Expr }).func,
        ...((node as { args: Expr[] }).args ?? []),
      ]
    case 'BinOp':
      return [
        (node as { left: Expr }).left,
        (node as { right: Expr }).right,
      ]
    case 'MethodCall':
      return [
        (node as { obj: Expr }).obj,
        ...((node as { args: Expr[] }).args ?? []),
      ]
    case 'PropertyCall':
      return [(node as { obj: Expr }).obj]
    default:
      return collectExprChildren(node as unknown as Record<string, unknown>)
  }
}

function collectExprChildren(node: Record<string, unknown>): Expr[] {
  const out: Expr[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isExpr(item)) out.push(item)
      }
    } else if (isExpr(value)) {
      out.push(value)
    }
  }
  return out
}

function isExpr(v: unknown): v is Expr {
  return (
    typeof v === 'object' &&
    v !== null &&
    'tag' in (v as object) &&
    typeof (v as { tag: unknown }).tag === 'string'
  )
}

export interface TagTally {
  totalAppearances: number
  distinctBoxes: number
  random: number
  mustInclude: number
}

export interface MethodPairTally extends TagTally {
  typeId: number
  methodId: number
  methodName?: string
  implemented?: boolean
  implementedIn?: string
}

export interface CorpusBox {
  boxId: string
  ergoTreeBytes: string
  blockHeight: number
  txId: string
  outputIndex: number
  source: string
}

export interface AnalysisResult {
  tagFrequencies: Map<string, TagTally>
  methodPairs: Map<string, MethodPairTally>
  unimplementedHits: Map<string, { distinctBoxes: number; exampleBoxIds: string[] }>
  parseFailures: { boxId: string; errorCode: string; source: string }[]
}

export function emptyResult(): AnalysisResult {
  return {
    tagFrequencies: new Map(),
    methodPairs: new Map(),
    unimplementedHits: new Map(),
    parseFailures: [],
  }
}

function incTally(tally: TagTally | MethodPairTally, source: string): void {
  tally.totalAppearances++
  if (source === 'random') tally.random++
  else if (source.startsWith('must-include')) tally.mustInclude++
}

export function analyzeBox(
  parsedBody: Expr,
  box: CorpusBox,
  result: AnalysisResult,
  knownMethods: Map<string, { name: string; implemented: boolean; implementedIn?: string }>,
  unimplementedTags: ReadonlySet<string>,
): void {
  const tagsSeenInThisBox = new Set<string>()
  const methodPairsSeenInThisBox = new Set<string>()
  const unimplementedSeenInThisBox = new Set<string>()

  walk(parsedBody, (node) => {
    let tally = result.tagFrequencies.get(node.tag)
    if (!tally) {
      tally = { totalAppearances: 0, distinctBoxes: 0, random: 0, mustInclude: 0 }
      result.tagFrequencies.set(node.tag, tally)
    }
    incTally(tally, box.source)
    if (!tagsSeenInThisBox.has(node.tag)) {
      tally.distinctBoxes++
      tagsSeenInThisBox.add(node.tag)
    }

    if (node.tag === 'MethodCall' || node.tag === 'PropertyCall') {
      const typeId = (node as { typeId: number }).typeId
      const methodId = (node as { methodId: number }).methodId
      const key = `${typeId}:${methodId}`
      let pair = result.methodPairs.get(key)
      if (!pair) {
        const lookup = knownMethods.get(key)
        pair = {
          totalAppearances: 0,
          distinctBoxes: 0,
          random: 0,
          mustInclude: 0,
          typeId,
          methodId,
          methodName: lookup?.name,
          implemented: lookup?.implemented,
          implementedIn: lookup?.implementedIn,
        }
        result.methodPairs.set(key, pair)
      }
      incTally(pair, box.source)
      if (!methodPairsSeenInThisBox.has(key)) {
        pair.distinctBoxes++
        methodPairsSeenInThisBox.add(key)
      }
    }

    if (unimplementedTags.has(node.tag) && !unimplementedSeenInThisBox.has(node.tag)) {
      let entry = result.unimplementedHits.get(node.tag)
      if (!entry) {
        entry = { distinctBoxes: 0, exampleBoxIds: [] }
        result.unimplementedHits.set(node.tag, entry)
      }
      entry.distinctBoxes++
      if (entry.exampleBoxIds.length < 5) entry.exampleBoxIds.push(box.boxId)
      unimplementedSeenInThisBox.add(node.tag)
    }
  })
}
