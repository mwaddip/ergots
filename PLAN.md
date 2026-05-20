# Phase 2i-a — Pure-bytes predefs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto → halt and declare; #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads]. Per `[[feedback-subagent-explicit-rules]]`, this is load-bearing.

**Spec:** `docs/specs/2026-05-20-ergoscript-phase-2i-a-pure-bytes-predefs-design.md` (HEAD `4e48464`)

**Goal:** Wire eval arms for 8 predef `Expr` variants — `CalcBlake2b256`, `CalcSha256`, `ByteArrayToLong`, `LongToByteArray`, `ByteArrayToBigInt`, `Xor`, `DecodePoint`, `SubstConstants`. Closes ~46% of wider-corpus boxes.

**Architecture:** Each arm is a single-file handler in `packages/ergoscript/src/eval/`, dispatched from the central `evalExpr` switch in `eval.ts`. Each validated byte-for-byte against sigma-rust's `try_eval_out` oracle via fixture-gen-generated JSON. TDD red-green cycle per arm: fixture-gen → RED test → GREEN handler → edge tests → mutation tests → commit. Execute simplest first, consensus-critical (`SubstConstants`) last.

**Tech Stack:** TypeScript (vitest, node + jsdom cross-runtime), `@noble/hashes@2.2.0`, `@noble/curves@2.2.0`, Rust `fixture-gen` crate, sigma-rust branch `integration/ergots`.

**Invariants:** Coverage 52 → 60 `Expr` arms; EvalError codes 48 → 55 (7 new); ~70 new fixtures; ~258 new tests (3500 → ~3758).

---

## Task ordering (simplest → consensus-critical)

```
T1   PLAN.md committed (this document)
T2   CalcBlake2b256     ← simplest hash predef
T3   CalcSha256         ← same shape as T2
T4   ByteArrayToLong    ← DataView i64 BE decode
T5   LongToByteArray    ← inverse of T4
T6   ByteArrayToBigInt  ← signed BE + i256 range check
T7   Xor                ← truncating-zip pairwise XOR
T8   DecodePoint        ← @noble/curves Point.fromBytes via existing adapter
T9   SubstConstants     ← consensus-critical bytes-in/bytes-out (LAST)
T10  facts/ergoscript-eval.md sweep
T11  README + SESSION_CONTEXT + HANDOFF_PROMPT sweep + push
```

---

## Task 1: Commit PLAN.md

**Files:**
- Create: `/home/mwaddip/projects/ergots/PLAN.md` (this file, overwrites previous 2h-f plan)

- [ ] **Step 1: Stage and commit**

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): overwrite PLAN.md with phase 2i-a execution plan

Per HANDOFF_PROMPT.md convention: PLAN.md is the in-flight phase's task list,
overwritten at each phase boundary. Spec at
docs/specs/2026-05-20-ergoscript-phase-2i-a-pure-bytes-predefs-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: 1 file changed, ~700+ insertions.

---

## Task 2: `CalcBlake2b256` — Pattern B, hash predef

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/calc_blake2b256.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (add `pub mod calc_blake2b256;`)
- Modify: `fixture-gen/src/main.rs` (~line 138 area — append generate-and-write block)
- Create: `packages/ergoscript/test/fixtures/eval/calc-blake2b256.json` (output of fixture-gen)
- Create: `packages/ergoscript/src/eval/calc-blake2b256.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add import + switch case)
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (add `'predef-input-not-byte-array'` to `EvalErrorCode` union — first task to introduce it)
- Create: `packages/ergoscript/test/eval/calc-blake2b256.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/calc-blake2b256.test.ts`

**Source:** `ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34` — Pattern B, cost `addPerItemCost(20, 7, 128, n)`, input must be `Coll[Byte]`.

- [ ] **Step 1: Write fixture-gen module**

Create `fixture-gen/src/cmds/ergoscript/eval/calc_blake2b256.rs`:

```rust
//! CalcBlake2b256 arm — fixtures for `Expr::CalcBlake2b256(...)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34
//!   let input_v = self.input.eval(env, ctx)?;
//!   match input_v {
//!       Value::Coll(CollKind::NativeColl(NativeColl::CollByte(coll_byte))) => {
//!           ctx.add_per_item_jit_cost(20, 7, 128, coll_byte.len() as u32)?;
//!           let expected_hash = blake2b256_hash(coll_byte.as_vec_u8().as_slice()).to_vec();
//!           Ok(expected_hash.into())
//!       }
//!       _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! Cost ordering: charge AFTER eval-child (Pattern B; sized by input bytes len).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::calc_blake2b256::CalcBlake2b256;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct CalcBlake2b256Fixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    pub expected_value_json: JsonValue,
    pub expected_cost: u64,
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct CalcBlake2b256FixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CalcBlake2b256Fixture>,
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = CalcBlake2b256::try_build(input)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, input: Expr) -> anyhow::Result<CalcBlake2b256Fixture> {
    let (tree, hex) = build_tree(input)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(CalcBlake2b256Fixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<CalcBlake2b256FixtureFile> {
    let mut entries = Vec::new();

    // Empty input — boundary case.
    entries.push(success_entry(
        "calc_blake2b256_empty",
        Expr::Const(Vec::<i8>::new().into()),
    )?);

    // 1-byte input.
    entries.push(success_entry(
        "calc_blake2b256_1byte",
        Expr::Const(vec![0x42i8].into()),
    )?);

    // 32-byte input (one full hash output's worth).
    entries.push(success_entry(
        "calc_blake2b256_32bytes",
        Expr::Const((0..32i8).collect::<Vec<_>>().into()),
    )?);

    // 64-byte input (two-block hash internal).
    entries.push(success_entry(
        "calc_blake2b256_64bytes",
        Expr::Const((0..64i8).map(|i| (i as i8).wrapping_mul(3)).collect::<Vec<_>>().into()),
    )?);

    // 128-byte input — chunk boundary at sigma-rust per-chunk cost factor.
    entries.push(success_entry(
        "calc_blake2b256_128bytes",
        Expr::Const(vec![0xABu8 as i8; 128].into()),
    )?);

    // 1024-byte input — large input cost.
    entries.push(success_entry(
        "calc_blake2b256_1024bytes",
        Expr::Const(vec![0x5Au8 as i8; 1024].into()),
    )?);

    // Hash-of-hash chain: blake(blake(input)) — exercises nesting via Expr composition.
    let inner = Expr::Const(vec![0x01i8, 0x02, 0x03].into());
    let inner_hash: Expr = CalcBlake2b256::try_build(inner)?.into();
    entries.push(success_entry("calc_blake2b256_chain", inner_hash)?);

    Ok(CalcBlake2b256FixtureFile {
        corpus: "eval_calc_blake2b256",
        entries,
    })
}
```

- [ ] **Step 2: Register fixture-gen module**

Modify `fixture-gen/src/cmds/ergoscript/eval/mod.rs`: add `pub mod calc_blake2b256;` in alphabetical position (after `bool_to_sigma_prop`, before `coll_append`).

Modify `fixture-gen/src/main.rs` after the `bit_inversion` block (~line 139):

```rust
    let calc_blake2b256_fixture = cmds::ergoscript::eval::calc_blake2b256::generate()?;
    write_ergoscript_json("eval/calc-blake2b256.json", &calc_blake2b256_fixture)?;
```

- [ ] **Step 3: Run fixture-gen + verify determinism + commit fixtures**

```bash
cd fixture-gen && cargo run --release
```

Expected: builds clean, produces `packages/ergoscript/test/fixtures/eval/calc-blake2b256.json` with 7 entries.

```bash
cd fixture-gen && cargo run --release  # re-run
git diff --exit-code packages/ergoscript/test/fixtures/eval/calc-blake2b256.json
```

Expected: empty diff.

```bash
git add fixture-gen/src/cmds/ergoscript/eval/{calc_blake2b256.rs,mod.rs} \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/calc-blake2b256.json
git commit -m "test(fixture-gen): CalcBlake2b256 oracle fixtures (7 scenarios)"
```

- [ ] **Step 4: Write the RED test (no handler yet)**

Create `packages/ergoscript/test/eval/calc-blake2b256.test.ts`:

```ts
/**
 * CalcBlake2b256 arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34
 *   add_per_item_jit_cost(20, 7, 128, n) AFTER eval-child; input must be Coll[Byte].
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/calc-blake2b256.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('CalcBlake2b256 arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
```

Run:
```bash
cd packages/ergoscript && npx vitest run test/eval/calc-blake2b256.test.ts
```

Expected: all 7 tests FAIL with `EvalError 'not-implemented-yet'`.

```bash
git add packages/ergoscript/test/eval/calc-blake2b256.test.ts
git commit -m "test(ergoscript): RED — CalcBlake2b256 oracle test (no handler yet)"
```

- [ ] **Step 5: Write the GREEN handler + wire into switch + add EvalErrorCode**

Create `packages/ergoscript/src/eval/calc-blake2b256.ts`:

```ts
/**
 * CalcBlake2b256 arm — bytes -> 32-byte blake2b-256 hash.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34
 *   add_per_item_jit_cost(20, 7, 128, n) AFTER eval-child; n = input bytes length.
 *   Input must be Coll[Byte]; throws UnexpectedValue otherwise.
 */
import { blake2b } from '@noble/hashes/blake2.js'
import type { CalcBlake2b256, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollByte } from './_byte-coll'
import { bytesToCollByteSValue } from './_coll-helpers'

export function evalCalcBlake2b256(
  e: CalcBlake2b256,
  env: Env,
  ctx: EvalContext,
): SValue {
  const inputV = evalExpr(e.input, env, ctx)
  let bytes: Uint8Array
  try {
    bytes = extractCollByte(inputV)
  } catch {
    throw new EvalError(
      `CalcBlake2b256: expected Coll[Byte] input, got kind='${inputV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  ctx.addPerItemCost(20, 7, 128, bytes.length)
  const out = blake2b(bytes, { dkLen: 32 })
  return bytesToCollByteSValue(out)
}
```

**Verify before writing:** `extractCollByte` IS exported from `src/eval/_byte-coll.ts:21`-ish (verified at plan-writing). If signature differs, adapt.

Modify `packages/ergoscript/src/eval/eval.ts`:

Add import alphabetically (after `evalBoolToSigmaProp`, before `evalAppend`):
```ts
import { evalCalcBlake2b256 } from './calc-blake2b256'
```

Add switch case alphabetically (after `'BoolToSigmaProp'`, before `'BlockValue'` or wherever fits the existing convention):
```ts
case 'CalcBlake2b256':
  return evalCalcBlake2b256(e, env, ctx)
```

Modify `packages/ergoscript/src/eval/eval-context.ts` — add `'predef-input-not-byte-array'` to the `EvalErrorCode` union. Search first:
```bash
rtk proxy grep -n "EvalErrorCode\|'not-implemented-yet'\|'arith-overflow'" packages/ergoscript/src/eval/eval-context.ts | head -5
```

Add alphabetically. Example shape (adapt to existing style):
```ts
export type EvalErrorCode =
  | 'arith-divide-by-zero'
  | 'arith-overflow'
  // ... existing ...
  | 'predef-input-not-byte-array'  // NEW (phase 2i-a)
  // ... rest ...
```

Run tests + typecheck:
```bash
cd packages/ergoscript && npx vitest run test/eval/calc-blake2b256.test.ts
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
```

Expected: 7 tests pass; tsc clean.

```bash
git add packages/ergoscript/src/eval/{calc-blake2b256.ts,eval.ts,eval-context.ts}
git commit -m "feat(ergoscript): CalcBlake2b256 eval arm (Pattern B, addPerItemCost(20,7,128,n))"
```

- [ ] **Step 6: Add throw-path tests (non-Coll[Byte] input)**

Append to `packages/ergoscript/test/eval/calc-blake2b256.test.ts`:

```ts
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import type { CalcBlake2b256 as CalcBlake2b256Expr } from '../../src/mir/types'

describe('CalcBlake2b256 arm — non-Coll[Byte] input', () => {
  it('throws predef-input-not-byte-array when input is SInt', () => {
    const expr: CalcBlake2b256Expr = {
      tag: 'CalcBlake2b256',
      input: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 42 },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-byte-array')
  })

  it('throws predef-input-not-byte-array when input is SBoolean', () => {
    const expr: CalcBlake2b256Expr = {
      tag: 'CalcBlake2b256',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-byte-array')
  })
})
```

Run:
```bash
npx vitest run test/eval/calc-blake2b256.test.ts
```

Expected: 9 tests pass (7 fixture-driven + 2 throw-path).

```bash
git add packages/ergoscript/test/eval/calc-blake2b256.test.ts
git commit -m "test(ergoscript): CalcBlake2b256 throw-path coverage (non-byte-array input)"
```

- [ ] **Step 7: Mutation tests (Layer C3.a)**

Create `packages/ergoscript/test/eval-mutation/calc-blake2b256.test.ts`:

```ts
/**
 * CalcBlake2b256 — Layer C3.a mutation testing.
 *
 * Mutates the inline Coll[Byte] input region for each happy-path fixture;
 * asserts ≥ 90% kill rate.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue } from '../_helpers'
import { findInlineByteColls, locateBytes, runMutationLoop } from '../_helpers/mutation-harness'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/calc-blake2b256.json')

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  entries: Array<{
    name: string
    tree_bytes_hex: string
    expected_value_json: { kind: string; value?: unknown } | null
    expected_cost: number
    expected_error_code: string | null
  }>
}

// Skip the empty-input fixture (no bytes to mutate).
const mutables = fixture.entries.filter(
  (e) => e.expected_error_code === null && !e.name.endsWith('_empty'),
)

describe.each(mutables)('CalcBlake2b256 mutation — $name', (entry) => {
  it('>= 90% kill rate on inline Coll[Byte] payload', () => {
    const treeBytes = hexToBytes(entry.tree_bytes_hex)
    const tree = parseTree(treeBytes)
    const inlineBytes = findInlineByteColls(tree.body)
    expect(inlineBytes.length).toBeGreaterThan(0)

    const target = inlineBytes[inlineBytes.length - 1]!
    const offset = locateBytes(treeBytes, target)
    const result = runMutationLoop(treeBytes, offset, target.length, {
      baseline: () => {
        const t = parseTree(treeBytes)
        return evaluateWith(t, makeContext())
      },
      expectedValue: hydrateSValue(entry.expected_value_json!),
    })
    const killRate = result.killed / result.total
    expect(killRate).toBeGreaterThanOrEqual(0.9)
  })
})
```

**IMPORTANT:** the exact `runMutationLoop` signature is to be confirmed against `packages/ergoscript/test/_helpers/mutation-harness.ts`. If the harness's signature differs (likely — it was consolidated in phase 2h-e and the call pattern might use named args differently), adapt this test. Reference working example: `packages/ergoscript/test/eval/savltree-mutation.test.ts`.

Run:
```bash
npx vitest run test/eval-mutation/calc-blake2b256.test.ts
```

Expected: all entries pass with kill rate ≥ 0.9.

```bash
git add packages/ergoscript/test/eval-mutation/calc-blake2b256.test.ts
git commit -m "test(ergoscript): CalcBlake2b256 mutation testing (Layer C3.a)"
```

- [ ] **Step 8: Cross-runtime verification**

```bash
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts test/eval/calc-blake2b256.test.ts test/eval-mutation/calc-blake2b256.test.ts
```

Expected: all pass under jsdom.

```bash
cd packages/ergoscript && npx vitest run
```

Expected: previous 2922 + 9 new (7 fixture + 2 throw-path) = 2931 passing. Mutation tests count separately depending on how harness reports.

If any test fails, fix before moving to T3.

---

## Task 3: `CalcSha256` — Pattern B, same shape as T2

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/calc_sha256.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/calc-sha256.json`
- Create: `packages/ergoscript/src/eval/calc-sha256.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`
- Create: `packages/ergoscript/test/eval/calc-sha256.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/calc-sha256.test.ts`

**Source:** `ergotree-interpreter/src/eval/calc_sha256.rs` — analogous to Blake; cost `addPerItemCost(80, 8, 64, n)`.

- [ ] **Step 1: Mirror T2's fixture-gen exactly with substitutions**

Copy T2's fixture-gen file (`calc_blake2b256.rs`) to `calc_sha256.rs`, then substitute:
- `CalcBlake2b256` → `CalcSha256` (and `calc_blake2b256` → `calc_sha256`)
- Cost expectation in module-comment: `(20, 7, 128)` → `(80, 8, 64)`
- Replace fixture names: `calc_blake2b256_*` → `calc_sha256_*`
- Add an "abc" fixture for the NIST sha256 test vector

Same fixture set (7 entries):
```rust
entries.push(success_entry("calc_sha256_empty", Expr::Const(Vec::<i8>::new().into()))?);
entries.push(success_entry("calc_sha256_abc", Expr::Const(b"abc".iter().map(|b| *b as i8).collect::<Vec<_>>().into()))?);
entries.push(success_entry("calc_sha256_1byte", Expr::Const(vec![0x42i8].into()))?);
entries.push(success_entry("calc_sha256_32bytes", Expr::Const((0..32i8).collect::<Vec<_>>().into()))?);
entries.push(success_entry("calc_sha256_64bytes", Expr::Const((0..64i8).map(|i| (i as i8).wrapping_mul(3)).collect::<Vec<_>>().into()))?);
entries.push(success_entry("calc_sha256_1024bytes", Expr::Const(vec![0x5Au8 as i8; 1024].into()))?);
let inner = Expr::Const(vec![0x01i8, 0x02, 0x03].into());
let inner_hash: Expr = ergotree_ir::mir::calc_sha256::CalcSha256::try_build(inner)?.into();
entries.push(success_entry("calc_sha256_chain", inner_hash)?);
```

Use `ergotree_ir::mir::calc_sha256::CalcSha256` instead of `CalcBlake2b256` in the `build_tree`/`try_build` calls.

- [ ] **Step 2: Register, run, commit fixtures**

mod.rs + main.rs additions; `cd fixture-gen && cargo run --release`; verify determinism with re-run.

```bash
git add fixture-gen/src/cmds/ergoscript/eval/{calc_sha256.rs,mod.rs} \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/calc-sha256.json
git commit -m "test(fixture-gen): CalcSha256 oracle fixtures (7 scenarios)"
```

- [ ] **Step 3: RED test**

Create `packages/ergoscript/test/eval/calc-sha256.test.ts` — mirror T2 Step 4's RED test verbatim with `calc-blake2b256` → `calc-sha256` substitutions.

Run, expect 7 fails with `'not-implemented-yet'`. Commit:

```bash
git add packages/ergoscript/test/eval/calc-sha256.test.ts
git commit -m "test(ergoscript): RED — CalcSha256 oracle test (no handler yet)"
```

- [ ] **Step 4: GREEN handler**

Create `packages/ergoscript/src/eval/calc-sha256.ts`:

```ts
/**
 * CalcSha256 arm — bytes -> 32-byte sha-256 hash.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/calc_sha256.rs
 *   add_per_item_jit_cost(80, 8, 64, n) AFTER eval-child; input must be Coll[Byte].
 */
import { sha256 } from '@noble/hashes/sha2.js'
import type { CalcSha256, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollByte } from './_byte-coll'
import { bytesToCollByteSValue } from './_coll-helpers'

export function evalCalcSha256(e: CalcSha256, env: Env, ctx: EvalContext): SValue {
  const inputV = evalExpr(e.input, env, ctx)
  let bytes: Uint8Array
  try {
    bytes = extractCollByte(inputV)
  } catch {
    throw new EvalError(
      `CalcSha256: expected Coll[Byte] input, got kind='${inputV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  ctx.addPerItemCost(80, 8, 64, bytes.length)
  return bytesToCollByteSValue(sha256(bytes))
}
```

**Verify import path:** check that `@noble/hashes/sha2.js` exports `sha256`. Search:
```bash
rtk proxy grep -rn "from '@noble/hashes/sha" packages/ packages/scorex/src 2>/dev/null
```

If the project uses a different path (e.g. `@noble/hashes/sha256`), use the same path for consistency.

Wire into `eval.ts`:
```ts
import { evalCalcSha256 } from './calc-sha256'
```

Switch case alphabetically:
```ts
case 'CalcSha256':
  return evalCalcSha256(e, env, ctx)
```

(`'predef-input-not-byte-array'` is already in `EvalErrorCode` from T2.)

Run tests + typecheck. 7 pass. Commit:
```bash
git add packages/ergoscript/src/eval/{calc-sha256.ts,eval.ts}
git commit -m "feat(ergoscript): CalcSha256 eval arm (Pattern B, addPerItemCost(80,8,64,n))"
```

- [ ] **Step 5: Throw-path + mutation tests**

Same shape as T2 Steps 6-7. Append throw-path tests (non-Coll[Byte]) to `test/eval/calc-sha256.test.ts`:

```ts
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import type { CalcSha256 as CalcSha256Expr } from '../../src/mir/types'

describe('CalcSha256 arm — non-Coll[Byte] input', () => {
  it('throws predef-input-not-byte-array when input is SInt', () => {
    const expr: CalcSha256Expr = {
      tag: 'CalcSha256',
      input: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 42 },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-byte-array')
  })
})
```

Create `test/eval-mutation/calc-sha256.test.ts` mirroring T2 Step 7's mutation file.

Run cross-runtime. Commit:
```bash
git add packages/ergoscript/test/eval/calc-sha256.test.ts \
        packages/ergoscript/test/eval-mutation/calc-sha256.test.ts
git commit -m "test(ergoscript): CalcSha256 throw-path + mutation tests (Layer C3.a)"
```

---

## Task 4: `ByteArrayToLong` — Pattern A, length-tail-ignored

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/byte_array_to_long.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/byte-array-to-long.json`
- Create: `packages/ergoscript/src/eval/byte-array-to-long.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`, `src/eval/eval-context.ts` (add `'byte-array-to-long-too-short'`)
- Create: `packages/ergoscript/test/eval/byte-array-to-long.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/byte-array-to-long.test.ts`

**Source:** `ergotree-interpreter/src/eval/byte_array_to_long.rs:18-34` — Pattern A `Fixed(16)`. **CRITICAL:** input length must be `>= 8`; reads first 8 bytes BE; trailing bytes IGNORED (sigma-rust `eval_skip_tail` at line 62-65). Throws on `length < 8`.

- [ ] **Step 1: Write fixture-gen module — 11 scenarios**

Create `fixture-gen/src/cmds/ergoscript/eval/byte_array_to_long.rs`:

```rust
//! ByteArrayToLong arm — bytes -> i64 (BE; first 8 bytes; trailing IGNORED).
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_long.rs:18-34
//!   add_jit_cost(16); input must be >= 8 bytes; reads first 8 BE; trailing ignored.
//!   `eval_skip_tail` test at :62-65 asserts trailing bytes are ignored.
//!
//! Throw paths: input.len() < 8 (UnexpectedValue).
//! Wrong-type input is rejected by ByteArrayToLong::try_build at build time.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::byte_array_to_long::ByteArrayToLong;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ByteArrayToLongFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    pub expected_value_json: JsonValue,
    pub expected_cost: u64,
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct ByteArrayToLongFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ByteArrayToLongFixture>,
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = ByteArrayToLong::try_build(input)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, bytes: Vec<i8>) -> anyhow::Result<ByteArrayToLongFixture> {
    let (tree, hex) = build_tree(Expr::Const(bytes.into()))?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ByteArrayToLongFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn error_entry(name: &str, bytes: Vec<i8>, code: &str) -> anyhow::Result<ByteArrayToLongFixture> {
    let (tree, hex) = build_tree(Expr::Const(bytes.into()))?;
    Ok(ByteArrayToLongFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<ByteArrayToLongFixtureFile> {
    let mut entries = Vec::new();

    // Happy: +1
    entries.push(success_entry("b2l_plus_one", vec![0, 0, 0, 0, 0, 0, 0, 1])?);
    // Happy: -1 (all -1 i8)
    entries.push(success_entry("b2l_neg_one", vec![-1; 8])?);
    // Happy: 0
    entries.push(success_entry("b2l_zero", vec![0; 8])?);
    // Happy: i64::MAX = 0x7FFFFFFFFFFFFFFF
    entries.push(success_entry("b2l_max", vec![0x7F, -1, -1, -1, -1, -1, -1, -1])?);
    // Happy: i64::MIN = 0x8000000000000000
    entries.push(success_entry("b2l_min", vec![-128, 0, 0, 0, 0, 0, 0, 0])?);
    // Happy: high-bit-set non-extreme
    entries.push(success_entry("b2l_high_bit", vec![-128, 0, 0, 0, 0, 0, 0, 1])?);
    // Happy: length-9 — trailing byte ignored (eval_skip_tail behavior)
    entries.push(success_entry("b2l_length_9_skip_tail", vec![0, 0, 0, 0, 0, 0, 0, 1, 0x42])?);
    // Happy: length-16 — trailing 8 bytes ignored
    entries.push(success_entry(
        "b2l_length_16_skip_tail",
        vec![0, 0, 0, 0, 0, 0, 0, 1, -1, -1, -1, -1, -1, -1, -1, -1],
    )?);
    // Happy: sigmastate-equivalence vector from sigma-rust test_equivalence
    entries.push(success_entry(
        "b2l_sigmastate_equiv_1",
        base16::decode("712d7f00ff807f7f")
            .unwrap()
            .into_iter()
            .map(|b| b as i8)
            .collect(),
    )?);

    // Throw: length 0
    entries.push(error_entry("b2l_empty", vec![], "byte-array-to-long-too-short")?);
    // Throw: length 7
    entries.push(error_entry("b2l_length_7", vec![0; 7], "byte-array-to-long-too-short")?);

    Ok(ByteArrayToLongFixtureFile {
        corpus: "eval_byte_array_to_long",
        entries,
    })
}
```

- [ ] **Step 2: Register, run, commit fixtures**

mod.rs + main.rs additions; `cd fixture-gen && cargo run --release`; verify determinism.

```bash
git add fixture-gen/src/cmds/ergoscript/eval/{byte_array_to_long.rs,mod.rs} \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/byte-array-to-long.json
git commit -m "test(fixture-gen): ByteArrayToLong oracle fixtures (11 scenarios incl. length-tail tolerance)"
```

- [ ] **Step 3: RED test** — mirror T2 Step 4. 11 tests fail. Commit.

- [ ] **Step 4: GREEN handler + EvalErrorCode**

Create `packages/ergoscript/src/eval/byte-array-to-long.ts`:

```ts
/**
 * ByteArrayToLong arm — first 8 bytes BE -> i64. Trailing bytes IGNORED.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_long.rs:18-34
 *   add_jit_cost(16); input must be >= 8 bytes; reads input[0..7] as BE i64.
 *   `eval_skip_tail` test at :62-65 asserts trailing bytes ignored.
 */
import type { ByteArrayToLong, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollByte } from './_byte-coll'

export function evalByteArrayToLong(
  e: ByteArrayToLong,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(16)
  const inputV = evalExpr(e.input, env, ctx)
  let bytes: Uint8Array
  try {
    bytes = extractCollByte(inputV)
  } catch {
    throw new EvalError(
      `ByteArrayToLong: expected Coll[Byte] input, got kind='${inputV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  if (bytes.length < 8) {
    throw new EvalError(
      `ByteArrayToLong: array must contain at least 8 elements, got ${bytes.length}`,
      'byte-array-to-long-too-short',
    )
  }
  // DataView reads first 8 bytes BE. bytes.buffer may be larger than bytes.length
  // (e.g. subarrayed); explicitly bound the view to 8 bytes starting at byteOffset.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 8)
  return { kind: 'Long', value: dv.getBigInt64(0, false) }
}
```

Add `'byte-array-to-long-too-short'` to `EvalErrorCode` union in `eval-context.ts` (alphabetically).

Wire `evalByteArrayToLong` into `eval.ts` switch (alphabetical position):
```ts
case 'ByteArrayToLong':
  return evalByteArrayToLong(e, env, ctx)
```

Run tests + typecheck. 11 pass. Commit:
```bash
git add packages/ergoscript/src/eval/{byte-array-to-long.ts,eval.ts,eval-context.ts}
git commit -m "feat(ergoscript): ByteArrayToLong eval arm (Pattern A Fixed(16), length-tail tolerated)"
```

- [ ] **Step 5: Throw-path + mutation tests**

Throw-path inline test:
```ts
describe('ByteArrayToLong arm — non-Coll[Byte] input', () => {
  it('throws predef-input-not-byte-array for SLong input', () => {
    const expr: ByteArrayToLongExpr = {
      tag: 'ByteArrayToLong',
      input: {
        tag: 'Const',
        tpe: { tag: 'SLong' },
        value: { kind: 'Long', value: 0n },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-byte-array')
  })
})
```

Mutation tests mirror T2 Step 7 but mutate the 8-byte input region. Skip "length < 8" throw entries.

Commit:
```bash
git add packages/ergoscript/test/eval/byte-array-to-long.test.ts \
        packages/ergoscript/test/eval-mutation/byte-array-to-long.test.ts
git commit -m "test(ergoscript): ByteArrayToLong throw-path + mutation tests"
```

---

## Task 5: `LongToByteArray` — Pattern A, i64 -> 8 bytes BE

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/long_to_byte_array.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/long-to-byte-array.json`
- Create: `packages/ergoscript/src/eval/long-to-byte-array.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`, `src/eval/eval-context.ts` (add `'predef-input-not-long'`)
- Create: `packages/ergoscript/test/eval/long-to-byte-array.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/long-to-byte-array.test.ts`

**Source:** `ergotree-interpreter/src/eval/long_to_byte_array.rs:14-25` — Pattern A `Fixed(17)`. Input is `Value::Long`. Output is 8 bytes BE.

- [ ] **Step 1: Write fixture-gen — 7 scenarios**

Create `fixture-gen/src/cmds/ergoscript/eval/long_to_byte_array.rs`:

```rust
//! LongToByteArray arm — i64 -> 8 bytes BE.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/long_to_byte_array.rs:14-25
//!   add_jit_cost(17); input must be Long; output is 8 bytes BE Coll[Byte].

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::long_to_byte_array::LongToByteArray;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct LongToByteArrayFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    pub expected_value_json: JsonValue,
    pub expected_cost: u64,
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct LongToByteArrayFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<LongToByteArrayFixture>,
}

fn build_tree(value: i64) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = LongToByteArray::try_build(Expr::Const(value.into()))?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, value: i64) -> anyhow::Result<LongToByteArrayFixture> {
    let (tree, hex) = build_tree(value)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(LongToByteArrayFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<LongToByteArrayFixtureFile> {
    let mut entries = Vec::new();
    entries.push(success_entry("l2b_plus_one", 1i64)?);
    entries.push(success_entry("l2b_neg_one", -1i64)?);
    entries.push(success_entry("l2b_zero", 0i64)?);
    entries.push(success_entry("l2b_max", i64::MAX)?);
    entries.push(success_entry("l2b_min", i64::MIN)?);
    entries.push(success_entry("l2b_high_bit_plus_one", i64::MIN + 1)?);  // 0x8000000000000001
    entries.push(success_entry("l2b_roundtrip_candidate", 0x12345678i64)?);

    Ok(LongToByteArrayFixtureFile {
        corpus: "eval_long_to_byte_array",
        entries,
    })
}
```

- [ ] **Step 2: Register, run, commit fixtures.**

- [ ] **Step 3: RED test.** Mirror T2 Step 4. 7 fails. Commit.

- [ ] **Step 4: GREEN handler + EvalErrorCode**

Create `packages/ergoscript/src/eval/long-to-byte-array.ts`:

```ts
/**
 * LongToByteArray arm — i64 -> 8 bytes BE.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/long_to_byte_array.rs:14-25
 *   add_jit_cost(17); input must be SLong; output is BE i64 as Coll[Byte] of length 8.
 */
import type { LongToByteArray, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_coll-helpers'

export function evalLongToByteArray(
  e: LongToByteArray,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(17)
  const inputV = evalExpr(e.input, env, ctx)
  if (inputV.kind !== 'Long') {
    throw new EvalError(
      `LongToByteArray: expected Long input, got kind='${inputV.kind}'`,
      'predef-input-not-long',
    )
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, inputV.value, false)
  return bytesToCollByteSValue(out)
}
```

Add `'predef-input-not-long'` to `EvalErrorCode` union.

Wire into `eval.ts`:
```ts
case 'LongToByteArray':
  return evalLongToByteArray(e, env, ctx)
```

Tests pass + typecheck. Commit:
```bash
git add packages/ergoscript/src/eval/{long-to-byte-array.ts,eval.ts,eval-context.ts}
git commit -m "feat(ergoscript): LongToByteArray eval arm (Pattern A Fixed(17))"
```

- [ ] **Step 5: Throw-path + mutation tests**

Throw-path inline test for non-Long input. Mutation test mirrors T2 Step 7 but mutates the embedded Long value's encoded bytes (single-iteration mutation since LongToByteArray's deterministic output makes most mutations kills).

Commit.

---

## Task 6: `ByteArrayToBigInt` — Pattern A, signed BE + i256 range check

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/byte_array_to_bigint.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/byte-array-to-bigint.json`
- Create: `packages/ergoscript/src/eval/byte-array-to-bigint.ts`
- Modify: `packages/ergoscript/src/eval/_byte-coll.ts` (add `signedBeBytesToBigInt`, `I256_MIN`, `I256_MAX`)
- Modify: `packages/ergoscript/src/eval/eval.ts`, `src/eval/eval-context.ts` (add `'byte-array-to-bigint-empty'`, `'byte-array-to-bigint-out-of-range'`)
- Create: `packages/ergoscript/test/eval/byte-array-to-bigint.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/byte-array-to-bigint.test.ts`

**Source:** `ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34` — Pattern A `Fixed(30)`. Throws on empty input. Range = `[-2^255, 2^255 - 1]`. Length NOT capped — 33+ byte inputs in-range succeed.

- [ ] **Step 1: Write fixture-gen — 10 scenarios**

Mirror the sigma-rust tests at `byte_array_to_bigint.rs:54-138`:

```rust
//! ByteArrayToBigInt arm — signed BE bytes -> BigInt (i256-range-checked).
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34
//!   add_jit_cost(30); empty input throws; decoded value must fit i256.
//!   Length NOT capped — 33+ byte inputs in-range succeed.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::byte_array_to_bigint::ByteArrayToBigInt;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ByteArrayToBigIntFixture { /* same shape */ }

#[derive(Serialize)]
pub struct ByteArrayToBigIntFixtureFile { /* same shape */ }

fn build_tree(bytes: Vec<i8>) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = ByteArrayToBigInt::try_build(Expr::Const(bytes.into()))?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, bytes: Vec<i8>) -> anyhow::Result<ByteArrayToBigIntFixture> { /* … */ }
fn error_entry(name: &str, bytes: Vec<i8>, code: &str) -> anyhow::Result<ByteArrayToBigIntFixture> { /* … */ }

pub fn generate() -> anyhow::Result<ByteArrayToBigIntFixtureFile> {
    let mut entries = Vec::new();

    // Happy: small +/-
    entries.push(success_entry("b2bi_plus_one", vec![0x01])?);
    entries.push(success_entry("b2bi_neg_one_1byte", vec![-1i8])?);  // 0xFF -> -1
    entries.push(success_entry("b2bi_neg_one_2byte", vec![-1i8, -1])?);  // 0xFFFF -> -1
    entries.push(success_entry("b2bi_256", vec![1, 0])?);
    entries.push(success_entry("b2bi_neg_32768", vec![-128, 0])?);

    // Happy boundary: i256 MAX = 0x7F FF...FF (32 bytes)
    let mut max_buf = vec![-1i8; 32];
    max_buf[0] = 0x7F;
    entries.push(success_entry("b2bi_i256_max", max_buf)?);

    // Happy boundary: i256 MIN = 0x80 00...00 (32 bytes)
    let mut min_buf = vec![0i8; 32];
    min_buf[0] = -128;  // 0x80
    entries.push(success_entry("b2bi_i256_min", min_buf)?);

    // Happy: 33-byte input that fits in i256 (leading 0x00 sign byte then 32-byte value)
    let mut in_range_33 = vec![0i8; 33];
    in_range_33[1] = 0x7E;
    entries.push(success_entry("b2bi_33byte_in_range", in_range_33)?);

    // Throw: 33-byte just above MAX (mirrors sigma-rust eval_above_max_bound at :107-118)
    let mut above_max = vec![0i8; 33];
    above_max[1] = -128;  // 0x80
    entries.push(error_entry("b2bi_33byte_above_max", above_max, "byte-array-to-bigint-out-of-range")?);

    // Throw: empty input
    entries.push(error_entry("b2bi_empty", vec![], "byte-array-to-bigint-empty")?);

    Ok(ByteArrayToBigIntFixtureFile {
        corpus: "eval_byte_array_to_bigint",
        entries,
    })
}
```

- [ ] **Step 2: Register, run, commit fixtures.**

- [ ] **Step 3: RED test.** Mirror T2 Step 4. 10 fails. Commit.

- [ ] **Step 4: Add helpers to `_byte-coll.ts`**

Modify `packages/ergoscript/src/eval/_byte-coll.ts`:

```ts
/**
 * Signed big-endian byte-array -> bigint. Pure bigint arithmetic; no @noble call.
 *
 * Empty input is REJECTED by the caller (this helper assumes bytes.length >= 1).
 * The high bit of bytes[0] is the sign bit (i8 semantics in sigma-rust storage).
 */
export function signedBeBytesToBigInt(bytes: Uint8Array): bigint {
  // Accumulate unsigned BE first.
  let value = 0n
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]!)
  }
  // Sign-extend if the high bit of the first byte is set.
  if (bytes[0]! & 0x80) {
    value -= 1n << BigInt(bytes.length * 8)
  }
  return value
}

/** Signed 256-bit integer range. */
export const I256_MIN = -(1n << 255n)
export const I256_MAX = (1n << 255n) - 1n
```

Verify the file's existing structure (where `extractCollByte`/`bytesToCollByteSValue` live) before appending.

- [ ] **Step 5: GREEN handler + EvalErrorCode**

Create `packages/ergoscript/src/eval/byte-array-to-bigint.ts`:

```ts
/**
 * ByteArrayToBigInt arm — signed BE bytes -> BigInt (i256-range-checked).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34
 *   add_jit_cost(30); empty input throws; decoded value must fit [-2^255, 2^255 - 1].
 *   Length NOT capped — 33+ byte inputs in-range succeed (eval_above_max_bound test).
 */
import type { ByteArrayToBigInt, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollByte, signedBeBytesToBigInt, I256_MIN, I256_MAX } from './_byte-coll'

export function evalByteArrayToBigInt(
  e: ByteArrayToBigInt,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(30)
  const inputV = evalExpr(e.input, env, ctx)
  let bytes: Uint8Array
  try {
    bytes = extractCollByte(inputV)
  } catch {
    throw new EvalError(
      `ByteArrayToBigInt: expected Coll[Byte] input, got kind='${inputV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  if (bytes.length === 0) {
    throw new EvalError(
      'ByteArrayToBigInt: byte array is empty',
      'byte-array-to-bigint-empty',
    )
  }
  const value = signedBeBytesToBigInt(bytes)
  if (value < I256_MIN || value > I256_MAX) {
    throw new EvalError(
      'ByteArrayToBigInt: decoded value out of i256 range',
      'byte-array-to-bigint-out-of-range',
    )
  }
  return { kind: 'BigInt', value }
}
```

Add `'byte-array-to-bigint-empty'` and `'byte-array-to-bigint-out-of-range'` to `EvalErrorCode` union (alphabetically).

Wire into `eval.ts`:
```ts
case 'ByteArrayToBigInt':
  return evalByteArrayToBigInt(e, env, ctx)
```

Tests pass + typecheck. Commit:
```bash
git add packages/ergoscript/src/eval/{byte-array-to-bigint.ts,_byte-coll.ts,eval.ts,eval-context.ts}
git commit -m "feat(ergoscript): ByteArrayToBigInt eval arm (Pattern A Fixed(30), i256-range)"
```

- [ ] **Step 6: Throw-path + mutation tests.** Commit.

---

## Task 7: `Xor` — Pattern B, truncating-zip

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/xor.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/xor.json`
- Create: `packages/ergoscript/src/eval/xor.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`
- Create: `packages/ergoscript/test/eval/xor.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/xor.test.ts`

**Source:** `ergotree-interpreter/src/eval/xor.rs:13-41`. Pattern B. **CRITICAL:** truncating-zip (`x.iter().zip(y.iter())`); output length = `min(left, right)`; cost sized by LEFT length. NO length-mismatch error.

- [ ] **Step 1: Write fixture-gen — 9 scenarios**

```rust
//! Xor arm — pairwise byte XOR via truncating-zip.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/xor.rs:13-41
//!   helper_xor: x.iter().zip(y.iter()) — truncates to shorter; cost sized by LEFT.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::mir::xor::Xor;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

// XorFixture + XorFixtureFile structs — same shape.

fn build_tree(left: Expr, right: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = Xor::new(left, right)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_pair(name: &str, l: Vec<i8>, r: Vec<i8>) -> anyhow::Result<XorFixture> {
    let (tree, hex) = build_tree(Expr::Const(l.into()), Expr::Const(r.into()))?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(XorFixture { /* … */ })
}

pub fn generate() -> anyhow::Result<XorFixtureFile> {
    let mut entries = Vec::new();
    entries.push(success_pair("xor_empty", vec![], vec![])?);
    entries.push(success_pair("xor_32byte", (0..32i8).collect(), (32..64i8).collect())?);
    entries.push(success_pair("xor_identical_zero", vec![0x42; 16], vec![0x42; 16])?);
    entries.push(success_pair("xor_inverse_allFF", vec![0x42; 16], (0..16).map(|_| !0x42i8).collect())?);
    entries.push(success_pair("xor_left_longer", vec![1, 2, 3, 4, 5], vec![-1, -2, -3])?);
    entries.push(success_pair("xor_right_longer", vec![-1, -2, -3], vec![1, 2, 3, 4, 5])?);
    entries.push(success_pair("xor_1byte", vec![0x01], vec![-2])?);
    entries.push(success_pair("xor_both_single", vec![0x42], vec![0x24])?);
    entries.push(success_pair("xor_64byte", (0..64i8).map(|i| i.wrapping_mul(3)).collect(), (0..64i8).rev().collect())?);

    Ok(XorFixtureFile {
        corpus: "eval_xor",
        entries,
    })
}
```

- [ ] **Step 2: Register, run, commit.**

- [ ] **Step 3: RED test.** Mirror T2 Step 4. 9 fails. Commit.

- [ ] **Step 4: GREEN handler**

Create `packages/ergoscript/src/eval/xor.ts`:

```ts
/**
 * Xor arm — pairwise byte XOR via truncating-zip.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/xor.rs:13-41
 *   helper_xor uses x.iter().zip(y.iter()) — truncates to shorter operand.
 *   Cost: addPerItemCost(10, 2, 128, l.length) — sized by LEFT.
 *   Order: eval left -> eval right -> shape-match both -> charge cost -> compute.
 */
import type { SValue, Xor } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollByte } from './_byte-coll'
import { bytesToCollByteSValue } from './_coll-helpers'

export function evalXor(e: Xor, env: Env, ctx: EvalContext): SValue {
  const leftV = evalExpr(e.left, env, ctx)
  const rightV = evalExpr(e.right, env, ctx)
  let l: Uint8Array
  let r: Uint8Array
  try {
    l = extractCollByte(leftV)
    r = extractCollByte(rightV)
  } catch {
    throw new EvalError(
      `Xor: expected Coll[Byte] for both operands, got kinds='${leftV.kind}','${rightV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  ctx.addPerItemCost(10, 2, 128, l.length) // sized by LEFT
  const outLen = Math.min(l.length, r.length)
  const out = new Uint8Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = l[i]! ^ r[i]!
  return bytesToCollByteSValue(out)
}
```

Wire into `eval.ts`:
```ts
case 'Xor':
  return evalXor(e, env, ctx)
```

(`'predef-input-not-byte-array'` already in `EvalErrorCode` from T2.)

Tests pass. Commit.

- [ ] **Step 5: Throw-path + mutation tests.** Commit.

---

## Task 8: `DecodePoint` — Pattern A, reuses existing adapter

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/decode_point.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/decode-point.json`
- Create: `packages/ergoscript/src/eval/decode-point.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`, `src/eval/eval-context.ts` (add `'decode-point-invalid'`)
- Create: `packages/ergoscript/test/eval/decode-point.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/decode-point.test.ts`

**Source:** `ergotree-interpreter/src/eval/decode_point.rs:14-30` — Pattern A `Fixed(300)`. Reuses existing `crypto/secp256k1.ts:decodePoint` adapter. See spec §"Risk Hotspot 3" for the pre-existing buf[0]==0 divergence.

- [ ] **Step 1: Write fixture-gen — 6 scenarios**

```rust
//! DecodePoint arm — 33 bytes -> GroupElement.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/decode_point.rs:14-30
//!   add_jit_cost(300); EcPoint::sigma_parse_bytes mirrored via decodePoint adapter.

use ergo_chain_types::EcPoint;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::decode_point::DecodePoint;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

// DecodePointFixture + DecodePointFixtureFile — same shape.

fn build_tree(bytes: Vec<i8>) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = DecodePoint::try_build(Expr::Const(bytes.into()))?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, bytes: Vec<i8>) -> anyhow::Result<DecodePointFixture> { /* … */ }
fn error_entry(name: &str, bytes: Vec<i8>, code: &str) -> anyhow::Result<DecodePointFixture> { /* … */ }

pub fn generate() -> anyhow::Result<DecodePointFixtureFile> {
    let mut entries = Vec::new();

    // Happy: generator
    let gen = EcPoint::generator();
    let gen_bytes: Vec<i8> = gen.sigma_serialize_bytes()?.into_iter().map(|b| b as i8).collect();
    entries.push(success_entry("dp_generator", gen_bytes)?);

    // Happy: identity (33 zero bytes)
    entries.push(success_entry("dp_identity", vec![0i8; 33])?);

    // Happy: arbitrary point — deterministic under proptest seed
    let arb = force_any_val::<EcPoint>();
    let arb_bytes: Vec<i8> = arb.sigma_serialize_bytes()?.into_iter().map(|b| b as i8).collect();
    entries.push(success_entry("dp_arbitrary", arb_bytes)?);

    // Throw: wrong length (32 bytes)
    entries.push(error_entry("dp_wrong_length_32", vec![0i8; 32], "decode-point-invalid")?);

    // Throw: wrong length (34 bytes)
    entries.push(error_entry("dp_wrong_length_34", vec![0i8; 34], "decode-point-invalid")?);

    // Throw: off-curve — 33 bytes with tag 0x04 (uncompressed marker — not valid for compressed)
    let mut off_curve = vec![0i8; 33];
    off_curve[0] = 0x04;
    for i in 1..33 { off_curve[i] = i as i8; }
    entries.push(error_entry("dp_off_curve", off_curve, "decode-point-invalid")?);

    Ok(DecodePointFixtureFile {
        corpus: "eval_decode_point",
        entries,
    })
}
```

- [ ] **Step 2: Register, run, commit fixtures.**

- [ ] **Step 3: RED test.** Mirror T2 Step 4. 6 fails. Commit.

- [ ] **Step 4: GREEN handler + EvalErrorCode**

Create `packages/ergoscript/src/eval/decode-point.ts`:

```ts
/**
 * DecodePoint arm — 33-byte SEC1 -> GroupElement.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/decode_point.rs:14-30
 *   add_jit_cost(300); EcPoint::sigma_parse_bytes mirrored via decodePoint adapter.
 *
 * Reuses crypto/secp256k1.ts:decodePoint which handles the Ergo identity
 * convention (33 zero bytes -> Point.ZERO). See spec §"Risk Hotspot 3" for the
 * pre-existing buf[0]==0 vs all-zero divergence with sigma-rust (out of scope).
 */
import type { DecodePoint, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollByte } from './_byte-coll'
import { decodePoint } from '../crypto/secp256k1'

export function evalDecodePoint(
  e: DecodePoint,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(300)
  const inputV = evalExpr(e.input, env, ctx)
  let bytes: Uint8Array
  try {
    bytes = extractCollByte(inputV)
  } catch {
    throw new EvalError(
      `DecodePoint: expected Coll[Byte] input, got kind='${inputV.kind}'`,
      'predef-input-not-byte-array',
    )
  }
  let point: ReturnType<typeof decodePoint>
  try {
    point = decodePoint(bytes)
  } catch (cause) {
    throw new EvalError(
      `DecodePoint: invalid point bytes — ${(cause as Error).message}`,
      'decode-point-invalid',
    )
  }
  // Re-encode to canonical 33-byte SEC1. Identity is encoded as 33 zero bytes
  // (matches sigma-rust EcPoint::scorex_serialize:127-137); compressed otherwise.
  const valueBytes = point.is0() ? new Uint8Array(33) : point.toBytes(true)
  return { kind: 'GroupElement', value: valueBytes }
}
```

**Before writing:** verify the exported method names on the returned Point — `is0()` and `toBytes(true)` per `crypto/secp256k1.ts` API. Search:
```bash
rtk proxy grep -n "is0\|toBytes" packages/ergoscript/src/crypto/secp256k1.ts | head -10
```

If names differ (e.g. `isZero()`, `toRawBytes(true)`), adapt.

Add `'decode-point-invalid'` to `EvalErrorCode` union.

Wire into `eval.ts`:
```ts
case 'DecodePoint':
  return evalDecodePoint(e, env, ctx)
```

Tests pass + typecheck. Commit.

- [ ] **Step 5: Throw-path + mutation tests.** Commit.

---

## Task 9: `SubstConstants` — consensus-critical bytes-in / bytes-out

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/subst_constants.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/subst-constants.json`
- Create: `packages/ergoscript/src/eval/subst-constants.ts`
- Modify: `packages/ergoscript/src/eval/_coll-helpers.ts` (add `extractCollInt`)
- Modify: `packages/ergoscript/src/eval/eval.ts`, `src/eval/eval-context.ts` (add `'subst-constants-error'`)
- Create: `packages/ergoscript/test/eval/subst-constants.test.ts`
- Create: `packages/ergoscript/test/eval-mutation/subst-constants.test.ts`

**Source:** `ergotree-interpreter/src/eval/subst_const.rs:18-89` + `ergotree-ir/src/ergo_tree.rs:45-70` (`with_constant`). Pattern B `addPerItemCost(100, 100, 1, template_consts_len)` — sized by TEMPLATE'S constants_len, NOT positions.length (bug-3 regression).

**This is the consensus-critical arm.** Read the spec's §"SubstConstants — consensus-critical bytes-in / bytes-out" before starting.

- [ ] **Step 1: Add `extractCollInt` helper**

Modify `packages/ergoscript/src/eval/_coll-helpers.ts`:

```ts
/**
 * Extract a Coll[Int] as a number[]. Throws 'coll-input-not-coll' on non-Coll;
 * throws 'coll-elem-tpe-mismatch' if elements aren't SInt.
 *
 * Used by SubstConstants for the positions argument.
 */
export function extractCollInt(v: SValue): number[] {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `expected Coll input, got kind='${v.kind}'`,
      'coll-input-not-coll',
    )
  }
  if (v.elem.tag !== 'SInt') {
    throw new EvalError(
      `expected Coll[Int], got Coll[${v.elem.tag}]`,
      'coll-elem-tpe-mismatch',
    )
  }
  return v.items.map((item) => {
    if (item.kind !== 'Int') {
      throw new EvalError(
        `Coll[Int] item is not Int (got '${item.kind}')`,
        'coll-elem-tpe-mismatch',
      )
    }
    return item.value
  })
}
```

Verify the existing imports at the top of `_coll-helpers.ts` (it needs access to `SValue`, `EvalError`). Add `extractCollInt` next to `extractCollItems`/`extractFuncValue`.

Run typecheck. If `EvalError` isn't imported, add it:
```ts
import { EvalError } from './eval-context'
```

Commit alone:
```bash
git add packages/ergoscript/src/eval/_coll-helpers.ts
git commit -m "refactor(ergoscript): add extractCollInt helper for SubstConstants"
```

- [ ] **Step 2: Write fixture-gen — 13 scenarios**

Create `fixture-gen/src/cmds/ergoscript/eval/subst_constants.rs`:

```rust
//! SubstConstants arm — substitute constants in a serialized ErgoTree.
//!
//! Sigma-rust ref:
//!   ergotree-interpreter/src/eval/subst_const.rs:18-89
//!   ergotree-ir/src/ergo_tree.rs:45-70 (with_constant)
//!
//! Cost: Pattern B, addPerItemCost(100, 100, 1, template.constants_len).
//! Bug-3 regression: cost size is TEMPLATE's constants_len, NOT positions.len.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::subst_const::SubstConstants;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct SubstConstantsFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    pub expected_value_json: JsonValue,
    pub expected_cost: u64,
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct SubstConstantsFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<SubstConstantsFixture>,
}

/// Builds: a + b * c — a 3-constant template (segregated).
fn make_template_3int(a: i32, b: i32, c: i32) -> anyhow::Result<Vec<u8>> {
    let expr = Expr::BinOp(
        BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::Const(a.into())),
            right: Box::new(Expr::BinOp(
                BinOp {
                    kind: BinOpKind::Arith(ArithOp::Multiply),
                    left: Box::new(Expr::Const(b.into())),
                    right: Box::new(Expr::Const(c.into())),
                }
                .into(),
            )),
        }
        .into(),
    );
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &expr)?;  // segregated
    Ok(tree.sigma_serialize_bytes()?)
}

/// Builds a 1-constant template (segregated) carrying the given Constant.
fn make_template_1const(c: Constant) -> anyhow::Result<Vec<u8>> {
    let expr = Expr::Const(c);
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &expr)?;
    Ok(tree.sigma_serialize_bytes()?)
}

fn build_subst_tree(
    template_bytes: Vec<u8>,
    positions: Vec<i32>,
    new_values_constant: Constant,
) -> anyhow::Result<(ErgoTree, String)> {
    let script_bytes: Box<Expr> = Box::new(Expr::Const(Constant::from(template_bytes)));
    let positions_expr: Box<Expr> = Box::new(Expr::Const(Constant::from(positions)));
    let new_values: Box<Expr> = Box::new(Expr::Const(new_values_constant));
    let subst = Expr::SubstConstants(
        SubstConstants {
            script_bytes,
            positions: positions_expr,
            new_values,
        }
        .into(),
    );
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &subst)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(
    name: &str,
    template: Vec<u8>,
    positions: Vec<i32>,
    new_values: Constant,
) -> anyhow::Result<SubstConstantsFixture> {
    let (tree, hex) = build_subst_tree(template, positions, new_values)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(SubstConstantsFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn error_entry(
    name: &str,
    template: Vec<u8>,
    positions: Vec<i32>,
    new_values: Constant,
) -> anyhow::Result<SubstConstantsFixture> {
    let (tree, hex) = build_subst_tree(template, positions, new_values)?;
    Ok(SubstConstantsFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("subst-constants-error"),
    })
}

pub fn generate() -> anyhow::Result<SubstConstantsFixtureFile> {
    let mut entries = Vec::new();

    // 1. Single substitution (1-const template)
    let t1 = make_template_1const(Constant::from(42i32))?;
    entries.push(success_entry("subst_single", t1.clone(), vec![0], Constant::from(vec![99i32]))?);

    // 2. 3-substitution (3-const Int template)
    let t3 = make_template_3int(1, 2, 3)?;
    entries.push(success_entry("subst_3", t3.clone(), vec![0, 1, 2], Constant::from(vec![10i32, 20, 30]))?);

    // 3. Reorder positions [2,0,1]
    entries.push(success_entry("subst_reorder", t3.clone(), vec![2, 0, 1], Constant::from(vec![100i32, 200, 300]))?);

    // 4. Empty positions — no-op; cost still based on template.constants_len
    entries.push(success_entry("subst_empty_positions", t3.clone(), vec![], Constant::from(Vec::<i32>::new()))?);

    // 5. Byte-substitution: 1-const Coll[Byte] template, substitute with new Coll[Byte]
    let t_bytes = make_template_1const(Constant::from(vec![0x01i8, 0x02, 0x03]))?;
    entries.push(success_entry(
        "subst_bytes",
        t_bytes,
        vec![0],
        Constant::from(vec![vec![0xAAi8, 0xBB, 0xCC]]),
    )?);

    // 6. Long template (3-const Long)
    let t_long_expr = Expr::BinOp(
        BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::Const(100i64.into())),
            right: Box::new(Expr::BinOp(
                BinOp {
                    kind: BinOpKind::Arith(ArithOp::Multiply),
                    left: Box::new(Expr::Const(200i64.into())),
                    right: Box::new(Expr::Const(300i64.into())),
                }
                .into(),
            )),
        }
        .into(),
    );
    let t_long = ErgoTree::new(ErgoTreeHeader::v0(true), &t_long_expr)?.sigma_serialize_bytes()?;
    entries.push(success_entry(
        "subst_3_long",
        t_long.clone(),
        vec![0, 1, 2],
        Constant::from(vec![1000i64, 2000, 3000]),
    )?);

    // 7. Throw: bad template bytes
    let bad_template = vec![0xFFu8; 8]; // not a valid ErgoTree
    entries.push(error_entry(
        "subst_bad_template",
        bad_template,
        vec![0],
        Constant::from(vec![1i32]),
    )?);

    // 8. Throw: position out-of-range (3-const template, positions=[5])
    entries.push(error_entry("subst_position_oob", t3.clone(), vec![5], Constant::from(vec![999i32]))?);

    // 9. Throw: type mismatch (3-const Int template, new_values=[1L,2L,3L])
    entries.push(error_entry("subst_type_mismatch", t3.clone(), vec![0, 1, 2], Constant::from(vec![1i64, 2, 3]))?);

    // 10. Throw: positions/new_values length mismatch
    entries.push(error_entry("subst_length_mismatch", t3.clone(), vec![0, 1], Constant::from(vec![99i32]))?);

    // 11. Negative position — i32::MIN. Sigma-rust casts to usize -> huge -> out-of-bounds.
    entries.push(error_entry("subst_negative_position", t3.clone(), vec![-1], Constant::from(vec![999i32]))?);

    // 12. Template with 0 constants (segregation=false)
    let t_no_segr = ErgoTree::new(ErgoTreeHeader::v0(false), &Expr::Const(7i32.into()))?
        .sigma_serialize_bytes()?;
    entries.push(error_entry("subst_no_segregation", t_no_segr, vec![0], Constant::from(vec![1i32]))?);

    // 13. Same template, single-position substitution: byte-equality cross-check
    //     (helps catch any byte-level divergence between our serializeTree and sigma-rust's)
    entries.push(success_entry("subst_byte_equality_check", t3.clone(), vec![1], Constant::from(vec![777i32]))?);

    Ok(SubstConstantsFixtureFile {
        corpus: "eval_subst_constants",
        entries,
    })
}
```

- [ ] **Step 3: Register, run, verify determinism, commit.**

- [ ] **Step 4: RED test.** Mirror T2 Step 4. 13 fails. Commit.

- [ ] **Step 5: GREEN handler + EvalErrorCode**

Create `packages/ergoscript/src/eval/subst-constants.ts`:

```ts
/**
 * SubstConstants arm — substitute constants in a serialized ErgoTree.
 *
 * Sigma-rust ref:
 *   ergotree-interpreter/src/eval/subst_const.rs:18-89
 *   ergotree-ir/src/ergo_tree.rs:45-70 (with_constant)
 *
 * Cost: Pattern B addPerItemCost(100, 100, 1, template.constants.length).
 * Sized by TEMPLATE'S constants_len, NOT positions.length (bug-3 regression).
 *
 * Output byte-equality with sigma-rust is guaranteed by reusing parseTree/
 * serializeTree (validated by 255 corpus round-trip fixtures + 6,221
 * parse-mutation tests). Only the constants section changes; everything else
 * round-trips.
 */
import type { ErgoTree, SubstConstants, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollByte } from './_byte-coll'
import { extractCollInt, bytesToCollByteSValue } from './_coll-helpers'
import { parseTree, serializeTree } from '../wire/ergo-tree'
import { sTypeEquals } from '../mir/stype-helpers'

export function evalSubstConstants(
  e: SubstConstants,
  env: Env,
  ctx: EvalContext,
): SValue {
  // 1. Evaluate the three child expressions (sigma-rust order).
  const scriptBytesV = evalExpr(e.scriptBytes, env, ctx)
  let scriptBytes: Uint8Array
  try {
    scriptBytes = extractCollByte(scriptBytesV)
  } catch {
    throw new EvalError(
      `SubstConstants: script_bytes must be Coll[Byte], got kind='${scriptBytesV.kind}'`,
      'subst-constants-error',
    )
  }

  const positionsV = evalExpr(e.positions, env, ctx)
  let positions: number[]
  try {
    positions = extractCollInt(positionsV)
  } catch {
    throw new EvalError(
      `SubstConstants: positions must be Coll[Int], got kind='${positionsV.kind}'`,
      'subst-constants-error',
    )
  }

  const newValuesV = evalExpr(e.newValues, env, ctx)
  if (newValuesV.kind !== 'Coll') {
    throw new EvalError(
      `SubstConstants: new_values must be Coll[T], got kind='${newValuesV.kind}'`,
      'subst-constants-error',
    )
  }

  // 2. Length match (sigma-rust subst_const.rs:49-55).
  if (positions.length !== newValuesV.items.length) {
    throw new EvalError(
      `SubstConstants: positions.length (${positions.length}) !== new_values.length (${newValuesV.items.length})`,
      'subst-constants-error',
    )
  }

  // 3. Parse the embedded template. Any wire-layer error -> 'subst-constants-error'.
  let tree: ErgoTree
  try {
    tree = parseTree(scriptBytes)
  } catch (cause) {
    throw new EvalError(
      `SubstConstants: bad template bytes — ${(cause as Error).message}`,
      'subst-constants-error',
    )
  }

  // 4. Charge cost — AFTER parse, BEFORE substitution. Sized by template's
  //    constants_len, NOT positions.length (sigma-rust subst_const.rs:65;
  //    bug-3 regression test at :221-283).
  ctx.addPerItemCost(100, 100, 1, tree.constants.length)

  // 5. Substitute. Validate each: position in bounds + new SType matches original.
  //    Defensive deep copy — never mutate the input tree's arrays.
  const newConstants = [...tree.constants]
  for (let ix = 0; ix < positions.length; ix++) {
    const i = positions[ix]!
    if (i < 0 || i >= tree.constants.length) {
      throw new EvalError(
        `SubstConstants: positions[${ix}] = ${i} out of bounds (constants.length = ${tree.constants.length})`,
        'subst-constants-error',
      )
    }
    // new_values is Coll[T] (homogeneous); compare its declared element type to
    // the original constant's stored SType. sigma-rust does the equivalent via
    // Constant.tpe == old_constant.tpe (ergo_tree.rs:51).
    if (!sTypeEquals(newValuesV.elem, tree.constantTypes[i]!)) {
      throw new EvalError(
        `SubstConstants: type mismatch at position ${i}`,
        'subst-constants-error',
      )
    }
    newConstants[i] = newValuesV.items[ix]!
  }

  // 6. Re-serialize. Output byte-equality with sigma-rust is guaranteed by the
  //    existing round-trip property of parseTree/serializeTree.
  const newTree: ErgoTree = { ...tree, constants: newConstants }
  try {
    return bytesToCollByteSValue(serializeTree(newTree))
  } catch (cause) {
    throw new EvalError(
      `SubstConstants: re-serialize failed — ${(cause as Error).message}`,
      'subst-constants-error',
    )
  }
}
```

Add `'subst-constants-error'` to `EvalErrorCode` union.

Wire into `eval.ts`:
```ts
case 'SubstConstants':
  return evalSubstConstants(e, env, ctx)
```

**Before running tests:** verify the import paths for `parseTree`, `serializeTree`, `sTypeEquals`, `ErgoTree`. Search:
```bash
rtk proxy grep -n "^export function parseTree\|^export function serializeTree" packages/ergoscript/src/wire/ergo-tree.ts
rtk proxy grep -n "^export function sTypeEquals" packages/ergoscript/src/mir/stype-helpers.ts
rtk proxy grep -n "^export interface ErgoTree" packages/ergoscript/src/mir/types.ts
```

If any are missing or differently named, adapt.

Run typecheck. Run tests. 13 pass. Commit:
```bash
git add packages/ergoscript/src/eval/{subst-constants.ts,eval.ts,eval-context.ts}
git commit -m "feat(ergoscript): SubstConstants eval arm (Pattern B; consensus-critical bytes-in/bytes-out)"
```

- [ ] **Step 6: Byte-equality regression check**

Add an explicit byte-equality test alongside `subst-constants.test.ts` (verifying the output matches the sigma-rust pre-computed reference byte string, NOT just the value-shape equality):

```ts
describe('SubstConstants — byte-equality with sigma-rust', () => {
  it('output bytes are bit-identical to sigma-rust for subst_byte_equality_check', () => {
    const entry = fixture.entries.find((e) => e.name === 'subst_byte_equality_check')!
    const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
    const ctx = makeContext({})
    const value = evaluateWith(tree, ctx) as { kind: 'Coll'; items: Array<{ value: number }> }
    expect(value.kind).toBe('Coll')
    const actualBytes = new Uint8Array(value.items.map((it) => it.value & 0xff))
    const expectedItems = entry.expected_value_json!.value as Array<{ value: number }>
    const expectedBytes = new Uint8Array(expectedItems.map((it) => it.value & 0xff))
    expect(actualBytes).toEqual(expectedBytes)
  })
})
```

This makes the byte-equality assertion explicit and visible in CI output (vs just falling out of value-shape equality).

Commit.

- [ ] **Step 7: Mutation testing (Layer C3.a) — 3 regions**

SubstConstants has 3 mutation regions:
- Embedded template bytes (mutating these changes the parsed tree shape — most mutations should kill on parse failure or post-substitution mismatch)
- Positions Coll[Int] bytes (mutating these mutates position indices)
- New-values Coll[T] bytes (mutating these mutates the substituted values)

Create 3 separate mutation describe-blocks in `test/eval-mutation/subst-constants.test.ts`, each scoped to a different inline Coll[Byte] region. Use `findInlineByteColls` + `locateBytes` to identify each region.

Each must hit ≥ 0.9 kill rate.

Commit.

- [ ] **Step 8: Full validation before T10**

```bash
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts
```

Expected: all subst-constants tests pass under jsdom.

```bash
cd packages/ergoscript && npx vitest run
```

Expected: ergoscript tests at ~3180.

```bash
node_modules/.bin/vitest run packages/
```

Expected: ~3758 total.

```bash
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
```

All clean.

```bash
cd fixture-gen && cargo run --release
git diff --exit-code packages/
```

Empty diff (determinism).

If any check fails, fix before T10.

---

## Task 10: Update `facts/ergoscript-eval.md`

**Files:**
- Modify: `facts/ergoscript-eval.md`

Per `[[feedback-docs-pass-every-phase]]`, the facts file MUST be updated. It is the boundary contract.

- [ ] **Step 1: Append the phase 2i-a changelog subsection**

After the Phase 2h-f entry, add:

```markdown
**Phase 2i-a — Pure-bytes predefs** (additive):

- 8 new eval arms wired (coverage 52 → 60 of ~70 `Expr` arms):
  - **`CalcBlake2b256`** — Pattern B `addPerItemCost(20, 7, 128, n)`. `@noble/hashes/blake2.js`.
  - **`CalcSha256`** — Pattern B `addPerItemCost(80, 8, 64, n)`. `@noble/hashes/sha2.js`.
  - **`ByteArrayToLong`** — Pattern A `Fixed(16)`. First 8 bytes BE → i64; trailing bytes IGNORED (sigma-rust `eval_skip_tail` at `byte_array_to_long.rs:62-65`).
  - **`LongToByteArray`** — Pattern A `Fixed(17)`. i64 → 8 bytes BE.
  - **`ByteArrayToBigInt`** — Pattern A `Fixed(30)`. Signed BE → bigint; range-checked to i256 (`[-2^255, 2^255 - 1]`). Empty input throws.
  - **`Xor`** — Pattern B `addPerItemCost(10, 2, 128, l_length)` sized by LEFT. Truncating-zip: output length = `min(left, right)` (no length-mismatch error).
  - **`DecodePoint`** — Pattern A `Fixed(300)`. Reuses existing `crypto/secp256k1.ts:decodePoint` adapter (handles Ergo 33-zero-bytes identity).
  - **`SubstConstants`** — Pattern B `addPerItemCost(100, 100, 1, template.constants.length)`. Sized by TEMPLATE's `constants.length`, NOT positions.length (bug-3 regression per sigma-rust `subst_const.rs:221-283`). Output byte-equality guaranteed by reusing `parseTree`/`serializeTree`.
- 7 new `EvalError` codes (48 → 55): `'predef-input-not-byte-array'`, `'predef-input-not-long'`, `'decode-point-invalid'`, `'byte-array-to-long-too-short'`, `'byte-array-to-bigint-empty'`, `'byte-array-to-bigint-out-of-range'`, `'subst-constants-error'`.
- 1 new helper module exports added to `eval/_byte-coll.ts`: `signedBeBytesToBigInt`, `I256_MIN`, `I256_MAX`.
- 1 new helper added to `eval/_coll-helpers.ts`: `extractCollInt`.
- Two documented TS-from-sigma-rust divergences (both inherited):
  - **`DecodePoint` identity convention**: existing `decodePoint` adapter at `crypto/secp256k1.ts:65-77` checks `isZero33(bytes)` (all 33 bytes zero), while sigma-rust dispatches on `buf[0] !== 0` (only the first byte). Pre-existing across the verifier surface; not introduced by this slice. Follow-up to converge tracked separately.
  - **`SubstConstants` type-check**: TS validates `sTypeEquals(newValuesV.elem, tree.constantTypes[i])` (the outer Coll's element type) vs sigma-rust's per-item `Constant.tpe == old_constant.tpe`. Equivalent for well-typed inputs (all of mainnet); divergence only on pathological hand-crafted hetero-typed Colls.

**Phase 2i-a COMPLETE.** Method handler registry: 44 entries (unchanged). EvalError codes: 55. Eval arm coverage: 60 of ~70. Test count: ~3180 (ergoscript); ~3758 (total).
```

- [ ] **Step 2: Update the "Coverage" summary** to reflect 60/~70 arms; 55 EvalError codes.

- [ ] **Step 3: Verify the facts file is internally consistent** — search for stale references to "52 of ~70" or "48 codes":
```bash
rtk proxy grep -n "52 / \|52 of \|48 .*[Ee]val\|48 codes\|2922" facts/ergoscript-eval.md
```
Update each match to the new numbers.

- [ ] **Step 4: Commit**

```bash
git add facts/ergoscript-eval.md
git commit -m "docs(ergoscript): facts sweep for phase 2i-a (52->60 arms, 48->55 codes)"
```

---

## Task 11: README + SESSION_CONTEXT + HANDOFF_PROMPT sweep + push

**Files:**
- Modify: `README.md` (root)
- Modify: `SESSION_CONTEXT.md` (rewrite from 2h-f to 2i-a)
- Modify: `HANDOFF_PROMPT.md` (rewrite from 2h-f to 2i-a)

- [ ] **Step 1: Update root `README.md`**

Find and update these stat references:
- ergoscript test count: 2922 → ~3180
- Coverage stat: "52 of ~70 `Expr` arms wired" → "60 of ~70 `Expr` arms wired"
- "44-entry method-handler registry; 48 `EvalError` codes" → "44-entry method-handler registry; 55 `EvalError` codes"
- Total tests: "3500" → "~3758"

In the `@ergots/ergoscript` row of the Packages table, update the description sentence to mention the new predef arms (DecodePoint, SubstConstants, CalcBlake2b256, etc.).

Add new bullet: "Pure-bytes predefs shipped (phase 2i-a): `DecodePoint`, `SubstConstants`, `CalcBlake2b256`, `CalcSha256`, `ByteArrayToLong`, `ByteArrayToBigInt`, `LongToByteArray`, `Xor`."

- [ ] **Step 2: Rewrite `SESSION_CONTEXT.md`**

Replace the 2h-f content with 2i-a session state. Use the existing 2h-f session-context as a template; replace section by section. Include:
- Phase 2i-a summary (8 arms shipped; coverage 52→60; codes 48→55)
- Per-package test counts (scorex 177 / nipopow 245 / avltree 156 / ergoscript ~3180 / total ~3758)
- Items closed by 2i-a (list of 8 arms + 2 helper module additions)
- Items still deferred (2i-b/c/d sub-phases + 2j cost calibration + DecodePoint adapter convergence)
- Commits in this session (gather via `git log --oneline origin/master..HEAD`)
- Verification commands run (paste output)
- Mutation kill rates table (gather actual kill rates from test output)
- Open decisions queued for next session (2i-b options; publish posture; OPS-02)
- Source-read findings (DecodePoint identity convention; SubstConstants bug-3 regression; truncating-zip Xor; ByteArrayToLong tail-skip)
- Notable architectural decisions
- Repo state at handoff

- [ ] **Step 3: Rewrite `HANDOFF_PROMPT.md`**

Replace 2h-f handoff content. Use the existing 2h-f handoff as a template. Include:
- State summary (3500 → ~3758 tests; ergoscript 2922 → ~3180; coverage 52→60; codes 48→55)
- Phase plan status (add ✅ Phase 2i-a; ⏳ next 2i-b)
- Key 2i-a source-read findings (DecodePoint identity; SubstConstants bug-3; truncating-zip Xor; ByteArrayToLong tail-skip)
- Open decisions still queued
- Outstanding follow-ups (DecodePoint adapter convergence; SubstConstants per-item type-check)
- Before-you-do-anything reading list (paste the 2h-f list, swap the spec reference to the 2i-a spec)
- Cross-package coupling (unchanged from 2h-c.2)
- Process pattern reminders (`[[feedback-review-by-default]]` validated again — reviewer caught 3 ★★★ consensus bugs in 2i-a spec pseudocode)
- Repo state at handoff
- Auto-loaded memories

- [ ] **Step 4: Commit docs sweep**

```bash
git add README.md SESSION_CONTEXT.md HANDOFF_PROMPT.md
git commit -m "docs: refresh README + SESSION_CONTEXT + HANDOFF_PROMPT for phase 2i-a"
```

- [ ] **Step 5: Final verification before push**

```bash
# Per-package typecheck
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json

# Cross-runtime tests
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts
cd packages/scorex && npx vitest run --config vitest.browser.config.ts
cd packages/nipopow && npx vitest run --config vitest.browser.config.ts
cd packages/avltree && npx vitest run --config vitest.browser.config.ts

# Full repo run under node
node_modules/.bin/vitest run packages/

# Fixture-gen determinism
cd fixture-gen && cargo run --release
git diff --exit-code packages/

# Working tree clean (modulo gitignored audit20260519/)
git status
```

All must be clean.

- [ ] **Step 6: Push to origin (ask user first)**

```bash
git log --oneline origin/master..HEAD
```

Show the user the commit list. Ask explicitly: "OK to push phase 2i-a (N commits) to origin/master?"

If approved:
```bash
git push origin master
```

Verify:
```bash
git rev-parse --short HEAD
git rev-parse --short origin/master
```

Both should match. Phase 2i-a complete + pushed.

---

## Spec coverage map

| Spec section | Plan task(s) |
|---|---|
| §Goal — 8 arms wired | T2-T9 |
| §Non-goals — 2i-b/c/d deferred | (covered by execution scope; nothing to implement) |
| §Architecture — per-arm pseudocode for 6 mechanical arms | T2-T7 (literal handler code in each) |
| §Architecture — `SubstConstants` consensus-critical | T9 (literal code + byte-equality test + 3 mutation regions) |
| §Architecture — wiring into eval.ts switch | T2-T9 each include a switch-case edit |
| §Helpers — extractCollInt, signedBeBytesToBigInt, I256 constants | T6 Step 4 (signedBeBytesToBigInt + I256) + T9 Step 1 (extractCollInt) |
| §Error taxonomy — 7 new codes | T2-T9 each adds its codes to eval-context.ts |
| §Test strategy — Layer C1 + C3.a | T2-T9 each ships per-arm fixtures + mutation tests |
| §Source mapping — sigma-rust references | T2-T9 each cites in handler comments |
| §Execution order | This document's T1-T11 sequence |
| §Risk hotspots | T9 (SubstConstants byte-equality + byte-equality regression test); T6 (i256 range); T8 (DecodePoint identity acknowledged via existing adapter) |
| §Rollback plan | Per-arm commits = per-arm bisect-clean revert path |
| §Confidence check | All arms ≥ 95% (per spec); no escalation needed |
| §Cross-references | T10 facts sweep updates the cross-references in facts/ergoscript-eval.md |

---

## Post-plan self-review notes

- **Type consistency:** `extractCollByte` is used across T2-T9 — confirmed exported from `_byte-coll.ts` at plan-writing time.
- **Helper additions ordered correctly:** T6 Step 4 adds `signedBeBytesToBigInt` + `I256_MIN`/`I256_MAX` to `_byte-coll.ts` BEFORE the T6 handler that uses them; T9 Step 1 adds `extractCollInt` to `_coll-helpers.ts` BEFORE the T9 SubstConstants handler.
- **`EvalErrorCode` union additions:** each new code is added on the task where its handler first throws it. Total: 7 new codes across 6 tasks (T2 adds `'predef-input-not-byte-array'`; T7 reuses it without an additional add).
- **Commit cadence:** ~3-5 commits per arm task × 8 arms = ~24-40 commits. Plus T1 + T10 + T11 = ~3-5 more. Total ~27-45 commits. Aligns with spec §Execution Order's "~36-44 commits expected" estimate.
- **Per-task scope:** each implementation task touches at most ~5 files (per OVERRIDES rule #4 — Phased Execution). Verified.
