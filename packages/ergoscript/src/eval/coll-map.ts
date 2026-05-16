/**
 * Map evaluator arm — first lambda HOF (phase 2f Coll HOFs Task 6).
 *
 * Applies a function (lambda) to each element of a collection, returning
 * a new collection of the same length with transformed elements.
 *
 * Cost: Mixed pattern — outer + per-iter.
 *   Sigma-rust ref: ergotree-interpreter/src/eval/coll_map.rs:14-84
 *
 *   Outer (line 72, AFTER input/mapper eval, BEFORE loop):
 *     ctx.add_per_item_jit_cost(20, 1, 10, n)  where n = inputColl.length
 *
 *   Per-iter (line 31, inside closure, BEFORE body eval):
 *     ctx.add_jit_cost(5)
 *
 * Eval order (Mixed pattern):
 *   1. Eval input  → must be Coll  (throws 'coll-input-not-coll')
 *   2. Eval mapper → must be Lambda (throws 'lambda-not-callable')
 *   3. Elem-type check: input.elem vs mapper's declared arg type
 *      (throws 'coll-elem-tpe-mismatch'; skipped if mapper is not a FuncValue MIR node)
 *   4. Outer cost: addPerItemCost(20, 1, 10, n)
 *   5. Per item: addCost(5), env.extend(argId, item), eval body,
 *      result-type check (throws 'lambda-result-type-mismatch'), collect result
 *   6. Return { kind: 'Coll', elem: inferred from items or fallback, items }
 *
 * Env-extend convention (establishes pattern for Tasks 7-10):
 *   TS Env is immutable (per phase 2b design). For each item we call
 *   env.extend(closure.argIds[0], item) to create a new scope — no
 *   save/restore needed, unlike sigma-rust's mutable env (coll_map.rs:30-38).
 *   Each iteration uses a fresh bodyEnv derived from the caller's `env`.
 *
 * Input elem-type check (sigma-rust coll_map.rs:46-64):
 *   Sigma-rust uses `mapper_sfunc.t_dom.first()` (static type stored on the
 *   Map MIR struct). The TS Map MIR interface has no mapper_sfunc field; we
 *   derive the expected input type from the mapper Expr when it is a FuncValue
 *   node (accessing e.mapper.args[0].tpe). If the mapper is not a FuncValue
 *   (e.g. a Const or ValUse returning a Lambda), we skip the static check —
 *   the extractFuncValue guard still catches non-callable values at runtime.
 *
 * Output elem type (sigma-rust coll_map.rs:78 via CollKind::from_collection):
 *   We use exprTpe(e.mapper) to derive the mapper's declared return type when
 *   the mapper is a FuncValue. If the mapper's type is SFunc, we use sfunc.result
 *   as outElemTpe and check each per-item result against it, throwing
 *   'lambda-result-type-mismatch' on mismatch. When outElemTpe is not derivable
 *   (mapper is not FuncValue or has SAny type), the per-item type check is skipped
 *   and we fall back to inferring from the first runtime result item.
 */

import type { Map, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEquals } from '../mir/stype-helpers'

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
 * @throws EvalError `'lambda-result-type-mismatch'` if a body result doesn't match mapper's declared return type.
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

  // 3b. Elem-type check: input.elem must match mapper's declared arg type.
  // Sigma-rust coll_map.rs:46-64: `self.mapper_sfunc.t_dom.first()` gives the declared
  // input type from the Map MIR struct. TS MIR has no mapper_sfunc field; we derive it
  // from e.mapper when it is a FuncValue MIR node (i.e., e.mapper.args[0].tpe).
  // When mapper is not a FuncValue node (ValUse etc.), skip — the extractFuncValue guard
  // above already enforces callable-at-runtime.
  let outElemTpe: SType | null = null
  if (e.mapper.tag === 'FuncValue' && e.mapper.args.length > 0) {
    const mapperInputTpe = e.mapper.args[0]!.tpe
    if (!sTypeEquals(inputColl.elem, mapperInputTpe)) {
      throw new EvalError(
        `Map: input elem type ${JSON.stringify(inputColl.elem)} does not match mapper declared arg type ${JSON.stringify(mapperInputTpe)}`,
        'coll-elem-tpe-mismatch'
      )
    }
    // Derive outElemTpe from exprTpe(e.mapper) — mirrors mapper_sfunc.t_range.
    // exprTpe(FuncValue) returns SFunc { args, result, tpeParams }; result = body type.
    const mapperTpe = exprTpe(e.mapper)
    if (mapperTpe.tag === 'SFunc') {
      outElemTpe = mapperTpe.result
    }
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

  // 5. Loop: per-iter cost + env-extend + body eval + result-type check.
  // Sigma-rust coll_map.rs:73-82: iter().map(|item| mapper_call(item)).collect()
  // where mapper_call: add_jit_cost(5), env.insert(argId, item), body.eval, env restore.
  // TS uses immutable Env.extend — no save/restore needed.
  // Result-type check mirrors CollKind::from_collection(self.out_elem_tpe(), values) which
  // validates each item's type implicitly. TS makes it explicit per-item.
  const outItems: SValue[] = []
  for (const item of inputColl.items) {
    // Per-iter cost (sigma-rust coll_map.rs:31).
    ctx.addCost(COLL_MAP_PER_ITER)
    // Extend env with arg binding (sigma-rust coll_map.rs:32: env.insert(func_arg.idx, arg)).
    const bodyEnv = env.extend(argId, item)
    // Eval body (sigma-rust coll_map.rs:33: func_value.body.eval(env, ctx)).
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
    // Result-type check: if outElemTpe is known, verify itemRes matches.
    if (outElemTpe !== null) {
      const itemTpe = inferSType(itemRes)
      if (!sTypeEquals(itemTpe, outElemTpe)) {
        throw new EvalError(
          `Map: lambda body returned type ${JSON.stringify(itemTpe)} but mapper declared return type ${JSON.stringify(outElemTpe)}`,
          'lambda-result-type-mismatch'
        )
      }
    }
    outItems.push(itemRes)
  }

  // 6. Determine output elem type for the result Coll.
  // Prefer the statically-derived outElemTpe (= mapper_sfunc.t_range); fall back to
  // inferring from the first runtime result item (non-empty) or input elem type (empty).
  const outElem: SType =
    outElemTpe !== null
      ? outElemTpe
      : outItems.length > 0
        ? inferSType(outItems[0]!)
        : inputColl.elem

  return { kind: 'Coll', elem: outElem, items: outItems }
}

/**
 * Infer an SType tag from a runtime SValue. Used for the output elem type of
 * Map when the MIR node does not carry mapper_sfunc.t_range.
 *
 * Covers all primitive and composite variants used in fixtures. For exotic
 * variants (SigmaProp, GroupElement, Box, Lambda) we emit a reasonable tag.
 */
function inferSType(v: SValue): SType {
  switch (v.kind) {
    case 'Boolean':
      return { tag: 'SBoolean' }
    case 'Byte':
      return { tag: 'SByte' }
    case 'Short':
      return { tag: 'SShort' }
    case 'Int':
      return { tag: 'SInt' }
    case 'Long':
      return { tag: 'SLong' }
    case 'BigInt':
      return { tag: 'SBigInt' }
    case 'Unit':
      return { tag: 'SUnit' }
    case 'Coll':
      return { tag: 'SColl', elem: v.elem }
    case 'Tuple': {
      const items = v.items.map(inferSType)
      return { tag: 'STuple', items }
    }
    case 'Option':
      return { tag: 'SOption', elem: v.elem }
    case 'GroupElement':
      return { tag: 'SGroupElement' }
    case 'SigmaProp':
      return { tag: 'SSigmaProp' }
    case 'Box':
      return { tag: 'SBox' }
    case 'Lambda':
      // Lambda-typed colls are unusual; emit SAny as a safe default.
      return { tag: 'SAny' }
    case 'AvlTree':
      return { tag: 'SAvlTree' }
    default:
      throw new EvalError(
        `Map: cannot infer SType for SValue kind '${(v as never as { kind: string }).kind}'`,
        'coll-map-elem-type-infer-failed'
      )
  }
}
