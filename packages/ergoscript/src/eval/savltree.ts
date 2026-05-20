/**
 * `SAvlTree.*` method-call handlers — phase 2h-b Tier 1 (pure accessors) +
 * Tier 2 (verification ops).
 *
 * Tier 1 (digest / enabledOperations / keyLength / valueLengthOpt /
 * isInsertAllowed / isUpdateAllowed / isRemoveAllowed) projects a single
 * field of `AvlTreeData` and never reaches into `@ergots/avltree`. All
 * Tier-1 handlers follow Pattern A: `ctx.addCost(15)` BEFORE shape check,
 * mirroring sigma-rust's `add_jit_cost` call at the top of every Tier-1
 * `EvalFn`.
 *
 * Tier 2 (contains / get / getMany / insert / update / remove) delegates
 * proof verification to `@ergots/avltree` v0.2.0's `verifyAvlBatch` and
 * `verifyAvlBatchPartial`. These handlers DO NOT charge a per-handler cost
 * — the dispatcher's Pattern-A cost 4 + inline Const arm costs cover them
 * (mirrors sigma-rust: Tier-2 `EvalFn` statics have no `add_jit_cost` call;
 * see savltree.rs:104, 152, 214, 279, 339, 383).
 *
 * Six failure models — `contains` is unique in that PER-OP failure returns
 * `false` (does not throw), but CONSTRUCT failure still throws. The
 * remaining five throw on construct failure; `get` / `getMany` / `remove`
 * throw on per-op failure too. `insert` throws on V<3 per-op failure but
 * breaks (returns final-or-empty Option) on V3+. `update` always breaks
 * (no V<3/V3+ split — confirmed via source-read of savltree.rs:421-431).
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:29-75 (Tier 1),
 *         ergotree-interpreter/src/eval/savltree.rs:104-381,383-439
 *         (Tier 2; see per-handler comments for line ranges).
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
 * Source: savltree.rs:339-381 — CONTAINS_EVAL_FN.
 *
 * Failure model (DIVERGES from get/getMany/get/remove):
 *   - verifier construct fail (`map_err(map_eval_err)?` on line 372) → throw
 *     `'avl-tree-proof-failed'`
 *   - per-op Lookup fail (Err arm on line 379) → return `Boolean(false)`
 *   - per-op Lookup ok None → `Boolean(false)`
 *   - per-op Lookup ok Some(_) → `Boolean(true)`
 *
 * No `ctx.addCost(…)` — the Tier-2 EvalFns in sigma-rust do not call
 * `add_jit_cost`; the dispatcher's Pattern-A cost 4 + inline Const arm
 * cover the cost surface.
 *
 * Defensive: `expectAvlTree` for non-AvlTree receiver (unreachable for
 * parser-produced trees; ConstantPlaceholder hardening).
 */
export function evalSAvlTreeContains(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.contains', obj)
  expectTwoArgs('SAvlTree.contains', args)
  const key = extractBytes(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildSingleLookupOp(key)
  const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
  // Per sigma-rust contains:
  //   - r === null FROM CONSTRUCT FAIL only: throw (parity with line 372 `?`).
  //   - r === null FROM PER-OP FAIL: returns false (line 379).
  // verifyAvlBatch collapses both into null. To distinguish, call
  // verifyAvlBatchPartial: it returns null ONLY on construct failure
  // (per-op failure yields a partial-success with opsCompleted < ops.length).
  if (r !== null) {
    // Verifier succeeded end-to-end. Per-key Lookup result lives at [0]:
    // non-null → key present (true); null → key absent (false).
    return { kind: 'Boolean', value: r.results[0] !== null }
  }
  // r === null. Disambiguate construct vs per-op failure via partial:
  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  if (partial === null) {
    // Construct fail — matches sigma-rust's `?` on line 372.
    throw new EvalError(
      'SAvlTree.contains: verifier construct failed',
      'avl-tree-proof-failed'
    )
  }
  // Per-op fail (partial !== null with opsCompleted === 0): return false.
  return { kind: 'Boolean', value: false }
}

/**
 * `SAvlTree.get` (100:10) — single-key Option lookup returning the value
 * bytes on hit.
 * Source: savltree.rs:104-150 — GET_EVAL_FN.
 *
 * Failure model:
 *   - verifier construct fail (`map_err(map_eval_err)?` on line 136) → throw
 *     `'avl-tree-proof-failed'`
 *   - per-op Lookup Err arm (line 145-148) → throw same code
 *   - Ok None → `Option[Coll[Byte]] None`
 *   - Ok Some(bytes) → `Some(Coll[Byte])`
 *
 * No per-handler cost charge (Tier-2 convention).
 */
export function evalSAvlTreeGet(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.get', obj)
  expectTwoArgs('SAvlTree.get', args)
  const key = extractBytes(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildSingleLookupOp(key)
  const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
  if (r === null) {
    throw new EvalError(
      'SAvlTree.get: tree proof is incorrect',
      'avl-tree-proof-failed'
    )
  }
  const found = r.results[0]
  if (found === null || found === undefined) {
    return { kind: 'Option', elem: SCOLL_BYTE, value: null }
  }
  return someCollByte(found)
}

/**
 * `SAvlTree.getMany` (100:11) — multi-key Option lookup.
 * Source: savltree.rs:152-212 — GET_MANY_EVAL_FN.
 *
 * Failure model: same throw discipline as `get`. Sigma-rust runs each
 * Lookup individually in a `try_fold`-style loop (line 186-206); if ANY
 * Lookup returns `Err`, the whole call throws (line 200-203). The successful
 * results map per-key to `Some(bytes)` (line 191-195) or `None`
 * (line 196-198).
 *
 * Returns a Coll of `Option[Coll[Byte]]` with one entry per input key.
 *
 * Implementation: `verifyAvlBatch` collapses both construct-fail and any
 * per-key-op-fail into null. Per sigma-rust both lead to the same throw, so
 * we don't need to disambiguate.
 */
export function evalSAvlTreeGetMany(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.getMany', obj)
  expectTwoArgs('SAvlTree.getMany', args)
  const keys = extractByteArrayList(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)
  const ops = buildLookupOps(keys)
  const r = verifyAvlBatch(obj.value.digest, proof, config, ops)
  if (r === null) {
    throw new EvalError(
      'SAvlTree.getMany: tree proof is incorrect',
      'avl-tree-proof-failed'
    )
  }
  const items: SValue[] = r.results.map((found) =>
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
