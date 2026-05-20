# Phase 2h-f — Tier-3 method-handler cleanup (`SColl.flatMap` + `SGroupElement.getEncoded`)

**Status:** Draft
**Date:** 2026-05-20
**Packages:** `@ergots/ergoscript` (TS) + `fixture-gen` (Rust)
**Interface contracts:** `facts/ergoscript-eval.md` — registry grows 42 → 44 entries; ≥ 0 new `EvalError` codes (see Error taxonomy section)
**Brainstorm transcript:** none (constrained port; deferred-handler scope from 2g.6 survey)
**Predecessor spec:** `docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md` (Phase 2h-e — refactor-only consolidation, landed)
**Successor spec:** Phase 2i (predefs) — separate brainstorm cycle

## Goal

Close the two long-tail method handlers deferred from the 2g.6 demand survey: `SColl.flatMap` (typeId 12, methodId 15) and `SGroupElement.getEncoded` (typeId 7, methodId 2). Both V0+, both byte-equality-validated against sigma-rust's `try_eval_out` oracle. Registry grows 42 → 44 entries. No new `Expr` arms.

**Naming correction (load-bearing):** the 2g.6 survey labeled `SColl.flatMap` as "flatten" and described the discrepancy as cosmetic. **It is not cosmetic.** sigma-rust's method is `flatMap` (`Coll[IV], (IV → Coll[OV]) → Coll[OV]`) — a lambda HOF, not the no-lambda `flatten` (`Coll[Coll[T]] → Coll[T]`). This spec implements flatMap per sigma-rust source (`ergotree-ir/src/types/scoll.rs:82-100`, `ergotree-interpreter/src/eval/scoll.rs:52-136`). The 2g.6 survey-count of 2 mainnet boxes refers to the same methodId 15; the count carries forward.

## Non-goals

- **No `flatten` handler.** sigma-rust has no separate `flatten` method on `SColl`. The 2g.6 survey label was wrong; flatten as a distinct method does not exist on the sigma-rust surface and is therefore not portable. `Coll[Coll[T]] → Coll[T]` can be expressed by callers as `xs.flatMap(x => x)`, but that runs into flatMap's defensive body-restriction (see Architecture R2 below) — sigma-rust does not provide a no-lambda flatten.

- **No broader `SGroupElement` method handlers.** `exponentiate` (typeId 7, methodId 3), `multiply` (methodId 4), `negate` (methodId 5), and `exponentiate` UnsignedBigInt variant (methodId 6) are sigma-rust-shipped but below the demand threshold. Defer until corpus demand surfaces or until predef phase pulls them in. `negate` and `multiply` would additionally need `@noble/curves` point negation / scalar multiplication wrappers; not load-bearing yet.

- **No broader `SColl` method handlers.** `patch` (methodId 19), `updated` (methodId 20), `updateMany` (methodId 21), `reverse` (methodId 30, V3-gated), `startsWith` (methodId 31, V3-gated), `endsWith` (methodId 32, V3-gated), `get` (methodId 33, V3-gated) all exist in sigma-rust but are 0-box-demand in the 2g.6 corpus survey. Defer.

- **No fixture-gen consolidation.** `make_resolver` (the 9th copy in `cmds/avltree.rs`), `build_proof_for_ops` (still 2 copies), and other deferred fixture-gen tech debt items from `SESSION_CONTEXT.md` stay deferred. This phase does NOT touch fixture-gen tech-debt.

- **No new `Expr` arms.** Coverage stays at 52 / ~70 variants. flatMap and getEncoded are method-call handlers (dispatched via the existing `MethodCall` arm registered in phase 2g.5), not new top-level Expr variants.

- **No method-call dispatcher changes.** No `minVersion` gating needed — both handlers are V0+. No new typeId namespaces; both typeIds (7 for SGroupElement, 12 for SColl) already exist in the registry.

- **No public-API change to `@ergots/scorex`, `@ergots/nipopow`, or `@ergots/avltree`.** Refactor-free dependencies. No version bumps anywhere in the workspace.

- **No `_known-methods.ts` registry resurrection.** That file was referenced in the 2g.6 spec but no longer exists in the codebase (verified by grep). Method-name canonicalization happens inline in fixture-gen's `MethodCall::with_concrete_types` calls; the TS dispatcher only needs `(typeId, methodId)` to route correctly.

## Motivation

### Handler 1 — `SGroupElement.getEncoded` (typeId 7, methodId 2)

**Demand:** 1 mainnet box per the 2g.6 corpus survey. Low absolute demand but consequence of porting is small — Pattern A Fixed(250), no args, single-line behavior (`ec_point.sigma_serialize_bytes()`). Closes a `'method-not-implemented'` throw path on at least one real-world tree.

**Implementation footprint:**
- 1 registry entry in `eval/method-call.ts` (~10 LOC inline, mirroring SGlobal.groupGenerator)
- No new helper module (33-byte SEC1 encoding already lives on `SValue.GroupElement.value`)
- 1 fixture-gen module: `fixture-gen/src/cmds/ergoscript/eval/sgroup_elem_get_encoded.rs` (~80-120 LOC)
- 1 test file: `packages/ergoscript/test/eval/sgroup-element-get-encoded.test.ts` (~80-150 LOC)
- 0 new `EvalError` codes (reuses `'method-not-implemented'` for defensive obj-kind throw, per error-taxonomy Decision #1 from 2g.5)

**Source-read findings:**
- sigma-rust `eval/sgroup_elem.rs:15-26`:
  ```rust
  pub(crate) static GET_ENCODED_EVAL_FN: EvalFn = |_mc, _env, ctx, obj, _args| {
      ctx.add_jit_cost(250)?;
      let encoded: Vec<u8> = match obj {
          Value::GroupElement(ec_point) => Ok(ec_point.sigma_serialize_bytes()?),
          _ => Err(EvalError::UnexpectedValue(...)),
      }?;
      Ok(Value::from(encoded))
  };
  ```
- **Cost pattern: A.** `add_jit_cost(250)` BEFORE the obj-kind match — pre-check cost is charged even on the throw path. Mirrors `SGlobal.groupGenerator` (cost 10 charged before obj-kind check) and the rest of Pattern-A.
- **SEC1 encoding == sigma_serialize_bytes for EcPoint:** in sigma-rust, `EcPoint::sigma_serialize_bytes` calls `EcPoint::scorex_serialize` which calls `sigma_ser` to write the 33-byte SEC1-compressed point. Our `SValue.GroupElement.value` is already a 33-byte SEC1-compressed `Uint8Array` (see `facts/ergoscript-eval.md` invariant: `GroupElement.value: Uint8Array // 33-byte compressed secp256k1`). **No serialization work needed — the handler returns a defensive copy of `obj.value`.**
- **Type: returns `Coll[Byte]`** — wrap the 33 bytes as `{ kind: 'Coll', elem: { tag: 'SByte' }, items: [...33 bytes as { kind: 'Byte' }...] }`. Existing helper `bytesToCollByteSValue` (used by SHeader.id, SBox.tokens) handles this.

### Handler 2 — `SColl.flatMap` (typeId 12, methodId 15)

**Demand:** 2 mainnet boxes per the 2g.6 corpus survey. Above the absolute-bar but flagged Tier 3 due to higher implementation cost (lambda HOF + defensive body restriction).

**Implementation footprint:**
- 1 registry entry in `eval/method-call.ts` (forwards to a new module — too large for inline)
- 1 new handler module: `packages/ergoscript/src/eval/scoll-flat-map.ts` (~150-200 LOC; mirrors `coll-map.ts` shape with concat semantics)
- 1 fixture-gen module: `fixture-gen/src/cmds/ergoscript/eval/scoll_flat_map.rs` (~150-250 LOC; covers per-property-call lambda + edge cases)
- 1 test file: `packages/ergoscript/test/eval/scoll-flat-map.test.ts` (~150-250 LOC oracle + edge-case + ≥ 1 throw scenario)
- 0 new `EvalError` codes — reuses `'coll-input-not-coll'`, `'lambda-not-callable'`, `'coll-elem-tpe-mismatch'`, `'lambda-result-type-mismatch'` from phase 2f Coll HOFs. The defensive body-restriction throw (see Architecture R2) reuses `'lambda-not-callable'` (sigma-rust uses generic `UnexpectedValue`; our compact taxonomy maps it onto an existing code).

**Source-read findings:**
- sigma-rust `eval/scoll.rs:52-136` — `flatmap_eval` function (NOT a static `EvalFn` like the others — it's a free-standing function called from the method-call registry, presumably because of its lambda-handling complexity).
- **Cost pattern: B.** `ctx.add_per_item_jit_cost(60, 10, 8, n)` at line 126 — **AFTER** input extraction + lambda extraction + type check + body restriction check. No per-iter cost (unlike MapColl/Filter/etc.'s Mixed pattern with their own Fixed(5/1) per-iter charge). Per-iter cost surfaces only via the body's own evaluation (whatever cost `body.eval` charges).
- **Lambda arity check (line 72-77):** `lambda.args.len() > 1` throws. **Existing `extractFuncValue` enforces non-empty (`argIds.length ≥ 1`) but does NOT enforce `≤ 1`** — flatMap needs an explicit `closure.argIds.length === 1` check.
- **Defensive body restriction (line 78-84):** if `lambda.body` is `Expr::MethodCall(mc)`, then `mc.args` MUST be empty (i.e., `xs.flatMap(x => x.property)` only — no `xs.flatMap(x => x.method(arg))`). When the body is some other Expr (e.g., a `ValUse` or another HOF), the check is bypassed silently. **This is unique to flatMap.** **Implementation: check `closure.body.tag === 'MethodCall' && closure.body.args.length > 0` — `closure.body` is the RUNTIME captured Expr (sigma-rust `Value::Lambda.body`), NOT the MIR-node `mc.args[0]`. The distinction matters when the lambda comes from a `ValUse` pointing to a `ValDef` of a FuncValue (rather than an inline FuncValue) — sigma-rust still enforces the restriction at runtime via `lambda.body`; our TS port must do the same via `closure.body` on the runtime Closure SValue.**
- **Elem-type check (line 109-117):** `coll.elem_tpe() != mapper_input_tpe`. TS mirror: `sTypeEquals(inputColl.elem, closure.argTpes[0])` — read from the runtime Closure SValue (same rationale as the body check: ValUse-source lambdas still enforce the check).
- **Concat semantics (line 127-135):** `normalized_input_vals.iter().map(|item| lambda_call(item.clone())).collect::<Result<Vec<Value>, _>>().map(|values| CollKind::from_vec_vec(lambda.body.tpe(), values).map_err(...))`. `from_vec_vec` (in `mir/value.rs:99-104`) has a `Coll[Byte]` special case returning a flat `NativeColl::CollByte` byte-vector; the general case takes the OUTER element type and concatenates inner Colls' items. **TS port:** per-item assert `itemRes.kind === 'Coll'`, then push all inner items. The `Coll[Byte]` flat-byte-vector form does NOT affect TS — our `Coll[Byte]` SValue is `{ kind: 'Coll', elem: SByte, items: [Byte SValues] }` uniformly; no special branch.
- **Output elem type:** sigma-rust uses `lambda.body.tpe()` — the lambda body's static type, ALWAYS concrete because sigma-rust has an `SMethod` resolver that returns the method's `t_range`. For our TS port, `exprTpe(closure.body)` returns the body's `SType` — **but PropertyCall and MethodCall bodies return `SAny`** (see `expr-tpe.ts:138-146` and `:261-267`: SMethod resolver not yet online in phase 2a → SAny placeholder). The canonical flatMap happy-path body (`xs.flatMap(x => x.indices)` per sigma-rust scoll.rs:494-539) is a PropertyCall, so `exprTpe(closure.body).tag === 'SAny'` is the common case. **Implementation must tolerate SAny**: when `exprTpe(closure.body).tag === 'SColl'`, use `bodyTpe.elem` as `outElem`; when `=== 'SAny'`, set `outElem = SAny` and refine post-first-item from the iter's `itemRes.elem`; throw `'lambda-result-type-mismatch'` only on truly unexpected (non-SColl, non-SAny) body types. This mirrors the divergence path that coll-map.ts:148-157 already implements for MapColl (input.elem fallback for empty inputs); flatMap uses the same SAny-tolerance pattern but refines from runtime `itemRes.elem` rather than `inferSType`. Result: empty-input flatMap returns `{ kind: 'Coll', elem: SAny, items: [] }`; non-empty returns `{ kind: 'Coll', elem: <inferred from first iter>, items: [concat] }`.

## Architecture

### Handler 1 — `SGroupElement.getEncoded` (in `eval/method-call.ts`, inline)

Registry entry mirrors `SGlobal.groupGenerator` (10:1, Pattern A Fixed(10)):

```ts
// SGroupElement.getEncoded (MethodCall, typeId=7, methodId=2) — phase 2h-f
// Source: ergotree-interpreter/src/eval/sgroup_elem.rs:15-26 — GET_ENCODED_EVAL_FN
// Pattern A Fixed(250). Returns 33-byte SEC1-compressed point as Coll[Byte].
HANDLERS.set(handlerKey(7, 2), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
  ctx.addCost(250) // sigma-rust line 16
  if (obj.kind !== 'GroupElement') {
    throw new EvalError(
      `SGroupElement.getEncoded expects a GroupElement obj; got '${obj.kind}'`,
      'method-not-implemented' // reuse per error taxonomy option 1
    )
  }
  // obj.value is already 33-byte SEC1-compressed; bytesToCollByteSValue makes a defensive copy.
  return bytesToCollByteSValue(obj.value)
} })
```

No new SType singletons needed (`SCOLL_BYTE` already imported). No new helper functions.

### Handler 2 — `SColl.flatMap` (new file `eval/scoll-flat-map.ts`)

Mirrors the `coll-map.ts` structure (Pattern B cost ordering, env-extend, immutable-env iteration) with three deltas:

1. **No per-iter cost** (unlike MapColl/Filter/Fold/Exists/ForAll which charge `Fixed(5)` or `Fixed(1)` per item)
2. **Defensive body-restriction check** unique to flatMap
3. **Concat semantics** (lambda body returns `Coll[OV]` per iter; collected as flat `Coll[OV]`)

```ts
/**
 * SColl.flatMap method handler — Tier-3 phase 2h-f.
 *
 * sigma-rust:
 *   ergotree-ir/src/types/scoll.rs:82-100   — method descriptor (id 15, V0+)
 *   ergotree-interpreter/src/eval/scoll.rs:52-136 — flatmap_eval
 *
 * Cost: Pattern B — addPerItemCost(60, 10, 8, n) AFTER all guards, BEFORE loop.
 *
 * Lambda restriction: when the lambda body is a MethodCall, its args MUST be
 * empty. Source: scoll.rs:78-84. Allowed: xs.flatMap(x => x.indices).
 * Not allowed: xs.flatMap(x => x.indexOf(5, 0)).
 */
import type { MethodCall, SType, SValue } from '../mir/types'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import type { Env } from './env'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEquals } from '../mir/stype-helpers'

// Pattern B outer cost: add_per_item_jit_cost(base=60, per_chunk=10, chunk_size=8, n)
// Source: scoll.rs:126
const FLATMAP_OUTER_BASE = 60
const FLATMAP_OUTER_PER_CHUNK = 10
const FLATMAP_OUTER_CHUNK_SIZE = 8

export function evalSCollFlatMap(
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  _explicitTypeArgs: Record<string, SType>,
  // The handler needs the originating MIR node (for the elem-type static check,
  // which the runtime Closure SValue does not carry — see Closure interface in
  // mir/types.ts:149-156: no argTpes field) AND the caller's Env (for env-extend
  // during per-item body eval). method-call.ts passes both through `extra`;
  // see Registration section below.
  mc: MethodCall,
  env: Env,
): SValue {
  // 1. Receiver shape check (sigma-rust scoll.rs:109-117).
  const inputColl = extractCollItems(obj)

  // 2. Argument check: exactly 1 lambda arg (sigma-rust scoll.rs:60-71).
  if (args.length !== 1) {
    throw new EvalError(
      `SColl.flatMap expects 1 lambda arg; got ${args.length}`,
      'lambda-not-callable'
    )
  }
  const closure = extractFuncValue(args[0]!)

  // 3. Lambda arity check (sigma-rust scoll.rs:72-77). `extractFuncValue`
  //    enforces argIds.length >= 1; flatMap further enforces == 1.
  if (closure.argIds.length !== 1) {
    throw new EvalError(
      `SColl.flatMap: lambda must take exactly 1 arg, got ${closure.argIds.length}`,
      'lambda-not-callable'
    )
  }

  // 4. Defensive body restriction (sigma-rust scoll.rs:78-84).
  //    When the lambda body is a MethodCall, that MethodCall's args MUST be empty
  //    (property-call style). Non-MethodCall bodies bypass the check.
  //    USE THE RUNTIME `closure.body` — not `mc.args[0].body` — because sigma-rust
  //    enforces this on the runtime `Value::Lambda.body`, which works whether the
  //    lambda came from an inline FuncValue OR a ValUse pointing to a ValDef of a
  //    FuncValue. The runtime Closure SValue captures the resolved body Expr in
  //    both source-shapes.
  if (closure.body.tag === 'MethodCall' && closure.body.args.length > 0) {
    throw new EvalError(
      `SColl.flatMap: lambda body MethodCall must take 0 args (property-call only); got ${closure.body.args.length}`,
      'lambda-not-callable'
    )
  }

  // 5. Elem-type check: input.elem must match lambda arg type.
  //    Sigma-rust (scoll.rs:99-108) reads `lambda.args[0].tpe` from the runtime
  //    Value::Lambda — but our Closure SValue does not carry argTpes. We fall
  //    back to the MIR-node `mc.args[0].args[0].tpe` when the lambda Expr is an
  //    inline FuncValue; otherwise (ValUse-source lambda) we skip the check.
  //    This mirrors the existing coll-map.ts:94-108 convention. See R3 in the
  //    spec for the documented divergence — defer Closure.argTpes extension to
  //    a separate phase if/when ValUse-source lambdas need static elem-checks.
  const lambdaExpr = mc.args[0]!
  if (lambdaExpr.tag === 'FuncValue' && lambdaExpr.args.length > 0) {
    const lambdaInputTpe = lambdaExpr.args[0]!.tpe
    if (!sTypeEquals(inputColl.elem, lambdaInputTpe)) {
      throw new EvalError(
        `SColl.flatMap: input elem type ${JSON.stringify(inputColl.elem)} does not match lambda arg type ${JSON.stringify(lambdaInputTpe)}`,
        'coll-elem-tpe-mismatch'
      )
    }
  }

  // 6. Outer cost: addPerItemCost(60, 10, 8, n) AFTER all guards (Pattern B).
  //    Source: scoll.rs:126.
  const n = inputColl.items.length
  ctx.addPerItemCost(FLATMAP_OUTER_BASE, FLATMAP_OUTER_PER_CHUNK, FLATMAP_OUTER_CHUNK_SIZE, n)

  // 7. Determine initial output elem type from the runtime closure body's static type.
  //    Sigma-rust uses `lambda.body.tpe()` (scoll.rs:132) — its SMethod resolver
  //    yields a concrete type. TS `exprTpe(closure.body)` is concrete for many
  //    body shapes but returns `SAny` for PropertyCall / MethodCall (see
  //    expr-tpe.ts:138-146 / :261-267 — SMethod resolver not yet online). Since
  //    the canonical flatMap body shape per sigma-rust scoll.rs:494-539 is a
  //    property call (`x.indices`), we MUST tolerate SAny here. Strategy:
  //      - SColl body type → use bodyTpe.elem as outElem (concrete path)
  //      - SAny body type  → set outElem = SAny pre-loop; refine to itemRes.elem
  //                          after the first iter (runtime inference)
  //      - other body type → defensive throw
  const bodyTpe = exprTpe(closure.body)
  let outElem: SType
  if (bodyTpe.tag === 'SColl') {
    outElem = bodyTpe.elem
  } else if (bodyTpe.tag === 'SAny') {
    outElem = { tag: 'SAny' }
  } else {
    throw new EvalError(
      `SColl.flatMap: lambda body must return Coll; got ${JSON.stringify(bodyTpe)}`,
      'lambda-result-type-mismatch'
    )
  }

  // 8. Loop: per-item env-extend + body eval + Coll-check + concat.
  //    Sigma-rust scoll.rs:127-135 — collect::<Result<Vec<Value>, _>>() then from_vec_vec.
  //    When pre-loop outElem === SAny, refine from the FIRST itemRes.elem.
  //    Subsequent iters check itemRes.elem matches the (now-refined) outElem.
  const argId = closure.argIds[0]!
  const outItems: SValue[] = []
  for (const item of inputColl.items) {
    const bodyEnv = env.extend(argId, item)
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
    if (itemRes.kind !== 'Coll') {
      throw new EvalError(
        `SColl.flatMap: lambda body returned non-Coll; got '${itemRes.kind}'`,
        'lambda-result-type-mismatch'
      )
    }
    if (outElem.tag === 'SAny') {
      // First-iter refinement: adopt the runtime Coll's elem type.
      outElem = itemRes.elem
    } else if (!sTypeEquals(itemRes.elem, outElem)) {
      // Sub-coll elem-type check (mirror from_vec_vec validation).
      throw new EvalError(
        `SColl.flatMap: lambda body Coll elem type ${JSON.stringify(itemRes.elem)} does not match expected ${JSON.stringify(outElem)}`,
        'lambda-result-type-mismatch'
      )
    }
    for (const sub of itemRes.items) outItems.push(sub)
  }

  // Empty-input case: outElem stays SAny; return empty Coll with elem=SAny.
  return { kind: 'Coll', elem: outElem, items: outItems }
}
```

**Registration in `method-call.ts`:** flatMap needs the originating `MethodCall` MIR node + `Env` (for env-extend). The existing dispatcher only passes `(obj, args, ctx, explicitTypeArgs)` — flatMap is the first handler that needs `mc` and `env`. Two options:

- **Option A** (minimal disruption): extend `HandlerFn` signature to optionally pass `(mc, env)`. Add a discriminated wrapper for handlers that need them. Most handlers stay 4-arg; flatMap (and any future lambda HOF method call) is 6-arg.

- **Option B** (handler-specific entry point): keep `HandlerFn` 4-arg; wrap flatMap registration inside `evalMethodCall` so we don't go through the registry for this one method (special-case at the dispatcher level).

Recommended: **Option A** — extend the `HandlerFn` shape via a new optional `extra` parameter carrying `{ mc, env }`. The dispatcher passes `extra` through; handlers that don't need it ignore it (TS structural-typing makes this zero-cost for the 41 existing handlers). The shape change is forward-looking: future lambda-HOF method calls (e.g., `SColl.zipWith` if it ever lands) follow the same pattern.

Concrete signature:

```ts
type HandlerFn = (
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>,
  // NEW optional argument; only consumed by handlers that need MIR-node + env access.
  // For non-lambda handlers (40 of 42 today), this is unused.
  extra?: { mc: MethodCall; env: Env }
) => SValue
```

The dispatcher inside `evalMethodCall` constructs `extra = { mc: e, env }` and passes it to `entry.handler(...)`. `evalPropertyCall` passes `extra = undefined` (PropertyCall has no MIR-node ambiguity that handlers need).

### Method-handler registry (post-2h-f, 44 entries)

```text
... (entries 1-42 unchanged from 2h-d) ...
43 | SGroupElement.getEncoded | 7:2  | 250 | A | Coll[Byte] (33 SEC1)  | eval/sgroup_elem.rs:15-26
44 | SColl.flatMap           | 12:15 | addPerItemCost(60,10,8,n) | B | Coll[OV] | eval/scoll.rs:52-136
```

### Wire-format / parser surface

No changes. Both methods are dispatched via the existing `MethodCall` Expr arm registered in phase 2g.5. Parser accepts the (typeId, methodId) pair already; no new parse arm.

### Cross-cutting guarantees (inherited unchanged)

- Browser-compat: no `Buffer`, no `node:*`, no `globalThis.crypto.subtle`. All Uint8Array.
- Determinism: pure handlers, no clock/PRNG/I/O. Both handlers byte-stable across runs.
- ESM-only. No top-level await.
- No new runtime deps. `@noble/hashes@2.2.0` and `@noble/curves@2.2.0` runtime deps unchanged. (getEncoded does NOT need `@noble/curves` — it returns the already-stored 33-byte SEC1 bytes verbatim.)
- No version bumps in any workspace package.

## Test strategy

Per the project's TDD discipline (CLAUDE.md, `superpowers:test-driven-development`). Each handler gets:

1. **Per-handler oracle fixture** (Layer C2): one fixture entry per handler asserting both the SValue return AND the JIT cost integer-equal to `try_eval_out` output.

2. **Edge-case scenarios per handler:**

   - `getEncoded`:
     - Happy path: arbitrary `GroupElement` → 33-byte `Coll[Byte]` with value-equality.
     - Group generator: `SGlobal.groupGenerator` → `getEncoded` round-trip matches `GROUP_GENERATOR_BYTES`.
     - **Cost charged on throw path:** invoke with a non-GroupElement `obj` (e.g., Long) via direct handler call (bypass type-system). Assert cost 250 still charged before the throw. (Hard to express through the parser; surface as a TS-direct test rather than a fixture.)

   - `flatMap`:
     - Happy path 1: `Coll[Coll[Long]] flatMap (xs => xs.indices)` → `Coll[Int]` of indices, ALL concatenated. Mirrors sigma-rust test `eval_flatmap` (`scoll.rs:494-539`). **Critical coverage for R3(b):** body is a `PropertyCall` → `exprTpe(closure.body) === SAny` → handler must refine `outElem` from `itemRes.elem` at first iter. Test asserts the result's `elem.tag === 'SInt'` (refined from runtime), proving the SAny-tolerance path works.
     - Happy path 2: `Coll[Long] flatMap (x => Coll(x, x+1))` (non-property body; concrete `bodyTpe = SColl(SLong)` from `exprTpe(Collection)`). Confirms the concrete-tpe path (no refinement needed). Asserts result's `elem.tag === 'SLong'`.
     - Empty Coll input + property-call body: `Coll[Coll[Long]]().flatMap(xs => xs.indices)` → empty `Coll`. Tests the empty-input SAny edge case: no iter runs, no refinement happens, return `{ kind: 'Coll', elem: { tag: 'SAny' }, items: [] }`. Asserts `outColl.elem.tag === 'SAny'` (documents the divergence per R3(b)).
     - Empty Coll input + concrete body: `Coll[Long]().flatMap(x => Coll(x))` → empty `Coll[Long]`. Concrete-tpe path: outElem stays SLong even with no iters. Asserts `outColl.elem.tag === 'SLong'`.
     - Lambda body with non-Coll return: throws `'lambda-result-type-mismatch'`.
     - Defensive body restriction: `xs.flatMap(x => x.indexOf(5, 0))` (MethodCall body with non-zero args) → throws `'lambda-not-callable'`. **Per R7 pre-flight: if sigma-rust rejects this shape at MethodCall::with_concrete_types construction time, test via TS-direct handler call instead of an oracle fixture.**
     - **Arity-> 1 lambda:** `xs.flatMap((x, y) => Coll(x))` (lambda takes 2 args). `extractFuncValue` enforces `argIds.length ≥ 1` but NOT `≤ 1`; flatMap's explicit `closure.argIds.length !== 1` check fires here → throws `'lambda-not-callable'`. Similar reachability caveat as the body restriction; TS-direct call if construction-time-rejected.
     - **ValUse-source lambda (R3 corner case):** `val f = (x: Coll[Long]) => x.indices; xs.flatMap(f)`. Body-restriction check on `closure.body` (runtime) STILL fires correctly (closure.body resolves to the original Expr regardless of source). Elem-type check is SKIPPED (R3 divergence) — happy path succeeds without static elem-check. Asserts: result correct; cost matches inline-FuncValue equivalent; no `'coll-elem-tpe-mismatch'` throw even when types would mismatch (documents the divergence behavior).
     - Elem-type mismatch (inline-FuncValue lambda): lambda expects `SLong` but input is `Coll[SInt]` → throws `'coll-elem-tpe-mismatch'`.
     - Non-Coll input: handler invoked with a non-Coll `obj` → throws `'coll-input-not-coll'`.
     - **Cost-on-throw paths (Pattern B specifics):** flatMap's `addPerItemCost(60, 10, 8, n)` is charged AFTER all guards. So:
       - Non-Coll obj throw → NO cost charged (guard fires first).
       - Lambda arity / body-restriction / elem-type-mismatch throw → NO cost charged (guards fire before cost).
       - Lambda-result-type-mismatch throw (per-item, mid-loop) → cost charged for the iters completed up to the throw plus the outer cost. Mirrors sigma-rust which calls `add_per_item_jit_cost` BEFORE `collect::<Result<_, _>>()` at scoll.rs:126.
       Distinguishes flatMap's cost surface from getEncoded's Pattern-A (which charges 250 even on the throw path).

3. **Mutation testing** (Layer C3.a): byte-level XOR mutation on the proof-bearing region of each fixture, asserting ≥ 90% kill rate via the shared `runMutationLoop` from phase 2h-e. flatMap's mutation surface is the lambda's body Expr bytes + the receiver Coll bytes; getEncoded's mutation surface is the 33-byte EcPoint constant. **Use the existing shared harness — do NOT inline a new mutation loop.**

4. **Cross-runtime**: vitest runs every test under both `node` and `jsdom`. Aggregate post-phase: `3481 + (oracle + edge + mutation count)` — see implementation plan for exact target.

5. **No new corpus-eval coverage measurement needed.** The 2g.6 C2 corpus only included trees whose body uses exclusively the supported variants. Adding 2 method handlers may unlock 1-3 more mainnet boxes for the C2 corpus aggregate (per the 1-box + 2-box demand counts). Surface as a one-line corpus-aggregate sentence in the next `facts/ergoscript.md` refresh, NOT as an extra fixture set.

## Error taxonomy

**Zero new `EvalError` codes added by this phase.**

| Handler | Defensive throw | Code reused |
|---|---|---|
| `SGroupElement.getEncoded` | obj.kind !== 'GroupElement' | `'method-not-implemented'` (per 2g.5 option-1 taxonomy) |
| `SColl.flatMap` | obj.kind !== 'Coll' | `'coll-input-not-coll'` (existing from 2f Coll HOFs) |
| `SColl.flatMap` | args.length !== 1 OR closure.argIds.length !== 1 | `'lambda-not-callable'` |
| `SColl.flatMap` | body=MethodCall with non-empty args | `'lambda-not-callable'` (compact taxonomy; sigma-rust's UnexpectedValue maps onto this) |
| `SColl.flatMap` | input.elem != lambda.args[0].tpe | `'coll-elem-tpe-mismatch'` |
| `SColl.flatMap` | itemRes.kind !== 'Coll' OR sub-Coll elem mismatch | `'lambda-result-type-mismatch'` |

Total codes after phase: 48 (unchanged). Total handler registry: 44.

## Implementation plan (sketch, finalized in PLAN.md)

**~8-12 commits across two handlers + final verification.** Sized lighter than 2h-d's 26 commits (smaller surface), heavier than 2h-e's 13 (new functionality vs refactor). Roughly:

### Handler 1 (getEncoded) — ~3-4 commits

1. **Spec + plan** (2 commits): this file + per-task PLAN.md.
2. **Fixture-gen**: add `sgroup_elem_get_encoded.rs` with 1-3 scenarios (happy + group-generator round-trip). Verify `cargo run -p fixture-gen --release` determinism.
3. **RED + GREEN**: write the oracle test asserting handler exists → red on `'method-not-implemented'`; add the registry entry → green.
4. **Edge-case tests**: throw path + cost-on-throw assertion.

### Handler 2 (flatMap) — ~5-7 commits

1. **Fixture-gen** `scoll_flat_map.rs`: ~5-7 scenarios (happy property-call, happy non-property body, empty input, body-restriction throw, type-mismatch throws).
2. **RED + GREEN** (registry stub + extracted module): create `eval/scoll-flat-map.ts`, register, add `HandlerFn` extra-arg threading, oracle test passes.
3. **Edge-case tests**: 4-6 scenarios from the test-strategy list.
4. **Mutation testing**: per-fixture mutation test using `runMutationLoop` from phase 2h-e.
5. **Optional** `HandlerFn` signature refactor cleanup (Option A from Architecture above).

### Final verification — ~1-2 commits

1. Cross-package typecheck + jsdom across all 4 packages.
2. fixture-gen determinism (`cargo run` × 2 + `git diff --exit-code`).
3. `facts/ergoscript-eval.md` registry update (42 → 44 entries, +1 changelog section "Phase 2h-f").
4. `facts/ergoscript.md` summary refresh.
5. `README.md` registry-count refresh (42 → 44).

**Expected commits: 8-12.** Push at user's discretion when implementation lands.

## Risks & mitigations

**R1 (critical) — `HandlerFn` signature extension.** Phase 2h-f introduces an optional `extra?: { mc, env }` parameter to handle flatMap's MIR-node and env-extend needs. This is the first cross-handler signature change since the `minVersion` field added in 2h-c.2. The 41 existing handlers ignore `extra` (TS structural typing); regressions are only possible if a future maintainer relies on a 4-arg shape. Mitigation: add a one-line comment to `HandlerFn` documenting the 5th arg; landed in the same commit that introduces the change.

**R2 — flatMap body restriction quirk.** sigma-rust's restriction "lambda body if it's a MethodCall, must have zero call-args" is non-obvious. The TS port preserves the exact same restriction (check at registration time before the loop). If the sigma-rust source-of-truth changes in a future `integration/ergots` rebase, our check must shift in lockstep. Mitigation: explicit source line reference in the handler module doc-comment; fixture covers both the allowed (`x.indices`) and disallowed (`x.indexOf(5, 0)`) shapes.

**R3 — Two distinct TS-from-sigma-rust divergences on lambda static typing.** Both inherited from existing arms; both load-bearing for flatMap.

**(a) Elem-type check (input.elem vs lambda.arg[0].tpe).** The runtime `Closure` SValue (`mir/types.ts:149-156`) does NOT carry `argTpes` — only `argIds`, `body`, `capturedEnv`. So the elem-type check (`sTypeEquals(inputColl.elem, lambdaArgTpe)`) can only run statically when the lambda Expr is an inline FuncValue MIR node (`mc.args[0].tag === 'FuncValue'`). For lambdas reaching the handler via `ValUse` resolving to a `ValDef` of a FuncValue, the check is skipped — mirroring the existing `coll-map.ts:94-108` convention. **Sigma-rust** (`scoll.rs:99-108`) reads `lambda.args[0].tpe` from the runtime `Value::Lambda` which DOES carry per-arg types — concrete check always runs.

**(b) Output elem type (lambda.body.tpe()).** The TS `exprTpe(closure.body)` returns `{ tag: 'SAny' }` for `PropertyCall` and `MethodCall` body Exprs (see `expr-tpe.ts:138-146` and `:261-267` — SMethod resolver not yet online in phase 2a → SAny placeholder). **The canonical flatMap body shape per sigma-rust** (`scoll.rs:494-539` test: `xs.flatMap(x => x.indices)`) **IS a PropertyCall** — so flatMap's typical happy-path body produces `SAny` via `exprTpe`. The handler MUST tolerate this: pre-loop `outElem = SAny`; refine from `itemRes.elem` after the first iter (handler step-8 logic above). **Sigma-rust** has `lambda.body.tpe()` returning a concrete type via SMethod resolver — never SAny.

**Mitigation for both:** document both divergences as a multi-line note in `facts/ergoscript-eval.md` `SColl.flatMap` registry-table entry. The behavior is sound (TS handler still produces correct concatenated results); the type information attached to the output Coll is just less precise than sigma-rust's. Downstream consumers using `Coll[OV]` outputs of flatMap should not rely on `outColl.elem` being concrete — they will receive `SAny` ONLY in empty-input cases (non-empty inputs always refine via the first-iter `itemRes.elem`). Future work: extend `Closure` to carry `argTpes` AND/OR bring the SMethod resolver online (separate cross-arm phases; out of scope here — both also affect MapColl/Filter/Fold/Exists/ForAll's static-typing accuracy).

**R4 — `getEncoded` 33-byte invariant.** Our `SValue.GroupElement.value` is contractually 33 bytes (see `facts/ergoscript-eval.md` invariants). A future change that violates this would silently corrupt `getEncoded` output. Mitigation: defensive `obj.value.length === 33` assertion in the handler (or rely on the upstream invariant). Recommendation: rely on the invariant — adding a length check is defensive against a programming error elsewhere; trust the type invariant.

**R5 — Fixture-gen `lambda.body.tpe()` for flatMap.** Sigma-rust's `try_eval_out` oracle requires constructing a `MethodCall` Expr with a properly-typed FuncValue body. The lambda body must have a derivable `tpe()` — i.e., its construction must succeed `ergotree-ir`'s type checker. The simplest happy-path fixture uses `xs.flatMap(x => x.indices)` where `x: Coll[Long]` and `x.indices: Coll[Int]`. Mitigation: copy the fixture-gen pattern from existing `coll_map.rs` (which builds a typed FuncValue + MethodCall); adapt the body to a property-call.

**R6 — Mutation kill rate on flatMap fixtures.** The lambda body inside a flatMap Expr tree is small (a single MethodCall or BinOp). A high-percentage of byte-mutations on lambda-body bytes might survive (mutated body still type-checks and produces a similar Coll). **Decision upfront: narrow the mutation region to the receiver Coll's inline-`Coll[Byte]` payload only (matching the 2g.5 SColl.indexOf mutation pattern from phase 2h-e's `runMutationLoop` consumer-side region selection).** Mitigation: use `locateInlineCollRegion(treeBytes, tree, collIndex: 0)` to scope the mutation region; if any individual fixture still fails the 90% threshold despite this narrowing, surface as a halt-and-investigate (mutation-coverage-narrowing-failed) before iterating the fixture body shape.

**R7 — Fixture-gen reachability of the body-restriction throw.** sigma-rust's `MethodCall::with_concrete_types` and the surrounding type-checker may reject a flatMap whose lambda body is a non-zero-arg MethodCall at *construction* time — meaning the `'lambda-not-callable'` throw might only be testable via direct-handler call in TS, not via `try_eval_out` from a fixture-gen-constructed tree. **Decision upfront: pre-flight this in the fixture-gen module before implementing the fixture.** If sigma-rust rejects the malformed shape at construction, the test for this case becomes a TS-direct handler invocation (not an oracle fixture). Mitigation: add a `cargo check` smoke build for the fixture-gen module's `body_restriction_throw` scenario as the first task in the implementation plan; if construction fails, switch the test strategy for this case to a TS-direct call and document in the test file.

## Open questions deferred to implementation

- **Q1: `HandlerFn` signature change scope.** Option A (extend signature with optional 5th arg `extra?: { mc, env }`) is the chosen approach. Decision settled — both `mc` (for the static elem-type check, see R3) and `env` (for per-item env-extend) are required. Implementation may discover that the `extra` arg's shape benefits from positional args instead of a bag-object; that's a cosmetic call at the registration commit.

- **Q2: Co-locate flatMap with coll-map.ts or separate file? — RESOLVED.** New file `eval/scoll-flat-map.ts`. Rationale: file size is comparable to `coll-map.ts` (~150-200 LOC), parity with existing per-arm files, and isolation from MapColl's own concerns.

- **Q3: `inferSType` helper — RESOLVED (still not needed, but for a different reason than the draft).** The SAny-tolerance path is back (per R3(b)), but our refinement uses `itemRes.elem` directly from the runtime `Coll` SValue's `elem` field — no `inferSType(...)` call on a non-Coll SValue is needed. Reason: the lambda body is structurally guaranteed to return `Coll[OV]` (per the type-check at step 7 + the runtime `itemRes.kind === 'Coll'` guard at step 8), so `itemRes.elem` is always a directly-readable `SType`. The `inferSType` helper in `coll-map.ts:169` would be needed only if we had to infer the SType of an arbitrary SValue — not our case.

- **Q4: Elem-check divergence note in `facts/ergoscript-eval.md`? — RESOLVED.** Yes, add a one-line note to the `SColl.flatMap` registry-table entry documenting the ValUse-source-lambda elem-check skip (see R3). Land in the `facts/ergoscript-eval.md` doc-refresh commit at end of phase.

## Verification commands (run after each commit)

```bash
# Per-commit verification (TS-side commits)
npx tsc --noEmit -p packages/scorex/tsconfig.json          # CLEAN
npx tsc --noEmit -p packages/nipopow/tsconfig.json         # CLEAN
npx tsc --noEmit -p packages/avltree/tsconfig.json         # CLEAN
npx tsc --noEmit -p packages/ergoscript/tsconfig.json      # CLEAN
node_modules/.bin/vitest run packages/                     # all tests pass

# Per-commit verification (Rust-side commits)
cd fixture-gen && cargo build --release                    # CLEAN
cd fixture-gen && cargo run --release                      # outputs unchanged for non-target fixtures
git diff --exit-code packages/                             # CLEAN (only the new fixture files appear)
cd fixture-gen && cargo run --release && git diff --exit-code packages/  # CLEAN (determinism)

# End-of-phase verification (one-time, after final commit)
cd packages/scorex && npx vitest run --config vitest.browser.config.ts     # 177 under jsdom
cd packages/nipopow && npx vitest run --config vitest.browser.config.ts    # 245 under jsdom
cd packages/avltree && npx vitest run --config vitest.browser.config.ts    # 156 under jsdom
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts # 2903+N under jsdom
git status                                                                 # CLEAN modulo gitignored audit20260519/
```

## End-of-phase invariants

- ✅ Method handler registry: 42 → **44** entries.
- ✅ `EvalError` codes: 48 (unchanged).
- ✅ `Expr` arm coverage: 52 / ~70 (unchanged — both new handlers are method calls, not top-level Expr arms).
- ✅ `SValue` kind variants: unchanged.
- ✅ Test count: 3481 + N (new tests for the two handlers; N ≈ 30-60 per the test-strategy plan).
- ✅ Cross-runtime jsdom: clean across all 4 packages.
- ✅ Fixture-gen determinism: byte-identical output on second `cargo run`.
- ✅ Public-API: unchanged in `@ergots/scorex`, `@ergots/nipopow`, `@ergots/avltree`. `@ergots/ergoscript` gains 2 handlers (additive, no breaking change).
- ✅ Working tree: clean modulo gitignored `audit20260519/`.
- ✅ No new runtime deps; no version bumps.
- ✅ `facts/ergoscript-eval.md` updated: registry table grows to 44 rows; new "Phase 2h-f" changelog entry; coverage summary registry-count refreshed.

## Cross-references

- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — predecessor that flagged this as Tier-3 deferred work and (incorrectly) labeled flatMap as "flatten"
- `docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md` — immediate predecessor (2h-e, refactor-only); provides the shared `runMutationLoop` harness used here
- `docs/specs/2026-05-18-task-b-corpus-survey-results.md` — original demand survey behind the Tier-3 categorization (`SColl.flatten` 2 boxes, `SGroupElement.getEncoded` 1 box; despite the naming error, the methodId 15 + methodId 2 demand counts carry forward)
- `facts/ergoscript-eval.md` — interface contract; registry table grows 42 → 44 in this phase
- `facts/ergoscript.md` — meta hub; coverage summary line refreshes 42 → 44
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/types/scoll.rs:82-100` — flatMap method descriptor (V0+, methodId 15)
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:52-136` — flatMap eval implementation
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/types/sgroup_elem.rs:40-53` — getEncoded method descriptor (V0+, methodId 2)
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/sgroup_elem.rs:15-26` — getEncoded eval implementation
- `~/projects/ergots/packages/ergoscript/src/eval/coll-map.ts` — closest existing analog for flatMap's lambda HOF structure
- `~/projects/ergots/packages/ergoscript/src/eval/method-call.ts` — dispatcher + registry
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
