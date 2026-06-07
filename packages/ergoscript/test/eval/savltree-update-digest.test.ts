/**
 * SAvlTree.updateDigest (100:15) — Tier-2 mutator op handler.
 *
 * Fixture-driven oracle suite (T7 of phase 2h-d, updated in F4 epilogue
 * 2026-06-07). Handler implementation lives at `src/eval/savltree.ts`.
 *
 * Pattern A Fixed(40): `ctx.addCost(40)` runs BEFORE the AvlTree shape
 * check, mirroring sigma-rust's `ctx.add_jit_cost(40)?` at savltree.rs:91.
 *
 * JVM CAvlTree.scala:31-34 has NO length require on updateDigest. Any
 * Coll[Byte] length is accepted verbatim and projected into a new AvlTreeData.
 * The previous 33-byte gate (mirroring sigma-rust's ADDigest::try_from shape)
 * was a convergent over-reject not present in the JVM; retired in F4 epilogue
 * (code 'avl-tree-bad-digest-length' removed from taxonomy: 80 → 79).
 *
 * Scenario coverage:
 *   1. update_digest_replace_33_byte  — happy path; new 33-byte digest verbatim.
 *   2. update_digest_replace_32_byte  — 32-byte digest accepted (any length OK).
 *
 * Test uses the canonical multi-scenario template from
 * `test/eval/coll-exists.test.ts:64-97`. Each entry branches on
 * `expected_error_code !== null`:
 *   - Throw branch: `captureEvalError` + `expect(err.code).toBe(...)`.
 *     Cost is NOT asserted on throw entries (fixture sentinels `expected_cost: 0`).
 *   - Success branch: assert value matches hydrated SValue + cost matches
 *     fixture-recorded `ctx.jitCost`.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:90-102 — UPDATE_DIGEST_EVAL_FN.
 *         JVM CAvlTree.scala:31-34 (no length require — any digest length accepted).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import type { MethodCall, SType, SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import { runMutationLoop, evalSafely, DEFAULT_KILL_THRESHOLD } from '../_helpers/mutation-harness'

interface UpdateDigestEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface UpdateDigestFixture {
  corpus: string
  entries: UpdateDigestEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-update-digest.json')
const fixture: UpdateDigestFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.updateDigest (100:15) — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))

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

// ---------------------------------------------------------------------------
// Edge cases (T8 — defensive throws via the dispatcher, updated F4 epilogue)
//
// Mirrors `test/eval/savltree-update-operations.test.ts` (T4) — same hand-
// crafted `MethodCall` pattern via `evalMethodCall` to drive the dispatcher's
// full cost path. Pattern A Fixed(40) means `addCost(40)` fires BEFORE the
// AvlTree shape check, BEFORE `expectOneArg`, and BEFORE `extractBytes`,
// so defensive throws observe jitCost = 4 (dispatcher) + 5 (Const obj) +
// 5 (Const arg) + 40 (handler) = 54 at error time.
//
// Since the 33-byte length gate is removed (F4 epilogue, JVM any-length),
// the 0-byte and 34-byte cases now SUCCEED and are pinned as acceptance cases.
//
// Four cases:
//   1. non-AvlTree receiver      → 'avl-tree-obj-not-avl-tree'
//   2. non-Coll arg              → 'method-not-implemented' (via extractBytes)
//   3. 0-byte Coll[Byte] arg     → Some(AvlTree with 0-byte digest) @ cost 54
//   4. 34-byte Coll[Byte] arg    → Some(AvlTree with 34-byte digest) @ cost 54
//   5. cost-limit < 54           → 'cost-limit-exceeded' (addCost(40) trips first)
// ---------------------------------------------------------------------------

/** Module-level SType singletons reused across edge-case + mutation tests. */
const SBYTE: SType = { tag: 'SByte' }
const SCOLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }
const SAVL_TREE: SType = { tag: 'SAvlTree' }
const SLONG: SType = { tag: 'SLong' }

/**
 * Fresh hand-crafted AvlTreeData carrier — matches the fixture's digest
 * (33 0x42 bytes) + flags (7) + keyLength (32). Reused across edge cases that
 * need a real SAvlTree-typed Const receiver.
 */
function makeAvlTreeConstValue(): SValue {
  return {
    kind: 'AvlTree',
    value: {
      digest: new Uint8Array(33).fill(0x42),
      treeFlags: 7,
      keyLength: 32,
      valueLengthOpt: null,
    },
  }
}

/** Build a `Coll[Byte]` SValue from a Uint8Array (handler will round-trip via extractBytes). */
function makeCollByteValue(bytes: Uint8Array): SValue {
  const items: SValue[] = []
  for (let i = 0; i < bytes.length; i++) {
    // i8 round-trip: parser yields signed -128..127; extractBytes recovers u8 via `& 0xff`.
    const b = bytes[i]!
    items.push({ kind: 'Byte', value: b > 127 ? b - 256 : b })
  }
  return { kind: 'Coll', elem: SBYTE, items }
}

describe('SAvlTree.updateDigest — edge cases', () => {
  it("throws 'avl-tree-obj-not-avl-tree' on non-AvlTree receiver", () => {
    // obj is a Long Const — evalExpr yields { kind: 'Long' }, which fails
    // expectAvlTree (savltree.ts:71-81) → 'avl-tree-obj-not-avl-tree'.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 100,
      methodId: 15,
      obj: { tag: 'Const', tpe: SLONG, value: { kind: 'Long', value: 42n } },
      args: [
        {
          tag: 'Const',
          tpe: SCOLL_BYTE,
          value: makeCollByteValue(new Uint8Array(33).fill(0xab)),
        },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('avl-tree-obj-not-avl-tree')
    expect(err.message).toContain('SAvlTree.updateDigest')
    // Pattern A: cost charged BEFORE shape check. 4 + 5 + 5 + 40 = 54.
    expect(ctx.jitCost).toBe(54)
  })

  it("throws 'method-not-implemented' when arg is not a Coll (extractBytes defensive)", () => {
    // args[0] is a Long Const — evalExpr yields { kind: 'Long' }, which fails
    // extractBytes's `v.kind !== 'Coll'` check (_avltree-adapter.ts:166-172)
    // → 'method-not-implemented'.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 100,
      methodId: 15,
      obj: {
        tag: 'Const',
        tpe: SAVL_TREE,
        value: makeAvlTreeConstValue(),
      },
      args: [
        { tag: 'Const', tpe: SLONG, value: { kind: 'Long', value: 5n } },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
    expect(err.message).toContain("Coll[Byte]")
    // 4 + 5 + 5 + 40 = 54 (Pattern A; extractBytes throw runs after addCost(40)).
    expect(ctx.jitCost).toBe(54)
  })

  it("accepts 0-byte Coll[Byte] arg — any digest length OK (JVM CAvlTree.scala:31-34)", () => {
    // JVM has no length require on updateDigest. Empty Coll[Byte] → extractBytes
    // returns 0-byte Uint8Array → projected verbatim into new AvlTreeData.
    // Returns AvlTree with 0-byte digest @ cost 54. ('avl-tree-bad-digest-length'
    // retired from taxonomy in F4 epilogue: codes 80 → 79.)
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 100,
      methodId: 15,
      obj: { tag: 'Const', tpe: SAVL_TREE, value: makeAvlTreeConstValue() },
      args: [
        { tag: 'Const', tpe: SCOLL_BYTE, value: makeCollByteValue(new Uint8Array(0)) },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result.kind).toBe('AvlTree')
    if (result.kind === 'AvlTree') {
      expect(result.value.digest).toEqual(new Uint8Array(0))
      expect(result.value.treeFlags).toBe(7)
      expect(result.value.keyLength).toBe(32)
      expect(result.value.valueLengthOpt).toBeNull()
    }
    // Pattern A: addCost(40) fires before returning. 4 + 5 + 5 + 40 = 54.
    expect(ctx.jitCost).toBe(54)
  })

  it("accepts 34-byte Coll[Byte] arg — any digest length OK (over-by-one boundary)", () => {
    // JVM accepts any digest length verbatim. 34-byte arg → AvlTree with
    // 34-byte digest @ cost 54. (Was 'avl-tree-bad-digest-length' before F4
    // epilogue; the 32-byte boundary is now covered by the fixture's
    // update_digest_replace_32_byte entry.)
    const digestBytes = new Uint8Array(34).fill(0xab)
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 100,
      methodId: 15,
      obj: { tag: 'Const', tpe: SAVL_TREE, value: makeAvlTreeConstValue() },
      args: [
        {
          tag: 'Const',
          tpe: SCOLL_BYTE,
          value: makeCollByteValue(digestBytes),
        },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result.kind).toBe('AvlTree')
    if (result.kind === 'AvlTree') {
      expect(result.value.digest).toEqual(digestBytes)
      expect(result.value.treeFlags).toBe(7)
      expect(result.value.keyLength).toBe(32)
      expect(result.value.valueLengthOpt).toBeNull()
    }
    // Pattern A. 4 + 5 + 5 + 40 = 54.
    expect(ctx.jitCost).toBe(54)
  })

  it("throws 'cost-limit-exceeded' if jitCostLimit < 54 (Pattern A charges before shape check)", () => {
    // Verify the addCost(40) charge fires BEFORE any shape check — even on a
    // would-be-failing receiver, cost-limit-exceeded wins because cost is
    // first. Set jitCostLimit=50: dispatcher 4 + Const obj 5 + Const arg 5
    // = 14, then handler addCost(40) → 54 > 50 → 'cost-limit-exceeded'.
    // The receiver is intentionally a Long (would-fail receiver-defense),
    // demonstrating that cost trips first.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 100,
      methodId: 15,
      obj: { tag: 'Const', tpe: SLONG, value: { kind: 'Long', value: 42n } },
      args: [
        {
          tag: 'Const',
          tpe: SCOLL_BYTE,
          value: makeCollByteValue(new Uint8Array(33).fill(0xab)),
        },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({ jitCostLimit: 50 })
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('cost-limit-exceeded')
  })
})

// ---------------------------------------------------------------------------
// Mutation testing (T8 — single-byte XOR mutations across tree_bytes_hex)
//
// Pattern mirrors `test/eval/savltree-update-operations.test.ts` (T4): three
// XOR patterns per byte (0xFF, 0x01, 0x80); kill iff the mutated outcome
// observably diverges from the baseline. Same helpers (`evalSafely`,
// `svalueEqual`, `isKill`) and threshold (`THRESHOLD = 0.9`).
//
// Scope: ONLY the first happy scenario (`update_digest_replace_33_byte`) is
// mutated. Both fixture entries are now happy (F4 epilogue removed the throw);
// the second entry (32-byte) has a narrower mutation surface and the 33-byte
// entry provides sufficient signal.
//
// MUTATION SURFACE — happy scenario (33-byte), 77-byte tree, restricted:
//   - offsets 0..4       (header + opcode 0xdc + typeId 100 + methodId 15 + AvlTree const opcode)
//   - offsets 38..76     (treeFlags + keyLength + valueLengthOpt + args-count +
//                         arg const tpe SColl[SByte] + 33-byte NEW digest)
//   EXCLUDED:
//   - offsets 5..37 inclusive (33 bytes — the RECEIVER's digest inside the
//     SAvlTree const). This is the LOAD-BEARING TOLERANCE: updateDigest's
//     job is to REPLACE the receiver's digest with args[0]. The handler
//     calls `withUpdatedDigest(obj.value, newDigest)` which substitutes
//     args[0] verbatim and ignores the input receiver digest entirely. Any
//     single-byte mutation to those 33 bytes is by design semantically
//     invisible — the output AvlTree has identical bytes regardless. This is
//     not a bug in the test or a missing kill in the handler; it is the
//     defining behavior of the method. Mutating these bytes inflates the
//     denominator with handler-by-design tolerances and lowers the kill
//     rate from ~0.985 (real signal) to ~0.56 (artifact of the test
//     denominator), with no improvement in coverage.
//
//   Mutation surface after exclusion: (5 + 39) bytes × 3 patterns = 132 mutations.
//
// TOLERATED (survived) mutations within the included surface — observed:
//   - offset 0 (header byte, 0x00), xor 0x01 → 0x01 (v1 header tag): parses
//     identically with no constants section; body unchanged.
//   - offset 0 (header byte, 0x00), xor 0x80 → 0x80 (reserved bit set):
//     parser tolerates the reserved bit per the wire spec; body unchanged.
//   No other tolerances. Observed rate: 130 killed / 132 = 0.985.
// ---------------------------------------------------------------------------

/**
 * Receiver-digest byte range inside `update_digest_replace_33_byte`'s
 * tree_bytes_hex. Excluded from the mutation surface (load-bearing tolerance
 * — see comment block above). Inclusive on both ends.
 */
const RECEIVER_DIGEST_START = 5
const RECEIVER_DIGEST_END = 37

describe('SAvlTree.updateDigest — mutation testing', () => {
  // First happy entry (33-byte). Both fixture entries are happy after F4 epilogue.
  const happyEntry = fixture.entries.find((e) => e.expected_error_code === null)
  if (happyEntry === undefined) {
    throw new Error('expected at least one happy-path entry in savltree-update-digest fixture')
  }

  it(`${happyEntry.name}: ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on non-tolerated byte mutations`, () => {
    const treeBytes = hexToBytes(happyEntry.tree_bytes_hex)

    // Precondition: baseline must succeed for kill-rate math to mean anything.
    const baseline = evalSafely(treeBytes, happyEntry.opts_json)
    expect(baseline.ok).toBe(true)

    // Build the exclusion set: receiver-digest bytes are replaced verbatim
    // by withUpdatedDigest; mutating them is semantically invisible.
    const excludedOffsets = new Set<number>()
    for (let i = RECEIVER_DIGEST_START; i <= RECEIVER_DIGEST_END; i++) {
      excludedOffsets.add(i)
    }

    const result = runMutationLoop({
      treeBytes,
      region: { start: 0, end: treeBytes.length },
      optsJson: happyEntry.opts_json,
      excludedOffsets,
    })

    // eslint-disable-next-line no-console
    console.log(
      `[mutation] updateDigest.${happyEntry.name}: killed=${result.killed} ` +
        `total=${result.total} rate=${result.rate.toFixed(3)} bytes=${treeBytes.length} ` +
        `(excluded receiver-digest offsets ${RECEIVER_DIGEST_START}..${RECEIVER_DIGEST_END})`,
    )
    expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
