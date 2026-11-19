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
 * An outer kind check (the value is not a `Coll`) throws
 * `'method-not-implemented'`; an array of another class (the JVM's
 * `toArray` cast on the key, value, proof or digest) routes through
 * `castArray` and surfaces as `'coll-class-cast'`; an entries item that
 * is no pair takes the JVM's failed `Tuple2` pattern-match cast as
 * `'coll-class-cast'`. Wire-format invariants make the shape checks
 * unreachable for parser-produced trees; the guards exist for
 * hand-crafted MIR / `ConstantPlaceholder` injection.
 *
 * Convention: leading-underscore filename follows existing project pattern
 * (`_byte-coll.ts`, `_box-synthesis.ts`, `_coll-helpers.ts`, `_numeric.ts`).
 */

import type { SValue, AvlTreeData } from '../mir/types'
import type { Operation, AvlTreeConfig } from '@ergots/avltree'
import { EvalError } from './eval-context'
import { castArray } from './_coll'

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
 * @throws EvalError `'method-not-implemented'` on a non-Coll input,
 *   `'coll-class-cast'` on an item that is no pair or whose component's
 *   array is of another class (see `extractEntries`).
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
 * Same shape as `buildInsertOps` but emits `InsertOrUpdate` ops. Used by
 * `SAvlTree.insertOrUpdate` (100:16; V3-gated). Source: savltree.rs:480-489.
 *
 * `extractEntries` returns `{ key, value }[]` per the existing
 * shape-extractor signature.
 */
export function buildInsertOrUpdateOps(entries: SValue): Operation[] {
  const pairs = extractEntries(entries)
  return pairs.map(({ key, value }) => ({ tag: 'InsertOrUpdate', key, value }))
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
 * `Coll[Byte]` SValue → `Uint8Array`, by the JVM's array cast
 * (`key.toArray` / `proof.toArray` / `value.toArray` /
 * `digest.toArray` in `CErgoTreeEvaluator`'s AvlTree methods and in
 * `CAvlTreeVerifier.apply`). Each `Byte` item carries a signed i8
 * (`wire/parse-svalue.ts:96-97`); we recover the u8 wire byte via
 * `value & 0xff`.
 *
 * Used by every Tier-2 handler that takes a key, value, proof, or digest
 * argument. A non-`Coll` input is a type error (`'method-not-implemented'`
 * for parser-produced trees, defensive against `ConstantPlaceholder`
 * injection). A `Coll` whose array is of another class — `Object[]` from a
 * tuple's `Coll[Any]`, for one — routes through the module's `castArray`
 * (`coll/ops.ts`) to `'coll-class-cast'`, the JVM's `ClassCastException` on
 * the array cast.
 */
export function extractBytes(v: SValue): Uint8Array {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `expected Coll[Byte] SValue, got '${v.kind}'`,
      'method-not-implemented'
    )
  }
  const items = castArray(v, 'byte', 'AvlTree byte argument')
  const out = new Uint8Array(items.length)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind !== 'Byte') {
      // Defensive: an array of class `'byte'` holds `Byte` items. Fall back
      // to the taxonomy's shape code for a mislabelled value.
      throw new EvalError(
        `expected Byte item at index ${i}, got '${item.kind}'`,
        'method-not-implemented'
      )
    }
    out[i] = item.value & 0xff
  }
  return out
}

/**
 * `Coll[Coll[Byte]]` SValue → `Uint8Array[]`. The outer collection is read
 * through the interface, as `keys.map { key => key.toArray }` in
 * `CErgoTreeEvaluator.getMany_eval` (`:124`) and
 * `operations(i).toArray` in `remove_eval` (`:242`); each inner `Coll[Byte]`
 * is cast through `extractBytes` (the JVM's `key.toArray`).
 *
 * Used by `getMany` (input keys) and `remove` (input keys).
 */
export function extractByteArrayList(v: SValue): Uint8Array[] {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `expected Coll[Coll[Byte]] SValue, got '${v.kind}'`,
      'method-not-implemented'
    )
  }
  // The outer read walks `v.items` through the Coll interface; each inner
  // item goes through the byte-array cast.
  return v.items.map(item => extractBytes(item))
}

/**
 * `Coll[Tuple[Coll[Byte], Coll[Byte]]]` SValue → `{key, value}[]`. The outer
 * collection is read through the interface, as the JVM's
 * `entries.forall { case (key, value) => ... }` reads it
 * (`CErgoTreeEvaluator.insert_eval` `:141`, `update_eval` `:174`,
 * `insertOrUpdate_eval` `:205`). Each item is pattern-matched as a `Tuple2`:
 * an item that is no pair fails the match on the JVM, mirrored here as
 * `'coll-class-cast'` (a failed cast of the item to a pair). Each
 * component's bytes are then cast as `extractBytes` does.
 *
 * Used by `buildInsertOps` / `buildUpdateOps` / `buildInsertOrUpdateOps`.
 */
export function extractEntries(v: SValue): { key: Uint8Array; value: Uint8Array }[] {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `expected Coll[Tuple[Coll[Byte], Coll[Byte]]] SValue, got '${v.kind}'`,
      'method-not-implemented'
    )
  }
  return v.items.map((item, i) => {
    if (item.kind !== 'Tuple' || item.items.length !== 2) {
      // The JVM's `case (k, v) =>` pattern match on an item that is no
      // `Tuple2` fails the cast; mirror that as the array-cast code.
      throw new EvalError(
        `AvlTree entries: item at index ${i} is not a pair (got kind '${item.kind}')`,
        'coll-class-cast'
      )
    }
    return {
      key: extractBytes(item.items[0]!),
      value: extractBytes(item.items[1]!),
    }
  })
}
