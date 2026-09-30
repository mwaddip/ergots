/**
 * SANTA v6 conformance — ergots vs JVM (`jvm:sigma-state-6.0.3`).
 *
 * Registration is manifest-free: every vector file under
 * `test/fixtures/conformance/v6/{spec,authored}/` runs (the FULL JVM-blessed
 * corpus, vendored verbatim from SANTA `vectors/eval/v6/` — conformance-ledger
 * Decision #3: SANTA is upstream, these are permanent regression pins;
 * re-sync at phase boundaries via `tools/sync-santa-corpus.sh`).
 *
 * Tiers (upstream layout): `spec/` = vectors derived from the sigma-state
 * v6.0 feature corpus; `authored/` = SANTA-authored adversarial/edge families.
 *
 * Envelope variants (runner-contract.md §3):
 *   v1 — closed tree, no input.
 *   v2 — single `input` bound to ctx var 1 (most vectors).
 *   v3 — `inputs` array: per-spending-tx-input ContextExtensions (multi-input).
 *   v4 — `input` + `selfRegisters`: var-1 binding + SELF R4..R9 population.
 * The `evalSantaEntry` dispatcher in _santa.ts handles all four transparently.
 *
 * Corpus provenance (condensed — per-family history lives in git: this file's
 * pre-readdir VECTOR_FILES comments, and the SANTA-side blessing prompts under
 * `~/projects/santa/prompts/`):
 *   - P5c–P7a: powHit k-generalization, HOF/FunDef adversarial closures,
 *     GroupElement.expUnsigned, Box.getReg (dynamic + adversarial),
 *     Context.getVarFromInput multi-input.
 *   - F1–F4: DeserializeContext dead-branch tolerance, Global.serialize walks
 *     (Box/AvlTree/Header/SigmaProp) + deserializeTo round-trips,
 *     AvlTree.insertOrUpdate + v6 epilogue acceptance corpus.
 *   - F5 batches 1–4: SOption nonzero DATA tag, SHeader accessors,
 *     wire-layer rejects (Rule 1012/1019), substConstants v3 source.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalSantaEntry, svalueToSantaJson, type SantaVector, type SantaEntry } from './_santa'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { blake2b256 } from '../../src/crypto/hashes'
import { hexToBytes, captureEvalError, synthesizeStubBox, parseParsedTree as parseTree } from '../_helpers'
import { seedBoxTree } from '../../src/wire/box-tree'
import { parseTree as parseTreeLenient } from '../../src/wire/ergo-tree'
import { isUnparsedTree } from '../../src/mir/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vectorDir = path.join(__dirname, '../fixtures/conformance/v6')

const vectorFiles = (['spec', 'authored'] as const).flatMap((tier) => {
  const files = fs
    .readdirSync(path.join(vectorDir, tier))
    .filter((f) => f.endsWith('.json'))
    .sort()
  // Tripwire: the corpus is append-only (ledger Decision #3) — an empty or
  // shrunken tier means a wipe or a partial sync, not a legitimate state.
  if (files.length === 0) {
    throw new Error(`conformance ${tier}/ tier is empty — wiped or partial sync?`)
  }
  return files.map((f) => path.join(tier, f))
})
if (vectorFiles.length < 60) {
  throw new Error(`conformance v6 corpus shrank to ${vectorFiles.length} files (floor 60; 78 @ 2026-06-10) — partial sync?`)
}

for (const file of vectorFiles) {
  const doc = JSON.parse(fs.readFileSync(path.join(vectorDir, file), 'utf8')) as SantaVector
  describe(`SANTA v6 conformance — ${file} — ${doc.op} (${doc.blessed_by})`, () => {
    for (const e of doc.entries) {
      it(e.name, () => {
        const actual = evalSantaEntry(e)
        if (e.expected.error !== null) {
          expect(actual.error).toBe('errored')
        } else {
          // Compare at SANTA canonical JSON level: ergots' runtime SValue carries
          // extra fields (e.g. `elem` on Option) that the blessed JSON omits.
          // Converting actual to SANTA form normalizes the representation, so the
          // comparison exactly mirrors the runner-contract §5 structural equality.
          expect(actual.error, `entry ${e.name} errored: ${actual.error}`).toBeNull()
          expect(svalueToSantaJson(actual.value!)).toEqual(e.expected.value)
          expect(actual.cost).toBe(e.expected.cost)
        }
      })
    }
  })
}

// The composite-function HOF tree must reject below v3: its SFunc type code (112) is no type there,
// rule 1018 at the type read (TypeSerializer.scala:211, 225-233), so the sized tree degrades, which the
// blesser grades errored. We derive the v2 case from the blessed v3 entry, the same tree under a v2 header
// (0x1b → 0x1a), rather than ship a separate fixture (a local sigma-state 6.0.6 probe, tree mode:
// unparsed, rule 1018).
describe('v6 HOF gate — composite-function tree rejects below v3', () => {
  it('higher order lambdas tree at ergoTree v2 → errored', () => {
    const doc = JSON.parse(
      fs.readFileSync(path.join(vectorDir, 'spec/higher_order_lambdas.json'), 'utf8'),
    ) as SantaVector
    const e = doc.entries[0]!
    expect(e.tree_bytes_hex.slice(0, 2)).toBe('1b')
    const v2: SantaEntry = {
      ...e,
      name: `${e.name}@v2`,
      tree_bytes_hex: `1a${e.tree_bytes_hex.slice(2)}`,
      version: { activated: 2, ergoTree: 2 },
    }
    expect(evalSantaEntry(v2).error).toBe('errored')
  })
})

// Pin the actual EvalError codes for the two errored adversarial entries in
// authored/Box.getReg_adversarial.json. The first uses the same context the
// conformance arm builds (blesser-mirroring SELF box + var-1 binding); the second's
// tree degrades at parse, so no context is read. The assertions are redundant but
// complementary: they catch any future code-rename at the gate.
describe('Box.getReg_adversarial — gate codes (conformance-arm context)', () => {
  // getRegV5-live-reject#0: { SELF.getRegV5(getVar[Int](1).get) } @ ergoTree v3.
  // 99:7 is unregistered in the handler map → 'method-not-implemented'.
  it('getRegV5-live (99:7) rejects with method-not-implemented', () => {
    const treeBytesHex = '1b0a00dc6307a701e4e30104'
    const treeBytes = hexToBytes(treeBytesHex)
    const tree = parseTree(treeBytes)
    // SELF is built from this lenient parse, as the blesser builds it (_santa.ts): seed it.
    seedBoxTree(treeBytes, tree)
    const selfBox = { ...synthesizeStubBox(), ergoTreeBytes: treeBytes }
    const ctx = makeContext({
      treeVersion: 3,
      constants: tree.constants,
      extension: { values: new Map([[1, { tpe: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 4 } }]]) },
      selfBox,
    })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
  })

  // getReg-v6-method-in-v2-tree-reject#2: { SELF.getReg[Long](getVar[Int](1).get) }
  // @ ergoTree v2. getReg (99:19) exists only from v3, so the parse's method lookup fails
  // (SMethod.fromIds, rule 1016) and the sized tree degrades; its spend then rejects with
  // 'unparsed-ergotree', before any evaluation. The dispatcher's minVersion gate is not reached. The
  // JVM: the tree unparsed on rule 1016, and the spend an InterpreterException over it (a local
  // sigma-state 6.0.6 probe, tree and spend modes).
  it('getReg (99:19) in ergoTree-v2 degrades at parse, so its spend rejects with unparsed-ergotree', () => {
    const tree = parseTreeLenient(hexToBytes('1a0b00dc6313a701e4e3010405'))
    if (!isUnparsedTree(tree)) throw new Error('expected an unparsed tree')
    expect((tree.error as { code?: string }).code).toBe('method-unknown')
    const err = captureEvalError(() => evaluateWith(tree, makeContext({ treeVersion: 2 })))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('unparsed-ergotree')
  })
})

describe('svalueToSantaJson — SigmaProp arm', () => {
  it('svalueToSantaJson encodes SigmaProp as serialized-SigmaBoolean raw_hex', () => {
    expect(svalueToSantaJson({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }))
      .toEqual({ kind: 'SigmaProp', raw_hex: 'd3' })
    expect(svalueToSantaJson({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: false } }))
      .toEqual({ kind: 'SigmaProp', raw_hex: 'd2' })
  })
})

// The blesser builds SELF from the tree under evaluation parsed leniently (checkType = false,
// LenientErgoTree.scala:22), so SELF carries that tree, and its bytes re-encode it
// (ErgoBoxCandidate.scala:142). The harness seeds the same tree on SELF's bytes (seedBoxTree);
// unseeded, a root that fails rule 1001 would make the re-encoding's box-rules parse reject.
describe('evalSantaEntry — SELF carries the leniently parsed tree (seedBoxTree)', () => {
  it('ExtractId(SELF) on the unsized tree 00 c5 a7 (a Coll[Byte] root) returns the id', () => {
    const e: SantaEntry = {
      name: 'extract-id-of-self',
      tree_bytes_hex: '00c5a7',
      version: { activated: 3, ergoTree: 0 },
      expected: { value: null, cost: null, error: null },
    }
    const actual = evalSantaEntry(e)
    expect(actual.error).toBeNull()
    // SELF (the blesser's EvalCore.scala:505-511): value 1_000_000, the tree 00 c5 a7, height 0,
    // no tokens, no registers, txId 32 x 00, index 0. Its id is blake2b256 over those bytes.
    const selfBytes = hexToBytes('c0843d' + '00c5a7' + '00' + '00' + '00' + '00'.repeat(32) + '00')
    const items = (actual.value as { items: { value: number }[] }).items
    expect(items.map((i) => i.value & 0xff)).toEqual(Array.from(blake2b256(selfBytes)))
  })
})
