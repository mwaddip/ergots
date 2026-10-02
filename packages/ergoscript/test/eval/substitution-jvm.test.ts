// The Deserialize substitution as the JVM's Kiama rewrite (spec docs/specs/2026-09-30-jvm-node-construction-design.md
// §5; facts/ergoscript-eval.md, "The Deserialize substitution"). The JVM rewrites a tree that has a Deserialize node
// with everywherebu(strategy { substDeserialize }) (Interpreter.scala:149-157, ErgoLikeInterpreter.scala:17-37):
// - children first, and a node whose child changed is rebuilt through its constructor by Kiama's dup, which nothing
//   catches (core/.../sigma/kiama/rewriting/Rewriter.scala:236-320, 446-471, 805-842);
// - substDeserialize runs inside the strategy's catch of ClassCastException (Rewriter.scala:180-191), so a class cast
//   while a script is decoded or typed, or while a register that is not a Coll[Byte] is read, leaves the node;
// - an absent register's default replaces the node. ergots keeps master's type check of the default (residual 7),
//   except where reading the default's type is a class cast: that default is substituted untyped, as in the JVM.
// Then the JVM reads node types at its eval-time checkType sites (values.scala:251-254), and a read that throws rejects.
//
// Each case spends a parsed tree as the local sigma-state 6.0.6 probe's spend mode does: SELF holds the tree, with R4
// and context variable 1 as given, at the tree's own version. "Accepted" is TrivialProp(true); a reject pins its code.
// Verdicts: the S*, G* and L1 rows are the sized-tree spec's final re-review (its case table, 2026-09-29); the #n rows
// are SANTA 7e2f5f4 (vectors/transaction/v6/authored/deserialize-substitution-spend.json, entry n); every other row is
// the probe's, named in its test. Each tree is checked against the bytes the probe or SANTA was given.
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { evaluateWith } from '../../src/eval/evaluate'
import { EvalError, makeContext } from '../../src/eval/eval-context'
import type { EvalContext } from '../../src/eval/eval-context'
import { substituteConstants, substituteDeserialize } from '../../src/eval/_substitute-deserialize'
import { ExprTpeError } from '../../src/mir/expr-tpe'
import type * as M from '../../src/mir/types'
import { serializeTree } from '../../src/wire/ergo-tree'
import { parseSValue } from '../../src/wire/parse-svalue'
import { hexToBytes, parseParsedTree, synthesizeStubBox } from '../_helpers'
import {
  Apply,
  BI,
  BitOr,
  Block,
  ByIndex,
  Coll,
  Ctx,
  DC,
  DR,
  EQ,
  Filter,
  GT,
  GV,
  GetVar,
  If,
  MC,
  Negation,
  OptionGet,
  OptionIsDefined,
  PC,
  Plus,
  SelectField,
  SizeOf,
  T,
  Tuple,
  ValDef,
  bool,
  collBool,
  collInt,
  dead,
  exprBytes,
  hex,
  int,
  long,
  sp,
  treeBytes,
} from '../_helpers/mir-build'

// ── Builders the shared helpers lack ──────────────────────────────────────
const NEQ = (l: M.Expr, r: M.Expr): M.BinOp => ({ tag: 'BinOp', op: { kind: 'Relation', op: 'NEq' }, left: l, right: r })
const lam = (id: number, body: M.Expr, tpe: M.SType = T.Int): M.FuncValue => ({ tag: 'FuncValue', args: [{ id, tpe }], body })
const OGE = (input: M.Expr, def: M.Expr): M.OptionGetOrElse => ({ tag: 'OptionGetOrElse', input, default: def })
const Fold = (input: M.Expr, zero: M.Expr, foldOp: M.Expr): M.Fold => ({ tag: 'Fold', input, zero, foldOp })
const MapColl = (input: M.Expr, mapper: M.Expr): M.Map => ({ tag: 'Map', input, mapper })
const FilterBy = (input: M.Expr, condition: M.Expr): M.Filter => ({ tag: 'Filter', input, condition })
const Exists = (input: M.Expr, condition: M.Expr): M.Exists => ({ tag: 'Exists', input, condition })
const ForAll = (input: M.Expr, condition: M.Expr): M.ForAll => ({ tag: 'ForAll', input, condition })
const LogicalNot = (input: M.Expr): M.LogicalNot => ({ tag: 'LogicalNot', input })
const CP = (id: number, tpe: M.SType): M.ConstPlaceholder => ({ tag: 'ConstPlaceholder', id, tpe })
const FunDef = (id: number, tpeArgs: string[], rhs: M.Expr): M.ValDef => ({ tag: 'ValDef', id, rhs, tpeArgs: tpeArgs.map((name) => ({ name })) })

/** `Int => Coll[Int]`. */
const FT: M.SType = { tag: 'SFunc', args: [T.Int], result: T.Coll(T.Int), tpeParams: [] }
const collIntEmpty = collInt([])
/** `Coll[Int](2)`: a lambda over it is applied once. */
const one = collInt([2])
/**
 * `DR(R4, Int => Coll[Int], default (x => Filter(BI)))` with R4 absent: the default evaluates to a closure, but reading
 * its type reads Filter(BI)'s, which casts the JVM's SAny to a collection (transformers.scala:121), a class cast. So it
 * is substituted untyped, and only a site that reads its type rejects.
 */
const bad = (): M.DeserializeRegister => DR(4, FT, lam(7, Filter(BI)))
const good = lam(8, collIntEmpty)
/** The same default under a declared `Coll[Int]`, for trees below v3, which cannot declare an SFunc type. */
const badColl = (): M.DeserializeRegister => DR(4, T.Coll(T.Int), lam(7, Filter(BI)))

// ── Spending ──────────────────────────────────────────────────────────────
type Entry = { tpe: M.SType; value: M.SValue }
const collByteEntry = (b: Uint8Array): Entry => ({
  tpe: T.Coll(T.Byte),
  value: { kind: 'Coll', elem: T.Byte, items: Array.from(b, (x) => ({ kind: 'Byte', value: (x << 24) >> 24 })) },
})
/** A register or variable holding the bytes of the script `e`. */
const script = (e: M.Expr): Entry => collByteEntry(exprBytes(e))
const intEntry = (n: number): Entry => ({ tpe: T.Int, value: { kind: 'Int', value: n } })
const collIntEntry = (ns: number[]): Entry => ({ tpe: T.Coll(T.Int), value: { kind: 'Coll', elem: T.Int, items: ns.map((n) => ({ kind: 'Int', value: n })) } })

interface Spent {
  ctx: EvalContext
  result?: M.SValue
  error?: unknown
}

/** Spend `bytes` as the probe does: SELF holds the tree (so R1 is its bytes), R4 and variable 1 as given. */
function spend(bytes: Uint8Array, opts: { r4?: Entry; var1?: Entry; self?: M.ErgoBox } = {}): Spent {
  const tree = parseParsedTree(bytes)
  const selfBox = opts.self ?? { ...synthesizeStubBox(), ergoTreeBytes: bytes, registers: opts.r4 ? { 4: opts.r4 } : {} }
  const ctx = makeContext({
    treeVersion: tree.header.version,
    constants: tree.constants,
    selfBox,
    extension: { values: new Map(opts.var1 ? [[1, opts.var1]] : []) },
  })
  try {
    return { ctx, result: evaluateWith(tree, ctx) }
  } catch (error) {
    return { ctx, error }
  }
}

const TRUE_PROP: M.SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
const FALSE_PROP: M.SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: false } }

function accepted(s: Spent): void {
  expect(s.error).toBeUndefined()
  expect(s.result).toEqual(TRUE_PROP)
}
function rejected(s: Spent, code: string): EvalError {
  expect(s.error).toBeInstanceOf(EvalError)
  expect((s.error as EvalError).code).toBe(code)
  return s.error as EvalError
}
/** A rebuilt ancestor fails the constructor's check, as Kiama's dup does; the check's own error is the cause. */
function rebuildFailed(s: Spent, causeCode: string): void {
  const err = rejected(s, 'deserialize-rebuild-failed')
  expect(err.cause).toMatchObject({ code: causeCode })
}
/**
 * The type read at a checkType site throws: the read's own ExprTpeError propagates, raised at eval, after a charge.
 * The substitution charges nothing, so a nonzero cost shows the read was the evaluator's, not the substitution's.
 */
function typeReadAtEval(s: Spent, code = 'filter-input-class-cast'): void {
  expect(s.error).toBeInstanceOf(ExprTpeError)
  expect((s.error as ExprTpeError).code).toBe(code)
  expect(s.ctx.jitCost).toBeGreaterThan(0)
}

// ── The trees ─────────────────────────────────────────────────────────────
const S1 = treeBytes(dead(GT(SizeOf(DR(4, T.Any, Filter(BI))), int(0))), 0x00)
const G1 = treeBytes(dead(GT(SizeOf(DR(4, T.Any, Filter(GV))), int(0))), 0x00)
const S2 = treeBytes(dead(EQ(DR(4, T.Any, Filter(BI)), GV)), 0x00)
const G2 = treeBytes(dead(EQ(DR(4, T.Any, Filter(GV)), GV)), 0x00)
const S3J = treeBytes(dead(EQ(DR(4, T.Any), GV)), 0x00)
const S16 = treeBytes(dead(EQ(DC(1, T.Any), GV)), 0x00)
const S3E = treeBytes(dead(EQ(DR(4, T.Int), int(0))), 0x00)
const S8 = treeBytes(dead(EQ(If(bool(true), DR(4, T.Any, Filter(BI)), GV), GV)), 0x00)
const G8 = treeBytes(dead(EQ(If(bool(true), DR(4, T.Any, Filter(GV)), GV), GV)), 0x00)
const S5 = treeBytes(dead(GT(Negation(DR(4, T.Int, collIntEmpty)), int(0))), 0x00)
const S6 = treeBytes(dead(OptionGet(DR(4, T.Option(T.Bool), collBool([])))), 0x00)
const S6_LIVE = treeBytes(sp(OptionGet(DR(4, T.Option(T.Bool), collBool([])))), 0x00)
const S9 = treeBytes(dead(GT(Plus(DR(4, T.Int, Filter(BI)), int(0)), int(0))), 0x00)
const L1 = treeBytes(sp(EQ(DR(4, T.Int), int(1))), 0x00)
const S10B = treeBytes(dead(EQ(DR(4, T.Tuple(T.Any, T.Int)), Tuple(GV, int(0)))), 0x00)
const S6B = treeBytes(dead(EQ(SizeOf(DR(4, T.Coll(T.Int), collBool([]))), int(0))), 0x00)
const S7 = treeBytes(dead(EQ(DR(4, T.Int, bool(true)), int(0))), 0x00)
const S7B = treeBytes(dead(EQ(DR(4, T.Int, long(0)), int(0))), 0x00)
const S9B = treeBytes(dead(GT(Plus(DR(4, T.Int, long(5)), int(0)), int(0))), 0x00)
const S15_SANTA = treeBytes(dead(EQ(DR(4, T.Int), int(1))), 0x00)

const b1Get = (d: M.Expr, index: M.Expr = int(0)): M.MethodCall => MC(12, 33, DR(4, T.Coll(T.Int), d), [index])
const B1A = treeBytes(OptionGet(MC(12, 33, DR(4, T.Coll(T.SigmaProp), collBool([true])), [int(0)])), 0x0b)
const B1B = treeBytes(dead(GT(Negation(OptionGet(b1Get(collBool([])))), int(0))), 0x0b)
const B1C = treeBytes(dead(GT(Negation(OptionGet(b1Get(Filter(BI)))), int(0))), 0x0b)
/** B1c with the get's index argument a segregated constant (review R2-B1): v3, sized, segregated. */
const B1C_SEGREGATED = serializeTree({
  header: { version: 3, hasSize: true, constantSegregation: true, rawHeader: 0x1b },
  constantTypes: [T.Int],
  constants: [{ kind: 'Int', value: 0 }],
  body: dead(GT(Negation(OptionGet(b1Get(Filter(BI), CP(0, T.Int)))), int(0))),
})
const M1 = treeBytes(dead(EQ(DC(1, T.Bool), bool(true))), 0x00)
const E1 = treeBytes(dead(EQ(SizeOf(DR(1, T.Coll(T.Byte))), int(0))), 0x00)
const E1_SANTA = treeBytes(dead(EQ(DR(1, T.Any), GV)), 0x00)
const R4B1 = treeBytes(sp(EQ(SizeOf(Coll(T.SigmaProp, [DR(4, T.SigmaProp, PC(101, 1, Ctx))])), int(1))), 0x00)
const R4B2 = treeBytes(sp(NEQ(DR(4, FT, lam(1, Filter(BI))), lam(1, collIntEmpty))), 0x0b)

const tupT = T.Tuple(FT, T.Int)
const foldOpSelect = lam(9, SelectField({ tag: 'ValUse', valId: 9, tpe: tupT }, 1), tupT)
const collBody = (): M.DeserializeRegister => DR(4, T.Coll(T.Int), lam(7, Filter(BI)))
const I5 = {
  neq: treeBytes(sp(NEQ(bad(), good)), 0x0b),
  eq: treeBytes(sp(EQ(bad(), good)), 0x0b),
  tupleUnderSelectField: treeBytes(sp(EQ(SizeOf(collIntEmpty), SelectField(Tuple(int(0), bad()), 1))), 0x0b),
  tuple: treeBytes(sp(NEQ(Tuple(int(0), bad()), Tuple(int(0), good))), 0x0b),
  coll: treeBytes(sp(EQ(SizeOf(Coll(FT, [bad()])), int(1))), 0x0b),
  blockRhs: treeBytes(Block([ValDef(1, bad())], sp(bool(true))), 0x0b),
  blockResult: treeBytes(sp(NEQ(Block([ValDef(1, int(0))], bad()), good)), 0x0b),
  ogeNone: treeBytes(sp(NEQ(OGE(GetVar(9, FT), bad()), good)), 0x0b),
  byIndexOutOfRange: treeBytes(sp(NEQ(ByIndex(Coll(FT, []), int(5), bad()), good)), 0x0b),
  foldZero: treeBytes(sp(NEQ(Fold(collIntEmpty, bad(), foldOpSelect), good)), 0x0b),
  lambdaBody: treeBytes(sp(NEQ(Apply(lam(3, bad()), [int(1)]), good)), 0x0b),
  ifBranch: treeBytes(sp(NEQ(If(bool(true), bad(), good), good)), 0x0b),
}
/**
 * The same two sites where nothing reads the node's type afterwards, so only the site's own read can reject: the
 * fold's result is applied rather than compared, and the inner application's result is an argument that the outer
 * lambda ignores (an argument's check compares its value with the stored type, values.scala:1074, reading no node).
 */
const isolatedFold = (zero: M.Expr): M.Expr => sp(EQ(SizeOf(Apply(Fold(one, zero, lam(9, good, tupT)), [int(1)])), int(0)))
const isolatedApply = (body: M.Expr): M.Expr => sp(EQ(Apply(lam(5, int(1), FT), [Apply(lam(3, body), [int(1)])]), int(1)))
const I5_ISOLATED = {
  foldZero: treeBytes(isolatedFold(bad()), 0x0b),
  foldZeroControl: treeBytes(isolatedFold(good), 0x0b),
  lambdaBody: treeBytes(isolatedApply(bad()), 0x0b),
  lambdaBodyControl: treeBytes(isolatedApply(good), 0x0b),
}
const byIndexInRange = sp(EQ(SizeOf(ByIndex(Coll(T.Coll(T.Int), [collIntEmpty]), int(0), badColl())), int(0)))
const ogeSome = sp(EQ(SizeOf(OGE(GetVar(1, T.Coll(T.Int)), badColl())), int(1)))
const I5V = {
  byIndexInRangeV0: treeBytes(byIndexInRange, 0x00),
  byIndexInRangeV3: treeBytes(byIndexInRange, 0x0b),
  ogeSomeV0: treeBytes(ogeSome, 0x00),
  ogeSomeV3: treeBytes(ogeSome, 0x0b),
}
const optionMap = (varId: number): M.MethodCall => MC(36, 7, GetVar(varId, T.Int), [lam(3, collBody())])
/** `Int => (Int => Coll[Int])`. */
const FT2: M.SType = { tag: 'SFunc', args: [T.Int], result: FT, tpeParams: [] }
/**
 * Map over a lambda parameter: `(f => SizeOf(Map(input, f)))(x => body)`. The mapper is a ValUse, whose type is stored,
 * so neither the Map's build nor its rebuild reads the applied lambda's body, nor does the arm's own read of an inline
 * mapper: the read after each application is the only one (values.scala:1080).
 */
const mapOverParameter = (body: M.Expr, input: M.Expr, size: number): M.Expr =>
  sp(EQ(Apply(lam(5, SizeOf(MapColl(input, { tag: 'ValUse', valId: 5, tpe: FT2 })), FT2), [lam(3, body)]), int(size)))
/** A live `DeserializeRegister(reg, Int, default 1) == 1`. */
const liveWithDefault = (reg: number): Uint8Array => treeBytes(sp(EQ(DR(reg, T.Int, int(1)), int(1))), 0x00)
const ARM = {
  map: treeBytes(sp(EQ(SizeOf(MapColl(one, lam(3, bad()))), int(1))), 0x0b),
  filter: treeBytes(sp(EQ(SizeOf(FilterBy(one, lam(3, bad()))), int(1))), 0x0b),
  exists: treeBytes(sp(Exists(one, lam(3, bad()))), 0x0b),
  forAll: treeBytes(sp(ForAll(one, lam(3, bad()))), 0x0b),
  fold: treeBytes(sp(NEQ(Fold(one, good, lam(9, bad(), tupT)), good)), 0x0b),
  flatMap: treeBytes(sp(EQ(SizeOf(MC(12, 15, one, [lam(3, collBody())])), int(0))), 0x0b),
  flatMapEmpty: treeBytes(sp(EQ(SizeOf(MC(12, 15, collIntEmpty, [lam(3, collBody())])), int(0))), 0x0b),
  optionMapSome: treeBytes(sp(EQ(SizeOf(OptionGet(optionMap(1))), int(0))), 0x0b),
  optionMapNone: treeBytes(sp(LogicalNot(OptionIsDefined(optionMap(9)))), 0x0b),
  mapOverParameter: treeBytes(mapOverParameter(bad(), one, 1), 0x0b),
  mapOverParameterGood: treeBytes(mapOverParameter(good, one, 1), 0x0b),
  mapOverParameterEmpty: treeBytes(mapOverParameter(bad(), collIntEmpty, 0), 0x0b),
}

describe('the probed bytes', () => {
  it('each tree and script is the one the probe or SANTA was given', () => {
    const trees: [Uint8Array, string][] = [
      [S1, '00d195010091b1d5046101b5b2860204000400040000d9010104010104000101'],
      [G1, '00d195010091b1d5046101b5e4e30161d9010104010104000101'],
      [S2, '00d195010093d5046101b5b2860204000400040000d90101040101e4e301610101'],
      [G2, '00d195010093d5046101b5e4e30161d90101040101e4e301610101'],
      [S3J, '00d195010093d5046100e4e301610101'],
      [S16, '00d195010093d46101e4e301610101'],
      [S3E, '00d195010093d504040004000101'],
      [S8, '00d195010093950101d5046101b5b2860204000400040000d90101040101e4e30161e4e301610101'],
      [G8, '00d195010093950101d5046101b5e4e30161d90101040101e4e30161e4e301610101'],
      [S5, '00d195010091f0d5040401100004000101'],
      [S6, '00d1950100e4d50425010d000101'],
      [S6_LIVE, '00d1e4d50425010d00'],
      [S9, '00d1950100919ad5040401b5b2860204000400040000d90101040101040004000101'],
      [L1, '00d193d50404000402'],
      [S10B, '00d195010093d5044c61008602e4e3016104000101'],
      [S6B, '00d195010093b1d50410010d0004000101'],
      [S7, '00d195010093d5040401010104000101'],
      [S7B, '00d195010093d5040401050004000101'],
      [S9B, '00d1950100919ad5040401050a040004000101'],
      [S15_SANTA, '00d195010093d504040004020101'],
      [B1A, '0b0ee4dc0c21d50414010d0101010400'],
      [B1B, '0b17d195010091f0e4dc0c21d50410010d0001040004000101'],
      [B1C, '0b26d195010091f0e4dc0c21d5041001b5b2860204000400040000d9010104010101040004000101'],
      [B1C_SEGREGATED, '1b29010400d195010091f0e4dc0c21d5041001b5b2860204000400040000d9010104010101730004000101'],
      [M1, '00d195010093d4010101010101'],
      [E1, '00d195010093b1d5010e0004000101'],
      [E1_SANTA, '00d195010093d5016100e4e301610101'],
      [R4B1, '00d193b1830108d5040801db6501fe0402'],
      [R4B2, '0b25d194d504700104100001d9010104b5b2860204000400040000d90101040101d90101041000'],
      [I5.neq, '0b25d194d504700104100001d9010704b5b2860204000400040000d90101040101d90108041000'],
      [I5.eq, '0b25d193d504700104100001d9010704b5b2860204000400040000d90101040101d90108041000'],
      [I5.tupleUnderSelectField, '0b28d193b110008c86020400d504700104100001d9010704b5b2860204000400040000d9010104010101'],
      [I5.tuple, '0b2dd19486020400d504700104100001d9010704b5b2860204000400040000d9010104010186020400d90108041000'],
      [I5.coll, '0b29d193b183017001041000d504700104100001d9010704b5b2860204000400040000d901010401010402'],
      [I5.blockRhs, '0b24d801d601d504700104100001d9010704b5b2860204000400040000d90101040101d10101'],
      [I5.blockResult, '0b2bd194d801d6010400d504700104100001d9010704b5b2860204000400040000d90101040101d90108041000'],
      [I5.ogeNone, '0b2dd194e5e3097001041000d504700104100001d9010704b5b2860204000400040000d90101040101d90108041000'],
      [I5.byIndexOutOfRange, '0b30d194b283007001041000040a01d504700104100001d9010704b5b2860204000400040000d90101040101d90108041000'],
      [I5.foldZero, '0b35d194b01000d504700104100001d9010704b5b2860204000400040000d90101040101d901094c70010410008c720901d90108041000'],
      [I5.lambdaBody, '0b2dd194dad9010304d504700104100001d9010704b5b2860204000400040000d90101040101010402d90108041000'],
      [I5.ifBranch, '0b2ed194950101d504700104100001d9010704b5b2860204000400040000d90101040101d90108041000d90108041000'],
      [I5_ISOLATED.foldZero, '0b39d193b1dab0100104d504700104100001d9010704b5b2860204000400040000d90101040101d901094c7001041000d901080410000104020400'],
      [I5_ISOLATED.foldZeroControl, '0b22d193b1dab0100104d90108041000d901094c7001041000d901080410000104020400'],
      [I5_ISOLATED.lambdaBody, '0b35d193dad901057001041000040201dad9010304d504700104100001d9010704b5b2860204000400040000d901010401010104020402'],
      [I5_ISOLATED.lambdaBodyControl, '0b1ed193dad901057001041000040201dad9010304d901080410000104020402'],
      [I5V.byIndexInRangeV0, '00d193b1b28301101000040001d5041001d9010704b5b2860204000400040000d901010401010400'],
      [I5V.byIndexInRangeV3, '0b27d193b1b28301101000040001d5041001d9010704b5b2860204000400040000d901010401010400'],
      [I5V.ogeSomeV0, '00d193b1e5e30110d5041001d9010704b5b2860204000400040000d901010401010402'],
      [I5V.ogeSomeV3, '0b22d193b1e5e30110d5041001d9010704b5b2860204000400040000d901010401010402'],
      [ARM.map, '0b2ad193b1ad100104d9010304d504700104100001d9010704b5b2860204000400040000d901010401010402'],
      [ARM.filter, '0b2ad193b1b5100104d9010304d504700104100001d9010704b5b2860204000400040000d901010401010402'],
      [ARM.exists, '0b26d1ae100104d9010304d504700104100001d9010704b5b2860204000400040000d90101040101'],
      [ARM.forAll, '0b26d1af100104d9010304d504700104100001d9010704b5b2860204000400040000d90101040101'],
      [ARM.fold, '0b38d194b0100104d90108041000d901094c7001041000d504700104100001d9010704b5b2860204000400040000d90101040101d90108041000'],
      [ARM.flatMap, '0b29d193b1dc0c0f10010401d9010304d5041001d9010704b5b2860204000400040000d901010401010400'],
      [ARM.flatMapEmpty, '0b28d193b1dc0c0f100001d9010304d5041001d9010704b5b2860204000400040000d901010401010400'],
      [ARM.optionMapSome, '0b2ad193b1e4dc2407e3010401d9010304d5041001d9010704b5b2860204000400040000d901010401010400'],
      [ARM.optionMapNone, '0b27d1efe6dc2407e3090401d9010304d5041001d9010704b5b2860204000400040000d90101040101'],
      [ARM.mapOverParameter, '0b3ad193dad90105700104700104100000b1ad100104720501d9010304d504700104100001d9010704b5b2860204000400040000d901010401010402'],
      [ARM.mapOverParameterGood, '0b23d193dad90105700104700104100000b1ad100104720501d9010304d901080410000402'],
      [ARM.mapOverParameterEmpty, '0b39d193dad90105700104700104100000b1ad1000720501d9010304d504700104100001d9010704b5b2860204000400040000d901010401010400'],
      [liveWithDefault(0), '00d193d500040104020402'],
      [liveWithDefault(2), '00d193d502040104020402'],
      [liveWithDefault(3), '00d193d503040104020402'],
      [liveWithDefault(5), '00d193d505040104020402'],
    ]
    for (const [bytes, probed] of trees) expect(hex(bytes)).toBe(probed)
    const scripts: [M.Expr, string][] = [
      [Filter(BI), 'b5b2860204000400040000d90101040101'],
      [BI, 'b2860204000400040000'],
      [OptionGet(BI), 'e4b2860204000400040000'],
      [Filter(GV), 'b5e4e30161d90101040101'],
      [OptionGet(GV), 'e4e4e30161'],
      [Negation(BI), 'f0b2860204000400040000'],
      [If(bool(true), int(1), SizeOf(OptionGet(BI))), '9501010402b1e4b2860204000400040000'],
      [If(bool(true), int(1), int(2)), '95010104020404'],
      [Apply(int(0), [int(0)]), 'da0400010400'],
      [Tuple(Apply(int(0), [int(0)]), int(1)), '8602da04000104000402'],
      [Tuple(BI, int(1)), '8602b28602040004000400000402'],
      [BitOr(bool(true), Filter(BI)), 'f20101b5b2860204000400040000d90101040101'],
      [BitOr(bool(true), int(1)), 'f201010402'],
    ]
    for (const [e, probed] of scripts) expect(hex(exprBytes(e))).toBe(probed)
  })
})

describe('the re-review table: accepted', () => {
  // The decode succeeds or the default is taken; a class cast at the decoded script's type read, or at the default's,
  // is swallowed or leaves the default untyped; no rebuilt ancestor reads a type that throws.
  it('S1: a class-cast default under SizeOf and GT (the JVM: TrueProp)', () => accepted(spend(S1)))
  it('G1: the same over the JVM SAny of GetVar (the JVM: TrueProp; a master regression)', () => accepted(spend(G1)))
  it('S2: a class-cast default under EQ (the JVM: TrueProp)', () => accepted(spend(S2)))
  it('G2: the same over GetVar (the JVM: TrueProp; a master regression)', () => accepted(spend(G2)))
  it('S3: R4 holds F(BI): the decode succeeds, its type read is a class cast, swallowed (the JVM: TrueProp)', () =>
    accepted(spend(S2, { r4: script(Filter(BI)) })))
  it('S3b: R4 holds BI, typed as the JVM SAny as declared: substituted (the JVM: TrueProp)', () =>
    accepted(spend(S2, { r4: script(BI) })))
  it('S3j: R4 holds OptionGet(BI): the decode is a class cast, swallowed (the JVM: TrueProp)', () =>
    accepted(spend(S3J, { r4: script(OptionGet(BI)) })))
  it('G3: R4 holds F(GV) (the JVM: TrueProp; a master regression)', () => accepted(spend(S2, { r4: script(Filter(GV)) })))
  it('G3j: R4 holds OptionGet(GV) (the JVM: TrueProp; a master regression)', () =>
    accepted(spend(S3J, { r4: script(OptionGet(GV)) })))
  it('S16: variable 1 holds F(BI): the type read is a class cast (the JVM: TrueProp)', () =>
    accepted(spend(S16, { var1: script(Filter(BI)) })))
  it('S16b: variable 1 holds OptionGet(BI): the decode is a class cast (the JVM: TrueProp)', () =>
    accepted(spend(S16, { var1: script(OptionGet(BI)) })))
  it('G16: variable 1 holds F(GV) (the JVM: TrueProp; a master regression)', () =>
    accepted(spend(S16, { var1: script(Filter(GV)) })))
  it('G16j: variable 1 holds OptionGet(GV) (the JVM: TrueProp; a master regression)', () =>
    accepted(spend(S16, { var1: script(OptionGet(GV)) })))
  it('S3e: a declared Int, R4 holds F(BI): the type read is a class cast (the JVM: TrueProp)', () =>
    accepted(spend(S3E, { r4: script(Filter(BI)) })))
  it('S15: R4 is an Int, not a Coll[Byte]: its value.toArray is a class cast, the node stays (the JVM: TrueProp)', () =>
    accepted(spend(S3E, { r4: intEntry(1) })))
})

describe('the re-review table: rejected', () => {
  it('S8: the If rebuilt over a class-cast default reads its type (the JVM: InvocationTargetException <- ClassCastException)', () =>
    rebuildFailed(spend(S8), 'filter-input-class-cast'))
  it('G8: the same over GetVar (the JVM: InvocationTargetException <- ClassCastException)', () =>
    rebuildFailed(spend(G8), 'filter-input-class-cast'))
  it('S9: the Plus rebuilt over a class-cast default reads its type (the JVM: InvocationTargetException <- ClassCastException)', () =>
    rebuildFailed(spend(S9), 'filter-input-class-cast'))
  it("S5: a Coll[Int] default for a declared Int; the JVM's rebuilt Negation rejects it, ergots' default check first", () =>
    rejected(spend(S5), 'deserialize-tpe-mismatch'))
  it("S6: a Coll[Boolean] default for a declared Option[Boolean]; the JVM's rebuilt OptionGet rejects it (SANTA #10's dead form)", () =>
    rejected(spend(S6), 'deserialize-tpe-mismatch'))
  it('S6, live (the JVM: InvocationTargetException <- ClassCastException)', () => rejected(spend(S6_LIVE), 'deserialize-tpe-mismatch'))
  it('S3h: R4 holds Negation(BI): the decode fails the require, not a class cast (the JVM: IllegalArgumentException)', () => {
    const err = rejected(spend(S3E, { r4: script(Negation(BI)) }), 'deserialize-parse-failed')
    expect(err.cause).toMatchObject({ code: 'negation-input-not-numeric' })
  })
  it('L1: a live register script whose decode is a class cast: the node stays and is evaluated (the JVM: "Should be overriden")', () =>
    rejected(spend(L1, { r4: script(If(bool(true), int(1), SizeOf(OptionGet(BI)))) }), 'deserialize-not-substituted'))
  it('S10: a decoded NoType against a declared SAny (the JVM: RuntimeException, "expected ... SAny; got NoType")', () =>
    rejected(spend(S3J, { r4: script(Apply(int(0), [int(0)])) }), 'deserialize-tpe-mismatch'))
  it('S10b: a decoded (NoType, Int) against a declared (SAny, Int): NoType at depth (probe: RuntimeException, the same message)', () =>
    rejected(spend(S10B, { r4: script(Tuple(Apply(int(0), [int(0)]), int(1))) }), 'deserialize-tpe-mismatch'))
  it("S10b's control: a decoded (SAny, Int) substitutes (probe: TrueProp)", () =>
    accepted(spend(S10B, { r4: script(Tuple(BI, int(1))) })))
  it('S16c: a decoded NoType in a context variable (the JVM: rule 1000)', () =>
    rejected(spend(S16, { var1: script(Apply(int(0), [int(0)])) }), 'deserialize-tpe-mismatch'))
})

describe("SELF's mandatory registers are always present (ErgoBox.get: R0-R2 from ErgoBoxCandidate.get, ErgoBoxCandidate.scala:69-83; R3 from its override, ErgoBox.scala:75-82)", () => {
  // R0 (a Long), R2 (the tokens) and R3 (a tuple) are present and not Coll[Byte]: `eba.value.toArray` is a class cast,
  // swallowed, so the node stays and its default is never taken; live, it throws. R1 is covered by E1 and SANTA #16-#19.
  for (const reg of [0, 2, 3]) {
    it(`R${reg} with a default, live: the node stays and is evaluated (probe: "Should be overriden")`, () =>
      rejected(spend(liveWithDefault(reg)), 'deserialize-not-substituted'))
  }
  it('the control, an absent R5: its default is taken (probe: TrueProp)', () => accepted(spend(liveWithDefault(5))))
})

describe('the re-review table: residual 7, still rejected (a wrong-typed default no rebuilt ancestor rejects)', () => {
  // The JVM substitutes these defaults untyped and accepts (probe: TrueProp for each). ergots keeps master's type check
  // of a default whose type it can read (spec Decision 8). A change that flips one of these must be the next spec's.
  it('S6b: a Coll[Boolean] default under SizeOf for a declared Coll[Int] (probe: TrueProp)', () =>
    rejected(spend(S6B), 'deserialize-tpe-mismatch'))
  it('S7: a Boolean default under EQ for a declared Int (probe: TrueProp)', () => rejected(spend(S7), 'deserialize-tpe-mismatch'))
  it('S7b: a Long default under EQ for a declared Int (probe: TrueProp)', () => rejected(spend(S7B), 'deserialize-tpe-mismatch'))
  it('S9b: a Long default under a rebuilt Plus, which reads it without a check (probe: TrueProp)', () =>
    rejected(spend(S9B), 'deserialize-tpe-mismatch'))
})

describe('the review witnesses', () => {
  it("B1a: a Coll[Boolean] default for a declared Coll[SigmaProp] at the root (probe: RuntimeException, 'Invalid result type')", () =>
    rejected(spend(B1A), 'deserialize-tpe-mismatch'))
  it('B1b: a Coll[Boolean] default under get, OptionGet and Negation (probe: TrueProp; residual 7, still rejected)', () =>
    rejected(spend(B1B), 'deserialize-tpe-mismatch'))
  it("B1c: a class-cast default under get: the rebuilt call keeps its recorded Option[Int], so OptionGet and Negation build (probe: TrueProp)", () =>
    accepted(spend(B1C)))
  it('B1c with the index a segregated constant: the placeholder rewrite keeps the call type too (review R2-B1; probe: TrueProp)', () =>
    accepted(spend(B1C_SEGREGATED)))
  it("M1: variable 1 holds BitOr(true, F(BI)): the require's message reads the right type, a class cast, swallowed (probe: TrueProp)", () =>
    accepted(spend(M1, { var1: script(BitOr(bool(true), Filter(BI))) })))
  it("M1's control: BitOr(true, 1) fails the require itself (probe: IllegalArgumentException)", () => {
    const err = rejected(spend(M1, { var1: script(BitOr(bool(true), int(1))) }), 'deserialize-parse-failed')
    expect(err.cause).toMatchObject({ code: 'bit-op-operand-not-numeric' })
  })
  it("E1: a dead DeserializeRegister(R1) decodes SELF's own tree, whose 00 is no type (probe: InvalidTypePrefix)", () => {
    const err = rejected(spend(E1), 'deserialize-parse-failed')
    expect(err.cause).toMatchObject({ code: 'type-prefix-invalid' })
  })
  it("R4-B1: an uncatalogued default typed as ergots' own SAny, in a Coll[SigmaProp] (probe: ArrayStoreException)", () =>
    rejected(spend(R4B1), 'deserialize-tpe-mismatch'))
  it("R4-B2: a class-cast lambda default under NEQ: NEQ's type read of its operand rejects (probe: ClassCastException)", () =>
    typeReadAtEval(spend(R4B2)))
})

// ── The builder's Upcast at a rebuild (spec §5; the final review, C1) ──────
// Before v3 the JVM's builder wraps the narrower of two different numeric operands of a relation in an Upcast
// (applyUpcast, SigmaBuilder.scala:674-683; equalityOp for EQ and NEQ, comparisonOp for LT, LE, GT and GE), and the
// ByIndex serializer wraps a Byte or Short index the same way (ByIndexSerializer.scala:29-33). Kiama's dup rebuilds that
// Upcast over a substituted child and re-runs its require, which reads the child's type (trees.scala:398). A class-cast
// default, substituted untyped, fails that read, so the JVM rejects the spend, in a dead branch too. The wider operand
// is not wrapped, and the JVM accepts a substituted default there. Every verdict is the local sigma-state 6.0.6 probe's,
// spend mode with R4 absent; each reject is an InvocationTargetException over a ClassCastException, the rebuilt Upcast's
// read of Filter(BI)'s type.
const LT = (l: M.Expr, r: M.Expr): M.BinOp => ({ tag: 'BinOp', op: { kind: 'Relation', op: 'Lt' }, left: l, right: r })
const GE = (l: M.Expr, r: M.Expr): M.BinOp => ({ tag: 'BinOp', op: { kind: 'Relation', op: 'Ge' }, left: l, right: r })
const byte = (n: number): M.Const => ({ tag: 'Const', tpe: T.Byte, value: { kind: 'Byte', value: n } })
const SHORT: M.SType = { tag: 'SShort' }
/** A default whose type read is a class cast: the substitution puts it in untyped. */
const X = (): M.Filter => Filter(BI)
/** CONTEXT.preHeader.timestamp: ergots' catalog lacks 105:3, so it types as ergots' own SAny; the JVM's type is Long. */
const TS = PC(105, 3, PC(101, 3, Ctx))
const UPCAST = {
  // The witnesses: the DR is the operand the builder wraps.
  eqNarrow: treeBytes(dead(EQ(DR(4, T.Int, X()), long(1))), 0x00),
  ltNarrow: treeBytes(dead(LT(DR(4, T.Int, X()), long(1))), 0x00),
  neqRightNarrow: treeBytes(dead(NEQ(long(1), DR(4, T.Int, X()))), 0x00),
  geByteV1: treeBytes(dead(GE(DR(4, T.Byte, X()), int(1))), 0x09),
  eqUnderBlock: treeBytes(dead(EQ(Block([], DR(4, T.Int, X())), long(1))), 0x00),
  byIndexByteV0: treeBytes(dead(EQ(ByIndex(collInt([1, 2]), DR(4, T.Byte, X())), int(1))), 0x00),
  byIndexShortV2: treeBytes(dead(EQ(ByIndex(collInt([1, 2]), DR(4, SHORT, X())), int(1))), 0x0a),
  eqLive: treeBytes(sp(EQ(DR(4, T.Int, X()), long(1))), 0x00),
  /** The wider operand a placeholder: the placeholder rewrite rebuilds the EQ first, and must keep the record. */
  eqSegregated: serializeTree({
    header: { version: 0, hasSize: false, constantSegregation: true, rawHeader: 0x10 },
    constantTypes: [T.Long],
    constants: [{ kind: 'Long', value: 1n }],
    body: dead(EQ(DR(4, T.Int, X()), CP(0, T.Long))),
  }),
  // The controls: the builder wraps the other operand, or nothing.
  eqWide: treeBytes(dead(EQ(DR(4, T.Long, X()), int(1))), 0x00),
  ltWide: treeBytes(dead(LT(DR(4, T.Long, X()), int(1))), 0x00),
  neqRightWide: treeBytes(dead(NEQ(int(1), DR(4, T.Long, X()))), 0x00),
  geWideV1: treeBytes(dead(GE(DR(4, T.Int, X()), byte(1))), 0x09),
  eqSame: treeBytes(dead(EQ(DR(4, T.Long, X()), long(1))), 0x00),
  eqSameV3: treeBytes(dead(EQ(DR(4, T.Long, X()), long(1))), 0x0b),
  eqNarrowTypedDefault: treeBytes(dead(EQ(DR(4, T.Int, int(7)), long(1))), 0x00),
  plusNarrow: treeBytes(dead(GT(Plus(DR(4, T.Int, X()), long(1)), long(0))), 0x00),
  byIndexIntV0: treeBytes(dead(EQ(ByIndex(collInt([1, 2]), DR(4, T.Int, X())), int(1))), 0x00),
  byIndexByteV3: treeBytes(dead(EQ(ByIndex(collInt([1, 2]), DR(4, T.Byte, X())), int(1))), 0x0b),
  // Residual 1: an operand typed as ergots' own SAny, so ergots cannot tell which operand the builder wrapped.
  ownSAnyNarrowDR: treeBytes(dead(EQ(TS, DR(4, T.Int, X()))), 0x00),
  ownSAnySameDR: treeBytes(dead(EQ(TS, DR(4, T.Long, X()))), 0x00),
}

describe("the builder's Upcast at a rebuild (spec §5; the final review, C1)", () => {
  it('each tree is the one the probe was given', () => {
    const trees: [Uint8Array, string][] = [
      [UPCAST.eqNarrow, '00d195010093d5040401b5b2860204000400040000d9010104010105020101'],
      [UPCAST.ltNarrow, '00d19501008fd5040401b5b2860204000400040000d9010104010105020101'],
      [UPCAST.neqRightNarrow, '00d1950100940502d5040401b5b2860204000400040000d901010401010101'],
      [UPCAST.geByteV1, '091ed195010092d5040201b5b2860204000400040000d9010104010104020101'],
      [UPCAST.eqUnderBlock, '00d195010093d800d5040401b5b2860204000400040000d9010104010105020101'],
      [UPCAST.byIndexByteV0, '00d195010093b210020204d5040201b5b2860204000400040000d901010401010004020101'],
      [UPCAST.byIndexShortV2, '0a24d195010093b210020204d5040301b5b2860204000400040000d901010401010004020101'],
      [UPCAST.eqLive, '00d193d5040401b5b2860204000400040000d901010401010502'],
      [UPCAST.eqSegregated, '10010502d195010093d5040401b5b2860204000400040000d9010104010173000101'],
      [UPCAST.eqWide, '00d195010093d5040501b5b2860204000400040000d9010104010104020101'],
      [UPCAST.ltWide, '00d19501008fd5040501b5b2860204000400040000d9010104010104020101'],
      [UPCAST.neqRightWide, '00d1950100940402d5040501b5b2860204000400040000d901010401010101'],
      [UPCAST.geWideV1, '091ed195010092d5040401b5b2860204000400040000d9010104010102010101'],
      [UPCAST.eqSame, '00d195010093d5040501b5b2860204000400040000d9010104010105020101'],
      [UPCAST.eqSameV3, '0b1ed195010093d5040501b5b2860204000400040000d9010104010105020101'],
      [UPCAST.eqNarrowTypedDefault, '00d195010093d5040401040e05020101'],
      [UPCAST.plusNarrow, '00d1950100919ad5040401b5b2860204000400040000d90101040101050205000101'],
      [UPCAST.byIndexIntV0, '00d195010093b210020204d5040401b5b2860204000400040000d901010401010004020101'],
      [UPCAST.byIndexByteV3, '0b24d195010093b210020204d5040201b5b2860204000400040000d901010401010004020101'],
      [UPCAST.ownSAnyNarrowDR, '00d195010093db6903db6503fed5040401b5b2860204000400040000d901010401010101'],
      [UPCAST.ownSAnySameDR, '00d195010093db6903db6503fed5040501b5b2860204000400040000d901010401010101'],
    ]
    for (const [bytes, probed] of trees) expect(hex(bytes)).toBe(probed)
  })

  describe('the witnesses: the rebuilt Upcast reads the substituted default, a class cast (the JVM: InvocationTargetException <- ClassCastException)', () => {
    it('v0 EQ(DR(R4, Int, F(BI)), 1L): the DR, an Int against a Long, is wrapped', () =>
      rebuildFailed(spend(UPCAST.eqNarrow), 'filter-input-class-cast'))
    it('v0 LT, the same operands (comparisonOp)', () => rebuildFailed(spend(UPCAST.ltNarrow), 'filter-input-class-cast'))
    it('v0 NEQ with the DR on the right', () => rebuildFailed(spend(UPCAST.neqRightNarrow), 'filter-input-class-cast'))
    it('v1 GE of a Byte DR against an Int', () => rebuildFailed(spend(UPCAST.geByteV1), 'filter-input-class-cast'))
    it('v0 EQ over BlockValue([], DR): the Upcast wraps the block, whose type is its result\'s', () =>
      rebuildFailed(spend(UPCAST.eqUnderBlock), 'filter-input-class-cast'))
    it('v0 ByIndex with a Byte DR index: the parse wrapped the index (ByIndexSerializer.scala:29-33)', () =>
      rebuildFailed(spend(UPCAST.byIndexByteV0), 'filter-input-class-cast'))
    it('v2 ByIndex with a Short DR index', () => rebuildFailed(spend(UPCAST.byIndexShortV2), 'filter-input-class-cast'))
    it('the first witness live: the same rebuild rejects it before any evaluation', () =>
      rebuildFailed(spend(UPCAST.eqLive), 'filter-input-class-cast'))
    it('the wider operand a segregated constant: the placeholder rewrite keeps the record through its own rebuild', () =>
      rebuildFailed(spend(UPCAST.eqSegregated), 'filter-input-class-cast'))
  })

  describe('the controls (the JVM: TrueProp, except where noted)', () => {
    it('v0 EQ with the DR the wider operand: the builder wraps the constant, and the DR is not read', () =>
      accepted(spend(UPCAST.eqWide)))
    it('v0 LT with the DR the wider operand', () => accepted(spend(UPCAST.ltWide)))
    it('v0 NEQ with the DR on the right, the wider operand', () => accepted(spend(UPCAST.neqRightWide)))
    it('v1 GE of an Int DR against a Byte', () => accepted(spend(UPCAST.geWideV1)))
    it('v0 EQ of the same type: no Upcast', () => accepted(spend(UPCAST.eqSame)))
    it('v3 EQ of the same type: no builder Upcast from v3 (SigmaBuilder.scala:757-763)', () => accepted(spend(UPCAST.eqSameV3)))
    it('v0 EQ with the DR narrower and a default of the declared Int: the rebuilt Upcast reads an Int', () =>
      accepted(spend(UPCAST.eqNarrowTypedDefault)))
    it('v0 Plus with the DR narrower: the rebuilt ArithOp reads both operands already (the JVM: InvocationTargetException <- ClassCastException)', () =>
      rebuildFailed(spend(UPCAST.plusNarrow), 'filter-input-class-cast'))
    it('v0 ByIndex with an Int DR index: no Upcast, so the index is not read', () => accepted(spend(UPCAST.byIndexIntV0)))
    it('v3 ByIndex with a Byte DR index: no Upcast from v3', () => accepted(spend(UPCAST.byIndexByteV3)))
    it('v0 EQ of ergots\' own SAny (the JVM: Long) and a Long DR: no Upcast in the JVM, and none read in ergots', () =>
      accepted(spend(UPCAST.ownSAnySameDR)))
    // Residual 1: ergots cannot tell which operand the JVM's builder wrapped when one is typed as its own SAny, so it
    // records 'unknown' and a rebuild reads neither. Here the JVM's type is Long, so it wrapped the Int DR, and its rebuild
    // rejects (probe: InvocationTargetException <- ClassCastException). Pinned so a fix of residual 1 flips it knowingly.
    it("v0 EQ of ergots' own SAny (the JVM: Long) and an Int DR: ergots accepts where the JVM rejects (residual 1, a known divergence)", () =>
      accepted(spend(UPCAST.ownSAnyNarrowDR)))
  })
})

describe('the type reads at the checkType sites (spec §5 item 5)', () => {
  // A class-cast default substituted untyped: a lambda whose type read reads Filter(BI)'s. Each site reads it after
  // evaluating it (values.scala:251-254). Every probe verdict is a plain ClassCastException unless it says otherwise.
  it("NEQ's operand (trees.scala:1226-1228; probe: ClassCastException)", () => typeReadAtEval(spend(I5.neq)))
  it("EQ's operand (trees.scala:1206-1208; probe: ClassCastException)", () => typeReadAtEval(spend(I5.eq)))
  it('a Tuple item (values.scala:830-833; probe: ClassCastException)', () => typeReadAtEval(spend(I5.tuple)))
  it('a Tuple item under SelectField: the rebuilt SelectField reads it first (probe: InvocationTargetException <- ClassCastException)', () =>
    rebuildFailed(spend(I5.tupleUnderSelectField), 'filter-input-class-cast'))
  it('a ConcreteCollection item (values.scala:894; probe: ClassCastException)', () => typeReadAtEval(spend(I5.coll)))
  it("a BlockValue's right-hand side (values.scala:1027; probe: ClassCastException)", () => typeReadAtEval(spend(I5.blockRhs)))
  it("a BlockValue's result (values.scala:1034; probe: ClassCastException)", () => typeReadAtEval(spend(I5.blockResult)))
  it("OptionGetOrElse's default, taken (transformers.scala:634; probe: ClassCastException)", () => typeReadAtEval(spend(I5.ogeNone)))
  it("ByIndex's default, taken (transformers.scala:268; probe: ClassCastException)", () =>
    typeReadAtEval(spend(I5.byIndexOutOfRange)))
  it("Fold's zero (transformers.scala:227; probe: ClassCastException)", () => typeReadAtEval(spend(I5.foldZero)))
  it("Fold's zero, where no later site reads the Fold's type (probe: ClassCastException; its control: TrueProp)", () => {
    typeReadAtEval(spend(I5_ISOLATED.foldZero))
    accepted(spend(I5_ISOLATED.foldZeroControl))
  })
  it("a lambda's body, at Apply (values.scala:1080; probe: ClassCastException)", () => typeReadAtEval(spend(I5.lambdaBody)))
  it("a lambda's body at Apply, where no later site reads the result's type (probe: ClassCastException; its control: TrueProp)", () => {
    typeReadAtEval(spend(I5_ISOLATED.lambdaBody))
    accepted(spend(I5_ISOLATED.lambdaBodyControl))
  })
  it('the taken If branch: the rebuilt If reads all three first (trees.scala:1313; probe: InvocationTargetException <- ClassCastException)', () =>
    rebuildFailed(spend(I5.ifBranch), 'filter-input-class-cast'))
})

describe("the defaults' reads follow the JVM's evaluation, by version", () => {
  // Before v3 ByIndex and OptionGetOrElse evaluate their default always, and check it (transformers.scala:268-273,
  // 634-640); from v3 only when it is taken.
  it('an in-range ByIndex before v3 evaluates and reads its default (probe: ClassCastException)', () =>
    typeReadAtEval(spend(I5V.byIndexInRangeV0)))
  it('an in-range ByIndex from v3 does not (probe: TrueProp)', () => accepted(spend(I5V.byIndexInRangeV3)))
  it('OptionGetOrElse over Some before v3 evaluates and reads its default (probe: ClassCastException)', () =>
    typeReadAtEval(spend(I5V.ogeSomeV0, { var1: collIntEntry([2]) })))
  it('OptionGetOrElse over Some from v3 does not (probe: TrueProp)', () => accepted(spend(I5V.ogeSomeV3, { var1: collIntEntry([2]) })))
})

describe("a lambda's body type, read at each application, per lambda-applying arm", () => {
  it('Filter (probe: ClassCastException)', () => typeReadAtEval(spend(ARM.filter)))
  it('Exists (probe: ClassCastException)', () => typeReadAtEval(spend(ARM.exists)))
  it('ForAll (probe: ClassCastException)', () => typeReadAtEval(spend(ARM.forAll)))
  it('Fold (probe: ClassCastException)', () => typeReadAtEval(spend(ARM.fold)))
  it("Map over an inline lambda: the rebuilt MapCollection reads its mapper's type first (probe: InvocationTargetException <- ClassCastException)", () =>
    rebuildFailed(spend(ARM.map), 'filter-input-class-cast'))
  it('Map over a lambda parameter: the read after each application is the only one that rejects (probe: ClassCastException)', () =>
    typeReadAtEval(spend(ARM.mapOverParameter)))
  it("Map over a lambda parameter, its controls: a good body, and the bad one over an empty collection, never applied (probe: TrueProp for both)", () => {
    accepted(spend(ARM.mapOverParameterGood))
    accepted(spend(ARM.mapOverParameterEmpty))
  })
  it("flatMap, applied once (probe: InvocationTargetException <- ClassCastException, the method's reflective call)", () =>
    typeReadAtEval(spend(ARM.flatMap)))
  it('Option.map over Some (probe: InvocationTargetException <- ClassCastException)', () =>
    typeReadAtEval(spend(ARM.optionMapSome, { var1: intEntry(1) })))
  // Residual 7 (found 2026-09-30): the JVM never applies the lambda, so it reads no body type and accepts (probe:
  // TrueProp for both). ergots' flatMap and Option.map arms read the body's type before any application, for their
  // output element type (eval/scoll-flat-map.ts, eval/soption-map.ts), and reject; the JVM types the result from the
  // call's type, which needs both methods in the catalog. Only a class-cast default reaches this; master rejected it
  // earlier, at the default's type check. Pinned so a fix flips them knowingly.
  it('flatMap over an empty collection: ergots rejects where the JVM accepts (a known divergence)', () =>
    typeReadAtEval(spend(ARM.flatMapEmpty)))
  it('Option.map over None: ergots rejects where the JVM accepts (a known divergence)', () =>
    typeReadAtEval(spend(ARM.optionMapNone)))
})

// ── SANTA 7e2f5f4, deserialize-substitution-spend.json ─────────────────────
describe('SANTA 7e2f5f4: the same cases at the transaction level', () => {
  // Each entry's spent tree, from its input box, against this file's encoding of the case. Task 7 replays the
  // transactions; here the evaluator spends the same trees.
  const SANTA_TREES: [string, Uint8Array, string][] = [
    ['#0 S3j', S3J, '00d195010093d5046100e4e301610101'],
    ['#1, #2, #5 L1', L1, '00d193d50404000402'],
    ['#3 S3, #6 S2', S2, '00d195010093d5046101b5b2860204000400040000d90101040101e4e301610101'],
    ['#4 S15', S15_SANTA, '00d195010093d504040004020101'],
    ['#7 S1', S1, '00d195010091b1d5046101b5b2860204000400040000d9010104010104000101'],
    ['#8 S8', S8, '00d195010093950101d5046101b5b2860204000400040000d90101040101e4e30161e4e301610101'],
    ['#9 S5', S5, '00d195010091f0d5040401100004000101'],
    ['#10 S6', S6, '00d1950100e4d50425010d000101'],
    ['#11 S9', S9, '00d1950100919ad5040401b5b2860204000400040000d90101040101040004000101'],
    ['#12 S10', S3J, '00d195010093d5046100e4e301610101'],
    ['#13-#15 S16', S16, '00d195010093d46101e4e301610101'],
    ['#19 E1', E1_SANTA, '00d195010093d5016100e4e301610101'],
  ]
  it("the spent trees are this file's", () => {
    for (const [, bytes, santa] of SANTA_TREES) expect(hex(bytes)).toBe(santa)
  })
  it('#2: the L1 twin, If(true, 1, 2), decodes typed Int and substitutes (valid)', () =>
    accepted(spend(L1, { r4: script(If(bool(true), int(1), int(2))) })))
  it('#4: S15 with the constant 1 (valid)', () => accepted(spend(S15_SANTA, { r4: intEntry(1) })))
  it('#5: S15 live: the node stays and is evaluated (invalid, "Should be overriden")', () =>
    rejected(spend(L1, { r4: intEntry(1) }), 'deserialize-not-substituted'))
  it('#19: E1 over a DeserializeRegister(R1, SAny) (invalid, InvalidTypePrefix)', () => {
    const err = rejected(spend(E1_SANTA), 'deserialize-parse-failed')
    expect(err.cause).toMatchObject({ code: 'type-prefix-invalid' })
  })

  // #16-#18: DeserializeRegister(R1) over SELF's segregated tree, whose bytes 10 01 04 ... read as a value are the
  // constant Coll[Int](2): type 10, length 01, item 04; the decode ignores the rest. The input box is SANTA's.
  const santaSelf = (boxHex: string): M.ErgoBox => {
    const v = parseSValue({ tag: 'SBox' }, 3, new ByteReader(hexToBytes(boxHex)))
    if (v.kind !== 'Box') throw new Error('not a box')
    return v.value
  }
  const R1 = {
    16: '8094ebdc0310010404d193b2d50110000400007300010000a22916bca3ab8b24e07e246ca962d39c91671f4b8175414dc7df3a0af4d272c300',
    17: '8094ebdc0310010402d193b2d50110000400007300010000498c36d935a56c57f11564211b6b8bba58758111a9e3e643f8a69241bfc6f40600',
    18: '8094ebdc0310010402d193b1d5011100730001000035662fae67ba46e80ab3b7d48aacf343dbcb8e3cb01ffd7a91cc0f3698863d4300',
  }
  const spendSelf = (boxHex: string): Spent => {
    const self = santaSelf(boxHex)
    return spend(self.ergoTreeBytes, { self })
  }
  it('#16: the decoded item is checked against its constant, 2 == 2 (valid)', () => {
    const self = santaSelf(R1[16])
    expect(hex(self.ergoTreeBytes)).toBe('10010404d193b2d50110000400007300')
    accepted(spendSelf(R1[16]))
  })
  it('#17: the constant 1: 2 == 1 is false (invalid)', () => {
    const s = spendSelf(R1[17])
    expect(s.error).toBeUndefined()
    expect(s.result).toEqual(FALSE_PROP)
  })
  it('#18: the same bytes declared Coll[Long] (invalid, "expected ... Coll[SLong$]; got Coll[SInt$]")', () =>
    rejected(spendSelf(R1[18]), 'deserialize-tpe-mismatch'))

  // #20-#23: the root DeserializeRegister(R4, SigmaProp, d), R4 absent.
  it('#20: the default true, which the JVM substitutes untyped and wraps in sigmaProp (valid; residual 7, still rejected)', () =>
    rejected(spend(treeBytes(DR(4, T.SigmaProp, bool(true)), 0x00)), 'deserialize-tpe-mismatch'))
  it('#21: the default false (invalid: the JVM reduces to sigmaProp(false))', () =>
    rejected(spend(treeBytes(DR(4, T.SigmaProp, bool(false)), 0x00)), 'deserialize-tpe-mismatch'))
  it('#22: the default Int 1 (invalid: the root is neither Boolean nor SigmaProp)', () =>
    rejected(spend(treeBytes(DR(4, T.SigmaProp, int(1)), 0x00)), 'deserialize-tpe-mismatch'))
  it('#23: no default: the node stays and is evaluated (invalid)', () =>
    rejected(spend(treeBytes(DR(4, T.SigmaProp), 0x00)), 'deserialize-not-substituted'))
})

describe('the rewrite rebuilds only what changed (review m7) and keeps every field', () => {
  const ctxFor = (tree: M.ParsedErgoTree, var1?: Entry): EvalContext =>
    makeContext({
      treeVersion: tree.header.version,
      selfBox: { ...synthesizeStubBox(), registers: {} },
      extension: { values: new Map(var1 ? [[1, var1]] : []) },
    })

  it('a tree whose Deserialize node stays comes back as the same object', () => {
    const tree = parseParsedTree(S16)
    expect(substituteDeserialize(tree.body, tree, ctxFor(tree), false)).toBe(tree.body)
  })
  it('only the ancestors of a substituted node are new; a sibling subtree keeps its identity', () => {
    const tree = parseParsedTree(treeBytes(sp(If(EQ(SizeOf(collInt([1])), int(1)), EQ(DC(1, T.Int), int(5)), bool(false))), 0x00))
    const out = substituteDeserialize(tree.body, tree, ctxFor(tree, script(int(5))), false)
    const before = tree.body as M.BoolToSigmaProp
    const after = out as M.BoolToSigmaProp
    expect(after).not.toBe(before)
    const ifBefore = before.input as M.If
    const ifAfter = after.input as M.If
    expect(ifAfter).not.toBe(ifBefore)
    expect(ifAfter.condition).toBe(ifBefore.condition)
    expect(ifAfter.falseBranch).toBe(ifBefore.falseBranch)
    expect((ifAfter.trueBranch as M.BinOp).right).toBe((ifBefore.trueBranch as M.BinOp).right)
    expect((ifAfter.trueBranch as M.BinOp).left).toEqual(int(5))
    expect(evaluateWith(tree, ctxFor(tree, script(int(5))))).toEqual(TRUE_PROP)
  })
  it('the placeholder rewrite rebuilds only the ancestors of a placeholder, and returns a tree with none as the same object', () => {
    const sibling = EQ(SizeOf(collInt([1])), int(1))
    const withPlaceholder = serializeTree({
      header: { version: 0, hasSize: false, constantSegregation: true, rawHeader: 0x10 },
      constantTypes: [T.Int],
      constants: [{ kind: 'Int', value: 0 }],
      body: sp(If(sibling, EQ(CP(0, T.Int), int(0)), bool(false))),
    })
    const tree = parseParsedTree(withPlaceholder)
    const out = substituteConstants(tree.body, tree.constants, tree.constantTypes, 0) as M.BoolToSigmaProp
    const ifBefore = (tree.body as M.BoolToSigmaProp).input as M.If
    const ifAfter = out.input as M.If
    expect(ifAfter).not.toBe(ifBefore)
    expect(ifAfter.condition).toBe(ifBefore.condition)
    expect((ifAfter.trueBranch as M.BinOp).left).toEqual(int(0))
    const none = parseParsedTree(treeBytes(sp(If(sibling, EQ(int(0), int(0)), bool(false))), 0x00))
    expect(substituteConstants(none.body, none.constants, none.constantTypes, 0)).toBe(none.body)
  })
  it('a rebuilt FunDef keeps its type arguments (mapChildren dropped them before 2026-09-30)', () => {
    const tree = parseParsedTree(treeBytes(Block([FunDef(1, ['T'], DC(1, T.Int))], sp(bool(true))), 0x0b))
    const funDef = (tree.body as M.BlockValue).items[0] as M.ValDef
    expect(funDef.tpeArgs).toEqual([{ name: 'T' }])
    const out = substituteDeserialize(tree.body, tree, ctxFor(tree, script(int(5))), false) as M.BlockValue
    const rebuilt = out.items[0] as M.ValDef
    expect(rebuilt).not.toBe(funDef)
    expect(rebuilt.rhs).toEqual(int(5))
    expect(rebuilt.tpeArgs).toEqual([{ name: 'T' }])
  })
})

describe('one version per evaluation (spec §1)', () => {
  it('evaluateWith sets an unset ctx.treeVersion to the tree header version before any work', () => {
    // Coll.get (12:33) is a v3 method, whose handler checks the evaluation's version.
    const tree = parseParsedTree(treeBytes(sp(OptionIsDefined(MC(12, 33, collInt([1]), [int(0)]))), 0x0b))
    const ctx = makeContext({})
    expect(evaluateWith(tree, ctx)).toEqual(TRUE_PROP)
    expect(ctx.treeVersion).toBe(3)
  })
  it('a version the caller sets is kept', () => {
    const tree = parseParsedTree(treeBytes(sp(bool(true)), 0x0b))
    const ctx = makeContext({ treeVersion: 5 })
    evaluateWith(tree, ctx)
    expect(ctx.treeVersion).toBe(5)
  })
})
