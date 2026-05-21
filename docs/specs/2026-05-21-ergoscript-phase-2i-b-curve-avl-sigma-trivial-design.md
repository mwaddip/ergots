# Phase 2i-b — Curve + AVL + sigma-trivial predefs (eval-side)

**Status:** Draft
**Date:** 2026-05-21
**Packages:** `@ergots/ergoscript` (TS) + `fixture-gen` (Rust)
**Interface contracts:** `facts/ergoscript-eval.md` — eval-arm coverage grows 60 → 65; `EvalError` codes 55 → 59 (+4); method-handler registry unchanged at 44.
**Predecessor spec:** `docs/specs/2026-05-20-ergoscript-phase-2i-a-pure-bytes-predefs-design.md` (Phase 2i-a — Pure-bytes predefs, landed 42 commits at HEAD `2e095a5`)
**Parent phase:** 2i — Predefs and oddments (umbrella from `docs/specs/2026-05-13-ergoscript-interpreter-design.md:70`)
**Sibling sub-phases (deferred):**

- 2i-c — Deserialize\* (`DeserializeContext`, `DeserializeRegister`) — recursive-eval architectural lift
- 2i-d — Long-tail parse-rejecting / deprecated arms (`OpTrue`/`OpFalse`/`UnitConstant`, `Select1-5`, `ModQ` family, `CollShift`/`CollRotate`, etc.)

## Goal

Wire eval arms for 5 `Expr` variants that round out the curve-arithmetic, AVL+ value-constructor, AVL+ single-key lookup, and sigma-trivial frontend-only-throw surfaces. Each is a single MIR variant whose payload is already parseable (wire format 100%); we add the eval cases only. Coverage grows from 60/~70 to 65/~70 `Expr` arms.

Per-arm summary:

| # | Arm | Cost pattern | Inputs | Output | Helper reuse |
|---|---|---|---|---|---|
| 1 | `SigmaPropIsProven` | none (structural throw) | (none evaluated) | (always throws) | — |
| 2 | `MultiplyGroup` | A, `Fixed(40)` | `GroupElement`, `GroupElement` | `GroupElement` | `decodePoint`/`pointAdd`/`encodePoint` (existing `crypto/secp256k1.ts`) |
| 3 | `Exponentiate` | A, `Fixed(900)` | `GroupElement`, `BigInt` (i256) | `GroupElement` | `decodePoint`/`pointMul`/`encodePoint` (existing) |
| 4 | `CreateAvlTree` | none (children-only) | `Byte`, `Coll[Byte]`, `Int`, `Option[Int]` | `AvlTree` | `collByteToUint8Array` (2i-a) |
| 5 | `TreeLookup` | none (children-only) | `AvlTree`, `Coll[Byte]`, `Coll[Byte]` | `Option[Coll[Byte]]` | `collByteToUint8Array` (2i-a) + `verifyAvlLookup` (`@ergots/avltree` v0.2.0) + `avlTreeDataToConfig` (existing in `_avltree-adapter.ts`) |

**Cost confirmation:** `CreateAvlTree` and `TreeLookup` have NO inline `add_jit_cost` in sigma-rust (verified via `grep -l "add_jit_cost\|add_per_item_jit_cost" ergotree-interpreter/src/eval/*.rs` — neither file appears in the result). `SigmaPropIsProven` also has none — it throws structurally before any children eval. The implementation cost contribution is whatever the children evals charge (which they do themselves through their own arms' Pattern A/B). Our TS port matches this — no direct `ctx.addCost` calls in T2/T5/T6 handlers. Oracle fixtures validate this byte-for-byte.

Per-arm demand counts from the Task B 12,712-box wider mainnet corpus survey: all 5 arms register **zero distinct boxes**. Per `[[feedback-pre-v1-coverage-not-load-bearing]]` this does NOT drive deferral — these arms ride along under the same architectural shape as the 2i-a predefs at near-zero marginal cost. The incremental scaffolding (5 new handler files + fixture-gen scenarios + oracle tests) is small and each closes a real interpreter gap.

## Non-goals

- **No recursive-eval arms.** `DeserializeContext` / `DeserializeRegister` ship in phase 2i-c (separate architectural lift — "untrusted bytes parsed as code").
- **No `DecodePoint` adapter convergence.** The 2i-a follow-up around `crypto/secp256k1.ts:decodePoint` aligning with sigma-rust's `buf[0] !== 0` semantic remains out of scope. `Exponentiate` and `MultiplyGroup` decode their GroupElement inputs through the same adapter; pre-existing divergence is inherited. See "Risk hotspots" §3.
- **No method-call dispatcher changes.** All 5 arms are top-level `Expr` variants with their own opcodes — none route through `MethodCall`. The 44-entry registry is unchanged.
- **No new runtime dependencies.** `@noble/curves@2.2.0` already provides secp256k1 `Point.add`, `Point.multiply`, `Point.fromBytes`. `@ergots/avltree` v0.2.0 already exposes `verifyAvlLookup`. No version bumps.
- **No public-API change to `@ergots/scorex`, `@ergots/nipopow`, or `@ergots/avltree`.** Refactor-free dependencies. No workspace-version bumps.
- **No Layer C3 cost calibration.** Per-arm Layer C1 cost-integer-equality is required (every oracle fixture asserts it); Layer C3 mainnet-context calibration is phase 2j.
- **No reuse-as-helper extraction.** None of the 5 arms touches a 3-or-more inline copy threshold — `decodePoint` / `encodePoint` / `pointAdd` / `pointMul` are already module-level helpers in `crypto/secp256k1.ts`. `collByteToUint8Array` (extracted in 2i-a T7.5) handles all Coll[Byte] inputs.

## Motivation

Phase 2i-a closed the 8 "pure-bytes" predefs (~46% of the wider corpus). The remaining ~10 unwired arms split into three buckets:

- **Curve + AVL primitives (this slice, 2i-b):** 5 arms with thin handlers that delegate to existing infrastructure. Marginal cost: near-zero.
- **Recursive-eval (2i-c):** 2 arms (`DeserializeContext`, `DeserializeRegister`) that re-enter the parser with untrusted bytes. Marginal cost: high (architectural lift; new consensus surface).
- **Long-tail parse-rejecting / deprecated (2i-d):** ~5 arms that always-throw via Scala-era graph-IR rewrites (`SigmaPropIsProven` sibling pattern) or are deprecated in V2+/V3 trees. Marginal cost: low but per-arm value also low.

This slice picks the "near-zero marginal cost" bucket. By the time it lands, the only unwired arms left are the 2i-c recursive lift and the 2i-d long-tail. Each can then be a focused, self-contained spec without the curve / AVL arms looming over the corpus survey.

## Architecture

### Per-arm handler design

**Uniform shape, ~25-50 LOC per handler.** Each handler lives in its own file under `packages/ergoscript/src/eval/`. Defensive kind-checks throw `EvalError` with the appropriate code.

```ts
// eval/sigma-prop-is-proven.ts — no cost, no eval, structural throw
// Source: ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25
// Sigma-rust always returns Err(EvalError::Misc(...)). Op-code 95 is reserved
// in the IR for byte-match parity with Scala sigmastate, whose typer rewrites
// `prop.isProven` to a SigmaPropIsProven node; the AOT graph-IR rewrite
// removes the node before evaluation. Sigma-rust mirrors that by throwing
// structurally; we do the same.
//
// NOTE the underscore-prefixed _env / _ctx in sigma-rust source — the arm
// reads neither, and crucially does NOT eval e.input. Our TS port matches:
// no evalExpr, no addCost, just the throw.
export function evalSigmaPropIsProven(_e: SigmaPropIsProven, _env: Env, _ctx: EvalContext): SValue {
  throw new EvalError(
    'SigmaPropIsProven has no interpreter eval (frontend-only — Scala graph-IR rewrites elide it; sigma-rust mirrors as a structural throw)',
    'sigma-prop-is-proven-no-eval'
  )
}

// eval/multiply-group.ts — Pattern A, Fixed(40)
// Source: ergotree-interpreter/src/eval/multiply_group.rs:9-29
//         ergo-chain-types/src/ec_point.rs:74-80 (Mul<&EcPoint> = ProjectivePoint::add)
//
// Sigma-rust uses *multiplicative notation* for the group — `left * right`
// on EcPoint dispatches to `ProjectivePoint::add(self.0, &other.0)` per the
// Mul<&EcPoint> impl. That is: "multiply" on group elements is point
// ADDITION on the underlying curve. We use our existing `pointAdd` adapter,
// which calls `Point.add` from @noble/curves — exactly mirroring sigma-rust.
export function evalMultiplyGroup(e: MultiplyGroup, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(40)
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  if (leftV.kind !== 'GroupElement') {
    throw new EvalError(`MultiplyGroup: expected GroupElement left input, got '${leftV.kind}'`,
      'group-op-input-not-group-element')
  }
  if (rightV.kind !== 'GroupElement') {
    throw new EvalError(`MultiplyGroup: expected GroupElement right input, got '${rightV.kind}'`,
      'group-op-input-not-group-element')
  }
  const left = decodePoint(leftV.value)
  const right = decodePoint(rightV.value)
  const result = pointAdd(left, right)
  return { kind: 'GroupElement', value: encodePoint(result) }
}

// eval/exponentiate.ts — Pattern A, Fixed(900)
// Source: ergotree-interpreter/src/eval/exponentiate.rs:13-33
//         ergo-chain-types/src/ec_point.rs:112-119 (exponentiate — identity short-circuit)
//         ergotree-ir/src/sigma_protocol/dlog_group.rs:60-64 (bigint256_to_scalar)
//
// Cost is Fixed(900) regardless of exponent magnitude — sigma-rust does NOT
// scale by bit-length. The exponent is BigInt256 (i256-range, signed). Our
// existing `pointMul(p, k)` adapter handles:
//   - Negative exponents:    `((k % groupOrder) + groupOrder) % groupOrder` —
//                            equivalent to sigma-rust's `UnsignedBigInt::from_signed_mod(bi, n)`.
//   - Zero exponent:         returns Point.ZERO directly (avoids @noble/curves'
//                            "invalid scalar: out of range" throw on k===0n).
//
// **REQUIRED identity-base guard (NOT in `pointMul`).** Verified against
// `@noble/curves@2.2.0` source (`node_modules/@noble/curves/src/abstract/weierstrass.ts`):
// `Point.multiply` (line 1067) executes the full wNAF path without an `is0()`
// short-circuit. Only `multiplyUnsafe` (line 1103) has `if (sc === _0n || p.is0()) return Point.ZERO`.
// Our `pointMul` calls `Point.multiply`, NOT `multiplyUnsafe`. So
// `pointMul(Point.ZERO, nonzero_k)` would execute wNAF on identity — UB at best,
// off-curve result at worst. Sigma-rust's `ec_point::exponentiate` (`ec_point.rs:113-118`)
// explicitly short-circuits identity bases. We mirror via the guard below.
export function evalExponentiate(e: Exponentiate, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(900)
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  if (leftV.kind !== 'GroupElement') {
    throw new EvalError(`Exponentiate: expected GroupElement base, got '${leftV.kind}'`,
      'group-op-input-not-group-element')
  }
  if (rightV.kind !== 'BigInt') {
    throw new EvalError(`Exponentiate: expected BigInt exponent, got '${rightV.kind}'`,
      'predef-input-not-bigint')
  }
  const base = decodePoint(leftV.value)
  // Mirror sigma-rust's `if !is_identity(base) { ... } else { *base }` short-circuit.
  if (base.is0()) {
    return { kind: 'GroupElement', value: new Uint8Array(33) }  // identity (Ergo convention: 33 zero bytes)
  }
  const result = pointMul(base, rightV.value)  // pointMul reduces mod n internally
  return { kind: 'GroupElement', value: encodePoint(result) }
}

// eval/create-avl-tree.ts — no inline cost, children-only
// Source: ergotree-interpreter/src/eval/create_avl_tree.rs:15-41
//         ergotree-ir/src/mir/create_avl_tree.rs:32-66 (MIR struct + type checks at construction)
//         ergotree-ir/src/mir/avl_tree_data.rs:71-90 (AvlTreeData wire shape)
//
// Eval order: flags → digest → keyLength → (optional) valueLength → construct AvlTreeData.
// Sigma-rust does NOT call add_jit_cost — children eval their own costs.
//
// Key length semantic: sigma-rust evaluates `key_length: i32` then does `as u32`
// (a BIT-CAST, not a range check). Negative i32 becomes a huge u32 (0xFFFFFFFF
// for -1). Mirrored in TS via `>>> 0` (uint32 bit-cast). The MIR struct's
// `key_length` is `Box<Expr>` of type `SInt`; per sigma-rust the field is i32
// at eval time. Oracle fixtures validate negative-i32 keyLength input.
export function evalCreateAvlTree(e: CreateAvlTree, env: Env, ctx: EvalContext): SValue {
  // 1. flags: Byte → u8 → canonicalized 3-bit form
  //
  // CRITICAL — sigma-rust's `AvlTreeFlags::parse` masks input to bits 0..2 only,
  // discarding reserved bits 3..7. See `mir/avl_tree_data.rs::parse`:
  //   insert = (u8 & 0x01) != 0; update = (u8 & 0x02) != 0; remove = (u8 & 0x04) != 0
  //   Self::new(insert, update, remove)  →  AvlTreeFlags(insert|update<<1|remove<<2)
  // So input 0xFF round-trips through parse→new to 0x07 (stored in struct).
  // Our TS port stores the canonicalized u8 in AvlTreeData.treeFlags to match
  // sigma-rust's in-memory AvlTreeData (oracle equality target).
  //
  // NOTE this differs from the WIRE-PARSE path (`parseSValue(SAvlTree, …)` in
  // phase 2h-b) which preserves all 8 bits on round-trip — that path mirrors
  // sigma-rust's wire parser which writes the raw u8 in `serialize()`. The
  // two paths legitimately diverge for u8 inputs with bits 3..7 set: wire-parse
  // keeps all bits; CreateAvlTree-eval masks to 3 bits. This is intentional
  // sigma-rust behavior.
  const flagsV = evalExpr(e.flags, env, ctx)
  if (flagsV.kind !== 'Byte') {
    throw new EvalError(`CreateAvlTree: expected Byte flags, got '${flagsV.kind}'`,
      'create-avl-tree-shape-mismatch')
  }
  const treeFlags = flagsV.value & 0x07  // canonicalize to bits 0..2 (matches AvlTreeFlags::parse→new)

  // 2. digest: Coll[Byte] → 33 bytes
  const digestV = evalExpr(e.digest, env, ctx)
  const digest = collByteToUint8Array(digestV, 'CreateAvlTree')
  if (digest.length !== 33) {
    throw new EvalError(
      `CreateAvlTree: digest must be 33 bytes (32-byte root + 1-byte tree height), got ${digest.length}`,
      'avl-tree-bad-digest-length'
    )
  }

  // 3. keyLength: Int → u32 (bit-cast)
  const keyLengthV = evalExpr(e.keyLength, env, ctx)
  if (keyLengthV.kind !== 'Int') {
    throw new EvalError(`CreateAvlTree: expected Int keyLength, got '${keyLengthV.kind}'`,
      'create-avl-tree-shape-mismatch')
  }
  const keyLength = keyLengthV.value >>> 0  // i32 → u32 (matches sigma-rust `as u32`)

  // 4. valueLength: Option[Int] → number | null
  let valueLengthOpt: number | null = null
  if (e.valueLength !== null) {
    const vlenV = evalExpr(e.valueLength, env, ctx)
    if (vlenV.kind !== 'Int') {
      throw new EvalError(`CreateAvlTree: expected Int valueLength, got '${vlenV.kind}'`,
        'create-avl-tree-shape-mismatch')
    }
    valueLengthOpt = vlenV.value >>> 0  // i32 → u32 (matches sigma-rust `as u32`)
  }

  return {
    kind: 'AvlTree',
    value: {
      digest,  // already a freshly-allocated Uint8Array from collByteToUint8Array
      treeFlags,
      keyLength,
      valueLengthOpt
    }
  }
}

// eval/tree-lookup.ts — no inline cost, children-only + verifier delegation
// Source: ergotree-interpreter/src/eval/tree_lookup.rs:20-65
//
// Eval order: tree → key → proof → verifier. Sigma-rust does NOT call
// add_jit_cost — children eval their own costs; the verifier itself is
// uncosted from this arm's perspective.
//
// Verifier wiring: thin wrap over `@ergots/avltree` v0.2.0's
// `verifyAvlLookup(startingDigest, proof, config, key)`. The package
// returns:
//   - null on proof construction failure (decode error, digest mismatch)
//     — TS throws 'avl-tree-proof-failed' (mirrors sigma-rust
//       Err(EvalError::AvlTree(...)) at tree_lookup.rs:59-63)
//   - { value: Uint8Array } on key-found
//   - { value: null } on key-not-found in proof
//
// The double-null semantic matters: outer null = throw, inner null = Option None.
export function evalTreeLookup(e: TreeLookup, env: Env, ctx: EvalContext): SValue {
  const treeV = evalExpr(e.tree, env, ctx)
  if (treeV.kind !== 'AvlTree') {
    throw new EvalError(`TreeLookup: expected AvlTree receiver, got '${treeV.kind}'`,
      'avl-tree-obj-not-avl-tree')
  }
  const keyV = evalExpr(e.key, env, ctx)
  const key = collByteToUint8Array(keyV, 'TreeLookup')
  const proofV = evalExpr(e.proof, env, ctx)
  const proof = collByteToUint8Array(proofV, 'TreeLookup')

  const config = avlTreeDataToConfig(treeV.value)  // existing helper from _avltree-adapter.ts
  const startingDigest = treeV.value.digest

  const result = verifyAvlLookup(startingDigest, proof, config, key)
  if (result === null) {
    throw new EvalError(`TreeLookup: tree proof verification failed`, 'avl-tree-proof-failed')
  }

  // result.value === null → key absent (Option None)
  // result.value: Uint8Array → key found (Option Some<Coll[Byte]>)
  const elemTpe: SType = { tag: 'SColl', elem: { tag: 'SByte' } }
  return {
    kind: 'Option',
    elem: elemTpe,
    value: result.value === null ? null : bytesToCollByteSValue(result.value)
  }
}
```

### Wiring into `eval.ts`

The 5 new arms are added to the central `evalExpr` switch in `packages/ergoscript/src/eval/eval.ts`. Each case is a single-line dispatch to the per-arm handler.

```ts
// Existing 60 cases unchanged...
case 'SigmaPropIsProven': return evalSigmaPropIsProven(e, env, ctx)
case 'MultiplyGroup':     return evalMultiplyGroup(e, env, ctx)
case 'Exponentiate':      return evalExponentiate(e, env, ctx)
case 'CreateAvlTree':     return evalCreateAvlTree(e, env, ctx)
case 'TreeLookup':        return evalTreeLookup(e, env, ctx)
```

The `_exhaust: never` discriminant at the end of the switch ensures any newly added `Expr` tag without a corresponding arm becomes a compile-time error.

**Chassis sentinel relay (no retargeting needed in 2i-b).** The 2i-a phase landed with the chassis "unwired variant" test sentinel pointing at `DeserializeContext` (a 2i-c arm). After 2i-b lands, `DeserializeContext` is still unwired — sentinel stays there. **`SigmaPropIsProven` does NOT become the sentinel** even though it's "wired"; it throws `'sigma-prop-is-proven-no-eval'`, NOT `'not-implemented-yet'`, so it fails the sentinel test's exact-code assertion. T2's chassis impact is zero.

### Helpers (no new helpers needed)

All required helpers exist:

- `decodePoint(bytes): Point` — `crypto/secp256k1.ts:65-74` (decodes 33-byte SEC1 with Ergo identity convention).
- `encodePoint(p: Point): Uint8Array` — `crypto/secp256k1.ts:85-92` (encodes with Ergo identity convention).
- `pointAdd(a, b): Point` — `crypto/secp256k1.ts:95-97` (thin wrap of `Point.add`).
- `pointMul(p, k: bigint): Point` — `crypto/secp256k1.ts:109-115` (handles k===0, mod n reduction, identity short-circuit).
- `collByteToUint8Array(v, arm, code?)` — `eval/_byte-coll.ts` (extracted in 2i-a T7.5).
- `bytesToCollByteSValue(bytes)` — existing helper.
- `avlTreeDataToConfig(data)` — `eval/_avltree-adapter.ts:13-22` (built in phase 2h-b).
- `verifyAvlLookup` — `@ergots/avltree` v0.2.0 public export.

Defensive kind-checks (`if (v.kind !== 'X')`) are inlined per-arm — no new helpers needed.

## Error taxonomy

**4 new `EvalError` codes (55 → 59):**

| Code | Thrown by | Mirrors sigma-rust |
|---|---|---|
| `'sigma-prop-is-proven-no-eval'` | `SigmaPropIsProven` — always (frontend-only structural throw) | `Misc("SigmaPropIsProven has no interpreter eval…")` (`sigma_prop_is_proven.rs:22-24`) |
| `'group-op-input-not-group-element'` | `MultiplyGroup` (both inputs) / `Exponentiate` (base) when input kind ≠ `GroupElement` | `UnexpectedValue` (`multiply_group.rs:23-26`); `try_extract_into()` fail (`exponentiate.rs:20`) |
| `'predef-input-not-bigint'` | `Exponentiate` when exponent kind ≠ `BigInt` | `try_extract_into::<BigInt256>()` fail (`exponentiate.rs:21`) |
| `'create-avl-tree-shape-mismatch'` | `CreateAvlTree` on non-Byte flags / non-Int keyLength / non-Int valueLength (compact: 1 code covers 3 throw paths via descriptive `.message`) | `try_extract_into` fails at `create_avl_tree.rs:21, 23, 26` |

**Existing codes reused:**

- `'predef-input-not-byte-array'` (2i-a) — `CreateAvlTree.digest` and `TreeLookup.key`/`TreeLookup.proof` non-Coll[Byte] inputs.
- `'avl-tree-bad-digest-length'` (2h-d) — `CreateAvlTree.digest.length !== 33` (mirrors sigma-rust's `ADDigest::try_from` length-check at `create_avl_tree.rs:32`).
- `'avl-tree-obj-not-avl-tree'` (2h-b) — `TreeLookup.tree` non-AvlTree receiver.
- `'avl-tree-proof-failed'` (2h-b) — `TreeLookup` verifier-construct failure (proof decode / digest mismatch / per-op error).

**Naming rationale (compact-taxonomy decision):**

- `'group-op-input-not-group-element'` is **shared** between `MultiplyGroup` and `Exponentiate`. Both arms have the same input-shape error; reusing one code reflects that. The semantic is "expected GroupElement input to a group operation"; this is distinct from `'sigma-prop-input-not-group-element'` (2g-medium) which is specifically for sigma-prop creation arms (`CreateProveDlog` / `CreateProveDhTuple`). The names parallel each other; programmatic dispatch on either covers exactly the intended call sites.
- `'predef-input-not-bigint'` follows the 2i-a `'predef-input-not-long'` precedent. Future arms in the `ModQ` family (phase 2i-d) will reuse this code.
- `'create-avl-tree-shape-mismatch'` is compact — 1 code covers 3 throw paths (flags / keyLength / valueLength). Mirrors `'subst-constants-error'` (2i-a) and `'create-avl-tree-shape-mismatch'`'s `.message` carries the specific field name.

## Test strategy

### Layer mapping

| Layer | What | Where | Pass criterion |
|---|---|---|---|
| **C1 — per-arm fixture validation** | Each arm against sigma-rust `try_eval_out` oracle (value + cost) | `packages/ergoscript/test/eval/<arm>.test.ts` (5 new files) | Byte-equal value + cost-integer-equal under `node` + `jsdom` |
| **C2 — corpus regression gate** | The 18-evaluable-tree mainnet corpus | `test/corpus-eval.test.ts` (unchanged file) | Hard gate stays at `evalSuccess === 18`. No uplift expected — survey shows 0 mainnet boxes touching these arms. |
| **C3.a — operator-driven mutation** | Per-arm single-byte mutation tests | `test/eval-mutation/<arm>.test.ts` | ≥ 90% kill rate per arm (target — aggregate accepted for hard-to-kill regions). `SigmaPropIsProven` skipped — no input bytes to mutate. |

### Fixture-gen structure

```
fixture-gen/src/cmds/ergoscript/eval/
├── sigma_prop_is_proven.rs       ← 1 scenario (the throw — value-side only since sigma-rust raw eval throws and try_eval_out never returns)
├── multiply_group.rs             ← 6 scenarios (generator+generator, gen+identity, identity+gen, random+random, identity+identity, asymmetric)
├── exponentiate.rs               ← 9 scenarios (gen^1, gen^0, gen^-1, gen^k random, identity^k, gen^(n-1), gen^n which ≡ identity, gen^(2^255 - 1) i256 max, gen^(-2^255) i256 min)
├── create_avl_tree.rs            ← 11 scenarios (all-flags-off + None, all-flags-on + Some(5), mid-flags + Some(0), valueLength=2^31-1 (i32 max), negative-keyLength (i32 → u32 bit-cast), large-keyLength, **flags=0xFF reserved-bits canonicalization**, digest wrong-length (32 bytes), non-Byte flags, non-Coll digest, non-Int keyLength)
└── tree_lookup.rs                ← 7 scenarios (key-found, key-absent (Option None), single-leaf-tree, balanced-10 tree, all-left-spine, malformed-proof (→ EvalError::AvlTree), wrong-digest (→ EvalError::AvlTree))
```

### Per-arm fixture matrix

| Arm | Happy | Edge | Throw | Total |
|---|---|---|---|---|
| `SigmaPropIsProven` | — | — | structural throw (no input shape variants — sigma-rust returns Misc unconditionally) | 1 |
| `MultiplyGroup` | gen+gen, gen+identity, identity+identity, random+random, asymmetric | identity-identity short-circuit | non-GroupElement input (left), non-GroupElement input (right) | 6 |
| `Exponentiate` | gen^1, gen^0, gen^k random, identity^k | gen^-1, gen^(n-1), gen^n ≡ identity, gen^(2^255 - 1) i256 max, gen^(-2^255) i256 min | non-GroupElement base, non-BigInt exponent | 9 |
| `CreateAvlTree` ★ | all-flags-off + None valueLength, all-flags-on + Some(5) valueLength, mid-flags + Some(0) | valueLength=2^31-1 (i32 max), negative-keyLength i32 bit-cast, large-keyLength, **flags=0xFF reserved-bits canonicalization (→ stored 0x07)** | digest wrong-length (32 bytes), non-Byte flags, non-Coll digest, non-Int keyLength | 11 |
| `TreeLookup` | key-found at low key in 10-leaf tree, key-absent (Option None) in 10-leaf, single-leaf-tree found | key-found at high (boundary) key in balanced-10 | malformed-proof, wrong-digest, non-AvlTree receiver | 7 |
| **Total** | — | — | — | **34 fixtures** |

★ `CreateAvlTree` has no consensus-critical bytes-out (its output is an in-memory `AvlTreeData` SValue, not on-chain bytes). Equality is structural on the 4 fields; oracle assertion via `eval_out_wo_ctx::<AvlTreeData>` mirrored as TS struct-equal.

### Mutation testing approach (Layer C3.a)

- Reuse the existing TS mutation harness (`test/eval-mutation/_harness.ts`, consolidated in phase 2h-e).
- One mutation scenario per `(fixture, arm)` pair; mutations limited to the fixture's relevant byte region.
- **`SigmaPropIsProven` SKIPPED for mutation testing** — no input bytes to mutate (the arm throws before reading anything). Its single scenario validates the throw shape; no mutation surface.
- For `Exponentiate` / `MultiplyGroup`: mutations target the 33-byte SEC1 GroupElement bytes and the BigInt bytes. Many GroupElement mutations either trip `decodePoint`'s SEC1 validation (kill) or produce a different point (also kill via byte-equality on output).
- For `CreateAvlTree`: mutations target the 33-byte digest and the i32 keyLength bytes.
- For `TreeLookup`: mutations target the proof bytes (the largest mutable surface). Proof corruption almost always causes verifier failure → kill via throw.
- Kill threshold ≥ 90% per arm; aggregate ≥ 90% if a single arm dips below (mirrors phase 2f Coll HOF / 2h-b avltree precedent).

### Expected test count delta

- ergoscript: 3074 → ~3180 (+~106).
- Total: 3652 → ~3758.
- Fixtures: 34 new oracle fixtures + matching mutation scenarios.
- LOC: ~250-350 new source LOC (handlers); ~500-700 new test LOC; ~600-900 new fixture-gen Rust LOC.

## Source mapping to sigma-rust

Pinned at sigma-rust branch `integration/ergots` at `~/projects/ergots/external/sigma-rust/`.

| Rust function / type (file) | TS function (file) | Cost pattern | Notes |
|---|---|---|---|
| `ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25` | `evalSigmaPropIsProven` (`eval/sigma-prop-is-proven.ts`) | none | Always throws; no eval of `e.input`, no cost. Mirrors underscore-prefixed `_env`/`_ctx` in sigma-rust |
| `ergotree-interpreter/src/eval/multiply_group.rs:9-29` | `evalMultiplyGroup` (`eval/multiply-group.ts`) | A `Fixed(40)` | Group "multiply" = point addition per `ec_point.rs:74-80` `Mul<&EcPoint>` impl |
| `ergo-chain-types/src/ec_point.rs:74-80` (`Mul<&EcPoint>::mul = ProjectivePoint::add`) | `pointAdd` (existing `crypto/secp256k1.ts:95-97`) | — | `@noble/curves` `Point.add` |
| `ergotree-interpreter/src/eval/exponentiate.rs:13-33` | `evalExponentiate` (`eval/exponentiate.ts`) | A `Fixed(900)` | Cost fixed regardless of exponent magnitude; identity base short-circuits via @noble/curves Point.ZERO behavior |
| `ergo-chain-types/src/ec_point.rs:111-119` (exponentiate) | `pointMul` (existing `crypto/secp256k1.ts:109-115`) | — | `@noble/curves` `Point.multiply`; pre-handles k===0n, identity, mod n |
| `ergotree-ir/src/sigma_protocol/dlog_group.rs:60-64` (bigint256_to_scalar) | `pointMul`'s internal reduction `((k % n) + n) % n` | — | Equivalent to sigma-rust's `UnsignedBigInt::from_signed_mod(bi, order())`; both handle negative bigints by mod n reduction with positive lift |
| `ergotree-interpreter/src/eval/create_avl_tree.rs:15-41` | `evalCreateAvlTree` (`eval/create-avl-tree.ts`) | none (children-only) | Verified via `grep -l "add_jit_cost" eval/*.rs` — file not in list. Eval order: flags → digest → keyLength → optional valueLength |
| `ergotree-ir/src/mir/avl_tree_data.rs:71-90` | `AvlTreeData` runtime shape (`mir/types.ts`) | — | Promoted from forward-decl in phase 2h-b; reused here |
| `ergo-chain-types/src/digest32.rs::ADDigest::try_from` | `digest.length !== 33` check in handler | — | Single length check; mirrors sigma-rust throw path via `map_eval_err` |
| `ergotree-interpreter/src/eval/tree_lookup.rs:20-65` | `evalTreeLookup` (`eval/tree-lookup.ts`) | none (children-only) | Verified via grep. Thin wrap over `verifyAvlLookup` from `@ergots/avltree` v0.2.0 |
| `@ergots/avltree` v0.2.0 `verifyAvlLookup` | direct call site | — | Existing public export from phase 2h-a; null = construct failure (throw), inner null = key absent (Option None) |
| `eval/_avltree-adapter.ts::avlTreeDataToConfig` | direct call site | — | Existing helper from phase 2h-b — reused unchanged |

## Execution order

Per-task: fixture-gen scenarios → RED test → GREEN handler → mutation tests → chassis check (no retarget needed). Per-task commit count ≈ 4-5 (T2's chassis sentinel impact is zero; T3-T6 add scenarios under existing chassis).

```
T1   docs(plan): PLAN.md overwrite with 2i-b execution plan
T2   eval/sigma-prop-is-proven.ts  ← structural throw; simplest (no fixtures, no mutation tests)
T3   eval/multiply-group.ts         ← uses existing pointAdd; 6 fixtures + mutation tests
T4   eval/exponentiate.ts           ← uses existing pointMul; 9 fixtures + mutation tests
T5   eval/create-avl-tree.ts        ← uses collByteToUint8Array; 8 fixtures + mutation tests
T6   eval/tree-lookup.ts            ← thin wrap over verifyAvlLookup; 7 fixtures + mutation tests
T7   docs: facts/ergoscript-eval.md sweep (coverage 60→65, codes 55→59, changelog entry)
T8   docs: README.md + SESSION_CONTEXT.md + HANDOFF_PROMPT.md sweep + spec → finalized
```

Total: ~21-25 commits expected (smaller than 2i-a's 42 due to fewer arms + no mid-phase refactor anticipated).

### Per-task commit shape

Each Tn for T3-T6 follows the 2i-a 4-commit pattern:

1. `test(fixture-gen): <arm> oracle fixtures` — N scenarios in Rust
2. `test(ergoscript): RED — <arm> oracle test` — TS test that fails because handler missing
3. `feat(ergoscript): <arm> eval arm` — handler + eval.ts wiring
4. `test(ergoscript): <arm> mutation testing (Layer C3.a)` — mutation harness invocation

**T2 (SigmaPropIsProven) is 3 commits, not 4** — `try_eval_out` returns an `Err` result for this arm, so fixture-gen captures the throw shape (NOT a value) in `{"error": "..."}` form; T2 SKIPS the mutation step (Layer C3.a — no input bytes to mutate). T2 commit shape:

1. `test(fixture-gen): SigmaPropIsProven throw-shape fixture` — single scenario in Rust capturing the EvalError::Misc message
2. `test(ergoscript): RED — SigmaPropIsProven structural throw` — TS test asserting the specific code/message
3. `feat(ergoscript): SigmaPropIsProven eval arm (frontend-only throw)` — handler + eval.ts wiring

**Total commit accounting:** T1 (1) + T2 (3) + T3-T6 (4 × 4 = 16) + T7 (1) + T8 (1) = **22 commits**. Range ~21-25 accounts for occasional spec-fix follow-ups.

## Risk hotspots

### 1. Identity-point arithmetic edge cases

Both `Exponentiate(identity, k)` and `MultiplyGroup(identity, X)` involve the identity element. Sigma-rust's `ec_point::exponentiate` explicitly short-circuits identity bases (`ec_point.rs:113-118`). Our `pointMul` relies on `@noble/curves` `Point.ZERO.multiply(k)` returning Point.ZERO. **Validation:** oracle fixture for `gen^0` (k=0), `identity^k` (any k including k=0), and `identity+identity`.

For `MultiplyGroup`: `@noble/curves`'s `Point.add` correctly handles identity in both operands (group axioms). Validation via `identity+gen` fixture.

### 2. BigInt256 → scalar reduction parity

Sigma-rust: `UnsignedBigInt::from_signed_mod(bi, order())` — modular reduction with positive lift. For negative `bi`, the result is `bi % n` lifted to `[0, n)` by adding `n`.

Our `pointMul`: `((k % groupOrder) + groupOrder) % groupOrder` — same algorithm, same result.

**Specific edge cases validated via fixtures:**
- `k = 0`: both produce `Point.ZERO`.
- `k = n - 1`: largest in-range scalar.
- `k = n`: reduces to 0 → identity.
- `k = -1`: reduces to `n - 1` → `gen^(n-1)` = `-gen` (curve inverse). Oracle compares bytes.
- `k = 2^255 - 1` (i256 max): non-trivial reduction.
- `k = -(2^255)` (i256 min): largest negative; sigma-rust accepts. Oracle compares bytes.

### 3. `DecodePoint` adapter divergence — inherited, not introduced by 2i-b

Both `Exponentiate` and `MultiplyGroup` decode their GroupElement inputs through the same `crypto/secp256k1.ts:decodePoint` adapter the sigma verifier and 2i-a's `DecodePoint` arm use. The adapter requires all 33 bytes zero for identity; sigma-rust accepts ANY 33-byte input where `buf[0] === 0` as identity.

**Practical impact:** Same as 2i-a. In-corpus fixtures only ever produce identity as `[0x00; 33]` exactly (canonical sigma-rust serialization). Pathological inputs like `[0x00, 0xAB, 0xCD, ...]` would diverge — but those don't arise from typed sigma-rust output. **No new follow-up created; tracked under the existing 2i-a follow-up.**

### 4. `pointMul(Point.ZERO, k)` REQUIRES an explicit identity-base guard (load-bearing)

**Source-verified during spec review (★★★ critical).**

Reading `@noble/curves@2.2.0`'s `weierstrass.ts`:
- Line 1067 — `Point.multiply(scalar)` enters the wNAF code path immediately. **No `is0()` short-circuit.**
- Line 1103 — `Point.multiplyUnsafe(scalar)` does have `if (sc === _0n || p.is0()) return Point.ZERO`. But our `pointMul` calls `multiply`, not `multiplyUnsafe`.

Conclusion: `pointMul(Point.ZERO, nonzero_k)` would execute the full wNAF path on identity coordinates — undefined behavior at best, off-curve result at worst. **Sigma-rust does NOT allow this** — `ec_point::exponentiate` short-circuits identity bases explicitly at `ec_point.rs:113-118`:

```rust
pub fn exponentiate(base: &EcPoint, exponent: &Scalar) -> EcPoint {
    if !is_identity(base) {
        EcPoint(base.0 * exponent)
    } else {
        *base  // identity^k = identity for all k
    }
}
```

**Required TS guard (already added to handler pseudocode, §"Per-arm handler design"):**

```ts
if (base.is0()) {
  return { kind: 'GroupElement', value: new Uint8Array(33) }  // identity^k = identity
}
const result = pointMul(base, rightV.value)
```

Oracle fixture for `identity^k` (k = random non-zero scalar) validates this guard via byte-equality on output.

**No T4 RED-test discovery required** — the guard ships as part of the initial GREEN. Validation: oracle fixture asserts 33-zero-bytes output for `identity^nonzero_k`.

### 5. `CreateAvlTree` keyLength bit-cast

Sigma-rust evaluates `key_length: i32` then bit-casts to u32 (`create_avl_tree.rs:23`). For negative i32 (e.g. -1), this yields a very large u32 (4294967295). Our handler mirrors via `>>> 0`.

**Fixture-gen requirement:** include a scenario with negative i32 keyLength. The expected output's `key_length` field will be the bit-cast u32 value. Same for `value_length`. Oracle equality on `AvlTreeData.key_length` validates the cast.

### 5b. `CreateAvlTree` flags canonicalization (reserved bits 3..7 stripped)

**Source-read finding from spec self-review (CRITICAL, must not slip).**

Sigma-rust's `AvlTreeFlags::parse(u8)` extracts the 3 boolean fields (`insert`/`update`/`remove`) from bits 0..2, then `AvlTreeFlags::new(...)` reconstructs the u8 from those 3 bits only:

```rust
// mir/avl_tree_data.rs (paraphrased)
pub fn parse(serialized: u8) -> Self {
  let insert = serialized & 0x01 != 0;
  let update = serialized & 0x02 != 0;
  let remove = serialized & 0x04 != 0;
  Self::new(insert, update, remove)  // returns AvlTreeFlags(insert|update<<1|remove<<2)
}
```

So `AvlTreeFlags::parse(0xFF)` returns `AvlTreeFlags(0x07)` — reserved bits 3..7 are stripped. The resulting `AvlTreeData.tree_flags` stores the canonicalized 3-bit form.

**TS port:** `const treeFlags = flagsV.value & 0x07` (NOT `& 0xff`). The spec handler now reflects this.

**Divergence from wire-parse path (intentional, mirrors sigma-rust):** The 2h-b `parseSValue(SAvlTree, …)` wire parser preserves all 8 input bits (`treeFlags: u8` stored verbatim). CreateAvlTree's eval path canonicalizes to 3 bits. Two paths, different outputs for u8 inputs with bits 3..7 set. Both correctly mirror sigma-rust.

**Fixture-gen requirement:** include a scenario with `flags = 0xFF` (or any value with bits 3..7 set). The oracle's expected `AvlTreeData.tree_flags` will be the canonicalized 3-bit form (0x07 for input 0xFF). Without this fixture, a regression dropping the `& 0x07` mask would pass all other fixtures (they use flags ∈ {0, 1, 2, 3, 4, 5, 6, 7}) but produce wrong bytes when constructed from `flags=0xFF`.

### 6. `TreeLookup` proof-failed vs key-absent semantic

Two distinct null returns at the `verifyAvlLookup` boundary:

- `verifyAvlLookup(...) === null` → proof construct failure → TS throws `'avl-tree-proof-failed'`.
- `verifyAvlLookup(...).value === null` → proof OK but key absent → TS returns `Option None`.

A malformed-proof fixture must distinguish these. The fixture's expected output is the throw, NOT `Option None`. Mistaking the two would mask consensus divergence.

### 7. `SigmaPropIsProven` and try_eval_out

Sigma-rust's `try_eval_out` returns `Err(EvalError::Misc(...))` for `SigmaPropIsProven`. The fixture-gen scenario for this arm captures the error path, not a value: the JSON oracle stores `{ "error": "<truncated EvalError::Misc message>" }` instead of `{ "value": ..., "cost": ... }`. The TS test asserts the throw shape (specific code `'sigma-prop-is-proven-no-eval'` + message-substring match).

This is exactly one fixture-gen scenario producing exactly one JSON oracle file. The TS test consumes it like any other oracle fixture, branching on `"error"` field presence vs `"value"`/`"cost"`. No mutation testing — the arm has no input bytes to mutate (it throws before reading anything). T2 commit shape: fixture-gen + RED + GREEN (3 commits, not the 4-commit T3-T6 pattern).

**Note:** since `try_eval_out` is gated by sigma-rust's `arbitrary` feature (per `[[reference-sigma-rust-eval-api]]`), fixture-gen already has the dependency configured.

## Rollback plan

Each arm is independent + bisect-clean. Single-arm revert: `git revert <arm-commit-range>` reverts cleanly without touching others. `eval.ts`'s switch arm for the reverted arm reverts to `'not-implemented-yet'` (the chassis default).

If any of the curve arms (`Exponentiate`, `MultiplyGroup`) proves consensus-divergent in production: revert T3 or T4's commit-range only. Trees containing that arm re-fail with `'not-implemented-yet'` (same behavior as today). The sigma-protocol verifier surface is untouched — neither T3 nor T4 modifies `crypto/secp256k1.ts` or any verifier-side code.

`CreateAvlTree` / `TreeLookup` revert: trees re-fail with `'not-implemented-yet'`. No cross-arm impact.

`SigmaPropIsProven` revert: arm re-fails with `'not-implemented-yet'` instead of the structural `'sigma-prop-is-proven-no-eval'` code. Behavior-equivalent for any caller that doesn't dispatch on the specific code.

## Confidence check (OVERRIDES #2 — crypto path)

| Arm | Confidence | Rationale |
|---|---|---|
| `SigmaPropIsProven` | ~99% | Single throw; no crypto, no eval. Sigma-rust mirror is 14 lines including comments. |
| `MultiplyGroup` | ~98% | Thin compose of existing `decodePoint`/`pointAdd`/`encodePoint`. Multiplicative-notation "multiply" = curve addition verified in source. |
| `Exponentiate` | ~97% | Existing `pointMul` already handles mod n reduction + k===0 + identity. Risk: identity-base behavior under `@noble/curves` (Risk Hotspot 4; resolved during T4 RED). |
| `CreateAvlTree` | ~98% | 4 simple kind-checks + 1 length check + struct construction. Risk: keyLength bit-cast semantics (Risk Hotspot 5; oracle fixture validates). |
| `TreeLookup` | ~96% | Thin wrap over already-validated `verifyAvlLookup`. Risk: double-null semantic (Risk Hotspot 6). |

All ≥ 95% — no escalation required per OVERRIDES rule #2.

## Cross-references

- **Predecessor spec:** `docs/specs/2026-05-20-ergoscript-phase-2i-a-pure-bytes-predefs-design.md`
- **Parent / umbrella:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md:70` (Phase 2i — Predefs and oddments)
- **Corpus demand source:** `docs/specs/2026-05-18-task-b-corpus-survey-tally.json` (all 5 arms register 0 distinct boxes; ride-along per `[[feedback-pre-v1-coverage-not-load-bearing]]`)
- **Boundary contract:** `facts/ergoscript-eval.md` (registry + EvalError codes; this spec proposes coverage 60→65, codes 55→59)
- **Sigma-rust source:** `~/projects/ergots/external/sigma-rust/`, branch `integration/ergots`
- **AVL+ adapter source:** `eval/_avltree-adapter.ts` (phase 2h-b) and `@ergots/avltree` v0.2.0
- **secp256k1 adapter source:** `crypto/secp256k1.ts` (phase 2g-medium; unchanged here)
- **Memory:** `[[feedback-pre-v1-coverage-not-load-bearing]]`, `[[feedback-focused-specs]]`, `[[feedback-review-by-default]]`, `[[reference-source-first-discipline]]`, `[[reference-cost-charging-order-patterns]]`
