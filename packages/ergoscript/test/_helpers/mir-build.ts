/**
 * Typed builders for MIR trees in tests. The names follow the case generator used to ask a local
 * sigma-state 6.0.6 probe for the JVM's verdicts, so a test can build a probed tree with the same
 * expression the probe case was built from, and cite that case.
 *
 * `T.Any` is `SANY_JVM`, the object `parseSType` returns for type code 97, so a tree built here
 * types as the same tree parsed from its bytes. ergots' own `SAny` (a fresh `{ tag: 'SAny' }` from
 * its method typing, residual 1) comes from a call its catalog lacks, such as
 * `PC(105, 3, PC(101, 3, Ctx))`, CONTEXT.preHeader.timestamp, which the JVM types as Long.
 *
 * Test-only: not part of the published bundle.
 */

import type * as M from '../../src/mir/types'
import { SANY_JVM } from '../../src/mir/types'
import { serializeTree } from '../../src/wire/ergo-tree'

type SType = M.SType
type Expr = M.Expr

export const T = {
  Int: { tag: 'SInt' } as SType,
  Long: { tag: 'SLong' } as SType,
  Bool: { tag: 'SBoolean' } as SType,
  Byte: { tag: 'SByte' } as SType,
  SigmaProp: { tag: 'SSigmaProp' } as SType,
  Any: SANY_JVM,
  Coll: (elem: SType): SType => ({ tag: 'SColl', elem }),
  Option: (elem: SType): SType => ({ tag: 'SOption', elem }),
  Tuple: (...items: SType[]): SType => ({ tag: 'STuple', items }),
}

// ── Constants ──────────────────────────────────────────────────────────────
export const int = (n: number): M.Const => ({ tag: 'Const', tpe: T.Int, value: { kind: 'Int', value: n } })
export const long = (n: number | bigint): M.Const => ({ tag: 'Const', tpe: T.Long, value: { kind: 'Long', value: BigInt(n) } })
export const bool = (b: boolean): M.Const => ({ tag: 'Const', tpe: T.Bool, value: { kind: 'Boolean', value: b } })
export const bytes = (arr: ArrayLike<number>): M.Const => ({
  tag: 'Const',
  tpe: T.Coll(T.Byte),
  value: { kind: 'Coll', elem: T.Byte, items: Array.from(arr, (x) => ({ kind: 'Byte', value: (x << 24) >> 24 })) },
})
export const collInt = (ns: number[]): M.Const => ({
  tag: 'Const',
  tpe: T.Coll(T.Int),
  value: { kind: 'Coll', elem: T.Int, items: ns.map((n) => ({ kind: 'Int', value: n })) },
})
export const collBool = (bs: boolean[]): M.Const => ({
  tag: 'Const',
  tpe: T.Coll(T.Bool),
  value: { kind: 'Coll', elem: T.Bool, items: bs.map((b) => ({ kind: 'Boolean', value: b })) },
})

// ── Operators ──────────────────────────────────────────────────────────────
export const bin = (op: M.BinOpKind, left: Expr, right: Expr): M.BinOp => ({ tag: 'BinOp', op, left, right })
export const EQ = (l: Expr, r: Expr): M.BinOp => bin({ kind: 'Relation', op: 'Eq' }, l, r)
export const GT = (l: Expr, r: Expr): M.BinOp => bin({ kind: 'Relation', op: 'Gt' }, l, r)
export const Plus = (l: Expr, r: Expr): M.BinOp => bin({ kind: 'Arith', op: 'Plus' }, l, r)
export const BitOr = (l: Expr, r: Expr): M.BinOp => bin({ kind: 'Bit', op: 'BitOr' }, l, r)
export const Negation = (input: Expr): M.Negation => ({ tag: 'Negation', input })
export const BitInversion = (input: Expr): M.BitInversion => ({ tag: 'BitInversion', input })
export const Upcast = (input: Expr, tpe: SType): M.Upcast => ({ tag: 'Upcast', input, tpe })
export const Downcast = (input: Expr, tpe: SType): M.Downcast => ({ tag: 'Downcast', input, tpe })

// ── Structure ──────────────────────────────────────────────────────────────
export const sp = (input: Expr): M.BoolToSigmaProp => ({ tag: 'BoolToSigmaProp', input })
export const If = (c: Expr, t: Expr, f: Expr): M.If => ({ tag: 'If', condition: c, trueBranch: t, falseBranch: f })
export const Tuple = (...items: Expr[]): M.Tuple => ({ tag: 'Tuple', items })
export const Coll = (elemTpe: SType, items: Expr[]): M.Collection => ({ tag: 'Collection', kind: 'Exprs', elemTpe, items })
export const Apply = (func: Expr, args: Expr[]): M.Apply => ({ tag: 'Apply', func, args })
export const Block = (items: Expr[], result: Expr): M.BlockValue => ({ tag: 'BlockValue', items, result })
export const ValDef = (id: number, rhs: Expr): M.ValDef => ({ tag: 'ValDef', id, rhs })
/** A ValUse. Only the id is written; the parse gives the node the type its ValDef stored. */
export const ValUse = (id: number, tpe: SType): M.ValUse => ({ tag: 'ValUse', valId: id, tpe })
export const SigmaAnd = (...items: Expr[]): M.SigmaAnd => ({ tag: 'SigmaAnd', items })
/** `sigmaProp(if (false) e else true)`: `e` sits in a branch that is never evaluated. */
export const dead = (e: Expr): M.BoolToSigmaProp => sp(If(bool(false), e, bool(true)))

// ── Collections, tuples, options ───────────────────────────────────────────
export const SizeOf = (input: Expr): M.SizeOf => ({ tag: 'SizeOf', input })
export const ByIndex = (input: Expr, index: Expr, def: Expr | null = null): M.ByIndex => ({ tag: 'ByIndex', input, index, default: def })
/** ByIndex over a tuple: the JVM's SAny (STuple's elemType, core/.../sigma/ast/SType.scala:838-841). */
export const BI: M.ByIndex = ByIndex(Tuple(int(0), int(0)), int(0))
/** `(x: Int) => true`. */
export const lambdaTrue: M.FuncValue = { tag: 'FuncValue', args: [{ id: 1, tpe: T.Int }], body: bool(true) }
export const Filter = (input: Expr): M.Filter => ({ tag: 'Filter', input, condition: lambdaTrue })
export const Slice = (input: Expr, from: Expr, until: Expr): M.Slice => ({ tag: 'Slice', input, from, until })
export const Append = (input: Expr, col2: Expr): M.Append => ({ tag: 'Append', input, col2 })
export const SelectField = (input: Expr, fieldIndex: number): M.SelectField => ({ tag: 'SelectField', input, fieldIndex })
export const GetVar = (id: number, t: SType): M.GetVar => ({ tag: 'GetVar', varId: id, varTpe: t })
export const OptionGet = (input: Expr): M.OptionGet => ({ tag: 'OptionGet', input })
export const OptionIsDefined = (input: Expr): M.OptionIsDefined => ({ tag: 'OptionIsDefined', input })
export const SigmaPropBytes = (input: Expr): M.SigmaPropBytes => ({ tag: 'SigmaPropBytes', input })
export const SigmaPropIsProven = (input: Expr): M.SigmaPropIsProven => ({ tag: 'SigmaPropIsProven', input })
export const TreeLookup = (tree: Expr, key: Expr, proof: Expr): M.TreeLookup => ({ tag: 'TreeLookup', tree, key, proof })
/** OptionGet(GetVar(1, SAny)): the JVM's SAny, type code 97. */
export const GV: M.OptionGet = OptionGet(GetVar(1, T.Any))

// ── Deserialize, context, calls ────────────────────────────────────────────
export const DR = (reg: number, tpe: SType, def: Expr | null = null): M.DeserializeRegister => ({ tag: 'DeserializeRegister', reg, tpe, default: def })
export const DC = (id: number, tpe: SType): M.DeserializeContext => ({ tag: 'DeserializeContext', id, tpe })
export const Ctx: M.Context = { tag: 'Context' }
export const MC = (typeId: number, methodId: number, obj: Expr, args: Expr[]): M.MethodCall => ({ tag: 'MethodCall', typeId, methodId, obj, args, explicitTypeArgs: {} })
export const PC = (typeId: number, methodId: number, obj: Expr): M.PropertyCall => ({ tag: 'PropertyCall', typeId, methodId, obj, explicitTypeArgs: {} })

// ── Bytes ──────────────────────────────────────────────────────────────────
/** A tree's bytes. `rawHeader`: 0x00 v0 plain, 0x08 v0 sized, 0x09 v1 sized, 0x0b v3 sized. */
export function treeBytes(body: Expr, rawHeader: number): Uint8Array {
  const header: M.TreeHeader = {
    version: (rawHeader & 0x07) as M.TreeHeader['version'],
    hasSize: (rawHeader & 0x08) !== 0,
    constantSegregation: (rawHeader & 0x10) !== 0,
    rawHeader,
  }
  return serializeTree({ header, constantTypes: [], constants: [], body })
}

/** An expression's bytes (a register or context-variable script): the plain v0 tree minus its header byte. */
export function exprBytes(e: Expr): Uint8Array {
  return treeBytes(e, 0x00).slice(1)
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
