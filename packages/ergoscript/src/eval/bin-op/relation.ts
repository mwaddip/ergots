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
import type { BinOp, SValue, RelationOp, SType, ErgoBox, AvlTreeData, PreHeader } from '../../mir/types'
import type { Header } from '@ergots/scorex'
import { sTypeEquals as sTypeEqualsHelper } from '../../mir/stype-helpers'
import type { Env } from '../env'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'
import { evalExpr } from '../eval'
import { isNumeric, valueToBigInt, bigIntToValue, widerKind, upcastCost } from './_numeric'
import { compareUBI } from './_ubi-binop'
import {
  equalSigmaBooleanCosted,
  sigmaBooleanStructuralEq,
  ecPointEqual,
  MATCH_TYPE_COST,
  EQ_GROUP_ELEMENT_COST,
} from './_sigma-boolean-eq'

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
 * Per-type equality costs for the composite kinds. Mirrors sigma-rust
 * `ergotree-interpreter/src/eval/data_value_comparer.rs` constants
 * (declared at top of the module): each underlying type derives
 * `PartialEq` and the comparer arm charges its constant once then does
 * `Ok(lv == rv)`.
 */
const EQ_BOX_COST = 6
const EQ_AVL_TREE_COST = 6
const EQ_PREHEADER_COST = 4
const EQ_HEADER_COST = 6

/** Byte-by-byte Uint8Array equality. Pure helper. */
function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Positional Vec<Token>-style equality. Mainnet stores tokens in deterministic
 * order (sigma-rust `BoxTokens: BoundedVec<Token, 1, 255>`); we mirror the
 * positional PartialEq.
 */
function tokensEqual(a: ErgoBox['tokens'], b: ErgoBox['tokens']): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!bytesEq(a[i]!.id, b[i]!.id)) return false
    if (a[i]!.amount !== b[i]!.amount) return false
  }
  return true
}

/**
 * NonMandatoryRegisters equality. Sigma-rust's `NonMandatoryRegisters` is
 * `Vec<RegisterValue>` (positional); mainnet always stores registers
 * contiguously from R4 in ascending key order, so iterating R4..R9 and
 * checking presence + value + tpe equality at each slot is logically
 * equivalent to the underlying Vec PartialEq.
 *
 * tpe equality is checked because sigma-rust's RegisterValue is a Constant
 * (tpe + bytes); two registers with the same SValue shape but different
 * declared STypes are NOT structurally equal in sigma-rust.
 */
function registersEqual(a: ErgoBox['registers'], b: ErgoBox['registers']): boolean {
  for (let k = 4; k <= 9; k++) {
    const ra = a[k]
    const rb = b[k]
    if (ra === undefined && rb === undefined) continue
    if (ra === undefined || rb === undefined) return false
    if (!sTypeEqualsHelper(ra.tpe, rb.tpe)) return false
    if (!primitiveValueEqual(ra.value, rb.value)) return false
  }
  return true
}

/**
 * Structural ErgoBox equality. Sigma-rust derives PartialEq on the struct
 * (`chain/ergo_box.rs`); we compare each field. `box_id` is skipped: it's a
 * cached blake2b256 of the sigma-serialized bytes, so equal-other-fields
 * boxes have equal box_ids by construction.
 */
function boxEqual(a: ErgoBox, b: ErgoBox): boolean {
  if (a.value !== b.value) return false
  if (!bytesEq(a.ergoTreeBytes, b.ergoTreeBytes)) return false
  if (!tokensEqual(a.tokens, b.tokens)) return false
  if (!registersEqual(a.registers, b.registers)) return false
  if (a.creationHeight !== b.creationHeight) return false
  if (!bytesEq(a.txId, b.txId)) return false
  if (a.index !== b.index) return false
  return true
}

/**
 * Structural AvlTreeData equality (sigma-rust `mir/avl_tree_data.rs`
 * derived PartialEq). `valueLengthOpt: number | null` — `null === null`
 * for the None case; numeric `===` otherwise.
 */
function avlTreeEqual(a: AvlTreeData, b: AvlTreeData): boolean {
  if (!bytesEq(a.digest, b.digest)) return false
  if (a.treeFlags !== b.treeFlags) return false
  if (a.keyLength !== b.keyLength) return false
  if (a.valueLengthOpt !== b.valueLengthOpt) return false
  return true
}

/**
 * AutolykosSolution equality (sigma-rust `ergo-chain-types/src/header.rs`).
 * `powOnetimePk: Uint8Array | null` (v1-only field) — null-vs-null match,
 * bytes-equal otherwise. `powDistance: bigint | null` — bigint `===`
 * compares value-equal; null cases handled identically.
 */
function autolykosSolutionEqual(
  a: Header['autolykosSolution'],
  b: Header['autolykosSolution']
): boolean {
  if (!bytesEq(a.minerPk, b.minerPk)) return false
  if ((a.powOnetimePk === null) !== (b.powOnetimePk === null)) return false
  if (a.powOnetimePk !== null && b.powOnetimePk !== null) {
    if (!bytesEq(a.powOnetimePk, b.powOnetimePk)) return false
  }
  if (!bytesEq(a.nonce, b.nonce)) return false
  if (a.powDistance !== b.powDistance) return false
  return true
}

/** Structural PreHeader equality (sigma-rust `ergo-chain-types/src/preheader.rs`). */
function preHeaderEqual(a: PreHeader, b: PreHeader): boolean {
  if (a.version !== b.version) return false
  if (!bytesEq(a.parentId, b.parentId)) return false
  if (a.timestamp !== b.timestamp) return false
  if (a.nBits !== b.nBits) return false
  if (a.height !== b.height) return false
  if (!bytesEq(a.minerPk, b.minerPk)) return false
  if (!bytesEq(a.votes, b.votes)) return false
  return true
}

/**
 * Structural Header equality (sigma-rust `ergo-chain-types/src/header.rs`
 * derived PartialEq across all 13 fields). `id` IS included (sigma-rust
 * compares it; it's a stored cache of the hash, but comparing it costs
 * little and matches the derive(PartialEq) field-by-field shape).
 */
function headerEqual(a: Header, b: Header): boolean {
  if (a.version !== b.version) return false
  if (!bytesEq(a.id, b.id)) return false
  if (!bytesEq(a.parentId, b.parentId)) return false
  if (!bytesEq(a.adProofsRoot, b.adProofsRoot)) return false
  if (!bytesEq(a.stateRoot, b.stateRoot)) return false
  if (!bytesEq(a.transactionRoot, b.transactionRoot)) return false
  if (a.timestamp !== b.timestamp) return false
  if (a.nBits !== b.nBits) return false
  if (a.height !== b.height) return false
  if (!bytesEq(a.extensionRoot, b.extensionRoot)) return false
  if (!autolykosSolutionEqual(a.autolykosSolution, b.autolykosSolution)) return false
  if (!bytesEq(a.votes, b.votes)) return false
  if (!bytesEq(a.unparsedBytes, b.unparsedBytes)) return false
  return true
}

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
/** data_value_comparer.rs:38 `EQ_COLL_AVL_TREE_PER_ITEM: (u32, u32, u32) = (15, 5, 2)` */
const EQ_COLL_AVL_TREE_PER_ITEM: PerItemCost = { base: 15, perChunk: 5, chunkSize: 2 }
/** data_value_comparer.rs:39 `EQ_COLL_BOX_PER_ITEM: (u32, u32, u32) = (15, 5, 1)` */
const EQ_COLL_BOX_PER_ITEM: PerItemCost = { base: 15, perChunk: 5, chunkSize: 1 }
/** data_value_comparer.rs:40 `EQ_COLL_PREHEADER_PER_ITEM: (u32, u32, u32) = (15, 3, 1)` */
const EQ_COLL_PREHEADER_PER_ITEM: PerItemCost = { base: 15, perChunk: 3, chunkSize: 1 }
/** data_value_comparer.rs:41 `EQ_COLL_HEADER_PER_ITEM: (u32, u32, u32) = (15, 5, 1)` */
const EQ_COLL_HEADER_PER_ITEM: PerItemCost = { base: 15, perChunk: 5, chunkSize: 1 }
/** data_value_comparer.rs:42 `EQ_COLL_DEFAULT_PER_ITEM: (u32, u32, u32) = (10, 2, 1)` — for
 *  all other elem types (Tuple, Option, nested Coll, etc.). */
const EQ_COLL_DEFAULT_PER_ITEM: PerItemCost = { base: 10, perChunk: 2, chunkSize: 1 }

/**
 * Mirror of `add_per_item_jit_cost(base, per_chunk, chunk_size, n_items)` from
 * ergotree-ir/src/chain/context.rs.
 *
 * Formula: base + chunks(n) * perChunk, where chunks(n) mirrors Scala consensus
 * PerItemCost.chunks = (n-1)/chunkSize + 1 with signed toward-zero division
 * (sigma-rust commit f6b2dd7f). Equals ceil(n/cs) for n>=1; differs only at n=0,
 * where a chunkSize>=2 element still costs one chunk. Must stay in lockstep with
 * EvalContext.addPerItemCost (the shared primitive) — both are the same formula.
 */
function addPerItemJitCost(
  { base, perChunk, chunkSize }: PerItemCost,
  n: number,
): number {
  const chunks = Math.max(0, Math.trunc((n - 1) / chunkSize) + 1)
  return base + chunks * perChunk
}

/**
 * Select the per-item cost tuple for a Coll based on its element SType.
 * Mirrors `coll_eq_cost` in data_value_comparer.rs:140-158.
 *
 * Sigma-rust dispatches on `CollKind`:
 *  - `NativeColl(CollByte)` → EQ_COLL_BYTE_PER_ITEM
 *  - `WrappedColl { elem_tpe, .. }` → match on SType:
 *    SShort/SInt/SLong/SBoolean/SBigInt/SGroupElement/SAvlTree/SBox/
 *    SPreHeader/SHeader → specific tuples
 *    _ → EQ_COLL_DEFAULT_PER_ITEM
 *
 * In TS, Coll always carries an explicit `elem: SType`. SByte maps to the
 * NativeColl (byte-pack) path in Rust; we treat it the same as BYTE_PER_ITEM.
 *
 * Iter-20: the SAvlTree/SBox/SPreHeader/SHeader arms were originally missing
 * (fell through to DEFAULT), causing a cost-drift on `Coll[SAvlTree]` equality
 * at mainnet h=972,275. SUnsignedBigInt (v6, P2c) maps to EQ_COA_BigInt (same
 * constant as SBigInt), handled by the explicit arm below.
 */
function collEqPerItemCost(elem: SType): PerItemCost {
  switch (elem.tag) {
    case 'SByte':         return EQ_COLL_BYTE_PER_ITEM
    case 'SShort':        return EQ_COLL_SHORT_PER_ITEM
    case 'SInt':          return EQ_COLL_INT_PER_ITEM
    case 'SLong':         return EQ_COLL_LONG_PER_ITEM
    case 'SBoolean':      return EQ_COLL_BOOLEAN_PER_ITEM
    case 'SBigInt':       return EQ_COLL_BIGINT_PER_ITEM
    case 'SUnsignedBigInt': return EQ_COLL_BIGINT_PER_ITEM // mirror BigInt (EQ_COA_BigInt)
    case 'SGroupElement': return EQ_COLL_GROUP_ELEMENT_PER_ITEM
    case 'SAvlTree':      return EQ_COLL_AVL_TREE_PER_ITEM
    case 'SBox':          return EQ_COLL_BOX_PER_ITEM
    case 'SPreHeader':    return EQ_COLL_PREHEADER_PER_ITEM
    case 'SHeader':       return EQ_COLL_HEADER_PER_ITEM
    default:              return EQ_COLL_DEFAULT_PER_ITEM
  }
}

/**
 * Whether a Coll element type is a COA (CollOverArray) leaf — the types JVM
 * `equalColls_Dispatch` (DataValueComparer.scala:201-238) bulk-compares via
 * `equalCOA_Prim` (NO recursion). Everything else (Coll/Tuple/Option/SigmaProp —
 * the `collEqPerItemCost` default arm) falls to JVM's generic `equalColls`, which
 * RECURSES `equalDataValues` per element, charging the nested MatchType + per-item.
 * The COA set is exactly the explicit (non-default) arms of `collEqPerItemCost`.
 */
function isCoaCollElem(elem: SType): boolean {
  switch (elem.tag) {
    case 'SByte': case 'SShort': case 'SInt': case 'SLong': case 'SBoolean':
    case 'SBigInt': case 'SUnsignedBigInt': case 'SGroupElement': case 'SAvlTree': case 'SBox':
    case 'SPreHeader': case 'SHeader':
      return true
    default:
      return false
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
 *   Unit/Lambda/Context/cross-type → catch-all arm → EQ_PRIM_COST = 3 (lines 130-135)
 *   SigmaProp → MatchType(1) + recursive SigmaBoolean walk (_sigma-boolean-eq.ts; JVM DataValueComparer.scala:253-282,353-361) — F3
 *   Box/AvlTree/PreHeader/Header → throw 'not-implemented-yet' (runtime shapes land in 2e/2h)
 *
 * Different `kind` → `false` (no cross-type coercion, matching sigma-rust's
 * match-arm posture which returns Ok(false) for cross-type pairs).
 *
 * Cost-charging is conditional on `ctx` being present. With `ctx` (the costed
 * `sValueEquals` wrapper, used by the Eq/NEq BinOp arm) every per-type EQ cost is
 * charged exactly as before. Without `ctx` (the cost-free `sValueStructuralEq`
 * wrapper, used by SColl.startsWith/endsWith — uncosted Scala ops on the JVM) the
 * boolean result is IDENTICAL but NO cost is charged. Cost is the ONLY use of
 * `ctx` in this core; the boolean logic is byte-for-byte unchanged either way.
 *
 * @param a   Left SValue operand (already evaluated)
 * @param b   Right SValue operand (already evaluated)
 * @param ctx Optional EvalContext for JIT cost accumulation; omitted = cost-free
 */
function compareSValues(a: SValue, b: SValue, ctx?: EvalContext): boolean {
  // Different kinds → catch-all arm in sigma-rust (lines 131-135): charges
  // EQ_PRIM_COST and then `Ok(lv == rv)` where PartialEq returns false for
  // cross-variant pairs. So: charge EQ_PRIM_COST, return false.
  if (a.kind !== b.kind) {
    ctx?.addCost(EQ_PRIM_COST)
    return false
  }

  switch (a.kind) {
    // Primitive comparisons — data_value_comparer.rs:53-60.
    case 'Boolean': ctx?.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value
    case 'Byte':    ctx?.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value
    case 'Short':   ctx?.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value
    case 'Int':     ctx?.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value
    case 'Long':    ctx?.addCost(EQ_PRIM_COST); return a.value === (b as typeof a).value

    // BigInt — data_value_comparer.rs:62-65.
    case 'BigInt':  ctx?.addCost(EQ_BIGINT_COST); return a.value === (b as typeof a).value

    // GroupElement — DataValueComparer.scala:340-341 / :294-300.
    // addFixedCost(EQ_GroupElement=172) charged unconditionally (flat, no MatchType
    // wrapper at this arm), then equalGroupElement — object equality on parsed points.
    // JVM GroupElementSerializer parses any 0x00-lead to THE identity object, so two
    // identity encodings with different tail bytes compare equal (sigma-rust ec_point.rs
    // :139-151 mirrors this). Route through ecPointEqual for the identity class.
    case 'GroupElement': {
      ctx?.addCost(EQ_GROUP_ELEMENT_COST)
      return ecPointEqual(a.value, (b as typeof a).value)
    }

    // Tuple — data_value_comparer.rs:83-93.
    // EQ_TUPLE_COST + recursive cost per element.
    case 'Tuple': {
      ctx?.addCost(EQ_TUPLE_COST)
      const ta = a
      const tb = b as typeof a
      if (ta.items.length !== tb.items.length) return false
      for (let i = 0; i < ta.items.length; i++) {
        if (!compareSValues(ta.items[i]!, tb.items[i]!, ctx)) return false
      }
      return true
    }

    // Option — data_value_comparer.rs:96-103.
    // EQ_OPTION_COST + recursive inner cost when both Some.
    case 'Option': {
      ctx?.addCost(EQ_OPTION_COST)
      const oa = a
      const ob = b as typeof a
      // Sigma-rust match: (None, None) → Ok(true), (Some(l), Some(r)) → recurse,
      // _ → Ok(false). Note: elem type check is NOT done in sigma-rust's eq_with_cost
      // (the match only looks at value presence, not the SType); we mirror that.
      if (oa.value === null && ob.value === null) return true
      if (oa.value === null || ob.value === null) return false
      return compareSValues(oa.value, ob.value, ctx)
    }

    // Coll — data_value_comparer.rs:105-118.
    case 'Coll': {
      // COLL_MATCH_TYPE_COST always paid (data_value_comparer.rs:108).
      ctx?.addCost(COLL_MATCH_TYPE_COST)
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
      ctx?.addCost(addPerItemJitCost(perItemCost, n))
      // Element comparison. JVM `equalColls_Dispatch`: COA leaf-element colls are
      // bulk-compared (equalCOA_Prim, no recursion — the per-item cost above is
      // the whole charge); COMPOSITE-element colls (Coll/Tuple/Option/SigmaProp)
      // RECURSE via equalDataValues per element, charging the nested MatchType +
      // per-item. Our prior code bulk-compared ALL elements via the non-recursive
      // primitiveValueEqual (mirroring sigma-rust's PartialEq) — under-charging
      // nested colls/tuples by the inner recursion vs JVM. sigma-rust shares it.
      // Routed to the sigma-rust session in santa §B4. JVM is canonical.
      const recurseElems = !isCoaCollElem(ca.elem)
      for (let i = 0; i < n; i++) {
        if (recurseElems) {
          // compareSValues charges the nested MatchType + per-item (and short-
          // circuits on inner length mismatch, matching JVM).
          if (!compareSValues(ca.items[i]!, cb.items[i]!, ctx)) return false
        } else {
          if (ca.items[i]!.kind !== cb.items[i]!.kind) return false
          if (!primitiveValueEqual(ca.items[i]!, cb.items[i]!)) return false
        }
      }
      return true
    }

    // SigmaProp — JVM DataValueComparer.scala:353-361: MatchType for the
    // SigmaProp dispatch, then equalSigmaBoolean walks the tree (MatchType
    // per node + EQ_GroupElement per ECPoint compared, && short-circuit;
    // conjecture-left vs different-variant-right THROWS, mirroring the JVM
    // sys.error :278-281). Replaces the flat EQ_PRIM_COST byte-compare
    // (sigma-rust catch-all posture) — F3 root cause #1; blessed vectors
    // EQ_of_SigmaProp{,_unequal} pin all three cost classes. The cost-free
    // path (sValueStructuralEq — JVM's uncosted Scala ==) compares
    // structurally with NO throw.
    case 'SigmaProp': {
      const rv = (b as typeof a).value
      if (ctx) {
        ctx.addCost(MATCH_TYPE_COST)
        return equalSigmaBooleanCosted(a.value, rv, ctx)
      }
      return sigmaBooleanStructuralEq(a.value, rv)
    }

    // Unit: falls into catch-all arm → EQ_PRIM_COST, always equal.
    // sigma-rust: Unit == Unit is true via PartialEq (unit has only one value).
    case 'Unit': {
      ctx?.addCost(EQ_PRIM_COST)
      return true
    }

    // Lambda: falls into catch-all arm → EQ_PRIM_COST.
    // Sigma-rust's Lambda values don't implement PartialEq as "equal", so this
    // returns false (PartialEq compares by closure identity, not structural eq).
    // We return false conservatively.
    case 'Lambda': {
      ctx?.addCost(EQ_PRIM_COST)
      return false
    }

    // Context: falls into catch-all arm → EQ_PRIM_COST, always equal.
    // Sigma-rust data_value_comparer.rs:130-135: `_ => { ctx.add_jit_cost(EQ_PRIM_COST)?; Ok(lv == rv) }`
    // Value::Context is a unit variant; Context == Context is always true via PartialEq.
    case 'Context': {
      ctx?.addCost(EQ_PRIM_COST)
      return true
    }

    // Global: unit variant (mirrors Context arm above). Value::Global == Value::Global
    // is always true via PartialEq (sigma-rust catch-all arm in data_value_comparer.rs).
    case 'Global': {
      ctx?.addCost(EQ_PRIM_COST)
      return true
    }

    // Box / AvlTree / PreHeader / Header — structural equality via field-by-field
    // compare, mirroring Rust derive(PartialEq) on each underlying type. Per-type
    // cost charged once before the recursive walk (data_value_comparer.rs:73-128).
    // First mainnet trigger: h=448,658 tx 1 input 0 (Coll[Box] equality).
    case 'Box': {
      ctx?.addCost(EQ_BOX_COST)
      return boxEqual(a.value, (b as typeof a).value)
    }
    case 'AvlTree': {
      ctx?.addCost(EQ_AVL_TREE_COST)
      return avlTreeEqual(a.value, (b as typeof a).value)
    }
    case 'PreHeader': {
      ctx?.addCost(EQ_PREHEADER_COST)
      return preHeaderEqual(a.value, (b as typeof a).value)
    }
    case 'Header': {
      ctx?.addCost(EQ_HEADER_COST)
      return headerEqual(a.value, (b as typeof a).value)
    }

    case 'String': {
      // SString equality is primitive (JS string compare). Iter-17 added
      // SValue.String for output-roundtrip parity; mainnet rarely exercises
      // String-equality at eval time, but it must compile and behave correctly.
      ctx?.addCost(EQ_PRIM_COST)
      return a.value === (b as typeof a).value
    }

    // UnsignedBigInt — mirrors BigInt (JVM descriptors map both to EQ_BigInt).
    case 'UnsignedBigInt': ctx?.addCost(EQ_BIGINT_COST); return a.value === (b as typeof a).value

    default: {
      const _exhaust: never = a
      throw new Error(`compareSValues: unreachable kind ${JSON.stringify(_exhaust)}`)
    }
  }
}

/**
 * Costed structural equality (the Eq/NEq BinOp arm). `ctx` REQUIRED — charges
 * the per-type EQ costs. Behavior unchanged from before the P3 refactor.
 */
export function sValueEquals(a: SValue, b: SValue, ctx: EvalContext): boolean {
  return compareSValues(a, b, ctx)
}

/**
 * Cost-free structural equality (SColl.startsWith/endsWith, v6 P3). Same boolean
 * result as sValueEquals but charges NO cost — the JVM's Coll.startsWith/endsWith
 * are uncosted Scala ops (only the Zip envelope is charged by the caller).
 */
export function sValueStructuralEq(a: SValue, b: SValue): boolean {
  return compareSValues(a, b)
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
 * Real callers: Coll bulk-element compare in the `compareSValues` Coll arm
 * (the COA/non-recursive element path), and `registersEqual` for box-register
 * equality. SColl.indexOf uses the COSTED `sValueEquals` (`method-call.ts:414`,
 * JVM `equalDataValues` at `methods.scala:1091`) — not this function.
 *
 * Unhandled kinds (Box, AvlTree, PreHeader, Header, Context, Lambda) fall through:
 * Box/AvlTree/PreHeader/Header throw 'not-implemented-yet'; Lambda and Context
 * return `false`/`true` respectively via their explicit arms above. The `default` exhaustiveness arm
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
    // GroupElement: identity class applies (0x00-lead → identity, tails dead).
    // JVM GroupElementSerializer parse-to-identity + DataValueComparer.scala:294-300.
    case 'GroupElement':
      return ecPointEqual(a.value, (b as typeof a).value)
    case 'SigmaProp':
      // Scala case-class == (uncosted — box-register / Coll-bulk path):
      // structural walk with identity-class ECPoint semantics, NO
      // conjecture-mismatch throw.
      return sigmaBooleanStructuralEq(a.value, (b as typeof a).value)
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
    // Global: unit variant, always equal (same catch-all arm as Context in sigma-rust).
    case 'Global': return true
    // Box / AvlTree / PreHeader / Header inside Coll — same structural compare
    // as the top-level sValueEquals arms, but WITHOUT cost charging (sigma-rust's
    // Coll PartialEq is a single bulk-cost charge above, with element compare
    // via PartialEq not eq_with_cost). Mirrors the iter-7 fix shape.
    case 'Box':
      return boxEqual(a.value, (b as typeof a).value)
    case 'AvlTree':
      return avlTreeEqual(a.value, (b as typeof a).value)
    case 'PreHeader':
      return preHeaderEqual(a.value, (b as typeof a).value)
    case 'Header':
      return headerEqual(a.value, (b as typeof a).value)
    case 'String':
      return a.value === (b as typeof a).value
    case 'UnsignedBigInt':
      return a.value === (b as typeof a).value
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
    let left = evalExpr(e.left, env, ctx)
    let right = evalExpr(e.right, env, ctx)
    // Mismatched-numeric equality: the JVM deserializer auto-upcasts the narrower
    // operand to the wider for pre-V3 ErgoTree versions (equalityOp → applyUpcast,
    // SigmaBuilder.scala:679-686,750-756), so e.g. EQ(Int 5, Long 5) compares as
    // Long → true. Charge the one inserted Upcast and coerce both operands to the
    // wider kind so sValueEquals sees same-kind values (and charges the wider eq
    // rate: EQ_PRIM 3 / EQ_BIGINT 5; the already-wider operand round-trips
    // unchanged). For V3+ the deserializer rejects this via its SameType check;
    // ergots' V3+ residual (cross-kind → false) is the deferred mechanism #2.
    if (
      (ctx.treeVersion ?? 0) < 3 &&
      isNumeric(left.kind) &&
      isNumeric(right.kind) &&
      left.kind !== right.kind
    ) {
      const wider = widerKind(left.kind, right.kind)
      ctx.addCost(upcastCost(wider))
      left = bigIntToValue(wider, valueToBigInt(left))
      right = bigIntToValue(wider, valueToBigInt(right))
    }
    const eq = sValueEquals(left, right, ctx)
    return { kind: 'Boolean', value: op === 'Eq' ? eq : !eq }
  }

  // Step 1: eval left operand first (sigma-rust bin_op.rs:190).
  const left = evalExpr(e.left, env, ctx)

  // UBI ordering — routed locally, before the isNumeric guard (P2b Critical 1).
  // Both operands must be UBI; ordering cost is the flat 20 (spec §3).
  if (left.kind === 'UnsignedBigInt') {
    ctx.addCost(RELATION_ORDERING_COST)
    const right = evalExpr(e.right, env, ctx)
    if (right.kind !== 'UnsignedBigInt') {
      throw new EvalError(
        `BinOp.Relation.${op}: UnsignedBigInt operand requires an UnsignedBigInt other operand, got '${right.kind}'`,
        'bin-op-kind-mismatch',
      )
    }
    return { kind: 'Boolean', value: compareUBI(op, left.value, right.value) }
  }

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
    // Mismatched-numeric ordering. The JVM deserializer auto-upcasts the
    // narrower operand to the wider — but ONLY for pre-V3 ErgoTree versions
    // (DeserializationSigmaBuilder.applyUpcast, SigmaBuilder.scala:750-756,
    // gated by ergoTreeVersion < 3; comparisonOp also runs a SameType check
    // that rejects the raw mismatch at deserialize-time for V3+). Both operands
    // are already known numeric here. For V3+ keep rejecting.
    if ((ctx.treeVersion ?? 0) >= 3) {
      throw new EvalError(
        `BinOp.Relation.${op}: kind mismatch ${left.kind} vs ${right.kind}`,
        'bin-op-kind-mismatch'
      )
    }
    // pre-V3: charge the one inserted Upcast (10/30 by target). The comparison
    // itself is width-independent (computed via bigint below), so the result is
    // unchanged and RELATION_ORDERING_COST (fixed 20) does not vary with kind.
    ctx.addCost(upcastCost(widerKind(left.kind, right.kind)))
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
