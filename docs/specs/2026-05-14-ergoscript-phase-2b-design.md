# ErgoScript Interpreter — Phase 2b Design Spec

**Status:** Draft
**Date:** 2026-05-14
**Package:** `@mwaddip/ergots-ergoscript` (phase 2b — first evaluator slice)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec; phases 2a–2j)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-14

## Goal

Ship the smallest evaluator slice of `@mwaddip/ergots-ergoscript` — enough
infrastructure to evaluate the no-chain-state subset of ErgoTree
expressions, with the dispatch chassis sized to scale to all ~70 MIR
variants across 2c–2j.

Concretely: 8 per-variant evaluator arms (`Const`, `ConstPlaceholder`,
`BlockValue`, `ValDef`, `ValUse`, `Tuple`, `Collection`, `If`) plus the
central exhaustive dispatch, an `Env` for `ValDef` bindings, an
`EvalContext` for cost (and, in later phases, chain state), and a
`evaluate(tree, opts?)` public surface. Cost values copied from
sigma-rust at the pinned rev (`integration/ergots@ed5452cf`) and asserted
via fixture-gen from day one.

## Non-goals (phase 2b)

- **Type-system additions.** No `isSubtype`, no `lub`/`glb`, no
  standalone unification API. Sigma-rust doesn't expose these (subtyping
  is implicit in `unify_one`'s asymmetric rules; `lub`/`glb` don't exist
  upstream); the Scala compiler has `unifyTypes`/`msgType` but consumes
  them only in `SigmaTyper.scala` (compiler-only, never the evaluator).
  Neither evaluator (rust or scala) reaches for these primitives. We add
  `withSubst` only when phase 2d's `Apply` concretely needs it.
- **Operator arms.** `BinOp`, `LogicalNot`, `BoolToSigmaProp`, `And`,
  `Or`, `Atleast`, `Negation`, `BitInversion`, etc. — phase 2c.
- **Lambda arms.** `FuncValue`, `Apply` — phase 2d.
- **Chain-state arms.** `GlobalVars`, `ExtractAmount`,
  `ExtractRegisterAs`, `ExtractScriptBytes`, `Context`, etc. — phase 2e.
- **Collection HOF arms.** `Map`, `Filter`, `Fold`, `Exists`, `ForAll`,
  `Slice`, `Append`, `ByIndex` — phase 2f.
- **Sigma protocol.** `CreateProveDlog`, `SigmaAnd`, `SigmaOr` etc. —
  phase 2g.
- **AVL+, predefs, real cost accounting** — phases 2h, 2i, 2j.
- **`evaluateConstant(expr)` / `isConstantTree(tree)` helpers.**
  Mentioned in the umbrella spec but not shipped here — no concrete
  consumer; whole-tree `evaluate` covers inspection use cases.
- **No npm publish.** Same posture as the umbrella spec — local-only
  through phase 2j; first publish at `1.0.0` after 2j.

## Architecture

### Directory layout

```
packages/ergoscript/src/eval/                  NEW
├── eval.ts                  central exhaustive switch on Expr.tag
├── env.ts                   Env (immutable-extend Map<ValId, SValue>)
├── eval-context.ts          EvalContext + EvalOpts + EvalError
├── const.ts                 Const arm
├── const-placeholder.ts     ConstPlaceholder arm
├── block-value.ts           BlockValue arm
├── val-def.ts               ValDef arm (throws — only valid inside BlockValue)
├── val-use.ts               ValUse arm
├── tuple.ts                 Tuple arm
├── collection.ts            Collection arm
└── if.ts                    If arm
```

Mirrors phase 2a's `wire/mir/<variant>.ts` layout. Per-variant module
file with a single exported function `eval<Variant>(e, env, ctx) =>
SValue`. Central `eval/eval.ts` is the exhaustive dispatch switch with
`_exhaust: never` discriminant — adding a new Expr variant to
`mir/types.ts` becomes a compile-time error here until an arm exists.
The 60+ arms shipped across 2c–2j extend this directory additively.

### Dispatch pattern

```ts
// eval/eval.ts (excerpt)
export function evalExpr(e: Expr, env: Env, ctx: EvalContext): SValue {
  switch (e.tag) {
    case 'Const':              return evalConst(e, env, ctx)
    case 'ConstPlaceholder':   return evalConstPlaceholder(e, env, ctx)
    case 'BlockValue':         return evalBlockValue(e, env, ctx)
    case 'ValDef':             return evalValDef(e, env, ctx)
    case 'ValUse':             return evalValUse(e, env, ctx)
    case 'Tuple':              return evalTuple(e, env, ctx)
    case 'Collection':         return evalCollection(e, env, ctx)
    case 'If':                 return evalIf(e, env, ctx)
    // ~60 more arms across 2c–2j; each is a `'not-implemented-yet'`
    // throw stub in 2b until its phase ports the arm.
    default: {
      const _exhaust: never = e
      throw new EvalError(
        `evalExpr: variant '${(e as { tag: string }).tag}' not implemented in phase 2b`,
        'not-implemented-yet'
      )
    }
  }
}
```

The default arm only fires for variants that exist in the union but
have no `case` line — in 2b that's most of them. Phase 2c+ replaces
each `default`-fall-through with an explicit `case` calling its new
per-variant module.

### Public surface (v0.2.0)

Re-exported from `src/index.ts`:

```ts
evaluate(tree: ErgoTree, opts?: EvalOpts): SValue

interface EvalOpts {
  jitCostLimit?: number       // undefined = unlimited (signing-style)
  constants?: SValue[]        // overrides tree.constants if set
  // chain-state added in phase 2e: height, selfBox, inputs, outputs,
  // dataInputs, preHeader, headers, extension, treeVersion, ...
}

interface EvalContext extends EvalOpts {
  jitCost: number             // mutable accumulator
  addCost(amount: number): void                                // throws EvalError 'cost-limit-exceeded' if limit set + exceeded
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void  // base + ceil(nItems/chunkSize) * perChunk
}

makeContext(opts?: EvalOpts): EvalContext     // exported for advanced/repeated use

evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue   // takes a pre-built ctx; tests use this to inspect ctx.jitCost after eval

class EvalError extends Error { code: string }
```

**`evaluate` is the ergonomic happy path:** `evaluate(tree)` works with
defaults; `evaluate(tree, { jitCostLimit: 1_000_000 })` adds a limit;
`evaluate(tree, { constants: customConstants })` lets advanced consumers
override the tree's segregated constants. `evaluateWith` is the
introspection variant for tests and tooling that needs to read
`ctx.jitCost` after eval.

`EvalContext extends EvalOpts` — relationship explicit; phase 2e grows
the `EvalOpts` shape, `EvalContext` inherits.

`makeContext` is mostly used by `evaluate` internally but exported so
advanced consumers can build a Context once and reuse it (e.g., for
multiple `evaluateWith` calls on different trees with the same chain
state).

`evaluate(tree, opts)` internally:
1. Constructs `ctx = makeContext({ jitCostLimit: opts?.jitCostLimit, constants: opts?.constants ?? tree.constants })`.
2. Dispatches `evalExpr(tree.body, Env.empty(), ctx)`.
3. Returns the result.

The `?? tree.constants` is non-destructive — caller-supplied constants
take precedence.

### EvalContext + Cost

Phase 2b's `EvalOpts`:

```ts
interface EvalOpts {
  jitCostLimit?: number
  constants?: SValue[]
}
```

Phase 2e expands this additively with chain-state fields. The "additive
growth" decision (vs pre-declared full shape with optionals) was made on
the basis that we don't publish during 2b–2j progression — internal
consumers absorb a "Context grew required fields" change in a single
bump. Sigma-rust grew its Context fields incrementally too (via git
history, `tree_version`, `extension_provider`, `jit_cost_limit`,
`constants` all show up at different revs).

`EvalContext.addCost`:

```ts
addCost(amount: number): void {
  this.jitCost = Math.min(this.jitCost + amount, Number.MAX_SAFE_INTEGER)
  if (this.jitCostLimit !== undefined && this.jitCost > this.jitCostLimit) {
    throw new EvalError(
      `JIT cost limit (${this.jitCostLimit}) exceeded`,
      'cost-limit-exceeded'
    )
  }
}
```

Saturating add prevents accumulator wraparound on pathological inputs
(mirrors sigma-rust's `Context::add_jit_cost` `saturating_add` —
`ergotree-ir/src/chain/context.rs:77-86`). Throws synchronously; caller
catches.

**Why mutable, not immutable + rebuild-per-step:** sigma-rust uses
`Cell<u64>` for `jit_cost` because cost charges happen in tight inner
loops — every `Const` evaluation calls `add_jit_cost(5)`. Returning a
new EvalContext from each charge would allocate millions of objects on
real trees. Same posture as sigma-rust.

### Env

Immutable-extend `Map<ValId, SValue>`:

```ts
class Env {
  private readonly store: Map<number, SValue>
  static empty(): Env
  extend(id: number, v: SValue): Env  // returns NEW Env; original unchanged
  get(id: number): SValue | undefined
  has(id: number): boolean
}
```

`extend` clones `store` internally (mirrors sigma-rust's
`Env::extend` — `let mut new_store = self.store.clone()` in
`ergotree-interpreter/src/eval/env.rs:28-32`). Cost is O(n) per extend,
but BlockValue scopes are small in practice (<30 bindings in real
trees). If profiling later shows this hot, switch to a persistent map
(HAMT) without changing the public surface.

The wire-format parser side already maintains a parallel
`valDefTypes: Map<number, SType>` (populated at parse time). Phase 2b's
runtime `Env` is the value-side counterpart — same key shape, different
value type. Two parallel maps is fine; merging them isn't worth the
conceptual coupling.

### The 8 eval arms

| Arm | Behavior | Sigma-rust reference | Cost |
|---|---|---|---|
| **Const** | `ctx.addCost(5); return e.value` | `eval.rs:21-24` | 5 (`Constant = Fixed(5)`) |
| **ConstPlaceholder** | `ctx.addCost(1); if (!ctx.constants) throw 'const-placeholder-no-constants'; if (e.id >= ctx.constants.length) throw 'const-placeholder-id-out-of-range'; return ctx.constants[e.id]` | `eval.rs:52-64` | 1 (`Fixed(1) per Scala`) |
| **BlockValue** | Charge per-item envelope cost. Iterate `e.items` — every item MUST be a `ValDef` (else throw `'block-item-not-val-def'`). For each: eval its `rhs`, charge `ADD_TO_ENV_COST` (5), then `env = env.extend(rhs.id, value)`. After items, eval `e.result` and return its value. | `eval/block.rs` (the file note in the test at `block.rs:85-89` documents the parity-gap fix that ensures `ADD_TO_ENV_COST` is charged per ValDef). | Envelope: `addPerItemCost(1, 1, 10, items.length)` = `1 + ceil(n/10)`. Per-item: 5 (ADD_TO_ENV_COST) + rhs eval cost. |
| **ValDef** | `throw new EvalError("ValDef should be evaluated inside BlockValue", 'val-def-outside-block')` | `eval.rs:66-68` (`UnexpectedExpr`) | n/a (charged inside BlockValue) |
| **ValUse** | `const v = env.get(e.id); if (v === undefined) throw 'val-use-unbound'; ctx.addCost(5); return v` | `eval/val_use.rs:15` | 5 (`ValUse = Fixed(5)`) |
| **Tuple** | `ctx.addCost(15); return { kind: 'Tuple', items: items.map(item => evalExpr(item, env, ctx)) }` | `eval/tuple.rs:15` | 15 (`Tuple = Fixed(15)`) |
| **Collection** | `ctx.addCost(20)`. Iterate `e.items`, eval each, validate kind matches `e.elemTpe` (throw `'collection-elem-kind-mismatch'`), return `{ kind: 'Coll', elem: e.elemTpe, items: [...] }` | `eval/collection.rs:22` | 20 (`ConcreteCollection = Fixed(20)`) |
| **If** | `ctx.addCost(10); const cond = evalExpr(e.condition, env, ctx); if (cond.kind !== 'Boolean') throw 'if-condition-not-boolean'; return cond.value ? evalExpr(e.trueBranch, env, ctx) : evalExpr(e.falseBranch, env, ctx)` | `eval/if_op.rs:16` | 10 (`If = Fixed(10)`); short-circuit means non-taken branch's cost is NOT charged. |

**`addPerItemCost` (helper on EvalContext):** mirrors sigma-rust's
`Context::add_per_item_jit_cost` (`ergotree-ir/src/chain/context.rs:88-99`):

```ts
addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void {
  const chunks = Math.ceil(nItems / chunkSize)
  this.addCost(base + chunks * perChunk)
}
```

Used by `BlockValue` envelope cost; will be reused by 2f's collection
HOFs (`Map`/`Filter`/`Fold`/...).

**Three cross-cutting points:**

1. **`If` short-circuits but condition + If cost are charged eagerly.**
   Match sigma-rust exactly: charge the `If` envelope cost (10) first,
   then `condition` cost, then the *taken* branch's cost only. The
   non-taken branch is never evaluated. Document this in `eval/if.ts`.
2. **`BlockValue` strictness on items.** Sigma-rust uses
   `try_extract_into::<Spanned<ValDef>>` which errors on non-ValDef
   items — we mirror this with a typed `'block-item-not-val-def'`
   throw. The umbrella spec's "items can be discarded" framing was
   wrong; the real behavior is strict.
3. **`BlockValue` scoping is naturally correct under our immutable Env.**
   Sigma-rust uses a mutable `&mut Env` and so has to save/restore
   bindings explicitly when a nested BlockValue shadows an existing
   binding (`block.rs:35-62`). Our `Env.extend` returns a new Env that
   goes out of scope when the function returns, so the save/restore
   dance is unnecessary. The behavior is equivalent: a nested
   BlockValue's bindings don't leak into the enclosing scope.
4. **`Collection.elemTpe` consistency check** matches our 2a
   `serializeSValue`'s existing kind-validation. Phase 2b's runtime
   check is a defensive duplicate — sigma-rust's `Collection` parser
   already validates this at construction time, and our parser inherits
   that, so a well-formed AST won't trip the runtime check. Throwing
   `'collection-elem-kind-mismatch'` rather than silently ignoring
   surfaces any contract violation immediately.

## Validation strategy

Three layers, mirroring phase 2a's discipline. Cost validation is
itself layered (C1, C2, C3) across 2b and later phases.

### Layer 1 — per-arm fixtures (phase 2b)

`fixture-gen/src/cmds/eval/<arm>.rs` — one new module per arm shipped.
Each emits 5–15 entries of:

```rust
struct EvalFixture {
    name: String,                          // human-readable
    tree_bytes_hex: String,                // bytes that parse to a tree exercising this arm
    opts_json: serde_json::Value,          // EvalOpts to construct the Context
    expected_value_json: serde_json::Value, // sigma-rust's Value after eval
    expected_cost: u64,                    // sigma-rust's ctx.jit_cost_value() after eval
}
```

Sigma-rust is the oracle: fixture-gen builds a sigma-rust `Context`
from `opts_json`, runs `expr.eval(env, ctx)` on the tree's body, and
captures the result + cost. TS test loads the fixture, parses
`tree_bytes_hex` (already round-trip-tested in 2a), constructs an
`EvalContext` from `opts_json` via `makeContext`, calls
`evaluateWith(tree, ctx)`, asserts both:
- `value` equals `expected_value_json` (SValue-equal via existing
  helpers from 2a)
- `ctx.jitCost` equals `expected_cost`

This is layer **C1** of the cost-validation strategy — catches
mistype-when-porting bugs immediately.

### Layer 2 — mainnet_boxes corpus eval-filter (phase 2b)

New test file `test/corpus-eval.test.ts` walks the existing 173-tree
mainnet_boxes corpus from phase 2a (the corpus we built closing the 16
exprTpe gaps). For each tree:
- Attempts `evaluate(tree, makeContext({}))`.
- Tallies (a) eval succeeds (small subset — pure-constant inspection
  trees; expected ~5-10 of 173), (b) throws `'not-implemented-yet'`
  with a known variant tag (expected for most trees), (c) throws
  anything else (regression — fails the test).

The tally is logged so we can track the *evaluable subset* growing as
2c/2d/2e/2f land — same telemetry pattern as the parse-mutation test
suite from 2a.

This is layer **C2** of cost-validation: fixture-gen captures
synthetic-context whole-tree cost for *all* 173 entries (not just the
eval-able subset) by running sigma-rust's eval against a synthetic
empty Context (height=0, empty inputs/outputs/data-inputs, default
preHeader). The TS test asserts cost-equality on the eval-able subset
in 2b; the same fixture data starts being checked against more trees
as later phases land arms. By 2j, every tree sigma-rust can eval
against the synthetic context is also asserted by TS for value AND
cost.

Fixture schema (additive):

```json
{
  "box_id": "...",
  "ergo_tree_hex": "...",
  "block_height": 1779485,
  "round_trip_ok": true,
  "sigma_rust_eval": {
    "context_kind": "synthetic-empty",
    "ok": true,
    "value_json": {...},
    "jit_cost": 247
  }
}
```

If sigma-rust itself can't eval against the synthetic context (e.g.,
trees that read `INPUTS(0).R4` throw),
`sigma_rust_eval.ok = false` with an error kind.

### Layer 3 — mutation tests (deferred to 2c+)

Single-byte flips on parsed trees plus assertion that eval throws OR
produces a different value. Phase 2b's arms are too narrow for
meaningful mutation coverage (most flips would land on bytes we don't
yet evaluate). Reintroduce in 2c when there are enough arms.

### Cost validation — full strategy

| Layer | Phase | Coverage |
|---|---|---|
| **C1** | **2b** | Per-arm cost values asserted via fixture-gen synthetic fixtures. Catches mistype-when-porting bugs. |
| **C2** | **2b → 2j** | Whole-tree synthetic-context cost captured for the 173 mainnet_boxes corpus in 2b; assertion in TS grows with the eval-able subset. |
| **C3** | **2j (or earlier as needed)** | Real-context cost capture from on-chain transactions. Fixture-gen pulls real input boxes from a sampled block range, builds full execution Context (real inputs, real outputs, real preHeader/headers), captures sigma-rust's per-tree cost. Strongest validation — matches what node validators actually saw at sync time. |

C3 requires:
- Node endpoint for historical UTXO lookup (ergo-node-rust may already
  have this via `/blocks/{id}/transactions` returning input box content;
  if not, add one — same path as the user's
  `/nipopow/proof/{m}/{k}` extension).
- Fixture-gen extension to walk a block sample and assemble the
  context per-input.
- Storage shape that scales to potentially 10K+ entries (a 1000-block
  sample on mainnet has ~25K tx outputs per the recent probe).

The C2 fixture schema in 2b accommodates C3 additively: C3 entries when
they arrive carry `"context_kind": "real-on-chain"` plus an additional
`"context_json": {...}` field with the real Context. Same TS test
asserts work for both kinds — the test reads `context_kind` and
reconstructs the right Context via `makeContext`.

### Cross-runtime testing

Vitest under `node` and `jsdom`. Bundle scan on `dist/` — phase 2b adds
no new browser-incompatible primitives, so the existing 2a scan
(`Buffer | process. | require( | node:` + Scala.js identifier patterns)
continues to pass unchanged.

## Browser compatibility

Hard rules carried verbatim from phase 2a, no new exceptions:

- All `Uint8Array`. Never `Buffer`.
- No `node:*` outside test files.
- No `globalThis.crypto` or `node:crypto`.
- No WASM dependencies, direct or transitive.
- ESM only, ES2022 target.
- `bigint` for `SLong`/`SBigInt`.
- No top-level `await`.

Phase 2b adds no runtime dependencies. `@noble/curves` waits until 2g.

## Dependencies

Runtime: unchanged from 2a (`@noble/hashes` 2.2.0).

Dev: unchanged from 2a (`typescript` ^5.5, `vitest` ^2 with jsdom,
`tsup` ^8, `@types/node` ^22 test-only).

## Error taxonomy

New class shipped in 2b: `EvalError extends Error { code: string }`.
Codes emitted by 2b's eight arms + dispatch:

| Code | Meaning | Throw site |
|---|---|---|
| `not-implemented-yet` | Variant has no eval arm in 2b (matches wire-format taxonomy from 2a) | central switch fallback |
| `cost-limit-exceeded` | `jitCostLimit` set and `addCost` would exceed it | `EvalContext.addCost` |
| `val-def-outside-block` | `ValDef` reached as top-level Expr (sigma-rust's `UnexpectedExpr`) | `eval/val-def.ts` |
| `val-use-unbound` | `ValUse(id)` but Env has no binding for `id` | `eval/val-use.ts` |
| `const-placeholder-id-out-of-range` | `ConstPlaceholder(id)` but `id >= ctx.constants.length` | `eval/const-placeholder.ts` |
| `const-placeholder-no-constants` | `ConstPlaceholder(_)` reached but `ctx.constants` undefined | `eval/const-placeholder.ts` |
| `if-condition-not-boolean` | `If.condition` evaluated to a non-Boolean SValue | `eval/if.ts` |
| `collection-elem-kind-mismatch` | `Collection.elemTpe` inconsistent with an item's eval result kind | `eval/collection.ts` |
| `block-item-not-val-def` | `BlockValue.items` contains a non-ValDef Expr | `eval/block-value.ts` |

`EvalError.message` includes the variant tag (`"not yet supported:
variant 'BinOp'"`) so consumers can dispatch on textual content if they
want; programmatic dispatch via `.code` is preferred.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cost values copied incorrectly from sigma-rust | Per-arm comment includes `eval/<variant>.rs:LINE` reference; PR-time review must check the cited value. C1 fixture-gen captures and asserts per-arm cost from day one. |
| Env extend O(n) cloning becomes hot on deep trees | Profile in 2c+ when more arms exist; switch to persistent map (HAMT) without API change. Phase 2b's BlockValue scopes are too small for this to bite. |
| Sigma-rust drift between snapshot rev and mainline (pinned to `integration/ergots@ed5452cf`) | Same posture as 2a — pinned ref + fixture-gen regen on bump; mismatched fixtures fail loudly. |
| Adding a new Expr variant to `mir/types.ts` without an eval arm | Compile-time error from `_exhaust: never` in central switch. Same exhaustiveness pattern as 2a's `wire/parse.ts`. |
| `BlockValue` semantics drift (item discard vs binding registration) | Direct port from sigma-rust's `block.rs`; per-arm fixture coverage. The "non-ValDef item is discarded" rule is non-obvious — explicit fixture for it. |
| `If` short-circuits but cost charged eagerly on condition | Match sigma-rust exactly: charge condition cost, charge branch cost only for the taken branch. Document explicitly in `eval/if.ts`. |
| Fixture corpus growth from cost-capture (C2 → C3) becomes unwieldy | Cost data is small (one `u64` per entry); the bulk of fixture size is `tree_bytes_hex`. Even at 10K entries the fixture is a few MB. Manageable with git-lfs if it grows further. |
| `Collection` runtime kind-mismatch is unreachable for well-formed ASTs | Acknowledged — the check is defensive, throws on contract violation rather than silently ignoring. Cost: one `kind` comparison per item. Negligible. |

## Open questions

1. **JVM test data files for cost values — investigate but don't
   commit.** Worth one-time grep through
   `~/projects/sigmastate-interpreter/sc/shared/src/test/scala/sigma/`
   (especially `LanguageSpecificationV5.scala` which references
   `TypeBasedCostItem` and `traceBase`) for `tx_id → cost` data files
   or per-op cost trace fixtures. If found, that'd be third-party
   validation (not us-vs-us). If not, we move on. Not a blocker for 2b.

2. **`evalExpr` signature with `'ctx'` lifetime.** Sigma-rust's signature is
   `eval<'ctx>(&self, env: &mut Env<'ctx>, ctx: &Context<'ctx>) -> Result<Value<'ctx>, EvalError>` — the `'ctx`
   lifetime threads through Value (so a Box value can borrow from the
   Context). In TS we have no lifetimes; eval just returns a fresh
   `SValue`. This is fine for 2b (no Box values yet) but worth noting
   when phase 2e brings Box/Context model — we'll need to copy box
   contents into SValue rather than reference them. Defer the decision
   to 2e.

3. **Should `evaluate` build the EvalContext eagerly or lazily?**
   Currently spec'd as eagerly — every call constructs a fresh
   EvalContext from opts. For batch evaluation (evaluate many trees
   with the same opts), `evaluateWith(tree, ctx)` is the pattern.
   Sufficient for now; revisit if a batch-eval consumer surfaces.

4. **Fixture-gen runtime when capturing cost for all 173 mainnet_boxes
   trees.** Should be fast (sigma-rust eval is millisecond-class per
   tree, even with synthetic context). If the C3 expansion to 10K+
   entries from real-context capture takes minutes, consider parallel
   execution in fixture-gen. Not a 2b concern.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella
  phase plan (2a–2j)
- `docs/specs/2026-05-13-no-gossip-decision.md` — phase placement
  rationale
- `facts/ergoscript.md` — boundary contract; extended additively per
  phase
- `facts/proof.md` — sister contract for the proof package
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`,
  HEAD `ed5452cf`) — byte-format and implementation oracle. Phase 2b
  authoritative refs: `ergotree-interpreter/src/eval.rs`,
  `ergotree-interpreter/src/eval/env.rs`,
  `ergotree-interpreter/src/eval/cost_accum.rs`,
  `ergotree-interpreter/src/eval/{const,block,val_use,tuple,collection,if_op}.rs`,
  `ergotree-ir/src/chain/context.rs`
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical
  language specification
- `~/projects/sigmastate-interpreter/core/shared/src/main/scala/sigma/ast/package.scala` —
  Scala's `unifyTypes` / `msgType` / `applySubst` (referenced for
  type-system non-goal rationale; not ported in 2b)
