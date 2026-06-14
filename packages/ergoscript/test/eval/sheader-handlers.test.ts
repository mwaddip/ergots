/**
 * SHeader property accessor handlers (typeId 104, methodIds 1-15) — Phase 2h-c.1.
 *
 * Two test suites:
 *   1. Oracle fixture-driven: 15 entries from eval/sheader-handlers.json, one per handler.
 *      Each entry evaluates the tree PropertyCall(ByIndex(PropertyCall(Context, headers), 0), method)
 *      and asserts value + cost match sigma-rust's oracle output.
 *   2. Defensive obj-kind check: 3 parameterized tests confirming each handler throws
 *      'header-obj-not-header' when the receiver is not a Header SValue.
 *
 * Source: ergotree-interpreter/src/eval/sheader.rs:16-113
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'
import {
  evalSHeaderId,
  evalSHeaderHeight,
  evalSHeaderStateRoot,
  evalSHeaderMinerPk,
  evalSHeaderPowOnetimePk,
  evalSHeaderPowDistance,
  evalSHeaderTimestamp,
} from '../../src/eval/sheader'
import { GROUP_GENERATOR_BYTES } from '../../src/eval/_group-generator'
import type { SValue } from '../../src/mir/types'
import type { Header } from '@ergots/scorex'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sheader-handlers.json')

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, 'utf-8'))

// ---------- Oracle fixture-driven tests ----------

describe('SHeader handlers — oracle fixture-driven (Phase 2h-c.1)', () => {
  for (const entry of fixture.entries) {
    // header_state_root is a documented ergots-LEADS-sigma-rust divergence (F5
    // batch 2): the sigma-rust oracle returns the raw 33-byte digest as Coll[Byte]
    // (sheader.rs:40-44), but the JVM returns AvlTree (CHeader.scala:29). ergots
    // follows the JVM, so the sigma-rust oracle value for this entry is stale. Its
    // JVM-aligned behavior (AvlTree, same cost 69) is asserted in the dedicated
    // suite below — the fixture data is kept as a record of sigma-rust's output.
    if (entry.name === 'header_state_root') continue
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

// ---------- SHeader.stateRoot: JVM AvlTree (sigma-rust divergence) ----------

describe('SHeader.stateRoot returns AvlTree (JVM CHeader.scala:29; F5 batch 2)', () => {
  // JVM CHeader.stateRoot = CAvlTree(avlTreeFromDigest(stateRoot)):
  //   flags(insert,update,remove) = 0b111, keyLength = crypto.hashLength = 32,
  //   valueLengthOpt = None. sigma-rust diverges (raw 33-byte digest as
  //   Coll[Byte], sheader.rs:40-44); ergots LEADS sigma-rust here.

  function makeHeader(stateRoot: Uint8Array): Header {
    return {
      version: 2,
      id: new Uint8Array(32),
      parentId: new Uint8Array(32),
      adProofsRoot: new Uint8Array(32),
      stateRoot,
      transactionRoot: new Uint8Array(32),
      timestamp: 0n,
      nBits: 0,
      height: 0,
      extensionRoot: new Uint8Array(32),
      autolykosSolution: {
        minerPk: new Uint8Array(33),
        powOnetimePk: null,
        nonce: new Uint8Array(8),
        powDistance: null,
      },
      votes: new Uint8Array(3),
      unparsedBytes: new Uint8Array(0),
    }
  }

  it('direct handler: synthesizes AvlTree from the 33-byte stateRoot digest; cost 10', () => {
    const stateRoot = new Uint8Array(33)
    for (let i = 0; i < 33; i++) stateRoot[i] = (i * 7 + 1) & 0xff
    const obj: SValue = { kind: 'Header', value: makeHeader(stateRoot) }
    const ctx = makeContext({})

    const result = evalSHeaderStateRoot(obj, [], ctx)

    expect(result).toEqual({
      kind: 'AvlTree',
      value: { digest: stateRoot, treeFlags: 0b00000111, keyLength: 32, valueLengthOpt: null },
    })
    expect(ctx.jitCost).toBe(10) // Pattern A Fixed(10)
  })

  it('full chain Context.headers[0].stateRoot evaluates to AvlTree; cost 69', () => {
    // Reuse the (skipped) oracle entry's tree + opts so the dispatch path and
    // cost (69) are identical — only the expected VALUE is JVM-aligned (AvlTree).
    const entry = fixture.entries.find((e) => e.name === 'header_state_root')!
    const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
    const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
    const value = evaluateWith(tree, ctx)
    const headers = entry.opts_json.headers as { stateRoot: string }[]
    const stateRoot = hexToBytes(headers[0]!.stateRoot)
    expect(value).toEqual({
      kind: 'AvlTree',
      value: { digest: stateRoot, treeFlags: 0b00000111, keyLength: 32, valueLengthOpt: null },
    })
    expect(ctx.jitCost).toBe(69)
  })
})

// ---------- Defensive obj-kind check ----------

describe('SHeader.* defensive obj-kind check', () => {
  // Direct handler call with a non-Header obj — each should throw 'header-obj-not-header'.
  const longVal: SValue = { kind: 'Long', value: 42n }
  const emptyCtx = makeContext({})

  it('evalSHeaderId (104:1) throws header-obj-not-header on non-Header obj', () => {
    const err = captureEvalError(() => evalSHeaderId(longVal, [], emptyCtx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('header-obj-not-header')
  })

  it('evalSHeaderHeight (104:9) throws header-obj-not-header on non-Header obj', () => {
    const err = captureEvalError(() => evalSHeaderHeight(longVal, [], emptyCtx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('header-obj-not-header')
  })

  it('evalSHeaderMinerPk (104:11) throws header-obj-not-header on non-Header obj', () => {
    const err = captureEvalError(() => evalSHeaderMinerPk(longVal, [], emptyCtx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('header-obj-not-header')
  })
})

// ---------- V2 null-branch coverage ----------

describe('SHeader V2-header null-branch coverage', () => {
  // V2 (version >= 2) headers have powOnetimePk and powDistance both null per
  // the AutolykosSolution wire format. The handler synthesizes the GENERATOR for
  // powOnetimePk (JVM ErgoHeader.scala:57-58 `wForV2 = dlogGroup.generator`; F5
  // batch 2 — ergots LEADS sigma-rust, which returns EcPoint::default() identity)
  // and BigInt 0n for powDistance (sigma-rust .unwrap_or_default()).
  //
  // The deterministic Context::arbitrary() seed used by fixture-gen always produces
  // V1 headers, so these branches are dead code in the oracle fixture suite.
  // Direct unit tests are the only path to cover them.

  function makeV2Header(): Header {
    return {
      version: 2,
      id: new Uint8Array(32),
      parentId: new Uint8Array(32),
      adProofsRoot: new Uint8Array(32),
      stateRoot: new Uint8Array(33),
      transactionRoot: new Uint8Array(32),
      timestamp: 0n,
      nBits: 0,
      height: 0,
      extensionRoot: new Uint8Array(32),
      autolykosSolution: {
        minerPk: new Uint8Array(33),
        powOnetimePk: null,   // V2: absent on wire
        nonce: new Uint8Array(8),
        powDistance: null,    // V2: absent on wire
      },
      votes: new Uint8Array(3),
      unparsedBytes: new Uint8Array(0),
    }
  }

  it('evalSHeaderPowOnetimePk (104:12) returns the generator when null (V2 wForV2)', () => {
    const header = makeV2Header()
    const obj: SValue = { kind: 'Header', value: header }
    const ctx = makeContext({})

    const result = evalSHeaderPowOnetimePk(obj, [], ctx)

    expect(result).toEqual({ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES })
    expect(ctx.jitCost).toBe(10) // Pattern A Fixed(10)
  })

  it('evalSHeaderPowOnetimePk (104:12) returns the parsed w unchanged for a V1 header (non-null)', () => {
    // V1 headers carry a real powOnetimePk (parsed w). The handler returns it
    // verbatim — the generator fallback only fires on the null (V2) branch.
    const w = new Uint8Array(33)
    w[0] = 0x03
    for (let i = 1; i < 33; i++) w[i] = (i * 5 + 2) & 0xff
    const header: Header = { ...makeV2Header(), version: 1 }
    header.autolykosSolution = { ...header.autolykosSolution, powOnetimePk: w }
    const obj: SValue = { kind: 'Header', value: header }
    const ctx = makeContext({})

    const result = evalSHeaderPowOnetimePk(obj, [], ctx)

    expect(result).toEqual({ kind: 'GroupElement', value: w })
    if (result.kind !== 'GroupElement') throw new Error('unreachable')
    expect(result.value).toBe(w) // verbatim, no copy
    expect(ctx.jitCost).toBe(10)
  })

  it('evalSHeaderPowDistance (104:14) returns 0n when null (V2)', () => {
    const header = makeV2Header()
    const obj: SValue = { kind: 'Header', value: header }
    const ctx = makeContext({})

    const result = evalSHeaderPowDistance(obj, [], ctx)

    expect(result).toEqual({ kind: 'BigInt', value: 0n })
    expect(ctx.jitCost).toBe(10) // Pattern A Fixed(10)
  })
})

// ---------- Signed i64 view of timestamp ----------

describe('SHeader.timestamp signed i64 view (F2 #4)', () => {
  // The JVM surfaces header.timestamp as Long (i64). scorex Header.timestamp is
  // now bigint (lossless u64 since F2). Timestamps in [2^63, 2^64) are NEGATIVE
  // Longs script-side — BigInt.asIntN(64, ·) is the exact reinterpretation.
  it('SHeader.timestamp surfaces u64 >= 2^63 as the SIGNED Long (JVM i64 view)', () => {
    const header: Header = {
      version: 2,
      id: new Uint8Array(32),
      parentId: new Uint8Array(32),
      adProofsRoot: new Uint8Array(32),
      stateRoot: new Uint8Array(33),
      transactionRoot: new Uint8Array(32),
      timestamp: 0xffffffffffffffffn,
      nBits: 0,
      height: 0,
      extensionRoot: new Uint8Array(32),
      autolykosSolution: {
        minerPk: new Uint8Array(33),
        powOnetimePk: null,
        nonce: new Uint8Array(8),
        powDistance: null,
      },
      votes: new Uint8Array(3),
      unparsedBytes: new Uint8Array(0),
    }
    const obj: SValue = { kind: 'Header', value: header }
    const ctx = makeContext({})

    const result = evalSHeaderTimestamp(obj, [], ctx)

    // u64 max (0xffffffffffffffff) reinterpreted as i64 = -1
    expect(result).toEqual({ kind: 'Long', value: -1n })
    expect(ctx.jitCost).toBe(10) // ACCESSOR_COST
  })
})
