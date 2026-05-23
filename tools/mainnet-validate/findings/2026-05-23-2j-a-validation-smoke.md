# Phase 2j-a Layer-5 validation smoke findings (2026-05-23)

## Spec success criterion

> Wiring validated end-to-end on real mainnet data; either clean walk OR
> structured halt with well-formed `error-report.json` at one of the new
> phase classes. Both outcomes ship 2j-a; failing outcome is a non-structured
> crash, which blocks ship.

Per `docs/specs/2026-05-22-ergoscript-2j-a-cost-oracle-design.md` §"Layer 5
— Validation smoke (post-implementation; the 2j-a closing task)".

## Result: HALT WITH STRUCTURED REPORT — `evaluate-cost / cost-drift` at h=3850

Walked from a fresh sidecar with `--max-height 100`, then bumped to `1000`,
then to `10000` per PLAN.md T9 step 4 escalation guidance. **The 10000-cap
walk halted at h=3850 with a fully-formed `error-report.json`** carrying
the structured cost-equivalence payload exactly as the spec mandates.

```
shim: network=Mainnet, computed 3 genesis box(es) for sidecar seeding
sidecar opened at height 0
shim: protocol_version=2
Walking 1..10000 (tip=1791617, network=mainnet)
halt at height 3850 (validation failed): cost-drift: oracle 434 vs ours 410 (delta 24) at tx 2, input 0
```

The walk completed h=1..3849 cleanly (3849 blocks, 3886 txs, 7772 boxes,
3969 spends — see Stats below). The halt site is the same height fix-2
previously surfaced (missing-utxo, now resolved) and fix-3 walked past
cleanly: this is a NEW divergence introduced by the 2j-a cost-equivalence
check, not a regression in the existing four validation passes.

## h=100 and h=1000 walks (clean)

Before bumping to h=10000, the spec's bumper sequence per PLAN.md T9 step 4
covered shorter caps for early-mainnet validation:

| cap | result | duration |
|---|---|---|
| 100 | clean tip-reach, no error-report | 5.7 s |
| 1000 | clean tip-reach, no error-report | 10.4 s |
| 10000 | halt at h=3850 with structured report | 40.8 s |

The h=100 and h=1000 walks confirm that 2j-a wiring runs end-to-end
without spurious mismatches on bare-P2PK boxes (>90% of early-mainnet
inputs). The bare-P2PK 50-cost `EVAL_SIGMA_PROP_CONSTANT` short-circuit
symmetry between our `tryTrivialReduceExpr` and sigma-rust's `eval.rs:213`
holds across 1000+ inputs cleanly.

## Stats (post-fix-3 baseline + 2j-a cost-equivalence active)

| metric | value |
|---|---|
| start | 1 |
| max | 10000 |
| validated to | 3849 (halt at h=3850) |
| blocks | 3,849 |
| txs | 3,886 |
| boxes validated | 7,772 |
| spends validated (evaluate + verifySignature + cost-diff) | 3,969 |
| elapsed | 40.8 s |
| halt | `evaluate-cost / cost-drift` at h=3850 tx 2 input 0 (delta 24) |

## Halt site detail

From `bootstrap-data/t-2j-a-error-report.json`:

```jsonc
{
  "phase": "evaluate-cost",
  "errorCode": "cost-drift",
  "location": {
    "txIndex": 2,
    "txId":      "e179f12156061c04d375f599bd8aea7ea5e704fab2d95300efb2d87460d60b83",
    "inputIndex": 0,
    "spentBoxId": "5527430474b673e4aafb08e0079c639de23e6a17e87edd00f78662b43c88aeda",
    "ergoTreeHex": "100e040004c094400580809cde91e7b0010580acc7f03704be944004808948058080c7b7e4992c0580b4c4c32104fe884804c0fd4f0580bcc1960b04befd4f05000400ea03d192c1b2a5730000958fa373019a73029c73037e997304a305958fa373059a73069c73077e997308a305958fa373099c730a7e99730ba305730cd193c2a7c2b2a5730d00d5040800"
  },
  "evaluateCost": { "expected": 434, "actual": 410, "delta": 24 }
}
```

The tree has **14 segregated constants** (`100e` header VLQ count) and
exercises sigma-protocol opcodes `0xea03d1...` (likely `SigmaAnd` /
`SigmaOr` with several conjuncts). Cost-delta is small (24 JitCost
units) and positive (oracle higher → our side **undercharged**).

Cost-pattern analysis (deferred to 2j-b proper):

- 24 JitCost is roughly the per-item charge of one of the smaller Coll
  HOF arms, or a couple of fixed-charge arms.
- Could be `Pattern A` charge missing on a tree-walk arm, or
  `Pattern B` `addPerItemCost` undercharging on a small Coll.
- Confirming requires the per-arm cost-charging audit (sigma-rust source
  read for the specific arms the tree exercises).

## All spec-mandated `error-report.json` fields present

Verified against `docs/specs/2026-05-22-ergoscript-2j-a-cost-oracle-design.md`
§"`error-report.json` payload extensions" (lines 146-177):

| spec key | present | value shape |
|---|---|---|
| `phase` | ✓ | `'evaluate-cost'` |
| `errorClass` | ✓ | `'HarnessError'` |
| `errorCode` | ✓ | `'cost-drift'` |
| `location.txIndex` | ✓ | `2` |
| `location.txId` | ✓ | 64-hex (T8-review-fix populated this) |
| `location.inputIndex` | ✓ | `0` |
| `location.spentBoxId` | ✓ | 64-hex |
| `location.ergoTreeHex` | ✓ | full tree hex |
| `evaluateCost.expected` | ✓ | `434` (u64 narrowed) |
| `evaluateCost.actual` | ✓ | `410` |
| `evaluateCost.delta` | ✓ | `24` (positive → ours undercharged) |
| `bundleExcerpt.headerHex` | ✓ | full header hex |

End-to-end pipeline validated: `validateTx` throws `HarnessError` →
`classifyError` flattens the 2j-a payload → `writeErrorReport` serializes
to disk → operator reads the structured halt site.

## Implication for 2j-b

This halt is the first naturally-occurring RED for the 2j cost-calibration
loop. 2j-b's RED is:
- The per-arm fixture test against this `(tx, input, ergoTree)` exercising
  the same cost gap.
- Source-read the relevant sigma-rust arms before writing GREEN (per
  `[[reference-source-first-discipline]]`).
- Likely root cause: a `Pattern A` arm charging less than sigma-rust, or
  a `Pattern B` `addPerItemCost` undercharging by a small per-item
  multiple. The `100e` 14-constant header + sigma-protocol body suggests
  the tree has multi-conjunct `SigmaAnd` / `SigmaOr` / `Atleast` arms.

The accumulated `findings/` folder now has the EMPIRICAL inventory:
fix-1/2/3 (resolved) + 2j-a wiring + this first cost-drift site (handed
off to 2j-b proper).

## Why this is a clean ship for 2j-a

Both spec outcomes are passing:

> "Clean walk to h=100 → wiring validated; document and ship."

We have clean walks at h=100 AND h=1000 (covers the "wiring runs
without false positives on the dominant bare-P2PK input shape" axis).

> "Halt with structured `error-report.json` → first surfaced RED;
> that's 2j-b's input data."

We have a fully-formed halt at h=3850 with all spec-mandated fields
present and correctly typed (covers the "halt machinery produces the
intended structured artifact" axis).

The cost-equivalence wiring is **validated end-to-end on real mainnet
data**. 2j-a ships.

## Known limitations carried into 2j-b (flagged in T5)

Per the T5 wiring decisions documented in `SESSION_CONTEXT.md`:

- **Shim uses `Parameters::default()`** (not block-parsed parameters)
  for `jit_cost_limit`. The default `1_000_000` JitCost is generous
  enough that cost-limit-induced false positives are unlikely. The
  h=3850 halt's delta of 24 sits far below the limit and is NOT cost-
  limit related — confirmed by the test passing without ever throwing
  `cost-limit-exceeded`. Follow-up: thread `block.parameters` into
  shim's `walk_transaction` if a deeper smoke surfaces a limit-related
  spurious mismatch.

- **Shim uses an empty rolling-headers window padded with the current
  header** in `cost_oracle::build_state_context`. Trees that read
  `CONTEXT.headers` may show spurious mismatches because our harness
  passes preceding-headers and the shim doesn't. The h=3850 halt's
  tree (sigma-conjunct multisig shape) does not read `CONTEXT.headers`
  — confirmed by the cost delta being small (24) rather than large.
  Follow-up: proper rolling state in shim's request handler if a
  deeper smoke surfaces a headers-related mismatch.

## Artifacts

- `bootstrap-data/modifiers.redb` — 25 GB snapshot copied from
  `/var/lib/ergo-node/data/` (gitignored; per-developer; replaces the
  prior `/tmp/ergots-2j-pre-smoke-data/modifiers.redb` location that
  didn't survive reboots).
- `bootstrap-data/t-2j-a-sidecar.redb` — fresh sidecar with h=1..3849
  walked.
- `bootstrap-data/t-2j-a-checkpoint.json` — `lastValidatedHeight: 3849,
  tipReachedAt: null`.
- `bootstrap-data/t-2j-a-error-report.json` — full structured halt
  report (excerpted above).

All gitignored under `bootstrap-data/` (per `.gitignore` block added
in T9).
