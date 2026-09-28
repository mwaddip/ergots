// The JVM tree parse (ErgoTreeSerializer.deserializeErgoTree, sigma-state 6.0.6 :141-215):
// parse on the arriving reader under a 4096 window; the declared size is used only on a
// soft-fork degrade. Spec: docs/specs/2026-09-28-sized-tree-declared-size-design.md §2, §4, §6.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader } from '@ergots/scorex'
import {
  parseTreeFromReader, parseTree, parseErgoTreeBytes, ErgoTreeParseError,
} from '../../src/wire/ergo-tree'
import { isUnparsedTree } from '../../src/mir/types'
import type { Expr } from '../../src/mir/types'
import { ergoTreeFromAddress, addressFromErgoTree } from '../../src/address'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const codeOf = (f: () => unknown) => { try { f(); return 'no-throw' } catch (e) { return (e as { code?: string }).code } }
const vlq = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b) } while (n); return o }
// A 42-byte body holding one inline SBox constant whose own tree is `tree2` (2 bytes).
const boxBody = (tree2: string) => '63' + 'c0843d' + tree2 + '00' + '00' + '00' + '00'.repeat(32) + '00'

describe('declared size is ignored when the body parses', () => {
  it('over: 09 03 08 d3 parses and the cursor stops after the 2-byte body', () => {
    const r = new ByteReader(hex('090308d301'))
    const t = parseTreeFromReader(r)
    expect(isUnparsedTree(t)).toBe(false)
    expect(r.position).toBe(4)
  })
  it('under: 09 01 08 d3 parses the whole body anyway', () => {
    const r = new ByteReader(hex('090108d301'))
    expect(isUnparsedTree(parseTreeFromReader(r))).toBe(false)
    expect(r.position).toBe(4)
  })
})

describe('the degrade uses the declared size', () => {
  it('a failure inside the span keeps [start, bodyPos + declared)', () => {
    const r = new ByteReader(hex('0b0ad1efefefefefefefeffd'))
    const t = parseTreeFromReader(r)
    expect(isUnparsedTree(t)).toBe(true)
    expect(r.position).toBe(12)
  })
  it('a failure past the span still keeps only the declared span', () => {
    const r = new ByteReader(hex('0901d1fd00'))
    const t = parseTreeFromReader(r)
    expect(isUnparsedTree(t)).toBe(true)
    if (isUnparsedTree(t)) expect(Array.from(t.unparsedBytes)).toEqual([0x09, 0x01, 0xd1])
    expect(r.position).toBe(3)
  })
  it('a negative span (size wraps to -7) is body-size-overflow', () => {
    expect(codeOf(() => parseTreeFromReader(new ByteReader(hex('09f9ffffff0ffd'))))).toBe('body-size-overflow')
  })
  it('a span past the end is body-size-overflow', () => {
    expect(codeOf(() => parseTreeFromReader(new ByteReader(hex('097ffd'))))).toBe('body-size-overflow')
  })
  it('the span is Int arithmetic (:200): an overflowing sum wraps negative', () => {
    // Declared 0x7fffffff: 6 + 2147483647 wraps to -2147483643 in the JVM's Int, so its getBytes
    // fails on a negative size. The verdict equals the past-the-end case; the reason is pinned.
    let err: unknown
    try { parseTreeFromReader(new ByteReader(hex('09ffffffff07fd'))) } catch (e) { err = e }
    expect((err as ErgoTreeParseError).code).toBe('body-size-overflow')
    expect((err as Error).message).toMatch(/-2147483643 is negative/)
  })
  it('a size above u32 is rejected before the body (getUInt)', () => {
    expect(codeOf(() => parseTreeFromReader(new ByteReader(hex('09808080801008d3'))))).toBe('vlq-overflow')
  })
})

describe('unsized trees, nested trees, and the degrade set', () => {
  it('an unsized soft-fork failure is wrapped (JVM SerializerException, :204-207)', () => {
    let err: unknown
    try { parseTree(hex('00fd')) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ErgoTreeParseError)
    expect((err as ErgoTreeParseError).code).toBe('soft-fork-without-size-bit')
    expect((err as Error).cause).toBeDefined()
  })
  it('an unsized nested tree failing soft-forkably rejects its sized parent', () => {
    expect(codeOf(() => parseTree(hex('0b2a' + boxBody('00fd'))))).toBe('soft-fork-without-size-bit')
  })
  it('a nested rule-1012 failure degrades its sized parent', () => {
    const r = new ByteReader(hex('0b2a' + boxBody('01d3')))
    expect(isUnparsedTree(parseTreeFromReader(r))).toBe(true)
    expect(r.position).toBe(44)
  })
  it('a read past the window degrades a sized tree (rule 1014)', () => {
    const big = new Array(4200).fill(0)
    const bytes = Uint8Array.from([0x08, 0x05, 0x93, 0x0e, ...vlq(4200), ...big, 0x0e, 0x00])
    const r = new ByteReader(bytes)
    expect(isUnparsedTree(parseTreeFromReader(r))).toBe(true)
    expect(r.position).toBe(7)
  })
  it('a read past the window at the end of the input is a hard truncated (the peek)', () => {
    const big = new Array(4200).fill(0)
    const bytes = Uint8Array.from([0x08, 0x05, 0x93, 0x0e, ...vlq(4200), ...big])
    expect(codeOf(() => parseTreeFromReader(new ByteReader(bytes)))).toBe('truncated')
  })
})

describe("a nested tree's run-out is marked for boxTreeOf's miss rule (spec §8)", () => {
  it("a nested tree reading past the end throws 'nested-tree-truncated', a hard reject", () => {
    // Sized outer tree (declared 8): an inline SBox constant whose own tree `09 7f d1` (sized,
    // declared 127) reads past the end of the input. The outer tree does not degrade on it.
    let err: unknown
    try { parseTree(hex('0b08' + '63c0843d' + '097f' + 'd1')) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ErgoTreeParseError)
    expect((err as ErgoTreeParseError).code).toBe('nested-tree-truncated')
    expect((err as Error).cause).toMatchObject({ code: 'truncated' })
  })
  it("a tree's own run-out stays 'truncated', also after an earlier tree on the same reader", () => {
    // Two trees on one reader, as a transaction's outputs are: the first parses, and the
    // second tree's run-out is its own (top level), not a nested tree's.
    const r = new ByteReader(hex('0008d3' + '00d1'))
    parseTreeFromReader(r)
    expect(codeOf(() => parseTreeFromReader(r))).toBe('truncated')
  })
})

describe('the window is restored like the JVM finally', () => {
  it('restored after a parse and after a degrade', () => {
    for (const h of ['00' + '08d3', '0b0ad1efefefefefefefeffd']) {
      const r = new ByteReader(hex(h + '00'))
      r.positionLimit = 999
      parseTreeFromReader(r)
      expect(r.positionLimit).toBe(999)
    }
  })
  it('not restored when the header throws (outside the try)', () => {
    const r = new ByteReader(hex('0301'))
    r.positionLimit = 999
    expect(codeOf(() => parseTreeFromReader(r))).toBe('header-version-requires-size')
    expect(r.positionLimit).toBe(4096)
  })
})

describe('constants count (getUInt().toInt, > 0, safeNewArray 100000)', () => {
  it('a count that wraps negative reads no constants', () => {
    const t = parseTree(hex('1080808080' + '08' + '08d3'))
    expect(isUnparsedTree(t)).toBe(false)
    if (!isUnparsedTree(t)) expect(t.constants.length).toBe(0)
  })
  it('100001 is too-many-constants before any constant is read', () => {
    expect(codeOf(() => parseTree(Uint8Array.from([0x10, ...vlq(100001)])))).toBe('too-many-constants')
  })
  it('100000 is allowed and runs out of input', () => {
    expect(codeOf(() => parseTree(Uint8Array.from([0x10, ...vlq(100000)])))).toBe('truncated')
  })
})

describe('rule 1001 (checkType): box paths only, JVM root type', () => {
  it('unsized Int root: parseTree accepts (lenient), box ingest rejects', () => {
    expect(isUnparsedTree(parseTree(hex('000402')))).toBe(false)
    expect(codeOf(() => parseErgoTreeBytes(new ByteReader(hex('000402'))))).toBe('soft-fork-without-size-bit')
  })
  it('sized Int root: box ingest degrades to the declared span', () => {
    const r = new ByteReader(hex('08020402'))
    expect(parseErgoTreeBytes(r).length).toBe(4)
    expect(r.position).toBe(4)
  })
  it('the burn box: lenient parse stops at the body, box ingest lands on byte 9', () => {
    const lenient = new ByteReader(hex('cd07021a8e6f59fd4a'))
    expect(isUnparsedTree(parseTreeFromReader(lenient))).toBe(false)
    expect(lenient.position).toBe(4)
    const box = new ByteReader(hex('cd07021a8e6f59fd4a'))
    expect(parseErgoTreeBytes(box).length).toBe(9)
    expect(box.position).toBe(9)
  })
  it('Apply of a Coll[SigmaProp] passes rule 1001 (the element type)', () => {
    const r = new ByteReader(hex('00da1401d3010400'))
    expect(parseErgoTreeBytes(r).length).toBe(8)
  })
  it('Apply of an Int fails rule 1001 (NoType) and degrades a sized tree', () => {
    const r = new ByteReader(hex('0806da0400010400'))
    expect(parseErgoTreeBytes(r).length).toBe(8)
  })
  it('checkType on parseTree is opt-in', () => {
    expect(codeOf(() => parseTree(hex('000402'), { checkType: true }))).toBe('soft-fork-without-size-bit')
  })
})

describe('parseTree trailing bytes', () => {
  it('tolerates trailing bytes inside the declared span (as the fork did)', () => {
    expect(isUnparsedTree(parseTree(hex('090308d300')))).toBe(false)
  })
  it('rejects trailing bytes beyond the declared span (ERG-02)', () => {
    expect(codeOf(() => parseTree(hex('090208d300')))).toBe('trailing-bytes')
    expect(codeOf(() => parseTree(hex('0008d300')))).toBe('trailing-bytes')
  })
})

describe('address decoding uses the box rules', () => {
  it('a P2S address of an unsized Int-root tree is rejected', () => {
    // Encode through the P2S path; decoding must apply rule 1001.
    const addr = addressFromErgoTree({ header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0 },
      constantTypes: [], constants: [], body: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } } } as never, 'mainnet')
    expect(codeOf(() => ergoTreeFromAddress(addr))).toBe('soft-fork-without-size-bit')
  })
})

describe('a hard count reject inside a sized tree is not swallowed by the degrade', () => {
  // Both counts reject hard in the JVM, outside its ValidationException degrade: SigmaAnd's
  // getUIntExact then safeNewArray (transformers/SigmaTransformerSerializer.scala:20-29; a plain
  // RuntimeException, core/.../sigma/util/package.scala:7-18), and ConcreteCollection's getUShort
  // (ConcreteCollectionSerializer.scala:28), whose IllegalArgumentException the inner catch turns
  // into a SerializerException (ErgoTreeSerializer.scala:188-194). The declared size covers the
  // bytes, so a degrade would succeed here: only the degrade set keeps these rejects hard.
  it('a SigmaAnd count of 100001 is sigma-and-too-many-items, not an UnparsedErgoTree', () => {
    const body = [0xea, ...vlq(100001)]
    const bytes = Uint8Array.from([0x08, body.length, ...body])
    expect(codeOf(() => parseTreeFromReader(new ByteReader(bytes)))).toBe('sigma-and-too-many-items')
  })
  it('a ConcreteCollection count of 0x10000 is collection-size-out-of-range, not an UnparsedErgoTree', () => {
    const body = [0x83, ...vlq(0x10000)]
    const bytes = Uint8Array.from([0x08, body.length, ...body])
    expect(codeOf(() => parseTreeFromReader(new ByteReader(bytes)))).toBe('collection-size-out-of-range')
  })
})

/**
 * The sweep's filter: whether a tree whose status changed under checkType has a root that is
 * genuinely not a SigmaProp. It is decided without exprTpe wherever the fixture allows, so that
 * an exprTpe mistype of a SigmaProp root still fails the sweep:
 *  - a constant root carries its type on the wire (wire/ergo-box-bytes.json's `09 02 01 01`,
 *    a Boolean constant, is the one such box tree);
 *  - any other tree outside eval/ and conformance/ (the mainnet and corpus box scripts, the
 *    wire fixtures) is a box script and must keep its status: no filter;
 *  - an evaluator vector (eval/, conformance/) is an expression tree evaluated for its value,
 *    not a box script, and its value's kind as the reference evaluated it (the JVM's for SANTA
 *    vectors, sigma-rust's for eval fixtures) is its root's type;
 *  - an error vector there has no value, so only exprTpe types it: such a tree changed status
 *    only because exprTpe gave a non-SigmaProp type or could not type it. This last case is the
 *    one the filter takes on exprTpe's word.
 */
function genuinelyNotSigmaProp(file: string, kind: string | undefined, body: Expr): boolean {
  if (body.tag === 'Const') return body.tpe.tag !== 'SSigmaProp'
  if (!/^(eval|conformance)\//.test(file)) return false
  if (kind !== undefined) return kind !== 'SigmaProp'
  return true
}

describe('no honest committed tree changes status under the box rules', () => {
  it('lenient-Parsed SigmaProp-rooted trees stay Parsed with checkType', () => {
    const root = join(__dirname, '..', 'fixtures')
    const KEYS = ['tree_bytes_hex', 'ergo_tree_hex', 'ergo_tree_bytes_hex', 'ergoTreeBytes', 'ergoTree']
    const trees: { h: string; file: string; kind?: string }[] = []
    // Every tree in the fixtures, with the reference's evaluated value kind when its entry has one.
    const visit = (o: unknown, file: string): void => {
      if (Array.isArray(o)) { for (const x of o) visit(x, file); return }
      if (o === null || typeof o !== 'object') return
      const rec = o as Record<string, unknown>
      const kind = (rec.expected_value_json as { kind?: string } | null | undefined)?.kind
        ?? (rec.expected as { value?: { kind?: string } | null } | null | undefined)?.value?.kind
      for (const k of KEYS) {
        const v = rec[k]
        if (typeof v === 'string' && /^([0-9a-f]{2})+$/.test(v)) trees.push({ h: v, file, kind })
      }
      for (const v of Object.values(rec)) visit(v, file)
    }
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (f.endsWith('.json')) visit(JSON.parse(readFileSync(p, 'utf8')), p.slice(root.length + 1))
      }
    }
    walk(root)
    expect(trees.length).toBeGreaterThan(50)
    let kept = 0
    for (const { h, file, kind } of trees) {
      let lenient; try { lenient = parseTree(hex(h)) } catch { continue }
      if (isUnparsedTree(lenient)) continue
      // A lenient-Parsed tree must either stay Parsed or fail rule 1001 only if its root is not SigmaProp.
      let stayedParsed: boolean
      try { stayedParsed = !isUnparsedTree(parseTree(hex(h), { checkType: true })) } catch { stayedParsed = false }
      if (stayedParsed) { kept++; continue }
      if (genuinelyNotSigmaProp(file, kind, lenient.body)) continue
      expect.soft(h, `tree ${h.slice(0, 40)}… (${file}) changed status under checkType`).toBe('non-SigmaProp root')
    }
    // The sweep reached the box scripts: the mainnet corpora alone hold 12,885 trees (12,712 + 173).
    expect(kept).toBeGreaterThan(13000)
  })
})
