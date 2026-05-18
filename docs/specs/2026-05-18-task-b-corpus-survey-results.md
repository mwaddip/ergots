# Task B — Wider Mainnet Corpus Survey Results

**Generated:** 2026-05-18T14:22:41.200Z
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
| 106 | 1 | SGlobal.groupGenerator | 120 | 120 | 110 | 10 | ✅ 2g.6 |
| 12 | 29 | SColl.zip | 40 | 35 | 40 | 0 | ✅ 2g.6 |
| 100 | 1 | SAvlTree.digest | 70 | 33 | 70 | 0 | ❌ |
| 100 | 13 | SAvlTree.update | 35 | 33 | 35 | 0 | ❌ |
| 12 | 14 | SColl.indices | 13 | 8 | 13 | 0 | ✅ 2g.6 |
| 105 | 3 | SPreHeader.timestamp | 7 | 7 | 3 | 4 | ✅ 2g.6 |
| 101 | 3 | SContext.preHeader | 7 | 7 | 3 | 4 | ✅ 2g.6 |
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
| ByteArrayToLong | 33 | fbdf13295f9a8987e0559b49b1fff4f16be7077998cf1b4b766ac3dd54551bcd, ea8e0992bc0d7958ea02831726cfb222bfe4072150947cb750de899b91cd39d1, 6de7d1f1a87852c31f83d704cb3c3e2a98e72c5e46b5d1e09aeaf206ab2ab4bc |
| DeserializeContext | 5 | fdcb9fcb2075e10e79ef608de2523b3e576ecf2bc7f8960599e3e9a4f968803e, 10938fd14fa900b217d4c0e23f065e216e67252090d682ec3a7a20d2c176ed9e, a98ff44b5b5091aefb118949f961dfb7335f225d99349b1c455f924e0a8d0755 |
| LongToByteArray | 3 | 6446283848ee971bb331a0bab56f52b4510bc072ca226aec378a849abd3ae9f9, f41287a15ccb4ea8bf290f3867ae431188fe74b4b3936d031234801434d8454e, 692c9161704ecafe20d7ca60357e7df98d1fb70f438cb661e88eec86aa5f2c17 |

## Parse failures

| Error class.code | Count | Example boxIds |
|---|---|---|

## Phase 2g.6 prioritization (raw — Task 6 authors the clustered version below)

| Rank | typeId | methodId | Method | distinctBoxes | Random | Must-include |
|---|---|---|---|---|---|---|
| 1 | 100 | 1 | SAvlTree.digest | 33 | 70 | 0 |
| 2 | 100 | 13 | SAvlTree.update | 33 | 35 | 0 |
| 3 | 100 | 12 | SAvlTree.insert | 3 | 3 | 0 |
| 4 | 100 | 11 | SAvlTree.getMany | 3 | 9 | 0 |
| 5 | 100 | 10 | SAvlTree.get | 2 | 4 | 0 |
| 6 | 12 | 15 | SColl.flatten | 2 | 4 | 0 |
| 7 | 7 | 2 | SGroupElement.getEncoded | 1 | 1 | 0 |
