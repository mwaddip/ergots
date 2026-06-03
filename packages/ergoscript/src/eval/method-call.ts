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
import { sValueEquals } from './bin-op/relation'
import { decodePoint, pointNegate, encodePoint } from '../crypto/secp256k1'
import {
  evalSAvlTreeContains,
  evalSAvlTreeDigest,
  evalSAvlTreeEnabledOperations,
  evalSAvlTreeGet,
  evalSAvlTreeGetMany,
  evalSAvlTreeInsert,
  evalSAvlTreeInsertOrUpdate,
  evalSAvlTreeIsInsertAllowed,
  evalSAvlTreeIsRemoveAllowed,
  evalSAvlTreeIsUpdateAllowed,
  evalSAvlTreeKeyLength,
  evalSAvlTreeRemove,
  evalSAvlTreeUpdate,
  evalSAvlTreeUpdateDigest,
  evalSAvlTreeUpdateOperations,
  evalSAvlTreeValueLengthOpt,
} from './savltree'
import { evalSCollFlatMap } from './scoll-flat-map'
import { numericV6Handlers } from './_numeric-v6'
import { evalSOptionMap } from './soption-map'
import { umod } from './_ubi-modular'
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

export type HandlerFn = (
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>,
  // Phase 2h-f: optional 5th arg for handlers that need the originating
  // MethodCall MIR node (for static type access not on the runtime Closure
  // SValue, e.g. SColl.flatMap's elem-type check) + the caller's Env
  // (for env-extend during per-item body eval). 41 of 43 existing handlers
  // (post-2h-f) ignore this arg via TS structural typing.
  extra?: { mc: MethodCall; env: Env }
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
  return dispatch(e.typeId, e.methodId, obj, args, ctx, e.explicitTypeArgs, { mc: e, env })
}

export function evalPropertyCall(e: PropertyCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4) // Pattern A; source: property_call.rs:16
  const obj = evalExpr(e.obj, env, ctx)
  return dispatch(e.typeId, e.methodId, obj, [], ctx, {}, undefined)
}

function dispatch(
  typeId: number,
  methodId: number,
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>,
  extra: { mc: MethodCall; env: Env } | undefined
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
  return entry.handler(obj, args, ctx, explicitTypeArgs, extra)
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

  // SContext.minerPubKey (PropertyCall, typeId=101, methodId=10)
  // Source: ergotree-interpreter/src/eval/scontext.rs:101-115 — MINER_PUBKEY_EVAL_FN
  // Descriptor: ergotree-ir/src/types/scontext.rs:151-164 — returns SColl(SByte).
  // Pattern A cost 20 (charged before obj check). Returns the 33-byte
  // SEC1-compressed secp256k1 miner pubkey as Coll[Byte] — our PreHeader.minerPk
  // is already stored in that form (mir/types.ts:184), byte-equivalent to
  // sigma-rust's `EcPoint::sigma_serialize_bytes()`.
  HANDLERS.set(handlerKey(101, 10), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(20)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.minerPubKey expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context'
      )
    }
    if (ctx.preHeader === undefined) {
      throw new EvalError(
        `SContext.minerPubKey: ctx.preHeader is undefined`,
        'context-field-missing'
      )
    }
    return bytesToCollByteSValue(ctx.preHeader.minerPk)
  } })

  // SContext.selfBoxIndex (PropertyCall, typeId=101, methodId=8)
  // Source: ergotree-interpreter/src/eval/scontext.rs:33-57 — SELF_BOX_INDEX_EVAL_FN
  // Descriptor: ergotree-ir/src/types/scontext.rs:124 — returns SInt.
  // Pattern A cost 20 (charged before obj check). Returns 0-based index of
  // ctx.selfBox in ctx.inputs, OR -1 for blocks with activated_script_version < V2.
  //
  // Activated-script-version gate (JVM bug #603 compat): the JVM's pre-v5
  // selfBoxIndex used reference-equality `eq` instead of value-equality `==`
  // in CostingDataContext.scala, always returning -1. The bug was fixed
  // globally in v5.x — ALL scripts in v5+ blocks get the correct index.
  // Gate is on BLOCK version, not tree version (see ergo-node-rust memory
  // feedback_tree_version_gate.md — session 22b broke block 942,664 by
  // gating on tree_version). sigma-rust derives activated_script_version
  // as `preHeader.version - 1` (saturating); see chain/context.rs:66-68.
  //
  // First exercised on mainnet at block 342,964 — the same block where
  // sigma-rust originally diverged from JVM (fixed in their v0.2.0).
  //
  // Box equality: validate-tx.ts sets `ctx.selfBox = inputBoxes[inputIndex]`
  // (same object reference as the corresponding entry in `ctx.inputs`), so
  // `inputs.indexOf(selfBox)` (reference equality) gives the right index.
  HANDLERS.set(handlerKey(101, 8), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(20)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.selfBoxIndex expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context'
      )
    }
    if (ctx.preHeader === undefined) {
      throw new EvalError(
        `SContext.selfBoxIndex: ctx.preHeader is undefined`,
        'context-field-missing'
      )
    }
    // activated_script_version = saturating_sub(preHeader.version, 1).
    const activatedVersion = Math.max(0, (ctx.preHeader.version | 0) - 1)
    if (activatedVersion < 2) {
      return { kind: 'Int', value: -1 }
    }
    if (ctx.selfBox === undefined || ctx.inputs === undefined) {
      throw new EvalError(
        `SContext.selfBoxIndex: ctx.${ctx.selfBox === undefined ? 'selfBox' : 'inputs'} is undefined`,
        'context-field-missing'
      )
    }
    const idx = ctx.inputs.indexOf(ctx.selfBox)
    if (idx === -1) {
      throw new EvalError(
        `SContext.selfBoxIndex: ctx.selfBox not found in ctx.inputs (` +
          `${ctx.inputs.length} inputs) — chain invariant violated`,
        'context-field-missing'
      )
    }
    return { kind: 'Int', value: idx }
  } })

  // SPreHeader.parentId (PropertyCall, typeId=105, methodId=2)
  // Source: ergotree-interpreter/src/eval/spreheader.rs:14-18 — PARENT_ID_EVAL_FN
  // Descriptor: ergotree-ir/src/types/spreheader.rs:20,53-58 — returns SColl(SByte).
  // Pattern A cost 10 (charged before obj check). Returns the 32-byte
  // parentId as Coll[Byte] — contrast with SPreHeader.minerPk (105:6) which
  // returns SGroupElement of a raw 33-byte pubkey.
  HANDLERS.set(handlerKey(105, 2), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(10)
    if (obj.kind !== 'PreHeader') {
      throw new EvalError(
        `SPreHeader.parentId expects a PreHeader obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return bytesToCollByteSValue(obj.value.parentId)
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

  // SPreHeader.height (PropertyCall, typeId=105, methodId=5)
  // Source: ergotree-interpreter/src/eval/spreheader.rs:32-36 — HEIGHT_EVAL_FN
  // Descriptor: ergotree-ir/src/types/spreheader.rs:26,73-77 — returns SType::SInt.
  // Pattern A cost 10 (charged before obj check). Returns height as Int (i32).
  // PreHeader.height in mir/types.ts:182 is already a JS number — fits i32.
  HANDLERS.set(handlerKey(105, 5), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(10)
    if (obj.kind !== 'PreHeader') {
      throw new EvalError(
        `SPreHeader.height expects a PreHeader obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return { kind: 'Int', value: obj.value.height }
  } })

  // SPreHeader.minerPk (PropertyCall, typeId=105, methodId=6)
  // Source: ergotree-interpreter/src/eval/spreheader.rs:38-42 — MINER_PK_EVAL_FN
  // Descriptor: ergotree-ir/src/types/spreheader.rs:79-84 — returns SGroupElement.
  // Pattern A cost 10 (charged before obj check). Returns the raw 33-byte
  // SEC1-compressed secp256k1 miner pubkey as SGroupElement — NOT serialized
  // to Coll[Byte] (cf. SContext.minerPubKey at 101:10, which calls
  // sigma_serialize_bytes). Our PreHeader.minerPk is already a 33-byte
  // Uint8Array (mir/types.ts:184), exactly the SValue.GroupElement encoding.
  HANDLERS.set(handlerKey(105, 6), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(10)
    if (obj.kind !== 'PreHeader') {
      throw new EvalError(
        `SPreHeader.minerPk expects a PreHeader obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return { kind: 'GroupElement', value: obj.value.minerPk }
  } })

  // SColl.indexOf (MethodCall, typeId=12, methodId=26)
  // Source: ergotree-interpreter/src/eval/scoll.rs:21-50 — INDEX_OF_EVAL_FN
  // Cost (JVM indexOf_eval): per-comparison element eq cost during the scan +
  // PerItemCost(20,10,2) over ITERATIONS performed, charged after. 'from < 0'
  // clamped to 0. Returns Int index or -1.
  HANDLERS.set(handlerKey(12, 26), { handler: (obj, args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.indexOf expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy (option 1)
      )
    }
    const n = obj.items.length
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
    // JVM `indexOf_eval` (methods.scala:1080-1097): scan from `start`, charging
    // the element eq cost per comparison via `equalDataValues`, THEN charge
    // PerItemCost(20,10,2) over the ITERATIONS performed (`i - start`) — not the
    // full input length. Our prior code charged full-length up-front and used the
    // uncharged `primitiveValueEqual`, diverging from JVM on BOTH; sigma-rust
    // shares it (scoll.rs:31 full-length + bare `==`). Routed in santa
    // prompts/ergots-v5-divergences.md §B3. JVM canonical. `sValueEquals` charges
    // the element-type eq cost (mirrors equalDataValues) and returns equality.
    const from = Math.max(0, fromArg.value)
    let foundIdx = -1
    let i = from
    while (i < n) {
      const eq = sValueEquals(obj.items[i]!, target, ctx)
      i++
      if (eq) {
        foundIdx = i - 1
        break
      }
    }
    ctx.addPerItemCost(20, 10, 2, i - from)
    return { kind: 'Int', value: foundIdx }
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

  // SGroupElement.getEncoded (MethodCall, typeId=7, methodId=2) — phase 2h-f
  // Source: ergotree-interpreter/src/eval/sgroup_elem.rs:15-26 — GET_ENCODED_EVAL_FN
  // Pattern A Fixed(250). Returns 33-byte SEC1-compressed point as Coll[Byte].
  // No args; no type-variable resolution needed (monomorphic on SGroupElement).
  HANDLERS.set(handlerKey(7, 2), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(250) // sigma-rust line 16
    if (obj.kind !== 'GroupElement') {
      throw new EvalError(
        `SGroupElement.getEncoded expects a GroupElement obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return bytesToCollByteSValue(obj.value)
  } })

  // SGroupElement.negate (MethodCall, typeId=7, methodId=5) — v5 method
  // Source: sigma-rust NEGATE_EVAL_FN (eval/sgroup_elem.rs, branch
  // ergo-node-integration — the clean reference; cross-checked vs the JVM).
  // Cost FixedCost(45): sigma/ast/methods.scala:670 (Negate_CostKind), charged
  // BEFORE the op (mirrors sigma-rust line 29). Value = additive inverse −P
  // (same x, flipped y-parity → flips the SEC1 prefix byte); decode → negate →
  // encode mirrors multiply-group.ts / exponentiate.ts. Identity (0x00-lead /
  // 33 zero bytes) → identity, via the Ergo identity convention baked into
  // crypto/secp256k1.ts decodePoint/encodePoint.
  HANDLERS.set(handlerKey(7, 5), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(45) // methods.scala:670 Negate_CostKind = FixedCost(JitCost(45))
    if (obj.kind !== 'GroupElement') {
      throw new EvalError(
        `SGroupElement.negate expects a GroupElement obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return { kind: 'GroupElement', value: encodePoint(pointNegate(decodePoint(obj.value))) }
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

  // SColl.flatMap (MethodCall, typeId=12, methodId=15) — phase 2h-f
  // Source: ergotree-interpreter/src/eval/scoll.rs:52-136 — flatmap_eval
  // Pattern B addPerItemCost(60, 10, 8, n). Lambda HOF with body-restriction
  // quirk + SAny-tolerant outElem (R3 divergences from sigma-rust). Handler
  // body lives in ./scoll-flat-map.ts; this wrapper extracts mc + env from
  // `extra` and forwards. V0+.
  HANDLERS.set(handlerKey(12, 15), {
    handler: (obj, args, ctx, explicitTypeArgs, extra) => {
      if (extra === undefined) {
        // Defensive — should never happen for MethodCall dispatch (only
        // PropertyCall passes extra=undefined, and SColl.flatMap is not a
        // PropertyCall). Surface as a programming-error throw rather than a
        // silent miscompute.
        throw new EvalError(
          `SColl.flatMap requires extra={mc, env}; got undefined (programming error)`,
          'method-not-implemented'
        )
      }
      return evalSCollFlatMap(obj, args, ctx, explicitTypeArgs, extra.mc, extra.env)
    },
  })

  // SColl.patch (MethodCall, typeId=12, methodId=19) — campaign iter-28
  // Source: ergotree-interpreter/src/eval/scoll.rs:195-236 — PATCH_EVAL_FN
  // Pattern A cost: addPerItemCost(30, 2, 10, n) on INPUT length n, charged
  // BEFORE pulling args (after the obj-is-Coll check), matching sigma-rust.
  // `from` and `replaced` are each INDEPENDENTLY clamped to >=0 via Math.max(0),
  // then: result = input.slice(0, from) ++ patch ++ input.slice(from + replaced).
  // JS slice saturates out-of-bounds exactly like Rust take/skip. Result elem
  // type = input's elem type. This is NOT generic Scala IndexedSeq.patch:
  // sigma-rust clamps `from` to 0 BEFORE the skip(from+replaced) (upstream fix
  // fc88669e), so e.g. [1,2,3].patch(-1,[4,5],1) → [4,5,2,3], not [4,5,1,2,3].
  // V0+ (no version gate — scoll.rs PATCH_METHOD min_version: V0).
  HANDLERS.set(handlerKey(12, 19), { handler: (obj, args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.patch expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    const n = obj.items.length
    ctx.addPerItemCost(30, 2, 10, n) // Pattern A; source: scoll.rs:204
    if (args.length !== 3) {
      throw new EvalError(
        `SColl.patch expects 3 args; got ${args.length}`,
        'method-not-implemented'
      )
    }
    const [fromArg, patchArg, replacedArg] = args as [SValue, SValue, SValue]
    if (fromArg.kind !== 'Int') {
      throw new EvalError(
        `SColl.patch expects 'from' to be Int; got '${fromArg.kind}'`,
        'method-not-implemented'
      )
    }
    if (replacedArg.kind !== 'Int') {
      throw new EvalError(
        `SColl.patch expects 'replaced' to be Int; got '${replacedArg.kind}'`,
        'method-not-implemented'
      )
    }
    if (patchArg.kind !== 'Coll') {
      throw new EvalError(
        `SColl.patch expects 'patch' to be a Coll; got '${patchArg.kind}'`,
        'method-not-implemented'
      )
    }
    // Independent clamp-to-0 (NOT clamped on the sum) — see doc-comment above.
    const from = Math.max(0, fromArg.value)
    const replaced = Math.max(0, replacedArg.value)
    return {
      kind: 'Coll',
      elem: obj.elem,
      items: [
        ...obj.items.slice(0, from),
        ...patchArg.items,
        ...obj.items.slice(from + replaced),
      ],
    }
  } })

  // SColl.updated (MethodCall, typeId=12, methodId=20) — v5 method
  // Source: sigma-rust UPDATED_EVAL_FN (eval/scoll.rs, branch ergo-node-integration).
  // Cost PerItemCost(20,1,10) on INPUT length n (sigma/ast/methods.scala:1035,
  // canonical), charged BEFORE arg handling. Returns a copy
  // with index i replaced by v. sigma-rust does `i as i32 as usize` then
  // `res.get_mut(idx)` → None ⇒ err, so a NEGATIVE i wraps to a huge usize and is
  // OOB as well. Result elem type = input's elem type. V0+ (UPDATED_METHOD min
  // V0). Unused on mainnet — a valid v5 language method (SANTA conformance only).
  HANDLERS.set(handlerKey(12, 20), { handler: (obj, args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.updated expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    const n = obj.items.length
    ctx.addPerItemCost(20, 1, 10, n) // PerItemCost(20,1,10); source: methods.scala:1035
    if (args.length !== 2) {
      throw new EvalError(
        `SColl.updated expects 2 args; got ${args.length}`,
        'method-not-implemented'
      )
    }
    const [indexArg, valueArg] = args as [SValue, SValue]
    if (indexArg.kind !== 'Int') {
      throw new EvalError(
        `SColl.updated expects 'index' to be Int; got '${indexArg.kind}'`,
        'method-not-implemented'
      )
    }
    // sigma-rust: `i as usize` + get_mut(idx) → None on OOB; a negative i wraps
    // to a huge usize and is OOB. So reject index < 0 OR index >= n.
    if (indexArg.value < 0 || indexArg.value >= n) {
      throw new EvalError(
        `SColl.updated: index ${indexArg.value} out of bounds for Coll of length ${n}`,
        'coll-update-index-out-of-range'
      )
    }
    const items = obj.items.slice()
    items[indexArg.value] = valueArg
    return { kind: 'Coll', elem: obj.elem, items }
  } })

  // SColl.updateMany (MethodCall, typeId=12, methodId=21) — v5 method
  // Source: sigma-rust UPDATE_MANY_EVAL_FN (eval/scoll.rs, branch
  // ergo-node-integration — the clean reference; the vendored integration/ergots
  // checkout is stale on this method's cost). Cost PerItemCost(20,2,10) on INPUT
  // length n: perChunkCost is 2, NOT 1 (sigma/ast/methods.scala:1055, canonical;
  // sigma-rust ergo-node-integration agrees). The n=14 vector (cost 160) pins it —
  // perChunk=1 would give 159. Charged BEFORE arg handling. Replaces each
  // indexes[k] with values[k] (sequential ⇒ last write wins on a repeated index).
  // Errors: indexes/values length mismatch, then per-index OOB (a negative index
  // wraps to a huge usize ⇒ OOB too). The sigma-rust input/values elem-type-
  // mismatch check is intentionally OMITTED: unreachable for type-checked trees,
  // untested, and a strict SType compare would false-positive against SAny-typed
  // colls (the iter-19 skip-don't-fail rule). Result elem type = input's. V0+.
  // Unused on mainnet — valid v5 language (SANTA conformance only).
  HANDLERS.set(handlerKey(12, 21), { handler: (obj, args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.updateMany expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    const n = obj.items.length
    ctx.addPerItemCost(20, 2, 10, n) // perChunk=2 (JVM); source: methods.scala:1055
    if (args.length !== 2) {
      throw new EvalError(
        `SColl.updateMany expects 2 args; got ${args.length}`,
        'method-not-implemented'
      )
    }
    const [indexesArg, valuesArg] = args as [SValue, SValue]
    if (indexesArg.kind !== 'Coll') {
      throw new EvalError(
        `SColl.updateMany expects 'indexes' to be a Coll; got '${indexesArg.kind}'`,
        'method-not-implemented'
      )
    }
    if (valuesArg.kind !== 'Coll') {
      throw new EvalError(
        `SColl.updateMany expects 'values' to be a Coll; got '${valuesArg.kind}'`,
        'method-not-implemented'
      )
    }
    // sigma-rust order: length mismatch (scoll.rs:308) before the per-index OOB loop.
    if (indexesArg.items.length !== valuesArg.items.length) {
      throw new EvalError(
        `SColl.updateMany: indexes/values length mismatch ` +
          `(${indexesArg.items.length} vs ${valuesArg.items.length})`,
        'coll-update-many-length-mismatch'
      )
    }
    const items = obj.items.slice()
    for (let k = 0; k < indexesArg.items.length; k++) {
      const idx = indexesArg.items[k]!
      if (idx.kind !== 'Int') {
        throw new EvalError(
          `SColl.updateMany expects each index to be Int; got '${idx.kind}'`,
          'method-not-implemented'
        )
      }
      // negative wraps to a huge usize ⇒ OOB; idx >= n ⇒ OOB (scoll.rs:328).
      if (idx.value < 0 || idx.value >= n) {
        throw new EvalError(
          `SColl.updateMany: index ${idx.value} out of bounds for Coll of length ${n}`,
          'coll-update-index-out-of-range'
        )
      }
      items[idx.value] = valuesArg.items[k]!
    }
    return { kind: 'Coll', elem: obj.elem, items }
  } })

  // SOption.map (MethodCall, typeId=36, methodId=7) — campaign iter-29
  // Source: ergotree-interpreter/src/eval/soption.rs:13-60 — map_eval
  // Fixed cost 20 (Pattern A, charged first inside the handler). Some(t)→Some(lambda(t)),
  // None→None. Lambda HOF — forwards extra.env for env-extend during body eval
  // (like flatMap). Handler body in ./soption-map.ts. V0+ (no version gate).
  HANDLERS.set(handlerKey(36, 7), {
    handler: (obj, args, ctx, _explicitTypeArgs, extra) => {
      if (extra === undefined) {
        throw new EvalError(
          `SOption.map requires extra={mc, env}; got undefined (programming error)`,
          'method-not-implemented'
        )
      }
      return evalSOptionMap(obj, args, ctx, extra.env)
    },
  })

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

  // ---------- SAvlTree.updateOperations (100:8) — phase 2h-d Task 3 ----------
  // Pattern A Fixed(45); V0+. Pure projection over AvlTreeData.treeFlags.
  // Source: ergotree-interpreter/src/eval/savltree.rs:77-88 — UPDATE_OPERATIONS_EVAL_FN.
  // Handler body lives in ./savltree.ts; signature is (ctx, obj, args) so the
  // wrapper here flips argument order to match `MethodHandler` shape.
  HANDLERS.set(handlerKey(100, 8), { handler: (obj, args, ctx) => evalSAvlTreeUpdateOperations(ctx, obj, args) })

  // ---------- SAvlTree.updateDigest (100:15) — phase 2h-d Task 7 ----------
  // Pattern A Fixed(40); V0+. Pure projection over AvlTreeData.digest.
  // Defensive 33-byte length check throws 'avl-tree-bad-digest-length'.
  // Source: ergotree-interpreter/src/eval/savltree.rs:90-102 — UPDATE_DIGEST_EVAL_FN.
  // Handler body lives in ./savltree.ts; signature is (ctx, obj, args) so the
  // wrapper here flips argument order to match `MethodHandler` shape.
  HANDLERS.set(handlerKey(100, 15), { handler: (obj, args, ctx) => evalSAvlTreeUpdateDigest(ctx, obj, args) })

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

  // ---------- SAvlTree.insertOrUpdate (100:16) — phase 2h-d Task 11 ----------
  // V3-gated batch-InsertOrUpdate. `minVersion: 3` on the HANDLERS entry causes
  // the dispatcher to throw 'tree-version-too-low' BEFORE invoking the handler
  // when (ctx.treeVersion ?? 0) < 3, mirroring sigma-rust's
  // MethodDesc.min_version: ErgoTreeVersion::V3 (types/savltree.rs:377-403).
  // Pre-check requires BOTH insert_allowed AND update_allowed set, else Option
  // None. Per-op fail is always graceful break under V3+ (no V<3 throw path
  // because the dispatcher already rejected V<3 trees).
  // Source: ergotree-interpreter/src/eval/savltree.rs:441-498 — INSERT_OR_UPDATE_EVAL_FN.
  HANDLERS.set(handlerKey(100, 16), {
    handler: (obj, args, ctx) => evalSAvlTreeInsertOrUpdate(ctx, obj, args),
    minVersion: 3,  // V3 gate — sigma-rust MethodDesc.min_version: ErgoTreeVersion::V3
  })

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

  // SBigInt.toUnsigned (6:14) — v6 P2c bridge. FixedCost(5) (methods.scala:543), Pattern A
  // (after the dispatcher's +4). Receiver BigInt; rejects negative (CBigInt.toUnsigned →
  // CUnsignedBigInt ctor). minVersion 3 (BigInt.getMethods gates ToUnsigned on isV3OrLater,
  // methods.scala:559-565).
  HANDLERS.set(handlerKey(6, 14), { minVersion: 3, handler: (obj, _args, ctx) => {
    ctx.addCost(5)
    if (obj.kind !== 'BigInt') {
      throw new EvalError(`BigInt.toUnsigned: expected BigInt operand, got '${obj.kind}'`, 'numeric-method-bad-operand')
    }
    if (obj.value < 0n) {
      throw new EvalError(`BigInt.toUnsigned: negative value ${obj.value}`, 'unsigned-bigint-out-of-range')
    }
    return { kind: 'UnsignedBigInt', value: obj.value }
  } })

  // SUnsignedBigInt.toSigned (9:19) — v6 P2c bridge. FixedCost(10) (methods.scala:607). Receiver
  // UBI; rejects value >= 2^255 (toSignedBigIntValueExact, bitLength > 255 — the "leftmost bit
  // set" case). minVersion 3 (UBI is v6-only).
  HANDLERS.set(handlerKey(9, 19), { minVersion: 3, handler: (obj, _args, ctx) => {
    ctx.addCost(10)
    if (obj.kind !== 'UnsignedBigInt') {
      throw new EvalError(`UnsignedBigInt.toSigned: expected UnsignedBigInt operand, got '${obj.kind}'`, 'numeric-method-bad-operand')
    }
    if (obj.value >= (1n << 255n)) {
      throw new EvalError(`UnsignedBigInt.toSigned: value ${obj.value} exceeds signed-256 range`, 'bigint-result-out-of-range')
    }
    return { kind: 'BigInt', value: obj.value }
  } })

  // SUnsignedBigInt.mod (9:18) — v6 P2d-1. FixedCost(20) (methods.scala:601), Pattern A.
  // a mod m (Euclidean). m==0 ⇒ arith-divide-by-zero (umod). Source: CUnsignedBigInt.scala:47.
  HANDLERS.set(handlerKey(9, 18), { minVersion: 3, handler: (obj, args, ctx) => {
    ctx.addCost(20)
    if (obj.kind !== 'UnsignedBigInt') {
      throw new EvalError(`UnsignedBigInt.mod: expected UnsignedBigInt receiver, got '${obj.kind}'`, 'numeric-method-bad-operand')
    }
    const m = args[0]
    if (m?.kind !== 'UnsignedBigInt') {
      throw new EvalError(`UnsignedBigInt.mod: expected UnsignedBigInt modulus, got '${m?.kind}'`, 'numeric-method-bad-operand')
    }
    return { kind: 'UnsignedBigInt', value: umod(obj.value, m.value) }
  } })

  // v6 numeric methods (toBytes/toBits/bitwise/shift) — all gate on treeVersion >= 3.
  for (const { typeId, methodId, handler } of numericV6Handlers()) {
    HANDLERS.set(handlerKey(typeId, methodId), { handler, minVersion: 3 })
  }
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
