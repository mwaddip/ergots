/**
 * EvalError code taxonomy for `@ergots/ergoscript`.
 *
 * `EvalErrorCode` is a string-literal union covering all legal second-argument
 * values for `new EvalError(message, code)`. Collecting them here:
 *   - serves as a single-place reference for reviewers
 *   - enables TypeScript to flag typos in `new EvalError(…, 'bad-code')` calls
 *     if you annotate the code parameter (opt-in; `EvalError` itself keeps `code: string`
 *     for ergonomic construction in each arm without needing to import this type)
 *   - documents the 73 codes added through v6 P2 (SUnsignedBigInt; see history)
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
 *    + 1 code added in v6 P1 C1 final-review fix (numeric-method-bad-operand)
 *    + 7 codes added in phase 2i-a (pure-bytes predefs):
 *        - 'predef-input-not-byte-array' (T2; shared by T2/T3/T4/T6/T7/T8)
 *        - 'byte-array-to-long-too-short' (T4)
 *        - 'predef-input-not-long' (T5)
 *        - 'byte-array-to-bigint-empty' (T6)
 *        - 'byte-array-to-bigint-out-of-range' (T6)
 *        - 'decode-point-invalid' (T8)
 *        - 'subst-constants-error' (T9 — compact umbrella for 7 paths)
 *    + 4 codes added in phase 2i-b (curve + AVL + sigma-trivial predefs):
 *        - 'sigma-prop-is-proven-no-eval' (T2 — frontend-only structural throw)
 *        - 'group-op-input-not-group-element' (T3+T4 — MultiplyGroup + Exponentiate base)
 *        - 'predef-input-not-bigint' (T4 — Exponentiate's BigInt exponent)
 *        - 'create-avl-tree-shape-mismatch' (T5 — compact: flags/keyLength/valueLength)
 *    + 5 codes added in phase 2i-c (deserialize family):
 *        - 'deserialize-context-key-not-found' (DC: ctx.extension.values[id] missing)
 *        - 'deserialize-input-not-byte-array' (both: entry/register not Coll[Byte])
 *        - 'deserialize-parse-failed' (both: inner Expr bytes malformed)
 *        - 'deserialize-tpe-mismatch' (both: exprTpe(parsed) !== e.tpe)
 *        - 'deserialize-not-substituted' (defensive eval-time throw; reachable
 *          for DR with register absent + default null OR recursive-Deserialize)
 *   = 64 codes total after phase 2i-c.
 *    + 2 codes from v5 Coll methods (coll-update-index-out-of-range,
 *        coll-update-many-length-mismatch) → 66
 *    + 2 codes from v6 P1 numeric methods (numeric-shift-out-of-range,
 *        bigint-result-out-of-range) → 68
 *    + 1 code from v6 P1 C1 final-review (numeric-method-bad-operand) → 69
 *    + 4 codes from v6 P2 SUnsignedBigInt (v6-type-in-pre-v3-tree,
 *        unsigned-bigint-op-unsupported, unsigned-bigint-out-of-range,
 *        unsigned-bigint-not-invertible) → 73 (housekeeping 2026-06-03: used in
 *        the P2 arms but omitted from this union until now)
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
  // Phase 2i-a — Pure-bytes predefs (7 new codes; 48 → 52). Per-code purposes
  // span T2-T9: predef-input-not-byte-array (T2-T9 shared); byte-array-to-
  // long-too-short (T4); predef-input-not-long (T5); byte-array-to-bigint-
  // empty / -out-of-range (T6); decode-point-invalid (T8); subst-constants-
  // error (T9 — umbrella for 7 throw paths).
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
  /**
   * `ByteArrayToLong`: input Coll[Byte] has fewer than 8 elements (the
   * minimum required to construct a big-endian i64). Sigma-rust returns
   * `EvalError::UnexpectedValue("byteArrayToLong: array must contain at
   * least 8 elements")`. The length comparison is `< 8`, NOT `!= 8`:
   * trailing bytes after the first 8 are silently ignored (sigma-rust's
   * `eval_skip_tail` test at byte_array_to_long.rs:62-65).
   *
   * Source: ergotree-interpreter/src/eval/byte_array_to_long.rs:20-24
   */
  | 'byte-array-to-long-too-short'
  /**
   * `LongToByteArray`: input SValue had a `kind` other than `'Long'`.
   * Sigma-rust raises `EvalError::TryExtractFrom` (via
   * `try_extract_into::<i64>()` after `eval`). Wire-format invariants
   * (`LongToByteArray::try_build` enforces `check_post_eval_tpe(SLong)`
   * at parse time) make this unreachable for parser-produced trees;
   * defensive against `ConstantPlaceholder` injection or hand-crafted MIR.
   *
   * Source: ergotree-interpreter/src/eval/long_to_byte_array.rs:17 (try_extract_into::<i64>)
   *         ergotree-ir/src/mir/long_to_byte_array.rs:43-48 (build-time guard)
   */
  | 'predef-input-not-long'
  /**
   * `ByteArrayToBigInt`: input Coll[Byte] is empty (length 0). Sigma-rust
   * raises `EvalError::UnexpectedValue("ByteArrayToBigInt: byte array is
   * empty")` via the explicit `input.is_empty()` check. Matches the Scala
   * sigmastate-interpreter behavior of throwing on empty rather than
   * defaulting to BigInt(0) (bnum returns 0 for empty input, so the explicit
   * check is required to preserve consensus semantics).
   *
   * Source: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:20-22
   *         ergotree-ir/src/bigint256.rs:55-62 (BigInt256::from_be_slice rejects empty)
   */
  | 'byte-array-to-bigint-empty'
  /**
   * `ByteArrayToBigInt`: decoded signed-BE value falls outside
   * `[I256::MIN, I256::MAX]` = `[-2^255, 2^255 - 1]`. Sigma-rust raises
   * `EvalError::UnexpectedValue("ByteArrayToBigInt: input array out of
   * bounds")` when `BigInt256::from_be_slice` returns `None` (via
   * `bnum::I256::from_be_slice` rejecting >32-byte slices whose leading
   * non-sign-extension bytes carry value out of i256 range).
   *
   * Length is NOT capped at 32: 33+ byte inputs with leading redundant
   * sign-extension bytes (0x00 for positive, 0xFF for negative) succeed
   * when their effective value fits in i256 (sigma-rust's
   * `eval_above_max_bound` test at byte_array_to_bigint.rs:107-118).
   *
   * Source: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:28-31
   *         ergotree-ir/src/bigint256.rs:60 (delegates to I256::from_be_slice)
   *         bnum-0.12.1/src/bint/endian.rs:53-58 (Option<None> for out-of-range)
   */
  | 'byte-array-to-bigint-out-of-range'
  /**
   * `DecodePoint`: the `crypto/secp256k1.ts:decodePoint` adapter rejected the
   * input. Three failure modes all surface as this code:
   *   - Wrong byte length (`bytes.length !== 33`).
   *   - Off-curve / invalid SEC1 encoding (`@noble/curves` throws "bad point").
   *   - (Possible in theory but blocked by the adapter's all-zero short-circuit:
   *     malformed identity-like inputs where the first byte is 0x00 but the
   *     trailing 32 bytes are non-zero.)
   *
   * Mirrors sigma-rust's `EvalError::Misc("DecodePoint: Failed to parse EC
   * point from bytes …")` which wraps `SigmaSerializable::sigma_parse_bytes`
   * errors from `EcPoint::scorex_parse`.
   *
   * Source: ergotree-interpreter/src/eval/decode_point.rs:23-29
   *         ergo-chain-types/src/ec_point.rs:140-152 (scorex_parse)
   */
  | 'decode-point-invalid'
  /**
   * `SubstConstants` (CONSENSUS-CRITICAL — output bytes go on-chain): any of
   * the 6 throw paths in the substitute-constants arm collapse to this single
   * compact code per the 2g.5 compact-taxonomy decision. The throw paths are:
   *   - `script_bytes` evaluated to non-`Coll[Byte]` (defensive — build-time
   *     guard `SubstConstants::new` enforces `SColl(SByte)`).
   *   - `positions` evaluated to non-`Coll[Int]` (defensive — build-time guard
   *     enforces `SColl(SInt)`).
   *   - `new_values` evaluated to non-`Coll[_]` (defensive — build-time guard
   *     enforces `SColl(_)`).
   *   - `positions.length !== new_values.items.length`.
   *   - Bad template bytes (any wire-layer error from `parseTree`).
   *   - Type mismatch: `new_values.elem` differs from `template.constantTypes[i]`.
   * Out-of-range `positions[ix]` (negative OR >= constants.length) is NOT a
   * throw — it is a silent no-op (JVM `getPositionsBackref` parity), so the
   * template bytes pass through unchanged. See subst-constants.ts step 7.
   *
   * Distinguished by `error.message` text. Mirrors sigma-rust's mix of
   * `EvalError::Misc` (subst_const.rs:36-87) and `SetConstantError`
   * (ergo_tree.rs:51-66) cases — EXCEPT the out-of-range position path, where
   * sigma-rust still errors and we (like the JVM) no-op. See santa
   * prompts/ergots-v5-divergences.md §A2.
   *
   * Source: ergotree-interpreter/src/eval/subst_const.rs:18-89
   *         ergotree-ir/src/ergo_tree.rs:45-70 (with_constant)
   */
  | 'subst-constants-error'

  // -------------------------------------------------------------------------
  // Phase 2i-b — Curve + AVL + sigma-trivial predefs. T2 added 1 code
  // (sigma-prop-is-proven-no-eval; 52 → 53). T3 adds 1 code
  // (group-op-input-not-group-element; 53 → 54). T4 adds 1 code
  // (predef-input-not-bigint; 54 → 55). T5 adds 1 code
  // (create-avl-tree-shape-mismatch; 55 → 56).
  // -------------------------------------------------------------------------
  /**
   * `SigmaPropIsProven`: structural throw with no eval of `e.input` and no
   * cost charged. Op-code 95 (`SIGMA_PROP_IS_PROVEN`) is reserved in the IR
   * for byte-match parity with Scala sigmastate, whose typer rewrites
   * `prop.isProven` to this node; the AOT graph-IR rewrite removes the node
   * before evaluation. Sigma-rust mirrors with an unconditional
   * `Err(EvalError::Misc("SigmaPropIsProven has no interpreter eval ..."))`.
   *
   * Source: ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25
   */
  | 'sigma-prop-is-proven-no-eval'
  /**
   * `MultiplyGroup` (both operands) — and, in phase 2i-b T4, `Exponentiate`
   * (base) — when an input expression evaluates to a non-`GroupElement` SValue.
   * Wire-format invariants (`MultiplyGroup::new` / `Exponentiate::new` enforce
   * `(SGroupElement, SGroupElement)` / `(SGroupElement, SBigInt)` at
   * construction) make this unreachable for parser-produced trees; defensive
   * against `ConstantPlaceholder` injection or hand-crafted MIR.
   *
   * Distinct from `'sigma-prop-input-not-group-element'` (2g-medium), which
   * is specifically for sigma-prop creation arms (`CreateProveDlog` /
   * `CreateProveDhTuple`); the names parallel each other.
   *
   * Source: ergotree-interpreter/src/eval/multiply_group.rs:23-26
   *         ergotree-interpreter/src/eval/exponentiate.rs:20 (T4)
   */
  | 'group-op-input-not-group-element'
  /**
   * `Exponentiate`: exponent expression evaluated to a non-`BigInt` SValue.
   * Wire-format invariants (`Exponentiate::new` enforces
   * `(SGroupElement, SBigInt)` at construction) make this unreachable for
   * parser-produced trees; defensive against `ConstantPlaceholder` injection
   * or hand-crafted MIR. Mirrors sigma-rust's `try_extract_into::<BigInt256>()`
   * failure at `exponentiate.rs:21`. Future arms in the `ModQ` family
   * (phase 2i-d) will reuse this code.
   *
   * Source: ergotree-interpreter/src/eval/exponentiate.rs:21
   */
  | 'predef-input-not-bigint'
  /**
   * `CreateAvlTree` arm: compact umbrella code covering 3 distinct shape-
   * mismatch throw paths. The `.message` text carries the specific field
   * name (flags / keyLength / valueLength):
   *   - flags `kind !== 'Byte'`        — mirrors sigma-rust try_extract_into::<i8>() at create_avl_tree.rs:21
   *   - keyLength `kind !== 'Int'`     — mirrors sigma-rust try_extract_into::<i32>() at create_avl_tree.rs:23
   *   - valueLength `kind !== 'Int'`   — mirrors sigma-rust try_extract_into::<i32>() at create_avl_tree.rs:26
   *
   * Wire-format invariants (`CreateAvlTree::new` enforces SByte / SColl(SByte)
   * / SInt / Option<SInt> at construction — `ergotree-ir/src/mir/create_avl_tree.rs:31-59`)
   * make these unreachable for parser-produced trees; defensive against
   * `ConstantPlaceholder` injection or hand-crafted MIR.
   *
   * Distinct from `'avl-tree-bad-digest-length'` (2h-d, reused here) which
   * covers the eval-time digest length check, and from `'predef-input-not-byte-array'`
   * (2i-a, reused here via `collByteToUint8Array`) which covers the
   * digest non-Coll[Byte] path.
   *
   * Source: ergotree-interpreter/src/eval/create_avl_tree.rs:21, 23, 26
   */
  | 'create-avl-tree-shape-mismatch'

  // -------------------------------------------------------------------------
  // Phase 2i-c — Deserialize family (5 new codes; 59 → 64). Substitute-pre-pass
  // architecture mirroring sigma-rust eval.rs:203-250 + mir/expr.rs:442-496.
  // Codes 1-4 are thrown by substituteDeserialize; code 5 is the defensive
  // eval-time throw on the Deserialize* arms (reached when substitute pass
  // does NOT rewrite — either DR with register absent + default null, or
  // recursive Deserialize inside a substituted inner Expr).
  // -------------------------------------------------------------------------
  /**
   * `DeserializeContext` substitute pass: `ctx.extension.values[e.id]` is
   * undefined. Mirrors sigma-rust `SubstDeserializeError::ExtensionKeyNotFound(id)`
   * at `ergotree-ir/src/mir/expr.rs:457`. Message includes the id for symmetry.
   *
   * Source: ergotree-ir/src/mir/expr.rs:453-457
   */
  | 'deserialize-context-key-not-found'
  /**
   * `DeserializeContext` / `DeserializeRegister` substitute pass: the
   * context-extension entry or register entry does NOT carry a Coll[Byte]
   * value (either `entry.tpe.tag !== 'SColl'` / `entry.tpe.elem.tag !== 'SByte'`
   * or the Coll's items contain non-Byte elements). Mirrors sigma-rust
   * `SubstDeserializeError::TryExtractFromError` via
   * `try_extract_into::<Vec<u8>>()` failure.
   *
   * Source: ergotree-ir/src/mir/expr.rs:459 (DC), :472 (DR)
   */
  | 'deserialize-input-not-byte-array'
  /**
   * `DeserializeContext` / `DeserializeRegister` substitute pass: the inner
   * Expr bytes (decoded from `ctx.extension` or `selfBox.registers`) fail to
   * parse. The underlying wire-layer error class + message is wrapped into
   * `.message`. Mirrors sigma-rust `SubstDeserializeError::ExprParsingError(SigmaParsingError)`
   * at `ergotree-ir/src/mir/expr.rs:725`.
   *
   * Common causes: malformed opcode stream, truncated bytes, ConstantPlaceholder
   * referenced with empty constants store (verified against sigma-rust
   * `serialization/constant_placeholder.rs:14-24` — both rust and our port
   * reject placeholders at parse when no store).
   *
   * Source: ergotree-ir/src/mir/expr.rs:462-464 (DC), :474 (DR)
   */
  | 'deserialize-parse-failed'
  /**
   * `DeserializeContext` / `DeserializeRegister` substitute pass: the parsed
   * inner Expr's `exprTpe()` doesn't match the arm's declared `e.tpe`. The
   * check runs on BOTH the register-decoded inner Expr AND the `default`
   * fallback Expr (per sigma-rust `expr.rs:486-491`). Mirrors
   * `SubstDeserializeError::ExprTpeError { expected, actual }` at line 727.
   *
   * Source: ergotree-ir/src/mir/expr.rs:486-491
   */
  | 'deserialize-tpe-mismatch'
  /**
   * `DeserializeContext` / `DeserializeRegister` eval-time defensive throw.
   * Reached when the substitute pass did NOT rewrite this node:
   *   (a) DeserializeRegister with register absent + `e.default === null` —
   *       sigma-rust `substitute_deserialize` returns `Ok(())` LEAVING the
   *       node unchanged (per `expr.rs:478-481` "When script in register is
   *       not found, and default is not defined, leave DeserializeRegisterNode
   *       unchanged, which will error on evaluation"). The defensive throw IS
   *       the canonical mirror.
   *   (b) Recursive Deserialize: an outer DeserializeContext decoded to an
   *       inner Expr containing another Deserialize* node. sigma-rust's
   *       `try_rewrite_bu` does NOT re-walk substituted children
   *       (`mir/expr.rs:397-408`), so the inner Deserialize survives and
   *       trips the eval-time throw. Sigma-rust mirror: eval/deserialize_*.rs
   *       files contain ONLY tests; NO Evaluable impl — falls through to
   *       "not implemented" at eval-time.
   *
   * Source: ergotree-ir/src/mir/expr.rs:478-481, :397-408;
   *         ergotree-interpreter/src/eval/deserialize_context.rs (tests-only)
   */
  | 'deserialize-not-substituted'

  // -------------------------------------------------------------------------
  // v5 Coll update methods — Coll.updated / Coll.updateMany (2 new codes; 64 → 66)
  // -------------------------------------------------------------------------
  /**
   * `SColl.updated` (typeId 12, methodId 20) / `SColl.updateMany` (12:21):
   * a target index is out of bounds for the receiver Coll. Genuine runtime
   * error — indices are runtime Int values, not type-constrained. sigma-rust
   * casts `i32 as usize` then `Vec::get_mut(idx)` → `None` ⇒ error, so a
   * NEGATIVE index wraps to a huge usize and is OOB as well.
   *
   * Source: sigma-rust UPDATED_EVAL_FN / UPDATE_MANY_EVAL_FN
   *         (eval/scoll.rs, branch ergo-node-integration).
   */
  | 'coll-update-index-out-of-range'
  /**
   * `SColl.updateMany` (typeId 12, methodId 21): the `indexes` and `values`
   * Colls have different lengths. Genuine runtime error (lengths are runtime
   * values, not constrained by the `Coll[T].updateMany(Coll[Int], Coll[T])`
   * signature). Checked before the per-index OOB loop, matching sigma-rust.
   *
   * Source: sigma-rust UPDATE_MANY_EVAL_FN length guard
   *         (eval/scoll.rs, branch ergo-node-integration).
   */
  | 'coll-update-many-length-mismatch'

  // -------------------------------------------------------------------------
  // v6 P1 numeric methods — shift-bound guard (1 new code; 66 → 67)
  // -------------------------------------------------------------------------
  /**
   * `Byte.shiftLeft` / `Byte.shiftRight` (typeId 2, methodIds 12–13),
   * `Short.shiftLeft` / `Short.shiftRight` (typeId 3, methodIds 12–13),
   * `Int.shiftLeft` / `Int.shiftRight` (typeId 4, methodIds 12–13),
   * `Long.shiftLeft` / `Long.shiftRight` (typeId 5, methodIds 12–13):
   * the `bits` argument is outside `[0, width)` where width is 8 / 16 / 32 / 64.
   * Both `bits < 0` and `bits >= width` are rejected. Mirrors the JVM
   * `ExactIntegral.shiftLeft` / `shiftRight` range guard.
   *
   * Also thrown for `BigInt.shiftLeft` / `BigInt.shiftRight` (typeId 6, methodIds
   * 12–13) when `bits` is outside `[0, 256)`. Mirrors the JVM `BigIntegerOps`
   * range guard (`CBigInt.scala`).
   */
  | 'numeric-shift-out-of-range'

  // -------------------------------------------------------------------------
  // v6 P1 BigInt result overflow (1 new code; 67 → 68)
  // -------------------------------------------------------------------------
  /**
   * Any v6 BigInt operation whose result falls outside signed-256 range
   * `[-2^255, 2^255 - 1]`. Currently only reachable via `BigInt.shiftLeft`
   * (methodId 12), which can produce a result with bitLength > 255. `shiftRight`
   * on an in-range value always stays in range. Mirrors the JVM `CBigInt`
   * constructor's call to `.toSignedBigIntValueExact` (Extensions.scala:219)
   * which throws `ArithmeticException` when bitLength() > 255.
   *
   * Distinct from `'byte-array-to-bigint-out-of-range'` (phase 2i-a), which is
   * for the `ByteArrayToBigInt` predef arm rejecting an over-width input byte
   * array, not for an arithmetic result.
   *
   * Source: sigmastate-interpreter/src/main/scala/org/ergoplatform/sdk/Extensions.scala:219
   *         sigmastate-interpreter/src/main/scala/special/collection/Extensions.scala (CBigInt)
   */
  | 'bigint-result-out-of-range'

  // -------------------------------------------------------------------------
  // v6 P1 C1 final-review — numeric method operand guards (1 new code; 68 → 69)
  // -------------------------------------------------------------------------
  /**
   * Any of the 40 v6 numeric method handlers (`toBytes` / `toBits` /
   * `bitwiseInverse` / `bitwiseOr` / `bitwiseAnd` / `bitwiseXor` /
   * `shiftLeft` / `shiftRight` on Byte/Short/Int/Long/BigInt) when the
   * receiver `obj` or an operand argument evaluates to an unexpected `kind`.
   *
   * Mirrors the JVM `asInstanceOf` / sigma-rust `try_extract_into` rejection
   * at eval. The JVM throws `ClassCastException`; sigma-rust throws
   * `EvalError::TryExtractFrom`. Wire-format invariants (MethodCall
   * construction via `SNumericTypeMethods` / `SBigIntMethods` enforce typed
   * args at build time) make this unreachable for parser-produced trees;
   * defensive against hand-crafted MIR (adversarial wrong-kind constant
   * injected as `obj` or `args[0]`). Without this guard, wrong-kind Byte/
   * Short/Int operands silently return garbage (`.value` is `undefined` → JS
   * produces 0 from numeric coercion); wrong-kind Long/BigInt operands throw
   * a raw `TypeError` (JS BigInt coercion) — both are consensus over-accept
   * vectors.
   *
   * The guard is unconditional at runtime (concrete `obj.kind` is always
   * concrete, never SAny — this is NOT a static `exprTpe` check; the "skip
   * SAny static checks" rule does not apply here).
   *
   * Source: sigma-rust `try_extract_into::<i8/i16/i32/i64/BigInt256>()`
   *         ergotree-interpreter/src/eval/method_call.rs
   */
  | 'numeric-method-bad-operand'

  // -------------------------------------------------------------------------
  // v6 P2 — SUnsignedBigInt + V3 type gating (4 new codes; 69 → 73)
  // Housekeeping (2026-06-03): these P2a/P2b/P2d-2 codes were used in the arms
  // but omitted from this union — `EvalError` takes `code: string`, so they
  // compiled regardless; added here for taxonomy completeness.
  // -------------------------------------------------------------------------
  /**
   * `validateV6Types` pre-eval pass: an `SUnsignedBigInt` / `SFunc` type
   * construct appears in a `treeVersion < 3` tree (checked over `constantTypes[]`
   * + the post-substitution body's wire-serialized type annotations). Zero-cost
   * reject. Source: `eval/validate-v6-types.ts` (v6 P2a).
   */
  | 'v6-type-in-pre-v3-tree'
  /**
   * A `UnsignedBigInt` SValue reached an operation with no JVM path. After P2c
   * this survives only in the UBI cast matrix (`eval/_cast-ubi.ts`): UBI↔BigInt
   * casts and UBI-source `Upcast` (the JVM uses `toUnsigned`/`toSigned` instead).
   * Source: `eval/_cast-ubi.ts` (v6 P2a/P2b).
   */
  | 'unsigned-bigint-op-unsupported'
  /**
   * `UnsignedBigInt` arithmetic/shift result fell outside the unsigned range
   * [0, 2^256) — e.g. `shiftLeft` overflow (`≥ 2^256`). Source:
   * `eval/_numeric-v6.ts` (ubiDesc) / `eval/bin-op/_ubi-binop.ts` (v6 P2b/P2c).
   */
  | 'unsigned-bigint-out-of-range'
  /**
   * `UnsignedBigInt.modInverse(a, m)`: `gcd(a, m) ≠ 1`, so no modular inverse
   * exists. (`m == 0` reuses `'arith-divide-by-zero'`.) Source:
   * `eval/_ubi-modular.ts` `umodInverse` (v6 P2d-2).
   */
  | 'unsigned-bigint-not-invertible'
