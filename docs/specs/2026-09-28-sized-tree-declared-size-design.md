# 2026-09-28 — A size-flagged ErgoTree's declared size: parse like the JVM, re-encode box trees

**Status:** design agreed with the user on 2026-09-28, section by section. It was then amended after an adversarial review the same day: findings C1–C3, I1–I8 and M1–M4, each re-verified against source. The user decided two points after the review: the method catalog becomes a residual with its own follow-up spec, and the count caps are in scope.

**Scope:**
- items 1–3 of `HANDOFF.md` "NEXT TASK";
- the unsized-tree error translation (item 5, third bullet);
- what faithfulness requires of those: the JVM's read order for each value, its root type for rule 1001, the spend path, and the count bounds.

**Approach:** re-encoding uses approach B, a cached helper with no change to the box types.

**Implementation:** TDD, contracts first.

**Supersedes:** the "Sub-decision — Parsed vs Unparsed" in `2026-06-17-ergotree-deserialize-unification.md`, and Carve-out 4 in `facts/ergoscript-wire.md`.

JVM citations are sigma-state v6.0.6 (`data/shared/src/main/scala/` unless the path says otherwise) and ergo-core v6.0.6.

## Problem

SANTA `2b1acee` has the finding (`docs/findings/wire-sized-tree-declared-size.md`) and the vectors (`vectors/wire/v6/authored/{Box,Transaction}.sized_tree_declared_size.json`). Each kind has three entries around the v1 size-flagged tree `09 02 08 d3`:
- the control;
- "over": the declared size spliced to 3;
- "under": the declared size spliced to 1.

The JVM accepts all six, and re-serializes both mismatches to the control's bytes. Dasher is red on four:
- both "over" entries reject;
- Transaction "under" rejects;
- Box "under" panics with an untyped `ReaderError: readU8: EOF`.

ergots honours the declared size. `parseTreeFromReader` forks a sub-reader of exactly that many bytes and advances the outer cursor by it. So "over" swallows the next field's bytes and "under" runs out of body.

There is a second gap. Wherever ergots re-serializes a box, it writes the tree's raw bytes, where the JVM re-encodes the tree from its parsed structure. A parse fix alone would therefore leave round-trips, tx ids and output box ids on the raw bytes.

SANTA `9421c11` then pinned the neighbouring behaviour with four JVM-blessed files: `{Box,Transaction}.tree_read_window.json` and `{Box,Transaction}.tree_root_type_check.json`. They cover the tree's 4096-byte read window, a read past the end of the input, and rule 1001 on sized and unsized box trees.

## Verified mechanism (JVM)

### The tree parse: `ErgoTreeSerializer.deserializeErgoTree` (`sigma/serialization/ErgoTreeSerializer.scala:141-215`)

1. **The window.** `startPos = r.position`. The previous `positionLimit` is saved and replaced by `r.position + maxTreeSizeBytes` (`:142-144`). Box trees pass `SigmaSerializer.MaxPropositionSize`, which is `SigmaConstants.MaxPropositionBytes` = 4096 (`ErgoBoxCandidate.scala:194`; `core/shared/src/main/scala/sigma/data/SigmaConstants.scala:40`). The replacement is unconditional, so a nested tree (a Box constant's own tree) overwrites its parent's limit while it parses.
2. **Header and size, outside the `try`.** `deserializeHeaderAndSize` (`:217-237`) reads the header and applies rule 1012 `CheckHeaderSizeBit` (`org/ergoplatform/validation/ValidationRules.scala:138-151`). For a size-flagged header it reads the size with `getUInt().toInt` and never checks it. `getUInt` rejects a value above 2^32−1. Both steps run before the `try`, so their exceptions skip the `finally` (the limit is not restored) and reach an enclosing tree's `catch` unchanged.
3. **Constants, then the body, on the same reader** (`:152-186`).
   - **Constants** (`deserializeConstants`, `:245-262`): `getUInt().toInt`, then constants are read only if the count is `> 0`. A count that wraps negative gives no constants. A positive count goes through `safeNewArray`, which throws a plain `RuntimeException` above 100000 (`core/shared/src/main/scala/sigma/util/package.scala:7-18`).
   - **Rule 1001.** When `checkType` is set, `CheckDeserializedScriptIsSigmaProp` follows (`:173-175`; `ValidationRules.scala:39-52`). A root whose `tpe` is not SigmaProp raises a `ValidationException`.
   - **The root's `tpe`** is the node's own. `If` takes its true branch's (`sigma/ast/trees.scala:1351`). `Apply` takes the function's range for an `SFunc`, the element type for a collection, and `NoType` otherwise (`sigma/ast/values.scala:1247-1251`).
   - **On success**, `propositionBytes` is re-read as `[startPos, r.position)` (`:179-181`). That keeps the declared size as received and the body as parsed; the size plays no other part.
4. **Inner catch** (`:188-194`).
   - `ReaderPositionLimitExceeded` becomes a `CheckPositionLimit` `ValidationException`. The reader's own check already throws that exception directly (see below), so this arm changes nothing.
   - An `IllegalArgumentException` becomes a `SerializerException`. One source is a tree version above the activated one, checked since v5 (`core/shared/src/main/scala/sigma/VersionContext.scala:17-21`).
5. **Outer catch** (`:196-209`), `ValidationException` only.
   - With a size: `numBytes = bodyPos - startPos + treeSize` in Int arithmetic (`:200`). Then `r.position = startPos` and `r.getBytes(numBytes)`, which produces an `UnparsedErgoTree`. A negative or past-the-end `numBytes` fails inside `getBytes`, which is a hard reject.
   - Without a size: `throw SerializerException("Cannot handle ValidationException, ErgoTree serialized without size bit.")`. No enclosing tree degrades on that.
6. **`finally`** (`:210-212`) restores only the position limit.

**The window check** is rule 1014 `CheckPositionLimit`. It is a lazy entry check with strict `>` (`core/shared/src/main/scala/sigma/validation/ValidationRules.scala:186-189`), run by each checked read (`core/shared/src/main/scala/sigma/serialization/CoreByteReader.scala:19-27`), and it throws the `ValidationException` itself. scorex's `ByteReader.checkPositionLimit` already mirrors it. `getBytes` checks once, on entry (`CoreByteReader.scala:85-88`), so the degrade's re-read from `startPos` never trips it.

### The order of every value read, and the one unchecked peek

`ValueSerializer.deserialize` (`:396-411`) does three things in order:
1. It raises the level. The setter throws `DeserializeCallDepthExceeded` above the cap (`CoreByteReader.scala:127-131`).
2. It **peeks** the first byte with `peekByte`, which has no window check (`CoreByteReader.scala:41`). At the end of the input the peek throws a raw index exception, which is a hard reject.
3. It does the checked read.

`Relation2Serializer` (`trees/Relation2Serializer.scala:41`) peeks the same way before its operands. These are the only two peek sites in main code (a search for `peekByte()`).

So a read that starts past the window **at the end of the input** is a hard reject, not a 1014 degrade. SANTA pins this with `Transaction.tree_read_window` #0 and #1, which differ only in whether another output follows the tree. The same ordering decides between a depth error and a window error when both apply.

**Block context.** ergo-core parses all of a block's transactions on one reader (`ergo-core/.../modifiers/history/BlockTransactions.scala:184-195`). So for a tree that reads to the very end of its transaction, the JVM's verdict depends on whether another transaction follows it in the block (the peek sees a real byte) or it is parsed on its own. See residual 7.

### Every other count the tree parse reads

The JVM bounds are `getUIntExact` (a u32 that must also fit an Int) and `safeNewArray` (≤ 100000):
- Apply's and MethodCall's arguments go through `SigmaByteReader.getValues` (`:53-61`: `getUIntExact`, 0 returns empty, otherwise `safeNewArray`), from `ApplySerializer.scala:24` and `MethodCallSerializer.scala:51`.
- BlockValue items (`BlockValueSerializer.scala:28-37`) and FuncValue arguments (`FuncValueSerializer.scala:30-34`) use `getUIntExact` and `safeNewArray`.

Between those bounds, the window decides.

### `checkType` and the spend path

`checkType` is `true` at every main-code call site. The 2-argument overload passes it (`:137-139`). The 1-argument overload (`:132-135`), used by `ErgoTree.fromBytes` (`sigma/ast/ErgoTree.scala:413-415`) and address decoding (`org/ergoplatform/ErgoAddress.scala:322`), calls the 2-argument one. So does the box parser (`ErgoBoxCandidate.scala:194`). Only the `private[sigma]` 3-argument form can pass `false`. SANTA's blesser uses it for the ErgoTree wire kind (`santa/jvm-blesser/src/main/scala/sigma/santa/LenientErgoTree.scala:22`).

A spend evaluates `box.ergoTree`, which is that ingest parse (ergo-core `ErgoTransaction.scala:138`). An `UnparsedErgoTree` whose error is not a soft fork throws during interpretation (`sigmastate/interpreter/Interpreter.scala:131-141`), and rule 1001's is not one.

### Re-encoded bytes versus bytes as received

**`serializeErgoTree`** (`:105-127`):
- an `UnparsedErgoTree` gives its raw bytes;
- a parsed tree is written from structure, with a recomputed size: the header byte as stored (`serializeHeader`, `:79-91`; the JVM never inspects bits 5–7), then the constants, then the root.

**Kept as received:**
- `ErgoTree.bytes` is the parser's `propositionBytes` (`sigma/ast/ErgoTree.scala:123-131`). So `ErgoBoxCandidate.propositionBytes` and R1 are raw (`ErgoBoxCandidate.scala:50, 72`).
- A parsed `ErgoBox` keeps its bytes (`ErgoBox.scala:214-226`), and its `bytes` and `id` use them (`:87-92`).

**Re-encoded:**
- The candidate serializer writes `serializeErgoTree(box.ergoTree)` (`ErgoBoxCandidate.scala:142`). It is used by `bytesWithNoRef` (`:54`), by a constructed box's `bytes`, and by the transaction serializer (`ErgoLikeTransaction.scala:136-142`). That makes it the basis of `bytesToSign` and the tx id (`:49`, `:192-198`; unsigned `:64`, signed `:100`; ergo-core `ErgoTransaction.scala:68`).
- A tx's outputs are constructed from its candidates (`:46-47`), so their `bytes` and ids are re-encoded.
- A Box value inside data goes through the same serializer.

**ergo-core `verifyOutput`** (`ergo-core/.../modifiers/mempool/ErgoTransaction.scala:171-176`; `utils/BoxUtils.scala:41`) takes the output `ErgoBox`:
- the box-size cap and the dust minimum use `out.bytes`, which is re-encoded;
- the script-size cap uses `out.propositionBytes`, which is raw.

### `SubstConstants`

`deserializeHeaderWithTreeBytes` (`:269-274`) reads the header and size through `deserializeHeaderAndSize`. The size is u32-checked by `getUInt` and otherwise ignored. The constants go through `deserializeConstants`, with the count semantics above, and the body is whatever remains.

### The burn box (mainnet h=545,684, tx 1, output 0)

The tree is `cd 07 02 1a 8e 6f 59 fd 4a`:
- header `0xcd`: version 5, the size flag, bits 6–7 set;
- size 7;
- body: a Byte constant `02 1a`, followed by five trailing bytes.

At that height the activated version was 1, so `VersionContext` did not object (its check starts at 2). The body parses, rule 1001 fails, the tree degrades, and `numBytes = 2 + 7 = 9`: the box continues at byte 9.

Today, ergots' box ingest also lands on byte 9, because its fork is 7 bytes long. But the standalone `parseTree` parses the tree, and `serializeTree` then throws `'header-inconsistent'` on the header's bits 5–7. After this change the box path degrades the tree through rule 1001 and lands on byte 9.

## Decision

- **Parse a tree on the reader it arrives on,** as the JVM does. Use the declared size only when the tree degrades.
- **Read every value in the JVM's order:** the depth check, then an end-of-input peek with no window check, then the window-checked read. Relation2 peeks instead of consuming.
- **Rule 1001 applies on the box paths,** meaning box ingest, spends and address decoding, and uses the JVM's root type. The standalone `parseTree` stays lenient by default (the JVM's `checkType = false`), because Dasher's ErgoTree arm and the eval vectors parse arbitrary-root trees with it.
- **Count bounds follow the JVM.** The tree's constants count wraps, as `toInt` does. The four ergots-only caps become the JVM's bounds, and the window decides below them.
- **Re-encode a box's tree** wherever the JVM re-serializes a box, through one cached helper (approach B). Keep the raw bytes wherever the JVM keeps them.
- **Out of scope** (user, 2026-09-28):
  - the method catalog (residual 1, with its own follow-up spec);
  - register re-encoding (Tuple-expression registers, AvlTree flags), until SANTA answers follow-ups 6–7;
  - the constant-store leak;
  - the six opcodes;
  - the tree-version check;
  - the rest of B-full.

## Changes

### 1. scorex

- **`set position(p)`**, the JVM's `position_=`. It rejects `p < 0` or `p > length` with a new `ReaderError` code, `'position-out-of-range'`. The degrade uses it to move back to the tree's start.
- **`peekU8()`**, the JVM's `peekByte`: an end-of-input check only, with no window check and no advance.
- **`readBytes(n)`** rejects a negative `n` with `'position-out-of-range'`. Today it would move the cursor backwards.
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
} catch (err) {
  if (!isSoftForkableParseError(err)) throw err
  if (declared === undefined) throw ErgoTreeParseError('soft-fork-without-size-bit', { cause: err })
  numBytes = (bodyPos - start + declared) | 0
  if (numBytes < 0) throw ErgoTreeParseError('body-size-overflow')
  r.position = start
  bytes = r.readBytes(numBytes)                         // past the end: 'body-size-overflow'
  result = Unparsed(copy of bytes, err)
} finally {
  r.positionLimit = saved
}
```

- **The degrade set.** `isSoftForkableParseError` covers every error ergots raises for a JVM `ValidationException`:
  - the existing `'opcode-reserved'`, `'unknown-opcode'` and `'soption-tree-version-too-low'`;
  - `'register-v6-type'` (rule 1019, raised by a nested Box's registers);
  - `ErgoTreeParseError` `'root-not-sigma-prop'` (rule 1001, new);
  - `'header-version-requires-size'` (rule 1012). This is reachable only from a nested tree, since a tree's own header throws outside its `try`.
  - scorex `ReaderError` `'position-limit-exceeded'` (rule 1014).
- **`ErgoTreeParseError` gains an optional `cause`.** Callers of `parseTree` on an unsized tree now get the wrapper instead of, for example, `ExprParseError('opcode-reserved')`.
- **The level leak becomes native.** With no fork, `forkSubReader` and `carryLeakedLevels` go.
- **`MAX_CONSTANTS_COUNT` (4096) goes,** replaced by the `toInt`, `> 0` and 100000 semantics.

### 3. ergoscript: the JVM's order for each value read

Wherever the JVM runs `ValueSerializer.deserialize`, ergots does the same three steps: `enterDepth()`, then `peekU8()`, then the checked read of the first byte. The sites:
- `parseExpr`, and every caller of `parseExprWithFirstByte` that reads the first byte itself;
- the register value parse (`parseRegisterExprWithTag` and its caller in `parse-svalue.ts`);
- transaction's context-extension value parse.

Relation2 (`parseBinOpFromByte`) peeks for `0x85` with `peekU8()`. It consumes that byte only on the Boolean-pair path; otherwise the left operand is parsed as a full value.

The site list is a hypothesis from a name search. The plan's first task greps every call of `readU8` that reads a value's first byte, which would catch a site under another name.

### 4. ergoscript: the root type for rule 1001

Rule 1001 uses `exprTpe(root)` with one JVM-faithful change to its `Apply` arm:
- a function of `SFunc` type gives its range, as now;
- a function of collection type gives the element type (new);
- any other function type throws a new, distinct `ExprTpeError('apply-func-no-type')`. That is JVM `NoType`, and rule 1001 treats it as "not SigmaProp".

The rule then reads:
- `SSigmaProp` passes;
- `SAny` passes (residual 1);
- any other type, or `'apply-func-no-type'`, throws `'root-not-sigma-prop'`;
- any other `ExprTpeError` propagates as a hard reject. The JVM throws for those shapes while building the node.

`ExprTpeError` is exported, so callers can classify it.

### 5. ergoscript and transaction: the count caps

`MAX_APPLY_ARGS`, `MAX_METHOD_ARGS`, `MAX_BLOCK_ITEMS` and `MAX_FUNC_VALUE_ARGS` all move from 65536 to 100000, the `safeNewArray` bound. Each count is read as a u32 that must fit an Int (`getUIntExact`), and a larger one rejects. The error codes keep their names; their meaning becomes "above the JVM's bound".

### 6. ergoscript: box ingest, `parseTree`, addresses

- **`parseErgoTreeBytes(r)`** calls `parseTreeFromReader(r, { checkType: true })`. It returns the detached span `[start, end)`, raw with the declared size as received, and seeds the cache of §8 with the tree, keyed by that span.
- **`parseTree(bytes, opts?: { checkType?: boolean })`** is lenient by default.
  - Its envelope checks are unchanged: empty input, the 1 MiB `'oversized'` cap, and trailing bytes.
  - It now tolerates trailing bytes that lie within a size-flagged tree's declared span (`bodyPos + declared`), as the fork did. So `09 03 08 d3 00` still parses. Beyond that span it still throws `'trailing-bytes'` (ERG-02; residual 6).
  - It also sees the 4096 window, as the JVM's lenient parse does.
- **Address decoding** (`address.ts`) passes `checkType: true`.

### 7. ergoscript: `serializeTree` writes the raw header

`serializeTree` emits `rawHeader` as stored. Its consistency guard compares only bits 0–4 (version, size, segregation) with the derived fields. The postcondition at `facts/ergoscript-wire.md:50` is rewritten to match.

### 8. ergoscript: `boxTreeOf` and `reencodeTreeBytes` (new exports)

- **`boxTreeOf(ergoTreeBytes)`** returns the box's tree under the box rules, from a `WeakMap` keyed by the `Uint8Array` instance (seeded by `parseErgoTreeBytes`). On a miss it parses once, standalone, with `checkType: true`:
  - if that parse fails, a size-flagged tree becomes `Unparsed` with the raw bytes. A tree that parsed inside its box always re-parses the same way standalone. A degraded one may fail differently on its own, for example when its trigger lay beyond its declared span. Its raw bytes are then the right answer.
  - an unsized tree's failure propagates;
  - trailing bytes throw `'trailing-bytes'`. Leaving them would make R1 and the re-encoding disagree.
- **`reencodeTreeBytes(ergoTreeBytes)`** is `serializeTree(boxTreeOf(ergoTreeBytes))`, cached. For an `Unparsed` tree it is the raw bytes, as in the JVM's `serializeErgoTree`.

The rule from `_box-id.ts` applies: bytes must not be mutated after first use. The cache belongs to one module instance, so two loaded copies of the package each fill their own.

### 9. The write sites and the spend

- **ergoscript `writeBoxBodyWithoutRef`** writes `reencodeTreeBytes(box.ergoTreeBytes)`. That covers:
  - `serializeSValue(SBox)`: the Box vector, and Box constants inside a tree, as in the JVM's `DataSerializer`;
  - `serializeBoxBytes`: the `boxBytesOf` fallback for constructed boxes, so output `bytes` and ids;
  - `serializeBoxBytesWithoutRef`: `bytesWithoutRef`.
- **transaction `serializeBoxCandidate`** writes `reencodeTreeBytes(b.ergoTreeBytes)`. That covers `serializeTransaction`, the signing message and the tx id. Output ids, the box-size cap and the dust minimum follow through `serializeBox`.
- **ergoscript `addBoxCost`** charges `3 + reencodeTreeBytes(box.ergoTreeBytes).length`.
- **transaction's spend** (`validate/stateful.ts`) evaluates `boxTreeOf(selfBox.ergoTreeBytes)` instead of the lenient `parseTree`. A tree that degraded under rule 1001 is now `Unparsed`, and the spend rejects (`EvalError('unparsed-ergotree')`), as it does in the JVM.

### 10. Bytes as received

- **Unchanged and raw:**
  - `ergoTreeBytes`: R1, `propositionBytes`, `ExtractScriptBytes`, the rent R1 comparison, the script-size cap, and address encoding;
  - a parsed box's `retainedBytes`.
- **Moved to the JVM's `box.bytes` basis:**
  - transaction's input and data-input id checks (`computeBoxId` becomes `boxIdOf`);
  - the storage-rent fee (`serializeBox(box).length` becomes `boxBytesOf(box).length`).

  For these, ergoscript exports `boxIdOf` and `boxBytesOf`.

### 11. `SubstConstants`

`substituteConstantsBytes` reads the template's declared size with `readVlqU32`, and its constants count with the §2 semantics.

### 12. The mainnet harness (`tools/mainnet-validate/harness`)

- **The output round-trip check** (`validate-block.ts:338-400`) compares `reencodeTreeBytes(ergoTreeBytes)` with the raw bytes. With the lenient `parseTree` it would stop at the burn box.
- **A degrade census:** every output tree that comes back `Unparsed` is logged. The run fails unless the set is exactly the expected one; today that is the burn box.
- **An ids-and-parse-only mode**, with no script evaluation, that checks ergots' tx id and each output box id against the chain's.

### 13. Contracts

Contracts are written first:
- **`facts/scorex.md`:** the position setter, `peekU8`, the `readBytes` guard, and the new code.
- **`facts/ergoscript-wire.md`:**
  - §§2–8 and the residuals below;
  - Carve-out 4 and "Reader depth after a degrade" rewritten;
  - the `serializeTree` postcondition;
  - the error taxonomy: `'root-not-sigma-prop'`, `'soft-fork-without-size-bit'`, `'apply-func-no-type'`, the narrowed `'body-size-overflow'`, the new meaning of the four caps' codes and of `'too-many-constants'` (above 100000), and `MAX_CONSTANTS_COUNT` gone;
  - the new exports: `boxTreeOf`, `reencodeTreeBytes`, `boxIdOf`, `boxBytesOf`, `ExprTpeError`, and the `parseTree` option.
- **`facts/ergoscript-eval.md`:** the serialize cost.
- **`facts/transaction.md`:**
  - ids and serialization re-encode the tree;
  - the id checks and the rent fee use the bytes as received;
  - the spend evaluates the box-rules tree;
  - R1 stays raw.
- Both packages' `API.md` and `README.md`.
- **`RELEASING.md`:** release order scorex, then ergoscript, then transaction.

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
| root `Apply` of a `Coll[SigmaProp]`, box path | parsed (root types as SigmaProp) | parsed |
| any root, `parseTree` | lenient | same |
| unsized tree failing soft-forkably, nested in a sized tree | rejected (the hard error escapes) | the outer tree degrades |
| nested rule-1012 or rule-1019 failure, inside a sized tree | the outer tree degrades | rejected |
| a count in (65536, 100000], sized tree | reads on; the window degrades the tree | rejected |
| constants count that wraps negative | no constants; parses | rejected |
| spend of a box whose tree rule 1001 degraded | rejected | evaluated (lenient re-parse) |
| header with bits 5–7 set, parses | re-encodes the header byte as stored | `serializeTree` throws |

## Scope and consensus

Honest trees declare their true size, have SigmaProp roots, and re-encode to themselves. The harness's output round-trip check held for every output tree it compared on the full mainnet walk to the tip (T7, 2026-05-31). That walk skipped size-flagged trees that failed to parse. Its parser also still rejected trailing bytes inside a declared size, so it proved nothing about over-declared trees.

Two limits apply to what the harness can show. It sees ergo-node-rust's re-serialized transaction bytes, not the raw block bytes. And ergo-node-rust (sigma-rust) honours the declared size, so a mainnet block carrying a mismatched declared size would already have stopped that node from syncing.

No mainnet id should move. The proof (Tests §4) targets what can actually change here:
- rule 1001 now runs on every box: the degrade census catches a silent degrade;
- ids now come from re-encoded trees: the id checks catch any movement.

## Residuals (documented, not closed)

1. **The method catalog.** `exprTpe` knows the result type of about 30 methods, and the parser accepts any typeId and methodId (`wire/mir/property-call.ts:59-74`). Rule 1001 therefore passes any root whose type falls back to `SAny`. SANTA-style probe: `00 db 65 01 fe`, root `CONTEXT.dataInputs`.
   - For an unsized tree, ergots accepts a box the JVM rejects.
   - For a sized tree with a wrong declared size, the two continue the box at different bytes.

   Follow-up spec: transcribe the JVM's method catalog (v5 and v6), which also closes B-full's unknown-method gate.
2. **The v5+ tree-version check.** A tree's version may not exceed the activated version. The wire layer has no activated version, so such a tree parses or degrades in ergots where the JVM rejects it.
3. **B-full:** unknown type codes and method gates degrade in the JVM but reject in ergots.
4. **Register re-encoding:** Tuple-expression registers keep `opaqueBytes`, and AvlTree flags stay unmasked.
5. **The constant-store leak** after a degrade, and the six opcodes the JVM parses.
6. **`parseTree`'s envelope:** the 1 MiB `'oversized'` cap, and trailing bytes beyond the declared span (ERG-02). The JVM's lenient parse ignores trailing bytes, and degrades a sized tree above 1 MiB. This affects the ErgoTree kind only; box trees are bounded by the 4096 windows.
7. **Block context:** for a tree that reads to the end of its transaction, the JVM degrades it when another transaction follows in the block and rejects it on its own. ergots parses each transaction on its own and takes the standalone verdict.
8. **A ValDef whose right-hand side is `Apply` of a non-function, non-collection:** the JVM gives it `NoType` and parses on, while ergots rejects (now with `'apply-func-no-type'`). This was pre-existing; the collection case is fixed here.

## Tests (TDD, contracts first)

1. **SANTA vectors, copied verbatim:**
   - the Box files, into ergoscript's wire conformance: `Box.sized_tree_declared_size` (`2b1acee`), `Box.tree_read_window` and `Box.tree_root_type_check` (`9421c11`);
   - the matching Transaction files, into the transaction replay table.
2. **A red, then green, per behavior:**
   - every row of the matrix;
   - the degrade's negative and past-the-end `numBytes`;
   - the limit restored on success and on degrade, and not after a header throw;
   - the read order: a depth error beats a window error, and a peek at the end of the input beats a window error;
   - Relation2's peek;
   - `parseTree` staying lenient, and tolerating trailing bytes within the declared span;
   - the burn box degrading on the box path and landing at byte 9;
   - `boxTreeOf` and `reencodeTreeBytes`: a hit, a miss, a sized failure on a miss, trailing bytes, and the unparsed passthrough;
   - each §9 write site emitting the re-encoded tree while R1 and `propositionBytes` stay raw;
   - the spend rejecting a rule-1001-degraded tree;
   - the id checks and the rent fee using the bytes as received;
   - the serialize cost using the re-encoded length;
   - `SubstConstants`' size and count reads;
   - address decoding under the box rules.
3. **Mutation checks** on the load-bearing lines: the outer-reader parse, the degrade re-read, the read order, rule 1001 and its root type, the unsized wrap, each write site, and the spend.
4. **The mainnet proof, as the merge gate:** the harness changes of §12, run from h=1 to the tip in ids-and-parse-only mode. The full evaluating walk is optional on top.
5. **Gates:** `npm test`, `npm run typecheck`, jsdom for the three packages, and the bare-root run. A local replay of the 21 entries in these six SANTA files against `master` (2026-09-28) gives eight reds: the four sized-tree entries, the two `tree_read_window` degrade-accepts, and the two unsized Int-root rejects. All 21 must be green. After the push, SANTA re-grades Dasher: those eight should turn green and nothing else should move.

## SANTA: requests (sent at the start of implementation)

**Vectors wanted:**
- an unsized tree with a soft-fork failure, as a Box constant inside a sized tree;
- a nested rule-1012 failure, and a nested rule-1019 failure, inside a sized tree;
- a parsed tree with header bits 5–7 set, round-tripped;
- the `Apply` roots `00 da 14 01 d3 01 04 00` (accepted) and `08 06 da 04 00 01 04 00` (degraded);
- a spend of a sized `If(false, Int, pk)` box (rejected);
- the residual-1 probe `00 db 65 01 fe`;
- an Apply count in (65536, 100000] in a sized tree;
- a constants count that wraps negative;
- a `SubstConstants` template whose declared size is above 2^32−1;
- an eval-tier transaction whose output declares the wrong size: its tx id, and that output's `propositionBytes` against its `bytes` inside the creating transaction's script.

**Dasher:**
- The Box arm maps only `SValueParseError` and `SValueSerializeError` to `errored` (`ts-runner/src/runner.ts:547-564`). The new Box-kind rejects surface as `ErgoTreeParseError` or `ReaderError`, so the arm should use `isWireCodecError`.
- `isWireCodecError` should also take `ExprTpeError`.

## Faithfulness risks

- **An `exprTpe` mistype of an honest root** would degrade or reject an honest box. The degrade census and the mainnet run are the check.
- **The read-order change touches the hottest parse path.** The whole corpus, the SANTA replays and the mainnet run cover it.
- **The spend now uses the box-rules tree.** Any honest input tree that rule 1001 degraded would stop being spendable. The census catches that.
- **The cache is keyed by a bytes instance,** and goes stale if the bytes are mutated. This is documented, as for `_box-id.ts`.
- **Cost:** one `serializeTree` per output tree, cached. A parsed box is not parsed twice, and a spend reuses the ingest parse.

## Follow-ups (not in this spec)

- The method-catalog spec (residual 1, plus B-full's method gate).
- The tree-version check (residual 2) and the rest of B-full (residual 3).
- Register re-encoding, once SANTA answers follow-ups 6–7.
- The JVM's `getUShort` reads `getULong().toInt` before its range check, so it accepts an over-long VLQ whose low 32 bits are in range. ergots rejects it: the SBox index, and the transaction's counts.
- SANTA `4ac2286` (function type code `0x70`, an unbound `ValUse`): check whether it touches ergots.
- Release per `RELEASING.md`, on the user's go-ahead.
