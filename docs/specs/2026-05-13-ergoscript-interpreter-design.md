# ErgoScript Interpreter Port — Design Spec

**Status:** Draft
**Date:** 2026-05-13
**Package:** `@ergots/ergoscript` (phase 2 of the `ergots` monorepo)
**Interface contract:** `facts/ergoscript.md` (written in phase 2a; extended per phase — that file wins on any interface disagreement)
**Brainstorm transcript:** this session, 2026-05-13

## Goal

A pure-TypeScript, browser-runnable port of sigma-rust's `ergotree-ir` and
`ergotree-interpreter` crates, validated byte-for-byte and value-for-value
against the `integration/ergots` branch. The wider goal that drives this is
to replace Fleet SDK's WASM dependency story with a native-TS stack for the
Ergo ecosystem — `sigma-js` (Scala.js cross-compile) exists but carries
Scala.js runtime baggage, opaque companion-object identifiers, and large
bundles. Pure native TS is the differentiator.

The wider and ultimate target is a complete port of `sigma-rust`, module
by module, such that the library can serve as the verification kernel of
an Ergo validating node. Wallet/light-client correctness (the Fleet SDK
replacement use case above) is a strict subset of validating-node
correctness, so completing the latter completes the former.
Browser-runnable remains an additional axis — validating-node correctness
does not require in-browser execution, but the project's browser-first
rules continue to apply throughout.

The port proceeds layer by layer (the proof package's discipline). Each
phase ships a complete feature of the interpreter; later phases extend
without breaking earlier ones.

## Non-goals (phase 2 arc)

- **Proof construction outside Sigma protocol prover.** Transaction
  building, key derivation, mnemonic handling, BIP32 — those live in the
  phase 3 wallet package or future sibling packages.
- **Multi-peer orchestration.** The Sigma protocol prover/verifier is in
  scope; collecting partial signatures across peers is not.
- **`ergoscript-compiler` (`.es` source → bytes).** Out of scope until
  upstream `ergoplatform/sigma-rust` PR #862 lands and the remaining 6/15
  sig-15 contracts close. Revisit then as a sibling package
  (`@ergots/ergoscript-compiler`).
- **AOT interpreter.** Upstream is deprecating AOT in v5.0.1
  (per `~/projects/sigmastate-interpreter/docs/aot-jit-switch.md`).
  We target `R5.0-JIT-verify` semantics exclusively.
- **Side effects in evaluation.** No filesystem, network, clock, PRNG, or
  `globalThis` reads. Same discipline as the proof package.

## Phase plan

Each phase = one feature of the interpreter, in dependency order. Phases
are versioned: phase N landing produces minor version `0.N.0`. Phase 2j
landing produces `1.0.0`. **No npm publishing during phase 2 progression
unless we hit a milestone we choose to broadcast** — the proof package was
published at v0.1.0 because it was already at end-of-phase-1 maturity; the
ergoscript phases reach that maturity only at 1.0.

| Phase | Slice | "Done" criterion |
|---|---|---|
| **2a — Wire format** | Parse + serialize every MIR variant. No evaluator. | Every fixture in the PR 862 corpora (45 legacy + 14 ecosystem + 9 sig-15 = 68 trees, plus synthetic VLQ/SType edge cases, plus real mainnet boxes) parses and re-serializes byte-identically. Address derivation helpers (P2PK recognition, `addressFromErgoTree`, `ergoTreeFromAddress`) ship here. ✅ shipped 2026-05-14 |
| **2b — Type system + constant evaluation** | `SType` discriminated union, `Const` evaluation, decodePoint and literal handling. | Trees that are purely constants/literals evaluate to the value sigma-rust returns. ✅ shipped as part of realized phase 2b evaluator chassis |
| **2c — Operators** | Binary/unary arithmetic, comparison, logical. | "1 + 2 = 3"-class trees evaluate to sigma-rust's value. ✅ shipped (BinOp 22 sub-ops, LogicalNot, BoolToSigmaProp) |
| **2d — Conditionals + blocks** | `If`, `BlockValue`, `ValDef` / `ValUse`, `FuncValue` / `Apply`, lambdas. | Trees with let-bindings, conditionals, and applied lambdas evaluate. ✅ shipped across realized phases 2d-A (unary numeric), 2d-B (Coll[Boolean] aggregators), 2e (FuncValue/Apply/XorOf + treeVersion) |
| **2e — Box / Context model** | `SBox`, `SContext`, `SHeader`, `SPreHeader` + all accessor methods. | Trees reaching `SELF.value`, `INPUTS(0).R4`, `HEIGHT`, etc., evaluate against fixture-captured contexts. ✅ shipped as realized phases 2f-narrow (Box wire + 7 Box-extract arms) + 2f-medium (full chain-state Context + 6 arms: GlobalVars, GetVar, OptionGet, OptionIsDefined, OptionGetOrElse, SelectField) |
| **2f — Collection operations** | map/filter/fold/forall/exists/size/append/slice/etc. | Collection method tests pass against captured sigma-rust evaluations. ✅ shipped 2026-05-16 as phase 2f Coll HOFs (9 arms: SizeOf, Append, ByIndex, Slice, MapColl, Filter, Fold, Exists, ForAll; 42/~70 arms total; Layer C3.a mutation testing at ≥ 90% kill rate per arm) |
| **2g — Sigma protocol** | `proveDlog` → `proveDhTuple` → `CAND` / `COR` / `CTHRESHOLD` composition. `@noble/curves` added. | ✅ shipped as **2g-medium** (2026-05-16) + **2g-combinators** (2026-05-17). Full SigmaBoolean verifier surface (leaf + Cand/Cor/Cthreshold); 3 new eval arms (Atleast/SigmaAnd/SigmaOr); pure-TS GF(2^192) module (Gf2_192Element + Gf2_192Poly); normalization helpers (cthresholdReduce/candNormalized/corNormalized); coverage 44 → 47 of ~70 arms; 4 new EvalError codes (36 → 40); 3 new VerifyError codes (5 → 8). |
| **2g.5 — Method-call dispatch** | MethodCall-routed Coll methods (`.indices`, `.zip`, `.zipWith`, `.reverse`, `.flatten`, `.getOrElse`) and numeric shift ops (`SNumericTypeMethods.shiftLeft/Right`). | ✅ shipped 2026-05-17 as **phase 2g.5** (measured corpus demand was much smaller than the original projection). 4 new eval arms (`Context`, `SigmaPropBytes`, `MethodCall`, `PropertyCall`); 3 registered handlers (`SBox.tokens`, `SContext.dataInputs`, `SColl.indexOf`); `EvalOpts.dataInputs` field; `SValue.Context` variant; 3 new EvalError codes (40 → 43); C2 corpus unlocked at `success=18/18`. Broader method surface (Coll utilities, Header methods, Bit shifts) deferred to phase 2g.6. See `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md`. |
| **2g.6 — Broader method-call surface** | Additional method-call handlers beyond 2g.5's three: Header methods, Coll utilities (`.indices`, `.zip`, `.zipWith`, `.reverse`, `.flatten`, `.getOrElse`, etc.), BinOp Bit shifts via `SNumericTypeMethods.shiftLeft/Right`, additional SBox/SContext/SGlobal methods. Specific method set scoped per the wider-mainnet corpus measurement (Task B). | ✅ shipped 2026-05-18 as **phase 2g.6** (5 method handlers + Global Expr arm + 2 SValue variants); coverage 51 → 52 arms; method-call handler registry 3 → 8; zero new EvalError codes (reused `'method-not-implemented'`, `'context-obj-not-context'`, `'context-field-missing'`). See `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md`. |
| **2h — AVL+ trees** | `SAvlTree`, contains / get / update + membership-proof verification. Reference is the `mwaddip/ergo_avltree_rust` fork (`main` HEAD `879545c`, including the three open upstream PRs #10/#11/#13). `integration/ergots` gains a `[patch.crates-io] ergo_avltree_rust = { path = … }` at the start of this phase. | Real AVL+ proofs from mainnet boxes verify against the fork-corrected semantics. |
| **2i — Predefs and oddments** | `substConstants`, `blake2b256`, `sha256`, `longToByteArray`, `byteArrayToBigInt`, `decodePoint`, `groupGenerator`, etc. | The remaining `SigmaPredef` surface evaluates. |
| **2j — Cost accounting** | Port JIT cost model from `integration/ergots`. Cost-charging is plumbed as a no-op from phase 2b forward; this phase fills in real cost values. | Cost values match sigma-rust's per-evaluation totals byte-for-byte on every block in the validation corpus (or a strong sample thereof — exact N decided in phase 2j planning). Byte-exact cost agreement is consensus-critical: a 1-unit cost drift between this verifier and JVM nodes is a hard fork. CI runs cost-equivalence on the validation corpus, not just the C2 mainnet-boxes corpus. |

**Note on realized vs planned phase numbering:** The umbrella plan above uses the original numbered sequence (2a–2j). Implementation revealed that several umbrella phases were each delivered across multiple narrower slices. The realized phase labels used in `facts/ergoscript.md` are: 2f-narrow (Box wire), 2f Stop α/β/γ (Box-extract arms), 2f-medium (chain-state Context), 2f Coll HOFs (9 collection HOF arms), 2g-medium (sigma protocol, leaf-only verifier), 2g-combinators (full SigmaBoolean verifier + Atleast/SigmaAnd/SigmaOr + GF(2^192)), 2g.5 (method-call dispatch + C2 corpus unlocker — measured demand was 4 arms + 3 handlers, not the full original projection). These realized labels are the historical record in `facts/ergoscript.md`; the umbrella table above maps them to the original planned phases. Do not renumber older docs — the realized labels in `facts/` are stable references.

## v1.0.0 release gate — validating-node-complete

The library's v1.0.0 release defines "validating-node-complete":

1. **100% pass-rate** against the validation corpus (every tree in every
   block parses, evaluates, and verifies — value+cost+signature agreement
   with sigma-rust's eval oracle on a strong-sample mainnet-block corpus;
   exact corpus size and selection methodology defined in phase 2j
   planning).
2. **Byte-exact cost agreement** with sigma-rust on every evaluation in
   the validation corpus. A 1-unit cost drift between this verifier and
   JVM nodes is a hard fork; consensus correctness requires byte-exact
   agreement.
3. **AVL+ membership-proof verification** (phase 2h) implemented and
   validated against fork-corrected `ergo_avltree_rust` semantics.
4. **All method dispatches** appearing in the validation corpus are
   implemented (no `'method-not-implemented'` throws against survey
   trees).
5. **All `Expr` arms** appearing in the validation corpus are implemented
   (no `'not-implemented-yet'` throws against survey trees).
6. **All predefs** appearing in the validation corpus are implemented
   (phase 2i).

Wallet/light-client correctness is a strict subset of these criteria, so
v1.0.0 also unblocks the Fleet SDK WASM-replacement use case
automatically.

## Architecture

### Repository layout

```
ergots/
├── packages/
│   ├── proof/                      @ergots/nipopow      ✅ shipped
│   └── ergoscript/                 @ergots/ergoscript ⏳ phase 2
│       ├── src/
│       │   ├── index.ts                 public surface re-exports
│       │   ├── mir/
│       │   │   ├── types.ts             SType + SValue + all Expr interfaces (one file)
│       │   │   ├── opcodes.ts           opcode byte constants
│       │   │   └── stype.ts             SType helpers / type equality / type inference helpers
│       │   ├── wire/
│       │   │   ├── reader.ts            cursor + bounds-checked reads
│       │   │   ├── writer.ts            append-only byte builder
│       │   │   ├── parse.ts             parseExpr dispatch (central switch)
│       │   │   ├── serialize.ts         serializeExpr dispatch (central switch)
│       │   │   ├── ergo-tree.ts         outer envelope (header byte, version, constants, body)
│       │   │   └── mir/                 per-variant parse + serialize logic
│       │   │       ├── const.ts
│       │   │       ├── if.ts
│       │   │       ├── block-value.ts
│       │   │       ├── coll-map.ts
│       │   │       └── …               (~80 files, one per MIR variant)
│       │   ├── eval/                    phase 2b+ — opcode evaluators
│       │   │   ├── eval.ts              central evaluator dispatch
│       │   │   ├── env.ts               Env (ValDef bindings) + CostAccumulator interface
│       │   │   ├── const.ts             evalConst — phase 2b
│       │   │   ├── operators.ts         evalArith/evalCmp/evalLogical — phase 2c
│       │   │   ├── if.ts                evalIf — phase 2d
│       │   │   └── …                   (~80 files at maturity, one per variant)
│       │   ├── context.ts               phase 2e — Box/Context/Header model
│       │   ├── sigma/                   phase 2g-medium / 2g-combinators
│       │   │   ├── prove-dlog.ts
│       │   │   ├── prove-dh-tuple.ts
│       │   │   ├── composition.ts       CAND/COR/CTHRESHOLD
│       │   │   ├── prover.ts            Sigma protocol prover
│       │   │   └── verifier.ts          Sigma protocol verifier
│       │   ├── avl/                     phase 2h
│       │   │   └── verify-proof.ts      AVL+ membership-proof verification
│       │   ├── cost.ts                  phase 2j — cost accumulator + per-op charges
│       │   ├── address.ts               phase 2a — address ↔ ergoTree conversion
│       │   └── crypto/
│       │       ├── secp256k1.ts         @noble/curves adapter (phase 2g+)
│       │       └── hashes.ts            blake2b + sha256 (used from phase 2a for address)
│       ├── test/
│       │   ├── fixtures/                regenerated by fixture-gen
│       │   ├── wire/                    parse + round-trip per fixture (phase 2a)
│       │   ├── eval/                    evaluation tests per phase (2b+)
│       │   └── …
│       ├── README.md                    consumer-facing
│       ├── API.md                       full API reference
│       └── package.json                 (publishes to npm only when ready)
├── facts/
│   ├── proof.md                    ✅ existing
│   └── ergoscript.md               ⏳ new — boundary contract, extended per phase
├── docs/specs/
│   ├── 2026-05-12-nipopow-proof-verifier-design.md   ✅
│   ├── 2026-05-13-no-gossip-decision.md              ✅
│   └── 2026-05-13-ergoscript-interpreter-design.md   ⏳ this file
└── fixture-gen/
    └── src/cmds/
        ├── …                            existing proof commands
        ├── wire/                        ⏳ phase 2a: ErgoTree parse fixtures
        ├── eval/                        ⏳ phases 2b+: (tree, context) → result fixtures
        └── …
```

**Single ergoscript package, not split into `-ir` + `-interpreter`.** Sigma-rust
splits them across crates; for a TS port, the boundary adds friction
without consumer payoff. If a downstream consumer eventually wants just
the parser without the evaluator (the only plausible split rationale),
extract `ergots-ergoscript-wire` as a subpath export later — same pattern
the proof package's `/envelope` subpath uses today.

### Type model

Three discriminated unions form the foundation: `SType`, `SValue`,
`Expr`. Chosen specifically for TypeScript's compile-time exhaustiveness
checking via `_exhaust: never`, **not** because Scala/Rust use the same
source-level pattern — they compile that pattern to different runtime
mechanisms (Scala: virtual dispatch via JVM v-tables; Rust: tag-based
jump tables; TypeScript: V8-optimized switch on string discriminant). The
exhaustiveness property is what TS adds over JS for IR-shaped problems
and is the load-bearing reason to prefer discriminated unions here.

```ts
// SType — type system, recursive
export type SType =
  | { tag: 'SBoolean' } | { tag: 'SByte' }   | { tag: 'SShort' }
  | { tag: 'SInt' }     | { tag: 'SLong' }   | { tag: 'SBigInt' }
  | { tag: 'SGroupElement' } | { tag: 'SSigmaProp' } | { tag: 'SBox' }
  | { tag: 'SAvlTree' } | { tag: 'SUnit' }   | { tag: 'SAny' }
  | { tag: 'SHeader' }  | { tag: 'SPreHeader' } | { tag: 'SContext' } | { tag: 'SGlobal' }
  | { tag: 'SColl',  elem: SType }
  | { tag: 'STuple', items: SType[] }
  | { tag: 'SOption', elem: SType }
  | { tag: 'SFunc',  args: SType[], result: SType, tpeParams: STypeVar[] }
  | { tag: 'STypeVar', name: string }

// SValue — runtime values; no embedded SType (recoverable from kind + elem)
export type SValue =
  | { kind: 'Boolean', value: boolean }
  | { kind: 'Byte' | 'Short' | 'Int',  value: number }
  | { kind: 'Long' | 'BigInt',         value: bigint }
  | { kind: 'GroupElement', value: Uint8Array }              // 33-byte compressed secp256k1
  | { kind: 'SigmaProp', value: SigmaBoolean }
  | { kind: 'Box', value: ErgoBox }
  | { kind: 'AvlTree', value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Coll',   elem: SType, items: SValue[] }
  | { kind: 'Tuple',  items: SValue[] }
  | { kind: 'Option', elem: SType, value: SValue | null }
  | { kind: 'Lambda', closure: Closure }                     // phase 2d+

// Expr — MIR node union, ~80 variants
export interface Const     { tag: 'Const',     tpe: SType, value: SValue }
export interface ValUse    { tag: 'ValUse',    id: number, tpe: SType }
export interface ValDef    { tag: 'ValDef',    id: number, rhs: Expr }
export interface BlockValue { tag: 'BlockValue', items: Expr[], result: Expr }
export interface If        { tag: 'If', condition: Expr, trueBranch: Expr, falseBranch: Expr }
export interface FuncValue { tag: 'FuncValue', args: { id: number, tpe: SType }[], body: Expr }
export interface Apply     { tag: 'Apply', func: Expr, args: Expr[] }
// … ~73 more
export type Expr = Const | ValUse | ValDef | BlockValue | If | FuncValue | Apply | …
```

Each `Expr` node knows its result type. Type checks during evaluation are
runtime asserts, not a separate type-check pass — sigma-rust's
`type_check::TypeCheckable::type_check` is for the compiler's MIR-lowering
phase, which we don't have.

### Dispatch architecture

**Central exhaustive switch in `eval/eval.ts`, one variant per `case`, each
delegating to a per-variant function in its own file.** Exhaustiveness via
`const _exhaust: never = expr` at the bottom of the switch. If multiple
orthogonal ops accumulate over time (eval + cost + pretty-print +
type-check), a future refactor to a visitor-style ops-interface map is
mechanical and doesn't touch the type unions.

The same pattern applies to `wire/parse.ts` and `wire/serialize.ts` —
each is a central switch on opcode-byte → per-variant function.

### Public surface (per-phase progression)

**v0.1.0 (after phase 2a):**

```ts
parseTree(bytes: Uint8Array): ErgoTree
serializeTree(tree: ErgoTree): Uint8Array

treeHeader(tree: ErgoTree): TreeHeader
treeConstants(tree: ErgoTree): SValue[]
treeBody(tree: ErgoTree): Expr

isP2PK(tree: ErgoTree): boolean
p2pkPublicKey(tree: ErgoTree): Uint8Array | null
addressFromErgoTree(tree: ErgoTree, network: 'mainnet' | 'testnet'): string
ergoTreeFromAddress(address: string): ErgoTree

// Discriminated unions per Section "Type model"
export type SType, SValue, Expr
export interface ErgoTree, TreeHeader

// Errors
class ErgoTreeParseError extends Error { code: string }
class ErgoTreeSerializeError extends Error { code: string }
```

**v0.2.0–v0.5.0 (phases 2b–2e):** incrementally add `evaluate(tree,
context?)`, `constantValue(expr)`, `isConstantTree(tree)`, `makeContext({…})`,
`interface Context`.

**v0.7.0 (phase 2g — delivered as 2g-medium + 2g-combinators):** `verifySignature` (leaf-only: TrivialProp + ProveDlog + ProveDhTuple) + structural `SigmaBoolean` 6-variant type + `CreateProveDlog`/`CreateProveDhTuple` eval arms shipped in 2g-medium. Conjecture verifier extension (Cand/Cor/Cthreshold) + `Atleast`/`SigmaAnd`/`SigmaOr` eval arms ship in 2g-combinators. `reduceToCrypto` and `prove` remain non-goals (see 2g-medium design spec Decision #3/#4 and Non-goals). `interface ProverSecret` deferred to phase 3 wallet package.

**v0.8.0 (phase 2h):** add `verifyMembershipProof`, `lookupInTree`.

**v1.0.0 (after phase 2j):** add `evaluateWithCost(tree, context, costLimit?)`.

**Subpath exports — none initially.** If a real consumer needs finer
tree-shaking, introduce `/wire` subpath at that point. Don't pre-build it.

**Stability commitment.** `parseTree`/`serializeTree`/`ErgoTree`/`Expr`/`SType`/
`SValue` shapes are stable from v0.1.0 forward. `Context` may grow fields
between v0.5.0 and v0.7.0 (designed-once-grown-additively per the
"Context shape: pre-design now" decision in Section 5 of the brainstorm).
`evaluate` may broaden inputs over phases but never narrows. `verify` /
`prove` are stable from v0.7.0.

## Validation strategy

Three layers of fixture-driven coverage. Same discipline as the proof
package, scaled to the larger surface.

### Layer 1 — Round-trip + parse correctness (every phase)

`fixture-gen` extends with a per-phase set of commands. For each
ErgoTree fixture:

- Sigma-rust parses the bytes via `ErgoTree::sigma_parse`, dumps the
  parsed `Expr` tree as JSON to
  `packages/ergoscript/test/fixtures/`.
- TS test: parse the bytes, structurally compare the produced `Expr` to
  the JSON, re-serialize, assert byte-identical output.
- Captures both byte-format and AST shape in one fixture pair.

### Layer 2 — Evaluation correctness (phase 2b+)

For each evaluable opcode or contract:

- Sigma-rust evaluates the tree against a known context, dumps the
  `SValue` result as JSON.
- TS test: parse, evaluate against the captured context, assert
  `SValue` equality.
- Fixture-gen emits canonical JSON form: bigints as strings,
  `GroupElement` bytes as hex, etc. TS parses it back to `SValue`.

### Layer 3 — Mutation tests

Single-byte flips at varied offsets across each fixture. Every mutation
must cause a specific error (`ErgoTreeParseError` with a structural code,
or `EvaluationError` with a semantic code). Catches parser brittleness
and evaluator silent-success.

At maturity (full opcode count), mutation testing samples mutations
(one per opcode dispatch path) rather than being exhaustive — matches
the proof package's approach.

### Corpora (priority order)

| Corpus | Source | Used from | Purpose |
|---|---|---|---|
| Synthetic edge cases | `fixture-gen` hand-rolled | Phase 2a | VLQ boundaries, deeply nested types, every SType variant, empty collections, ZigZag edges |
| PR 862 legacy-45 | `integration/ergots`: `~/projects/sigma-rust/sigma-rust/.../tests/fixtures/` | Phase 2a | 45 trees, in-repo Rust provenance, broad v1/v2 surface coverage |
| PR 862 ecosystem-14 | `~/projects/sigma-rust/sigma-rust/ergoscript-compiler/tests/` | Phase 2a | 14 trees, byte-matched to Scala node v6.1.2 — strongest non-mainnet ground-truth signal |
| PR 862 Significant-15 | same | Phase 2a (parse-only); phase 2e+ (evaluate) | Real keystone contracts (chaincash, ergoraffle, spectrum n2t/t2t, dexy bank, etc.). 9 byte-matched at start of phase, 6 in pipeline upstream |
| Mainnet boxes (real) | REST-fetch from local `ergo-node-rust:9052` | Phase 2a | Real boxes' `ergoTree` bytes — mainnet-fixture pattern from proof package, applied to scripts |
| sigma-rust unit tests | `~/projects/sigma-rust/sigma-rust/ergotree-{ir,interpreter}/src/.../tests/` | All phases | Per-opcode fixture-gen commands extracted from existing Rust tests |
| sigmastate-interpreter Scala tests | `~/projects/sigmastate-interpreter/.../shared/src/test/scala/` | Where Rust has parity gaps | Cross-version property tests, JIT cost spec. Reference when sigma-rust doesn't cover a case |
| Mainnet blocks (validated against sigma-rust) | REST-fetch from local `ergo-node-rust:9052` (`/blocks/{height}`, `/transactions/{tx_id}`); cross-validated against sigma-rust's eval oracle | Phase 2g.6+; corpus shape and size finalized in Task B planning | Block-level pass-rate testing; load-bearing for phase 2j cost-equivalence and the library-level validating-node-complete exit gate |

### Cross-runtime testing

Same discipline as the proof package. Vitest configured for both `node`
and `jsdom`. Bundle scan in CI: `grep -E "Buffer|process\.|require\(|node:"`
against `dist/` returns nothing. New: also scan for Scala.js-style
identifiers (`\$\$module\$`, `\$$` suffixed companion objects) to catch
accidental `sigma-js` imports — we're not going through that runtime.

### Two cross-cutting design decisions (carry through all phases)

1. **Cost-accumulator plumbed from phase 2b as a no-op.** Every evaluator
   signature is `(expr, env, costAcc) => SValue` with
   `costAcc.add(opcode)` as a no-op call until phase 2j. Avoids a 50-file
   refactor of every evaluator when 2j lands.

2. **Context designed as eventual shape from phase 2e.** Full context
   structure with optional/null fields where later phases will fill them
   in. Avoids non-additive breaking changes between v0.5.0 and v0.7.0.

## Browser compatibility

Hard rules carried verbatim from the proof package, enforced by the test
environment + CI bundle scans:

- No `Buffer`, no `process`, no `node:*` outside test files.
- No `node:crypto`, no `globalThis.crypto.subtle`. Hashing is
  `@noble/hashes` only; curve ops are `@noble/curves` only (phase 2g+).
- No WASM dependencies, direct or transitive. CI scans for `.wasm` files
  and `WebAssembly.instantiate` in `dist/`; also scans for Scala.js
  identifier patterns to catch accidental `sigma-js` imports.
- ESM only, ES2022 target. No CJS. No top-level await in published code.
- `bigint` used for `SLong`, `SBigInt`, cost values. Native everywhere we
  target (Node ≥ 20, evergreen browsers).
- Vitest runs each test under both `node` and `jsdom` environments.

## Dependencies

Runtime:
- `@noble/hashes` 2.2.0 — blake2b-256, sha-256, sha-512. Same pin as
  proof package.
- `@noble/curves` 2.2.0 — secp256k1 point ops + Schnorr-style signing.
  Pins `@noble/hashes` 2.2.0 transitively — version-locked pair. Added in
  phase 2g-medium.

Dev:
- `typescript` ^5.5
- `vitest` ^2 (with jsdom)
- `tsup` ^8
- `@types/node` ^22 (test-only)

Same dev surface as proof package.

## Error taxonomy

```ts
class ErgoTreeParseError extends Error { code: string }       // phase 2a — malformed bytes
class ErgoTreeSerializeError extends Error { code: string }   // phase 2a — invalid Expr structure
class EvaluationError extends Error { code: string }          // phase 2b+ — runtime eval failure
class SigmaProtocolError extends Error { code: string }       // phase 2g+ — proof/verify failure
class CostLimitExceededError extends Error { cost: number }   // phase 2j — cost > limit
```

Each carries a `code: string` matching one of a fixed enum:
`'truncated'`, `'unexpected-tag'`, `'oversized'`, `'vlq-overflow'`,
`'type-mismatch'`, `'missing-var'`, `'arithmetic-overflow'`,
`'invalid-group-element'`, etc. Programmatic dispatch via `code`;
human-readable via `message`. Same shape as `ProofParseError` /
`ProofVerificationError` in the proof package.

No other error classes exported. Internal panics (e.g., bug in
`@noble/curves`) surface as plain `Error` — those are contract violations
inside the package, not input issues.

**Tree size cap.** Defensive cap enforced at `parseTree` entry, before
allocation. Sigma-rust reads `tree_size_bytes` as a `u32` without an
explicit `MAX_TREE_SIZE` constant — the practical cap comes from the
box-size limits enforced at transaction validation. Real-world ErgoTrees
are small (largest in the PR 862 corpus is ergoraffle at 931 bytes); we
pick a value comfortably above that ceiling. **Proposed: 1 MB**, decided
in phase 2a planning. Rejection becomes `ErgoTreeParseError` with
`code: 'oversized'`.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cross-version semantics drift (Script v1/v2/v3) | Each fixture tagged with its script version; tests assert per-version semantics. AOT interpreter for pre-v3 historical blocks is a non-goal |
| Cost-parity drift between TS and `integration/ergots`'s JIT cost model (CONSENSUS-CRITICAL: any drift is a hard fork) | Phase 2j captures cost-per-evaluation as fixture values; CI runs cost-equivalence on the validation corpus (broad mainnet-block sample, not just the C2 mainnet-boxes corpus). Per-arm cost reads are cross-verified at fixture-gen time against sigma-rust's `try_eval_out` cost oracle. |
| `@noble/curves` API drift between 2.x minors | Pin exact `2.2.0` (no caret); upgrade only with explicit version bump + full corpus re-run |
| Scala.js `sigma-js` accidentally imported by downstream | Bundle scan in CI rejects Scala.js identifier patterns; README explicitly distinguishes |
| TS language-server slowdown on 80-arm union | Acknowledged in type-model rationale. Monitor; refactor to ops-interface map if hover times exceed ~200ms |
| Memory blowup on deeply nested trees | `MAX_TREE_SIZE` enforced at `parseTree` entry; mirror sigma-rust's cap |
| AVL+ fork drift | `integration/ergots` carries the `[patch.crates-io]` line at phase 2h; project memory + this spec updated |
| Cost-accumulator plumbed-but-unused complexity in early phases | `NoCostAccumulator` no-op instance; tests assert no-op behavior in pre-2j phases |
| Mutation testing combinatorial explosion at full opcode count | Sample mutations (one per opcode dispatch path) rather than exhaustive |
| Browser ESM bundle size at full opcode count | Per-variant files keep unused phase code tree-shakeable. Subpath exports introduced only when real consumers need finer granularity |
| Sigma protocol prover side-channel concerns | Out of scope for v1. Document as "verifier-grade, not prover-grade — use a hardware signer for high-value spends." Same posture sigma-rust takes for non-hardened proving |

## Open questions (not blockers)

1. **`SigmaBoolean` shape: structurally exposed or opaque?** Phase 2g
   produces `SigmaBoolean` (post-reduction sigma proposition tree).
   Exposing its CAND/COR/CTHRESHOLD/ProveDlog/ProveDhTuple structure lets
   wallet code introspect. Opaque + accessor methods is safer but less
   flexible. Phase 3 brainstorm will reveal the answer.

2. **Wallet sibling utilities — same package or separate?** v0.1.0 has
   `addressFromErgoTree` / `ergoTreeFromAddress` (no key material). The
   wallet PoC will need mnemonic + BIP32 + key derivation. Those don't
   depend on ergotree-interpreter. Probably `ergots-wallet` (the
   phase 3 package). Revisit at phase 3 brainstorm.

3. **`ergoscript-compiler` revisitation trigger.** Out of scope until PR
   862 lands AND a follow-up tightens the remaining 6/15 sig-15
   contracts. After that, separate brainstorm for
   `@ergots/ergoscript-compiler`. Captured in `project-ergots-direction`
   memory.

4. **`Context` shape vs sigma-rust's `ErgoStateContext`.** Phase 2e
   designs the full Context. Sigma-rust's `ErgoStateContext` is the
   reference, but a few fields (`pre_header_proofs`, validation-state) may
   not be needed for a verifier. Decide field-by-field in phase 2e plan;
   default: mirror sigma-rust surface, prune only with clear reason.

## Cross-references

- `facts/ergoscript.md` — written in phase 2a, extended per phase
- `facts/nipopow.md` — existing interface contract for the verifier
  package; reference template for `facts/ergoscript.md`
- `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` — proof
  package design spec; template for this one
- `docs/specs/2026-05-13-no-gossip-decision.md` — phase 2 placement
  rationale
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) —
  byte-format and implementation oracle
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical
  language specification for opcode semantics
- `~/projects/sigmastate-interpreter/docs/aot-jit-switch.md` — JIT vs AOT
  background; rationale for JIT-only scope
- `~/projects/sigmastate-interpreter/docs/perf-style-guide.md` — upstream
  performance guidance
- `~/projects/ergo_avltree_rust/` (branch `main`, HEAD `879545c`) —
  reference implementation for phase 2h with three upstream PRs applied
- `~/projects/ergo-node-rust/facts/validation.md` — phase 3 integration
  boundary (`DeferredEval` shape)
