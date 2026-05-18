# Task B — Wider Mainnet Corpus + Method-Demand Survey Design Spec

**Status:** Draft
**Date:** 2026-05-18
**Package:** `@mwaddip/ergots-ergoscript` (Task B — pre-phase-2g.6 corpus widening + method-demand survey)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella; this Task B is the pre-2g.6 data-driven scoping work mandated by the goal-expansion captured in the 2026-05-17 umbrella spec edits — Task A)
**Sister specs:**
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` (immediate predecessor — method-call dispatcher + 3 corpus-unlocker handlers; established the data-driven scoping discipline that motivates Task B at a wider scale)
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec — Task A widened it to validating-node-complete; Task B feeds the data into the new 2g.6 row and the "Mainnet blocks (validated against sigma-rust)" corpus row added in that edit pass)

**Interface contract:** `facts/ergoscript.md` (Task B introduces no public-API changes — it produces a corpus fixture and survey-results artifacts only; the `facts/` document is unchanged by this slice)

**Brainstorm transcript:** session 2026-05-18 (this design; builds on the 2026-05-17 goal-expansion conversation captured in the now-shipped Task A umbrella spec edits)

## Goal

Produce two artifacts that scope phase 2g.6 (and the subsequent phases 2h/2i) with empirical, data-driven priority information:

1. **A wider mainnet corpus fixture** — `packages/ergoscript/test/fixtures/mainnet_boxes_wider.json` — combining a 10,000-box random sample from recent mainnet (~5 months) with a curated must-include set of ~150-400 boxes derived from known sigma-rust regression blocks (PRs #854/857/859/860).
2. **A method-demand survey deliverable** — markdown report + machine-readable JSON tally — that tallies `Expr.tag` and `(typeId, methodId)` frequencies across the corpus, with source-segmented breakdown (random vs must-include), and emits a prioritized phase-2g.6 method-implementation list.

Together these answer: "across actual mainnet activity (current circulation + known-regression edge cases), which method-call handlers does phase 2g.6 need to land?" The 2g.5 brainstorm measured 3 method pairs from 173 boxes; Task B's wider sample is the discipline applied at scale. The handoff projection of 2g.6 ("Header methods, Coll utilities, Bit shifts via `SNumericTypeMethods`") was speculative; Task B replaces speculation with measurement.

Public function signatures are unchanged. `facts/ergoscript.md` is unchanged. No `@mwaddip/ergots-ergoscript` source code is modified — Task B touches only `fixture-gen/`, `packages/ergoscript/test/fixtures/`, `packages/ergoscript/scripts/`, and `docs/specs/`.

## Background — why Task B precedes phase 2g.6

The umbrella spec was edited on 2026-05-18 (Task A) to widen the library's ultimate target from "Fleet SDK WASM replacement" to "complete sigma-rust port serving as the verification kernel of a validating node." This widening converted four previously-optional phases (2g.6, 2h, 2i, 2j) into mandatory, and made byte-exact cost agreement with sigma-rust (phase 2j) consensus-critical (a 1-unit cost drift is a hard fork).

Three implications follow:

1. **Nothing is optional.** Phase 2g.6 (broader method surface), 2h (AVL+), 2i (predefs), 2j (cost validation) are all required for validating-node-class completeness.
2. **The 173-box C2 corpus is too narrow** to drive scope decisions at this widened ambition. A method that appears in 0 of 173 corpus boxes but in 5% of mainnet activity is still required for validating-node-complete.
3. **Cost validation is load-bearing for consensus.** Phase 2j's success criterion must be "match on every block in the validation corpus (or a strong sample thereof)," not "match on the current corpus." Task B's must-include set is also the seed for that future validation corpus.

Task B's survey produces the empirical evidence base for 2g.6 (and surfaces gaps for 2h/2i). The phase-2j validation corpus is a separate later task; Task B's must-include set is its prototype.

## Non-goals

- **Block-level evaluation against sigma-rust's eval oracle.** Task B parses every corpus box and walks its AST; it does NOT evaluate. Evaluation requires per-box context synthesis (à la `corpus-eval.test.ts` for the existing 173-box corpus) and is meaningfully larger surface area. Task B's question is "what arms / methods does mainnet use?" not "do we evaluate them correctly?" — the latter is phase-2j-prep territory.
- **Cost-equivalence assertions.** No cost values are read or compared in Task B. The `tx_costs_700000_700050.json` cost vectors from sigma-rust will be carried through as fixture metadata for future phase 2j use, but no cost assertions run in Task B.
- **Signature verification.** Out of scope; verification is exercised by the existing GF(2^192) and 374-entry V1+V2 verifier fixtures, not by mainnet boxes.
- **Wider corpus replacing the existing 173-box `mainnet_boxes.json`.** The existing C2 corpus stays as the regression signal (`expect(evalSuccess).toBe(18)`); the wider corpus is a parallel artifact. A future v1.0.0 milestone may consolidate them once all boxes evaluate correctly.
- **Phase 2g.6 implementation.** Task B produces the scoping data; phase 2g.6 implementation is a separate slice with its own design spec (created after Task B ships).
- **AVL+ corpus seeding.** Phase 2h's AVL+ verifier will need membership-proof fixtures, not just ergoTree bytes. Out of scope for Task B.
- **Re-fetching the 700,000-700,050 vectors.** These are *imported* from sigma-rust's existing test-vectors directory (the canonical Scala-computed reference), not re-fetched. Re-fetching would diverge from the consensus oracle.
- **Layer C3.a mutation testing** on the wider corpus. C3.a is operator-driven and Coll-HOF-oriented; the wider corpus is for AST-walk analysis, not mutation testing.
- **Behavioral changes** to the existing C2 corpus eval test. `corpus-eval.test.ts` continues to exercise the 173-box corpus with `success=18` regression gate. Task B doesn't touch it.

## Architecture

### Repository layout

```
ergots/
├── fixture-gen/
│   └── src/cmds/
│       └── wider_corpus.rs                      NEW: Rust fetch logic + must-include import
├── packages/ergoscript/
│   ├── scripts/
│   │   └── analyze-wider-corpus.ts              NEW: TS iterative AST walker + tally
│   └── test/fixtures/
│       ├── mainnet_boxes.json                   UNCHANGED (existing 173-box C2 corpus)
│       └── mainnet_boxes_wider.json             NEW: ~10,200 boxes (random + must-include)
└── docs/specs/
    ├── 2026-05-18-task-b-corpus-widening-design.md          THIS SPEC
    ├── 2026-05-18-task-b-corpus-survey-results.md           NEW: markdown deliverable (Task 5)
    └── 2026-05-18-task-b-corpus-survey-tally.json           NEW: machine-readable tally (Task 5)
```

### Corpus shape

Top-level structure:

```json
{
  "meta": {
    "generatedAt": "2026-05-18T...",
    "nodeVersion": "0.5.0-or-equivalent",
    "randomWindow": {
      "startHeight": N,
      "endHeight": M,
      "seed": "0x..."
    },
    "mustIncludeSingletonBlocks": [342964, 670557, 680692, 942664, 1711120],
    "mustIncludeRange": { "from": 700000, "to": 700050 }
  },
  "boxes": [
    {
      "boxId": "...",
      "ergoTreeBytes": "0008cd...",
      "blockHeight": 1500000,
      "txId": "...",
      "outputIndex": 0,
      "source": "random"
    },
    {
      "boxId": "...",
      "ergoTreeBytes": "...",
      "blockHeight": 1711120,
      "txId": "...",
      "outputIndex": 1,
      "source": "must-include:pr860-block-1711120-tx1"
    }
  ]
}
```

Per-box fields:
- `boxId` — 32-byte hex; primary identifier; deduplication key.
- `ergoTreeBytes` — hex-encoded ErgoTree bytes; the survey input.
- `blockHeight` — height of the block containing the source transaction. Carried for future phase 2j use (the validation corpus prototype).
- `txId` — 32-byte hex; the transaction that created this output box. Same rationale.
- `outputIndex` — 0-based index within the transaction's outputs.
- `source` — string tag identifying provenance. Values: `'random'` or `'must-include:<descriptor>'`. The descriptor names the regression context (e.g., `'must-include:pr860-block-1711120-tx1'` for the SOption-leniency regression, `'must-include:pr854-tx-cost-parity:700017:518acec'` for a specific cost-parity tx).

Estimated total size: ~20-30 MB committed JSON. Acceptable; same order of magnitude as the existing fixture set.

### Sampling — random recent-window layer

Layer 3a per the brainstorm: a deterministic random sample from a recent mainnet window.

- **Window:** `[chain_tip - 100000, chain_tip]` at generation time, recorded as absolute heights in the fixture's `meta.randomWindow`. Approximately 5 months of mainnet activity (Ergo block time ~2 minutes; 100,000 blocks ≈ 138 days).
- **Pool construction:** for every height in the window, fetch the block via `http://127.0.0.1:9052/blocks/{height}`, iterate the block's transactions, collect every output box as a candidate. Total pool is on the order of 10^5 to 10^6 boxes (Ergo blocks have ~10-30 transactions, each with ~1-5 outputs).
- **Sampling:** deterministic PRNG seeded by the chain-tip block id at generation time, used to select 10,000 boxes from the pool without replacement. The seed is recorded in `meta.randomWindow.seed`.
- **Reproducibility:** the fixture is byte-identical across re-runs given the same node state, same height window, same seed. The recorded absolute heights make the window stable; the recorded seed makes the selection stable. The node's UTXO+history state is the only varying input; on the user's mainnet-synced full node, that state is consensus-determined.

Rationale for "recent only": Task B's goal is to scope phase 2g.6 (method demand) and surface unimplemented arms for 2h/2i. Currently-circulating contracts dominate that question. A height-stratified sample (e.g., 3 bands across all-time) would add complexity for marginal signal — historical contracts are usually long-lived and re-appear in the recent window; truly defunct contracts are out-of-scope for the validating-node-complete v1.0.0 (which validates future blocks, not historical ones beyond what the chain itself preserves).

### Sampling — must-include layer

Layer 3b per the brainstorm: a curated set derived from known sigma-rust regression blocks. Each entry is grounded in a specific commit, PR, or memory record.

| # | Block height(s) | Regression | Source |
|---|---|---|---|
| 1 | **342,964** | `selfBoxIndex` returning real input index instead of -1 for pre-v2 ErgoTree (JVM bug #603) | sigma-rust PR #859 / commits `2de209be`, `5b7ad2d1` |
| 2 | **670,557** | `BigInt256` modulo using Rust remainder (can be negative) instead of java `BigInteger.mod()` | sigma-rust PR #857 / commit `c91235e4` |
| 3 | **680,692** | `BoolToSigmaProp` rejecting SigmaProp input on pre-v2 trees; mainnet tx `5fe235558…` carries `sigmaProp(sigmaProp(true))` | consolidated into sigma-rust PR #859 leniency wave |
| 4 | **700,000-700,050** (50 blocks, 78 txs) | JIT cost parity reference; includes tx `518acec…@700,032` (ADD_TO_ENV_COST short-count), ConstantPlaceholder JitCost-5-vs-1, P2PK trivial-reduce, and several other cost-parity fixes | sigma-rust PR #854 / `tx_costs_700000_700050.json` + `transactions_700000_700050.json` + `headers_700000_700060.json` |
| 5 | **942,664** | `selfBoxIndex` gating regression — gate on `tree_version` vs `activated_script_version` (post-v5 block with V0 script returning -1 incorrectly) | sigma-rust PR #859 / commit `2de209be` |
| 6 | **1,711,120 (tx[1])** | `SOption(T)` accepted where `T` expected during parse | sigma-rust PR #860 / commits `506a3ce3`, `df8cc145` |

**Not in the must-include set** (and the reason):
- ergo_avltree_rust commit `69765ef` (`contains` LabelOnly fix) — persistence-state class issue, not a tree-evaluation regression. Phase-2h-relevant, not Task B.
- The `xorOf` bug — audit-discovered with no specific block.
- sigma-rust nipopow PRs (#851, #852, #855) — proof construction/parsing; out of scope.
- ErgoTreePredef (#848), parameter variants (#850), `gen_indexes` panic (#847) — not block-specific.

**Extraction strategy:**
- The **700,000-700,050 range** is imported directly from `~/projects/sigma-rust/sigma-rust/ergo-lib/tests/test-vectors/transactions_700000_700050.json`. No re-fetch. The file IS the canonical Scala-computed reference; copying preserves the consensus oracle for future phase 2j use. Filesystem access is straightforward in the Rust fixture-gen.
- The **5 singleton blocks** are fetched via `/blocks/{height}` from the local `ergo-node-rust:9052` node and every output box from every transaction in each block is collected.
- Each must-include box carries a descriptive `source` tag identifying the regression context (e.g., `'must-include:pr860-block-1711120-tx1'`). Within the 700k range, transactions known to expose specific regressions (e.g., `518acec…@700,032` for ADD_TO_ENV_COST) get additional source-tag granularity (e.g., `'must-include:pr854-tx-cost-parity:700032:518acec'`).

Total must-include count: ~150-400 boxes (5 singleton blocks × ~10-30 boxes each + 50-block range × ~5-10 boxes per block).

### Tooling — Rust fixture generator

New command `wider_corpus` in `fixture-gen/src/cmds/wider_corpus.rs`. Responsibilities:

1. Connect to the local Ergo node at `http://127.0.0.1:9052` and query `/info` for chain tip height.
2. For the random-sample layer: iterate `[chain_tip - 100000, chain_tip]`, fetch each block via `/blocks/{height}`, deserialize its transactions, collect every output box (including `box_id`, `ergoTreeBytes`, `blockHeight`, `txId`, `outputIndex`) into a pool.
3. Seed a deterministic PRNG (e.g., `rand::rngs::StdRng::from_seed`) with the chain-tip block id's bytes. Random-sample 10,000 boxes from the pool. Record seed (hex) in `meta.randomWindow.seed`.
4. For each must-include singleton block (342964, 670557, 680692, 942664, 1711120): fetch the block, extract all output boxes, tag with the appropriate `source` descriptor.
5. For the must-include 700k range: read `~/projects/sigma-rust/sigma-rust/ergo-lib/tests/test-vectors/transactions_700000_700050.json` from disk, iterate its transactions, extract every output box, tag with `'must-include:pr854-tx-cost-parity:<height>:<txid_prefix>'` source descriptors. (Within-range tx-specific regressions like `518acec…@700,032` get tighter descriptors via a lookup table embedded in the command.)
6. Concatenate all boxes (random sample + must-include) with metadata header, write to `packages/ergoscript/test/fixtures/mainnet_boxes_wider.json`.

Rust binary location: `cargo run -p fixture-gen -- wider_corpus`. Two-run determinism check applies (`cargo run` twice, diff should be empty if node state is unchanged).

### Tooling — TypeScript analyzer

New script `packages/ergoscript/scripts/analyze-wider-corpus.ts`. Standalone — invoked via `tsx packages/ergoscript/scripts/analyze-wider-corpus.ts` (or an npm script like `npm run analyze-wider-corpus`). Not a vitest test; analysis is reporting, not assertion.

Algorithm:

1. Load `mainnet_boxes_wider.json`.
2. For each box: attempt `parseTree(hexToBytes(box.ergoTreeBytes))`. On any typed parse error, record `{ boxId, errorCode, source }` in a `parseFailures` array and continue.
3. For each successfully parsed `ErgoTree`, walk `tree.body` recursively-via-worklist (iterative; not recursive — defensive against pathological lambda nesting depth). For every `Expr` node visited:
   - Increment the `Expr.tag` frequency map.
   - If the node is `MethodCall` or `PropertyCall`, record `(typeId, methodId)` into the method-pair map, including the corresponding sigma-rust method name via a lookup table (`KNOWN_METHODS` constant, sourced from sigma-rust's method registry).
   - If the tag is in the current `'not-implemented-yet'` set (after phase 2g.5, the ~19 still-deferred arms), record it in the `unimplementedHits` map alongside the current `box.boxId`.
4. All frequency maps are dual: `totalAppearances` (every visit counts) and `distinctBoxes` (each box contributes at most 1). All maps are also source-segmented (`random` vs `mustInclude` sub-tallies).
5. After walking every box, derive the phase-2g.6 prioritization: for each method pair in the method-pair map that is NOT marked implemented (i.e., not registered in our current `eval/method-call.ts` `HANDLERS` map), rank by `distinctBoxes` count, with `mustInclude` count as the tiebreaker. Output top N (or all, depending on tail length).
6. Write two artifacts:
   - `docs/specs/2026-05-18-task-b-corpus-survey-tally.json` — full machine-readable tally including all maps, parse failures, derived prioritization.
   - `docs/specs/2026-05-18-task-b-corpus-survey-results.md` — human-readable summary with tables.

**Iterative walker:** explicit worklist (a `Expr[]` stack), no recursion. Pseudocode:

```ts
function walk(root: Expr, visit: (e: Expr) => void): void {
  const stack: Expr[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    visit(node)
    for (const child of childrenOf(node)) {
      stack.push(child)
    }
  }
}
```

`childrenOf(node)` is a per-tag function returning every nested `Expr` field — `If.condition`, `If.trueBranch`, `If.falseBranch`, `BlockValue.items`, `BlockValue.result`, `FuncValue.body`, `MethodCall.obj`, `MethodCall.args`, `Apply.func`, `Apply.args`, every `BinOp.left`/`right`, `Collection.items` (when `kind === 'Exprs'`), every Coll-HOF lambda parts, etc. Constants and ConstantPlaceholders have no nested expressions and contribute only their own tag.

## Output deliverables

### `mainnet_boxes_wider.json`

Top-level shape per "Corpus shape" above. Committed under `packages/ergoscript/test/fixtures/`.

### `docs/specs/2026-05-18-task-b-corpus-survey-results.md`

Structure:

```markdown
# Task B — Wider Mainnet Corpus Survey Results

**Generated:** YYYY-MM-DD
**Source fixture:** packages/ergoscript/test/fixtures/mainnet_boxes_wider.json
**Total boxes analyzed:** 10,XXX (random=10,000, mustInclude=XXX)
**Parse failures:** N (rate: X%)

## Top-level Expr tag frequencies

| Tag | Total nodes | Distinct boxes | Random | Must-include |
|---|---|---|---|---|
| GlobalVars | N | N | N | N |
| BinOp | N | N | N | N |
| ... | | | | |

## Method-call (typeId, methodId) pair frequencies

| typeId | methodId | Sigma-rust name | Total nodes | Distinct boxes | Random | Must-include | Implemented? |
|---|---|---|---|---|---|---|---|
| 99 | 8 | SBox.tokens | N | N | N | N | ✅ 2g.5 |
| 12 | 26 | SColl.indexOf | N | N | N | N | ✅ 2g.5 |
| 101 | 1 | SContext.dataInputs | N | N | N | N | ✅ 2g.5 |
| ... | | | | | | | |

## Currently-unimplemented arms hit (priority signal for 2h / 2i)

| Tag | Distinct boxes | Example boxIds |
|---|---|---|
| ... | | |

## Parse failures

| Error class.code | Count | Example boxIds |
|---|---|---|
| ... | | |

## Phase 2g.6 prioritization

Methods recommended for phase 2g.6 implementation, ranked by `distinctBoxes`:

1. **(typeId, methodId) `SXxx.method`** — N distinct boxes (random=N, mustInclude=N) [sigma-rust source: `xxx.rs:Y-Z`]
2. ...
```

### `docs/specs/2026-05-18-task-b-corpus-survey-tally.json`

Machine-readable mirror of the markdown. Schema:

```json
{
  "meta": {
    "generatedAt": "2026-05-18T...",
    "fixtureSource": "packages/ergoscript/test/fixtures/mainnet_boxes_wider.json",
    "totalBoxes": 10XXX,
    "randomBoxes": 10000,
    "mustIncludeBoxes": XXX,
    "parseFailureRate": 0.XX
  },
  "tagFrequencies": [
    { "tag": "GlobalVars", "totalAppearances": N, "distinctBoxes": N,
      "random": N, "mustInclude": N }
  ],
  "methodPairs": [
    { "typeId": 99, "methodId": 8, "methodName": "SBox.tokens",
      "totalAppearances": N, "distinctBoxes": N,
      "random": N, "mustInclude": N,
      "implemented": true, "implementedIn": "2g.5" }
  ],
  "unimplementedHits": [
    { "tag": "...", "distinctBoxes": N, "exampleBoxIds": [...] }
  ],
  "parseFailures": [
    { "boxId": "...", "errorCode": "...", "source": "..." }
  ],
  "phase2g6Priority": [
    { "rank": 1, "typeId": N, "methodId": N, "methodName": "...",
      "distinctBoxes": N, "random": N, "mustInclude": N,
      "sigmaRustSource": "xxx.rs:Y-Z" }
  ]
}
```

## Implementation tasks (flat, 8 tasks, per-task commits)

Each task is a complete unit of work landing on master via its own commit (per `feedback_no_artificial_stops`). No artificial `Stop` markers between tasks.

1. **Rust `fixture-gen/src/cmds/wider_corpus.rs`.** Implement node-side fetch (random sample + 5 must-include singletons), 700k-range filesystem import, deterministic PRNG sampling, output JSON shape per the spec. Two-run determinism cross-check at end (build, run, diff against re-run; should be byte-identical given stable node state).
2. **Generate the wider corpus fixture.** Run `cargo run -p fixture-gen -- wider_corpus`, commit `packages/ergoscript/test/fixtures/mainnet_boxes_wider.json`. Audit commit size; if approaching limits, document.
3. **TS analyzer `packages/ergoscript/scripts/analyze-wider-corpus.ts`.** Implement the iterative AST walker, four tallies, source segmentation, sigma-rust method-name lookup table, parse-failure tolerance. Output the two deliverable artifacts (markdown + JSON).
4. **Cross-check: re-run analyzer on existing `mainnet_boxes.json`.** The expected output is the 2g.5 measurement reproduced byte-for-byte: `SBox.tokens` 43, `SContext.dataInputs` 15, `SColl.indexOf` 6, top-level tag distribution as in the 2g.5 design spec's "Background — measured corpus demand" section. RED if mismatch; investigate the walker.
5. **Run analyzer on wider corpus.** Generate `docs/specs/2026-05-18-task-b-corpus-survey-results.md` + `docs/specs/2026-05-18-task-b-corpus-survey-tally.json`. Commit both.
6. **Author phase 2g.6 prioritization conclusions** in the markdown results doc — the "phase 2g.6 prioritization" section ranks methods by `distinctBoxes` with `mustInclude` as tiebreaker. Include suggested groupings (e.g., "Header methods", "Coll utilities", "Bit shifts") for the future 2g.6 design spec to consume directly.
7. **Update `SESSION_CONTEXT.md` and `MEMORY.md`** to reflect Task B complete + 2g.6 scope locked (specific method list with distinct-box-count justification). Memory record `project_ergots_direction.md` gets a hook-line update.
8. **Final regression sweep.** Confirm the existing C2 corpus still passes 18/18 (Task B shouldn't have touched any production source); full TS test suite under node + jsdom; `cargo test` in fixture-gen still passes; `cargo run -p fixture-gen` is still deterministic for all existing fixtures.

**Estimated total:** 1-3 days. Mostly Sonnet-suitable. Tasks 1 (Rust fetch + sigma-rust JSON import) and 3 (iterative AST walker + source-segmented tallies) are the heaviest; Opus may help on Task 3 if the walker hits edge cases with newer `Expr` variants.

## Validation strategy

### Layer C1 — analyzer self-validation

Three cross-checks before publishing any conclusions:

1. **Backward-compatibility sanity check (Task 4).** Re-run the analyzer against the existing 173-box `mainnet_boxes.json`. Must reproduce the 2g.5 measurement exactly:
   - `SBox.tokens` (99, 8) — 43 total appearances
   - `SContext.dataInputs` (101, 1) — 15 total appearances
   - `SColl.indexOf` (12, 26) — 6 total appearances
   - Top-level tag distribution: `PropertyCall` 58, `GlobalVars` 142, `Context` 15, `MethodCall` 6, `SigmaPropBytes` 2 (per the 2g.5 design spec)

   Any deviation is an analyzer bug. Fix and re-run before proceeding.

2. **Method-name lookup completeness.** For every `(typeId, methodId)` pair surfaced by the analyzer, confirm it resolves to a sigma-rust method via the lookup table embedded in the analyzer. Unresolvable pairs are either (a) lookup-table gaps (file a follow-up to widen `KNOWN_METHODS`) or (b) wire-layer bugs (typeId/methodId combinations that shouldn't exist on mainnet). Both are output as a "lookup gaps" section in the results markdown.

3. **Manual spot-check.** Pick 5 random boxes from the wider corpus. For each, parse manually via a one-shot inline tsx invocation, eyeball the resulting `Expr` tree against the analyzer's per-box contribution to the tally. Five samples is enough to catch off-by-one or recursion-skip errors in the walker. Recorded in the results markdown's "validation methodology" section.

### Layer C2 — corpus eval

Out of scope. The existing C2 corpus on `mainnet_boxes.json` continues to be the eval-correctness signal at `success=18/18`. The wider corpus is *not* exercised via eval (no synthesized contexts; out of scope per Non-goals).

### Cross-runtime testing

The analyzer script runs under tsx in node only. The `Expr` parser and walker primitives are browser-clean (they're the existing wire/mir code already covered by node + jsdom vitest matrix); the analyzer's filesystem I/O is node-specific (file reads), which is appropriate for a tooling script.

### Fixture-gen determinism

Two-run determinism check (Task 1 close): build, run, diff against re-run. Expected zero byte differences given stable node state. If the node state has advanced (chain tip moved), the random-sample heights will differ; document the snapshot height range in the commit message and treat the fixture as a point-in-time deliverable. (Future re-runs will produce different but equally-valid corpora; the original fixture stays committed for reproducibility of Task B's specific conclusions.)

## Risks and open questions

### Sample distribution skew

Recent 100,000-block window may be skewed by transient activity bursts (e.g., a single popular DEX dominating boxes during the snapshot period). Mitigation: source-segmented tallies separate `random` from `mustInclude`; the markdown results explicitly note any tag/method appearing in fewer than 50 distinct boxes (long-tail signal). If the 2g.6 prioritization is dominated by a single contract family, consider re-sampling with a wider window (e.g., 200,000 blocks) before committing 2g.6's scope.

### `KNOWN_METHODS` lookup table accuracy

The TS-side mapping from `(typeId, methodId)` to sigma-rust method name (e.g., `(99, 8)` → `'SBox.tokens'`) is hand-curated from `sigma-rust/ergotree-ir/src/types/`. Errors here surface as "Method-name lookup completeness" gaps in Validation Layer C1; the gaps are non-blocking (the tally is still correct, just less human-readable). Future work: derive the lookup table programmatically from sigma-rust source.

### Parse failure handling

A high parse-failure rate in the wider corpus would indicate either (a) our parser is missing real-world wire-format cases, or (b) the corpus contains malformed boxes. Mitigation: the analyzer's `parseFailures` section explicitly enumerates rates and error codes. If rate exceeds, say, 1%, flag for investigation before drawing 2g.6 scope conclusions from the survey.

### 700k-range tx-id source-tag granularity

The cost-parity vectors include 78 transactions across 50 blocks, but the regression set documented in PR #854 update notes calls out specific transactions (e.g., `518acec…@700,032` for ADD_TO_ENV_COST). The fixture-gen command embeds a lookup table mapping tx_id-prefixes to regression descriptors for the most-load-bearing of these. Transactions in the 700k range not in this lookup get a generic `'must-include:pr854-tx-cost-parity:<height>'` tag.

### Avltree LabelOnly fix (not in must-include set)

The ergo_avltree_rust commit `69765ef` (LabelOnly persistence-state issue) is real, regression-class, and the user explicitly mentioned it. The reason it does NOT enter the Task B must-include set: it is not a tree-evaluation regression — it is a persistence-layer consistency issue at the AVL+ storage tier. Phase 2h will need its own AVL+ corpus (membership-proof fixtures), separately designed. Task B's scope (ergoTree method-demand analysis) is the wrong lens for that fix. Captured here so the omission isn't lost.

### Future Task B follow-ups

After Task B ships, the natural follow-ups are:

- **Phase 2g.6 design spec** consumes the prioritization deliverable. Each method on the recommended list gets a per-method micro-task: source-read sigma-rust handler → write fixture → write TS handler → cost cross-validate.
- **`@mwaddip/ergots-ergoscript@0.3.0` npm publish** is a natural milestone before or after Task B; user's call on timing.
- **AVL+ membership-proof corpus** for phase 2h — separate task, separate fixture shape (requires AVL+ digests, sibling paths, etc. — not ergoTree bytes).
- **Block-level validation corpus** for phase 2j — extends Task B's must-include set with full eval contexts (block context per tx, dataInputs, post-state digests) and sigma-rust cost oracle per tree. Task B's `transactions_700000_700050.json` import is the seed.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec (post-Task-A edits reflect goal expansion; Task B feeds the 2g.6 row and the "Mainnet blocks" validation corpus row)
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` — immediate predecessor; established the data-driven scoping discipline applied at scale here
- `facts/ergoscript.md` — unchanged by Task B
- `~/projects/sigma-rust/sigma-rust/ergo-lib/tests/test-vectors/transactions_700000_700050.json` — 78-tx cost-parity vectors (consumed by Task 1's import path)
- `~/projects/sigma-rust/sigma-rust/ergo-lib/tests/test-vectors/tx_costs_700000_700050.json` — Scala-computed block costs (carried through as metadata for future phase 2j)
- `~/projects/sigma-rust/sigma-rust/ergo-lib/tests/test-vectors/headers_700000_700060.json` — block headers (carried through for future phase 2j context construction)
- sigma-rust commits `2de209be`, `5b7ad2d1`, `c91235e4`, `506a3ce3`, `df8cc145` (regression fixes whose blocks enter the must-include set)
- sigma-rust open PRs #854, #857, #859, #860 (the user's mainnet-validation-derived PRs that name the must-include blocks)
- Memory `project_block342964_validation.md`, `project_block942664_validation.md` — provenance for must-include blocks 342,964 and 942,664
- Memory `rust_full_node_mainnet.md`, `empirical_validation.md` — the mainnet-sync-as-differential-test framing
- Memory `feedback_no_artificial_stops` — flat task list discipline for Task B's 8 tasks
- Memory `feedback_question_framing_first` + `feedback_wire_format_first_scoping` — data-driven scoping discipline applied here
- Memory `reference_source_first_discipline` — source-read sigma-rust handlers before implementing the methods 2g.6 will need (applied at 2g.6 time, not Task B time, but informs the prioritization output's "sigma-rust source" annotations)
