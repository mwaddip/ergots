# F5 batch 3 — checkType class + register ingress + header gates (design)

Status: DRAFT 2026-06-08, awaiting approval. Closes the 5 dasher over-accepts SANTA
pinned with the batch-1 witnesses (dasher 23→28; fixes flip them back). Adversarial-only
(no mainnet path) but consensus-relevant — the JVM rejects, ergots accepts.

Ledger: `docs/specs/2026-06-06-ergoscript-conformance-run-design.md` (§F5 members:
checkType class, rule-1019, rule-1012). Witnesses delivered by SANTA 2026-06-08
(reply in `~/projects/santa/prompts/f4-santa-asks.md`).

## The 5 reds → 4 fixes (2 slices)

| W | witness (tree_bytes_hex) | ver | JVM | ergots now | fix slice |
|---|---|---|---|---|---|
| W1 | `008602480101010101010402` Tuple((Bool,Bool,Bool)const, 1) | v0 | errored "Unsupported tuple type" | accepts @25 | eval (checkType) |
| W2 | `1002480101010101010402860273007301` same via ConstantPlaceholder | v0 | errored (same) | accepts | eval (checkType) |
| W3 | `008c6001040a01` SelectField((5,), 1) | v0 | errored "Invalid type returned by evaluator" | Int 5 @15 | eval (SelectField) |
| W6 | `03050101017300` header 0x03 (v3, size bit clear) | v3 | errored at header parse | parses+evals | wire (rule-1012) |
| W7 | `1b33…c17300` v3 Const(SBox) R4=Option[Int] | v3 | errored at box deserialize | parses | wire (rule-1019) |

**Already green — vendor as regression pins, no code:** W4 EQ-of-non-pair-tuples (JVM
arity-errors at `Tuple.eval` values.scala:797 BEFORE EQ runs — no EQ-tuple comparer cost
exists; ergots already errors via batch-2 `tuple-invalid-arity`). W5a/W5b substConstants
version-source (batch-1 C1 covers both: outer-v2→errored, outer-v3→SUCCESS Coll[Byte]@222).

## Source-confirmed (JVM canonical, read 2026-06-08)

**checkType (SType.scala:200-205 `isValueOfType`):**
```
case t: STuple => if (t.items.length == 2) x.isInstanceOf[Tuple2] else sys.error("Unsupported tuple type")
case tF: SFunc => if (tF.tDom.length == 1) x.isInstanceOf[Function1] else sys.error("Unsupported function type")
```
The hard reject fires ONLY on a non-pair `STuple` or non-unary `SFunc` *declared type* — it
does NOT recurse into SColl/STuple children in one call (nesting is covered by the per-item
checkType calls at the Tuple/CC arms). `Value.checkType` is called at 9 seams (values.scala):
ConstantPlaceholder(412), Tuple items(801,804), ConcreteCollection(865), ValUse(962),
BlockValue valdef(998)+result(1005), FuncValue param(1045)+body(1051). NOT plain Constant,
NOT MethodCall.

**SelectField (transformers.scala:297-308):** matches ONLY `Tuple2`; non-pair input (a
1-tuple is `Coll[Any]` at runtime, Evaluation.scala:99-102) → `Value.typeError` →
"Invalid type returned by evaluator".

**rule-1012 CheckHeaderSizeBit (ValidationRules.scala:138-151, enforced
ErgoTreeSerializer.scala:219 `deserializeHeaderAndSize`):** `version != 0 && !hasSize(header)`
→ throw. Unconditional at parse. Also fires on substConstants TEMPLATE headers (same parse path).

**rule-1019 CheckV6Type (ValidationRules.scala:165-205) — UNCONDITIONAL, ALL VERSIONS**
(in ruleSpecsV5 AND ruleSpecsV6; corrects the ledger's "v≥3" note — that was the body-constant
SOption gate, a different surface). Enforced at box-register deserialize (ErgoBoxCandidate.scala:232)
and context-extension parse (ContextExtension.scala:60):
```
def v6TypeCheck(t) = if (t.isOption || t.typeCode == SHeader || t.typeCode == SUnsignedBigInt) throw ...
def step(s) = s match { case STuple => items.foreach(step); case SCollection => step(elemType); case _ => v6TypeCheck(s) }
```
Type set: {SOption(any), SHeader, SUnsignedBigInt}. Recurses STuple items + SColl elemType
(STuple matched before SColl since STuple <: SColl). Version-agnostic: a v0 SBox with an
Option-typed register rejects too.

## Design calls (resolved)

**Q1 checkType breadth — shared helper at the data seams.** New helper
`assertValueTypeSupported(tpe: SType)` (eval): throws `'unsupported-value-type'` iff `tpe` is a
non-pair `STuple` (items.length≠2) OR non-unary `SFunc` (the two isValueOfType sys.error
conditions; top-level only, NOT recursive — matching the JVM's single-call shape). Called at the
STuple/value data seams ergots can reach: **Tuple items** (tuple.ts — W1), **ConstantPlaceholder**
(const-placeholder.ts — W2), and the other data seams that flow a declared type — **ConcreteCollection
items, BlockValue valdef+result, ValUse** — for faithful coverage of any non-pair-tuple value flow.
**Scoped OUT (documented residual, ask SANTA for a witness): the FuncValue/Apply param+body SFunc
arms** (P6 closure path) — no SFunc witness, and landing an arity gate on the closure path blind
(no JVM-blessed pin) risks a different divergence; the helper already rejects a non-unary SFunc
*value* flowing through a data seam, so the residual is only the lambda-define/apply-specific seams.
(Rationale: verify the reference with a vector before gating the closure path — CLAUDE.md.)

**Q2 rule-1019 — unconditional, recursive, register leg only.** New predicate `containsV6RegisterType(tpe)`
(wire): true iff `tpe` (recursing STuple items + SColl elemType) contains SOption / SHeader /
SUnsignedBigInt. Reject at register ingress (`parseRegisterExprWithTag`, parse-svalue.ts) regardless
of tree version, code `'register-v6-type'`. **Extension leg: N/A this batch** — ergots has no
context-extension WIRE parser (extensions are built in `makeContext`, not deserialized); documented
residual, applies if/when extension wire-parsing lands. Distinct from the existing
`validate-v6-types.ts` predicate (that one is {SUnsignedBigInt, SFunc} for the tree-body/constantTypes
v6 gate — different set, different surface); do NOT merge.

## Tasks (subagent-driven TDD, implementer → spec review → quality review per task)

- **T1 — facts/ contract** (direct, contract-first): `facts/ergoscript-eval.md` (checkType helper +
  `'unsupported-value-type'`; SelectField non-pair) and `facts/ergoscript-wire.md` (rule-1012
  `'header-version-requires-size'`; rule-1019 `'register-v6-type'`). EvalError + wire-error tallies.
- **T2 — checkType class** (W1+W2): `assertValueTypeSupported` helper + calls at Tuple/ConstantPlaceholder
  (+ CC/BlockValue/ValUse data seams). New eval code `'unsupported-value-type'`. SFunc-arm residual documented.
- **T3 — SelectField non-pair** (W3): reject arity≠2 input in select-field.ts (after input eval, before
  index bounds). New code `'select-field-non-pair'` (the JVM typeError shape; distinct from the existing
  non-Tuple and index-OOB checks).
- **T4 — rule-1012 header size bit** (W6): gate in `wire/ergo-tree.ts` header parse — `version>0 && !hasSize`
  → `'header-version-requires-size'`. Apply at BOTH the main tree-header parse and the substConstants
  TEMPLATE-header parse (find the template parse site; JVM enforces 1012 there too). Mechanical.
- **T5 — rule-1019 register ingress** (W7): `containsV6RegisterType` recursive predicate + reject in
  `parseRegisterExprWithTag`, all versions. New wire code `'register-v6-type'`. Extension leg residual documented.
- **T6 — vendor + conformance**: vendor all 7 witnesses (5 red→green + W4/W5a/W5b green pins) →
  test/fixtures/conformance/{v5,v6}/; register in cost-v5/cost-v6. The v0 witnesses (W1/W2/W3) — confirm
  the harness handles ergoTree-version-0 envelopes (santa-eval/v2).
- **T7 — gate + close-out**: full monorepo green; ledger + SESSION_CONTEXT + API.md (if surface changes);
  coordination (ergots-leads-both-libs note already routing via SANTA; SFunc-witness ask; extension-leg note).

## Walker safety
All 4 fixes are adversarial-only and walker-safe: mainnet boxes can't carry v6-typed registers (node
enforces rule-1019); mainnet v>0 trees carry the size bit (node enforces rule-1012); non-pair Tuple/SelectField
values don't occur in compiler output. The walker (green through tip) won't regress. Confirm via the
full harness suite (incl. the h=2..10 walk) at T7.

## Gate
build + tsc ×4 + full monorepo (packages 4835+ / harness) green; conformance +7 (299→306). New codes:
~2 eval (`'unsupported-value-type'`, `'select-field-non-pair'`) + ~2 wire (`'header-version-requires-size'`,
`'register-v6-type'`) — finalize exact reuse-vs-new in T1.

## Out of scope / residuals (tracked)
- checkType FuncValue/Apply SFunc-arity arms (P6 closure path) — needs an SFunc witness first.
- rule-1019 context-extension leg — no wire ingress yet.
- The 2 dasher-adapter items (Ask 8 lastBlockUtxoRootHash, getRegV5 taxonomy) — SANTA-side, separate track.
