# ErgoScript v6 — P5c: `Global.powHit` design

**Status:** proposed (2026-06-05)
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

### Relationship to the existing scorex verify path

`@ergots/scorex/src/autolykos-v2.ts` already implements this math for **header verification** (`verifyAutolykosV2`), but in a *specialized* form with three differences from the general `powHit` form:

1. `genIndexes` is **hardcoded to 32 indices** (`for i in 0..32`); `powHit` needs `k`.
2. `hashElement(index, height: number)` derives the element's "height bytes" from a parsed `int → BE4`; `powHit` passes `h` through as **raw `Coll[Byte]`** (into both the `f` seed-hash and `genElementV2`).
3. scorex folds JVM's `Blake2b256(seed)` into `buildAutolykosSeed` (it returns the *hashed* seed) and its `genIndexes` skips the internal re-hash. **This is algebraically identical** to the JVM, just factored differently.

The JVM's own header path (`hitForVersion2(header)`, `:150-160`) is literally `hitForVersion2ForMessage(32, msgByHeader(header), powNonce, int32BE(height), calcN(header))`. **So routing both verify and powHit through one general function mirrors the canonical structure** — this is the chosen architecture (Option C), not a flexibility-driven refactor.

---

## 3. Architecture

### 3.1 `@ergots/scorex` — the general hit primitive (+ verify refactor)

In `packages/scorex/src/autolykos-v2.ts`, add the faithful general port (names are TS-idiomatic; JVM correspondence documented in source comments + the facts Source Mapping table):

- **`autolykosHitForMessage(k, msg, nonce, h, N): bigint`** — the un-checked core. A line-for-line port of `hitForVersion2ForMessage`, reusing the file's existing `blake2b256`, `calcBigM`, and `asUnsignedByteArray` helpers. Generalizes `genIndexes` to `(0 until k)` and uses `h: Uint8Array` raw (no int→BE4).
- **`autolykosHitForMessageWithChecks(k, msg, nonce, h, N): bigint`** — the public checked entry: the three `require` guards, then the core. **This is what the ergoscript handler calls.** On guard violation it throws a dedicated error (see §3.3) — distinct from scorex's existing `AutolykosV1NotSupportedError`.

Then **refactor `verifyAutolykosV2`** to express the hit in terms of the new core, mirroring JVM `hitForVersion2`:

```
hit = autolykosHitForMessage(32, msg, nonce, int32BE(height), bigN)   // unchecked: k=32, N=bigN always pass the guards
target = ORDER / decodeCompactBits(header.nBits)
return hit < target
```

This removes scorex's now-redundant specialized trio (`buildAutolykosSeed`, the hardcoded-32 `genIndexes`, `hashElement`). The general `genIndexes` re-hashes the seed internally (JVM form), so the seed passed in is the **raw** `f ++ msg ++ nonce`.

**Faithfulness of the refactor is guarded by:** the existing scorex Autolykos tests, the ergoscript `checkPow` fixture (h=614,440), and (historically) the full mainnet walk — all of which exercise the k=32 path and re-derive the same bytes. Any drift goes red immediately.

**Export** `autolykosHitForMessageWithChecks` from `packages/scorex/src/index.ts` (alongside the existing `verifyAutolykosV2`). Functions made dead by the refactor are removed (not left exported) unless an external consumer needs them — to be confirmed during implementation (`buildAutolykosSeed`/`genIndexes`/`hashElement` are currently exported; the facts task verifies no other in-repo consumer before removal).

> **Build note:** touching scorex `src/` requires rebuilding `packages/scorex/dist/` before ergoscript tests run (ergoscript imports the built dist), and republishing scorex at v6 delivery — identical footprint to P5a's `ByteReader` change. nipopow is unaffected by the powHit addition but **is** affected by any verify-path refactor (nipopow consumes scorex's PoW verification) → the nipopow suite is part of the gate.

### 3.2 `@ergots/ergoscript` — the `Global.powHit` handler

New file `packages/ergoscript/src/eval/global-pow-hit.ts` (P5 naming convention: `global-from-bigendian-bytes.ts`, `global-decode-nbits.ts`, …). The handler:

1. Extracts args: `k` (Int → number), `msg`/`nonce`/`h` (Coll[Byte] → Uint8Array via the existing byte-coll helper), `N` (Int → number). Operand-kind guards on each (the P1 final-review lesson — a wrong-kind operand must yield a typed `EvalError`, not garbage or a raw `TypeError`).
2. **Charges cost first** (Pattern A, cost-then-throw — see §4): `FixedCost(c)` computed from the *raw* `k` and the byte lengths.
3. Calls `autolykosHitForMessageWithChecks(k, msg, nonce, h, N)` from `@ergots/scorex`.
4. Returns `{ kind: 'UnsignedBigInt', value: hit }`.

Registered in `eval/method-call.ts`: `HANDLERS.set(handlerKey(106, 8), { handler, minVersion: 3 })`.

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
- Cost is computed from the **raw `k`**, *before* the guards — even an out-of-range `k` (e.g. 33, or a negative) charges `c(k,…)` and *then* the WithChecks guard throws. Pin this in a reject fixture.

**Worked example (blessed vector, h=614,440):** k=32, lengths 7+8+4=19 → `⌊19/128⌋+1 = 1` → `c = 500 + 33·1·7 = 731`.

---

## 5. Error handling

The three `require` failures are undifferentiated in the JVM (all `IllegalArgumentException` → script fails). One new descriptive `EvalError` code is faithful and simplest:

- **`'pow-hit-invalid-params'`** — raised by `autolykosHitForMessageWithChecks` when `k < 2`, `k > 32`, or `N < 16`. (The error message names which guard fired, for debuggability; the *code* is one.)

Per the adversarial-path-equal-weight rule: `k` and `N` are attacker-controlled `SInt` constants, so these guards are consensus-reachable and **must** reject exactly where the JVM rejects. This raises the ergoscript EvalError code count **79 → 80** and the method registry **122 → 123** (exact pre-counts re-verified in the facts task).

Scorex error surfacing: the new guard error is a scorex-layer throw (a new error class or a typed throw) that the ergoscript handler maps to the `'pow-hit-invalid-params'` EvalError — mirroring how `checkPow` maps scorex's `AutolykosV1NotSupportedError` to `'autolykos-v1-not-supported'`.

---

## 6. Wire / dispatch / type resolution

- **No new wire opcode.** `powHit` has 5 args → serialized as a plain `MethodCall` (0xdc) on `Global`; args are concrete-typed and the return is concrete `SUnsignedBigInt` → **no explicit-type-args**, no P0 type-var engine. Just the `(106,8)` dispatch entry.
- **`method-signatures.ts`:** add a closed-`tRange` entry `(106, 8) → SUnsignedBigInt` so `exprTpe` resolves a `powHit` MethodCall's static type correctly. **This is load-bearing for type propagation** — it's exactly the bug sigma-rust #877 fixed: `coll.map(x => Global.powHit(…)).exists((u: UnsignedBigInt) => …)` must type the mapped collection as `Coll[SUnsignedBigInt]`, not `Coll[SBoolean]`/`Coll[SAny]`.

---

## 7. Test plan & conformance

**Primary value vector (JVM-blessed):** k=32, msg=`0a101b8c6a4f2e`, nonce=`000000000000002c`, h=`00000000`, N=`1048576` → hit `326674862673836209462483453386286740270338859283019276168539876024851191344`. From `LanguageSpecificationV6.scala:1589-1593` + `BasicOpsTests.scala:106-111` (real mainnet header at h=614,440). Test at both the scorex primitive layer and the ergoscript MethodCall-eval layer; assert the eval-layer **cost = 731** (+ the MethodCall dispatcher + per-Const evals — exact tree total computed in the plan).

**Reject vectors (boundary, from the `require` lines):** k=1 (k<2), k=33 (k>32), N=15 (N<16) → each throws `'pow-hit-invalid-params'`. Where determinate, **pin the charged cost** to lock the cost-then-throw order (e.g. k=33 charges `500 + 34·1·7` then throws).

**Verify-path non-regression:** the existing scorex Autolykos tests + the ergoscript `checkPow` (h=614,440) fixture must stay green through the refactor — they are the byte-for-byte guard that routing verify through the general core changed nothing.

**Coverage limit (stated honestly):** the only JVM-blessed *value* vector is k=32, which coincides with the verify path's hardcoded count — so it does **not** independently exercise the `k≠32` generalization. Assurance for `k≠32` rests on **source-correspondence** (the general `genIndexes` is a line-for-line port of JVM `(0 until k)`, and the k=32 core is the same code the mainnet-walked verify path now uses). **Follow-up:** request a `k≠32` JVM-blessed conformance vector from SANTA (a prompt scaffold already exists: `~/projects/sigma-rust/prompts/santa-powhit-unsignedbigint-hof-vector.md`, currently HOF-typing focused). Tracked, not blocking — consistent with the v6 SANTA-leads conformance model.

**Gate (the user's push precondition):** `npm test` green across **all four** packages (scorex rebuilt first; nipopow included because the verify-path refactor touches its PoW dependency), `npx tsc --noEmit` clean across all workspaces.

---

## 8. Risks & residuals

- **Verify-path refactor on the consensus crypto path** — the one real risk. Mitigation: the change is algebraically identity-preserving (JVM organizes it exactly this way), and the existing tests + checkPow fixture re-derive the bytes. The user has gated push on this gate being green. Extra care + an explicit diff review before commit (CLAUDE.md crypto-confidence escalation).
- **Adversarial huge-`k` cost overflow (accepted residual, documented):** JVM `JitCost` is an `Int`; for `k` near `Int.MAX`, `(k+1)*…` overflows in the JVM (silent wraparound) *before* `require(k<=32)` throws. ergots computes the cost with JS numbers (no 32-bit overflow), so the *charged cost value* on this path can differ. **There is no observable consensus divergence:** for every valid `k ∈ [2,32]` the factor `(k+1) ≤ 33` never overflows, so the costs are *identical*; the differing value only ever arises for `k > 32` (or `k < 2`), which **always rejects** via the require guard regardless of cost. So the divergence is confined to the magnitude of a cost charged only on an always-reject path — never to an accept/reject decision. Flagged for reviewer sign-off rather than replicating JVM Int-overflow in the accumulator.
- **`genIndexes` zero-index** (sigma-rust #847) is a Rust-only `.to_u32_digits()` panic on `BigInt(0)`. TS `BigInt` `mod` returns `0n` natively (`0 mod N = 0`) — **no special-casing needed**; the port is correct by construction. Noted so it isn't re-litigated.
- **UBI result range:** the hit is `blake2b256(…)` interpreted unsigned = exactly 32 bytes = always `< 2^256`, so it always fits `SUnsignedBigInt`; **no result range-check** (and none in the JVM).

---

## 9. Scope

**In P5c:** the `Global.powHit` method end-to-end — scorex general hit primitive + verify refactor, ergoscript handler + dispatch + method-signature + cost + one EvalError code, and the test vectors above.

**Out of P5c:** anything beyond this one method. P5c completes P5; P6/P7/P8 remain. No changes to other Global methods, no UBI surface changes (P2 is complete), no wire changes.

---

## 10. facts/ + docs updates (contract-first — Task 1 of the plan)

- `facts/scorex.md` — add `autolykosHitForMessageWithChecks` to the `@ergots/scorex` interface (the Autolykos surface), with its precondition guards and the JVM Source Mapping row; note the verify-path refactor.
- `facts/ergoscript-eval.md` — add the `(106,8)` row to the method registry (→123), the `'pow-hit-invalid-params'` code (→80), the cost formula, the version gate, and the `method-signatures.ts` `(106,8)→SUnsignedBigInt` resolver entry.
- `facts/ergoscript.md` (hub) — bump the registry/code tallies in lockstep.
- `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` — mark P5c done in the phase ledger; note P5 complete.
- `SESSION_CONTEXT.md` — close-out summary (untracked).

---

## 11. Commit plan (local-only; no push until §7 gate green + explicit go)

Following the established per-step cadence (brainstorm → spec → writing-plans → subagent-driven TDD):

1. spec (this doc)
2. facts/ (scorex + ergoscript-eval + hub) — contract-first
3. scorex: `autolykosHitForMessage` + `…WithChecks` + guard error + exports (TDD against the k=32 primitive vector)
4. scorex: refactor `verifyAutolykosV2` through the core; remove dead specialized fns (non-regression green)
5. ergoscript: `method-signatures.ts` `(106,8)` entry
6. ergoscript: `global-pow-hit.ts` handler + dispatch + `'pow-hit-invalid-params'` code (TDD: value vector + reject/cost-then-throw vectors)
7. close-out (umbrella ledger + facts tallies reconcile + SESSION_CONTEXT)

Per the v6 disposition these stay on `ergoscript-v6`; **push only after the full four-package gate is green and with an explicit go** (the consensus-path constraint).
