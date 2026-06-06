/**
 * SANTA v6 conformance — ergots vs JVM (`jvm:sigma-state-6.0.3`).
 * Vectors imported verbatim from SANTA (`vectors/eval/v6/`) into
 * `test/fixtures/conformance/v6/`. Asserting whole-tree value+cost against the
 * JVM-blessed oracle. VECTOR_FILES grows as SANTA blesses more v6 vectors.
 *
 * Envelope variants used here (runner-contract.md §3):
 *   v2 — single `input` bound to ctx var 1 (most vectors).
 *   v3 — `inputs` array: per-spending-tx-input ContextExtensions (multi-input).
 *   v4 — `input` + `selfRegisters`: var-1 binding + SELF R4..R9 population.
 * The `evalSantaEntry` dispatcher in _santa.ts handles all three transparently.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalSantaEntry, svalueToSantaJson, type SantaVector, type SantaEntry } from './_santa'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes, captureEvalError, synthesizeStubBox } from '../_helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vectorDir = path.join(__dirname, '../fixtures/conformance/v6')

const VECTOR_FILES = [
  'higher_order_lambdas.json',
  // P6 Task 7 — JVM-blessed adversarial HOF (SANTA a66af91): FunDef (0xd7,
  // concrete body) → 7/58, currying (Apply-of-Apply) → 4/119, function-in-
  // Coll[SFunc] → 6/130. The adversarial-closure gate for first-class functions.
  'HOF_FunDef_polymorphic_identity.json',
  'HOF_currying_Apply_of_Apply.json',
  'HOF_function_in_Coll_of_SFunc.json',
  'HOF_FunDef_type_var_body.json', // type-var-body FunDef — reject at apply (SANTA), bind-only accepts
  // P5c follow-up (SANTA fc3c1f4): JVM-blessed Global.powHit k≠32 value+cost
  // (k=2/16/31) + require-boundary rejects (k=1/33, N=15). Independently pins
  // the (0 until k) index generalization the k=32 verify-path fixtures never
  // exercised, plus the (k+1)·7 cost coefficient.
  'Global.powHit_varying_k.json',
  'Global.powHit_require_boundary.json',
  // P7a (SANTA 2026-06-06): 16 JVM-blessed entries across 4 families.
  //
  // GroupElement.expUnsigned (santa-eval/v2, 3 entries):
  //   exp-1→generator (906), exp-0→identity (906), exp-order→identity (906).
  //   Flat ExponentiateUnsignedMethod cost = FixedCost(900) + 6 tree overhead.
  'GroupElement.expUnsigned.json',
  // Box.getReg dynamic index MethodCall (santa-eval/v4, 4 entries):
  //   accept-r4-long: R4=Long 7, idx→4, typeArg Long → Some(Long 7), cost 89.
  //   reject-wrong-type: R4=Long 7, typeArg Int → eval REJECT (InvalidType).
  //   none-absent-r5: idx→5, R5 unset → None, cost 89.
  //   none-out-of-range-10: idx→10 → None, cost 89.
  //   Uses v4 envelope: per-entry selfRegisters (R4..R9) + var-1 index binding.
  'Box.getReg_dynamic_index.json',
  // Context.getVarFromInput multi-input (santa-eval/v3, 6 entries):
  //   multi-input-no-var-at-idx1: in-range, var absent → None, cost 17.
  //   multi-input-present-true-at-idx1: → Some(true), cost 17.
  //   multi-input-wrong-type-at-idx1: → None (type mismatch), cost 17.
  //   multi-input-present-false-at-idx1: → Some(false), cost 17.
  //   oob-input-index: inputIdx 5 ≥ 2 inputs → None, cost 17.
  //   negative-varid-0xff: getVarFromInput[Boolean](0, -1) ≡ key 255 → Some(true), cost 17.
  //     First authoritative pin for var ids ≥ 0x80; byte-identity confirmed.
  'Context.getVarFromInput_multi_input.json',
  // Box.getReg adversarial (santa-eval/v2, 3 entries):
  //   getRegV5-live-reject: SELF.getRegV5(i) on v5 live path → eval REJECT.
  //   getRegV5-dead-branch-accept: dead-branch if(true) → Boolean true, cost 12.
  //   getReg-v6-method-in-v2-tree-reject: 99:19 in ergoTree-v2 → eval REJECT
  //     (ValidationRule 1011 CheckAndGetMethod at deserialize, soft-fork-wrapped).
  'Box.getReg_adversarial.json',
  // F1 (SANTA 2026-06-06): DeserializeContext dead-branch tolerance —
  // 2 dead-branch accepts (RED until the F1 fix) + 2 live rejects.
  'DeserializeContext_over_absent_wrong_typed_var.json',
  // F2 (2026-06-06): timestamp-bigint (#4) + putUByte=1 (#5) acceptance — the 16
  // dasher reds of 2026-06-06. serialize walks over Box (nTokens/nRegs +2),
  // AvlTree (flags +1), Header v1/v2 (dLen/unparsedLen +1); the three Header
  // entries carry timestamp 4928911477310178288 > 2^53 (the #4 panic class).
  // deserializeTo_header = serialize→deserializeTo→EQ round-trip (677 v2 / 804 v1).
  'Global.serialize_Box.json',
  'Global.serialize_Box_Int.json',
  'Global.serialize_AvlTree.json',
  'Global.serialize_Header.json',
  'Global.deserializeTo_header.json',
  'Header_new_methods.json',
]

for (const file of VECTOR_FILES) {
  const doc = JSON.parse(fs.readFileSync(path.join(vectorDir, file), 'utf8')) as SantaVector
  describe(`SANTA v6 conformance — ${doc.op} (${doc.blessed_by})`, () => {
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

// The composite-function HOF tree must reject below v3 (the SFunc-in-SPair type
// code is V3-gated; ergots reproduces this in validateV6Types). We derive the
// v2 case from the blessed v3 entry rather than ship a separate fixture.
describe('v6 HOF gate — composite-function tree rejects below v3', () => {
  it('higher order lambdas tree at ergoTree v2 → errored', () => {
    const doc = JSON.parse(
      fs.readFileSync(path.join(vectorDir, 'higher_order_lambdas.json'), 'utf8'),
    ) as SantaVector
    const e = doc.entries[0]!
    const v2: SantaEntry = { ...e, name: `${e.name}@v2`, version: { activated: 2, ergoTree: 2 } }
    expect(evalSantaEntry(v2).error).toBe('errored')
  })
})

// Pin the actual EvalError codes for the two v2-envelope adversarial entries in
// Box.getReg_adversarial.json. These use the same context the conformance arm
// builds (blesser-mirroring SELF box + var-1 binding), so the assertions are
// redundant but complementary: they catch any future code-rename at the gate.
describe('Box.getReg_adversarial — gate codes (conformance-arm context)', () => {
  // getRegV5-live-reject#0: { SELF.getRegV5(getVar[Int](1).get) } @ ergoTree v3.
  // 99:7 is unregistered in the handler map → 'method-not-implemented'.
  it('getRegV5-live (99:7) rejects with method-not-implemented', () => {
    const treeBytesHex = '1b0a00dc6307a701e4e30104'
    const treeBytes = hexToBytes(treeBytesHex)
    const tree = parseTree(treeBytes)
    const selfBox = { ...synthesizeStubBox(), ergoTreeBytes: treeBytes }
    const ctx = makeContext({
      treeVersion: 3,
      constants: tree.constants,
      extension: { values: { 1: { tpe: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 4 } } } },
      selfBox,
    })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
  })

  // getReg-v6-method-in-v2-tree-reject#2: { SELF.getReg[Long](getVar[Int](1).get) }
  // @ ergoTree v2. 99:19 has minVersion=3 → dispatcher throws 'tree-version-too-low'.
  it('getReg (99:19) in ergoTree-v2 rejects with tree-version-too-low', () => {
    const treeBytesHex = '1a0b00dc6313a701e4e3010405'
    const treeBytes = hexToBytes(treeBytesHex)
    const tree = parseTree(treeBytes)
    const selfBox = { ...synthesizeStubBox(), ergoTreeBytes: treeBytes }
    const ctx = makeContext({
      treeVersion: 2,
      constants: tree.constants,
      extension: { values: { 1: { tpe: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 4 } } } },
      selfBox,
    })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('tree-version-too-low')
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
