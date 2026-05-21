# Phase 2i-d — Arm-count reframe + DecodePoint documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto/cost-path → halt and declare (not applicable to this taxonomy-only phase but stays in the preamble); #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads]. Per `[[feedback-subagent-explicit-rules]]`, this is load-bearing.

**Spec:** `docs/specs/2026-05-21-ergoscript-phase-2i-d-arm-count-reframe-design.md` (HEAD `bcc83df`)

**Goal:** Reframe 19 wire-layer parse-reject sites from `ExprParseError 'not-implemented-yet'` to `'opcode-reserved'`; add a parse-reject completeness test; document the DecodePoint adapter strict-reject divergence as deliberate; refresh `~70` coverage language across facts/README.

**Architecture:** Pure taxonomy + documentation pass. No new eval semantics, no behavior change. The 19 sites are confirmed truly-dead in sigma-rust via direct source-read (verified during reviewer pass). The 4 routed-elsewhere sites (LastBlockUtxoRootHash, FlatMap, TrivialPropFalse, TrivialPropTrue) keep `'not-implemented-yet'`.

**Tech stack:** TypeScript (vitest, node + jsdom cross-runtime). No fixture-gen work. No new runtime dependencies.

**Invariants:**
- ExprParseError codes: 1 new (`'opcode-reserved'`); `'not-implemented-yet'` kept (still used by 4 wire + 5 eval sites).
- 19 wire/parse.ts sites renamed (3 new — FUN_DEF/SOME_VALUE/NONE_VALUE — were promoted from the original 16 during reviewer pass).
- 0 production-test-assertion flips expected (all 5 `'not-implemented-yet'` test assertions target the deferred-4 set or are EvalError-class).
- 19 new test cases in `parse-reject-coverage.test.ts`.
- No method-handler registry change (44 unchanged).
- No EvalError code change (64 unchanged).
- Ergoscript test count: 3174 → ~3193 (+19 from completeness test).

---

## Task ordering

```
T1   PLAN.md committed (this document)
T2   ExprParseErrorCode 'opcode-reserved' declared; 19 wire/parse.ts sites renamed + messages refreshed
T3   Completeness test added (parse-reject-coverage.test.ts; 19 cases)
T4   Existing-test sweep + fixture-gen grep audit (confirmation pass)
T5   DecodePoint docstring expansion + per-file pointers at 4 consuming files
T6   facts/ergoscript-wire.md taxonomy update ('opcode-reserved' + 'not-implemented-yet' clarifying note)
T7   facts/ergoscript-eval.md + facts/ergoscript.md + README.md coverage-language refresh
T8   SESSION_CONTEXT.md + HANDOFF_PROMPT.md sweep + push
```

Total: ~8 commits (this plan + 7 task commits).

---

## Task 1: Commit PLAN.md

**Files:**
- Create: `/home/mwaddip/projects/ergots/PLAN.md` (this file, overwrites 2i-c plan)

- [ ] **Step 1: Stage and commit**

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): overwrite PLAN.md with phase 2i-d execution plan

Per HANDOFF_PROMPT.md convention: PLAN.md is the in-flight phase's task
list, overwritten at each phase boundary. Spec at
docs/specs/2026-05-21-ergoscript-phase-2i-d-arm-count-reframe-design.md
(HEAD bcc83df, reviewer pass applied).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Verification**

```bash
git log --oneline -2  # confirm 2 commits ahead of bcc83df: PLAN + spec
```

---

## Task 2: Rename 19 wire/parse.ts sites + extend ExprParseErrorCode

**Files:**
- Edit: `packages/ergoscript/src/wire/errors.ts` — add `'opcode-reserved'` to `ExprParseErrorCode` union (1 line).
- Edit: `packages/ergoscript/src/wire/parse.ts` — rename 19 throw sites (code string + message string); leave the 4 routed-elsewhere sites untouched.

**Sites to rename** (per spec Decision 1 table; line numbers reference `'not-implemented-yet'` throw position):

| OP constant | throw line | new message |
|---|---|---|
| `OP_TRUE` | 406 | `'OpTrue opcode reserved in sigma-rust enum but not dispatched by sigma-rust\'s parser; mirrored as parse-reject'` |
| `OP_FALSE` | 411 | (same pattern with name swapped) |
| `OP_UNIT_CONSTANT` | 416 | |
| `OP_SELECT_1` | 433 | |
| `OP_SELECT_2` | 438 | |
| `OP_SELECT_3` | 443 | |
| `OP_SELECT_4` | 448 | |
| `OP_SELECT_5` | 453 | |
| `OP_FUN_DEF` | 463 | |
| `OP_SOME_VALUE` | 468 | |
| `OP_NONE_VALUE` | 473 | |
| `OP_MOD_Q` | 488 | |
| `OP_PLUS_MOD_Q` | 493 | |
| `OP_MINUS_MOD_Q` | 498 | |
| `OP_COLL_SHIFT_RIGHT` | 503 | |
| `OP_COLL_SHIFT_LEFT` | 508 | |
| `OP_COLL_SHIFT_RIGHT_ZEROED` | 513 | |
| `OP_COLL_ROTATE_LEFT` | 518 | |
| `OP_COLL_ROTATE_RIGHT` | 523 | |

**Sites to leave at `'not-implemented-yet'` (the deferred-4):**
- `OP_LAST_BLOCK_UTXO_ROOT_HASH` (throw line 428) — routed via PropertyCall id 9 on SContext.
- `OP_FLAT_MAP` (throw line 458) — routed via SColl method-call surface.
- `OP_TRIVIAL_PROP_FALSE` (throw line 478) — nested via SSigmaProp.
- `OP_TRIVIAL_PROP_TRUE` (throw line 483) — nested via SSigmaProp.

- [ ] **Step 1: Extend `ExprParseErrorCode` union**

Read `packages/ergoscript/src/wire/errors.ts`. Locate the `ExprParseErrorCode` union (or however the code-type is declared — could be a `type` alias or a `string` constant set). Add `'opcode-reserved'` to the union, alphabetically placed.

- [ ] **Step 2: Rename the 19 sites**

For each of the 19 listed throw sites: change the second argument of `new ExprParseError(...)` from `'not-implemented-yet'` to `'opcode-reserved'`, AND update the message string to the new pattern.

- [ ] **Step 3: Verify typecheck**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
```

Must be clean. If TS complains that `'opcode-reserved'` isn't a member of the union, Step 1 wasn't completed correctly.

- [ ] **Step 4: Run existing tests**

```bash
node_modules/.bin/vitest run packages/ergoscript/
```

Expected: 3174 pass (existing test count). The Layer 2 audit (T4) confirms no production-assertion flips — if T2 alone breaks tests at this point, something unexpected happened; debug before proceeding. Common cause: a test asserts on `.code` for a renamed site without us realizing.

- [ ] **Step 5: Stage and commit**

```bash
git add packages/ergoscript/src/wire/errors.ts packages/ergoscript/src/wire/parse.ts
git commit -m "$(cat <<'EOF'
refactor(ergoscript): rename 'not-implemented-yet' → 'opcode-reserved' for 19 truly-dead wire opcodes (T2 of 2i-d)

Per phase 2i-d spec Decision 1: 19 wire opcodes are reserved in sigma-rust's
OpCode enum but never dispatched by sigma-rust's parser (verified via
op_code.rs declaration + expr.rs dispatch gap + eval/ directory absence
during reviewer pass). Renaming the parse-reject code from
'not-implemented-yet' (forward-promise, misleading) to 'opcode-reserved'
(permanent-state, accurate).

Affected: OpTrue, OpFalse, UnitConstant, Select1-5, FunDef, SomeValue,
NoneValue, ModQ, PlusModQ, MinusModQ, CollShiftLeft/Right/RightZeroed,
CollRotateLeft/Right.

Not touched (the deferred-4, routed elsewhere): LastBlockUtxoRootHash
(PropertyCall id 9), FlatMap (SColl method-call), TrivialPropFalse/True
(SSigmaProp nesting).

The 'not-implemented-yet' code stays declared — still used by the 4 wire
sites above plus 5 EvalError throw sites (eval.ts, global-vars.ts,
bin-op/relation.ts ×2, bin-op/bit.ts).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add completeness test (parse-reject-coverage.test.ts)

**Files:**
- Create: `packages/ergoscript/test/parse-reject-coverage.test.ts`

**Test structure:** one `describe.each([...19 opcode entries...])` block. Each entry: `{ name: 'OpTrue', opcode: 0x?? }` (opcode bytes need lookup from `wire/op-codes.ts` or wherever OP_* constants live).

Body of each test:
```ts
const bytes = Uint8Array.from([0x08, 0x01, opcode])  // V0+hasSize header, body_size=1, opcode
expect(() => parseTree(bytes)).toThrow(ExprParseError)
try { parseTree(bytes) } catch (e) {
  expect((e as ExprParseError).code).toBe('opcode-reserved')
  expect((e as ExprParseError).message).toContain(name)
}
```

- [ ] **Step 1: Look up opcode values**

Read `packages/ergoscript/src/wire/op-codes.ts` (or the equivalent constants file — grep for `export const OP_TRUE` to find it). Build the lookup table for the 19 opcodes.

- [ ] **Step 2: Write the test file**

Use `describe.each` for compactness. Import `parseTree`, `ExprParseError` from the public surface.

- [ ] **Step 3: Verify typecheck + run test**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
node_modules/.bin/vitest run packages/ergoscript/test/parse-reject-coverage.test.ts
```

Expected: 19 pass.

- [ ] **Step 4: Run full ergoscript suite**

```bash
node_modules/.bin/vitest run packages/ergoscript/
```

Expected: 3174 + 19 = 3193 pass.

- [ ] **Step 5: Cross-runtime under jsdom**

```bash
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts test/parse-reject-coverage.test.ts
```

Expected: 19 pass.

- [ ] **Step 6: Stage and commit**

```bash
git add packages/ergoscript/test/parse-reject-coverage.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): parse-reject completeness for 19 'opcode-reserved' sites (T3 of 2i-d)

Per phase 2i-d spec Decision 4: defensive regression test asserting each
of the 19 truly-dead opcodes hits the parse-reject path with code
'opcode-reserved' and a message containing the human-readable opcode name.
Proves against silent regression if anyone later wires a stray dispatch
arm for these opcodes.

Construction form: [0x08, 0x01, opcode] — V0+hasSize header, body size 1,
bare opcode byte. All 19 opcode values are ≥ 119, well above
LAST_CONSTANT_CODE (112), so the inline-constant early-return at
parse.ts:175 does not intercept.

Test count: 3174 → 3193 (+19). Passes under both node and jsdom.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Existing-test sweep + fixture-gen grep audit

**Goal:** confirmation pass — no production-assertion flips expected per spec Layer 2.

- [ ] **Step 1: Grep audit for `'not-implemented-yet'` across test files**

```bash
grep -rn "'not-implemented-yet'" packages/ergoscript/test/
```

Expected sites:
- `ergo-tree.test.ts:186, 207, 247` — target `0xa6` (OP_LAST_BLOCK_UTXO_ROOT_HASH). Stays.
- `opcodes.test.ts:186` — positive assertion on LAST_BLOCK_UTXO_ROOT_HASH. Stays.
- `opcodes.test.ts:171` — negative assertion (`not.toBe`). Robust, stays.
- `evaluate.test.ts:76` — EvalError class. Stays.
- `corpus-eval.test.ts:128` — string-bucketing on code value for evaluator failures (EvalError bucket). Stays; consider comment cleanup if the bucket-name comment claims "wire layer" semantics.

For each: re-read the surrounding 5-line context. Confirm the input bytes/opcode target is in the deferred-4 set OR the error class is EvalError (not ExprParseError). If ANY site is found to target a renamed opcode, update that assertion to `'opcode-reserved'` and document in commit message.

- [ ] **Step 2: Grep audit for fixture-gen Rust references**

```bash
grep -rn "'not-implemented-yet'" fixture-gen/src/
```

Expected: 1 hit at `fixture-gen/src/cmds/ergoscript/eval/bin_op_bit.rs:270` — a comment about Bit shift dispatch. No code switches expected. If any Rust code-switch on the string is found, evaluate whether the Rust fixture-gen needs updating (probably not — the Rust comments reference the TS code, not vice versa).

- [ ] **Step 3: Comment cleanup if applicable**

If `corpus-eval.test.ts:128`'s surrounding comment claims `'not-implemented-yet'` means a specific thing that's now ambiguous (eval-TBD vs. wire-routed-elsewhere), update the comment to reflect the new ambiguity. Otherwise skip.

- [ ] **Step 4: Re-run full ergoscript suite**

```bash
node_modules/.bin/vitest run packages/ergoscript/
```

Expected: 3193 pass (no regression).

- [ ] **Step 5: Stage and commit**

If only a comment cleanup was applied:

```bash
git add packages/ergoscript/test/corpus-eval.test.ts  # or whatever was touched
git commit -m "$(cat <<'EOF'
test(ergoscript): comment cleanup post-rename + audit sweep (T4 of 2i-d)

Per phase 2i-d spec Layer 2: confirmation pass on the 5 existing
'not-implemented-yet' test assertions. All 5 confirmed to target either
the deferred-4 wire sites (LastBlockUtxoRootHash) or the EvalError class;
no production-assertion flips needed.

[Describe any comment cleanup here.]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no edits needed: skip commit entirely (T4 is a no-op confirmation pass). Document in T8 sweep.

---

## Task 5: DecodePoint docstring + per-file pointers

**Files:**
- Edit: `packages/ergoscript/src/crypto/secp256k1.ts` — expand the `decodePoint` docstring (current 5 lines → ~15 lines).
- Edit: `packages/ergoscript/src/eval/decode-point.ts` — 1-2 line pointer comment near `decodePoint` invocation.
- Edit: `packages/ergoscript/src/eval/multiply-group.ts` — same.
- Edit: `packages/ergoscript/src/eval/exponentiate.ts` — same.
- Edit: `packages/ergoscript/src/eval/sigma/verifier.ts` — same (covers all 5 invocations in this one file via a single docstring on the function-or-block that contains them).
- Edit: `facts/ergoscript-sigma.md` — one paragraph in the ProveDlog/ProveDhTuple section.
- Edit: `facts/ergoscript-eval.md` — one paragraph in the DecodePoint arm 2i-a changelog section; one-sentence cross-references in Exponentiate/MultiplyGroup 2i-b sections.

**Expanded docstring content (suggested for crypto/secp256k1.ts:decodePoint):**

```ts
/**
 * Decode a 33-byte SEC1 compressed point. The Ergo convention: 33 zero
 * bytes decodes to the identity (point-at-infinity).
 *
 * **Divergence from sigma-rust:** sigma-rust's `ec_point.rs:139-151`
 * dispatches on `buf[0] != 0` alone — any 33-byte payload whose first
 * byte is `0x00` is silently treated as identity, regardless of the
 * remaining 32 bytes. Our `decodePoint` requires ALL 33 bytes to be
 * zero (`isZero33`) and rejects `[0x00, non-zero...]` inputs as
 * malformed SEC1.
 *
 * **Why strict-reject is correct:** the divergence is unreachable on
 * well-formed inputs because sigma-rust's serializer at
 * `ec_point.rs:127-136` always emits identity as exactly 33 zero bytes
 * (`is_identity → write [0u8; 33]`). The only inputs that trigger the
 * divergence are hand-crafted MIR or hostile peer bytes. For hostile
 * inputs, strict-reject is a small additional safety margin: we don't
 * silently accept malformed-but-byte-zero-prefixed encodings.
 *
 * Throws on wrong length or invalid SEC1 encoding.
 *
 * Source: sigma-rust `ec_point.rs:130-151` (Ergo identity convention).
 */
```

**Per-file pointer template (for the 4 consuming files):**

```ts
// Note: decodePoint silently rejects `[0x00, non-zero]` inputs that
// sigma-rust would accept as identity. See decodePoint docstring at
// crypto/secp256k1.ts for the divergence rationale.
```

Place the pointer once per file (above the first `decodePoint` invocation in each), NOT at each individual invocation.

**Facts file additions:**

For `facts/ergoscript-sigma.md`, in the ProveDlog leaf-verifier section:

> **DecodePoint divergence note:** Both `ProveDlog.h` and `ProveDhTuple.{g,h,u,v}` decode 33-byte SEC1 compressed points via the package-internal `decodePoint` adapter. Our adapter rejects `[0x00, non-zero...]` inputs as malformed SEC1; sigma-rust's `ec_point.rs:139-151` would silently treat them as identity. The divergence is production-unreachable (sigma-rust's serializer always emits identity as 33 zero bytes); strict-reject is deliberate as a defense against hand-crafted/hostile inputs. Documented at `packages/ergoscript/src/crypto/secp256k1.ts:decodePoint`.

For `facts/ergoscript-eval.md`, in the DecodePoint arm (phase 2i-a section):

> The pre-existing strict-reject divergence on `decodePoint` (we require all-33-bytes-zero for identity vs. sigma-rust's `buf[0] != 0` dispatch) is documented centrally at `packages/ergoscript/src/crypto/secp256k1.ts:decodePoint`. Production-unreachable; deliberate as defense against hand-crafted inputs. Affects 4 files (verifier 5×, decode-point 1×, multiply-group 2×, exponentiate 1×).

Add a one-sentence cross-reference at MultiplyGroup and Exponentiate arms in the 2i-b section.

- [ ] **Step 1: Expand the docstring**

Read current `crypto/secp256k1.ts:57-64`. Replace with the expanded docstring above.

- [ ] **Step 2: Add per-file pointers**

For each of the 4 consuming files: locate the first `decodePoint` invocation (`verifier.ts:135`, `decode-point.ts:72`, `multiply-group.ts:57`, `exponentiate.ts:75`). Add the pointer comment above it.

- [ ] **Step 3: Update facts/ergoscript-sigma.md**

Read the current ProveDlog/ProveDhTuple section. Add the divergence note (1 paragraph).

- [ ] **Step 4: Update facts/ergoscript-eval.md**

Add the DecodePoint divergence paragraph in the 2i-a changelog section. Add one-sentence cross-references in the 2i-b MultiplyGroup and Exponentiate sections.

- [ ] **Step 5: Verify typecheck + tests**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
node_modules/.bin/vitest run packages/ergoscript/
```

Expected: clean + 3193 pass. Pure docstring/comment changes — no behavior coupling.

- [ ] **Step 6: Stage and commit**

```bash
git add packages/ergoscript/src/crypto/secp256k1.ts \
        packages/ergoscript/src/eval/decode-point.ts \
        packages/ergoscript/src/eval/multiply-group.ts \
        packages/ergoscript/src/eval/exponentiate.ts \
        packages/ergoscript/src/eval/sigma/verifier.ts \
        facts/ergoscript-sigma.md \
        facts/ergoscript-eval.md
git commit -m "$(cat <<'EOF'
docs(ergoscript): centralize DecodePoint strict-reject divergence note (T5 of 2i-d)

Per phase 2i-d spec Decision 2: documents the pre-existing TS-from-sigma-rust
divergence on decodePoint identity dispatch (we require all-33-bytes-zero
vs. sigma-rust's buf[0] != 0). No behavior change.

Documentation surface:
- Expanded docstring at crypto/secp256k1.ts:decodePoint (~15 lines covering
  the divergence, the rationale, and the production-unreachability argument).
- Per-file pointer comment at the 4 consuming files (verifier.ts,
  decode-point.ts, multiply-group.ts, exponentiate.ts) — one per file, not
  per invocation, to avoid copy-paste rot.
- Paragraph in facts/ergoscript-sigma.md (ProveDlog/ProveDhTuple leaf-verifier
  section).
- Paragraph in facts/ergoscript-eval.md (DecodePoint arm 2i-a section) +
  one-sentence cross-refs at MultiplyGroup/Exponentiate (2i-b).

Closes the 4-phase carry-forward (2g-medium, 2i-a, 2i-b, 2i-c handoffs
each mentioned the divergence as TODO; now resolved as deliberate).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: facts/ergoscript-wire.md taxonomy update

**Files:**
- Edit: `facts/ergoscript-wire.md` — line 172 ExprParseError code enumeration.

**Update:** add `'opcode-reserved'` to the enumeration with a brief description. Add a clarifying note next to `'not-implemented-yet'` explaining the surviving meanings.

**Suggested new entry:**

```
- **`'opcode-reserved'`** — 19 wire opcodes (`OpTrue`, `OpFalse`, `UnitConstant`, `Select1-5`, `FunDef`, `SomeValue`, `NoneValue`, `ModQ`/`PlusModQ`/`MinusModQ`, `CollShiftLeft/Right/RightZeroed`, `CollRotateLeft/Right`) are reserved in sigma-rust's `OpCode` enum but never dispatched by sigma-rust's parser. We mirror via unconditional parse-reject. The opcode constants exist in sigma-rust's wire enum for forward-compat / historical reasons but no `Evaluable` impl ever ships.
```

**Clarifying note for `'not-implemented-yet'`:**

> *(Note: this code is now ambiguous between "parse-reject for sigma-rust routed-elsewhere opcodes (the 4 remaining: `LastBlockUtxoRootHash`, `FlatMap`, `TrivialPropFalse`, `TrivialPropTrue`)" and the EvalError-class meaning "TBD eval support". Both meanings legitimate, distinguished by error class.)*

- [ ] **Step 1: Edit the file**

- [ ] **Step 2: Verify (no test impact)**

`facts/` files have no test coverage; verification is read-back-only.

- [ ] **Step 3: Stage and commit**

```bash
git add facts/ergoscript-wire.md
git commit -m "$(cat <<'EOF'
docs(facts): add 'opcode-reserved' to ExprParseError taxonomy (T6 of 2i-d)

Per phase 2i-d spec Error taxonomy section: facts/ergoscript-wire.md line
172 ExprParseError enumeration gains 'opcode-reserved' entry covering the
19 truly-dead wire opcodes. Adds clarifying note on the now-ambiguous
'not-implemented-yet' code (parse-reject for 4 routed-elsewhere opcodes
vs. EvalError-class TBD; distinguished by error class).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Coverage-language refresh

**Files:**
- Edit: `facts/ergoscript-eval.md` — Public surface / Coverage caveat sections (find all forward-looking "67 of ~70" references; historical changelog entries stay as-is).
- Edit: `facts/ergoscript.md` — Coverage summary table.
- Edit: `README.md` — `@ergots/ergoscript` Packages-table row.

**New phrasing for forward-looking summary tables:**

> 67 of 67 implementable arms wired. 19 wire opcodes (ModQ family, OpTrue/False, UnitConstant, Select1-5, CollShift family, CollRotate family, FunDef, SomeValue, NoneValue) are reserved in sigma-rust's enum but unconditionally parse-rejected — sigma-rust itself never dispatches them. We mirror via `ExprParseError 'opcode-reserved'`. A further 4 (LastBlockUtxoRootHash, FlatMap, TrivialPropFalse, TrivialPropTrue) are routed through other dispatch paths in sigma-rust; their top-level direct-dispatch `'not-implemented-yet'` status remains under separate review.

**For README's terser row:** "67 of 67 implementable Expr arms wired (19 wire opcodes are reserved-but-never-dispatched in sigma-rust; we mirror as `'opcode-reserved'` parse-reject)".

- [ ] **Step 1: facts/ergoscript-eval.md**

Search for `~70` and `of 67 implementable`. Replace forward-looking summary sentences (Coverage section, Public surface caveat). Historical per-phase changelog entries (`60 of ~70 after 2i-a`, etc.) stay UNCHANGED as historical record.

- [ ] **Step 2: facts/ergoscript.md**

Update the Coverage summary table row for the evaluator slice.

- [ ] **Step 3: README.md**

Update the `@ergots/ergoscript` row in the Packages table.

- [ ] **Step 4: Stage and commit**

```bash
git add facts/ergoscript-eval.md facts/ergoscript.md README.md
git commit -m "$(cat <<'EOF'
docs: refresh ~70-arm coverage language to 67-of-67-implementable (T7 of 2i-d)

Per phase 2i-d spec Decision 3: the '~70' denominator implied 3 more arms
to wire. There aren't. The real denominator is 67 implementable variants +
19 reserved-never-dispatched + 4 routed-elsewhere. Forward-looking summary
sections in facts/ergoscript-eval.md, facts/ergoscript.md, and README.md
updated to use '67 of 67 implementable arms' with an explanatory note
covering the reserved-19 and routed-elsewhere-4 sets.

Historical per-phase changelog entries inside facts/ergoscript-eval.md
unchanged — they keep their original wording as historical record.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: SESSION_CONTEXT + HANDOFF_PROMPT sweep + push

**Files:**
- Edit: `SESSION_CONTEXT.md` — full rewrite reflecting phase 2i-d completion.
- Edit: `HANDOFF_PROMPT.md` — full rewrite reflecting phase 2i-d completion + revised "next phase" queued options.

**SESSION_CONTEXT.md structure:** mirror the 2i-c version but reflect 2i-d state (8 commits since `3b98b84`; coverage language reframed; 4 routed-elsewhere remaining; next options shift to 2j or 7→4 follow-up).

**HANDOFF_PROMPT.md structure:** mirror 2i-c version. Update test counts, arm counts (still 67), EvalError codes (still 64), commit count, queued-next options. New queued options:
- 2j (cost calibration; consensus-critical)
- Follow-up on the 4 routed-elsewhere opcodes (per-opcode source-read pass)
- Eval-side `'not-implemented-yet'` audit (5 sites)
- Tech-debt: `force_any_val` fixture-gen nondeterminism (latent in `mg_random_random`)
- Publish posture (still frozen)

- [ ] **Step 1: Run full verification before declaring complete**

```bash
# Per CLAUDE.md verification commands section
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
node_modules/.bin/vitest run packages/

cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts
cd ../..

cd fixture-gen && cargo run --release && cd ..
git status  # should be clean modulo audit20260519/
```

All must pass. Test count should be 3174 + 19 = 3193 for ergoscript; total monorepo 3752 + 19 = 3771.

- [ ] **Step 2: Edit SESSION_CONTEXT.md**

Full rewrite. Capture: phase 2i-d complete; ~8 commits since `3b98b84` (this PLAN + T2-T8); coverage language reframed; tests 3193; codes unchanged at 64; ExprParseError gains `'opcode-reserved'`; 4 routed-elsewhere still at `'not-implemented-yet'`; DecodePoint divergence documented centrally; publish posture unchanged.

- [ ] **Step 3: Edit HANDOFF_PROMPT.md**

Full rewrite per the structure above. Phase plan section updates: ✅ Phase 2i-d added.

- [ ] **Step 4: Stage and commit**

```bash
git add SESSION_CONTEXT.md HANDOFF_PROMPT.md
git commit -m "$(cat <<'EOF'
docs: SESSION_CONTEXT + HANDOFF_PROMPT sweep for phase 2i-d (T8 of 2i-d)

Phase 2i-d (arm-count reframe + DecodePoint documentation) complete.
8 commits since bcc83df: spec + PLAN + T2-T7 + this sweep.

State summary:
- ExprParseError 'opcode-reserved' wired; 19 wire/parse.ts sites renamed.
- 4 routed-elsewhere wire sites (LastBlockUtxoRootHash, FlatMap,
  TrivialPropFalse, TrivialPropTrue) stay at 'not-implemented-yet'.
- Eval-side 'not-implemented-yet' callers (5 sites) unchanged.
- DecodePoint divergence documented centrally at crypto/secp256k1.ts +
  4 per-file pointers + 2 facts cross-references.
- Coverage language reframed: '67 of 67 implementable arms' + 19 reserved
  + 4 routed-elsewhere.
- Tests: 3174 → 3193 (+19 from parse-reject-coverage.test.ts).
- Method handler registry: 44 unchanged. EvalError codes: 64 unchanged.

Queued for next session:
- 2j — cost calibration (Layer C3; consensus-critical per umbrella spec).
- 4-opcode routed-elsewhere follow-up (per-opcode source-read pass).
- Eval-side 'not-implemented-yet' audit (5 sites).
- force_any_val fixture-gen nondeterminism remediation (latent).
- OPS-02 vitest upgrade.

Publish posture still frozen ("before publishing we finish the library").

Validates [[feedback-review-by-default]] updated rule: spec+review even
seemingly-small jobs (3 opcodes promoted from deferred-7 during reviewer
pass; missed test site plugged).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Push**

```bash
git push origin master
```

Verify with `git status` (clean) and `git log --oneline origin/master..HEAD` (empty).

- [ ] **Step 6: Update project_ergots_direction memory**

Per `[[feedback-docs-pass-every-phase]]`, end-of-phase docs sweep includes the auto-memory refresh. Update `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` to reflect post-2i-d state: HEAD, commit count, test count, arm count framing.

---

## Done criteria for the phase

- All 8 tasks committed and pushed.
- `git status` clean modulo `audit20260519/`.
- `origin/master` aligned with local `master`.
- All four packages typecheck clean.
- All four packages test suite passes under both `node` and `jsdom`.
- `cargo run -p fixture-gen` produces clean output (modulo the known `multiply-group.json` latent nondeterminism from 2i-b).
- SESSION_CONTEXT.md and HANDOFF_PROMPT.md reflect the post-2i-d state.
- `project_ergots_direction` memory refreshed.
