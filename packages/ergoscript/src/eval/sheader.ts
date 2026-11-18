/**
 * SHeader method handlers — 15 property accessors (typeId 104, methodIds 1-15).
 *
 * All handlers follow Pattern A Fixed(10): ctx.addCost(10) → assertHeaderObj(obj)
 * → project a Header field into an SValue.
 *
 * Source: ergotree-interpreter/src/eval/sheader.rs at sigma-rust integration/ergots branch.
 * Per-method line refs in each handler's doc-comment.
 *
 * Error codes originated here:
 *   'header-obj-not-header'    — defensive receiver check; thrown by all 15 handlers
 *                                 when obj.kind !== 'Header'. Wire-format invariants
 *                                 make this unreachable for parser-produced trees.
 */

import { EvalError } from './eval-context'
import type { EvalContext } from './eval-context'
import { byteColl } from './_coll'
import { GROUP_GENERATOR_BYTES } from './_group-generator'
import type { SValue } from '../mir/types'
import type { Header } from '@ergots/scorex'
import { verifyAutolykosV2, AutolykosV1NotSupportedError } from '@ergots/scorex'

/** Pattern A cost charged by every SHeader accessor. Source: sheader.rs:16-113. */
const ACCESSOR_COST = 10

/** Defensive receiver check shared by all 15 SHeader handlers. */
function assertHeaderObj(
  obj: SValue,
  methodName: string
): asserts obj is { kind: 'Header'; value: Header } {
  if (obj.kind !== 'Header') {
    throw new EvalError(
      `SHeader.${methodName} expects a Header obj; got '${obj.kind}'`,
      'header-obj-not-header'
    )
  }
}

/**
 * SHeader.id (104:1) — 32-byte block id as Coll[Byte].
 * Source: sheader.rs:22-26.
 */
export function evalSHeaderId(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'id')
  // JVM `CHeader.id` is a specialised `Coll[Byte]` —
  // `data/shared/src/main/scala/sigma/data/CHeader.scala:17`
  // `id = ergoHeader.id` reads the pre-built collection; `ergoHeader.id`
  // itself is built at
  // `data/shared/src/main/scala/org/ergoplatform/ErgoHeader.scala:140`:
  // `Colls.fromArray(serializedId)` on an `Array[Byte]` — the specialised
  // `fromArray` branch
  // (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:226-233`).
  return byteColl(obj.value.id, true)
}

/**
 * SHeader.version (104:2) — header version as Byte (sign-extended u8 → i8).
 * Source: sheader.rs:16-20.
 */
export function evalSHeaderVersion(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'version')
  // Rust: `header.version as i8` — sign-extend u8 to signed i8.
  return { kind: 'Byte', value: (obj.value.version << 24) >> 24 }
}

/**
 * SHeader.parentId (104:3) — 32-byte parent block id as Coll[Byte].
 * Source: sheader.rs:28-32.
 */
export function evalSHeaderParentId(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'parentId')
  // JVM `CHeader.parentId` is a specialised `Coll[Byte]` —
  // `data/shared/src/main/scala/sigma/data/CHeader.scala:23`
  // `parentId = Colls.fromArray(idToBytes(ergoHeader.parentId))` on an
  // `Array[Byte]` — the specialised `fromArray` branch
  // (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:226-233`).
  return byteColl(obj.value.parentId, true)
}

/**
 * SHeader.ADProofsRoot (104:4) — 32-byte AD proofs root as Coll[Byte].
 * Source: sheader.rs:34-38.
 */
export function evalSHeaderAdProofsRoot(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'ADProofsRoot')
  // JVM `CHeader.ADProofsRoot` is a specialised `Coll[Byte]` —
  // `data/shared/src/main/scala/sigma/data/CHeader.scala:26`
  // `ADProofsRoot = Colls.fromArray(ergoHeader.ADProofsRoot)` on an
  // `Array[Byte]` — specialised
  // (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:226-233`).
  return byteColl(obj.value.adProofsRoot, true)
}

/**
 * SHeader.stateRoot (104:5) — 33-byte ADDigest as AvlTree.
 * Source (JVM canonical): CHeader.scala:29
 *   `stateRoot = CAvlTree(avlTreeFromDigest(stateRoot))`.
 *
 * `avlTreeFromDigest` (core AvlTreeData.scala) builds an AvlTreeData with flags
 * (insert, update, remove) = 0b111, keyLength = crypto.hashLength = 32, and
 * valueLengthOpt = None; the digest is the verbatim 33-byte ADDigest. Identical
 * shape to SContext.lastBlockUtxoRootHash (method-call.ts) and SAvlTree literals.
 *
 * ergots LEADS sigma-rust here: sigma-rust's evaluator returns the raw digest as
 * Coll[Byte] (sheader.rs:40-44) even though types/sheader.rs:127 declares
 * SAvlTree. The JVM is canonical. See facts/ergoscript-eval.md row 26.
 */
export function evalSHeaderStateRoot(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'stateRoot')
  return {
    kind: 'AvlTree',
    value: {
      digest: obj.value.stateRoot,
      treeFlags: 0b00000111,
      keyLength: 32,
      valueLengthOpt: null,
    },
  }
}

/**
 * SHeader.transactionsRoot (104:6) — 32-byte transactions root as Coll[Byte].
 * Source: sheader.rs:46-50.
 *
 * Note: Rust field name is `header.transaction_root` (singular);
 * method name in types/sheader.rs is `transactionsRoot` (plural).
 * Our scorex Header uses `transactionRoot` (singular) matching the wire field.
 */
export function evalSHeaderTransactionsRoot(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'transactionsRoot')
  // JVM `CHeader.transactionsRoot` is a specialised `Coll[Byte]` —
  // `data/shared/src/main/scala/sigma/data/CHeader.scala:32`
  // `transactionsRoot = Colls.fromArray(ergoHeader.transactionsRoot)` on an
  // `Array[Byte]` — specialised.
  return byteColl(obj.value.transactionRoot, true)
}

/**
 * SHeader.timestamp (104:7) — block timestamp as Long (bigint).
 * Source: sheader.rs:58-62.
 *
 * Rust: `header.timestamp as i64`. scorex Header.timestamp is the unsigned
 * wire u64 (bigint, lossless since F2); the JVM/sigma-rust accessor presents
 * the two's-complement i64 view, so timestamps in [2^63, 2^64) surface as
 * NEGATIVE Longs. BigInt.asIntN(64, ·) is exactly that reinterpretation.
 */
export function evalSHeaderTimestamp(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'timestamp')
  return { kind: 'Long', value: BigInt.asIntN(64, obj.value.timestamp) }
}

/**
 * SHeader.nBits (104:8) — difficulty target as Long (bigint).
 * Source: sheader.rs:64-68.
 *
 * Rust: `header.n_bits as i64`. Our scorex Header.nBits is a JS `number`;
 * we convert to bigint via BigInt().
 */
export function evalSHeaderNBits(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'nBits')
  return { kind: 'Long', value: BigInt(obj.value.nBits) }
}

/**
 * SHeader.height (104:9) — block height as Int (i32).
 * Source: sheader.rs:70-74.
 *
 * Rust: `header.height as i32`. Force i32 truncation via `| 0`.
 */
export function evalSHeaderHeight(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'height')
  return { kind: 'Int', value: obj.value.height | 0 }
}

/**
 * SHeader.extensionRoot (104:10) — 32-byte extension root as Coll[Byte].
 * Source: sheader.rs:52-56.
 */
export function evalSHeaderExtensionRoot(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'extensionRoot')
  // JVM `CHeader.extensionRoot` is a specialised `Coll[Byte]` —
  // `data/shared/src/main/scala/sigma/data/CHeader.scala:45`
  // `extensionRoot = Colls.fromArray(ergoHeader.extensionRoot)` on an
  // `Array[Byte]` — specialised.
  return byteColl(obj.value.extensionRoot, true)
}

/**
 * SHeader.minerPk (104:11) — miner public key as GroupElement (33 bytes).
 * Source: sheader.rs:76-80.
 */
export function evalSHeaderMinerPk(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'minerPk')
  return { kind: 'GroupElement', value: obj.value.autolykosSolution.minerPk }
}

/**
 * SHeader.powOnetimePk (104:12) — one-time PoW public key as GroupElement (33 bytes).
 * Source (JVM canonical): CHeader.scala:52 `powOnetimePk = CGroupElement(powSolution.w)`.
 *
 * V1 headers carry a parsed `w` (returned verbatim). For Autolykos v2 our scorex
 * sets `powOnetimePk === null`; the JVM returns the GENERATOR in that case
 * (ErgoHeader.scala:57-58 `wForV2 = dlogGroup.generator`). ergots LEADS sigma-rust
 * here: sigma-rust returns EcPoint::default() (identity, sheader.rs:82-86). The JVM
 * is canonical. See facts/ergoscript-eval.md row 33.
 *
 * `.slice()` copies the module-level generator constant so callers can't mutate it
 * (mirrors the GlobalVars.GroupGenerator arm at global-vars.ts).
 */
export function evalSHeaderPowOnetimePk(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'powOnetimePk')
  const pk = obj.value.autolykosSolution.powOnetimePk ?? GROUP_GENERATOR_BYTES.slice()
  return { kind: 'GroupElement', value: pk }
}

/**
 * SHeader.powNonce (104:13) — PoW nonce as Coll[Byte] (8 bytes).
 * Source: sheader.rs:88-92.
 */
export function evalSHeaderPowNonce(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'powNonce')
  // JVM `CHeader.powNonce` is a specialised `Coll[Byte]` —
  // `data/shared/src/main/scala/sigma/data/CHeader.scala:55`
  // `powNonce = Colls.fromArray(ergoHeader.powSolution.n)` on an
  // `Array[Byte]` — specialised.
  return byteColl(obj.value.autolykosSolution.nonce, true)
}

/**
 * SHeader.powDistance (104:14) — PoW distance as BigInt.
 * Source: sheader.rs:94-107.
 *
 * Rust: `header.autolykos_solution.pow_distance.unwrap_or_default().to_bigint()`.
 * For V2 headers where our scorex `powDistance === null`, we return 0n.
 */
export function evalSHeaderPowDistance(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'powDistance')
  const d = obj.value.autolykosSolution.powDistance ?? 0n
  return { kind: 'BigInt', value: d }
}

/**
 * SHeader.votes (104:15) — miner votes as Coll[Byte] (3 bytes).
 * Source: sheader.rs:109-113.
 */
export function evalSHeaderVotes(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'votes')
  // JVM `CHeader.votes` is a specialised `Coll[Byte]` —
  // `data/shared/src/main/scala/sigma/data/CHeader.scala:62`
  // `votes = Colls.fromArray(ergoHeader.votes)` on an `Array[Byte]` —
  // specialised.
  return byteColl(obj.value.votes, true)
}

/**
 * SHeader.checkPow (typeId 104, methodId 16).
 *
 * Pattern A Fixed(700) — `ctx.addCost(700)` BEFORE the obj-kind check and
 * verifier invocation. Sigma-rust source: ergotree-interpreter/src/eval/sheader.rs:115-124.
 *
 * V3-gated at the dispatcher level (registration in method-call.ts with
 * minVersion: 3). The dispatcher's minVersion check fires BEFORE this
 * handler is invoked, so V<3 reject incurs zero handler cost (sigma-rust
 * parity — sigma-rust gates this at MethodDesc.min_version).
 *
 * Returns SValue.Boolean from verifyAutolykosV2.
 *
 * Error codes:
 *   'header-obj-not-header'        — defensive receiver check (reused from 2h-c.1)
 *   'autolykos-v1-not-supported'   — verifyAutolykosV2 threw AutolykosV1NotSupportedError on a V1 header
 */
export function evalSHeaderCheckPow(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext,
): SValue {
  // 1. Pattern A cost charge (mirrors sigma-rust eval/sheader.rs:116)
  ctx.addCost(700)

  // 2. Defensive receiver kind check (reuses 'header-obj-not-header' from 2h-c.1)
  assertHeaderObj(obj, 'checkPow')

  // 3. Run verifier; catch typed v1 error and re-throw as EvalError
  try {
    const result = verifyAutolykosV2(obj.value)
    return { kind: 'Boolean', value: result }
  } catch (e) {
    if (e instanceof AutolykosV1NotSupportedError) {
      throw new EvalError(
        'SHeader.checkPow: Autolykos v1 PoW verification is not implemented (mirrors sigma-rust)',
        'autolykos-v1-not-supported',
      )
    }
    throw e  // re-throw unexpected errors unwrapped
  }
}
