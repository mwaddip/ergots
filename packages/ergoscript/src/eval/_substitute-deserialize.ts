/**
 * The rewrites a tree goes through before it is evaluated, as the JVM makes them (sigma-state 6.0.6; spec
 * docs/specs/2026-09-30-jvm-node-construction-design.md §5; facts/ergoscript-eval.md, "The Deserialize substitution"):
 *  - {@link substituteConstants}: each `ConstantPlaceholder` becomes its constant, as `ErgoTree.substConstants` does
 *    for a segregated tree (ErgoTree.scala:314-322). `evaluate.ts:dispatchTreeBody` runs it before the Deserialize
 *    rewrite, so the substituted body charges `Const = Fixed(5)` per former placeholder rather than the lazy
 *    `ConstPlaceholder = Fixed(1)` (the h=3850 cost drift of
 *    `tools/mainnet-validate/findings/2026-05-23-2j-a-validation-smoke.md`);
 *  - {@link substituteDeserialize}: each `DeserializeContext` and `DeserializeRegister` becomes its decoded script, its
 *    default, or stays (`Interpreter.scala:110-157`, `ErgoLikeInterpreter.scala:17-37`).
 *
 * Both are Kiama's `everywherebu` (core/.../sigma/kiama/rewriting/Rewriter.scala:805-842): a node's children are
 * rewritten first, left to right; a node whose children all come back as the same objects is kept as it is, and one
 * with a changed child is rebuilt (`allProduct`, :446-471; `dup`, :236-320); then the node itself is rewritten. A
 * substituted script is not traversed again. The rewrites charge no cost: the JVM's decode and tree-bytes charges are
 * a follow-up. {@link treeHasDeserialize} and {@link childrenOf} walk a tree without rewriting it.
 */

import type {
  ByIndex,
  DeserializeContext,
  DeserializeRegister,
  Expr,
  MethodCall,
  ParsedErgoTree,
  PropertyCall,
  SType,
  SValue,
} from '../mir/types'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { ByteReader } from '@ergots/scorex'
import { parseExpr } from '../wire/parse'
import { checkBuild } from '../wire/check-build'
import { isJvmClassCast } from '../wire/jvm-exceptions'
import { exprTpe, recordCallType, recordIndexUpcast, recordedCallType, recordedIndexUpcast } from '../mir/expr-tpe'
import { scriptTypeEquals } from '../mir/jvm-types'
import { sTypeEquals } from '../mir/stype-helpers'
import { collByteToUint8Array } from './_byte-coll'
import { getRegisterEntry } from './extract-register-as'

// ---------------------------------------------------------------------------
// treeHasDeserialize — O(n) early-return scan.
//
// Mirrors sigma-rust `Expr::has_deserialize` (ergotree-ir/src/mir/expr.rs:
// 431-438). Returns true iff `tree.body` (or any sub-expression of
// `tree.body`) contains a `DeserializeContext` or `DeserializeRegister`
// node.
// ---------------------------------------------------------------------------

export function treeHasDeserialize(tree: ParsedErgoTree): boolean {
  return hasDeserializeWalk(tree.body)
}

/**
 * Recursive early-return walker over an Expr. Returns true on first
 * Deserialize* node encountered; otherwise false.
 *
 * Children list per variant mirrors `Traversable for Expr`
 * (`mir/expr.rs:531-605`) and the per-variant `impl_traversable_expr!`
 * macro invocations across `mir/<variant>.rs`.
 */
function hasDeserializeWalk(e: Expr): boolean {
  if (e.tag === 'DeserializeContext' || e.tag === 'DeserializeRegister') {
    return true
  }
  for (const child of childrenOf(e)) {
    if (hasDeserializeWalk(child)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// substituteDeserialize — the JVM's applyDeserializeContextJITC.
// ---------------------------------------------------------------------------

/**
 * `body` with its Deserialize nodes substituted, as the JVM's `applyDeserializeContextJITC` does before it evaluates
 * (`Interpreter.scala:149-157`): `everywherebu(strategy { case x: SValue => substDeserialize(...) })`. The version is
 * the evaluation's one version, the spent tree's (`withVersions(activated, ergoTree.version)`, `:203-238`), so a
 * script decodes at the spent tree's version. Does not mutate `body`.
 */
export function substituteDeserialize(body: Expr, tree: ParsedErgoTree, ctx: EvalContext): Expr {
  return rewriteBottomUp(body, ctx, ctx.treeVersion ?? tree.header.version)
}

/**
 * Kiama's `bottomup(attempt(s))`: the children first, then the node. A node rebuilt because a child changed passes
 * the constructor's checks, as `dup` runs them; then a Deserialize node is substituted.
 */
function rewriteBottomUp(e: Expr, ctx: EvalContext, v: number): Expr {
  const node = mapChildren(e, (child) => rewriteBottomUp(child, ctx, v), v)
  if (node !== e) checkRebuild(node, v)
  if (node.tag === 'DeserializeContext') return substituteDeserializeContext(node, ctx, v)
  if (node.tag === 'DeserializeRegister') return substituteDeserializeRegister(node, ctx, v)
  return node
}

/**
 * Kiama's `dup` rebuilds a changed node through its first constructor, by reflection (Rewriter.scala:236-320), outside
 * the strategy's catch: any throw rejects, a `ClassCastException` included. So `checkBuild`'s `'rebuild'` site, the
 * constructor's checks; the builder's `check2` does not run on a rebuild.
 */
function checkRebuild(node: Expr, v: number): void {
  try {
    checkBuild(node, 'rebuild', v)
  } catch (cause) {
    throw new EvalError(
      `${node.tag}: rebuilt around a substituted node, it fails its constructor's check — ${messageOf(cause)}`,
      'deserialize-rebuild-failed',
      { cause }
    )
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isCollByte(t: SType): boolean {
  return t.tag === 'SColl' && t.elem.tag === 'SByte'
}

/**
 * Decode a script and read its type, as `substDeserialize` does inside Kiama's `strategy`, whose
 * `catch { case _: ClassCastException => None }` covers both (Rewriter.scala:180-191): a class cast from either leaves
 * the node, `undefined` here. Any other failure rejects. The decode is `ValueSerializer.deserialize` on a fresh reader,
 * with no constant store and trailing bytes ignored (`deserializeMeasured`, Interpreter.scala:99-107). A soft failure
 * inside the script is no class cast, so it rejects too, as the JVM rethrows it (spec §4a).
 */
function decodeScript(bytes: Uint8Array, node: string, v: number): { script: Expr; tpe: SType } | undefined {
  let script: Expr
  try {
    script = parseExpr(new ByteReader(bytes), [], [], new Map(), v)
  } catch (err) {
    if (isJvmClassCast(err)) return undefined
    throw new EvalError(`${node}: inner Expr parse failed — ${messageOf(err)}`, 'deserialize-parse-failed', {
      cause: err,
    })
  }
  let tpe: SType
  try {
    tpe = exprTpe(script, v)
  } catch (err) {
    if (isJvmClassCast(err)) return undefined
    throw new EvalError(`${node}: reading the decoded script's type failed — ${messageOf(err)}`, 'deserialize-parse-failed', {
      cause: err,
    })
  }
  return { script, tpe }
}

/**
 * `DeserializeContext` (Interpreter.scala:110-129). An absent variable, or one whose type is not `Coll[Byte]`, gives
 * `None`, so the node stays: it throws `'deserialize-not-substituted'` only if it is evaluated, and a dead branch
 * accepts. A decoded script replaces the node when its type is the declared one by the JVM's `!=`
 * (`CheckDeserializedScriptType`, rule 1000, ValidationRules.scala:24-37), under which `NoType != SAny`.
 */
function substituteDeserializeContext(e: DeserializeContext, ctx: EvalContext, v: number): Expr {
  if (ctx.extension === undefined) {
    throw new EvalError('DeserializeContext: ctx.extension undefined', 'context-field-missing')
  }
  const entry = ctx.extension.values.get(e.id)
  if (entry === undefined || !isCollByte(entry.tpe)) return e
  const bytes = collByteToUint8Array(entry.value, 'DeserializeContext', 'deserialize-input-not-byte-array')
  const decoded = decodeScript(bytes, 'DeserializeContext', v)
  if (decoded === undefined) return e
  if (!scriptTypeEquals(decoded.tpe, e.tpe)) {
    throw new EvalError(
      `DeserializeContext: inner Expr tpe mismatch (expected ${e.tpe.tag}, got ${decoded.tpe.tag})`,
      'deserialize-tpe-mismatch'
    )
  }
  return decoded.script
}

/**
 * `DeserializeRegister` (ErgoLikeInterpreter.scala:17-37). SELF's register is read with `ErgoBox.get`
 * (ErgoBox.scala:75-82), which gives R0 to R3 always: R1 is SELF's tree bytes as received, so a
 * `DeserializeRegister(R1)` decodes SELF's own tree (`getRegisterEntry`).
 * - A present register matches `case eba: EvaluatedValue[SByteArray]@unchecked` whatever its type, and
 *   `eba.value.toArray` throws a `ClassCastException` unless it is a `Coll[Byte]`: swallowed, so the node stays, and
 *   `.orElse(d.default)` is not reached.
 * - A `Coll[Byte]` register decodes as a context variable does; `outVal.tpe != d.tpe` is a `sys.error`.
 * - An absent register gives the default, if any ({@link substituteDefault}); with none, the node stays.
 */
function substituteDeserializeRegister(e: DeserializeRegister, ctx: EvalContext, v: number): Expr {
  if (ctx.selfBox === undefined) {
    throw new EvalError('DeserializeRegister: ctx.selfBox undefined', 'context-field-missing')
  }
  const entry = getRegisterEntry(ctx.selfBox, e.reg)
  if (entry !== undefined) {
    if (!isCollByte(entry.tpe)) return e
    const bytes = collByteToUint8Array(entry.value, 'DeserializeRegister', 'deserialize-input-not-byte-array')
    const decoded = decodeScript(bytes, 'DeserializeRegister', v)
    if (decoded === undefined) return e
    if (!scriptTypeEquals(decoded.tpe, e.tpe)) {
      throw new EvalError(
        `DeserializeRegister: inner Expr tpe mismatch (expected ${e.tpe.tag}, got ${decoded.tpe.tag})`,
        'deserialize-tpe-mismatch'
      )
    }
    return decoded.script
  }
  if (e.default === null) return e
  return substituteDefault(e.default, e.tpe, v)
}

/**
 * An absent register's default. The JVM substitutes it untyped (`.orElse(d.default)`). ergots keeps `master`'s
 * structural type check of it (spec Decision 8; residual 7 of facts/ergoscript-eval.md), except where reading its type
 * is a class cast: then the default is substituted untyped, as the JVM substitutes every default (Decision 5). Any
 * other failure of that read propagates.
 */
function substituteDefault(defaultExpr: Expr, declared: SType, v: number): Expr {
  let t: SType
  try {
    t = exprTpe(defaultExpr, v)
  } catch (err) {
    if (isJvmClassCast(err)) return defaultExpr
    throw err
  }
  if (!sTypeEquals(t, declared)) {
    throw new EvalError(
      `DeserializeRegister: default Expr tpe mismatch (expected ${declared.tag}, got ${t.tag})`,
      'deserialize-tpe-mismatch'
    )
  }
  return defaultExpr
}

// ---------------------------------------------------------------------------
// substituteConstants — the placeholders of a segregated tree.
// ---------------------------------------------------------------------------

/**
 * `body` with each `ConstantPlaceholder` replaced by `Const(constantTypes[id], constants[id])`, as the JVM's
 * `ErgoTree.substConstants` does (`everywherebu`, ErgoTree.scala:314-322). Its rebuilds run no construction check:
 * they are verdict-neutral, since a placeholder's type is its constant's. A rebuilt call keeps its recorded type
 * (`mapChildren`). A placeholder id out of range throws `'const-placeholder-id-out-of-range'`, the eval-time arm's code
 * (`eval/const-placeholder.ts`). `v` is the tree version.
 */
export function substituteConstants(body: Expr, constants: SValue[], constantTypes: SType[], v: number): Expr {
  return rewriteConstantsBottomUp(body, constants, constantTypes, v)
}

function rewriteConstantsBottomUp(e: Expr, constants: SValue[], constantTypes: SType[], v: number): Expr {
  const node = mapChildren(e, (child) => rewriteConstantsBottomUp(child, constants, constantTypes, v), v)
  if (node.tag === 'ConstPlaceholder') {
    const id = node.id
    if (id >= constants.length) {
      throw new EvalError(
        `ConstPlaceholder(${id}): id out of range (constants.length=${constants.length})`,
        'const-placeholder-id-out-of-range'
      )
    }
    return { tag: 'Const', tpe: constantTypes[id]!, value: constants[id]! }
  }
  return node
}

// ---------------------------------------------------------------------------
// mapChildren — Kiama's allProduct over one node.
// ---------------------------------------------------------------------------

/** `fn` over `xs` in order; `xs` itself when every item comes back as the same object. */
function mapItems(xs: Expr[], fn: (child: Expr) => Expr): Expr[] {
  let out: Expr[] | undefined
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!
    const y = fn(x)
    if (out === undefined && y !== x) out = xs.slice(0, i)
    if (out !== undefined) out.push(y)
  }
  return out ?? xs
}

/**
 * A rebuilt `MethodCall` or `PropertyCall` keeps the type its predecessor was built with. The JVM's `MethodCall.tpe`
 * is a `val` over the `SMethod` specialized at parse (values.scala:1355), and `dup` passes that same `SMethod` to the
 * rebuilt node, so no rewrite changes a call's type. A parsed call has a record (`checkBuild`); one built through the
 * API has none, and its type is read from its children as they were.
 */
function keepCallType<C extends MethodCall | PropertyCall>(before: C, rebuilt: C, v: number): C {
  recordCallType(rebuilt, recordedCallType(before) ?? exprTpe(before, v))
  return rebuilt
}

/**
 * A rebuilt `ByIndex` keeps the decision its predecessor was parsed with. Before v3 the JVM's parse put an actual
 * `Upcast` over an index that is not an Int (ByIndexSerializer.scala:29-33), and `dup` keeps that node while it rebuilds
 * the ByIndex around a rewritten index (Rewriter.scala:236-320), so no rewrite changes whether the Upcast is there,
 * whatever type the node that replaced the index has. A parsed node has a record (`parseCollByIndex`); one built through
 * the API, or parsed from v3, has none, and neither does its rebuild.
 */
function keepIndexUpcast(before: ByIndex, rebuilt: ByIndex): ByIndex {
  const decision = recordedIndexUpcast(before)
  if (decision !== undefined) recordIndexUpcast(rebuilt, decision)
  return rebuilt
}

/**
 * `e` with each Expr child replaced by `fn(child)`, visited in the order of the JVM node's constructor fields, as
 * Kiama's `allProduct` visits them (Rewriter.scala:446-471). When every child comes back as the same object, `e`
 * itself (review m7); otherwise a copy of `e` with the new children, every other field kept (a `ValDef`'s `tpeArgs`
 * included). A new call keeps its recorded type ({@link keepCallType}), and a new `ByIndex` its recorded decision
 * ({@link keepIndexUpcast}).
 *
 * The switch is exhaustive over the Expr union: a new variant is a compile-time error at the `default` arm.
 */
function mapChildren(e: Expr, fn: (child: Expr) => Expr, v: number): Expr {
  switch (e.tag) {
    // No Expr children.
    case 'Const':
    case 'ConstPlaceholder':
    case 'Context':
    case 'Global':
    case 'GlobalVars':
    case 'LastBlockUtxoRootHash':
    case 'ValUse':
    case 'GetVar':
    case 'DeserializeContext':
      return e

    // One `input` child.
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
    case 'ExtractRegisterAs':
    case 'SizeOf':
    case 'BoolToSigmaProp':
    case 'CreateProveDlog':
    case 'SigmaPropBytes':
    case 'SigmaPropIsProven':
    case 'DecodePoint':
    case 'CalcBlake2b256':
    case 'CalcSha256':
    case 'LongToByteArray':
    case 'ByteArrayToLong':
    case 'ByteArrayToBigInt':
    case 'XorOf':
    case 'SelectField':
    case 'Upcast':
    case 'Downcast':
    case 'ZkProofBlock': {
      const input = fn(e.input)
      return input === e.input ? e : { ...e, input }
    }

    // Two children.
    case 'BinOp':
    case 'Xor':
    case 'MultiplyGroup':
    case 'Exponentiate': {
      const left = fn(e.left)
      const right = fn(e.right)
      return left === e.left && right === e.right ? e : { ...e, left, right }
    }
    case 'Append': {
      const input = fn(e.input)
      const col2 = fn(e.col2)
      return input === e.input && col2 === e.col2 ? e : { ...e, input, col2 }
    }
    case 'Atleast': {
      const bound = fn(e.bound)
      const input = fn(e.input)
      return bound === e.bound && input === e.input ? e : { ...e, bound, input }
    }
    case 'OptionGetOrElse': {
      const input = fn(e.input)
      const def = fn(e.default)
      return input === e.input && def === e.default ? e : { ...e, input, default: def }
    }
    case 'Map': {
      const input = fn(e.input)
      const mapper = fn(e.mapper)
      return input === e.input && mapper === e.mapper ? e : { ...e, input, mapper }
    }
    case 'Filter':
    case 'Exists':
    case 'ForAll': {
      const input = fn(e.input)
      const condition = fn(e.condition)
      return input === e.input && condition === e.condition ? e : { ...e, input, condition }
    }

    // Three children.
    case 'If': {
      const condition = fn(e.condition)
      const trueBranch = fn(e.trueBranch)
      const falseBranch = fn(e.falseBranch)
      return condition === e.condition && trueBranch === e.trueBranch && falseBranch === e.falseBranch
        ? e
        : { ...e, condition, trueBranch, falseBranch }
    }
    case 'Slice': {
      const input = fn(e.input)
      const from = fn(e.from)
      const until = fn(e.until)
      return input === e.input && from === e.from && until === e.until ? e : { ...e, input, from, until }
    }
    case 'Fold': {
      const input = fn(e.input)
      const zero = fn(e.zero)
      const foldOp = fn(e.foldOp)
      return input === e.input && zero === e.zero && foldOp === e.foldOp ? e : { ...e, input, zero, foldOp }
    }
    case 'TreeLookup': {
      const tree = fn(e.tree)
      const key = fn(e.key)
      const proof = fn(e.proof)
      return tree === e.tree && key === e.key && proof === e.proof ? e : { ...e, tree, key, proof }
    }
    case 'SubstConstants': {
      const scriptBytes = fn(e.scriptBytes)
      const positions = fn(e.positions)
      const newValues = fn(e.newValues)
      return scriptBytes === e.scriptBytes && positions === e.positions && newValues === e.newValues
        ? e
        : { ...e, scriptBytes, positions, newValues }
    }

    // Four children.
    case 'CreateProveDhTuple': {
      const g = fn(e.g)
      const h = fn(e.h)
      const u = fn(e.u)
      const w = fn(e.v)
      return g === e.g && h === e.h && u === e.u && w === e.v ? e : { ...e, g, h, u, v: w }
    }
    case 'CreateAvlTree': {
      const flags = fn(e.flags)
      const digest = fn(e.digest)
      const keyLength = fn(e.keyLength)
      const valueLength = fn(e.valueLength)
      return flags === e.flags && digest === e.digest && keyLength === e.keyLength && valueLength === e.valueLength
        ? e
        : { ...e, flags, digest, keyLength, valueLength }
    }

    // A list of children.
    case 'Collection': {
      if (e.kind === 'BoolConstants') return e
      const items = mapItems(e.items, fn)
      return items === e.items ? e : { ...e, items }
    }
    case 'Tuple':
    case 'SigmaAnd':
    case 'SigmaOr': {
      const items = mapItems(e.items, fn)
      return items === e.items ? e : { ...e, items }
    }

    // The rest.
    case 'FuncValue': {
      const body = fn(e.body)
      return body === e.body ? e : { ...e, body }
    }
    case 'Apply': {
      const func = fn(e.func)
      const args = mapItems(e.args, fn)
      return func === e.func && args === e.args ? e : { ...e, func, args }
    }
    case 'MethodCall': {
      const obj = fn(e.obj)
      const args = mapItems(e.args, fn)
      return obj === e.obj && args === e.args ? e : keepCallType(e, { ...e, obj, args }, v)
    }
    case 'PropertyCall': {
      const obj = fn(e.obj)
      return obj === e.obj ? e : keepCallType(e, { ...e, obj }, v)
    }
    case 'BlockValue': {
      const items = mapItems(e.items, fn)
      const result = fn(e.result)
      return items === e.items && result === e.result ? e : { ...e, items, result }
    }
    case 'ValDef': {
      const rhs = fn(e.rhs)
      return rhs === e.rhs ? e : { ...e, rhs }
    }
    case 'ByIndex': {
      const input = fn(e.input)
      const index = fn(e.index)
      const def = e.default === null ? null : fn(e.default)
      return input === e.input && index === e.index && def === e.default
        ? e
        : keepIndexUpcast(e, { ...e, input, index, default: def })
    }
    case 'DeserializeRegister': {
      if (e.default === null) return e
      const def = fn(e.default)
      return def === e.default ? e : { ...e, default: def }
    }

    default: {
      const unknownVariant: never = e
      throw new Error(`mapChildren: unhandled Expr variant ${JSON.stringify(unknownVariant)}`)
    }
  }
}

/**
 * Generator over the immediate Expr children of `e`. Mirrors the iterator
 * built by `Traversable::children` (mir/expr.rs:534-605) and the per-variant
 * `iter_from!` macro expansion.
 *
 * Used by {@link hasDeserializeWalk}; the substitution walker uses {@link mapChildren}
 * which reconstructs the parent.
 */
export function* childrenOf(e: Expr): Generator<Expr, void, void> {
  switch (e.tag) {
    // Zero children.
    case 'Const':
    case 'ConstPlaceholder':
    case 'Context':
    case 'Global':
    case 'GlobalVars':
    case 'LastBlockUtxoRootHash':
    case 'ValUse':
    case 'GetVar':
    case 'DeserializeContext':
      return

    // OneArgOp — single `input`.
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
    case 'BoolToSigmaProp':
    case 'CreateProveDlog':
    case 'SigmaPropBytes':
    case 'SigmaPropIsProven':
    case 'DecodePoint':
    case 'CalcBlake2b256':
    case 'CalcSha256':
    case 'LongToByteArray':
    case 'ByteArrayToLong':
    case 'ByteArrayToBigInt':
    case 'XorOf':
      yield e.input
      return

    case 'Append':
      yield e.input
      yield e.col2
      return
    case 'SubstConstants':
      yield e.scriptBytes
      yield e.positions
      yield e.newValues
      return
    case 'Collection':
      if (e.kind === 'Exprs') {
        for (const it of e.items) yield it
      }
      return
    case 'Tuple':
      for (const it of e.items) yield it
      return
    case 'FuncValue':
      yield e.body
      return
    case 'Apply':
      yield e.func
      for (const a of e.args) yield a
      return
    case 'MethodCall':
      yield e.obj
      for (const a of e.args) yield a
      return
    case 'PropertyCall':
      yield e.obj
      return
    case 'BlockValue':
      for (const it of e.items) yield it
      yield e.result
      return
    case 'ValDef':
      yield e.rhs
      return
    case 'If':
      yield e.condition
      yield e.trueBranch
      yield e.falseBranch
      return
    case 'BinOp':
      yield e.left
      yield e.right
      return
    case 'Xor':
      yield e.left
      yield e.right
      return
    case 'Atleast':
      yield e.bound
      yield e.input
      return
    case 'OptionGetOrElse':
      yield e.input
      yield e.default
      return
    case 'ExtractRegisterAs':
      yield e.input
      return
    case 'ByIndex':
      yield e.input
      yield e.index
      if (e.default !== null) yield e.default
      return
    case 'Slice':
      yield e.input
      yield e.from
      yield e.until
      return
    case 'Fold':
      yield e.input
      yield e.zero
      yield e.foldOp
      return
    case 'Map':
      yield e.input
      yield e.mapper
      return
    case 'Filter':
      yield e.input
      yield e.condition
      return
    case 'Exists':
      yield e.input
      yield e.condition
      return
    case 'ForAll':
      yield e.input
      yield e.condition
      return
    case 'SelectField':
      yield e.input
      return
    case 'Upcast':
      yield e.input
      return
    case 'Downcast':
      yield e.input
      return
    case 'CreateProveDhTuple':
      yield e.g
      yield e.h
      yield e.u
      yield e.v
      return
    case 'ZkProofBlock':
      yield e.input
      return
    case 'SigmaAnd':
      for (const it of e.items) yield it
      return
    case 'SigmaOr':
      for (const it of e.items) yield it
      return
    case 'DeserializeRegister':
      if (e.default !== null) yield e.default
      return
    case 'MultiplyGroup':
      yield e.left
      yield e.right
      return
    case 'Exponentiate':
      yield e.left
      yield e.right
      return
    case 'TreeLookup':
      yield e.tree
      yield e.key
      yield e.proof
      return
    case 'CreateAvlTree':
      yield e.flags
      yield e.digest
      yield e.keyLength
      yield e.valueLength
      return
    default: {
      const _exhaust: never = e
      throw new Error(
        `childrenOf: unhandled Expr variant ${JSON.stringify(_exhaust)}`,
      )
    }
  }
}
