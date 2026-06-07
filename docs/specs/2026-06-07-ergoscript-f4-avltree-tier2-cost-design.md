# F4 — AvlTree Tier-2 cost faithfulness + construct-failure value class (mini-spec)

**Date:** 2026-06-07 · **Status:** ✅ DONE 2026-06-07 (commits `0665f84..cbaad45`) · **Branch:** `ergoscript-v6`
**Parent:** `2026-06-06-ergoscript-conformance-run-design.md` §F4 (the conformance-run living ledger)
**Closes:** 25 cost rows (22 v5 + 3 v6 insertOrUpdate) + 1 value row (insertOrUpdate#bad-proof)
+ the latent construct-failure value class in the other five proof-carrying methods (unvectored,
same JVM-canonical class — adversarial path carries equal weight per CLAUDE.md).

## Why a mini-spec (Decision #4)

The Tier-2 handlers (`eval/savltree.ts`) charge ZERO cost today — inherited from the
pre-cost-model sigma-rust Tier-2 convention ("no add_jit_cost in Tier-2 EvalFns"). Canonical
sigma-rust (eni @ `dc0adbe8`) has since landed the JVM model; ergots never did. The design
space warranting a spec: DynamicCost decomposition (proof-chunks vs tree-height), per-method
failure semantics (where the JVM diverges from ALL THREE conformers), and charged-op
arithmetic on the failure paths.

## Verified cost model (JVM-canonical, source-read 2026-06-07)

Sources: `CErgoTreeEvaluator.scala:67-254` (eval bodies), `methods.scala:1391-1516`
(descriptors), `CostKind.scala:24-32` (PerItemCost), `CAvlTreeVerifier.scala:24`
(treeHeight = rootNodeHeight). Second read: eni
`git show ergo-node-integration:ergotree-interpreter/src/eval/savltree.rs` — same model,
including the `tree_height` comment citing scorex `rootNodeHeight = startingDigest.last & 0xff`.

| component | kind | constants | charged on |
|---|---|---|---|
| createVerifier | PerItem | (110, 20, 64) | `proof.length` bytes, charged BEFORE construction, in every proof-carrying method incl. flag-passed bad-proof paths |
| LookupAvlTree | PerItem | (40, 10, 1) | **raw** `treeHeight` (no max-1 floor), once per key — contains/get ×1, getMany ×k |
| InsertIntoAvlTree | PerItem | (40, 10, 1) | `max(treeHeight, 1)`, per entry |
| UpdateAvlTree | PerItem | (120, 20, 1) | `max(treeHeight, 1)`, per op — **update AND insertOrUpdate both use this** |
| RemoveAvlTree | PerItem | (100, 15, 1) | `max(treeHeight, 1)`, per op |
| isInsertAllowed / isUpdateAllowed / isRemoveAllowed | Fixed | 15 | charge-then-check (blessed flags-deny 73 = envelope 43 + 15 + 15 proves both charges on insertOrUpdate) |
| digest (remove only) | Fixed | 15 | UNCONDITIONAL after remove's op loop (even poisoned) |
| updateDigest | Fixed | 40 | on success only (digest = Some), all four modify methods |

- **PerItemCost chunks = `trunc((n−1)/chunkSize) + 1`** — our `ctx.addPerItemCost` already
  implements exactly this (eval-context.ts:147, the JVM-lockstep fix). At chunkSize=1, n=0
  → 0 chunks (base only); at chunkSize=64, n=0 → 1 chunk.
- **treeHeight = `digest[32]`** — the height byte of the AvlTreeData starting digest
  (scorex `rootNodeHeight = startingDigest.last & 0xff`; our avltree port reads the same
  byte, proof-decode.ts:192). Computable at the handler level: `obj.value.digest[32]`.
  NOT proof-derived; constant across the op loop.
- **Charge placement = Pattern A** (charge before the guarded work): flag cost before flag
  check, createVerifier cost before construction, per-op cost before each op attempt
  (JVM `addSeqCost` wraps; eni places charge first).
- **insertOrUpdate flag order:** isUpdateAllowed(15) THEN isInsertAllowed(15), both always
  charged (CErgoTreeEvaluator.scala:199-200).
- The MethodCall envelope (dispatcher Pattern-A 4 + Const arms) is existing
  conformance-proven machinery — no change.

### Arithmetic reconciliation (blessed vectors, all exact)

n=8 tree → digest[32] = 4. Envelope 43 (insert/update/insertOrUpdate-shaped trees) or 27
(get/contains/getMany/remove-shaped):

- insert valid 348 = 43 + 15 + (110+20·3 [177 B proof]) + (40+10·4) + 40 ✓
- insert readonly-None 58 = 43 + 15 ✓
- update valid 468 = 43 + 15 + 170 + (120+20·4) + 40 ✓
- remove valid 447 = 27 + 15 + (110+20·4 [193–256 B proof]) + (100+15·4) + 15 + 40 ✓
- get/contains @n=8 257 = 27 + (110+20·2 [65–128 B proof]) + (40+10·4) ✓ (absent == present ✓)
- insertOrUpdate fresh-key 483 = 43 + 30 + (110+20·3 [177 B]) + (120+20·4) + 40 ✓
- insertOrUpdate flags-deny 73 = 43 + 30 ✓
- **insertOrUpdate bad-proof 443 = 73 + (110+20·3 [143 B]) + (120+20·4), NO updateDigest** ✓
  — proves the JVM runs the charged op loop on a construct-broken verifier (forall breaks
  at op 1) and returns None.
- ⚠ getMany 307/438/569 (k=1/2/3): AvlTree components reconcile exactly
  (cv 190/230/270 per proof 211/353/462 B; lookups k×90); residual +1 at k=2, +2 at k=3
  vs my hand-model — sits in the script envelope (likely ConcreteCollection/Const shape
  for the keys arg), NOT in the AvlTree components. Settle in TDD with the parsed trees;
  if a genuine evaluator gap, source-dive then.

## Failure model (JVM-canonical) — the value-class fix

**The JVM has NO construct-throw path.** scorex `BatchAVLVerifier` construction wraps
reconstruction in `Try{…}.toOption` (logError overridden to swallow in CAvlTreeVerifier);
a bad proof yields a verifier with `topNode = None`. Every subsequent op returns `Failure`;
`digest` returns `None`. All observable behavior flows from the per-op/digest semantics:

| method | construct-fail / per-op-fail behavior (JVM) | ergots today | fix |
|---|---|---|---|
| contains | Lookup Failure → `false` (no throw ever) | construct-fail THROWS | route construct-fail → false |
| get | Lookup Failure → throw (`syntax.error`) | construct-fail throws ✓ (same observable) | keep throw; charge cv + 1 lookup first |
| getMany | first Lookup Failure → throw; keys before it charged | construct-fail throws ✓ | keep; charge cv + 1 lookup (construct-fail) / opsCompleted+1 (op-fail) |
| insert | per-op Failure: V<3 throw / V3+ forall-break → digest None → None | construct-fail throws at ALL versions | construct-fail = first-op-fail: V<3 throw, V3+ None |
| update | per-op Failure → break → None (no version split) | per-op → None ✓; construct-fail THROWS | construct-fail → None |
| remove | per-op results DISCARDED (`cfor`, no break); digest None → None — **never throws** | construct-fail AND per-op-fail THROW | both → None |
| insertOrUpdate | per-op Failure → break → None | construct-fail THROWS (**the blessed red row**, savltree.ts:684) | construct-fail → None |

This is faithful-means-less-code: the contains construct/per-op disambiguation dance
(double verification via verifyAvlBatchPartial) DELETES; construct-fail simply joins the
per-op-fail path per method. eni keeps the construct `?` throw on all six — ergots LEADS
here (F3 conjecture-throw pattern); route the divergence note to sigma-rust via SANTA
post-phase.

### Charged-ops arithmetic on failure paths

Our `verifyAvlBatchPartial` returns `null` on construct-fail, else `opsCompleted` (count of
successful ops). Charged ops per method:

- contains/get: always exactly 1 lookup.
- getMany: full success → k lookups; construct-fail → 1; op-fail at key i → opsCompleted+1.
- insert/update/insertOrUpdate: full success → ops.length; construct-fail → 1 (first op
  fails immediately, forall breaks); op-fail → opsCompleted+1.
- remove: **always ops.length** (cfor has no break), + unconditional digest(15).
- Empty-ops batches: ZERO per-op charges (loop over nothing); behavior pin — valid proof
  → digest Some(starting digest) → updateDigest(40) + Some(tree); bad proof → None.
  ⚠ VERIFY in-task: our adapter's `newDigest`/`opsCompleted` for 0-op batches (current
  remove comment claims sigma-rust returns None on empty — re-source-read scrypto +
  ergo_avltree_rust + our port; pin whichever the JVM does, expect Some per scorex digest
  semantics).

## Task 0 (prerequisite) — `svalueToSantaJson` struct arms

`_santa.ts` `svalueToSantaJson` default-throws on AvlTree/Box/Header/PreHeader — AvlTree-valued
expected values (insert/update/remove/insertOrUpdate Some-arms) cannot compare today. Add:

- `AvlTree`/`Box`/`Header` → `{ kind, bytes_hex }` via `serializeSValue(tpe, v, 3, writer)`
  (wire/serialize-svalue.ts:139) — exact inverse of `hydrateCanonicalBytes` (parseSValue,
  test/_helpers/index.ts:51). Version-free channel rationale carries over (data-layer
  serialization is version-invariant; 3 matches the hydration constant).
- `PreHeader`: NO canonical-bytes channel exists (no JVM DataSerializer either) — struct-JSON
  arm only if a vendored file in this phase needs it (F4's needs are AvlTree-valued only).
- Likely free riders: the stateRoot + LastBlockUtxoRootHash value reds (AvlTree-valued
  accessor results that currently throw in the harness arm, NOT evaluator bugs). powOnetimePk
  (GroupElement arm already exists) is NOT explained by this — out of F4 scope, F5/Header
  family. Do not claim these flips in the gate; note them for the re-grade.

## TDD plan

Vendor 10 files (9 × `v5/authored/AvlTree.*.json` + 1 × `v6/authored/AvlTree.insertOrUpdate.json`)
into `test/fixtures/conformance/{v5,v6}/` + register in the santa-arm suites
(cost-v5/cost-v6.test.ts). Expected initial reds = exactly the 25 cost rows + 1 value row;
greens (values, adversarial rejects, updateOperations/updateDigest) must stay green.

Tasks (writing-plans will refine):
1. **Task 0** — harness arms (above) + vendor the 10 files; assert the predicted red/green split.
2. **Task 1** — facts/ergoscript-eval.md contract rows: Tier-2 cost model table + failure-model
   corrections (contract-first per CLAUDE.md docs rule).
3. **Task 2** — cost charges in the 7 Tier-2 handlers (`savltree.ts`): shared helpers
   (`treeHeight(data)`, `chargeCreateVerifier(ctx, proofLen)`), per-method charge sites per
   the tables above. The 25 cost rows go green.
4. **Task 3** — construct-failure value class: re-route `partial === null` per the failure
   table (6 methods); insertOrUpdate#bad-proof flips; unit pins for the 5 unvectored methods
   (each construct-fail shape: contains→false, insert v2→throw/v3→None, update→None,
   remove→None incl. per-op-fail→None, get/getMany→throw); empty-ops pins after the
   adapter verification. `'avl-tree-proof-failed'` stays (get/getMany/insert-V<3); remove
   the dead throw sites.
5. **Task 4** — close-out: ledger §F4 outcome + re-grade ping (predict −25 cost −1 value;
   flag the 2 likely Task-0 value riders), SESSION_CONTEXT, facts/ sweep, errors tally
   (expect 0 new codes), SANTA asks routed (below).

Gate: vendored vectors green at blessed costs · full monorepo suite green (node+jsdom) ·
tsc clean (4 pkgs) · SANTA re-grade confirms predicted flips.

## SANTA asks (queue post-phase, non-blocking)

1. contains-bad-proof → `false` bless (the most surprising unvectored fix; pins the
   no-throw-ever contract).
2. Empty-ops valid-proof bless for one modify method (pins Some(starting-digest) + cost
   envelope+flags+cv+updateDigest, zero per-op).
3. sigma-rust divergence note: construct-fail `?` throws on all six (eni savltree.rs:156/191/
   249/309/361) vs JVM swallow-and-flow — same routing as the F3 conjecture-throw note.

## Task 7.5 amendment — op-shape mismatches (2026-06-07)

**Verdict (source-read twice):** scorex has NO upfront op validation. Key shape is checked
per-op at the head of `AuthenticatedTreeOps.returnResultOfOneOperation` — inside its `Try`:
`require(compare(key, NegativeInfinityKey) > 0)`, `require(compare(key, PositiveInfinityKey) < 0)`,
`require(key.length == keyLength)` (±inf = all-0x00 / all-0xFF × keyLength) — and value length
(fixed-value trees) at modifyHelper's two write branches (`require(value.length == N,
"Value length is fixed and should be N")`). Any violation → Failure AT THAT OP'S INDEX;
`BatchAVLVerifier.performOneOperation` poisons `topNode = None`. Sources: scrypto_2.13-3.0.0
bytecode (decompiled from the coursier jar — `$anonfun$returnResultOfOneOperation$1`
offsets 8–102, `$anonfun$…$4/$6`, `$anonfun$performOneOperation$1`);
`ergo_avltree_rust/src/authenticated_tree_ops.rs:226-229` (`ensure!` triple) + `:291/:314`
(value length — Rust `assert!`/panic where the JVM Failure-routes; JVM canonical);
`batch_avl_verifier.rs:157-172`. `CAvlTreeVerifier` (`:26-39`) passes keys raw (`ADKey @@ key`).

**Failure-matrix row:** op-shape mismatch (wrong-length key, ±inf key, wrong-length value)
= per-op Failure at the violating index. Ops before it replay against the proof; whichever
failure comes first in op order wins. Result routing per method = the per-op-fail column of
the failure model above; charges = the existing chargedOps arithmetic with the failure at
that index (remove still charges ALL ops + digest 15).

**Construct-shape subclass:** `keyLength <= 0`, fixed `valueLength < 0`, `digest.length != 33`
are scorex RECONSTRUCTION requires (swallowed → topNode None → construct-fail). They fire
BEFORE `rootNodeHeight = digest.last & 0xff` is assigned (bytecode-verified), so this class
charges with treeHeight 0: lookup family `nItems = 0` (base-only at chunk 1), modify family
`max(0,1) = 1`. (Proof-parse construct-fails — requires passed — keep treeHeight = digest[32],
as the blessed bad-proof vector pins.) keyLength = 0 is wire-craftable (VLQ u32 in
AvlTreeData); the digest/valueLength legs are currently unreachable from script
(createAvlTree/updateDigest input checks) but guarded for faithfulness.

**Implementation:** handler-level pre-scan in `eval/savltree.ts` — `keyShapeBad` /
`firstShapeBadOpIndex` mirror the three key requires + the value require;
`verifyWithShapeRouting` slices ops to the prefix before the first violation and
short-circuits construct-shape to `null`; `constructShapeBad` gates the charge height.
`@ergots/avltree`'s public upfront-throw contract is UNCHANGED (its `AvlVerifyError`
validation is simply never tripped by the handlers). No new EvalError codes. Pins:
`test/eval/savltree-op-shape.test.ts` (15 — per-method wrong-length/±inf/value-length/
construct-shape, mid-batch index arithmetic for getMany+insert at exact costs).

**Wrapped-negative field fix (T7.5 follow-up, 2026-06-07):** JVM `AvlTreeData.scala:84-85`
parses `keyLength` and `valueLengthOpt` as `getUInt().toInt` — wire values in [2^31, 2^32)
wrap NEGATIVE (acknowledged by the JVM's own comment at :84-88).  `constructShapeBad`
previously used plain `<= 0` / `< 0` comparisons on ergots' positive u32 storage, so the
wrapped-negative range bypassed construct-shape detection and routed the Lookup/modify family
with `treeHeight = digest[32]` instead of the JVM-faithful 0.  Fix: `| 0` reinterpretation
(`(data.keyLength | 0) <= 0`, `(data.valueLengthOpt | 0) < 0`) in `constructShapeBad`,
citing AvlTreeData.scala:84-88.  Three pins added to `savltree-op-shape.test.ts` (Pin A:
contains keyLength=0x80000000 digest[32]=5 → 170 not 220; Pin B: update valueLengthOpt=
0x80000000 digest[32]=5 → 285 not 365; Pin C: remove keyLength=0x80000000 2-key digest[32]=5
→ 390 not 510) — all RED pre-fix, all GREEN post-fix.

**Known remaining Tier-1 divergences (JVM-verified, out of T7.5 scope, routed to SANTA):**
JVM `CAvlTree.updateDigest` (`CAvlTree.scala:31-34`) and `AvlTreeData` accept ANY digest
length (no require) — ergots' `updateDigest`/`createAvlTree` throw `'avl-tree-bad-digest-length'`
(sigma-rust `ADDigest::try_from` shape). JVM `CreateAvlTree` also keeps negative
`keyLength`/`valueLengthOpt` Ints as-is (the accessor-view divergence: `keyLength` accessor
on a wire-constant SAvlTree returns positive u32 where JVM returns negative Int) — still
SANTA-routed, untouched here; the use-site `constructShapeBad` now handles the wrapped-negative
range faithfully at the cost-charging level.

## Out of scope

- powOnetimePk value red (GroupElement-valued — not the harness arm; F5/Header family).
- Header accessor batch (F5 authoring demand, landed post-inventory).
- tx-tier 21 not-impl rows (open scope question, unchanged).
- Per-op cost growth on small-tree many-op batches (the JVM's own "cost is not properly
  approximated" comment at CErgoTreeEvaluator.scala:212-214 — nItems is loop-constant in
  the JVM; we mirror, including the imprecision).

## Outcome

**Delivered vs planned:**
- Planned: 22 v5 cost rows. Delivered: 22 v5 + 3 v6 insertOrUpdate cost rows + 1 value row (bad-proof→None) = 26 total rows.
- Task 7.5 (beyond plan): op-shape + construct-shape routing — scorex verdict from DECOMPILED scrypto 3.0.0 bytecode + ergo_avltree_rust; 18 op-shape pins + wrapped-negative u32 fix. Closed a LIVE acceptance fork.
- Pin counts: 18 op-shape pins + 12 Task-7 pins (construct-fail + empty-ops classes) + prior per-method cost vectors (25+1 blessed).
- Fixtures: savltree-*.json re-blessed; HAND-BLESSED marker in fixture-gen/src/main.rs; mutation suites adjusted (contains_key_absent removed — 0%-killable under never-throws).
- Gate: avltree 156 / ergoscript 4114 / nipopow 247 / scorex 187 — all green; tsc clean. EvalError codes: 80 (0 new).
- Adjacent findings routed to F5: TreeLookup over-accept (JVM has no eval override — trees.scala:1322-1338) + Tier-1 accessor-view family (updateDigest any-length / CreateAvlTree negative lengths / keyLength accessor wrapping — JVM-verified 2026-06-07).

## Epilogue amendment — acceptance-corpus round (2026-06-07)

SANTA resolved all 5 F4 asks same-day (reply in `~/projects/santa/prompts/f4-santa-asks.md`):
14 files / 57 entries across 4 blesser families; the F4 failure-model predictions held exactly
(op-shape sweep, ±inf keys, empty-ops, bad-proof-bytes all dasher-GREEN). sigma-rust shipped its
construct-fail routing same-day (eni `a4ee7442`, PR #890) — three-implementation convergence.
Remaining 9-row acceptance corpus, all JVM-blessed:
1. **TreeLookup over-accept (2)** — JVM has no eval override (`trees.scala:1322-1338`,
   `costKind = notSupportedError`; blessed errored @v2 AND @v3). ergots evaluated it
   (sigma-rust port). Fix: unconditional eval-reject `'unsupported-eval-node'`.
2. **CreateAvlTree over-accept (1, dasher panic)** — same class: no JVM eval override; blessed
   errored @v3 (unserializable @v5 JVM-side). Same fix; the panic resolves to a clean reject.
3. **updateDigest over-reject (4)** — JVM `CAvlTree.scala:31-34` accepts ANY digest length;
   blessed: 3-byte/empty/40-byte → Some(AvlTree) cost 46, `.digest` readback cost 65, canonical
   bytes carry the digest VERBATIM. ergots' `'avl-tree-bad-digest-length'` (eval) and
   `'savltree-digest-length'` (wire serializer) both retire.
4. **keyLength sign (2)** — deserialize-only asymmetry (`AvlTreeData.scala:84-85`
   `getUInt().toInt`; the serializer requires unsigned range, so only parse wraps): wire
   `0x80000001` → JVM `.keyLength` = −2147483647. Fix: i32 view at the accessor
   (`keyLength | 0`), consistent with T7.5's construct-shape predicate; valueLengthOpt gets the
   same view (same JVM parse line; source-backed, vector-unblessed — flagged for a future bless).
