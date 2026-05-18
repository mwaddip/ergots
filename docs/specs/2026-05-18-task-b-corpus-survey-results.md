# Task B — Wider Mainnet Corpus Survey Results

**Generated:** 2026-05-18T10:46:10.727Z
**Source fixture:** `packages/ergoscript/test/fixtures/mainnet_boxes_wider.json`
**Total boxes analyzed:** 12712 (random=10000, mustInclude=2712)
**Parse failures:** 0 (rate: 0.00%)

## Top-level Expr tag frequencies

| Tag | Total nodes | Distinct boxes | Random | Must-include |
|---|---|---|---|---|
| Const | 7147 | 6616 | 4966 | 2181 |
| BoolToSigmaProp | 9566 | 6101 | 8984 | 582 |
| BinOp | 75124 | 6099 | 69671 | 5453 |
| ConstPlaceholder | 54320 | 6099 | 50190 | 4130 |
| GlobalVars | 38010 | 6078 | 34740 | 3270 |
| SelectField | 18951 | 6036 | 17841 | 1110 |
| ByIndex | 31699 | 5290 | 30122 | 1577 |
| ExtractScriptBytes | 9747 | 5146 | 9017 | 730 |
| CreateProveDlog | 4777 | 4707 | 4397 | 380 |
| ExtractCreationInfo | 4564 | 3500 | 4056 | 508 |
| SizeOf | 4168 | 3186 | 3757 | 411 |
| SigmaAnd | 4388 | 2850 | 4207 | 181 |
| Collection | 7215 | 2820 | 6447 | 768 |
| And | 4015 | 2807 | 3599 | 416 |
| DecodePoint | 2661 | 2660 | 2364 | 297 |
| SubstConstants | 2647 | 2647 | 2351 | 296 |
| ValUse | 77927 | 2596 | 73786 | 4141 |
| BlockValue | 4344 | 2577 | 4088 | 256 |
| ValDef | 21120 | 2577 | 19675 | 1445 |
| PropertyCall | 9929 | 2576 | 9437 | 492 |
| OptionGet | 11279 | 2516 | 10668 | 611 |
| ExtractRegisterAs | 12778 | 2503 | 12148 | 630 |
| ExtractAmount | 7412 | 2462 | 6975 | 437 |
| OptionIsDefined | 3464 | 1810 | 3430 | 34 |
| SigmaOr | 1761 | 1721 | 1709 | 52 |
| GetVar | 1702 | 1590 | 1691 | 11 |
| LogicalNot | 1547 | 1532 | 1538 | 9 |
| If | 5739 | 1021 | 5506 | 233 |
| Upcast | 2805 | 772 | 2213 | 592 |
| FuncValue | 2242 | 609 | 2089 | 153 |
| ExtractId | 562 | 464 | 493 | 69 |
| Context | 465 | 457 | 406 | 59 |
| Or | 449 | 447 | 394 | 55 |
| CalcBlake2b256 | 1125 | 442 | 1050 | 75 |
| Filter | 591 | 338 | 578 | 13 |
| Fold | 501 | 310 | 454 | 47 |
| Apply | 1104 | 279 | 985 | 119 |
| Tuple | 522 | 250 | 483 | 39 |
| Map | 342 | 246 | 312 | 30 |
| ForAll | 307 | 168 | 287 | 20 |
| Slice | 241 | 145 | 239 | 2 |
| CreateProveDhTuple | 157 | 120 | 143 | 14 |
| Global | 120 | 120 | 110 | 10 |
| SigmaPropBytes | 124 | 107 | 93 | 31 |
| Exists | 118 | 87 | 115 | 3 |
| Negation | 103 | 51 | 67 | 36 |
| Append | 200 | 51 | 200 | 0 |
| MethodCall | 97 | 41 | 97 | 0 |
| ByteArrayToLong | 645 | 33 | 645 | 0 |
| Atleast | 13 | 13 | 12 | 1 |
| OptionGetOrElse | 24 | 7 | 20 | 4 |
| DeserializeContext | 5 | 5 | 3 | 2 |
| ExtractBytes | 3 | 3 | 2 | 1 |
| Downcast | 7 | 3 | 7 | 0 |
| LongToByteArray | 3 | 3 | 3 | 0 |
| ExtractBytesWithNoRef | 2 | 1 | 2 | 0 |

## Method-call (typeId, methodId) pair frequencies

| typeId | methodId | Sigma-rust name | Total | Distinct boxes | Random | Must-include | Implemented? |
|---|---|---|---|---|---|---|---|
| 99 | 8 | SBox.tokens | 9253 | 2575 | 8834 | 419 | ✅ 2g.5 |
| 101 | 1 | SContext.dataInputs | 458 | 453 | 403 | 55 | ✅ 2g.5 |
| 106 | 1 | SGlobal.groupGenerator | 120 | 120 | 110 | 10 | ❌ |
| 12 | 29 | SColl.zip | 40 | 35 | 40 | 0 | ❌ |
| 100 | 1 | SAvlTree.digest | 70 | 33 | 70 | 0 | ❌ |
| 100 | 13 | SAvlTree.update | 35 | 33 | 35 | 0 | ❌ |
| 12 | 14 | SColl.indices | 13 | 8 | 13 | 0 | ❌ |
| 105 | 3 | SPreHeader.timestamp | 7 | 7 | 3 | 4 | ❌ |
| 101 | 3 | SContext.preHeader | 7 | 7 | 3 | 4 | ❌ |
| 100 | 12 | SAvlTree.insert | 3 | 3 | 3 | 0 | ❌ |
| 100 | 11 | SAvlTree.getMany | 9 | 3 | 9 | 0 | ❌ |
| 100 | 10 | SAvlTree.get | 4 | 2 | 4 | 0 | ❌ |
| 12 | 15 | SColl.flatten | 4 | 2 | 4 | 0 | ❌ |
| 12 | 26 | SColl.indexOf | 2 | 2 | 2 | 0 | ✅ 2g.5 |
| 7 | 2 | SGroupElement.getEncoded | 1 | 1 | 1 | 0 | ❌ |

## Currently-unimplemented arms hit

| Tag | Distinct boxes | Example boxIds |
|---|---|---|
| DecodePoint | 2660 | 960b27bcf62ca2a621495e2a06a64e26ccc7159212de53c1b13c729295edc5f7, de3094f7b87f2fce950f31a8723b3b0c52fd44fa3dd5fe2d9c95273bdf75bc1c, 8b15345c26773c92731802b0fdf1df55713b6610a943a741740ec6c10bafff42 |
| SubstConstants | 2647 | 960b27bcf62ca2a621495e2a06a64e26ccc7159212de53c1b13c729295edc5f7, de3094f7b87f2fce950f31a8723b3b0c52fd44fa3dd5fe2d9c95273bdf75bc1c, 8b15345c26773c92731802b0fdf1df55713b6610a943a741740ec6c10bafff42 |
| CalcBlake2b256 | 442 | fbaa13b87515b2023cda4c2a541aed6983cbec0e2d9e196ac8cdd21d43eb6ced, 1b5e68b9bcf640f7e3ec23ee96eb32ca5801f896d7f9d0cec1d3506a91318479, 57eb7ee4f0a8c6560af0fd16bd339a2fe270d0af163f3ef044c1275ef45e8e67 |
| Global | 120 | 1b5e68b9bcf640f7e3ec23ee96eb32ca5801f896d7f9d0cec1d3506a91318479, 57eb7ee4f0a8c6560af0fd16bd339a2fe270d0af163f3ef044c1275ef45e8e67, 25668cfa791821a3b6f5a451435cdae987cd7cb1d474eec8b0e87314596623ec |
| ByteArrayToLong | 33 | fbdf13295f9a8987e0559b49b1fff4f16be7077998cf1b4b766ac3dd54551bcd, ea8e0992bc0d7958ea02831726cfb222bfe4072150947cb750de899b91cd39d1, 6de7d1f1a87852c31f83d704cb3c3e2a98e72c5e46b5d1e09aeaf206ab2ab4bc |
| DeserializeContext | 5 | fdcb9fcb2075e10e79ef608de2523b3e576ecf2bc7f8960599e3e9a4f968803e, 10938fd14fa900b217d4c0e23f065e216e67252090d682ec3a7a20d2c176ed9e, a98ff44b5b5091aefb118949f961dfb7335f225d99349b1c455f924e0a8d0755 |
| LongToByteArray | 3 | 6446283848ee971bb331a0bab56f52b4510bc072ca226aec378a849abd3ae9f9, f41287a15ccb4ea8bf290f3867ae431188fe74b4b3936d031234801434d8454e, 692c9161704ecafe20d7ca60357e7df98d1fb70f438cb661e88eec86aa5f2c17 |

## Parse failures

| Error class.code | Count | Example boxIds |
|---|---|---|

## Phase 2g.6 prioritization (clustered + tiered)

Based on the source-segmented tally above, phase 2g.6 should land the
following method handlers. Methods are grouped by responsibility area
and tiered by demand. AVL+ methods are deferred to phase 2h per the
umbrella spec's separation; AVL+ method-pairs surfaced by the survey are
listed at the bottom for phase 2h planning to consume.

### Tier 1 — High demand, must land in 2g.6 (>= 30 distinct boxes)

| Rank | (typeId, methodId) | Method | distinctBoxes | random | mustInclude | sigma-rust source |
|---|---|---|---|---|---|---|
| 1 | (106, 1) | `SGlobal.groupGenerator` | 120 | 110 | 10 | `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sglobal.rs:49` |
| 2 | (12, 29) | `SColl.zip` | 35 | 40 | 0 | `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scoll.rs:103` |

### Tier 2 — Moderate demand or must-include-relevant (should land in 2g.6)

| Rank | (typeId, methodId) | Method | distinctBoxes | random | mustInclude | sigma-rust source |
|---|---|---|---|---|---|---|
| 3 | (12, 14) | `SColl.indices` | 8 | 13 | 0 | `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scoll.rs:123` |
| 4 | (105, 3) | `SPreHeader.timestamp` | 7 | 3 | 4 | `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/spreheader.rs:63` |
| 5 | (101, 3) | `SContext.preHeader` | 7 | 3 | 4 | `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scontext.rs:72` |

### Tier 3 — Long-tail (deferred to a future slice)

| Rank | (typeId, methodId) | Method | distinctBoxes | random | mustInclude |
|---|---|---|---|---|---|
| 6 | (12, 15) | `SColl.flatten` | 2 | 4 | 0 |
| 7 | (7, 2) | `SGroupElement.getEncoded` | 1 | 1 | 0 |

### Deferred to phase 2h — AVL+ tree methods (not phase 2g.6 scope)

These methods surfaced in the survey but belong to phase 2h's AVL+ tree
surface (per the umbrella spec). Listed here for phase 2h planning.

| (typeId, methodId) | Method | distinctBoxes | random | mustInclude |
|---|---|---|---|---|
| (100, 1) | `SAvlTree.digest` | 33 | 70 | 0 |
| (100, 13) | `SAvlTree.update` | 33 | 35 | 0 |
| (100, 12) | `SAvlTree.insert` | 3 | 3 | 0 |
| (100, 11) | `SAvlTree.getMany` | 3 | 9 | 0 |
| (100, 10) | `SAvlTree.get` | 2 | 4 | 0 |

### Phase 2g.6 scope summary

- **Tier 1 (must land):** 2 methods — `SGlobal.groupGenerator`, `SColl.zip`
- **Tier 2 (should land):** 3 methods — `SColl.indices`, `SPreHeader.timestamp`, `SContext.preHeader`
- **Tier 3 (defer):** 2 methods — `SColl.flatten`, `SGroupElement.getEncoded`
- **Phase 2h handoff:** 5 `SAvlTree.*` methods documented above for 2h planning

Total phase 2g.6 method-handler implementation effort: 5 methods (Tier 1 + Tier 2) at ~2-4 hours per method (TDD discipline, fixture-driven). Estimated ~10-20 hours of focused implementation work.

### Implementation guidance for the phase 2g.6 design spec

For each Tier 1 + Tier 2 method:
1. Read sigma-rust source (linked in the table) to confirm cost pattern
   (Pattern A vs B per memory `reference_cost_charging_order_patterns`),
   return-value shape, and any defensive-error cases.
2. Author a fixture-gen case (one per method) producing
   `(tree, context) -> (value, cost)` test vectors.
3. Implement the TS handler in `eval/method-call.ts` (extend the
   existing `HANDLERS` registry from phase 2g.5).
4. Wire the C1 fixture + per-method tests; verify against sigma-rust's
   `try_eval_out` oracle at fixture-gen time.

### Other observations from the survey

- **Handoff projection accuracy:** The original handoff (per 2g.5 design
  spec) projected 2g.6 to cover Header methods, additional Coll utilities
  (`.indices`, `.zip`, `.zipWith`, `.reverse`, `.flatten`, `.getOrElse`),
  and BinOp Bit shifts via SNumericTypeMethods. The wider-corpus survey
  confirmed some (`SColl.zip`, `SColl.indices`, `SColl.flatten`) but
  measured zero demand for `SColl.zipWith`, `SColl.reverse`,
  `SColl.getOrElse`, BinOp Bit shifts, and most SHeader methods. The
  survey also surfaced `SGlobal.groupGenerator` as the highest-demand
  unimplemented method (not in the handoff projection at all).
- **Parse failures:** 0 out of 12,712 boxes. The wire-layer parser is
  solid on real mainnet activity.
- **Unimplemented Expr-arm signal:** The `unimplementedHits` section
  shows three arms with significant distinct-box counts beyond AVL+:
  `DecodePoint` (2,660 boxes), `SubstConstants` (2,647 boxes), and
  `CalcBlake2b256` (442 boxes). `ByteArrayToLong` appears at 33 boxes.
  `DeserializeContext` and `LongToByteArray` appear at low counts (5 and
  3 respectively). `Global` at 120 boxes corresponds to
  `SGlobal.groupGenerator` already captured in Tier 1. `DecodePoint`,
  `SubstConstants`, and `CalcBlake2b256` are candidates for phase 2i
  predefs or a dedicated crypto-ops slice; they collectively cover a
  large fraction of mainnet script activity and merit their own spec
  before 2g.6 work closes out.
