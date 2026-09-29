# 2026-09-28 — A size-flagged ErgoTree's declared size: parse like the JVM, re-encode box trees

**Status:** the design was agreed with the user on 2026-09-28, section by section. It was then amended after three adversarial review passes the same day, and every finding was re-verified against source:
- first pass: C1–C3, I1–I8 and M1–M4;
- second pass: C-N1, C-N2, I-N1 and I-N2, plus minor points;
- third pass: two clarifications (where the register check runs, and `boxTreeOf`'s miss rule), plus minor points.

After the first pass the user decided two points: the method catalog becomes a residual with its own follow-up spec, and the count caps are in scope.

**Amended during implementation** (2026-09-28 and 2026-09-29), each change re-verified against source: §4 (the declared `SAny`), §5 (the audited sites), the §2 pseudo-code (a nested degrade past the end), §8 (the miss rule), residuals 1 and 4, two citations under "Register values", and the follow-ups that implementation surfaced. The user decided one more point: `parseTransaction` forces each output tree's re-encoding at parse, as ergo-core's eager transaction id does (§9).

**Amended after the final review** (2026-09-29), each change checked against a live sigma-state 6.0.6 probe: §4 (`ByIndex` over a tuple, the JVM's `SAny`), §6 (a register's lead byte), §7 (the re-encoding follows each node's JVM companion; the Box index is written within a Short), §8 (the miss rule's span check), §12 (the output check against the chain's box bytes), the behavior matrix, residuals 1, 4 and 5, the new residual 11, the follow-ups, and the SANTA requests.

**Amended in the final fix's second round** (2026-09-29), each change checked against a live sigma-state 6.0.6 probe: §4 (`exprTpe` throws where the JVM's `tpe` casts or requires the JVM's `SAny`; `NOTYPE_JVM`), §8 (a span inside the size VLQ, decided exactly), the behavior matrix, residual 1, the node-construction follow-up, a new follow-up for the `DeserializeRegister` default check, and the vectors wanted.

**Shipped with open findings** (2026-09-29, the user's decision). The second round's re-review found that the spend-time substitution follows neither the JVM nor master (the new residual 12), and that `Upcast` and `Downcast` belong to the node-construction class. Both close with the next spec, the JVM's construction-time type reads at parse and after substitution (Follow-ups). §4, the residuals, the follow-ups and the vectors wanted are corrected to match.

**Scope:**
- items 1–3 of `HANDOFF.md` "NEXT TASK";
- the unsized-tree error translation (item 5, third bullet);
- what faithfulness requires of those: the JVM's read order for each value, its root type for rule 1001, the spend path, the count bounds inside a tree, and the register read order.

**Approach:** re-encoding uses approach B, a cached helper with no change to the box types.

**Implementation:** TDD, contracts first.

**Supersedes:** the "Sub-decision — Parsed vs Unparsed" in `2026-06-17-ergotree-deserialize-unification.md`, and Carve-out 4 in `facts/ergoscript-wire.md`.

JVM citations are sigma-state v6.0.6 (`data/shared/src/main/scala/` unless the path says otherwise) and ergo-core v6.0.6.

## Problem

SANTA `2b1acee` has the finding (`docs/findings/wire-sized-tree-declared-size.md`) and the vectors (`vectors/wire/v6/authored/{Box,Transaction}.sized_tree_declared_size.json`). Each kind has three entries around the v1 size-flagged tree `09 02 08 d3`: the control, "over" (declared size spliced to 3) and "under" (declared size spliced to 1).

The JVM accepts all six and re-serializes both mismatches to the control's bytes. Dasher is red on four:
- both "over" entries reject;
- Transaction "under" rejects;
- Box "under" panics with an untyped `ReaderError: readU8: EOF`.

ergots honours the declared size. `parseTreeFromReader` forks a sub-reader of exactly that many bytes and advances the outer cursor by it. So "over" swallows the next field's bytes, and "under" runs out of body.

There is a second problem. Wherever ergots re-serializes a box it writes the tree's raw bytes, where the JVM re-encodes the tree from its parsed structure. A parse fix alone would therefore leave round-trips, tx ids and output box ids on the raw bytes.

SANTA `9421c11` then pinned the neighbouring behaviour with four JVM-blessed files: `{Box,Transaction}.tree_read_window.json` and `{Box,Transaction}.tree_root_type_check.json`. They cover the tree's 4096-byte read window, a read past the end of the input, and rule 1001 on sized and unsized box trees.

## Verified mechanism (JVM)

### The tree parse: `ErgoTreeSerializer.deserializeErgoTree` (`sigma/serialization/ErgoTreeSerializer.scala:141-215`)

1. **The window.** `startPos = r.position`. The previous `positionLimit` is saved and replaced by `r.position + maxTreeSizeBytes` (`:142-144`). Box trees pass `SigmaSerializer.MaxPropositionSize`, which is `SigmaConstants.MaxPropositionBytes` = 4096 (`ErgoBoxCandidate.scala:194`; `core/shared/src/main/scala/sigma/data/SigmaConstants.scala:40`). The replacement is unconditional, so a nested tree (a Box constant's own tree) overwrites its parent's limit while it parses.
2. **Header and size, outside the `try`.** `deserializeHeaderAndSize` (`:217-237`) reads the header and applies rule 1012 `CheckHeaderSizeBit` (`org/ergoplatform/validation/ValidationRules.scala:138-151`). For a size-flagged header it reads the size with `getUInt().toInt` and never checks it; `getUInt` rejects a value above 2^32−1. Because both run before the `try`, their exceptions skip the `finally`, so the limit is not restored, and they reach an enclosing tree's `catch` unchanged.
3. **Constants, then the body, on the same reader** (`:152-186`).
   - `deserializeConstants` (`:245-262`) reads the count with `getUInt().toInt` and reads constants only if the count is `> 0`. A count that wraps negative gives no constants. A positive count goes through `safeNewArray`, which throws a plain `RuntimeException` above 100000 (`core/shared/src/main/scala/sigma/util/package.scala:7-18`).
   - When `checkType` is set, rule 1001 `CheckDeserializedScriptIsSigmaProp` follows (`:173-175`; `ValidationRules.scala:39-52`). A root whose `tpe` is not SigmaProp raises a `ValidationException`.
   - The root's `tpe` is the node's own. `If` takes its true branch's (`sigma/ast/trees.scala:1351`). `Apply` takes the function's range for an `SFunc`, the element type for a collection, and `NoType` otherwise (`sigma/ast/values.scala:1247-1251`).
   - On success, `propositionBytes` is re-read as `[startPos, r.position)` (`:179-181`). That keeps the declared size as received and the body as parsed; the size plays no other part.
4. **Inner catch** (`:188-194`). A `ReaderPositionLimitExceeded` becomes a `CheckPositionLimit` `ValidationException`. The reader's own check already throws that exception directly (see below), so this arm changes nothing. An `IllegalArgumentException` becomes a `SerializerException`. Sources include a tree version above the activated one, which is checked since v5 (`core/shared/src/main/scala/sigma/VersionContext.scala:17-21`), and a `getUShort` above 0xFFFF.
5. **Outer catch** (`:196-209`), for `ValidationException` only.
   - With a size: `numBytes = bodyPos - startPos + treeSize` in Int arithmetic (`:200`), then `r.position = startPos` and `r.getBytes(numBytes)`, giving an `UnparsedErgoTree`. A negative or past-the-end `numBytes` fails inside `getBytes`, a hard reject.
   - Without a size: `throw SerializerException("Cannot handle ValidationException, ErgoTree serialized without size bit.")`. No enclosing tree degrades on that.
6. **`finally`** (`:210-212`) restores only the position limit.

**The window check** is rule 1014 `CheckPositionLimit`:
- It is a lazy check on entry, with strict `>` (`core/shared/src/main/scala/sigma/validation/ValidationRules.scala:186-189`).
- It runs on each checked read (`core/shared/src/main/scala/sigma/serialization/CoreByteReader.scala:19-27`) and throws the `ValidationException` itself.
- scorex's `ByteReader.checkPositionLimit` already mirrors it.
- `getBytes` checks once, on entry (`CoreByteReader.scala:85-88`), so the degrade's re-read from `startPos` never trips it.

### The order of every value read, and the one unchecked peek

`ValueSerializer.deserialize` (`:396-411`) works in three steps:
1. It raises the level. The setter throws `DeserializeCallDepthExceeded` above the cap (`CoreByteReader.scala:127-131`).
2. It **peeks** the first byte with `peekByte`, which has no window check (`CoreByteReader.scala:41`). At the end of the input the peek throws a raw index exception, a hard reject.
3. It does the checked read.

`Relation2Serializer` (`trees/Relation2Serializer.scala:41`) peeks the same way before its operands. Searching for `peekByte()` in sigma-state's main code finds only these two peek sites.

So a read that starts past the window at the end of the input is a hard reject, not a 1014 degrade. SANTA pins this with `Transaction.tree_read_window` #0 and #1, which differ only in whether another output follows the tree. The same ordering decides between a depth error and a window error when both apply.

ergo-core parses all of a block's transactions on one reader (`ergo-core/.../modifiers/history/BlockTransactions.scala:184-195`). So for a tree that reads to the very end of its transaction, the JVM's verdict depends on context. If another transaction follows in the block, the peek sees a real byte. Parsed on its own, the peek hits the end. See residual 7.

### Counts: every read has a JVM bound, and above it the reject is hard

Inside a tree:
- **Apply and MethodCall arguments** go through `SigmaByteReader.getValues` (`:53-61`): `getUIntExact`, where 0 returns empty and anything else goes through `safeNewArray`. The callers are `ApplySerializer.scala:24` and `MethodCallSerializer.scala:51`.
- **BlockValue items** (`BlockValueSerializer.scala:28-37`), **FuncValue arguments** (`FuncValueSerializer.scala:30-34`), and **SigmaAnd and SigmaOr items** (`transformers/SigmaTransformerSerializer.scala:20-29`) use `getUIntExact` then `safeNewArray`, so at most 100000.
- **Collection items.** A ConcreteCollection's items (`ConcreteCollectionSerializer.scala:27-41`) and a Boolean-constant collection's (`ConcreteCollectionBooleanConstantSerializer.scala:33-47`) are counted with `getUShort`. That raises an `IllegalArgumentException` above 0xFFFF, which the inner catch turns into a hard reject.

In a box, the register count is a `getUByte`. The loop resolves each register's id before reading its value, so a seventh register throws an index exception only when the loop reaches it, after R4–R9 have been read (`ErgoBoxCandidate.scala:226-234`).

Below each bound, the window decides. This matters more after this change. Once a window trip degrades a sized tree, any count ergots reads with no bound, or with a laxer one, turns a JVM reject into an ergots accept.

### Register values

A register value is read whole, with `getValue()`, and only then checked by rule 1019 `CheckV6Type` (`ErgoBoxCandidate.scala:229-234`). So a hard error in the value's data comes first. Examples: SHeader data in a pre-v3 tree (`CoreDataSerializer.scala:144-146`), or an UnsignedBigInt longer than 32 bytes (`:118-124`; `:111-117` is the SBigInt arm).

### `checkType` and the spend path

`checkType` is `true` at every main-code call site:
- The 2-argument overload passes it (`:137-139`).
- The 1-argument overload (`:132-135`) calls the 2-argument one. It is used by `ErgoTree.fromBytes` (`sigma/ast/ErgoTree.scala:413-415`) and address decoding (`org/ergoplatform/ErgoAddress.scala:322`).
- The box parser calls the 2-argument overload too (`ErgoBoxCandidate.scala:194`).

Only the `private[sigma]` 3-argument form can pass `false`. SANTA's blesser uses it for the ErgoTree wire kind (`santa/jvm-blesser/src/main/scala/sigma/santa/LenientErgoTree.scala:22`).

A spend evaluates `box.ergoTree`, which is that ingest parse (ergo-core `ErgoTransaction.scala:138`). An `UnparsedErgoTree` whose error is not a soft fork throws during interpretation (`interpreter/shared/src/main/scala/sigmastate/interpreter/Interpreter.scala:131-141`). Rule 1001's error is not a soft fork.

### Re-encoded bytes versus bytes as received

`serializeErgoTree` (`:105-127`) returns an `UnparsedErgoTree`'s raw bytes. It writes a parsed tree from structure, with a recomputed size: the header byte as stored (`serializeHeader`, `:79-91`; the JVM never inspects bits 5–7), then the constants, then the root.

**Kept as received:**
- `ErgoTree.bytes` is the parser's `propositionBytes` (`sigma/ast/ErgoTree.scala:123-131`), so `ErgoBoxCandidate.propositionBytes` and R1 are raw (`ErgoBoxCandidate.scala:50, 72`).
- A parsed `ErgoBox` keeps its bytes (`ErgoBox.scala:214-226`), and its `bytes` and `id` use them (`:87-92`).

**Re-encoded:**
- The candidate serializer writes `serializeErgoTree(box.ergoTree)` (`ErgoBoxCandidate.scala:142`). It is used by:
  - `bytesWithNoRef` (`:54`);
  - a constructed box's `bytes`;
  - the transaction serializer (`ErgoLikeTransaction.scala:136-142`), and so `bytesToSign` and the tx id (`:49`, `:192-198`; unsigned `:64`, signed `:100`; ergo-core `ErgoTransaction.scala:68`).
- A tx's outputs are constructed from its candidates (`:46-47`), so their `bytes` and ids are re-encoded.
- A Box value inside data goes through the same serializer.

ergo-core `verifyOutput` (`ergo-core/.../modifiers/mempool/ErgoTransaction.scala:171-176`; `utils/BoxUtils.scala:41`) takes the output `ErgoBox`. The box-size cap and the dust minimum use `out.bytes`, which is re-encoded. The script-size cap uses `out.propositionBytes`, which is raw.

### `SubstConstants`

`deserializeHeaderWithTreeBytes` (`:269-274`) reads the header and size through `deserializeHeaderAndSize`: the size is u32-checked by `getUInt` and otherwise ignored. The constants go through `deserializeConstants`, with the count semantics above, and the body is whatever remains.

### The burn box (mainnet h=545,684, tx 1, output 0)

The tree is `cd 07 02 1a 8e 6f 59 fd 4a`:
- header `0xcd`: version 5, the size flag, bits 6–7 set;
- declared size 7;
- body: a Byte constant `02 1a`, followed by five trailing bytes.

At that height the activated version was 1, so `VersionContext` did not object; its check starts at 2. The body parses, rule 1001 fails, the tree degrades, and `numBytes = 2 + 7 = 9`: the box continues at byte 9.

In ergots today, box ingest also lands on byte 9, because its fork is 7 bytes long. The standalone `parseTree`, though, parses the tree, and `serializeTree` then throws `'header-inconsistent'` on the header's bits 5–7. After this change the box path degrades the tree through rule 1001 and lands on byte 9.

## Decision

- **Parse a tree on the reader it arrives on,** as the JVM does. Use the declared size only when the tree degrades.
- **Read every value in the JVM's order:** the depth check, then an end-of-input peek with no window check, then the window-checked read. Relation2 peeks instead of consuming.
- **Every count read inside a tree gets its JVM reader and bound.** The constants count wraps as `toInt` does. Below the bounds, the window decides.
- **Register values follow the JVM's order:** rule 1019 after the value is read, and the seventh-register reject only when the loop reaches it.
- **Rule 1001 applies on the box paths:** box ingest, spends and address decoding. It uses the JVM's root type. The standalone `parseTree` stays lenient by default (the JVM's `checkType = false`), because Dasher's ErgoTree arm and the eval vectors parse arbitrary-root trees with it.
- **Re-encode a box's tree** wherever the JVM re-serializes a box, through one cached helper (approach B). Keep the raw bytes wherever the JVM keeps them.
- **Out of scope** (user, 2026-09-28):
  - the method catalog (residual 1, with its own follow-up spec);
  - register re-encoding and grammar (residual 4), until SANTA answers follow-ups 6–7;
  - the constant-store leak;
  - the six opcodes;
  - the tree-version check;
  - the rest of B-full.

## Changes

### 1. scorex

- **`set position(p)`**, the JVM's `position_=`. It rejects `p < 0` or `p > length` with a new `ReaderError` code, `'position-out-of-range'`. The degrade uses it to move back to the tree's start.
- **`peekU8()`**, the JVM's `peekByte`. It checks for end of input only, throwing `ReaderError('truncated')` as a hard reject. It does no window check and does not advance.
- **`readBytes(n)`** rejects a negative `n` with `'position-out-of-range'`, after its window check. The JVM's `getBytes` checks the window before it allocates. Today a negative `n` would move the cursor backwards.
- `forkSubReader` stays public; ergoscript stops using it.

### 2. ergoscript: `parseTreeFromReader(r, opts?: { checkType?: boolean })`

This mirrors steps 1–6 above:

```
start = r.position; saved = r.positionLimit
r.positionLimit = start + MAX_PROPOSITION_SIZE          // 4096; overwrites, as a nested JVM tree does
header = r.readU8(); rule 1012                          // outside the try: errors propagate, limit not restored
declared = hasSize ? readVlqU32(r) | 0 : undefined      // getUInt().toInt; never checked
bodyPos = r.position
try {
  if (segregated) { n = readVlqU32(r) | 0; if (n > 0) { n > 100000 ⇒ reject; read n constants } }
  body, on r                                             // no fork; every value read in the JVM order (§3)
  if (checkType) rule 1001 on the root's type (§4)
  result = Parsed
} catch (err) {                                         // nested: another tree is open on r (§8)
  if (!isSoftForkableParseError(err)) {
    if (nested && err is ReaderError('truncated')) throw ErgoTreeParseError('nested-tree-truncated', { cause: err })
    throw err
  }
  if (declared === undefined) throw ErgoTreeParseError('soft-fork-without-size-bit', { cause: err })
  numBytes = (bodyPos - start + declared) | 0
  if (numBytes < 0) throw ErgoTreeParseError('body-size-overflow', { cause: err })
  r.position = start
  if (numBytes > r.remaining)                            // the JVM's getBytes fails here (:202)
    throw ErgoTreeParseError(nested ? 'nested-tree-truncated' : 'body-size-overflow', { cause: err })
  bytes = r.readBytes(numBytes)
  result = Unparsed(copy of bytes, err)
} finally {
  r.positionLimit = saved
}
```

- **The degrade set.** `isSoftForkableParseError` covers every error ergots raises for a JVM `ValidationException`, except those listed in residual 3:
  - the existing `'opcode-reserved'`, `'unknown-opcode'` and `'soption-tree-version-too-low'`;
  - `'register-v6-type'` (rule 1019), raised by a nested Box's registers and now checked after the value is read (§6);
  - `ErgoTreeParseError` `'root-not-sigma-prop'` (rule 1001, new);
  - `'header-version-requires-size'` (rule 1012). Only a nested tree can reach this one, since a tree's own header throws outside its `try`.
  - scorex `ReaderError` `'position-limit-exceeded'` (rule 1014).
- `ErgoTreeParseError` gains an optional `cause`. A caller of `parseTree` on an unsized tree now gets the wrapper instead of, for example, `ExprParseError('opcode-reserved')`.
- The level leak becomes native. With no fork, `forkSubReader` and `carryLeakedLevels` go.
- `MAX_CONSTANTS_COUNT` (4096) goes. The `toInt`, `> 0` and 100000 semantics replace it, and `'too-many-constants'` now means "above 100000". `serializeTree`, which also used `MAX_CONSTANTS_COUNT` (ERG-05), bounds its constants at 100000 too, so every tree it writes re-parses.

### 3. ergoscript: the JVM's order for each value read

Wherever the JVM runs `ValueSerializer.deserialize`, ergots runs three steps: `enterDepth()`, then `peekU8()`, then the checked read of the first byte. That applies at:
- `parseExpr`, and every caller of `parseExprWithFirstByte` that reads the first byte itself;
- the register value parse (`parseRegisterExprWithTag` and its caller in `parse-svalue.ts`), including each Tuple item it reads;
- transaction's context-extension value parse.

Relation2 (`parseBinOpFromByte`) peeks for `0x85` with `peekU8()`. It consumes that byte only on the Boolean-pair path; otherwise the left operand is parsed as a full value.

This site list is a hypothesis from a name search. The plan's first task greps every `readU8` that reads a value's first byte, which would catch a site under another name.

### 4. ergoscript: the root type for rule 1001

Rule 1001 uses `exprTpe(root)`, with one JVM-faithful change to its `Apply` arm:
- a function of `SFunc` type gives its range, as now;
- a function of collection type gives the element type (new);
- a function of `SAny` type gives that same `SAny` (the cascade), except that the JVM's `SAny` or `NoType` gives the JVM's `NoType`, `NOTYPE_JVM` (final fix round 2, below);
- any other non-`SAny` function type throws a new, distinct `ExprTpeError('apply-func-no-type')`. That is the JVM's `NoType`, and rule 1001 treats it as "not SigmaProp".

The rule then reads:
- `SSigmaProp` passes.
- ergots' own `SAny` passes (residual 1). It is the fresh object ergots' method typing makes: an unregistered method's return, or `resolveReturnTpe`'s fallback for a type variable left unbound. `unifyTypes` also makes one, for the element of a tuple matched against a collection, where the JVM makes its `SAny`.
- Any other type, or `'apply-func-no-type'`, throws `'root-not-sigma-prop'`. That includes the JVM's `SAny`, from type code 97 or a tuple's element type, as in the JVM, whose rule requires `isInstanceOf[SSigmaProp.type]` (`core/.../sigma/ast/package.scala:121`).
- Any other `ExprTpeError` propagates as a hard reject: each is a shape the JVM throws for while it builds or types the node (`ByIndex` over a type that is no collection, `OptionGet` over one that is no option, and the like; `sigma/ast/transformers.scala:38, 254, 294, 601, 626`; and the JVM's `SAny` through a casting or requiring arm, below). A shape the JVM types, `exprTpe` must type too, or the rule over-rejects. `ByIndex` over a tuple was one until the final review (2026-09-29): `STuple` extends `SCollection[SAny]` with `elemType = SAny` (`core/.../sigma/ast/SType.scala:838-841`) and `ByIndex.tpe = input.tpe.elemType` (`sigma/ast/transformers.scala:254`), so the JVM types it as its `SAny` and degrades a sized tree rooted there (`08 0a b2 86 02 04 00 04 00 04 00 00`), where `exprTpe` threw `'by-index-input-not-scoll'`. It now returns the JVM's `SAny`, which also lets a ValDef bind it, as the JVM's does (`08 10 d8 01 d6 01 b2 86 02 04 00 04 00 04 00 00 08 d3` parses).

The two `SAny`s are told apart by identity (added after review, 2026-09-28). `SANY_JVM` is one frozen object: `parseSType` returns it for type code 97, and `exprTpe` for `ByIndex` over a tuple; nodes keep the types they parse as received; and wherever `exprTpe` passes an `SAny` input through, it returns the same object. ergots' own `SAny` is always a fresh object. So the JVM's `SAny` fails the rule when it reaches the root through `exprTpe`'s own arms, and passes where the method typing replaces it with one of ergots' own (residual 1). Telling the two apart cannot itself reject an honest tree, since ergots' own `SAny` keeps passing; the rule over-rejects only where `exprTpe` throws for a shape the JVM types, as it did for `ByIndex` over a tuple.

**The JVM's `SAny` through a casting or requiring arm (final fix, second round, 2026-09-29).** The first fix round made `ByIndex` over a tuple the JVM's `SAny`, and ten arms passed an `SAny` input through, so ergots accepted trees the JVM rejects at parse (the re-review's 25 shapes). The controller's ruling: `exprTpe` mirrors the JVM node's `tpe`, including where that `tpe` throws. It supersedes the cascade clause of the declared-`SAny` ruling ("never a new over-reject").
- **Casts.** The JVM casts an input's type while it builds `ByIndex`, `SelectField`, `MapCollection` (the mapper), `Slice` and `Append` (their `val tpe`, `sigma/ast/transformers.scala:254, 294, 38, 89, 62`) and `OptionGet` and `OptionGetOrElse` (read by their `val opType`, `:600-601, 625-626`), and wherever `Filter`'s type is read (`def tpe`, `:121`). The JVM's `SAny` and `NoType` fail the cast, a `ClassCastException`: `exprTpe` throws the arm's `'-class-cast'` code for `SANY_JVM` and `NOTYPE_JVM`.
- **Requires.** The JVM requires a numeric type or `NoType` (`isNumTypeOrNoType`, `core/.../sigma/ast/package.scala:139`) while it builds `Negation`, `BitInversion` and `BitOp`, both operands (`sigma/ast/trees.scala:882, 900, 913`). Its `SAny` fails, an `IllegalArgumentException` rethrown as a `SerializerException` (`ErgoTreeSerializer.scala:190-193`); `NoType` passes. `exprTpe` throws the arm's `'-jvm-sany'` code for `SANY_JVM` and passes `NoType`.
- **`NOTYPE_JVM`.** An `Apply` of the JVM's `SAny` is `NoType` (`sigma/ast/values.scala:1247-1251`), which the requires pass. So it types as `NOTYPE_JVM`, a second frozen object, where it returned the function's `SANY_JVM` before, which the new requires would have rejected. Rule 1001 fails it; the casts throw for it.
- **Arms the JVM types** keep typing both: `If`, `BlockValue`, `ValDef`, `Fold`, arithmetic (no cast; the pre-v3 builder upcasts only numeric pairs), `Tuple` and `FuncValue` (wrapped), and the fixed types of `SizeOf`, `Exists`, `ForAll`, `OptionIsDefined`, the relations and the logical operators. ergots' own `SAny` passes every arm.
- **Only where the JVM reads a type.** A `PropertyCall` with explicit type arguments (`Global.none[T]`) is typed from those alone, since the JVM never reads its object's type (`PropertyCallSerializer.scala:36-50`).

A live probe fixed every verdict: 21 arms over the JVM's `SAny` (ByIndex over a tuple; type code 97 through `GetVar` and `DeserializeContext`) and its `NoType`, at a sized root, an unsized root, a root parsed without `checkType`, and a ValDef's right-hand side. The JVM checks these arms wherever they sit, ergots only where it types a node: the rest is the node-construction follow-up. `Upcast` and `Downcast` are outside the change. The JVM requires a numeric input while it builds them (`sigma/ast/trees.scala:398, 431`), which its `SAny`, its `NoType` and any other non-numeric type fail, where `exprTpe` types them from their target without reading the input. So ergots accepts or degrades those shapes wherever they sit (70 probed; the node-construction follow-up).

`ExprTpeError` is exported so callers can classify it. The evaluator also calls `exprTpe`, in eight places. For those callers the collection case is also the JVM's type, and a non-function still throws. Since the second round they can also see the new throws. That matches the JVM where the evaluator reads a type the JVM reads at parse or at the same point of evaluation. It does not match on the spend-time substitution path, where the JVM swallows a `ClassCastException`, never types a register's default, and runs `check2` only at parse (residual 12).

### 5. ergoscript: the count bounds inside a tree

Every count the parser reads inside a tree gets its JVM reader and bound:
- **Apply and MethodCall arguments, BlockValue items, FuncValue arguments, and SigmaAnd and SigmaOr items:** a u32 that must fit an Int (`getUIntExact`), at most 100000 (`safeNewArray`). The four existing caps move from 65536 to 100000. SigmaAnd and SigmaOr get the bound; today they have none.
- **ConcreteCollection and Boolean-constant collection items:** at most 0xFFFF (`getUShort`), checked while parsing, right after the count and before the element type is read. The JVM's `getUShort` throws before `getType` (`ConcreteCollectionSerializer.scala:28-29`). Today `MAX_COLL_ITEMS` is checked only when serializing. The over-long-VLQ subtlety of `getUShort` is in the follow-ups.
- **The constants count:** see §2.

Above each bound the parse rejects. The error codes keep their names and now mean "above the JVM's bound".

This list is a hypothesis from the serializers the reviews named. The plan's first task searches the property instead: every count or length the wire parser reads (each `readVlqU`, `readVlqU32`, `readU8` or `readU16` used as one), checked against its JVM serializer. Any site whose bound is missing, or laxer than the JVM's, is fixed the same way.

**The audit's added sites** (2026-09-28; a property search over every count, length and first-byte read, each re-verified against the v6.0.6 source). Each read now uses the JVM's reader, bound and order (`facts/ergoscript-wire.md`, "Count bounds inside a tree"):
- **The `0x85` lookahead** belongs to Relation2's nine opcodes only (`ValueSerializer.scala:48-58`); the arithmetic and bit operators read two full values (`TwoArgumentsSerializer`).
- **FuncValue argument ids and ValUse ids** are read as `getUInt().toInt`, a u32 wrapped to an Int (`FuncValueSerializer.scala:36`, `ValUseSerializer.scala:13`), and their serializers reject an id outside [0, 2^31), as the JVM's `putUInt` does. A **ValDef id** is `getUIntExact` (`ValDefSerializer.scala:31`): a u32, then at most `Int.MaxValue`.
- **CTHRESHOLD**: `k`, then `n`, each a `getUShort` bounded as it is read; the JVM's `require` (`k <= n`, `n <= 255`, `SigmaBoolean.scala:223`) after the children. ergots' stricter `k >= 1` moves after the children too, so it cannot pre-empt a child's window error.
- **Data lengths**: an SString length is `getUIntExact` (at most `Int.MaxValue`, checked before its bytes' window check, `CoreDataSerializer.scala:104-110`); SBigInt and UnsignedBigInt lengths are `getUShort().toShort` (`:111-117`, `:118-124`), where a zero or negative Short reaches `getBytes`, whose window check comes first.
- **Type code 0**: the JVM's error message makes a window-checked read (`TypeSerializer.scala:133-135`), so past the window the window error comes first.
- **Header points**: an SHeader value's `minerPk` (and a v1 header's `powOnetimePk`) is validated as it is read (`ErgoHeader.scala:73-74, 90`), through scorex's new `parseHeader` option `validatePoint`; a v1 solution's `d` is read even at length 0 (`:76-77`).
- **The register Tuple arity** (§6): a signed `getByte`, so 128 or more rejects before any item (`TupleSerializer.scala:28-31`).
- **An SAvlTree value's `keyLength` and `valueLengthOpt`**: parsed as `getUInt().toInt` as before, and now serialized only within [0, 2^31), since the JVM's `putUInt` rejects the negative Int such a value parses to (`AvlTreeData.scala:77-78, 84-85`); a tree carrying one parses but cannot be re-encoded.

The sites the audit found and excluded are in the follow-ups; none is a bound that the window degrade turns into an accept.

### 6. ergoscript: box ingest, register values, `parseTree`, addresses

- **`parseErgoTreeBytes(r)`** calls `parseTreeFromReader(r, { checkType: true })`. It returns the detached span `[start, end)`, which is raw and keeps the declared size as received. It seeds the cache of §8 with the tree, keyed by that span.
- **Register values follow the JVM** (`ErgoBoxCandidate.scala:226-234`):
  - Rule 1019 runs once per register, in `parseAdditionalRegisters`, on the complete value. It runs after `parseRegisterExprWithTag` has returned, so a Tuple's items have all been read and the value's level has been lowered, as in the JVM (`ValueSerializer.scala:409`). Checking each item as it is read would let an early item's rule-1019 failure degrade a tree the JVM rejects on a later item's hard error. It would also leak one level more.
  - The count stays a `getUByte`. More than six registers rejects only when the parser reaches the seventh, after R4–R9 have been read.
  - The context extension keeps its check before the value. Outside a tree both orders reject, so no verdict changes.
  - A register value's lead byte, and a register Tuple item's, that is neither a constant's type code nor `0x86` is classified as `parseExpr` classifies it (final review, 2026-09-29): `r.getValue()` runs rule 1002 `CheckValidOpCode` on it (`ValueSerializer.scala:171-175`), so an opcode with no JVM serializer throws the soft `'opcode-reserved'` / `'unknown-opcode'` and degrades an enclosing sized tree (`18 32 01 63 01 00 08 d3 00 00 01 84 <11×32> 00 d1 91 c1 73 00 05 00`). `parseExpr`'s dispatch becomes `exprParserFor(opcode)`, the JVM's `getSerializer`, which the register parse calls for the classification alone. A known opcode, which the JVM parses and then casts to an evaluated value (`ErgoBoxCandidate.scala:231`), keeps the hard `'sbox-register-unsupported-expr'` without its payload being read (residual 4), and so do the six opcodes of residual 5.
- **`parseTree(bytes, opts?: { checkType?: boolean })`** is lenient by default.
  - Its envelope checks are unchanged: empty input, the 1 MiB `'oversized'` cap, and trailing bytes.
  - It now tolerates trailing bytes that lie within a size-flagged tree's declared span (`bodyPos + declared`), as the fork did, so `09 03 08 d3 00` still parses. Beyond that span it still throws `'trailing-bytes'` (ERG-02; residual 6).
  - It now also sees the 4096 window, as the JVM's lenient parse does.
- **Address decoding** (`address.ts`) passes `checkType: true`.

### 7. ergoscript: `serializeTree` writes the raw header

`serializeTree` emits `rawHeader` as stored. Its consistency guard compares only bits 0–4 (version, size, segregation) with the derived fields. The postcondition at `facts/ergoscript-wire.md:50` is rewritten to match.

Since re-encoding now carries the transaction id, the writers follow the JVM's in two more places (final review, 2026-09-29):
- **Each node is written by its JVM companion's serializer**, which can differ from the opcode it was read with. A ConcreteCollection of SBoolean whose items are all constants is written `0x85`, packed (`values.scala:871-875`), and a MethodCall without arguments is written as a PropertyCall, `0xdb` (`values.scala:1351`). `serializeCollection` and `serializeMethodCall` write their own opcode. A Boolean-constant collection holding a constant of another type, which the JVM's parse rejects (residual 9), cannot be written: `'collection-item-not-boolean-constant'`, as the JVM's writer fails there too.
- **A Box value's index is written within [0, 0x7FFF]**: the JVM stores it as a Short (`getUShort().toShort`, `ErgoBox.scala:56, 218, 224`) and its `putUShort` (`:211`) rejects the negative Short that 0x8000–0xFFFF parse to. The parse bound stays 0xFFFF, so such a box parses but cannot be re-encoded, in a tree, a register, an extension or `Global.serialize` (`'sbox-index-out-of-range'`).

The JVM's pre-v3 builder rewrites arithmetic operands too; ergots does not model that (residual 11).

### 8. ergoscript: `boxTreeOf`, `reencodeTreeBytes` and `seedBoxTree` (new exports)

**`boxTreeOf(ergoTreeBytes)`** returns the box's tree under the box rules. It reads from a `WeakMap` keyed by the `Uint8Array` instance, which `parseErgoTreeBytes` seeds. On a miss it parses once, standalone, with `checkType: true`:
- **The tree's own reads run out of input** (`'truncated'`, including from `peekU8`, raised outside any nested tree's constants and body; a nested tree reads its header and size before its `try`, so a run-out there counts as the enclosing tree's): a size-flagged tree becomes `Unparsed` with the raw bytes. In its box, that tree degraded after its reads went past its declared span, and box ingest kept exactly that span, `bodyPos + declared` bytes in the JVM's Int arithmetic. Bytes of any other length are no box span, and the run-out propagates (final review, 2026-09-29). A span can also end inside the size VLQ, from a size negative as an Int (final fix round 2): bytes of length n whose size read runs out are a span iff some VLQ length L in [max(n, 5), 10] writes v = 2^32 + (n − 1 − L) with the bytes after the header as its first n − 1 bytes (scorex-util 0.2.1 `VLQReader.scala:54-58, 75-89`: `getULong` reads at most 10 bytes, `getUInt` bounds the value, and a value of 2^31 or more takes at least 5 groups). `09 fe ff ff` and `09 fc ff ff ff` are spans and stay `Unparsed`; `09 fe`, `09 80` and `09 ff ff` are not, and the run-out propagates.
- **A nested tree runs out of input:** the result is ambiguous. In the box, a nested tree may have degraded after reading past this tree's end, then moved back, leaving this tree parsed. It may also have degraded over a span that ends past this tree's end before this tree itself degraded (added after the task review, 2026-09-29). The miss throws `ErgoTreeParseError('box-context-required')`, and a JVM-faithful result for such bytes needs the ingest seed or `seedBoxTree`. `parseTreeFromReader` marks both nested run-outs, a `'truncated'` raised in a nested tree's constants or body and a nested tree's degrade span past the end of the input, as `'nested-tree-truncated'`, so the miss can tell them from the tree's own.
- **Any other failure propagates.** It does not depend on the bytes after the tree, so such bytes are not a valid box tree, and `ErgoTree.fromBytes` would throw too.
- **Trailing bytes** throw `'trailing-bytes'`. Leaving them in place would make R1 and the re-encoding disagree.

**`reencodeTreeBytes(ergoTreeBytes)`** is `serializeTree(boxTreeOf(ergoTreeBytes))`, cached. For an `Unparsed` tree that is the raw bytes, as the JVM's `serializeErgoTree` gives.

**`seedBoxTree(ergoTreeBytes, tree)`** lets an embedder that parsed a tree itself attach it to those bytes, as a JVM box built from an `ErgoTree` object carries its tree. ergots' SANTA eval harness uses it for its synthesized SELF, which the blesser builds from a leniently parsed tree.

The rule from `_box-id.ts` applies: the bytes must not be mutated after first use. The cache belongs to one module instance, so if the package is loaded twice, each copy fills its own.

### 9. The write sites and the spend

- **ergoscript `writeBoxBodyWithoutRef`** writes `reencodeTreeBytes(box.ergoTreeBytes)`. That covers:
  - `serializeSValue(SBox)`: the Box vector, and Box constants inside a tree, as in the JVM's `DataSerializer`;
  - `serializeBoxBytes`: the fallback of `boxBytesOf` for constructed boxes, so output `bytes` and ids;
  - `serializeBoxBytesWithoutRef`: `bytesWithoutRef`.
- **transaction `serializeBoxCandidate`** writes `reencodeTreeBytes(b.ergoTreeBytes)`. That covers `serializeTransaction`, the signing message and the tx id. Output ids, the box-size cap and the dust minimum follow through `serializeBox`.
- **transaction `parseTransaction`** forces each output tree's re-encoding once every output is parsed, and before its own `'trailing-bytes'` check (user decision, 2026-09-28). ergo-core computes the transaction id eagerly (`ErgoTransaction.scala:68`), so the JVM's parse fails on an output tree that parses but cannot be written; ergots rejects it as `TxParseError('output-tree-not-reencodable')`, with the write error as `cause`. Register and context-extension values, which the JVM's eager id also writes, are not forced (a follow-up).
- **ergoscript `addBoxCost`** charges `3 + reencodeTreeBytes(box.ergoTreeBytes).length`.
- **transaction's spend** (`validate/stateful.ts`) evaluates `boxTreeOf(selfBox.ergoTreeBytes)` instead of the lenient `parseTree`. A tree that degraded under rule 1001 is now `Unparsed`, and its spend rejects (`EvalError('unparsed-ergotree')`), as in the JVM.

### 10. Bytes as received

**Unchanged and raw:**
- `ergoTreeBytes`: R1, `propositionBytes`, `ExtractScriptBytes`, the rent R1 comparison, the script-size cap and address encoding;
- a parsed box's `retainedBytes`.

**Moved to the JVM's `box.bytes` basis:**
- transaction's input and data-input id checks: `computeBoxId` becomes `boxIdOf`;
- the storage-rent fee: `serializeBox(box).length` becomes `boxBytesOf(box).length`.

For these, ergoscript exports `boxIdOf` and `boxBytesOf`.

### 11. `SubstConstants`

`substituteConstantsBytes` reads the template's declared size with `readVlqU32`, and its constants count with the §2 semantics.

### 12. The mainnet harness (`tools/mainnet-validate/harness`)

- **The output round-trip check** (`validate-block.ts`) re-serializes each output box as the JVM does, its tree re-encoded under the box rules, and compares the result with the chain's box bytes (final review, 2026-09-29; it first compared `reencodeTreeBytes(ergoTreeBytes)` with the raw tree bytes). The chain's box bytes are the JVM's own serialization of the box: they hash to the box id, which the indexer client checks, so they are a fixed point of the JVM's re-encoding. An honest tree need not be: the JVM rewrites some honest encodings (§7), which the chain's bytes therefore never carry. The box-level comparison also covers the registers and the index. With the lenient `parseTree` it would stop at the burn box.
- **A degrade census:** every output tree that comes back `Unparsed` is logged.
  - The first run establishes the set, with each entry justified. The burn box is the one known today.
  - Later runs fail on any difference.
- **An ids-and-parse-only mode**, with no script evaluation. It checks ergots' tx id and each output box id against the chain's.
- **The oracle-mode spend** (`validate-tx.ts:720`) switches from the lenient `parseTree` to `boxTreeOf`, like the library's spend.

### 13. Contracts

Contracts are written first.

**`facts/scorex.md`:**
- the position setter;
- `peekU8`;
- the `readBytes` guard;
- the new error code.

**`facts/ergoscript-wire.md`:**
- §§2–8 and the residuals below;
- Carve-out 4 and "Reader depth after a degrade", rewritten;
- the `serializeTree` postcondition;
- the error taxonomy:
  - new codes `'root-not-sigma-prop'`, `'soft-fork-without-size-bit'` and `'apply-func-no-type'`;
  - the narrowed `'body-size-overflow'`;
  - the new meaning of the count codes and `'too-many-constants'`;
  - `MAX_CONSTANTS_COUNT` removed;
- the new exports: `boxTreeOf`, `reencodeTreeBytes`, `seedBoxTree`, `boxIdOf`, `boxBytesOf`, `ExprTpeError`, and the `parseTree` option.

**`facts/ergoscript-eval.md`:** the serialize cost.

**`facts/transaction.md`:**
- ids and serialization re-encode the tree;
- the id checks and the rent fee use the bytes as received;
- the spend evaluates the box-rules tree;
- R1 stays raw.

**Other docs:**
- both packages' `API.md` and `README.md`;
- `RELEASING.md`: release scorex, then ergoscript, then transaction.

## Behavior matrix (JVM = ergots after this change)

| Tree | JVM | ergots before |
|---|---|---|
| sized, declared = body, parses | parsed; next field after the body | same |
| sized, declared > body ("over"), parses | parsed; next field right after the body; re-encoded with the true size | rejects: the next field's bytes are taken as body |
| sized, declared < body ("under"), parses | same as "over" | rejects (Box: untyped EOF) |
| sized, body fails soft-forkably inside its declared span | unparsed, `[start, bodyPos + declared)` | same, via the fork |
| sized, body fails soft-forkably past its declared span (`tree_read_window#0`) | unparsed, the declared span | rejects (the fork runs out) |
| sized, read past the window at the end of the input (`tree_read_window#1`) | rejected (the peek fails) | rejects |
| unsized, read past the window (`tree_read_window` unsized) | rejected | rejects (the box window trips first) |
| sized, non-SigmaProp concrete root, box path (burn box; `tree_root_type_check#2`) | unparsed, the declared span | parsed |
| unsized, non-SigmaProp concrete root, box path (`tree_root_type_check#1`) | rejected | accepted |
| root `Apply` of a `Coll[SigmaProp]`, box path | parsed (the root types as SigmaProp) | parsed |
| any root, `parseTree` | lenient | same |
| unsized tree failing soft-forkably, nested in a sized tree | rejected (the hard error escapes) | the outer tree degrades |
| nested rule-1012 failure, or rule 1019 on well-formed data, inside a sized tree | the outer tree degrades | rejected |
| nested Box whose register data fails hard (SHeader in a pre-v3 tree), inside a sized tree | rejected | rejected |
| nested Box with seven registers and a degrade trigger in R4–R9, inside a sized tree | the outer tree degrades | rejected (count checked first) |
| Apply, MethodCall, BlockValue or FuncValue count in (65536, 100000], sized tree | reads on; the window degrades the tree | rejected |
| SigmaAnd or SigmaOr count above 100000, or a collection count above 0xFFFF, sized tree | rejected (the bound) | rejects (the fork runs out) |
| constants count that wraps negative | no constants; parses | rejected |
| spend of a box whose tree rule 1001 degraded | rejected | evaluated (lenient re-parse) |
| header with bits 5–7 set, parses | re-encodes the header byte as stored | `serializeTree` throws |
| sized, root `ByIndex` over a tuple, box path (final review) | unparsed, the declared span (the root types `SAny`) | rejected (`'by-index-input-not-scoll'`) |
| a ValDef bound to `ByIndex` over a tuple (final review) | parsed | rejected (`'val-def-rhs-tpe'`) |
| nested Box register led by an opcode with no serializer, sized tree (final review) | the outer tree degrades | rejected (`'sbox-register-unsupported-expr'`) |
| Boolean-constant collection read as `0x83`, or a MethodCall without arguments read as `0xdc` (final review) | re-encoded as `0x85` / `0xdb` | re-encoded as read |
| Box value with index 0x8000–0xFFFF (final review) | parses; cannot be re-encoded, so the tx rejects | parsed and re-encoded |
| a root or a ValDef typed through a cast of the JVM's `SAny` or `NoType`: `OptionGet(ByIndex(tuple))`, `ByIndex(Apply(ByIndex(tuple), [0]), 0)` (final fix round 2) | rejected (`ClassCastException`) | a sized root parsed (no rule 1001); a ValDef rejected (`'val-def-rhs-tpe'`) |
| the same through a numeric require: `Negation(ByIndex(tuple))` (final fix round 2) | rejected (the `require`) | the same |
| `Negation(Apply(ByIndex(tuple), [0]))`, the JVM's `NoType` (final fix round 2) | a sized root degrades; a ValDef parses | a sized root parsed; a ValDef rejected |
| `OptionGet(Global.none[SigmaProp])` on a `Filter` of the JVM's `SAny`, v3 (final fix round 2) | parsed | parsed |

## Scope and consensus

Honest trees declare their true size and have SigmaProp roots, and a tree written as the JVM writes it re-encodes to itself; the chain's served bytes are written that way. The harness's output round-trip check held for every output tree it compared on the full mainnet walk to the tip (T7, 2026-05-31). That evidence has limits:
- the walk skipped size-flagged trees that failed to parse;
- its parser still rejected trailing bytes inside a declared size, so it proved nothing about over-declared trees;
- the harness sees ergo-node-rust's re-serialized transaction bytes, not the raw block bytes;
- ergo-node-rust (sigma-rust) honours the declared size, so a mainnet block carrying a mismatched one would already have stopped that node from syncing.

No mainnet id should move. The proof (Tests §4) targets what can actually change here:
- rule 1001 now runs on every box: the degrade census catches a silent degrade;
- ids now come from re-encoded trees: the id checks catch any movement.

## Residuals (documented, not closed)

1. **The method catalog, and ergots' other own `SAny`s.** `exprTpe` knows the result type of about 76 typeId/methodId pairs (28 explicit, 48 numeric), and the parser accepts any pair (`wire/mir/property-call.ts:59-74`). Rule 1001 therefore passes any root whose type falls back to ergots' own `SAny`, for example `00 db 65 01 fe`, whose root is `CONTEXT.dataInputs`, where the JVM, which knows the method, fails it. ergots' method typing makes its own `SAny` in two more places, and rule 1001 passes those roots too (amended 2026-09-29):
   - `resolveReturnTpe`'s fallback (`mir/method-signatures.ts:303`) for a result type variable left unbound. The variable may be bound to a wire-declared type variable, as in `0b 0a dc 6a 04 dd 01 0e 00 67 01 58` (`Global.deserializeTo[X]`, which the JVM types `STypeVar(X)`, `sigma/ast/values.scala:1355-1357`), or meet conflicting operand types, as in `0b 09 dc 04 09 d4 61 01 01 04 00` (`Int.bitwiseOr` on a `DeserializeContext(SAny)` receiver, which the JVM specializes to `SInt`, `sigma/ast/methods.scala:235-257`). The catalog follow-up does not close the first case: `106:4`'s signature already matches the JVM's.
   - `unifyTypes`' element type for a tuple matched against a collection, which the JVM makes an `SAny` too (`core/.../sigma/ast/package.scala:46-47`), and fails.

   The JVM's `SAny` (`SANY_JVM`: type code 97, or a tuple's element type) fails the rule, as in the JVM, when it reaches the root through `exprTpe`'s own arms, and fails the parse where one of them casts or requires it (§4). `unifyTypes`' element type for a tuple is that same `SAny` in the JVM; returning `SANY_JVM` there would close the second case above. Where the method typing replaces it with one of ergots' own, it passes: `00 db 24 03 e3 01 61`, `SOption.get` on `GetVar(1, SAny)`, whose pair the catalog lacks, parses under `checkType`.
   - For an unsized tree, ergots accepts a box the JVM rejects.
   - For a sized tree, the JVM degrades it, so its spend rejects, where ergots parses it and evaluates a spend. With a wrong declared size, the two also continue the box at different bytes.

   A follow-up spec transcribes the JVM's method catalog (v5 and v6), which also closes B-full's unknown-method gate.
2. **The v5+ tree-version check.** A tree's version may not exceed the activated version. The wire layer has no activated version, so such a tree parses or degrades in ergots where the JVM rejects it.
3. **B-full.** Unknown type codes, method gates and rule 1009 for SFunc data (SANTA `4ac2286`) degrade in the JVM and reject in ergots. This includes the UnsignedBigInt type code in a pre-v3 tree, which the JVM's type table rejects while reading the type, and ergots accepts. So a malformed UnsignedBigInt register in a pre-v3 tree rejects in ergots where the JVM degrades.
4. **Registers.**
   - Tuple-expression registers keep `opaqueBytes`, and AvlTree flags stay unmasked. The JVM writes the flags back masked (`AvlTreeData.scala:28-34, 74`), so an AvlTree value with flag bits 3–7 set, in an output's registers or tree or in an input's context extension (`ContextExtension.scala:49`), gives ergots another signing message, and so another tx id and other output ids (`facts/transaction.md` Known residual 3).
   - The JVM also accepts ConcreteCollection and GroupGenerator register values (`ValidationRules.scala:188-193`), where ergots accepts only constants and tuples.
   - A register Tuple's items are held to the same two forms, where the JVM reads each with `r.getValue()` (`TupleSerializer.scala:32-34`) and casts only the Tuple itself: a known opcode as an item parses in the JVM (`86 02 04 00 a3`) and rejects in ergots. A register Tuple of arity 0 or 1, which the JVM parses, rejects in ergots.
   - A register value, or a Tuple item, led by an opcode with no JVM serializer is soft in both (§6). ergots rejects any other opcode on its lead byte, where the JVM first parses the node's payload: a soft failure in that payload degrades an enclosing sized tree in the JVM and rejects in ergots (`d1 84` as a nested box's R4; sigma-state 6.0.6 probe).
   - The JVM writes a ConcreteCollection register of Boolean constants back as `0x85` (§7), which ergots, rejecting such registers, never writes.
   - Register values the JVM cannot re-encode, such as an AvlTree register whose `keyLength` is 2^31 or more, one of a 1-item tuple type, or a Box value whose index is 0x8000 or more, parse in both. The JVM rejects a transaction whose output, or whose context extension, carries one at parse, since its eager id writes them from their structure (`ErgoBoxCandidate.scala:175`, `ContextExtension.scala:49`); ergots rejects it only when it computes the id or re-serializes the box.
5. **The constant-store leak** after a degrade, and the six opcodes the JVM parses (TrueLeaf, FalseLeaf, TaggedVariable and the three ModQ opcodes). As a register's lead byte they stay hard (§6): the JVM has a serializer for each, so its rule 1002 does not apply. The JVM rejects TaggedVariable and ModQ there at the register's cast, as ergots does, unless their payload holds a soft failure first (`e7 84` degrades in the JVM); it accepts TrueLeaf and FalseLeaf, where ergots rejects. Classifying them as `parseExpr` does would have turned the four JVM rejects into degrades.
6. **`parseTree`'s envelope, including P2S address decoding:** the 1 MiB `'oversized'` cap, and trailing bytes beyond the declared span (ERG-02). The JVM's lenient parse ignores trailing bytes and degrades a sized tree above 1 MiB. This is ErgoTree-kind and address only; box trees are bounded by the 4096 windows.
7. **Block context.** For a tree that reads to the end of its transaction, the JVM degrades the tree when another transaction follows in the block, and rejects it on its own. ergots parses each transaction on its own and takes the standalone verdict. SANTA's BlockTransactions kind (`02c60db`) pins the block side.
8. **A ValDef whose right-hand side is `Apply` of a non-function, non-collection.** The JVM gives it `NoType` and parses on; ergots rejects with `'val-def-rhs-tpe'`. This predates the change; only the collection case is fixed here.
9. **Collection item types.** The JVM asserts that each ConcreteCollection item has the declared type (`ConcreteCollectionSerializer.scala:38`). ergots does not check, so it accepts what the JVM rejects. This also predates the change.
10. **The ValDef type store.**
    - The JVM keeps one store per reader (`SigmaByteReader.scala:32`), so the outputs of one transaction share it. A ValDef in output 0's tree resolves a ValUse in output 1's (SANTA `02c60db`, `Transaction.valdef_scope#0`, accepted).
    - ergots starts a fresh map for every tree, so it rejects that transaction.
    - Adopting the reader's store needs its own look: the JVM's store is flat, while ergots may scope ValDefs inside one tree. It goes to a follow-up.
11. **The pre-v3 builder's arithmetic rewrites** (final review, 2026-09-29). For a tree of version 0–2, the JVM's `DeserializationSigmaBuilder` inserts an `Upcast` for the narrower of two numeric operands of different types (`applyUpcast`, `SigmaBuilder.scala:674-712`; not from v3, `:750-764`), `ByIndexSerializer` upcasts the index to `SInt` (`ByIndexSerializer.scala:29-33`), and the writer drops the `Upcast` of a constant (`serializable`, `ValueSerializer.scala:157-169, 362-373`). The JVM therefore re-encodes these trees differently, where ergots writes them back as read (sigma-state 6.0.6 probe):
    - `00 d1 91 a3 05 00` → `00 d1 91 7e a3 05 05 00`;
    - `00 d1 91 7e 04 00 05 05 00` → `00 d1 91 04 00 05 00`;
    - `10 02 04 00 05 00 d1 91 73 00 73 01` → `10 02 04 00 05 00 d1 91 7e 73 00 05 73 01` (a placeholder is not a constant, so the `Upcast` stays);
    - `00 d1 91 9a a3 05 02 05 00` → `00 d1 91 9a 7e a3 05 05 02 05 00`;
    - `00 d1 b2 0d 01 01 7d a3 02 00` → `00 d1 b2 0d 01 01 7e 7d a3 02 04 00`.

    The transaction id, output ids, `Global.serialize` and the serialize cost follow the re-encoding. Modelling it needs `exprTpe` to type arithmetic as the JVM's builder does (the `Plus(Int, Long)` follow-up), a broad change. A JVM-compiled tree, and the chain's served bytes, are already written as the builder leaves them; a tree from another encoder may not be.
12. **The spend-time substitution** (the final fix's second re-review, 2026-09-29; shipped open by the user's decision). The JVM substitutes `DeserializeContext` and `DeserializeRegister` with `everywherebu(strategy { substDeserialize })` (`sigmastate/interpreter/Interpreter.scala:149-156`; `org/ergoplatform/ErgoLikeInterpreter.scala:18-38`):
    - Kiama's `strategy` catches a `ClassCastException` and treats it as no rewrite (`core/.../sigma/kiama/rewriting/Rewriter.scala:180-190`). A cast failure while decoding the script, while reading its type, or on a register that is not `Coll[Byte]` (`eba.value.toArray`) therefore leaves the node in place: a dead branch accepts, a live one rejects. An `IllegalArgumentException` from a `require` is not caught, and rejects.
    - A register's default is taken untyped (`.orElse(d.default)`).
    - The ancestors of a substituted node are rebuilt by Kiama's `dup`, which runs their constructors: the casts, the requires, and the type reads of building an `If` (all three children), arithmetic, `OptionIsDefined` and `SigmaPropBytes`. It does not run the builder's `check2`. `toValidScriptTypeJITC` then checks the root's type.

    ergots differs at four places (`eval/_substitute-deserialize.ts`, `eval/evaluate.ts`):
    - it types a decoded script and throws;
    - it types a default against the declared type (sigma-rust's `mir/expr.rs:486-491`);
    - it throws on a register that is not `Coll[Byte]`;
    - it runs `validateBinOpTypes` on the substituted body.

    A sigma-state 6.0.6 probe of 44 spends found divergences in both directions:
    - **Six spends that the JVM and master accept and this branch rejects.** In each, the JVM's `SAny` of type code 97 sits inside a `Filter` or an `OptionGet` in a dead branch; these are the second round's casting arms, where master passed that `SAny` through. The six shapes: a default for an absent register, under `SizeOf` and under `==`; a present register decoding to such a script; and a `DeserializeContext` decoding to one.
    - **Rejects the JVM does not make, on every version:**
      - a default whose type differs from the declared one and that no rebuilt ancestor reads;
      - a decoded script whose type read fails where the JVM swallows the cast;
      - a `DeserializeRegister` over a register that is not `Coll[Byte]`, in a dead branch.
    - **Accepts the JVM does not make:**
      - A live register script whose own construction fails in the JVM: `If(true, 1, SizeOf(OptionGet(ByIndex(tuple))))`. The JVM swallows the cast, keeps the node and rejects the live branch; ergots substitutes and accepts.
      - A decoded script typed `NoType` against a declared `SAny`. ergots' structural comparison passes it, since `NOTYPE_JVM` equals `SAny` structurally; the JVM rejects it.

    Every partial fix leaves a probed case wrong. For example, dropping the default check opens accepts wherever a rebuilt `Negation`, `OptionGet`, arithmetic node or `If` reads the substituted default. Closing it needs the construction-time type reads of the rebuilt ancestors, the same model as the node-construction follow-up, together with Kiama's cast swallow; that is the next spec. The decoded `NoType` case needs one more change: the decoded type compared with the declared one by identity, so that `NOTYPE_JVM` never equals a declared `SAny`.

## Tests (TDD, contracts first)

1. **SANTA vectors, copied verbatim.** The Box files go into ergoscript's wire conformance: `Box.sized_tree_declared_size` (`2b1acee`), `Box.tree_read_window` and `Box.tree_root_type_check` (`9421c11`). The Transaction files go into the transaction replay table.
2. **A red, then green, per behaviour:**
   - every row of the matrix;
   - the degrade's negative and past-the-end `numBytes`;
   - the limit restored on success and on degrade, and not after a header throw;
   - the read order: a depth error beats a window error, and a peek at the end of the input beats a window error;
   - Relation2's peek;
   - each count bound of §5, at the bound and one above it;
   - the register order: rule 1019 after the value, and the seventh-register reject reached last;
   - `parseTree` staying lenient, and tolerating trailing bytes within the declared span;
   - the burn box degrading on the box path and landing at byte 9;
   - `boxTreeOf`, `reencodeTreeBytes` and `seedBoxTree`: a hit, a miss, a sized tree running out of input on a miss, any other failure propagating, trailing bytes, the unparsed passthrough, and a seeded tree;
   - each §9 write site emitting the re-encoded tree while R1 and `propositionBytes` stay raw;
   - the spend rejecting a tree that rule 1001 degraded;
   - the id checks and the rent fee using the bytes as received;
   - the serialize cost using the re-encoded length;
   - `SubstConstants`' size and count reads;
   - address decoding under the box rules.

   **Existing expectations that change:**
   - `ergo-tree.test.ts:258-269`: a constants count of 4097 now runs out of input instead of throwing `'too-many-constants'`.
   - ERG-05, at `:95-123`: the serialize bound.
   - `register-v6-type-rule1019.test.ts`:
     - W7 now degrades.
     - The SHeader case needs valid header bytes, plus a separate hard-reject test.
     - Option at tree versions 0 and 2 now reports `'soption-tree-version-too-low'`.
3. **Mutation checks** on the load-bearing lines: the outer-reader parse, the degrade re-read, the read order, each count bound, the register order, rule 1001 and its root type, the unsized wrap, each write site, and the spend.
4. **The mainnet proof, as the merge gate:** the harness changes of §12, run from h=1 to the tip in ids-and-parse-only mode. The full evaluating walk is optional on top.
5. **Gates:** `npm test`, `npm run typecheck`, jsdom for the three packages, and the bare-root run.
   - **Local replay.** A local replay of the 21 entries in the six SANTA files against `master` (2026-09-28) has eight reds: the four sized-tree entries, the two `tree_read_window` degrade-accepts, and the two unsized Int-root rejects. All 21 must be green.
   - **Dasher** reports ten reds on those 21 today: its Box arm grades a `ReaderError` reject as a panic. The Dasher gate therefore depends on SANTA widening the Box arm first (next section). After both changes, all 21 should be green in Dasher, and nothing else should regress. Other Box-kind panics, such as `4ac2286`'s, may turn green too.

## SANTA: requests (sent at the start of implementation)

**Dasher, needed first:**
- The Box arm maps only `SValueParseError` and `SValueSerializeError` to `errored` (`ts-runner/src/runner.ts:547-564`). The new Box-kind rejects surface as `ErgoTreeParseError` or `ReaderError`, so the arm should use `isWireCodecError`. The `4ac2286` Box rejects panic the same way today.
- `isWireCodecError` should also take `ExprTpeError`.

**Vectors wanted:**
- an unsized tree with a soft-fork failure, as a Box constant inside a sized tree;
- a nested rule-1012 failure, and a nested rule-1019 failure on well-formed data, inside a sized tree;
- a nested Box with an SHeader-typed register inside a sized v1 tree (a hard reject);
- a nested Box with seven registers whose R4 triggers a degrade, inside a sized tree;
- a SigmaAnd count above 100000, and a collection count above 0xFFFF, each in a sized tree followed by more than 4 KB;
- an Apply count in (65536, 100000] in a sized tree;
- a constants count that wraps negative;
- a parsed tree with header bits 5–7 set, round-tripped;
- the `Apply` roots `00 da 14 01 d3 01 04 00` (accepted) and `08 06 da 04 00 01 04 00` (degraded);
- a spend of a sized `If(false, Int, pk)` box (rejected);
- the residual-1 probe `00 db 65 01 fe`;
- a `SubstConstants` template whose declared size is above 2^32−1;
- an eval-tier transaction whose output declares the wrong size, covering its tx id and that output's `propositionBytes` against its `bytes` inside the creating transaction's script.

**Vectors wanted after the final review** (2026-09-29; for the handoff batch, not sent), each shape already checked against a local sigma-state 6.0.6 probe:
- residual 11: the five pre-v3 re-encodings listed there, as Transaction vectors, whose tx ids the rewrite moves;
- a nested Box register led by `0x84`, by `0xd3`, and a register Tuple item led by `0x84`, each in a sized tree (degraded and accepted), the same in an unsized tree (rejected), and a register led by `a3` (rejected);
- the register leads of residual 5 (`7f`, `80`, `e7 06 01 05`, `71 01 04`) and a known lead over a soft payload (`d1 84`, `e7 84`), where ergots still diverges;
- a Boolean-constant collection read as `0x83`, empty included, and a MethodCall without arguments read as `0xdc`, with their tx ids;
- a Box value with index 0x8000 in an output tree, an output register and a context extension (rejected), with the 0x7FFF control;
- a sized tree rooted at `ByIndex` over a tuple (degraded), its unsized twin (rejected), and a ValDef bound to it (parsed);
- the cascade family (final fix round 2): a sized root `OptionGet(ByIndex(tuple))` (rejected), a ValDef bound to one (rejected), the same through `Filter`, `Slice`, `Append`, `Negation`, `BitInversion` and `BitOp` (rejected), `Negation(Apply(ByIndex(tuple), [0]))` (a sized root degraded, a ValDef parsed), and `OptionGet(Global.none[SigmaProp])` on a `Filter` of the JVM's `SAny` in a v3 tree (parsed);
- spans that end inside the size VLQ (final fix round 2): output trees `09 fe ff ff` and `09 fc ff ff ff`, each read from a tree whose negative size ends there (accepted, Unparsed).
- residual 12, as spends: a cast swallowed while decoding or typing a substituted script; a `DeserializeRegister` over a register that is not `Coll[Byte]` in a dead branch; an untyped default under `==` (accepted) and under a rebuilt `If`, `Negation` or arithmetic node (rejected); and `Upcast` and `Downcast` over a non-numeric input at a sized root (rejected).

## Faithfulness risks

- **Honest roots.** An `exprTpe` mistype of an honest root would degrade or reject an honest box. The degrade census and the mainnet run are the check.
- **Counts.** Every count read inside a tree must now match the JVM's bound, or a JVM reject becomes an ergots accept. The property search in the plan's first task is the guard.
- **The read-order change** touches the hottest parse path. The whole corpus, the SANTA replays and the mainnet run cover it.
- **The spend** now uses the box-rules tree. Any honest input tree that rule 1001 degraded would stop being spendable, and the census would catch it.
- **The cache** is keyed by a bytes instance and goes stale if the bytes are mutated. This is documented, as for `_box-id.ts`.
- **Cost.** One `serializeTree` per output tree, cached. A parsed box is not parsed twice, and a spend reuses the ingest parse.

## Follow-ups (not in this spec)

- The method-catalog spec: residual 1, plus B-full's method gate. Residual 1's `resolveReturnTpe` cases need their own fix, since the catalog already matches the JVM there: a result type variable bound to a wire-declared type variable stays that variable, and a numeric method types as its owner type (`sigma/ast/methods.scala:235-257`).
- The tree-version check (residual 2) and the rest of B-full (residual 3).
- Register re-encoding and grammar (residual 4), once SANTA answers follow-ups 6–7.
- **`getUShort`.** The JVM reads `getULong().toInt` before its range check, so it accepts an over-long VLQ whose low 32 bits are in range. ergots rejects it wherever the JVM reads a `getUShort`: the collection counts inside a tree, the SigmaBoolean counts and CTHRESHOLD's `k`, the BigInt and UnsignedBigInt lengths, the SBox index, and the transaction's io counts and proof length.
- **The audit's excluded sites** (2026-09-28). None is a bound that the window degrade turns into an accept:
  - a MethodCall with no arguments in a v3+ tree, which the JVM `assert`s against at parse (`MethodCallSerializer.scala:53-55`), where ergots rejects it only before evaluation (`EvalError('method-call-empty-args')`), so ergots accepts at parse, for example in an output's tree, a tree the JVM rejects;
  - an ExtractRegisterAs register id outside 0..9, which the JVM rejects at parse (`ErgoBox.findRegisterByIndex(regId).get`, `ExtractRegisterAsSerializer.scala:28`), where ergots accepts any byte;
  - a SelectField index outside its tuple, which the JVM rejects at parse when it builds the node (`SelectFieldSerializer.scala:21-23`; `sigma/ast/transformers.scala:294`, with the index read as a signed byte), where ergots rejects only an index of 0;
  - a BlockValue item that is not a ValDef, which the JVM rejects at parse (`asInstanceOf[BlockItem]`, `BlockValueSerializer.scala:39`; `ValDef` is the only `BlockItem`, `sigma/ast/values.scala:924, 945-948`), where ergots accepts any Expr;
  - the CAND/COR/CTHRESHOLD `< 1` rejects, which are stricter than the JVM; dropping them needs SANTA vectors and the verifier's handling of empty conjectures first;
  - the transaction's token-table count, which the JVM reads with `getUIntExact` and bounds with `safeNewArray` at 100000 (`ErgoLikeTransaction.scala:162-166`), where ergots accepts up to 65535 × 255 = 16,711,425, sigma-rust's bound (`facts/transaction.md`, "Count bounds").
- **The JVM's node-construction checks, at parse and after substitution: the next spec** (the user's decision, 2026-09-29). One class, narrowed by the final fix's second round: ergots now makes the check for the JVM's `SAny` (and `NoType`) where it types a node, meaning the root under `checkType`, a ValDef's right-hand side, and the arms `exprTpe` descends from there (§4). The same model closes residual 12, where Kiama's `dup` rebuilds the ancestors of a substituted script. What remains:
  - `Upcast` and `Downcast`, whose constructors require a numeric input (`sigma/ast/trees.scala:398, 431`). `exprTpe` types them from their target, so ergots makes no check for any input, the JVM's `SAny` and `NoType` included. The probe had 70 shapes the JVM rejects; ergots degrades them at a sized root, parses them at a ValDef's right-hand side or a root parsed without `checkType`, and rejects only at an unsized root;
  - the type reads made while building an `If` (all three children, `Quadruple.opType`, `sigma/ast/trees.scala:1313`), arithmetic (both operands), `OptionIsDefined` (`transformers.scala:656`) and `SigmaPropBytes` (`:336`). These reject a `Filter` over the JVM's `SAny` in those places, where `exprTpe` reads only an `If`'s true branch and arithmetic's left operand;
  - the positions ergots does not type at parse, where the JVM still checks while it builds the node (and, for `Filter`, wherever its type is read): a MethodCall's object, a Relation's `check2` (`SigmaBuilder.scala:691, 699, 702`; ergots runs it only before evaluation), a ConcreteCollection item's assert (residual 9), the pre-v3 arithmetic upcast (residual 11), a root parsed without `checkType` (`00 b4 b2 86 02 04 00 04 00 04 00 00 04 00 04 02`, `Slice` over `ByIndex(tuple)`), and a node whose type no enclosing node reads (`08 10 b1 b4 b2 86 02 04 00 04 00 04 00 00 04 00 04 02`, the same `Slice` under `SizeOf`, which ergots degrades and the JVM rejects);
  - wrong concrete input types: a `ClassCastException` in `ByIndex`, `SelectField`, `MapCollection`, `OptionGet`, `OptionGetOrElse`, `Slice`, `Append` and `Filter` (`sigma/ast/transformers.scala:254, 294, 38, 600-601, 625-626, 89, 62, 121`), and a failed require in `Negation`, `BitInversion` and `BitOp` (`sigma/ast/trees.scala:882, 900, 913`) for a concrete type that is not numeric, where `exprTpe` checks the first five for a type that is no collection, option, tuple or function but passes the others' input type through;
  - a `NumericCast` to a non-numeric type (`NumericCastSerializer.scala:22-23`);
  - a pre-v3 `ByIndex` whose index is wider than an Int, which `upcastTo(SInt)` rejects with an `AssertionError` (`ByIndexSerializer.scala:29-33`; `00 d1 b2 0d 01 01 05 00 00`, final review).

  The JVM rejects these shapes while it builds the node, where ergots can accept, or degrade, the tree. The `apply-func-no-type` throw stands in for the JVM's `NoType` of an `Apply` of a concrete non-function (residual 8), so a cast of it propagates to rule 1001 as a degrade where the JVM rejects (`08 0a b2 da 04 00 01 04 00 04 00 00`, `ByIndex` over `Apply(Int 0, [0])`, which the JVM rejects): modelling that `NoType` as a type, as `NOTYPE_JVM` models the one from the JVM's `SAny`, closes it and residual 8 together, but moves an `Apply` of a concrete non-function as a method's object into residual 1.
- **The spend-time substitution** (residual 12) closes with the construction-time spec above. It also needs:
  - Kiama's cast swallow: a `ClassCastException` while decoding or typing a substituted script, or on a register that is not `Coll[Byte]`, leaves the node in place;
  - the untyped default;
  - `check2` only at parse and inside decoded scripts;
  - the decoded type compared with the declared one by identity, so that a decoded `NoType` (`NOTYPE_JVM`) never equals a declared `SAny`.

  Keeping the default check with its pre-round typing is not faithful: it fixes only the `SizeOf` case.
- **`exprTpe` of `Plus(Int, Long)`** is `SInt`, where the JVM's builder upcasts both operands to `Long` (`SigmaBuilder.scala:674-683, 707-712`). Verdict-neutral for rule 1001, since neither is SigmaProp; `exprTpe`'s other callers need a check for mixed-width arithmetic. It is also what modelling residual 11's rewrites needs.
- **A register's known-opcode lead** (residual 4): the JVM parses the node's payload before its cast rejects it, so a soft failure there degrades an enclosing sized tree, where ergots rejects on the lead byte. Parsing the payload needs the reader's constant and ValDef stores (residuals 5 and 10), and the six opcodes of residual 5 would still need parsers.
- **`boxTreeOf`'s nested miss rule is conservative** (final review): some nested run-outs are decidable from the bytes alone, for example under an enclosing tree without the size flag, which cannot have degraded; the miss still throws `'box-context-required'`. That is the safe direction, and box ingest seeds every parsed tree.
- **sigma-rust writes a Boolean-constant collection read as `0x83` back as `0x83`, and a MethodCall without arguments as `0xdc`** (`collection.rs:127`, `method_call.rs:111` on `ergo-node-integration`), where the JVM writes `0x85` and `0xdb` (§7): route to the sigma-rust session at handoff.
- **The spend of a degraded box.** The JVM reads an `UnparsedErgoTree` as `TrueSigmaProp` when the current validation settings mark its error's rule as soft-forked (`interpreter/.../Interpreter.scala:131-141`); ergots rejects every such spend (`EvalError('unparsed-ergotree')`). This belongs with the B-full `ValidationException` audit.
- **`parseTransaction`'s `'trailing-bytes'`** is stricter than the JVM's `parseBytes`, which ignores the bytes after a transaction (ergo-core `avldb/.../ErgoSerializer.scala:27-30`).
- **A parse-time re-encoding check over context-extension and register values.** The JVM's eager id writes the whole signing message from structure; the user's decision (§9) forced output trees only.
- **NiPoPoW header points.** The JVM decodes header points as it reads them, everywhere. A node's proofs carry headers parsed by ergo-core, whose Autolykos solution serializers decode each point with `groupElemFromBytes` (`mining/AutolykosSolution.scala:79-80, 103`), which is `GroupElementSerializer.parse` (`mining/mining.scala:50`); sigma-state's `ErgoHeader.scala:73-74, 90` does the same for an SHeader value. So the JVM rejects a proof with an invalid point at parse, where `@ergots/nipopow` calls `parseHeader` without `validatePoint` and keeps the raw bytes.
- **The harness's storage-rent rules** (`tools/mainnet-validate/harness/src/validate-tx.ts`) still follow sigma-rust's old logic; only its fee basis moved to the bytes as received.
- SANTA `4ac2286` (function type code `0x70`, an unbound `ValUse`): check what it asks of ergots.
- The per-reader ValDef type store (residual 10), with SANTA's `Transaction.valdef_scope` vectors.
- Release per `RELEASING.md`, on the user's go-ahead.
