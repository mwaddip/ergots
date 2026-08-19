# `@ergots/nipopow` continuous-mode unit — design

**Date:** 2026-08-19. **Status:** approved design, pre-plan. **Target
version:** 0.4.0 (breaking — see Versioning). **Predecessor:** the prover
phase (`docs/superpowers/specs/2026-08-18-nipopow-prover-design.md`, merged
as PR #15), whose Non-goals section scoped this unit and whose Task 9
elevated it from polish to interop-required.

## Why this unit exists (interop gap)

Every live JVM node serves continuous-mode proofs unconditionally:
`PopowProcessor.popowProof` hardcodes `PoPowParams(m, k, continuous =
true)` (`PopowProcessor.scala:110`) and `GET /nipopow/proof/{m}/{k}` has no
parameter to request otherwise. `@ergots/nipopow` 0.3.0 implements neither
continuous construction nor continuous verification: `verifyProof` rejects
every proof a live node serves today with `'continuous-unsupported'`.
After this unit, `verifyProof` accepts (and correctly validates) live
proofs, and `proveWithReader` reproduces them byte-for-byte.

Continuous mode, mechanically: the prover injects into the prefix the
historical headers a client needs to *recompute the difficulty* of blocks
that will arrive after the suffix — the last `useLastEpochs + 1` epoch-
boundary headers relative to the next difficulty-recalculation height. The
verifier checks those headers are present. Nothing else changes: same wire
format (the trailing `continuous` byte already round-trips since 0.3.0 /
NIP-12), same suffix rules, same PoW rules.

## Reference authority

| Concern | Canonical source (local checkout `~/projects/ergo-jvm-pr`) |
|---|---|
| Epoch math | `ergo-core/src/main/scala/org/ergoplatform/mining/difficulty/DifficultyAdjustment.scala:27-55` (`nextRecalculationHeight`, `previousHeightsRequiredForRecalculation`, `heightsForNextRecalculation`) |
| Prover-side injection | `src/main/scala/org/ergoplatform/modifiers/history/popow/NipopowProverWithDbAlgs.scala:93-105` |
| Verifier-side check | `ergo-core/.../popow/NipopowProof.scala:82-105` (`hasValidDifficultyHeaders`), `:74-76` (`isValid` conjunction), `:128-148` (`hasValidConnections` look-back window) |
| Chain-setting values | `src/main/resources/application.conf` (`epochLength = 1024`, `useLastEpochs = 8`), `mainnet.conf` (`eip37EpochLength = 128`), `testnet.conf` (`epochLength = 128`) |

**sigma-rust is not a reference for this unit.** Its `ergo-nipopow` crate
has no continuous mode at all — its codec omits the trailing byte (the
Task 7b wire-dialect finding, upstream-bug candidate owned by the
sigma-rust session) and it has no difficulty-header machinery. Every
behavior question in this unit resolves against the JVM alone.

Clean-room rule unchanged: the Scala is the reference for *behavior*; no
line-by-line translation.

## Non-goals

- **Difficulty recomputation.** `bitcoinCalculate` / `eip37Calculate` /
  `interpolate` — the arithmetic that turns the injected headers into a
  required-difficulty value for post-suffix blocks — is NOT ported. The
  JVM proof verifier itself never runs it: `hasValidDifficultyHeaders`
  checks header *membership* only. A future light-client/wallet unit that
  validates newly arriving headers will need the arithmetic; this unit
  ships exactly what the proof layer ships.
- **The three unrelated prover-arc carries** (INTERLINK_VECTOR_PREFIX
  export dedupe, non-integer m/k gate test, json-codec indices-digest
  scoping). Separate small items; folding them in would blur this spec's
  focus (focused-specs rule).
- **Wire-format changes.** None are needed; parse/serialize are already
  JVM-dialect (strict trailing `0|1` byte, Task 7b ruling stands).
- **Unfreezing `fixture-gen/`.** Stays frozen — and could not help here
  even if unfrozen: sigma-rust cannot generate continuous fixtures.

## Design

### 1. New module `src/difficulty.ts` — epoch math + membership check

Pure functions, clean-room from `DifficultyAdjustment.scala:27-55`:

```ts
export function nextRecalculationHeight(height: number, epochLength: number): number;
export function previousHeightsRequiredForRecalculation(
  height: number, epochLength: number, useLastEpochs: number): number[];
export function heightsForNextRecalculation(
  height: number, epochLength: number, useLastEpochs: number): number[];
```

Behavior pinned to the Scala, including the branches only exotic configs
reach:

- `nextRecalculationHeight`: `height % epochLength === 0` → `height + 1`;
  else `(floor(height / epochLength) + 1) * epochLength + 1`.
- `previousHeightsRequiredForRecalculation(height, e, u)`:
  1. `(height-1) % e === 0 && e > 1` → `[(height-1) - i*e for i in 0..u]`,
     filtered `>= 0`, ascending;
  2. else `(height-1) % e === 0 && height > e*u` → same list, unfiltered,
     ascending (reachable only when `e === 1`; ported anyway — faithful
     includes the branches we never expect to take);
  3. else → `[height - 1]`.
- `heightsForNextRecalculation` = composition of the two. Note the
  composed call always lands in branch 1 for `e > 1`, producing up to
  `u + 1` ascending multiples of `e`.

Membership check, clean-room from `NipopowProof.scala:82-105`:

```ts
export function hasValidDifficultyHeaders(
  proof: NipopowProof, epochLength: number, useLastEpochs: number): boolean;
```

- `proof.continuous === false` → `true` (vacuous, JVM else-branch).
- Otherwise: for each `h` of
  `heightsForNextRecalculation(proof.suffixHead.header.height, epochLength,
  useLastEpochs)` with `0 < h < suffixHead.height`, the flat header chain
  (`prefix` headers + `suffixHead` + `suffixTail`) must contain a header at
  height `h`. Implemented as an ordered two-pointer scan that never resets
  between needles — the JVM's `indexWhere(_, lastIndex)` semantics, which
  coincide with set membership only because the needle list is ascending
  and callers establish strict height monotonicity first. Callers MUST
  run the heights check before this one (both call sites below do; the
  JVM's `isValid` `&&`-chain enforces the same order by short-circuit).

Both `verifier.ts` and `compare.ts` import from this module; it imports
only `proof.ts` types (no cycle).

### 2. Chain-parameter surface

Two exported constants (naming follows `V2_ACTIVATION_HEIGHT_MAINNET`):

```ts
export const EPOCH_LENGTH_MAINNET = 128;   // effective: eip37EpochLength.getOrElse(epochLength)
export const USE_LAST_EPOCHS_MAINNET = 8;
```

The JVM composes `eip37EpochLength.getOrElse(epochLength)` at both call
sites (prover and verifier) with no height-gating — the pre-EIP-37 value
1024 never participates in this machinery on mainnet — so ergots exposes
the *composed* value as a single `epochLength` knob. Testnet is also 128;
the defaults cover both public networks.

Optional overrides, flat fields (the `v2ActivationHeight` precedent):

- `VerifyOptions` gains `epochLength?: number` and
  `useLastEpochs?: number`.
- `PoPowParams` gains `continuous?: boolean` (default `false`),
  `epochLength?: number`, `useLastEpochs?: number`.
- `compareProofs(a, b)` gains an optional third argument
  `opts?: { epochLength?: number; useLastEpochs?: number }`.

A shared resolver in `difficulty.ts` applies defaults and gates the
values: both must be integers (`Number.isInteger`), `epochLength >= 1`,
`useLastEpochs >= 2`, and `epochLength * useLastEpochs <= 2^31` (the
JVM constructor's `require`s: `useLastEpochs > 1`, `epochLength > 0`,
overflow guard). Violations throw `RangeError` — a caller-configuration
defect, deliberately outside the `ProofVerificationError` /
`ProofBuildError` taxonomies, which describe defects in proofs.

**Coupling with the connections window.** The JVM derives
`hasValidConnections`' prefix look-back window from the *same* setting:
`maxDiffHeaders = useLastEpochs + 1`, window = `useLastEpochs + 3`
predecessors (`NipopowProof.scala:129,135`). `connections.ts` currently
hardcodes `LOOKBACK_SPAN = 11`. `hasValidConnections` gains an optional
second parameter `useLastEpochs = USE_LAST_EPOCHS_MAINNET`; the window
becomes `useLastEpochs + 3`; verifier and compare thread their resolved
value through. Behavior at defaults is bit-for-bit unchanged.

### 3. Verifier (`verifier.ts`)

- **Delete** the `'continuous-unsupported'` early gate (Task 7b's
  placeholder — its purpose was precisely to reserve this unit's slot).
- Resolve `epochLength` / `useLastEpochs` from `VerifyOptions` next to
  the existing `checkPoW` / `v2ActivationHeight` resolution (resolver
  runs before any proof inspection, so a `RangeError` on bad options
  fires even for proofs that would fail verification).
- **After** the strict-monotonicity + PoW loop (so the ascending-chain
  precondition of the two-pointer scan is established — mirroring the
  JVM's `isValid` short-circuit order, where `hasValidDifficultyHeaders`
  runs last), run `hasValidDifficultyHeaders`; on `false` throw
  `ProofVerificationError` with new code **`'missing-difficulty-headers'`**.
- `VerificationResult.continuous` widens from literal `false` to
  `boolean`, echoing `proof.continuous`. For non-continuous proofs the
  accept-set is **exactly 0.3.0's** (the new check is vacuous); for
  continuous proofs the accept-set is exactly the JVM's.

`verifyProof` (bytes entry) changes only through `verifyParsedProof`.

### 4. Compare (`compare.ts`)

Internal `isValid` appends the difficulty check after connections,
heights, and interlinks proofs — the JVM's exact conjunction order
(`NipopowProof.scala:75`). Boolean domain, no new exceptions: a
continuous proof missing its difficulty headers is not valid for
comparison — it loses to any valid proof, and two such proofs compare
`false`, same as the JVM. `compareProofs` threads its new `opts` through;
`isBetterThan` stays internal.

This closes the carried "compareProofs continuous gate": 0.3.0's
`isValid` (sigma-rust lineage) silently scored continuous proofs without
the difficulty-membership requirement the JVM imposes.

### 5. Provers (`prover.ts`) — decision (b): inject in both

Shared injection helper (module-internal):

```
neededPrefixHeights(suffixHeadHeight, epochLength, useLastEpochs): number[]
  = heightsForNextRecalculation(suffixHeadHeight, ...)
      .filter(h => h < suffixHeadHeight)          // strict; JVM prover gate
```

(The verifier additionally ignores `h <= 0`; the prover needs no such
gate — no chain has a header at height ≤ 0, so lookup misses and the
silent-skip rule below applies, matching the JVM, where
`popowHeader(height)` returns `None` and `.foreach` does nothing.)

- **`proveWithReader`** (production path, mirrors
  `NipopowProverWithDbAlgs.scala:93-105` exactly): when
  `params.continuous`, after seeding genesis and before merging the
  interlink-walk selection, fetch each needed height via
  `reader.popowHeaderAtHeight(h)`; a `null` is **silently skipped** (JVM
  `Option.foreach` — NOT the `'missing-popow-header'` error the by-id
  fetches raise; a reader that cannot serve a needed height yields a
  proof the verifier will reject as `'missing-difficulty-headers'`,
  which is the JVM's behavior too). Injected headers enter the by-height
  dedupe map before walk-collected ones — the JVM's `storedHeights`
  precedence. Existing exotic-config delta, now load-bearing enough to
  document: under real configs (`epochLength > 1`) injected heights are
  multiples of `epochLength` and cannot collide with genesis (height 1)
  or each other, so map-set-if-absent equals the JVM's unconditional
  array append; under `epochLength === 1` the JVM can append a
  duplicate-height header (producing a proof its own verifier rejects)
  where ergots dedupes — noted in facts, not reproduced.
  No reader-interface change: `popowHeaderAtHeight` already exists.
- **`prove`** (in-memory): same needed-heights set, looked up by height
  scan over `preSuffix` (the chain argument minus the suffix), skip if
  absent, add to the prefix unless a same-id entry is already selected,
  re-sort by height. **Deliberate divergence from the reference:** the
  JVM's `NipopowAlgos.prove` stamps `params.continuous` into the proof
  WITHOUT injecting (`NipopowAlgos.scala:158`) — self-marked "Paper-like
  code used in tests only" with a todo to replace it. Mirroring that
  wart would make `prove(continuous: true)` emit proofs our own verifier
  rejects. ergots instead makes both provers inject identically, so
  continuous `prove()` output equals continuous `proveWithReader()`
  output on any chain where the two walks already coincide — the
  level-0-free equivalence predicate in `facts/nipopow.md` is UNCHANGED
  by this unit, because injection adds the same header set to both
  sides. Documented in facts as a deliberate delta with the JVM todo
  cited. Consequence for validation: JVM `NipopowAlgos.prove`
  vectors are ground truth for `continuous: false` only; continuous
  prover ground truth is `NipopowProverWithDbAlgs` semantics (what live
  nodes run).
- Both provers stamp `params.continuous ?? false` into the returned
  proof. `prove` keeps rejecting non-genesis-anchored chains and short
  chains exactly as today; no new prover error codes.

### 6. Public-surface inventory

New exports (package root): `nextRecalculationHeight`,
`previousHeightsRequiredForRecalculation`, `heightsForNextRecalculation`,
`hasValidDifficultyHeaders`, `EPOCH_LENGTH_MAINNET`,
`USE_LAST_EPOCHS_MAINNET`. (Small, pure, and light-client-useful; also
what the facts contract documents and the tests exercise.)

Changed: `VerifyOptions` (+2 fields), `VerificationResult.continuous`
(`false` → `boolean`), `PoPowParams` (+3 fields), `compareProofs` (+1
optional arg), `hasValidConnections` (+1 optional arg), error taxonomy
(− `'continuous-unsupported'`, + `'missing-difficulty-headers'`).

Unchanged: wire codecs, envelope, merkle, interlinks, level, reader
interface, `/prover` subpath layout.

## Validation strategy

`fixture-gen/` stays frozen and is unusable here regardless (sigma-rust
has no continuous mode). Ground truth is the JVM, via SANTA vectors and a
live mainnet node. TDD discipline applies: each fixture lands before the
test, each test red before the code.

1. **SANTA batch 1 — epoch-math truth table** (cheap, stable): committed
   JSON of `(height, epochLength, useLastEpochs) → heightsForNextRecalculation`
   (plus the two sub-functions) straight from `DifficultyAdjustment`,
   covering: epoch boundary (`h % e === 0`), boundary ± 1, mid-epoch,
   tiny heights where the `>= 0` filter bites, heights around the
   `e * u` cliff, and a `(1024, 8)` pre-EIP-37 set alongside `(128, 8)`.
   Drives `test/difficulty.test.ts`.
2. **SANTA batch 2 — verifier truth vectors**: hand-built JVM proofs
   (fake headers fine), continuous both ways, with and without the
   needed heights present, each with JVM `hasValidDifficultyHeaders` /
   `isValid` booleans and serialized proof bytes. Accept AND reject
   cases — the adversarial path (continuous-stamped proof missing one
   needed height; needed height present but in the suffix; boundary
   `suffixHead.height % epochLength === 0`) carries equal weight.
   Drives verifier + compare tests.
3. **SANTA batch 3 (feasibility asked, non-blocking)** —
   `NipopowProverWithDbAlgs.prove(continuous = true)` full proof bytes
   on a synthetic history, as a committed-fixture complement to the live
   gate. If SANTA can't drive a synthetic `ErgoHistoryReader`, the live
   gate alone anchors the prover (Task 9 precedent).
4. **Acceptance gate (the headline)** — `tools/nipopow-capture/
   live-walk.mjs --expect-full-identity` flips to PASS against a real
   mainnet node: our `proveWithReader(continuous: true)` byte-identical
   to the raw JVM response (no filtering, no flag normalization), both
   Task 9 parameter sets (m=6,k=6 and m=2,k=10). Plus the interop
   headline itself: `verifyProof(rawLiveBytes)` succeeds with
   `checkPoW: true`. Tools-side tweak in scope: in full-identity mode
   live-walk stops forcing `continuous: false` and calls the prover with
   `continuous: true`.
5. **Regression floor**: full-workspace `npm test` + typecheck + nipopow
   jsdom + package build stay green. Existing tests asserting
   `'continuous-unsupported'` are rewritten to the new behavior (accept
   valid continuous proofs; reject header-missing ones with
   `'missing-difficulty-headers'`).

## Risks

- **Epoch-math port defects** (off-by-one at boundaries, the `>= 0`
  filter, branch selection). Mitigation: batch 1 truth table is
  generated from the JVM itself; the tools-side reimplementation in
  `live-walk.mjs` (already validated by Task 9's surplus attribution)
  cross-checks the package port.
- **Verifier accept-set drift.** The check is small but consensus-shaped
  for interop: accept exactly what the JVM accepts. Mitigation: batch 2
  includes adversarial rejects, and the ordered-scan subtlety (needle
  list ascending + chain strictly monotone) is pinned by tests either
  side of the boundary.
- **Live-gate flakiness** (node availability / tip movement mid-run).
  The script already snapshots a tip id and anchors both sides to it
  (Task 9); any conformant `ergo-mainnet-6.x` node works as fallback.
- **SANTA batch 3 infeasibility.** Non-blocking by design; the live gate
  covers the same surface with production truth.

## Versioning and rollout

- `@ergots/nipopow` **0.4.0**. Breaking: `VerificationResult.continuous`
  type widens; `'continuous-unsupported'` removed from the error
  taxonomy. Everything else is additive-optional.
- Release-notes bullets to carry: 0.4.0 verifies live-node proofs
  end-to-end (the 0.3.0 interop gap closes); non-continuous accept-set
  unchanged; `prove(continuous: true)` deliberately diverges from the
  JVM's stamp-only test prover (injects like the production prover).
- Publish remains the user's call, as with 0.3.0.

## Plan conventions (carried from the prover arc)

- `facts/nipopow.md` contract update is **Task 1** (contract-first),
  covering: the new `/difficulty` entries, prover/verifier/compare
  postcondition changes, error-taxonomy delta, the `prove` divergence
  note, the exotic-config dedupe note, and flipping the "Limitations"
  live-endpoint section to resolved.
- Branch `nipopow-continuous` off master; this spec's commit is the
  branch base. Docs close-out (README, API.md, SESSION_CONTEXT, HANDOFF)
  is the final task. Per-task review, one ledger under
  `.superpowers/sdd/`.
- Subagent dispatches carry OVERRIDES.md verbatim + proof-of-reading
  gate (standing rule).
