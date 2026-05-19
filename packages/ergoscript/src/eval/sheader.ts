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
import { bytesToCollByteSValue } from './_byte-coll'
import type { SValue } from '../mir/types'
import type { Header } from '@ergots/scorex'

/** Pattern A cost charged by every SHeader accessor. Source: sheader.rs:16-113. */
const ACCESSOR_COST = 10

/** 33 zero bytes — sigma-rust EcPoint::default() (identity point) encoding. Source: ec_point.rs:127-137. */
const IDENTITY_POINT_BYTES = new Uint8Array(33)

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
  return bytesToCollByteSValue(obj.value.id)
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
  return bytesToCollByteSValue(obj.value.parentId)
}

/**
 * SHeader.ADProofsRoot (104:4) — 32-byte AD proofs root as Coll[Byte].
 * Source: sheader.rs:34-38.
 */
export function evalSHeaderAdProofsRoot(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'ADProofsRoot')
  return bytesToCollByteSValue(obj.value.adProofsRoot)
}

/**
 * SHeader.stateRoot (104:5) — 33-byte ADDigest as Coll[Byte].
 * Source: sheader.rs:40-44.
 *
 * Note: types/sheader.rs:127 declares return type as SAvlTree, but the evaluator
 * returns Coll[Byte] (Vec<i8> wrapped in a CollByte). This is an intentional
 * quirk in sigma-rust: the type-system layer declares SAvlTree for type inference,
 * while the evaluator returns the raw digest bytes.
 */
export function evalSHeaderStateRoot(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'stateRoot')
  return bytesToCollByteSValue(obj.value.stateRoot)
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
  return bytesToCollByteSValue(obj.value.transactionRoot)
}

/**
 * SHeader.timestamp (104:7) — block timestamp as Long (bigint).
 * Source: sheader.rs:58-62.
 *
 * Rust: `header.timestamp as i64`. Our scorex Header.timestamp is a JS `number`;
 * we convert to bigint via BigInt() per the type contract.
 */
export function evalSHeaderTimestamp(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'timestamp')
  return { kind: 'Long', value: BigInt(obj.value.timestamp) }
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
  return bytesToCollByteSValue(obj.value.extensionRoot)
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
 * Source: sheader.rs:82-86.
 *
 * Rust: `header.autolykos_solution.pow_onetime_pk.unwrap_or_default()`.
 * For V2 headers where our scorex `powOnetimePk === null`, we return 33 zero bytes,
 * which is sigma-rust's EcPoint::default() encoding (identity point per ec_point.rs:127-137).
 */
export function evalSHeaderPowOnetimePk(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'powOnetimePk')
  const pk = obj.value.autolykosSolution.powOnetimePk ?? IDENTITY_POINT_BYTES
  return { kind: 'GroupElement', value: pk }
}

/**
 * SHeader.powNonce (104:13) — PoW nonce as Coll[Byte] (8 bytes).
 * Source: sheader.rs:88-92.
 */
export function evalSHeaderPowNonce(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  ctx.addCost(ACCESSOR_COST)
  assertHeaderObj(obj, 'powNonce')
  return bytesToCollByteSValue(obj.value.autolykosSolution.nonce)
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
  return bytesToCollByteSValue(obj.value.votes)
}
