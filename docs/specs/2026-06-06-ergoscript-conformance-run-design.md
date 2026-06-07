# ErgoScript conformance run — full-surface sweep (v5 + v6)

**Date:** 2026-06-06 · **Status:** discovery DONE → fixing in phases · **Branch:** `ergoscript-v6`
**Phase type:** discovery/root-cause (done) → reachability-ordered fix phases F1–F5 (user-approved
the plan + F1 execution 2026-06-06; F2 DONE 2026-06-06).
**Deliverable:** root-caused divergence inventory (done) + phased fix plan (done) + the fixes.
**Progress:** ✅ **F1 DONE + PUSHED** (`origin/ergoscript-v6` @ `d7cef2f`; atLeast + DC value forks,
6 eval-tier reds closed). ✅ **F2 DONE 2026-06-06** (commits `7bf3bff..531c8fa`, 9 commits; timestamp
bigint + putUByte cost class; 16 rows closed at blessed costs). Next: **F3** (EQ_of_SigmaProp +
serialize(SigmaProp) cost) — **READY, zero external dependencies** (both vector files landed
SANTA-side 2026-06-06; vendor in-task). SANTA deliveries (re-grade, authoring batches) are a
PARALLEL track — no F-phase waits on them unless its plan section says so. The signed-view
micro-phase (§Coordination) is also unblocked (JVM-adjudicated) and should land before SANTA's
vector batch arrives.

## Why

- Per-phase SANTA vectors pinned each phase's *new* arms; nothing ever swept the whole
  built surface. The v5 sweep meta-lesson: live JVM vectors catch what source-only triage
  misses (3 of 4 cost arms hid a second sub-divergence).
- P7b framing collapsed on contact: its nominal items (substConstants v6 fix, AvlTree
  insert/insertOrUpdate v6 semantics) were already landed (`5e56367`, 2h-era port). What
  the verification surfaced instead: the AvlTree Tier-2 **cost** surface charges zero vs
  the JVM model (canonical sigma-rust has since landed it too) — and nothing pins it.
- SANTA operates a 5-way grade far beyond what we vendored: `v5/spec` alone 1558 entries
  (green). The sweep consumes that machinery instead of rebuilding it.

## Method

1. **Grade at tip** — done 2026-06-06: dasher (ergots) @ `56582c5` = exact tip, 93 reds.
   Inventory: `~/projects/santa/prompts/dasher-red-inventory-2026-06-06.md`.
2. **Triage classes** (extends the P7a experience): `ergots-bug` / `dasher-bridge` /
   `stale-blessing` / `out-of-scope-surface`.
3. **Root-cause every ergots-bug family** — source-level (ergots + JVM canonical
   `~/projects/sigmastate-interpreter/`; eni cross-check ONLY via
   `git show ergo-node-integration:<path>` in `external/sigma-rust` — the vendored
   working tree is stale), anchored by the blessed vectors. ≥95% confidence per
   OVERRIDES #10, or explicit escalation.
4. **Gap inventory** — SANTA corpus manifest diffed against the ergots registry
   (~125 methods + ~65 non-method arms) for never-covered surface. Pre-confirmed gaps:
   AvlTree Tier-2 proof-carrying methods ×7 (zero vectors; SANTA top queue item via
   sigma-rust's request), substConstants `treeVersion≥3`+hasSize (manifest will settle).
5. **Phased fix plan** — ordered by reachability class (chain-reachable first), written
   as the phase close-out, user-approved before any fix phase starts.

## Status ledger (live)

| bucket | rows | state |
|---|---|---|
| dasher-bridge (UBI deferred in their ts-runner) | 46 | ✅ CLOSED — bridge shipped (santa@`0d74aac`) + re-graded: ALL 46 flip GREEN, zero divergences underneath; ergots UBI surface fully value+cost conformant (v6/spec 241/241 value, 240/241 cost — the 1 coal is the pre-existing deserializeTo_header −1). Dead abstain machinery deleted on their side (future bridge gaps panic loud). Inventory regenerated at same path: **47 rows = true triage surface** |
| out-of-scope surface (Transaction wire 17 + captured-tx envelope 4) | 21 | scope question OPEN (user): tx codec on roadmap or acknowledged gap |
| ergots-bug (original) | 26 | ✅ root-caused 2026-06-06 (4 read-only agents; sub-issue B re-dispatched focused — see table) |
| ergots-bug (+27 from SANTA batch, 2026-06-06) | 27 | ✅ all COST, zero new value bugs. 22 AvlTree Tier-2 (full blessed table → F4) + 5 EQ_of_SigmaProp-unequal (→ F3, second arm). dasher 47→74. Batch note: `~/projects/santa/prompts/santa-avl-batch-landed.md` (7 commits santa `main`, push pending). Corpus 2143/155. **Confirmed GREEN (no work):** Tier-1 props (21, incl. R9[AvlTree].get), AvlTree Tier-2 VALUES (proof verify/non-inclusion/flag-gate/modify/reject), UBI plain-arith (13, value+cost), 52 healed spec entries, EQ-unequal VALUES |

### ergots-bug families → root causes (diagnosed 2026-06-06, read-only agents)

| # | family (entries) | class | root cause | conf |
|---|---|---|---|---|
| 1 | EQ_of_SigmaProp (3) | cost | ergots `relation.ts:491` charges flat `EQ_PRIM_COST=3` for SigmaProp equality; JVM `DataValueComparer.scala:253-282,353-361` walks the SigmaBoolean tree recursively — MatchType(1) per node + `EQ_GroupElement`(172) per ECPoint compare (ProveDlog=1, ProveDHTuple=4) + outer MatchType. Arithmetic reconciles all three blessed costs exactly (224/740/398, shared tree-envelope 50). ~~sigma-rust shares the bug~~ **RETRACTED 2026-06-06** — the diagnosis agent read the STALE vendored working tree; eni @ `dc0adbe8` (verified: local ref AND SANTA's graded `.santa/blitzen-eni` checkout, identical) implements the full walk incl. && short-circuit (`data_value_comparer.rs:152-158` + `eq_sigma_bool_with_cost`), and the grade confirms (eni 10/10 on these vectors). **Fix is ergots-alone**; mirror the short-circuit semantics (blessed vectors only compare identical trees — unequal-tree cost paths need their own pins) | 98% |
| 2 | atLeast degenerate bounds (4) | **value** | JVM `AtLeast`: bound ≤ 0 → TrivialProp(true); bound > children.size → TrivialProp(false) (covers bound=256>2 and empty-children); ergots `atleast.ts` error-rejects all four. **Chain-reachable: twin of captured testnet tx @ h=184137.** BONUS divergence found: ergots misses the JVM 255-children cap on the collection (oversized-coll behavior unpinned — add to gap list) | 99% |
| 3 | DeserializeContext absent/wrong-typed var in dead branch (2) | **value** | ergots `_substitute-deserialize.ts:176,182` THROWS during the eager pre-eval substitution; JVM `Interpreter.scala:110-123` `substDeserialize` returns `None` → node left in place → dead branch never evaluated (live-branch cases throw in BOTH — agreement). **sigma-rust eni already matches JVM** (leaves node; ergots ported the older pre-fix behavior). **Chain-reachable: twin of captured testnet tx @ h=111927.** Fix-class: failure-tolerant substitution (return node unchanged; also the register wrong-type site :244). Open: whether any per-tree deserialize overhead cost applies (blessed dead-branch cost=12 suggests none) | 98% |
| 4 | Header timestamp > 2^53 (3 panics) | value | scorex `header.ts:69-73` guards VLQ-u64 timestamp at `Number.MAX_SAFE_INTEGER` and throws; JVM carries Long (full i64). Mainnet ts ≈ 2^41 (unreachable), consensus-wrong for crafted headers. Fix-class: bigint-carrying timestamp. Blast radius ENUMERATED: scorex `header.ts` (field + parse/serialize) + 4 ergoscript files (`sheader.ts`, `method-call.ts`, `relation.ts`, `serialize-cost.ts`); **nipopow: ZERO `.timestamp` references in src** — type-level ripple only. Eval layer already carries Long as bigint → struct field + conversions only. Cross-package; scorex republish already due at v6 delivery. NOTE: fixing this UNMASKS the Header-v2 unparsedLen putUByte term (#5) on serialize_Header cost 333 — fix #5 together or first | 95% |
| 5 | serializeCost undercounts: Box −2 (×10), AvlTree −1 (×2), deserializeTo[Header] −1 (×1) | cost | **ONE root cause** (closed by orchestrator after two agent attempts stalled on envelope-vs-method reconciliation): `serialize-cost.ts` models every bare `putUByte` as cost-0, but the JVM charges PutByteCost=1 via virtual dispatch — scorex `Writer.putUByte(x)=put(x.toByte)` → `SigmaByteWriter.put(Byte):45-48` `addFixedCost(PutByteCost)`. (Bare `putUInt:105-107` genuinely charges 0 — the asymmetry P5a's transcription generalized from.) Sites: Box `ErgoBoxCandidate.scala:144` (nTokens) + `:166` (nRegs) = +2/box ✓×10; AvlTree `AvlTreeData.scala:76` (flags) = +1 ✓×2; Header-v1 solution `ErgoHeader.scala:68` (dLen) = +1 → the deserializeTo v1 entry ✓; Header-v2 `HeaderWithoutPow.scala:61-62` (unparsedLen) +1 currently MASKED by the timestamp panic (serialize_Header cost 333 needs it once #4 is fixed). Every red row = exact putUByte-site count; every putUByte-free family green. Fix-class: charge 1 per bare putUByte in the walk + sweep serialize-cost.ts for all "putUByte…=0" comment sites. P5a's 7-round review couldn't catch it — no JVM cost oracle existed for these types then (the file's own comment says so); conformance-driven > source-only, again | 97% |
| 6 | serialize(SigmaProp) (1) | value | byte path is FINE (`serializeSValue` handles SSigmaProp via `serializeSigmaBoolean`); the COST walk `serialize-cost.ts:248` default-arm throws `'global-serialize-failed'` — missing SSigmaProp arm. Fix-class: add cost arm mirroring the SigmaBoolean serializer walk (opcode 1; ProveDlog +36; DHT +144; conjectures putUShort+recurse), JVM `CoreDataSerializer.scala:45-47` | 95% |

### Vector authorship — BATCH LANDED 2026-06-06 (`santa-avl-batch-landed.md`, 7 commits, push pending)

All four families landed; dasher graded against them. **Zero new value bugs**; the only reds
are cost (folded into the +27 ledger row above). Per-family:
1. **Spec heal (+52, v5/spec)** — ✅ dasher GREEN on all 52 (21 Tier-1 props incl.
   `R9[AvlTree].get` + NEQ-nested/Advanced_Box additions). Tier-1 CONFIRMED solid; dasher
   v5/spec = 1757/1757. (SANTA fixed its OWN AvlTree result-encode bridge that the heal exposed.)
2. **AvlTree Tier-2 (+26, v5/authored)** — values all green; **22 cost reds → F4.** Blessed table:
   - get/contains present+absent @ n=8: **257** each (absent == present)
   - get proof ladder n=1..256: **207 → 357** monotone (9 points)
   - getMany k=1/2/3 @ n=16 (proofs 211/353/462 B = 4/6/8 chunks): **307 / 438 / 569** (+131 per +2 chunks +1 lookup)
   - flag-gated insert/update/remove: **58 / 58 / 42** (gate pre-verifier — cheap None)
   - valid insert/update/remove: **348 / 468 / 447**
   - cost has BOTH per-proof-chunk AND per-tree-height components (getMany @ fixed n = chunk instrument).
   - GREEN already: updateOperations/updateDigest + the 2 adversarial rejects.
3. **UBI plain-arith (+13, v6/authored)** — ✅ dasher fully GREEN value+cost (JVM flat 17/op,
   operand-size-independent; ergots matches). No work.
4. **EQ_of_SigmaProp unequal (+5, v5/authored)** — values green; **5 cost reds → F3 second arm.**
   Blessed: dlog-vs-dlog2 **176** · dlog-vs-dht **4** (node-TYPE mismatch = MatchType only, no
   ECPoint — THIRD cost class) · dht-mismatch-at-g **176** (stops after ECPoint 1) · dht-mismatch-at-v
   **692** (all 4; Δ516=3×172) · cand-second-child **350**. With identical-tree trio (224/740/398),
   F3's EQ fix now has BOTH arms pinned.

- Corpus manifest still owed (settles substConstants-v3/hasSize + the atLeast 255-cap + any
  remaining never-covered arms).

### Captured tier (provenance, learned this phase)

`transaction/*/captured` = real on-chain txs verbatim (these 4: public TESTNET, suffix =
acceptance height), each captured because it **wedged ergo-node-rust mid-sync** =
production sigma-rust↔JVM divergences; JVM-blessed `{valid:true, cost}` (ergo-core
6.0.2.1 validateStateful). Artifacts: `~/projects/santa/docs/findings/testnet-*/`.
ergots inherits sigma-rust behavior → chain-reachable class (testnet evidence; mainnet
not asserted). `bigint-downcast-2666` + `powhit-return-type-28474` have NO ergots eval-red
twin — verify ergots handles them (powhit-return-type ≈ the #877 return-type concern P5c
closed via `method-signatures.ts`); if green, route that to sigma-rust via SANTA.

**Verification results (F1 Task 5, 2026-06-06 — read-only).** All four settled; **no new
latent divergence.** Directories are descriptively named (`testnet-<slug>`); height = the
acceptance-block suffix. Per seed: eval-vector (twin or not) / ergots status / aspect of the
real tx the distilled vector does NOT cover.

| seed (height) | eval-vector | ergots status | uncovered by the distilled vector |
|---|---|---|---|
| atleast-degenerate-bound (184137) | **TWIN** — `atLeast_with_a_degenerate_bound.json` `empty-input-False#6` = `atLeast(1, Coll[SigmaProp] size 0)` → FalseProp (`d2`), cost 44 (`test/conformance/cost-v5.test.ts`, value+cost) | ✅ **FIXED by F1** — `eval/atleast.ts:72–77` bound>size → TrivialProp(false); real tx (bound 1, size 0) hits exactly that branch | real tree is a V0 self-replicating contract reading INPUTS/OUTPUTS/SELF + R4–R7 + a token; end-to-end ACCEPT through full reduce/verify needs the block tier. Vector reduces atLeast in isolation (+ a bound=256>255 superset case the tx never exercises) |
| deserialize-context (111927) | **TWIN** — `DeserializeContext_over_absent_wrong_typed_var.json` `dead-branch-absent#0` = `if(true) true else deserializeContext[Boolean](0)` → true, cost 20; `live-absent#2` → errored (`cost-v6.test.ts`, value+cost) | ✅ **FIXED by F1** — `eval/_substitute-deserialize.ts:176–202` absent/wrong-typed ctx var → leave node unchanged (JVM `None`); live-path leftover still throws at eval | real tree's `if/else` guard (HEIGHT/`SELF.R7`/`dataInputs(0).R4`/OUTPUTS/INPUTS preservation) + empty-proof ACCEPT needs the block tier; vector forces the branch dead with a constant-true `if`, not the tx's height-comparison guard. |
| bigint-downcast-v3 (2666) | NOT a twin — sigma-rust eval-blind (its runner pre-sets `tree_version`); block-tier only | ✅ **already green** — `eval/downcast.ts:131` correct V3 gate **and** `eval/evaluate.ts:75` derives `treeVersion = tree.header.version` in the production `evaluate()` path (the exact derivation the sigma-rust bug skipped, defaulting V0). Targeted check: `Downcast(BigInt(67500000000), SLong)` @V3 → `Long 67500000000` (= JVM); @V0 → throws `tree-version-too-low` | no eval-tier vector (block-tier only). No dedicated regression test of BigInt→primitive @V3 — `downcast.test.ts` is V0-only by design (a coverage gap, **not** a divergence); behavior pinned here by the targeted check + the walker's V3 tip-reach |
| powhit-return-type (28474) | NOT a twin — block-tier real tree; the distilled `map(powHit).{exists,filter,forall}` item-2 vector lives SANTA-side | ✅ **already green** — `mir/method-signatures.ts:194–197` (106,8) `tRange=SUnsignedBigInt` (closed); `mir/expr-tpe.ts:352` MethodCall → `resolveReturnTpe` ⇒ `map(powHit)` types `Coll[UnsignedBigInt]`; eval returns UnsignedBigInt (`test/eval/global-pow-hit.test.ts`, incl. V3 `evalMethodCall` round-trip; conformance `Global.powHit_*`) | the `map(powHit).exists` HOF-domain composition + the real context-guard tree's ACCEPT need the block tier; ergots pins the bare call + the type-resolution mechanism, not the map/exists composite as one vector (type resolution is deterministic from the closed signature) |

## Phased fix plan (DRAFT 2026-06-06 — awaiting user approval; nothing executes from this)

Reachability-ordered. Each phase follows the established chain (writing-plans →
subagent TDD → review → close-out) under this spec as umbrella; per-phase mini-specs
only where a phase's design space warrants one (F4 likely does). Acceptance gate per
phase: in-repo TDD green vs the blessed vectors + tsc + full suite, then a SANTA
re-grade confirming exactly the predicted row flips. End state: **eval reds 0**.

### ✅ RESOLVED — F1 DC dead-branch cost 20-vs-12 (2026-06-06)

DC core fix was correct on value+error. The cost 20-vs-12 question was resolved via SANTA
Decision A: SANTA re-blessed the two dead-branch entries 12→20 (santa@`9167d38`). ergots'
20 is correct — `treeHasDeserialize` triggers a `substituteConstants` pre-pass (CP→Const at
cost 5 vs lazy CP at cost 1), validated at h=3850 and by `evaluate-cost-deserialize-segregated.test.ts`.
The SANTA-blessed vectors now show cost 20, conformance green. DC fix committed `5580a75` /
`b614d6e`. EvalError `'deserialize-context-key-not-found'` removed (81→80 at that step,
combined with Task 2's `'atleast-bound-out-of-range'` removal: net 81→79).

### F1 — chain-reachable value forks (atLeast + DeserializeContext)  ·  closes 6 rows  ·  ✅ DONE 2026-06-06 (commits `eb09892`/`f5dd083` atLeast, `5580a75`/`b614d6e` DC)
- **atLeast degenerate bounds** (root cause #2): add the JVM trivial-prop reductions
  (bound≤0 → TrivialProp(true); bound>size → TrivialProp(false)) to `eval/atleast.ts`,
  preserving the live CAND/COR/CTHRESHOLD paths. TDD: all 7 family entries (4 red + 3
  green pins).
- **DC dead-branch** (root cause #3): failure-tolerant substitution in
  `_substitute-deserialize.ts` — absent (:176) / wrong-typed (:182) ctx var + the
  register wrong-type site (:244) return the node unchanged instead of throwing; the
  existing eval-time defensive throw covers live branches. TDD: 4 family entries
  (2 red dead-branch + 2 green live-branch). Dead-branch cost = 20 (production
  substituteConstants; re-blessed 12→20, Decision A).
- **Captured-twin closure, both directions:** read
  `~/projects/santa/docs/findings/testnet-{111927,184137}/` to confirm the distilled
  vectors faithfully represent the wedge txs; read the other two
  (`bigint-downcast-2666`, `powhit-return-type-28474`) and confirm ergots handles their
  eval shapes (expected: yes) — report the result to SANTA either way.
- **Optional rider (user call):** the atLeast 255-children cap (bonus find, currently
  vectorless). Same file under surgery; would land source-pinned + unit-tested, with
  the conformance vector following via SANTA's queue. IN or defer to F5?

### F2 — timestamp bigint + the putUByte cost class  ·  ✅ DONE 2026-06-06 (commits `7bf3bff..531c8fa`, 9 commits)

**Outcome:** 16 rows closed at blessed costs. All 6 SANTA vectors green (Box ×8 cost 139–178, Box_Int ×2 cost 142/146, AvlTree ×2 cost 127, serialize_Header 333, deserializeTo_header 677/804, Header_new_methods 774). Zero remaining F2 work. **Two review-caught bonus consensus fixes:**
1. **VLQ u64 wrap** (`7bf3bff`→`1aacca1`+`6b46fd2`): `decodeVlqU`/`ByteReader.readVlqBigInt` now wrap mod 2^64 (`BigInt.asUintN(64,·)`) matching sigma-rust `get_u64` / JVM `getULong` protobuf loop; `encodeVlqU`/`writeVlqBigInt` reject inputs > u64. A genuine consensus correctness fix caught during code review.
2. **SHeader/SPreHeader signed-i64 view** (`5a2d979`+`31d2dabc`): the eval accessors for `.timestamp` now present `BigInt.asIntN(64, value)` (signed i64 view) rather than the raw u64 — matching JVM `as Long` semantics; u64-max surfaces as Long(−1) not a large positive bigint.

**putUByte=1 model verified 4 ways:** JVM dispatch chain (`Writer.putUByte`→`put(x.toByte)`→`SigmaByteWriter.put(Byte):45-48`→`addFixedCost(PutByteCost=1)`); scorex-util jar bytecode; eni `add_put_byte_cost` sites; arithmetic confirmation from the blessed row `serialize_Header: 333 = StartWriter(10) + serializeHeaderWithoutPow(244) + putUByte(1) + powSolution(78)`.

**eni type-length divergence flagged for routing (pending user go):** eni does NOT charge the four type-serializer length-byte `put_u8` sites (>4-tuple len `types.rs:456`, SFunc tDom len `:467`, SFunc tpeParams len `:475`, STypeVar name len `types/stype_param.rs:81`) NOR the STypeVar name-bytes chunk cost (`types/stype_param.rs:81-82`). JVM is canonical; only the >4-tuple site is adversarially reachable (5-tuple register types, cost pin 84). ✅ ROUTED 2026-06-06 + SANTA-verified in place (all five sites confirmed real against `.santa/blitzen-eni` @ `dae8443f`; path erratum adopted here; costing lands `jit-costing-final` first per maintainer rule). See §Coordination.

**Gate:** avltree 156 / ergoscript 3987 / nipopow 247 / scorex 187 — all green; tsc clean.

**Note on row count:** the plan said "closes 19 rows (3 panics + 16 cost)". The 3 panic rows and the 16 cost rows were double-counted across both the panic bucket and the cost bucket in the earlier arithmetic — the correct count of distinct dasher reds closed is **16** (the 3 panics are a subset of the 16 putUByte/timestamp cost rows; they all flip together). The re-grade table below is corrected.

- ~~scorex `Header.timestamp` number→bigint (root cause #4)~~ ✅ done `7bf3bff`
- ~~putUByte = 1 sweep (root cause #5)~~ ✅ done `02b17fe`, `855044b`, `6bfae86`

### F3 — cost-only remainder (EQ_of_SigmaProp + serialize(SigmaProp))  ·  closes 8 rows (3 identical + 5 unequal EQ + serialize_SigmaProp)
- **EQ_of_SigmaProp** (root cause #1): recursive SigmaBoolean cost walk in
  `relation.ts` — MatchType(1) per node + EQ_GroupElement(172) per ECPoint + outer
  MatchType, mirroring JVM `DataValueComparer` incl. && short-circuit. **BOTH arms now
  vectored (batch landed):** identical-tree `EQ_of_SigmaProp` (224/740/398) + unequal
  `EQ_of_SigmaProp_unequal` (176/4/176/692/350). The unequal arm pins the short-circuit AND
  a THIRD cost class — node-TYPE mismatch (dlog-vs-dht) = MatchType only, NO ECPoint compare
  = cost 4. Walk must short-circuit on first node-type mismatch (no ECPoint) and on first
  ECPoint inequality (charge ECPoints compared, not all). Vendor both v5/authored files.
- **serialize(SigmaProp) cost arm** (root cause #6): add the SSigmaProp arm to
  `serialize-cost.ts` mirroring the `serializeSigmaBoolean` walk (opcode 1; ProveDlog
  +36; DHT +144; conjectures putUShort(3) + recurse). TDD: the 1 blessed entry +
  composite-prop unit pins.

### F4 — AvlTree Tier-2 cost faithfulness (the original P7b finding)  ·  closes 22 cost rows
Transcribe the JVM cost model into the 7 Tier-2 handlers (`savltree.ts`):
createVerifier PerItem(110,20,64) on proof length · flag-check Fixed(15) (insertOrUpdate
charges both) · per-op × max(treeHeight,1): lookup (40,10,1), insert (40,10,1), remove
(100,15,1), update (exact constants transcribed in-phase) · updateDigest Fixed(40) on
success · remove's unconditional digest Fixed(15). eni (`dc0adbe8`) as TS-adjacent
second read — it landed the same model. **Vectors LANDED (batch 2026-06-06):** 9
`AvlTree.*.json` v5/authored files; values green, 22 cost reds are the TDD target — full
blessed table in the authorship section above (get/contains 257 · ladder 207→357 · getMany
307/438/569 · flag-gated 58/58/42 · valid 348/468/447; dual chunk+height cost). Sequencing
flexible — F4 may run before F3. Warrants its own mini-spec (DynamicCost + the chunk-vs-height
cost decomposition + proof-shape coverage).

### F5 — manifest-derived gap-fill (CONTENT LANDED 2026-06-06 — manifest received)

**Manifest:** `~/projects/santa/docs/coverage/eval-coverage.json` (`santa-coverage/v1`,
suite-gated current; consumer doc `docs/coverage/README.md`; announcement
`santa-to-ergots-coverage-manifest.md`). 155 families · 2,143 entries (1,952 accept /
191 reject) · 75 ops · 95 methods. Diff vs our registry @ `56582c5` (125 keys):
- **Corpus ∖ registry = `99:7` only** (their adversarial getRegV5 — correctly
  unregistered). **Zero genuine eval not-impls our side** — triage §3 re-confirmed.
- **Registry ∖ corpus = 31 keys implemented but never exercised** (the authoring
  demand list): Header accessors `104:1..15` (ALL — only checkPow 104:16 covered;
  F2-adjacent: accessor-read vectors would pin timestamp>2⁵³ at the EVAL tier) ·
  Context props `101:1/2/3/8/9/10` (first four method-only; 101:9/10 op-forms also
  absent) · PreHeader accessors `105:2/3/5/6` (zero 105:* coverage) · UBI `9:18 mod` +
  `9:19 toSigned` · AvlTree `100:16 insertOrUpdate` · Option `36:7 map` · Global
  `106:9 some` + `106:10 none`. Re-diff post-F2: extract keys, set-diff vs
  `jq -r '.method_index | keys[]' eval-coverage.json`.
- **substConstants v3+hasSize: SETTLED — covered on BOTH readings** (outer tree
  `Fix_substConstants_in_v6.0_…` is v3+hasSize ×2 accepts; entry #1 embeds a
  `0x1b`-header v3+size+segregation script as the bytes argument). Optional small
  authoring: an embedded-v3 REJECT twin (truncated-size) if hardening wants it.
- Manifest limits (honest): structural presence not edge-depth; embedded script
  bytes are data (not walked); our minVersion gates not modeled in the diff.

F5 members now: the 31-key vector-authoring batch (priority answer owed to SANTA —
their suggested first block = the 15 Header accessors, which also empirically pins
F2's ≥2⁵³/≥2⁶³ timestamp behavior) · signed-view sweep + its vectors (see §Coordination
F2 final-review finding — Box.value/R0/token-amount ≥2⁶³, vectors FIRST to pin the JVM
before coding) · atLeast 255-cap vector + fix (+ the JVM-vs-eni ordering verification
below) · optional substConstants embedded-reject twin · the full-corpus vendoring task
(Decision #3 middle path) · 5-tuple-register serialize vector (from the eni routing
note's ask #2).
- **atLeast 255-CHILDREN cap (sharpened by the F1 Task-2 review, 2026-06-06):** ergots
  enforces NO cap on the input-coll length (`ConcreteCollection` parses to u16=65535;
  `extractSigmaPropColl`/`cthresholdReduce` uncapped) → `atLeast(k, Coll[SigmaProp] of
  >255)` reduces where BOTH the JVM (`MaxChildrenCount=255`) and canonical sigma-rust
  e-n-i (`BoundedVec<_,1,255>`) reject — pre-existing adversarial accept-where-reject
  fork, widened slightly by F1 (the removed `k>255` bound guard had accidentally caught
  the `k>255 ∧ >255-children` subset). **OPEN ordering question (needs JVM verification
  — reviewer-claimed, NOT yet confirmed):** e-n-i applies the cap AFTER the degenerate
  reductions (cap only in the non-degenerate path), so it returns TrueProp for
  `atLeast(≤0, >255 children)`; the reviewer claims JVM `CSigmaDslBuilder.atLeast`
  checks `props.length>255` BEFORE `reduce` → would throw. If true, that's a SECOND
  JVM↔sigma-rust fork (degenerate-reduce-vs-cap ordering). F5 must: (a) verify JVM
  ordering from `CSigmaDslBuilder.scala` + `trees.scala`; (b) place the cap per the JVM;
  (c) get a SANTA vector for `atLeast(≤0, >255 children)` to pin the ordering. Adversarial-
  only (compilers never emit >255-prop atLeast), no honest/mainnet path.

### Re-grade prediction table (the phase-gate oracle) — updated for the 74-row surface

Eval-tier reds at F1 start = 53 (the 47-row inventory's 26 ergots-bug minus the 21 tx-scope
that aren't eval-tier… recount: dasher 74 = 26 orig ergots-bug + 21 tx + 27 batch; eval-tier
ergots-bug reds = 74 − 21 tx = 53). Atleast's 4 already flipped (Task 2 committed).

| after | eval-tier reds remaining | flips |
|---|---|---|
| Task 2 (✅ done `eb09892`) | 49 | −4 atLeast value |
| F1 Task 3 (✅ done `5580a75` — DC cost resolved: SANTA re-blessed 12→20, Decision A) | 47 | −2 DC value |
| F2 ✅ DONE | **31** | −16 (timestamp+putUByte cost rows, incl. the 3 that were panicking). *(The old "−19" arithmetic double-counted the 3 panic rows across both the "panics" and "cost" subtotals — they are the same rows. Correct flip count = 16.)* |
| F3 | 22 | −9 (EQ_of_SigmaProp: 3 identical + 5 unequal = 8 rows; serialize_SigmaProp: 1 row) |
| F4 | 0 eval-tier ergots-bug reds | −22 AvlTree Tier-2 cost (after F3: 22 remaining = exactly the 22 AvlTree Tier-2 cost rows; tx-tier 21 stay out-of-scope) |
| F5 | gap-fill; NEW green pins extend corpus | |

(tx-tier 21 stay out-of-scope unless the codec decision flips them in. After F4, eval-tier ergots-bug reds = 0.)

### Decisions needed before/during execution (user)
1. F1 rider: atLeast 255-cap in F1 or F5?
2. tx-tier scope (21 not-impl rows): Transaction codec on the roadmap (own future
   phase, NOT part of this plan) or acknowledged-gap (rows stay as growth ledger)?
3. Corpus vendoring policy: ✅ **RESOLVED 2026-06-06 (user) — middle path.** Vendor the
   FULL green corpus (2.9 MB / 155 files / 2143 entries) into `test/fixtures/conformance/`
   as permanent regression pins, with SANTA as upstream: one-command re-sync (`cp -r` +
   git-diff review) at phase boundaries, so staleness vs SANTA re-blessings is bounded by
   a phase. Lands as its own task at F5/close-out — per-phase subsets continue through
   F2–F4 (not load-bearing mid-run). Flow is BIDIRECTIONAL: ergots-side authored
   tests/vectors flow back to SANTA, which redistributes them to grade all the other
   implementations (the established ergots-leads pattern).
4. Process weight per fix phase: full chain incl. brainstorm for each, or
   writing-plans→TDD→review under this umbrella (recommended for F1–F3; F4 gets a
   mini-spec)?

## Done criteria

- [x] UBI re-grade consumed; surviving rows re-triaged (47 = 26 diagnosed + 21 scope)
- [x] Every ergots-bug family root-caused at ≥95% confidence (6 root causes, 95–99%)
- [x] Gap inventory settled against the corpus manifest — ✅ manifest received 2026-06-06 (`eval-coverage.json`): zero genuine not-impls our side; substConstants-v3 SETTLED-covered (hypothesis refuted); avltree settled via the Tier-2 batch (→F4); 31-key never-exercised list = F5 authoring demand; atLeast 255-cap remains vectorless (→F5 member). Gap-FILL itself is F5 execution, tracked there.
- [x] Captured-tx twins verified both directions (our 2 reds; their 2 possible-greens) — folded into F1 (Task 5, 2026-06-06: 4/4 settled, no new latent divergence — see Captured tier)
- [x] Phased fix plan DRAFTED (F1–F5 above), reachability-ordered — **user approval pending**
- [ ] Open scope questions answered: tx codec in/out; corpus vendoring policy; F1 rider; per-phase process weight

## Coordination

SANTA channel: kitty win 2 (autonomous messaging granted 2026-06-06; file routing still
per-authorization). sigma-rust session: kitty win 3 (no direct grant — route via SANTA
or user). This spec is the phase's living ledger; update tables in place.

**F2 follow-up — eni type-length divergence routing: ✅ ROUTED 2026-06-06 (user-authorized).**
`~/projects/santa/prompts/ergots-eni-serialize-type-length-cost-divergence.md` + kitty ping (win 7).
Content: the 4 uncharged type-serializer length-byte `put_u8` sites (>4-tuple `types.rs:456`,
SFunc tDom `:467`, SFunc tpeParams `:475`, STypeVar name `types/stype_param.rs:81`) + the STypeVar
name-bytes chunk cost, with the JVM dispatch-chain proof (verified 4 ways incl. scorex-util jar
bytecode) and an honest "not verified either way" flag on eni's expr-Tuple count byte. Asks:
sigma-rust alignment + a low-priority 5-tuple-register vector. Awaiting SANTA ack / sigma-rust fix.

**F2 final-review finding — signed-view sweep (follow-up phase item, pre-existing, NOT an F2 regression):**
the signed-i64-view principle F2 established for the two timestamp accessors stops there; four other
u64-wire→SLong surfaces still present the raw unsigned bigint for values ∈ [2^63, 2^64):
`extract-amount.ts:48` (Box.value), `extract-register-as.ts:95` (R0), `extract-register-as.ts:72` +
`method-call.ts:1240` (token amounts). The JVM (canonical) parses these via unbounded `getULong()`
(`ErgoBoxCandidate.scala:193/:212/:220`) and surfaces them as SIGNED Longs (`:71`); sigma-rust instead
REJECTS at parse (`BoxValue`/`TokenAmount::try_from`) — an eni-vs-JVM divergence in its own right.
ergots currently accepts like the JVM but surfaces an out-of-i64-range positive 'Long' = neither
reference. Fix class: `BigInt.asIntN(64, ·)` at the four surfaces + JVM DataSerializer-path verify
(adversarial-verify rule) + SANTA vector request (Box value / token amount ≥ 2^63, AND a ≥2^63
Header-timestamp vector to pin F2's asIntN sign-flip empirically — currently unit-pinned only).
Candidate slot: F5 or its own micro-phase; does not gate F3/F4.

**→ JVM-ADJUDICATED 2026-06-06/07 (SANTA spike, `santa-header-signedview-spike-findings.md`):
the JVM uniformly blesses the SIGNED view** — no oracle crash anywhere: `new ErgoBox(value=-1L)`
constructs; spliced u64-max box bytes parse to `value == -1L` (confirms our unbounded-getULong
reading); eval surfaces `SELF.value` → Long(-1) **cost 18** · `SELF.R0[Long].get` → Long(-1)
**cost 75** · `SELF.tokens(0)._2` → Long(-1) **cost 70** · `preHeader.timestamp` → Long(-1)
**cost 34** (= our F2 unit pin, pre-confirmed) · Header accessors flat **cost 39** (3-range
timestamp incl. u64-max → -1). The asIntN(64) fix class is CONFIRMED faithful. Incoming vectors
use the Box INPUT channel (`{ (b: Box) => b.value }` over `{kind:'Box', bytes_hex}`) — pins the
exact hydration seam where sigma-rust's `try_from` fires (their boxes never hydrate → routed to
sigma-rust develop-first with the vectors, per their maintainer rule). Until ergots applies the
asIntN fix, these vectors will RED on us (raw unsigned bigint ≥2⁶³) — the micro-phase should
ideally land BEFORE the batch arrives.
