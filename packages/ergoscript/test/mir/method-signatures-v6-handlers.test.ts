/**
 * method-signatures.ts — v6 handlers missing from the static catalog
 * (audit finding V6-SIGNATURE-01).
 *
 * SAvlTree.insertOrUpdate (100:16) and SHeader.checkPow (104:16) have runtime
 * handlers + `minVersion: 3` gates but no static `method-signatures.ts` entry,
 * so `exprTpe` fell back to `SAny` instead of the JVM descriptor return type.
 * SAny moves neither value, cost, nor ok/error (no consensus-observable
 * divergence — not SANTA-vectorizable), but it loses static type precision for
 * ValDef recovery and higher-order collection/option paths.
 *
 * Dual-table sync (facts/ergoscript-eval.md): the static `tRange` must equal
 * what the runtime handler returns —
 *   - insertOrUpdate → Option[AvlTree] (savltree.ts some/noneAvlTree, elem SAvlTree)
 *   - checkPow       → Boolean         (sheader.ts evalSHeaderCheckPow)
 *
 * JVM descriptors (methods.scala):
 *   - SAvlTree.insertOrUpdate: (AvlTree, Coll[(Coll[Byte], Coll[Byte])], Coll[Byte]) → Option[AvlTree]
 *   - SHeader.checkPow:        (Header) → Boolean
 */
import { describe, it, expect } from 'vitest'
import { exprTpe } from '../../src/mir/expr-tpe'
import { evaluate } from '../../src/eval/evaluate'
import { captureEvalError } from '../_helpers'
import type { Expr, SType, ErgoTree } from '../../src/mir/types'

const SAVL: SType = { tag: 'SAvlTree' }
const SCOLL_BYTE: SType = { tag: 'SColl', elem: { tag: 'SByte' } }
const ENTRIES: SType = {
  tag: 'SColl',
  elem: { tag: 'STuple', items: [SCOLL_BYTE, SCOLL_BYTE] },
}

// exprTpe inspects only `.tpe`, never the value — stub values cast through any.
const avlConst: Expr = { tag: 'Const', tpe: SAVL, value: { kind: 'AvlTree', value: {} } as any }
const headerConst: Expr = { tag: 'Const', tpe: { tag: 'SHeader' }, value: { kind: 'Header', value: {} } as any }
const entriesConst: Expr = { tag: 'Const', tpe: ENTRIES, value: { kind: 'Coll', elem: ENTRIES.elem, items: [] } as any }
const proofConst: Expr = { tag: 'Const', tpe: SCOLL_BYTE, value: { kind: 'Coll', elem: { tag: 'SByte' }, items: [] } as any }

const insertOrUpdate: Expr = {
  tag: 'MethodCall',
  typeId: 100,
  methodId: 16,
  obj: avlConst,
  args: [entriesConst, proofConst],
  explicitTypeArgs: {},
}

describe('method-signatures: v6 handlers (audit V6-SIGNATURE-01)', () => {
  it('AvlTree.insertOrUpdate (100:16) exprTpe returns Option[AvlTree], not SAny', () => {
    expect(exprTpe(insertOrUpdate)).toEqual({ tag: 'SOption', elem: { tag: 'SAvlTree' } })
  })

  it('Header.checkPow (104:16) as MethodCall returns SBoolean, not SAny', () => {
    expect(
      exprTpe({
        tag: 'MethodCall',
        typeId: 104,
        methodId: 16,
        obj: headerConst,
        args: [],
        explicitTypeArgs: {},
      }),
    ).toEqual({ tag: 'SBoolean' })
  })

  it('Header.checkPow (104:16) as PropertyCall (the wire form) returns SBoolean', () => {
    // checkPow serializes as a PropertyCall (0xdb) on the wire; exprTpe's
    // PropertyCall arm must resolve the same (typeId, methodId) signature.
    expect(
      exprTpe({
        tag: 'PropertyCall',
        typeId: 104,
        methodId: 16,
        obj: headerConst,
        explicitTypeArgs: {},
      }),
    ).toEqual({ tag: 'SBoolean' })
  })

  it('higher-order: Map mapper body insertOrUpdate infers Coll[Option[AvlTree]], not Coll[SAny]', () => {
    // The downstream cost of the SAny fallback: a map whose mapper returns
    // insertOrUpdate would type as Coll[SAny] instead of Coll[Option[AvlTree]].
    const mapExpr: Expr = {
      tag: 'Map',
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: SAVL },
        value: { kind: 'Coll', elem: SAVL, items: [] } as any,
      },
      mapper: {
        tag: 'FuncValue',
        args: [{ id: 1, tpe: SAVL }],
        body: {
          tag: 'MethodCall',
          typeId: 100,
          methodId: 16,
          obj: { tag: 'ValUse', valId: 1, tpe: SAVL },
          args: [entriesConst, proofConst],
          explicitTypeArgs: {},
        },
      },
    }
    expect(exprTpe(mapExpr)).toEqual({
      tag: 'SColl',
      elem: { tag: 'SOption', elem: { tag: 'SAvlTree' } },
    })
  })

  it('faithfulness side-effect: Eq(checkPow, Int) at V3 rejects (was masked by SAny)', () => {
    // Before the 104:16 signature, exprTpe(checkPow) = SAny, so validateBinOpTypes
    // SKIPPED the SameType check (reference_sany_type_checks_skip_not_fail) and the
    // mismatched Eq over-accepted. With the signature, exprTpe = SBoolean, so
    // Eq(SBoolean, SInt) is rejected pre-eval ('bin-op-kind-mismatch'), matching
    // the JVM (CheckingSigmaBuilder.equalityOp -> check2(SameType),
    // SigmaBuilder.scala). A faithfulness GAIN (closes an over-acceptance), not a
    // neutral change — the adding-signatures fix is consensus-improving here.
    const tree: ErgoTree = {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 3 },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'BinOp',
        op: { kind: 'Relation', op: 'Eq' },
        left: { tag: 'MethodCall', typeId: 104, methodId: 16, obj: headerConst, args: [], explicitTypeArgs: {} },
        right: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
      },
    }
    const err = captureEvalError(() => evaluate(tree))
    expect(err.code).toBe('bin-op-kind-mismatch')
  })
})
