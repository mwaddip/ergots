/**
 * `MethodCall` + `PropertyCall` dispatcher — routes to per-method handlers
 * via a (typeId, methodId) registry.
 *
 * Pattern A: cost 4 charged BEFORE eval-children. Source: method_call.rs:17,
 * property_call.rs:16.
 *
 * The registry is module-internal. Handlers are registered inline below the
 * dispatcher definition (in this same file) — keeping co-location simple
 * while the registry size is moderate (8 entries as of Task 7; 15 after
 * phase 2h-b Tier 1; 21 after phase 2h-b Tier 2). Tier-1 AND Tier-2 SAvlTree
 * handlers (typeId=100, methodIds 1..7 and 9..14) live in `./savltree.ts`
 * — the wrappers here only forward to those exports.
 *
 * Error codes originated here:
 *   'method-not-implemented'    — dispatcher hit a (typeId, methodId) not in the registry;
 *                                  also reused for defensive shape mismatches in 5+ registered handlers
 *                                  (per the design spec's option-1 error taxonomy).
 *   'context-obj-not-context'   — thrown by SContext.dataInputs handler when obj is not Context;
 *                                  also reused by SContext.preHeader (Task 6) for the same shape.
 *   'avl-tree-obj-not-avl-tree' — thrown by the 7 SAvlTree Tier-1 accessor handlers AND the 6
 *                                  Tier-2 verification op handlers when obj is not AvlTree
 *                                  (defensive; unreachable for parser-produced trees).
 *                                  Code originated in `./savltree.ts` (phase 2h-b Tier 1).
 *   'avl-tree-proof-failed'     — thrown by `get` / `getMany` / `insert` (V<3 per-op + construct) /
 *                                  `update` (construct only) / `remove` (any) / `contains` (construct
 *                                  only). See per-handler doc-comments in savltree.ts for the
 *                                  per-handler failure model. Code originated in `./savltree.ts`
 *                                  (phase 2h-b Tier 2 / Phase F).
 *   'header-obj-not-header'     — thrown by the 15 SHeader property accessor handlers (typeId 104,
 *                                  methodIds 1-15) when obj is not a Header SValue.
 *                                  Code originated in `./sheader.ts` (phase 2h-c.1).
 *
 * Codes callers may also observe (owned by other modules):
 *   'cost-limit-exceeded'       — thrown by ctx.addCost() in eval-context.ts when jitCostLimit is reached.
 *   'context-field-missing'     — thrown by the SContext.preHeader handler when ctx.preHeader === undefined;
 *                                  code originated in global-vars.ts / get-var.ts.
 */

import type { ErgoBox, MethodCall, PropertyCall, SType, SValue } from '../mir/types'
import type { Header } from '@ergots/scorex'
import { GROUP_GENERATOR_BYTES } from './_group-generator'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { SCOLL_BYTE } from './_box-synthesis'
import { primitiveValueEqual } from './bin-op/relation'
import {
  evalSAvlTreeContains,
  evalSAvlTreeDigest,
  evalSAvlTreeEnabledOperations,
  evalSAvlTreeGet,
  evalSAvlTreeGetMany,
  evalSAvlTreeInsert,
  evalSAvlTreeIsInsertAllowed,
  evalSAvlTreeIsRemoveAllowed,
  evalSAvlTreeIsUpdateAllowed,
  evalSAvlTreeKeyLength,
  evalSAvlTreeRemove,
  evalSAvlTreeUpdate,
  evalSAvlTreeValueLengthOpt,
} from './savltree'
import {
  evalSHeaderId,
  evalSHeaderVersion,
  evalSHeaderParentId,
  evalSHeaderAdProofsRoot,
  evalSHeaderStateRoot,
  evalSHeaderTransactionsRoot,
  evalSHeaderTimestamp,
  evalSHeaderNBits,
  evalSHeaderHeight,
  evalSHeaderExtensionRoot,
  evalSHeaderMinerPk,
  evalSHeaderPowOnetimePk,
  evalSHeaderPowNonce,
  evalSHeaderPowDistance,
  evalSHeaderVotes,
  evalSHeaderCheckPow,  // NEW phase 2h-c.2
} from './sheader'

// Module-level SType singletons used in handler helpers.
// Coll[STuple[SColl[Byte], Long]] — return type for tokensCollOf.
// SBox — element type for dataInputsCollOf.
// SInt — element type for indicesCollOf.
// SHeader — element type for headersCollOf.
const SLONG: SType = { tag: 'SLong' }
const STUPLE_COLLBYTE_LONG: SType = { tag: 'STuple', items: [SCOLL_BYTE, SLONG] }
const SBOX: SType = { tag: 'SBox' }
const SINT: SType = { tag: 'SInt' }
const SHEADER: SType = { tag: 'SHeader' }

type HandlerFn = (
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>
) => SValue

interface HandlerEntry {
  handler: HandlerFn
  minVersion?: number // optional ErgoTreeVersion gate; undefined = always callable
}

function handlerKey(typeId: number, methodId: number): string {
  return `${typeId}:${methodId}`
}

const HANDLERS = new Map<string, HandlerEntry>()

export function evalMethodCall(e: MethodCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4) // Pattern A; source: method_call.rs:17
  const obj = evalExpr(e.obj, env, ctx)
  const args = e.args.map((a) => evalExpr(a, env, ctx))
  return dispatch(e.typeId, e.methodId, obj, args, ctx, e.explicitTypeArgs)
}

export function evalPropertyCall(e: PropertyCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4) // Pattern A; source: property_call.rs:16
  const obj = evalExpr(e.obj, env, ctx)
  return dispatch(e.typeId, e.methodId, obj, [], ctx, {})
}

function dispatch(
  typeId: number,
  methodId: number,
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>
): SValue {
  const entry = HANDLERS.get(handlerKey(typeId, methodId))
  if (entry === undefined) {
    throw new EvalError(
      `method not implemented: typeId=${typeId}, methodId=${methodId}`,
      'method-not-implemented'
    )
  }
  if (entry.minVersion !== undefined && (ctx.treeVersion ?? 0) < entry.minVersion) {
    throw new EvalError(
      `method ${typeId}:${methodId} requires tree version >= ${entry.minVersion}, got ${ctx.treeVersion ?? 0}`,
      'tree-version-too-low'
    )
  }
  return entry.handler(obj, args, ctx, explicitTypeArgs)
}

// ---------- Handler registration ----------

function registerHandlers(): void {
  // SBox.tokens (PropertyCall, typeId=99, methodId=8)
  // Source: ergotree-interpreter/src/eval/sbox.rs:72-79 — TOKENS_EVAL_FN
  // Cost 15 (Pattern A within handler). Returns Coll[(Coll[Byte], Long)].
  HANDLERS.set(handlerKey(99, 8), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(15)
    if (obj.kind !== 'Box') {
      throw new EvalError(
        `SBox.tokens expects a Box obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1 (spec: error-taxonomy decision)
      )
    }
    return tokensCollOf(obj.value)
  } })

  // SContext.dataInputs (PropertyCall, typeId=101, methodId=1)
  // Source: ergotree-interpreter/src/eval/scontext.rs:17-31 — DATA_INPUTS_EVAL_FN
  // Cost 15 (Pattern A within handler). Returns Coll[Box] from ctx.dataInputs ?? [].
  HANDLERS.set(handlerKey(101, 1), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(15)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.dataInputs expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context'
      )
    }
    return dataInputsCollOf(ctx.dataInputs ?? [])
  } })

  // SContext.preHeader (PropertyCall, typeId=101, methodId=3)
  // Source: ergotree-interpreter/src/eval/scontext.rs:72-81 — PRE_HEADER_EVAL_FN
  // Pattern A cost 15 (charged before obj check). Returns { kind: 'PreHeader', value: ctx.preHeader }.
  HANDLERS.set(handlerKey(101, 3), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(15)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.preHeader expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context' // reuses existing code (also used by SContext.dataInputs)
      )
    }
    if (ctx.preHeader === undefined) {
      throw new EvalError(
        `SContext.preHeader: ctx.preHeader is undefined`,
        'context-field-missing'
      )
    }
    return { kind: 'PreHeader', value: ctx.preHeader }
  } })

  // SPreHeader.timestamp (PropertyCall, typeId=105, methodId=3)
  // Source: ergotree-interpreter/src/eval/spreheader.rs:20-24 — TIMESTAMP_EVAL_FN
  // Pattern A cost 10 (charged before obj check). Returns Long.
  HANDLERS.set(handlerKey(105, 3), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(10)
    if (obj.kind !== 'PreHeader') {
      throw new EvalError(
        `SPreHeader.timestamp expects a PreHeader obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return { kind: 'Long', value: obj.value.timestamp }
  } })

  // SColl.indexOf (MethodCall, typeId=12, methodId=26)
  // Source: ergotree-interpreter/src/eval/scoll.rs:21-50 — INDEX_OF_EVAL_FN
  // Pattern B cost: addPerItemCost(20, 10, 2, n) AFTER extracting Coll, BEFORE search.
  // 'from < 0' clamped to 0. Returns Int index or -1.
  HANDLERS.set(handlerKey(12, 26), { handler: (obj, args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.indexOf expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy (option 1)
      )
    }
    const n = obj.items.length
    ctx.addPerItemCost(20, 10, 2, n) // Pattern B; source: scoll.rs:31
    if (args.length !== 2) {
      throw new EvalError(
        `SColl.indexOf expects 2 args; got ${args.length}`,
        'method-not-implemented'
      )
    }
    const [target, fromArg] = args as [SValue, SValue]
    if (fromArg.kind !== 'Int') {
      throw new EvalError(
        `SColl.indexOf expects 'from' to be Int; got '${fromArg.kind}'`,
        'method-not-implemented'
      )
    }
    const from = Math.max(0, fromArg.value)
    for (let i = from; i < n; i++) {
      if (primitiveValueEqual(obj.items[i]!, target)) return { kind: 'Int', value: i }
    }
    return { kind: 'Int', value: -1 }
  } })

  // SGlobal.groupGenerator (PropertyCall, typeId=106, methodId=1)
  // Source: ergotree-interpreter/src/eval/sglobal.rs:32-41 — GROUP_GENERATOR_EVAL_FN
  // Pattern A cost 10 (charged before obj check). Returns 33-byte SEC1 of secp256k1 base point.
  HANDLERS.set(handlerKey(106, 1), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(10)
    if (obj.kind !== 'Global') {
      throw new EvalError(
        `SGlobal.groupGenerator expects a Global obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return { kind: 'GroupElement', value: GROUP_GENERATOR_BYTES }
  } })

  // SColl.indices (MethodCall, typeId=12, methodId=14)
  // Source: ergotree-interpreter/src/eval/scoll.rs:171-193 — INDICES_EVAL_FN
  // Pattern B cost: addPerItemCost(20, 2, 16, n) AFTER Coll extraction.
  // Returns Coll[Int] = 0..n-1. Overflow guard at n > 2^31-1 (mirrors sigma-rust
  // i32::try_from(i)? throw).
  HANDLERS.set(handlerKey(12, 14), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.indices expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    const n = obj.items.length
    if (n > 0x7fffffff) {
      throw new EvalError(
        `SColl.indices: length ${n} exceeds i32 range`,
        'method-not-implemented' // symmetry with sigma-rust's TryFromIntError throw
      )
    }
    ctx.addPerItemCost(20, 2, 16, n) // Pattern B; source: scoll.rs:179
    return indicesCollOf(n)
  } })

  // SColl.zip (MethodCall, typeId=12, methodId=29)
  // Source: ergotree-interpreter/src/eval/scoll.rs:138-169 — ZIP_EVAL_FN
  // Pattern B cost: addPerItemCost(10, 1, 10, n) where n = obj len (NOT min).
  // Truncates to the shorter Coll (Rust Iterator::zip semantics).
  HANDLERS.set(handlerKey(12, 29), { handler: (obj, args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.zip expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented'
      )
    }
    const n = obj.items.length
    ctx.addPerItemCost(10, 1, 10, n) // Pattern B; source: scoll.rs:147
    if (args.length !== 1) {
      throw new EvalError(
        `SColl.zip expects 1 arg; got ${args.length}`,
        'method-not-implemented'
      )
    }
    const arg = args[0]!
    if (arg.kind !== 'Coll') {
      throw new EvalError(
        `SColl.zip expects arg to be a Coll; got '${arg.kind}'`,
        'method-not-implemented'
      )
    }
    return zipCollsOf(obj, arg)
  } })

  // ---------- SAvlTree Tier-1 (pure accessors) — phase 2h-b ----------
  // All 7 are Pattern A cost 15. Source: ergotree-interpreter/src/eval/savltree.rs:29-75.
  // Handler bodies live in ./savltree.ts; they expect `(obj, args, ctx)` —
  // explicitTypeArgs is unused. Wrapping closures drop it so the function
  // signature stays compatible with `MethodHandler`.
  HANDLERS.set(handlerKey(100, 1), { handler: (obj, args, ctx) => evalSAvlTreeDigest(obj, args, ctx) })
  HANDLERS.set(handlerKey(100, 2), { handler: (obj, args, ctx) => evalSAvlTreeEnabledOperations(obj, args, ctx) })
  HANDLERS.set(handlerKey(100, 3), { handler: (obj, args, ctx) => evalSAvlTreeKeyLength(obj, args, ctx) })
  HANDLERS.set(handlerKey(100, 4), { handler: (obj, args, ctx) => evalSAvlTreeValueLengthOpt(obj, args, ctx) })
  HANDLERS.set(handlerKey(100, 5), { handler: (obj, args, ctx) => evalSAvlTreeIsInsertAllowed(obj, args, ctx) })
  HANDLERS.set(handlerKey(100, 6), { handler: (obj, args, ctx) => evalSAvlTreeIsUpdateAllowed(obj, args, ctx) })
  HANDLERS.set(handlerKey(100, 7), { handler: (obj, args, ctx) => evalSAvlTreeIsRemoveAllowed(obj, args, ctx) })

  // ---------- SAvlTree Tier-2 (verification ops) — phase 2h-b Phase F ----------
  // No per-handler cost (Tier-2 sigma-rust EvalFns do not add_jit_cost; the
  // dispatcher's Pattern-A cost 4 + inline Const arms cover the cost surface).
  // Source: ergotree-interpreter/src/eval/savltree.rs:104-150 (get),
  //                                              152-212 (getMany),
  //                                              214-277 (insert),
  //                                              279-337 (remove),
  //                                              339-381 (contains),
  //                                              383-439 (update).
  // Handler bodies live in ./savltree.ts; they expect `(ctx, obj, args)` —
  // the wrapper here flips argument order to match `MethodHandler` shape
  // and drops explicitTypeArgs (Tier-2 has none).
  HANDLERS.set(handlerKey(100, 9), { handler: (obj, args, ctx) => evalSAvlTreeContains(ctx, obj, args) })
  HANDLERS.set(handlerKey(100, 10), { handler: (obj, args, ctx) => evalSAvlTreeGet(ctx, obj, args) })
  HANDLERS.set(handlerKey(100, 11), { handler: (obj, args, ctx) => evalSAvlTreeGetMany(ctx, obj, args) })
  HANDLERS.set(handlerKey(100, 12), { handler: (obj, args, ctx) => evalSAvlTreeInsert(ctx, obj, args) })
  HANDLERS.set(handlerKey(100, 13), { handler: (obj, args, ctx) => evalSAvlTreeUpdate(ctx, obj, args) })
  HANDLERS.set(handlerKey(100, 14), { handler: (obj, args, ctx) => evalSAvlTreeRemove(ctx, obj, args) })

  // ---------- SContext.headers (typeId=101, methodId=2) — phase 2h-c.1 ----------
  // Pattern A cost 15 (charged before obj check). Returns Coll[Header] from ctx.headers ?? [].
  // Source: ergotree-interpreter/src/eval/scontext.rs:57-68 — HEADERS_EVAL_FN.
  HANDLERS.set(handlerKey(101, 2), { handler: (obj, _args, ctx) => {
    ctx.addCost(15)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.headers expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context'
      )
    }
    return headersCollOf(ctx.headers ?? [])
  } })

  // SContext.lastBlockUtxoRootHash (PropertyCall, typeId=101, methodId=9)
  // Source: ergotree-interpreter/src/eval/scontext.rs:83-99 — LAST_BLOCK_UTXO_ROOT_HASH_EVAL_FN
  // Pattern A cost 15 (charged before obj check). Synthesizes AvlTreeData from
  // ctx.headers[0].stateRoot. treeFlags=0b00000111 means insert/update/remove
  // all allowed (sigma-rust AvlTreeFlags::new(true, true, true)). keyLength=32,
  // valueLengthOpt=null.
  HANDLERS.set(handlerKey(101, 9), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(15)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.lastBlockUtxoRootHash expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context'
      )
    }
    if (ctx.headers === undefined || ctx.headers.length === 0) {
      throw new EvalError(
        `SContext.lastBlockUtxoRootHash: ctx.headers is ${ctx.headers === undefined ? 'undefined' : 'empty'}`,
        'context-field-missing'
      )
    }
    return {
      kind: 'AvlTree',
      value: {
        digest: ctx.headers[0]!.stateRoot,
        treeFlags: 0b00000111,
        keyLength: 32, // blake2b-256 digest length; hard-coded in sigma-rust AvlTreeData
        valueLengthOpt: null,
      },
    }
  } })

  // ---------- SHeader (15 property accessors) — phase 2h-c.1 ----------
  // All Pattern A Fixed(10). Source: ergotree-interpreter/src/eval/sheader.rs:16-113.
  // Handler bodies live in ./sheader.ts.
  HANDLERS.set(handlerKey(104, 1), { handler: (obj, args, ctx) => evalSHeaderId(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 2), { handler: (obj, args, ctx) => evalSHeaderVersion(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 3), { handler: (obj, args, ctx) => evalSHeaderParentId(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 4), { handler: (obj, args, ctx) => evalSHeaderAdProofsRoot(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 5), { handler: (obj, args, ctx) => evalSHeaderStateRoot(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 6), { handler: (obj, args, ctx) => evalSHeaderTransactionsRoot(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 7), { handler: (obj, args, ctx) => evalSHeaderTimestamp(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 8), { handler: (obj, args, ctx) => evalSHeaderNBits(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 9), { handler: (obj, args, ctx) => evalSHeaderHeight(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 10), { handler: (obj, args, ctx) => evalSHeaderExtensionRoot(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 11), { handler: (obj, args, ctx) => evalSHeaderMinerPk(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 12), { handler: (obj, args, ctx) => evalSHeaderPowOnetimePk(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 13), { handler: (obj, args, ctx) => evalSHeaderPowNonce(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 14), { handler: (obj, args, ctx) => evalSHeaderPowDistance(obj, args, ctx) })
  HANDLERS.set(handlerKey(104, 15), { handler: (obj, args, ctx) => evalSHeaderVotes(obj, args, ctx) })

  // SHeader.checkPow (MethodCall, typeId=104, methodId=16) — phase 2h-c.2
  // Pattern A Fixed(700). V3-gated (sigma-rust MethodDesc.min_version: ErgoTreeVersion::V3).
  // Source: ergotree-interpreter/src/eval/sheader.rs:115-124.
  HANDLERS.set(handlerKey(104, 16), {
    handler: (obj, args, ctx) => evalSHeaderCheckPow(obj, args, ctx),
    minVersion: 3,  // V3 gate — sigma-rust MethodDesc.min_version: ErgoTreeVersion::V3
  })
}

registerHandlers()

// ---------- SBox.tokens helper ----------

/** Convert ErgoBox.tokens to a Coll[(Coll[Byte], Long)] SValue. */
function tokensCollOf(box: ErgoBox): SValue {
  return {
    kind: 'Coll',
    elem: STUPLE_COLLBYTE_LONG,
    items: box.tokens.map((t) => ({
      kind: 'Tuple',
      items: [bytesToCollByteSValue(t.id), { kind: 'Long', value: t.amount }],
    })),
  }
}

// ---------- SContext.dataInputs helper ----------

/** Convert an ErgoBox[] to a Coll[Box] SValue. */
function dataInputsCollOf(boxes: ErgoBox[]): SValue {
  return {
    kind: 'Coll',
    elem: SBOX,
    items: boxes.map((b) => ({ kind: 'Box', value: b })),
  }
}

// ---------- SColl.indices helper ----------

/** Build a Coll[Int] = [0, 1, ..., n-1]. */
function indicesCollOf(n: number): SValue {
  const items: SValue[] = []
  for (let i = 0; i < n; i++) items.push({ kind: 'Int', value: i })
  return { kind: 'Coll', elem: SINT, items }
}

// ---------- SContext.headers helper ----------

/** Convert a Header[] to a Coll[Header] SValue. */
function headersCollOf(headers: Header[]): SValue {
  return {
    kind: 'Coll',
    elem: SHEADER,
    items: headers.map((h) => ({ kind: 'Header', value: h })),
  }
}

// ---------- SColl.zip helper ----------

/** Zip two Colls into Coll[STuple[T1, T2]], truncating to the shorter input. */
function zipCollsOf(
  coll1: SValue & { kind: 'Coll' },
  coll2: SValue & { kind: 'Coll' }
): SValue {
  const len = Math.min(coll1.items.length, coll2.items.length)
  const items: SValue[] = []
  for (let i = 0; i < len; i++) {
    items.push({ kind: 'Tuple', items: [coll1.items[i]!, coll2.items[i]!] })
  }
  return {
    kind: 'Coll',
    elem: { tag: 'STuple', items: [coll1.elem, coll2.elem] },
    items,
  }
}
