# Phase 2j-pre fix-1 — `sbox-ergo-tree-no-size` rejection (v0+hasSize=false SBox parse)

**Status:** Draft v2 (2026-05-22). Reviewer pass applied.
**Author:** Claude Opus 4.7 (1M context) under user direction.
**Phase scope:** Make `parseSValue(SBox)` handle ErgoTree bodies whose header has `hasSize=false`, by delegating to a shared `parseTree`-equivalent body parse rather than rejecting. Single-site library bug fix; surfaced by 2j-pre Layer-3 smoke against ~99% of mainnet boxes.

**Preceding phase:** 2j-pre (mainnet-validation harness; 20 commits pushed to origin/master, HEAD `2e86757`).
**Phase plan:** the 2j-pre fix-list (handoff §"Phase 2j-pre fix-list"). Item 1 of 2; item 2 (`missing-utxo at h=3850`) is a separate focused spec after this.

---

## Goal

Unblock the harness's `validate-block.ts` output-roundtrip pass against real mainnet boxes by deleting an incorrect rejection in `parseSValue(SBox)`. Today the parser throws `SValueParseError('sbox-ergo-tree-no-size')` for any SBox whose ErgoTree header byte has bit-3 (the `hasSize` flag) clear. The comment at `parse-svalue.ts:280-282` justifies this with "all real on-chain boxes use v1+ (hasSize=true)". The 2j-pre Layer-3 smoke against the user's 25 GB mainnet snapshot empirically refutes that assumption: every attempt halted at the FIRST SBox of the first transaction across heights 1, 1000, and 3849 — all with header byte `0x10` (v0, hasSize=false, constantSegregation=true) or `0x00` (v0, hasSize=false, no segregation).

The fix lets the parser handle hasSize=false trees by parsing the body directly from the shared reader, mirroring sigma-rust's `ErgoTree::sigma_parse` (`ergo_tree.rs:410-453`) which already handles both branches.

## Non-goals

- **No new opcode arms.** This is a parser plumbing fix, not an evaluator-coverage change. The 67-of-67 implementable arm count is unchanged.
- **No serialize-side change.** `serializeSValue(SBox)` at `serialize-svalue.ts` writes the captured `ergo_tree_bytes` verbatim; the existing `serializeTree` at `ergo-tree.ts:207-275` already emits both hasSize=true and hasSize=false symmetrically (lines 251-253). The fix is parse-side only.
- **No `parseTree(bytes)` behavior change visible to external callers.** The external function-signature `parseTree(bytes: Uint8Array): ErgoTree` stays exactly as documented. Its internal structure refactors to share a helper with the new SBox-internal call site.
- **No additional MAX_TREE_SIZE enforcement inside the SBox path.** SBox-internal trees are bounded by the enclosing block size; mainnet protocol limits cap block bytes well below MAX_TREE_SIZE per tree. Matching sigma-rust's no-explicit-cap-here pattern.
- **No fixture-gen Rust changes.** This fix exercises capability the library has been missing; the test fixture comes from a real mainnet box (the harness already extracts these via the shim).

## Motivation

Three converging reasons:

1. **Empirical refutation of the rejection rationale.** The comment claims "all real on-chain boxes use v1+ (hasSize=true)". Layer-3 smoke shows the opposite — at heights 1, 1000, 3849, EVERY first-output of the first-transaction halts with header byte `0x10` or `0x00`. v0+hasSize=false (P2PK) is the mainnet majority shape, not the exception.

2. **The fix is structurally trivial against the spec.** Sigma-rust's parse path at `ergo_tree.rs:410-453` ALREADY handles hasSize=false on a shared reader: read header → if `is_constant_segregation`, parse constants from outer reader → `Expr::sigma_parse(r)` on outer reader. The Expr grammar is self-delimiting (each opcode-arm consumes a deterministic number of bytes), so the cursor naturally lands at the body's end. Our TS `parseTree(bytes)` ALREADY contains the equivalent body-parse logic at `ergo-tree.ts:139-166` — it just packages it behind a function that demands a pre-sliced byte input. The fix extracts the body parse into a helper that operates on a shared reader.

3. **Harness unblock.** Until this lands, the harness cannot validate ≥ 1 real mainnet block in the output-roundtrip phase — every smoke run halts at the first v0 box. Item 2 (the shim walker bug at h=3850) is reachable only by walks that successfully traverse heights 1..3849, which requires this fix to be in place first.

## Architecture

### Decision 1: Extract `parseTreeFromReader(r: ByteReader): ErgoTree` from `parseTree`

Current `parseTree(bytes)` does (`ergo-tree.ts:103-192`):
1. Empty/oversized check.
2. Wrap `bytes` in a `ByteReader outer`.
3. Read header byte → derive `TreeHeader`.
4. If `hasSize`: read VLQ body size, slice into bounded `inner` reader. Else: slice outer's remaining into a fresh `inner` reader.
5. Parse constants (if segregated) and body Expr from `inner`.
6. Enforce `inner.isExhausted` (no trailing in declared body) and `outer.isExhausted` (no trailing in envelope).
7. Return `ErgoTree`.

Refactor to:

```ts
// New internal helper. Reads from the current cursor position. Leaves
// the reader at the byte AFTER the body. Does NOT enforce caller's
// expectations about remaining bytes — the caller decides.
export function parseTreeFromReader(outer: ByteReader): ErgoTree {
  // Steps 3..5 above. For hasSize=false, `inner = outer` (share the
  // reader directly, mirroring sigma-rust). For hasSize=true, `inner`
  // is a fresh ByteReader over `outer.readBytes(bodyByteLength)`.
  // The hasSize=true branch still enforces `inner.isExhausted` after
  // body parse — sigma-rust's bounded-buffer pattern requires it.
}

// `parseTree(bytes)` becomes a thin wrapper.
export function parseTree(bytes: Uint8Array): ErgoTree {
  if (bytes.length === 0) throw new ErgoTreeParseError('empty ErgoTree bytes', 'empty')
  if (bytes.length > MAX_TREE_SIZE) throw new ErgoTreeParseError(
    `ErgoTree size ${bytes.length} exceeds ${MAX_TREE_SIZE} byte cap`,
    'oversized'
  )
  const outer = new ByteReader(bytes)
  const tree = parseTreeFromReader(outer)
  if (!outer.isExhausted) {
    throw new ErgoTreeParseError(
      `${outer.remaining} trailing bytes after ErgoTree envelope`,
      'trailing-bytes',
    )
  }
  return tree
}
```

**Why share the reader (not slice) for `hasSize=false`:** the SBox-internal caller needs `outer.position` to advance past the tree's bytes so the box parser can continue reading `creation_height`. The current `parseTree(bytes)` creates a fresh ByteReader over `outer.readBytes(outer.remaining)` (line 146) which works for the `parseTree(bytes)` case (callers don't see the outer's position) but doesn't work for the shared-reader case. Sharing the reader directly resolves both: `parseTree(bytes)` wrapper still enforces `outer.isExhausted`, and the SBox caller continues reading at the right position.

**hasSize=true path is unchanged behaviorally.** The bounded-buffer pattern still applies (we never want the inner reader to advance past the declared body region). The helper enforces `inner.isExhausted` inside the hasSize=true branch.

### Decision 2: Update `parseSValue(SBox)` to call `parseTreeFromReader`

`packages/ergoscript/src/wire/parse-svalue.ts` lines 274-291 currently capture `treeStart`, read the header byte, bail if `!hasSize`, then read `bodySize`-bounded bytes and slice. Replace with:

```ts
// --- ergoTreeBytes (self-delimiting via ErgoTree header) ---
const treeStart = r.position
parseTreeFromReader(r)  // advances r past the tree body; sigma-rust mirror
const ergoTreeBytes = r.slice(treeStart, r.position).slice()  // defensive copy
```

We don't *use* the returned `ErgoTree` value here — the SBox parse only needs the raw `ergo_tree_bytes` for the `ErgoBox.ergoTree` field (downstream callers re-parse via the public `parseTree` if they want structural access). The single call serves to advance the cursor.

Cost: a parsed-then-discarded `ErgoTree` per box. Mainnet has ~5.4M boxes in the snapshot used for 2j-pre smoke; the body parse is the same work `parseTree` does today on the harness's output-roundtrip pass. Net runtime per box is unchanged — we do the work once during SBox parse and once again during the round-trip's `parseTree(ergoTreeBytes)` check. Acceptable for the harness; a future micro-optimization could cache the parsed tree on the SBox value.

### Decision 3: Remove `'sbox-ergo-tree-no-size'` from the `SValueParseError` taxonomy

This code was added in 2j-pre (commit `867e99e`, T9) as a deliberate strict-reject because the implementer didn't have a working v0+hasSize=false path yet. Now that we DO have one, the code becomes structurally unreachable.

Two options:
- **A. Remove cleanly.** Delete the throw site, remove from the error-class union type, remove from facts file. Justified because: (a) ergoscript is pre-publish (local v0.3.x), (b) the code was 5 days old at handoff, (c) no external consumer dispatches on it, (d) it's "rejection-by-mistake" not "deliberate-strict-mode-posture".
- **B. Reserve for ABI stability** (like `'conjecture-not-implemented'`). Justified if we anticipate publishing soon; preserves the union for downstream catch-on-code patterns.

**Recommendation: A (remove cleanly).** Per `[[feedback-correctness-over-effort]]`, don't paper over with deprecation when removal is the correct fix. Pre-publish, no consumers, no ABI commitments to preserve.

**Removal cascade — 13 occurrences across 9 files** (validated by reviewer-pass grep across the entire repo):

| File | Lines | Reference kind |
|---|---|---|
| `packages/ergoscript/src/wire/parse-svalue.ts` | 278-287 | throw site (deleted by T4) |
| `packages/ergoscript/src/wire/parse-svalue.ts` | 286 | string literal in throw constructor |
| `packages/ergoscript/dist/index.js` | ~772 | compiled mirror — refreshed by `npm run build` post-T4 (see Decision 5) |
| `facts/ergoscript-wire.md` | 176 | taxonomy enumeration |
| `tools/mainnet-validate/README.md` | 109, 129, 177 | example JSON, error-class table, fix-list narrative |
| `tools/mainnet-validate/harness/test/integration/halt-path.test.ts` | 22-23, 156-162 | test-comment narrative + `'sbox-parse-failed'` halt-snapshot assertion (see Decision 6) |
| `tools/mainnet-validate/harness/test/integration/tip-reach-path.test.ts` | 185 | `'sbox-parse-failed'` halt-snapshot assertion |
| `tools/mainnet-validate/harness/test/integration/resume-path.test.ts` | 25-28 | test-comment narrative |
| `PLAN.md` | 1075-1079 | smoke-walk table |
| `HANDOFF_PROMPT.md` | 35 | fix-list item 1 narrative |
| `SESSION_CONTEXT.md` | 48, 112 | fix-list summary |

**Discipline note (reviewer M4 applied):** the previous draft said "lines 176-177" of facts/ergoscript-wire.md. The actual line is 176 only; line 177 is `SValueSerializeError`, a different class. Corrected.

### Decision 4: Extract `parseTreeFromReader` into ergo-tree.ts; accept the new circular dependency as ESM-tolerable

Reviewer M1 identified a new import cycle introduced by the refactor:
- `ergo-tree.ts:44` already imports `parseSValue` from `./parse-svalue` (used inside `parseTree` for segregated-constants parsing).
- The refactor adds a reverse import: `parse-svalue.ts` imports `parseTreeFromReader` from `./ergo-tree.ts`.
- New cycle: `ergo-tree.ts ↔ parse-svalue.ts`.

ESM tolerates this when both sides use the imported values only in function bodies (never at module top-level). Both call sites here are function-body — `parseSValue(SBox)`'s arm and `parseTreeFromReader`'s constants loop — so the cycle is functionally safe today.

Alternatives considered and rejected:
- **Move `parseTreeFromReader` to a new `wire/_parse-tree-body.ts` module.** Doesn't break the cycle — the body parser still needs `parseSValue` for segregated constants, and `parse-svalue.ts` still needs the body parser. The cycle just shifts to a new pair.
- **Inline the body-parse logic in `parse-svalue.ts`** (no helper extraction). Code duplication (~20 lines). Maintenance hazard: a future change in body-parse semantics would have to be made in two places.

**Mitigation in T4:** the implementer verifies module-load order by running the full test suite under `vitest run`; any cycle-induced load-order issue surfaces as a `ReferenceError` at first use. If surfaced, fall back to the inline-duplication option and document the choice.

### Decision 5: Explicit verification commands in the execution order (OVERRIDES rule #6)

Reviewer C3 caught that the previous draft omitted `npm run build`, `npx tsc --noEmit`, and `npm test` from the per-task verification gates. Per OVERRIDES rule #6 ("FORCED VERIFICATION"), every code-touching task must run the appropriate verification before being declared done.

Added per-task gates (now reflected in §"Execution order" below):

- **After T4 (GREEN refactor):** `npx tsc --noEmit -p packages/ergoscript/tsconfig.json` + `node_modules/.bin/vitest run packages/ergoscript` + cross-runtime jsdom variant.
- **Before T7 (Layer 3 smoke):** `npm run build` in `packages/ergoscript/` to refresh `dist/`. The harness imports `@ergots/ergoscript` via the workspace's `file:` deps, which resolves to `dist/index.js` per `packages/ergoscript/package.json`'s `"main"` / `"exports"` entries. Running the harness without rebuild executes the OLD (pre-fix) parser; T7 would silently pass-or-fail against stale code.

### Decision 6: T6b — refresh harness integration-test assertions

Reviewer C1 identified 3 harness integration tests that snapshot the CURRENT halt point and will break post-fix:

- `tools/mainnet-validate/harness/test/integration/halt-path.test.ts:160-162` — asserts halt at h=1 with `phase: 'output-roundtrip'` + `errorCode: 'sbox-parse-failed'` (the harness's wrapped form of the underlying SValueParseError).
- `tools/mainnet-validate/harness/test/integration/tip-reach-path.test.ts:185` — same assertion shape at h=999.
- `tools/mainnet-validate/harness/test/integration/resume-path.test.ts:25-28` — comment-narrative pin; functional assertion is downstream.

These tests only run when `checkRealDataPrereqs()` finds the 25 GB local fixture; they're gated by environment, not CI-required. But on the user's machine they will execute.

T6b's job: after T7 (Layer 3 smoke) reveals the NEW halt point (likely a different phase, possibly a different height), update the three snapshots to pin the new halt site. If the smoke reveals halts SCATTERED across many phases / heights (e.g., one bug per block), T6b instead removes the strict snapshot assertions and replaces them with looser shape assertions (`expect(report.height).toBeGreaterThan(0)`) — pinning the specific halt point would be churn-bait until 2j proper's calibration pass finishes.

### Decision 7: facts/ergoscript-wire.md taxonomy update

Line 176 currently lists `'sbox-ergo-tree-no-size'` in the `SValueParseError` codes enumeration. Remove that entry. Add a one-line note in the "Phase 2j-pre fix-1" changelog section (newly added) explaining the removal and that v0+hasSize=false SBoxes are now supported via shared-reader body parse.

No other facts updates needed: `parseTreeFromReader` is internal (not in the public surface section); the public `parseTree(bytes)` signature and behavior are unchanged.

## Error taxonomy

| Code | Class | Before | After |
|---|---|---|---|
| `'sbox-ergo-tree-no-size'` | `SValueParseError` | thrown at parse-svalue.ts:278-287 | **REMOVED** from union type, throw site deleted |
| `'trailing-bytes'` | `ErgoTreeParseError` | thrown in two places (line 173-184) | unchanged; helper preserves both checks for hasSize=true; wrapper preserves outer-envelope check for `parseTree(bytes)` callers |

No new codes introduced.

## Test strategy

Three layers:

### Layer 1 — synthetic v0+hasSize=false P2PK fixture

The mainnet-canonical v0+hasSize=false ErgoTree is the P2PK shape: 36 bytes total = header `0x00` + body `0x08 0xcd <33 bytes pubkey>`. Byte breakdown (reviewer-pass Mi3 confirmed):

- `0x00` — header byte: version=0, hasSize=false, constantSegregation=false.
- `0x08` — SType code for `SSigmaProp`.
- `0xcd` — `ProveDlog::OP_CODE` (sigma-rust `serialization/sigmaboolean.rs:50`, value `PROVE_DLOG = 205`).
- 33 bytes — compressed secp256k1 EcPoint (the miner pubkey).

The structure is `Const(SSigmaProp, SigmaProp(ProveDlog(EcPoint)))` serialized inline.

Tests (file `test/parse-svalue-sbox-no-size.test.ts` — new):
1. **`'parses v0+hasSize=false P2PK SBox without throwing'`** — minimal full SBox bytes (value VLQ + tree + creation_height + 0 tokens + 0 regs + 32-byte tx_id + VLQ index); assert `parseSValue(SBox, 0, r)` returns `value.kind === 'Box'`.
2. **`'round-trips byte-equal'`** — `serializeSValue(SBox, parsedValue, 0, writer)` produces bytes identical to the synthetic input.
3. **`'ergoTreeBytes captures exactly the tree bytes'`** — assert `parsedBox.value.ergoTree` matches the synthetic header+body bytes exactly (no leading/trailing).
4. **`'public-API parseTree handles the same v0+hasSize=false bytes'`** — assert that the round-trip via `parseTree(captured) → serializeTree(...)` produces the same 36 bytes. Locks in that the public `parseTree(bytes)` wrapper hasn't regressed for the hasSize=false case.

Reviewer M5 applied: the previous draft also proposed a `0x10` (constantSegregation=true) synthetic case but left its body bytes undecided. Dropped from Layer 1 because (a) the body shape under segregation isn't trivially pinpointable without picking a body opcode and exercising the full constants-array parse, and (b) the real-mainnet Layer 2 fixture naturally covers segregation-true variants. If the Layer 2 corpus turns out to NOT contain a `0x10` example, T5 captures one separately or hand-constructs against a known-good body (e.g., a copy of a real mainnet body with `0x00` swapped to `0x10`).

### Layer 2 — real mainnet fixture

Capture one v0+hasSize=false box from the user's bootstrap-data snapshot (e.g., genesis output 0). Add to `packages/ergoscript/test/fixtures/` as a hex-encoded byte array. Test (added to the same test file):

5. **`'parses real mainnet v0+hasSize=false SBox at height 1'`** — load fixture; assert parse succeeds; assert round-trip byte-equal.

Capture mechanism: a small `tools/mainnet-validate/` invocation that dumps the first output of block 1 to a JSON file, hex-encoded. Or, since the smoke walk already surfaced the byte sequence inline in halt diagnostics, manually transcribe the bytes from the smoke logs. Either is fine; the latter is faster.

### Layer 3 — smoke walk advances past the `sbox-ergo-tree-no-size` halt site

After implementation, re-run T12-equivalent smoke against the bootstrap-data snapshot:
- `--start-height 1 --max-height 5` — expect: parse no longer halts at the FIRST output of the FIRST tx. The walk advances PAST the previous halt site. Downstream halts in `evaluate` or `verify-signature` are PROBABLE (the harness's evaluate / sig paths have unit coverage but no prior end-to-end exercise on real mainnet boxes — see `tools/mainnet-validate/README.md:173-174`); they become 2j proper's next fix-list items.
- `--start-height 3849 --max-height 3850` — expect: h=3849 advances at least past output-roundtrip (parse fix lands), then halts at h=3850 on item 2 (the shim walker bug, separately spec'd).

**Layer-3 success criterion (reviewer M2 applied — tightened):** "the harness advances PAST the `sbox-ergo-tree-no-size` halt site." Not "ANY block validates fully end-to-end." The reviewer flagged that multiple downstream halts are probable, and the harness was explicitly designed for stop-on-first-divergence triage; this spec's job is to remove ONE halt site, not validate the whole library against real mainnet. Future halts feed 2j proper's calibration corpus, not this spec.

If Layer 3 surprisingly DOES validate ≥ 1 full block end-to-end on the first try, that's a stretch outcome worth recording in T7's brief findings note — but not a required deliverable.

### No mutation testing

The fix is a parser plumbing change, not a new opcode arm. Existing parse-mutation suites (6,221 mutations across the wire-format corpus) already cover the byte-level invariants. The new code paths are exercised by the Layer 1/2 fixtures; no per-byte mutation pass would add meaningful signal.

## Source mapping to sigma-rust

| Rust source (pinned `integration/ergots`, HEAD `ed5452cf`) | TS impact |
|---|---|
| `ergotree-ir/src/ergo_tree.rs:410-453` (`ErgoTree::sigma_parse`) | Master reference for the parse flow. Our `parseTreeFromReader` mirrors the non-hasSize branch (lines 436-451) — read constants if segregated, then `Expr::sigma_parse(r)` on the shared reader. |
| `ergotree-ir/src/chain/ergo_box.rs:343-388` (`parse_box_with_indexed_digests`) | Confirms sigma-rust calls `ErgoTree::sigma_parse(r)` directly on the shared reader (line 350); no special-casing of hasSize. Our refactored `parseSValue(SBox)` matches this pattern. |
| `ergotree-ir/src/ergo_tree.rs:372-408` (`ErgoTree::sigma_serialize`) | Confirms serialize-side symmetry: hasSize controls size-prefix emission (line 401); body bytes are written verbatim. Our `serializeSValue(SBox)` already writes captured `ergoTreeBytes` verbatim, so no serialize change is needed. |

## Execution order

```
T1   Spec lands (this file)
T2   PLAN.md committed (overwrites 2j-pre plan)
T3   Layer 1 fixture + failing test (RED)
T4   Refactor parseTree → parseTreeFromReader + parseTree wrapper
     + update parseSValue(SBox) to call the helper (GREEN)
     Verify per OVERRIDES rule #6:
       - npx tsc --noEmit -p packages/ergoscript/tsconfig.json   (CLEAN)
       - node_modules/.bin/vitest run packages/ergoscript         (all pass)
       - cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts  (jsdom CLEAN)
T5   Layer 2 real-mainnet fixture + test
     Same verification commands as T4.
T6   Remove 'sbox-ergo-tree-no-size' throw site + facts file entry
     + propagate removal through README.md / PLAN.md / HANDOFF_PROMPT.md
     / SESSION_CONTEXT.md (per Decision 3's 13-occurrence cascade table).
     Re-grep for any missed reference; same verification commands.
T6b  Rebuild dist: cd packages/ergoscript && npm run build
     (refreshes packages/ergoscript/dist/index.js so the harness sees the
     post-fix parser via its file: workspace dep)
T7   Layer 3 smoke re-run + brief findings note (which halt surfaces,
     if any; record under HANDOFF_PROMPT.md's fix-list for 2j proper)
T7b  Refresh harness integration-test snapshots
     (halt-path.test.ts, tip-reach-path.test.ts assertions at the
     observed new halt site — or replaced with shape-only assertions
     per Decision 6 if halts scatter across heights)
T8   SESSION_CONTEXT + HANDOFF_PROMPT sweep + push
```

Expected commit count: 9 (was 8 in v1; +1 for T6b dist rebuild + T7b test refresh, both folded into existing tasks where natural).

**Why T3 leads with the fixture + RED test:** TDD discipline per CLAUDE.md "no production code without a failing test first." The fixture is hand-constructed (no fixture-gen dependency), so the RED step is self-contained.

**Why T6 (taxonomy + docs cascade) lands after T4/T5:** the code is in the source until T6; T4's removal of the throw site is the behavior change; T6 is the structural-and-narrative cleanup. Separating them isolates the runtime behavior delta from the documentation delta.

**Why T6b (dist rebuild) is its own gate:** the harness in `tools/mainnet-validate/harness/` resolves `@ergots/ergoscript` to the package's `dist/index.js` per `packages/ergoscript/package.json`'s `"main"` field. Without rebuild, T7's Layer 3 smoke would execute the OLD parser — false-positive or false-negative against stale code.

**Why T7 (smoke re-run) is necessary:** the spec's success criterion is "advances past the `sbox-ergo-tree-no-size` halt site." T7 verifies that. Downstream halts are PROBABLE and recorded as new fix-list items for 2j proper, NOT folded back into this spec.

**Why T7b lands after T7:** the new halt site (or scatter pattern) is observed during T7. T7b refreshes the three integration-test snapshots to match. If T7's smoke walk happens to land at the same halt phase but a different errorCode, the test refresh is a one-line change; if halts scatter across multiple blocks, T7b switches to shape-only assertions per Decision 6.

## Risk hotspots

1. **`parseTree(bytes)` behavior change inside the wrapper.** Currently the non-hasSize branch creates a fresh ByteReader (line 146); refactored, it shares the outer reader. Existing tests assert against the public function's output, not internal cursor state — should be functionally equivalent. Mitigation: T4's verification commands include a full re-run of the wire-format test suite (1074 wire tests at last count); any divergence surfaces immediately.

2. **`parseTreeFromReader` cursor-position contract.** Caller depends on the cursor landing exactly at the byte after the body. If the helper inadvertently consumes one extra byte (e.g., a misplaced `readU8`), the SBox parser would interpret SBox-`creation_height` bytes as part of the tree. Mitigation: Layer 1's "ergoTreeBytes captures exactly the tree bytes" test pins this. Sigma-rust's pattern is the authoritative model — body Expr grammar is self-delimiting and well-tested.

3. **Synthetic-fixture validity.** The Layer 1 hand-constructed P2PK bytes must parse cleanly through ALL existing wire-layer machinery (Expr opcode dispatch, SValue parse for any embedded constants, etc.). Mitigation: use a known-good byte sequence (the canonical 36-byte P2PK form, header `0x00` + body `0x08 0xcd <33 bytes>` + value/height/tokens/regs/txid/index suffix). Test 3 specifically asserts the slice boundary.

4. **`sbox-ergo-tree-no-size` removal cascade undercount.** Reviewer-pass surfaced 13 occurrences across 9 files (Decision 3 table); earlier draft named only 3 of them. Mitigation: T6 walks the cascade table item-by-item, then runs a final `grep "sbox-ergo-tree-no-size"` across the entire repo (not just `packages/`) expecting zero hits. The grep-only enforcement is documented in §"Confidence check" per reviewer C2.

5. **Layer 3 smoke is best-effort, not load-bearing.** It may reveal new halts beyond the scope of this spec. That's fine — they go into the fix-list, separate from this spec. The smoke's success criterion is "advances past the `sbox-ergo-tree-no-size` halt site," not "validates the full chain." Reviewer M2 confirmed the prior draft's "ANY block validates fully end-to-end" was overconfident.

6. **Harness integration-test snapshots break post-fix** (reviewer C1). Three tests at `tools/mainnet-validate/harness/test/integration/{halt-path,tip-reach-path,resume-path}.test.ts` pin the current `'sbox-parse-failed'` halt at h=1 / h=999. After T4, the halts vanish or move. Mitigation: T7b runs after T7 observes the new halt site and refreshes the snapshots accordingly (or replaces with shape-only assertions if halts scatter across many blocks).

7. **New circular import** (`ergo-tree.ts ↔ parse-svalue.ts`) introduced by the refactor (reviewer M1). ESM-tolerable for function-body uses; risk is a future top-level access would break. Mitigation: T4's full vitest re-run catches any `ReferenceError` from load-order issues; if surfaced, fall back to inline-duplication (rejected alternative documented in Decision 4).

8. **Stale `dist/index.js`** would cause T7's smoke walk to execute the old parser. Mitigation: explicit T6b rebuild step before T7 (reviewer C3 applied).

## Confidence check (OVERRIDES #2 — crypto/cost path)

**Confidence on fix mechanics: 96%** (reviewer-pass M1+C2 adjusted down from 97%).

- Source-read of `ergo_tree.rs:410-453` and `ergo_box.rs:343-388` directly confirms sigma-rust's hasSize=false flow. Reviewer-pass independent re-read confirmed.
- The body Expr grammar is self-delimiting — well-established invariant across the wire-format slice (255-fixture corpus + 6,221-mutation pass at full coverage; no fixture has ever desynchronized due to body parse cursor drift). Reviewer-pass spot-checked 3 opcode arms (Constant via parse_with_tag, MethodCall, If) and confirmed each reads exactly its grammar's bytes.
- The refactor preserves all existing `parseTree(bytes)` behavior; the new code path is purely additive at the SBox call site.
- The new circular import (`ergo-tree.ts ↔ parse-svalue.ts`) is ESM-tolerable per Decision 4 — both sides use the cross-module values in function bodies only. -1% residual confidence vs. the v1 draft on that account.

**The 4% residual uncertainty:**
- 2% on edge cases in the body Expr grammar at v0 specifically — are there v0-only opcodes whose grammar isn't fully self-delimiting? Mitigation: source-read of `expr.rs::sigma_parse` dispatch table during T4 to confirm no opcode-arm reads beyond its declared byte budget. If any exists, that's a separate (and surprising) finding.
- 1% on the real-mainnet fixture content — the genesis-block first-output may carry unusual register payloads that surface a different bug. Mitigation: if Layer 2 surfaces a new halt, T7 documents it and the spec stays narrow to the `sbox-ergo-tree-no-size` fix.
- 1% on the circular-import behavior under vitest's loader — extremely low risk, but the cycle is new to this code path. T4's full test re-run catches any load-order issue as a `ReferenceError`.

**Confidence on spec-as-delivery-plan: ~92%** (reviewer-pass independent rating was 85% on v1; v2 closes the C1/C3/M3 gaps that drove that number).

**On `SValueParseError.code: string` field (reviewer C2 applied — corrected):** the code field is a plain `string`, NOT a literal union. Removal of `'sbox-ergo-tree-no-size'` is enforced purely by grep, not by TypeScript's exhaustive checking. T6's removal pass relies on the 13-occurrence cascade table in Decision 3 + a final repo-wide `grep "sbox-ergo-tree-no-size"` returning zero hits. Future hardening (promote `code` to a literal union across all error classes) is deferred to a separate phase.

**Escalation status:** none. Not a crypto-path phase; not a cost-path phase. Reviewer's independent confidence on fix mechanics matches mine (~96%). OVERRIDES #2 escalation triggers do not apply.

## Rollback plan

Single-revert per task; each commit independently revertible.

- T3 (RED): revert; production code is unchanged.
- T4 (GREEN): revert; restores the rejection. Layer 1 tests then fail until the spec is re-tried.
- T5: revert; restores pre-fixture state.
- T6: revert; restores the union member declaration (with no throw site, the code becomes dead but compiles). Cosmetic only.
- T7: revert; smoke re-run finding stays in handoff notes if needed.
- T8: revert; docs revert.

If a deep regression surfaces (e.g., T4's refactor breaks an existing fixture), revert T4 + T3 together; the rest stand alone.

## Future work (captured as residual follow-ups)

1. **Cache parsed ErgoTree on the SBox value.** Currently the parsed tree from `parseTreeFromReader` is discarded; the harness re-parses via `parseTree(ergoTreeBytes)` for the round-trip check. A future micro-optimization: store the parsed tree on the SBox SValue alongside the raw bytes; the harness can compare structures directly. Out of scope for this fix; would surface as a separate phase if profiling shows it matters.

2. **MAX_TREE_SIZE enforcement at the SBox-internal call site.** Today the bound is enforced only when `parseTree(bytes)` is the entry point. If `parseSValue(SBox)` is fed adversarial bytes from a hostile peer (not a chain-validated block), an oversized tree-body could consume more memory than necessary. The block-level cap provides a soft bound; a hard per-tree bound at the SBox layer is a defensive add. Out of scope here; would land alongside any future "untrusted input" hardening pass.

## Cross-references

- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/ergo_tree.rs:410-453` — `ErgoTree::sigma_parse` (hasSize branching).
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/chain/ergo_box.rs:343-388` — `parse_box_with_indexed_digests` (calls `ErgoTree::sigma_parse(r)` on shared reader).
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/serialization/sigmaboolean.rs:50` — `ProveDlog::OP_CODE = PROVE_DLOG = 205 (0xcd)` (reviewer Mi3 reference for the synthetic P2PK byte sequence).
- `~/projects/ergots/packages/ergoscript/src/wire/parse-svalue.ts:274-291` — current SBox parse with the rejection.
- `~/projects/ergots/packages/ergoscript/src/wire/ergo-tree.ts:103-192` — current `parseTree(bytes)` with the body-parse logic to be extracted.
- `~/projects/ergots/tools/mainnet-validate/harness/test/integration/halt-path.test.ts:160-162` — halt-snapshot integration test (T7b target).
- `~/projects/ergots/tools/mainnet-validate/harness/test/integration/tip-reach-path.test.ts:185` — halt-snapshot integration test (T7b target).
- `~/projects/ergots/SESSION_CONTEXT.md` — 2j-pre completion record + fix-list reference.
- `docs/specs/2026-05-21-mainnet-validate-harness-design.md` — 2j-pre design (the source of the smoke walk that surfaced this bug).
- `facts/ergoscript-wire.md:176` — current `SValueParseError` taxonomy listing `'sbox-ergo-tree-no-size'` for removal.

## Reviewer findings applied (2026-05-22)

Spec was reviewed by a general-purpose reviewer subagent dispatched with the explicit instruction set: validate sigma-rust precedent claims via independent source-read, validate the body-Expr self-delimiting invariant across 3 spot-check arms, validate serialize-side symmetry, audit the `'sbox-ergo-tree-no-size'` removal cascade across the entire repo (not just src/), verify the synthetic P2PK byte sequence, check for other hasSize=false guards, audit Layer 3 success-criterion realism, verify MAX_TREE_SIZE deferral, and rate confidence honesty. Reviewer returned 3 ★★★ critical findings, 5 ★★ moderate findings, 3 ★ minor findings.

**★★★ Critical findings (all applied inline):**

1. **C1 — harness integration tests will fail post-fix.** 3 tests in `tools/mainnet-validate/harness/test/integration/` snapshot the CURRENT `'sbox-parse-failed'` halt (the harness's wrapped form of `SValueParseError('sbox-ergo-tree-no-size')`). After T4, the halt vanishes or moves. **Applied:** new T7b in execution order refreshes those snapshots after T7 reveals the new halt site. Decision 6 documents the refresh contract.

2. **C2 — `SValueParseError.code: string` is not a literal union; "compile-time enforcement" claim was wrong.** Removal is grep-driven only. **Applied:** Confidence check section corrected — removal enforcement is the 13-occurrence cascade table in Decision 3 plus a final repo-wide grep.

3. **C3 — dist rebuild + `npm test` + `npx tsc --noEmit` missing from execution order.** OVERRIDES rule #6 violation by omission. **Applied:** verification commands added under T4/T5; new T6b adds `npm run build` before T7's smoke walk.

**★★ Moderate findings (folded inline):**

1. **M1 — circular import** between `ergo-tree.ts` and `parse-svalue.ts`. ESM-tolerable for function-body uses; flagged. **Applied:** Decision 4 documents the trade-off + mitigation (T4 verifies via full vitest run). Confidence reduced 97% → 96% to reflect the new structural risk.

2. **M2 — Layer 3 success criterion overconfident.** "ANY block validates fully end-to-end" assumes evaluator + sig paths handle real mainnet boxes cleanly; per `tools/mainnet-validate/README.md:173-174`, this has never been demonstrated. **Applied:** Layer 3 success criterion tightened to "advances PAST the `sbox-ergo-tree-no-size` halt site." Downstream halts are PROBABLE and recorded as new fix-list items.

3. **M3 — `'sbox-ergo-tree-no-size'` removal cascade undercounted.** Reviewer-pass grep found 13 occurrences across 9 files (spec v1 named only 3). **Applied:** Decision 3 now contains the full cascade table.

4. **M4 — `facts/ergoscript-wire.md:176-177` was wrong.** Single line, not two. **Applied:** Decision 7 (formerly 4) corrected.

5. **M5 — synthetic `0x10` (segregation=true) case undecided.** **Applied:** dropped from Layer 1; deferred to Layer 2 mainnet capture.

**★ Minor findings (acknowledged, no spec change):**

1. **Mi1 — `creation_height` is VLQ via sigma-rust's `put_u32` (which is VLQ internally).** No action; existing TS comment is correct.

2. **Mi2 — MAX_TREE_SIZE deferral is consistent with sigma-rust** (which also doesn't cap per-tree inside box parse). No action.

3. **Mi3 — `0xcd` is sigma-boolean leaf `PROVE_DLOG` opcode (not `CreateProveDlog` Expr opcode).** Spec correctly uses inline-Const path. Cross-reference added to §"Cross-references" for clarity.

Net effect: confidence on fix mechanics 97% → 96% (M1's new cycle); confidence on spec-as-delivery-plan 85% → 92% (C1/C3/M3 gaps closed); recommendation lifted from REVISE → SHIP.
