# 2026-06-17 — ErgoTree deserialize unification (box propBytes reject the non-soft-forkable class)

**Status:** design agreed (unify onto one tree-deserialize; the public `parseTree` API becomes reference-faithful — there are no consumers yet, so the behavior change is a correction, not a break). Implementation: TDD. Box-path twin of `docs/specs/2026-06-17-ergotree-unparsed-soft-fork-preservation.md` (B-core).

## Problem

SANTA's `Box.softfork_header_constant_reject` (`wire/v6/authored`, `blessed_by: jvm:sigma-state-6.0.3`) caught ergots **over-accepting** an `ErgoBox` the JVM rejects. The box's `propositionBytes` are a size-flagged ErgoTree with one segregated `SHeader` constant (typeCode `0x68`). The JVM grades it `errored`; ergots parses the whole box cleanly.

This is inconsistent with how ergots treats the **same tree bare**:

- **Bare** (`parseTree`): ergots **rejects** it — `SValueParseError('sheader-tree-version-too-low')`. ✓ (the B-core fix this is a twin of)
- **In a box** (`parseSValue(SBox)` → `parseErgoTreeBytes`): ergots **accepts** (skip-parses the body, captures the span, round-trips). ✗

Reproduced against the canonical vector bytes (261-byte box): `parseSValue({tag:'SBox'}, 2, r)` consumes all 261 bytes and returns a `Box`, while `parseTree` on the *same* captured `ergoTreeBytes` throws `sheader-tree-version-too-low`. This is a crafted-bytes consensus over-accept on the **box→boxId path** — a latent fork the moment a miner puts such a box in a block.

## Verified mechanism (JVM and sigma-rust agree — ergots' box path is the lone outlier)

ergots has **three** tree-parse ingresses, and they disagree:

1. `parseTreeFromReader` (structured; used by `parseTree`, `ergo-tree.ts:185-306`) — parses constants+body, degrades hasSize+soft-forkable → `UnparsedErgoTree`, **rejects** SHeader. ✓
2. `consumeTreeFromReader` (span-capture; used by the box's `parseErgoTreeBytes`, `ergo-tree.ts:332-364`) — for a hasSize tree it **skips the body entirely without parsing** (`:345-357`). It never reaches the SHeader constant, so it never rejects — and that holds for the *whole* non-soft-forkable parse-failure class, not just SHeader.
3. `substituteConstantsBytes` (`ergo-tree.ts:593+`) — parses constants (so it would reject SHeader); a different path, not in scope.

Both reference implementations fully parse the box's tree:

- **JVM** `ErgoBoxCandidate.parseBodyWithIndexedDigests` reads the tree via `ErgoTreeSerializer.deserializeErgoTree(r, MaxPropositionSize)` (`ErgoBoxCandidate.scala:194`). `deserializeErgoTree` (`ErgoTreeSerializer.scala:141-214`) **always** runs `deserializeConstants` (`:155`, `:245-266`) — there is no skip-the-body path — so the SHeader constant hits `DataSerializer`, which throws a `SerializerException` (SHeader is neither `== OptionTypeCode` nor `> LastDataType` 111, so rule-1009 `CheckSerializableTypeCode` does not fire). The outer catch (`:196-208`) wraps **only** `ValidationException` → `UnparsedErgoTree`; a `SerializerException` escapes → **reject**. (For a *clean* parse the JVM uses the parse-determined `treeSize = r.position - startPos`, `:179`, not the declared size — see "Residuals".)
- **sigma-rust(eni)** `ErgoBox::sigma_parse` → `ErgoTree::sigma_parse` → `parse_with` (`ergo_tree.rs:181-239`, reached via the strict `sigma_parse` at `:623`). On a parse error it **rejects** `NonSerializableTypeCode` (`:206-211`, thrown at `data.rs:298-301`) and **degrades everything else** to `Unparsed` (`:212-219`). It reads the full declared size into a bounded buffer first (`:191-194`) and does **not** enforce buffer exhaustion — trailing inside the sized buffer is tolerated.

### The ERG-02 history (why the obvious fix has a trap, and why it's removable)

`consumeTreeFromReader` was *deliberately* made to skip-parse so it accepts a real mainnet burn box (h=545,684 — a hasSize tree whose body parses an Expr but leaves trailing bytes). The strict `parseTreeFromReader` rejects that box via an **inner-trailing check** (`ergo-tree.ts:293`) labelled "Audit ERG-02". So routing the box path through `parseTreeFromReader` as-is would re-break h=545,684.

But that inner check is **not** what ERG-02 required. The 2026-05-19 audit finding (`audit20260519/findings-ergoscript.md:71`, "Accepts and Drops Trailing Bytes") is about bytes *after* the declared tree — "append one extra byte to a valid tree" — and mandated "require **outer** reader exhaustion in `parseTree`." That is the check at `parseTree:455`; the regression test (`ergo-tree.test.ts:131`) appends garbage after a complete tree whose header is `0x10` (**no hasSize**), so it exercises only the outer check. The inner-body check at `:293` merely *cites* ERG-02 by analogy. It matches **neither** reference (JVM stops at parse-end; sigma-rust tolerates the sized-buffer leftover) and nothing else pins it (exhaustive `trailing-bytes` sweep: only the outer ERG-02 test + an unrelated nipopow one). **It is an over-application, and removable.**

## Decision

Collapse the box path onto the structured parser and make `parseTreeFromReader` the single, reference-faithful tree-deserialize:

1. **Remove the inner-trailing check** (`ergo-tree.ts:293`). A hasSize body that parses but leaves trailing inside the declared size is tolerated (matches both references; keeps the burn box alive).
2. **Delete `consumeTreeFromReader` and its `parseTreeBodyAfterHeader` helper.** They exist only to skip-parse hasSize bodies; with (1) they are redundant.
3. **Route `parseErgoTreeBytes` through `parseTreeFromReader`** — parse for validation, capture the consumed span, discard the structured tree. The box ingest now gets the *same* deserialize as everything else: SHeader (and the whole non-soft-forkable class) **rejects**; soft-forkable degrades to `Unparsed`; inner-trailing tolerated.
4. **`parseTree` keeps its outer-exhaustion check** (`:455`) — ERG-02's actual requirement (reject bytes after the whole tree).

**Public-API consequence (intentional):** `parseTree`/`parseTreeFromReader` become **lenient on inner-trailing** — `parseTree` on an inner-trailing tree goes reject→accept, matching sigma-rust. The rule is "the public API behaves like the reference"; there are no consumers yet, so this is a correction. One existing assertion flips: `consume-tree.test.ts:46` (currently asserts the strict parser throws on the burn box) becomes "does not throw".

**Sub-decision — Parsed vs Unparsed for a clean non-SigmaProp root with trailing (the burn-box shape):** ergots does **not** root-type-check, so `parseTreeFromReader` returns such a tree as `Parsed` (clean root, trailing ignored). sigma-rust returns it as `Unparsed` (via `RootTpeError`, `ergo_tree.rs:165-167`). This is **moot for consensus**: the box ingest captures the verbatim span (identical boxId either way), and a spend re-parses that span — a `Parsed` non-SigmaProp root fails reduction, an `Unparsed` tree fails the unparsed gate; **both reject the spend**. We take `Parsed` (minimal; no new root-type machinery). The only property it forfeits is byte-identical `parseTree`→`serializeTree` round-trip of a *standalone* inner-trailing non-SigmaProp tree — a property the JVM doesn't guarantee either (it captures `[start, parse-end)`), so it is not reference-required. Tracked as a residual (add `RootTpeError`→`Unparsed` only if a future SANTA vector demands it).

## Changes

- `packages/ergoscript/src/wire/ergo-tree.ts`:
  - delete the inner-trailing block (`:284-298`); delete `consumeTreeFromReader` (`:332-364`) and `parseTreeBodyAfterHeader` (`:402-429`).
  - `parseErgoTreeBytes` (`:387-391`): call `parseTreeFromReader(r)` (discard result), keep the span capture.
  - the file-header comment block (`:26-28`) already says trailing-within-size is "tolerated … we do the same" — that becomes true again; reconcile the now-stale comments.
- `packages/ergoscript/src/wire/parse-svalue.ts`: reconcile the SBox-arm comments (`:532-537`, `:574-580`) that describe the now-deleted `consumeTreeFromReader` / "body skipped without parse" path.
- `packages/ergoscript/test/wire/consume-tree.test.ts`: retarget at `parseErgoTreeBytes` / `parseTreeFromReader` (the surviving API). Flip the `:46` burn-box assertion to "accepts". Keep: body-size-overflow rejects; hasSize parseable accepts; hasSize=false malformed rejects; **add** the SHeader-in-box reject.
- No new error codes. The box path now surfaces the existing wire/SValue parse errors it previously skipped.

## Behavior matrix (box-path tree parse, after unification)

| tree body outcome | before (skip) | after (unified) | JVM | sigma-rust(eni) |
|---|---|---|---|---|
| clean parse | accept | accept | accept | accept |
| soft-forkable error (reserved opcode, SOption v-gate) | accept | degrade→accept | degrade→accept | degrade→accept |
| **non-soft-forkable (SHeader / NonSerializableTypeCode)** | **accept** | **reject** ✓fix | reject | reject |
| clean root + inner trailing (burn box h=545,684) | accept | accept | accept | accept |
| body-size-overflow (declared > remaining) | reject | reject | reject | reject |
| hasSize=false malformed body | reject | reject | reject | reject |
| outer trailing (bytes after whole tree, via `parseTree`) | reject | reject | (tolerated) | (tolerated) |

## Scope / consensus

In scope: the box/transaction ingest now rejects the non-soft-forkable parse-failure class on propBytes, matching the JVM and sigma-rust(eni). The SHeader-in-box over-accept closes — note SHeader-**as-constant** is rejected at `treeVersion < 3` and *parsed* at v ≥ 3 by all three impls (JVM `DataSerializer.scala:38-43` v3 override; sigma-rust `data.rs:269-271`; ergots' `< 3` gate at `parse-svalue.ts:711`); the vector is v2, in the reject band. The separate v ≥ 3 SHeader-DATA-accept question (ergots/sigma-rust accept where the JVM rejects at every version) is its own out-of-scope divergence. The burn box stays accepted (its *spend* shifts from a parse-reject today to a reduction-reject at `stateful.ts:197` under the unified parser; net reject preserved). `@ergots/transaction`'s `box-candidate.ts:83` and `parse-svalue.ts:584` share the one helper, so both tiers are fixed together.

The box path will now parse **every output box** genesis→tip — a superset of the spent boxes that `stateful.ts:180` already runs `parseTree` on. The definitive safety gate is a genesis→tip **re-walk** (see Tests).

## Residuals (documented, not closed here)

- **B-full** (the real exposure): ergots' soft-forkable set is the narrow B-core 3-code set (`opcode-reserved`, `unknown-opcode`, `soption-tree-version-too-low`), narrower than the JVM's full `ValidationException` class (unknown type/method codes, position limit). An output box whose tree fails with a JVM-degradable error that ergots throws *outside* those 3 codes would now **over-reject**. The box path inherits the *same* residual as `parseTree`; the re-walk bounds it concretely. Closing it = the tracked B-full audit.
- **Boundary** (sigma-rust-shared, JVM-divergent): for a clean-parse-plus-trailing sized tree the JVM lands at parse-end (`treeSize = r.position - startPos`) while ergots and sigma-rust land at declared-size-end. Not what this vector tests (an SHeader parse *failure*); left as-is (ergots stays sigma-rust-aligned). Its own item if a SANTA vector ever pins it.
- **Root-tpe → Unparsed fidelity** (the sub-decision above): ergots returns a clean non-SigmaProp root as `Parsed`, not `Unparsed`. Consensus-equivalent; standalone round-trip fidelity only.

## Tests (TDD)

1. **RED — box SHeader reject:** vendor the SANTA vector `Box.softfork_header_constant_reject` into `test/fixtures/conformance/wire/`; assert `parseSValue(SBox)` (and `@ergots/transaction`'s box codec) **rejects** it. The regression guard.
2. **GREEN preserved — burn box:** the h=545,684 shape (`cd07021a8e6f59fd4a`) still **accepts** via `parseErgoTreeBytes`, cursor lands at 9.
3. **Preserved rejects:** body-size-overflow; hasSize=false malformed; **outer-trailing** (the ERG-02 `parseTree` test stays green — outer check untouched); rule-1012 header-size-bit still fires first (`header-size-bit-rule1012.test.ts`).
4. **Parity:** the existing wire/eval/mutation suites stay green (whole-monorepo gate).
5. **Re-walk (safety gate, dev-tooling):** resume the `--mode lib` capstone walk genesis→tip on testnet (then mainnet) with the fix; zero new halts = the box-path parse is mainnet-safe and the B-full exposure is empirically bounded.

## Faithfulness risks

- **Over-reject via the narrow soft-forkable set** (B-full) — the one real risk; gated by the re-walk. If the walk halts on a box, that halt is a B-full case to triage, not a regression in this change.
- **Cursor/boundary drift** — `parseTreeFromReader` already advances the outer reader by the full declared size for hasSize trees (`readBytes(bodyByteLength)`), identical to the deleted skip, so `parseErgoTreeBytes` captures the same span. Pinned by test 2.
- **Missed ingress** — `substituteConstantsBytes` already parses constants (rejects SHeader); not routed through here, correct as-is.

## Follow-ups (out of this spec)

- `facts/ergoscript-wire.md`: fold the unified deserialize + the retired `consumeTreeFromReader`/inner-trailing into the wire-encoding/ingress section; note the box path shares `parseTreeFromReader`.
- `API.md` (ergoscript): note `parseTree`'s inner-trailing leniency.
- SANTA reply (user-routed): confirm the box arm landed + that the fix is the box-path twin of B-core; vendor the blessed vector as the cross-impl pin.
- Memory: update `project_ergotree_softfork_bfull_residual` — the box path now shares the B-core degrade/reject + the B-full residual.
