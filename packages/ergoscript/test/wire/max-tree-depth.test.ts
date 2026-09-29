/**
 * MaxTreeDepth (110) deserialization depth limit — STRUCTURAL, cross-cutting.
 *
 * The JVM enforces a SINGLE shared recursion-depth counter (`CoreByteReader.level`,
 * default cap `SigmaConstants.MaxTreeDepth = 110`) across ALL deserialization:
 *   - every Expr/Value node               (ValueSerializer.deserialize,    :393-408)
 *   - every data value                    (CoreDataSerializer.deserialize, :95-148)
 *   - every SigmaBoolean node             (SigmaBoolean.serializer.parse,  :71-104)
 * all incrementing the same `r.level`, throwing `DeserializeCallDepthExceeded` when
 * a call would push level > 110 (`CoreByteReader.level_=`, :127-131). A fresh reader
 * starts at level 0; the first call sets level 1; the call that would set level 111
 * throws. Decrement on exit ⇒ it is DEPTH, not a running total.
 *
 * These tests pin the structural property across EVERY ergots parse-recursion kind:
 * expr-tree (`parseTree`), data (`deserializeTo[Coll/Option/Tuple]`), sigma-boolean
 * (`deserializeTo[SigmaProp]`), and box internals (nested register / nested ergoTree).
 * A future un-counted parse path would FAIL one of these.
 *
 * Off-by-one anchors (derived from source, each consensus-load-bearing):
 *   - data:  parseSValue increments once/call from a fresh level-0 reader.
 *            N present-data-values deep ⇒ deepest level N. 110 OK / 111 throws.
 *   - expr:  parseExpr increments once/node; a Const leaf is parseExpr(+1) THEN
 *            parseSValue(+1) = 2 levels (mirrors ValueSerializer→DataSerializer).
 *            K `LogicalNot` wrappers + 1 `Const(SBoolean)` ⇒ deepest K+2.
 *   - sigma: parseSValue(SSigmaProp)=L1, then each parseSigmaBoolean=+1. K nested
 *            single-child Cand + 1 leaf ⇒ deepest K+2.
 */

import { describe, expect, it } from 'vitest'
import { ByteReader, ByteWriter, ReaderError } from '@ergots/scorex'
import { parseParsedTree as parseTree } from '../_helpers'
import { serializeExpr } from '../../src/wire/serialize'
import { serializeSigmaBoolean } from '../../src/wire/sigma-boolean'
import { parseSValue } from '../../src/wire/parse-svalue'
import { parseTreeFromReader } from '../../src/wire/ergo-tree'
import { serializeSType } from '../../src/wire/serialize-stype'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { Expr, MethodCall, SigmaBoolean, SType, SValue } from '../../src/mir/types'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** A `Const(SBoolean, true)` leaf Expr. */
const BOOL_LEAF: Expr = {
  tag: 'Const',
  tpe: { tag: 'SBoolean' },
  value: { kind: 'Boolean', value: true },
}

/** K nested `LogicalNot` wrappers around a `Const(SBoolean)` leaf. */
function logicalNotChain(k: number): Expr {
  let e: Expr = BOOL_LEAF
  for (let i = 0; i < k; i++) e = { tag: 'LogicalNot', input: e }
  return e
}

/** Serialize a body Expr into a standalone ErgoTree (header 0x00: v0, no size, no segregation). */
function treeBytesFromBody(body: Expr): Uint8Array {
  const w = new ByteWriter()
  w.writeU8(0x00) // header: version 0, hasSize=false, segregation=false
  serializeExpr(body, w, 0)
  return w.toBytes()
}

const SBYTE: SType = { tag: 'SByte' }
const COLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }

function collByteConst(bytes: number[]): MethodCall['args'][number] {
  const items: SValue[] = bytes.map((b) => ({ kind: 'Byte', value: b }))
  return { tag: 'Const', tpe: COLL_BYTE, value: { kind: 'Coll', elem: SBYTE, items } }
}

/** A `Global.deserializeTo[T](Coll[Byte])` MethodCall over `bytes`. */
function deserExpr(T: SType, bytes: number[]): MethodCall {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 4,
    args: [collByteConst(bytes)],
    explicitTypeArgs: { T },
  }
}

/** K nested single-child `Cand` wrappers around a `TrivialProp(true)` leaf. */
function candChain(k: number): SigmaBoolean {
  let sb: SigmaBoolean = { tag: 'TrivialProp', value: true }
  for (let i = 0; i < k; i++) sb = { tag: 'Cand', items: [sb] }
  return sb
}

/** Bytes of a nested-Cand SigmaBoolean, for `deserializeTo[SigmaProp]`. */
function sigmaBytes(sb: SigmaBoolean): number[] {
  const w = new ByteWriter()
  serializeSigmaBoolean(sb, w)
  return Array.from(w.toBytes())
}

// ---------------------------------------------------------------------------
// 1) EXPR-TREE nesting via the general parseTree path
// ---------------------------------------------------------------------------

describe('MaxTreeDepth — expr-tree (parseTree)', () => {
  it('K=108 LogicalNot + Const(SBoolean) leaf (deepest level 110) is ACCEPTED', () => {
    const bytes = treeBytesFromBody(logicalNotChain(108))
    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('LogicalNot')
  })

  it('K=109 LogicalNot + Const(SBoolean) leaf (deepest level 111) is REJECTED', () => {
    const bytes = treeBytesFromBody(logicalNotChain(109))
    let err: unknown
    try {
      parseTree(bytes)
    } catch (e) {
      err = e
    }
    // Single faithful depth error — the shared reader counter throws ReaderError
    // exactly as the JVM throws DeserializeCallDepthExceeded from CoreByteReader.
    // It propagates unwrapped from the wire layer, like ReaderError('truncated').
    expect(err).toBeInstanceOf(ReaderError)
    expect((err as ReaderError).code).toBe('max-tree-depth-exceeded')
  })
})

// ---------------------------------------------------------------------------
// 2) DATA nesting via deserializeTo[Coll/Option/Tuple]
//    (the existing data-driven property — re-pinned here for the unified counter)
// ---------------------------------------------------------------------------

describe('MaxTreeDepth — data (deserializeTo)', () => {
  it('Coll: data recursing to exactly depth 110 is allowed', () => {
    let T: SType = { tag: 'SByte' }
    for (let i = 0; i < 110; i++) T = { tag: 'SColl', elem: T }
    const data = new Array(109).fill(1).concat([0]) // 109 len-1 markers + innermost len 0
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(T, data), Env.empty(), ctx)
    expect(r).toMatchObject({ kind: 'Coll' })
  })

  it('Coll: data recursing past depth 110 throws global-deserialize-failed', () => {
    let T: SType = { tag: 'SByte' }
    for (let i = 0; i < 111; i++) T = { tag: 'SColl', elem: T }
    const deepData = new Array(115).fill(1)
    const ctx = makeContext({ treeVersion: 3 })
    let err: unknown
    try {
      evalMethodCall(deserExpr(T, deepData), Env.empty(), ctx)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EvalError)
    expect((err as EvalError).code).toBe('global-deserialize-failed')
  })

  it('Coll: deeply-nested TYPE with empty data is ACCEPTED (data-driven, not type depth)', () => {
    let T: SType = { tag: 'SByte' }
    for (let i = 0; i < 200; i++) T = { tag: 'SColl', elem: T }
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(T, [0]), Env.empty(), ctx)
    expect(r).toMatchObject({ kind: 'Coll', items: [] })
  })

  it('Option: 109 Some-wrapped Options + present inner (depth 110) accepted; +1 (111) rejected', () => {
    // deserializeTo[Option[Option[...Byte]]]; each Some tag = 0x01, innermost Byte present.
    // parseSValue depth: outer Option = L1 ... so K Options + 1 Byte leaf ⇒ deepest K+1.
    // K=109 Options + Byte ⇒ 110 (accept). data: 109 Some-tags (0x01) + 1 byte.
    let Tok: SType = { tag: 'SByte' }
    for (let i = 0; i < 109; i++) Tok = { tag: 'SOption', elem: Tok }
    const ctxOk = makeContext({ treeVersion: 3 })
    const rOk = evalMethodCall(
      deserExpr(Tok, new Array(109).fill(1).concat([7])),
      Env.empty(),
      ctxOk,
    )
    expect(rOk).toMatchObject({ kind: 'Option' })

    let Tbad: SType = { tag: 'SByte' }
    for (let i = 0; i < 110; i++) Tbad = { tag: 'SOption', elem: Tbad }
    const ctxBad = makeContext({ treeVersion: 3 })
    let err: unknown
    try {
      evalMethodCall(deserExpr(Tbad, new Array(110).fill(1).concat([7])), Env.empty(), ctxBad)
    } catch (e) {
      err = e
    }
    expect((err as EvalError).code).toBe('global-deserialize-failed')
  })
})

// ---------------------------------------------------------------------------
// 3) SIGMA-BOOLEAN nesting via deserializeTo[SigmaProp]  (the reviewer's case)
// ---------------------------------------------------------------------------

describe('MaxTreeDepth — sigma-boolean (deserializeTo[SigmaProp])', () => {
  const SSIGMAPROP: SType = { tag: 'SSigmaProp' }

  it('K=108 nested Cand + TrivialProp leaf (deepest level 110) is ACCEPTED', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(SSIGMAPROP, sigmaBytes(candChain(108))), Env.empty(), ctx)
    expect(r).toMatchObject({ kind: 'SigmaProp' })
  })

  it('K=109 nested Cand + TrivialProp leaf (deepest level 111) is REJECTED', () => {
    const ctx = makeContext({ treeVersion: 3 })
    let err: unknown
    try {
      evalMethodCall(deserExpr(SSIGMAPROP, sigmaBytes(candChain(109))), Env.empty(), ctx)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EvalError)
    expect((err as EvalError).code).toBe('global-deserialize-failed')
  })

  it('parseSigmaBoolean used standalone (no SValue framing) is bounded too', () => {
    // The bare reader still carries the level cap; a >110-deep nested Cand parsed
    // directly via parseSValue(SSigmaProp) on a fresh reader rejects.
    const bytes = new Uint8Array(sigmaBytes(candChain(120)))
    let err: unknown
    try {
      parseSValue(SSIGMAPROP, 3, new ByteReader(bytes))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ReaderError)
    expect((err as ReaderError).code).toBe('max-tree-depth-exceeded')
  })
})

// ---------------------------------------------------------------------------
// 4) BOX internals — nested register value participates in the same counter
// ---------------------------------------------------------------------------

describe('MaxTreeDepth — box internals (register / nested ergoTree)', () => {
  // Build a minimal box's bytes with one register holding a deeply-nested
  // Coll-of-Coll value, then parse via parseSValue(SBox). The register's
  // data-value recursion shares the box parse's reader level.
  //
  // Box wire layout (see parse-svalue.ts SBox arm):
  //   value(VLQ) | ergoTree | creationHeight(VLQ) | tokensCount(u8)
  //   | regCount(u8) | per-reg: SType-bytes + SValue-bytes
  //   | txId(32) | index(VLQ)
  //
  // We hand-build a minimal box whose single register holds a Coll-of-Coll
  // value of controllable depth, then parse via parseSValue(SBox). The register
  // value's data-value recursion shares the box parse's reader level, so the box
  // parser (parseSValue(SBox) = L1) plus the register Coll-chain must not push
  // past 110.

  function boxBytesWithDeepRegister(collDepth: number, dataMarkers: number[]): Uint8Array {
    const w = new ByteWriter()
    // value
    w.writeVlqU(1)
    // ergoTree: minimal hasSize=false tree = header 0x00 + body sigmaProp(true) (`08 d3`),
    // which self-delimits. The root must type as SigmaProp: box ingest applies rule 1001
    // (ErgoBoxCandidate.scala:194, checkType = true), so a Boolean root would reject the
    // box at its tree, before the register this test is about. The tree's levels are all
    // released before the registers are read, so the register chain's depth is unaffected.
    w.writeBytes(new Uint8Array([0x00, 0x08, 0xd3]))
    // creationHeight
    w.writeVlqU(0)
    // tokens count
    w.writeU8(0)
    // registers: 1
    w.writeU8(1)
    // register SType: Coll^collDepth of SByte, encoded via the SType serializer
    // (SType bytes are depth-EXEMPT — they don't bump the reader level, matching
    // the JVM TypeSerializer — so only the per-element VALUE recursion counts).
    serializeSType(collOfByte(collDepth), w)
    for (const b of dataMarkers) w.writeU8(b)
    // txId (32)
    w.writeBytes(new Uint8Array(32))
    // index
    w.writeVlqU(0)
    return w.toBytes()
  }

  function collOfByte(depth: number): SType {
    let t: SType = { tag: 'SByte' }
    for (let i = 0; i < depth; i++) t = { tag: 'SColl', elem: t }
    return t
  }

  it('box register data recursing to exactly depth 110 is ACCEPTED', () => {
    // Depth chain (shared reader level): parseSValue(SBox)=L1, then the register
    // is read as an Expr via parseRegisterExpr (≡ JVM r.getValue() /
    // ValueSerializer.deserialize) = L2, then the register's Coll-chain:
    // reg Coll#1=L3 ... reg Coll#108=L110. So a 108-deep register Coll-chain lands
    // the innermost value at level 110 (accepted). Markers: 107 present (len 1)
    // drive Coll#1..#107 to recurse; the innermost Coll[SByte] reads len 0 (empty).
    const bytes = boxBytesWithDeepRegister(108, new Array(107).fill(1).concat([0]))
    const sbox = parseSValue({ tag: 'SBox' }, 0, new ByteReader(bytes))
    expect(sbox.kind).toBe('Box')
  })

  it('box register data recursing past depth 110 is REJECTED (boundary)', () => {
    // One deeper: a 109-deep register Coll-chain puts the innermost at level 111
    // (SBox L1 + register-Expr L2 + 109 Colls). This is exactly the JVM divergence
    // the register-Expr level closes: the JVM reads the register via r.getValue()
    // (an extra ValueSerializer level) and rejects this box at depth 111, so ergots
    // must too. 108 present markers drive the recursion to the 111th enterDepth.
    const bytes = boxBytesWithDeepRegister(109, new Array(108).fill(1).concat([0]))
    let err: unknown
    try {
      parseSValue({ tag: 'SBox' }, 0, new ByteReader(bytes))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ReaderError)
    expect((err as ReaderError).code).toBe('max-tree-depth-exceeded')
  })
})

// ---------------------------------------------------------------------------
// 5) A soft-fork degrade leaves its levels on the reader (the JVM's level leak)
// ---------------------------------------------------------------------------

describe('MaxTreeDepth — levels leaked by a soft-fork degrade', () => {
  // JVM frames lower `r.level` only on a normal return (`r.level = r.level - 1`, no finally,
  // ValueSerializer.scala:396-412), and deserializeErgoTree's degrade restores only the position
  // limit (ErgoTreeSerializer.scala:196-211). SANTA Transaction.degraded_tree_depth_leak
  // (jvm:sigma-state-6.0.6) pins the effect at the transaction level.
  //
  // Tree 0b 0a d1 ef×8 fd: v3 with the size flag, a 10-byte body of BoolToSigmaProp (level 1),
  // 8 LogicalNot (levels 2-9) and the unknown opcode 0xfd, which throws at level 10 and degrades.
  const DEGRADING_TREE = [0x0b, 0x0a, 0xd1, 0xef, 0xef, 0xef, 0xef, 0xef, 0xef, 0xef, 0xef, 0xfd]

  it('a degrade 10 levels deep leaves the reader at level 10', () => {
    const r = new ByteReader(new Uint8Array(DEGRADING_TREE))
    const tree = parseTreeFromReader(r)
    expect('unparsedBytes' in tree).toBe(true)
    expect(r.level).toBe(10)
  })

  it('the leak survives the normal return of an enclosing frame (a Box whose tree degrades)', () => {
    // parseSValue(SBox) enters level 1, the tree's failing node throws at 1 + 10 = 11, and the
    // Box frame's normal return lowers the level by one: 10 remain, as the JVM's relative
    // `r.level - 1` leaves them (DataSerializer.scala:33-38).
    const w = new ByteWriter()
    w.writeVlqU(1_000_000)                      // value
    w.writeBytes(new Uint8Array(DEGRADING_TREE)) // ergoTree
    w.writeVlqU(0)                              // creationHeight
    w.writeU8(0)                                // tokens
    w.writeU8(0)                                // registers
    w.writeBytes(new Uint8Array(32))            // txId
    w.writeVlqU(0)                              // index
    const r = new ByteReader(w.toBytes())
    expect(parseSValue({ tag: 'SBox' }, 0, r).kind).toBe('Box')
    expect(r.level).toBe(10)
  })

  it('a degrade nested in a size-flagged tree that parses still leaves its levels', () => {
    // v3 sized + segregated tree whose one constant is a Box carrying DEGRADING_TREE, then body
    // sigmaProp(true). The Box data frame enters 1, the nested failing node throws at 1 + 10 = 11,
    // the Box frame's normal return lowers 1: 10 remain on the JVM's one reader after the whole
    // tree parses (DataSerializer.scala:35-37). SANTA Transaction.nested_degrade_depth_leak
    // (jvm:sigma-state-6.0.6) pins it at the transaction level.
    const hex = '1b37' + '01' + '63' + 'c0843d' + '0b0ad1efefefefefefefeffd' + '00'.repeat(36) + '08d3'
    const r = new ByteReader(new Uint8Array(hex.match(/../g)!.map((x) => parseInt(x, 16))))
    const tree = parseTreeFromReader(r)
    expect('unparsedBytes' in tree).toBe(false)
    expect(r.level).toBe(10)
  })

  it('a degrade on Option data two data frames deep leaves 2 levels', () => {
    // v1 sized + segregated tree, constant Coll[Option[Int]] = [Some(1)]: the Coll data frame
    // (level 1) and the Option element frame (level 2) are open when the pre-v3 Option data gate
    // throws (CoreDataSerializer.scala:96, :145), so 2 levels stay.
    const r = new ByteReader(new Uint8Array([0x19, 0x08, 0x01, 0x0c, 0x28, 0x01, 0x01, 0x02, 0x08, 0xd3]))
    expect('unparsedBytes' in parseTreeFromReader(r)).toBe(true)
    expect(r.level).toBe(2)
  })
})
