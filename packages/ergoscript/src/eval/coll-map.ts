/**
 * Map evaluator arm.
 *
 * Applies a lambda to each element of a collection, returning a new
 * collection of the same length with transformed elements. The result's
 * class and array-store rule are the collection module's (see `mapped`
 * in `src/coll/ops.ts`, mirroring JVM `CollOverArray.map`
 * `CollsOverArrays.scala:28-31` and `PairOfCols.map` `:317-324` at 6.0.7):
 * each item is stored through the range type's `ArrayBuilder` (plain
 * receiver) or through a direct aastore (pairs receiver), and a failure is
 * `EvalError('coll-class-cast')` or `EvalError('coll-array-store')`.
 *
 * Cost (Mixed pattern — outer `PerItemCost` + per-iter):
 *   Outer, AFTER input/mapper eval, BEFORE the loop:
 *     `addPerItemCost(20, 1, 10, inputColl.length)` — JVM
 *     `MapCollection.eval` `transformers.scala:44`: `addSeqCostNoOp(
 *       MapCollection.costKind, inputV.length)`; `costKind = PerItemCost(20,
 *       1, 10)` (`transformers.scala:52-53`).
 *   Per-iter, inside the closure, BEFORE body eval:
 *     `addCost(5)` — JVM `FuncValue.eval` `values.scala:1076`:
 *     `addFixedCost(AddToEnvironmentDesc_CostKind, ...)` = 5.
 *
 * Eval order (Mixed pattern):
 *   1. Eval input  → must be Coll (throws `'coll-input-not-coll'`).
 *   2. Eval mapper → must be Lambda (throws `'lambda-not-callable'`).
 *   3. Elem-type check: input.elem vs the mapper's declared arg type when
 *      the MIR mapper node is a FuncValue (throws `'coll-elem-tpe-mismatch'`;
 *      a shape mirror of the JVM's `FuncValue.eval`
 *      `Value.checkType(arg0._2, vArg)` which runs `isValueOfType`
 *      `SType.scala:187-213`). Skipped when the MIR mapper is no FuncValue.
 *   4. Outer cost: `addPerItemCost(20, 1, 10, n)`.
 *   5. Per item: `addCost(5)`, `env.extend(argId, item)`, eval body, read
 *      the body's `tpe` (JVM `values.scala:1080` `checkType(body, res)`:
 *      `isValueOfType` is a SHAPE check that any `Coll[_]` fits an
 *      `SCollectionType`, any `Tuple2[_,_]` a pair `STuple`, etc.
 *      `SType.scala:198-205`). Collect the result.
 *   6. Return `mapped(inputColl, outElem, outItems)` — the module does the
 *      store check per receiver shape and range class; each refusal is the
 *      JVM's `ClassCastException` (`'coll-class-cast'`) or
 *      `ArrayStoreException` (`'coll-array-store'`).
 *
 * Env-extend convention: TS Env is immutable. For each item we call
 *   env.extend(closure.argIds[0], item) to create a new scope — no
 *   save/restore needed; the previous scope is the still-live parent
 *   binding.
 *
 * Output elem type (JVM `MapCollection.eval` `transformers.scala:43`:
 *   `tResItem = Evaluation.stypeToRType(mapper.tpe.tRange)`; the store runs
 *   at that type. `MapCollection.tpe` is `SCollection(mapper.tpe.tRange)`
 *   `:38`, so the range comes from the mapper's type as the JVM reads it —
 *   for a mapper that is an `If` of two lambdas, `If.tpe = trueBranch.tpe`
 *   gives the first lambda's `SFunc` type (`values.scala:1066-1083` of
 *   `If.eval` reads this in order).
 *
 *   We derive `outElem` from `exprTpe(e.mapper, ctx.treeVersion ?? 0)` on
 *   every MIR mapper shape whose static type is an `SFunc`. For a mapper
 *   whose `exprTpe` is `SAny` (unresolved method return types), the static
 *   range is unknown; we take the first result's runtime type for the
 *   result's `elem`, and the receiver's `elem` for an empty output — the
 *   store then runs through `arrayClassOf(outElem)` with that fallback.
 */

import type { Map, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { assertArgTypeResolved } from './_lambda'
import { readCheckedType } from './_check-type'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEqualsModuloSAny, hasSAny } from '../mir/stype-helpers'
import { sValueType } from './svalue-type'
import { mapped } from './_coll'

// Outer cost: add_per_item_jit_cost(base=20, per_chunk=1, chunk_size=10, n)
// Sigma-rust ref: coll_map.rs:72
const COLL_MAP_OUTER_BASE = 20
const COLL_MAP_OUTER_PER_CHUNK = 1
const COLL_MAP_OUTER_CHUNK_SIZE = 10

// Per-iter cost: add_jit_cost(5) per element before body eval
// Sigma-rust ref: coll_map.rs:31
const COLL_MAP_PER_ITER = 5

/**
 * Evaluate a `Map` node. Mixed pattern: outer after children, per-iter in loop.
 *
 * @throws EvalError `'coll-input-not-coll'` if input does not eval to a Coll.
 * @throws EvalError `'lambda-not-callable'` if mapper does not eval to a callable Lambda.
 * @throws EvalError `'coll-elem-tpe-mismatch'` if input's elem type doesn't match mapper's declared arg type.
 * @throws EvalError `'coll-class-cast'` / `'coll-array-store'` if a mapped item's class fails the result array's store (through `mapped`).
 * @throws EvalError `'cost-limit-exceeded'` if any cost charge exceeds the limit.
 */
export function evalMap(e: Map, env: Env, ctx: EvalContext): SValue {
  // 1. Eval input and mapper — Pattern B ordering (eval children first, outer cost after).
  const inputVal = evalExpr(e.input, env, ctx)
  const mapperVal = evalExpr(e.mapper, env, ctx)

  // 2. Guard: input must be Coll.
  const inputColl = extractCollItems(inputVal)

  // 3. Guard: mapper must be a callable Lambda with at least one arg.
  const closure = extractFuncValue(mapperVal)

  // 3b. Elem-type check: input.elem must match the mapper's declared arg type
  // (a shape mirror of the JVM's `FuncValue.eval` `Value.checkType(arg0._2,
  // vArg)` = `isValueOfType`, `SType.scala:187-213`, which rejects a wrong
  // kind at each application). The TS MIR has no `mapper_sfunc` field; we
  // derive the expected input type from the mapper Expr when it is a
  // FuncValue node (e.mapper.args[0].tpe). When the mapper is not a FuncValue
  // node (ValUse, If, etc.), skip — `extractFuncValue` above already enforces
  // callable-at-runtime, and the per-item application charges arg-bind via
  // addCost(5).
  //
  // SAny tolerance: when the RUNTIME input collection's elem is SAny we skip
  // the check rather than reject. SAny is our placeholder for an element type
  // we couldn't resolve statically (it flows from unresolved MethodCall return
  // types — see `exprTpe` — through ValDef/ValUse/Map-output). The JVM never
  // has SAny here; its check (on the concrete runtime type) passes, so
  // rejecting on our lossy SAny is a false positive. Mirrors the
  // SAny-tolerance in ByIndex/OptionGet/SelectField.
  if (e.mapper.tag === 'FuncValue' && e.mapper.args.length > 0) {
    const mapperInputTpe = e.mapper.args[0]!.tpe
    if (!sTypeEqualsModuloSAny(inputColl.elem, mapperInputTpe)) {
      throw new EvalError(
        `Map: input elem type ${JSON.stringify(inputColl.elem)} does not match mapper declared arg type ${JSON.stringify(mapperInputTpe)}`,
        'coll-elem-tpe-mismatch'
      )
    }
  }
  // Derive outElemTpe from `exprTpe(e.mapper, v)` on every mapper whose
  // static type is an SFunc (not just a FuncValue MIR node). JVM
  // `MapCollection.eval` reads `mapper.tpe.tRange` with no gate on the MIR
  // shape (`transformers.scala:43`): for an If of two lambdas the type is
  // the true branch's lambda type (`If.tpe = trueBranch.tpe`), so the range
  // is known at every well-typed shape.
  let outElemTpe: SType | null = null
  const mapperTpe = exprTpe(e.mapper, ctx.treeVersion ?? 0)
  if (mapperTpe.tag === 'SFunc') {
    outElemTpe = mapperTpe.result
  }

  // 4. Outer cost: add_per_item_jit_cost(20, 1, 10, n) — BEFORE the loop.
  // Sigma-rust coll_map.rs:72: ctx.add_per_item_jit_cost(20, 1, 10, normalized_input_vals.len())?;
  ctx.addPerItemCost(
    COLL_MAP_OUTER_BASE,
    COLL_MAP_OUTER_PER_CHUNK,
    COLL_MAP_OUTER_CHUNK_SIZE,
    inputColl.items.length
  )

  const argId = closure.argIds[0]!

  // 5. Loop: per-iter cost + env-extend + body eval + body-tpe read.
  // Mirrors JVM `FuncValue.eval` `values.scala:1069-1086`: for each item
  // bind the arg (charging 5 for `AddToEnvironmentDesc`), evaluate the body,
  // then `Value.checkType(body, res)` = `isValueOfType` — a SHAPE check that
  // any `Coll[_]` fits an `SCollectionType`, any `Tuple2[_,_]` fits a pair
  // `STuple`, etc. (`SType.scala:198-205`). The per-element RANGE check
  // that the JVM makes is shape-only; the strict elem-type-level test an
  // earlier revision made here rejected trees the JVM accepts (row #20's
  // `Coll[Long]` into a `Coll[Coll[Int]]` lambda range, row #37's empty
  // `Coll[GroupElement]` into `Coll[Coll[Box]]`, and so on). The ACTUAL
  // JVM rejection for a misfit is the per-item array store in
  // `MapCollection.eval` (`transformers.scala:45`): that moved to the
  // module's `mapped` call below.
  const outItems: SValue[] = []
  for (const item of inputColl.items) {
    // Per-iter cost: 5 for `AddToEnvironmentDesc` (JVM values.scala:1076).
    ctx.addCost(COLL_MAP_PER_ITER)
    // Extend the lambda's CAPTURED (definition-site) env with the arg
    // binding — lexical scoping, JVM-faithful for v6. For inline mapper
    // lambdas capturedEnv == the caller env, so this is a no-op.
    // v6 P6: reject a type-var arg type at the per-element apply (JVM
    // "Unknown type T"). Per-element ⇒ an empty input never binds.
    assertArgTypeResolved(closure.argTpes[0]!)
    const bodyEnv = closure.capturedEnv.extend(argId, item)
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
    // The JVM's closure reads the body's type after each application
    // (`data/shared/src/main/scala/sigma/ast/values.scala:1080`:
    // `Value.checkType(body, res)` reads `body.tpe` before the shape check).
    readCheckedType(closure.body, ctx)
    outItems.push(itemRes)
  }

  // 6. Determine the output's elem type for the result Coll, and the store
  // runs at it in `mapped` (which the module turns into the correct class
  // via `arrayClassOf(outElem)`).
  //
  // Prefer the static outElemTpe (= `exprTpe(mapper).result` = JVM
  // `mapper.tpe.tRange`, `values.scala:1050-1064`). If that is wholly
  // concrete (no SAny at any depth), use it. Otherwise recover the concrete
  // elem from the first runtime item; for an empty output fall back to the
  // static type (incl. its SAny) or the receiver's elem.
  const staticConcrete = outElemTpe !== null && !hasSAny(outElemTpe)
  const outElem: SType =
    staticConcrete
      ? outElemTpe!
      : outItems.length > 0
        ? sValueType(outItems[0]!)
        : (outElemTpe ?? inputColl.elem)

  // `MapCollection.eval` (transformers.scala:40-46) calls
  // `inputV.map(mapperV)(tResItem)` at the mapper's declared range type —
  // the collection module's `mapped` does the per-item store at
  // `arrayClassOf(tRange)` by the JVM's rules:
  //   array-shape receiver → `CollOverArray.map` through
  //   `ArrayBuilder.ofXXX.+=` (CollsOverArrays.scala:28-31); plain result,
  //   pair routing on a pair range.
  //   pairs-shape receiver → `PairOfCols.map` writes `new Array[V](n);
  //   res(i) = f(..)` directly, a plain `CollOverArray` (`:317-324`).
  if (inputVal.kind !== 'Coll') throw new Error('unreachable: extractCollItems would have thrown')
  return mapped(inputVal, outElem, outItems)
}

