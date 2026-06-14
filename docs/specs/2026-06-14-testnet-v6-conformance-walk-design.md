# Testnet v6 Conformance Walk — JVM oracle, golden harvest into SANTA

**Date:** 2026-06-14
**Status:** design — approved shape (brainstorm); pending spec review → writing-plans
**Branch:** a fresh feature branch at implementation time (off the v6 delivery once PR #1 lands)
**Scope owner:** `@ergots/ergoscript` harness (`tools/mainnet-validate/`) — the ergots side. The
JVM-oracle service + the full-context vector envelope are a **coordinated `santa/jvm-blesser`
deliverable** (described here as the shared contract; routed to SANTA, not built in this repo).

---

## 1. Goal

Validate ergots' v6 (ErgoTree V3) evaluator + JIT cost model against **real on-chain v6 trees**,
using the **JVM `sigma-state` reference as the oracle**, and harvest every result into SANTA's
canonical conformance corpus.

Two facts drive both halves:

- **Mainnet doesn't contain what we built.** The v6 surface shipped in PR #1 was validated only
  against hand-authored / JVM-blessed conformance vectors. Mainnet is effectively all v5, so the
  T7 walker campaign never exercised v6 against real trees. **Testnet activates forks first**, so it
  is where live v6 traffic exists.
- **The reference implementation should be the oracle.** The v5 mainnet walk used sigma-rust (WASM)
  as the oracle; every mismatch was a two-way triage — *is ergots wrong, or did sigma-rust diverge
  from the JVM?* — and several resolved as sigma-rust production bugs ergots never shared. Pointing
  the oracle at the JVM collapses that: the JVM **is** consensus, so a mismatch is, by definition,
  an ergots bug. It is also consistent with the JVM-canonical shift already made for the F-series
  conformance run. (For v6 specifically the JVM oracle is not merely *better* but closer to
  *necessary*: the WASM oracle is built from the vendored sigma-rust, which may not reliably cost v6.)

This is the **mainnet T7 walker loop re-pointed at testnet v6 with the JVM oracle** — not a new
validation paradigm. The autonomy model, checkpointing, and fix-and-continue rhythm are inherited.

**This walker replaces the old one completely.** It is **chain-agnostic** (mainnet + testnet,
selected by the existing `network` field) and **JVM-oracle-based for both chains** — so it
supersedes the old `mainnet-validate` walker and its sigma-rust WASM oracle entirely, not just for
v6. Mainnet validation moves onto the JVM oracle too (one walker, one oracle, both chains). The
"v6 / tree version ≥ 3" filter is a **campaign parameter**, not a property of the walker: a testnet
campaign filters to v6 (the new surface); a mainnet campaign validates whatever tree versions the
chain carries (a JVM-oracle re-validation of the surface the old WASM walker covered, plus goldens).
The first campaign is testnet v6 (this spec's worked example); a full mainnet re-walk is a later
campaign on the same machinery (latency caveat in §12).

## 2. Non-goals / scope boundaries

- **The ergoscript library is complete as scoped.** This walk does not aim to *grow* the implemented
  surface. Work that surfaces as `not-implemented` belongs to the transaction tier or elsewhere
  outside these libraries (see §5.2) — it is recorded, not fixed, by this walk.
- **No transaction-tier validation.** The walk validates per-input script eval + cost, not
  transaction-level consensus (fees, size, tx structure). Those are a future package.
- **No prover, no compiler** — unchanged from the library's standing scope.
- **The SANTA-side build (jvm-blesser live service + full-context envelope) is not done in this
  repo.** It is specified here as the shared contract and routed to SANTA.

## 3. The model — one integrated walk, three outcome classes

A single walk over testnet's v6 range. For each input script (v6 / ErgoTree version ≥ 3), the walker
reconstructs the input's **real context** and evaluates the tree through ergots, comparing against
the JVM oracle. Each tree falls into exactly one class:

1. **not-impl (expected — not a gap).** ergots cleanly reports it cannot evaluate the tree
   (`'not-implemented-yet'` / `'method-not-implemented'` / a reserved opcode). These are the
   out-of-scope / transaction-tier / deferred-residual cases — the same ones that intentionally grade
   `not-implemented` in SANTA. **The walk does not halt.** It records the unique feature in a deduped
   **not-impl ledger** (enough to bless it later without a second walk — see §5.2) and continues. A
   byproduct list, never a worklist.

2. **implemented-but-diverges (a real bug).** An arm ergots *does* implement returns a value or cost
   that disagrees with the JVM oracle. The walk **stops**, the divergence is **fixed TDD-style**
   (captured as a committed regression golden first — §6), then the walk **continues**. Autonomy
   governs whether the fix is applied without user input (§7).

3. **match (the common case).** ergots agrees with the JVM on value + cost. The golden is still
   captured and contributed to SANTA (§4, §6) — a green pin for the whole conformer board.

## 4. Architecture & data flow

```
testnet node (REST)
   └─▶ ergots walker (tools/mainnet-validate, repurposed; network='testnet')
         • walk v6 activation height → tip
         • per input (tree version ≥ 3): reconstruct the REAL context
           (inputs, dataInputs, outputs, last-10 headers, preHeader, height, extension, self_index)
         • run ergots eval + cost
         • classify (§3) against the JVM oracle:
   └─▶ JVM oracle — santa/jvm-blesser, LIVE service mode (per-input call)
         • eval (tree, real context) via sigma-state → (value, cost) or errored
   └─▶ outcome:
         • not-impl   → deduped ledger entry (feature-id + example tree+context+height)
         • diverges   → STOP → capture golden → TDD fix → continue (autonomy §7)
         • match      → capture golden
   └─▶ every UNIQUE golden (tree + full context + JVM value+cost)
         → a SANTA vector in the full-context envelope (§8)
         → committed in SANTA's corpus → vendored back into ergots
         → grades the whole board (dasher/eni/develop/vixen/…)
```

The WASM oracle is **retired** — for both chains, not just the v6 path. The new walker never loads
`ergo-lib-wasm-nodejs`; the JVM service is its sole oracle, mainnet and testnet alike. `wasm-oracle.ts`
is removed only once the new walker has reached mainnet parity (§12 — don't delete the old validation
capability before the new one has covered the same ground); until then it lingers, unused by the new
path. End-state: one walker, one oracle, no WASM in the harness (it was dev-tooling-only anyway).

## 5. Components

### 5.1 ergots walker (harness) — the harvester + walk loop

Repurposes `tools/mainnet-validate/`. The harness already carries a `network: 'mainnet' | 'testnet'`
field, a caller-overridable activation height, and a REST-only `NodeClient(baseUrl)`, so the node
target is config, not a rebuild. New/changed pieces:

- **Testnet context reconstruction.** `bundle-assembler.ts` already assembles most of an input's
  context for the (old) WASM oracle — input boxes, rolling headers, extension, dataInputs. Extend it
  to assemble the **full** `ErgoLikeContext` surface needed for faithful eval: real `OUTPUTS`,
  `dataInputs`, the last-10 `headers`, the real `preHeader`, `HEIGHT`, `self_index`, and the per-input
  `extension`. Serialize each piece as **canonical bytes-hex** (§8).
- **JVM-oracle client.** A thin REST/IPC client to the `jvm-blesser` live service (replacing the
  in-process `wasm-oracle.ts`). Per-input call → `(value, cost)` or `errored`. Persistent service +
  per-block batching to keep the walk tractable (the call is out-of-process, unlike the old WASM).
- **Classifier + walk loop.** Mirrors the mainnet `validate-tx.ts` loop: per input, compare ergots
  vs oracle, branch into the three classes of §3. Checkpointed/resumable via the existing
  `checkpoint.ts`.
- **Version filter is a campaign parameter** — `--min-tree-version` (or equivalent): testnet
  campaign → ≥ 3 (v6 only); mainnet campaign → unfiltered (all versions). Not hardcoded.
- **Naming:** the harness is no longer mainnet-specific — **rename `tools/mainnet-validate/` →
  `tools/chain-validate/`** (it replaces the old walker for both chains). Mechanical rename; do it
  when the harness-side plan (Plan 2) lands.

### 5.2 not-impl ledger

A deduped accumulator, keyed by **feature identity**:

- `Expr.tag` for arms, `(typeId, methodId)` for methods, opcode for the rest.
- Each entry: count + first-seen `(height, txid, input)` + the example `(tree, context)` bytes.

The example bytes are retained so a not-impl can later be JVM-blessed and vectored **without a second
walk** (the "collect the strays in passing" requirement). The harness's existing
`repeated-arm-detector.ts` is the natural base. Output: a committed `findings/`-style report at
walk end (the v6 not-impl inventory). This is a *byproduct*; it does not gate the walk.

### 5.3 ergots conformance harness — full-context eval mode

ergots' own conformance harness (`packages/ergoscript/test/conformance/_santa.ts` + `makeContext`)
currently evaluates under the canonical **dummy** context (`INPUTS=[SELF]`, empty
outputs/dataInputs/headers, `HEIGHT=0`, dummy preHeader), with only narrow per-entry overrides. To
re-evaluate full-context goldens it must accept the **full** real context from the new vector
envelope (§8). This is the consumer side of the shared contract — built in ergots.

### 5.4 santa/jvm-blesser — live oracle service + full-context bless (COORDINATED, not built here)

SANTA already runs `jvm-blesser` (Scala, wraps sigma-state) to bless the conformance corpus, but
**only against `EvalCore.dummyContext`**. This walk needs two extensions, routed to SANTA:

- **Full-context eval.** `EvalCore` evaluates the harvested tree against the harvested **real**
  `ErgoLikeContext` (reconstructed from the bytes-hex context — the JVM has codecs for boxes/headers).
  The JVM can do this natively (it is what the node does every block); the limitation today is the
  dummyContext convenience, not the interpreter.
- **Live service mode.** A persistent process exposing a per-input `(tree, context) → (value, cost)`
  endpoint the walker calls, rather than (only) the batch bless-a-vector-set entrypoint. Persistent
  + batchable so the walk doesn't pay JVM startup per call.

## 6. Goldens & TDD

- A **golden** = `(tree_bytes, full context, JVM-blessed value+cost)`. Every **unique** golden
  (matching or diverged, after dedup — §9) is contributed to SANTA as a full-context vector (§8),
  committed in SANTA, and vendored back into ergots.
- **Divergences drive TDD.** When the live oracle catches a divergence, that golden is the failing
  test (red); the fix is the minimal ergots change to match the JVM (green); the golden stays as a
  permanent regression pin. This is the project's **fixtures-as-oracle** discipline — the inner
  red-green loop runs against the *committed golden*, never a live JVM, so it stays deterministic.
- The live oracle's job is **detection** (does ergots match the JVM right now?); the committed golden's
  job is **fix + regression**. Both are needed; they don't conflict.

## 7. Autonomy (inherited T7 rules)

The walk runs autonomously under the existing mainnet-campaign autonomy model
(`feedback_t7_overnight_autonomy`):

- **Fix-and-continue at ≥95% confidence** — cost-drift or value divergence on an implemented arm,
  diagnosed source-first (ergots + JVM canonical `~/projects/sigmastate-interpreter/`), fixed
  TDD-style, walk resumes. Full timeline logged to `findings/`.
- **Stop for user input only on:** a change too big to apply confidently, confidence that cannot be
  raised to ≥95% without input, or a *failed* fix.
- not-impl never stops the walk (§3.1). A genuine crash (neither a clean not-impl nor a value/cost
  divergence) is treated as the mainnet walk treated unexpected halts — investigate, since it is a
  bug, not an expected outcome.

## 8. The full-context vector envelope (shared SANTA contract)

A new `santa-eval` envelope (e.g. `santa-eval/v6-fullctx`), the SANTA coordination point. Every
context piece is **canonical consensus bytes in hex** — both sides already have parsers (JVM
`sigmaSerializer`; ergots `parseSValue(SBox)` / scorex `parseHeader`), and bytes sidestep any
structured-JSON re-encoding ambiguity:

```
{
  schema: "santa-eval/v6-fullctx",
  name, version: { activated, ergoTree },
  tree_bytes_hex,                      // the script under eval (= inputs[self_index]'s tree)
  context: {
    self_index,                        // which input is SELF
    inputs:      [ box_bytes_hex, … ], // ErgoBox bytes (incl. SELF)
    data_inputs: [ box_bytes_hex, … ],
    outputs:     [ box_candidate_bytes_hex, … ],
    headers:     [ header_bytes_hex, … ],   // up to 10
    pre_header:  bytes_hex,            // or derived from the spending block header
    height,                            // u32
    extension:   { <key 0..255>: SValue }   // the SELF input's ContextExtension
  },
  expected: { value: <SValue>, cost: <number>, error: null }   // blank at harvest; SANTA fills
}
```

Defined once, jointly; ergots implements the consumer (§5.3), SANTA implements the producer/blesser
(§5.4). The canonical-dummy-context envelopes (v1–v5) are unaffected — this is additive.

## 9. Dedup

Every **unique** golden becomes a vector — not every spend. The same contract spent many times must
not yield many near-identical vectors.

- Dedup exact `(tree_bytes, context)` duplicates outright.
- If a single `tree_bytes` still fans out across many distinct contexts, cap the kept contexts per
  tree (a small N that preserves branch/cost variety). Log what was dropped (no silent truncation).

## 10. Dependencies & coordination

- **Testnet node** — a node to point `NodeClient` at (local testnet node, or a public testnet REST
  endpoint). Confirm before the campaign.
- **Testnet v6 activation height** — the walk's start. Confirm the block-v3 / ErgoTree-V3 activation
  height on testnet (sets the lower walk bound).
- **SANTA coordination** — the full-context envelope (§8) and the `jvm-blesser` live-service +
  full-context-eval extensions (§5.4). Routed to SANTA via `prompts/`; the schema is agreed jointly
  before the ergots consumer + harvester are finalized.

## 11. Implementation decomposition

Larger than one plan; sequence as sub-projects (each its own writing-plans pass as reached):

1. **Shared contract + SANTA side** — agree the §8 envelope with SANTA; SANTA builds the
   full-context bless + live service. (Coordination + SANTA work; gates the rest.)
2. **ergots full-context machinery** — context reconstruction in `bundle-assembler.ts` (§5.1) +
   the conformance harness full-context eval mode (§5.3) + the JVM-oracle client. TDD against a
   handful of hand-made full-context goldens first.
3. **The walk loop** — classifier, not-impl ledger (§5.2), divergence fix-and-continue
   orchestration, autonomy wiring (§7), checkpoint/resume.
4. **The campaign** — run the walk from v6 activation, fix divergences TDD-style, harvest goldens
   into SANTA, produce the not-impl inventory.

The first writing-plans pass covers the **ergots side of (2)**, which can start against
hand-authored full-context goldens before SANTA's live service exists (the service is only needed for
the live campaign in (4), not for building/testing the full-context machinery).

## 12. Open questions / risks

- **Live-service latency at chain scale.** Out-of-process JVM calls are slower than the old
  in-process WASM. For the **first campaign (testnet v6)** this is a non-issue — the v6 range is far
  smaller than mainnet's 1.8M blocks and only v6 trees are oracled. For a **full mainnet re-walk**
  (the replacement campaign) it bites harder: persistent service + per-block batching are the
  mitigations, and the re-walk can run incrementally / from a checkpoint rather than in one pass.
  The old WASM walker stays available until a mainnet JVM-oracle re-walk has demonstrably reached
  parity (don't delete the old validation capability before the new one has covered the same ground).
- **Context reconstruction fidelity.** The reconstructed `ErgoLikeContext` must be byte-faithful to
  what the node validated; an off-by-one in headers/preHeader/height would manifest as a spurious
  divergence. Pin with hand-made full-context goldens in sub-project (2) before trusting the walk.
- **Corpus growth.** Even deduped, the real v6 surface could be large. The per-tree context cap (§9)
  and the coverage-novelty lens bound it; log drops.
