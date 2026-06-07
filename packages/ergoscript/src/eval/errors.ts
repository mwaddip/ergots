/**
 * EvalError code taxonomy for `@ergots/ergoscript`.
 *
 * `EvalErrorCode` is a string-literal union covering all legal second-argument
 * values for `new EvalError(message, code)`. Collecting them here:
 *   - serves as a single-place reference for reviewers
 *   - enables TypeScript to flag typos in `new EvalError(…, 'bad-code')` calls
 *     if you annotate the code parameter (opt-in; `EvalError` itself keeps `code: string`
 *     for ergonomic construction in each arm without needing to import this type)
 *   - documents the 79 codes through v6 P6 (HOF lambdas) + F1 (which removed
 *     'deserialize-context-key-not-found': 80 → 79; see history) + F3 (79 → 80)
 *     + F4 epilogue Task 2 (+'unsupported-eval-node', −'create-avl-tree-shape-mismatch'
 *     which the unconditional CreateAvlTree reject orphaned: net 80 → 80)
 *     + F4 epilogue Task 3 (−'avl-tree-bad-digest-length': JVM accepts any digest
 *     length, CAvlTree.scala:31-34 no-require; net 80 → 79)
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
 *        - 'create-avl-tree-shape-mismatch' (T5 — compact: flags/keyLength/
 *          valueLength; REMOVED in the F4 epilogue — the unconditional
 *          CreateAvlTree eval-reject orphaned every throw path)
 *    + 4 codes added in phase 2i-c (deserialize family; was 5 — F1 later
 *      removed 'deserialize-context-key-not-found', see note below):
 *        - 'deserialize-input-not-byte-array' (both: entry/register not Coll[Byte])
 *        - 'deserialize-parse-failed' (both: inner Expr bytes malformed)
 *        - 'deserialize-tpe-mismatch' (both: exprTpe(parsed) !== e.tpe)
 *        - 'deserialize-not-substituted' (defensive eval-time throw; reachable
 *          for DR with register absent + default null OR recursive-Deserialize
 *          OR — post-F1 — a LIVE DC over an absent/wrong-typed var)
 *   = 63 codes total after phase 2i-c (F1-adjusted from 64).
 *    + 2 codes from v5 Coll methods (coll-update-index-out-of-range,
 *        coll-update-many-length-mismatch) → 65
 *    + 2 codes from v6 P1 numeric methods (numeric-shift-out-of-range,
 *        bigint-result-out-of-range) → 67
 *    + 1 code from v6 P1 C1 final-review (numeric-method-bad-operand) → 68
 *    + 4 codes from v6 P2 SUnsignedBigInt (v6-type-in-pre-v3-tree,
 *        unsigned-bigint-op-unsupported, unsigned-bigint-out-of-range,
 *        unsigned-bigint-not-invertible) → 72 (housekeeping 2026-06-03: used in
 *        the P2 arms but omitted from this union until now)
 *    + 1 code added in F3 (conformance run — EQ-of-SigmaProp costed walk):
 *        'sigma-boolean-compare-unsupported' (JVM DataValueComparer sys.error mirror)
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
  // Phase 2g-combinators — Atleast + sigma helpers (3 new codes)
  // Total taxonomy: 36 → 39.
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
  // F4 rewrite: final throw surface after JVM-canonical construct-fail routing.
  // -------------------------------------------------------------------------
  /**
   * SAvlTree Tier-2 verification op handlers throw this code when the proof
   * verification fails AND the JVM-canonical semantics mandate a throw (not a
   * return-false or return-None).
   *
   * **Thrown by:**
   *   - `get` — any verification failure (construct fail OR per-op Lookup
   *     fail) → throw (CErgoTreeEvaluator.scala:106 `syntax.error`).
   *   - `getMany` — any verification failure with ≥1 key in the batch
   *     (construct fail → first Lookup fails; per-op fail at key i) →
   *     throw (CErgoTreeEvaluator.scala:126). Zero-key batch: empty Coll,
   *     no throw even on construct failure.
   *   - `insert` at `ctx.treeVersion < 3` with ≥1 op in the batch →
   *     throw (CErgoTreeEvaluator.scala:150 V<3 path). V3+ and zero-op:
   *     None (never throws).
   *
   * (The `TreeLookup` MIR arm bullet retired in the F4 epilogue: the arm
   * now rejects unconditionally with `'unsupported-eval-node'` — the JVM
   * has no eval override for the node; see that code's entry below.)
   *
   * **NOT thrown by (F4 JVM-canonical, final state):**
   *   - `contains` — always returns false on any failure; never throws.
   *   - `update` — per-op failure or construct fail → None; never throws.
   *   - `remove` — per-op results discarded (cfor, no break); digest None
   *     → None; never throws.
   *   - `insertOrUpdate` — construct fail or per-op fail → None; never
   *     throws (V<3 rejected at dispatcher before handler runs).
   *   - `getMany` with zero keys — empty Coll returned; no throw.
   *   - `insert` at V3+ or zero ops — None; never throws.
   *
   * The JVM has NO construct-throw path: scorex `BatchAVLVerifier` wraps
   * reconstruction in `Try{…}.toOption` (logError overridden to swallow in
   * `CAvlTreeVerifier`); a bad proof yields a verifier with `topNode = None`,
   * and every subsequent op returns Failure. The observable behavior is
   * determined entirely by each method's per-op/digest semantics. Pre-F4,
   * ergots followed the sigma-rust `?`-on-construct fork (construct fail
   * threw on all six handlers) — that wider throw surface is now closed.
   *
   * Source (JVM-canonical):
   *   - CErgoTreeEvaluator.scala:106  (get throw)
   *   - CErgoTreeEvaluator.scala:126  (getMany throw)
   *   - CErgoTreeEvaluator.scala:150  (insert V<3 throw)
   *   - docs/specs/2026-06-07-ergoscript-f4-avltree-tier2-cost-design.md
   *     (failure model table)
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
  // Phase 2h-d — SAvlTree.updateDigest (1 new code added; then REMOVED in
  // F4 epilogue Task 3, 2026-06-07: JVM CAvlTree.scala:31-34 has no length
  // require on updateDigest — the 33-byte gate was the sigma-rust
  // ADDigest::try_from shape, a convergent over-reject; net count: 47 → 48 → 47)
  // -------------------------------------------------------------------------
  // 'avl-tree-bad-digest-length' REMOVED here (was 47 → 48; now retired).
  // Blessed vectors: AvlTree.updateDigest_any_length.json (3-byte/empty/40-byte
  // all succeed). The code is no longer thrown anywhere in src/.

  // -------------------------------------------------------------------------
  // Phase 2i-a — Pure-bytes predefs (7 new codes; 47 → 54). Per-code purposes
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
  // (sigma-prop-is-proven-no-eval; 54 → 55). T3 adds 1 code
  // (group-op-input-not-group-element; 55 → 56). T4 adds 1 code
  // (predef-input-not-bigint; 56 → 57). T5 added 1 code
  // (create-avl-tree-shape-mismatch; 57 → 58) — REMOVED in the F4 epilogue
  // (2026-06-07): the CreateAvlTree arm became an unconditional
  // 'unsupported-eval-node' reject (no JVM eval override), orphaning all 3
  // shape-mismatch throw paths. Net 2i-b contribution: 3 codes (54 → 57).
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

  // -------------------------------------------------------------------------
  // Phase 2i-c — Deserialize family (originally 5 new codes; 59 → 64; F1 removed
  // 'deserialize-context-key-not-found' → 4 codes, 59 → 63). Substitute-pre-pass
  // architecture mirroring sigma-rust eni eval.rs:203-250 + mir/expr.rs:442-496.
  // Codes 1-3 are thrown by substituteDeserialize; code 4 is the defensive
  // eval-time throw on the Deserialize* arms (reached when substitute pass
  // does NOT rewrite — DR with register absent + default null, a recursive
  // Deserialize inside a substituted inner Expr, OR — post-F1 — a LIVE DC over
  // an absent/wrong-typed var).
  // -------------------------------------------------------------------------
  // NOTE: 'deserialize-context-key-not-found' was REMOVED in F1 — an absent
  // DeserializeContext var now LEAVES the node unchanged (JVM `substDeserialize`
  // `else None`), so it no longer throws at substitution. A LIVE such node
  // errors at eval via 'deserialize-not-substituted' (below); a DEAD branch is
  // evaluable. See _substitute-deserialize.ts:substituteDeserializeContext.
  /**
   * Raised by: (1) `DeserializeRegister` substitute pass when the register
   * entry is present but NOT a Coll[Byte] (eager throw — DR rejects at
   * substitution, unlike DC which leaves the node post-F1); (2) the downstream
   * `collByteToUint8Array` value-shape check on a present Coll[Byte]-typed entry
   * whose items contain non-Byte elements (both DC and DR). Mirrors sigma-rust
   * eni `try_extract_into::<Vec<u8>>()` failure.
   *
   * Source (eni): DR `try_extract` at mir/expr.rs:482 (.transpose()? :492).
   * (Post-F1 the DC tpe path at :459-462 LEAVES the node — no longer this code.)
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

  // -------------------------------------------------------------------------
  // v6 P4 — V3+ empty-args MethodCall reject (1 new code; 73 → 74)
  // -------------------------------------------------------------------------
  /**
   * `validateMethodCallArity` pre-eval pass: a `MethodCall`-opcode node with
   * empty args (`args.length === 0`) appears in a `treeVersion >= 3` tree.
   * Mirrors the JVM `MethodCallSerializer.parse`
   * `if (isV3OrLaterErgoTreeVersion) assert(args.nonEmpty)`
   * (data/shared/.../serialization/MethodCallSerializer.scala:53-55). Honest
   * trees never emit this (zero-arg calls use the PropertyCall opcode); it is an
   * adversarial over-accept (any zero-arg method reached via the MethodCall
   * opcode — `none` 106:10, `groupGenerator` 106:1 — would otherwise evaluate).
   * Pre-V3 is grandfathered (the JVM does not assert there). Zero-cost reject.
   * Source: `eval/validate-method-call-arity.ts` (v6 P4).
   */
  | 'method-call-empty-args'

  // -------------------------------------------------------------------------
  // v6 P5a — Global.serialize / Global.deserializeTo (2 new codes; 74 → 76)
  // -------------------------------------------------------------------------
  /**
   * `SGlobal.serialize` (106:3): the sigma-serialization of the argument value
   * failed. Raised when the internal `serializeSValue` / `serializeSType`
   * round-trip throws for a value that cannot be expressed in the wire format
   * (e.g. a `'Lambda'` or `'Context'` SValue kind, which have no on-wire
   * SValue encoding). Mirrors the JVM `sigmaSerialize` throwing
   * `SigmaSerializationException` surfaced as `EvalError`.
   *
   * Source: JVM `sigma/ast/methods.scala:1957`
   */
  | 'global-serialize-failed'
  /**
   * `SGlobal.deserializeTo[T]` (106:4): the supplied `Coll[Byte]` argument
   * bytes failed to parse as an SValue of type `T` via the data codec
   * (`DataSerializer.deserialize`). Raised on malformed / truncated bytes,
   * an oversized BigInt / UnsignedBigInt (> 32 bytes), or actual parse
   * recursion deeper than `MaxTreeDepth` (110, data-driven). There is NO ErgoTree body parse and
   * NO `exprTpe` match step — `T` drives the parse directly.
   * Mirrors the JVM `sigmaDeserialize` path surfaced as `EvalError`.
   *
   * Source: JVM `sigma/ast/methods.scala:1906`
   */
  | 'global-deserialize-failed'

  // -------------------------------------------------------------------------
  // v6 P5b-1 — Global.fromBigEndianBytes (1 new code; 76 → 77)
  // -------------------------------------------------------------------------
  /**
   * `SGlobal.fromBigEndianBytes[T]` (106:5): the supplied `Coll[Byte]` bytes
   * could not be decoded as a value of type `T`. Raised on wrong exact length
   * for a fixed-width type (Byte=1/Short=2/Int=4/Long=8), an oversized
   * BigInt/UnsignedBigInt (> 32 bytes), empty bytes for BigInt (JVM
   * `new BigInteger(byte[0])` throws; UnsignedBigInt empty → 0 is accepted), or
   * an unsupported non-numeric `T` (rejected at eval — the JVM's unsupported-type
   * throw is in the runtime body). `FixedCost(10)` is charged before the throw.
   * V3-gated (`minVersion: 3`).
   *
   * Source: JVM `sigma/ast/methods.scala:1925`
   */
  | 'global-from-bigendian-bytes-failed'
  | 'global-encode-nbits-failed'
  | 'global-decode-nbits-failed'

  // -------------------------------------------------------------------------
  // v6 P5c — Global.powHit (106:8) (1 new code; 79 → 80)
  // -------------------------------------------------------------------------
  /**
   * `SGlobal.powHit` (106:8): k<2 / k>32 / N<16 (maps the scorex
   * `PowHitInvalidParamsError`), or a non-conforming operand (non-Int k or N).
   * Cost is charged from the RAW k BEFORE the require guards (cost-then-throw).
   * JVM `Autolykos2PowValidation` require guards.
   *
   * Source: JVM sigma/ast/methods.scala:1884-1902 — hitForVersion2ForMessageWithChecks
   *         ergoscript v6 P5c; scorex autolykos-v2.ts:PowHitInvalidParamsError
   */
  | 'pow-hit-invalid-params'

  // -------------------------------------------------------------------------
  // v6 P6 — type-var lambda apply reject (1 new code; 80 → 81)
  // -------------------------------------------------------------------------
  /**
   * Applying a lambda (closure) whose declared argument type is — or
   * structurally contains — an unresolved `STypeVar`. Thrown at the apply-time
   * arg binding, at EVERY lambda-invocation site (`apply.ts` + the 7 lambda
   * HOF arms), BEFORE the arg is bound — independent of whether the body reads
   * the arg.
   *
   * The JVM (sigma-state 6.0.3, canonical for v6) rejects such an application:
   * resolving the type-var arg's runtime RType fails (`stypeToRType(STypeVar)`
   * → `RuntimeException: Unknown type T`). A type-var lambda that is bound but
   * never applied evaluates fine (the binding itself is OK) — so this fires
   * ONLY at apply, NOT at FuncValue construction or at the FunDef/ValDef bind.
   * Distinguishes a `{val id[T]={(x:T)=>x}; id(7)}` (rejects) from the
   * concrete-arg `{val id[T]={(x:Int)=>x}; id(7)}` (accepts → 7).
   *
   * Honest compiler-produced trees never apply a type-var-arg lambda (the
   * polymorphic FunDef is monomorphized at the call site); this is an
   * adversarial over-accept the dynamically-typed evaluator would otherwise
   * silently evaluate.
   *
   * Source: SANTA `vectors/eval/v6/authored/HOF_FunDef_type_var_body.json`
   *         (blessed_by jvm:sigma-state-6.0.3).
   */
  | 'apply-unresolved-type-var'

  // -------------------------------------------------------------------------
  // F3 — conformance run, EQ-of-SigmaProp costed walk (1 code; 79 → 80)
  // -------------------------------------------------------------------------
  /**
   * `compareSValues` SigmaProp arm: the LEFT SigmaBoolean is a conjecture
   * (Cand / Cor / Cthreshold) and the RIGHT is a DIFFERENT variant (or a leaf
   * when the left is a conjecture). Mirrors JVM `DataValueComparer.scala`
   * `equalSigmaBoolean` `:278-281`:
   *   `case _ => sys.error("Unknown SigmaBoolean type ...")`.
   * The node MatchType(1) is charged BEFORE the throw (cost-then-throw).
   * ASYMMETRY: leaf-left vs conjecture-right → plain `false`; conjecture-left
   * vs different-right → throw. Applies only to the costed path (ctx present).
   * The cost-free structural twin (`sValueStructuralEq` / `primitiveValueEqual`)
   * uses plain `false` for all tag mismatches — no throw.
   *
   * Source: JVM DataValueComparer.scala:278-281; _sigma-boolean-eq.ts.
   */
  | 'sigma-boolean-compare-unsupported'

  // -------------------------------------------------------------------------
  // F4 epilogue — TreeLookup + CreateAvlTree unconditional eval reject
  // (1 new code, and the same change REMOVED the orphaned
  // 'create-avl-tree-shape-mismatch' above: net 80 → 80)
  // -------------------------------------------------------------------------
  /**
   * The `TreeLookup` (opcode 0xb7) and `CreateAvlTree` (opcode 0xb6) MIR
   * arms: the JVM has NO eval override for either node — `costKind =
   * Value.notSupportedError` (trees.scala:1334-1337 TreeLookup,
   * trees.scala:87-91 CreateAvlTree) and the default `Value.eval` fires
   * `sys.error("Should be overriden in ...")` (values.scala:102). EVERY
   * evaluation throws JVM-side, so both arms reject unconditionally —
   * nothing charged, no operand evaluated.
   *
   * Both nodes still PARSE fine (the JVM parses them; parse/serialize
   * arms unchanged). Mainnet history is JVM-validated, so no mainnet
   * block ever evaluated either node — the reject cannot fork against
   * chain history. ergots' previous evaluating arms were sigma-rust
   * ports; sigma-rust (eni) convergently over-accepts both (routed to
   * sigma-rust via SANTA).
   *
   * Source: JVM-blessed vectors AvlTree.unsupported_eval_nodes.json
   * (tree_lookup @v2) + AvlTree.unsupported_eval_nodes_v6.json
   * (tree_lookup + create_avl_tree @v3), blessed_by jvm:sigma-state-6.0.3;
   * trees.scala:79-91 + 1322-1338.
   *
   * ⚠ Grading coupling (load-bearing — do NOT rename to a not-impl code):
   * SANTA's dasher maps ONLY 'method-not-implemented' to its
   * not-implemented category (santa ts-runner/src/runner.ts:152); every
   * other EvalError grades as errored. These vectors EXPECT errored — a
   * distinct code is what makes the reject visible as a reject. The 4
   * unit/mutation suites pin the exact code as a local tripwire.
   */
  | 'unsupported-eval-node'
