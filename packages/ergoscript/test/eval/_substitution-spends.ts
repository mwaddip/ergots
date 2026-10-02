/**
 * The spends of the substitution-cost probe (a local sigma-state 6.0.6 probe, spend mode: the tree parsed by the box
 * rules, put in SELF with R4 and context variable 1 as given, and reduced by `ErgoLikeInterpreter.fullReduction` with
 * `initCost` 0). Test-only. `reduce-with.test.ts` holds the probe's costs; `evaluate-with-substitution-pins.test.ts`
 * pins what `evaluateWith` gives for the same spends.
 *
 * A register or variable is written as the probe takes it: a typed constant, type then data. `0e0208d3` is the
 * `Coll[Byte]` holding `08 d3`.
 */
import { ByteReader } from '@ergots/scorex'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalContext } from '../../src/eval/eval-context'
import { isUnparsedTree } from '../../src/mir/types'
import type { ErgoBox, ParsedErgoTree, SType, SValue } from '../../src/mir/types'
import { parseTree } from '../../src/wire/ergo-tree'
import { parseSType } from '../../src/wire/parse-stype'
import { parseSValue } from '../../src/wire/parse-svalue'
import { hexToBytes, synthesizeStubBox } from '../_helpers'

export interface Spend {
  /** The spent tree's bytes. */
  tree: string
  /** SELF's R4 as a typed constant; absent when unset. */
  r4?: string
  /** Context variable 1 as a typed constant; absent when unset. */
  var1?: string
}

/** secp256k1's generator, compressed. */
const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
/** SANTA deserialize-substitution-spend #0's and #3's tree: dead(EQ(DR(R4, SAny[, default]), GV)). */
const TREE_C = '00d195010093d5046100e4e301610101'
const TREE_D = '00d195010093d5046101b5b2860204000400040000d90101040101e4e301610101'
/** SANTA #13's and #14's tree: dead(EQ(DC(SAny, 1), GV)). */
const TREE_K = '00d195010093d46101e4e301610101'
/** The bytes of F(BI), 17 of them: they decode, and their type read is a class cast. */
const SCRIPT_TYPE_READ_CASTS = '0e11b5b2860204000400040000d90101040101'
/** The bytes of OptionGet(BI), 11 of them: their decode is a class cast. */
const SCRIPT_DECODE_CASTS = '0e0be4b2860204000400040000'

export const SPENDS = {
  /** DR(R4, SigmaProp) as the root, decoding the constant TrueProp. */
  A1: { tree: '00d5040800', r4: '0e0208d3' },
  /** The same root, decoding a ProveDlog constant: 35 bytes. */
  A3: { tree: '00d5040800', r4: `0e2308cd${G}` },
  /** Controls without a Deserialize node: a SigmaProp-constant tree, and P2PK. */
  A5: { tree: '0008d3' },
  A6: { tree: `0008cd${G}` },
  /** DC(SigmaProp, 1) as the root, decoding the constant TrueProp (SANTA evaluated-values-spend #42). */
  B: { tree: '00d40801', var1: '0e0208d3' },
  /** A dead Deserialize node and no decode. */
  C: { tree: TREE_C },
  /** SANTA #3: a 17-byte decode that completes, then a type read that is a class cast. */
  D: { tree: TREE_D, r4: SCRIPT_TYPE_READ_CASTS },
  /** sigmaProp(EQ(DR(R4, Int), DC(Int, 1))): two decodes of 2 bytes. */
  H1: { tree: '00d193d5040400d40401', r4: '0e020402', var1: '0e020402' },
  /** sigmaProp(EQ(DR(R4, Int), DR(R4, Int))): one register decoded twice. */
  H3: { tree: '00d193d5040400d5040400', r4: '0e020402' },
  /** sigmaProp(DR(R4, Boolean)) (SANTA evaluated-values-spend #38). */
  I: { tree: '00d1d5040100', r4: '0e020101' },
  /** sigmaProp(DC(Int, 1) == 1): the Int constant written with an over-long VLQ, and canonically. */
  J1: { tree: '00d193d40401048200', var1: '0e020402' },
  J2: { tree: '00d193d404010402', var1: '0e020402' },
  /** J2's tree with the size bit: its size written with an over-long VLQ, and canonically. */
  J3: { tree: '088700d193d404010402', var1: '0e020402' },
  J4: { tree: '0807d193d404010402', var1: '0e020402' },
  /** SANTA #0: the register's decode is a class cast. */
  K1: { tree: TREE_C, r4: SCRIPT_DECODE_CASTS },
  /** SANTA #13: the variable decodes, and its type read is a class cast. */
  K3: { tree: TREE_K, var1: SCRIPT_TYPE_READ_CASTS },
  /** SANTA #14: the variable's decode is a class cast. */
  K5: { tree: TREE_K, var1: SCRIPT_DECODE_CASTS },
  /** sigmaProp(DR(R4, Boolean, default = DC(Boolean, 1))). */
  L1: { tree: '00d1d5040101d40101', r4: '0e020101', var1: '0e020101' },
  L2: { tree: '00d1d5040101d40101', var1: '0e020101' },
  L3: { tree: '00d1d5040101d40101', r4: '0e020101' },
  /** The default's variable is an empty array: its decode fails. */
  L4: { tree: '00d1d5040101d40101', r4: '0e020101', var1: '0e00' },
  /** J4's tree at versions 3 and 2. */
  N1: { tree: '0b07d193d404010402', var1: '0e020402' },
  N2: { tree: '0a07d193d404010402', var1: '0e020402' },
  /** A sized version-1 tree with A1's root. */
  R8a: { tree: '0905d5040800', r4: '0e0208d3' },
  /** B's tree, decoding DC(SigmaProp, 2), whose variable is absent. */
  R10a: { tree: '00d40801', var1: '0e03d40802' },
  /** A segregated tree: one constant, and B's root. */
  SEG1: { tree: '10010402d40801', var1: '0e0208d3' },
  /** A1's tree, its register holding two bytes after the script. */
  T1: { tree: '00d5040800', r4: '0e0408d3d3d3' },
} satisfies Record<string, Spend>

export type SpendName = keyof typeof SPENDS

type Entry = { tpe: SType; value: SValue }

function constant(hex: string): Entry {
  const r = new ByteReader(hexToBytes(hex))
  const tpe = parseSType(r, 0)
  const value = parseSValue(tpe, 0, r)
  if (!r.isExhausted) throw new Error(`constant ${hex}: ${r.remaining} bytes left over`)
  return { tpe, value }
}

export interface Spent {
  tree: ParsedErgoTree
  ctx: EvalContext
}

/**
 * The spend's tree, parsed by the box rules, and its context: SELF holds the tree and R4, the extension holds
 * variable 1, the pre-header's version is one above `activated`, and the cost limit is `limit` block-cost units.
 */
export function spendContext(spend: Spend, activated: number, limit?: number): Spent {
  const bytes = hexToBytes(spend.tree)
  const tree = parseTree(bytes, { checkType: true })
  if (isUnparsedTree(tree)) throw new Error(`spend ${spend.tree}: the tree degraded (${tree.error.message})`)
  const selfBox: ErgoBox = {
    ...synthesizeStubBox(),
    ergoTreeBytes: bytes,
    registers: spend.r4 === undefined ? {} : { 4: constant(spend.r4) },
  }
  const ctx = makeContext({
    constants: tree.constants,
    selfBox,
    inputs: [selfBox],
    extension: { values: new Map(spend.var1 === undefined ? [] : [[1, constant(spend.var1)]]) },
    preHeader: {
      version: activated + 1,
      parentId: new Uint8Array(32),
      timestamp: 3n,
      nBits: 0,
      height: 0,
      minerPk: hexToBytes(G),
      votes: new Uint8Array(3),
    },
    jitCostLimit: limit === undefined ? undefined : limit * 10,
  })
  return { tree, ctx }
}
