# 2026-09-28 — A size-flagged ErgoTree's declared size: parse like the JVM, re-encode box trees

**Status:** design agreed with the user 2026-09-28, section by section. Scope: items 1–3 of `HANDOFF.md` "NEXT TASK", plus the unsized-tree error translation (item 5, third bullet). The register side of re-encoding and the other item-5 gaps stay out. Re-encoding uses approach B: a cached helper, with no change to the box types. Implementation: TDD, contracts first. This spec supersedes the "Sub-decision — Parsed vs Unparsed" in `2026-06-17-ergotree-deserialize-unification.md` and Carve-out 4 in `facts/ergoscript-wire.md`.

JVM citations are sigma-state v6.0.6, under `data/shared/src/main/scala/` unless a path says otherwise, and ergo-core v6.0.6.

## Problem

SANTA `2b1acee` has the finding (`docs/findings/wire-sized-tree-declared-size.md`) and the vectors (`vectors/wire/v6/authored/{Box,Transaction}.sized_tree_declared_size.json`). Each kind has three entries around the v1 size-flagged tree `09 02 08 d3`:
- the control;
- "over": the declared size spliced to 3;
- "under": the declared size spliced to 1.

The JVM accepts all six and re-serializes both mismatches to the control's bytes. Dasher fails four of them:
- both "over" entries reject;
- Transaction "under" rejects;
- Box "under" panics with an untyped `ReaderError: readU8: EOF`.

ergots honours the declared size: `parseTreeFromReader` forks a sub-reader of exactly that many bytes and advances the outer cursor by it. So "over" swallows the next field's bytes, and "under" runs out of body. Separately, wherever ergots re-serializes a box it writes the tree's raw bytes, while the JVM re-encodes the tree from its parsed structure. A parse fix alone would therefore leave round-trips, tx ids and output box ids on the raw bytes.

## Verified mechanism (JVM)

### The tree parse: `ErgoTreeSerializer.deserializeErgoTree` (`sigma/serialization/ErgoTreeSerializer.scala:141-215`)

1. **Position limit.** `startPos = r.position`. The previous `positionLimit` is saved and replaced by `r.position + maxTreeSizeBytes` (`:142-144`). Box trees pass `SigmaSerializer.MaxPropositionSize`, which is `SigmaConstants.MaxPropositionBytes` = 4096 (`ErgoBoxCandidate.scala:194`). The replacement is unconditional, so a nested tree (a Box constant's own tree) overwrites its parent's limit while it parses.
2. **Header and size, outside the `try`.** `deserializeHeaderAndSize` (`:217-237`) reads the header and applies rule 1012 `CheckHeaderSizeBit` (`org/ergoplatform/validation/ValidationRules.scala:138-151`). For a size-flagged header it reads the size with `getUInt().toInt` and never checks it. Because both run before the `try`, their exceptions skip the `finally` (the limit is not restored) and reach an enclosing tree's `catch` unchanged.
3. **Constants, body, rule 1001.** Inside the `try` (`:152-186`), the constants and then the body are read from the same reader. When `checkType` is set, rule 1001 `CheckDeserializedScriptIsSigmaProp` runs next (`:173-175`; `ValidationRules.scala:39-52`): a root whose `tpe` is not SigmaProp raises a `ValidationException`. On success, `propositionBytes` is re-read as `[startPos, r.position)` (`:179-181`). That keeps the declared size as received and the body as parsed; the size plays no other part.
4. **Inner catch** (`:188-194`):
   - `ReaderPositionLimitExceeded` becomes a `CheckPositionLimit` `ValidationException`.
   - `IllegalArgumentException` becomes a `SerializerException`. This is the case of a tree version above the activated one, checked since v5 (`core/shared/src/main/scala/sigma/VersionContext.scala:17-21`).
5. **Outer catch** (`:196-209`), `ValidationException` only:
   - With a size: `numBytes = bodyPos - startPos + treeSize` in Int arithmetic (`:200`), then `r.position = startPos` and `r.getBytes(numBytes)`, giving an `UnparsedErgoTree`.
   - Without a size: `throw SerializerException("Cannot handle ValidationException, ErgoTree serialized without size bit.")`. No enclosing tree degrades on that.
6. **`finally`** (`:210-212`) restores only the position limit.

**The position limit** is rule 1014 `CheckPositionLimit`, a lazy entry check with strict `>` (`core/shared/src/main/scala/sigma/serialization/CoreByteReader.scala:19-27`). scorex's `ByteReader.checkPositionLimit` already mirrors it. `getBytes` checks once on entry (`CoreByteReader.scala:85-88`), so the degrade's re-read from `startPos` never trips it. A negative `numBytes` fails to allocate its array, and one that runs past the end fails to read; both are hard rejects.

**`checkType` is `true` at every main-code call site.** The 2-argument overload passes it (`:137-139`). That overload is what the box parser (`ErgoBoxCandidate.scala:194`), `ErgoTree.fromBytes` (`sigma/ast/ErgoTree.scala:413-415`) and address decoding (`org/ergoplatform/ErgoAddress.scala:322`) call. Only the `private[sigma]` 3-argument form can pass `false`. SANTA's blesser uses that form for the ErgoTree wire kind, whose witnesses have Int roots (`santa/jvm-blesser/src/main/scala/sigma/santa/LenientErgoTree.scala:22`).

### Re-encoded bytes versus bytes as received

**`serializeErgoTree`** (`:105-127`) returns an `UnparsedErgoTree`'s raw bytes. A parsed tree is written from structure, with a recomputed size:
- the header byte as stored (`serializeHeader`, `:79-91`; the JVM never inspects bits 5–7);
- the constants;
- the root.

**Kept as received:**
- `ErgoTree.bytes` is the parser's `propositionBytes` (`sigma/ast/ErgoTree.scala:123-131`). So `ErgoBoxCandidate.propositionBytes` and R1 are raw (`ErgoBoxCandidate.scala:50, 72`).
- A parsed `ErgoBox` keeps its bytes (`ErgoBox.scala:214-226`), and its `bytes` and `id` use them (`:87-92`).

**Re-encoded:**
- The candidate serializer writes `serializeErgoTree(box.ergoTree)` (`ErgoBoxCandidate.scala:142`). It is used by `bytesWithNoRef` (`:54`), by a constructed box's `bytes`, and by the transaction serializer (`ErgoLikeTransaction.scala:136-142`), hence by `bytesToSign` and the tx id (`:49, :64, :192-198`).
- A tx's outputs are constructed from its candidates (`:46-47`), so their `bytes` and ids are re-encoded.
- A Box value inside data goes through the same serializer.

**ergo-core `verifyOutput`** (`ergo-core/src/main/scala/org/ergoplatform/modifiers/mempool/ErgoTransaction.scala:171-176`; `utils/BoxUtils.scala:41`) takes the output `ErgoBox`:
- the box-size cap and the dust minimum use `out.bytes`, which is re-encoded;
- the script-size cap uses `out.propositionBytes`, which is raw.

**`SubstConstants`** ignores the size too (`deserializeHeaderWithTreeBytes`, `:269-274`). ergots' `substituteConstantsBytes` already does the same, so it needs no change.

### The burn box (mainnet h=545,684, tx 1, output 0)

The tree is `cd 07 02 1a 8e 6f 59 fd 4a`:
- header `0xcd`: version 5, the size flag, bits 6–7 set;
- declared size 7;
- body: a Byte constant `02 1a`, followed by five trailing bytes.

At that height the activated version was 1, so `VersionContext` did not object (its check starts at 2). The body parses, rule 1001 fails, the tree degrades, and `numBytes = 2 + 7 = 9`, so the box continues at byte 9. ergots lands on byte 9 today because its fork is 7 bytes long. After this change it lands there because rule 1001 degrades the tree.

## Decision

- **Parse** a tree on the reader it arrives on, as the JVM does. Use the declared size only when the tree degrades.
- **Rule 1001** runs on the box paths only. `parseTree` stays lenient (the JVM's `checkType = false`), because Dasher's ErgoTree arm, the eval vectors and ergots' own consumers parse arbitrary-root trees with it.
- **Re-encode** a box's tree wherever the JVM re-serializes a box, through one cached helper (approach B). Keep the raw bytes wherever the JVM keeps them.
- **Out of scope** (user, 2026-09-28):
  - register re-encoding (Tuple-expression registers, AvlTree flags), which waits for SANTA follow-ups 6–7;
  - the constant-store leak;
  - the six opcodes;
  - the tree-version check;
  - the rest of B-full.

## Changes

### 1. scorex: a position setter

`ByteReader` gains `set position(p)`, the JVM's `position_=`. It is a plain assignment that rejects `p < 0` or `p > length` with a `ReaderError`. The degrade needs it to move back to the tree's start. `forkSubReader` stays public; ergoscript stops using it.

### 2. ergoscript: `parseTreeFromReader(r, opts?: { checkType?: boolean })`

This mirrors steps 1–6 above:

```
start = r.position; saved = r.positionLimit
r.positionLimit = start + MAX_PROPOSITION_SIZE          // 4096; overwrites, as a nested JVM tree does
header = r.readU8(); rule 1012                          // outside the try: errors propagate, limit not restored
declared = hasSize ? readVlqU32(r) | 0 : undefined     // getUInt().toInt: u32 or reject, then wrapped; never checked
bodyPos = r.position
try {
  constants (if segregated) and body, on r               // no fork
  if (checkType) rule 1001 on exprTpe(body)             // SAny passes (residual 1)
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

- **The degrade set** (`isSoftForkableParseError`) keeps its three codes and gains three more:
  - `ErgoTreeParseError` `'root-not-sigma-prop'` (rule 1001, new);
  - `'header-version-requires-size'` (rule 1012). This one is reachable only from a nested tree, because a tree's own header throws outside its `try`;
  - scorex `ReaderError` `'position-limit-exceeded'` (rule 1014).
- `ErgoTreeParseError` gains an optional `cause`.
- **The level leak becomes native.** There is no fork, so `forkSubReader` and `carryLeakedLevels` go. A degrade's frames keep their levels on the one reader, as in the JVM.
- `MAX_PROPOSITION_SIZE` is 4096 (`SigmaSerializer.MaxPropositionSize`).

### 3. ergoscript: box ingest and `parseTree`

- **`parseErgoTreeBytes(r)`** calls `parseTreeFromReader(r, { checkType: true })`. It returns the detached span `[start, end)`, raw with the declared size as received. It also seeds the re-encode cache (§5) with the tree, keyed by that span.
- **`parseTree(bytes)`** calls it with `checkType: false`. Its envelope checks (empty input, the 1 MiB `'oversized'` cap, trailing bytes) are unchanged. It now also sees the 4096 limit, as the JVM's lenient parse does.

### 4. ergoscript: `serializeTree` writes the raw header

`serializeTree` emits `rawHeader` as stored. Its consistency guard compares only bits 0–4 (version, size, segregation) with the derived fields. A parsed tree whose header has bits 5–7 set now re-encodes instead of throwing `'header-inconsistent'`.

### 5. ergoscript: `reencodeTreeBytes(ergoTreeBytes)` (new export)

It returns what the JVM's `serializeErgoTree` returns for a box's tree:
- A `WeakMap` keyed by the `Uint8Array` instance holds the parsed tree (seeded by `parseErgoTreeBytes`) and, once computed, the re-encoded bytes.
- On a miss (a box built in memory), it parses once with `checkType: true` on a fresh reader. If that parse leaves bytes over, it throws `ErgoTreeParseError('trailing-bytes')`, as `parseTree` does.
- An `UnparsedErgoTree` gives back its raw bytes.

The same rule applies as for `_box-id.ts`: the bytes must not be mutated after first use.

### 6. The write sites

- **ergoscript `writeBoxBodyWithoutRef`** writes `reencodeTreeBytes(box.ergoTreeBytes)`. That covers:
  - `serializeSValue(SBox)`: the Box vector, and Box constants inside a tree, as the JVM's `DataSerializer` handles them;
  - `serializeBoxBytes`: the fallback of `boxBytesOf` for constructed boxes, so output `bytes` and ids;
  - `serializeBoxBytesWithoutRef`: `bytesWithoutRef`.
- **transaction `serializeBoxCandidate`** writes `reencodeTreeBytes(b.ergoTreeBytes)`. That covers `serializeTransaction`, the signing message and the tx id. Output ids, the box-size cap and the dust minimum follow through `serializeBox`.
- **ergoscript `addBoxCost`** charges `3 + reencodeTreeBytes(box.ergoTreeBytes).length` for `putBytes(ergoTree)`.

### 7. Bytes as received

- **Unchanged and raw:**
  - `ergoTreeBytes`: R1, `propositionBytes`, `ExtractScriptBytes`, the rent R1 comparison, the script-size cap, addresses;
  - a parsed box's `retainedBytes`.
- **Moved to the JVM's `box.bytes` basis:**
  - transaction's input and data-input id checks (`computeBoxId` → `boxIdOf`);
  - the storage-rent fee (`serializeBox(box).length` → `boxBytesOf(box).length`).

  For these, ergoscript exports `boxIdOf` and `boxBytesOf`.

### 8. Contracts

Contracts are written first.
- `facts/scorex.md`: the position setter.
- `facts/ergoscript-wire.md`:
  - §§2–5 and the residuals below;
  - Carve-out 4 and "Reader depth after a degrade" rewritten;
  - the error taxonomy: `'root-not-sigma-prop'` and `'soft-fork-without-size-bit'` added, `'body-size-overflow'` narrowed to the degrade re-read.
- `facts/ergoscript-eval.md`: the serialize cost.
- `facts/transaction.md`: ids and serialization re-encode; id checks and the rent fee use the bytes as received; R1 stays raw.
- Both packages' `API.md` and `README.md`.
- `RELEASING.md`: release order scorex → ergoscript → transaction.

## Behavior matrix (JVM = ergots after this change)

| Tree | JVM | ergots before |
|---|---|---|
| sized, declared = body, parses | parsed; next field after the body | same |
| sized, declared > body ("over"), parses | parsed; next field right after the body; re-encoded with the true size | rejects: the next field's bytes are taken as body |
| sized, declared < body ("under"), parses | same as "over" | rejects (Box: untyped EOF) |
| sized, body fails soft-forkably | unparsed, `[start, bodyPos + declared)` | same, via the fork |
| sized, non-SigmaProp root, box path (the burn box) | unparsed, the declared span | parsed |
| unsized, non-SigmaProp root, box path | rejected | accepted |
| any tree, non-SigmaProp root, `parseTree` | parsed (lenient) | same |
| unsized tree failing soft-forkably, nested in a sized tree | rejected (the hard error escapes) | the outer tree degrades |
| nested tree failing rule 1012, inside a sized tree | the outer tree degrades | rejected |
| sized tree whose body runs past start + 4096 | unparsed, the declared span | parsed or rejected, depending on the declared size (the fork has no limit) |
| header with bits 5–7 set, parses | re-encodes the header byte as stored | `serializeTree` throws |

## Scope and consensus

Honest trees declare their true size, have SigmaProp roots and re-encode to themselves. The harness's output round-trip check (`tools/mainnet-validate/harness/src/validate-block.ts:393`) held for every output tree on the full mainnet walk that reached the tip (T7, 2026-05-31). It skips size-flagged trees that fail to parse, such as the burn box. So no mainnet box id or tx id should move. Proving that is the merge gate (Tests §4), because rule 1001 now runs on every box and ids now come from re-encoded trees.

## Residuals (documented, not closed)

1. Rule 1001 passes a root whose `exprTpe` is `SAny` (the type-var widening residual), where the JVM's precise type could fail it.
2. The v5+ check that a tree's version does not exceed the activated version. The wire layer has no activated version, so such a tree parses or degrades in ergots where the JVM rejects it.
3. B-full: unknown type codes and method gates degrade in the JVM but reject in ergots.
4. Register re-encoding: Tuple-expression registers keep `opaqueBytes`, and AvlTree flags stay unmasked.
5. The constant-store leak after a degrade, and the six opcodes the JVM parses.
6. `parseTree`'s 1 MiB `'oversized'` pre-check rejects a sized tree the JVM would degrade. This affects the ErgoTree kind only; boxes are bounded by the 4096 limits.

## Tests (TDD, contracts first)

1. **SANTA vectors, copied verbatim:** `Box.sized_tree_declared_size.json` into ergoscript's wire conformance, and `Transaction.sized_tree_declared_size.json` into the transaction replay table.
2. **A red, then green, per behavior:**
   - each row of the matrix;
   - the degrade's negative and past-the-end `numBytes`;
   - the limit restored on success and on degrade, and not restored after a header throw;
   - `parseTree` staying lenient on an Int root;
   - the burn box degrading and landing at byte 9;
   - `reencodeTreeBytes`: a hit, a miss, the trailing-bytes throw, and the unparsed passthrough;
   - each write site of §6 emitting the re-encoded tree while R1 and `propositionBytes` stay raw;
   - the id checks and the rent fee using the bytes as received;
   - the serialize cost using the re-encoded length.
3. **Mutation checks** on the load-bearing lines: the outer-reader parse, the degrade re-read, rule 1001, the unsized wrap, and each write site.
4. **Mainnet proof, the merge gate.** The lib-mode walker gains an ids-and-parse-only mode (no script evaluation) and two checks: ergots' tx id equals the chain's, and each output box id equals the chain's. It runs from h=1 to the tip. The full evaluating walk is optional on top.
5. **Gates:** `npm test`, `npm run typecheck`, jsdom for the three packages, and the bare-root run. After the push, SANTA re-grades Dasher: the four reds should turn green and nothing else should move.

## JVM truth requested from SANTA (sent at the start of implementation)

- a sized box tree whose body runs past the 4096 limit;
- an unsized tree with a soft-fork failure, as a Box constant inside a sized tree;
- a nested rule-1012 failure inside a sized tree;
- Int-rooted box trees, sized and unsized, in a Box and in a tx output;
- a parsed tree with header bits 5–7 set, round-tripped;
- an eval-tier tx whose output declares the wrong size: its tx id, and that output's `propositionBytes` against its `bytes` inside the creating tx's script.

## Faithfulness risks

- **`exprTpe` could mistype an honest root,** which would degrade or reject an honest box. The mainnet run is the check.
- **The re-encode fallback must parse with the box rules.** A lenient re-parse would re-encode a tree that ingest would have degraded.
- **The cache is keyed by a bytes instance,** so it goes stale if the bytes are mutated. This is documented, as for `_box-id.ts`.
- **Cost:** one `serializeTree` per output tree, cached. A parsed box is not parsed twice.

## Follow-ups (not in this spec)

- Register re-encoding, once SANTA answers follow-ups 6–7.
- The tree-version check (residual 2) and B-full (residual 3).
- Release per `RELEASING.md`, on the user's go-ahead.
