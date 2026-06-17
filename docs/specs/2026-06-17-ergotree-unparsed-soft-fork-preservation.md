# 2026-06-17 — ErgoTree unparsed soft-fork body preservation (structured `parseTree`)

**Status:** design agreed (discriminated-union representation + eval-reject ripple in scope). Implementation: TDD.

## Problem

The dasher conformance CI surfaced a coal: `wire/v6/authored ErgoTree.unparsed_soft_fork_roundtrip`
(vectors `0b01fd` and `0b03fd0102`, expected `roundtrip`) — ergots **panics** where rudolph (the JVM,
the reference) round-trips.

`0x0b` decodes to ErgoTree header **version 3 + hasSize** (bit 3, 0x08). The body is size-prefixed:
`01`→1-byte body `fd`; `03`→3-byte body `fd0102`. Opcode `0xfd` (= `LastConstantCode` 112 + shift 141)
is `CollRotateRight`'s code — present in the OpCode enum but **undispatched** by the Expr parser, so an
eager parse errors.

ergots' structured `parseTreeFromReader` eagerly `parseExpr`s the hasSize body → hits `0xfd` →
throws `ExprParseError('opcode-reserved')`, uncaught. So `parseTree`/`serializeTree` reject a tree
both references preserve.

## Verified mechanism (JVM and sigma-rust AGREE — ergots is the lone outlier)

- **JVM** `ErgoTreeSerializer.deserializeErgoTree` (`ErgoTreeSerializer.scala:141-214`): reads header +
  hasSize size-prefix (`deserializeHeaderAndSize`, `:217-238`); tries to deserialize the body; on
  `ValidationException` (from `CheckValidOpCode`, rule 1002, `ValidationRules.scala:54-67`) **when
  `sizeOpt = Some` (hasSize set)** → rewind, read `bodyPos - startPos + treeSize` bytes, construct
  `Left(UnparsedErgoTree(bytes, ve))` (`ErgoTree.scala:19-22`). Without hasSize (`None`) → rethrow
  (reject). `serializeErgoTree` (`:105-128`): `Left(UnparsedErgoTree(bytes, _)) => bytes` verbatim.
- **sigma-rust** `ErgoTree::parse_with` (`ergo_tree.rs:164-220`): `if header.has_size()` → read size,
  buffer body, try `sigma_parse_sized`; on `Err(error)` → capture the full bytes →
  `ErgoTree::Unparsed { tree_bytes, error }` (enum `:115-130`). `sigma_serialize`:
  `Unparsed { tree_bytes, _ } => write_all(&tree_bytes)` verbatim.

Both degrade-to-opaque **only when hasSize is set**; without it, both reject (that is the soft-fork
contract — an old node can skip an unparsable proposition only because the size prefix lets it). The
ergots facts contract already names this (`facts/ergoscript-wire.md:158`, "captured verbatim as
`ErgoTree::Unparsed { tree_bytes, error }` … rather than throwing"), but it was implemented only on
the box-capture path (`consumeTreeFromReader`, which skips a hasSize body without parsing), never on
the structured `parseTree`. The coal is exactly that overlooked gap.

## Decision

Represent an unparsed tree as a first-class discriminated-union arm, mirroring both references' enums:

```ts
type ErgoTree = ParsedErgoTree | UnparsedErgoTree
```

`ParsedErgoTree` keeps the current fields (`header`, `constantTypes`, `constants`, `body`).
`UnparsedErgoTree` carries the decoded `header`, the **full verbatim tree bytes**, and the
capture-time error. The exact discriminant encoding is chosen during implementation to minimise
constructor churn, but every `tree.body` consumer must be TS-forced to handle the unparsed arm.

## Changes

1. **`mir/types.ts`** — split `ErgoTree` into `ParsedErgoTree | UnparsedErgoTree`.
2. **`wire/ergo-tree.ts` `parseTreeFromReader`** — when `hasSize` is set and the constants+body parse
   throws, rewind to the tree-start position, capture the full tree bytes verbatim → return
   `UnparsedErgoTree`. Without hasSize → rethrow (unchanged). Gating mirrors the references exactly
   (`assertHeaderSizeBit` + the declared-size-overflow check already run before the inner parse).
3. **`wire/ergo-tree.ts` `serializeTree`** — `UnparsedErgoTree` → return its verbatim bytes.
4. **Eval ripple** — `evaluate`/`evaluateWith` (`eval/evaluate.ts`) and `validate-v6-types.ts` and any
   other `tree.body`/`tree.constants` consumer: `UnparsedErgoTree` → reject with a clear `EvalError`
   (unspendable reserved/unparsed script). New code `'unparsed-ergotree'`.
5. **Address** (`address.ts`) — `parseTree` may now return `UnparsedErgoTree` (round-trips); eval
   rejects it. No address-codec change needed.

## Scope / consensus

Net accept/reject is **preserved**: spending such a box is still rejected — today at parse-time,
after the fix at eval-time (a reserved-opcode script is unspendable until a soft-fork defines it). The
change is wire round-trip faithfulness + matching the references' parse-vs-preserve boundary. **No new
on-chain acceptances.** The box-capture path (`consumeTreeFromReader`) is unchanged — it already
opaque-skips, so SBox / transaction-candidate byte-stability is unaffected (verify nipopow + transaction
suites stay green).

## Tests

- Vendor the SANTA `ErgoTree.unparsed_soft_fork_roundtrip` vector (`0b01fd`, `0b03fd0102`) into the
  conformance corpus (`test/fixtures/conformance/wire/`).
- **RED:** `serializeTree(parseTree(bytes)) === bytes` for both vectors (currently throws).
- **hasSize gating:** a NON-hasSize tree carrying the same reserved opcode still rejects (no
  over-broad leniency — the soft-fork tolerance is hasSize-only).
- **Eval-reject:** evaluating an `UnparsedErgoTree` throws the new `EvalError('unparsed-ergotree')`.
- **Gate:** ergoscript node + jsdom, `tsc --noEmit`, build; `facts/ergoscript-wire.md` updated.

## Faithfulness risks

- The catch must be gated on `hasSize` and scoped to the sized inner region (mirror both refs). A
  too-broad catch would accept trees the references reject.
- The `UnparsedErgoTree` must store the bytes from the **tree-start** position (header byte onward),
  not just the body, so the round-trip is byte-identical including the header + size VLQ.

## Update (2026-06-17) — degrade-set is the JVM `ValidationException` class; B-core vs B-full

Verifying the JVM (with a SANTA vector to follow) revealed the soft-fork degradation is broader than
reserved opcodes. `ErgoTreeSerializer.deserializeErgoTree` catches **`ValidationException`**
(`ErgoTreeSerializer.scala:197`) and degrades to `UnparsedErgoTree` when `hasSize`; a
`SerializerException` / reader-underflow escapes that catch → rejects even for a sized tree. The
`ValidationException` class includes not only `CheckValidOpCode` (rule 1002, reserved opcodes) but also
`CheckSerializableTypeCode` (rule 1009 — the pre-v3 Option/Header DATA gate, which throws a
ValidationException *"in order to be able to interpret it as soft-fork condition"*,
`ValidationRules.scala:135-144`), plus `CheckTypeCode`/`CheckPrimitiveTypeCode`, `CheckTypeWithMethods`/
`CheckAndGetMethod`, and `CheckPositionLimit`. So **a v2 hasSize tree with an Option/Header constant
degrades to Unparsed, it does not reject** (verified chain, agent-traced + cross-checked) — ergots' prior
reject was a wire-conformance divergence.

### B-core (SHIPPED)
`parseTreeFromReader`'s catch degrades to `UnparsedErgoTree` only when `hasSize` AND the failure is in the
VERIFIED pure-`ValidationRule` equivalent set
`SOFT_FORKABLE_PARSE_CODES = { opcode-reserved, unknown-opcode, soption-tree-version-too-low }`
(`wire/ergo-tree.ts isSoftForkableParseError`); everything else REJECTS (malformed VLQ, truncation, value
overflow, type-code-0 / invalid-prefix, structural arity).

**`sheader-tree-version-too-low` is NOT in the set — SHeader REJECTS** (corrected after an adversarial
review caught an over-inclusion). Unlike SOption, SHeader (typeCode 104) is neither `== OptionTypeCode` nor
`> LastDataType` (111), so JVM rule 1009 (`CheckSerializableTypeCode`) does NOT throw a `ValidationException`
for it — it falls through to a DIRECT `SerializerException` (`CoreDataSerializer.scala:146`) that escapes the
`UnparsedErgoTree` fallback → the JVM rejects a hasSize SHeader-DATA tree. (An early "by analogy to SOption"
inclusion; SOption is the special case, SHeader is not.) SHeader's degrade/reject thus belongs to the B-full
residual class (it's a `SerializerException`, not a `ValidationException`).

Tests: `soption-version-gate` (4) + `ergo-tree` header-bits (1) updated to expect Unparsed (Option / reserved
opcode degrade); `svalue-sheader-roundtrip` keeps expecting reject (SHeader rejects, correctly); the
`svalue-sheader-mutation` kill criterion gained `isUnparsedTree ⇒ detected/killed` (a mutation that produces a
valid soft-fork tree is detected, keeping the strict 90% threshold). The v0 (no-size) Option reject is
unchanged (`sizeOpt=None` → rethrow). Spend-path note (`transaction/src/validate/stateful.ts`): an unparsed
input proposition threads `[]` constants and `evaluateWith` rejects with `EvalError('unparsed-ergotree')`
(`ErgoTree.toProposition` on `Left(UnparsedErgoTree)` likewise throws on the JVM — box unspendable).

### B-full residual (research scheduled AFTER this fix — user-requested 2026-06-17)
The complete `ValidationException` degrade-set is broader, but ergots' error codes don't map cleanly:
- `'invalid-type-code'` (`parse-stype.ts`) CONFLATES a **reject** case (type code 0, `:118` = JVM
  `InvalidTypePrefix`, a direct `SerializerException`) with **degrade** cases (unknown / out-of-range code
  = `CheckTypeCode` / `CheckPrimitiveTypeCode`, a `ValidationException`). Closing it requires splitting the
  code by site.
- Method gates (`CheckTypeWithMethods` 1010 / `CheckAndGetMethod`) and the position limit
  (`CheckPositionLimit` 1014 ↔ ergots `max-tree-depth-exceeded`) are degrade-candidates needing per-site
  classification.
- Reader underflow / `vlq-overflow` / `value-out-of-range` stay reject (the `SerializerException` class).

**The research:** audit every wire-parse error site (`ExprParseError` / `STypeParseError` /
`SValueParseError` / `ReaderError`) against the JVM `ValidationException`-vs-`SerializerException` boundary,
split conflated codes, and extend `SOFT_FORKABLE_PARSE_CODES` to the full verified class — each boundary
case pinned by a SANTA-blessed vector (does the JVM round-trip a hasSize tree carrying the construct, or
throw?). The residual is **adversarial-only** (honest trees never carry an unknown type code or an
unsupported method inside a pre-version tree), which is why B-core ships first; closing it is genuinely
broad work — a sanctioned residual per the project's adversarial-path rule.
