/**
 * Layer C3.a — Mutation operators + tree-traversal helpers.
 *
 * Provides:
 *  - `visitExpr`       — depth-first traversal, calls callback(node, path)
 *  - `replaceAtPath`   — immutable deep-replace at a numeric path
 *  - O1-O7 operator implementations (see task-11 spec)
 *  - `ALL_OPERATORS`   — registry of all 7 operators
 *
 * Path encoding: array of integer indices into the per-tag child list (same
 * order as the switch below). E.g. `[0]` = first child, `[0, 1]` = first
 * child's second child.
 *
 * Phase 2f Coll HOFs only (9 arms). Not retroactive to the 33 prior arms
 * (though the visitor handles all Expr variants for correctness).
 */

import type {
  Expr,
  SValue,
  Const,
  Collection,
  FuncValue,
  Fold,
  ByIndex,
  LogicalNot,
} from '../src/mir/types'

// ---------------------------------------------------------------------------
// MutationOperator interface
// ---------------------------------------------------------------------------

export interface MutationOperator {
  name: string
  /** Returns 0 or more single-mutation Expr variants. Deterministic order. */
  apply(expr: Expr): Expr[]
}

// ---------------------------------------------------------------------------
// visitExpr — depth-first traversal
// ---------------------------------------------------------------------------

/**
 * Visit every reachable Expr node in depth-first order.
 * `callback(node, path)` is called for each node.
 * `path` is the deterministic numeric path from the root.
 *
 * Child order per tag matches `getChildren` below.
 */
export function visitExpr(
  expr: Expr,
  callback: (node: Expr, path: number[]) => void,
  _path: number[] = []
): void {
  callback(expr, _path)
  const children = getChildren(expr)
  for (let i = 0; i < children.length; i++) {
    if (children[i] !== null) {
      visitExpr(children[i]!, callback, [..._path, i])
    }
  }
}

// ---------------------------------------------------------------------------
// replaceAtPath — immutable deep-replace
// ---------------------------------------------------------------------------

/**
 * Returns a new Expr tree with the node at `path` replaced by `newNode`.
 * All ancestor nodes along the path are also new objects (shallow-cloned
 * with the relevant child replaced). Leaves the rest of the tree as-is.
 *
 * Throws if the path is invalid for the tree structure.
 */
export function replaceAtPath(expr: Expr, path: number[], newNode: Expr): Expr {
  if (path.length === 0) return newNode

  const head = path[0] as number  // non-null because path.length > 0
  const tail = path.slice(1)
  const children = getChildren(expr)
  if (head < 0 || head >= children.length || children[head] === null) {
    throw new Error(
      `replaceAtPath: invalid path index ${head} for tag '${expr.tag}' (${children.length} children)`
    )
  }

  const childAtHead = children[head] as Expr  // non-null: checked above
  const newChild = replaceAtPath(childAtHead, tail, newNode)
  return replaceChild(expr, head, newChild)
}

// ---------------------------------------------------------------------------
// getChildren / replaceChild — the exhaustive per-tag child enumeration
// ---------------------------------------------------------------------------

/**
 * Returns the ordered child Expr list for `expr`.
 * `null` entries represent optional children that are absent (e.g. `ByIndex.default = null`).
 * For nullary nodes (Const, ValUse, Context, Global, GlobalVars, GetVar, etc.)
 * returns [].
 */
function getChildren(expr: Expr): (Expr | null)[] {
  switch (expr.tag) {
    // Nullary — no Expr children
    case 'Const':
    case 'ConstPlaceholder':
    case 'Context':
    case 'Global':
    case 'GlobalVars':
    case 'LastBlockUtxoRootHash':
    case 'ValUse':
    case 'GetVar':
    case 'DeserializeContext':
      return []

    // Unary — one Expr child via `input`
    case 'ByteArrayToLong':
    case 'ByteArrayToBigInt':
    case 'LongToByteArray':
    case 'CalcBlake2b256':
    case 'CalcSha256':
    case 'And':
    case 'Or':
    case 'LogicalNot':
    case 'Negation':
    case 'BitInversion':
    case 'OptionGet':
    case 'OptionIsDefined':
    case 'ExtractAmount':
    case 'ExtractBytes':
    case 'ExtractBytesWithNoRef':
    case 'ExtractScriptBytes':
    case 'ExtractCreationInfo':
    case 'ExtractId':
    case 'SizeOf':
    case 'SelectField':
    case 'BoolToSigmaProp':
    case 'CreateProveDlog':
    case 'SigmaPropBytes':
    case 'SigmaPropIsProven':
    case 'ZkProofBlock':
    case 'DecodePoint':
    case 'XorOf':
      return [expr.input]

    case 'ExtractRegisterAs':
      return [expr.input]  // registerId and elemTpe are non-Expr metadata

    case 'Upcast':
    case 'Downcast':
      return [expr.input]  // tpe is non-Expr metadata

    // Binary — two Expr children
    case 'Append':
      return [expr.input, expr.col2]

    case 'BinOp':
      return [expr.left, expr.right]

    case 'Xor':
    case 'MultiplyGroup':
    case 'Exponentiate':
      return [expr.left, expr.right]

    case 'Atleast':
      return [expr.bound, expr.input]

    case 'OptionGetOrElse':
      return [expr.input, expr.default]

    case 'ByIndex':
      // children: [input, index, default|null]
      return [expr.input, expr.index, expr.default]

    case 'Slice':
      return [expr.input, expr.from, expr.until]

    case 'If':
      return [expr.condition, expr.trueBranch, expr.falseBranch]

    case 'SubstConstants':
      return [expr.scriptBytes, expr.positions, expr.newValues]

    case 'TreeLookup':
      return [expr.tree, expr.key, expr.proof]

    case 'CreateAvlTree':
      // children: [flags, digest, keyLength, valueLength] — 4 exprs (JVM
      // layout; valueLength is an Option-TYPED expr, always present)
      return [expr.flags, expr.digest, expr.keyLength, expr.valueLength]

    case 'CreateProveDhTuple':
      return [expr.g, expr.h, expr.u, expr.v]

    // Fold: [input, zero, foldOp]
    case 'Fold':
      return [expr.input, expr.zero, expr.foldOp]

    // Map, Filter, Exists, ForAll: [input, mapper/condition]
    case 'Map':
      return [expr.input, expr.mapper]
    case 'Filter':
      return [expr.input, expr.condition]
    case 'Exists':
      return [expr.input, expr.condition]
    case 'ForAll':
      return [expr.input, expr.condition]

    // FuncValue: [body] — args are FuncArg[] (metadata only, no Expr)
    case 'FuncValue':
      return [expr.body]

    // Apply: [func, ...args]
    case 'Apply':
      return [expr.func, ...expr.args]

    // MethodCall: [obj, ...args]
    case 'MethodCall':
      return [expr.obj, ...expr.args]

    // PropertyCall: [obj]
    case 'PropertyCall':
      return [expr.obj]

    // BlockValue: [...items, result]
    case 'BlockValue':
      return [...expr.items, expr.result]

    // ValDef: [rhs]
    case 'ValDef':
      return [expr.rhs]

    // Tuple: [...items]
    case 'Tuple':
      return [...expr.items]

    // Collection: either Exprs (items are Expr[]) or BoolConstants (no Expr children)
    case 'Collection':
      if (expr.kind === 'Exprs') {
        return [...expr.items]
      }
      return []  // BoolConstants carries boolean[], no Expr children

    // SigmaAnd / SigmaOr: [...items]
    case 'SigmaAnd':
    case 'SigmaOr':
      return [...expr.items]

    // DeserializeRegister: [default|null]
    case 'DeserializeRegister':
      return [expr.default]

    default: {
      // Exhaustive check — TypeScript will catch unhandled cases at compile time.
      const _exhaust: never = expr
      throw new Error(`getChildren: unhandled tag '${(_exhaust as { tag: string }).tag}'`)
    }
  }
}

/**
 * Returns a shallow-cloned expr with child at `index` replaced by `newChild`.
 * Uses the same child ordering as `getChildren`.
 */
function replaceChild(expr: Expr, index: number, newChild: Expr): Expr {
  switch (expr.tag) {
    // Nullary — should never be called with a valid path
    case 'Const':
    case 'ConstPlaceholder':
    case 'Context':
    case 'Global':
    case 'GlobalVars':
    case 'LastBlockUtxoRootHash':
    case 'ValUse':
    case 'GetVar':
    case 'DeserializeContext':
      throw new Error(`replaceChild: nullary tag '${expr.tag}' has no children`)

    // Unary via `input`
    case 'ByteArrayToLong':
    case 'ByteArrayToBigInt':
    case 'LongToByteArray':
    case 'CalcBlake2b256':
    case 'CalcSha256':
    case 'And':
    case 'Or':
    case 'LogicalNot':
    case 'Negation':
    case 'BitInversion':
    case 'OptionGet':
    case 'OptionIsDefined':
    case 'ExtractAmount':
    case 'ExtractBytes':
    case 'ExtractBytesWithNoRef':
    case 'ExtractScriptBytes':
    case 'ExtractCreationInfo':
    case 'ExtractId':
    case 'SizeOf':
    case 'SelectField':
    case 'BoolToSigmaProp':
    case 'CreateProveDlog':
    case 'SigmaPropBytes':
    case 'SigmaPropIsProven':
    case 'ZkProofBlock':
    case 'DecodePoint':
    case 'XorOf':
    case 'ExtractRegisterAs':
    case 'Upcast':
    case 'Downcast':
      if (index !== 0) throw new Error(`replaceChild: ${expr.tag} only has child 0`)
      return { ...expr, input: newChild }

    case 'Append':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, col2: newChild }
      throw new Error(`replaceChild: Append has 2 children`)

    case 'BinOp':
      if (index === 0) return { ...expr, left: newChild }
      if (index === 1) return { ...expr, right: newChild }
      throw new Error(`replaceChild: BinOp has 2 children`)

    case 'Xor':
    case 'MultiplyGroup':
    case 'Exponentiate':
      if (index === 0) return { ...expr, left: newChild }
      if (index === 1) return { ...expr, right: newChild }
      throw new Error(`replaceChild: ${expr.tag} has 2 children`)

    case 'Atleast':
      if (index === 0) return { ...expr, bound: newChild }
      if (index === 1) return { ...expr, input: newChild }
      throw new Error(`replaceChild: Atleast has 2 children`)

    case 'OptionGetOrElse':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, default: newChild }
      throw new Error(`replaceChild: OptionGetOrElse has 2 children`)

    case 'ByIndex':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, index: newChild }
      if (index === 2) return { ...expr, default: newChild }
      throw new Error(`replaceChild: ByIndex has 3 children`)

    case 'Slice':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, from: newChild }
      if (index === 2) return { ...expr, until: newChild }
      throw new Error(`replaceChild: Slice has 3 children`)

    case 'If':
      if (index === 0) return { ...expr, condition: newChild }
      if (index === 1) return { ...expr, trueBranch: newChild }
      if (index === 2) return { ...expr, falseBranch: newChild }
      throw new Error(`replaceChild: If has 3 children`)

    case 'SubstConstants':
      if (index === 0) return { ...expr, scriptBytes: newChild }
      if (index === 1) return { ...expr, positions: newChild }
      if (index === 2) return { ...expr, newValues: newChild }
      throw new Error(`replaceChild: SubstConstants has 3 children`)

    case 'TreeLookup':
      if (index === 0) return { ...expr, tree: newChild }
      if (index === 1) return { ...expr, key: newChild }
      if (index === 2) return { ...expr, proof: newChild }
      throw new Error(`replaceChild: TreeLookup has 3 children`)

    case 'CreateAvlTree':
      if (index === 0) return { ...expr, flags: newChild }
      if (index === 1) return { ...expr, digest: newChild }
      if (index === 2) return { ...expr, keyLength: newChild }
      if (index === 3) return { ...expr, valueLength: newChild }
      throw new Error(`replaceChild: CreateAvlTree has 4 children`)

    case 'CreateProveDhTuple':
      if (index === 0) return { ...expr, g: newChild }
      if (index === 1) return { ...expr, h: newChild }
      if (index === 2) return { ...expr, u: newChild }
      if (index === 3) return { ...expr, v: newChild }
      throw new Error(`replaceChild: CreateProveDhTuple has 4 children`)

    case 'Fold':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, zero: newChild }
      if (index === 2) return { ...expr, foldOp: newChild }
      throw new Error(`replaceChild: Fold has 3 children`)

    case 'Map':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, mapper: newChild }
      throw new Error(`replaceChild: Map has 2 children`)

    case 'Filter':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, condition: newChild }
      throw new Error(`replaceChild: Filter has 2 children`)

    case 'Exists':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, condition: newChild }
      throw new Error(`replaceChild: Exists has 2 children`)

    case 'ForAll':
      if (index === 0) return { ...expr, input: newChild }
      if (index === 1) return { ...expr, condition: newChild }
      throw new Error(`replaceChild: ForAll has 2 children`)

    case 'FuncValue':
      if (index !== 0) throw new Error(`replaceChild: FuncValue only has child 0 (body)`)
      return { ...expr, body: newChild }

    case 'Apply': {
      if (index === 0) return { ...expr, func: newChild }
      const newArgs: Expr[] = [...expr.args]
      newArgs[index - 1] = newChild
      return { ...expr, args: newArgs }
    }

    case 'MethodCall': {
      if (index === 0) return { ...expr, obj: newChild }
      const newArgs: Expr[] = [...expr.args]
      newArgs[index - 1] = newChild
      return { ...expr, args: newArgs }
    }

    case 'PropertyCall':
      if (index !== 0) throw new Error(`replaceChild: PropertyCall only has child 0 (obj)`)
      return { ...expr, obj: newChild }

    case 'BlockValue': {
      const allChildren: Expr[] = [...expr.items, expr.result]
      allChildren[index] = newChild
      const last = allChildren[allChildren.length - 1]
      if (last === undefined) throw new Error('replaceChild: BlockValue allChildren is empty')
      return {
        ...expr,
        items: allChildren.slice(0, allChildren.length - 1),
        result: last,
      }
    }

    case 'ValDef':
      if (index !== 0) throw new Error(`replaceChild: ValDef only has child 0 (rhs)`)
      return { ...expr, rhs: newChild }

    case 'Tuple': {
      const newItems: Expr[] = [...expr.items]
      newItems[index] = newChild
      return { ...expr, items: newItems }
    }

    case 'Collection': {
      if (expr.kind !== 'Exprs') {
        throw new Error(`replaceChild: Collection(BoolConstants) has no Expr children`)
      }
      const newItems: Expr[] = [...expr.items]
      newItems[index] = newChild
      return { ...expr, items: newItems }
    }

    case 'SigmaAnd':
    case 'SigmaOr': {
      const newItems: Expr[] = [...expr.items]
      newItems[index] = newChild
      return { ...expr, items: newItems }
    }

    case 'DeserializeRegister':
      if (index !== 0) throw new Error(`replaceChild: DeserializeRegister only has child 0 (default)`)
      return { ...expr, default: newChild }

    default: {
      const _exhaust: never = expr
      throw new Error(`replaceChild: unhandled tag '${(_exhaust as { tag: string }).tag}'`)
    }
  }
}

// ---------------------------------------------------------------------------
// O1 — replaceLeafConst: mutate Const value via fixed substitution table
// ---------------------------------------------------------------------------

/** Returns a different SValue of the same type family, or null if not supported. */
function mutateConstValue(value: SValue): SValue | null {
  switch (value.kind) {
    case 'Boolean':
      return { kind: 'Boolean', value: !value.value }
    case 'Byte':
      return { kind: 'Byte', value: value.value === 0 ? 1 : 0 }
    case 'Short':
      return { kind: 'Short', value: value.value + 1 }
    case 'Int':
      return { kind: 'Int', value: value.value + 1 }
    case 'Long':
      return { kind: 'Long', value: value.value + 1n }
    case 'BigInt':
      return { kind: 'BigInt', value: value.value + 1n }
    default:
      // GroupElement, SigmaProp, Box, AvlTree, Unit, Coll, Tuple, Option, Lambda
      // — not mutated (complex byte arrays or structural values)
      return null
  }
}

export const replaceLeafConst: MutationOperator = {
  name: 'replaceLeafConst',
  apply(expr: Expr): Expr[] {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      if (node.tag !== 'Const') return
      const mutated = mutateConstValue(node.value)
      if (mutated === null) return
      const newConst: Const = { tag: 'Const', tpe: node.tpe, value: mutated }
      variants.push(replaceAtPath(expr, path, newConst))
    })
    return variants
  },
}

// ---------------------------------------------------------------------------
// O2 — swapBinaryChildren: swap children of BinOp, Tuple(2), Append
// ---------------------------------------------------------------------------

export const swapBinaryChildren: MutationOperator = {
  name: 'swapBinaryChildren',
  apply(expr: Expr): Expr[] {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      let swapped: Expr | null = null
      if (node.tag === 'BinOp') {
        swapped = { ...node, left: node.right, right: node.left }
      } else if (node.tag === 'Append') {
        swapped = { ...node, input: node.col2, col2: node.input }
      } else if (node.tag === 'Tuple' && node.items.length === 2) {
        swapped = { ...node, items: [node.items[1]!, node.items[0]!] }
      }
      if (swapped !== null) {
        variants.push(replaceAtPath(expr, path, swapped))
      }
    })
    return variants
  },
}

// ---------------------------------------------------------------------------
// O3 — mutateCollItem: mutate each item of a Collection(Exprs) via O1
// ---------------------------------------------------------------------------

export const mutateCollItem: MutationOperator = {
  name: 'mutateCollItem',
  apply(expr: Expr): Expr[] {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      if (node.tag !== 'Collection' || node.kind !== 'Exprs') return
      for (let i = 0; i < node.items.length; i++) {
        const item = node.items[i]!  // non-null: i < items.length
        // Apply O1 to the item (in isolation to get its mutated forms)
        const itemVariants = replaceLeafConst.apply(item)
        for (const mutatedItem of itemVariants) {
          const newItems = [...node.items]
          newItems[i] = mutatedItem
          const newColl: Collection = { ...node, items: newItems }
          variants.push(replaceAtPath(expr, path, newColl))
        }
      }
    })
    return variants
  },
}

// ---------------------------------------------------------------------------
// O4 — replaceLambdaBodyConst: apply O1 to constants inside FuncValue body
// ---------------------------------------------------------------------------

export const replaceLambdaBodyConst: MutationOperator = {
  name: 'replaceLambdaBodyConst',
  apply(expr: Expr): Expr[] {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      if (node.tag !== 'FuncValue') return
      // Apply O1 to constants inside the body, producing body variants
      const bodyVariants = replaceLeafConst.apply(node.body)
      for (const mutatedBody of bodyVariants) {
        const newFunc: FuncValue = { ...node, body: mutatedBody }
        variants.push(replaceAtPath(expr, path, newFunc))
      }
    })
    return variants
  },
}

// ---------------------------------------------------------------------------
// O5 — negateBooleanCond: wrap a FuncValue body in LogicalNot if Boolean result
// ---------------------------------------------------------------------------

/** Heuristic: the body is Boolean if it's a BinOp with Relation op, a LogicalNot, a Const(Boolean), or tag indicates boolean. */
function bodyLooksBoolean(body: Expr): boolean {
  if (body.tag === 'Const' && body.value.kind === 'Boolean') return true
  if (body.tag === 'BinOp' && body.op.kind === 'Relation') return true
  if (body.tag === 'BinOp' && body.op.kind === 'Logical') return true
  if (body.tag === 'LogicalNot') return true
  if (body.tag === 'ValUse') return true  // conservative — ValUse may be any type; include it
  return false
}

export const negateBooleanCond: MutationOperator = {
  name: 'negateBooleanCond',
  apply(expr: Expr): Expr[] {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      if (node.tag !== 'FuncValue') return
      if (!bodyLooksBoolean(node.body)) return
      const wrappedBody: LogicalNot = { tag: 'LogicalNot', input: node.body }
      const newFunc: FuncValue = { ...node, body: wrappedBody }
      variants.push(replaceAtPath(expr, path, newFunc))
    })
    return variants
  },
}

// ---------------------------------------------------------------------------
// O6 — mutateByIndexIndex: swap ByIndex.index to 0 or 1
// ---------------------------------------------------------------------------

export const mutateByIndexIndex: MutationOperator = {
  name: 'mutateByIndexIndex',
  apply(expr: Expr): Expr[] {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      if (node.tag !== 'ByIndex') return
      const currentIdx = node.index
      // Only mutate if the current index is a Const(SInt)
      if (currentIdx.tag !== 'Const') return
      if (currentIdx.value.kind !== 'Int') return
      const currentVal = currentIdx.value.value
      const newVal = currentVal === 0 ? 1 : 0
      const newIndexConst: Const = {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: newVal },
      }
      const newByIndex: ByIndex = { ...node, index: newIndexConst }
      variants.push(replaceAtPath(expr, path, newByIndex))
    })
    return variants
  },
}

// ---------------------------------------------------------------------------
// O7 — mutateFoldZero: apply O1 to the zero child of a Fold node
// ---------------------------------------------------------------------------

export const mutateFoldZero: MutationOperator = {
  name: 'mutateFoldZero',
  apply(expr: Expr): Expr[] {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      if (node.tag !== 'Fold') return
      const zeroVariants = replaceLeafConst.apply(node.zero)
      for (const mutatedZero of zeroVariants) {
        const newFold: Fold = { ...node, zero: mutatedZero }
        variants.push(replaceAtPath(expr, path, newFold))
      }
    })
    return variants
  },
}

// ---------------------------------------------------------------------------
// ALL_OPERATORS registry
// ---------------------------------------------------------------------------

export const ALL_OPERATORS: MutationOperator[] = [
  replaceLeafConst,
  swapBinaryChildren,
  mutateCollItem,
  replaceLambdaBodyConst,
  negateBooleanCond,
  mutateByIndexIndex,
  mutateFoldZero,
]
