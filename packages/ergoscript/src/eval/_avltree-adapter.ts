/**
 * `@ergots/avltree` ↔ ErgoScript runtime adapter helpers — phase 2h-b, Phase E.
 *
 * 10 pure helpers that bridge `AvlTreeData` runtime values to the
 * `@ergots/avltree` package's `Operation` / `AvlTreeConfig` API. Consumed by
 * Phase F's 6 Tier-2 verification op handlers (contains, get, getMany,
 * insert, update, remove). None of these touch `EvalContext` — they're
 * stateless utilities.
 *
 * Two helper families:
 *
 *   1. Op-builders (`buildSingleLookupOp` / `buildLookupOps` /
 *      `buildInsertOps` / `buildUpdateOps` / `buildRemoveOps`) — assemble
 *      the `Operation[]` arrays that `verifyAvlBatchPartial` consumes.
 *
 *   2. Shape-extractors (`extractBytes` / `extractByteArrayList` /
 *      `extractEntries`) — narrow a runtime `SValue` (always a `Coll`,
 *      either of `Byte`, `Coll[Byte]`, or `Tuple[Coll[Byte], Coll[Byte]]`)
 *      into the `Uint8Array` / `Uint8Array[]` / `{key, value}[]` shapes that
 *      op-builders + config-projection use.
 *
 *   3. Tree-data projection (`avlTreeDataToConfig` / `withUpdatedDigest`) —
 *      project to `AvlTreeConfig` for verifier input, and immutably produce
 *      a successor `AvlTreeData` with a replaced digest on successful
 *      modification.
 *
 * Defensive shape checks throw EvalError `'method-not-implemented'` per
 * the compact-taxonomy decision (Decision #1 from 2g.5). Wire-format
 * invariants make these unreachable for parser-produced trees; the guards
 * exist for hand-crafted MIR / future ConstantPlaceholder injection.
 *
 * Convention: leading-underscore filename follows existing project pattern
 * (`_byte-coll.ts`, `_box-synthesis.ts`, `_coll-helpers.ts`, `_numeric.ts`).
 */

import type { SValue, AvlTreeData } from '../mir/types'
import type { Operation, AvlTreeConfig } from '@ergots/avltree'
import { EvalError } from './eval-context'

// ---------------------------------------------------------------------------
// Tree-data projection helpers.
// ---------------------------------------------------------------------------

/**
 * Pure projection: `AvlTreeData` → `AvlTreeConfig`. Carries forward only
 * `keyLength` and `valueLengthOpt` — the two structural fields the verifier
 * needs to validate leaf key/value lengths. `digest`, `treeFlags`, and any
 * future field are intentionally dropped (the verifier accepts a starting
 * digest separately and does not consult flags).
 */
export function avlTreeDataToConfig(d: AvlTreeData): AvlTreeConfig {
  return {
    keyLength: d.keyLength,
    valueLengthOpt: d.valueLengthOpt,
  }
}

/**
 * Immutable: produce a new `AvlTreeData` with the digest replaced;
 * `treeFlags`, `keyLength`, `valueLengthOpt` carry forward unchanged.
 *
 * Used by every successful Tier-2 modification handler (insert / update /
 * remove) — `verifyAvlBatchPartial` returns the post-batch root digest, and
 * the SAvlTree method-call returns a new tree-value with that digest spliced
 * in. The other fields are invariant across modification (a batch can't
 * change `keyLength` or `valueLengthOpt`).
 */
export function withUpdatedDigest(tree: AvlTreeData, newDigest: Uint8Array): AvlTreeData {
  return {
    digest: newDigest,
    treeFlags: tree.treeFlags,
    keyLength: tree.keyLength,
    valueLengthOpt: tree.valueLengthOpt,
  }
}

/**
 * Immutable: produce a new `AvlTreeData` with `treeFlags` replaced; `digest`,
 * `keyLength`, `valueLengthOpt` carry forward unchanged.
 *
 * Used by `SAvlTree.updateOperations` (100:8) — caller pre-narrows the input
 * i8 SValue to u8 via `& 0xff`. Source: sigma-rust's
 * `avl_tree_data.tree_flags = AvlTreeFlags::parse(new_byte)` at
 * `eval/savltree.rs:86`. We store the byte directly; flag-bit semantics are
 * encoded by the existing `INSERT_ALLOWED_BIT` / `UPDATE_ALLOWED_BIT` /
 * `REMOVE_ALLOWED_BIT` constants in `savltree.ts`.
 */
export function withUpdatedFlags(tree: AvlTreeData, flags: number): AvlTreeData {
  return {
    digest: tree.digest,
    treeFlags: flags & 0xff,
    keyLength: tree.keyLength,
    valueLengthOpt: tree.valueLengthOpt,
  }
}

// ---------------------------------------------------------------------------
// Op-builders — Operation[] assembly.
// ---------------------------------------------------------------------------

/**
 * Build a single-key `Lookup` op (wrapped in a 1-element array, matching the
 * `Operation[]` argument shape `verifyAvlBatchPartial` expects).
 *
 * Used by `contains` and `get` — both call `verifyAvlBatchPartial` with a
 * single-element batch and then project the single result.
 */
export function buildSingleLookupOp(key: Uint8Array): Operation[] {
  return [{ tag: 'Lookup', key }]
}

/**
 * Build N `Lookup` ops from N keys. Used by `getMany`.
 */
export function buildLookupOps(keys: Uint8Array[]): Operation[] {
  return keys.map(key => ({ tag: 'Lookup', key }))
}

/**
 * Extract `Insert` ops from a `Coll[Tuple[Coll[Byte], Coll[Byte]]]` SValue.
 *
 * Used by `insert` — each tuple's first element becomes the key, second
 * becomes the value.
 *
 * @throws EvalError `'method-not-implemented'` if input doesn't conform
 *   (non-Coll, items not `Tuple` of arity 2, tuple elements not Coll[Byte]).
 */
export function buildInsertOps(entries: SValue): Operation[] {
  const pairs = extractEntries(entries)
  return pairs.map(({ key, value }) => ({ tag: 'Insert', key, value }))
}

/**
 * Same shape as `buildInsertOps` but emits `Update` ops. Used by `update`.
 */
export function buildUpdateOps(entries: SValue): Operation[] {
  const pairs = extractEntries(entries)
  return pairs.map(({ key, value }) => ({ tag: 'Update', key, value }))
}

/**
 * Build `Remove` ops from a `Uint8Array[]` of keys. Used by `remove`.
 *
 * Note: takes already-extracted keys (not an SValue) — caller is expected
 * to have already run `extractByteArrayList` on the SValue argument. Mirrors
 * the input pattern of `buildLookupOps` for parallelism.
 */
export function buildRemoveOps(keys: Uint8Array[]): Operation[] {
  return keys.map(key => ({ tag: 'Remove', key }))
}

// ---------------------------------------------------------------------------
// Shape-extractors — SValue → primitive narrow.
// ---------------------------------------------------------------------------

/**
 * `Coll[Byte]` SValue → `Uint8Array`. Each `Byte` item carries a signed i8
 * (range -128..=127 per parser convention at `wire/parse-svalue.ts:96-97`);
 * we recover the u8 wire byte via `value & 0xff`.
 *
 * Used directly by every Tier-2 handler that takes a key or value argument.
 *
 * @throws EvalError `'method-not-implemented'` if `v` is not a `Coll` or
 *   any item is not a `Byte`.
 */
export function extractBytes(v: SValue): Uint8Array {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `expected Coll[Byte] SValue, got '${v.kind}'`,
      'method-not-implemented'
    )
  }
  const out = new Uint8Array(v.items.length)
  for (let i = 0; i < v.items.length; i++) {
    const item = v.items[i]!
    if (item.kind !== 'Byte') {
      throw new EvalError(
        `expected Byte item at index ${i}, got '${item.kind}'`,
        'method-not-implemented'
      )
    }
    // i8 → u8: `& 0xff` recovers the original wire byte for negatives.
    out[i] = item.value & 0xff
  }
  return out
}

/**
 * `Coll[Coll[Byte]]` SValue → `Uint8Array[]`. Recurses `extractBytes` per
 * item. Used by `getMany` (input keys) and `remove` (input keys).
 *
 * @throws EvalError `'method-not-implemented'` if `v` is not a `Coll`, or
 *   any item fails `extractBytes` shape check.
 */
export function extractByteArrayList(v: SValue): Uint8Array[] {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `expected Coll[Coll[Byte]] SValue, got '${v.kind}'`,
      'method-not-implemented'
    )
  }
  return v.items.map(item => extractBytes(item))
}

/**
 * `Coll[Tuple[Coll[Byte], Coll[Byte]]]` SValue → `{key, value}[]`. Defensive
 * shape check at every level: input must be a `Coll`, each item must be a
 * `Tuple` of arity 2, both tuple elements must pass `extractBytes`.
 *
 * Used by `buildInsertOps` / `buildUpdateOps`.
 *
 * @throws EvalError `'method-not-implemented'` on any shape mismatch.
 */
export function extractEntries(v: SValue): { key: Uint8Array; value: Uint8Array }[] {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `expected Coll[Tuple[Coll[Byte], Coll[Byte]]] SValue, got '${v.kind}'`,
      'method-not-implemented'
    )
  }
  return v.items.map((item, i) => {
    if (item.kind !== 'Tuple') {
      throw new EvalError(
        `expected Tuple item at index ${i}, got '${item.kind}'`,
        'method-not-implemented'
      )
    }
    if (item.items.length !== 2) {
      throw new EvalError(
        `expected Tuple of arity 2 at index ${i}, got arity ${item.items.length}`,
        'method-not-implemented'
      )
    }
    return {
      key: extractBytes(item.items[0]!),
      value: extractBytes(item.items[1]!),
    }
  })
}
