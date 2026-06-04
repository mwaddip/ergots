# ErgoScript v6 — P5c: `Global.powHit` design

**Status:** proposed (2026-06-05; **revised to Architecture C″** the same day after source-verifying that `@ergots/nipopow` consumes the scorex hit helpers — see §3).
**Phase:** v6 P5c — the last piece of P5 (Global functions). After this, P5 is complete; P6 (HOF lambdas), P7 (per-type + `allZK`/`anyZK`), P8 (validation) remain.
**Branch:** `ergoscript-v6` (local-only; per the v6 disposition, one PR to `master` at v6 delivery). **No push until the consensus-path test gate is green** (user constraint, 2026-06-05).
**Canonical source:** JVM `sigma-state` only (per the v6 canonical-source decision). sigma-rust `eni` is an optional non-canonical cross-check.

---

## 1. What `Global.powHit` is

A 5-argument method on the `Global` object (SGlobal, **typeId 106, methodId 8**):

```
powHit(k: Int, msg: Coll[Byte], nonce: Coll[Byte], h: Coll[Byte], N: Int): SUnsignedBigInt
```

It computes the **Autolykos-2 Proof-of-Work *hit value*** for *custom* parameters — the raw `UnsignedBigInt` hit, **not** a boolean, and **without** any target comparison. (That distinguishes it from header PoW *verification*, which compares the hit against a difficulty-derived target.)

- **Return type:** `SUnsignedBigInt` (confirmed `methods.scala:1885`; sigma-rust mis-declared it `SBoolean` and fixed it in PR #877 — ergots must use `SUnsignedBigInt`).
- **Version gate:** V3+ (`isV3OrLaterErgoTreeVersion`), via the dispatcher's `minVersion: 3` — consistent with all v6 methods. (`GraphBuilding.scala:1213`.)

### Canonical sources (cited)

- `data/shared/src/main/scala/sigma/ast/methods.scala:1884-1902` — `powHitMethod` SMethod def + `powHit_eval` (cost charging + the call into `Autolykos2PowValidation`).
- `data/shared/src/main/scala/sigma/ast/CostKind.scala:68-88` — `PowHitCostKind.cost(k, msg, nonce, h)`.
- `data/shared/src/main/scala/sigma/pow/Autolykos2PowValidation.scala:99-137` — `genIndexes`, `genElementV2`, `hitForVersion2ForMessageWithChecks`, `hitForVersion2ForMessage` (**the algorithm**).
- `sc/shared/src/test/scala/sigma/LanguageSpecificationV6.scala:1561-1601` — the `Global.powHit` `verifyCases` (blessed value vector).
- `interpreter/shared/src/test/scala/sigmastate/eval/BasicOpsTests.scala:104-136` — `powHit evaluation` (same blessed value at both the SigmaDsl layer and the MethodCall/AST layer).

---

## 2. The algorithm (faithful transcription)

The method calls `Autolykos2PowValidation.hitForVersion2ForMessageWithChecks(k, msg, nonce, h, N)`:

```
require(k >= 2)    // at least 2 elements needed for the k-sum
require(k <= 32)   // genIndexes does not support k > 32
require(N >= 16)   // minimum table size
→ hitForVersion2ForMessage(k, msg, nonce, h, N)
```

`hitForVersion2ForMessage` (the un-checked core, `Autolykos2PowValidation.scala:122-137`):

```
prei8   = unsignedBE( blake2b256(msg ++ nonce).takeRight(8) )      // last 8 bytes → unsigned BigInt
i       = asUnsignedByteArray(4, prei8 mod N)                       // 4 bytes, big-endian
f       = blake2b256(i ++ h ++ M).drop(1)                           // 31 bytes  (h = raw bytes, passed through)
seed    = f ++ msg ++ nonce                                         // raw concat (NOT hashed here)
indexes = genIndexes(k, seed, N)                                    // k indices in [0, N)
elems   = indexes.map(idx => genElementV2(int32BE(idx), h))         // h reused
f2      = sum(elems)                                                // BigInt
array   = asUnsignedByteArray(32, f2)                               // 32 bytes
hit     = unsignedBE( blake2b256(array) )                           // 32 bytes → unsigned BigInt
return hit
```

`genIndexes(k, seed, N)` (`:99-105`):

```
hash         = blake2b256(seed)
extendedHash = hash ++ hash.take(3)                                 // 35 bytes
(0 until k).map { i => unsignedBE(extendedHash.slice(i, i+4)) mod N } // k windows
```

`genElementV2(indexBytes, heightBytes)` (`:110-113`):

```
unsignedBE( blake2b256(indexBytes ++ heightBytes ++ M).drop(1) )    // 31 bytes → unsigned BigInt
```

`M` (`:72`): `(0 until 1024).flatMap(i => longToBE8(i))` = 1024 × 8-byte big-endian longs = **8192 bytes** constant. (Matches `@ergots/scorex`'s existing `calcBigM()`.)

### The existing scorex factoring is byte-equivalent to the JVM

`@ergots/scorex/src/autolykos-v2.ts` already implements this math for header verification, factored slightly differently — and that factoring is **provably byte-identical** to the JVM, so it is **kept** (not rewritten):

- scorex's `buildAutolykosSeed` returns the **hashed** seed `blake2b256(f‖msg‖nonce)`, and its `genIndexes` consumes that pre-hashed seed *without* an internal re-hash. The JVM keeps `seed` raw and hashes *inside* `genIndexes`. Since scorex's `buildAutolykosSeed` output ≡ the JVM's `genIndexes`-internal `hash` (verified: scorex's `f`-slice ≡ JVM's `f`, so `blake2b256(f‖msg‖nonce)` is computed identically), the two produce identical index windows.
- scorex's `genIndexes` is hardcoded to **32** indices; powHit needs `k`.
- scorex's `buildAutolykosSeed` / `hashElement` derive the element/seed "height bytes" from a parsed `int → BE4`; powHit passes `h` through as **raw `Coll[Byte]`**.

So the only faithful changes needed to the existing helpers are: **add a `k` parameter** to `genIndexes`, and **take `h` as `Uint8Array`** (not `height: number`) in `buildAutolykosSeed` / `hashElement`. The header callers pass `int32BE(height)` for `h` and `k = 32` — recovering today's exact behavior.

---

## 3. Architecture — C″: one hit core, three consumers

**Discovery that set this architecture (2026-06-05):** the header-hit computation is currently duplicated in **three** inline loops — `scorex/verifyAutolykosV2`, **`nipopow/compare.ts:303 powHit(header)`** (the KMZ17 best-arg comparison), and (would-be) ergoscript's new handler. The scorex helpers `buildAutolykosSeed`/`genIndexes`/`hashElement` are a **hard public dependency of nipopow** (`compare.ts:48-50,318-324`) — they cannot simply be deleted.

**Chosen approach (C″, user-authorized 2026-06-05):** collapse all three inline loops into **one** general hit core in scorex, and route `verifyAutolykosV2`, nipopow's `powHit`, and ergoscript's `Global.powHit` through it. The seed/index/element helpers are **generalized** (per §2) and **retained as internal decomposition** of the core, but **dropped from the public package API** (`index.ts`); nipopow switches from importing the trio to importing the core.

> **CLAUDE.md exception:** this edits `packages/nipopow/src/` (the KMZ17 PoW comparison), which CLAUDE.md's standing rule says not to refactor for other packages' needs. The user explicitly authorized it ("do it proper, C″", 2026-06-05) to land the single-source unification now. The refactor is **identity-preserving** (nipopow's loop is byte-for-byte the general core at `k=32`, `h=int32BE(height)`) and gated on nipopow's full suite.

### 3.1 `@ergots/scorex` — the single hit core (`autolykos-v2.ts`)

Generalize the existing helpers and add the core (names TS-idiomatic; JVM correspondence in source comments + the facts Source Mapping table):

- **`genIndexes(seed, N, k)`** — add the `k` parameter (`(0 until k)`), preserving the pre-hashed-seed contract. (Header callers pass `k = 32`.)
- **`buildAutolykosSeed(msg, nonce, h, N)`** and **`hashElement(index, h)`** — take `h: Uint8Array` instead of `height: number`. (Header callers pass `int32BE(height)`.)
- **`autolykosHitForMessage(k, msg, nonce, h, N): bigint`** — the un-checked core: `seed = buildAutolykosSeed(msg,nonce,h,N)` → `indexes = genIndexes(seed,N,k)` → sum `hashElement(idx,h)` as BE BigInts → `asUnsignedByteArray(32, f2)` → `unsignedBE(blake2b256(...))`. (≡ JVM `hitForVersion2ForMessage`.)
- **`autolykosHitForMessageWithChecks(k, msg, nonce, h, N): bigint`** — the three `require` guards (§2), then the core. **What the ergoscript handler calls.** On guard violation throws a dedicated scorex error (see §5).
- A small **`int32BE(n: number): Uint8Array`** helper (factor out the existing inline 4-byte big-endian code).

**`verifyAutolykosV2(header)`** is refactored to:

```
hit    = autolykosHitForMessage(32, autolykosMessage(header), nonce, int32BE(height), bigN)
target = ORDER / decodeCompactBits(header.nBits)
return hit < target            // unchanged
```

(Uses the *unchecked* core, mirroring JVM `hitForVersion2` — for a real header `k=32`/`N=bigN` always pass the guards.)

**Public API (`packages/scorex/src/index.ts`):** **remove** `buildAutolykosSeed`, `genIndexes`, `hashElement` from the exports; **add** `autolykosHitForMessage` and `autolykosHitForMessageWithChecks`. The removed helpers stay as module-level exports in `autolykos-v2.ts` (the in-package test imports them by relative path) — they are simply no longer part of the published surface.

### 3.2 `@ergots/nipopow` — route `powHit` through the core (`compare.ts`)

Replace the inline hit loop (`compare.ts:313-340`) in the v2 branch of `powHit(header)` with:

```
const hit = autolykosHitForMessage(32, autolykosMessage(header), header.autolykosSolution.nonce, int32BE(header.height), calcBigN(header.version, header.height));
return hit;
```

Update the imports (`compare.ts:48-50`): drop `buildAutolykosSeed`/`genIndexes`/`hashElement`, add `autolykosHitForMessage` (+ `int32BE` if not otherwise available). Remove now-unused local `asUnsignedByteArray`/`blake2b256` imports **only if** nothing else in `compare.ts` uses them (verify during implementation). The v1 branch (`pow_distance`/`ORDER` fallback, `:304-311`) is unchanged.

### 3.3 `@ergots/ergoscript` — the `Global.powHit` handler

New file `packages/ergoscript/src/eval/global-pow-hit.ts` (P5 naming convention). The handler:

1. Guards `obj.kind === 'Global'` and `args.length === 5`.
2. Extracts: `k` (arg[0], kind `'Int'` → number), `msg`/`nonce`/`h` (args[1..3], `collByteToUint8Array`), `N` (arg[4], kind `'Int'` → number). Operand-kind guards on each (the P1 final-review lesson — a wrong-kind operand must yield a typed `EvalError`, not garbage or a raw `TypeError`).
3. **Charges cost first** (Pattern A, cost-then-throw — see §4): `ctx.addCost(c)` with `c` computed from the *raw* `k` and the byte lengths.
4. Calls `autolykosHitForMessageWithChecks(k, msg, nonce, h, N)` from `@ergots/scorex`; maps its guard error to the `'pow-hit-invalid-params'` EvalError.
5. Returns `{ kind: 'UnsignedBigInt', value: hit }`.

Registered in `eval/method-call.ts`: `HANDLERS.set(handlerKey(106, 8), { handler: evalGlobalPowHit, minVersion: 3 })`.

> **Build/dep notes:** ergoscript imports the **built** scorex `dist/` → rebuild `packages/scorex` before ergoscript tests. nipopow imports scorex too → rebuild scorex before nipopow tests, and the nipopow suite is part of the gate. Republish scorex (and, since the API surface changed, bump it) at v6 delivery.

---

## 4. Cost model

`PowHitCostKind.cost` (`CostKind.scala:79-87`) — charged as a `FixedCost(c)`:

```
chunkSize    = CalcBlake2b256.costKind.chunkSize    = 128
perChunkCost = CalcBlake2b256.costKind.perChunkCost = 7
baseCost     = 500

c = 500 + (k + 1) * ( ⌊(msg.len + nonce.len + h.len) / 128⌋ + 1 ) * 7
```

(ergots already uses chunkSize=128 / perChunk=7 for blake2b256 at `eval/calc-blake2b256.ts`; the spec reuses those exact constants.)

**Three load-bearing notes:**

- This is a **bespoke formula**, *not* the `(n-1)/chunkSize + 1` chunks helper (`addPerItemJitCost`). It uses `⌊L/chunkSize⌋ + 1` directly. So the n=0 JVM-divergence (the per-item `n=0` chunk memo) **does not apply** — at `L=0` this already yields `1`. Implement it inline; do **not** route through the PerItemCost chunks helper.
- Scala integer `/` truncates toward zero; `L ≥ 0`, so `Math.trunc` (≡ `Math.floor` here) is exact.
- Cost is computed from the **raw `k`**, *before* the guards — even an out-of-range `k` (e.g. 33, or a negative) charges `c(k,…)` and *then* the WithChecks guard throws. Pin this in a reject fixture. (This cost lives in the ergoscript handler, not in scorex.)

**Worked example (blessed vector, h=614,440):** k=32, lengths 7+8+4=19 → `⌊19/128⌋+1 = 1` → `c = 500 + 33·1·7 = 731`.

---

## 5. Error handling

The three `require` failures are undifferentiated in the JVM (all `IllegalArgumentException` → script fails). Two layers:

- **scorex:** `autolykosHitForMessageWithChecks` throws a dedicated error class (e.g. `PowHitInvalidParamsError`, alongside `AutolykosV1NotSupportedError` in `scorex/src/errors.ts`) with a message naming which guard fired.
- **ergoscript:** the handler maps that scorex throw to one new `EvalError` code **`'pow-hit-invalid-params'`** — mirroring how `checkPow` maps scorex's `AutolykosV1NotSupportedError` to `'autolykos-v1-not-supported'`.

Per the adversarial-path-equal-weight rule: `k` and `N` are attacker-controlled `SInt` constants, so these guards are consensus-reachable and **must** reject exactly where the JVM rejects. This raises the ergoscript EvalError code count **79 → 80** and the method registry **122 → 123** (exact pre-counts re-verified in the facts task).

---

## 6. Wire / dispatch / type resolution

- **No new wire opcode.** `powHit` has 5 args → serialized as a plain `MethodCall` (0xdc) on `Global`; args are concrete-typed and the return is concrete `SUnsignedBigInt` → **no explicit-type-args**, no P0 type-var engine. Just the `(106,8)` dispatch entry.
- **`method-signatures.ts`:** add a closed-`tRange` entry `(106, 8) → SUnsignedBigInt` so `exprTpe` resolves a `powHit` MethodCall's static type correctly. **This is load-bearing for type propagation** — it's exactly the bug sigma-rust #877 fixed: `coll.map(x => Global.powHit(…)).exists((u: UnsignedBigInt) => …)` must type the mapped collection as `Coll[SUnsignedBigInt]`, not `Coll[SBoolean]`/`Coll[SAny]`.

---

## 7. Test plan & conformance

**Primary value vector (JVM-blessed):** k=32, msg=`0a101b8c6a4f2e`, nonce=`000000000000002c`, h=`00000000`, N=`1048576` → hit `326674862673836209462483453386286740270338859283019276168539876024851191344`. From `LanguageSpecificationV6.scala:1589-1593` + `BasicOpsTests.scala:106-111` (real mainnet header at h=614,440). Test at both the scorex primitive layer (`autolykosHitForMessageWithChecks`) and the ergoscript MethodCall-eval layer; assert the eval-layer **cost = 731** (+ the MethodCall dispatcher + per-Const evals — exact tree total computed in the plan).

**Reject vectors (boundary, from the `require` lines):** k=1 (k<2), k=33 (k>32), N=15 (N<16) → each throws `'pow-hit-invalid-params'`. Where determinate, **pin the charged cost** to lock the cost-then-throw order (e.g. k=33 charges `500 + 34·1·7` then throws).

**Non-regression — the consensus guard (this is what makes C″ safe):**
- **scorex** Autolykos tests (`packages/scorex/test/autolykos-v2.test.ts`) — adapted to the generalized helper signatures (`genIndexes(seed,N,32)`, `h`-bytes), must stay green; the existing per-step byte fixtures are the guard that the generalization changed no bytes.
- **nipopow** full suite (247 tests) — the `compareProofs`/best-arg tests are the byte-for-byte guard that routing `powHit(header)` through the core left the KMZ17 comparison identical.
- **ergoscript** `checkPow` (h=614,440) fixture — guards the scorex verify refactor end-to-end.

**Coverage limit (stated honestly):** the only JVM-blessed *value* vector is k=32, which coincides with the verify/nipopow path — so it does **not** independently exercise the `k≠32` generalization. Assurance for `k≠32` rests on **source-correspondence** (the generalized `genIndexes` is a line-for-line port of JVM `(0 until k)`). **Follow-up:** a `k≠32` JVM-blessed conformance vector is requested from SANTA (`~/projects/santa/prompts/ergots-powhit-vectors.md`, 2026-06-05) — tracked, non-blocking, consistent with the v6 SANTA-leads conformance model.

**Gate (the user's push precondition):** `npm test` green across **all four** packages (scorex rebuilt first, then nipopow + ergoscript against the rebuilt dist), `npx tsc --noEmit` clean across all workspaces.

---

## 8. Risks & residuals

- **C″ touches two consensus-crypto paths — scorex's PoW verify AND nipopow's KMZ17 PoW comparison.** This is the real risk and the reason the user gated push on the full suite. Mitigation: every change is **identity-preserving** (the helpers are generalized with defaults that recover today's behavior; the two header loops are byte-for-byte the core at k=32), and the existing scorex per-step fixtures + nipopow comparison tests + the ergoscript `checkPow` fixture re-derive the same bytes and go red instantly on any drift. Extra care + an explicit full-diff review before commit (CLAUDE.md crypto-confidence escalation).
- **Adversarial huge-`k` cost overflow (accepted residual, documented):** JVM `JitCost` is an `Int`; for `k` near `Int.MAX`, `(k+1)*…` overflows in the JVM (silent wraparound) *before* `require(k<=32)` throws. ergots computes the cost with JS numbers (no 32-bit overflow), so the *charged cost value* on this path can differ. **There is no observable consensus divergence:** for every valid `k ∈ [2,32]` the factor `(k+1) ≤ 33` never overflows, so the costs are *identical*; the differing value only ever arises for `k > 32` (or `k < 2`), which **always rejects** via the require guard regardless of cost. So the divergence is confined to the magnitude of a cost charged only on an always-reject path — never to an accept/reject decision. Flagged for reviewer sign-off rather than replicating JVM Int-overflow in the accumulator.
- **`genIndexes` zero-index** (sigma-rust #847) is a Rust-only `.to_u32_digits()` panic on `BigInt(0)`. TS `BigInt` `mod` returns `0n` natively (`0 mod N = 0`) — **no special-casing needed**; the port is correct by construction. Noted so it isn't re-litigated.
- **UBI result range:** the hit is `blake2b256(…)` interpreted unsigned = exactly 32 bytes = always `< 2^256`, so it always fits `SUnsignedBigInt`; **no result range-check** (and none in the JVM).

---

## 9. Scope

**In P5c:** the `Global.powHit` method end-to-end, **plus the single-source unification (C″)**:
- scorex: generalized helpers + the `autolykosHitForMessage`(+`WithChecks`) core + `int32BE`; `verifyAutolykosV2` routed through the core; public-API swap (trio → core); guard error class.
- nipopow: `powHit(header)` routed through the core; imports updated.
- ergoscript: `global-pow-hit.ts` handler + dispatch + `method-signatures` entry + cost + one EvalError code.
- The test vectors + the full four-package non-regression gate.

**Out of P5c:** anything beyond this. P5c completes P5; P6/P7/P8 remain. No other Global methods, no UBI-surface changes (P2 complete), no wire changes, no behavior change to nipopow's comparison *result* (identity-preserving refactor only).

---

## 10. facts/ + docs updates (contract-first — Task 1 of the plan)

- `facts/scorex.md` — update the `@ergots/scorex` Autolykos surface: **remove** `buildAutolykosSeed`/`genIndexes`/`hashElement` from the public interface, **add** `autolykosHitForMessage` / `autolykosHitForMessageWithChecks` (signatures, the `require` preconditions, the JVM Source Mapping rows); note the public-API change is a scorex version bump at v6 delivery.
- `facts/nipopow.md` — the public contract is **unchanged** (only an internal dep swap: the trio → the scorex core); add a one-line note recording the internal change so the cross-package dependency is explicit.
- `facts/ergoscript-eval.md` — add the `(106,8)` row to the method registry (→123), the `'pow-hit-invalid-params'` code (→80), the cost formula, the version gate, and the `method-signatures.ts` `(106,8)→SUnsignedBigInt` resolver entry.
- `facts/ergoscript.md` (hub) — bump the registry/code tallies in lockstep.
- `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` — mark P5c done in the phase ledger; note P5 complete.
- `SESSION_CONTEXT.md` — close-out summary (untracked).

---

## 11. Commit plan (local-only; no push until §7 gate green + explicit go)

Following the established per-step cadence (brainstorm → spec → writing-plans → subagent-driven TDD):

1. spec (this doc)
2. facts/ (scorex + nipopow note + ergoscript-eval + hub) — contract-first
3. scorex: generalize helpers (`genIndexes` +k, `buildAutolykosSeed`/`hashElement` h-bytes) + `int32BE` + the `autolykosHitForMessage`(+`WithChecks`) core + guard error; adapt the scorex test; index.ts API swap (TDD: the k=32 primitive vector + the existing per-step fixtures stay green)
4. scorex: route `verifyAutolykosV2` through the core (non-regression: `checkPow`-equivalent scorex verify tests stay green)
5. nipopow: route `compare.ts` `powHit(header)` through the core; update imports (non-regression: 247 suite stays green)
6. ergoscript: `method-signatures.ts` `(106,8)` entry
7. ergoscript: `global-pow-hit.ts` handler + dispatch + `'pow-hit-invalid-params'` code (TDD: value vector + reject/cost-then-throw vectors)
8. close-out (umbrella ledger + facts tallies reconcile + SESSION_CONTEXT)

Per the v6 disposition these stay on `ergoscript-v6`; **push only after the full four-package gate is green and with an explicit go** (the consensus-path constraint).
