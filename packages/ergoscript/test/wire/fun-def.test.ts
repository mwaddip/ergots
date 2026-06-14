import { describe, it, expect } from 'vitest'
import { parseExpr } from '../../src/wire/parse'
import { serializeExpr } from '../../src/wire/serialize'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import type { Expr } from '../../src/mir/types'

// v6 P6: FunDef (opcode 0xd7) is a polymorphic `let f[T] = rhs` — a ValDef
// carrying a non-empty `tpeArgs` list. The JVM (ValDefSerializer.scala) emits
// 0xd7 exactly when tpeArgs is non-empty, else 0xd6 (plain ValDef). ergots
// mirrors this on the existing ValDef MIR node via an optional `tpeArgs`.

// { let f[T] = { (x: Int) => x }; 5 }   (f unused; result = 5)
const funDefBlock: Expr = {
  tag: 'BlockValue',
  items: [
    {
      tag: 'ValDef',
      id: 1,
      tpeArgs: [{ name: 'T' }],
      rhs: {
        tag: 'FuncValue',
        args: [{ id: 2, tpe: { tag: 'SInt' } }], // FuncArg { id, tpe }
        body: { tag: 'ValUse', valId: 2, tpe: { tag: 'SInt' } },
      },
    },
  ],
  result: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 5 } },
}

describe('FunDef wire round-trip', () => {
  it('serializes with OP_FUN_DEF (0xd7) and round-trips byte-exact', () => {
    const w = new ByteWriter()
    serializeExpr(funDefBlock, w, 0)
    const bytes = w.toBytes()
    expect([...bytes]).toContain(0xd7) // FunDef opcode present
    const parsed = parseExpr(new ByteReader(bytes), [], [], new Map(), 0)
    expect(parsed).toEqual(funDefBlock) // full structural round-trip (incl. tpeArgs)
  })

  it('a plain ValDef (no tpeArgs) still serializes with OP_VAL_DEF (0xd6)', () => {
    const plain: Expr = {
      tag: 'BlockValue',
      items: [{ tag: 'ValDef', id: 1, rhs: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 9 } } }],
      result: { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } },
    }
    const w = new ByteWriter()
    serializeExpr(plain, w, 0)
    const bytes = w.toBytes()
    expect([...bytes]).toContain(0xd6)
    expect([...bytes]).not.toContain(0xd7)
    expect(parseExpr(new ByteReader(bytes), [], [], new Map(), 0)).toEqual(plain)
  })
})
