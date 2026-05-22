# Phase 2j-pre fix-1 — `sbox-ergo-tree-no-size` rejection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto/cost-path → halt and declare (this fix is NOT a crypto/cost-path phase, but the rule stays in the preamble); #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads; #10 — truncation suspicion on grep results]. Per `[[feedback-subagent-explicit-rules]]`, this preamble is load-bearing.

**Spec:** `docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md` (v2, reviewer-pass applied)

**Goal:** Replace the unconditional rejection at `packages/ergoscript/src/wire/parse-svalue.ts:278-287` (`SValueParseError 'sbox-ergo-tree-no-size'`) with a shared-reader body parse that mirrors sigma-rust's `ErgoTree::sigma_parse` at `ergo_tree.rs:410-453`. The fix unblocks the harness's output-roundtrip pass against the ~99% of mainnet boxes that use v0+hasSize=false ErgoTrees.

**Architecture (one-paragraph summary):** Extract `parseTreeFromReader(r: ByteReader): ErgoTree` from the existing `parseTree(bytes)` body. Make `parseTree(bytes)` a thin wrapper that constructs a `ByteReader`, calls the helper, then enforces outer-envelope exhaustion. Update `parseSValue(SBox)` to call `parseTreeFromReader` directly on the shared reader (capturing the consumed bytes via `r.slice(treeStart, r.position)` for the SBox's `ergoTreeBytes` field). Remove the now-unreachable `'sbox-ergo-tree-no-size'` code from the error class + facts taxonomy + docs cascade (13 occurrences across 9 files per spec Decision 3). Rebuild `dist/`. Layer 3 smoke re-run to verify the halt site advances; harness integration-test snapshots refreshed to match the new halt point.

**Invariants:**
- Zero new public-API additions; `parseTree(bytes)` signature unchanged.
- `parseSValue(SBox)` accepts v0+hasSize=false trees; previously-accepted v1+hasSize=true continues to work byte-for-byte identically.
- Serialize side unchanged (writes captured `ergoTreeBytes` verbatim per `serialize-svalue.ts`).
- Package tests stay at 3772 + any new tests added by T2/T4 (Layer 1 and Layer 2 fixtures); cross-runtime jsdom continues to pass.

---

## Task ordering

```
T1   PLAN.md committed (this document; overwrites 2j-pre plan)
T2   Layer 1 RED — synthetic v0+hasSize=false P2PK SBox fixture +
     4 failing tests in test/parse-svalue-sbox-no-size.test.ts.
T3   GREEN — extract parseTreeFromReader from parseTree;
     update parseSValue(SBox) to call it. Verify: tsc + vitest
     (node + jsdom) clean across the ergoscript package.
T4   Layer 2 — real-mainnet v0+hasSize=false fixture captured from
     bootstrap-data snapshot (transcribed from smoke-log halt
     diagnostics OR re-run smoke at low height to capture). Add
     test that exercises the captured bytes.
T5   Remove 'sbox-ergo-tree-no-size' throw site + facts entry +
     propagate removal through README.md (tools/mainnet-validate/),
     PLAN.md historical reference (this file's section won't matter
     after T1 commits — but spec's cascade table flags PLAN.md from
     the OLD 2j-pre plan; that's already overwritten by T1 so just
     verify no remaining hits), HANDOFF_PROMPT.md, SESSION_CONTEXT.md.
     Final repo-wide grep returns zero hits.
T6   Rebuild dist: cd packages/ergoscript && npm run build.
     Verify the refreshed dist/index.js no longer contains the
     literal "sbox-ergo-tree-no-size".
T7   Layer 3 smoke re-run against the bootstrap-data snapshot.
     Document the new halt site (phase + errorCode + height) in a
     brief findings note appended to HANDOFF_PROMPT.md's fix-list
     OR captured as the seed for the next focused-fix spec.
T8   Refresh harness integration-test snapshots in
     tools/mainnet-validate/harness/test/integration/{halt-path,
     tip-reach-path,resume-path}.test.ts to reflect T7's observed
     halt site (or replace with shape-only assertions if halts
     scatter across heights).
T9   SESSION_CONTEXT.md + HANDOFF_PROMPT.md + project_ergots_direction
     memory refresh + push to origin/master.
```

Total: 9 commits (T1 plus T2-T9).

---

## Task 1: Commit PLAN.md

**Files:**
- Create: `/home/mwaddip/projects/ergots/PLAN.md` (this file, overwrites 2j-pre plan)

- [ ] **Step 1: Stage and commit**

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): overwrite PLAN.md with phase 2j-pre fix-1 execution plan

Per HANDOFF_PROMPT.md convention: PLAN.md is the in-flight phase's task
list, overwritten at each phase boundary. Spec at
docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md
(v2, reviewer pass applied).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Verification**

```bash
git log --oneline -3   # confirm: PLAN commit + spec commit + 2e86757 (2j-pre tip)
```

---

## Task 2: Layer 1 RED — synthetic v0+hasSize=false fixture + failing tests

**Files:**
- Create: `packages/ergoscript/test/parse-svalue-sbox-no-size.test.ts`

**Fixture (hand-constructed):**

The canonical v0+hasSize=false P2PK ErgoTree is 36 bytes:
- byte 0: `0x00` — header (version=0, hasSize=false, no segregation)
- byte 1: `0x08` — SType code for SSigmaProp
- byte 2: `0xcd` — `ProveDlog::OP_CODE` (sigma-rust `serialization/sigmaboolean.rs:50`)
- bytes 3-35: 33 deterministic test bytes (e.g., `0x02` + 32 bytes of `0xaa`) — compressed secp256k1 EcPoint shape; doesn't need to be a real curve point for parse-only tests.

The full SBox byte layout (matching `parse-svalue.ts:271-318` and `serialize-svalue.ts`):
- value (VLQ u64, e.g., `0x80 0x01` = 128 nanoERG)
- ergo_tree_bytes (the 36-byte P2PK above)
- creation_height (VLQ u32, e.g., `0x01` = 1)
- tokens_count (raw u8, `0x00` = no tokens)
- additional_regs (raw u8, `0x00` = no R4-R9)
- transaction_id (32 raw bytes, e.g., 32 bytes of `0xbb`)
- index (VLQ u16, e.g., `0x00` = 0)

Total SBox bytes: 2 (value) + 36 (tree) + 1 (height) + 1 (token count) + 1 (reg count) + 32 (txid) + 1 (index) = 74 bytes.

- [ ] **Step 1: Construct the fixture**

Inline hex constant in the test file. Use a helper to assemble:

```ts
const P2PK_TREE = new Uint8Array([
  0x00,                     // header: v0, !hasSize, !segregation
  0x08, 0xcd,               // SSigmaProp + ProveDlog opcode
  0x02, ...new Array(32).fill(0xaa),  // 33-byte EcPoint (test data)
])

const SYNTHETIC_SBOX = new Uint8Array([
  0x80, 0x01,                          // value VLQ u64 = 128
  ...P2PK_TREE,                        // ergo_tree (36 bytes)
  0x01,                                // creation_height VLQ u32 = 1
  0x00,                                // tokens_count u8 = 0
  0x00,                                // additional_regs u8 = 0
  ...new Array(32).fill(0xbb),         // transaction_id (32 bytes)
  0x00,                                // index VLQ u16 = 0
])
// length: 74 bytes total
```

- [ ] **Step 2: Write 4 failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue, serializeSValue, SValueParseError } from '../src/wire/parse-svalue'
// (or wherever the public re-exports point — confirm import paths
// from the ergoscript test/ existing patterns)
import { parseTree, serializeTree } from '../src/wire/ergo-tree'

describe('SBox v0+hasSize=false parse (phase 2j-pre fix-1)', () => {
  it('parses v0+hasSize=false P2PK SBox without throwing', () => {
    const r = new ByteReader(SYNTHETIC_SBOX)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r)
    expect(sbox.kind).toBe('Box')
  })

  it('round-trips byte-equal', () => {
    const r = new ByteReader(SYNTHETIC_SBOX)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r)
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, sbox, 0, w)
    expect(w.toBytes()).toEqual(SYNTHETIC_SBOX)
  })

  it('ergoTreeBytes captures exactly the tree bytes', () => {
    const r = new ByteReader(SYNTHETIC_SBOX)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r) as any  // narrow as needed
    expect(sbox.value.ergoTree).toEqual(P2PK_TREE)
  })

  it('public-API parseTree handles the same v0+hasSize=false bytes', () => {
    const tree = parseTree(P2PK_TREE)
    expect(tree.header.version).toBe(0)
    expect(tree.header.hasSize).toBe(false)
    expect(serializeTree(tree)).toEqual(P2PK_TREE)
  })
})
```

- [ ] **Step 3: Run the failing tests — confirm they fail with the expected error**

```bash
cd /home/mwaddip/projects/ergots
node_modules/.bin/vitest run packages/ergoscript/test/parse-svalue-sbox-no-size.test.ts
```

Expected: tests 1, 2, 3 throw `SValueParseError('sbox-ergo-tree-no-size')`. Test 4 should ALREADY pass — the `parseTree(bytes)` public function handles hasSize=false internally; this test pins the parity.

If test 4 fails: investigate before touching anything else — that's an unknown the spec didn't anticipate.

- [ ] **Step 4: Stage + commit**

```bash
git add packages/ergoscript/test/parse-svalue-sbox-no-size.test.ts
git commit -m "$(cat <<'EOF'
test(2j-pre/fix-1): RED — failing test for v0+hasSize=false SBox parse (T2)

Adds packages/ergoscript/test/parse-svalue-sbox-no-size.test.ts with 4
tests exercising parseSValue(SBox) against a hand-constructed 74-byte
SBox containing a canonical 36-byte P2PK ErgoTree (header 0x00, body
0x08 0xcd <33-byte test EcPoint>).

3 of 4 tests fail with SValueParseError('sbox-ergo-tree-no-size') —
the rejection at parse-svalue.ts:278-287 that this phase removes.
Test 4 (public parseTree handles the same bytes) passes today and
locks in parity post-refactor.

Per spec docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md
§Layer 1. TDD discipline per CLAUDE.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: GREEN — extract `parseTreeFromReader` + update `parseSValue(SBox)`

**Files:**
- Edit: `packages/ergoscript/src/wire/ergo-tree.ts` — extract `parseTreeFromReader`, refactor `parseTree(bytes)` to delegate.
- Edit: `packages/ergoscript/src/wire/parse-svalue.ts` — replace the throw at lines 278-287 with a call to `parseTreeFromReader`.

- [ ] **Step 1: Re-read both files in full**

Per OVERRIDES rule #8 — read before edit. Both files are < 500 lines; one Read each.

- [ ] **Step 2: Add `parseTreeFromReader` in `ergo-tree.ts`**

Insert before `parseTree(bytes)`. The new helper contains all the logic currently inside `parseTree(bytes)` except: (a) the `bytes.length` size cap + empty checks, (b) the `outer.isExhausted` trailing-bytes check at the very end. Critically: for the `!hasSize` branch, the helper sets `inner = outer` (shares the reader) instead of constructing a fresh ByteReader over `outer.remaining`.

```ts
/**
 * Parse an ErgoTree's header + body from the current cursor position of
 * the provided reader. Leaves the cursor at the byte AFTER the body. Does
 * NOT enforce trailing-byte exhaustion on the outer reader — that's the
 * caller's job.
 *
 * Mirrors sigma-rust's ErgoTree::sigma_parse at ergo_tree.rs:410-453:
 * non-hasSize branch reads constants (if segregated) + body Expr from the
 * SHARED reader. Body Expr is self-delimiting via the opcode grammar.
 *
 * Used by:
 *   - parseTree(bytes), which wraps with size cap + outer exhaustion check.
 *   - parseSValue(SBox), which captures the consumed byte range as the
 *     box's ergoTreeBytes field.
 */
export function parseTreeFromReader(outer: ByteReader): ErgoTree {
  const rawHeader = outer.readU8()
  const header: TreeHeader = {
    version: (rawHeader & VERSION_MASK) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
    hasSize: (rawHeader & HAS_SIZE_FLAG) !== 0,
    constantSegregation: (rawHeader & CONSTANT_SEGREGATION_FLAG) !== 0,
    rawHeader,
  }

  let inner: ByteReader
  if (header.hasSize) {
    const bodyByteLength = outer.readVlqU()
    if (bodyByteLength > outer.remaining) {
      throw new ErgoTreeParseError(
        `declared body size ${bodyByteLength} exceeds remaining bytes ${outer.remaining}`,
        'body-size-overflow',
      )
    }
    inner = new ByteReader(outer.readBytes(bodyByteLength))
  } else {
    // Share the outer reader. The body Expr grammar is self-delimiting;
    // the cursor lands at the body's end after parseExpr returns. Sigma-rust
    // does the same at ergo_tree.rs:436-451.
    inner = outer
  }

  const constantTypes: SType[] = []
  const constants: SValue[] = []
  if (header.constantSegregation) {
    const count = inner.readVlqU()
    if (count > MAX_CONSTANTS_COUNT) {
      throw new ErgoTreeParseError(
        `constant count ${count} exceeds ${MAX_CONSTANTS_COUNT}`,
        'too-many-constants',
      )
    }
    for (let i = 0; i < count; i++) {
      const tpe = parseSType(inner)
      constantTypes.push(tpe)
      constants.push(parseSValue(tpe, header.version, inner))
    }
  }

  const body = parseExpr(inner, constantTypes, constants, new Map(), header.version)

  // hasSize-bounded: enforce that the inner buffer is exhausted (no trailing
  // bytes inside the declared body region).
  if (header.hasSize && !inner.isExhausted) {
    throw new ErgoTreeParseError(
      `${inner.remaining} trailing bytes after body in declared tree-body region`,
      'trailing-bytes',
    )
  }
  // Non-hasSize: NO exhaustion check here. The outer caller decides whether
  // more bytes are expected after the tree (e.g., parseSValue(SBox) expects
  // creation_height next; parseTree(bytes) expects nothing).

  return { header, constantTypes, constants, body }
}
```

- [ ] **Step 3: Refactor `parseTree(bytes)` to be a thin wrapper**

Replace the entire current body of `parseTree(bytes)` with:

```ts
export function parseTree(bytes: Uint8Array): ErgoTree {
  if (bytes.length === 0) {
    throw new ErgoTreeParseError('empty ErgoTree bytes', 'empty')
  }
  if (bytes.length > MAX_TREE_SIZE) {
    throw new ErgoTreeParseError(
      `ErgoTree size ${bytes.length} exceeds ${MAX_TREE_SIZE} byte cap`,
      'oversized',
    )
  }
  const outer = new ByteReader(bytes)
  const tree = parseTreeFromReader(outer)
  if (!outer.isExhausted) {
    throw new ErgoTreeParseError(
      `${outer.remaining} trailing bytes after ErgoTree envelope`,
      'trailing-bytes',
    )
  }
  return tree
}
```

- [ ] **Step 4: Update `parseSValue(SBox)` in `parse-svalue.ts`**

Replace lines 274-291 (the current `treeStart`/`headerByte`/`hasSize`/throw/`bodySize`/`readBytes` block) with:

```ts
// --- ergoTreeBytes (self-delimiting via ErgoTree header) ---
// Sigma-rust calls ErgoTree::sigma_parse(r) here at
// chain/ergo_box.rs:350; we mirror via parseTreeFromReader which
// handles both hasSize=true and hasSize=false on the shared reader.
const treeStart = r.position
parseTreeFromReader(r)  // advances r past the body; return value unused
const ergoTreeBytes = r.slice(treeStart, r.position).slice()  // defensive copy
```

Update the comment block at lines 257-269 (the SBox field documentation comment) to remove the "all real boxes use v1+" claim. New comment:

```ts
//   ergo_tree_bytes — self-delimiting via ErgoTree header.
//                     Sigma-rust calls ErgoTree::sigma_parse(r) on the
//                     shared reader; we mirror via parseTreeFromReader.
//                     Both hasSize=true (size-prefixed body) and
//                     hasSize=false (body grammar self-delimits) are
//                     supported as of phase 2j-pre fix-1.
```

Add the import: `import { parseTreeFromReader } from './ergo-tree'`. Note: the reverse import `ergo-tree.ts → parse-svalue.ts` (for `parseSValue`-on-constants) already exists. The new direction makes the cycle bidirectional. ESM-tolerable per spec Decision 4 (both sides use values only in function bodies).

- [ ] **Step 5: Verify per OVERRIDES rule #6**

```bash
# Typecheck — must be CLEAN
npx tsc --noEmit -p packages/ergoscript/tsconfig.json

# Run all ergoscript tests under node
node_modules/.bin/vitest run packages/ergoscript

# Run all ergoscript tests under jsdom (cross-runtime)
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts
cd /home/mwaddip/projects/ergots
```

Expected: all tests pass, including the 4 new tests from T2. If any pre-existing test fails, investigate before claiming GREEN — the spec asserts behavior preservation; a failure means the refactor changed something.

- [ ] **Step 6: Stage + commit**

```bash
git add packages/ergoscript/src/wire/ergo-tree.ts \
        packages/ergoscript/src/wire/parse-svalue.ts
git commit -m "$(cat <<'EOF'
feat(2j-pre/fix-1): support v0+hasSize=false SBoxes via shared-reader body parse (T3)

Extracts parseTreeFromReader from parseTree in wire/ergo-tree.ts; the
new helper parses an ErgoTree's header + body from the current cursor
position of a shared ByteReader, leaving the cursor at the byte after
the body. parseTree(bytes) becomes a thin wrapper that adds size cap
and outer-envelope exhaustion checks.

parseSValue(SBox) at wire/parse-svalue.ts now calls parseTreeFromReader
on the shared reader, mirroring sigma-rust's chain/ergo_box.rs:350
which calls ErgoTree::sigma_parse(r) directly. v0+hasSize=false trees
(~99% of mainnet boxes) now parse cleanly; previously this case threw
SValueParseError('sbox-ergo-tree-no-size').

The 4 RED tests from T2 turn GREEN. Pre-existing 3194 ergoscript tests
unchanged. Cross-runtime jsdom unchanged.

Per spec docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md
§Decisions 1, 2, 4. T3 of 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Layer 2 — real-mainnet v0+hasSize=false fixture

**Goal:** capture a real on-chain box from the bootstrap-data snapshot and add a parse + round-trip test using its bytes. Validates that the fix handles real mainnet data, not just hand-crafted P2PK.

**Files:**
- Edit: `packages/ergoscript/test/parse-svalue-sbox-no-size.test.ts` — append the Layer 2 test.
- (Optional) Create: `packages/ergoscript/test/fixtures/mainnet-sbox-h1-out0.hex` — if storing the fixture as a file vs. inline hex.

- [ ] **Step 1: Capture a real mainnet SBox**

Two options:

**Option A — Use the existing smoke walk logs.** The T12 smoke runs surfaced halt diagnostics with the failing box's bytes. If `error-report.json` from a prior run captured the `bundleExcerpt.spentBoxHex` or similar (re-read `tools/mainnet-validate/harness/src/error-report.ts` to confirm what's captured), transcribe those bytes.

**Option B — Re-run a tiny smoke walk to capture.** From the bootstrap-data snapshot at `/tmp/ergots-2j-pre-smoke-data/modifiers.redb` (created during 2j-pre T12; may have been cleaned up):

```bash
# If the snapshot still exists; otherwise re-create per
# tools/mainnet-validate/README.md §"Snapshot the live store":
ls /tmp/ergots-2j-pre-smoke-data/modifiers.redb

# Build the shim if not already built:
cd tools/mainnet-validate/shim && cargo build --release
cd /home/mwaddip/projects/ergots

# Use a small ad-hoc script (TypeScript or Rust) that drives the shim's
# GET_BLOCK 1 command, parses the BlockBundle, and dumps the first output
# box's bytes (BlockBundle.transactions[0].outputs[0]) to stdout as hex.
# The shim returns box bytes per its CBOR protocol; harness/src/protocol.ts
# defines the TS shape.
```

The cleanest path is Option A if the bytes are recoverable from existing artifacts; Option B otherwise.

- [ ] **Step 2: Add the captured fixture to the test file**

```ts
// At the bottom of test/parse-svalue-sbox-no-size.test.ts:

const MAINNET_H1_OUT0_BYTES = new Uint8Array([
  // <transcribed real-mainnet bytes from Step 1>
])

it('parses real mainnet v0+hasSize=false SBox (h=1 out 0)', () => {
  const r = new ByteReader(MAINNET_H1_OUT0_BYTES)
  const sbox = parseSValue({ tag: 'SBox' }, 0, r) as any
  expect(sbox.kind).toBe('Box')
  expect(r.isExhausted).toBe(true)  // exact consumption
})

it('real mainnet SBox round-trips byte-equal', () => {
  const r = new ByteReader(MAINNET_H1_OUT0_BYTES)
  const sbox = parseSValue({ tag: 'SBox' }, 0, r)
  const w = new ByteWriter()
  serializeSValue({ tag: 'SBox' }, sbox, 0, w)
  expect(w.toBytes()).toEqual(MAINNET_H1_OUT0_BYTES)
})
```

- [ ] **Step 3: Verify**

```bash
node_modules/.bin/vitest run packages/ergoscript/test/parse-svalue-sbox-no-size.test.ts
```

Expected: both new tests pass. If the round-trip fails byte-equal, the parser is dropping or reordering some byte — investigate before proceeding.

- [ ] **Step 4: Stage + commit**

```bash
git add packages/ergoscript/test/parse-svalue-sbox-no-size.test.ts
git commit -m "$(cat <<'EOF'
test(2j-pre/fix-1): real-mainnet v0+hasSize=false SBox fixture + round-trip (T4)

Captures a real on-chain v0+hasSize=false SBox from the bootstrap-data
snapshot (height 1, output 0; transcribed from {smoke artifact location})
and asserts parse + byte-equal round-trip. Confirms the fix handles real
mainnet data, not just hand-crafted P2PK.

Per spec docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md
§Layer 2. T4 of 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Remove `'sbox-ergo-tree-no-size'` code + docs cascade

**Files (per spec Decision 3's cascade table):**
- Edit: `packages/ergoscript/src/wire/parse-svalue.ts` — already updated by T3 (throw site removed). Verify the literal string `'sbox-ergo-tree-no-size'` no longer appears.
- Edit: `facts/ergoscript-wire.md:176` — remove `'sbox-ergo-tree-no-size'` from the `SValueParseError` codes enumeration. Add a one-line changelog note in §"Phase 2j-pre fix-1" (new subsection) explaining the removal.
- Edit: `tools/mainnet-validate/README.md` — three references at lines 109 (JSON example), 129 (error-class table), 177 (fix-list narrative). The fix-list narrative at line 177 needs to either be removed (item resolved) or rewritten to say "RESOLVED in fix-1, see {spec}."
- Edit: `HANDOFF_PROMPT.md:35` — fix-list item 1 narrative. Either remove (resolved) or mark RESOLVED.
- Edit: `SESSION_CONTEXT.md:48,112` — fix-list summary. Same treatment as HANDOFF_PROMPT.

**Note on PLAN.md:** the spec's cascade table lists `PLAN.md:1075-1079`. That refers to the OLD 2j-pre PLAN; T1 of THIS plan overwrote PLAN.md entirely, so the lines are gone. Verify via grep that no current `PLAN.md` reference exists.

- [ ] **Step 1: Repo-wide grep — capture starting state**

```bash
grep -rn "sbox-ergo-tree-no-size" \
  --include="*.ts" --include="*.md" --include="*.json" --include="*.js" \
  /home/mwaddip/projects/ergots/ \
  | grep -v "dist/" | grep -v "node_modules/"
```

Expected occurrence count: ≤ 13 minus the throw site removed in T3 (so ≤ 12). The `dist/` exclusion is deliberate — T6 rebuilds it separately. Document the actual count for the commit message.

- [ ] **Step 2: Remove from `facts/ergoscript-wire.md:176`**

Locate the `'sbox-ergo-tree-no-size'` entry in the `SValueParseError` codes line; remove only that entry. Verify the surrounding code list still reads naturally (commas, formatting).

Add a new subsection (or extend an existing changelog section) — likely after the phase 2h-c.1 SHeader updates section — titled "## Phase 2j-pre fix-1 wire updates" with:

> `parseSValue(SBox)` at `parse-svalue.ts` now handles v0+hasSize=false ErgoTrees by delegating to a shared-reader body parse (`parseTreeFromReader` in `ergo-tree.ts`), mirroring sigma-rust's `chain/ergo_box.rs:350` calling `ErgoTree::sigma_parse(r)`. The previously-thrown `SValueParseError('sbox-ergo-tree-no-size')` code is removed; v0+hasSize=false (~99% of mainnet boxes) is now supported.

- [ ] **Step 3: Update `tools/mainnet-validate/README.md`**

For line 109 (JSON example with `"errorCode": "sbox-ergo-tree-no-size"`) — replace with a more representative example (e.g., one of the validation phases that's STILL possible to halt at, like `output-roundtrip` with `byte-roundtrip-mismatch`).

For line 129 (error-class table) — remove the `sbox-ergo-tree-no-size` row.

For line 177 (fix-list narrative) — mark item 1 RESOLVED with a pointer to the spec OR remove the entire fix-list item-1 narrative paragraph (rewrite the surrounding section).

- [ ] **Step 4: Update `HANDOFF_PROMPT.md` and `SESSION_CONTEXT.md`**

Defer the substantial rewrite to T9 (final docs sweep). For T5: lightweight edit — change "top priority" wording to "RESOLVED" or strike through. T9 will fully refresh.

- [ ] **Step 5: Final repo-wide grep — verify zero hits (excluding dist/)**

```bash
grep -rn "sbox-ergo-tree-no-size" \
  --include="*.ts" --include="*.md" --include="*.json" --include="*.js" \
  /home/mwaddip/projects/ergots/ \
  | grep -v "dist/" | grep -v "node_modules/"
```

Expected: zero hits. If any remain, investigate. Per OVERRIDES rule #10, if grep returns suspiciously few results, re-narrow and re-confirm.

- [ ] **Step 6: Verify per OVERRIDES rule #6**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
node_modules/.bin/vitest run packages/ergoscript
```

Expected: clean. The removed code is unused; type/test should be unaffected.

- [ ] **Step 7: Stage + commit**

```bash
git add facts/ergoscript-wire.md tools/mainnet-validate/README.md \
        HANDOFF_PROMPT.md SESSION_CONTEXT.md packages/ergoscript/src/wire/parse-svalue.ts
git commit -m "$(cat <<'EOF'
docs(2j-pre/fix-1): remove 'sbox-ergo-tree-no-size' from taxonomy + docs cascade (T5)

The code became unreachable after T3's parse-svalue.ts refactor. Removes:
- facts/ergoscript-wire.md SValueParseError codes enumeration (line 176)
- tools/mainnet-validate/README.md error-class table + fix-list narrative
- HANDOFF_PROMPT.md + SESSION_CONTEXT.md fix-list item 1 references

Adds a §"Phase 2j-pre fix-1 wire updates" subsection in
facts/ergoscript-wire.md documenting the change.

Repo-wide grep "sbox-ergo-tree-no-size" returns zero hits outside
packages/ergoscript/dist/ (T6 rebuilds dist separately).

Per spec docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md
§Decision 3 cascade table. T5 of 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rebuild `dist/`

**Files:**
- Refresh: `packages/ergoscript/dist/index.js` (and any other compiled artifacts).

- [ ] **Step 1: Run the build**

```bash
cd /home/mwaddip/projects/ergots/packages/ergoscript
npm run build
cd /home/mwaddip/projects/ergots
```

- [ ] **Step 2: Verify the rebuild removed the stale code**

```bash
grep "sbox-ergo-tree-no-size" packages/ergoscript/dist/index.js
```

Expected: no hits. If still present, the build didn't pick up the new source — investigate the build config.

- [ ] **Step 3: Verify dist artifacts are git-tracked**

```bash
git status packages/ergoscript/dist/
```

If `dist/` is gitignored or untracked, that's a separate decision — but per `ls packages/ergoscript/dist/` showing existing committed files, it IS tracked. Stage the diff.

- [ ] **Step 4: Stage + commit**

```bash
git add packages/ergoscript/dist/
git commit -m "$(cat <<'EOF'
build(2j-pre/fix-1): rebuild packages/ergoscript/dist (T6)

npm run build refreshes dist/index.js to remove the dead
'sbox-ergo-tree-no-size' literal and pick up the parseTreeFromReader
extraction. Required before T7's Layer 3 smoke walk — the harness
resolves @ergots/ergoscript via the workspace's file: dep, which
resolves to dist/index.js per package.json's "main" field.

Per spec §Decision 5. T6 of 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Layer 3 smoke re-run

**Goal:** verify the harness advances past the previous halt site at h=1 / h=1000 / h=3849. Capture the new halt site (phase + errorCode + height) for downstream fix-list seeding.

- [ ] **Step 1: Confirm bootstrap-data snapshot is available**

```bash
ls /tmp/ergots-2j-pre-smoke-data/modifiers.redb
```

If absent: re-create per `tools/mainnet-validate/README.md §"Snapshot the live store"`. This requires `sudo` access; if not available in the session, document the gap and skip Layer 3 (the unit tests in T2/T4 already validate the fix mechanics).

- [ ] **Step 2: Run smoke walk from height 1**

```bash
# Build shim if not already (cargo build --release in shim/):
ls tools/mainnet-validate/shim/target/release/ergots-mainnet-validate-shim || \
  (cd tools/mainnet-validate/shim && cargo build --release && cd /home/mwaddip/projects/ergots)

# Build harness if not already:
ls tools/mainnet-validate/harness/dist/main.js || \
  (cd tools/mainnet-validate/harness && npm install && npm run build && cd /home/mwaddip/projects/ergots)

# Run with fresh checkpoint + sidecar paths to avoid cross-attempt state:
rm -f /tmp/t7-fix1-sidecar.redb /tmp/t7-fix1-checkpoint.json /tmp/t7-fix1-error-report.json
node tools/mainnet-validate/harness/dist/main.js \
  --store-path /tmp/ergots-2j-pre-smoke-data/modifiers.redb \
  --sidecar-path /tmp/t7-fix1-sidecar.redb \
  --checkpoint-path /tmp/t7-fix1-checkpoint.json \
  --error-report-path /tmp/t7-fix1-error-report.json \
  --start-height 1 \
  --max-height 5 \
  --sleep-ms 0
```

- [ ] **Step 3: Interpret outcome**

Three possibilities:

**A. Validates ≥ 1 block end-to-end** (stretch outcome — see spec §Layer 3). Capture height(s) validated; document briefly.

**B. Halts at a NEW phase/errorCode** (probable). Read `/tmp/t7-fix1-error-report.json`. Capture: `phase`, `errorClass`, `errorCode`, `height`, brief `location`. This becomes a new fix-list item for 2j proper.

**C. Halts at the SAME phase/errorCode as before** (`output-roundtrip` / `sbox-parse-failed`). Unexpected — the fix didn't take effect. Most likely cause: dist not rebuilt (re-check T6). Less likely: the fix has a regression. Investigate.

- [ ] **Step 4: Optionally try other start heights**

If time permits, sample additional heights to confirm consistency:

```bash
node tools/mainnet-validate/harness/dist/main.js \
  --store-path /tmp/ergots-2j-pre-smoke-data/modifiers.redb \
  --sidecar-path /tmp/t7-fix1-sidecar-h1000.redb \
  --checkpoint-path /tmp/t7-fix1-checkpoint-h1000.json \
  --error-report-path /tmp/t7-fix1-error-report-h1000.json \
  --start-height 1000 \
  --max-height 1004 \
  --sleep-ms 0
```

- [ ] **Step 5: Record findings**

The PLAN-level findings note goes in the commit message + a paragraph appended to T9's HANDOFF_PROMPT.md update. For T7's commit:

```bash
# No source files changed in T7 — this is a verification task. Commit a
# small findings file or annotate the commit message with the outcome.
# If no files to add: skip the commit and embed findings in T8/T9's
# commit messages.
```

Recommended: write a brief findings note to a new file `tools/mainnet-validate/findings/2026-05-22-fix-1-smoke.md` (create the directory) capturing the smoke outcome. Then commit:

```bash
mkdir -p tools/mainnet-validate/findings
# write the findings file (see Step 6 for content template)
git add tools/mainnet-validate/findings/2026-05-22-fix-1-smoke.md
git commit -m "$(cat <<'EOF'
test(2j-pre/fix-1): Layer 3 smoke re-run findings — halt advances (T7)

After T3 + T6, the harness {validates h=1..N cleanly | halts at h=N
in phase X with errorCode Y}. Previous halt at h=1 in output-roundtrip
with sbox-parse-failed is resolved.

{Brief paragraph on new halt site for next fix-list item if applicable.}

Per spec §Layer 3. T7 of 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Findings file template**

```markdown
# 2j-pre fix-1 Layer 3 smoke findings (2026-05-22)

## Pre-fix state (from 2j-pre T12)

Every smoke attempt halted at output-roundtrip in tx 0 output 0
with errorCode `sbox-parse-failed` (underlying `sbox-ergo-tree-no-size`).

## Post-fix state

| Attempt | start | max | Validated up to | Halt phase | Halt errorCode | Halt height |
|---|---|---|---|---|---|---|
| 1 | 1 | 5 | {n} | {phase} | {code} | {h} |
| 2 (optional) | 1000 | 1004 | ... | ... | ... | ... |

## Next fix-list item (handed to 2j proper)

{Brief description of the new halt site, in the same format as the
2j-pre fix-list items at HANDOFF_PROMPT.md.}
```

---

## Task 8: Refresh harness integration-test snapshots

**Files:**
- Edit: `tools/mainnet-validate/harness/test/integration/halt-path.test.ts`
- Edit: `tools/mainnet-validate/harness/test/integration/tip-reach-path.test.ts`
- Edit: `tools/mainnet-validate/harness/test/integration/resume-path.test.ts` (per spec Decision 6; review for narrative-only changes)

**Strategy depends on T7 outcome:**

- If T7 surfaced a single deterministic new halt (option B above): refresh the snapshots to pin the new halt phase/errorCode/height.
- If halts scatter across heights (multiple bugs surface across the walk): replace strict pinning with shape-only assertions (e.g., `expect(report.height).toBeGreaterThan(0); expect(report.phase).toBeOneOf(['output-roundtrip', 'evaluate', 'verify-signature'])`).
- If T7 stretch-outcomes (option A — validates cleanly): the halt-path test's premise is broken; it should be re-purposed to use a deliberate fault injection (e.g., a temporarily-broken library function via a test-mode flag) per spec Decision 6's mitigation.

- [ ] **Step 1: Re-read each test file**

Per OVERRIDES rule #8 — read before edit. Each integration test is ~200 lines.

- [ ] **Step 2: Update halt-path.test.ts**

Find the assertion currently at line 160-162 (`report.errorCode === 'sbox-parse-failed'`). Update per T7 outcome.

If new halt site is e.g. `phase: 'evaluate'` with `errorCode: 'method-not-implemented'` at h=1, the assertion becomes:

```ts
expect(report.phase).toBe('evaluate')
expect(report.errorCode).toBe('method-not-implemented')
expect(report.height).toBe(1)
```

If halts scatter, use shape-only:

```ts
expect(['output-roundtrip', 'evaluate', 'verify-signature']).toContain(report.phase)
expect(report.height).toBeGreaterThanOrEqual(1)
```

- [ ] **Step 3: Update tip-reach-path.test.ts**

Same treatment as halt-path. The current line 185 assertion `stillThere.errorCode === 'sbox-parse-failed'` updates analogously.

- [ ] **Step 4: Update resume-path.test.ts**

If T7 indicated that resume now CAN walk further (where it previously halted at h=1 unconditionally), update the test to assert the new resumed-walk behavior. Otherwise leave the test mostly as-is and only update narrative comments.

- [ ] **Step 5: Run integration tests**

```bash
cd tools/mainnet-validate/harness && npm test
cd /home/mwaddip/projects/ergots
```

Expected: all three integration tests pass against the new halt site.

- [ ] **Step 6: Stage + commit**

```bash
git add tools/mainnet-validate/harness/test/integration/
git commit -m "$(cat <<'EOF'
test(2j-pre/fix-1): refresh harness integration-test snapshots (T8)

Updates halt-path.test.ts + tip-reach-path.test.ts + resume-path.test.ts
to reflect the new halt site observed in T7 ({new phase}/{new errorCode}
at h={new height}). The previous snapshots pinned the now-resolved
sbox-parse-failed halt; without this refresh the tests would fail
against the post-fix-1 harness.

{If shape-only assertions used instead: brief reason.}

Per spec §Decision 6. T8 of 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: SESSION_CONTEXT + HANDOFF + memory refresh + push

**Files:**
- Edit: `SESSION_CONTEXT.md` — refresh to post-fix-1 state.
- Edit: `HANDOFF_PROMPT.md` — refresh to point at fix-2 (shim walker bug) OR direct 2j proper if fix-2 is folded in.
- Edit: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` — append fix-1 closure + new halt site if surfaced.

- [ ] **Step 1: SESSION_CONTEXT.md sweep**

Update to reflect:
- Phase 2j-pre fix-1 COMPLETE.
- Commit count this session.
- Test counts (3194 + N new tests, where N is from T2 + T4).
- Fix-list item 1 RESOLVED; fix-list item 2 (shim walker) STILL OPEN; new halt-site item N+1 captured (if T7 surfaced one).

- [ ] **Step 2: HANDOFF_PROMPT.md refresh**

Update §"Phase 2j-pre fix-list":
- Strike item 1 with RESOLVED in commit {sha} (T3 of fix-1 plan).
- Keep item 2 as next.
- Add new item N+1 if T7 surfaced one — same format (file path + error code + reproducer).

Update §"Phase plan status" to add `✅ Phase 2j-pre fix-1` entry between 2j-pre and 2j proper.

- [ ] **Step 3: facts/ sweep**

Verify facts files reflect:
- `facts/ergoscript.md` — error-model overview shouldn't need changes (taxonomy is in `ergoscript-wire.md`).
- `facts/ergoscript-wire.md` — already updated in T5.

- [ ] **Step 4: Memory refresh**

Append to `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`:
- Date 2026-05-22.
- Fix-1 closure summary.
- Updated phase status.
- Updated commit-table.

- [ ] **Step 5: Push**

```bash
git push origin master
```

Per OVERRIDES + project convention: never `--force`, never `--no-verify`.

- [ ] **Step 6: Final verification**

```bash
git status                          # CLEAN modulo audit20260519/
git log --oneline -12               # confirm: PLAN + 7 task commits + spec
ls packages/ergoscript/test/parse-svalue-sbox-no-size.test.ts
```

- [ ] **Step 7: Stage + commit (final docs only — push happens above)**

```bash
git add SESSION_CONTEXT.md HANDOFF_PROMPT.md
git commit -m "$(cat <<'EOF'
docs(2j-pre/fix-1): SESSION_CONTEXT + HANDOFF_PROMPT refresh + memory (T9)

Marks 2j-pre fix-1 COMPLETE. Fix-list item 1 (sbox-ergo-tree-no-size)
RESOLVED in commit {T3 sha}. Fix-list item 2 (shim walker missing-utxo
at h=3850) STILL OPEN — next focused-fix spec.

{If T7 surfaced new halt: brief item-N+1 paragraph.}

T9 of 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push origin master
```

---

## Done criteria for this phase

- All 9 tasks committed.
- `git status` clean modulo `audit20260519/`.
- `origin/master` aligned with local `master`.
- `npx tsc --noEmit -p packages/ergoscript/tsconfig.json` CLEAN.
- `node_modules/.bin/vitest run packages/ergoscript` — all pass including new T2/T4 tests.
- Cross-runtime jsdom pass.
- `grep "sbox-ergo-tree-no-size"` returns zero hits across the entire repo (including refreshed `dist/`).
- `packages/ergoscript/dist/` rebuilt; reflects post-fix source.
- Layer 3 smoke ran AND results documented in commit + findings file.
- Harness integration-test snapshots refreshed; `npm test` in `tools/mainnet-validate/harness/` passes.
- SESSION_CONTEXT.md + HANDOFF_PROMPT.md reflect post-fix-1 state.
- `project_ergots_direction` memory refreshed.

**Done criteria explicitly NOT in scope:**
- Fixing the shim walker bug at `block_walker.rs:535` (fix-list item 2; separate focused spec).
- Walking the chain to tip cleanly (2j proper).
- Implementing every method handler the chain demands (2j proper).
- Closing every cost-related divergence (2j proper).
