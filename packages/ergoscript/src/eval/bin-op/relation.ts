/**
 * BinOp.Relation family — Eq, NEq, Lt, Le, Gt, Ge.
 *
 * This file ships ordering ops (Lt/Le/Gt/Ge) in phase 2c task 6, and
 * adds Eq/NEq (with full sValueEquals comparer) in task 7.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Relation arm,
 * ordering subset at lines ~205-211:
 *   BinOpKind::Relation(op) => match op {
 *       RelationOp::Eq | RelationOp::NEq => {}  // cost charged inside eq_with_cost
 *       _ => { ctx.add_jit_cost(20)?; }  // LT, LE, GT, GE = Fixed(20)
 *   }
 * Ordering helpers eval_lt/le/gt/ge at lines ~100-166: type-specific dispatch
 * via match on lv kind. We collapse to bigint internally; observably equivalent
 * for same-kind numeric pairs.
 *
 * Ordering matches sigma-rust: eval left → charge cost → eval right.
 * Cost: Fixed(20) per bin_op.rs:210 (inline literal; no named constant in costs.rs).
 *
 * Eq/NEq: eval left → eval right → call sValueEquals (which charges cost).
 * No envelope cost for Eq/NEq — sigma-rust bin_op.rs:205 leaves the match arm
 * empty; all cost is delegated to eq_with_cost in data_value_comparer.rs.
 */
import type { BinOp, SValue, RelationOp, SType } from '../../mir/types'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'
import { evalExpr } from '../eval'
import { isNumeric, valueToBigInt } from './_numeric'
import { serializeSigmaBoolean } from '../../wire/sigma-boolean'
import { ByteWriter } from '../../wire/writer'

/** Cost for ordering Relation ops. sigma-rust bin_op.rs:210. */
const RELATION_ORDERING_COST = 20

// ---------------------------------------------------------------------------
// Cost constants from data_value_comparer.rs (ergotree-interpreter)
// All values are direct mirrors of the named constants in that file.
// ---------------------------------------------------------------------------

/** Per-comparison cost for Boolean/Byte/Short/Int/Long, and also for the
 *  catch-all arm (Unit, SigmaProp, cross-type, Lambda).
 *  data_value_comparer.rs:15 `EQ_PRIM_COST: u64 = 3` */
const EQ_PRIM_COST = 3

/** Per-comparison cost for BigInt.
 *  data_value_comparer.rs:16 `EQ_BIGINT_COST: u64 = 5` */
const EQ_BIGINT_COST = 5

/** Per-comparison cost for GroupElement (secp256k1 point comparison).
 *  data_value_comparer.rs:17 `EQ_GROUP_ELEMENT_COST: u64 = 172` */
const EQ_GROUP_ELEMENT_COST = 172

/** Tuple equality base cost (plus recursive element costs).
 *  data_value_comparer.rs:18 `EQ_TUPLE_COST: u64 = 4` */
const EQ_TUPLE_COST = 4

/** Option equality base cost (plus recursive inner cost when both Some).
 *  data_value_comparer.rs:19 `EQ_OPTION_COST: u64 = 4` */
const EQ_OPTION_COST = 4

/** Collection match-type dispatch cost: always paid before any length or
 *  per-item check. data_value_comparer.rs:27 `COLL_MATCH_TYPE_COST: u64 = 1`
 *
 *  Note: sigma-rust comment "Charged first, before the length-mismatch
 *  short-circuit so the dispatch itself is always paid for" (line 107). */
const COLL_MATCH_TYPE_COST = 1

/**
 * Per-item collection equality cost parameters (base, perChunk, chunkSize),
 * mirroring sigma-rust data_value_comparer.rs:31-42 `EQ_COLL_*_PER_ITEM` tuples.
 *
 * Applied via: cost = base + ceil(n / chunkSize) * perChunk
 * (matching `Context::add_per_item_jit_cost` in ergotree-ir/src/chain/context.rs:89-99)
 */
type PerItemCost = { base: number; perChunk: number; chunkSize: number }

/** data_value_comparer.rs:31 `EQ_COLL_BYTE_PER_ITEM: (u32, u32, u32) = (15, 2, 128)` */
const EQ_COLL_BYTE_PER_ITEM: PerItemCost = { base: 15, perChunk: 2, chunkSize: 128 }
/** data_value_comparer.rs:32 `EQ_COLL_SHORT_PER_ITEM: (u32, u32, u32) = (15, 2, 96)` */
const EQ_COLL_SHORT_PER_ITEM: PerItemCost = { base: 15, perChunk: 2, chunkSize: 96 }
/** data_value_comparer.rs:33 `EQ_COLL_INT_PER_ITEM: (u32, u32, u32) = (15, 2, 64)` */
const EQ_COLL_INT_PER_ITEM: PerItemCost = { base: 15, perChunk: 2, chunkSize: 64 }
/** data_value_comparer.rs:34 `EQ_COLL_LONG_PER_ITEM: (u32, u32, u32) = (15, 2, 48)` */
const EQ_COLL_LONG_PER_ITEM: PerItemCost = { base: 15, perChunk: 2, chunkSize: 48 }
/** data_value_comparer.rs:35 `EQ_COLL_BOOLEAN_PER_ITEM: (u32, u32, u32) = (15, 2, 128)` */
const EQ_COLL_BOOLEAN_PER_ITEM: PerItemCost = { base: 15, perChunk: 2, chunkSize: 128 }
/** data_value_comparer.rs:36 `EQ_COLL_BIGINT_PER_ITEM: (u32, u32, u32) = (15, 7, 5)` */
const EQ_COLL_BIGINT_PER_ITEM: PerItemCost = { base: 15, perChunk: 7, chunkSize: 5 }
/** data_value_comparer.rs:37 `EQ_COLL_GROUP_ELEMENT_PER_ITEM: (u32, u32, u32) = (15, 5, 1)` */
const EQ_COLL_GROUP_ELEMENT_PER_ITEM: PerItemCost = { base: 15, perChunk: 5, chunkSize: 1 }
/** data_value_comparer.rs:42 `EQ_COLL_DEFAULT_PER_ITEM: (u32, u32, u32) = (10, 2, 1)` — for
 *  all other elem types (Tuple, Option, nested Coll, etc.). */
const EQ_COLL_DEFAULT_PER_ITEM: PerItemCost = { base: 10, perChunk: 2, chunkSize: 1 }

/**
 * Mirror of `add_per_item_jit_cost(base, per_chunk, chunk_size, n_items)` from
 * ergotree-ir/src/chain/context.rs:89-99.
 *
 * Formula: base + ceil(n / chunkSize) * perChunk
 */
function addPerItemJitCost(
  { base, perChunk, chunkSize }: PerItemCost,
  n: number,
): number {
  const chunks = Math.ceil(n / chunkSize)
  return base + chunks * perChunk
}

/**
 * Select the per-item cost tuple for a Coll based on its element SType.
 * Mirrors `coll_eq_cost` in data_value_comparer.rs:140-158.
 *
 * Sigma-rust dispatches on `CollKind`:
 *  - `NativeColl(CollByte)` → EQ_COLL_BYTE_PER_ITEM
 *  - `WrappedColl { elem_tpe, .. }` → match on SType:
 *    SShort/SInt/SLong/SBoolean/SBigInt/SGroupElement → specific tuples
 *    _ → EQ_COLL_DEFAULT_PER_ITEM
 *
 * In TS, Coll always carries an explicit `elem: SType`. SByte maps to the
 * NativeColl (byte-pack) path in Rust; we treat it the same as BYTE_PER_ITEM.
 */
function collEqPerItemCost(elem: SType): PerItemCost {
  switch (elem.tag) {
    case 'SByte':         return EQ_COLL_BYTE_PER_ITEM
    case 'SShort':        return EQ_COLL_SHORT_PER_ITEM
    case 'SInt':          return EQ_COLL_INT_PER_ITEM
    case 'SLong':         return EQ_COLL_LONG_PER_ITEM
    case 'SBoolean':      return EQ_COLL_BOOLEAN_PER_ITEM
    case 'SBigInt':       return EQ_COLL_BIGINT_PER_ITEM
    case 'SGroupElement': return EQ_COLL_GROUP_ELEMENT_PER_ITEM
    default:              return EQ_COLL_DEFAULT_PER_ITEM
  }
}

/**
 * Structural equality on SType. Same-tag check; for composite types
 * (SColl/SOption/STuple/SFunc) recurse on inner fields. STypeVar compares
 * on name.
 *
 * Used by sValueEquals to compare Coll/Option elem types.
 */
export function sTypeEquals(a: SType, b: SType): boolean {
  if (a.tag !== b.tag) return false
  switch (a.tag) {
    case 'SColl':   return sTypeEquals(a.elem, (b as typeof a).elem)
    case 'SOption': return sTypeEquals(a.elem, (b as typeof a).elem)
    case 'STuple': {
      const tb = b as typeof a
      if (a.items.length !== tb.items.length) return false
      for (let i = 0; i < a.items.length; i++) {
        if (!sTypeEquals(a.items[i]!, tb.items[i]!)) return false
      }
      return true
    }
    case 'SFunc': {
      const fb = b as typeof a
      if (a.args.length !== fb.args.length) return false
      for (let i = 0; i < a.args.length; i++) {
        if (!sTypeEquals(a.args[i]!, fb.args[i]!)) return false
      }
      return sTypeEquals(a.result, fb.result)
    }
    case 'STypeVar': return a.name === (b as typeof a).name
    // All other tags (primitives, SBox, SAvlTree, etc.) — same tag → equal.
    default: return true
  }
}

/**
 * Structural equality on SValue. Recursive across Coll/Tuple/Option.
 * Mirrors sigma-rust's `eq_with_cost` in
 * `ergotree-interpreter/src/eval/data_value_comparer.rs`.
 *
 * Cost model (mirrors sigma-rust's per-type JIT costs):
 *
 *   Boolean/Byte/Short/Int/Long  → EQ_PRIM_COST = 3  (data_value_comparer.rs:15)
 *   BigInt                       → EQ_BIGINT_COST = 5 (data_value_comparer.rs:16)
 *   GroupElement                 → EQ_GROUP_ELEMENT_COST = 172 (line 17)
 *   Tuple                        → EQ_TUPLE_COST = 4 + recursive element costs (line 18)
 *   Option                       → EQ_OPTION_COST = 4 + recursive inner cost if both Some (line 19)
 *   Coll                         → COLL_MATCH_TYPE_COST = 1 always, then if lengths equal:
 *                                   addPerItemJitCost(perItemCost(elem), n) (lines 27, 108-117)
 *   Unit/SigmaProp/Lambda/Context/cross-type → catch-all arm → EQ_PRIM_COST = 3 (lines 130-135)
 *   Box/AvlTree                  → throw 'not-implemented-yet' (runtime shapes land in 2e/2h)
 *
 * Different `kind` → `false` (no cross-type coercion, matching sigma-rust's
 * match-arm posture which returns Ok(false) for cross-type pairs).
 *
 * @param a   Left SValue operand (already evaluated)
 * @param b   Right SValue operand (already evaluated)
 * @param ctx EvalContext for JIT cost accumulation
 */
export function sValueEquals(a: SValue, b: SValue, ctx: EvalContext): boolean {
  // Different kinds → catch-all arm in sigma-rust (lines 131-135): charges
  // EQ_PRIM_COST and then `Ok(lv == rv)` where PartialEq returns false for
  // cross-variant pairs. So: charge EQ_PRIM_COST, return false.
  if (a.kind !== b.kind) {
    ctx.addCost(EQ_PRIM_COST)
    return false
  }

  switch (a.kind) {
    // Primitive comparisons — data_value_comparer.rs:53-60.
    case 'Boolean': ctx.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value
    case 'Byte':    ctx.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value
    case 'Short':   ctx.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value
    case 'Int':     ctx.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value
    case 'Long':    ctx.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value

    // BigInt — data_value_comparer.rs:62-65.
    case 'BigInt':  ctx.addCost(EQ_BIGINT_COST); return a.value === (b as typeof a).value

    // GroupElement — data_value_comparer.rs:67-70.
    case 'GroupElement': {
      ctx.addCost(EQ_GROUP_ELEMENT_COST)
      const ba = a.value
      const bb = (b as typeof a).value
      if (ba.length !== bb.length) return false
      for (let i = 0; i < ba.length; i++) {
        if (ba[i] !== bb[i]) return false
      }
      return true
    }

    // Tuple — data_value_comparer.rs:83-93.
    // EQ_TUPLE_COST + recursive cost per element.
    case 'Tuple': {
      ctx.addCost(EQ_TUPLE_COST)
      const ta = a
      const tb = b as typeof a
      if (ta.items.length !== tb.items.length) return false
      for (let i = 0; i < ta.items.length; i++) {
        if (!sValueEquals(ta.items[i]!, tb.items[i]!, ctx)) return false
      }
      return true
    }

    // Option — data_value_comparer.rs:96-103.
    // EQ_OPTION_COST + recursive inner cost when both Some.
    case 'Option': {
      ctx.addCost(EQ_OPTION_COST)
      const oa = a
      const ob = b as typeof a
      // Sigma-rust match: (None, None) → Ok(true), (Some(l), Some(r)) → recurse,
      // _ → Ok(false). Note: elem type check is NOT done in sigma-rust's eq_with_cost
      // (the match only looks at value presence, not the SType); we mirror that.
      if (oa.value === null && ob.value === null) return true
      if (oa.value === null || ob.value === null) return false
      return sValueEquals(oa.value, ob.value, ctx)
    }

    // Coll — data_value_comparer.rs:105-118.
    case 'Coll': {
      // COLL_MATCH_TYPE_COST always paid (data_value_comparer.rs:108).
      ctx.addCost(COLL_MATCH_TYPE_COST)
      const ca = a
      const cb = b as typeof a
      const n = ca.items.length
      if (n !== cb.items.length) {
        // Length mismatch: early false without per-item cost
        // (data_value_comparer.rs:110-114: "Scala short-circuits on length mismatch
        //  without charging per-item or base cost").
        return false
      }
      // Same length: charge per-item cost, then compare as bulk.
      // Sigma-rust uses `Ok(lv == rv)` which compares the entire Coll at once
      // (Rust PartialEq on CollKind). We mirror by checking element-wise.
      const perItemCost = collEqPerItemCost(ca.elem)
      ctx.addCost(addPerItemJitCost(perItemCost, n))
      // Element-wise comparison (respects same semantics as PartialEq on CollKind).
      for (let i = 0; i < n; i++) {
        if (ca.items[i]!.kind !== cb.items[i]!.kind) return false
        // Fast-path primitive equality without recursive cost charging — sigma-rust's
        // Coll comparison uses PartialEq which does NOT recursively call eq_with_cost.
        // The per-item cost is charged as a single bulk charge above; individual
        // elements are compared via PartialEq, not eq_with_cost.
        if (!primitiveValueEqual(ca.items[i]!, cb.items[i]!)) return false
      }
      return true
    }

    // SigmaProp: byte-equal on canonical wire bytes (serialized via structural walker).
    // Falls into sigma-rust's catch-all `_` arm (line 132): EQ_PRIM_COST + lv == rv.
    // SigmaProp's PartialEq compares the inner SigmaBoolean structurally, which is
    // equivalent to comparing the canonical wire bytes.
    case 'SigmaProp': {
      ctx.addCost(EQ_PRIM_COST)
      const wa = new ByteWriter(); serializeSigmaBoolean(a.value, wa); const ra = wa.toBytes()
      const wb = new ByteWriter(); serializeSigmaBoolean((b as typeof a).value, wb); const rb = wb.toBytes()
      if (ra.length !== rb.length) return false
      for (let i = 0; i < ra.length; i++) {
        if (ra[i] !== rb[i]) return false
      }
      return true
    }

    // Unit: falls into catch-all arm → EQ_PRIM_COST, always equal.
    // sigma-rust: Unit == Unit is true via PartialEq (unit has only one value).
    case 'Unit': {
      ctx.addCost(EQ_PRIM_COST)
      return true
    }

    // Lambda: falls into catch-all arm → EQ_PRIM_COST.
    // Sigma-rust's Lambda values don't implement PartialEq as "equal", so this
    // returns false (PartialEq compares by closure identity, not structural eq).
    // We return false conservatively.
    case 'Lambda': {
      ctx.addCost(EQ_PRIM_COST)
      return false
    }

    // Context: falls into catch-all arm → EQ_PRIM_COST, always equal.
    // Sigma-rust data_value_comparer.rs:130-135: `_ => { ctx.add_jit_cost(EQ_PRIM_COST)?; Ok(lv == rv) }`
    // Value::Context is a unit variant; Context == Context is always true via PartialEq.
    case 'Context': {
      ctx.addCost(EQ_PRIM_COST)
      return true
    }

    // Box, AvlTree: not equality-comparable via BinOp in v0 ErgoScript.
    case 'Box':
    case 'AvlTree':
      throw new EvalError(
        `BinOp.Relation.Eq: ${a.kind} equality not yet implemented in this slice`,
        'not-implemented-yet'
      )

    default: {
      const _exhaust: never = a
      throw new Error(`sValueEquals: unreachable kind ${JSON.stringify(_exhaust)}`)
    }
  }
}

/**
 * Fast-path structural equality for a single SValue without cost charging.
 * Used internally by `sValueEquals` for Coll element comparison, since
 * sigma-rust's Coll equality uses PartialEq (not recursive eq_with_cost).
 *
 * Handles only the primitive variants that appear inside Colls in v0 ErgoScript.
 * For nested composites (nested Coll, Tuple inside Coll, etc.) we fall back
 * to false if kinds mismatch (already checked before call) and recurse for
 * the types that support it.
 *
 * Note: sigma-rust uses `Ok(lv == rv)` for the whole Coll after bulk cost
 * — meaning it doesn't recurse into eq_with_cost per element but uses Rust's
 * structural PartialEq. We mirror this by doing plain value comparison here.
 *
 * This function is also exported for use by SColl.indexOf (`method-call.ts`),
 * which uses `==` (PartialEq) directly in sigma-rust, not `eq_with_cost` — so
 * no cost is charged per comparison in the search loop. Any semantics change
 * here requires coordinating with that handler.
 *
 * Unhandled kinds (Box, AvlTree, Context, Lambda) fall through: Box/AvlTree
 * throw 'not-implemented-yet'; Lambda and Context return `false`/`true`
 * respectively via their explicit arms above. The `default` exhaustiveness arm
 * below covers any future additions.
 */
export function primitiveValueEqual(a: SValue, b: SValue): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'Boolean': return a.value === (b as typeof a).value
    case 'Byte':    return a.value === (b as typeof a).value
    case 'Short':   return a.value === (b as typeof a).value
    case 'Int':     return a.value === (b as typeof a).value
    case 'Long':    return a.value === (b as typeof a).value
    case 'BigInt':  return a.value === (b as typeof a).value
    case 'Unit':    return true
    case 'GroupElement': {
      const ba = a.value, bb = (b as typeof a).value
      if (ba.length !== bb.length) return false
      for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) return false
      return true
    }
    case 'SigmaProp': {
      const wa = new ByteWriter(); serializeSigmaBoolean(a.value, wa); const ra = wa.toBytes()
      const wb = new ByteWriter(); serializeSigmaBoolean((b as typeof a).value, wb); const rb = wb.toBytes()
      if (ra.length !== rb.length) return false
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return false
      return true
    }
    case 'Coll': {
      const ca = a, cb = b as typeof a
      if (ca.items.length !== cb.items.length) return false
      for (let i = 0; i < ca.items.length; i++) {
        if (!primitiveValueEqual(ca.items[i]!, cb.items[i]!)) return false
      }
      return true
    }
    case 'Tuple': {
      const ta = a, tb = b as typeof a
      if (ta.items.length !== tb.items.length) return false
      for (let i = 0; i < ta.items.length; i++) {
        if (!primitiveValueEqual(ta.items[i]!, tb.items[i]!)) return false
      }
      return true
    }
    case 'Option': {
      const oa = a, ob = b as typeof a
      if (oa.value === null && ob.value === null) return true
      if (oa.value === null || ob.value === null) return false
      return primitiveValueEqual(oa.value, ob.value)
    }
    case 'Lambda': return false
    // Context: unit variant, always equal (mirrors catch-all in data_value_comparer.rs:130-135).
    case 'Context': return true
    case 'Box':
    case 'AvlTree':
      throw new EvalError(
        `sValueEquals inner Coll: ${a.kind} equality not yet implemented`,
        'not-implemented-yet'
      )
    default: {
      const _exhaust: never = a
      throw new Error(`primitiveValueEqual: unreachable kind ${JSON.stringify(_exhaust)}`)
    }
  }
}

export function evalRelationOp(e: BinOp, env: Env, ctx: EvalContext): SValue {
  if (e.op.kind !== 'Relation') throw new Error('evalRelationOp: wrong kind')
  const op: RelationOp = e.op.op

  // Eq / NEq: eval left → eval right → call sValueEquals (which charges cost).
  // No envelope cost — sigma-rust bin_op.rs:205 match arm is empty for Eq/NEq;
  // all JIT cost is charged INSIDE sValueEquals (mirrors data_value_comparer.rs).
  if (op === 'Eq' || op === 'NEq') {
    const left = evalExpr(e.left, env, ctx)
    const right = evalExpr(e.right, env, ctx)
    const eq = sValueEquals(left, right, ctx)
    return { kind: 'Boolean', value: op === 'Eq' ? eq : !eq }
  }

  // Step 1: eval left operand first (sigma-rust bin_op.rs:190).
  const left = evalExpr(e.left, env, ctx)
  if (!isNumeric(left.kind)) {
    throw new EvalError(
      `BinOp.Relation.${op}: non-numeric left operand kind ${left.kind}`,
      'bin-op-not-numeric'
    )
  }

  // Step 2: charge envelope cost AFTER left-eval (sigma-rust bin_op.rs:205-211).
  ctx.addCost(RELATION_ORDERING_COST)

  // Step 3: eval right operand.
  const right = evalExpr(e.right, env, ctx)
  if (!isNumeric(right.kind)) {
    throw new EvalError(
      `BinOp.Relation.${op}: non-numeric right operand kind ${right.kind}`,
      'bin-op-not-numeric'
    )
  }
  if (left.kind !== right.kind) {
    throw new EvalError(
      `BinOp.Relation.${op}: kind mismatch ${left.kind} vs ${right.kind}`,
      'bin-op-kind-mismatch'
    )
  }

  const a = valueToBigInt(left)
  const b = valueToBigInt(right)

  // op is narrowed to 'Lt' | 'Le' | 'Gt' | 'Ge' here (Eq/NEq already handled above).
  // The _exhaust default provides compile-time exhaustiveness over the full RelationOp union
  // in case future variants are added.
  let result: boolean
  switch (op) {
    case 'Lt': result = a < b;  break
    case 'Le': result = a <= b; break
    case 'Gt': result = a > b;  break
    case 'Ge': result = a >= b; break
    default: {
      const _exhaust: never = op
      throw new Error(`evalRelationOp ordering: unreachable op ${JSON.stringify(_exhaust)}`)
    }
  }
  return { kind: 'Boolean', value: result }
}
