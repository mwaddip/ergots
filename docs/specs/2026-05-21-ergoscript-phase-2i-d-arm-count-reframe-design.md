# Phase 2i-d — Arm-count reframe + DecodePoint divergence documentation

**Status:** Draft v2 (2026-05-21). Reviewer pass applied.
**Author:** Claude Opus 4.7 (1M context) under user direction.
**Phase scope:** Reframe 19 wire-layer parse-reject sites from `ExprParseError 'not-implemented-yet'` to `'opcode-reserved'`; add a parse-reject completeness test; document the DecodePoint adapter strict-reject divergence as deliberate; refresh `~70` coverage language across facts/README.

**Preceding phase:** 2i-c (Deserialize family via substitute-pre-pass; 2 new arms, 67/~70 coverage, 64 EvalError codes).
**Phase plan:** umbrella spec `docs/specs/2026-05-13-ergoscript-interpreter-design.md`. 2i-d closes the open question on the `~70`-arm denominator without adding eval semantics. 2j (cost calibration) is the next substantive phase after this.

---

## Goal

Two adjacent deliverables shipping in the same session:

1. **Arm-count reframe.** The handoff-tracked `~70`-arm denominator is misleading. Sigma-rust never implements 19 of the named candidate opcodes — they are reserved-but-never-dispatched in sigma-rust's wire enum (`op_code.rs:154-156` for ModQ family; analogous reservations for OpTrue/False, UnitConstant, Select1-5, CollShift family, CollRotate family, FunDef, SomeValue, NoneValue). Our TS port already mirrors this by parse-rejecting all 19, but uses the misleading `'not-implemented-yet'` code which connotes "TBD". Rename to `'opcode-reserved'` and treat as permanent.

2. **DecodePoint divergence documentation.** Our `crypto/secp256k1.ts:decodePoint` rejects malformed `[0x00, *]` inputs that sigma-rust's `ec_point.rs:139-151` silently treats as identity. Production-unreachable (sigma-rust's serializer always emits identity as 33 zero bytes), but the divergence has been undocumented across the 9 invocations spanning 4 files. Document once, centrally, and reference from each call-site's adjacent facts file.

## Non-goals

- **No new eval semantics.** Sigma-rust never implements the 19 arms (confirmed via `ls ~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/` — no `mod_q.rs`, `select_1*`, `coll_shift*`, `coll_rotate*`, `op_true*`, `unit_constant*`, `fun_def*`, `some_value*`, `none_value*` files; and confirmed via grep that none of these opcode constants appear anywhere in sigma-rust outside their declaration in `op_code.rs`). Wiring eval arms for them would diverge from sigma-rust, not converge.
- **No DecodePoint behavior change.** Strict-reject stays; the only delta is documentation.
- **No widening to the 4 "routed-elsewhere" parse-reject sites.** `LastBlockUtxoRootHash`, `FlatMap`, `TrivialPropFalse`, `TrivialPropTrue` ALSO throw `'not-implemented-yet'` at `wire/parse.ts` but are routed through other dispatch paths in sigma-rust:
  - `OP_LAST_BLOCK_UTXO_ROOT_HASH` (54) — routed via `types/scontext.rs:136` (PropertyCall method id 9) + `eval/scontext.rs:83` (EvalFn).
  - `OP_FLAT_MAP` (72) — routed via `types/scoll.rs:84` (SColl method-call surface).
  - `OP_TRIVIAL_PROP_FALSE/TRUE` (98/99) — routed via `sigmaboolean.rs:57-58` (nested-context dispatch inside SSigmaProp).
  These 4 stay at `'not-implemented-yet'`; their dispatch surfaces are reachable via Method/PropertyCall paths we already implement. Closing them needs a separate per-opcode source-read to confirm whether each top-level direct-dispatch is truly-dead or merely route-redundant. **Out of scope.** Tracked as a residual follow-up in §"Future work".
- **No corpus-level coverage uplift.** The 19 dead opcodes never appear in real corpora (sigma-rust's serializer can't emit them since the parser can't read them). The C2 corpus pass count is unchanged.

## Motivation

Three forces converge on this reframe:

1. **Documentation honesty.** `'not-implemented-yet'` is a forward-promise. The 19 sites in question will NEVER be implemented — sigma-rust doesn't implement them either. Leaving the code as `'not-implemented-yet'` misleads future readers into thinking these are work-in-progress vs. permanent state.

2. **Coverage-language clarity.** `facts/ergoscript-eval.md` says "67 of ~70 `Expr` arms" — the `~70` denominator implies 3 more arms to wire. There aren't. The real denominator is 67 implementable variants + 19 reserved-never-dispatched + 4 routed-elsewhere; coverage on the implementable subset is 100%, not ~96%. This matters for 2j's framing (when does cost calibration declare "complete"?) and for downstream consumers reading our facts files.

3. **DecodePoint follow-up consolidation.** The strict-reject divergence has been mentioned in 4 prior phases' carry-forward sections (2g-medium, 2i-a, 2i-b, 2i-c handoffs). Each mention adds noise without resolution. Documenting once and removing it from carry-forward is itself a cleanup. The actual call-site footprint is 9 invocations across 4 files (verifier.ts 5×, decode-point.ts 1×, multiply-group.ts 2×, exponentiate.ts 1×); centralizing the docstring at `crypto/secp256k1.ts:decodePoint` and pointing each call-site file at it (1 per file = 4 pointers) keeps the divergence visible without copy-paste rot.

The C2 mainnet-corpus impact is zero — neither change affects evaluation behavior. The win is taxonomic + documentation closure.

## Architecture

### Decision 1: Rename `'not-implemented-yet'` → `'opcode-reserved'` (for the 19 truly-dead sites only)

**Scope of rename:** 19 throw sites in `wire/parse.ts`. Line numbers reference the `'not-implemented-yet'` literal position (each `case` line is at -3 relative to its throw):

| OP constant | wire/parse.ts throw line | sigma-rust opcode (decimal) |
|---|---|---|
| `OP_TRUE` | 406 | (reserved per `op_code.rs`; absent from `expr.rs` dispatch and `eval/` impls) |
| `OP_FALSE` | 411 | (reserved) |
| `OP_UNIT_CONSTANT` | 416 | (reserved) |
| `OP_SELECT_1` | 433 | (reserved) |
| `OP_SELECT_2` | 438 | (reserved) |
| `OP_SELECT_3` | 443 | (reserved) |
| `OP_SELECT_4` | 448 | (reserved) |
| `OP_SELECT_5` | 453 | (reserved) |
| `OP_FUN_DEF` | 463 | 103 (zero non-declaration references in sigma-rust) |
| `OP_SOME_VALUE` | 468 | 110 (zero non-declaration references) |
| `OP_NONE_VALUE` | 473 | 111 (zero non-declaration references) |
| `OP_MOD_Q` | 488 | 119 (`op_code.rs:154`) |
| `OP_PLUS_MOD_Q` | 493 | 120 (`op_code.rs:155`) |
| `OP_MINUS_MOD_Q` | 498 | 121 (`op_code.rs:156`) |
| `OP_COLL_SHIFT_RIGHT` | 503 | (reserved) |
| `OP_COLL_SHIFT_LEFT` | 508 | (reserved) |
| `OP_COLL_SHIFT_RIGHT_ZEROED` | 513 | (reserved) |
| `OP_COLL_ROTATE_LEFT` | 518 | (reserved) |
| `OP_COLL_ROTATE_RIGHT` | 523 | (reserved) |

**Out-of-rename-scope (the 4 routed-elsewhere):** `OP_LAST_BLOCK_UTXO_ROOT_HASH` (throw line 428, routed via PropertyCall id 9), `OP_FLAT_MAP` (throw line 458, routed via SColl method-call surface), `OP_TRIVIAL_PROP_FALSE` (throw line 478, nested via SSigmaProp), `OP_TRIVIAL_PROP_TRUE` (throw line 483, nested via SSigmaProp). These KEEP `'not-implemented-yet'` pending separate confirmation that no top-level direct dispatch is also expected.

**Message update:** also update each per-site error message. Current pattern: `'<Name> opcode not implemented (deferred — rarely used in production trees)'`. New pattern for the 19: `'<Name> opcode reserved in sigma-rust enum but not dispatched by sigma-rust\'s parser; mirrored as parse-reject'`. The 4 routed-elsewhere keep their current message; the 1 outlier (`OP_LAST_BLOCK_UTXO_ROOT_HASH`'s richer multi-line comment-message about PropertyCall routing) stays as-is.

**Taxonomy update:** `facts/ergoscript-wire.md` `ExprParseError` code enumeration (line 172) gains `'opcode-reserved'` and keeps `'not-implemented-yet'` (still used by the other 4 wire sites + by `EvalError` callers).

**Rationale for keeping `'not-implemented-yet'` declared:** five `EvalError` throw sites (`eval.ts:229`, `global-vars.ts:136`, `bin-op/relation.ts:336`, `bin-op/relation.ts:426`, `bin-op/bit.ts:58`) plus the 4 wire-layer routed-elsewhere sites still use it. The code is not deletable.

### Decision 2: DecodePoint stays strict-reject; document divergence centrally

**No behavior change.** The current `decodePoint` at `crypto/secp256k1.ts:65-74` requires all 33 bytes to be zero to recognize identity. Sigma-rust's `ec_point.rs:139-151` dispatches on `buf[0] != 0` only and would silently treat `[0x00, 0xAB, ...]` as identity.

**Why strict-reject is correct:** the divergence is unreachable on well-formed inputs because sigma-rust's serializer at `ec_point.rs:127-136` always emits identity as exactly 33 zero bytes (`is_identity → write [0u8; 33]`). The only inputs that trigger the divergence are hand-crafted MIR or hostile peer bytes. For hostile inputs, strict-reject is a small additional safety margin: we don't silently accept malformed-but-byte-zero-prefixed encodings.

**Documentation surface:** one expanded docstring at `crypto/secp256k1.ts:decodePoint` (replacing the current 5-line docstring with ~15 lines covering the divergence, the rationale, and the unreachability argument). Then one short pointer comment (1-2 lines: "decodePoint silently rejects `[0x00, non-zero]` inputs sigma-rust would accept as identity — see decodePoint docstring") at each of the 4 consuming files, NOT at each of the 9 individual invocations (per-file is enough; per-invocation would be copy-paste rot). One paragraph each in `facts/ergoscript-sigma.md` (`SigmaBoolean` ProveDlog/ProveDhTuple notes) and `facts/ergoscript-eval.md` (DecodePoint arm 2i-a changelog section — Exponentiate/MultiplyGroup 2i-b sections share the divergence note via a single sentence pointing back to the central docstring).

### Decision 3: Refresh `~70`-arm coverage language

Touched files:
- `facts/ergoscript-eval.md`: replace forward-looking "67 of ~70" in the Public surface / Coverage caveat sections with "67 of 67 implementable arms" + a single explanatory note: "19 wire opcodes (ModQ family, OpTrue/False, UnitConstant, Select1-5, CollShift family, CollRotate family, FunDef, SomeValue, NoneValue) are reserved in sigma-rust's enum but unconditionally parse-rejected — sigma-rust itself never dispatches them. We mirror via `ExprParseError 'opcode-reserved'`. A further 4 (LastBlockUtxoRootHash, FlatMap, TrivialPropFalse, TrivialPropTrue) are routed through other dispatch paths in sigma-rust; their top-level direct-dispatch `'not-implemented-yet'` status remains under separate review."
- `facts/ergoscript.md` (meta hub): "67 of ~70" → "67 of 67 implementable arms" in the Coverage summary table.
- `README.md`: same update in the Packages-table row for `@ergots/ergoscript`.
- Historical per-phase changelog entries inside `facts/ergoscript-eval.md` are NOT rewritten — they keep their original wording ("60 of ~70 after 2i-a", "65 of ~70 after 2i-b", "67 of ~70 after 2i-c"). Only forward-looking summary tables get the reframed language. This preserves the per-phase history as a true record.

### Decision 4: Add parse-reject completeness test

New file: `packages/ergoscript/test/parse-reject-coverage.test.ts`.

For each of the 19 dead opcodes, construct a minimal ErgoTree byte sequence and assert it throws `ExprParseError` with code `'opcode-reserved'`.

Construction form: `Uint8Array.from([0x08, 0x01, opcode])` — header `0x08` (V0 + hasSize, no constant segregation), `body_size_vlq` = `0x01`, then the bare opcode byte. This exercises the hasSize envelope path and matches existing test conventions at `ergo-tree.test.ts:201`. (All 19 opcodes have values ≥ 119 > `LAST_CONSTANT_CODE` = 112, so the inline-constant early-return at `parse.ts:175` does not intercept; dispatch fires on the bare opcode.)

This is a defensive regression test — proves against silent regression if anyone accidentally wires a stray dispatch arm for these opcodes later.

## Error taxonomy

One new `ExprParseError` code added; `'not-implemented-yet'` survives. Net codes touched:

| Code | Source path | Description |
|---|---|---|
| `'opcode-reserved'` (NEW) | wire/parse.ts (19 specific sites) | Wire opcode is reserved in sigma-rust's `OpCode` enum but never dispatched by sigma-rust's parser. We mirror via unconditional parse-reject. Per Decision 1. |
| `'not-implemented-yet'` (KEPT) | wire/parse.ts (4 sites) + eval/* (5 sites) | Status undetermined: either routed-elsewhere-but-top-level-direct-dispatch-unclear (the 4 wire sites pending separate review) or legitimately-TBD (the eval-side callers). See §"Future work". |

Existing `EvalError` taxonomy untouched — this phase only renames within the `ExprParseError` class.

`facts/ergoscript-wire.md` line 172 enumeration updated to add `'opcode-reserved'` and keep `'not-implemented-yet'` with a clarifying note: "the code is now ambiguous between 'parse-reject for sigma-rust routed-elsewhere opcodes (the 4 listed)' and the EvalError-class meaning 'TBD eval support'; both meanings legitimate, distinguished by error class."

## Test strategy

Two-layer validation, mirrors prior phase patterns at compressed scope:

### Layer 1 — completeness test (new)

`packages/ergoscript/test/parse-reject-coverage.test.ts`. One `describe.each([...19 opcodes...])` block. Each entry asserts:
- Wrapping the opcode byte in a minimal ErgoTree envelope (`[0x08, 0x01, opcode]`) throws `ExprParseError`.
- The error's `.code` is `'opcode-reserved'` (not `'not-implemented-yet'`).
- The error's `.message` contains the human-readable opcode name.

### Layer 2 — existing-test sweep (touched)

Four pre-existing test sites assert on `'not-implemented-yet'`. Each needs audit:

- **`ergo-tree.test.ts:186, 207, 247`** (3 assertions) — all three input byte sequences hardcode `0xa6` (OP_LAST_BLOCK_UTXO_ROOT_HASH), which is one of the 4 routed-elsewhere opcodes (NOT in the rename set). All 3 assertions stay at `'not-implemented-yet'`; no edit needed. Worth confirming via re-read in T4 to avoid drift, but the audit is a confirmation pass.
- **`opcodes.test.ts:186`** (1 assertion, `'not-implemented-yet'` positive) — also targets `OP.OP_LAST_BLOCK_UTXO_ROOT_HASH` per the surrounding `parseOne(OP.OP_LAST_BLOCK_UTXO_ROOT_HASH)` call. Stays unchanged.
- **`opcodes.test.ts:171`** (1 assertion, `'not-implemented-yet'` negative — `not.toBe`) — robust either way; no edit needed.
- **`evaluate.test.ts:76`** (1 assertion on `err.code === 'not-implemented-yet'`) — `EvalError` class, not `ExprParseError`. Unchanged.
- **`corpus-eval.test.ts:128`** (string-bucketing on the code value for evaluator failures) — `EvalError` bucket; comment cleanup may help (since `'not-implemented-yet'` now means "either eval-TBD or wire-routed-elsewhere"), but no logic change.

Net edits in T4: 0 production assertion flips; 1-2 comment touchups.

### Layer 3 — DecodePoint (no behavior change)

Existing tests under `test/sigma/`, `test/eval/decode-point.test.ts`, `test/eval/multiply-group.test.ts`, `test/eval/exponentiate.test.ts` are unchanged. Documentation-only update.

### No new fixture-gen work

This phase does NOT generate new fixtures. The 19 dead opcodes have no sigma-rust eval counterpart to produce oracle output. The completeness test uses hand-constructed bytes. Spot-check `fixture-gen/` Rust source for any code-side switches on the `'not-implemented-yet'` string (vs. comments mentioning it): expected zero such switches; the one known mention at `fixture-gen/src/cmds/ergoscript/eval/bin_op_bit.rs:270` is a code comment about Bit shift dispatch, not a switch.

### No mutation testing

Mutation testing on the 19 dead opcodes would be circular — every mutation either still hits a dead opcode (still parse-rejects with `'opcode-reserved'`) or hits a live opcode (parse path tested elsewhere). No incremental signal. The pre-existing 6,221-mutation parse-mutation suite is sufficient.

## Source mapping to sigma-rust

| Rust source (pinned `integration/ergots`, HEAD `ed5452cf`) | TS impact |
|---|---|
| `ergotree-ir/src/serialization/op_code.rs:154-156` (ModQ family opcode constants) | Confirms 119/120/121 are reserved-but-never-dispatched; informs Decision 1 |
| `ergotree-ir/src/serialization/expr.rs:86-209` (opcode → Expr dispatch table) | Confirms no parse arms for any of the 19; informs Decision 1 |
| `ergotree-interpreter/src/eval/` (directory listing) | Confirms no Evaluable impl files for any of the 19; informs Decision 1 |
| `ergotree-ir/src/types/scontext.rs:136` + `ergotree-interpreter/src/eval/scontext.rs:83` | Confirms `LAST_BLOCK_UTXO_ROOT_HASH` route via PropertyCall id 9; informs the deferred-4 classification |
| `ergotree-ir/src/types/scoll.rs:84` | Confirms `FLAT_MAP` route via SColl method-call surface; informs the deferred-4 classification |
| `ergotree-ir/src/mir/sigmaboolean.rs:57-58` | Confirms `TRIVIAL_PROP_FALSE/TRUE` nested-context dispatch; informs the deferred-4 classification |
| `ergo-chain-types/src/ec_point.rs:139-151` (`scorex_parse`, `buf[0] != 0` dispatch) | Source for Decision 2's documented divergence note |
| `ergo-chain-types/src/ec_point.rs:127-136` (`scorex_serialize`, `is_identity → write [0u8; 33]`) | Supports the "production-unreachable" claim |

## Execution order

Tasks ordered simplest → most cross-cutting:

```
T1   PLAN.md committed (overwrites 2i-c plan)
T2   ExprParseError 'opcode-reserved' code declared in wire/errors.ts;
     19 wire/parse.ts sites renamed; per-site message updated
T3   Completeness test added (parse-reject-coverage.test.ts; 19 cases)
T4   Existing-test sweep: audit + comment cleanup (no production-assertion
     flips expected; per Layer 2 §"Test strategy")
T5   DecodePoint docstring expansion (crypto/secp256k1.ts);
     per-file pointer comments at the 4 consuming files;
     facts/ergoscript-sigma.md + facts/ergoscript-eval.md cross-references
T6   facts/ergoscript-wire.md taxonomy update ('opcode-reserved' added;
     'not-implemented-yet' clarifying note)
T7   facts/ergoscript-eval.md + facts/ergoscript.md + README.md
     coverage-language refresh
T8   SESSION_CONTEXT.md + HANDOFF_PROMPT.md sweep + push
```

Expected commit count: 8.

**Why T2 leads with the code declaration:** adding `'opcode-reserved'` to the `ExprParseErrorCode` union type in `wire/errors.ts` (a single line) makes T2's parse.ts edits type-check cleanly. If T2 renamed parse.ts sites first, every site would temporarily fail typecheck.

**Why T3 lands before T4:** the new completeness test exercises `'opcode-reserved'`. T4's sweep of existing tests is now expected to be a confirmation pass (no assertion flips needed per Layer 2 audit), but landing T3 first gives a green baseline before any T4 touchup work.

**Why TDD's RED-first is acceptable to invert here:** the rename is mechanical, no algorithmic risk to discover. The new `ExprParseErrorCode` union member is a 1-line type declaration, not a "production code" arm in the conventional sense.

## Risk hotspots

1. **`'not-implemented-yet'` switches in fixture-gen Rust code.** Searches show `fixture-gen/src/cmds/ergoscript/eval/bin_op_bit.rs:270` has a comment "TS mirrors with 'not-implemented-yet' (shifts use SNumericTypeMethods)" — comment-only, not a code switch. T2 includes a confirmation grep across `fixture-gen/` to catch any switch-on-code-string this audit missed.

2. **T4 is mostly a no-op confirmation pass.** All 5 known `'not-implemented-yet'` test assertions (`ergo-tree.test.ts:186/207/247`, `opcodes.test.ts:186`, `opcodes.test.ts:171`) target either `OP_LAST_BLOCK_UTXO_ROOT_HASH` (deferred-4, stays at `'not-implemented-yet'`) or are robust negative-assertions. The `evaluate.test.ts:76` site asserts on `EvalError` (different class). T4's risk is a missed assertion in a corner of the test suite that grep didn't surface — mitigation is a final `grep "'not-implemented-yet'"` across `packages/ergoscript/test/` after T3 lands, before declaring T4 done.

3. **DecodePoint docstring drift.** Future phases may add new DecodePoint call sites and forget the divergence reference. Mitigation: single canonical paragraph at `crypto/secp256k1.ts:decodePoint`'s docstring; downstream sites use a one-line pointer per FILE (not per-invocation). This makes future-drift visible in code review as a missing per-file pointer rather than missing per-invocation noise.

4. **Coverage-language regression in future changelog appends.** Future phases (2j, etc.) may append `~70` language out of habit. Mitigation: the explanatory note added to `facts/ergoscript-eval.md`'s "Coverage summary" section uses "67 of 67 implementable + 19 reserved + 4 routed-elsewhere" — future phase reads should grok the framing before adding new summary entries. T7's edit lands the canonical phrasing for downstream copy-paste.

5. **The 4 routed-elsewhere opcodes may have hidden top-level direct dispatch in sigma-rust.** This spec asserts their dispatch is *only* via PropertyCall/MethodCall/SigmaBoolean nesting; if any has a parallel top-level Expr arm we missed, our `'not-implemented-yet'` for the top-level case is correctly cautious but technically a possible miss-vs-sigma-rust divergence. Mitigation: captured as the residual follow-up in §"Future work"; per-opcode source-read pass would close this. Low risk because sigma-rust's serializer would not emit these as top-level opcodes if the routing is the canonical path.

## Confidence check (OVERRIDES #2 — crypto/cost path)

**Confidence: 97%** on the rename mechanics and DecodePoint documentation.

- The 19 sites are confirmed truly-dead in sigma-rust via direct source-read (`op_code.rs:154-156` + `expr.rs:86-209` dispatch gap + `eval/` file listing — verified inline during reviewer pass).
- The 3 promoted opcodes (FUN_DEF, SOME_VALUE, NONE_VALUE) added in v2 are confirmed via cross-tree grep returning zero references outside their `op_code.rs` declaration — reviewer pass result.
- The DecodePoint dispatch logic is confirmed verbatim at `ec_point.rs:139-151` (also directly source-read).
- The rename is mechanical: a 1-character-per-site change plus message refresh. No semantic surprise possible.
- The completeness test exercises a public API surface (parse) with known inputs. No fixture-gen, no cross-runtime concern beyond standard vitest dual-environment.

**The 3% residual uncertainty:**
- 1% on the routed-elsewhere-4: are TRIVIAL_PROP_FALSE/TRUE / LAST_BLOCK_UTXO_ROOT_HASH / FLAT_MAP also dispatched at top-level Expr in sigma-rust (in addition to their nested routes)? Source-read confirms they're routed nested; whether ALSO direct-dispatched is the residual. Risk is bounded: if any are also direct-dispatch, our `'not-implemented-yet'` for that top-level path is overly cautious (we reject what sigma-rust would dispatch), which is a strict-mode posture — recoverable in a follow-up.
- 2% on macro-expansion: SOME_VALUE/NONE_VALUE/FUN_DEF could conceivably be referenced via a macro-generated dispatch I didn't expand. Sigma-rust's IR layout doesn't typically use this pattern, but I didn't expand every macro.

**Escalation status:** none. Not a crypto-path phase; not a cost-path phase. OVERRIDES #2 escalation triggers do not apply.

## Rollback plan

Single-revert per task. Each commit is independently revertible:

- T2: revert the rename. Sites return to `'not-implemented-yet'`. The completeness test from T3 would then fail; revert T3 alongside if needed.
- T3: revert the completeness test. No production-code coupling.
- T4: revert the comment touchups. No code coupling.
- T5: revert the docstring expansion. No behavior coupling.
- T6/T7: revert facts edits. No code coupling.
- T8: revert docs sweep.

If a deep regression surfaces (e.g., T2's rename breaks a fixture-gen invocation that grep didn't catch), revert T2 + T3 together; the rest stand alone.

## Future work (captured as residual follow-ups)

1. **Determine whether the 4 routed-elsewhere opcodes have parallel top-level direct dispatch in sigma-rust.** Per-opcode source-read pass:
   - `OP_LAST_BLOCK_UTXO_ROOT_HASH` — confirmed nested via PropertyCall id 9 on SContext; check if sigma-rust ALSO dispatches at top-level Expr.
   - `OP_FLAT_MAP` — confirmed nested via SColl method-call; check top-level.
   - `OP_TRIVIAL_PROP_FALSE`/`OP_TRIVIAL_PROP_TRUE` — confirmed nested via `sigmaboolean.rs:57-58`; check top-level.
   For each that turns out to have NO top-level direct dispatch in sigma-rust, extend the rename to `'opcode-reserved'`. For each that DOES, the current `'not-implemented-yet'` may need a more accurate code (`'opcode-routed-only'`?) or stay as a deliberate strict-reject of the top-level form.

2. **EvalError `'not-implemented-yet'` audit.** The 5 EvalError throw sites (`eval.ts:229`, `global-vars.ts:136`, `bin-op/relation.ts:336`, `bin-op/relation.ts:426`, `bin-op/bit.ts:58`) each represent a legitimately-TBD eval path. Quick audit to confirm each will eventually be implemented (vs. defensive-throw stays-forever) would inform whether the EvalError code should also rename for some cases.

3. **`isZero33` micro-optimization OR sigma-rust dispatch parity.** If a future 7-of-7 audit ever surfaces a real-world need to converge DecodePoint with sigma-rust's looser dispatch (e.g., a hostile peer sends `[0x00, garbage]` that sigma-rust nodes accept but we reject, causing a chain split), revisit Decision 2. Currently not motivated.

## Cross-references

- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/serialization/op_code.rs:154-156` — ModQ opcode reservations.
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/serialization/expr.rs:86-209` — parse dispatch table (the 19-arm gap).
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/` — directory listing (no impls for the 19).
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/types/scontext.rs:136` — LAST_BLOCK_UTXO_ROOT_HASH PropertyCall routing.
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/types/scoll.rs:84` — FLAT_MAP SColl method-call routing.
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/mir/sigmaboolean.rs:57-58` — TRIVIAL_PROP_FALSE/TRUE nested-context routing.
- `~/projects/ergots/external/sigma-rust/ergo-chain-types/src/ec_point.rs:127-151` — DecodePoint serialize + parse.
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (phase plan; this is 2i-d).
- `docs/specs/2026-05-21-ergoscript-phase-2i-c-deserialize-design.md` — preceding spec, template reference.
- `facts/ergoscript-eval.md` — primary update target.
- `facts/ergoscript-wire.md` — taxonomy update target.
- `facts/ergoscript-sigma.md` + `facts/ergoscript.md` + `README.md` — secondary update targets.

## Reviewer findings applied (2026-05-21)

Spec was reviewed by a general-purpose reviewer subagent dispatched with the explicit instructions: validate the "16 truly-dead opcodes" claim via independent source-read, audit the "7 routed-elsewhere" deferral, verify DecodePoint dispatch/serializer claims and call-site count, verify the 23-site total, check `ergo-tree.test.ts` assertion targets, audit the completeness-test approach. Reviewer returned 2 ★★★ critical findings, 3 ★★ moderate findings, 2 ★ minor findings.

**★★★ Critical findings (all applied inline):**

1. **3 of the 7 "deferred" opcodes are actually truly-dead.** `FUN_DEF` (103), `SOME_VALUE` (110), `NONE_VALUE` (111) have zero non-declaration references anywhere in sigma-rust per cross-tree grep. Promoted to the rename set; new totals: **19 truly-dead → `'opcode-reserved'`**, 4 routed-elsewhere → keep `'not-implemented-yet'`. Affects Goal, Non-goals, Decision 1 table, Decision 3 coverage language, Decision 4 completeness test (16 → 19 cases), Error taxonomy counts, Source mapping, Future work §1 (reduced from 7 items to 4).

2. **Missed test site at `opcodes.test.ts:186`.** Spec's Layer 2 enumeration listed only `ergo-tree.test.ts` + `evaluate.test.ts` + `corpus-eval.test.ts`. Added `opcodes.test.ts:186` (assertion on `OP_LAST_BLOCK_UTXO_ROOT_HASH` parse-reject) and `opcodes.test.ts:171` (robust negative assertion) to Layer 2 enumeration. Both stay at `'not-implemented-yet'` under the post-C1 framing.

**★★ Moderate findings (folded inline):**

1. **DecodePoint invocation count was wrong.** Spec said "6 sites"; actual is **9 invocations across 4 files** (verifier.ts 5×, decode-point.ts 1×, multiply-group.ts 2×, exponentiate.ts 1×). Decision 2 updated to use "9 invocations across 4 files" and the per-file pointer count is now "4 files" (not "6 sites").

2. **Line numbers were biased by ~3.** Original table listed case-statement lines; refreshed to `'not-implemented-yet'` throw-literal lines per the reviewer's grep.

3. **Risk Hotspot 2 misstated the test situation.** All 3 `ergo-tree.test.ts` assertions hardcode `0xa6` (LAST_BLOCK_UTXO_ROOT_HASH), so they stay at `'not-implemented-yet'` under the post-C1 framing regardless. Rewrote RH2 to reflect "T4 is a confirmation pass; expected zero production-assertion flips."

**★ Minor findings (acknowledged):**

1. **Completeness test body-construction prose was unclear.** Spec mid-sentence self-corrected on the bytes form. Cleaned to commit definitively to `[0x08, 0x01, opcode]` (header `0x08` = V0 + hasSize). Added note about LAST_CONSTANT_CODE not intercepting any of the 19 since all are ≥ 119.

2. **EvalError caller count was 4; actually 5.** `bin-op/relation.ts` has TWO throw sites (336, 426), not one. Caller count updated to 5 in the keep-code-declared rationale.

Net effect: spec confidence at 97% (unchanged from v1); 3 newly-classified truly-dead opcodes promoted into the rename set, eliminating a future-work item that a 2-minute source-read already resolved; one missed test site plugged.
