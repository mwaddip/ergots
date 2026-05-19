/**
 * `SAvlTree.*` method-call handlers — phase 2h-b Tier 1 (pure accessors).
 *
 * Each handler projects a single field of `AvlTreeData` and never reaches
 * into `@ergots/avltree` (those are Tier 2 verification ops, phase F). All
 * handlers follow Pattern A: `ctx.addCost(15)` BEFORE shape check, mirroring
 * sigma-rust's `add_jit_cost` call at the top of every `EvalFn`.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:29-75 (one `EvalFn`
 * static per handler).
 *
 * Defensive-throw `'avl-tree-obj-not-avl-tree'` on non-AvlTree receiver.
 * Wire-format invariants (PropertyCall construction; SAvlTree-typed Const)
 * make this unreachable for parser-produced trees — guard against
 * hand-crafted MIR or future `ConstantPlaceholder` injection.
 *
 * facts/ergoscript-eval.md: Method-handler registry rows 9-15.
 */

import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import type { AvlTreeData, SType, SValue } from '../mir/types'
import { bytesToCollByteSValue } from './_byte-coll'

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
