/**
 * Ports operation.rs's Operation enum and update_fn.
 * Source: ergo_avltree_rust/src/operation.rs (107 lines).
 *
 * Note: Rust's KeyValue { key, value } and KeyDelta { key, delta } structs
 * are flattened inline onto the variants here — TS-idiomatic for discriminated
 * unions, intentional divergence from the Rust struct shape.
 */

/** Ports operation.rs::Operation enum (lines 13-22). */
export type Operation =
  | { tag: 'Lookup'; key: Uint8Array }
  | { tag: 'UnknownModification'; key: Uint8Array }
  | { tag: 'Insert'; key: Uint8Array; value: Uint8Array }
  | { tag: 'Update'; key: Uint8Array; value: Uint8Array }
  | { tag: 'InsertOrUpdate'; key: Uint8Array; value: Uint8Array }
  | { tag: 'UpdateLongBy'; key: Uint8Array; delta: bigint }
  | { tag: 'Remove'; key: Uint8Array }
  | { tag: 'RemoveIfExists'; key: Uint8Array }

/** Internal per-op result: success with new value (or null = remove), or precondition failure. */
export type UpdateFnResult =
  | { ok: true; newValue: Uint8Array | null }
  | { ok: false; reason: UpdateFnFailReason }

/** Failure reasons for updateFn. */
export type UpdateFnFailReason =
  | 'key-already-exists'           // Insert on existing key
  | 'key-not-found'                // Update or Remove on absent key
  | 'decrement-on-absent-key'      // UpdateLongBy delta < 0 on absent key
  | 'result-negative'              // UpdateLongBy result < 0 (in-range)
  | 'result-out-of-i64-range'      // UpdateLongBy sum overflows i64 (JVM Math.addExact analogue)
  | 'invalid-long-value-length'    // UpdateLongBy existing value is not exactly 8 bytes (audit AVL-02)

/**
 * Signed 64-bit range bounds. Used by the UpdateLongBy sum-overflow guard
 * below and by the delta range checks at both public boundaries
 * (`verify.ts::validateOperationShape`, `BatchAVLProver.performOneOperation`).
 */
export const I64_MAX = 2n ** 63n - 1n
export const I64_MIN = -(2n ** 63n)

/**
 * Encode a signed i64 value as 8-byte big-endian.
 * Ports Rust i64::to_be_bytes (operation.rs:91, 98) via BigEndian::write_i64.
 * Uses bigint arithmetic; assumes value fits in the i64 range [-2^63, 2^63-1].
 * Enforced by the UpdateLongBy arm's range guard for the sum path, and by the
 * delta range checks at BOTH public boundaries for the absent-key insert path
 * (`verify.ts::validateOperationShape`, AVL-03, and
 * `BatchAVLProver.performOneOperation` — 6e review finding I-1).
 */
function i64ToBeBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  // setBigInt64 writes a signed 64-bit integer in big-endian order.
  view.setBigInt64(0, value, false)
  return bytes
}

/**
 * Decode 8-byte big-endian as a signed i64.
 * Ports BigEndian::read_i64 (operation.rs:94).
 * Interprets byte[0] bit 7 as the sign bit (two's complement).
 *
 * Precondition: bytes.length === 8. Caller (updateFn UpdateLongBy branch) MUST
 * pre-check; this function asserts as a defensive guard. Audit AVL-02: the
 * pre-fix code threw RangeError on bytes.length < 8 (DataView constructor),
 * bypassing the verifier's null-on-failure path; the explicit check converts
 * that to a typed failure surfaced through updateFn's UpdateFnResult.
 */
function beBytesToI64(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8)
  // getBigInt64 reads a signed 64-bit integer in big-endian order.
  return view.getBigInt64(0, false)
}

/**
 * Ports operation.rs::Operation::update_fn (lines 64-106).
 * Per-op old-value → new-value transform used by the AVL+ batch verifier
 * at the matching leaf. Returns ok+newValue on success, ok:false+reason on
 * precondition failure. null = key is absent (or removal result).
 *
 * WARNING: For `Lookup` ops, the verifier's tree-walking code (modify.ts /
 * delete.ts) MUST short-circuit BEFORE calling updateFn — mirrors Rust's
 * handling at authenticated_tree_ops.rs:280-282, 303-305. Passing a Lookup
 * op into updateFn always returns { ok: true, newValue: null }, which the
 * naive caller would treat as "remove key" — a critical bug. The Lookup
 * branch here exists as a defensive stub but should never be reached in
 * practice.
 */
export function updateFn(op: Operation, oldValue: Uint8Array | null): UpdateFnResult {
  switch (op.tag) {
    case 'Lookup':
      // operation.rs:65 — Lookup always returns None (no modification).
      return { ok: true, newValue: null }

    case 'UnknownModification':
      // operation.rs:66 — pass through old value unchanged.
      return { ok: true, newValue: oldValue }

    case 'Insert':
      // operation.rs:67-70 — insert only when absent.
      if (oldValue === null) {
        return { ok: true, newValue: op.value }
      }
      return { ok: false, reason: 'key-already-exists' }

    case 'Update':
      // operation.rs:71-74 — update only when present.
      if (oldValue === null) {
        return { ok: false, reason: 'key-not-found' }
      }
      return { ok: true, newValue: op.value }

    case 'InsertOrUpdate':
      // operation.rs:75 — always write new value.
      return { ok: true, newValue: op.value }

    case 'Remove':
      // operation.rs:76-79 — remove only when present.
      if (oldValue === null) {
        return { ok: false, reason: 'key-not-found' }
      }
      return { ok: true, newValue: null }

    case 'RemoveIfExists':
      // operation.rs:80 — remove unconditionally (no-op if absent).
      return { ok: true, newValue: null }

    case 'UpdateLongBy': {
      // operation.rs:89-105 — add delta to existing i64 value stored as 8 BE bytes.
      // Pattern: delta == 0 short-circuits first regardless of key presence.
      if (op.delta === 0n) {
        // operation.rs:90 — `m if kv.delta == 0 => Ok(m)` returns old value as-is.
        return { ok: true, newValue: oldValue }
      }
      if (oldValue === null) {
        if (op.delta > 0n) {
          // operation.rs:91 — insert with delta as 8 BE bytes.
          return { ok: true, newValue: i64ToBeBytes(op.delta) }
        }
        // operation.rs:92 — delta < 0 on absent key.
        return { ok: false, reason: 'decrement-on-absent-key' }
      }
      // Audit AVL-02: pre-fix beBytesToI64 threw RangeError when oldValue
      // was not exactly 8 bytes (variable-length-value trees can legitimately
      // store any-length values; an UpdateLongBy that lands on a non-8-byte
      // leaf cannot be applied). Surface as a typed failure reason rather
      // than letting the DataView constructor panic past the verifier's
      // null-on-failure path.
      if (oldValue.length !== 8) {
        return { ok: false, reason: 'invalid-long-value-length' }
      }
      // operation.rs:93-103 — key present: add delta to existing value.
      const current = beBytesToI64(oldValue)
      const newVal = current + op.delta
      // scrypto's UpdateLongBy.updateFn computes this sum with Math.addExact
      // (bytecode-verified: scrypto 3.0.0 $anonfun$updateFn$7, offset 169),
      // so an i64 overflow in EITHER direction is a per-op failure before any
      // sign check runs — the sign checks below only ever see in-range sums.
      // Deliberate divergence from ergo_avltree_rust @191052c, whose plain
      // release-mode `+` wraps and sign-checks the WRAPPED value (storing a
      // wrapped-positive, or removing the key at exactly MIN+MIN, on negative
      // overflow where the JVM rejects). The JVM is canonical; the crate-side
      // divergence is routed cross-project. Without this guard the true-sum
      // checks accepted positive overflow and i64ToBeBytes stored the
      // wrapped-NEGATIVE encoding.
      if (newVal > I64_MAX || newVal < I64_MIN) {
        return { ok: false, reason: 'result-out-of-i64-range' }
      }
      if (newVal === 0n) {
        // operation.rs:95 — result zero → remove.
        return { ok: true, newValue: null }
      }
      if (newVal > 0n) {
        // operation.rs:97 — positive result → write new value.
        return { ok: true, newValue: i64ToBeBytes(newVal) }
      }
      // operation.rs:99 — negative result → fail.
      return { ok: false, reason: 'result-negative' }
    }

    default: {
      // Exhaustiveness guard — TS should make this unreachable.
      const _exhaustive: never = op
      return _exhaustive
    }
  }
}
