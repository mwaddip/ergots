/**
 * EvalError code taxonomy for `@ergots/ergoscript`.
 *
 * `EvalErrorCode` is a string-literal union covering all legal second-argument
 * values for `new EvalError(message, code)`. Collecting them here:
 *   - serves as a single-place reference for reviewers
 *   - enables TypeScript to flag typos in `new EvalError(…, 'bad-code')` calls
 *     if you annotate the code parameter (opt-in; `EvalError` itself keeps `code: string`
 *     for ergonomic construction in each arm without needing to import this type)
 *   - documents the 40 + 3 + 1 = 44 codes added through phase 2h-b Tier 1
 *
 * **Do not add codes here without also adding them to the relevant arm's source
 * file and test.** This file is the taxonomy, not the source of truth for
 * behaviour.
 *
 * History:
 *   28 codes through phase 2f medium (GlobalVars/GetVar/Option/SelectField)
 *    + 7 codes added in phase 2f Coll HOFs (Task 1, 2026-05-16)
 *    + 1 code added in phase 2g-medium (sigma-protocol primitives)
 *    + 4 codes added in phase 2g-combinators (Atleast + sigma helpers)
 *    + 3 codes added in phase 2g.5 (method-call dispatch + SigmaPropBytes + SContext.dataInputs)
 *    + 1 code added in phase 2h-b Tier 1 (SAvlTree pure accessors)
 *    + 1 code added in phase 2h-b Tier 2 (SAvlTree verification ops)
 *    + 1 code added in phase 2h-c.1 (SHeader property accessors)
 *    + 1 code added in phase 2h-c.2 (SHeader.checkPow — Autolykos V1 guard)
 *    + 1 code added in phase 2h-d (SAvlTree.updateDigest length check)
 *    + 1 code added in phase 2i-a (pure-bytes predef input guard)
 *   = 49 codes total after phase 2i-a T2 (CalcBlake2b256).
 */

/**
 * All legal EvalError codes, grouped by phase and arm family.
 *
 * Use this type for narrowing `catch (e)` clauses or exhaustive switch checks
 * in test utilities.
 */
export type EvalErrorCode =
  // -------------------------------------------------------------------------
  // Infrastructure / cross-cutting (2 codes)
  // -------------------------------------------------------------------------
  /** Cost accumulator overflow: addCost / addPerItemCost exceeded jitCostLimit. */
  | 'cost-limit-exceeded'
  /** Arm not yet implemented (eval.ts dispatch default). */
  | 'not-implemented-yet'

  // -------------------------------------------------------------------------
  // Phase 2b — Const / Block / Val (5 codes)
  // -------------------------------------------------------------------------
  /** ConstPlaceholder id is >= constants.length. */
  | 'const-placeholder-id-out-of-range'
  /** ConstPlaceholder used when the tree has no constant-segregation section. */
  | 'const-placeholder-no-constants'
  /** ValDef node reached the evaluator directly (should only be processed by BlockValue). */
  | 'val-def-outside-block'
  /** ValUse references an id not bound in the current environment. */
  | 'val-use-unbound'
  /** BlockValue item is not a ValDef node. */
  | 'block-item-not-val-def'

  // -------------------------------------------------------------------------
  // Phase 2b — If / Collection (2 codes)
  // -------------------------------------------------------------------------
  /** If.condition evaluated to non-Boolean SValue. */
  | 'if-condition-not-boolean'
  /** Collection literal: runtime element kind mismatches declared element SType. */
  | 'collection-elem-kind-mismatch'

  // -------------------------------------------------------------------------
  // Phase 2c — BinOp family (5 codes)
  // -------------------------------------------------------------------------
  /** BinOp: operands evaluated to non-numeric kinds. */
  | 'bin-op-not-numeric'
  /** BinOp: operands evaluated to non-Boolean kinds (logical ops); also BoolToSigmaProp. */
  | 'bin-op-not-boolean'
  /** BinOp: operator kind not handled by the dispatch arm (defensive). */
  | 'bin-op-kind-mismatch'
  /** BinOp arith: integer overflow (checked arithmetic on Long/BigInt). */
  | 'arith-overflow'
  /** BinOp arith: division or modulo by zero. */
  | 'arith-divide-by-zero'

  // -------------------------------------------------------------------------
  // Phase 2d-A — Upcast / Downcast (2 codes)
  // -------------------------------------------------------------------------
  /** Upcast/Downcast: requires ErgoTree version ≥ required level. */
  | 'tree-version-too-low'
  /** Downcast: target value out of range for target integer type. */
  | 'downcast-overflow'

  // -------------------------------------------------------------------------
  // Phase 2d-B — And / Or / XorOf (Coll[Boolean] aggregators) (1 code)
  // -------------------------------------------------------------------------
  /** And/Or/XorOf: input evaluated to non-Coll or Coll with non-Boolean elements. */
  | 'coll-not-boolean'

  // -------------------------------------------------------------------------
  // Phase 2e — FuncValue / Apply (2 codes)
  // -------------------------------------------------------------------------
  /** Apply: func evaluated to non-Lambda SValue. */
  | 'apply-non-lambda'
  /** Apply: argument count doesn't match lambda arity. */
  | 'apply-arity-mismatch'

  // -------------------------------------------------------------------------
  // Phase 2f narrow — Box runtime (3 codes)
  // -------------------------------------------------------------------------
  /** Box-extract arm: input evaluated to non-Box SValue. */
  | 'extract-input-not-box'
  /** ExtractRegisterAs: register id is outside valid range. */
  | 'register-id-out-of-range'
  /** ExtractRegisterAs: declared type doesn't match stored register type. */
  | 'register-type-mismatch'

  // -------------------------------------------------------------------------
  // Phase 2f medium — GlobalVars / GetVar / Option / SelectField (6 codes)
  // -------------------------------------------------------------------------
  /** GlobalVars: required context field is missing (e.g. ctx.selfBox is undefined). */
  | 'context-field-missing'
  /** GetVar: variable's stored type doesn't match requested type. */
  | 'get-var-type-mismatch'
  /** OptionGet / OptionIsDefined / OptionGetOrElse: input evaluated to non-Option SValue. */
  | 'option-input-not-option'
  /** OptionGet: Option is None (no value). */
  | 'option-empty'
  /** SelectField: input evaluated to non-Tuple SValue. */
  | 'select-field-input-not-tuple'
  /** SelectField: field index is out of range for the Tuple arity. */
  | 'select-field-index-out-of-range'

  // -------------------------------------------------------------------------
  // Phase 2f Coll HOFs — 7 new codes (Task 1, 2026-05-16) (7 codes)
  // Total taxonomy: 28 → 35.
  // -------------------------------------------------------------------------
  /** All 9 Coll HOF arms: input evaluated to a non-Coll SValue. */
  | 'coll-input-not-coll'
  /**
   * Append, MapColl, Filter, Exists, ForAll: declared or expected element type
   * doesn't match the runtime element type of the Coll input.
   *   - Append: input.elem vs col_2.elem mismatch.
   *   - MapColl: input.elem vs mapper_sfunc.t_dom[0] mismatch.
   *   - Filter/Exists/ForAll: input.elem vs declared elem_tpe mismatch.
   */
  | 'coll-elem-tpe-mismatch'
  /** ByIndex: index is OOB and no `default` branch was provided. */
  | 'coll-by-index-out-of-range'
  /** ByIndex: index expression evaluated to a non-Int SValue (defensive). */
  | 'coll-by-index-index-not-int'
  /** Slice: `from` or `until` expression evaluated to a non-Int SValue. */
  | 'coll-slice-bound-not-int'
  /**
   * 5 lambda HOFs (MapColl, Filter, Fold, Exists, ForAll): the
   * mapper/condition/fold_op evaluated to a non-Lambda SValue — OR to a
   * Lambda with an empty argIds list (defensive). Both cases merged into one
   * code (per design spec Decision #8).
   */
  | 'lambda-not-callable'
  /**
   * 5 lambda HOFs: lambda body returned the wrong SType:
   *   - Filter/Exists/ForAll: body must return Boolean.
   *   - MapColl: body must return mapper_sfunc.t_range.
   *   - Fold: body must return zero.tpe (accumulator type).
   */
  | 'lambda-result-type-mismatch'

  // -------------------------------------------------------------------------
  // Phase 2g-medium — sigma-protocol primitives (1 new code)
  // Total taxonomy: 35 → 36.
  // -------------------------------------------------------------------------
  /**
   * `CreateProveDlog` / `CreateProveDhTuple` input expression evaluated to a
   * non-GroupElement SValue. Wire-format invariants make this unreachable for
   * parser-produced trees (sigma-rust's `OneArgOpTryBuild`/`new` reject at
   * construction); defensive against `ConstantPlaceholder` injection and
   * future MIR shape changes.
   *
   * Source: ergotree-interpreter/src/eval/create_provedlog.rs:21-26
   */
  | 'sigma-prop-input-not-group-element'

  // -------------------------------------------------------------------------
  // Phase 2g-combinators — Atleast + sigma helpers (4 new codes)
  // Total taxonomy: 36 → 40.
  // -------------------------------------------------------------------------
  /**
   * `Atleast`: bound expression evaluated to a non-Int SValue. Wire-format
   * invariants (`Atleast::new` enforces `post_eval_tpe == SInt` at construction)
   * make this unreachable for parser-produced trees; defensive against
   * `ConstantPlaceholder` injection.
   *
   * Source: ergotree-interpreter/src/eval/atleast.rs:19-44
   */
  | 'atleast-bound-not-int'
  /**
   * `Atleast` / `_sigma-helpers.extractSigmaPropColl`: a Coll element
   * evaluated to a non-SigmaProp SValue. Wire-format invariants
   * (`Atleast::new` enforces `SColl(SSigmaProp)` on input) make this
   * unreachable for parser-produced trees; defensive against
   * `ConstantPlaceholder` injection.
   *
   * Source: ergotree-interpreter/src/eval/atleast.rs:39-46
   */
  | 'sigma-prop-coll-elem-not-sigma-prop'
  /**
   * `Atleast` / `_sigma-helpers.extractSigmaPropColl`: input expression
   * evaluated to a non-Coll SValue. Wire-format invariants make this
   * unreachable for parser-produced trees; defensive against
   * `ConstantPlaceholder` injection.
   *
   * Source: ergotree-interpreter/src/eval/atleast.rs:31-37
   */
  | 'sigma-prop-input-not-coll'
  /**
   * `Atleast`: bound value is out of the valid range [0, 255] (i.e., does
   * not fit in a u8) or bound > items.length (impossible to prove k of n
   * when k > n). Both conditions map to `EvalError::Misc` in sigma-rust.
   *
   * Source: ergotree-interpreter/src/eval/atleast.rs:49-56
   */
  | 'atleast-bound-out-of-range'

  // -------------------------------------------------------------------------
  // Phase 2g.5 — method-call dispatch + SigmaPropBytes + SContext.dataInputs
  // (3 new codes; 40 → 43)
  // -------------------------------------------------------------------------
  /**
   * `MethodCall` / `PropertyCall` dispatcher: the `(typeId, methodId)` pair
   * has no registered handler in the HANDLERS registry. Also reused for
   * defensive shape mismatches inside registered handlers (e.g., obj.kind
   * doesn't match what the handler expects). Option 1 of the error-taxonomy
   * decision in the design spec (compact taxonomy; revisit if any defensive
   * throw becomes externally-meaningful).
   *
   * Source: ergotree-interpreter/src/eval/method_call.rs:17,
   *         ergotree-interpreter/src/eval/property_call.rs:16
   */
  | 'method-not-implemented'
  /**
   * `SigmaPropBytes`: input expression evaluated to a non-SigmaProp SValue.
   * Wire-format invariants (`OneArgOpTryBuild::try_build` checks post_eval_tpe
   * at construction) make this unreachable for parser-produced trees; defensive
   * against `ConstantPlaceholder` injection.
   *
   * Source: ergotree-interpreter/src/eval/sigma_prop_bytes.rs:18-23
   */
  | 'sigma-prop-bytes-input-not-sigma-prop'
  /**
   * `SContext.dataInputs`: `obj` evaluated to a non-Context SValue. Wire-format
   * invariants (PropertyCall construction via sigma-rust) make this unreachable
   * for parser-produced trees; defensive against `ConstantPlaceholder` injection
   * or hand-crafted MIR trees.
   *
   * Source: ergotree-interpreter/src/eval/scontext.rs:17-31
   */
  | 'context-obj-not-context'

  // -------------------------------------------------------------------------
  // Phase 2h-b Tier 1 — SAvlTree pure accessors (1 new code; 43 → 44)
  // -------------------------------------------------------------------------
  /**
   * Any of the 7 SAvlTree Tier-1 accessor handlers
   * (`digest` / `enabledOperations` / `keyLength` / `valueLengthOpt` /
   * `isInsertAllowed` / `isUpdateAllowed` / `isRemoveAllowed`) when `obj`
   * evaluated to a non-AvlTree SValue. Wire-format invariants (PropertyCall
   * construction with an SAvlTree-typed obj) make this unreachable for
   * parser-produced trees; defensive against `ConstantPlaceholder` injection
   * or hand-crafted MIR trees.
   *
   * Source: ergotree-interpreter/src/eval/savltree.rs:29-75
   */
  | 'avl-tree-obj-not-avl-tree'

  // -------------------------------------------------------------------------
  // Phase 2h-b Tier 2 — SAvlTree verification ops (1 new code; 44 → 45)
  // -------------------------------------------------------------------------
  /**
   * Any of the 6 SAvlTree Tier-2 verification op handlers (`get` / `getMany` /
   * `insert` / `update` / `remove`) when proof verification fails. Two failure
   * modes both surface as this code:
   *   - verifier construct failure (proof bytes malformed, digest mismatch,
   *     length-validation failure) — thrown by all 5 of those handlers; also
   *     thrown by `contains` despite its overall return-`false`-on-per-op
   *     failure semantics (per sigma-rust line 372: `.map_err(map_eval_err)?`
   *     unwraps construct failure before reaching the match on the per-op
   *     result).
   *   - per-op failure surfacing in `get` / `getMany` / `remove` /
   *     (V<3-only) `insert` — per-key Lookup/Remove failure forces the
   *     `EvalError::AvlTree("Tree proof is incorrect ...")` path in
   *     sigma-rust. `contains` swallows per-op failure (returns `false`);
   *     `update` always breaks (no throw); V3+ `insert` also breaks.
   *
   * Source:
   *   - savltree.rs:148-149  (GET_EVAL_FN per-op fail)
   *   - savltree.rs:200-203  (GET_MANY_EVAL_FN per-op fail)
   *   - savltree.rs:262-266  (INSERT_EVAL_FN V<3 per-op fail)
   *   - savltree.rs:322-325  (REMOVE_EVAL_FN per-op fail)
   *   - savltree.rs:372      (CONTAINS_EVAL_FN construct fail via `?`)
   */
  | 'avl-tree-proof-failed'

  // -------------------------------------------------------------------------
  // Phase 2h-c.1 — SHeader property accessors (1 new code; 45 → 46)
  // -------------------------------------------------------------------------
  /**
   * Any of the 15 SHeader property accessor handlers (typeId 104, methodIds 1-15)
   * when `obj` evaluated to a non-Header SValue. Wire-format invariants
   * (PropertyCall construction with an SHeader-typed obj via `ByIndex` on
   * `Context.headers`) make this unreachable for parser-produced trees;
   * defensive against `ConstantPlaceholder` injection or hand-crafted MIR trees.
   *
   * Source: ergotree-interpreter/src/eval/sheader.rs:16-113
   */
  | 'header-obj-not-header'

  // -------------------------------------------------------------------------
  // Phase 2h-c.2 — SHeader.checkPow (1 new code; 46 → 47)
  // -------------------------------------------------------------------------
  /**
   * `SHeader.checkPow` (typeId 104, methodId 16): `verifyAutolykosV2` threw
   * `AutolykosV1NotSupportedError` because the header carries Autolykos v1 PoW.
   * Mirrors sigma-rust's `AutolykosPowSchemeError::Unsupported`.
   * Wire-format invariants make this unreachable in practice (script-touched
   * headers are typically V2+ for ~5 years post-mainnet-417792); defensive
   * against unusual `ctx.headers` constructions.
   *
   * Source: ergotree-interpreter/src/eval/sheader.rs:115-124
   */
  | 'autolykos-v1-not-supported'

  // -------------------------------------------------------------------------
  // Phase 2h-d — SAvlTree.updateDigest (1 new code; 47 → 48)
  // -------------------------------------------------------------------------
  /**
   * `SAvlTree.updateDigest`: the Coll[Byte] argument is not exactly 33 bytes
   * (the required ADDigest length: 32-byte root hash + 1 tree-height byte).
   * Mirrors sigma-rust's `ADDigest::try_from` length-check failure surfaced
   * as `EvalError::Misc`.
   *
   * Source: ergotree-interpreter/src/eval/savltree.rs:98
   */
  | 'avl-tree-bad-digest-length'

  // -------------------------------------------------------------------------
  // Phase 2i-a — Pure-bytes predefs (1 new code; 48 → 49)
  // -------------------------------------------------------------------------
  /**
   * Pure-bytes predef arms (`CalcBlake2b256`, `CalcSha256`, `ByteArrayToLong`,
   * `ByteArrayToBigInt`, `LongToByteArray`, `Xor`, `DecodePoint`,
   * `SubstConstants`): input expression evaluated to a non-`Coll[Byte]`
   * SValue (or an inner item kind didn't match `Byte`). Wire-format
   * invariants (`OneArgOpTryBuild::try_build` / per-arm `try_build` enforce
   * `check_post_eval_tpe(SColl(SByte))` at parse time) make this unreachable
   * for parser-produced trees; defensive against `ConstantPlaceholder`
   * injection or hand-crafted MIR.
   *
   * Source: ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34
   *         ergotree-interpreter/src/eval/calc_sha256.rs (companion)
   *         (T3-T9 follow the same code per phase 2i-a design)
   */
  | 'predef-input-not-byte-array'
