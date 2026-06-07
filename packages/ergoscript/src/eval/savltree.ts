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
 * Cost model: conversion to the same JVM PerItemCost charging pattern lands in
 * F4 Tasks 4-6. Header will be finalized then. The in-flight inconsistency
 * between the lookup family (F4-canonical) and modify family (sigma-rust-canonical
 * cost, pre-F4) is documented here rather than silent.
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
import { verifyAvlBatch, verifyAvlBatchPartial } from '@ergots/avltree'
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
 * Source: savltree.rs:214-277 — INSERT_EVAL_FN.
 *
 * Pre-check (BEFORE proof parse): if `!insert_allowed`, return `None`
 * straight away (line 218-220). No `@ergots/avltree` call.
 *
 * Failure model:
 *   - verifier construct fail (line 251 `?`) → throw `'avl-tree-proof-failed'`
 *   - V<3 per-op fail (line 263-267 `return Err`) → throw same code
 *   - V3+ per-op fail (line 260-261 `break`) → continue to result block
 *
 * Result block (line 270-276):
 *   - `bv.digest()` returns Some(new_digest) → `Some(AvlTree(new_digest))`
 *   - `bv.digest()` returns None → `Option None`
 *
 * `bv.digest()` returns None iff `root === null`, which happens AFTER any
 * per-op failure (root is poisoned). So in V3+ break case, this is the
 * `Option None` branch. On full-success path, `bv.digest()` is the
 * post-batch digest.
 *
 * V3+ implementation: we use `verifyAvlBatch` (all-or-nothing) — non-null
 * means full success, null means EITHER construct fail OR per-op fail.
 * Differentiate via `verifyAvlBatchPartial`: null → construct fail (throw);
 * partial.opsCompleted < ops.length → per-op fail (break path → None).
 *
 * V<3 implementation: same, but per-op fail throws instead of returning None.
 */
export function evalSAvlTreeInsert(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.insert', obj)
  expectTwoArgs('SAvlTree.insert', args)
  // Pre-check: insert_allowed flag (line 218-220) — return None WITHOUT
  // touching @ergots/avltree.
  if ((obj.value.treeFlags & INSERT_ALLOWED_BIT) === 0) {
    return noneAvlTree()
  }
  const ops = buildInsertOps(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const treeVersion = ctx.treeVersion ?? 0

  // Construct via verifyAvlBatchPartial to distinguish construct vs per-op
  // failure (verifyAvlBatch collapses both to null).
  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  if (partial === null) {
    // Construct fail — line 251 in sigma-rust.
    throw new EvalError(
      'SAvlTree.insert: verifier construct failed',
      'avl-tree-proof-failed'
    )
  }
  if (partial.opsCompleted < ops.length) {
    // Per-op fail.
    if (treeVersion < 3) {
      // V<3 throws (line 263-267).
      throw new EvalError(
        'SAvlTree.insert: incorrect insert',
        'avl-tree-proof-failed'
      )
    }
    // V3+ break path: bv.digest() returns None → Option None
    // (line 270-275 `if let Some(new_digest) = bv.digest() { … } else { None }`).
    // Sigma-rust's `bv.digest()` is poisoned to None after a per-op
    // failure (batch_avl_verifier.rs:168 `tree.root = None`), so the
    // result is Option None — NOT a partial-state Some.
    return noneAvlTree()
  }
  // Full success — apply the new digest immutably.
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}

/**
 * `SAvlTree.update` (100:13) — batch-Update returning successor AvlTree.
 * Source: savltree.rs:383-439 — UPDATE_EVAL_FN.
 *
 * Pre-check: `!update_allowed` (line 387-389) → None.
 *
 * Failure model:
 *   - verifier construct fail (line 420 `?`) → throw `'avl-tree-proof-failed'`
 *   - per-op fail (line 422-431 `break` — UNCONDITIONAL, no V<3/V3+ split)
 *     → continue to result block
 *
 * Confirmed via source-read: unlike `insert`, the `update` `break` is NOT
 * gated by `ctx.tree_version() >= ErgoTreeVersion::V3`. This is a survey
 * divergence — survey said V<3 throws like insert; sigma-rust shows update
 * always breaks.
 *
 * Result block (line 432-438): identical to insert.
 *   - bv.digest() Some → Some(AvlTree(new_digest))
 *   - bv.digest() None (post-poison) → Option None
 */
export function evalSAvlTreeUpdate(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.update', obj)
  expectTwoArgs('SAvlTree.update', args)
  if ((obj.value.treeFlags & UPDATE_ALLOWED_BIT) === 0) {
    return noneAvlTree()
  }
  const ops = buildUpdateOps(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)

  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  if (partial === null) {
    throw new EvalError(
      'SAvlTree.update: verifier construct failed',
      'avl-tree-proof-failed'
    )
  }
  if (partial.opsCompleted < ops.length) {
    // Per-op fail: ALWAYS breaks → None (no V<3/V3+ split).
    return noneAvlTree()
  }
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}

/**
 * `SAvlTree.remove` (100:14) — batch-Remove returning successor AvlTree.
 * Source: savltree.rs:279-337 — REMOVE_EVAL_FN.
 *
 * Pre-check: `!remove_allowed` (line 283-285) → None.
 *
 * Failure model (NO V3+ break):
 *   - verifier construct fail (line 316 `?`) → throw `'avl-tree-proof-failed'`
 *   - per-op Remove fail (line 318-326 — always-throw `return Err`) → throw
 *     same code
 *
 * Confirmed: `remove` is the only modify-style handler with no V3+ partial-
 * success path. Per the design spec / source-read this is intentional.
 *
 * Result block (line 328-336): same as insert/update — Some(AvlTree) on
 * full success, Option None if `bv.digest()` returns None (only reachable
 * with an empty-keys batch yielding no digest update; sigma-rust returns
 * None then too).
 */
export function evalSAvlTreeRemove(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.remove', obj)
  expectTwoArgs('SAvlTree.remove', args)
  if ((obj.value.treeFlags & REMOVE_ALLOWED_BIT) === 0) {
    return noneAvlTree()
  }
  const keys = extractByteArrayList(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildRemoveOps(keys)

  // Remove uses verifyAvlBatch (all-or-nothing) per source — any failure
  // collapses to throw.
  const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
  if (r === null) {
    throw new EvalError(
      'SAvlTree.remove: incorrect remove',
      'avl-tree-proof-failed'
    )
  }
  return someAvlTree(withUpdatedDigest(obj.value, r.newDigest))
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
 * Source: savltree.rs:441-498 — INSERT_OR_UPDATE_EVAL_FN. Descriptor at
 * types/savltree.rs:377-403 with min_version: ErgoTreeVersion::V3.
 *
 * V-gating: dispatcher-level via `minVersion: 3` on the HANDLERS entry. The
 * dispatcher throws 'tree-version-too-low' BEFORE invoking this handler when
 * (ctx.treeVersion ?? 0) < 3. Mirrors sigma-rust's MethodDesc.min_version
 * gate. Receiver-eval + envelope cost (4) are still charged; the handler's
 * zero per-handler cost is not.
 *
 * Pre-check: BOTH insert_allowed AND update_allowed must be set
 * (line 444). Asymmetric vs insert (insert_allowed only) and update
 * (update_allowed only). Either flag unset → Option None.
 *
 * Verifier path: verifyAvlBatchPartial with InsertOrUpdate ops:
 *   - partial === null (construct fail) → throw 'avl-tree-proof-failed'
 *   - partial.opsCompleted < ops.length → graceful break (always; no V<3
 *     throw path because dispatcher already rejected V<3) → Option None
 *   - Full success → Some(AvlTree(new_digest))
 */
export function evalSAvlTreeInsertOrUpdate(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.insertOrUpdate', obj)
  expectTwoArgs('SAvlTree.insertOrUpdate', args)
  if (
    (obj.value.treeFlags & INSERT_ALLOWED_BIT) === 0 ||
    (obj.value.treeFlags & UPDATE_ALLOWED_BIT) === 0
  ) {
    return noneAvlTree()
  }
  const ops = buildInsertOrUpdateOps(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)

  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  if (partial === null) {
    throw new EvalError(
      'SAvlTree.insertOrUpdate: verifier construct failed',
      'avl-tree-proof-failed'
    )
  }
  if (partial.opsCompleted < ops.length) {
    // V<3 already rejected at dispatcher; V3+ break path: bv.digest()
    // returns None post-poison → Option None (matches savltree.rs:495-497).
    return noneAvlTree()
  }
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}
