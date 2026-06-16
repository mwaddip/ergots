/**
 * Substitution pre-passes for `ConstantPlaceholder`, `DeserializeContext`,
 * and `DeserializeRegister`.
 *
 * Mirrors sigma-rust:
 *   - `Expr::has_deserialize`        (ergotree-ir/src/mir/expr.rs:431-438)
 *   - `Expr::substitute_deserialize` (ergotree-ir/src/mir/expr.rs:442-496)
 *   - `Expr::substitute_constants`   (ergotree-ir/src/mir/expr.rs:498-514)
 *   - `Expr::rewrite_bu_inner`       (ergotree-ir/src/mir/expr.rs:397-408)
 *   - `Traversable for Expr`         (ergotree-ir/src/mir/expr.rs:531-678)
 *
 * Bottom-up rewrites that locate every target node in the tree and replace
 * it with a substituted Expr. The walks are purely tree transforms: they
 * charge no cost and may not recurse into substituted children.
 *
 * The module exports three functions:
 *  - {@link treeHasDeserialize}    — O(n) early-return scan.
 *  - {@link substituteDeserialize} — bottom-up immutable rewrite of DC/DR.
 *  - {@link substituteConstants}   — bottom-up immutable rewrite of CP→Const,
 *    mirroring `tree.proposition()` (`ergo_tree.rs:248-258` calls
 *    `substitute_constants` when `header.is_constant_segregation()`). Used
 *    by `evaluate.ts:dispatchTreeBody` BEFORE `substituteDeserialize` on the
 *    deserialize path, so the post-substituted body charges
 *    `Const = Fixed(5)` per ex-placeholder (matching sigma-rust
 *    `eval/expr.rs:21-23`) instead of the lazy `ConstPlaceholder = Fixed(1)`
 *    path that ran before phase 2j-b/iter-1. See findings note
 *    `tools/mainnet-validate/findings/2026-05-23-2j-a-validation-smoke.md`
 *    for the h=3850 cost-drift halt that surfaced this 4-per-CP gap.
 */

import type {
  Append,
  Apply,
  Atleast,
  BinOp,
  BlockValue,
  ByIndex,
  Collection,
  CreateAvlTree,
  CreateProveDhTuple,
  DeserializeContext,
  DeserializeRegister,
  ErgoTree,
  Exists,
  Expr,
  Exponentiate,
  Filter,
  Fold,
  ForAll,
  FuncValue,
  If,
  Map,
  MethodCall,
  MultiplyGroup,
  OptionGetOrElse,
  PropertyCall,
  SelectField,
  SigmaAnd,
  SigmaOr,
  Slice,
  SType,
  SubstConstants,
  SValue,
  Tuple,
  TreeLookup,
  Upcast,
  Downcast,
  ValDef,
  Xor,
  ZkProofBlock,
} from '../mir/types'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { ByteReader } from '@ergots/scorex'
import { parseExpr } from '../wire/parse'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEquals } from '../mir/stype-helpers'
import { collByteToUint8Array } from './_byte-coll'

// ---------------------------------------------------------------------------
// treeHasDeserialize — O(n) early-return scan.
//
// Mirrors sigma-rust `Expr::has_deserialize` (ergotree-ir/src/mir/expr.rs:
// 431-438). Returns true iff `tree.body` (or any sub-expression of
// `tree.body`) contains a `DeserializeContext` or `DeserializeRegister`
// node.
// ---------------------------------------------------------------------------

export function treeHasDeserialize(tree: ErgoTree): boolean {
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
// substituteDeserialize — bottom-up immutable rewrite.
//
// Mirrors sigma-rust `Expr::substitute_deserialize`
// (ergotree-ir/src/mir/expr.rs:442-496). Returns a NEW Expr with every
// Deserialize* node rewritten in place; does NOT mutate inputs. Does NOT
// re-walk the substituted children (matches `try_rewrite_bu` at
// `mir/expr.rs:397-408`).
// ---------------------------------------------------------------------------

export function substituteDeserialize(
  body: Expr,
  tree: ErgoTree,
  ctx: EvalContext,
): Expr {
  return rewriteBottomUp(body, tree, ctx)
}

/**
 * Bottom-up recursive rewrite. Children are rewritten BEFORE the parent is
 * considered for substitution — matching `rewrite_bu_inner`
 * (`mir/expr.rs:397-408`) which calls `children_mut().try_for_each(recurse)`
 * before applying `subst` to the current node.
 *
 * After rewriting children, if the current node is `DeserializeContext` or
 * `DeserializeRegister`, dispatch to the substitution helper. The result of
 * that helper is NOT recursively re-walked (substituted children survive
 * intact).
 */
function rewriteBottomUp(e: Expr, tree: ErgoTree, ctx: EvalContext): Expr {
  // 1. Recurse into children first (bottom-up).
  const eWithRewrittenChildren = mapChildren(e, (child) =>
    rewriteBottomUp(child, tree, ctx),
  )

  // 2. Apply substitution at this node (only if Deserialize*).
  if (eWithRewrittenChildren.tag === 'DeserializeContext') {
    return substituteDeserializeContext(eWithRewrittenChildren, tree, ctx)
  }
  if (eWithRewrittenChildren.tag === 'DeserializeRegister') {
    return substituteDeserializeRegister(eWithRewrittenChildren, tree, ctx)
  }
  return eWithRewrittenChildren
}

/**
 * Substitute a single `DeserializeContext` node by reading
 * `ctx.extension.values[e.id]`, decoding the bytes as an inner Expr, and
 * type-checking the parsed result against the declared `e.tpe`.
 *
 * Failure-tolerant substitution (mirrors the DR arm below): if the context var
 * is ABSENT, or PRESENT but not a `Coll[Byte]`, LEAVE the node unchanged rather
 * than throwing. The JVM `Interpreter.substDeserialize` returns `None` in both
 * cases — `else None` for absent (Interpreter.scala:124-125), inner
 * `case _ => None` for wrong-typed (:121-122) — and `everywherebu` leaves a
 * `None` node in place. A leftover node errors ONLY if the live reduction path
 * evaluates it (eval-time 'deserialize-not-substituted'); a DEAD branch is
 * harmless. This is how the JVM accepts the h=111927 testnet tx that wedged the
 * Rust node under the old eager-throw model. Only a present-AND-`Coll[Byte]`
 * var proceeds to the per-byte cost + parse + tpe check below.
 *
 * Mirrors sigma-rust eni `mir/expr.rs:442-465, 486-491` (DC branch: absent
 * `None => return Ok(())` :453, wrong-typed `Err(_) => return Ok(())` :462,
 * then parse + tpe check).
 */
function substituteDeserializeContext(
  e: DeserializeContext,
  tree: ErgoTree,
  ctx: EvalContext,
): Expr {
  if (ctx.extension === undefined) {
    throw new EvalError(
      'DeserializeContext: ctx.extension undefined',
      'context-field-missing',
    )
  }
  const entry = ctx.extension.values.get(e.id)
  if (entry === undefined) {
    // Absent var: LEAVE the node unchanged. The JVM `substDeserialize` returns
    // None via the `else None` (Interpreter.scala:124-125) — `everywherebu`
    // leaves a None node in place, so the node errors only IF EVALUATED, via
    // the eval-time 'deserialize-not-substituted' throw; a dead branch never
    // errors. sigma-rust eni matches (`None => return Ok(())`, expr.rs:453).
    // The old eager throw here was the h=111927 testnet wedge shape. Blessed:
    // DeserializeContext_over_absent_wrong_typed_var #0 (dead, true@20) /
    // #2 (live, errored).
    return e
  }
  if (entry.tpe.tag !== 'SColl' || entry.tpe.elem.tag !== 'SByte') {
    // Wrong-typed var: same leave-unchanged contract. JVM inner `case _ => None`
    // (Interpreter.scala:121-122); sigma-rust eni `Err(_) => return Ok(())`
    // (expr.rs:462). Blessed: entries #1 (dead, true@20) / #3 (live, errored).
    return e
  }
  const bytes = collByteToUint8Array(
    entry.value,
    'DeserializeContext',
    'deserialize-input-not-byte-array',
  )
  const reader = new ByteReader(bytes)
  let parsed: Expr
  try {
    parsed = parseExpr(
      reader,
      [],
      [],
      new Map(),
      ctx.treeVersion ?? tree.header.version,
    )
  } catch (err) {
    throw new EvalError(
      `DeserializeContext: inner Expr parse failed — ${(err as Error).message}`,
      'deserialize-parse-failed',
    )
  }
  const parsedTpe = exprTpe(parsed)
  if (!sTypeEquals(parsedTpe, e.tpe)) {
    throw new EvalError(
      `DeserializeContext: inner Expr tpe mismatch (expected ${e.tpe.tag}, got ${parsedTpe.tag})`,
      'deserialize-tpe-mismatch',
    )
  }
  return parsed
}

/**
 * Substitute a single `DeserializeRegister` node by reading
 * `ctx.selfBox.registers[e.reg]`, decoding the bytes as an inner Expr, and
 * type-checking the parsed result against `e.tpe`. If the register is
 * absent and `e.default` is non-null, type-check + return `e.default`. If
 * both are absent, LEAVE the node unchanged (the eval-time defensive
 * throw catches it).
 *
 * Mirrors sigma-rust `mir/expr.rs:466-482, 486-491` (DR branch + tpe
 * check). The "leave unchanged" branch mirrors the `None => return Ok(())`
 * at `expr.rs:480`.
 */
function substituteDeserializeRegister(
  e: DeserializeRegister,
  tree: ErgoTree,
  ctx: EvalContext,
): Expr {
  if (ctx.selfBox === undefined) {
    throw new EvalError(
      'DeserializeRegister: ctx.selfBox undefined',
      'context-field-missing',
    )
  }
  const entry = ctx.selfBox.registers[e.reg]
  if (entry !== undefined) {
    // Wrong-typed register: EAGER throw is correct here — DR semantics DIFFER
    // from the DC arm above (which leaves the node). F1 verified that BOTH
    // references error eagerly at substitution for a present-but-not-Coll[Byte]
    // register:
    //   - JVM ErgoLikeInterpreter.substDeserialize matches with
    //     `case eba: EvaluatedValue[SByteArray]@unchecked` (type param erased —
    //     `@unchecked` precisely because it matches ANY register), then
    //     `eba.value.toArray` throws ClassCastException for a non-Coll value
    //     (ErgoLikeInterpreter.scala:21-22; its `case _ => None` is documented
    //     as never-reached, :29-36).
    //   - sigma-rust eni: `constant.try_extract_into::<Vec<u8>>()?` (expr.rs:482)
    //     propagates SubstDeserializeError via `.transpose()?` (:492).
    // The JVM throws inside the WHOLE-TREE everywherebu pass, so even a DEAD-
    // branch DR with a wrong-typed register is rejected — `return e` here would
    // FORK (ergots would accept a dead branch the JVM rejects). No blessed
    // vector covers this shape; the eager throw is the confirmed-faithful path.
    if (entry.tpe.tag !== 'SColl' || entry.tpe.elem.tag !== 'SByte') {
      throw new EvalError(
        `DeserializeRegister: selfBox.registers[${e.reg}].tpe must be Coll[Byte], got ${entry.tpe.tag}`,
        'deserialize-input-not-byte-array',
      )
    }
    const bytes = collByteToUint8Array(
      entry.value,
      'DeserializeRegister',
      'deserialize-input-not-byte-array',
    )
    const reader = new ByteReader(bytes)
    let parsed: Expr
    try {
      parsed = parseExpr(
        reader,
        [],
        [],
        new Map(),
        ctx.treeVersion ?? tree.header.version,
      )
    } catch (err) {
      throw new EvalError(
        `DeserializeRegister: inner Expr parse failed — ${(err as Error).message}`,
        'deserialize-parse-failed',
      )
    }
    const parsedTpe = exprTpe(parsed)
    if (!sTypeEquals(parsedTpe, e.tpe)) {
      throw new EvalError(
        `DeserializeRegister: inner Expr tpe mismatch (expected ${e.tpe.tag}, got ${parsedTpe.tag})`,
        'deserialize-tpe-mismatch',
      )
    }
    return parsed
  }
  // Register absent.
  if (e.default !== null) {
    const defaultTpe = exprTpe(e.default)
    if (!sTypeEquals(defaultTpe, e.tpe)) {
      throw new EvalError(
        `DeserializeRegister: default Expr tpe mismatch (expected ${e.tpe.tag}, got ${defaultTpe.tag})`,
        'deserialize-tpe-mismatch',
      )
    }
    return e.default
  }
  // Register absent + default null → LEAVE node unchanged. Mirrors sigma-rust
  // mir/expr.rs:478-481 "When script in register is not found, and default is
  // not defined, leave DeserializeRegisterNode unchanged, which will error on
  // evaluation". The defensive eval-time throw 'deserialize-not-substituted'
  // (wired in T3) catches this on the next dispatch step.
  return e
}

// ---------------------------------------------------------------------------
// substituteConstants — bottom-up immutable rewrite of CP → Const.
//
// Mirrors sigma-rust `Expr::substitute_constants`
// (ergotree-ir/src/mir/expr.rs:498-514). Used by `tree.proposition()`
// (ergotree-ir/src/ergo_tree.rs:248-258) when the tree header has
// `is_constant_segregation()` set. The substitute walks the body
// bottom-up; every `ConstPlaceholder(id)` is replaced with
// `Const(constantTypes[id], constants[id])`. The walk does NOT recurse
// into substituted children — a `Const` produced by substitution is a leaf
// and `mapChildren` returns it unchanged on the next traversal step.
//
// Error: if a placeholder's id is out of range (`id >= constants.length`),
// throw `EvalError('const-placeholder-id-out-of-range')` — same code as the
// eval-time `ConstPlaceholder` arm (`eval/const-placeholder.ts:53`). This
// keeps the error taxonomy consistent across the substitute path and the
// (now-unused-by-the-deserialize-branch) lazy-resolution path.
// ---------------------------------------------------------------------------

export function substituteConstants(
  body: Expr,
  constants: SValue[],
  constantTypes: SType[],
): Expr {
  return rewriteConstantsBottomUp(body, constants, constantTypes)
}

/**
 * Bottom-up recursive rewrite. Children are rewritten BEFORE the parent is
 * considered for substitution — matching `rewrite_bu_inner`
 * (`mir/expr.rs:397-408`). After rewriting children, if the current node is
 * `ConstPlaceholder`, replace it with `Const(constantTypes[id], constants[id])`.
 */
function rewriteConstantsBottomUp(
  e: Expr,
  constants: SValue[],
  constantTypes: SType[],
): Expr {
  // 1. Recurse into children first (bottom-up).
  const eWithRewrittenChildren = mapChildren(e, (child) =>
    rewriteConstantsBottomUp(child, constants, constantTypes),
  )

  // 2. Apply substitution at this node (only if ConstPlaceholder).
  if (eWithRewrittenChildren.tag === 'ConstPlaceholder') {
    const id = eWithRewrittenChildren.id
    if (id >= constants.length) {
      throw new EvalError(
        `ConstPlaceholder(${id}): id out of range (constants.length=${constants.length})`,
        'const-placeholder-id-out-of-range',
      )
    }
    return {
      tag: 'Const',
      tpe: constantTypes[id]!,
      value: constants[id]!,
    }
  }
  return eWithRewrittenChildren
}

// ---------------------------------------------------------------------------
// mapChildren — exhaustive per-variant child rewrite.
//
// Mirrors the `impl Traversable for Expr` block at `mir/expr.rs:531-678`
// and the per-variant `impl_traversable_expr!` macro invocations across
// `mir/<variant>.rs`. Each variant either has zero Expr children (leaf —
// return the node unchanged) or has 1+ Expr children (apply `fn` to each,
// reconstruct with the same tag + non-Expr fields).
//
// The switch is exhaustive over all 69 Expr variants. The `_exhaust: never`
// default ensures adding a new Expr variant is a compile-time error here.
// ---------------------------------------------------------------------------

function mapChildren(e: Expr, fn: (child: Expr) => Expr): Expr {
  switch (e.tag) {
    // -------------------------------------------------------------------
    // Zero Expr children (leaves). Mirrors `Box::new(core::iter::empty())`
    // arms in `mir/expr.rs:531-605`.
    // -------------------------------------------------------------------
    case 'Const':
      return e
    case 'ConstPlaceholder':
      return e
    case 'Context':
      return e
    case 'Global':
      return e
    case 'GlobalVars':
      return e
    case 'LastBlockUtxoRootHash':
      return e
    case 'ValUse':
      return e
    case 'GetVar':
      return e
    case 'DeserializeContext':
      // No Expr children — `impl_traversable_expr!(DeserializeContext)`.
      return e

    // -------------------------------------------------------------------
    // OneArgOp variants — single `input` Expr child. Mirrors the blanket
    // `impl<T: OneArgOp> Traversable for T` (traversable.rs:17-26).
    // -------------------------------------------------------------------
    case 'And':
      return { tag: 'And', input: fn(e.input) }
    case 'Or':
      return { tag: 'Or', input: fn(e.input) }
    case 'LogicalNot':
      return { tag: 'LogicalNot', input: fn(e.input) }
    case 'Negation':
      return { tag: 'Negation', input: fn(e.input) }
    case 'BitInversion':
      return { tag: 'BitInversion', input: fn(e.input) }
    case 'OptionGet':
      return { tag: 'OptionGet', input: fn(e.input) }
    case 'OptionIsDefined':
      return { tag: 'OptionIsDefined', input: fn(e.input) }
    case 'ExtractAmount':
      return { tag: 'ExtractAmount', input: fn(e.input) }
    case 'ExtractBytes':
      return { tag: 'ExtractBytes', input: fn(e.input) }
    case 'ExtractBytesWithNoRef':
      return { tag: 'ExtractBytesWithNoRef', input: fn(e.input) }
    case 'ExtractScriptBytes':
      return { tag: 'ExtractScriptBytes', input: fn(e.input) }
    case 'ExtractCreationInfo':
      return { tag: 'ExtractCreationInfo', input: fn(e.input) }
    case 'ExtractId':
      return { tag: 'ExtractId', input: fn(e.input) }
    case 'SizeOf':
      return { tag: 'SizeOf', input: fn(e.input) }
    case 'BoolToSigmaProp':
      return { tag: 'BoolToSigmaProp', input: fn(e.input) }
    case 'CreateProveDlog':
      return { tag: 'CreateProveDlog', input: fn(e.input) }
    case 'SigmaPropBytes':
      return { tag: 'SigmaPropBytes', input: fn(e.input) }
    case 'SigmaPropIsProven':
      return { tag: 'SigmaPropIsProven', input: fn(e.input) }
    case 'DecodePoint':
      return { tag: 'DecodePoint', input: fn(e.input) }
    case 'CalcBlake2b256':
      return { tag: 'CalcBlake2b256', input: fn(e.input) }
    case 'CalcSha256':
      return { tag: 'CalcSha256', input: fn(e.input) }
    case 'LongToByteArray':
      return { tag: 'LongToByteArray', input: fn(e.input) }
    case 'ByteArrayToLong':
      return { tag: 'ByteArrayToLong', input: fn(e.input) }
    case 'ByteArrayToBigInt':
      return { tag: 'ByteArrayToBigInt', input: fn(e.input) }
    case 'XorOf':
      return { tag: 'XorOf', input: fn(e.input) }

    // -------------------------------------------------------------------
    // Variants with explicit `impl_traversable_expr!` invocations carrying
    // specific child fields. Per-variant macros listed at
    // `external/sigma-rust/ergotree-ir/src/mir/<variant>.rs`.
    // -------------------------------------------------------------------

    // `impl_traversable_expr!(Append, boxed input, boxed col_2)`.
    case 'Append': {
      const r: Append = { tag: 'Append', input: fn(e.input), col2: fn(e.col2) }
      return r
    }

    // `impl_traversable_expr!(SubstConstants, boxed script_bytes, boxed positions, boxed new_values)`.
    case 'SubstConstants': {
      const r: SubstConstants = {
        tag: 'SubstConstants',
        scriptBytes: fn(e.scriptBytes),
        positions: fn(e.positions),
        newValues: fn(e.newValues),
      }
      return r
    }

    // Collection: Exprs arm has `arr items`; BoolConstants arm is empty.
    // Mirrors `impl Traversable for Collection` (mir/collection.rs:84-98).
    case 'Collection': {
      if (e.kind === 'Exprs') {
        const r: Collection = {
          tag: 'Collection',
          kind: 'Exprs',
          elemTpe: e.elemTpe,
          items: e.items.map(fn),
        }
        return r
      }
      // BoolConstants — no Expr children.
      return e
    }

    // `impl_traversable_expr!(Tuple, arr items)`.
    case 'Tuple': {
      const r: Tuple = { tag: 'Tuple', items: e.items.map(fn) }
      return r
    }

    // `impl_traversable_expr!(FuncValue, boxed body)`. Note: args are
    // `FuncArg` (not Expr), so they pass through unchanged.
    case 'FuncValue': {
      const r: FuncValue = {
        tag: 'FuncValue',
        args: e.args,
        body: fn(e.body),
      }
      return r
    }

    // `impl_traversable_expr!(Apply, boxed func, arr args)`.
    case 'Apply': {
      const r: Apply = {
        tag: 'Apply',
        func: fn(e.func),
        args: e.args.map(fn),
      }
      return r
    }

    // `impl_traversable_expr!(MethodCall, boxed obj, arr args)`.
    case 'MethodCall': {
      const r: MethodCall = {
        tag: 'MethodCall',
        obj: fn(e.obj),
        typeId: e.typeId,
        methodId: e.methodId,
        args: e.args.map(fn),
        explicitTypeArgs: e.explicitTypeArgs,
      }
      return r
    }

    // `impl_traversable_expr!(PropertyCall, boxed obj)`.
    case 'PropertyCall': {
      const r: PropertyCall = {
        tag: 'PropertyCall',
        obj: fn(e.obj),
        typeId: e.typeId,
        methodId: e.methodId,
        explicitTypeArgs: e.explicitTypeArgs,
      }
      return r
    }

    // `impl_traversable_expr!(BlockValue, arr items, boxed result)`.
    case 'BlockValue': {
      const r: BlockValue = {
        tag: 'BlockValue',
        items: e.items.map(fn),
        result: fn(e.result),
      }
      return r
    }

    // `impl_traversable_expr!(ValDef, boxed rhs)`.
    case 'ValDef': {
      const r: ValDef = { tag: 'ValDef', id: e.id, rhs: fn(e.rhs) }
      return r
    }

    // `impl_traversable_expr!(If, boxed condition, boxed true_branch, boxed false_branch)`.
    case 'If': {
      const r: If = {
        tag: 'If',
        condition: fn(e.condition),
        trueBranch: fn(e.trueBranch),
        falseBranch: fn(e.falseBranch),
      }
      return r
    }

    // `impl_traversable_expr!(BinOp, boxed left, boxed right)`.
    case 'BinOp': {
      const r: BinOp = {
        tag: 'BinOp',
        op: e.op,
        left: fn(e.left),
        right: fn(e.right),
      }
      return r
    }

    // `impl_traversable_expr!(Xor, boxed left, boxed right)`.
    case 'Xor': {
      const r: Xor = { tag: 'Xor', left: fn(e.left), right: fn(e.right) }
      return r
    }

    // `impl_traversable_expr!(Atleast, boxed bound, boxed input)`.
    case 'Atleast': {
      const r: Atleast = {
        tag: 'Atleast',
        bound: fn(e.bound),
        input: fn(e.input),
      }
      return r
    }

    // `impl_traversable_expr!(OptionGetOrElse, boxed input, boxed default)`.
    case 'OptionGetOrElse': {
      const r: OptionGetOrElse = {
        tag: 'OptionGetOrElse',
        input: fn(e.input),
        default: fn(e.default),
      }
      return r
    }

    // `impl_traversable_expr!(ExtractRegisterAs, boxed input)`.
    case 'ExtractRegisterAs':
      return {
        tag: 'ExtractRegisterAs',
        input: fn(e.input),
        registerId: e.registerId,
        elemTpe: e.elemTpe,
      }

    // `impl_traversable_expr!(ByIndex, boxed input, boxed index, opt default)`.
    case 'ByIndex': {
      const r: ByIndex = {
        tag: 'ByIndex',
        input: fn(e.input),
        index: fn(e.index),
        default: e.default !== null ? fn(e.default) : null,
      }
      return r
    }

    // `impl_traversable_expr!(Slice, boxed input, boxed from, boxed until)`.
    case 'Slice': {
      const r: Slice = {
        tag: 'Slice',
        input: fn(e.input),
        from: fn(e.from),
        until: fn(e.until),
      }
      return r
    }

    // `impl_traversable_expr!(Fold, boxed input, boxed zero, boxed fold_op)`.
    case 'Fold': {
      const r: Fold = {
        tag: 'Fold',
        input: fn(e.input),
        zero: fn(e.zero),
        foldOp: fn(e.foldOp),
      }
      return r
    }

    // `impl_traversable_expr!(Map, boxed input, boxed mapper)`.
    case 'Map': {
      const r: Map = { tag: 'Map', input: fn(e.input), mapper: fn(e.mapper) }
      return r
    }

    // `impl_traversable_expr!(Filter, boxed input, boxed condition)`.
    case 'Filter': {
      const r: Filter = {
        tag: 'Filter',
        input: fn(e.input),
        condition: fn(e.condition),
      }
      return r
    }

    // `impl_traversable_expr!(Exists, boxed input, boxed condition)`.
    case 'Exists': {
      const r: Exists = {
        tag: 'Exists',
        input: fn(e.input),
        condition: fn(e.condition),
      }
      return r
    }

    // `impl_traversable_expr!(ForAll, boxed input, boxed condition)`.
    case 'ForAll': {
      const r: ForAll = {
        tag: 'ForAll',
        input: fn(e.input),
        condition: fn(e.condition),
      }
      return r
    }

    // `impl_traversable_expr!(SelectField, boxed input)`.
    case 'SelectField': {
      const r: SelectField = {
        tag: 'SelectField',
        input: fn(e.input),
        fieldIndex: e.fieldIndex,
      }
      return r
    }

    // `impl_traversable_expr!(Upcast, boxed input)`.
    case 'Upcast': {
      const r: Upcast = { tag: 'Upcast', input: fn(e.input), tpe: e.tpe }
      return r
    }

    // `impl_traversable_expr!(Downcast, boxed input)`.
    case 'Downcast': {
      const r: Downcast = { tag: 'Downcast', input: fn(e.input), tpe: e.tpe }
      return r
    }

    // `impl_traversable_expr!(CreateProveDhTuple, boxed g, boxed h, boxed u, boxed v)`.
    case 'CreateProveDhTuple': {
      const r: CreateProveDhTuple = {
        tag: 'CreateProveDhTuple',
        g: fn(e.g),
        h: fn(e.h),
        u: fn(e.u),
        v: fn(e.v),
      }
      return r
    }

    // ZkProofBlock: `impl Traversable for ZkProofBlock` (mir/zk_proof.rs:45-55)
    // exposes the single `input` Expr child.
    case 'ZkProofBlock': {
      const r: ZkProofBlock = { tag: 'ZkProofBlock', input: fn(e.input) }
      return r
    }

    // `impl_traversable_expr!(SigmaAnd, arr items)`.
    case 'SigmaAnd': {
      const r: SigmaAnd = { tag: 'SigmaAnd', items: e.items.map(fn) }
      return r
    }

    // `impl_traversable_expr!(SigmaOr, arr items)`.
    case 'SigmaOr': {
      const r: SigmaOr = { tag: 'SigmaOr', items: e.items.map(fn) }
      return r
    }

    // `impl_traversable_expr!(DeserializeRegister, opt default)`. The default
    // Expr (if non-null) is a child — sigma-rust walks it bottom-up too.
    case 'DeserializeRegister':
      return {
        tag: 'DeserializeRegister',
        reg: e.reg,
        tpe: e.tpe,
        default: e.default !== null ? fn(e.default) : null,
      }

    // `impl_traversable_expr!(MultiplyGroup, boxed left, boxed right)`.
    case 'MultiplyGroup': {
      const r: MultiplyGroup = {
        tag: 'MultiplyGroup',
        left: fn(e.left),
        right: fn(e.right),
      }
      return r
    }

    // `impl_traversable_expr!(Exponentiate, boxed left, boxed right)`.
    case 'Exponentiate': {
      const r: Exponentiate = {
        tag: 'Exponentiate',
        left: fn(e.left),
        right: fn(e.right),
      }
      return r
    }

    // `impl_traversable_expr!(TreeLookup, boxed tree, boxed key, boxed proof)`.
    case 'TreeLookup': {
      const r: TreeLookup = {
        tag: 'TreeLookup',
        tree: fn(e.tree),
        key: fn(e.key),
        proof: fn(e.proof),
      }
      return r
    }

    // JVM layout: 4 expr operands (valueLength is an Option-TYPED expr,
    // always present — trees.scala:79-91; see wire/mir/create-avl-tree.ts).
    case 'CreateAvlTree': {
      const r: CreateAvlTree = {
        tag: 'CreateAvlTree',
        flags: fn(e.flags),
        digest: fn(e.digest),
        keyLength: fn(e.keyLength),
        valueLength: fn(e.valueLength),
      }
      return r
    }

    default: {
      // Compile-time exhaustiveness: adding a new Expr variant becomes
      // an error here until a case is added above.
      const _exhaust: never = e
      throw new Error(
        `mapChildren: unhandled Expr variant ${JSON.stringify(_exhaust)}`,
      )
    }
  }
}

/**
 * Generator over the immediate Expr children of `e`. Mirrors the iterator
 * built by `Traversable::children` (mir/expr.rs:534-605) and the per-variant
 * `iter_from!` macro expansion.
 *
 * Used by {@link hasDeserializeWalk} and by `eval/validate-bin-op-types.ts`'s
 * whole-tree pass; the substitution walker uses {@link mapChildren} which
 * reconstructs the parent.
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
