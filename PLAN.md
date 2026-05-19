# Plan: Phase 2h-c.1 — SHeader runtime + 17 method handlers

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire 17 new method-call handlers in `@ergots/ergoscript` (15 `SHeader.*` property accessors at typeId 104, methodIds 1-15 + 2 `SContext.*` additions: `headers` at 101:2 and `LastBlockUtxoRootHash` at 101:9). Add the `SValue.Header` runtime variant (`Header` type imported from `@ergots/scorex`). Promote SHeader SValue wire format from `'not-implemented-phase-2a'` to a V3-gated parse/serialize via a new `treeVersion: number` parameter threaded through `parseSValue`/`serializeSValue`. Add 1 new `EvalError` code (`'header-obj-not-header'`) and 2 new wire-layer error codes (`SValueParseError`/`SValueSerializeError 'sheader-tree-version-too-low'`). Add `EvalContext.headers?: Header[]`. Net regression target: zero — all 3388 existing tests must remain green.

**Architecture:** Additive method-handler phase. Existing dispatcher (`eval/method-call.ts`) routes new entries with no structural changes. Wire-format unlock is a parameter threading change confined to ergoscript (no scorex API changes per brainstorm decision option B). `Header` runtime type is sourced from `@ergots/scorex` workspace dep (already declared during phase 2h-c.0). All 17 handlers follow **Pattern A** (cost charged BEFORE receiver inspection): 15 SHeader at Fixed(10), 2 SContext at Fixed(15). Per-handler cost values and projection semantics drawn from sigma-rust source-reads of `eval/sheader.rs`, `eval/scontext.rs`, `types/sheader.rs`, and `types/scontext.rs` against the pinned `integration/ergots` branch.

**Tech Stack:** TypeScript + vitest (cross-runtime: node + jsdom). No new runtime deps. Workspace dep on `@ergots/scorex@0.1.0`.

**Design spec:** `docs/specs/2026-05-19-ergoscript-phase-2h-c-1-sheader-design.md` (committed `a77f640` in this session).

---

## OVERRIDES preamble for every subagent dispatched against this plan

Every subagent implementing tasks below MUST receive this preamble (per `[[feedback-subagent-explicit-rules]]`):

> **OVERRIDES rules (project-wide; override conflicting defaults):**
>
> - **Rule #2 — Confidence escalation:** if confidence on a byte-format detail, V3 gating placement, identity-point encoding, or cost-charging order drops below 95%, halt and declare. Read sigma-rust source first.
> - **Rule #5 — Root-cause mandate:** no `try/catch` swallows, no retry loops, no flag-vars to skip broken logic. Fix the origin.
> - **Rule #6 — Forced verification:** run `npx tsc --noEmit -p packages/ergoscript/tsconfig.json` AND `npx vitest run packages/ergoscript/` after every implementation step; FIX all errors before claiming done.
> - **Rule #7 — Context decay:** after 10+ messages, re-read files before editing them.
> - **Rule #8 — Edit integrity:** read-edit-read around every edit. Max 3 edits to the same file without a verification read between batches.
>
> **TDD Iron Law:** no production code without a failing test first. Each handler gets its own red→green cycle backed by a sigma-rust-oracle fixture.
> **Source-first discipline:** read `~/projects/ergots/external/sigma-rust/...` for any wire-format / eval semantics. Notes drift; source is authoritative.
> **Browser-first hard rules** (CLAUDE.md): no `Buffer`, no `node:*`, no `process`, no WASM, no top-level await. ESM only.

---

## Phase ordering

Strict sequential — each phase depends on the previous landing cleanly:

1. **Phase 1** — `SValue.Header` discriminated-union variant + `EvalContext.headers?: Header[]` field; fix every exhaustive-switch site that TS surfaces.
2. **Phase 2** — Wire-format V3-gated SHeader SValue parse + serialize. Adds `treeVersion: number` parameter to `parseSValue`/`serializeSValue`; threads it through every recursive call site; adds `'sheader-tree-version-too-low'` codes on both error classes.
3. **Phase 3** — 15 `SHeader.*` method handlers + `'header-obj-not-header'` EvalError code. One handler per task (each its own red→green cycle, each backed by a fixture-gen oracle JSON).
4. **Phase 4** — 2 `SContext.*` method handlers (`headers` + `lastBlockUtxoRootHash`). Same red→green per handler.
5. **Phase 5** — V3 SHeader-constant wire-roundtrip fixtures (4-6) + mutation testing (~25-30 single-byte flips, ≥ 90% kill rate per fixture).
6. **Phase 6** — Update `facts/ergoscript-eval.md`, `facts/ergoscript-wire.md`, `facts/ergoscript.md`. Final verification across all 4 packages.

Per `[[feedback-no-artificial-stops]]`: drive Phase 1 → Phase 6 with per-task commits; only stop on verification failure or genuine surprise.

---

## Phase 1: `SValue.Header` variant + `EvalContext.headers` field

### Task 1.1 — Add `SValue.Header` variant to the discriminated union

**Files:**
- Modify: `packages/ergoscript/src/mir/types.ts:823-841` (the `SValue` type definition)

- [ ] **Step 1.1.1: Read the existing SValue union to confirm location and import section.**

```bash
sed -n '1,40p' /home/mwaddip/projects/ergots/packages/ergoscript/src/mir/types.ts
sed -n '823,841p' /home/mwaddip/projects/ergots/packages/ergoscript/src/mir/types.ts
```

Confirm: `Header` type is NOT yet imported from `@ergots/scorex` at the top of the file (it will be after this step).

- [ ] **Step 1.1.2: Add the `Header` import and `SValue.Header` variant.**

At the top of `packages/ergoscript/src/mir/types.ts`, add (after the existing `@ergots/scorex` import block if one exists, otherwise add a new one):

```ts
import type { Header } from '@ergots/scorex'
```

Then insert the new variant into the `SValue` union immediately after the existing `PreHeader` variant (line 833). The block becomes:

```ts
export type SValue =
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Byte'; value: number }
  | { kind: 'Short'; value: number }
  | { kind: 'Int'; value: number }
  | { kind: 'Long'; value: bigint }
  | { kind: 'BigInt'; value: bigint }
  | { kind: 'GroupElement'; value: Uint8Array }
  | { kind: 'SigmaProp'; value: SigmaBoolean }
  | { kind: 'Box'; value: ErgoBox }
  | { kind: 'PreHeader'; value: PreHeader }
  | { kind: 'Header'; value: Header }              // NEW phase 2h-c.1
  | { kind: 'AvlTree'; value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Context' }
  | { kind: 'Global' }
  | { kind: 'Coll'; elem: SType; items: SValue[] }
  | { kind: 'Tuple'; items: SValue[] }
  | { kind: 'Option'; elem: SType; value: SValue | null }
  | { kind: 'Lambda'; closure: Closure }
```

- [ ] **Step 1.1.3: Run typecheck — expect a fresh set of exhaustiveness errors.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -50
```

Expected: multiple errors like `Type 'never' is not assignable to type 'SValue'` or `Argument of type '{ kind: "Header"; value: Header; }' is not assignable to parameter of type 'never'` at every exhaustive switch over `SValue.kind`. These are intentional — Phase 1 fixes them. Capture the file list:

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | grep -E "error TS" | grep -oE 'src/[^(]+' | sort -u
```

The file list output is the input to Task 1.2.

### Task 1.2 — Fix every exhaustive-switch site that flagged

**Files:**
- Modify: every file from Task 1.1.3 output (typically 2-5 files; primary suspect is `packages/ergoscript/src/eval/svalue-equals.ts` or wherever `sValueEquals` lives; secondary suspects include `wire/serialize-svalue.ts`)

- [ ] **Step 1.2.1: For each flagged file, locate the switch and add a `case 'Header':` arm.**

Pattern (mirroring the existing `case 'Box':` / `case 'AvlTree':` arms in `sValueEquals`):

```ts
case 'Header':
  throw new EvalError(
    `sValueEquals: SValue.kind='Header' is not implemented yet`,
    'not-implemented-yet'
  )
```

For `serialize-svalue.ts` (if flagged), the switch is over `SType.tag` and dispatches into `SValue.kind` — likely a defensive cross-check rather than a true exhaustive switch. Add the `'Header'` case mapping the `SValue.kind` to the `SType.SHeader` path: when `tpe.tag === 'SHeader'` and `v.kind !== 'Header'`, throw `'type-value-mismatch'` (existing code).

- [ ] **Step 1.2.2: Verify typecheck clean after fixing all sites.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -10
```

Expected: zero errors. If any remain, repeat Task 1.2.1.

- [ ] **Step 1.2.3: Run existing test suite to verify no semantic regression.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/ 2>&1 | tail -20
```

Expected: 2810 tests pass (the existing ergoscript test count before this phase). If any test now fails, the most likely cause is an exhaustive-switch site that needs `case 'Header':` handling beyond a bare throw.

### Task 1.3 — Add `EvalContext.headers?: Header[]` field

**Files:**
- Modify: `packages/ergoscript/src/eval/eval-context.ts`

- [ ] **Step 1.3.1: Read the existing EvalOpts/EvalContext to confirm location of chain-state field declarations.**

```bash
grep -n "preHeader\?\|dataInputs\?\|EvalOpts\|EvalContext" /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/eval-context.ts | head -20
```

- [ ] **Step 1.3.2: Add the `headers?: Header[]` field and `Header` import.**

Add to the imports section (at the top of `eval-context.ts`):

```ts
import type { Header } from '@ergots/scorex'
```

Add to the `EvalOpts` interface alongside `preHeader?: PreHeader`, `dataInputs?: ErgoBox[]`, etc.:

```ts
/** Block headers; sigma-rust uses fixed-size [Header; 10] — TS relaxes to variable length. */
headers?: Header[]
```

`EvalContext` inherits from `EvalOpts`, so no separate declaration there.

- [ ] **Step 1.3.3: Verify typecheck clean.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -5
```

Expected: clean.

### Task 1.4 — Commit Phase 1

- [ ] **Step 1.4.1: Stage and commit.**

```bash
cd /home/mwaddip/projects/ergots && git add packages/ergoscript/src/mir/types.ts packages/ergoscript/src/eval/eval-context.ts packages/ergoscript/src/eval/svalue-equals.ts packages/ergoscript/src/wire/serialize-svalue.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): add SValue.Header variant + EvalContext.headers field

Phase 2h-c.1 Step 1. Additive type-level change: introduces the
{ kind: 'Header'; value: Header } SValue variant (Header imported from
@ergots/scorex) and the EvalOpts/EvalContext.headers?: Header[] chain-state
field. Updates every exhaustive SValue.kind switch site to throw
'not-implemented-yet' for the new variant (matches existing Box/AvlTree
arms in sValueEquals). No semantic change to existing eval paths.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 1.4.2: Verify commit landed.**

```bash
git -C /home/mwaddip/projects/ergots log --oneline -2
```

---

## Phase 2: Wire-format V3-gated SHeader SValue parse + serialize

This phase changes the signature of `parseSValue` / `serializeSValue` by adding a `treeVersion: number` parameter. Threading this through every recursive callsite is mechanical but easy to miss one — TS's exhaustive switch will catch missing forwards at compile time.

### Task 2.1 — Add `'sheader-tree-version-too-low'` to wire-layer error codes

**Files:**
- Modify: `packages/ergoscript/src/wire/errors.ts` (or wherever `SValueParseError` / `SValueSerializeError` are declared)

- [ ] **Step 2.1.1: Locate the error class declarations.**

```bash
grep -n "SValueParseError\|SValueSerializeError" /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/errors.ts
```

- [ ] **Step 2.1.2: Add `'sheader-tree-version-too-low'` to both unions.**

For `SValueParseError`, add the code to the `code:` type union and any code-list comment:

```ts
| 'sheader-tree-version-too-low'   // SHeader SValue literal at tree-version < 3; mirrors sigma-rust data.rs:196 NotSupported
```

For `SValueSerializeError`, same code:

```ts
| 'sheader-tree-version-too-low'   // SHeader SValue value with tree-version < 3; mirrors sigma-rust data.rs:98 NotSupported
```

- [ ] **Step 2.1.3: Verify typecheck clean.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -5
```

### Task 2.2 — Add `treeVersion` parameter to `parseSValue` signature

**Files:**
- Modify: `packages/ergoscript/src/wire/parse-svalue.ts`
- Modify: every caller of `parseSValue` (locate via grep)

- [ ] **Step 2.2.1: Find every caller of `parseSValue` in the codebase.**

```bash
rtk proxy grep -rn "parseSValue(" /home/mwaddip/projects/ergots/packages/ergoscript/src/ --include "*.ts"
```

Document the call sites: typically `parse-tree.ts` (envelope entry), recursive call sites inside `parse-svalue.ts` itself (`Coll`, `Tuple`, `Option` arms).

- [ ] **Step 2.2.2: Change `parseSValue` signature.**

Update `packages/ergoscript/src/wire/parse-svalue.ts`:

```ts
// Before:
export function parseSValue(tpe: SType, r: ByteReader): SValue { ... }

// After:
export function parseSValue(tpe: SType, treeVersion: number, r: ByteReader): SValue { ... }
```

Within `parseSValue`'s recursive call sites (Coll arm, Tuple arm, Option arm), forward `treeVersion`:

```ts
// Coll arm:
items.push(parseSValue(elemTpe, treeVersion, r))

// Tuple arm:
items.push(parseSValue(itemTpe, treeVersion, r))

// Option arm:
const inner = parseSValue(elemTpe, treeVersion, r)
```

- [ ] **Step 2.2.3: Update every caller of `parseSValue`.**

For each caller from Step 2.2.1, inject `treeVersion`:

- `parse-tree.ts`: `treeVersion` is already available as `tree.header.version` (or wherever the parsed header is in scope at the time of constant-section parsing). Inject it into the constants-section loop call.

```ts
// In parseTree, where constants are parsed:
const constValue = parseSValue(constType, header.version, r)
```

- [ ] **Step 2.2.4: Verify typecheck clean.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -10
```

Expected: clean. If any "expected 3 arguments, got 2" errors remain, fix the missed call site.

### Task 2.3 — TDD red: V3 parse of SHeader SValue literal

**Files:**
- Create: `packages/ergoscript/test/wire/svalue-sheader-v3-parse.test.ts`

- [ ] **Step 2.3.1: Write the failing test.**

```ts
// packages/ergoscript/test/wire/svalue-sheader-v3-parse.test.ts
import { describe, expect, test } from 'vitest'
import { parseSValue } from '../../src/wire/parse-svalue'
import { ByteReader, parseHeader } from '@ergots/scorex'
import type { SType } from '../../src/mir/types'

// A real mainnet V2 header serialized for reuse — sourced from nipopow's fixtures.
// Test setup: serialize one to bytes (using scorex's serializeHeader), then assert
// parseSValue(SHeader, treeVersion=3, r) returns { kind: 'Header', value: <parsed> }.

describe('parseSValue SHeader V3 gating', () => {
  test('parses SHeader at tree-version 3', () => {
    const headerBytes = loadHeaderFixtureBytes() // helper: returns Uint8Array of one full mainnet header
    const r = new ByteReader(headerBytes)
    const SHEADER: SType = { tag: 'SHeader' }

    const v = parseSValue(SHEADER, 3, r)

    expect(v.kind).toBe('Header')
    expect((v as { kind: 'Header'; value: { id: Uint8Array } }).value.id).toBeInstanceOf(Uint8Array)
    expect((v as { kind: 'Header'; value: { id: Uint8Array } }).value.id.length).toBe(32)
  })

  test('rejects SHeader at tree-version 2 with sheader-tree-version-too-low', () => {
    const headerBytes = loadHeaderFixtureBytes()
    const r = new ByteReader(headerBytes)
    const SHEADER: SType = { tag: 'SHeader' }

    expect(() => parseSValue(SHEADER, 2, r)).toThrowError(
      expect.objectContaining({ code: 'sheader-tree-version-too-low' })
    )
  })
})

function loadHeaderFixtureBytes(): Uint8Array {
  // Implementation: load from packages/ergoscript/test/fixtures/headers/header-v2-mainnet.bin
  // The bytes are produced once by fixture-gen (Phase 5) and stored as a static binary fixture.
  // For Task 2.3 (red), this returns a minimal placeholder buffer that will fail parseHeader
  // — the test still verifies the signature/error-code path correctly.
  throw new Error('TODO Task 2.4: replace with real header bytes loaded from disk')
}
```

- [ ] **Step 2.3.2: Run the test — expect failure with "function not defined" or "TODO" message.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/wire/svalue-sheader-v3-parse.test.ts 2>&1 | tail -20
```

Expected: FAIL. Most likely because the `SHeader` arm in `parseSValue` still throws `'not-implemented-phase-2a'`.

### Task 2.4 — TDD green: implement the SHeader arm in `parseSValue`

**Files:**
- Modify: `packages/ergoscript/src/wire/parse-svalue.ts` (the SHeader arm)
- Create: `packages/ergoscript/test/fixtures/headers/header-v2-mainnet.bin` (and a `.json` companion if useful)

- [ ] **Step 2.4.1: Generate the test fixture header bytes.**

Use scorex's `serializeHeader` to produce the binary from an existing test-side `Header` instance. Easiest path: pick a real mainnet header from `packages/nipopow/test/fixtures/headers/` (or load via nipopow's `parseHeader` and re-serialize) and copy the resulting bytes to `packages/ergoscript/test/fixtures/headers/header-v2-mainnet.bin`.

```bash
ls /home/mwaddip/projects/ergots/packages/nipopow/test/fixtures/headers/ | head
```

Identify one V2 header fixture; copy its raw `.bin` form into the ergoscript test fixtures directory.

```bash
mkdir -p /home/mwaddip/projects/ergots/packages/ergoscript/test/fixtures/headers
cp /home/mwaddip/projects/ergots/packages/nipopow/test/fixtures/headers/<v2-header>.bin /home/mwaddip/projects/ergots/packages/ergoscript/test/fixtures/headers/header-v2-mainnet.bin
```

Update the `loadHeaderFixtureBytes()` helper in the test:

```ts
import fs from 'node:fs'
function loadHeaderFixtureBytes(): Uint8Array {
  // Note: fs is fine in tests (test runner is node); production code does NOT use it.
  return new Uint8Array(fs.readFileSync('packages/ergoscript/test/fixtures/headers/header-v2-mainnet.bin'))
}
```

- [ ] **Step 2.4.2: Replace the SHeader arm's `'not-implemented-phase-2a'` throw with V3-gated parsing.**

In `parse-svalue.ts`, locate the existing SHeader arm (currently throws `'not-implemented-phase-2a'`) and replace with:

```ts
case 'SHeader': {
  if (treeVersion < 3) {
    throw new SValueParseError(
      `SHeader SValue requires tree-version >= 3; got treeVersion=${treeVersion}`,
      'sheader-tree-version-too-low'
    )
  }
  const header = parseHeader(r)
  return { kind: 'Header', value: header }
}
```

Add the `parseHeader` import at the top of the file:

```ts
import { parseHeader } from '@ergots/scorex'
```

- [ ] **Step 2.4.3: Run the test — expect pass.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/wire/svalue-sheader-v3-parse.test.ts 2>&1 | tail -10
```

Expected: both tests PASS.

### Task 2.5 — TDD red/green: serialize side

**Files:**
- Modify: `packages/ergoscript/src/wire/serialize-svalue.ts`
- Modify: `packages/ergoscript/src/wire/serialize.ts` (or wherever `serializeTree` lives) — thread `treeVersion` into the constants-section serialize loop
- Create: `packages/ergoscript/test/wire/svalue-sheader-v3-serialize.test.ts`

- [ ] **Step 2.5.1: Add the failing serialize test.**

```ts
// packages/ergoscript/test/wire/svalue-sheader-v3-serialize.test.ts
import { describe, expect, test } from 'vitest'
import { ByteReader, ByteWriter, parseHeader } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import type { SType, SValue } from '../../src/mir/types'
import { loadHeaderFixtureBytes } from './_fixture-helpers'

const SHEADER: SType = { tag: 'SHeader' }

describe('serializeSValue SHeader V3 gating', () => {
  test('serializes SHeader at tree-version 3 byte-equal to scorex serializeHeader', () => {
    const headerBytes = loadHeaderFixtureBytes()
    const v = parseSValue(SHEADER, 3, new ByteReader(headerBytes))

    const w = new ByteWriter()
    serializeSValue(SHEADER, v, 3, w)
    expect(w.toBytes()).toEqual(headerBytes)
  })

  test('rejects SHeader at tree-version 2 with sheader-tree-version-too-low', () => {
    const headerBytes = loadHeaderFixtureBytes()
    const v = parseSValue(SHEADER, 3, new ByteReader(headerBytes))

    const w = new ByteWriter()
    expect(() => serializeSValue(SHEADER, v, 2, w)).toThrowError(
      expect.objectContaining({ code: 'sheader-tree-version-too-low' })
    )
  })
})
```

(Move the `loadHeaderFixtureBytes` helper into `_fixture-helpers.ts` and import in both parse + serialize tests to DRY.)

- [ ] **Step 2.5.2: Run — expect failure.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/wire/svalue-sheader-v3-serialize.test.ts 2>&1 | tail -10
```

- [ ] **Step 2.5.3: Update `serializeSValue` signature + implement the SHeader arm.**

```ts
// Before:
export function serializeSValue(tpe: SType, v: SValue, w: ByteWriter): void { ... }

// After:
export function serializeSValue(tpe: SType, v: SValue, treeVersion: number, w: ByteWriter): void { ... }
```

Within the function, forward `treeVersion` to every recursive call site (Coll, Tuple, Option arms). For the SHeader arm:

```ts
case 'SHeader': {
  if (treeVersion < 3) {
    throw new SValueSerializeError(
      `SHeader SValue requires tree-version >= 3; got treeVersion=${treeVersion}`,
      'sheader-tree-version-too-low'
    )
  }
  if (v.kind !== 'Header') {
    throw new SValueSerializeError(
      `serializeSValue(SHeader, ...): value kind '${v.kind}' does not match SHeader`,
      'type-value-mismatch'
    )
  }
  const bytes = serializeHeader(v.value)
  w.writeBytes(bytes)
  break
}
```

Add the import:

```ts
import { serializeHeader } from '@ergots/scorex'
```

- [ ] **Step 2.5.4: Find and update every caller of `serializeSValue`.**

```bash
rtk proxy grep -rn "serializeSValue(" /home/mwaddip/projects/ergots/packages/ergoscript/src/ --include "*.ts"
```

Update each caller (primary: `serialize-tree.ts` constants-section loop) to inject `treeVersion`:

```ts
// In serializeTree, where constants are serialized:
serializeSValue(constType, constValue, tree.header.version, w)
```

- [ ] **Step 2.5.5: Run serialize test — expect pass.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/wire/svalue-sheader-v3-serialize.test.ts 2>&1 | tail -10
```

Expected: both serialize tests PASS.

### Task 2.6 — Verify Phase 2 + commit

- [ ] **Step 2.6.1: Full typecheck + test suite.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -5
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/ 2>&1 | tail -5
```

Expected: typecheck clean; **2810 + 4 (new V3 gating tests) = 2814 tests pass**, no regressions.

- [ ] **Step 2.6.2: Commit Phase 2.**

```bash
cd /home/mwaddip/projects/ergots && git add packages/ergoscript/src/wire/parse-svalue.ts packages/ergoscript/src/wire/serialize-svalue.ts packages/ergoscript/src/wire/errors.ts packages/ergoscript/src/wire/parse.ts packages/ergoscript/src/wire/serialize.ts packages/ergoscript/test/wire/
git add packages/ergoscript/test/fixtures/headers/
git commit -m "$(cat <<'EOF'
feat(ergoscript): V3-gated SHeader SValue wire format

Phase 2h-c.1 Step 2. Replaces the 'not-implemented-phase-2a' throw for
SHeader SValue parse + serialize with a V3-gated implementation delegating
to @ergots/scorex's parseHeader / serializeHeader. Mirrors sigma-rust
ergotree-ir/src/serialization/data.rs:196 (parse) and :98 (serialize).

Signature change: parseSValue and serializeSValue gain a treeVersion: number
parameter that threads through every recursive callsite (Coll, Tuple, Option
arms). parseTree and serializeTree inject treeVersion from tree.header.version.

Adds 'sheader-tree-version-too-low' code to both SValueParseError and
SValueSerializeError code unions. Drops SHeader from the
'not-implemented-phase-2a' emitting set in both error classes.

Tests: 4 new (parse + serialize, V3 success + V<3 rejection). Fixture
header-v2-mainnet.bin sourced from nipopow's fixture corpus.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: 15 SHeader method handlers

The 15 handlers are isomorphic by structure: each follows Pattern A Fixed(10), defensive `obj.kind === 'Header'` check via `assertHeaderObj(obj)`, and projects a single Header field into the appropriate SValue. Implementation lives in a new `eval/sheader.ts` module (mirrors the `eval/savltree.ts` pattern from phase 2h-b).

### Task 3.1 — Add `'header-obj-not-header'` EvalError code

**Files:**
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (or wherever `EvalError.code` type union lives)

- [ ] **Step 3.1.1: Locate the `EvalError` code union.**

```bash
grep -n "EvalErrorCode\|'avl-tree-obj-not-avl-tree'\|'context-obj-not-context'" /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/eval-context.ts
```

- [ ] **Step 3.1.2: Add the new code.**

Insert `'header-obj-not-header'` into the `EvalErrorCode` type union (alphabetical placement preferred; adjacent to `'avl-tree-obj-not-avl-tree'` works):

```ts
| 'header-obj-not-header'      // SHeader.* handlers: obj is not an SValue.Header
```

- [ ] **Step 3.1.3: Verify typecheck clean.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -5
```

### Task 3.2 — Create `eval/sheader.ts` skeleton + `assertHeaderObj` helper

**Files:**
- Create: `packages/ergoscript/src/eval/sheader.ts`

- [ ] **Step 3.2.1: Write the skeleton file.**

```ts
// packages/ergoscript/src/eval/sheader.ts
/**
 * SHeader method handlers — 15 property accessors (typeId 104, methodIds 1-15).
 *
 * All handlers follow Pattern A Fixed(10): ctx.addCost(10) → assertHeaderObj(obj)
 * → project a Header field into an SValue.
 *
 * Source: ergotree-interpreter/src/eval/sheader.rs at sigma-rust integration/ergots branch.
 * Per-method line refs in each handler's doc-comment.
 *
 * Error codes originated here:
 *   'header-obj-not-header'    — defensive receiver check; thrown by all 15 handlers
 *                                 when obj.kind !== 'Header'. Wire-format invariants
 *                                 make this unreachable for parser-produced trees.
 */

import type { Header } from '@ergots/scorex'
import { EvalError, type EvalContext } from './eval-context'
import { bytesToCollByteSValue } from './_byte-coll'
import type { SValue } from '../mir/types'

/** Defensive receiver check shared by all 15 SHeader handlers. */
function assertHeaderObj(obj: SValue, methodName: string): asserts obj is SValue & { kind: 'Header' } {
  if (obj.kind !== 'Header') {
    throw new EvalError(
      `SHeader.${methodName} expects a Header obj; got '${obj.kind}'`,
      'header-obj-not-header'
    )
  }
}

// 15 handler exports — one per Header property. Each charges Fixed(10) BEFORE the obj check.
// Handlers are added in Tasks 3.3 through 3.17 (one task per handler).
```

- [ ] **Step 3.2.2: Verify typecheck clean (no handler implementations yet).**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -5
```

### Task 3.3 — Implement `SHeader.id` (104:1)

**Files:**
- Modify: `packages/ergoscript/src/eval/sheader.ts` (add handler export)
- Modify: `packages/ergoscript/src/eval/method-call.ts` (register handler)
- Create: `packages/ergoscript/test/fixtures/eval/sheader-id.json` (oracle fixture)
- Create: `packages/ergoscript/test/eval/sheader-handlers.test.ts` (first test entry)

- [ ] **Step 3.3.1: Generate the oracle fixture using fixture-gen.**

The fixture-gen Rust side produces `{ exprBytes (hex), expectedValue (JSON), expectedJitCost (number) }` for each handler call. For `SHeader.id`, the Rust setup is:

```rust
// fixture-gen/src/sheader_handlers.rs (NEW)
use ergotree_ir::mir::{coll_by_index::ByIndex, expr::Expr, property_call::PropertyCall};
use ergotree_ir::types::{scontext::HEADERS_PROPERTY, sheader::ID_PROPERTY};
// ... build PropertyCall(ByIndex(PropertyCall(Context, headers), 0), ID_PROPERTY)
//     run try_eval_out with a mainnet header in ctx.headers[0]
//     emit JSON fixture
```

Write the Rust generator following the pattern of the existing SAvlTree fixture-gen module (`fixture-gen/src/savltree_handlers.rs` or similar). Run:

```bash
cd /home/mwaddip/projects/ergots/fixture-gen && cargo run --release 2>&1 | tail -5
```

Verify the fixture lands at `packages/ergoscript/test/fixtures/eval/sheader-id.json`.

- [ ] **Step 3.3.2: Write the failing test.**

```ts
// packages/ergoscript/test/eval/sheader-handlers.test.ts
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluateWith, makeContext } from '../../src/eval'
import { parseTree } from '../../src/wire/parse-tree'

interface Fixture {
  exprBytes: string         // hex
  expectedValueJson: unknown
  expectedJitCost: number
  ctxHeaders?: Array<{ /* serialized Header JSON */ }>
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(`packages/ergoscript/test/fixtures/eval/${name}.json`, 'utf8')) as Fixture
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
}

describe('SHeader handlers — Phase 2h-c.1', () => {
  test('SHeader.id (104:1) Fixed(10)', () => {
    const fx = loadFixture('sheader-id')
    const tree = parseTree(hexToBytes(fx.exprBytes))
    const ctx = makeContext({ headers: fx.ctxHeaders!.map(toRuntimeHeader) })
    const result = evaluateWith(tree, ctx)
    expect(toJsonComparable(result)).toEqual(fx.expectedValueJson)
    expect(ctx.jitCost).toBe(fx.expectedJitCost)
  })
})

// Helpers: toRuntimeHeader converts fixture-side Header JSON to runtime Header type
// (handle Uint8Array<->hex). toJsonComparable serializes SValue to a stable JSON shape.
// Both helpers exist in test/_helpers.ts (consider extracting if not already).
function toRuntimeHeader(_h: unknown): never { throw new Error('TODO: implement in _helpers.ts') }
function toJsonComparable(_v: unknown): unknown { throw new Error('TODO: implement in _helpers.ts') }
```

- [ ] **Step 3.3.3: Run — expect failure.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/eval/sheader-handlers.test.ts 2>&1 | tail -10
```

- [ ] **Step 3.3.4: Implement the helpers + `evalSHeaderId` handler.**

Implement `toRuntimeHeader` and `toJsonComparable` (or expand `_helpers.ts`). Then in `eval/sheader.ts`:

```ts
export function evalSHeaderId(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(10) // Pattern A; source: eval/sheader.rs:22-26
  assertHeaderObj(obj, 'id')
  return bytesToCollByteSValue(obj.value.id)
}
```

Register in `eval/method-call.ts` `registerHandlers()` (insert in source-id order — typeId=104, methodId=1):

```ts
// SHeader.id (PropertyCall, typeId=104, methodId=1)
// Source: ergotree-interpreter/src/eval/sheader.rs:22-26 — ID_EVAL_FN
HANDLERS.set(handlerKey(104, 1), (obj, args, ctx) => evalSHeaderId(obj, args, ctx))
```

Add the import at the top of `method-call.ts`:

```ts
import { evalSHeaderId } from './sheader'
```

- [ ] **Step 3.3.5: Run test — expect pass.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/eval/sheader-handlers.test.ts 2>&1 | tail -10
```

### Task 3.4 — Task 3.17: Implement the remaining 14 SHeader handlers

Each task follows the identical pattern as Task 3.3 (fixture-gen → red test → handler implementation → registry → green test). The 14 remaining handlers, in order:

| Task | Method | typeId:methodId | Field projection | Return shape | Source |
|---|---|---|---|---|---|
| 3.4 | `version` | 104:2 | `header.version` | `{ kind: 'Byte', value: ((header.version << 24) >> 24) }` (u8 → i8 sign-extend) | `sheader.rs:16-20` |
| 3.5 | `parentId` | 104:3 | `header.parentId` | `bytesToCollByteSValue(header.parentId)` | `:28-32` |
| 3.6 | `adProofsRoot` | 104:4 | `header.adProofsRoot` | `bytesToCollByteSValue(header.adProofsRoot)` | `:34-38` |
| 3.7 | `stateRoot` | 104:5 | `header.stateRoot` (33 bytes) | `bytesToCollByteSValue(header.stateRoot)` — **see quirk note in design spec** | `:40-44` |
| 3.8 | `transactionsRoot` | 104:6 | `header.transactionRoot` (scorex field name singular; method name plural) | `bytesToCollByteSValue(header.transactionRoot)` | `:46-50` |
| 3.9 | `timestamp` | 104:7 | `header.timestamp` (`number`) | `{ kind: 'Long', value: BigInt(header.timestamp) }` | `:58-62` |
| 3.10 | `nBits` | 104:8 | `header.nBits` (`number`) | `{ kind: 'Long', value: BigInt(header.nBits) }` | `:64-68` |
| 3.11 | `height` | 104:9 | `header.height` (`number`) | `{ kind: 'Int', value: header.height \| 0 }` (force i32) | `:70-74` |
| 3.12 | `extensionRoot` | 104:10 | `header.extensionRoot` | `bytesToCollByteSValue(header.extensionRoot)` | `:52-56` |
| 3.13 | `minerPk` | 104:11 | `header.autolykosSolution.minerPk` (33 bytes) | `{ kind: 'GroupElement', value: header.autolykosSolution.minerPk }` | `:76-80` |
| 3.14 | `powOnetimePk` | 104:12 | `header.autolykosSolution.powOnetimePk` (nullable) | `{ kind: 'GroupElement', value: header.autolykosSolution.powOnetimePk ?? new Uint8Array(33) }` — **33 zero bytes when null** (identity point) | `:82-86` |
| 3.15 | `powNonce` | 104:13 | `header.autolykosSolution.nonce` (8 bytes) | `bytesToCollByteSValue(header.autolykosSolution.nonce)` | `:88-92` |
| 3.16 | `powDistance` | 104:14 | `header.autolykosSolution.powDistance` (nullable bigint) | `{ kind: 'BigInt', value: header.autolykosSolution.powDistance ?? 0n }` — **0n when null** | `:94-107` |
| 3.17 | `votes` | 104:15 | `header.votes` (3 bytes) | `bytesToCollByteSValue(header.votes)` | `:109-113` |

For EACH task (3.4 through 3.17), the 5 steps are:

- [ ] **Step N.1: Extend `fixture-gen/src/sheader_handlers.rs` to emit the fixture for this method.** Verify `cargo run` writes `packages/ergoscript/test/fixtures/eval/sheader-<methodName>.json` deterministically (same input headers → identical output across runs).

- [ ] **Step N.2: Add the failing test entry inside the existing `describe('SHeader handlers ...')` block.** Use the same shape as Task 3.3.2's test — load fixture, parse tree, evaluate, assert value + jitCost. Expected: FAIL ("method not implemented" — dispatch miss).

- [ ] **Step N.3: Add the handler export to `eval/sheader.ts`.** Use the precise field-projection shape from the table. Cost is always `ctx.addCost(10)`. Defensive check is `assertHeaderObj(obj, '<methodName>')`.

- [ ] **Step N.4: Register the handler in `eval/method-call.ts`.** Insert in numeric order by methodId. Add the import for the new `eval<MethodName>` export. After the registry edit, perform the audit-step diff:

```bash
git diff /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/method-call.ts | grep "HANDLERS.set"
```

Confirm the new line uses the documented `(typeId, methodId)` keys and that no existing entries were moved or modified.

- [ ] **Step N.5: Run the test — expect pass.** Verify `jitCost` matches the fixture's `expectedJitCost` byte-for-byte (well, integer-equal). Verify SValue return shape byte-equal for byte-collection cases, value-equal for Long/Int/BigInt cases.

### Task 3.18 — `'header-obj-not-header'` defensive coverage

**Files:**
- Modify: `packages/ergoscript/test/eval/sheader-handlers.test.ts` (add parameterized throw-path tests)

- [ ] **Step 3.18.1: Add parameterized "non-Header obj" tests across 3 representative handlers.**

Pick handlers from different return-kind categories: `id` (Coll[Byte]), `height` (Int), `minerPk` (GroupElement). For each, construct a `MethodCall` whose `obj` evaluates to a non-Header SValue (e.g., a Long constant) and assert `EvalError('header-obj-not-header')` is thrown.

```ts
import { EvalError } from '../../src/eval/eval-context'

describe('SHeader.* defensive obj-kind check', () => {
  test.each([
    ['SHeader.id (104:1)', 104, 1, 'id'],
    ['SHeader.height (104:9)', 104, 9, 'height'],
    ['SHeader.minerPk (104:11)', 104, 11, 'minerPk'],
  ])('%s throws header-obj-not-header on non-Header obj', (_label, typeId, methodId, methodName) => {
    // Construct a hand-built PropertyCall with obj=Const(Long, 42n), method=<methodId>
    // Evaluate; expect throw.
    const expr = buildPropertyCallWithLongObj(typeId, methodId)
    expect(() => evaluateExpr(expr)).toThrow(
      expect.objectContaining({ code: 'header-obj-not-header' })
    )
  })
})
```

(Helper `buildPropertyCallWithLongObj` is small — synthesizes the Expr tree by hand without fixture-gen.)

- [ ] **Step 3.18.2: Run — expect pass.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/eval/sheader-handlers.test.ts 2>&1 | tail -10
```

### Task 3.19 — Verify Phase 3 + commit

- [ ] **Step 3.19.1: Full ergoscript test suite.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -5
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/ 2>&1 | tail -5
```

Expected: 2814 + 15 (per-handler) + 3 (parameterized defensive) = **2832 tests pass**.

- [ ] **Step 3.19.2: Commit Phase 3.**

```bash
cd /home/mwaddip/projects/ergots && git add packages/ergoscript/src/eval/sheader.ts packages/ergoscript/src/eval/method-call.ts packages/ergoscript/src/eval/eval-context.ts packages/ergoscript/test/eval/sheader-handlers.test.ts packages/ergoscript/test/fixtures/eval/sheader-*.json fixture-gen/src/sheader_handlers.rs fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): 15 SHeader method handlers + 'header-obj-not-header' code

Phase 2h-c.1 Step 3. Wires the 15 SHeader.* property accessors at typeId 104,
methodIds 1-15. All Pattern A Fixed(10) — ctx.addCost(10) before
assertHeaderObj() defensive receiver check, then projects a Header field.

Per-handler return shapes (sigma-rust eval/sheader.rs lines 16-113):
  id (1) parentId (3) adProofsRoot (4) stateRoot (5) transactionsRoot (6)
  extensionRoot (10) powNonce (13) votes (15) → Coll[Byte]
  version (2) → Byte (u8→i8 sign-extend)
  timestamp (7) nBits (8) → Long (bigint)
  height (9) → Int (i32)
  minerPk (11) powOnetimePk (12) → GroupElement (33 bytes)
  powDistance (14) → BigInt

V2-header semantics: powOnetimePk returns 33 zero bytes when null (identity
point per EcPoint::default() → scorex_serialize); powDistance returns 0n.

New EvalError code: 'header-obj-not-header' (defensive; 45→46 codes total).

Tests: 15 oracle fixtures (one per handler) + 3 parameterized defensive throws.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: 2 SContext method handlers (`headers` + `lastBlockUtxoRootHash`)

Both extend the existing `eval/method-call.ts` registry. Pattern A Fixed(15). Both check `obj.kind === 'Context'` (existing `'context-obj-not-context'` code) and `ctx.headers !== undefined` (existing `'context-field-missing'` code).

### Task 4.1 — `SContext.headers` (101:2)

**Files:**
- Modify: `packages/ergoscript/src/eval/method-call.ts` (add handler registration + helper)
- Create: `packages/ergoscript/test/fixtures/eval/scontext-headers.json` (oracle fixture)
- Modify: `packages/ergoscript/test/eval/scontext-handlers.test.ts` (extend existing file from 2g.5/2g.6)

- [ ] **Step 4.1.1: Generate the oracle fixture.**

Extend `fixture-gen/src/sheader_handlers.rs` (or create `fixture-gen/src/scontext_headers.rs`) to emit a fixture exercising `PropertyCall(Context, HEADERS_PROPERTY)`. Verify deterministic output.

- [ ] **Step 4.1.2: Write the failing test.**

```ts
// in scontext-handlers.test.ts (extend existing file)
test('SContext.headers (101:2) Fixed(15) returns Coll[Header]', () => {
  const fx = loadFixture('scontext-headers')
  const tree = parseTree(hexToBytes(fx.exprBytes))
  const ctx = makeContext({ headers: fx.ctxHeaders!.map(toRuntimeHeader) })
  const result = evaluateWith(tree, ctx)
  expect(result.kind).toBe('Coll')
  expect((result as { kind: 'Coll'; items: SValue[] }).items.length).toBe(fx.ctxHeaders!.length)
  expect(ctx.jitCost).toBe(fx.expectedJitCost)
})

test('SContext.headers throws context-field-missing when ctx.headers undefined', () => {
  const fx = loadFixture('scontext-headers')
  const tree = parseTree(hexToBytes(fx.exprBytes))
  const ctx = makeContext({}) // no headers
  expect(() => evaluateWith(tree, ctx)).toThrow(
    expect.objectContaining({ code: 'context-field-missing' })
  )
})
```

- [ ] **Step 4.1.3: Run — expect failure.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/eval/scontext-handlers.test.ts 2>&1 | tail -10
```

- [ ] **Step 4.1.4: Implement the handler in `eval/method-call.ts`.**

Inside `registerHandlers()`, add (locate near the existing SContext entries — `dataInputs` 101:1 and `preHeader` 101:3):

```ts
// SContext.headers (PropertyCall, typeId=101, methodId=2)
// Source: ergotree-interpreter/src/eval/scontext.rs:58-70 — HEADERS_EVAL_FN
// Pattern A cost 15 (charged before obj check). Returns Coll[Header].
HANDLERS.set(handlerKey(101, 2), (obj, _args, ctx, _explicitTypeArgs) => {
  ctx.addCost(15)
  if (obj.kind !== 'Context') {
    throw new EvalError(
      `SContext.headers expects a Context obj; got '${obj.kind}'`,
      'context-obj-not-context'
    )
  }
  if (ctx.headers === undefined) {
    throw new EvalError(`SContext.headers: ctx.headers is undefined`, 'context-field-missing')
  }
  return headersCollOf(ctx.headers)
})
```

Add the helper (place near `dataInputsCollOf` at the bottom of the file):

```ts
const SHEADER_ELEM: SType = { tag: 'SHeader' }

function headersCollOf(headers: Header[]): SValue {
  return {
    kind: 'Coll',
    elem: SHEADER_ELEM,
    items: headers.map((h) => ({ kind: 'Header', value: h })),
  }
}
```

Add the `Header` import at the top:

```ts
import type { Header } from '@ergots/scorex'
```

- [ ] **Step 4.1.5: Run tests — expect pass.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/eval/scontext-handlers.test.ts 2>&1 | tail -10
```

### Task 4.2 — `SContext.lastBlockUtxoRootHash` (101:9)

**Files:**
- Modify: `packages/ergoscript/src/eval/method-call.ts` (add handler)
- Create: `packages/ergoscript/test/fixtures/eval/scontext-last-block-utxo-root-hash.json`
- Modify: `packages/ergoscript/test/eval/scontext-handlers.test.ts`

- [ ] **Step 4.2.1: Generate the oracle fixture.**

Extend the fixture-gen module to emit the `PropertyCall(Context, LAST_BLOCK_UTXO_ROOT_HASH_PROPERTY)` fixture.

- [ ] **Step 4.2.2: Write the failing test.**

```ts
test('SContext.lastBlockUtxoRootHash (101:9) synthesizes AvlTree from ctx.headers[0].stateRoot', () => {
  const fx = loadFixture('scontext-last-block-utxo-root-hash')
  const tree = parseTree(hexToBytes(fx.exprBytes))
  const ctx = makeContext({ headers: fx.ctxHeaders!.map(toRuntimeHeader) })
  const result = evaluateWith(tree, ctx)
  expect(result.kind).toBe('AvlTree')
  const at = (result as { kind: 'AvlTree'; value: { digest: Uint8Array; treeFlags: number; keyLength: number; valueLengthOpt: number | null } }).value
  expect(at.digest).toEqual(ctx.headers![0].stateRoot)
  expect(at.treeFlags).toBe(0b111)
  expect(at.keyLength).toBe(32)
  expect(at.valueLengthOpt).toBeNull()
  expect(ctx.jitCost).toBe(fx.expectedJitCost)
})

test('SContext.lastBlockUtxoRootHash throws context-field-missing on empty/undefined headers', () => {
  const fx = loadFixture('scontext-last-block-utxo-root-hash')
  const tree = parseTree(hexToBytes(fx.exprBytes))

  // Case 1: undefined
  expect(() => evaluateWith(tree, makeContext({}))).toThrow(
    expect.objectContaining({ code: 'context-field-missing' })
  )

  // Case 2: empty array
  expect(() => evaluateWith(tree, makeContext({ headers: [] }))).toThrow(
    expect.objectContaining({ code: 'context-field-missing' })
  )
})
```

- [ ] **Step 4.2.3: Run — expect failure.**

- [ ] **Step 4.2.4: Implement the handler in `eval/method-call.ts`.**

```ts
// SContext.lastBlockUtxoRootHash (PropertyCall, typeId=101, methodId=9)
// Source: ergotree-interpreter/src/eval/scontext.rs:83-99 — LAST_BLOCK_UTXO_ROOT_HASH_EVAL_FN
// Pattern A cost 15. Synthesizes AvlTreeData from ctx.headers[0].stateRoot.
HANDLERS.set(handlerKey(101, 9), (obj, _args, ctx, _explicitTypeArgs) => {
  ctx.addCost(15)
  if (obj.kind !== 'Context') {
    throw new EvalError(
      `SContext.lastBlockUtxoRootHash expects a Context obj; got '${obj.kind}'`,
      'context-obj-not-context'
    )
  }
  if (ctx.headers === undefined || ctx.headers.length === 0) {
    throw new EvalError(
      `SContext.lastBlockUtxoRootHash: ctx.headers is ${ctx.headers === undefined ? 'undefined' : 'empty'}`,
      'context-field-missing'
    )
  }
  return {
    kind: 'AvlTree',
    value: {
      digest: ctx.headers[0]!.stateRoot,
      treeFlags: 0b111, // insert/update/remove all allowed; sigma-rust AvlTreeFlags::new(true, true, true)
      keyLength: 32,
      valueLengthOpt: null,
    },
  }
})
```

- [ ] **Step 4.2.5: Run tests — expect pass.**

### Task 4.3 — Verify Phase 4 + commit

- [ ] **Step 4.3.1: Full test suite.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -5
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/ 2>&1 | tail -5
```

Expected: 2832 + 4 = **2836 tests pass**.

- [ ] **Step 4.3.2: Commit Phase 4.**

```bash
cd /home/mwaddip/projects/ergots && git add packages/ergoscript/src/eval/method-call.ts packages/ergoscript/test/eval/scontext-handlers.test.ts packages/ergoscript/test/fixtures/eval/scontext-headers.json packages/ergoscript/test/fixtures/eval/scontext-last-block-utxo-root-hash.json fixture-gen/src/
git commit -m "$(cat <<'EOF'
feat(ergoscript): SContext.headers + lastBlockUtxoRootHash handlers

Phase 2h-c.1 Step 4. Wires 2 new SContext method handlers:

  - SContext.headers (101:2) Pattern A Fixed(15) returns Coll[Header]
    from ctx.headers; source: eval/scontext.rs:58-70.
  - SContext.lastBlockUtxoRootHash (101:9) Pattern A Fixed(15) synthesizes
    AvlTree from ctx.headers[0].stateRoot with treeFlags 0b111, keyLength
    32, valueLengthOpt null; source: eval/scontext.rs:83-99.

Both throw 'context-field-missing' (existing 2f-medium code) when ctx.headers
is undefined; lastBlockUtxoRootHash also throws on empty array.

Tests: 2 oracle fixtures + 3 throw-path coverage cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5: V3 SHeader-constant wire-roundtrip + mutation testing

### Task 5.1 — Generate 6 V3 SHeader-constant ErgoTree fixtures

**Files:**
- Create: `packages/ergoscript/test/fixtures/wire/sheader-constants-v3-*.bin` (6 fixtures)
- Create: `packages/ergoscript/test/wire/svalue-sheader-roundtrip.test.ts`

- [ ] **Step 5.1.1: Extend fixture-gen to synthesize 6 V3 ErgoTrees with embedded SHeader constants.**

Fixtures to emit:
- `sheader-constants-v3-single-header.bin` — V3 tree, segregated-constants section contains 1 SHeader literal (a mainnet V2 header).
- `sheader-constants-v3-single-v1-header.bin` — same shape, but the embedded header is a mainnet V1 header (validates V1 vs V2 codec parity).
- `sheader-constants-v3-coll-of-headers.bin` — V3 tree with `Coll[Header]` of 3 SHeader literals (validates recursive `treeVersion` threading through the Coll arm).
- `sheader-constants-v3-option-some.bin` — V3 tree with `Option[Header] = Some(h)` (validates Option arm threading).
- `sheader-constants-v3-option-none.bin` — V3 tree with `Option[Header] = None` (validates the None tag path; no SHeader bytes follow).
- `sheader-constants-v2-header-literal.bin` — V2 (tree-version=2) tree containing an SHeader constant — **negative fixture**; must trip `'sheader-tree-version-too-low'` on parse.

Use sigma-rust's `ErgoTreeBuilder` or hand-construct via `Constant::new(SType::SHeader, ...)` + `serialize_with_version(version)`. Verify byte determinism (`cargo run` twice → byte-identical outputs).

- [ ] **Step 5.1.2: Write the round-trip tests.**

```ts
// packages/ergoscript/test/wire/svalue-sheader-roundtrip.test.ts
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTree, serializeTree } from '../../src/wire'

const FIXTURES = [
  'sheader-constants-v3-single-header',
  'sheader-constants-v3-single-v1-header',
  'sheader-constants-v3-coll-of-headers',
  'sheader-constants-v3-option-some',
  'sheader-constants-v3-option-none',
] as const

describe('SHeader SValue wire round-trip — V3 trees', () => {
  test.each(FIXTURES)('%s round-trips byte-equal', (name) => {
    const bytes = new Uint8Array(readFileSync(`packages/ergoscript/test/fixtures/wire/${name}.bin`))
    const tree = parseTree(bytes)
    const out = serializeTree(tree)
    expect(out).toEqual(bytes)
  })
})

describe('SHeader SValue wire — V<3 rejection', () => {
  test('V2 tree with SHeader literal throws sheader-tree-version-too-low', () => {
    const bytes = new Uint8Array(readFileSync('packages/ergoscript/test/fixtures/wire/sheader-constants-v2-header-literal.bin'))
    expect(() => parseTree(bytes)).toThrow(
      expect.objectContaining({ code: 'sheader-tree-version-too-low' })
    )
  })
})
```

- [ ] **Step 5.1.3: Run — expect all 6 tests pass (5 round-trip + 1 negative).**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/wire/svalue-sheader-roundtrip.test.ts 2>&1 | tail -10
```

### Task 5.2 — Add mutation testing for SHeader-constant trees

**Files:**
- Create: `packages/ergoscript/test/wire/svalue-sheader-mutation.test.ts`

- [ ] **Step 5.2.1: Implement single-byte-flip mutation harness.**

Pattern follows existing `parse-mutation.test.ts` in the ergoscript test suite. For each of the 5 positive C2 fixtures (excluding the negative V2 one), iterate every byte offset, flip the byte, attempt to `parseTree`, and record one of:

- **Killed (typed error):** any subclass of `Error` with a known `.code` from the wire-layer taxonomy (`ErgoTreeParseError`, `ExprParseError`, `STypeParseError`, `SValueParseError`, `ReaderError`).
- **Killed (re-serializes to non-original):** parses successfully but `serializeTree(parseTree(mutated))` ≠ mutated bytes (mutation moved the bytes off the canonical round-trip).
- **Tolerated (byte-identical re-serialize):** mutation flipped a byte in `Header.unparsedBytes` forward-compat region that round-trips identically. Document the offset ranges in a per-fixture `tolerated.json`.

Per-fixture kill-rate threshold: **≥ 90%**. Total mutation count target: ≈ 25-30 across the 5 fixtures.

```ts
// packages/ergoscript/test/wire/svalue-sheader-mutation.test.ts (skeleton)
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTree, serializeTree } from '../../src/wire'

const FIXTURES = [
  'sheader-constants-v3-single-header',
  'sheader-constants-v3-single-v1-header',
  'sheader-constants-v3-coll-of-headers',
  'sheader-constants-v3-option-some',
  'sheader-constants-v3-option-none',
] as const

describe('SHeader-constant wire mutation testing', () => {
  test.each(FIXTURES)('%s achieves ≥90%% kill rate', (name) => {
    const bytes = new Uint8Array(readFileSync(`packages/ergoscript/test/fixtures/wire/${name}.bin`))
    let killed = 0
    let total = 0
    for (let i = 0; i < bytes.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const mutated = new Uint8Array(bytes)
        mutated[i] ^= 1 << bit
        total++
        try {
          const tree = parseTree(mutated)
          const out = serializeTree(tree)
          if (!byteEqual(out, mutated)) killed++
        } catch (e) {
          if (isTypedWireError(e)) killed++
        }
      }
    }
    const killRate = killed / total
    expect(killRate).toBeGreaterThanOrEqual(0.9)
  })
})

function byteEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function isTypedWireError(e: unknown): boolean {
  return (
    e instanceof Error &&
    typeof (e as { code?: string }).code === 'string'
  )
}
```

- [ ] **Step 5.2.2: Run — expect all 5 mutation tests achieve ≥ 90% kill rate.**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/test/wire/svalue-sheader-mutation.test.ts 2>&1 | tail -15
```

Expected: all 5 PASS at ≥ 90%. If any fixture drops below, inspect tolerated-mutation offsets to confirm they're all in legitimate forward-compat regions (typically `Header.unparsedBytes`); document inline.

### Task 5.3 — Verify Phase 5 + commit

- [ ] **Step 5.3.1: Full test suite + cross-runtime.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json 2>&1 | head -5
npx vitest run /home/mwaddip/projects/ergots/packages/ergoscript/ 2>&1 | tail -5
# Cross-runtime check (jsdom):
cd /home/mwaddip/projects/ergots/packages/ergoscript && npx vitest run --config vitest.browser.config.ts 2>&1 | tail -5
```

Expected: 2836 + 11 (6 round-trip + 5 mutation per-fixture) = **2847 tests pass** under both `node` and `jsdom`.

- [ ] **Step 5.3.2: Commit Phase 5.**

```bash
cd /home/mwaddip/projects/ergots && git add packages/ergoscript/test/fixtures/wire/ packages/ergoscript/test/wire/ fixture-gen/src/
git commit -m "$(cat <<'EOF'
test(ergoscript): SHeader-constant wire roundtrip + mutation testing

Phase 2h-c.1 Step 5. Adds 6 V3 ErgoTree fixtures with embedded SHeader
literals (single header V1+V2, Coll[Header], Option[Some/None]) + 1 V2
negative fixture. Round-trip tests assert serializeTree(parseTree(b)) === b.
Mutation tests (single-byte flip across all offsets) target ≥ 90% kill
rate per fixture; tolerated mutations are documented in per-fixture
inline comments (forward-compat unparsedBytes region only).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6: Facts files + final verification

### Task 6.1 — Update `facts/ergoscript-eval.md`

**Files:**
- Modify: `facts/ergoscript-eval.md`

- [ ] **Step 6.1.1: Add Phase 2h-c.1 changelog block.**

Insert a new section after the existing **"Phase 2h-b — `@ergots/avltree` integration"** block, before the **"Does NOT ship yet (deferred)"** section. Format mirrors prior phase entries:

```markdown
**Phase 2h-c.1 — SHeader runtime + 17 method handlers** (additive):

- 17 new method handlers wired (21 → 38 registry entries):
  - **15 `SHeader.*` accessors** (Pattern A Fixed(10) each) at typeId 104, methodIds 1-15: `id` (1), `version` (2), `parentId` (3), `adProofsRoot` (4), `stateRoot` (5), `transactionsRoot` (6), `timestamp` (7), `nBits` (8), `height` (9), `extensionRoot` (10), `minerPk` (11), `powOnetimePk` (12), `powNonce` (13), `powDistance` (14), `votes` (15). Source: `eval/sheader.rs:16-113`.
  - **2 `SContext.*` additions** (Pattern A Fixed(15) each): `headers` (101:2) returns `Coll[Header]` from `ctx.headers`; `LastBlockUtxoRootHash` (101:9) synthesizes `AvlTree(digest=ctx.headers[0].stateRoot, treeFlags=0b111, keyLength=32, valueLengthOpt=null)`. Source: `eval/scontext.rs:58-70` and `:83-99`.
- New `SValue` variant: `{ kind: 'Header'; value: Header }` (`Header` imported from `@ergots/scorex`).
- `EvalOpts` / `EvalContext` gains 1 new optional field: `headers?: Header[]`.
- 1 new `EvalError` code: `'header-obj-not-header'` (defensive receiver check on all 15 SHeader handlers; 45 → 46 total).
- Wire-format unlock (cross-references `facts/ergoscript-wire.md`): `parseSValue` / `serializeSValue` signatures gain `treeVersion: number` parameter; SHeader SValue parse + serialize now ship with V3-gating (replaces `'not-implemented-phase-2a'`).
- V2-header semantic detail: `powOnetimePk` returns 33 zero bytes (identity-point encoding per `EcPoint::default()` → `scorex_serialize`); `powDistance` returns `0n` (BigInt).
- Notable quirk: `SHeader.stateRoot` is declared with `SType::SAvlTree` in sigma-rust `types/sheader.rs:127`, but the eval (`sheader.rs:40-44`) returns `Coll[Byte]` (33 bytes). We match the eval, not the type-system declaration.

**Phase 2h-c.1 COMPLETE.** Method handler registry: 38 entries. EvalError codes: 46. Test count: ~2847.
```

- [ ] **Step 6.1.2: Update the method-handler registry table.**

Insert rows #22 through #38 into the existing table (after row #21 from phase 2h-b). Use exact entries from the design spec's Section 3 table.

- [ ] **Step 6.1.3: Update the `EvalError` taxonomy.**

Add the `'header-obj-not-header'` description under a new "Phase 2h-c.1 codes (SHeader.* method handlers)" subsection.

- [ ] **Step 6.1.4: Update the SValue union type-invariants section.**

Add `| { kind: 'Header'; value: Header } // phase 2h-c.1 — Header value carrier` to the `SValue` union block.

- [ ] **Step 6.1.5: Update the EvalOpts table.**

Add `headers?: Header[]` row to the chain-state fields list.

- [ ] **Step 6.1.6: Update the Coverage section's "Coverage and stability" subsection.**

Change "**Method-handler registry: 21 entries**" to "**Method-handler registry: 38 entries** (was 21 before 2h-c.1; +17 from 2h-c.1 — 15 SHeader accessors at typeId 104, methodIds 1-15, + 2 SContext additions at 101:2 and 101:9)."

### Task 6.2 — Update `facts/ergoscript-wire.md`

**Files:**
- Modify: `facts/ergoscript-wire.md`

- [ ] **Step 6.2.1: Update `SValueParseError` and `SValueSerializeError` code lists.**

Add `'sheader-tree-version-too-low'` to both lists. Update the `'not-implemented-phase-2a'` description to note that SHeader has been removed from its emitting set (mirrors the existing "SBox removed in phase 2f Stop α, SAvlTree removed in phase 2h-b" pattern).

- [ ] **Step 6.2.2: Add a new "Phase 2h-c.1 wire updates (SHeader)" section.**

Mirrors the existing "Phase 2h-b wire updates (SAvlTree)" section. Document:

- `parseSValue(SHeader, treeVersion, r)` and `serializeSValue(SHeader, v, treeVersion, w)` ship with V3 gating.
- Signature change: both functions gain `treeVersion: number` parameter (threading through every recursive callsite).
- The wire format delegates to `@ergots/scorex`'s `parseHeader` / `serializeHeader` at V3+; throws `'sheader-tree-version-too-low'` at V<3.
- 6 fixture entries cover the round-trip + V<3 rejection.

### Task 6.3 — Update `facts/ergoscript.md`

**Files:**
- Modify: `facts/ergoscript.md`

- [ ] **Step 6.3.1: Update Coverage summary.**

Update the test-count line to "Cross-runtime: ~2847 ergoscript + 143 avltree + 313 nipopow + 115 scorex = ~3418 tests, passing under both `node` and `jsdom`." (Or whatever the actual final count is.)

Update the Evaluator coverage row to "52 of ~70 `Expr` arms wired; **38** method-handler registry entries; **46** `EvalError` codes; mainnet C2 corpus `success` ≥ 18 (post-2h-c.1 uplift TBD on next corpus run)."

### Task 6.4 — Final verification

- [ ] **Step 6.4.1: Full cross-package typecheck.**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/scorex/tsconfig.json
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/nipopow/tsconfig.json
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/avltree/tsconfig.json
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json
```

All four must be clean.

- [ ] **Step 6.4.2: Full cross-package test run (node + jsdom).**

```bash
npx vitest run /home/mwaddip/projects/ergots/packages/ 2>&1 | tail -10
# Cross-runtime:
cd /home/mwaddip/projects/ergots/packages/ergoscript && npx vitest run --config vitest.browser.config.ts 2>&1 | tail -5
cd /home/mwaddip/projects/ergots/packages/scorex && npx vitest run --config vitest.browser.config.ts 2>&1 | tail -5
```

Expected: ≈ 3470 tests pass under both runtimes. Zero regression on existing 3388.

- [ ] **Step 6.4.3: fixture-gen determinism check.**

```bash
cd /home/mwaddip/projects/ergots/fixture-gen && cargo build --release && cargo run --release 2>&1 | tail -3
git -C /home/mwaddip/projects/ergots status packages/ergoscript/test/fixtures/eval/ packages/ergoscript/test/fixtures/wire/ packages/ergoscript/test/fixtures/headers/ 2>&1 | head -10
```

Expected: clean tree (`cargo run` reproduces the committed fixtures byte-identically).

### Task 6.5 — Commit Phase 6

- [ ] **Step 6.5.1: Stage facts files + commit.**

```bash
cd /home/mwaddip/projects/ergots && git add facts/ergoscript-eval.md facts/ergoscript-wire.md facts/ergoscript.md
git commit -m "$(cat <<'EOF'
docs: facts files updated for phase 2h-c.1 SHeader runtime

Updates facts/ergoscript-eval.md (+changelog block, +17 registry rows,
+'header-obj-not-header' code, +SValue.Header variant, +headers field,
+coverage summary), facts/ergoscript-wire.md (+'sheader-tree-version-too-low'
codes, +SHeader removed from 'not-implemented-phase-2a' emitting set,
+wire-updates section), and facts/ergoscript.md (refreshed test counts +
coverage stats).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6.5.2: Confirm final repo state.**

```bash
git -C /home/mwaddip/projects/ergots log --oneline -10
git -C /home/mwaddip/projects/ergots status
```

Expected: ~6 phase commits + the initial spec commit `a77f640`. Working tree clean modulo the gitignored `audit20260519/` directory.

---

## Acceptance criteria (Phase 2h-c.1 complete)

1. **Zero test regression:** all 3388 pre-phase tests still pass.
2. **Test count uplift:** ≥ 3470 total tests across all 4 packages (target ≈ 3470; absolute floor 3388 + 80 = 3468).
3. **Typecheck clean** across all 4 packages.
4. **fixture-gen deterministic:** `cargo run` reproduces committed fixtures byte-identically.
5. **Cross-runtime green:** all tests pass under both `node` and `jsdom`.
6. **Facts files in sync:** `facts/ergoscript-eval.md`, `facts/ergoscript-wire.md`, `facts/ergoscript.md` accurately reflect the landed code.
7. **No `--no-verify` / `--no-gpg-sign`** flags used on any commit.
8. **All commits authored Co-by Claude Opus 4.7** per project convention.

## Deferred (not 2h-c.1 scope)

- `SHeader.checkPow` method handler (typeId 104, methodId 16) — phase 2h-c.2 with Autolykos v2 verifier promotion into `@ergots/scorex`.
- Re-exporting `Header` / `AutolykosSolution` from `@ergots/ergoscript`'s public `index.ts`.
- C2 mainnet-corpus uplift run.
- Real-context cost validation (Layer C3) — phase 2j calibration.
- Open issue from 2h-b: V3+ partial-success path for `SAvlTree.insert`/`update` is implemented but not fixture-tested. ~1-2 hr; carried forward.
