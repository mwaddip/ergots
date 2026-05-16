/**
 * Mutations expected to survive (i.e., the operator produces a structurally
 * equivalent variant that the evaluator correctly handles identically).
 *
 * Format: `${arm}:${entryName}:${operatorName}:${siteIndex}`
 * Populated by Task 12 calibration (89 total survivals across 9 arms).
 *
 * Classification categories used:
 *
 * A — SizeOf invariance: SizeOf only inspects .length; mutating item values
 *     (replaceLeafConst or mutateCollItem on Coll items) doesn't change the result.
 *
 * B — Append empty-side commutativity: Append([], X) == Append(X, []) when one
 *     side is empty; swapBinaryChildren produces an identical result.
 *
 * C — ByIndex non-indexed slot: ByIndex reads exactly one item; mutating items
 *     NOT at the accessed index is invisible (replaceLeafConst / mutateCollItem
 *     on those slots survive). Covers both in-bounds and OOB/negative-index cases.
 *
 * D — ByIndex dead branch (lazy evaluation): when tree version enables lazy
 *     ByIndex evaluation, the unused branch (default when in-bounds, or coll
 *     items when OOB) contains constants that are never evaluated.
 *
 * E — Slice boundary clamping: when from/until are already in a clamped regime
 *     (neg from, OOB until, from >= until, or empty input), a +1 mutation on
 *     those bounds stays in the same clamped state and produces the same result.
 *
 * F — Commutative BinOp (O2): swapBinaryChildren on Plus/Mul/And/Or BinOps
 *     inside lambda bodies or fold accumulators: a+b == b+a, a*b == b*a.
 *
 * G — Empty collection: any mutation to a lambda body or Coll items is invisible
 *     when the collection is empty (lambda never invoked; items don't exist).
 *     Covers replaceLeafConst, replaceLambdaBodyConst, swapBinaryChildren,
 *     negateBooleanCond on the empty-input arms of map/filter/fold/exists/forall.
 *
 * H — Exists/ForAll mixed-item stability: when a collection has both items that
 *     pass and fail the original condition, negating the condition (negateBooleanCond)
 *     does not flip the Exists (True→True) or ForAll (False→False) result, because
 *     items that previously failed now pass and keep the outcome stable.
 *
 * I — Threshold proximity: +1 mutation on a condition threshold that is already
 *     strict enough that all items still fail (for no-match Exists) or still pass
 *     (for all-pass ForAll). Not a fundamental structural invariance, but the
 *     accidental invariance is narrow enough to allowlist on first-pass calibration.
 */
export const EXPECTED_SURVIVALS = new Set<string>([
  // ── Category A: SizeOf invariance ────────────────────────────────────────
  // coll_size_int_5 (5-item Int coll): all 5 items and their constants are invisible to SizeOf
  'coll-size:coll_size_int_5:replaceLeafConst:0',
  'coll-size:coll_size_int_5:replaceLeafConst:1',
  'coll-size:coll_size_int_5:replaceLeafConst:2',
  'coll-size:coll_size_int_5:replaceLeafConst:3',
  'coll-size:coll_size_int_5:replaceLeafConst:4',
  'coll-size:coll_size_int_5:mutateCollItem:0',
  'coll-size:coll_size_int_5:mutateCollItem:1',
  'coll-size:coll_size_int_5:mutateCollItem:2',
  'coll-size:coll_size_int_5:mutateCollItem:3',
  'coll-size:coll_size_int_5:mutateCollItem:4',
  // coll_size_long_3 (3-item Long coll)
  'coll-size:coll_size_long_3:replaceLeafConst:0',
  'coll-size:coll_size_long_3:replaceLeafConst:1',
  'coll-size:coll_size_long_3:replaceLeafConst:2',
  'coll-size:coll_size_long_3:mutateCollItem:0',
  'coll-size:coll_size_long_3:mutateCollItem:1',
  'coll-size:coll_size_long_3:mutateCollItem:2',
  // coll_size_nested_2 (2-item nested coll): inner item items of the outer collection
  'coll-size:coll_size_nested_2:replaceLeafConst:0',
  'coll-size:coll_size_nested_2:replaceLeafConst:1',
  'coll-size:coll_size_nested_2:replaceLeafConst:2',
  'coll-size:coll_size_nested_2:mutateCollItem:0',
  'coll-size:coll_size_nested_2:mutateCollItem:1',
  'coll-size:coll_size_nested_2:mutateCollItem:2',
  'coll-size:coll_size_nested_2:mutateCollItem:3',
  'coll-size:coll_size_nested_2:mutateCollItem:4',
  'coll-size:coll_size_nested_2:mutateCollItem:5',

  // ── Category B: Append empty-side commutativity ───────────────────────────
  // Append([], X) and Append(X, []) both equal X; swap is transparent.
  // coll_append_empty_lhs = Append([], [1,2,3])  → swap → Append([1,2,3], []) = same
  'coll-append:coll_append_empty_lhs:swapBinaryChildren:0',
  // coll_append_empty_rhs = Append([1,2,3], [])  → swap → Append([], [1,2,3]) = same
  'coll-append:coll_append_empty_rhs:swapBinaryChildren:0',
  // coll_append_both_empty = Append([], [])       → swap → same
  'coll-append:coll_append_both_empty:swapBinaryChildren:0',
  // coll_append_cost_eq_lhs = Append([1..100], []) → swap → Append([], [1..100]) = same
  'coll-append:coll_append_cost_eq_lhs:swapBinaryChildren:0',
  // coll_append_cost_eq_rhs = Append([], [1..100]) → swap → Append([1..100], []) = same
  'coll-append:coll_append_cost_eq_rhs:swapBinaryChildren:0',

  // ── Category C: ByIndex non-indexed slot ─────────────────────────────────
  // coll_by_index_happy: coll=[10,20,30], index=1 (expected=20)
  // Sites 0 (item=10) and 2 (item=30) are not the accessed slot.
  'coll-by-index:coll_by_index_happy:replaceLeafConst:0',
  'coll-by-index:coll_by_index_happy:replaceLeafConst:2',
  'coll-by-index:coll_by_index_happy:mutateCollItem:0',
  'coll-by-index:coll_by_index_happy:mutateCollItem:2',
  // coll_by_index_oob_with_def: OOB index, default=99 is used.
  // Coll items (sites 0,1,2) are not accessed; only the default matters.
  'coll-by-index:coll_by_index_oob_with_def:replaceLeafConst:0',
  'coll-by-index:coll_by_index_oob_with_def:replaceLeafConst:1',
  'coll-by-index:coll_by_index_oob_with_def:replaceLeafConst:2',
  'coll-by-index:coll_by_index_oob_with_def:mutateCollItem:0',
  'coll-by-index:coll_by_index_oob_with_def:mutateCollItem:1',
  // coll_by_index_neg_with_def: negative index treated as OOB, default=99 used.
  // Coll items (sites 0,1) are not accessed.
  'coll-by-index:coll_by_index_neg_with_def:replaceLeafConst:0',
  'coll-by-index:coll_by_index_neg_with_def:replaceLeafConst:1',
  'coll-by-index:coll_by_index_neg_with_def:mutateCollItem:0',
  'coll-by-index:coll_by_index_neg_with_def:mutateCollItem:1',

  // ── Category D: ByIndex dead branch (lazy evaluation) ────────────────────
  // coll_by_index_lazy_inbounds (treeVersion=3): index is in bounds, default never evaluated.
  // Sites 0,2 are non-indexed coll items; sites 4,5 are constants in the dead default branch.
  // swapBinaryChildren:0 is a commutative BinOp in the coll or index construction (still same result).
  'coll-by-index:coll_by_index_lazy_inbounds:replaceLeafConst:0',
  'coll-by-index:coll_by_index_lazy_inbounds:replaceLeafConst:2',
  'coll-by-index:coll_by_index_lazy_inbounds:replaceLeafConst:4',
  'coll-by-index:coll_by_index_lazy_inbounds:replaceLeafConst:5',
  'coll-by-index:coll_by_index_lazy_inbounds:swapBinaryChildren:0',
  'coll-by-index:coll_by_index_lazy_inbounds:mutateCollItem:0',
  'coll-by-index:coll_by_index_lazy_inbounds:mutateCollItem:2',
  // coll_by_index_lazy_oob (treeVersion=3): index is OOB, coll items never evaluated.
  // Sites 0-3 are constants in the un-accessed coll; swapBinaryChildren:0 is a
  // commutative BinOp in the dead coll-construction branch.
  'coll-by-index:coll_by_index_lazy_oob:replaceLeafConst:0',
  'coll-by-index:coll_by_index_lazy_oob:replaceLeafConst:1',
  'coll-by-index:coll_by_index_lazy_oob:replaceLeafConst:2',
  'coll-by-index:coll_by_index_lazy_oob:replaceLeafConst:3',
  'coll-by-index:coll_by_index_lazy_oob:swapBinaryChildren:0',
  'coll-by-index:coll_by_index_lazy_oob:mutateCollItem:0',
  'coll-by-index:coll_by_index_lazy_oob:mutateCollItem:1',
  'coll-by-index:coll_by_index_lazy_oob:mutateCollItem:2',

  // ── Category E: Slice boundary clamping ──────────────────────────────────
  // coll_slice_neg_from: from=-1, Slice clamps to 0; mutating -1→0 is the same clamp point.
  'coll-slice:coll_slice_neg_from:replaceLeafConst:0',
  // coll_slice_until_oob: until > length, clamped; +1 stays beyond bounds, same clamp.
  'coll-slice:coll_slice_until_oob:replaceLeafConst:1',
  // coll_slice_from_ge_until: from >= until → []; +1 on either bound preserves this inequality.
  'coll-slice:coll_slice_from_ge_until:replaceLeafConst:0',
  'coll-slice:coll_slice_from_ge_until:replaceLeafConst:1',
  // coll_slice_empty_input: input coll is empty; any from/until gives [].
  'coll-slice:coll_slice_empty_input:replaceLeafConst:0',
  'coll-slice:coll_slice_empty_input:replaceLeafConst:1',
  // coll_slice_large_range: until constant is already at/beyond coll length; +1 still beyond.
  'coll-slice:coll_slice_large_range:replaceLeafConst:1',

  // ── Category F: Commutative BinOp (O2 swapBinaryChildren) ───────────────
  // coll-map: mapper body is Add(ValUse, Const(1)); swap → Add(Const(1), ValUse) = same.
  'coll-map:coll_map_happy:swapBinaryChildren:0',
  // coll-fold: fold body is Plus(acc, elem) or Mul(acc, elem); both commutative.
  'coll-fold:coll_fold_happy_sum:swapBinaryChildren:0',
  'coll-fold:coll_fold_multiply:swapBinaryChildren:0',
  'coll-fold:coll_fold_byte_coll:swapBinaryChildren:0',
  'coll-fold:coll_fold_sg_n12:swapBinaryChildren:0',
  // coll-exists: condition body has a commutative comparison (e.g., EQ or AND-chain).
  'coll-exists:coll_exists_happy:swapBinaryChildren:0',

  // ── Category G: Empty collection ─────────────────────────────────────────
  // Fold on empty coll: fold body (BinOp) is never called; swap is invisible.
  'coll-fold:coll_fold_empty:swapBinaryChildren:0',
  // Map on empty coll: mapper is never invoked.
  'coll-map:coll_map_empty:replaceLeafConst:0',
  'coll-map:coll_map_empty:swapBinaryChildren:0',
  'coll-map:coll_map_empty:replaceLambdaBodyConst:0',
  // Filter on empty coll: condition is never invoked.
  'coll-filter:coll_filter_empty:replaceLeafConst:0',
  'coll-filter:coll_filter_empty:replaceLambdaBodyConst:0',
  'coll-filter:coll_filter_empty:negateBooleanCond:0',
  // Exists on empty coll: no items, result always False regardless of condition.
  'coll-exists:coll_exists_empty:replaceLeafConst:0',
  'coll-exists:coll_exists_empty:replaceLambdaBodyConst:0',
  'coll-exists:coll_exists_empty:negateBooleanCond:0',
  // ForAll on empty coll: no items, result always True regardless of condition.
  'coll-forall:coll_forall_empty:replaceLeafConst:0',
  'coll-forall:coll_forall_empty:replaceLambdaBodyConst:0',
  'coll-forall:coll_forall_empty:negateBooleanCond:0',

  // ── Category H: Exists/ForAll mixed-item stability ───────────────────────
  // coll_exists_happy (True): coll has both matching and non-matching items.
  // Negating the condition flips which items pass/fail, but Exists remains True
  // (items that previously failed now pass, keeping at least one match).
  'coll-exists:coll_exists_happy:negateBooleanCond:0',
  // coll_exists_sg_full_outer_cost (True): same mixed-item pattern with large coll.
  'coll-exists:coll_exists_sg_full_outer_cost:negateBooleanCond:0',
  // coll_forall_sg_full_outer_cost (False): coll has both passing and failing items.
  // Negating the condition: items that passed now fail, keeping ForAll False.
  'coll-forall:coll_forall_sg_full_outer_cost:negateBooleanCond:0',

  // ── Category I: Threshold proximity ──────────────────────────────────────
  // coll_exists_no_match (False): coll is [2,4,6], condition is x > threshold where
  // threshold is high enough that all items fail. +1 mutation still leaves all items
  // failing; the threshold-crossing point is not in the +1 neighbourhood.
  // replaceLeafConst:0 mutates a coll item constant (2→3, still fails condition).
  // replaceLambdaBodyConst:0 mutates the threshold inside the lambda (threshold+1, still strict).
  'coll-exists:coll_exists_no_match:replaceLeafConst:0',
  'coll-exists:coll_exists_no_match:replaceLambdaBodyConst:0',
])
