# Phase 2i-a — Pure-bytes predefs (eval-side)

**Status:** Draft
**Date:** 2026-05-20
**Packages:** `@ergots/ergoscript` (TS) + `fixture-gen` (Rust)
**Interface contracts:** `facts/ergoscript-eval.md` — eval-arm coverage grows 52 → 60; `EvalError` codes 48 → 54; method-handler registry unchanged at 44.
**Brainstorm transcript:** session 2026-05-20 (continuation of HANDOFF_PROMPT.md d4623e9; scope locked by corpus-survey demand data in `docs/specs/2026-05-18-task-b-corpus-survey-tally.json`)
**Predecessor spec:** `docs/specs/2026-05-20-ergoscript-phase-2h-f-tier-3-method-handlers-design.md` (Phase 2h-f — Tier-3 method-handler cleanup, landed)
**Parent phase:** 2i — Predefs and oddments (umbrella from `docs/specs/2026-05-13-ergoscript-interpreter-design.md:70`)
**Sibling sub-phases (deferred):**

- 2i-b — Curve + AVL + sigma-trivial predefs (`Exponentiate`, `MultiplyGroup`, `CreateAvlTree`, `TreeLookup`, `SigmaPropIsProven`)
- 2i-c — Deserialize\* (`DeserializeContext`, `DeserializeRegister`) — recursive-eval architectural lift
- 2i-d — Long-tail parse-rejecting / deprecated arms (`OpTrue`/`OpFalse`/`UnitConstant`, `Select1-5`, `ModQ` family, `CollShift`/`CollRotate`, etc.)

## Goal

Wire eval arms for the 8 predef-style `Expr` variants whose semantics live entirely in the byte/numeric domain. Each arm is a single MIR variant with `(input...) → output` shape, parsed by phase 2a's wire layer, dispatched via the existing `evalExpr` switch. Coverage grows from 52/~70 to 60/~70 `Expr` arms.

Per-arm demand counts from the Task B 12,712-box wider mainnet corpus survey:

| # | Arm | Cost pattern | Output | Distinct boxes |
|---|---|---|---|---|
| 1 | `DecodePoint` | A, `Fixed(300)` | `GroupElement` (33-byte SEC1) | **2660** |
| 2 | `SubstConstants` | B, `addPerItemCost(100, 100, 1, template_consts_len)` | `Coll[Byte]` | **2647** |
| 3 | `CalcBlake2b256` | B, `addPerItemCost(20, 7, 128, n)` | `Coll[Byte]` (32) | **442** |
| 4 | `CalcSha256` | B, `addPerItemCost(80, 8, 64, n)` | `Coll[Byte]` (32) | 0 |
| 5 | `ByteArrayToLong` | A, `Fixed(16)` | `Long` (i64) | 33 |
| 6 | `ByteArrayToBigInt` | A, `Fixed(30)` | `BigInt` (i256) | 0 |
| 7 | `LongToByteArray` | A, `Fixed(17)` | `Coll[Byte]` (8) | 3 |
| 8 | `Xor` | B, `addPerItemCost(10, 2, 128, n)` | `Coll[Byte]` | 0 |

Tier-1 arms (≥30 boxes) cover ~5785 distinct boxes (≈46% of the wider corpus). Tier-2/3 arms ride along under the same architectural shape — incremental cost of wiring them is small enough that demand-driven cuts here would be wasteful.

## Non-goals

- **No curve scalar ops beyond `Point.fromBytes`.** `Exponentiate` (G^k) and `MultiplyGroup` (G·H) are deferred to phase 2i-b. `DecodePoint` only uses the existing `crypto/secp256k1.ts` adapter's `Point.fromBytes` wrapper — which the sigma-protocol verifier already exercises.
- **No AVL+ predefs.** `CreateAvlTree` (runtime `AvlTreeData` synthesis) and `TreeLookup` (single-key AVL lookup) are deferred to phase 2i-b.
- **No recursive-eval arms.** `DeserializeContext` and `DeserializeRegister` introduce "untrusted bytes parsed as code" semantics with their own consensus surface — phase 2i-c.
- **No parse-rejecting / deprecated arms.** `OpTrue`/`OpFalse`/`UnitConstant`, `TrivialPropFalse`/`True`, `SomeValue`/`NoneValue`, `Select1-5`, `LastBlockUtxoRootHash` (top-level), `FlatMap` (top-level), `FunDef`, `ModQ`/`PlusModQ`/`MinusModQ`, `CollShift{Left,Right,RightZeroed}`/`CollRotate{Left,Right}` — all zero corpus demand and many deprecated in V2+/V3 trees. Phase 2i-d.
- **No method-call dispatcher changes.** All 8 arms are top-level `Expr` variants with their own opcodes — none route through `MethodCall`. The 44-entry registry is unchanged.
- **No new runtime dependencies.** `@noble/hashes@2.2.0` already provides blake2b + sha256; `@noble/curves@2.2.0` already provides secp256k1 `Point.fromBytes`.
- **No public-API change to `@ergots/scorex`, `@ergots/nipopow`, or `@ergots/avltree`.** Refactor-free dependencies. No version bumps anywhere in the workspace.
- **No Layer C3 cost calibration.** Per-arm Layer C1 cost-integer-equality is required (every fixture); real-context Layer C3 calibration is phase 2j.

## Motivation

Phase 2i's umbrella-spec demand from `2026-05-13-ergoscript-interpreter-design.md:70` is "the remaining `SigmaPredef` surface evaluates." Survey data from phase 2h-b (12,712-box wider corpus) shows the surface is dominated by 4 arms (`DecodePoint`, `SubstConstants`, `CalcBlake2b256`, `ByteArrayToLong`) accounting for ~5782 distinct boxes; the other ~28 predef-ish arms collectively account for ~8 distinct boxes. Per `[[feedback-pre-v1-coverage-not-load-bearing]]` we don't ship zero-demand arms just for completeness — but 4 of the 8 arms in this slice are zero-demand. Why include them?

Because the marginal cost is near-zero. Each of `CalcSha256`, `ByteArrayToBigInt`, `LongToByteArray`, `Xor` is a 30-60 LOC handler that mirrors a 20-30 LOC sigma-rust source file, fits the same Pattern A/B cost scaffolding, and reuses the same `extractCollByte` / `bytesToCollByteSValue` helpers as the demand-driven arms. Splitting them into a separate later phase would duplicate the fixture-gen scaffolding, the docs/sweep cycle, and the per-arm test-file boilerplate for no architectural benefit. They ride along here.

## Architecture

### Per-arm handler design

**6 mechanical arms — one file per arm in `packages/ergoscript/src/eval/`, ~30-60 LOC each.**

The shape is uniform: extract input, charge cost (A or B), apply the operation, return the result. All defensive type-checks throw `EvalError` with the appropriate code.

```ts
// eval/decode-point.ts — Pattern A, Fixed(300)
// Source: ergotree-interpreter/src/eval/decode_point.rs:14-30
export function evalDecodePoint(e: DecodePoint, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(300)
  const bytes = extractCollByte(evalExpr(e.input, env, ctx))
  let point: Point
  try { point = secp256k1.Point.fromBytes(bytes) }
  catch (cause) { throw new EvalError('DecodePoint: invalid point bytes', 'decode-point-invalid') }
  return { kind: 'GroupElement', value: point.toBytes(true) }  // 33-byte SEC1
}

// eval/calc-blake2b256.ts — Pattern B
// Source: ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34
export function evalCalcBlake2b256(e: CalcBlake2b256, env: Env, ctx: EvalContext): SValue {
  const bytes = extractCollByte(evalExpr(e.input, env, ctx))
  ctx.addPerItemCost(20, 7, 128, bytes.length)
  return bytesToCollByteSValue(blake2b256(bytes))  // 32-byte output
}

// eval/calc-sha256.ts — Pattern B
// Source: ergotree-interpreter/src/eval/calc_sha256.rs (cost 80, 8, 64)
export function evalCalcSha256(e: CalcSha256, env: Env, ctx: EvalContext): SValue {
  const bytes = extractCollByte(evalExpr(e.input, env, ctx))
  ctx.addPerItemCost(80, 8, 64, bytes.length)
  return bytesToCollByteSValue(sha256(bytes))  // 32-byte output
}

// eval/byte-array-to-long.ts — Pattern A, Fixed(16)
// Source: ergotree-interpreter/src/eval/byte_array_to_long.rs:15-30
export function evalByteArrayToLong(e: ByteArrayToLong, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(16)
  const bytes = extractCollByte(evalExpr(e.input, env, ctx))
  if (bytes.length !== 8) {
    throw new EvalError(`ByteArrayToLong: expected 8 bytes, got ${bytes.length}`,
      'byte-array-to-long-wrong-length')
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 8)
  return { kind: 'Long', value: dv.getBigInt64(0, false) }  // big-endian i64
}

// eval/long-to-byte-array.ts — Pattern A, Fixed(17)
// Source: ergotree-interpreter/src/eval/long_to_byte_array.rs:14-25
export function evalLongToByteArray(e: LongToByteArray, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(17)
  const longV = evalExpr(e.input, env, ctx)
  if (longV.kind !== 'Long') {
    throw new EvalError(`LongToByteArray: expected Long input, got '${longV.kind}'`,
      'predef-input-not-long')
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, longV.value, false)
  return bytesToCollByteSValue(out)
}

// eval/byte-array-to-bigint.ts — Pattern A, Fixed(30)
// Source: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34
// Range: i256 = [-2^255, 2^255 - 1]. Empty input throws; length cap is NOT 32 (33+ byte
// inputs whose decoded value falls in-range still succeed — sigma-rust matches).
export function evalByteArrayToBigInt(e: ByteArrayToBigInt, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(30)
  const bytes = extractCollByte(evalExpr(e.input, env, ctx))
  if (bytes.length === 0) {
    throw new EvalError('ByteArrayToBigInt: byte array is empty', 'byte-array-to-bigint-empty')
  }
  const value = signedBeBytesToBigInt(bytes)  // pure-bigint helper, no @noble call
  if (value < I256_MIN || value > I256_MAX) {
    throw new EvalError(`ByteArrayToBigInt: decoded value out of i256 range`,
      'byte-array-to-bigint-out-of-range')
  }
  return { kind: 'BigInt', value }
}

// eval/xor.ts — Pattern B
// Source: ergotree-interpreter/src/eval/xor.rs (cost 10, 2, 128)
// Evaluate LEFT first, then RIGHT, then cost. Order matters when both inputs throw.
export function evalXor(e: Xor, env: Env, ctx: EvalContext): SValue {
  const l = extractCollByte(evalExpr(e.left, env, ctx))
  const r = extractCollByte(evalExpr(e.right, env, ctx))
  if (l.length !== r.length) {
    throw new EvalError(`Xor: length mismatch (${l.length} vs ${r.length})`,
      'xor-length-mismatch')
  }
  ctx.addPerItemCost(10, 2, 128, l.length)
  const out = new Uint8Array(l.length)
  for (let i = 0; i < l.length; i++) out[i] = l[i]! ^ r[i]!
  return bytesToCollByteSValue(out)
}
```

### `SubstConstants` — consensus-critical bytes-in / bytes-out

**The most consequential arm in this slice.** It takes a serialized `ErgoTree`, swaps constants at given positions, returns the new serialized bytes. The output bytes go on-chain (callers typically feed them to another contract instance). One byte's divergence from sigma-rust's output is a consensus failure.

```ts
// eval/subst-constants.ts — Pattern B, ~150 LOC
// Source: ergotree-interpreter/src/eval/subst_const.rs:18-89
//         ergotree-ir/src/ergo_tree.rs:45-70 (with_constant)
export function evalSubstConstants(e: SubstConstants, env: Env, ctx: EvalContext): SValue {
  // 1. Evaluate the three child expressions (sigma-rust order: script_bytes, positions, new_values).
  const scriptBytes = extractCollByte(evalExpr(e.scriptBytes, env, ctx))
  const positions = extractCollInt(evalExpr(e.positions, env, ctx))   // i32[]
  const newValuesV = evalExpr(e.newValues, env, ctx)
  if (newValuesV.kind !== 'Coll') {
    throw new EvalError('SubstConstants: new_values must be Coll[T]', 'subst-constants-error')
  }

  // 2. Length match (sigma-rust subst_const.rs:49-55).
  if (positions.length !== newValuesV.items.length) {
    throw new EvalError(
      `SubstConstants: positions.length (${positions.length}) !== new_values.length (${newValuesV.items.length})`,
      'subst-constants-error'
    )
  }

  // 3. Parse the embedded tree. Reuses our wire-format machinery — same parser,
  //    same MAX_TREE_SIZE bound. Any wire-layer error is re-thrown under the
  //    eval-side code 'subst-constants-error' (compact taxonomy per 2g.5).
  let tree: ErgoTree
  try { tree = parseTree(scriptBytes) }
  catch (cause) {
    throw new EvalError(`SubstConstants: bad template bytes — ${(cause as Error).message}`,
      'subst-constants-error')
  }

  // 4. Cost charged here — AFTER parse, BEFORE substitution loop. Sized by the
  //    template's constants_len, NOT positions.length (sigma-rust bug-3 regression
  //    test asserts this — subst_const.rs:221-283).
  ctx.addPerItemCost(100, 100, 1, tree.constants.length)

  // 5. Substitute. Validate each: position in bounds + new SType matches original.
  //    Defensive deep copy — never mutate the input tree's arrays.
  const newConstants = [...tree.constants]
  // constantTypes is unchanged because with_constant enforces type-equality.
  for (let ix = 0; ix < positions.length; ix++) {
    const i = positions[ix]!
    if (i < 0 || i >= tree.constants.length) {
      throw new EvalError(
        `SubstConstants: positions[${ix}] = ${i} out of bounds (constants.length = ${tree.constants.length})`,
        'subst-constants-error'
      )
    }
    // new_values: Coll[T] is homogeneous — its element type is newValuesV.elem.
    // Sigma-rust compares constant.tpe == old_constant.tpe (ergo_tree.rs:51).
    if (!sTypeEquals(newValuesV.elem, tree.constantTypes[i]!)) {
      throw new EvalError(
        `SubstConstants: type mismatch at position ${i} — expected ${stypeToString(tree.constantTypes[i]!)}, got ${stypeToString(newValuesV.elem)}`,
        'subst-constants-error'
      )
    }
    newConstants[i] = newValuesV.items[ix]!
  }

  // 6. Re-serialize. Output byte-equality with sigma-rust is GUARANTEED by our
  //    existing wire round-trip property (validated on 255 corpus fixtures +
  //    6,221 parse-mutation tests). Only the constants section differs from input.
  const newTree: ErgoTree = { ...tree, constants: newConstants }
  return bytesToCollByteSValue(serializeTree(newTree))
}
```

**Why reuse `parseTree` / `serializeTree`, not byte-surgical substitution.** Sigma-rust does the same: parse → modify constants → re-serialize (`subst_const.rs:59`, `subst_const.rs:80`). Byte-surgical substitution would require maintaining a parallel byte-level constants writer — duplicating logic, doubling the consensus surface, and creating a maintenance burden when wire-format details evolve (e.g. the `treeVersion` parameter threading in phase 2h-c.1). The full round-trip approach inherits all of phase 2a's mutation-tested correctness for free.

**Edge case — `constantSegregation === false` trees.** When the input tree has no constants section, `tree.constants.length === 0`, so any position is out-of-range. Sigma-rust matches: `with_constant(i, …)` returns `OutOfBounds` (`ergo_tree.rs:63-68`). Our handler throws `'subst-constants-error'` with `position-out-of-range` in the message. A fixture covers this case.

**Edge case — `newValuesV.items.length === 0`.** A no-op substitution. Sigma-rust: empty positions + empty new_values both check out, the loop runs zero iterations, and the tree is re-serialized unchanged. The cost is still charged based on `template.constants.length` (the template walk fires regardless). Our handler matches.

### Wiring into `eval.ts`

The 8 new arms are added to the central `evalExpr` switch in `packages/ergoscript/src/eval/eval.ts`. Each case is a single-line dispatch to the per-arm handler.

```ts
// Existing 52 cases unchanged...
case 'CalcBlake2b256':   return evalCalcBlake2b256(e, env, ctx)
case 'CalcSha256':       return evalCalcSha256(e, env, ctx)
case 'ByteArrayToLong':  return evalByteArrayToLong(e, env, ctx)
case 'LongToByteArray':  return evalLongToByteArray(e, env, ctx)
case 'ByteArrayToBigInt': return evalByteArrayToBigInt(e, env, ctx)
case 'Xor':              return evalXor(e, env, ctx)
case 'DecodePoint':      return evalDecodePoint(e, env, ctx)
case 'SubstConstants':   return evalSubstConstants(e, env, ctx)
```

The `_exhaust: never` discriminant at the end of the switch ensures any newly added `Expr` tag without a corresponding arm becomes a compile-time error.

### Helpers (small additions)

- `extractCollInt(v: SValue): number[]` — new helper in `eval/_coll-helpers.ts`. Throws `'coll-input-not-coll'` on non-Coll; throws a new `'coll-elem-not-int'` if elements aren't `SInt`. Used by `SubstConstants` for the positions Coll[Int].
- `signedBeBytesToBigInt(bytes: Uint8Array): bigint` — new helper in `eval/_byte-coll.ts` (existing file). Pure-bigint signed BE decode; no `@noble` call.
- `I256_MIN`, `I256_MAX` constants — in `eval/_byte-coll.ts`. `I256_MIN = -(1n << 255n)`, `I256_MAX = (1n << 255n) - 1n`.

`extractCollByte` and `bytesToCollByteSValue` already exist in `eval/_byte-coll.ts` and `eval/_coll-helpers.ts` respectively; reused.

## Error taxonomy

**6 new `EvalError` codes (48 → 54):**

| Code | Thrown by | Mirrors sigma-rust |
|---|---|---|
| `'predef-input-not-byte-array'` | calc-blake / calc-sha / byte-array-to-long / byte-array-to-bigint / xor / decode-point when input isn't `Coll[Byte]` | Generic `UnexpectedValue` |
| `'predef-input-not-long'` | long-to-byte-array when input isn't `Long` | Generic `UnexpectedValue` |
| `'decode-point-invalid'` | DecodePoint on off-curve / wrong-length / malformed bytes | `Misc("DecodePoint: Failed to parse EC point…")` |
| `'byte-array-to-long-wrong-length'` | ByteArrayToLong when bytes.length !== 8 | `UnexpectedValue("Input size 8 is expected…")` |
| `'byte-array-to-bigint-empty'` | ByteArrayToBigInt on empty input | `UnexpectedValue("byte array is empty")` |
| `'byte-array-to-bigint-out-of-range'` | ByteArrayToBigInt when decoded value falls outside i256 | `UnexpectedValue("input array out of bounds")` |
| `'xor-length-mismatch'` | Xor when operand byte arrays differ in length | `UnexpectedValue("XOR length mismatch…")` |
| `'subst-constants-error'` | SubstConstants — single compact code covering 6 throw paths: bad template bytes, new_values not Coll, positions/new_values length mismatch, position out of range, type mismatch | 6 distinct `Misc(...)` errors in sigma-rust |

Wait — that's 8 codes, not 6. Recount:

1. `'predef-input-not-byte-array'`
2. `'predef-input-not-long'`
3. `'decode-point-invalid'`
4. `'byte-array-to-long-wrong-length'`
5. `'byte-array-to-bigint-empty'`
6. `'byte-array-to-bigint-out-of-range'`
7. `'xor-length-mismatch'`
8. `'subst-constants-error'`

Plus a new helper code:
9. `'coll-elem-not-int'` — `extractCollInt` helper, when the Coll's elements aren't `SInt`. Could be merged into `'coll-elem-tpe-mismatch'` (existing) per the compact-taxonomy principle.

**Decision:** merge `'coll-elem-not-int'` into the existing `'coll-elem-tpe-mismatch'`. Result: **8 new codes (48 → 56).**

This is more than the original Section 2 estimate of 6. The growth comes from:
- Splitting `'byte-array-to-bigint-empty'` out from `'out-of-range'` because sigma-rust treats them as structurally distinct (one is a precondition, the other a postcondition).
- Adding `'predef-input-not-long'` for the LongToByteArray input check (`'predef-input-not-byte-array'` doesn't fit semantically).

Note: existing codes are reused where the dispatch is identical to a previous use:
- `'coll-elem-tpe-mismatch'` — extends to cover `extractCollInt`'s non-SInt case.
- No re-use of method-call-related codes — these are top-level `Expr` arms.

## Test strategy

### Layer mapping

| Layer | What | Where | Pass criterion |
|---|---|---|---|
| **C1 — per-arm fixture validation** | Each arm against sigma-rust `try_eval_out` oracle (value + cost) | `packages/ergoscript/test/eval/<arm>.test.ts` (8 new files) | Byte-equal value + cost-integer-equal under `node` + `jsdom` |
| **C2 — corpus regression gate** | The 18-evaluable-tree mainnet corpus | `test/corpus-eval.test.ts` (unchanged file) | Hard gate stays at `evalSuccess === 18`. May rise if any of the 18 trees touched a predef arm via `'not-implemented-yet'`. Re-baseline if so. |
| **C3.a — operator-driven mutation** | Per-arm single-byte mutation tests | `test/eval-mutation/<arm>.test.ts` | ≥ 90% kill rate per arm (target — aggregate accepted for hard-to-kill regions per phase 2f Coll HOF precedent) |

### Fixture-gen structure

```
fixture-gen/src/cmds/ergoscript/eval/
├── decode_point.rs              ← 6 scenarios
├── subst_constants.rs           ← 13 scenarios (consensus-critical)
├── calc_blake2b256.rs           ← 7 scenarios
├── calc_sha256.rs               ← 7 scenarios
├── byte_array_to_long.rs        ← 8 scenarios
├── byte_array_to_bigint.rs      ← 10 scenarios (range-edge heavy)
├── long_to_byte_array.rs        ← 7 scenarios
└── xor.rs                       ← 7 scenarios
```

### Per-arm fixture matrix

| Arm | Happy | Edge | Throw | Total |
|---|---|---|---|---|
| `DecodePoint` | generator, random EcPoint, identity | wrong-length (32 bytes; 34 bytes) | off-curve, non-Coll[Byte] | 6 |
| `SubstConstants` ★ | single substitution, 3-substitution, identity reorder (positions=[2,0,1]), empty positions | template with 0 constants (segregation false), template with mixed types substituted | bad template bytes (malformed VLQ), position-out-of-range, type-mismatch, positions/values length mismatch, non-Coll new_values | 13 |
| `CalcBlake2b256` | empty input, 1-byte, 64-byte, 1024-byte, mainnet-shape | hash-of-hash chain | non-Coll[Byte] | 7 |
| `CalcSha256` | empty input, 1-byte, 64-byte, 1024-byte, NIST test vector | hash-of-hash chain | non-Coll[Byte] | 7 |
| `ByteArrayToLong` | +1, -1, 0, i64::MAX, i64::MIN | high-bit-set, roundtrip with LongToByteArray | length 0, length 7, length 9 | 8 |
| `ByteArrayToBigInt` | small +/-, 32-byte i256 MAX, 32-byte i256 MIN, 1-byte 0xFF (= -1), 2-byte 0xFFFF (= -1) | exact 32-byte boundary, 33-byte in-range, all-zero | 33-byte just-above-MAX, 33-byte just-below-MIN, empty, non-Coll[Byte] | 10 |
| `LongToByteArray` | +1, -1, 0, i64::MAX, i64::MIN | roundtrip with ByteArrayToLong | non-Long input | 7 |
| `Xor` | empty (zero-length), 32-byte, identical (→ all-zero), inverse (→ all-FF) | 1-byte, asymmetric (0x01 ^ 0xFF) | length mismatch, non-Coll[Byte] | 7 |
| **Total** | — | — | — | **65 fixtures** |

★ `SubstConstants` fixtures are consensus-critical. Each substitution scenario asserts the post-substitution bytes are byte-identical to what `ErgoTree::sigma_serialize_bytes` produces in Rust. The "type-mismatch" fixture is intentionally hand-crafted (sigma-rust's typed prover never produces such a tree) — synthesized via direct `Expr::SubstConstants {…}` construction at fixture-gen time.

### Mutation testing approach (Layer C3.a)

- Reuse the existing TS mutation harness (`test/eval-mutation/_harness.ts`, consolidated in phase 2h-e).
- One mutation scenario per `(fixture, arm)` pair; mutations limited to the fixture's relevant byte region (e.g. `Xor` mutates only the operand bytes; `SubstConstants` has 3 separate mutation scenarios — new_values bytes, positions bytes, embedded template bytes).
- Kill threshold ≥ 90% per arm; aggregate ≥ 90% if a single arm dips below (mirrors phase 2f Coll HOF precedent).

### Expected test count delta

- ergoscript: 2922 → ~3170 (+~248).
- Total: 3500 → ~3748.
- Fixtures: ~65 new oracle fixtures + matching mutation scenarios.
- LOC: ~700-900 new source LOC (handlers); ~1200-1500 new test LOC; ~1500-2000 new fixture-gen Rust LOC.

## Source mapping to sigma-rust

Pinned at sigma-rust branch `integration/ergots` at `~/projects/ergots/external/sigma-rust/`.

| Rust function / type (file) | TS function (file) | Cost pattern | Notes |
|---|---|---|---|
| `ergotree-interpreter/src/eval/decode_point.rs:14-30` | `evalDecodePoint` (`eval/decode-point.ts`) | A `Fixed(300)` | `@noble/curves` `Point.fromBytes` mirrors `EcPoint::sigma_parse_bytes` |
| `ergotree-interpreter/src/eval/subst_const.rs:18-89` | `evalSubstConstants` (`eval/subst-constants.ts`) | B `(100, 100, 1, n)` | n = template's `constants.length`, NOT positions.length (subst_const.rs:65; bug-3 regression at :221-283) |
| `ergotree-ir/src/ergo_tree.rs:45-70` | inline in `evalSubstConstants` | — | `with_constant(i, c)` type-check mirrored as `sTypeEquals(newValuesV.elem, tree.constantTypes[i])` |
| `ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34` | `evalCalcBlake2b256` (`eval/calc-blake2b256.ts`) | B `(20, 7, 128, n)` | `@noble/hashes/blake2.js` blake2b-256 |
| `ergotree-interpreter/src/eval/calc_sha256.rs` (analogous) | `evalCalcSha256` (`eval/calc-sha256.ts`) | B `(80, 8, 64, n)` | `@noble/hashes/sha2.js` sha256 |
| `ergotree-interpreter/src/eval/byte_array_to_long.rs:15-30` | `evalByteArrayToLong` (`eval/byte-array-to-long.ts`) | A `Fixed(16)` | DataView `getBigInt64(0, false)` for BE i64 |
| `ergotree-interpreter/src/eval/long_to_byte_array.rs:14-25` | `evalLongToByteArray` (`eval/long-to-byte-array.ts`) | A `Fixed(17)` | DataView `setBigInt64(0, v, false)` for BE i64 |
| `ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34` | `evalByteArrayToBigInt` (`eval/byte-array-to-bigint.ts`) | A `Fixed(30)` | `BigInt256::from_be_slice` mirrored as `signedBeBytesToBigInt` + `[I256_MIN, I256_MAX]` range check |
| `ergotree-interpreter/src/eval/xor.rs` | `evalXor` (`eval/xor.ts`) | B `(10, 2, 128, n)` | Pairwise XOR; length-match precondition |

## Execution order

Each Tn is a TDD red-green cycle: fixture-gen first → RED test → GREEN handler → edge tests → mutation tests. Per-task commit count ≈ 4-5.

```
T1   docs(plan): PLAN.md overwrite with 2i-a execution plan
T2   eval/calc-blake2b256.ts      ← simplest; reuses scorex/@noble/hashes blake2b
T3   eval/calc-sha256.ts          ← same shape; @noble/hashes sha256
T4   eval/byte-array-to-long.ts   ← DataView i64 BE + length check
T5   eval/long-to-byte-array.ts   ← inverse of T4
T6   eval/byte-array-to-bigint.ts ← signed BE decode + i256 range check
T7   eval/xor.ts                  ← pairwise XOR + length match
T8   eval/decode-point.ts         ← @noble/curves Point.fromBytes wrap
T9   eval/subst-constants.ts      ← consensus-critical bytes-in/bytes-out (LAST)
T10  docs: facts/ergoscript-eval.md sweep (coverage 52→60, codes 48→56, changelog entry)
T11  docs: README.md + SESSION_CONTEXT.md + HANDOFF_PROMPT.md sweep + spec → finalized
```

Total: ~36-44 commits expected.

## Risk hotspots

### 1. `SubstConstants` byte-equality (highest risk)

The substituted tree's `serializeTree` output must be bit-identical to sigma-rust's `ErgoTree::sigma_serialize_bytes`. The validating evidence is our existing 255-fixture round-trip property — if `serializeTree(parseTree(b)) === b` holds for every fixture, then `serializeTree(parseTree(b) with constants[i]:=v)` produces a sigma-rust-equivalent tree because only the constants block changes. Belt-and-suspenders: 3+ fixtures in `subst_constants.rs` explicitly capture the post-substitution bytes from `ergo_tree.sigma_serialize_bytes()` and assert byte-equality against our TS output.

**Risks to validate during T9:**

- **Constants section format under `constantSegregation === true`.** Each constant is encoded as `(SType, SValue)`. Our `serializeTree` already handles this for round-trip; substitution preserves the format.
- **`treeVersion`-dependent serialization for SHeader-containing constants.** If a substituted constant is `SHeader`, the V3 gating from phase 2h-c.1 must apply. Test fixture: substitute one constant with an SHeader value in a V3 tree.
- **`hasSize` body-size pre-prefix.** Trees with `hasSize === true` have a VLQ-u32 body-size byte after the header. The body size changes when constants are substituted with values of different encoded sizes (e.g. replacing a 1-byte `SInt(0)` with a 5-byte `SInt(2^30)`). Our `serializeTree` already recomputes the body size — covered by existing round-trip property.

### 2. `ByteArrayToBigInt` range semantics

Sigma-rust uses `BigInt256` (signed 256-bit). Range is `[-2^255, 2^255 - 1]`. Our TS port computes the signed-BE bigint then validates the range. **Critical:** the length cap is NOT 32 — sigma-rust's `from_be_slice` accepts inputs of any length and only rejects when the decoded value falls outside i256.

Test coverage: explicit fixtures for `(33 bytes, in-range)` success and `(33 bytes, just-above-MAX)` failure. Mirrors sigma-rust `byte_array_to_bigint.rs:107-118` (`eval_above_max_bound`).

### 3. `DecodePoint` `@noble/curves` consistency

Our sigma-protocol verifier (`crypto/secp256k1.ts`) already wraps `Point.fromBytes` with an off-curve throw. `DecodePoint` reuses the same wrapper. Open question: does `@noble/curves` reject the **identity point** (all-zero) by default? Need to verify in T8 — sigma-rust accepts identity as a valid EcPoint (`EcPoint::default()` is identity, e.g. used as `powOnetimePk` placeholder for V2+ headers).

If `@noble/curves`'s `Point.fromBytes` rejects identity, we need an explicit identity-byte-check before the call (similar pattern to how `SHeader.powOnetimePk` was handled in phase 2h-c.1).

### 4. `Xor` operand evaluation order

Sigma-rust evals left first, then right, then cost. Order matters when both inputs throw — left's throw fires first. Our handler matches this order (`evalExpr(e.left, ...)` precedes `evalExpr(e.right, ...)`).

### 5. VLQ-Int decode of `positions: Coll[Int]`

Coll[Int] elements are i32 ZigZag-VLQ encoded. Negative positions are theoretically encodable. Our handler rejects any position outside `[0, tree.constants.length)` — sigma-rust does the same via `usize` cast (negative → huge → out-of-bounds).

## Rollback plan

Each arm is independent + bisect-clean. Single-arm revert: `git revert <arm-commit-range>` reverts cleanly without touching others. `eval.ts`'s switch arm for the reverted arm reverts to `'not-implemented-yet'`.

If `SubstConstants` proves consensus-divergent in production: revert T9's commit-range only. Trees containing `SubstConstants` then re-fail with `'not-implemented-yet'` (same as today), no other arm affected.

## Confidence check (OVERRIDES #2 — crypto path)

| Arm | Confidence | Rationale |
|---|---|---|
| `DecodePoint` | ~99% | Thin wrap of existing `@noble/curves` usage; sigma-rust mirror is 13 lines. |
| `SubstConstants` | ~96% | Reuses validated wire round-trip; novelty is type-check on substitution. |
| `CalcBlake2b256` / `CalcSha256` | ~99% | Direct hash; no crypto novelty. |
| `ByteArrayToBigInt` | ~98% | i256 range arithmetic is straightforward bigint compare. Sigma-rust source-checked for length-cap behavior (no cap — only range check). |
| `ByteArrayToLong` / `LongToByteArray` | ~99% | DataView gives exact BE i64; trivial mapping. |
| `Xor` | ~99% | Pairwise XOR; trivial. |

All ≥ 95% — no escalation required per OVERRIDES rule #2.

## Cross-references

- **Predecessor spec:** `docs/specs/2026-05-20-ergoscript-phase-2h-f-tier-3-method-handlers-design.md`
- **Parent / umbrella:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md:70` (Phase 2i — Predefs and oddments)
- **Corpus demand source:** `docs/specs/2026-05-18-task-b-corpus-survey-tally.json`
- **Boundary contract:** `facts/ergoscript-eval.md` (registry + EvalError codes; this spec proposes coverage 52→60, codes 48→56)
- **Wire-format dependency:** `facts/ergoscript-wire.md` — `parseTree` / `serializeTree` reused by `SubstConstants`
- **Sigma-rust source:** `~/projects/ergots/external/sigma-rust/`, branch `integration/ergots`
- **Memory:** `[[feedback-pre-v1-coverage-not-load-bearing]]`, `[[feedback-focused-specs]]`, `[[feedback-review-by-default]]`, `[[reference-source-first-discipline]]`
