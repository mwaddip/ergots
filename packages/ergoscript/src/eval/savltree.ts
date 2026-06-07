/**
 * `SAvlTree.*` method-call handlers — phase 2h-b Tier 1 (pure accessors) +
 * Tier 2 (verification ops, JVM-canonical cost model from F4).
 *
 * ## Tier 1 — pure accessors (updateOperations 45; updateDigest 40; all others 15)
 *
 * Handlers: digest / enabledOperations / keyLength / valueLengthOpt /
 * isInsertAllowed / isUpdateAllowed / isRemoveAllowed / updateOperations /
 * updateDigest. Each projects a field of `AvlTreeData` and never reaches into
 * `@ergots/avltree`. All follow Pattern A: `ctx.addCost(N)` BEFORE shape check,
 * mirroring sigma-rust's `add_jit_cost` at the top of every Tier-1 `EvalFn`.
 *
 * ## Tier 2 — lookup family (contains / get / getMany, F4)
 *
 * JVM cost model (CErgoTreeEvaluator.scala:67-130, methods.scala:1498-1516):
 *   1. CreateAvlVerifier_Info — PerItem(110, 20, 64) on `proof.length`, charged
 *      BEFORE construction. Outcome-independent (charged even on construct failure).
 *   2. LookupAvlTree_Info — PerItem(40, 10, 1) × chargedOps on RAW `digest[32]`
 *      tree height (no max-1 floor); `contains`/`get` always charge ×1;
 *      `getMany` charges ×chargedOps (see helper above).
 *
 * Failure model (JVM-canonical, F4) — construct failure is NOT a distinct
 * observable: scorex BatchAVLVerifier swallows reconstruction errors (topNode =
 * None); every subsequent op returns Failure, which joins the per-op-failure
 * routing:
 *   - `contains` — construct-fail and per-op-fail BOTH → false (NEVER throws).
 *   - `get` — construct-fail and per-op-fail BOTH → throw 'avl-tree-proof-failed'.
 *   - `getMany` — construct-fail + ops.length > 0 → throw same code;
 *                 construct-fail + ops.length == 0 → empty Coll (keys.map over
 *                 empty coll runs zero lookups — no Failure surfaces).
 *
 * ## Tier 2 — modify family (insert / update / remove / insertOrUpdate)
 *
 * JVM cost model (CErgoTreeEvaluator.scala:132-254, F4):
 *   insert/update/remove/insertOrUpdate: isXxxAllowed Fixed(15) [insertOrUpdate:
 *   isUpdateAllowed(15) + isInsertAllowed(15)] + createVerifier PerItem(110,20,64)
 *   + per-op PerItemCost × max(treeHeight,1) + updateDigest Fixed(40) on success.
 *   insert: InsertIntoAvlTree(40,10,1) × chargedOps; update: UpdateAvlTree(120,20,1) × chargedOps;
 *   remove: RemoveAvlTree(100,15,1) × ALL ops (cfor, no break) + digest Fixed(15) unconditional;
 *   insertOrUpdate (V3-gated): shares update's UpdateAvlTree(120,20,1) descriptor × chargedOps.
 *   Failure model — insert(V<3):throw/(V3+):None; update:None; remove:None (never throws);
 *   insertOrUpdate:None (V<3 rejected at dispatcher). ALL DONE (F4 Tasks 3-6).
 *
 * ## Known pre-existing limitation
 *
 * Shape-mismatch inputs (e.g. key length ≠ tree.keyLength) currently surface as
 * `AvlVerifyError` from `@ergots/avltree`'s pre-validation — a known pre-existing
 * divergence class under verification in F4 Task 7.5 (scorex per-op semantics to
 * be confirmed vs JVM source).
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:29-75 (Tier 1),
 *         ergotree-interpreter/src/eval/savltree.rs:104-381,383-439
 *         (Tier 2; see per-handler comments for line ranges).
 *         CErgoTreeEvaluator.scala:67-254, methods.scala:1498-1516,
 *         docs/specs/2026-06-07-ergoscript-f4-avltree-tier2-cost-design.md.
 *
 * Defensive-throw `'avl-tree-obj-not-avl-tree'` on non-AvlTree receiver.
 * Wire-format invariants (PropertyCall construction; SAvlTree-typed Const)
 * make this unreachable for parser-produced trees — guard against
 * hand-crafted MIR or future `ConstantPlaceholder` injection.
 *
 * facts/ergoscript-eval.md: Method-handler registry rows 9-21.
 */

import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import type { AvlTreeData, SType, SValue } from '../mir/types'
import { bytesToCollByteSValue } from './_byte-coll'
import { verifyAvlBatchPartial } from '@ergots/avltree'
import {
  avlTreeDataToConfig,
  buildInsertOps,
  buildInsertOrUpdateOps,
  buildLookupOps,
  buildRemoveOps,
  buildSingleLookupOp,
  buildUpdateOps,
  extractByteArrayList,
  extractBytes,
  withUpdatedDigest,
  withUpdatedFlags,
} from './_avltree-adapter'

/** Cost charged Pattern A by every SAvlTree accessor; source: savltree.rs:29..75. */
const ACCESSOR_COST = 15

/** Module-level `Option[Int]` element type, reused by `valueLengthOpt`. */
const SINT_TYPE: SType = { tag: 'SInt' }

/**
 * Common Pattern A entry — narrow `SValue` to AvlTree. All Tier-1 accessors
 * call this, so any future receiver-shape divergence (e.g. wrapping AvlTreeData
 * in a synthetic context) needs to be edited in one place.
 *
 * Mirrors `obj.try_extract_into::<AvlTreeData>()` in sigma-rust — that call
 * is infallible for parser-produced trees because the Const arm yields the
 * exact `Value::AvlTree(...)` variant the eval function expects.
 */
function expectAvlTree(
  handlerName: string,
  obj: SValue
): asserts obj is { kind: 'AvlTree'; value: AvlTreeData } {
  if (obj.kind !== 'AvlTree') {
    throw new EvalError(
      `${handlerName} expects an AvlTree obj; got '${obj.kind}'`,
      'avl-tree-obj-not-avl-tree'
    )
  }
}

/**
 * `SAvlTree.digest` (100:1) — root hash + tree-height byte (33 bytes total).
 * Source: savltree.rs:28-34.
 *
 * Rust returns `Coll[Byte]` via `digest.0.iter().map(|&b| b as i8).collect()`;
 * `bytesToCollByteSValue` sign-extends each u8 to signed i8 to match.
 */
export function evalSAvlTreeDigest(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext
): SValue {
  ctx.addCost(ACCESSOR_COST)
  expectAvlTree('SAvlTree.digest', obj)
  return bytesToCollByteSValue(obj.value.digest)
}

/**
 * `SAvlTree.enabledOperations` (100:2) — `treeFlags` as signed Byte.
 * Source: savltree.rs:36-40.
 *
 * Rust: `Value::Byte(avl_tree_data.tree_flags.serialize() as i8)`. We
 * sign-extend the u8 (`(x << 24) >> 24`) so values 128..255 surface as
 * negative i8 — matches Rust's `as i8` cast.
 */
export function evalSAvlTreeEnabledOperations(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext
): SValue {
  ctx.addCost(ACCESSOR_COST)
  expectAvlTree('SAvlTree.enabledOperations', obj)
  const u8 = obj.value.treeFlags & 0xff
  return { kind: 'Byte', value: (u8 << 24) >> 24 }
}

/**
 * `SAvlTree.keyLength` (100:3) — common key length as Int.
 * Source: savltree.rs:42-46.
 *
 * Rust: `Value::Int(avl_tree_data.key_length as i32)`. Stored as u32 in
 * sigma-rust; in TS as a non-negative `number` (VLQ-decoded at parse time).
 * Values > i32::MAX cannot appear from a parser-produced tree.
 */
export function evalSAvlTreeKeyLength(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext
): SValue {
  ctx.addCost(ACCESSOR_COST)
  expectAvlTree('SAvlTree.keyLength', obj)
  return { kind: 'Int', value: obj.value.keyLength }
}

/**
 * `SAvlTree.valueLengthOpt` (100:4) — `Option[Int]` of common value length.
 * Source: savltree.rs:48-57.
 *
 * Rust: maps `Option<Box<u32>>` to `Option<Box<Value::Int>>`. In TS,
 * `valueLengthOpt === null` → None; otherwise wrap as `Some(Int)`.
 */
export function evalSAvlTreeValueLengthOpt(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext
): SValue {
  ctx.addCost(ACCESSOR_COST)
  expectAvlTree('SAvlTree.valueLengthOpt', obj)
  const v = obj.value.valueLengthOpt
  return {
    kind: 'Option',
    elem: SINT_TYPE,
    value: v === null ? null : { kind: 'Int', value: v },
  }
}

/**
 * `SAvlTree.isInsertAllowed` (100:5) — bit 0 (0x01) of `treeFlags`.
 * Source: savltree.rs:59-63; bit definition in avl_tree_data.rs:16-25.
 */
export function evalSAvlTreeIsInsertAllowed(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext
): SValue {
  ctx.addCost(ACCESSOR_COST)
  expectAvlTree('SAvlTree.isInsertAllowed', obj)
  return { kind: 'Boolean', value: (obj.value.treeFlags & 0x01) !== 0 }
}

/**
 * `SAvlTree.isUpdateAllowed` (100:6) — bit 1 (0x02) of `treeFlags`.
 * Source: savltree.rs:65-69.
 */
export function evalSAvlTreeIsUpdateAllowed(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext
): SValue {
  ctx.addCost(ACCESSOR_COST)
  expectAvlTree('SAvlTree.isUpdateAllowed', obj)
  return { kind: 'Boolean', value: (obj.value.treeFlags & 0x02) !== 0 }
}

/**
 * `SAvlTree.isRemoveAllowed` (100:7) — bit 2 (0x04) of `treeFlags`.
 * Source: savltree.rs:71-75.
 */
export function evalSAvlTreeIsRemoveAllowed(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext
): SValue {
  ctx.addCost(ACCESSOR_COST)
  expectAvlTree('SAvlTree.isRemoveAllowed', obj)
  return { kind: 'Boolean', value: (obj.value.treeFlags & 0x04) !== 0 }
}

// ===========================================================================
// Tier 2 — verification ops. Each handler delegates to @ergots/avltree.
// ===========================================================================

/** AvlTreeFlags bit positions per `avl_tree_data.rs:16-25`. */
const INSERT_ALLOWED_BIT = 0x01
const UPDATE_ALLOWED_BIT = 0x02
const REMOVE_ALLOWED_BIT = 0x04

// ---------------------------------------------------------------------------
// Tier-2 JVM cost model (F4). Source: CErgoTreeEvaluator.scala:67-254,
// methods.scala:1498-1516 (descriptors), CostKind.scala:26 (chunks formula).
// Spec: docs/specs/2026-06-07-ergoscript-f4-avltree-tier2-cost-design.md.
// ---------------------------------------------------------------------------

/**
 * Tree height as the JVM sees it: scorex `BatchAVLVerifier.rootNodeHeight =
 * startingDigest.last & 0xff` — the 33rd byte of the AvlTreeData digest.
 * NOT proof-derived; loop-constant (the JVM computes nItems once per call,
 * its own "cost is not properly approximated" comment notwithstanding —
 * we mirror the imprecision exactly).
 */
function treeHeight(data: AvlTreeData): number {
  return (data.digest[32] ?? 0) & 0xff
}

/** CreateAvlVerifier_Info — PerItemCost(110, 20, 64) on proof byte length. */
function chargeCreateVerifier(ctx: EvalContext, proofLen: number): void {
  ctx.addPerItemCost(110, 20, 64, proofLen)
}

/**
 * Charge a per-op PerItemCost(base, perChunk, 1) on nItems, `times` times —
 * one charge per attempted op, looped so a cost-limit trip fires at the same
 * op boundary as the JVM's per-iteration addSeqCost.
 */
function chargePerOp(
  ctx: EvalContext,
  base: number,
  perChunk: number,
  nItems: number,
  times: number
): void {
  for (let i = 0; i < times; i++) ctx.addPerItemCost(base, perChunk, 1, nItems)
}

/**
 * Charged-op count for the forall-style modify loops (insert/update/
 * insertOrUpdate) and getMany's map: full success charges every op;
 * a per-op failure charges the successful prefix + the failing op;
 * a construct failure charges exactly the first op attempt (JVM: every
 * op on a broken verifier fails immediately; forall breaks at op 1).
 */
function chargedOps(
  partial: { opsCompleted: number } | null,
  opsLength: number
): number {
  if (partial === null) return Math.min(1, opsLength)
  return partial.opsCompleted < opsLength ? partial.opsCompleted + 1 : opsLength
}

/** `Coll[Byte]` SType — element type of returned bytes Coll. */
const SCOLL_BYTE: SType = { tag: 'SColl', elem: { tag: 'SByte' } }
/** `Option[Coll[Byte]]` SType — `get` return shape + `getMany` element shape. */
const SOPTION_COLL_BYTE: SType = { tag: 'SOption', elem: SCOLL_BYTE }
/** `SAvlTree` SType — `insert` / `update` / `remove` Option element shape. */
const SAVL_TREE: SType = { tag: 'SAvlTree' }

/** Wrap a `Uint8Array` returned-value into `Some(Coll[Byte])`. */
function someCollByte(bytes: Uint8Array): SValue {
  return {
    kind: 'Option',
    elem: SCOLL_BYTE,
    value: bytesToCollByteSValue(bytes),
  }
}

/** `None` of type `Option[Coll[Byte]]`. */
function noneCollByte(): SValue {
  return { kind: 'Option', elem: SCOLL_BYTE, value: null }
}

/** Wrap a successor `AvlTreeData` into `Some(AvlTree)`. */
function someAvlTree(data: AvlTreeData): SValue {
  return {
    kind: 'Option',
    elem: SAVL_TREE,
    value: { kind: 'AvlTree', value: data },
  }
}

/** `None` of type `Option[AvlTree]`. */
function noneAvlTree(): SValue {
  return { kind: 'Option', elem: SAVL_TREE, value: null }
}

/**
 * Defensive 2-arg arity check; all 6 Tier-2 handlers take exactly
 * `(key/keys/entries, proof)`. Reuses `'method-not-implemented'` per the
 * compact-taxonomy decision (option 1 in the 2g.5 spec).
 */
function expectTwoArgs(handlerName: string, args: SValue[]): void {
  if (args.length !== 2) {
    throw new EvalError(
      `${handlerName} expects 2 args; got ${args.length}`,
      'method-not-implemented'
    )
  }
}

/**
 * Defensive 1-arg arity check; updateOperations (Byte) and updateDigest
 * (Coll[Byte]) both take exactly 1 arg. Reuses `'method-not-implemented'`
 * per the compact-taxonomy decision.
 */
function expectOneArg(handlerName: string, args: SValue[]): void {
  if (args.length !== 1) {
    throw new EvalError(
      `${handlerName} expects 1 arg; got ${args.length}`,
      'method-not-implemented'
    )
  }
}

/**
 * `SAvlTree.contains` (100:9) — single-key membership test.
 * Source: CErgoTreeEvaluator.scala:67-90 (JVM-canonical, F4).
 *
 * JVM cost model (F4):
 *   1. CreateAvlVerifier PerItem(110,20,64) on proof.length — BEFORE construction.
 *   2. LookupAvlTree PerItem(40,10,1) × 1 on RAW digest[32] height (no max-1 floor).
 *
 * Failure model (JVM-canonical, F4) — JVM has NO construct-throw path:
 *   scorex swallows reconstruction errors (topNode = None); any Lookup on a
 *   broken verifier surfaces as Failure. All failure paths → false:
 *   - verifier construct fail → false (JVM returns false, not throw)
 *   - per-op Lookup fail → false
 *   - per-op Lookup ok None → false (key absent)
 *   - per-op Lookup ok Some(_) → true (key present)
 *
 * Note: eni savltree.rs:361 still has the sigma-rust `?`-on-construct fork —
 * ergots leads here per JVM. Route divergence to sigma-rust via SANTA post-F4.
 *
 * Defensive: `expectAvlTree` for non-AvlTree receiver (unreachable for
 * parser-produced trees; ConstantPlaceholder hardening).
 */
export function evalSAvlTreeContains(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.contains', obj)
  expectTwoArgs('SAvlTree.contains', args)
  const key = extractBytes(args[0]!)
  const proof = extractBytes(args[1]!)
  // CreateAvlVerifier — charged before construction (JVM addSeqCost wraps it).
  chargeCreateVerifier(ctx, proof.length)
  // LookupAvlTree ×1 on RAW treeHeight (contains/get take no max-1 floor —
  // CErgoTreeEvaluator.scala:80 `val nItems = bv.treeHeight`).
  chargePerOp(ctx, 40, 10, treeHeight(obj.value), 1)
  const config = avlTreeDataToConfig(obj.value)
  const partial = verifyAvlBatchPartial(
    obj.value.digest, proof, config, buildSingleLookupOp(key)
  )
  // JVM contains NEVER throws (CErgoTreeEvaluator.scala:84-90): construct
  // failure and lookup failure both surface as Failure → false; a successful
  // lookup maps Some→true / None→false. Construct failure is not a distinct
  // observable — scorex swallows reconstruction errors (topNode = None) and
  // every subsequent op fails.
  if (partial === null || partial.opsCompleted < 1) {
    return { kind: 'Boolean', value: false }
  }
  return { kind: 'Boolean', value: partial.results[0] != null }
}

/**
 * `SAvlTree.get` (100:10) — single-key Option lookup returning the value
 * bytes on hit.
 * Source: CErgoTreeEvaluator.scala:92-109 (JVM-canonical, F4).
 *
 * JVM cost model (F4):
 *   1. CreateAvlVerifier PerItem(110,20,64) on proof.length — BEFORE construction.
 *   2. LookupAvlTree PerItem(40,10,1) × 1 on RAW digest[32] height (CErgoTreeEvaluator.scala:97).
 *
 * Failure model (JVM-canonical, F4):
 *   - verifier construct fail → Lookup returns Failure → throw 'avl-tree-proof-failed'
 *     (both construct-fail and per-op-fail share the same throw path).
 *   - per-op Lookup Err → throw same code.
 *   - Ok None → `Option[Coll[Byte]] None`.
 *   - Ok Some(bytes) → `Some(Coll[Byte])`.
 */
export function evalSAvlTreeGet(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.get', obj)
  expectTwoArgs('SAvlTree.get', args)
  const key = extractBytes(args[0]!)
  const proof = extractBytes(args[1]!)
  chargeCreateVerifier(ctx, proof.length)
  // LookupAvlTree ×1 on RAW treeHeight (CErgoTreeEvaluator.scala:97).
  chargePerOp(ctx, 40, 10, treeHeight(obj.value), 1)
  const config = avlTreeDataToConfig(obj.value)
  const partial = verifyAvlBatchPartial(
    obj.value.digest, proof, config, buildSingleLookupOp(key)
  )
  // JVM get throws on Lookup Failure (syntax.error, CErgoTreeEvaluator.scala:106)
  // — construct failure manifests as that same Failure, so both throw.
  if (partial === null || partial.opsCompleted < 1) {
    throw new EvalError(
      'SAvlTree.get: tree proof is incorrect',
      'avl-tree-proof-failed'
    )
  }
  const found = partial.results[0]
  if (found === null || found === undefined) {
    return { kind: 'Option', elem: SCOLL_BYTE, value: null }
  }
  return someCollByte(found)
}

/**
 * `SAvlTree.getMany` (100:11) — multi-key Option lookup.
 * Source: CErgoTreeEvaluator.scala:112-130 (JVM-canonical, F4).
 *
 * JVM cost model (F4):
 *   1. CreateAvlVerifier PerItem(110,20,64) on proof.length — BEFORE construction.
 *   2. LookupAvlTree PerItem(40,10,1) × chargedOps on RAW digest[32] height.
 *      - Full success: k charges (one per key).
 *      - Construct-fail: 1 charge (first op fails immediately on broken verifier).
 *      - Per-op-fail at key i: opsCompleted+1 charges (JVM throws out of map at
 *        first Failure — CErgoTreeEvaluator.scala:126).
 *
 * Charging after verifyAvlBatchPartial but before the throw keeps the cost-limit
 * boundary: if a charge crosses the limit, addPerItemCost throws
 * 'cost-limit-exceeded' before the proof-failed throw — same observable as the
 * JVM's charge-then-attempt ordering at whole-call granularity.
 *
 * Returns a Coll of `Option[Coll[Byte]]` with one entry per input key.
 */
export function evalSAvlTreeGetMany(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.getMany', obj)
  expectTwoArgs('SAvlTree.getMany', args)
  const keys = extractByteArrayList(args[0]!)
  const proof = extractBytes(args[1]!)
  chargeCreateVerifier(ctx, proof.length)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildLookupOps(keys)
  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  // One LookupAvlTree charge per key the JVM's keys.map reached: all keys on
  // success; the successful prefix + the failing key on failure (the JVM
  // throws out of the map at the first Failure — CErgoTreeEvaluator.scala:126).
  // RAW treeHeight (no max-1 floor), loop-constant.
  chargePerOp(ctx, 40, 10, treeHeight(obj.value), chargedOps(partial, ops.length))
  // ops.length === 0: the JVM's keys.map over an empty coll runs zero lookups —
  // no Failure can surface even on a construct-broken verifier → empty Coll
  // (charges: createVerifier only). CErgoTreeEvaluator.scala:111-130.
  if (ops.length > 0 && (partial === null || partial.opsCompleted < ops.length)) {
    throw new EvalError(
      'SAvlTree.getMany: tree proof is incorrect',
      'avl-tree-proof-failed'
    )
  }
  const items: SValue[] = (partial === null ? [] : partial.results).map((found) =>
    found === null ? noneCollByte() : someCollByte(found)
  )
  return { kind: 'Coll', elem: SOPTION_COLL_BYTE, items }
}

/**
 * `SAvlTree.insert` (100:12) — batch-Insert returning successor AvlTree.
 * Source: CErgoTreeEvaluator.scala:132-164 (JVM-canonical, F4).
 *
 * JVM cost model (F4):
 *   1. isInsertAllowed_Info Fixed(15) — charge-then-check (CErgoTreeEvaluator.scala:133).
 *   2. CreateAvlVerifier PerItem(110,20,64) on proof.length — BEFORE construction.
 *   3. InsertIntoAvlTree PerItem(40,10,1) × chargedOps on `max(treeHeight, 1)`.
 *      ("when the tree is empty we still need to add the insert cost",
 *      CErgoTreeEvaluator.scala:139). Full success: ops.length; construct-fail:
 *      min(1, ops.length); per-op-fail: opsCompleted+1.
 *   4. updateDigest Fixed(40) on the success path only (CErgoTreeEvaluator.scala:159).
 *
 * Failure model (JVM-canonical, F4) — construct failure is not a distinct
 * observable (scorex swallows reconstruction errors; broken verifier → every
 * op returns Failure). Construct-fail = first-op-fail:
 *   - ops.length === 0: empty forall never runs; even a construct failure
 *     cannot surface → digest → None at every version.
 *   - ops.length > 0 AND (ctx.treeVersion ?? 0) < 3: V<3 throws
 *     'avl-tree-proof-failed' (CErgoTreeEvaluator.scala:150).
 *   - ops.length > 0 AND treeVersion >= 3: forall breaks → digest None → None.
 */
export function evalSAvlTreeInsert(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.insert', obj)
  expectTwoArgs('SAvlTree.insert', args)
  // isInsertAllowed_Info Fixed(15) — charge-then-check (CErgoTreeEvaluator.scala:133).
  ctx.addCost(15)
  if ((obj.value.treeFlags & INSERT_ALLOWED_BIT) === 0) {
    return noneAvlTree()
  }
  const ops = buildInsertOps(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  chargeCreateVerifier(ctx, proof.length)
  // InsertIntoAvlTree PerItem(40,10,1) × charged ops on max(height, 1)
  // ("when the tree is empty we still need to add the insert cost",
  // CErgoTreeEvaluator.scala:139).
  const nItems = Math.max(treeHeight(obj.value), 1)
  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  chargePerOp(ctx, 40, 10, nItems, chargedOps(partial, ops.length))
  if (partial === null || partial.opsCompleted < ops.length) {
    // An op actually failed (construct failure manifests as the first op
    // failing — scorex swallows reconstruction errors). V<3 throws
    // (CErgoTreeEvaluator.scala:150 syntax.error, !isV3OrLater); V3+ breaks
    // → digest None → None. With ZERO ops the forall never runs, so even a
    // construct failure cannot reach the V<3 throw — it falls to digest →
    // None at every version.
    if (ops.length > 0 && (ctx.treeVersion ?? 0) < 3) {
      throw new EvalError(
        'SAvlTree.insert: incorrect insert',
        'avl-tree-proof-failed'
      )
    }
    return noneAvlTree()
  }
  // updateDigest_Info Fixed(40) on the success path only (CErgoTreeEvaluator.scala:159).
  ctx.addCost(40)
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}

/**
 * `SAvlTree.update` (100:13) — batch-Update returning successor AvlTree.
 * Source: CErgoTreeEvaluator.scala:165-195 (JVM-canonical, F4).
 *
 * JVM cost model (F4):
 *   1. isUpdateAllowed_Info Fixed(15) — charge-then-check (CErgoTreeEvaluator.scala:169).
 *   2. CreateAvlVerifier PerItem(110,20,64) on proof.length — BEFORE construction.
 *   3. UpdateAvlTree PerItem(120,20,1) × chargedOps on `max(treeHeight, 1)`
 *      (CErgoTreeEvaluator.scala:175-181).
 *   4. updateDigest Fixed(40) on the success path only (CErgoTreeEvaluator.scala:189).
 *
 * Failure model (JVM-canonical, F4) — JVM update NEVER throws (no version
 * split): per-op Failure breaks the forall (CErgoTreeEvaluator.scala:178-186);
 * construct failure joins the same path (scorex swallows reconstruction errors).
 * Either failure → digest None → None. Pre-F4 ergots threw on construct fail
 * (sigma-rust `?`-on-construct fork) — that divergence is now closed.
 */
export function evalSAvlTreeUpdate(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.update', obj)
  expectTwoArgs('SAvlTree.update', args)
  // isUpdateAllowed_Info Fixed(15) — charge-then-check (CErgoTreeEvaluator.scala:169).
  ctx.addCost(15)
  if ((obj.value.treeFlags & UPDATE_ALLOWED_BIT) === 0) {
    return noneAvlTree()
  }
  const ops = buildUpdateOps(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  chargeCreateVerifier(ctx, proof.length)
  // UpdateAvlTree PerItem(120,20,1) × charged ops on max(height, 1)
  // (CErgoTreeEvaluator.scala:175-181).
  const nItems = Math.max(treeHeight(obj.value), 1)
  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  chargePerOp(ctx, 120, 20, nItems, chargedOps(partial, ops.length))
  if (partial === null || partial.opsCompleted < ops.length) {
    // JVM update never throws: per-op Failure breaks the forall (no version
    // split — CErgoTreeEvaluator.scala:178-186), digest None → None.
    // Construct failure joins the same path. Pre-F4 ergots threw on
    // construct failure (the sigma-rust `?`-on-construct fork).
    return noneAvlTree()
  }
  ctx.addCost(40) // updateDigest_Info on success (CErgoTreeEvaluator.scala:189)
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}

/**
 * `SAvlTree.remove` (100:14) — batch-Remove returning successor AvlTree.
 * Source: CErgoTreeEvaluator.scala:230-254 (JVM-canonical, F4).
 *
 * JVM cost model (F4):
 *   1. isRemoveAllowed_Info Fixed(15) — charge-then-check (CErgoTreeEvaluator.scala:233).
 *   2. CreateAvlVerifier PerItem(110,20,64) on proof.length — BEFORE construction.
 *   3. RemoveAvlTree PerItem(100,15,1) × ALL ops.length on max(treeHeight, 1).
 *      The JVM uses `cfor` (CErgoTreeEvaluator.scala:240-245) — no break, no fast-exit
 *      on failure; every op is charged even after the verifier is poisoned by a bad proof.
 *   4. digest_Info Fixed(15) — UNCONDITIONAL (:246), charged before the digest inspect
 *      regardless of whether any op succeeded.
 *   5. updateDigest_Info Fixed(40) on the success path only (:249).
 *
 * Failure model (JVM-canonical, F4) — remove NEVER throws:
 *   scorex `BatchAVLVerifier` swallows construction errors (topNode = None); every
 *   subsequent op returns Failure; per-op results are DISCARDED by the cfor (no break).
 *   After the loop, `bv.digest()` returns None (construct-fail or any op-fail), so
 *   the digest match falls to the None arm → return None (:247-252).
 *
 *   - construct-fail → verifier poisoned → digest None → None
 *   - any per-op Remove fail → result discarded (cfor continues) → digest None → None
 *   - full success → digest Some(newDigest) → Some(AvlTree(newDigest)) + updateDigest(40)
 *
 * Pre-F4 ergots threw on both construct-fail and per-op-fail, matching sigma-rust's
 * `?`-on-construct fork (savltree.rs:316,322). That divergence is now closed;
 * ergots leads per JVM. Route divergence note to sigma-rust via SANTA post-F4.
 */
export function evalSAvlTreeRemove(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.remove', obj)
  expectTwoArgs('SAvlTree.remove', args)
  // isRemoveAllowed_Info Fixed(15) — charge-then-check (CErgoTreeEvaluator.scala:233).
  ctx.addCost(15)
  if ((obj.value.treeFlags & REMOVE_ALLOWED_BIT) === 0) {
    return noneAvlTree()
  }
  const keys = extractByteArrayList(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildRemoveOps(keys)
  chargeCreateVerifier(ctx, proof.length)
  // RemoveAvlTree PerItem(100,15,1) × ALL ops on max(height, 1).
  // The JVM uses cfor with per-op results DISCARDED (CErgoTreeEvaluator.scala:240-245):
  // no fast-break, every op is charged even after the verifier is poisoned.
  const nItems = Math.max(treeHeight(obj.value), 1)
  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  chargePerOp(ctx, 100, 15, nItems, ops.length)
  // digest_Info Fixed(15) — UNCONDITIONAL (:246), before the digest inspect.
  ctx.addCost(15)
  if (partial === null || partial.opsCompleted < ops.length) {
    // JVM remove NEVER throws: failures (construct or per-op) poison the verifier;
    // digest → None → None (:247-252). Pre-F4 ergots threw on both (the only modify
    // handler with a per-op throw — sigma-rust fork, now closed).
    return noneAvlTree()
  }
  ctx.addCost(40) // updateDigest_Info on success (:249)
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}

/**
 * `SAvlTree.updateOperations` (100:8) — replaces treeFlags byte.
 * Source: savltree.rs:77-88 — UPDATE_OPERATIONS_EVAL_FN.
 *
 * Pattern A Fixed(45) — addCost(45) BEFORE shape check (matches sigma-rust's
 * `ctx.add_jit_cost(45)?` at line 78). Pure projection over AvlTreeData;
 * no @ergots/avltree call.
 *
 * SType: (SAvlTree, SByte) → SAvlTree.
 *
 * Defensive checks reuse 'avl-tree-obj-not-avl-tree' (existing) and
 * 'method-not-implemented' (existing per compact-taxonomy).
 */
export function evalSAvlTreeUpdateOperations(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  ctx.addCost(45)
  expectAvlTree('SAvlTree.updateOperations', obj)
  expectOneArg('SAvlTree.updateOperations', args)
  if (args[0]!.kind !== 'Byte') {
    throw new EvalError(
      `SAvlTree.updateOperations expects Byte arg; got '${args[0]!.kind}'`,
      'method-not-implemented'
    )
  }
  const newFlags = args[0]!.value & 0xff  // i8 → u8
  return { kind: 'AvlTree', value: withUpdatedFlags(obj.value, newFlags) }
}

/**
 * `SAvlTree.updateDigest` (100:15) — replaces the 33-byte digest.
 * Source: savltree.rs:90-102 — UPDATE_DIGEST_EVAL_FN.
 *
 * Pattern A Fixed(40) — addCost(40) BEFORE shape check (matches sigma-rust's
 * `ctx.add_jit_cost(40)?` at line 91). Pure projection over AvlTreeData;
 * no @ergots/avltree call.
 *
 * SType: (SAvlTree, SColl(SByte)) → SAvlTree.
 *
 * Defensive 33-byte length check — sigma-rust surfaces the same condition
 * via `ADDigest::try_from(bytes_vec)` failing inside `map_eval_err`. Reachable
 * from script-controlled data (any Coll[Byte] can be passed); thrown
 * specifically as 'avl-tree-bad-digest-length' (NEW code; not reused).
 *
 * `withUpdatedDigest` (existing helper, _avltree-adapter.ts:68-75) does NOT
 * validate length — it's pure field-substitution. The handler's pre-check
 * is the sole length gate.
 */
export function evalSAvlTreeUpdateDigest(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  ctx.addCost(40)
  expectAvlTree('SAvlTree.updateDigest', obj)
  expectOneArg('SAvlTree.updateDigest', args)
  const newDigest = extractBytes(args[0]!)
  if (newDigest.length !== 33) {
    throw new EvalError(
      `SAvlTree.updateDigest: digest must be 33 bytes, got ${newDigest.length}`,
      'avl-tree-bad-digest-length'
    )
  }
  return { kind: 'AvlTree', value: withUpdatedDigest(obj.value, newDigest) }
}

/**
 * `SAvlTree.insertOrUpdate` (100:16) — V3-gated InsertOrUpdate batch.
 * Source: CErgoTreeEvaluator.scala:196-228 (JVM-canonical, F4).
 *         savltree.rs:441-498 — INSERT_OR_UPDATE_EVAL_FN (reference, pre-F4
 *         sigma-rust still has the `?`-on-construct fork; ergots leads here).
 *
 * V-gating: dispatcher-level via `minVersion: 3` on the HANDLERS entry. The
 * dispatcher throws 'tree-version-too-low' BEFORE invoking this handler when
 * (ctx.treeVersion ?? 0) < 3. Mirrors sigma-rust's MethodDesc.min_version
 * gate. Receiver-eval + envelope cost (4) are still charged; the handler's
 * per-handler costs are not.
 *
 * JVM cost model (F4):
 *   1. isUpdateAllowed_Info Fixed(15) — charged FIRST (CErgoTreeEvaluator.scala:199).
 *   2. isInsertAllowed_Info Fixed(15) — charged SECOND (CErgoTreeEvaluator.scala:200).
 *      BOTH charges occur before the combined flag check. Blessed flags-deny 73
 *      = envelope 43 + 15 + 15 pins the double charge.
 *   3. Combined flag check (insert AND update both required): either unset → None.
 *   4. CreateAvlVerifier PerItem(110,20,64) on proof.length — BEFORE construction.
 *   5. UpdateAvlTree PerItem(120,20,1) × chargedOps on `max(treeHeight, 1)`.
 *      insertOrUpdate shares update's descriptor (CErgoTreeEvaluator.scala:215).
 *   6. updateDigest Fixed(40) on success only (CErgoTreeEvaluator.scala:223).
 *
 * Failure model (JVM-canonical, F4):
 *   JVM has NO construct-throw path (scorex swallows reconstruction errors;
 *   broken verifier → topNode=None → every op returns Failure).
 *   Construct-fail = first-op-fail → forall breaks → digest None → None.
 *   The blessed bad-proof entry (None @ 443) pins this path: flags 30 +
 *   createVerifier(143 B → 170) + ONE UpdateAvlTree(120+20·4) on the
 *   construct-broken verifier, NO updateDigest. Pre-F4 ergots threw
 *   'avl-tree-proof-failed' here — the sigma-rust `?`-on-construct fork;
 *   ergots leads the fix (JVM canonical). V<3 unreachable (dispatcher gate).
 *
 * Route the divergence note to sigma-rust via SANTA post-F4.
 */
export function evalSAvlTreeInsertOrUpdate(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.insertOrUpdate', obj)
  expectTwoArgs('SAvlTree.insertOrUpdate', args)
  // BOTH flag costs, isUpdateAllowed FIRST (CErgoTreeEvaluator.scala:199-200),
  // charged before the combined check — blessed flags-deny 73 = envelope 43
  // + 15 + 15 pins the double charge.
  ctx.addCost(15) // isUpdateAllowed_Info
  ctx.addCost(15) // isInsertAllowed_Info
  if (
    (obj.value.treeFlags & INSERT_ALLOWED_BIT) === 0 ||
    (obj.value.treeFlags & UPDATE_ALLOWED_BIT) === 0
  ) {
    return noneAvlTree()
  }
  const ops = buildInsertOrUpdateOps(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  chargeCreateVerifier(ctx, proof.length)
  // UpdateAvlTree_Info (120,20,1) — insertOrUpdate shares update's descriptor
  // (CErgoTreeEvaluator.scala:215), × charged ops on max(height, 1).
  const nItems = Math.max(treeHeight(obj.value), 1)
  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  chargePerOp(ctx, 120, 20, nItems, chargedOps(partial, ops.length))
  if (partial === null || partial.opsCompleted < ops.length) {
    // Failures discarded (forall fast-break), digest None → None
    // (CErgoTreeEvaluator.scala:209-226). V<3 unreachable (dispatcher
    // minVersion 3). The blessed bad-proof entry (None @ 443) pins this
    // exact path: flags 30 + createVerifier(143 B → 170) + ONE
    // UpdateAvlTree(120+20·4) on the construct-broken verifier. Pre-F4
    // ergots threw 'avl-tree-proof-failed' here — the sigma-rust
    // `?`-on-construct fork shared by all three conformers; ergots leads
    // the fix (JVM canonical).
    return noneAvlTree()
  }
  ctx.addCost(40) // updateDigest_Info on success (CErgoTreeEvaluator.scala:223)
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}
